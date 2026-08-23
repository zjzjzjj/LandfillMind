import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Calculator, Search, BookOpen, ArrowRight, ChevronRight, FileDown } from 'lucide-react';
import type { CalcResult } from '../types';
import { buildCalcMarkdown, downloadJSON, downloadText, openPrintableHtml, timestampName } from '../utils/exporter';

const CALC_LIST = [
  { id: 'slopeFs', name: '堆体稳定 Fs', desc: '圆弧滑动法计算边坡稳定安全系数', ref: 'CJJ 176 §4.5' },
  { id: 'injectR', name: '注气驱替半径', desc: '循环井注气影响半径估算', ref: 'CJJ 176 §5.2' },
  { id: 'leachateCalc', name: '渗滤液产量', desc: '基于降雨入渗的渗滤液日产方量', ref: 'CJJ 176 §5.1' },
  { id: 'lfgYield', name: '填埋气产气量', desc: 'LandGEM 一阶衰减模型', ref: 'USEPA LandGEM' },
  { id: 'wellR', name: '循环井影响半径', desc: '地下水循环井影响范围', ref: 'HJ 25.6' },
  { id: 'advect', name: '污染物对流-弥散', desc: '地下水中污染物迁移浓度预测', ref: 'HJ 25.6' },
  { id: 'soilScreen', name: '土壤筛选值', desc: '建设用地土壤污染风险筛选值', ref: 'GB 36600-2018' },
  { id: 'decayCalc', name: '衰减达标年限', desc: '污染物自然衰减达标年限', ref: 'HJ 25.6' },
  { id: 'linerKeq', name: '复合衬垫等效渗透', desc: 'HDPE+GCL 复合衬垫等效渗透系数', ref: 'GB 16889 §5.1' },
  { id: 'hdpeCheck', name: 'HDPE 膜验算', desc: 'HDPE 膜厚度与焊缝强度验算', ref: 'GB/T 17643' },
  { id: 'settlementHyper', name: '沉降预测', desc: '双曲线法沉降量预测', ref: 'CJJ 176 §4.6' },
  { id: 'capacity', name: '库容与年限', desc: '填埋场库容与使用年限估算', ref: 'CJJ 176 §3.3' },
];

