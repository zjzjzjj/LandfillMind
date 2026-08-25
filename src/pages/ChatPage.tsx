import { useRef, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Square, ChevronDown, ChevronUp, Bot, User, AlertCircle, Loader2, FileDown, X, Lightbulb } from 'lucide-react';
import type { Message, ToolCall, Agent, ModelOption, PermissionMode, FollowUpItem } from '../types';
import { useDetailPref } from '../utils/detailPref';
import { buildChatMarkdown, downloadJSON, downloadText, timestampName } from '../utils/exporter';
import { EXPERT_LABELS } from '../utils/expertPrompts';
import { FeedbackWidget } from '../components/FeedbackWidget';

// ========================
// 知识库检索增强 / 工程计算内核 卡片
//   注：兼容路径（GLM/兼容通道）下这是后端 RAG / 计算结果回放的 UI 展示；
//   仅在 CODEBUDDY_API_KEY 设置时才是 SDK 真实产出的工具调用循环。
//   type 字段（'kb' / 'calc'）由后端显式回传（kind）——UI 据此分类渲染。
// ========================
function ToolCallCard({ tc }: { tc: ToolCall }) {
  const [open, setOpen] = useState(false);
  const statusColor = tc.status === 'success' ? '#10b981' : tc.status === 'error' ? '#ef4444' : '#06b6d4';

  // 类型归类：type 优先（后端显式标注），否则按 name 推断兼容旧数据
  const kind: 'kb' | 'calc' | 'ogs' = tc.type
    ?? (tc.name === 'kb_lookup' ? 'kb'
      : tc.name === 'ogs_sim' ? 'ogs'
      : tc.name === 'calculate' || tc.name === 'run_diagnosis' ? 'calc'
      : 'kb');

  // 标题与图标按类型分类
  const headerLabel = kind === 'kb' ? '🔍 知识库检索增强'
    : kind === 'ogs' ? '🌐 稳定化计算（OpenGeoSys 有限元求解）'
    : '⚙ 工程计算（确定性内核）';

  // KB 输出：把 entries 的 ref / clause 单独渲染为可点击引用徽章
  let kbEntries: Array<{ title?: string; ref?: string; clause?: string }> | null = null;
  if (kind === 'kb' && tc.output !== undefined) {
    try {
      const parsed = typeof tc.output === 'string' ? JSON.parse(tc.output) : tc.output;
      if (Array.isArray(parsed)) kbEntries = parsed as any;
    } catch { /* 非 JSON 时退回到通用结果区 */ }
  }

  // 计算输出：取首条摘要 + ref 规范引用
  let calcSummary: { name?: string; analysis?: string; ref?: string } | null = null;
  if (kind === 'calc' && tc.output !== undefined) {
    try {
      const parsed = typeof tc.output === 'string' ? JSON.parse(tc.output) : tc.output;
      if (Array.isArray(parsed) && parsed[0]) calcSummary = parsed[0] as any;
    } catch { /* 非 JSON 时退回到通用结果区 */ }
  }

  // 稳定化计算输出：结构化运行结果
  let ogsResult: any = null;
  if (kind === 'ogs' && tc.output !== undefined) {
    try {
      ogsResult = typeof tc.output === 'string' ? JSON.parse(tc.output) : tc.output;
    } catch { /* 非 JSON 时退回到通用结果区 */ }
  }

  return (
    <div
      className="rounded-xl border overflow-hidden my-2"
      style={{ borderColor: 'var(--border)' }}
    >
      {/* 头部 */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
        style={{ backgroundColor: 'var(--bg-elevated)' }}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: statusColor }} />
        <span className="text-[11px] font-mono font-medium" style={{ color: 'var(--text-secondary)' }}>
          {headerLabel}
        </span>
        {tc.status === 'running' && <Loader2 size={11} className="animate-spin" style={{ color: statusColor }} />}
        {open ? <ChevronUp size={12} className="ml-auto" style={{ color: 'var(--text-muted)' }} />
               : <ChevronDown size={12} className="ml-auto" style={{ color: 'var(--text-muted)' }} />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            <div className="p-3 space-y-2">
              {/* KB 类型：引用徽章 + 标题列表 */}
              {kind === 'kb' && kbEntries && kbEntries.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>引用规范</p>
                  <div className="flex flex-wrap gap-1.5">
                    {kbEntries.map((e, i) => (
                      <span key={'cite-' + i} className="chip" title={e.clause ?? ''}>
                        📖 {e.ref ?? '规范条目'}
                        {e.clause ? <span style={{ opacity: 0.7 }}> · {e.clause}</span> : null}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 space-y-1">
                    {kbEntries.map((e, i) => (
                      e.title ? (
                        <div key={'t-' + i} className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                          · {e.title}
                        </div>
                      ) : null
                    ))}
                  </div>
                </div>
              )}

              {/* 计算类型：公式 + 规范引用 */}
              {kind === 'calc' && calcSummary && (
                <div>
                  {calcSummary.name && (
                    <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>
                      计算器：<span className="font-mono">{calcSummary.name}</span>
                    </p>
                  )}
                  {calcSummary.analysis && (
                    <pre className="text-[11px] font-mono whitespace-pre-wrap rounded-lg p-2"
                         style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-secondary)' }}>
                      {calcSummary.analysis}
                    </pre>
                  )}
                  {calcSummary.ref && (
                    <span className="chip mt-1 inline-block" title={calcSummary.ref}>
                      📖 {calcSummary.ref}
                    </span>
                  )}
                </div>
              )}

              {/* 稳定化计算结果 */}
              {kind === 'ogs' && ogsResult && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                    场景：<span className="font-mono">{ogsResult.scenarioName ?? ogsResult.scenario}</span>
                    {ogsResult.ok ? <span className="ml-1.5 text-emerald-500">✓ 求解正常</span>
                                  : <span className="ml-1.5 text-rose-500">⚠ 未正常收敛</span>}
                  </p>
                  {ogsResult.summary && (
                    <pre className="text-[11px] font-mono whitespace-pre-wrap rounded-lg p-2"
                         style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-secondary)' }}>
                      {ogsResult.summary}
                    </pre>
                  )}
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    求解耗时 {ogsResult.elapsedMs}ms · 模拟 {ogsResult.simulationTime ?? '-'}
                    {Array.isArray(ogsResult.timeSeries) && ogsResult.timeSeries.length > 0
                      ? ` · 时程输出 ${ogsResult.timeSeries.length} 组` : ''}
                  </p>
                </div>
              )}

              {/* 检索关键词（KB） / 计算入参（计算） / 模拟参数（OGS） */}
              {tc.input && Object.keys(tc.input).length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>
                    {kind === 'kb' ? '检索关键词' : kind === 'ogs' ? '模拟参数' : '计算入参'}
                  </p>
                  <pre className="text-[11px] font-mono whitespace-pre-wrap rounded-lg p-2"
                       style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-secondary)' }}>
                    {JSON.stringify(tc.input, null, 2)}
                  </pre>
                </div>
              )}

              {/* 兜底：无法解析时仍显示原始 output */}
              {((kind === 'kb' && !kbEntries) || (kind === 'calc' && !calcSummary) || (kind === 'ogs' && !ogsResult)) && tc.output !== undefined && (
                <div>
                  <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>结果</p>
                  <pre className="text-[11px] font-mono whitespace-pre-wrap rounded-lg p-2"
                       style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-secondary)' }}>
                    {typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ========================
// 追问引导卡片（P0-8 修复：来自 server/followUp.ts 的 follow_up SSE 事件）
//   折叠展开，显示建议补全的参数，点击"采纳建议"把问句回填到输入框
// ========================
function FollowUpCard({ items, onApply }: { items: FollowUpItem[]; onApply: (prompt: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!items || items.length === 0) return null;

  // 类别 → 中文标签 + 配色（与 FOLLOW_UP_GUIDES 4 类语义对齐，不扩到 7 类）
  const kindMeta: Record<string, { label: string; color: string; icon: string }> = {
    slope: { label: '边坡稳定', color: '#10b981', icon: '⛰️' },
    leachate: { label: '渗滤液', color: '#3b82f6', icon: '💧' },
    settlement: { label: '沉降', color: '#8b5cf6', icon: '📉' },
    methane: { label: '填埋气/甲烷', color: '#f59e0b', icon: '🔥' },
    general: { label: '追问', color: '#06b6d4', icon: '🧠' },
  };

  return (
    <div
      className="rounded-xl border overflow-hidden my-2"
      style={{
        borderColor: 'rgba(245,158,11,0.5)',
        backgroundColor: 'rgba(245,158,11,0.06)',
        boxShadow: '0 0 12px rgba(245,158,11,0.15)',
      }}
    >
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
        style={{ backgroundColor: 'rgba(245,158,11,0.08)' }}
      >
        <Lightbulb size={13} style={{ color: '#f59e0b' }} />
        <span className="text-[11px] font-semibold" style={{ color: '#f59e0b' }}>
          ⚠ 智能追问 · 检测到可补充 {items.length} 项参数
        </span>
        {open ? <ChevronUp size={12} className="ml-auto" style={{ color: '#f59e0b' }} />
              : <ChevronDown size={12} className="ml-auto" style={{ color: '#f59e0b' }} />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            <div className="p-3 space-y-2">
              {items.map((it, i) => {
                const meta = kindMeta[it.kind] ?? kindMeta.general;
                return (
                  <div
                    key={i}
                    className="rounded-lg p-2.5"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      borderLeft: `3px solid ${meta.color}`,
                    }}
                  >
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <span className="text-sm">{meta.icon}</span>
                      <span className="text-[10px] font-semibold" style={{ color: meta.color }}>
                        {meta.label}
                      </span>
                    </div>
                    <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                      {it.prompt}
                    </p>
                    {it.hint && (
                      <p className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        💡 {it.hint}
                      </p>
                    )}
                    <button
                      onClick={() => onApply(it.prompt)}
                      className="mt-1.5 text-[10px] px-2 py-1 rounded-md border transition-colors"
                      style={{ borderColor: meta.color, color: meta.color, backgroundColor: 'transparent' }}
                      onMouseEnter={e => { e.currentTarget.style.backgroundColor = meta.color; e.currentTarget.style.color = '#fff'; }}
                      onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = meta.color; }}
                    >
                      采纳建议 · 把问句回填到输入框
                    </button>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ========================
// 消息气泡
// ========================
function MessageBubble({ msg, onApplyFollowUp, currentSessionId, currentAgentKey, selectedModel }: { msg: Message; onApplyFollowUp: (prompt: string) => void; currentSessionId: string; currentAgentKey: string; selectedModel: string }) {
  const isUser = msg.role === 'user';
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}
    >
      {/* 头像 */}
      <div
        className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
        style={{ backgroundColor: isUser ? 'var(--primary-glow)' : 'var(--bg-elevated)' }}
      >
        {isUser ? <User size={14} style={{ color: 'var(--primary)' }} />
                : <Bot size={14} style={{ color: 'var(--text-muted)' }} />}
      </div>

      {/* 内容 */}
      <div className={`flex-1 max-w-[75%] ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
        <div
          className="px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap"
          style={{
            backgroundColor: isUser ? 'var(--primary)' : 'var(--bg-surface)',
            color: isUser ? '#fff' : 'var(--text-primary)',
            borderBottomLeftRadius: isUser ? '0.75rem' : '0.25rem',
            borderBottomRightRadius: isUser ? '0.25rem' : '0.75rem',
          }}
        >
          {msg.content}
        </div>

        {msg.sources && ((msg.sources.kb?.length ?? 0) > 0 || (msg.sources.calcs?.length ?? 0) > 0) && (
          <div className="flex flex-wrap gap-1.5 mt-1">
            {msg.sources.kb?.map((s, i) => (
              <span key={'kb-' + i} className="chip">📚 {s.ref}</span>
            ))}
            {msg.sources.calcs?.map((c, i) => (
              <span key={'calc-' + i} className="chip">🧮 {c.name}</span>
            ))}
          </div>
        )}

        {/* 知识库检索增强 + 工程计算内核（兼容路径下为后端 RAG 结果回放） */}
        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="w-full">
            {msg.toolCalls.map(tc => <ToolCallCard key={tc.id} tc={tc} />)}
          </div>
        )}

        {/* P0-8 修复：追问引导卡片（来自后端 follow_up SSE 事件） */}
        {msg.followUps && msg.followUps.length > 0 && (
          <div className="w-full">
            <FollowUpCard items={msg.followUps} onApply={onApplyFollowUp} />
          </div>
        )}

        {msg.error && (
          <div className="flex items-center gap-1.5 text-xs text-red-400 mt-1">
            <AlertCircle size={12} />
            <span>{msg.error}</span>
          </div>
        )}

        {/* P3 用户反馈组件（仅 AI 消息） */}
        {!isUser && (
          <FeedbackWidget
            sessionId={currentSessionId}
            messageId={msg.id}
            agentKey={currentAgentKey}
            model={selectedModel}
          />
        )}
      </div>
    </motion.div>
  );
}

// ========================
// 权限弹窗
// ========================
function PermissionDialog({
  request, onAllow, onDeny,
}: {
  request: { tool: string; params: unknown };
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex items-center gap-2 px-3 py-2 rounded-xl border"
      style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
    >
      <AlertCircle size={14} style={{ color: '#f59e0b' }} />
      <span className="text-xs flex-1" style={{ color: 'var(--text-secondary)' }}>
        Agent 请求调用工具：<span className="font-mono font-medium">{request.tool}</span>
      </span>
      <button onClick={onAllow} className="px-3 py-1 rounded-lg text-xs font-medium text-white"
              style={{ backgroundColor: '#10b981' }}>允许</button>
      <button onClick={onDeny} className="px-3 py-1 rounded-lg text-xs font-medium border"
              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>拒绝</button>
    </motion.div>
  );
}

// ========================
// 主组件
// ========================
interface ChatPageProps {
  currentSession: any;
  models: ModelOption[];
  selectedModel: string;
  agents: Agent[];
  isLoading: boolean;
  inputValue: string;
  permissionRequest: { tool: string; params: unknown } | null;
  permissionMode: PermissionMode;
  onSendMessage: (text: string) => void;
  onStop: () => void;
  onInputChange: (val: string) => void;
  onModelChange: (modelId: string) => void;
  onPermissionAllow: (tool: string, params: unknown) => void;
  onPermissionDeny: (tool: string) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
}

export default function ChatPage({
  currentSession, models: _models, selectedModel, agents, isLoading, inputValue, permissionRequest,
  onSendMessage, onStop, onInputChange,
  onPermissionAllow, onPermissionDeny,
}: ChatPageProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messages = currentSession?.messages ?? [];
  const getAgent = (id: string) => agents.find(a => a.id === id);
  // 与 AppShell 逻辑保持一致：根据当前 session 的 agentId 取 agent
  const currentAgent = currentSession?.agentId ? getAgent(currentSession.agentId) : getAgent('default');
  const [detail, setDetail] = useDetailPref('chat');

  // 多智能体追问上下文：从 MultiAgentPage "追问这位专家" 带过来的专家身份与上下文
  // 关闭后清掉 sessionStorage，避免下次刷新又冒出来
  const [expertCtx, setExpertCtx] = useState<{ agentId?: string; name: string; icon: string; color: string } | null>(() => {
    try {
      const raw = sessionStorage.getItem('chat-prefill-expert');
      if (!raw) return null;
      const o = JSON.parse(raw);
      return o && o.name ? { agentId: typeof o.agentId === 'string' ? o.agentId : undefined, name: String(o.name), icon: String(o.icon ?? '🧠'), color: String(o.color ?? '#06b6d4') } : null;
    } catch { return null; }
  });
  const dismissExpert = () => {
    setExpertCtx(null);
    sessionStorage.removeItem('chat-prefill-expert');
  };

  // 追问卡片"采纳建议"：把问句回填到输入框，由用户修改后发送
  const handleApplyFollowUp = (prompt: string) => {
    onInputChange(prompt);
    // 焦点回到输入框（让用户能继续编辑）
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  // 专家身份展示名：优先用 MA_SYSTEM_PROMPTS 的中文 label，否则用 banner 自带 name
  //   （DiagnosisPage 的 engineer 不在 5 个专家里，fallback 到 banner name）
  const expertLabel = expertCtx
    ? (EXPERT_LABELS[expertCtx.agentId ?? ''] ?? expertCtx.name)
    : '';

  // 首页"一键问 AI"带入的问题：挂载后自动发送一次
  const sendRef = useRef(onSendMessage);
  useEffect(() => { sendRef.current = onSendMessage; }, [onSendMessage]);
  useEffect(() => {
    const q = sessionStorage.getItem('chat-prefill');
    if (!q) return;
    // 先移除再同步发送：StrictMode 双挂载下第二次读取为 null，不会重复发送
    sessionStorage.removeItem('chat-prefill');
    sendRef.current(q);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = () => {
    if (inputValue.trim()) {
      onSendMessage(inputValue.trim());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 多智能体追问上下文横幅 */}
      {expertCtx && (
        <div
          className="flex items-center gap-2 px-4 py-2 border-b text-[11px]"
          style={{
            borderColor: expertCtx.color,
            backgroundColor: expertCtx.color + '14',
            color: 'var(--text-primary)',
            boxShadow: `0 0 18px ${expertCtx.color}33`,
          }}
        >
          <span className="text-base">{expertCtx.icon}</span>
          <span style={{ color: expertCtx.color }} className="font-semibold">{expertCtx.name}</span>
          <span style={{ color: 'var(--text-secondary)' }}>· 已带场景与结论上下文追问中</span>

          {/* P0-8 修复：霓虹角标 "🧠 已切换为：{expertLabel}专家"
              - 边框 + glow（box-shadow）让评审一眼看见"这次对话确实被切到专家 system"
              - expertLabel 来自 MA_SYSTEM_PROMPTS 的 label 字段（agent 角色名），
                未命中则 fallback 到 banner 自带 name（DiagnosisPage 的 engineer） */}
          <span
            className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold"
            style={{
              border: `1px solid ${expertCtx.color}`,
              color: expertCtx.color,
              backgroundColor: 'transparent',
              boxShadow: `0 0 10px ${expertCtx.color}80, inset 0 0 6px ${expertCtx.color}33`,
              letterSpacing: '0.04em',
            }}
          >
            🧠 已切换为：{expertLabel}专家
          </span>

          <button
            onClick={dismissExpert}
            className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'var(--bg-elevated)'; }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; }}
          >
            <X size={11} /> 关闭
          </button>
        </div>
      )}
      {/* 消息区 */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full">
            <Bot size={40} style={{ color: 'var(--border-accent)' }} />
            <p className="text-sm mt-3 font-medium" style={{ color: 'var(--text-muted)' }}>
              LandfillMind · 填埋场智慧监测 AI 助手
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              问我关于填埋场设计、施工、运营的任何问题
            </p>
            <div className="mt-5 flex flex-wrap gap-2 justify-center max-w-md">
              {[
                '填埋场选址条件有哪些？',
                '边坡稳定 Fs 怎么算？',
                '渗滤液液位超标怎么处理？',
                'HDPE 膜厚度设计要求？',
              ].map((q, i) => (
                <button
                  key={i}
                  onClick={() => onSendMessage(q)}
                  className="chip cursor-pointer text-xs px-3 py-1.5"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg: Message) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              onApplyFollowUp={handleApplyFollowUp}
              currentSessionId={currentSession?.id ?? ''}
              currentAgentKey={currentAgent?.id ?? ''}
              selectedModel={selectedModel}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* 权限弹窗 */}
      {permissionRequest && (
        <div className="px-6 pb-2">
          <PermissionDialog
            request={permissionRequest}
            onAllow={() => onPermissionAllow(permissionRequest.tool, permissionRequest.params)}
            onDeny={() => onPermissionDeny(permissionRequest.tool)}
          />
        </div>
      )}

      {/* 输入区 */}
      <div className="shrink-0 px-6 pb-5 pt-2 border-t" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-surface)' }}>
        <div className="flex items-center gap-3 mb-2">
          <div className="flex items-center gap-1 p-1 rounded-lg" style={{ backgroundColor: 'var(--bg-elevated)' }}>
            <span className="text-[10px] font-semibold px-1.5" style={{ color: 'var(--text-muted)' }}>回答详细度</span>
            {([['brief', '摘要'], ['standard', '标准'], ['detailed', '详细']] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setDetail(key)}
                className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-all duration-150"
                style={{
                  backgroundColor: detail === key ? 'var(--bg-surface)' : 'transparent',
                  color: detail === key ? 'var(--text-primary)' : 'var(--text-muted)',
                  boxShadow: detail === key ? '0 1px 3px rgba(0,0,0,0.2)' : 'none',
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {detail === 'detailed' && (
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>详细模式：回复更全面，生成时间更长</span>
          )}
          {messages.length > 0 && (
            <div className="ml-auto flex items-center gap-1.5">
              <button
                onClick={() => downloadText(timestampName('专家问答', 'md'), buildChatMarkdown(currentSession))}
                className="btn btn-ghost btn-sm"
              >
                <FileDown size={12} /> 导出 MD
              </button>
              <button
                onClick={() => downloadJSON(timestampName('专家问答', 'json'), currentSession)}
                className="btn btn-ghost btn-sm"
              >
                <FileDown size={12} /> 导出 JSON
              </button>
            </div>
          )}
        </div>
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={e => onInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder="输入问题，按 Enter 发送..."
            className="flex-1 px-4 py-2.5 rounded-xl text-sm resize-none border outline-none"
            style={{
              backgroundColor: 'var(--bg-input)',
              borderColor: 'var(--border)',
              color: 'var(--text-primary)',
              maxHeight: '120px',
            }}
            onFocus={e => (e.target.style.borderColor = 'var(--primary)')}
            onBlur={e => (e.target.style.borderColor = 'var(--border)')}
          />
          {isLoading ? (
            <button
              onClick={onStop}
              className="btn btn-ghost w-10 h-10 rounded-xl"
            >
              <Square size={15} />
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!inputValue.trim()}
              className="btn btn-primary w-10 h-10 rounded-xl"
            >
              <Send size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
