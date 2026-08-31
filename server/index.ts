/**
 * LandfillMind · 填埋场全周期智能体 v4.2 — 后端服务入口
 * 职责：SSE 流式对话 / 会话管理 / KB 检索 / 计算器 / 双引擎诊断 / 健康检查
 */

import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from './db.js';
import { initDb } from './db.js';
import { runDiagnosis } from './diagnose.js';
import { lookupKB, KB_ENTRIES } from './kb.js';
import { AGENT_TOOL_USAGE } from './prompts.js';
import { extractSceneParams, getCachedAgentRun, agentCache, warmAgentCache } from './multiagent.js';
import type { MASceneParams } from './multiagent.js';
import { resolveCompat, resolveCfgForModel, resolveOpenRouter, resolveGlm, detailMaxTokens, detailPromptSuffix } from './llm.js';

import { initRetrieval } from './retrieval.js';
import { buildChatAugmentation, summarizeConversation, detectCalcIntent, detectOgsIntent } from './augment.js';
import { runOgsScenario } from './ogs.js';
import { buildScene, hasSceneIntent, isExplicitSceneRequest, DEFAULT_NL_PARSER } from './scene-builder.js';
import { startIotBroker, stopIotBroker } from './iot.js';
import type { DetailLevel } from './llm.js';
import type { CompatCfg } from './llm.js';
import { generateFollowUp, FOLLOW_UP_GUIDES } from './followUp.js';
import { calcRouter, CALC_REGISTRY } from './routes/calc.js';
import { ogsRouter } from './routes/ogs.js';
import { kbRouter } from './routes/kb.js';
import { iotRouter } from './routes/iot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

/** 去掉模型输出里的 Markdown 符号（前端为纯文本渲染，避免出现 ###、** 等） */
function stripMarkdown(text: string): string {
  return text
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/#{1,6}\s*/g, '');
}

// 反代之后取真实 IP（Render 等平台在 X-Forwarded-For 携带客户端 IP）
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

// 预热混合知识库检索（embedding 失败时自动回退关键词检索）
initRetrieval().catch(() => {});

// ============ 演示限流（防刷 Key，阈值走环境变量） ============
const RATE_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN ?? '20', 10);
const RATE_PER_DAY = parseInt(process.env.RATE_LIMIT_PER_DAY ?? '200', 10);
const RATE_GLOBAL_PER_DAY = parseInt(process.env.RATE_LIMIT_GLOBAL_PER_DAY ?? '1000', 10);

const ipMinute = new Map<string, { count: number; resetAt: number }>();
const ipDay = new Map<string, { count: number; day: string }>();
let globalCount = 0;
let globalDay = '';

app.use('/api', (req, res, next) => {
  // 豁免零模型成本的读写接口，只限制会烧钱的路径
  if (
    req.path === '/health'
    || req.path === '/models'
    || req.path === '/sessions'
    || req.path === '/calc' && req.method === 'GET'
    || req.path.startsWith('/kb/') && req.method === 'GET'
  ) return next();
  const ip = req.ip ?? 'unknown';
  const now = Date.now();

  const minute = ipMinute.get(ip);
  if (minute && now < minute.resetAt) {
    minute.count++;
    if (minute.count > RATE_PER_MIN) {
      return res.status(429).json({ error: `请求过于频繁，请稍后再试（每分钟最多 ${RATE_PER_MIN} 次）` });
    }
  } else {
    ipMinute.set(ip, { count: 1, resetAt: now + 60_000 });
  }

  // 用本地日期（避免 UTC 16:00 后中国地区 date 已翻页）
  const today = formatLocalDate(new Date());
  const day = ipDay.get(ip);
  if (day && day.day === today) {
    day.count++;
    if (day.count > RATE_PER_DAY) {
      return res.status(429).json({ error: '今日请求次数已达上限，请明天再试' });
    }
  } else {
    ipDay.set(ip, { count: 1, day: today });
  }

  if (globalDay !== today) {
    globalDay = today;
    globalCount = 0;
  }
  globalCount++;
  if (globalCount > RATE_GLOBAL_PER_DAY) {
    return res.status(429).json({ error: '演示环境今日请求已达上限' });
  }

  // 防止 Map 无界增长：只清过期项（P1-1：原本 ipDay.clear() 会把当天未过期的也一并清掉，
  // 让同一 IP 反复刷穿 RATE_PER_DAY 阈值，已改为按 day 字段判过期）
  if (ipMinute.size > 5000) {
    for (const [k, v] of ipMinute) {
      if (now >= v.resetAt) ipMinute.delete(k);
    }
  }
  if (ipDay.size > 5000) {
    for (const [k, v] of ipDay) {
      if (v.day !== today) ipDay.delete(k);
    }
  }

  next();
});

/** 本地日期 YYYY-MM-DD（服务器时区；中国时区下不会因 UTC 16:00 翻页） */
function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ============ 数据库初始化（fire-and-forget：等下 bootstrap 里 await 同一个 Promise） ============
// 真正的 await 在 bootstrap()；这里提前启动能让 WASM 加载与 listen 之前的其它同步初始化并行。
const dbReady: Promise<void> = initDb().catch((err) => {
  console.error('[boot] initDb 失败:', err);
  throw err;
});

// ============ 模型提供商 ============
type Provider = 'codebuddy' | 'openrouter' | 'glm' | 'compat';

function getProvider(): Provider {
  if (process.env.CODEBUDDY_API_KEY) return 'codebuddy';
  const cfg = resolveCompat();
  if (cfg) return cfg.kind;
  return 'codebuddy';
}

