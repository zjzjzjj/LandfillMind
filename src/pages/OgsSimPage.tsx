/**
 * OgsSimPage · 稳定化计算（OpenGeoSys 数值内核）
 *
 * 调用后端 /api/ogs/status + /api/ogs/run 运行求解：
 *   - 产气模拟（gas-production）：ADM1 式厌氧产甲烷模型，日分辨率时程
 *   - 沉降模拟（settlement）：OGS DEFORMATION 有限元求解
 * 展示求解摘要、关键指标卡片、时程曲线。
 */

import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Play, Loader2, RefreshCw, FlaskConical, ChevronDown, ChevronUp, Zap, TrendingUp, Wind } from 'lucide-react';

interface OgsParamSpec { key: string; label: string; unit?: string; default: number; min?: number; max?: number; step?: number; hint?: string; }
interface OgsScenarioMeta { id: string; name: string; description: string; params: OgsParamSpec[]; }
interface OgsTimeSeries { name: string; unit?: string; varName?: string; points: { t: number; v: number }[]; }
interface OgsRunResult {
  ok: boolean; runId: string; scenario: string; scenarioName: string;
  params: Record<string, number>; elapsedMs: number; logTail?: string;
  simulationTime?: string; summary: string; timeSeries: OgsTimeSeries[];
  fileSummaries: Array<{ file: string; min: number; max: number; mean: number; points: number }>;
  error?: string;
}

/** 格式化数值：大数用万，小数保留精度，极小数用科学计数法 */
const fmtAxis = (x: number) => {
  if (!Number.isFinite(x)) return '0';
  if (x === 0) return '0';
  const abs = Math.abs(x);
  if (abs >= 1e4) return (x / 1e4).toFixed(0) + '万';
  if (abs >= 100) return x.toFixed(0);
  if (abs >= 1) return x.toFixed(1);
  if (abs >= 0.01) return x.toFixed(2);
  if (abs >= 0.001) return x.toFixed(3);
  // 极小数：用 ×10⁻ⁿ 格式
  const exp = Math.floor(Math.log10(abs));
  const mantissa = x / Math.pow(10, exp);
  const superscript = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  const expStr = String(Math.abs(exp)).split('').map(d => superscript[parseInt(d)]).join('');
  return `${mantissa.toFixed(1)}×10${exp < 0 ? '⁻' : ''}${expStr}`;
};

/** 颜色映射 */
const CHART_COLORS: Record<string, string> = {
  ch4_cum: '#3b82f6',    // 蓝
  co2_cum: '#10b981',    // 绿
  ch4_rate: '#6366f1',   // 靛蓝
  co2_rate: '#14b8a6',   // 青
  ch4_total: '#3b82f6',
  co2_total: '#10b981',
  deg_fast: '#ef4444',   // 红 - 快速纤维素
  deg_slow: '#f97316',   // 橙 - 慢速纤维素
  deg_glucose: '#eab308', // 黄 - 葡萄糖
  deg_protein: '#22c55e', // 绿 - 蛋白质
  deg_fat: '#3b82f6',    // 蓝 - 脂肪
  deg_vfa: '#8b5cf6',    // 紫 - VFA
  deg_bacteria: '#06b6d4', // 青 - 细菌
  DISPLACEMENT_Y1: '#f59e0b', // 琥珀 - 沉降
};
const getColor = (varName?: string) => (varName && CHART_COLORS[varName]) || '#06b6d4';

