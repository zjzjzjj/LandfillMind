/**
 * LandfillMind · 填埋场智慧监测系统 v4.2 — 后端服务入口
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
import * as calc from './calculate.js';
import { lookupKB, getKB, KB_ENTRIES } from './kb.js';
import { AGENT_TOOL_USAGE } from './prompts.js';
import { extractSceneParams, getCachedAgentRun, agentCache, warmAgentCache } from './multiagent.js';
import type { MASceneParams } from './multiagent.js';
import { resolveCompat, resolveCfgForModel, resolveOpenRouter, resolveGlm, detailMaxTokens, detailPromptSuffix } from './llm.js';
import { gaussian } from './calculate.js';

import { initRetrieval } from './retrieval.js';
import { buildChatAugmentation, summarizeConversation, detectCalcIntent } from './augment.js';
import { getOgsStatus, listOgsScenarios, runOgsScenario, getOgsRunFiles } from './ogs.js';
import type { DetailLevel } from './llm.js';
import type { CompatCfg } from './llm.js';
import { generateFollowUp, FOLLOW_UP_GUIDES } from './followUp.js';

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
          const errText = await upstream.text().catch(() => '');
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
      res.write(`data: ${JSON.stringify({ type: 'error', message: `${lastCfg?.label ?? 'AI 服务'} 错误 (${upstream?.status ?? '网络异常'})` })}\n\n`);
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

// ============ 计算器 ============
// num: 将输入宽松转为有限数字；缺失/非法时回退到默认值（避免透传把整个对象当位置参数导致 NaN）
function num(v: any, def?: number): number {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : (def ?? NaN);
}

const CALC_REGISTRY: Record<string, (params: any) => any> = {
  // v4.5 全部走 calculate.ts 的新函数，extra 字段透传
  slopeFs: (p: any) => {
    const r = calc.slopeFs(
      num(p.H, 30), num(p.beta, 3), num(p.gamma, 10), num(p.c, 5), num(p.phi, 25),
      num(p.waterTableDepth, 10), num(p.seismicCoeff, 0), num(p.surcharge, 0),
    );
    return { ...r };
  },
  capacity: (p: any) => {
    const r = calc.capacity(
      num(p.A, 10), num(p.H, 30), num(p.rho, 10), num(p.Qd, 500),
      Math.max(1, num(p.phases, 1)), num(p.coverRatio, 0), num(p.sFactor, 1),
    );
    return { ...r };
  },
  settlementHyper: (p: any) => {
    const r = calc.settlementHyper(num(p.t1, 30), num(p.s1, 50), num(p.t2, 180), num(p.s2, 200));
    return { ...r };
  },
  optimizeWellSpacing: (p: any) => {
    const r = calc.optimizeWellSpacing(
      num(p.effectiveRadius, num(p.H, 30)),
      p.pattern ?? 'hexagonal',
      num(p.drawdown, 5),
      num(p.interferenceFactor, 0.4),
    );
    return { ...r };
  },
  leachateCalc: (p: any) => {
    // area 仍按"万㎡"输入，内部 ×10000 → m²
    const r = calc.calculateLeachate(
      num(p.area) * 10000, num(p.rainfall, 1200),
      num(p.runoffCoeff, 0.3), num(p.wasteHeight, 0),
      num(p.ET, 800), num(p.cloggingFactor, 0), num(p.recirculationRatio, 0),
    );
    return { ...r };
  },
  moisturePredict: (p: any) => {
    const r = calc.predictMoisture(
      num(p.initialMoisture, 60), num(p.injectionPressure, 15), num(p.days, 7), num(p.depth, 5),
      num(p.gasFlow, 50), num(p.screenLength, 3), num(p.wellheadLoss, 1),
    );
    return { ...r };
  },
  lfgYield: (p: any) => {
    const r = calc.lfgYield(
      num(p.M, 500), num(p.k, 0.1), num(p.year, 10), num(p.Lo, 170),
      num(p.utilizationFactor, 0.5), num(p.flareEfficiency, 0.9),
    );
    return { ...r };
  },
  hdpeCheck: (p: any) => {
    const r = calc.hdpeCheck(
      num(p.D, 1.5), num(p.sigma, 27), num(p.eps, 700),
      num(p.P, 0.2), num(p.hold, 5),
      num(p.carbonBlack, 2.5), num(p.punctureResistance, 480), num(p.oxidInductionTime, 100),
    );
    return { ...r };
  },
  linerKeq: (p: any) => {
    const r = calc.linerKeq(
      num(p.d1, 1.5), num(p.k1, 0.0000001), num(p.d2, 6), num(p.k2, 0.000000001), num(p.theta, 0.1),
      num(p.seamLength, 50), num(p.chemicalCompatibility, 1),
    );
    return { ...r };
  },
  wellR: (p: any) => {
    const r = calc.wellR(
      num(p.Q, 100), num(p.t, 30), num(p.ne, 0.3), num(p.dh, 2),
      p.aquiferType ?? 'unconfined', num(p.thickness, 20),
    );
    return { ...r };
  },
  injectR: (p: any) => {
    const r = calc.injectR(
      num(p.Pinj, 4), num(p.t, 24), num(p.mu, 1.0), num(p.k, 1.0),
      num(p.porosity, 0.3), num(p.gasViscosity, 0.018), num(p.formationCompressibility, 1e-6),
    );
    return { ...r };
  },
  advect: (p: any) => {
    const r = calc.advect(
      num(p.C0, 100), num(p.v, 0.1), num(p.x, 50), num(p.D, 10),
      num(p.retardationFactor, 1), num(p.decayRate, 0),
    );
    return { ...r };
  },
  soilScreen: (p: any) => {
    const r = calc.soilScreen(p.pol ?? '砷', p.cls ?? '一类(居住/学校)', p.depthLayer ?? '0.5-1.5');
    return { ...r };
  },
  decayCalc: (p: any) => {
    const r = calc.decayCalc(num(p.C0, 500), num(p.Ctarget, 50), num(p.t12, 1000), num(p.monitoringCostPerYear, 8));
    return { ...r };
  },
};

// 各计算器的规范公式（用于计算书"计算公式"章节，公式按规范/经验式给出）
const CALC_FORMULAS: Record<string, string> = {
  slopeFs: 'Fs = (c·L + W·cos²α·tanφ) / (W·sinα·cosα)；运行期要求 Fs ≥ 1.30（CJJ 176-2012 §4.5）',
  capacity: 'V = A·H·10⁴；使用年限 T = W / (Qd × 365)（CJJ 176-2012 §3.3）',
  hdpeCheck: 'D ≥ 1.5mm；σ ≥ 27MPa；ε ≥ 700%；焊缝气压 0.2MPa 持压 5min 压降 <10%（GB/T 17643-2011 / GB 16889-2008 §5.1）',
  wellR: 'R = √(Q·t / (π·nₑ·Δh))（HJ 25.6-2019）',
  injectR: 'r ≈ k·√(P_inj·t / μ)（CJJ 176-2012 §5.2 / 研究经验式）',
  leachateCalc: 'Q = A·P·C·η / 1000（A=面积㎡，P=年降雨mm，C=径流系数，η=覆盖折减）（CJJ 176-2012 §5.1）',
  lfgYield: 'Q(t) = k·L₀·M·exp(−k·t)（USEPA LandGEM 一阶衰减）',
  advect: 'C(x) = C0·exp(−v·x/D)（HJ 25.6-2019）',
  soilScreen: 'C ≤ GB 36600-2018 表1 筛选值/管制值',
  decayCalc: 'T = ln(C0/Ct) / λ；λ = ln2 / t½（HJ 25.6-2019）',
  linerKeq: 'k_eq = d_total² / (d₂²/k₂ + d₁·d₂·θ/k₁)；k_eq ≤ 1×10⁻⁹ cm/s（GB 16889-2008 §5.1）',
  settlementHyper: 's(t) = s∞·t / (a + t)（CJJ 176-2012 §4.6，双曲线法）',
  optimizeWellSpacing: 'D = √3·R（梅花形）或 2R（方形），井群叠加降深 = 单井 × (1+interference)',
  moisturePredict: 'ΔS = inflow − et − runoff；储水量上限 = storageMax（CJJ 176-2012 §5.3）',
  // v4.5 移除 extractionPressure（占位实现 + 字段脱钩）
};

// 单计算器路由放在最后（避免抢匹配 /api/calc/sensitivity 等保留路由）
// 见下：app.post('/api/calc/:name', ...)

app.get('/api/calc', (_req, res) => {
  res.json({ count: Object.keys(CALC_REGISTRY).length, names: Object.keys(CALC_REGISTRY) });
});

// ============ v4.3 新增：敏感性分析 ============
// POST /api/calc/sensitivity
//   body: { name, params, varyParam, n?, range? }
//   → { xs, ys, baseValue, baseX, param, unit }
app.post('/api/calc/sensitivity', (req, res) => {
  const { name, params = {}, varyParam, n = 20, range } = req.body ?? {};
  if (!name || !CALC_REGISTRY[name]) {
    return res.status(400).json({ error: `未知计算器: ${name}`, available: Object.keys(CALC_REGISTRY) });
  }
  if (!varyParam) {
    return res.status(400).json({ error: '缺少 varyParam' });
  }
  const fn = CALC_REGISTRY[name];
  const baseX = num(params[varyParam], 1);
  let lo: number, hi: number;
  if (Array.isArray(range) && range.length === 2 && Number.isFinite(range[0]) && Number.isFinite(range[1])) {
    [lo, hi] = range;
  } else {
    // 默认 baseX ± 50%，且下界 ≥ 0
    const half = Math.max(Math.abs(baseX) * 0.5, 1);
    lo = Math.max(0, baseX - half);
    hi = baseX + half;
  }
  const xs: number[] = [];
  const ys: number[] = [];
  const steps = Math.max(2, Math.min(50, Math.floor(n)));
  for (let i = 0; i < steps; i++) {
    const x = lo + (hi - lo) * (i / (steps - 1));
    xs.push(x);
    const testParams: any = { ...params, [varyParam]: x };
    try {
      const r = fn(testParams);
      const y = typeof r?.value === 'number' ? r.value : NaN;
      ys.push(y);
    } catch {
      ys.push(NaN);
    }
  }
  // 基准值（用原参数跑一次）
  let baseValue: number = NaN;
  try {
    const r0 = fn(params);
    baseValue = typeof r0?.value === 'number' ? r0.value : NaN;
  } catch { /* 保持 NaN */ }
  res.json({ xs, ys, baseValue, baseX, param: varyParam });
});