// 各计算器的参数定义
const PARAMS_MAP: Record<string, Array<{ name: string; label: string; unit?: string; default?: number | string; min?: number; max?: number; type?: 'number' | 'select'; options?: string[] }>> = {
  slopeFs: [
    { name: 'H', label: '堆体高度 H', unit: 'm', default: 30, min: 0 },
    { name: 'beta', label: '坡角倒数 1:β', unit: '', default: 3, min: 1 },
    { name: 'gamma', label: '垃圾重度 γ', unit: 'kN/m³', default: 10, min: 0 },
    { name: 'c', label: '黏聚力 c', unit: 'kPa', default: 5, min: 0 },
    { name: 'phi', label: '内摩擦角 φ', unit: '°', default: 25, min: 0, max: 60 },
  ],
  capacity: [
    { name: 'A', label: '填埋面积', unit: 'ha', default: 10, min: 0 },
    { name: 'H', label: '平均填埋深度', unit: 'm', default: 30, min: 0 },
    { name: 'rho', label: '垃圾填埋密度', unit: 'kN/m³', default: 10, min: 0 },
    { name: 'Qd', label: '日均垃圾填入量', unit: 'm³/d', default: 500, min: 0 },
  ],
  hdpeCheck: [
    { name: 'D', label: '膜厚', unit: 'mm', default: 1.5, min: 0 },
    { name: 'sigma', label: '最大应力', unit: 'MPa', default: 5, min: 0 },
    { name: 'eps', label: '应变', unit: '%', default: 2, min: 0, max: 30 },
  ],
  wellR: [
    { name: 'Q', label: '抽注流量', unit: 'm³/d', default: 100, min: 0 },
    { name: 't', label: '运行时间', unit: 'd', default: 30, min: 0 },
    { name: 'ne', label: '有效孔隙度', unit: '', default: 0.3, min: 0, max: 1 },
    { name: 'dh', label: '水位变幅', unit: 'm', default: 2, min: 0 },
  ],
  // ===== 以下为透传计算器表单（原缺失，导致表单为空、无法输入参数） =====
  injectR: [
    { name: 'Pinj', label: '注气压力 Pinj', unit: 'kPa', default: 4, min: 0 },
    { name: 't', label: '处理时间 t', unit: 'h', default: 24, min: 0 },
    { name: 'mu', label: '动力黏度 μ', unit: '', default: 1, min: 0 },
    { name: 'k', label: '渗透率系数 k', unit: '', default: 1, min: 0 },
  ],
  leachateCalc: [
    { name: 'area', label: '填埋面积', unit: '万㎡', default: 30, min: 0 },
    { name: 'rainfall', label: '年降雨量', unit: 'mm', default: 1200, min: 0 },
    { name: 'runoffCoeff', label: '径流系数', unit: '', default: 0.3, min: 0, max: 1 },
    { name: 'wasteHeight', label: '垃圾覆盖厚度', unit: 'm', default: 0, min: 0 },
  ],
  lfgYield: [
    { name: 'M', label: '垃圾量 M', unit: '万吨', default: 500, min: 0 },
    { name: 'k', label: '降解速率 k', unit: '/a', default: 0.1, min: 0 },
    { name: 'year', label: '填埋龄期', unit: 'a', default: 10, min: 0 },
    { name: 'Lo', label: '产气潜力 L₀', unit: 'm³/t', default: 170, min: 0 },
  ],
  advect: [
    { name: 'C0', label: '源浓度 C0', unit: 'mg/L', default: 100, min: 0 },
    { name: 'v', label: '流速 v', unit: 'm/d', default: 0.1, min: 0 },
    { name: 'x', label: '迁移距离 x', unit: 'm', default: 50, min: 0 },
    { name: 'D', label: '弥散系数 D', unit: 'm²/d', default: 10, min: 0 },
  ],
  soilScreen: [
    { name: 'pol', label: '污染物', type: 'select', options: ['砷', '镉', '铅', '汞', '镍', '苯', '铬(六价)'], default: '砷' },
    { name: 'cls', label: '用地类型', type: 'select', options: ['一类(居住/学校)', '二类(工业/商业)'], default: '一类(居住/学校)' },
  ],
  decayCalc: [
    { name: 'C0', label: '初始浓度 C0', unit: 'mg/L', default: 500, min: 0 },
    { name: 'Ctarget', label: '目标浓度 Ct', unit: 'mg/L', default: 50, min: 0 },
    { name: 't12', label: '半衰期 t½', unit: 'd', default: 1000, min: 0 },
  ],
  linerKeq: [
    { name: 'd1', label: 'HDPE 厚度 d1', unit: 'mm', default: 1.5, min: 0 },
    { name: 'k1', label: 'HDPE 渗透 k1', unit: 'cm/s', default: 0.0000001, min: 0 },
    { name: 'd2', label: 'GCL 厚度 d2', unit: 'mm', default: 6, min: 0 },
    { name: 'k2', label: 'GCL 渗透 k2', unit: 'cm/s', default: 0.000000001, min: 0 },
    { name: 'theta', label: '缺陷率 θ', unit: '', default: 0.1, min: 0 },
  ],
  settlementHyper: [
    { name: 't1', label: '观测时间 t1', unit: 'd', default: 30, min: 0 },
    { name: 's1', label: '沉降量 s1', unit: 'mm', default: 50, min: 0 },
    { name: 't2', label: '观测时间 t2', unit: 'd', default: 180, min: 0 },
    { name: 's2', label: '沉降量 s2', unit: 'mm', default: 200, min: 0 },
  ],
};

const GRADE_COLOR = {
  red: '#dc2626', orange: '#ea580c', yellow: '#ca8a04', blue: '#2563eb', green: '#16a34a',
};
const GRADE_LABEL = {
  red: '危险', orange: '警示', yellow: '注意', blue: '关注', green: '正常',
};

function GradeBadge({ grade }: { grade: string }) {
  const color = GRADE_COLOR[grade as keyof typeof GRADE_COLOR] ?? '#64748b';
  const label = GRADE_LABEL[grade as keyof typeof GRADE_LABEL] ?? grade;
  return (
    <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ backgroundColor: `${color}18`, color }}>
      {label}
    </span>
  );
}