/** 模型下拉的友好显示名 */
function friendlyModelName(id: string): string {
  const map: Record<string, string> = {
    'deepseek/deepseek-v4-flash': 'DeepSeek V4 Flash（OpenRouter）',
    'dots-studio/dots-3-note-preview:free': 'Dots 3 Note（OpenRouter 免费）',
    'deepseek/deepseek-v4-pro': 'DeepSeek V4 Pro（OpenRouter）',
    'deepseek/deepseek-chat': 'DeepSeek Chat（OpenRouter）',
    'deepseek/deepseek-chat-v3-0324:free': 'DeepSeek V3（OpenRouter 免费）',
    'nvidia/nemotron-3-ultra-550b-a55b:free': 'Nemotron 3 Ultra 550B（OpenRouter 免费）',
    'glm-4-flash-250414': 'GLM-4-Flash（智谱直连）',
    'glm-4.6v-flash': 'GLM-4.6V-Flash（智谱直连）',
    'glm-4.7-flash': 'GLM-4.7-Flash（智谱直连）',
  };
  if (map[id]) return map[id];
  if (id.startsWith('deepseek/')) return 'DeepSeek ' + id.slice('deepseek/'.length) + '（OpenRouter）';
  if (id.startsWith('nvidia/')) return 'NVIDIA ' + id.slice('nvidia/'.length).replace(/:free$/, '') + '（OpenRouter 免费）';
  if (id.startsWith('z-ai/glm')) return id.replace('z-ai/', '') + '（OpenRouter）';
  if (id.startsWith('glm')) return id + '（智谱直连）';
  return id;
}

// ============ 通用 OpenAI 兼容 SSE 流式（OpenRouter 主 + GLM 直连备） ============
/** 从 OGS 运行结果抽"时程峰值 + 单位"（供场景卡片展示；失败/空返回 null）
 *  优先取速率系列（*_rate，如产气日峰），避免累计序列（*_cum）的最大值冒充"日峰"；
 *  位移类（沉降向下为负）取绝对值最大，语义上指向"最大沉降" */
function summarizeOgsResult(r: { ok: boolean; timeSeries?: Array<{ name?: string; varName?: string; unit?: string; points?: { t: number; v: number }[] }> }): { peakValue: number; unit: string } | null {
  if (!r.ok || !r.timeSeries?.length) return null;
  const nameAndUnit = (s: { name?: string; varName?: string; unit?: string }) => `${s.name ?? ''} ${s.varName ?? ''} ${s.unit ?? ''}`;
  const rateSeries = r.timeSeries.find(s => /rate|速率|日峰/i.test(nameAndUnit(s))) ?? null;
  const series = rateSeries ?? r.timeSeries[0];
  const values = (series.points ?? []).map(p => p.v);
  if (!values.length) return null;
  const peak = values.reduce((a, b) => Math.abs(b) > Math.abs(a) ? b : a, 0);
  return { peakValue: peak, unit: series.unit ?? '' };
}

/** OGS 联动适配：跑一个稳定化计算场景，抽峰值（失败静默返回 null，容器内无求解器也不阻塞） */
async function runOgScenarioSummary(scenario: string): Promise<{ peakValue: number; unit: string } | null> {
  try {
    const r = await runOgsScenario(scenario, {});
    return summarizeOgsResult(r);
  } catch {
    return null;
  }
}