/** SVG 时程曲线 */
function TimeSeriesChart({ series }: { series: OgsTimeSeries }) {
  const pts = series.points;
  if (!pts || pts.length < 2) return <p className="text-xs" style={{ color: 'var(--text-muted)' }}>数据点不足</p>;
  const W = 460, H = 200, PAD_L = 56, PAD_R = 16, PAD_T = 12, PAD_B = 44;
  const ts = pts.map((p) => p.t);
  const vs = pts.map((p) => p.v);
  const tMin = Math.min(...ts), tMax = Math.max(...ts);
  const vMinRaw = Math.min(...vs), vMaxRaw = Math.max(...vs);
  // Y 轴强制从 0 开始；若数据全为负则保留原始最小值
  const vMin = vMinRaw >= 0 ? 0 : vMinRaw;
  const vMax = vMaxRaw >= 0 ? vMaxRaw * 1.05 : vMaxRaw; // 正值时顶部留 5% 余量
  const tRange = tMax - tMin || 1;
  const vRange = vMax - vMin || 1;
  const X = (t: number) => PAD_L + (t - tMin) / tRange * (W - PAD_L - PAD_R);
  const Y = (v: number) => H - PAD_B - (v - vMin) / vRange * (H - PAD_T - PAD_B);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
  const color = getColor(series.varName);

  // Y 轴刻度（3~5 个，从 0 开始）
  const yTicks: number[] = [];
  const yStep = vRange / 4;
  for (let i = 0; i <= 4; i++) yTicks.push(vMin + i * yStep);

  // X 轴刻度（智能选择步长）
  const xTicks: number[] = [];
  let xStep: number;
  if (tRange <= 10) xStep = 1;
  else if (tRange <= 50) xStep = 5;
  else if (tRange <= 200) xStep = 20;
  else if (tRange <= 1000) xStep = 100;
  else xStep = Math.ceil(tRange / 8 / 100) * 100;
  for (let t = Math.ceil(tMin / xStep) * xStep; t <= tMax; t += xStep) xTicks.push(t);

  // X 轴单位推断
  const xUnit = tMax > 1e5 ? 's' : tMax > 1000 ? 's' : 'd';
  // 图表绘制区域中心
  const plotCenterX = PAD_L + (W - PAD_L - PAD_R) / 2;
  const plotCenterY = PAD_T + (H - PAD_T - PAD_B) / 2;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={series.name}>
      {/* 网格线 */}
      {yTicks.map((v, i) => (
        <g key={`y${i}`}>
          <line x1={PAD_L} y1={Y(v)} x2={W - PAD_R} y2={Y(v)} stroke="var(--border)" strokeOpacity="0.5" strokeDasharray="2,3" />
          <text x={PAD_L - 6} y={Y(v) + 3} textAnchor="end" fontSize="9" fill="var(--text-muted)">{fmtAxis(v)}</text>
        </g>
      ))}
      {xTicks.map((t) => (
        <g key={`x${t}`}>
          <line x1={X(t)} y1={H - PAD_B} x2={X(t)} y2={H - PAD_B + 3} stroke="var(--border)" />
          <text x={X(t)} y={H - PAD_B + 14} textAnchor="middle" fontSize="8" fill="var(--text-muted)">{fmtAxis(t)}</text>
        </g>
      ))}
      {/* 坐标轴 */}
      <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} stroke="var(--border)" />
      <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} stroke="var(--border)" />
      {/* X 轴标题 — 底部居中独立放置 */}
      <text x={plotCenterX} y={H - 4} textAnchor="middle" fontSize="9" fill="var(--text-muted)">
        时间 ({xUnit})
      </text>
      {/* Y 轴标题 — 左侧垂直居中独立放置（单位归属测量值，写在 Y 轴） */}
      <text x={14} y={plotCenterY} textAnchor="middle" fontSize="9" fill="var(--text-muted)"
            transform={`rotate(-90, 14, ${plotCenterY})`}>
        {series.unit ? `${series.name}（${series.unit}）` : series.name}
      </text>
      {/* 曲线 */}
      <path d={line} fill="none" stroke={color} strokeWidth="2" />
      {/* 起止点 */}
      <circle cx={X(pts[0].t)} cy={Y(pts[0].v)} r="3" fill={color} />
      <circle cx={X(pts[pts.length - 1].t)} cy={Y(pts[pts.length - 1].v)} r="3" fill={color} opacity="0.6" />
      {/* 终点数值标注 */}
      <text x={X(pts[pts.length - 1].t) + 4} y={Y(pts[pts.length - 1].v) - 4} fontSize="9" fontWeight="600" fill={color}>
        {fmtAxis(pts[pts.length - 1].v)}
      </text>
    </svg>
  );
}

/** 关键指标卡片 */
function MetricCard({ icon, label, value, unit, color }: { icon: React.ReactNode; label: string; value: string; unit?: string; color: string }) {
  return (
    <div className="rounded-xl border p-3 flex items-center gap-3" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-elevated)' }}>
      <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ backgroundColor: color + '18' }}>
        {icon}
      </div>
      <div>
        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{label}</p>
        <p className="text-base font-bold font-mono" style={{ color }}>{value}{unit && <span className="text-xs font-normal ml-1" style={{ color: 'var(--text-muted)' }}>{unit}</span>}</p>
      </div>
    </div>
  );
}

