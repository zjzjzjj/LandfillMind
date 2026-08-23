// ========================
// 会话 & 消息
// ========================

export interface MessageSources {
  kb?: { title: string; ref: string; clause?: string }[];
  calcs?: { name: string; formula?: string; ref?: string }[];
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  sources?: MessageSources | null;
  error?: string;
  /** P0-8 修复：追问引导卡片（server/followUp.ts 命中关键词后由后端 SSE 下发） */
  followUps?: FollowUpItem[];
}

/** 追问引导项：来自 server/followUp.ts FOLLOW_UP_GUIDES 的命中 */
export interface FollowUpItem {
  /** 命中类别：slope / leachate / settlement / methane */
  kind: string;
  /** 给用户的引导问句（提示需要补全哪些参数） */
  prompt: string;
  /** 下一步动作提示（如"收到参数后用简化 Bishop 法计算 Fs"） */
  hint: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** 归类：'kb' = 知识库检索增强，'calc' = 工程计算（确定性内核），undefined = 兼容旧数据 */
  type?: 'kb' | 'calc';
  input: Record<string, unknown>;
  output?: unknown;
  status: 'running' | 'success' | 'error';
  duration?: number;
}

export interface Session {
  id: string;
  title: string;
  agentId: string;
  model: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

// ========================
// Agent
// ========================

export type AgentIcon = string; // emoji 或图标组件名

export interface Agent {
  id: string;
  name: string;
  icon: AgentIcon;
  description: string;
  systemPrompt: string;
  model: string;
  color: string; // CSS 色值
  isBuiltIn: boolean;
}

// ========================
// 计算器
// ========================

export interface CalcResult {
  ok: boolean;
  value?: number;
  unit?: string;
  grade: 'red' | 'orange' | 'yellow' | 'blue' | 'green';
  analysis: string;
  ref?: string;
  formula?: string;
  [key: string]: unknown;
}

export interface CalcRegistry {
  [name: string]: {
    name: string;
    description: string;
    params: CalcParam[];
    ref: string;
  };
}

export interface CalcParam {
  name: string;
  label: string;
  unit?: string;
  default?: number;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
}

// ========================
// 诊断
// ========================

export type RiskLevel = 'red' | 'orange' | 'yellow' | 'blue' | 'green';

export interface CalcStep {
  label: string;
  formula: string;
  detail: string;
}

export interface ReportSection {
  title: string;
  content: string;
}

export interface DetailedReport {
  overview: string;
  sections: ReportSection[];
  regulations: string[];
  actions: { immediate: string[]; shortTerm: string[]; longTerm: string[] };
  monitoring: string[];
  conclusion: string;
}

export interface DiagnosisResult {
  risks: RiskItem[];
  overallRisk?: RiskLevel;
  report: DetailedReport;
  site?: Record<string, unknown>;
  dataCompleteness?: number;
  warnings?: string[];
  /**
   * AI 纠偏：计算内核交叉复核结果（服务端 diagnose.ts verifyReportAgainstKernel 生成）
   * - mismatches 默认按字符串存储（兼容服务端历史实现：单条自然语言描述）
   * - 演示用纠偏样例可使用结构化对象（hazard/field/expected/reported/action）以呈现完整字段
   */
  verification?: VerificationResult;
}

/**
 * AI 纠偏：单条不一致项的结构化描述
 *  - 服务端默认返回 string[]（自然语言描述，参见 server/diagnose.ts verifyReportAgainstKernel）
 *  - 演示样例可使用对象形式以暴露 hazard / field / expected / reported / action 完整字段
 */
export interface VerificationMismatch {
  hazard: string;   // 隐患类别：slope | leachate | lfg | gw | summary
  field: string;    // 出错字段 / 关键数值项
  expected: string; // 内核计算结论
  reported: string; // AI 报告原文（含漏报/编造说明）
  action: string;   // 系统级纠偏处置
}

export interface VerificationResult {
  consistent: boolean;
  checked: number;
  total: number;
  mismatches: Array<string | VerificationMismatch>;
  /** 纠偏来源说明（演示样例可标注"系统级内核交叉复核"等） */
  correctedAt?: string;
}

export interface RiskItem {
  id: string;
  category: string;         // 边坡/渗滤液/填埋气/地下水/综合
  title: string;
  description: string;
  level: RiskLevel;
  value?: number | string;
  unit?: string;
  threshold?: string;
  suggestion: string;
  calc?: CalcStep[];        // 计算书（逐项详实）
}

// ========================
// 知识库检索增强 + 工程计算内核
//   注：兼容路径（GLM/兼容通道）下，ToolCall 仅是后端 RAG / 计算结果回放，
//   不走 OpenAI / Anthropic 真 function calling schema；仅在 CODEBUDDY_API_KEY 设置时
//   才是 SDK 真实产出的工具调用循环（见 server/index.ts handleCodeBuddyChat）
// ========================

export type PermissionMode = 'default' | 'acceptAll' | 'rejectAll';

/** 回答详细度三档：摘要 / 标准 / 详细 */
export type DetailLevel = 'brief' | 'standard' | 'detailed';

// ========================
// 模型选项（/api/models 返回）
// ========================

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

// ========================
// KB
// ========================

export interface KBEntry {
  key: string;
  module: 'm6' | 'm62';
  kw: string[];
  q: string;
  pro: string;
  easy: string;
  cite: string;
  clause: string;
  related: string[];
  calc?: string;
}

// ========================
// 多智能体
// ========================

export type AgentStatus = 'idle' | 'waiting' | 'running' | 'success' | 'error';

export interface MultiAgentState {
  agentId: string;
  agentName: string;
  status: AgentStatus;
  result?: string;
  thinkingSteps: ThinkingStep[];
}

export interface ThinkingStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  content?: string;
}