// ============ v4.3 新增：蒙特卡洛风险评估 ============
// POST /api/calc/montecarlo
//   body: { name, params, paramDist, threshold, iterations? }
//   → { samples, mean, p5, p50, p95, min, max, failProb, threshold, iterations }
app.post('/api/calc/montecarlo', (req, res) => {
  const {
    name, params = {},
    paramDist = {},
    threshold = { op: '<', value: 1.3 },
    iterations = 500,
  } = req.body ?? {};
  if (!name || !CALC_REGISTRY[name]) {
    return res.status(400).json({ error: `未知计算器: ${name}`, available: Object.keys(CALC_REGISTRY) });
  }
  if (!threshold || typeof threshold.value !== 'number' || !['<', '<=', '>', '>='].includes(threshold.op)) {
    return res.status(400).json({ error: 'threshold 必须是 {op, value} 且 op ∈ {<, <=, >, >=' });
  }
  const fn = CALC_REGISTRY[name];
  const N = Math.max(50, Math.min(2000, Math.floor(iterations)));
  const samples: number[] = [];
  let failCount = 0;
  // 对每个 paramDist 的 key，生成扰动后的参数
  const distKeys = Object.keys(paramDist);
  for (let i = 0; i < N; i++) {
    const sampleParams: any = { ...params };
    for (const k of distKeys) {
      const { mean, std } = paramDist[k] ?? {};
      if (typeof mean === 'number' && typeof std === 'number' && std > 0) {
        const base = num(params[k], mean);
        const perturbed = base + gaussian() * std;
        sampleParams[k] = Math.max(0, perturbed); // 物理量非负
      }
    }
    try {
      const r = fn(sampleParams);
      const v = typeof r?.value === 'number' ? r.value : null;
      if (v !== null) {
        samples.push(v);
        // 阈值判定
        const op = threshold.op;
        const tv = threshold.value;
        if ((op === '<' && v < tv) || (op === '<=' && v <= tv) || (op === '>' && v > tv) || (op === '>=' && v >= tv)) {
          failCount++;
        }
      }
    } catch { /* skip failed sample */ }
  }
  if (samples.length === 0) {
    return res.status(500).json({ error: '蒙特卡洛采样全部失败，请检查参数' });
  }
  // 排序取分位数
  const sorted = [...samples].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  res.json({
    samples,
    mean,
    p5: q(0.05),
    p50: q(0.50),
    p95: q(0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    failProb: failCount / samples.length,
    threshold: threshold.value,
    iterations: samples.length,
  });
});

// ============ v4.3 新增：场景对比 ============
// POST /api/calc/compare
//   body: { name, scenarios: [{ label, params }] }
//   → { results: [{ label, value, grade, unit, analysis }] }
app.post('/api/calc/compare', (req, res) => {
  const { name, scenarios = [] } = req.body ?? {};
  if (!name || !CALC_REGISTRY[name]) {
    return res.status(400).json({ error: `未知计算器: ${name}`, available: Object.keys(CALC_REGISTRY) });
  }
  if (!Array.isArray(scenarios) || scenarios.length < 2) {
    return res.status(400).json({ error: 'scenarios 至少 2 个' });
  }
  const fn = CALC_REGISTRY[name];
  const results = scenarios.map((sc: any) => {
    try {
      const r = fn(sc.params ?? {});
      return {
        label: String(sc.label ?? '未命名场景'),
        value: r?.value,
        unit: r?.unit,
        grade: r?.grade,
        analysis: r?.analysis,
      };
    } catch (e: any) {
      return { label: String(sc.label ?? '未命名场景'), error: e?.message ?? '计算失败' };
    }
  });
  res.json({ name, results });
});

// ============ 单计算器：放在最后（避免抢匹配 /api/calc/sensitivity/montecarlo/compare） ============
app.post('/api/calc/:name', (req, res) => {
  const { name } = req.params;
  // 保留路由名，让其他路由有机会处理
  if (['sensitivity', 'montecarlo', 'compare'].includes(name)) {
    return res.status(404).json({ error: `未知计算器: ${name}`, available: Object.keys(CALC_REGISTRY) });
  }
  const fn = CALC_REGISTRY[name];
  if (!fn) {
    return res.status(400).json({ error: `未知计算器: ${name}`, available: Object.keys(CALC_REGISTRY) });
  }
  try {
    const result = fn(req.body || {});
    if (result && typeof result === 'object' && !result.formula) result.formula = CALC_FORMULAS[name] ?? '';
    res.json({ name, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? '计算失败' });
  }
});

// ============ OGS (OpenGeoSys) 数值模拟 ============
// GET /api/ogs/status → 求解器可用性 + 场景列表
app.get('/api/ogs/status', (_req, res) => {
  const s = getOgsStatus();
  res.json({ ok: true, ...s });
});
// POST /api/ogs/run → { scenario, params } → 运行求解器返回结构化结果
app.post('/api/ogs/run', async (req, res) => {
  const { scenario, params = {} } = req.body ?? {};
  if (!scenario) {
    return res.status(400).json({ ok: false, error: '缺少 scenario', scenarios: listOgsScenarios().map((s) => s.id) });
  }
  try {
    const result = await runOgsScenario(String(scenario), params ?? {});
    if (result.ok) return res.json(result);
    return res.status(422).json(result);
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message ?? 'OGS 运行异常' });
  }
});
// GET /api/ogs/runs/:id → 某次运行的输出文件清单（供前端展示/下载）
app.get('/api/ogs/runs/:id', (req, res) => {
  const files = getOgsRunFiles(req.params.id);
  if (!files) return res.status(404).json({ ok: false, error: 'run not found' });
  res.json({ ok: true, runId: req.params.id, files });
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

// ============ KB 检索 ============
app.post('/api/kb/search', (req, res) => {
  const { q, topK = 3 } = req.body as { q: string; topK?: number };
  if (!q) return res.status(400).json({ error: '缺少 query 参数' });
  const results = lookupKB(q, topK);
  res.json({ query: q, count: results.length, results });
});

app.get('/api/kb/:key', (req, res) => {
  const entry = getKB(req.params.key);
  if (!entry) return res.status(404).json({ error: 'KB 条目不存在' });
  res.json(entry);
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
  server = app.listen(PORT, () => {
    const cfg = resolveCompat();
    const engine = process.env.CODEBUDDY_API_KEY
      ? 'CodeBuddy（主）' + (cfg ? ` + ${cfg.label}（备）` : '')
      : cfg ? `${cfg.label}（${cfg.model}）` : '未配置（请在 .env 填入 API Key）';

    console.log(`\n  LandfillMind · 填埋场智慧监测系统 v4.2 后端已启动`);
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