function ResultPanel({ result, calcName, calcRef, params }: {
  result: CalcResult;
  calcName: string;
  calcRef: string;
  params: Record<string, number | string>;
}) {
  const exportMd = () => downloadText(timestampName('计算书', 'md'), buildCalcMarkdown(calcName, calcRef, params, result));
  const exportHtml = () => openPrintableHtml(`${calcName} · 计算书`, buildCalcMarkdown(calcName, calcRef, params, result));
  const exportJson = () => downloadJSON(timestampName('计算书', 'json'), { calcName, calcRef, params, result });
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border overflow-hidden"
      style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-surface)' }}
    >
      <div className="h-1" style={{ backgroundColor: GRADE_COLOR[result.grade as keyof typeof GRADE_COLOR] ?? '#64748b' }} />
      <div className="p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>计算结果</span>
          <GradeBadge grade={result.grade} />
        </div>
        {result.value !== undefined && (
          <div className="flex items-baseline gap-2 mb-3">
            <span
              className="text-4xl font-bold font-mono"
              style={{ color: GRADE_COLOR[result.grade as keyof typeof GRADE_COLOR] ?? 'inherit' }}
            >
              {typeof result.value === 'number' ? result.value.toFixed(2) : result.value}
            </span>
            {result.unit && <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{result.unit}</span>}
          </div>
        )}
        <p className="text-xs leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
          {result.analysis}
        </p>
        {result.ref && (
          <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>依据：{result.ref}</span>
          </div>
        )}
        <div className="mt-4 pt-3 border-t flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
          <span className="text-[10px] font-semibold mr-auto" style={{ color: 'var(--text-muted)' }}>导出计算书</span>
          <button
            onClick={exportMd}
            className="text-[11px] px-2 py-1 rounded-md border flex items-center gap-1 transition-colors"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.color = 'var(--primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            <FileDown size={11} /> MD
          </button>
          <button
            onClick={exportHtml}
            className="text-[11px] px-2 py-1 rounded-md border flex items-center gap-1 transition-colors"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.color = 'var(--primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            <FileDown size={11} /> HTML·PDF
          </button>
          <button
            onClick={exportJson}
            className="text-[11px] px-2 py-1 rounded-md border flex items-center gap-1 transition-colors"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.color = 'var(--primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            <FileDown size={11} /> JSON
          </button>
        </div>
      </div>
    </motion.div>
  );
}

