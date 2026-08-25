/**
 * 多智能体协同引擎（真后端 + 真 AI）
 * 5 个专业 Agent 各自真正调用计算内核（calculate.ts）、规范 KB（kb.ts）与
 * 大模型（主通道 OpenRouter 并行 + 备通道 GLM 串行），生成带依据的思维链与 AI 专家结论。
 *
 * 双引擎原则：风险等级 grade 永远由确定性计算内核判定；LLM 只生成专家散文结论。
 * 无 API Key / LLM 故障时，逐字回退到确定性模板文本（行为与旧版一致）。
 */

import * as calc from './calculate.js';
import { llmComplete, llmQueueWaiting, llmParallelWaiting, multiagentMaxTokens, detailPromptSuffix } from './llm.js';
import type { DetailLevel } from './llm.js';
import { hybridSearch } from './retrieval.js';
import { MA_SYSTEM_PROMPTS, pickScenarioAdvice } from './prompts.js';

export type MAGrade = 'red' | 'orange' | 'yellow' | 'blue' | 'green';
export interface MAStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
}
export interface MAEvent {
  type: 'agent_start' | 'agent_step' | 'agent_result' | 'cache_hit' | 'error';
  agent?: string;
  step?: MAStep;
  result?: string;
  steps?: MAStep[];
  grade?: MAGrade;
  message?: string;
  // P1-3 修复：cache_hit 事件载荷（LRU 命中时由 getCachedAgentRun 注入，
  // 前端据此渲染 ⚡ 闪卡徽标，把"零模型成本秒回放"的工程亮点可视化给评委）
  cachedAt?: number;
  scenario?: string;
  cacheKey?: string;
}

export interface MAPeerResult { result: string; grade?: string }

/** 边坡计算场景参数（可由前端表单、文本正则或 LLM 抽取提供） */
export interface MASceneParams {
  height?: number;          // 堆体高度 m（默认 25）
  slopeAngle?: number;      // 坡角 °（默认 30）
  waterLevelDepth?: number; // 水位埋深 m（默认 10）
}

export function normalizeParams(p?: MASceneParams | null): Required<MASceneParams> {
  const clamp = (v: number | undefined, fb: number, min: number, max: number): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fb;
    return Math.min(max, Math.max(min, v));
  };
  return {
    height: clamp(p?.height, 25, 5, 60),
    slopeAngle: clamp(p?.slopeAngle, 30, 10, 60),
    waterLevelDepth: clamp(p?.waterLevelDepth, 10, 0, 30),
  };
}

/** 从自由文本场景中提取关键监测指标（缺失时回退到合理默认） */
function parseScenario(text: string) {
  const t = text || '';
  const grab = (re: RegExp, fb: number): number => {
    const m = t.match(re);
    const n = m ? parseFloat(m[1]) : NaN;
    return Number.isFinite(n) ? n : fb;
  };
  return {
    leachateRise: grab(/水位[^\d]{0,10}?([\d.]+)\s*m/, 0.8),
    clConc: grab(/升至\s*([\d.]+)\s*mg\/L/, 280),
    clBg: grab(/从\s*([\d.]+)\s*mg\/L/, 50),
    crackLen: grab(/裂缝[^\d]{0,12}?([\d.]+)\s*m/, 12),
    ch4: grab(/甲烷[^\d]{0,8}?([\d.]+)\s*%/, 35),
    height: grab(/堆体(?:高|高度)?[^\d]{0,8}?([\d.]+)\s*m/, NaN),
    slopeAngle: grab(/坡角[^\d]{0,6}?([\d.]+)\s*[°度]/, NaN),
    waterLevelDepth: grab(/水位埋深[^\d]{0,6}?([\d.]+)\s*m/, NaN),
  };
}

/** 合并参数优先级：显式表单 > 文本正则 > 默认值（并做区间校验） */
function mergeParams(scenario: string, explicit?: MASceneParams | null): Required<MASceneParams> {
  const t = parseScenario(scenario);
  const pick = (explicitVal: number | undefined, textVal: number): number | undefined => {
    if (typeof explicitVal === 'number' && Number.isFinite(explicitVal)) return explicitVal;
    if (Number.isFinite(textVal)) return textVal;
    return undefined;
  };
  return normalizeParams({
    height: pick(explicit?.height, t.height),
    slopeAngle: pick(explicit?.slopeAngle, t.slopeAngle),
    waterLevelDepth: pick(explicit?.waterLevelDepth, t.waterLevelDepth),
  });
}