export default function OgsSimPage() {
  const [scenarios, setScenarios] = useState<OgsScenarioMeta[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [exePath, setExePath] = useState<string>('');
  const [selectedId, setSelectedId] = useState('gw-flow');
  const [params, setParams] = useState<Record<string, number>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OgsRunResult | null>(null);
  const [error, setError] = useState('');
  const [logOpen, setLogOpen] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/ogs/status').then((x) => x.json());
      setScenarios(r.scenarios ?? []);
      setAvailable(!!r.available);
      setExePath(r.exe ?? '');
    } catch { setAvailable(false); }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // 场景列表加载后，若当前选中项不在列表里，自动选中第一个
  useEffect(() => {
    if (scenarios.length > 0 && !scenarios.find(s => s.id === selectedId)) {
      setSelectedId(scenarios[0].id);
    }
  }, [scenarios, selectedId]);

  const scenario = scenarios.find((s) => s.id === selectedId);

  // 切场景时用默认参数初始化
  useEffect(() => {
    if (scenario) {
      const init: Record<string, number> = {};
      for (const p of scenario.params) init[p.key] = p.default;
      setParams(init);
    }
  }, [scenario?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    setRunning(true);
    setError('');
    setResult(null);
    try {
      const r = await fetch('/api/ogs/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: selectedId, params }),
      });
      const data = await r.json();
      if (r.ok && data.ok) setResult(data);
      else setError(data?.summary ?? data?.error ?? 'OGS 运行失败');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const setParam = (key: string, v: number) => setParams((prev) => ({ ...prev, [key]: v }));

  return (
    <div className="flex-1 overflow-y-auto p-6" style={{ backgroundColor: 'var(--bg-base)' }}>
      <div className="max-w-5xl mx-auto">
        {/* 页头 */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <FlaskConical size={20} style={{ color: 'var(--primary)' }} /> 稳定化计算
            </h1>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              OpenGeoSys 有限元求解器本地调用 · 确定性数值内核，非 LLM 推算
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] px-2 py-1 rounded-full font-mono"
                  style={{ backgroundColor: available ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                           color: available ? '#10b981' : '#ef4444', border: '1px solid currentColor' }}>
              {available ? '✓ 求解器就绪' : '✗ 求解器不可用'}
            </span>
            <button onClick={loadStatus} className="p-1.5 rounded-lg border" title="刷新状态"
                    style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
              <RefreshCw size={13} />
            </button>
          </div>
        </div>

        {available === false && (
          <div className="rounded-xl border p-4 mb-4 text-sm" style={{ borderColor: '#f59e0b55', color: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.06)' }}>
            ⚠ 未找到 OGS 求解器（ogs.exe）。请在项目根目录 .env 设置 <code>OGS_EXE=你的ogs.exe路径</code>，
            或将求解器拷贝到 <code>data/ogs/bin/ogs.exe</code>。当前尝试路径：<code>{exePath || '无'}</code>
          </div>
        )}

        {/* 场景选择 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          {scenarios.map((s) => (
            <button key={s.id} onClick={() => setSelectedId(s.id)}
                    className="rounded-xl border p-3 text-left transition-all"
                    style={{ borderColor: selectedId === s.id ? 'var(--primary)' : 'var(--border)',
                             backgroundColor: selectedId === s.id ? 'rgba(6,182,212,0.06)' : 'var(--bg-surface)',
                             boxShadow: selectedId === s.id ? '0 0 16px rgba(6,182,212,0.12)' : 'none' }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{s.name}</span>
                {selectedId === s.id && <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--primary)' }} />}
              </div>
              <p className="text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>{s.description}</p>
            </button>
          ))}
        </div>

        {/* 参数表单 */}
        {scenario && (
          <div className="rounded-2xl border p-4 mb-4" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-surface)' }}>
            <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
              {scenario.name} · 模拟参数
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {scenario.params.map((p) => (
                <label key={p.key} className="block">
                  <span className="text-xs mb-1 flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
                    {p.label}
                    {p.unit && <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>({p.unit})</span>}
                  </span>
                  <input
                    type="number"
                    value={params[p.key] ?? p.default}
                    step={p.step || 'any'}
                    min={p.min}
                    max={p.max}
                    onChange={(e) => setParam(p.key, parseFloat(e.target.value))}
                    className="w-full rounded-lg border px-3 py-2 text-sm font-mono outline-none"
                    style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)' }}
                  />
                  {p.hint && <span className="block text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{p.hint}</span>}
                </label>
              ))}
            </div>
            <button
              onClick={run}
              disabled={running || !available}
              className="mt-4 w-full py-2.5 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-2 transition-all disabled:opacity-50"
              style={{ backgroundColor: 'var(--primary)' }}
              onMouseEnter={(e) => !running && (e.currentTarget.style.boxShadow = '0 0 20px rgba(6,182,212,0.4)')}
              onMouseLeave={(e) => (e.currentTarget.style.boxShadow = 'none')}
            >
              {running ? (<><Loader2 size={15} className="animate-spin" /> {selectedId === 'gas-production' ? '产气预测计算中…' : '求解器中…'}</>)
                       : (<><Play size={15} /> 运行稳定化计算</>)}
            </button>
          </div>
        )}

        {/* 结果区 */}
        {error && (
          <div className="rounded-xl border p-3 mb-4 text-sm" style={{ borderColor: '#ef444455', color: '#ef4444', backgroundColor: 'rgba(239,68,68,0.06)' }}>
            {error}
          </div>
        )}

        <AnimatePresence>
          {result && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                        className="rounded-2xl border p-5 mb-4" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-surface)' }}>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: result.ok ? '#10b981' : '#ef4444' }} />
                  {result.scenarioName} · 求解结果
                  {result.ok && <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ backgroundColor: 'rgba(16,185,129,0.1)', color: '#10b981' }}>正常收敛</span>}
                </h2>
                <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                  模拟 {result.simulationTime ?? '-'} · {result.elapsedMs > 0 ? `求解 ${result.elapsedMs}ms` : '确定性计算'}
                </span>
              </div>

              {/* 关键指标卡片（产气场景） */}
              {result.scenario === 'gas-production' && result.timeSeries.length > 0 && (() => {
                const ch4Cum = result.timeSeries.find(s => s.varName === 'ch4_cum');
                const co2Cum = result.timeSeries.find(s => s.varName === 'co2_cum');
                const ch4Rate = result.timeSeries.find(s => s.varName === 'ch4_rate');
                const ch4Total = result.timeSeries.find(s => s.varName === 'ch4_total');
                const co2Total = result.timeSeries.find(s => s.varName === 'co2_total');
                const finalCH4 = ch4Total?.points[ch4Total.points.length - 1]?.v ?? ch4Cum?.points[ch4Cum!.points.length - 1]?.v ?? 0;
                const finalCO2 = co2Total?.points[co2Total.points.length - 1]?.v ?? co2Cum?.points[co2Cum!.points.length - 1]?.v ?? 0;
                const peakRate = ch4Rate ? Math.max(...ch4Rate.points.map(p => p.v)) : 0;
                return (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                    <MetricCard icon={<FlaskConical size={16} color="#3b82f6" />} label="CH₄ 累计产量" value={finalCH4.toFixed(0)} unit="万m³" color="#3b82f6" />
                    <MetricCard icon={<Wind size={16} color="#10b981" />} label="CO₂ 累计产量" value={finalCO2.toFixed(0)} unit="万m³" color="#10b981" />
                    <MetricCard icon={<TrendingUp size={16} color="#6366f1" />} label="CH₄ 日产峰值" value={peakRate.toFixed(2)} unit="万m³/d" color="#6366f1" />
                    <MetricCard icon={<Zap size={16} color="#f59e0b" />} label="发电潜力" value={((finalCH4 * 1e4 * 9.97) / 1000).toFixed(0)} unit="MWh" color="#f59e0b" />
                  </div>
                );
              })()}

              {/* 汇总文本 */}
              <pre className="text-[12px] font-mono whitespace-pre-wrap rounded-lg p-3 mb-4"
                   style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {result.summary}
              </pre>

              {/* 时程曲线（2列网格） */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                {result.timeSeries.map((s) => (
                  <div key={s.name} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-elevated)' }}>
                    <p className="text-[11px] font-semibold mb-1 flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: getColor(s.varName) }} />
                      {s.name}
                    </p>
                    <TimeSeriesChart series={s} />
                  </div>
                ))}
              </div>

              {/* 域统计 */}
              {result.fileSummaries.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
                  {result.fileSummaries.slice(0, 3).map((f) => (
                    <div key={f.file} className="rounded-lg border p-2" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-elevated)' }}>
                      <p className="text-[10px] font-mono mb-1 truncate" style={{ color: 'var(--text-muted)' }}>{f.file}</p>
                      <p className="text-[10px] font-mono" style={{ color: 'var(--text-secondary)' }}>
                        min {f.min.toExponential(2)} · max {f.max.toExponential(2)} · 节点 {f.points}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* 日志折叠 */}
              <button onClick={() => setLogOpen(!logOpen)} className="flex items-center gap-1.5 text-[11px]"
                      style={{ color: 'var(--text-muted)' }}>
                {logOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />} 求解日志
              </button>
              {logOpen && result.logTail && (
                <pre className="text-[10px] font-mono whitespace-pre-wrap rounded-lg p-3 mt-2 max-h-48 overflow-y-auto"
                     style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-muted)' }}>
                  {result.logTail}
                </pre>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