export default function DesignPage() {
  const [selected, setSelected] = useState(CALC_LIST[0]);
  const [params, setParams] = useState<Record<string, number | string>>({});
  const [result, setResult] = useState<CalcResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  // 初始化默认参数
  useEffect(() => {
    const p = PARAMS_MAP[selected.id] ?? [];
    const init: Record<string, number | string> = {};
    p.forEach(x => { init[x.name] = x.default ?? 0; });
    setParams(init);
    setResult(null);
  }, [selected]);

  const handleCalc = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/calc/${selected.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (res.ok) {
        const data = await res.json();
        setResult(data);
      }
    } catch {}
    setLoading(false);
  };

  const filtered = CALC_LIST.filter(c =>
    !search || c.name.includes(search) || c.desc.includes(search)
  );

  return (
    <div className="flex-1 overflow-hidden flex flex-col" style={{ backgroundColor: 'var(--bg-base)' }}>
      {/* 标题 */}
      <div className="px-6 pt-5 pb-4 border-b shrink-0" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-surface)' }}>
        <div className="flex items-center gap-2.5">
          <Calculator size={18} style={{ color: 'var(--primary)' }} />
          <div>
            <h1 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>计算中心</h1>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>12 项专业工程计算器，带规范引用与风险评级</p>
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* 左侧：计算器列表 */}
        <div className="w-64 flex-shrink-0 border-r overflow-y-auto" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-surface)' }}>
          {/* 搜索 */}
          <div className="p-3 border-b" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border"
                 style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-input)' }}>
              <Search size={13} style={{ color: 'var(--text-muted)' }} />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="搜索计算器..."
                className="flex-1 bg-transparent text-xs outline-none"
                style={{ color: 'var(--text-primary)' }}
              />
            </div>
          </div>
          {/* 列表 */}
          <div className="p-2 space-y-0.5">
            {filtered.map(calc => (
              <button
                key={calc.id}
                onClick={() => setSelected(calc)}
                className="w-full text-left px-3 py-2.5 rounded-lg transition-all duration-150 group"
                style={{
                  backgroundColor: selected.id === calc.id ? 'var(--primary-glow)' : 'transparent',
                }}
                onMouseEnter={e => { if (selected.id !== calc.id) e.currentTarget.style.backgroundColor = 'var(--bg-elevated)'; }}
                onMouseLeave={e => { if (selected.id !== calc.id) e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium truncate" style={{ color: selected.id === calc.id ? 'var(--primary)' : 'var(--text-primary)' }}>
                    {calc.name}
                  </span>
                  <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />
                </div>
                <p className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{calc.desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* 中间：参数表单 */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-xl space-y-5">
            {/* 计算器标题 */}
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{selected.name}</h2>
                <GradeBadge grade="green" />
              </div>
              <div className="flex items-center gap-2">
                <BookOpen size={12} style={{ color: 'var(--text-muted)' }} />
                <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{selected.ref}</span>
              </div>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{selected.desc}</p>
            </div>

            {/* 参数表单 */}
            <div
              className="rounded-2xl border p-5 space-y-4"
              style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-surface)' }}
            >
              <p className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>参数输入</p>
              {(PARAMS_MAP[selected.id] ?? []).map(p => (
                <div key={p.name}>
                  <label className="flex items-center justify-between mb-1.5">
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{p.label}</span>
                    {p.unit && <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{p.unit}</span>}
                  </label>
                  {p.type === 'select' ? (
                    <select
                      value={(params[p.name] ?? p.default) as string}
                      onChange={e => setParams(prev => ({ ...prev, [p.name]: e.target.value }))}
                      className="w-full px-3 py-2 rounded-xl text-sm border outline-none transition-all"
                      style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                      onFocus={e => (e.currentTarget.style.borderColor = 'var(--primary)')}
                      onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
                    >
                      {(p.options ?? []).map(o => (
                        <option key={o} value={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="number"
                      value={params[p.name] ?? p.default ?? 0}
                      onChange={e => setParams(prev => ({ ...prev, [p.name]: parseFloat(e.target.value) || 0 }))}
                      className="w-full px-3 py-2 rounded-xl text-sm font-mono border outline-none transition-all"
                      style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                      onFocus={e => (e.currentTarget.style.borderColor = 'var(--primary)')}
                      onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
                    />
                  )}
                </div>
              ))}
              <button
                onClick={handleCalc}
                disabled={loading}
                className="w-full py-2.5 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-2 transition-all disabled:opacity-50"
                style={{ backgroundColor: 'var(--primary)' }}
              >
                {loading
                  ? <div className="w-4 h-4 border-2 rounded-full animate-spin" style={{ borderColor: 'rgba(255,255,255,0.3)', borderTopColor: '#fff' }} />
                  : <><Calculator size={15} /> 开始计算</>
                }
              </button>
            </div>

            {/* 小屏：结果折叠到表单下方（lg 以下无右侧面板） */}
            <div className="lg:hidden">
              <AnimatePresence>
                {result && (
                  <ResultPanel result={result} calcName={selected.name} calcRef={selected.ref} params={params} />
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* 右侧：结果面板（≥lg 显示，独立滚动） */}
        <div
          className="hidden lg:block w-[380px] xl:w-[420px] flex-shrink-0 border-l overflow-y-auto p-5"
          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-elevated)' }}
        >
          <AnimatePresence>
            {result ? (
              <ResultPanel result={result} calcName={selected.name} calcRef={selected.ref} params={params} />
            ) : (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="h-full flex flex-col items-center justify-center text-center"
              >
                <Calculator size={36} style={{ color: 'var(--border-accent)' }} />
                <p className="text-sm mt-3 font-medium" style={{ color: 'var(--text-muted)' }}>暂无计算结果</p>
                <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  在左侧填写参数并点击「开始计算」，<br />结果将显示在这里
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