async function handleCompatChat(req: express.Request, res: express.Response, primaryCfg: CompatCfg) {
  const { messages, model, systemPrompt, sessionId, detail } = req.body as {
    messages: any[]; model: string; systemPrompt?: string; sessionId?: string; detail?: DetailLevel;
  };
  // 前端模型下拉选择的直接使用（'codebuddy' 为占位符除外），否则回退服务端默认模型
  const selectedModel = (model && model !== 'codebuddy') ? model : primaryCfg.model;
  const sid = sessionId ?? uuidv4();
  const assistantMsgId = uuidv4();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

    // SSE 心跳：每 15 秒发 :keepalive 注释行，防反代/浏览器断开
    const ka = setInterval(() => {
      if (res.writableEnded) { clearInterval(ka); return; }
      try { res.write(':keepalive\n\n'); } catch { clearInterval(ka); }
    }, 15000);
    res.on('close', () => clearInterval(ka));

  try {
    const conversation: { role: string; content: string }[] = [];
    if (systemPrompt) conversation.push({ role: 'system', content: systemPrompt + detailPromptSuffix(detail) });

    // 长对话记忆：较早消息压缩为要点摘要
    const msgs: any[] = messages ?? [];
    const totalChars = msgs.reduce((a: number, m: any) => a + String(m.content ?? '').length, 0);
    const RECENT_KEEP = 6;
    if (msgs.length > 12 || totalChars > 8000) {
      const older = msgs.slice(0, Math.max(0, msgs.length - RECENT_KEEP));
      const recent = msgs.slice(Math.max(0, msgs.length - RECENT_KEEP));
      const summary = await summarizeConversation(older.map((m: any) => ({ role: m.role, content: String(m.content ?? '') })));
      if (summary) conversation.push({ role: 'system', content: '【对话记忆】' + summary });
      recent.forEach((m: any) => conversation.push({ role: m.role, content: m.content }));
    } else {
      msgs.forEach((m: any) => conversation.push({ role: m.role, content: m.content }));
    }

    // 知识库检索 + 自动计算（确定性内核）：作为独立 system 消息注入，避免污染 user 原文
    //   注意：aug 在此处只是后端 RAG 检索增强，不走 OpenAI / Anthropic 真 function calling schema
    //   标注为"内部参考"以引导 LLM 基于检索结果作答、禁止编造规范条款
    const lastUser = [...msgs].reverse().find((m: any) => m.role === 'user');
    const aug: { contextText: string; kb: any[]; calcs: any[]; ogs?: any } = lastUser
      ? await buildChatAugmentation(String(lastUser.content ?? ''))
      : { contextText: '', kb: [], calcs: [] };
    if (aug.contextText) {
      // 改为独立 system 消息（明确"内部参考"边界，不与用户原文混在一起）
      conversation.push({
        role: 'system',
        content:
          '【知识库检索增强 · 内部参考，请勿原样复述给用户】\n' +
          aug.contextText +
          '\n\n【作答要求：以上是后端 RAG 检索结果，供你参考引用；禁止编造规范条款；不要向用户暴露"系统消息"或"工具调用"等实现细节】',
      });
    }

    // 通道链：所选模型所在通道 → 备用通道（主备 fallback）
    const selectedCfg = resolveCfgForModel(selectedModel);
    const fallbackCfg = selectedCfg?.kind === 'glm' ? resolveOpenRouter() : resolveGlm();
    const chain: { cfg: CompatCfg; model: string }[] = [];
    if (selectedCfg) chain.push({ cfg: selectedCfg, model: selectedModel });
    if (fallbackCfg && fallbackCfg.baseUrl !== selectedCfg?.baseUrl) {
      chain.push({ cfg: fallbackCfg, model: fallbackCfg.model });
    }

    // 免费模型常见限制是并发=1 / 高峰期拥堵（429 / 5xx），做指数退避重试（最多 3 次）
    let upstream: globalThis.Response | null = null;
    let lastCfg: CompatCfg | null = null;
    for (const item of chain) {
      lastCfg = item.cfg;
      let maxTokens = detailMaxTokens(detail, item.cfg.kind);
      for (let attempt = 0; attempt < 3; attempt++) {
        const body: Record<string, unknown> = {
          model: item.model, messages: conversation, stream: true, temperature: 0.7,
          max_tokens: maxTokens,
        };
        if (item.cfg.kind === 'glm') body.thinking = { type: 'disabled' };
        upstream = await fetch(`${item.cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${item.cfg.apiKey}` },
          body: JSON.stringify(body),
        });
        // max_tokens 超限 / 上下文过长：减半重试，最终自动降档不中断
        if (!upstream.ok && upstream.status === 400) {
          const errText = await upstream.clone().text().catch(() => '');
          console.error(`[llm] ${item.cfg.model} 上游 400：`, errText.slice(0, 300));
          if (/max_tokens|maximum context|context length|invalid_request_error/i.test(errText)) {
            if (maxTokens > 512) { maxTokens = Math.floor(maxTokens / 2); continue; }
          }
        }
        if (upstream.status !== 429 && upstream.status < 500) break;
        await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt)));
      }
      if (upstream && upstream.ok && upstream.body) break;
    }

    if (!upstream || !upstream.ok || !upstream.body) {
      const detail = await upstream?.clone().text().catch(() => '');
      const brief = detail ? String(detail).replace(/\s+/g, ' ').slice(0, 140) : '';
      res.write(`data: ${JSON.stringify({ type: 'error', message: `${lastCfg?.label ?? 'AI 服务'} 错误 (${upstream?.status ?? '网络异常'})${brief ? '：' + brief : ''}` })}\n\n`);
      return; // 不直接 end，交给 finally 统一收尾（补 [DONE] + end）
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const effectiveModel = lastCfg && selectedCfg && lastCfg.baseUrl !== selectedCfg.baseUrl
      ? lastCfg.model
      : selectedModel;
    res.write(`data: ${JSON.stringify({ type: 'init', sessionId: sid, assistantMessageId: assistantMsgId, model: effectiveModel })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'sources', kb: aug.kb, calcs: aug.calcs })}\n\n`);

    // 知识库检索增强 + 工程计算内核：aug 已在服务端真实执行（RAG 已注入上面那条 system 消息）
    //   此处回放只是把结果以 SSE 事件形式告知前端做 UI 展示，type 字段明确为 'kb' / 'calc'
    //   注意：这不是 OpenAI / Anthropic 真 function calling schema，仅是后端到前端的事实通知
    const lastUserText = lastUser ? String(lastUser.content ?? '') : '';
    if (aug.kb.length) {
      const callId = uuidv4();
      res.write(`data: ${JSON.stringify({ type: 'tool_call', callId, name: 'kb_lookup', kind: 'kb', input: { query: lastUserText.slice(0, 100) } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'tool_result', callId, name: 'kb_lookup', kind: 'kb', output: JSON.stringify(aug.kb) })}\n\n`);
    }
    if (aug.calcs.length) {
      const intent = detectCalcIntent(lastUserText);
      const callId = uuidv4();
      const c = aug.calcs[0];
      res.write(`data: ${JSON.stringify({ type: 'tool_call', callId, name: 'calculate', kind: 'calc', input: intent ? { name: intent.name, params: intent.params } : { name: c.name } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'tool_result', callId, name: 'calculate', kind: 'calc', output: JSON.stringify(aug.calcs) })}\n\n`);
    }
    if (aug.ogs) {
      const callId = uuidv4();
      res.write(`data: ${JSON.stringify({ type: 'tool_call', callId, name: 'ogs_sim', kind: 'ogs', input: aug.ogs.input })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'tool_result', callId, name: 'ogs_sim', kind: 'ogs', output: JSON.stringify(aug.ogs.result) })}\n\n`);
    }

    // AI 生成 3D 场景：兼容通道无真 function calling，走确定性规则解析（hasSceneIntent + DEFAULT_NL_PARSER）
    //   显式建场请求（isExplicitSceneRequest）即使规则零命中也放行默认场景；非场景语 → 静默跳过
    if (lastUserText && hasSceneIntent(lastUserText)) {
      try {
        const scenePartial = DEFAULT_NL_PARSER(lastUserText);
        if (isExplicitSceneRequest(lastUserText) || (scenePartial && Object.keys(scenePartial).length)) {
          const ogsIntent = detectOgsIntent(lastUserText);
          // 去重：aug（buildChatAugmentation）已跑同一 OGS 场景则复用它，避免一请求算两遍并阻塞 LLM 流
          const reuseSum = (aug.ogs && aug.ogs.input.scenario === ogsIntent?.scenario)
            ? summarizeOgsResult(aug.ogs.result as any)
            : null;
          const built = await buildScene(
            {
              intent: { kind: 'natural', text: lastUserText },
              injectOgs: !!ogsIntent,
              ogsScenario: (ogsIntent?.scenario ?? undefined) as 'gas-production' | 'settlement' | 'degradation' | undefined,
            },
            { runOgs: reuseSum ? async () => reuseSum : runOgScenarioSummary },
          );
          const sceneCallId = uuidv4();
          res.write(`data: ${JSON.stringify({ type: 'tool_call', callId: sceneCallId, name: 'buildScene', kind: 'scene', input: { intent: 'natural', text: lastUserText.slice(0, 120) } })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'tool_result', callId: sceneCallId, name: 'buildScene', kind: 'scene', output: JSON.stringify({ ok: true, preset: built.preset, geo: built.geo, snapshot: built.snapshot, ogSummary: built.ogSummary ?? null, navigateTo: '/3d-simulator' }) })}\n\n`);
        }
      } catch (sceneErr: any) {
        // 场景生成失败不阻塞聊天主流程（兼容通道本就无工具回执语义）
        console.error('[scene-builder] compat 通道生成失败:', sceneErr?.message);
      }
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        if (!raw.startsWith('data: ')) continue;
        const data = raw.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data);
          const text = chunk.choices?.[0]?.delta?.content;
          if (text) {
            const clean = stripMarkdown(text);
            if (clean) res.write(`data: ${JSON.stringify({ type: 'text', text: clean })}\n\n`);
          }
        } catch {}
      }
    }

    // P0-8 修复：LLM 流结束后，按用户问题关键词触发追问引导
    //   generateFollowUp 在 FOLLOW_UP_GUIDES（4 类：边坡/渗滤液/沉降/甲烷）里匹配，
    //   命中且缺失参数时返回问句；否则 null（不打扰）。事件类型 follow_up 与
    //   useChat.ts SSE 解析器一一对应；前端会渲染为"⚠ 智能追问"卡片。
    if (lastUserText && !res.writableEnded) {
      try {
        const followUp = generateFollowUp(lastUserText, {});
        if (followUp) {
          // 反查 guide 的 kind（用同条 trigger 正则匹配）以便前端按类别展示图标
          const matched = FOLLOW_UP_GUIDES.find(g => g.trigger.test(lastUserText));
          const kind = matched ? (matched.requiredParams[0]?.toString().replace(/^[a-z]/, c => c.toLowerCase()) ?? 'general') : 'general';
          // kind 简化映射：requiredParams 首项为标识（如 slopeAngle → slope）
          const kindLabel =
            /边坡|稳定|Fs/.test(lastUserText) ? 'slope'
            : /渗滤液|液位|导排/.test(lastUserText) ? 'leachate'
            : /沉降|settlement/.test(lastUserText) ? 'settlement'
            : /甲烷|CH4|沼气/.test(lastUserText) ? 'methane'
            : 'general';
          const question = followUp.split(' | ')[0] ?? followUp;
          const hint = followUp.split(' | ').slice(1).join(' | ') ?? '';
          res.write(`data: ${JSON.stringify({ type: 'follow_up', kind: kindLabel, prompt: question, hint })}\n\n`);
        }
      } catch (fuErr) {
        // 追问引导失败不应阻塞正常 SSE 收尾
        console.error('[followUp] 生成失败:', (fuErr as Error)?.message);
      }
    }
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err?.message ?? '未知错误' })}\n\n`);
  } finally {
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}

// ============ CodeBuddy SDK SSE 流式（主引擎） ============
async function handleCodeBuddyChat(req: express.Request, res: express.Response) {
  const { messages, systemPrompt, sessionId, permissionMode, detail } = req.body as {
    messages: any[]; systemPrompt?: string; sessionId?: string; permissionMode?: string; detail?: DetailLevel;
  };
  const sid = sessionId ?? uuidv4();
  const assistantMsgId = uuidv4();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

    // SSE 心跳：每 15 秒发 :keepalive 注释行，防反代/浏览器断开
    const ka = setInterval(() => {
      if (res.writableEnded) { clearInterval(ka); return; }
      try { res.write(':keepalive\n\n'); } catch { clearInterval(ka); }
    }, 15000);
    res.on('close', () => clearInterval(ka));

  try {
    // 动态导入 SDK（延迟加载避免启动报错）
    const { query } = await import('@tencent-ai/agent-sdk');
    const conv = (messages ?? []).map((m: any) => ({ role: m.role, content: m.content }));

    // SDK 类型随版本变动，按兼容选项调用
    //   【重要】该分支仅在设置了 CODEBUDDY_API_KEY 时启用（见 POST /api/chat 分发逻辑）
    //   这里的 tools 是 OpenAI / Anthropic 真 function calling schema：模型在生成过程中
    //   主动调用 kb_lookup / calculate / run_diagnosis 后，SDK 流式产出 type='tool_call' 事件，
    //   本函数再真实执行工具并产出 type='tool_result'——形成完整的工具调用循环。
    //   当 CODEBUDDY_API_KEY 未设置时，会回退到上方的 handleCompatChat：那条路径不使用
    //   真 function calling，aug 走的是 RAG 检索 + 独立 system 消息注入 + SSE 结果回放（仅 UI 用）。
    const stream = await (query as any)({
      messages: conv,
      system: (systemPrompt ?? '') + detailPromptSuffix(detail),
      tools: [
        {
          name: 'kb_lookup',
          description: '从规范知识库检索相关条目，返回规范依据和条款摘要',
          input_schema: { type: 'object', properties: { query: { type: 'string', description: '检索关键词' } }, required: ['query'] },
        },
        {
          name: 'calculate',
          description: '调用专业工程计算器，输入参数返回计算结果和风险评级',
          input_schema: { type: 'object', properties: { name: { type: 'string' }, params: { type: 'object' } }, required: ['name', 'params'] },
        },
        {
          name: 'run_diagnosis',
          description: '对填埋场/地下水场地进行双引擎诊断，返回风险等级和处置建议',
          input_schema: { type: 'object', properties: { data: { type: 'object' } }, required: ['data'] },
        },
        {
          name: 'buildScene',
          description: 'AI 生成填埋场 3D 场景：根据用户自然语言/参数输出 8 维几何参数（GeoParams），可选联动稳定化计算（OGS），前端跳转 3D 仿真器渲染',
          input_schema: {
            type: 'object',
            properties: {
              intent: {
                type: 'object',
                description: '场景意图：preset(预设) / custom(自定义参数) / natural(自然语言)',
                properties: {
                  kind: { type: 'string', enum: ['preset', 'custom', 'natural'] },
                  key: { type: 'string', enum: ['small', 'large', 'default'], description: 'preset 时必填' },
                  geo: { type: 'object', description: 'custom 时填 GeoParams 子集（valleyWidth 0.6-1.6 / pileHeight 0.5-1.8 / pondVolume 0.4-2.2 / gasWellSpacing 0.6-1.5 / damHeight 0.5-2.0 / treeDensity 0.4-1.6 / vehicleCount 0-8 / volumeScale 0.2-2.2）' },
                  text: { type: 'string', description: 'natural 时必填，例："缓坡山谷型 500 万 m³ 的填埋场"' },
                },
                required: ['kind'],
              },
              injectOgs: { type: 'boolean', description: '是否同步触发稳定化计算并联动 3D', default: false },
              ogsScenario: { type: 'string', enum: ['gas-production', 'settlement', 'degradation'] },
            },
            required: ['intent'],
          },
        },
      ],
      stream: true,
      ...(permissionMode === 'acceptAll' ? { permission_mode: 'accept_all' } : {}),
    });

    res.write(`data: ${JSON.stringify({ type: 'init', sessionId: sid, assistantMessageId: assistantMsgId })}\n\n`);

    for await (const rawEvent of stream) {
      const event: any = rawEvent;
      if (event.type === 'text' && event.text) {
        const cleanText = stripMarkdown(event.text);
        if (cleanText) res.write(`data: ${JSON.stringify({ type: 'text', text: cleanText })}\n\n`);
      } else if (event.type === 'tool_call' && event.name) {
        const callId = event.call_id ?? uuidv4();
        res.write(`data: ${JSON.stringify({ type: 'tool_call', callId, name: event.name, input: event.input ?? {} })}\n\n`);

        // 执行工具
        try {
          let output: any;
          if (event.name === 'kb_lookup') {
            const q = (event.input as any)?.query ?? '';
            const results = lookupKB(q, 3);
            output = JSON.stringify(results.slice(0, 3));
          } else if (event.name === 'calculate') {
            const { name, params } = (event.input as any) ?? {};
            if (name && CALC_REGISTRY[name]) {
              output = JSON.stringify(CALC_REGISTRY[name](params ?? {}));
            } else {
              output = JSON.stringify({ error: `未知计算器: ${name}` });
            }
          } else if (event.name === 'run_diagnosis') {
            const { data } = (event.input as any) ?? {};
            const cfg = resolveCompat();
            const result = await runDiagnosis(data ?? {}, cfg?.models ?? ['glm-4-flash-250414'], cfg?.apiKey ?? '', cfg?.baseUrl ?? 'https://openrouter.ai/api/v1');
            output = JSON.stringify(result);
          } else if (event.name === 'buildScene') {
            // AI 生成 3D 场景：LLM 结构化 intent → scene-builder → SSE 回放 scene 卡片
            const built = await buildScene(event.input ?? {}, { runOgs: runOgScenarioSummary });
            output = JSON.stringify({ ok: true, preset: built.preset, geo: built.geo, snapshot: built.snapshot, ogSummary: built.ogSummary ?? null, navigateTo: '/3d-simulator' });
          }
          res.write(`data: ${JSON.stringify({ type: 'tool_result', callId, output })}\n\n`);
        } catch (toolErr: any) {
          res.write(`data: ${JSON.stringify({ type: 'tool_result', callId, output: `工具执行错误: ${toolErr?.message}` })}\n\n`);
        }
      } else if (event.type === 'permission') {
        res.write(`data: ${JSON.stringify({ type: 'permission', tool: event.tool, params: event.params })}\n\n`);
      }
    }
  } catch (err: any) {
    // SDK 不可用，降级到 OpenAI 兼容接口
    const cfg = resolveCompat();
    if (cfg) {
      console.warn('[chat] CodeBuddy SDK 失败，降级到 compat:', err?.message);
      await handleCompatChat(req, res, cfg);
      return;
    }
    // 没有 compat 通道可降级：给前端友好错误
    const msg = `CodeBuddy SDK 启动失败（${err?.message ?? '未知错误'}）。请在服务器 .env 设置 OPENAI_API_KEY（智谱 GLM 免费）或 OPENROUTER_API_KEY。`;
    console.error('[chat]', msg);
    res.write(`data: ${JSON.stringify({ type: 'error', message: msg, needConfig: true })}\n\n`);
  } finally {
    // 降级路径已由 handleCompatChat 收尾，这里只在尚未结束时补 [DONE]
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}

// ============ POST /api/chat ============
// 分发逻辑（v4.3 修复）：
//   1. 优先 OpenAI 兼容通道（GLM/OpenRouter/CodeBuddy-OpenAI-mode）—— 最稳定
//   2. 仅当显式设置了 CODEBUDDY_API_KEY 且无 compat 通道时，走原 CodeBuddy SDK
//   3. 都没有：返回 503 友好提示，**不再**自动尝试 spawn SDK（避免 CLI 错误）
app.post('/api/chat', async (req, res) => {
  const cfg = resolveCompat();
  if (cfg) {
    // 通道链：所选模型所在通道 → 备用通道（GLM ↔ OpenRouter）
    return await handleCompatChat(req, res, cfg);
  }
  if (process.env.CODEBUDDY_API_KEY) {
    // 用户显式要求走 CodeBuddy
    return await handleCodeBuddyChat(req, res);
  }
  // 无任何通道：直接给前端友好错误，**不再**走 SDK
  console.error('[chat] 无可用 LLM 通道：OPENAI_API_KEY / OPENROUTER_API_KEY / CODEBUDDY_API_KEY 均未配置');
  res.status(503).json({
    error: '后端未配置任何 LLM 通道。请在服务器 .env 里设置 OPENAI_API_KEY（智谱 GLM，免费）或 OPENROUTER_API_KEY 后重启 dev server。',
    needConfig: true,
  });
});

// ============ 会话管理 ============
app.get('/api/sessions', (_req, res) => {
  try {
    const sessions = db.getAllSessions().map(s => ({
      id: s.id,
      title: s.title,
      agentId: 'default',
      model: s.model,
      messages: db.getMessagesBySession(s.id).map(m => {
        let toolCalls;
        try {
          toolCalls = m.tool_calls ? JSON.parse(m.tool_calls) : undefined;
        } catch {
          toolCalls = undefined;
        }
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: new Date(m.created_at).getTime(),
          toolCalls,
        };
      }),
      createdAt: new Date(s.created_at).getTime(),
      updatedAt: new Date(s.updated_at).getTime(),
    }));
    res.json({ sessions });
  } catch {
    res.json({ sessions: [] });
  }
});

// 前端每轮对话后同步：整体 upsert 会话 + 替换消息列表（刷新页面不丢）
app.post('/api/sessions', (req, res) => {
  try {
    const s = (req.body?.session ?? req.body) as any;
    if (!s?.id) {
      return res.status(400).json({ error: '无效会话数据' });
    }
    const now = new Date();
    const existing = db.getSession(String(s.id));
    db.upsertSession({
      id: String(s.id),
      title: typeof s.title === 'string' ? s.title : (existing?.title ?? '新会话'),
      model: typeof s.model === 'string' ? s.model : (existing?.model ?? 'codebuddy'),
      sdk_session_id: existing?.sdk_session_id ?? null,
      created_at: existing?.created_at ?? (s.createdAt ? new Date(s.createdAt).toISOString() : now.toISOString()),
      updated_at: now.toISOString(),
    });
    if (Array.isArray(s.messages)) {
      db.replaceMessages(String(s.id), s.messages.map((m: any) => ({
        id: String(m.id ?? uuidv4()),
        session_id: String(s.id),
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content ?? ''),
        model: null,
        created_at: m.timestamp ? new Date(m.timestamp).toISOString() : now.toISOString(),
        tool_calls: m.toolCalls ? JSON.stringify(m.toolCalls) : null,
      })));
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? '保存失败' });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  try {
    db.deleteSession(req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: '删除失败' });
  }
});

// ============ POST /api/diagnose ============
app.post('/api/diagnose', async (req, res) => {
  try {
    const cfg = resolveCompat();
    const result = await runDiagnosis(
      req.body.data ?? req.body,
      cfg?.models ?? ['glm-4-flash-250414'],
      cfg?.apiKey ?? '',
      cfg?.baseUrl ?? 'https://openrouter.ai/api/v1',
      req.body.detail ?? 'detailed',
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? '诊断失败' });
  }
});

// ============ 多智能体协同（参数抽取 + 缓存重放 + SSE 流式） ============
app.post('/api/multiagent', async (req, res) => {
  const { scenario, agent, peerResults, params, detail } = req.body as {
    scenario?: string; agent?: string;
    peerResults?: Record<string, { result: string; grade?: string }>;
    params?: MASceneParams | null;
    // P1-4 修复：透传回答详细度三档（brief/standard/detailed），影响 MA 路径 maxTokens 与 promptSuffix
    detail?: DetailLevel;
  };
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

    // SSE 心跳：每 15 秒发 :keepalive 注释行，防反代/浏览器断开
    const ka = setInterval(() => {
      if (res.writableEnded) { clearInterval(ka); return; }
      try { res.write(':keepalive\n\n'); } catch { clearInterval(ka); }
    }, 15000);
    res.on('close', () => clearInterval(ka));
  try {
    const scene = scenario ?? '';
    // 表单显式参数优先，缺失时 LLM 结构化 JSON 抽取兜底（文本正则快路径）
    const p = await extractSceneParams(scene, params ?? null);
    // P1-4 修复：detail 透传到 getCachedAgentRun（不影响缓存 key，仅影响 runAgent 内的 maxTokens/promptSuffix）
    const { events, fromCache } = await getCachedAgentRun(agent ?? 'summary', scene, p, detail);
    if (fromCache) {
      // P1-3 修复：路由层补一次 cache_hit SSE 事件，保证即便 events 数组里没有 cache_hit
      //   （例如未来重构 getCachedAgentRun 时遗漏），前端仍能拿到独立事件类型并渲染 ⚡ 闪卡徽标。
      //   该事件先于合成 agent_step 抵达前端，避免被合成 step 抢走"第一个事件"的视觉位置。
      res.write(`data: ${JSON.stringify({ type: 'cache_hit', agent: agent ?? 'summary', cachedAt: Date.now(), scenario: scene.slice(0, 80) })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'agent_step', agent: agent ?? 'summary', step: { id: 'cache', label: '命中结果缓存：直接重放上次分析（零模型成本）', status: 'done' } })}\n\n`);
    }
    for (const ev of events) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
      // 每个推理步骤间插入短暂延迟，模拟 Agent 逐步思考的节奏（缓存重放更快）
      if (ev.type === 'agent_step') {
        await new Promise(r => setTimeout(r, fromCache ? 40 : 280));
      }
    }
  } catch (e: any) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: e?.message ?? 'Agent 执行异常' })}\n\n`);
  } finally {
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ============ 调试：清空多智能体结果缓存（现场应急：LLM 通道异常态落入缓存后强制重算） ============
app.get('/api/agent-cache/clear', (_req, res) => {
  const cleared = agentCache.size;
  agentCache.clear();
  res.json({ ok: true, cleared });
});

// ============ 调试：查询多智能体缓存状态（现场演示 LRU 工程亮点） ============
//   返回：当前缓存条目数 / 已用容量 / 最近 N 条缓存 key（脱敏后的 agent+params 摘要），
//   便于评委查看"预热了多少条演示结论、是否被淘汰"等运行态指标。
app.get('/api/agent-cache/status', (_req, res) => {
  const keys = Array.from(agentCache.keys()).map((k) => {
    // 缓存 key 形如 "agent|{...params}|scenario"，脱敏后只回显 agent + 截断的场景摘要
    const [agent, , scenario] = k.split('|');
    return { agent, scenario: (scenario ?? '').slice(0, 40) };
  });
  res.json({
    size: agentCache.size,
    capacity: 20, // 与 multiagent.ts 中 AGENT_CACHE_MAX 保持一致
    keys,
  });
});

// ============ GET /api/models（前端模型下拉的真实数据源） ============
app.get('/api/models', (_req, res) => {
  const models: { id: string; name: string; provider: string }[] = [];
  if (process.env.CODEBUDDY_API_KEY) {
    models.push({ id: 'codebuddy', name: 'CodeBuddy（主）', provider: '腾讯云 AI' });
  }
  const or = resolveOpenRouter();
  if (or) {
    or.models.forEach(id => models.push({ id, name: friendlyModelName(id), provider: 'OpenRouter' }));
  }
  const glm = resolveGlm();
  if (glm) {
    glm.models.forEach(id => models.push({ id, name: friendlyModelName(id), provider: '智谱直连' }));
  }
  res.json({ models, active: getProvider() });
});

// ============ 健康检查 ============
app.get('/api/health', (_req, res) => {
  const cfg = resolveCompat();
  res.json({
    status: 'ok',
    version: '4.2.0',
    provider: getProvider(),
    model: process.env.CODEBUDDY_API_KEY ? 'codebuddy' : (cfg?.model ?? null),
    kbCount: KB_ENTRIES.length,
    calcCount: Object.keys(CALC_REGISTRY).length,
    uptime: process.uptime(),
  });
});

// ============ P3 用户反馈系统（E） ============
import { saveFeedback, listFeedback, getFeedbackStats, enqueueDistill, listDistillCandidates, distillToKBEntry, feedbackTrendByDay } from './feedback';
import { adminAuth, getAdminAuthStatus } from './adminAuth';
app.post('/api/feedback', (req, res) => {
  try {
    const { sessionId, messageId, rating, comment, agentKey, model, kbRefs, abVariant } = req.body ?? {};
    if (!sessionId || !messageId || !['up', 'down'].includes(rating)) {
      return res.status(400).json({ ok: false, error: 'invalid params' });
    }
    const fb = saveFeedback({ sessionId, messageId, rating, comment, agentKey, model, kbRefs, abVariant });
    // 低分反馈自动入蒸馏队列
    if (rating === 'down' && comment && comment.length > 5) {
      const c = enqueueDistill(fb);
      console.log(`[feedback] 自动入蒸馏队列 #${c.feedbackId.slice(0, 8)}`);
    }
    // AB test 反馈统计
    if (abVariant) {
      recordFeedback(abVariant, rating);
    }
    res.json({ ok: true, feedback: fb });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});
app.get('/api/feedback/stats', (_req, res) => {
  res.json({ ok: true, stats: getFeedbackStats() });
});
app.get('/api/feedback/list', (req, res) => {
  const limit = parseInt(String(req.query.limit ?? 50));
  res.json({ ok: true, items: listFeedback(limit) });
});
app.get('/api/feedback/trend', (req, res) => {
  const days = parseInt(String(req.query.days ?? 14));
  res.json({ ok: true, trend: feedbackTrendByDay(days) });
});
app.post('/api/feedback/distill', adminAuth, (req, res) => {
  const candidates = listDistillCandidates().filter(c => c.status === 'pending');
  const entries = candidates.map(c => distillToKBEntry(c)).filter(Boolean);
  res.json({ ok: true, candidatesCount: candidates.length, entries });
});
// L: 检查 admin auth 状态（无需 token 即可探查）
app.get('/api/admin/auth-status', (_req, res) => {
  res.json({ ok: true, ...getAdminAuthStatus() });
});

// ============ P3 A/B 测试系统（G） ============
import { selectVariant, recordImpression, getABStats, getAllVariants, recordFeedback } from './abTest';
app.get('/api/ab/variants', (_req, res) => {
  res.json({ ok: true, variants: getAllVariants() });
});
app.get('/api/ab/stats', (_req, res) => {
  res.json({ ok: true, stats: getABStats() });
});
app.get('/api/ab/assign', (req, res) => {
  const variant = selectVariant();
  recordImpression(variant.id);
  res.json({ ok: true, variant });
});
// L: AB 重置（受保护）
app.post('/api/ab/reset', adminAuth, (_req, res) => {
  const variants = getAllVariants();
  for (const v of variants) {
    v.stats.impressions = 0;
    v.stats.upCount = 0;
    v.stats.downCount = 0;
    v.weight = 1.0;
  }
  res.json({ ok: true, message: 'AB stats 重置完成' });
});

// ============ 独立路由模块（calc / ogs / kb / iot） ============
app.use(calcRouter());
app.use(ogsRouter());
app.use(kbRouter());
app.use(iotRouter());

// ============ /api/* 404 JSON 兜底（防止 SPA fallback 返回 HTML 让前端 fetch JSON.parse 报错） ============
app.use('/api', (_req, res) => {
  res.status(404).json({ error: '未找到该接口' });
});

// ============ 静态托管（生产：同源托管前端构建产物） ============
const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// ============ 演示 IP 限流数据定期清理（防无界增长 + 跨天重置） ============
const demoCleanupTimer = setInterval(() => {
  const now = Date.now();
  const today = formatLocalDate(new Date());
  let freedMinute = 0, freedDay = 0;
  for (const [k, v] of ipMinute) { if (now >= v.resetAt) { ipMinute.delete(k); freedMinute++; } }
  for (const [k, v] of ipDay) { if (v.day !== today) { ipDay.delete(k); freedDay++; } }
  if (freedMinute + freedDay > 0) console.log(`[ratelimit] 清过期 IP：minute=${freedMinute}, day=${freedDay}, remaining=${ipMinute.size}/${ipDay.size}`);
}, 60_000);
// Render 免费层无 unref 需求；保持活动以确保清理在服务生命周期内持续
demoCleanupTimer.unref?.();

// ============ 优雅退出（Render 重启 / Docker SIGTERM 不硬杀） ============
// 提到 listen 之前，避免 listen 回调里再嵌套函数声明（hoist 隐患）
function gracefulShutdown(signal: string) {
  console.log(`\n[${signal}] 收到退出信号，关闭 HTTP 服务并落盘...`);
  server.close((err) => {
    if (err) console.error('[shutdown] server.close 错误:', err);
    try { import('./db.js').then(db => db.persistNow()); } catch {}
    setTimeout(() => process.exit(err ? 1 : 0), 1500).unref?.();
  });
  setTimeout(() => { console.error('[shutdown] 强杀兜底'); process.exit(1); }, 8000).unref?.();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => { console.error('[uncaughtException]', err); gracefulShutdown('uncaughtException'); });

// ============ 启动 ============
// bootstrap：等 initDb 完成后再 listen，避免冷启动首请求撞"数据库尚未初始化"
const PORT = parseInt(process.env.PORT ?? '3000');
let server: import('http').Server;

async function bootstrap() {
  await dbReady; // initDb 已完成，表结构就绪
  // IoT broker：嵌入式 MQTT（端口 1884）+ 5 个 mock 传感器定时推送
  //  失败不阻塞 server 启动（演示中 broker 不可用不影响对话/3D 主流程）
  try {
    await startIotBroker();
  } catch (e) {
    console.error('[iot] broker 启动失败（继续运行，无 IoT 数据流）:', (e as Error).message);
  }
  server = app.listen(PORT, () => {
    const cfg = resolveCompat();
    const engine = process.env.CODEBUDDY_API_KEY
      ? 'CodeBuddy（主）' + (cfg ? ` + ${cfg.label}（备）` : '')
      : cfg ? `${cfg.label}（${cfg.model}）` : '未配置（请在 .env 填入 API Key）';

    console.log(`\n  LandfillMind · 填埋场全周期智能体 v4.4 后端已启动`);
    console.log(`  端口: http://localhost:${PORT}`);
    console.log(`  模型: ${engine}`);
    console.log(`  静态托管: ${fs.existsSync(distPath) ? distPath : '未构建（开发模式走 Vite 代理）'}`);
    console.log(`  KB: ${KB_ENTRIES.length}条规范知识库`);
    console.log(`  Calc: ${Object.keys(CALC_REGISTRY).length}项计算器\n`);

    // 预热多智能体演示缓存（评委首跑秒回放；WARM_AGENT_CACHE=0 关闭；无 LLM 通道时跳过避免缓存模板文本）
    if (process.env.WARM_AGENT_CACHE !== '0' && resolveCompat()) {
      const mode = process.env.WARM_AGENT_CACHE_PARALLEL === '1' ? '并发' : '串行';
      console.log(`[multiagent] 演示缓存预热（${mode}）开始，预计 30-120s …`);
      warmAgentCache().catch((e: any) => console.error('[multiagent] 演示缓存预热失败:', e?.message));
    }
  });
}

bootstrap().catch((err) => {
  console.error('[boot] bootstrap 失败:', err);
  process.exit(1);
});