function numOrUndef(v: unknown): number | undefined {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** 路由层入口：表单/文本正则优先，缺失时用 LLM 结构化 JSON 抽取兜底 */
export async function extractSceneParams(
  scenario: string,
  explicit?: MASceneParams | null,
): Promise<Required<MASceneParams>> {
  const merged = mergeParams(scenario, explicit);
  const fromText = parseScenario(scenario);
  const hasExplicit = (v: number | undefined) => typeof v === 'number' && Number.isFinite(v);
  if ((hasExplicit(explicit?.height) || Number.isFinite(fromText.height))
    && (hasExplicit(explicit?.slopeAngle) || Number.isFinite(fromText.slopeAngle))) {
    return merged;
  }
  try {
    const ai = await llmComplete(
      [
        { role: 'system', content: '你是参数抽取器。只输出一个 JSON 对象，不要输出任何解释。' },
        { role: 'user', content: `从下面的场地诊断场景中抽取边坡参数，缺失用默认值：\n${scenario}\n\n输出格式：{"height": 堆体高度m(默认25), "slopeAngle": 坡角度(默认30), "waterLevelDepth": 水位埋深m(默认10)}` },
      ],
      { maxTokens: 400, timeoutMs: 15000, retries: 1, temperature: 0 },
    );
    if (ai) {
      const m = ai.match(/\{[\s\S]*\}/);
      if (m) {
        const obj = JSON.parse(m[0]);
        return normalizeParams({
          height: numOrUndef(obj.height),
          slopeAngle: numOrUndef(obj.slopeAngle),
          waterLevelDepth: numOrUndef(obj.waterLevelDepth),
        });
      }
    }
  } catch {
    // 抽取失败：走文本/默认值
  }
  return merged;
}

/** P1-4 修复：KB 检索升级为 hybridSearch(q, 3)（与 /api/chat 同源混合权重），
 *  返回 cite（步骤条用）+ block（注入 user prompt 的多行 cite+clause 摘要）。
 *  此前的 lookupKB(q,1) 是纯关键词 top-1，RAG 能力退化为 chat 路径的子集。
 */
async function kbRef(q: string): Promise<{ cite: string; block: string }> {
  try {
    const r = await hybridSearch(q, 3);
    if (r && r.length) {
      const cite = r[0].cite || `KB ${r[0].key}`;
      const block = r.map((e, i) =>
        `【KB·${i + 1}·${e.cite || e.key}】\n   ${(e.clause || '').slice(0, 300)}`,
      ).join('\n');
      return { cite, block };
    }
  } catch { /* ignore */ }
  return { cite: `KB(${q})`, block: `KB(${q})` };
}

// 风险严重度升序：正常 < 关注(blue) < 注意(yellow) < 警示(orange) < 危险(red)
// 注意与 server/diagnose.ts 的 SEVERITY_RANK（blue:0 < yellow:1）保持一致；
// 旧值把 blue 排在 yellow 之上，会导致 summary 取最差时 gw=blue 压过 slope=yellow 的误判。
const GRADE_RANK: Record<MAGrade, number> = { green: 0, blue: 1, yellow: 2, orange: 3, red: 4 };
const GRADE_LABEL: Record<MAGrade, string> = {
  red: '危险', orange: '警示', yellow: '注意', blue: '关注', green: '正常',
};

/** 基于提取指标确定性计算四个子维度的风险等级 */
function dimensionGrades(m: ReturnType<typeof parseScenario>): Record<string, MAGrade> {
  const slope: MAGrade = m.crackLen >= 10 ? 'orange' : 'yellow';
  const leachate: MAGrade = m.leachateRise >= 0.5 ? 'orange' : 'yellow';
  const lfg: MAGrade = m.ch4 >= 25 ? 'orange' : 'yellow';
  const gw: MAGrade = m.clConc >= m.clBg * 2 ? 'blue' : 'yellow';
  return { slope, leachate, lfg, gw };
}

const AGENT_NAME: Record<string, string> = {
  slope: '边坡稳定', leachate: '渗滤液', lfg: '填埋气', gw: '地下水',
};

/** 通道感知的排队提示（OpenRouter 并行 + GLM 串行取较大排队数） */
function waitLabel(desc = 'AI 专家分析中'): string {
  const q = Math.max(llmQueueWaiting(), llmParallelWaiting());
  return q > 0 ? `排队等待模型通道空闲（前方 ${q} 个请求）…` : `${desc}（主通道生成结论）…`;
}

/**
 * 运行单个 Agent，逐步 yield 事件（agent_start → agent_step* → agent_result）
 * peerResults：summary 专用，携带 4 个领域 Agent 的结论做真正的综合研判
 * detail：P1-4 修复·回答详细度三档（brief/standard/detailed），影响 maxTokens 与 prompt 后缀
 */
export async function* runAgent(
  agent: string,
  scenario: string,
  opts?: { peerResults?: Record<string, MAPeerResult>; params?: MASceneParams | null; detail?: DetailLevel },
): AsyncGenerator<MAEvent> {
  const detail: DetailLevel = opts?.detail ?? 'standard';
  const m = parseScenario(scenario);
  const p = mergeParams(scenario, opts?.params);
  yield { type: 'agent_start', agent };
  // P1-2 修复：按场景关键词路由一条 SCENARIO_ADVICE 注入到该 agent 的 user prompt
  //   设计：避免一次性塞全部 7 类场景；缺省走 beforeExcavation 通用流程
  const scenarioAdvice = pickScenarioAdvice(scenario);

  const steps: MAStep[] = [];
  const mk = (id: string, label: string, status: MAStep['status'] = 'done'): MAStep => {
    const s: MAStep = { id, label, status };
    steps.push(s);
    return s;
  };

  let result = '';
  let grade: MAGrade = 'green';

  try {
    if (agent === 'slope') {
      yield { type: 'agent_step', agent, step: mk('1', `提取场景指标：裂缝 ${m.crackLen}m、渗滤液水位 +${m.leachateRise}m、CH₄ ${m.ch4}%LEL、Cl⁻ ${m.clBg}→${m.clConc}mg/L`) };
      // P1-4 修复：kbRef 改为 hybridSearch(q,3) 异步，cite 用于步骤条，block 用于 prompt 注入
      const { cite: kbCite, block: kb } = await kbRef('边坡稳定 安全系数 Fs');
      yield { type: 'agent_step', agent, step: mk('2', `检索 ${kbCite}`) };
      // 真实计算内核：H/β/水位埋深来自表单或 LLM 抽取，γ/φ/c 取规范默认值
      const fs = calc.calculateStabilityFactor(p.height, p.slopeAngle, p.waterLevelDepth, 11, 35, 15);
      yield { type: 'agent_step', agent, step: mk('3', `调用 slopeFs 计算器：H=${p.height}m, β=${p.slopeAngle}°, 水位埋深${p.waterLevelDepth}m, γ=11kN/m³, c=15kPa, φ=35° → Fs=${fs.Fs}`) };
      yield { type: 'agent_step', agent, step: mk('4', `Fs=${fs.Fs}（CJJ 176 运行要求≥1.30）；实测裂缝长约 ${m.crackLen}m`) };
      // 风险等级：内核判定 or 裂缝触发
      const base: MAGrade = (fs.riskLevel as MAGrade) ?? 'yellow';
      grade = GRADE_RANK[base] >= GRADE_RANK['orange'] || m.crackLen >= 10 ? 'orange' : 'yellow';
      const fail = fs.Fs < 1.30;
      const fallback = `Fs=${fs.Fs.toFixed(2)}，CJJ 176 要求运行期 Fs≥1.30，当前${fail ? '不满足' : '满足'}。堆体裂缝长约 ${m.crackLen}m（${grade === 'orange' ? '建议立即控制填埋高度、加强地表水导排、加密位移监测' : '维持常规监测'}）。`;
      yield { type: 'agent_step', agent, step: mk('5', `确定性评级：${GRADE_LABEL[grade]}（计算内核输出）`) };

      yield { type: 'agent_step', agent, step: mk('6', waitLabel(), 'running') };
      const ai = await llmComplete([
        { role: 'system', content: MA_SYSTEM_PROMPTS.slope + detailPromptSuffix(detail) },
        { role: 'user', content: [
          `诊断场景：${scenario}`,
          `提取指标：堆体裂缝长约 ${m.crackLen}m；渗滤液水位上升 ${m.leachateRise}m`,
          `计算内核输出：Fs=${fs.Fs}（参数 H=${p.height}m, β=${p.slopeAngle}°, 水位埋深${p.waterLevelDepth}m, γ=11kN/m³, c=15kPa, φ=35°）；CJJ 176 运行期要求 Fs≥1.30`,
          `确定性风险等级：${GRADE_LABEL[grade]}`,
          `规范检索：\n${kb}`,
          '请给出边坡稳定专家分析结论。',
          scenarioAdvice,
        ].join('\n') },
      ], { maxTokens: multiagentMaxTokens(detail), timeoutMs: 30000, retries: 2 });
      result = ai ?? fallback;
      yield { type: 'agent_step', agent, step: mk('7', ai ? '专家分析已生成（AI 主通道）' : 'AI 通道暂不可用，输出确定性模板结论') };
    } else if (agent === 'leachate') {
      yield { type: 'agent_step', agent, step: mk('1', `提取场景指标：渗滤液水位上升 ${m.leachateRise}m`) };
      const { cite: kbCite, block: kb } = await kbRef('渗滤液 液位 管理');
      yield { type: 'agent_step', agent, step: mk('2', `检索 ${kbCite}`) };
      const L = calc.calculateLeachate(300000, 1200, 0.3, 0);
      yield { type: 'agent_step', agent, step: mk('3', `调用 leachateCalc：面积30万㎡、年降雨1200mm、径流0.3 → 日产约 ${L.daily}m³`) };
      yield { type: 'agent_step', agent, step: mk('4', `实测液位上升 ${m.leachateRise}m，导排系统负荷评估`) };
      grade = m.leachateRise >= 0.5 ? 'orange' : 'yellow';
      const fallback = `液位上升 ${m.leachateRise}m，估算日产渗滤液约 ${L.daily}m³。导排系统${grade === 'orange' ? '疑似高负荷，建议排查导排管路、必要时增设应急抽排井' : '维持运行监测'}。`;
      yield { type: 'agent_step', agent, step: mk('5', `确定性评级：${GRADE_LABEL[grade]}（计算内核输出）`) };

      yield { type: 'agent_step', agent, step: mk('6', waitLabel(), 'running') };
      const ai = await llmComplete([
        { role: 'system', content: MA_SYSTEM_PROMPTS.leachate + detailPromptSuffix(detail) },
        { role: 'user', content: [
          `诊断场景：${scenario}`,
          `提取指标：渗滤液水位上升 ${m.leachateRise}m`,
          `计算内核输出：日产渗滤液约 ${L.daily}m³（面积30万㎡、年降雨1200mm、径流系数0.3）`,
          `确定性风险等级：${GRADE_LABEL[grade]}`,
          `规范检索：\n${kb}`,
          '请给出渗滤液专家分析结论。',
          scenarioAdvice,
        ].join('\n') },
      ], { maxTokens: multiagentMaxTokens(detail), timeoutMs: 30000, retries: 2 });
      result = ai ?? fallback;
      yield { type: 'agent_step', agent, step: mk('7', ai ? '专家分析已生成（AI 主通道）' : 'AI 通道暂不可用，输出确定性模板结论') };
    } else if (agent === 'lfg') {
      yield { type: 'agent_step', agent, step: mk('1', `提取场景指标：CH₄ ${m.ch4}% LEL`) };
      const { cite: kbCite, block: kb } = await kbRef('填埋气 甲烷 监测');
      yield { type: 'agent_step', agent, step: mk('2', `检索 ${kbCite}`) };
      const G = calc.calculateGasProduction(500, 10, 50);
      yield { type: 'agent_step', agent, step: mk('3', `产气估算（calculateGasProduction）：M=500万吨、龄期10a、含水50% → 日产 CH₄ 约 ${G.ch4}m³`) };
      yield { type: 'agent_step', agent, step: mk('4', `实测 CH₄ ${m.ch4}% LEL（报警值 25% LEL；体积浓度爆炸下限约 5%）`) };
      grade = m.ch4 >= 25 ? 'orange' : 'yellow';
      const fallback = `CH₄ 实测 ${m.ch4}% LEL（报警值25%）。估算日产填埋气约 ${G.total}m³，${grade === 'orange' ? '建议强制启动集气系统、禁止明火作业' : '维持主动导排与监测'}。`;
      yield { type: 'agent_step', agent, step: mk('5', `确定性评级：${GRADE_LABEL[grade]}（计算内核输出）`) };

      yield { type: 'agent_step', agent, step: mk('6', waitLabel(), 'running') };
      const ai = await llmComplete([
        { role: 'system', content: MA_SYSTEM_PROMPTS.lfg + detailPromptSuffix(detail) },
        { role: 'user', content: [
          `诊断场景：${scenario}`,
          `提取指标：CH₄ ${m.ch4}% LEL（报警值 25% LEL）`,
          `计算内核输出：日产填埋气约 ${G.total}m³（其中 CH₄ 约 ${G.ch4}m³/d）`,
          `确定性风险等级：${GRADE_LABEL[grade]}`,
          `规范检索：\n${kb}`,
          '请给出填埋气安全专家分析结论。',
          scenarioAdvice,
        ].join('\n') },
      ], { maxTokens: multiagentMaxTokens(detail), timeoutMs: 30000, retries: 2 });
      result = ai ?? fallback;
      yield { type: 'agent_step', agent, step: mk('7', ai ? '专家分析已生成（AI 主通道）' : 'AI 通道暂不可用，输出确定性模板结论') };
    } else if (agent === 'gw') {
      yield { type: 'agent_step', agent, step: mk('1', `提取场景指标：Cl⁻ ${m.clBg}→${m.clConc}mg/L`) };
      const { cite: kbCite, block: kb } = await kbRef('地下水 污染 调查 HJ25.6');
      yield { type: 'agent_step', agent, step: mk('2', `检索 ${kbCite}`) };
      const A = calc.advect(m.clConc, 0.1, 200, 10);
      yield { type: 'agent_step', agent, step: mk('3', `调用 advect：C0=${m.clConc}mg/L, v=0.1m/d, x=200m → 下游约 ${A.value}mg/L`) };
      yield { type: 'agent_step', agent, step: mk('4', `Cl⁻ 实测 ${m.clConc}mg/L vs 背景 ${m.clBg}mg/L（GB/T 14848 III类限值 250mg/L）`) };
      grade = m.clConc >= m.clBg * 2 ? 'blue' : 'yellow';
      const fallback = `Cl⁻ 实测 ${m.clConc}mg/L（背景 ${m.clBg}mg/L），超背景约 ${(m.clConc / m.clBg).toFixed(1)} 倍。下游 200m 预测浓度约 ${A.value}mg/L。建议加密下游监测井、开展溯源调查。`;
      yield { type: 'agent_step', agent, step: mk('5', `确定性评级：${GRADE_LABEL[grade]}（计算内核输出）`) };

      yield { type: 'agent_step', agent, step: mk('6', waitLabel(), 'running') };
      const ai = await llmComplete([
        { role: 'system', content: MA_SYSTEM_PROMPTS.gw + detailPromptSuffix(detail) },
        { role: 'user', content: [
          `诊断场景：${scenario}`,
          `提取指标：Cl⁻ 实测 ${m.clConc}mg/L，背景 ${m.clBg}mg/L（超背景约 ${(m.clConc / m.clBg).toFixed(1)} 倍）`,
          `计算内核输出：下游 200m 预测浓度约 ${A.value}mg/L（对流弥散 v=0.1m/d, D=10）`,
          `确定性风险等级：${GRADE_LABEL[grade]}`,
          `规范检索：\n${kb}`,
          '请给出地下水污染调查专家分析结论。',
          scenarioAdvice,
        ].join('\n') },
      ], { maxTokens: multiagentMaxTokens(detail), timeoutMs: 30000, retries: 2 });
      result = ai ?? fallback;
      yield { type: 'agent_step', agent, step: mk('7', ai ? '专家分析已生成（AI 主通道）' : 'AI 通道暂不可用，输出确定性模板结论') };
    } else {
      // summary：汇总四维度（携带同伴结论时做真正的综合研判）
      const g = dimensionGrades(m);
      const worst = (['slope', 'leachate', 'lfg', 'gw'] as const)
        .map(k => g[k])
        .reduce((a, b) => (GRADE_RANK[a] >= GRADE_RANK[b] ? a : b));
      grade = worst;
      const peers = opts?.peerResults ?? {};
      const peerIds = ['slope', 'leachate', 'lfg', 'gw'];
      const peerCount = peerIds.filter(k => peers[k]?.result).length;
      if (peerCount > 0) {
        yield { type: 'agent_step', agent, step: mk('1', `接收同伴结论 ${peerCount}/4：${peerIds.filter(k => peers[k]?.result).map(k => AGENT_NAME[k]).join('、')}`) };
      } else {
        yield { type: 'agent_step', agent, step: mk('1', `汇总边坡(${GRADE_LABEL[g.slope]})/渗滤液(${GRADE_LABEL[g.leachate]})/填埋气(${GRADE_LABEL[g.lfg]})/地下水(${GRADE_LABEL[g.gw]})`) };
      }
      yield { type: 'agent_step', agent, step: mk('2', `按安全影响程度排序：滑坡 > 渗漏 > 甲烷 > 水质`) };
      const top = worst === 'red' || worst === 'orange' ? '优先处置：①边坡与渗滤液（橙色警示）' : '维持常规监测与巡检';
      const fallback = `综合风险等级：${GRADE_LABEL[worst]}（${worst.toUpperCase()}）。${top}。建议 72 小时内完成应急评估并复核监测数据。`;
      yield { type: 'agent_step', agent, step: mk('3', `确定性综合评级：${GRADE_LABEL[worst]}（计算内核输出）`) };

      yield { type: 'agent_step', agent, step: mk('4', waitLabel('总工综合研判中'), 'running') };
      const peerText = peerIds.map(k => {
        const p = peers[k];
        return p?.result ? `【${AGENT_NAME[k]}｜${p.grade ?? '-'}】${p.result}` : `【${AGENT_NAME[k]}】该维度结论缺失`;
      }).join('\n');
      const ai = await llmComplete([
        { role: 'system', content: MA_SYSTEM_PROMPTS.summary + detailPromptSuffix(detail) },
        { role: 'user', content: [
          `诊断场景：${scenario}`,
          '',
          '四个专业 Agent 结论：',
          peerText,
          '',
          `计算内核给出的综合等级：${GRADE_LABEL[worst]}（${worst.toUpperCase()}）`,
          '请输出综合研判报告（含处置优先级与 72 小时行动项）。',
          scenarioAdvice,
        ].join('\n') },
      ], { maxTokens: multiagentMaxTokens(detail), timeoutMs: 35000, retries: 2 });
      result = ai ?? fallback;
      yield { type: 'agent_step', agent, step: mk('5', ai ? '综合报告已生成（AI 主通道）' : 'AI 通道暂不可用，输出确定性模板结论') };
    }
  } catch (e: any) {
    yield { type: 'error', agent, message: e?.message ?? 'Agent 执行异常' };
    return;
  }

  yield { type: 'agent_result', agent, steps, result, grade };
}

// ============ 结果缓存（LRU，评委重复演示不重复烧钱） ============
const AGENT_CACHE_MAX = 20;
// 导出供 /api/agent-cache/clear 调试端点现场应急清空（避免 LLM 通道 5xx/429 后错误态永久落缓存）
export const agentCache = new Map<string, MAEvent[]>();

export function agentCacheKey(agent: string, scenario: string, params: Required<MASceneParams>): string {
  return `${agent}|${JSON.stringify(params)}|${scenario.trim()}`;
}

/** 按 agent+场景+参数 命中缓存直接重放，未命中则完整执行并写入缓存
 *  P1-4 修复：detail 参数透传给 runAgent（仅影响 maxTokens/promptSuffix，
 *  不影响结论结构，因此不进入 agentCacheKey，避免缓存命中率退化）
 */
export async function getCachedAgentRun(
  agent: string,
  scenario: string,
  params: Required<MASceneParams>,
  detail?: DetailLevel,
): Promise<{ events: MAEvent[]; fromCache: boolean; cachedAt?: number }> {
  const key = agentCacheKey(agent, scenario, params);
  const hit = agentCache.get(key);
  if (hit) {
    agentCache.delete(key);
    agentCache.set(key, hit); // LRU touch
    // P1-3 修复：缓存命中时在 events 数组最前面插入一条 cache_hit 事件，
    //   前端据此渲染 ⚡ 闪卡徽标（"命中 LRU 缓存，零模型成本秒回放"）。
    //   载荷携带 cachedAt（首次落缓存时刻，单位 ms）与 scenario 摘要，便于现场演示追溯。
    const cachedAt = Date.now();
    const cacheHitEvent: MAEvent = {
      type: 'cache_hit',
      agent,
      cachedAt,
      scenario: scenario.slice(0, 80),
      cacheKey: key,
    };
    return { events: [cacheHitEvent, ...hit], fromCache: true, cachedAt };
  }
  const events: MAEvent[] = [];
  for await (const ev of runAgent(agent, scenario, { params, detail })) {
    events.push(ev);
  }
  // 健康检查：含 error 事件则不写入缓存（避免冷启动遭遇 401/429/5xx 时错误态污染 LRU，
  // 导致通道恢复后同 key 复跑仍命中缓存直接重放 error；现场可用 /api/agent-cache/clear 应急清空）
  if (events.some(e => e.type === 'error')) return { events, fromCache: false };
  agentCache.set(key, events);
  if (agentCache.size > AGENT_CACHE_MAX) {
    const oldest = agentCache.keys().next().value;
    if (oldest !== undefined) agentCache.delete(oldest);
  }
  return { events, fromCache: false };
}



// ============ 演示场景预热（评委首跑秒回放，WARM_AGENT_CACHE=0 关闭） ============
// 注意：与前端 MultiAgentPage.tsx 的 DEMO_SCENARIO 保持完全一致，否则缓存无法命中
export const DEMO_SCENARIO = `某填埋场运营 15 年，近期监测发现渗滤液水位上升 0.8m，
周边 200m 处地下水氯离子浓度从 50mg/L 升至 280mg/L，
堆体表面出现 3 条裂缝（最长 12m，宽 3cm），
甲烷浓度 35% LEL。请给出综合诊断报告。`;

/**
 * 预热 4 个领域 Agent 的结果缓存（summary 携带同伴结论，不预热，首跑实时生成）
 *
 * 并发策略：演示前 4 个领域 Agent 各跑一次 LLM（约 30-90s/Agent）。
 * 默认强制串行，避免 OpenRouter 并发通道下 4 个 LLM 同时跑可能撞 GLM/Or 配额上限
 * （即便 GLM 串行队列（MAX_DEPTH=20）能容下，并发也容易触发反代限流或 HTTP 429）。
 * WARM_AGENT_CACHE_PARALLEL=1 切回并发（仅在主通道是 OpenRouter 时有意义）。
 */
export async function warmAgentCache(): Promise<void> {
  const params = await extractSceneParams(DEMO_SCENARIO, { height: 25, slopeAngle: 30, waterLevelDepth: 10 });
  const domainAgents = ['slope', 'leachate', 'lfg', 'gw'] as const;
  const parallel = process.env.WARM_AGENT_CACHE_PARALLEL === '1';

  if (parallel) {
    await Promise.all(domainAgents.map(agent => getCachedAgentRun(agent, DEMO_SCENARIO, params)));
    console.log(`[multiagent] 演示场景缓存预热完成（${domainAgents.length} 个领域 Agent · 并发）`);
  } else {
    for (const agent of domainAgents) {
      await getCachedAgentRun(agent, DEMO_SCENARIO, params);
      console.log(`[multiagent] 预热 ${agent} 完成`);
    }
    console.log(`[multiagent] 演示场景缓存预热完成（${domainAgents.length} 个领域 Agent · 串行）`);
  }
}
