/**
 * LandfillMind · 计算中心 v4.4（简洁 2 栏布局）
 *
 * 布局：左 240px 计算器列表 + 右 主区（单列流式）
 *   - 顶部条：标题 + 预设切换 + 立即计算按钮
 *   - 参数输入（单列，不撑宽）
 *   - 计算结果（KPI 卡 + 安全系数仪表）
 *   - 敏感性曲线
 *   - 公式推导（折叠）
 *   - 3 个聚合视图：场景对比 / 蒙特卡洛 / 成本估算（独立全宽视图）
 *
 * 实时计算保留（debounce 300ms），同时支持"立即计算"按钮触发
 */
import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Calculator, Search, Sliders, GitCompare, Activity,
  ChevronRight, FileDown, RotateCcw, FileText, Sparkles,
  TrendingUp, ShieldAlert, BookOpen, Play, ChevronDown, ChevronUp,
} from 'lucide-react';
import type { CalcResult } from '../types';
import {
  buildCalcMarkdown, downloadJSON, downloadText, openPrintableHtml, timestampName,
} from '../utils/exporter';
import { ResultInterpretation } from '../components/ResultInterpretation';
import { CalculationAnimation } from '../components/CalculationAnimation';
import { FeedbackTrendChart } from '../components/Charts';
import { SafetyFactorGauge } from '../components/SafetyFactorGauge';
import { HistogramChart } from '../components/HistogramChart';
import { PRESETS, PRESET_LABELS, applyPreset, suggestVaryParam, estimateCost, type PresetName } from '../utils/calcPresets';

// ============================================================
// 计算器清单
// ============================================================
const CALC_LIST = [
  { id: 'slopeFs',          name: '堆体稳定 Fs',         desc: '圆弧滑动法',                ref: 'CJJ 176 §4.5',         cat: '边坡' },
  { id: 'capacity',         name: '库容与年限',           desc: '填埋场库容估算',              ref: 'CJJ 176 §3.3',         cat: '容量' },
  { id: 'settlementHyper',  name: '沉降预测',             desc: '双曲线法',                   ref: 'CJJ 176 §4.6',         cat: '边坡' },
  { id: 'optimizeWellSpacing', name: '井间距优化',          desc: '抽水井最优井间距',            ref: 'CJJ 176 §5.2',         cat: '地下水' },
  { id: 'leachateCalc',     name: '渗滤液产量',           desc: '降雨入渗估算',                ref: 'CJJ 176 §5.1',         cat: '水气' },
  { id: 'moisturePredict',  name: '水量平衡',             desc: '入流-蒸散-径流-储量',          ref: 'CJJ 176 §5.3',         cat: '水气' },
  { id: 'lfgYield',         name: '填埋气产气量',         desc: 'LandGEM 一阶衰减',             ref: 'USEPA LandGEM',        cat: '水气' },
  { id: 'extractionPressure', name: '抽气井压力',          desc: 'LFG 抽气井压力损失',          ref: 'USEPA LFG Energy',     cat: '水气' },
  { id: 'hdpeCheck',        name: 'HDPE 膜验算',          desc: 'HDPE 膜厚度/焊缝',            ref: 'GB/T 17643',           cat: '防渗' },
  { id: 'linerKeq',         name: '复合衬垫等效渗透',     desc: 'HDPE+GCL 等效 k',             ref: 'GB 16889 §5.1',        cat: '防渗' },
  { id: 'wellR',            name: '循环井影响半径',       desc: '地下水循环井影响范围',         ref: 'HJ 25.6',              cat: '地下水' },
  { id: 'injectR',          name: '注气驱替半径',         desc: '循环井注气影响半径',           ref: 'CJJ 176 §5.2',         cat: '地下水' },
  { id: 'advect',           name: '污染物对流-弥散',      desc: '地下水迁移浓度',               ref: 'HJ 25.6',              cat: '地下水' },
  { id: 'soilScreen',       name: '土壤筛选值',           desc: '建设用地风险筛选',             ref: 'GB 36600-2018',        cat: '地下水' },
  { id: 'decayCalc',        name: '衰减达标年限',         desc: '自然衰减达标',                 ref: 'HJ 25.6',              cat: '地下水' },
];

const COMPARE_ID = '__compare__';
const MONTE_ID = '__monte__';
const COST_ID = '__cost__';

// ============================================================
// 参数定义
// ============================================================
const PARAMS_MAP: Record<string, Array<{ name: string; label: string; unit?: string; default?: number | string; min?: number; max?: number; type?: 'number' | 'select'; options?: string[] }>> = {
  slopeFs: [
    { name: 'H', label: '堆体高度 H', unit: 'm', default: 30, min: 5, max: 60 },
    { name: 'beta', label: '坡角倒数 1:β', default: 3, min: 1, max: 5 },
    { name: 'gamma', label: '垃圾重度 γ', unit: 'kN/m³', default: 10, min: 5, max: 18 },
    { name: 'c', label: '黏聚力 c', unit: 'kPa', default: 5, min: 0, max: 20 },
    { name: 'phi', label: '内摩擦角 φ', unit: '°', default: 25, min: 0, max: 45 },
  ],
  capacity: [
    { name: 'A', label: '填埋面积', unit: 'ha', default: 10, min: 1, max: 50 },
    { name: 'H', label: '平均填埋深度', unit: 'm', default: 30, min: 5, max: 80 },
    { name: 'rho', label: '垃圾填埋密度', unit: 'kN/m³', default: 10, min: 5, max: 15 },
    { name: 'Qd', label: '日均垃圾填入量', unit: 'm³/d', default: 500, min: 50, max: 5000 },
  ],
  hdpeCheck: [
    { name: 'D', label: '膜厚', unit: 'mm', default: 1.5, min: 0.5, max: 3 },
    { name: 'sigma', label: '最大应力', unit: 'MPa', default: 27, min: 10, max: 50 },
    { name: 'eps', label: '应变', unit: '%', default: 700, min: 100, max: 1000 },
    { name: 'P', label: '气压', unit: 'MPa', default: 0.2, min: 0.1, max: 0.5 },
    { name: 'hold', label: '持压时间', unit: 'min', default: 5, min: 1, max: 30 },
  ],
  wellR: [
    { name: 'Q', label: '抽注流量', unit: 'm³/d', default: 100, min: 10, max: 1000 },
    { name: 't', label: '运行时间', unit: 'd', default: 30, min: 1, max: 365 },
    { name: 'ne', label: '有效孔隙度', default: 0.3, min: 0.05, max: 0.5 },
    { name: 'dh', label: '水位变幅', unit: 'm', default: 2, min: 0.5, max: 10 },
  ],
  injectR: [
    { name: 'Pinj', label: '注气压力', unit: 'kPa', default: 4, min: 0, max: 20 },
    { name: 't', label: '处理时间', unit: 'h', default: 24, min: 1, max: 200 },
    { name: 'mu', label: '动力黏度', default: 1, min: 0.1, max: 5 },
    { name: 'k', label: '渗透率系数', default: 1, min: 0.1, max: 5 },
  ],
  leachateCalc: [
    { name: 'area', label: '填埋面积', unit: '万㎡', default: 30, min: 1, max: 200 },
    { name: 'rainfall', label: '年降雨量', unit: 'mm', default: 1200, min: 200, max: 3000 },
    { name: 'runoffCoeff', label: '径流系数', default: 0.3, min: 0.05, max: 0.9 },
    { name: 'wasteHeight', label: '垃圾覆盖厚度', unit: 'm', default: 0, min: 0, max: 20 },
  ],
  lfgYield: [
    { name: 'M', label: '垃圾量', unit: '万吨', default: 500, min: 10, max: 5000 },
    { name: 'k', label: '降解速率 k', unit: '/a', default: 0.1, min: 0.01, max: 0.5 },
    { name: 'year', label: '填埋龄期', unit: 'a', default: 10, min: 0, max: 50 },
    { name: 'Lo', label: '产气潜力 L₀', unit: 'm³/t', default: 170, min: 50, max: 300 },
  ],
  advect: [
    { name: 'C0', label: '源浓度 C0', unit: 'mg/L', default: 100, min: 0, max: 1000 },
    { name: 'v', label: '流速 v', unit: 'm/d', default: 0.1, min: 0, max: 5 },
    { name: 'x', label: '迁移距离 x', unit: 'm', default: 50, min: 0, max: 500 },
    { name: 'D', label: '弥散系数 D', unit: 'm²/d', default: 10, min: 0.1, max: 100 },
  ],
  soilScreen: [
    { name: 'pol', label: '污染物', type: 'select', options: ['砷', '镉', '铅', '汞', '镍', '苯', '铬(六价)'], default: '砷' },
    { name: 'cls', label: '用地类型', type: 'select', options: ['一类(居住/学校)', '二类(工业/商业)'], default: '一类(居住/学校)' },
  ],
  decayCalc: [
    { name: 'C0', label: '初始浓度 C0', unit: 'mg/L', default: 500, min: 0, max: 5000 },
    { name: 'Ctarget', label: '目标浓度 Ct', unit: 'mg/L', default: 50, min: 0, max: 1000 },
    { name: 't12', label: '半衰期 t½', unit: 'd', default: 1000, min: 10, max: 10000 },
  ],
  linerKeq: [
    { name: 'd1', label: 'HDPE 厚度 d1', unit: 'mm', default: 1.5, min: 0.5, max: 3 },
    { name: 'k1', label: 'HDPE 渗透 k1', unit: 'cm/s', default: 0.0000001, min: 0 },
    { name: 'd2', label: 'GCL 厚度 d2', unit: 'mm', default: 6, min: 2, max: 12 },
    { name: 'k2', label: 'GCL 渗透 k2', unit: 'cm/s', default: 0.000000001, min: 0 },
    { name: 'theta', label: '缺陷率 θ', default: 0.1, min: 0, max: 0.5 },
  ],
  settlementHyper: [
    { name: 't1', label: '观测时间 t1', unit: 'd', default: 30, min: 1, max: 365 },
    { name: 's1', label: '沉降量 s1', unit: 'mm', default: 50, min: 0, max: 500 },
    { name: 't2', label: '观测时间 t2', unit: 'd', default: 180, min: 30, max: 3650 },
    { name: 's2', label: '沉降量 s2', unit: 'mm', default: 200, min: 0, max: 2000 },
  ],
  optimizeWellSpacing: [
    { name: 'effectiveRadius', label: '有效影响半径', unit: 'm', default: 30, min: 5, max: 100 },
  ],
  moisturePredict: [
    { name: 'initialMoisture', label: '初始含水率', unit: '%', default: 60, min: 20, max: 90 },
    { name: 'injectionPressure', label: '注气压力', unit: 'kPa', default: 15, min: 5, max: 50 },
    { name: 'days', label: '处理天数', unit: 'd', default: 7, min: 1, max: 60 },
    { name: 'depth', label: '处理深度', unit: 'm', default: 5, min: 1, max: 30 },
  ],
  extractionPressure: [
    { name: 'injectionPressure', label: '注气压力', unit: 'kPa', default: 15, min: 5, max: 80 },
  ],
};

const THRESHOLDS: Record<string, Array<{ min?: number; max?: number; label: string; color: string }>> = {
  slopeFs: [
    { max: 1.0, label: '失稳', color: '#dc2626' },
    { min: 1.0, max: 1.2, label: '欠稳定', color: '#ea580c' },
    { min: 1.2, max: 1.3, label: '基本稳定', color: '#ca8a04' },
    { min: 1.3, max: 1.5, label: '稳定', color: '#16a34a' },
    { min: 1.5, label: '高裕度', color: '#0891b2' },
  ],
  hdpeCheck: [
    { max: 1.5, label: '不达标', color: '#dc2626' },
    { min: 1.5, max: 2.0, label: '达标', color: '#16a34a' },
    { min: 2.0, label: '偏厚', color: '#0891b2' },
  ],
  linerKeq: [
    { min: 1e-7, label: '超标', color: '#dc2626' },
    { min: 1e-9, max: 1e-7, label: '合规', color: '#16a34a' },
    { max: 1e-9, label: '优秀', color: '#0891b2' },
  ],
};

const GRADE_COLOR: Record<string, string> = {
  red: '#dc2626', orange: '#ea580c', yellow: '#ca8a04', blue: '#2563eb', green: '#16a34a',
};

// ============================================================
// Hooks
// ============================================================
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function loadSavedParams(calcId: string): Record<string, number | string> | null {
  try {
    const raw = localStorage.getItem(`design.params.${calcId}`);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}
function saveParams(calcId: string, params: Record<string, number | string>) {
  try { localStorage.setItem(`design.params.${calcId}`, JSON.stringify(params)); } catch { /* ignore */ }
}

// ============================================================
// 主组件
// ============================================================
export default function DesignPage() {
  // ============= 状态 =============
  const [selected, setSelected] = useState<string>('slopeFs');
  const [preset, setPreset] = useState<PresetName>('standard');
  const [params, setParams] = useState<Record<string, number | string>>(() => defaultParams('slopeFs'));
  const [result, setResult] = useState<CalcResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [calcTrigger, setCalcTrigger] = useState(0); // 立即计算按钮
  const [varyParam, setVaryParam] = useState<string>('H');
  const [sensitivity, setSensitivity] = useState<{ xs: number[]; ys: number[]; baseValue: number; baseX: number } | null>(null);
  const [showFormula, setShowFormula] = useState(false);
  const [compareScenarios, setCompareScenarios] = useState(() => [
    { label: '现状', params: applyPreset('slopeFs', 'standard') },
    { label: '加固后', params: applyPreset('slopeFs', 'conservative') },
  ]);
  const [compareResult, setCompareResult] = useState<any>(null);
  const [monteParams, setMonteParams] = useState<{ param: string; std: number }[]>([{ param: 'H', std: 5 }]);
  const [monteResult, setMonteResult] = useState<any>(null);
  const [costInputs, setCostInputs] = useState({ capacityM3: 300000, leachateM3PerYear: 10000, monitorWells: 8 });

  // 立即计算时缩短 debounce 到 0；自动计算用 300ms
  const debouncedParams = useDebounce(params, calcTrigger > 0 ? 0 : 300);
  const debouncedVaryParam = useDebounce(varyParam, 500);
  const debouncedMonteParams = useDebounce(monteParams, 500);
  const debouncedCompareScenarios = useDebounce(compareScenarios, 500);
  const debouncedCostInputs = useDebounce(costInputs, 300);

  // ============= 切换计算器 =============
  const handleSelect = useCallback((id: string) => {
    setSelected(id);
    setResult(null);
    setSensitivity(null);
    const saved = loadSavedParams(id);
    const initial = saved ?? applyPreset(id, preset);
    setParams(initial);
    setVaryParam(suggestVaryParam(id, initial));
    setCalcTrigger(t => t + 1); // 切换时立即算一次
  }, [preset]);

  const handlePresetChange = useCallback((p: PresetName) => {
    setPreset(p);
    if (selected === COMPARE_ID || selected === MONTE_ID || selected === COST_ID) return;
    const newParams = applyPreset(selected, p);
    setParams(newParams);
    setVaryParam(suggestVaryParam(selected, newParams));
    setCalcTrigger(t => t + 1);
  }, [selected]);

  const handleCalculate = useCallback(() => {
    setCalcTrigger(t => t + 1);
  }, []);

  // ============= 实时计算 =============
  useEffect(() => {
    if (selected === COMPARE_ID || selected === MONTE_ID || selected === COST_ID) return;
    if (!debouncedParams || Object.keys(debouncedParams).length === 0) return;
    setLoading(true);
    saveParams(selected, debouncedParams);
    fetch(`/api/calc/${selected}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(debouncedParams),
    })
      .then(r => r.json())
      .then(data => {
        if (data && typeof data.value !== 'undefined') {
          setResult(data as CalcResult);
        } else if (data?.error) {
          setResult({ ok: false, value: NaN, grade: 'red', analysis: `错误：${data.error}`, ref: '' } as CalcResult);
        }
      })
      .catch(err => setResult({ ok: false, value: NaN, grade: 'red', analysis: `网络错误：${err?.message ?? err}`, ref: '' } as CalcResult))
      .finally(() => setLoading(false));
  }, [selected, debouncedParams, calcTrigger]);

  // 敏感性
  useEffect(() => {
    if (selected === COMPARE_ID || selected === MONTE_ID || selected === COST_ID) return;
    if (!debouncedVaryParam || !debouncedParams[debouncedVaryParam]) return;
    fetch('/api/calc/sensitivity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: selected, params: debouncedParams, varyParam: debouncedVaryParam, n: 24 }),
    })
      .then(r => r.json())
      .then(d => { if (d?.xs) setSensitivity(d); })
      .catch(() => setSensitivity(null));
  }, [selected, debouncedParams, debouncedVaryParam, calcTrigger]);

  // 场景对比
  useEffect(() => {
    if (selected !== COMPARE_ID) return;
    if (debouncedCompareScenarios.length < 2) return;
    const baseParams = debouncedCompareScenarios[0].params;
    const sampleId = Object.keys(PARAMS_MAP).find(id => PARAMS_MAP[id].every(d => baseParams[d.name] !== undefined)) ?? 'slopeFs';
    fetch('/api/calc/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: sampleId, scenarios: debouncedCompareScenarios }),
    })
      .then(r => r.json())
      .then(d => setCompareResult(d?.results ?? []))
      .catch(() => setCompareResult(null));
  }, [selected, debouncedCompareScenarios]);

  // 蒙特卡洛
  useEffect(() => {
    if (selected !== MONTE_ID) return;
    if (debouncedMonteParams.length === 0) return;
    const baseParams = applyPreset('slopeFs', preset);
    const paramDist: Record<string, { mean: number; std: number }> = {};
    debouncedMonteParams.forEach(({ param, std }) => {
      const v = baseParams[param];
      if (typeof v === 'number') paramDist[param] = { mean: v, std };
    });
    fetch('/api/calc/montecarlo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'slopeFs', params: baseParams, paramDist, threshold: { op: '<', value: 1.30 }, iterations: 500 }),
    })
      .then(r => r.json())
      .then(d => setMonteResult(d))
      .catch(() => setMonteResult(null));
  }, [selected, debouncedMonteParams, preset]);

  // ============= 工具 =============
  const updateParam = (name: string, value: number | string) => {
    setParams(prev => ({ ...prev, [name]: value }));
  };

  const exportMd = () => {
    if (!result || selected === COMPARE_ID || selected === MONTE_ID || selected === COST_ID) return;
    const calcItem = CALC_LIST.find(c => c.id === selected);
    downloadText(timestampName('计算书', 'md'), buildCalcMarkdown(calcItem?.name ?? selected, calcItem?.ref ?? '', params, result));
  };
  const exportHtml = () => {
    if (!result || selected === COMPARE_ID || selected === MONTE_ID || selected === COST_ID) return;
    const calcItem = CALC_LIST.find(c => c.id === selected);
    openPrintableHtml(`${calcItem?.name ?? selected} · 计算书`, buildCalcMarkdown(calcItem?.name ?? selected, calcItem?.ref ?? '', params, result));
  };
  const exportJson = () => {
    const calcItem = CALC_LIST.find(c => c.id === selected);
    downloadJSON(timestampName('计算书', 'json'), { calcName: calcItem?.name, calcId: selected, params, result, sensitivity });
  };

  const groupedCalcs = useMemo(() => {
    const cats = ['边坡', '容量', '水气', '防渗', '地下水'] as const;
    const map: Record<string, typeof CALC_LIST> = {};
    cats.forEach(c => { map[c] = []; });
    CALC_LIST.filter(c => c.name.toLowerCase().includes(search.toLowerCase()) || c.desc.includes(search))
      .forEach(c => { (map[c.cat] ??= []).push(c); });
    return cats.map(c => ({ cat: c, items: map[c] || [] })).filter(g => g.items.length > 0);
  }, [search]);

  const selectedCalc = CALC_LIST.find(c => c.id === selected);
  const costResult = useMemo(() => estimateCost(debouncedCostInputs), [debouncedCostInputs]);

  // 公式步骤
  const formulaSteps = useMemo(() => {
    if (!result || selected === COMPARE_ID || selected === MONTE_ID || selected === COST_ID) return [];
    const steps: { label: string; formula: string; detail: string; result?: string }[] = [];
    const paramsDisplay = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(', ');
    steps.push({ label: '1. 输入参数', formula: `params = { ${paramsDisplay} }`, detail: '来自表单' });
    if (selected === 'slopeFs' && typeof params.H === 'number' && typeof params.beta === 'number' && typeof params.gamma === 'number' && typeof params.c === 'number' && typeof params.phi === 'number') {
      const H = params.H, beta = params.beta, gamma = params.gamma, c = params.c, phi = params.phi;
      const tanPhi = Math.tan(phi * Math.PI / 180);
      const alpha = Math.atan(1 / beta) / 2;
      const cosA = Math.cos(alpha), sinA = Math.sin(alpha);
      const W = 0.5 * gamma * H * H * (1 + 1 / beta);
      const Ls = W / (gamma * cosA * H / 2);
      const Fs = (c * Ls + W * cosA * cosA * tanPhi) / (W * sinA * cosA);
      steps.push({ label: '2. 弧面参数', formula: 'α = atan(1/β) / 2', detail: `α = ${(alpha * 180 / Math.PI).toFixed(2)}°` });
      steps.push({ label: '3. 滑动力 W', formula: 'W = ½ · γ · H² · (1 + 1/β)', detail: `W = ${W.toFixed(0)} kN/m` });
      steps.push({ label: '4. 弧长 Ls', formula: 'Ls = W / (γ · cosα · H / 2)', detail: `Ls = ${Ls.toFixed(1)} m` });
      steps.push({ label: '5. 安全系数 Fs', formula: 'Fs = (c·Ls + W·cos²α·tanφ) / (W·sinα·cosα)', detail: `Fs = ${Fs.toFixed(2)}`, result: `≥ 1.30 ? ${Fs >= 1.3 ? '✓ 满足' : '✗ 不满足'}` });
    } else {
      steps.push({ label: '2. 代入计算器', formula: `POST /api/calc/${selected}`, detail: '后端 calculate.ts 已实现' });
      steps.push({ label: '3. 输出', formula: 'CalcResult { value, grade, analysis, ref }', detail: result.analysis?.slice(0, 60) ?? '' });
    }
    return steps;
  }, [selected, params, result]);

  const sensitivityData = useMemo(() => {
    if (!sensitivity) return [];
    return sensitivity.xs.map((x, i) => ({ date: String(x.toFixed(1)), up: sensitivity.ys[i] || 0, down: 0 }));
  }, [sensitivity]);

  // ============= 渲染 =============
  return (
    <div className="flex h-full w-full" style={{ backgroundColor: 'var(--bg-base)' }}>
      {/* 左侧 240px 固定栏：计算器列表 */}
      <aside
        className="flex-shrink-0 flex flex-col overflow-hidden"
        style={{ width: 240, backgroundColor: 'var(--bg-surface)', borderRight: '1px solid var(--border)' }}
      >
        <div className="px-3 py-3 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2 mb-2">
            <Calculator size={15} style={{ color: 'var(--primary)' }} />
            <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>计算中心</span>
            <span className="text-[10px] ml-auto px-1.5 py-0.5 rounded font-mono" style={{ backgroundColor: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
              v4.4
            </span>
          </div>
          <div className="relative">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索..."
              className="w-full text-xs pl-7 pr-2 py-1.5 rounded outline-none border"
              style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {groupedCalcs.map(group => (
            <div key={group.cat} className="mb-3">
              <div className="text-[10px] font-semibold uppercase tracking-widest px-2 py-1" style={{ color: 'var(--text-muted)' }}>
                {group.cat}
              </div>
              <div className="space-y-0.5">
                {group.items.map(c => (
                  <button
                    key={c.id}
                    onClick={() => handleSelect(c.id)}
                    className="w-full text-left px-2.5 py-1.5 rounded text-xs transition-colors"
                    style={{
                      backgroundColor: selected === c.id ? 'rgba(14,165,183,0.10)' : 'transparent',
                      color: selected === c.id ? 'var(--primary)' : 'var(--text-secondary)',
                      borderLeft: selected === c.id ? '2px solid var(--primary)' : '2px solid transparent',
                    }}
                  >
                    <div className="truncate font-medium">{c.name}</div>
                  </button>
                ))}
              </div>
            </div>
          ))}

          <div className="text-[10px] font-semibold uppercase tracking-widest px-2 py-1 mt-4" style={{ color: 'var(--text-muted)' }}>
            高级分析
          </div>
          <div className="space-y-0.5">
            <SideNavItem icon={<GitCompare size={12} />} label="场景对比" active={selected === COMPARE_ID} onClick={() => { setSelected(COMPARE_ID); setResult(null); setSensitivity(null); }} />
            <SideNavItem icon={<Activity size={12} />} label="蒙特卡洛" active={selected === MONTE_ID} onClick={() => { setSelected(MONTE_ID); setResult(null); setSensitivity(null); }} />
            <SideNavItem icon={<TrendingUp size={12} />} label="成本估算" active={selected === COST_ID} onClick={() => { setSelected(COST_ID); setResult(null); setSensitivity(null); }} />
          </div>
        </div>
      </aside>

      {/* 主区：单列流式 */}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* 顶部条 */}
        <div className="flex items-center gap-3 px-6 py-3 border-b shrink-0" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-surface)' }}>
          <div className="flex items-center gap-2 min-w-0">
            <Sliders size={14} style={{ color: 'var(--primary)' }} />
            <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {selected === COMPARE_ID ? '场景对比' :
               selected === MONTE_ID ? '蒙特卡洛风险评估' :
               selected === COST_ID ? '运营成本估算' :
               selectedCalc?.name}
            </span>
            {selectedCalc && (
              <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                {selectedCalc.ref}
              </span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {/* 预设 */}
            {(['conservative', 'standard', 'aggressive'] as PresetName[]).map(p => (
              <button
                key={p}
                onClick={() => handlePresetChange(p)}
                disabled={selected === COMPARE_ID || selected === MONTE_ID || selected === COST_ID}
                className="text-[10px] px-2 py-1 rounded font-medium transition-colors disabled:opacity-30"
                style={{
                  backgroundColor: preset === p ? PRESET_LABELS[p].color + '20' : 'var(--bg-elevated)',
                  color: preset === p ? PRESET_LABELS[p].color : 'var(--text-muted)',
                  border: preset === p ? `1px solid ${PRESET_LABELS[p].color}40` : '1px solid transparent',
                }}
                title={PRESET_LABELS[p].desc}
              >
                {PRESET_LABELS[p].name}
              </button>
            ))}
            {/* 立即计算按钮 */}
            {selected !== COMPARE_ID && selected !== MONTE_ID && selected !== COST_ID && (
              <button
                onClick={handleCalculate}
                disabled={loading}
                className="ml-2 text-xs px-3 py-1.5 rounded font-semibold flex items-center gap-1.5 transition-all disabled:opacity-50"
                style={{ backgroundColor: 'var(--primary)', color: '#fff' }}
              >
                {loading ? <Activity size={12} className="animate-spin" /> : <Play size={12} />}
                {loading ? '计算中' : '立即计算'}
              </button>
            )}
          </div>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
            {selected === COMPARE_ID ? (
              <CompareModeFull scenarios={compareScenarios} setScenarios={setCompareScenarios} result={compareResult} />
            ) : selected === MONTE_ID ? (
              <MonteCarloFull
                params={monteParams} setParams={setMonteParams}
                preset={preset} result={monteResult}
              />
            ) : selected === COST_ID ? (
              <CostFull inputs={costInputs} setInputs={setCostInputs} result={costResult} />
            ) : (
              <SingleModeFull
                selected={selected}
                params={params}
                result={result}
                loading={loading}
                varyParam={varyParam}
                setVaryParam={setVaryParam}
                sensitivity={sensitivity}
                sensitivityData={sensitivityData}
                formulaSteps={formulaSteps}
                showFormula={showFormula}
                setShowFormula={setShowFormula}
                updateParam={updateParam}
                onExportMd={exportMd}
                onExportHtml={exportHtml}
                onExportJson={exportJson}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function defaultParams(calcId: string): Record<string, number | string> {
  const defs = PARAMS_MAP[calcId] ?? [];
  const obj: Record<string, number | string> = {};
  defs.forEach(p => { obj[p.name] = p.default ?? (p.type === 'select' ? (p.options?.[0] ?? '') : 0); });
  return obj;
}

function SideNavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-2.5 py-1.5 rounded text-xs flex items-center gap-1.5"
      style={{
        backgroundColor: active ? 'rgba(14,165,183,0.10)' : 'transparent',
        color: active ? 'var(--primary)' : 'var(--text-secondary)',
        borderLeft: active ? '2px solid var(--primary)' : '2px solid transparent',
      }}
    >
      <span className="opacity-70">{icon}</span>
      <span className="font-medium">{label}</span>
    </button>
  );
}

// ============================================================
// 单计算器（主区）— 单列流式
// ============================================================
function SingleModeFull(props: {
  selected: string;
  params: Record<string, number | string>;
  result: CalcResult | null;
  loading: boolean;
  varyParam: string;
  setVaryParam: (v: string) => void;
  sensitivity: { xs: number[]; ys: number[]; baseValue: number; baseX: number } | null;
  sensitivityData: { date: string; up: number; down: number }[];
  formulaSteps: { label: string; formula: string; detail: string; result?: string }[];
  showFormula: boolean;
  setShowFormula: (v: boolean) => void;
  updateParam: (name: string, value: number | string) => void;
  onExportMd: () => void;
  onExportHtml: () => void;
  onExportJson: () => void;
}) {
  const { selected, params, result, loading, varyParam, setVaryParam, sensitivity, sensitivityData, formulaSteps, showFormula, setShowFormula, updateParam, onExportMd, onExportHtml, onExportJson } = props;
  const defs = PARAMS_MAP[selected] ?? [];
  const isFs = selected === 'slopeFs';
  const FsValue = isFs && result && typeof result.value === 'number' ? result.value : null;
  const thresholds = THRESHOLDS[selected];

  return (
    <>
      {/* 1. 参数输入（单列，每行 label + input） */}
      <Card title="参数输入" icon={<Sliders size={13} />} hint={loading ? '计算中…' : '修改后自动计算（300ms）'}>
        <div className="space-y-3">
          {defs.map(p => (
            <ParamField key={p.name} param={p} value={params[p.name]} onChange={v => updateParam(p.name, v)} />
          ))}
        </div>
      </Card>

      {/* 2. 计算结果（KPI / 安全系数仪表） */}
      {result && (
        <Card title="计算结果" icon={<Sparkles size={13} />}>
          {isFs && FsValue !== null ? (
            <div className="flex flex-col items-center py-2">
              <SafetyFactorGauge Fs={FsValue} size={200} />
              {result.ref && (
                <div className="text-[10px] font-mono mt-3" style={{ color: 'var(--text-muted)' }}>
                  规范：{result.ref}
                </div>
              )}
            </div>
          ) : thresholds ? (
            <ResultInterpretation
              value={typeof result.value === 'number' ? result.value : 0}
              unit={result.unit ?? ''}
              label={CALC_LIST.find(c => c.id === selected)?.name ?? '计算结果'}
              thresholds={thresholds}
              interpretation={result.analysis ?? ''}
              reference={result.ref}
            />
          ) : (
            <PlainResult result={result} />
          )}
        </Card>
      )}

      {/* 3. 敏感性分析（仅 slopeFs 显著，其他计算器隐藏） */}
      {isFs && (
        <Card title="敏感性分析" icon={<TrendingUp size={13} />}>
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>变分参数：</span>
            {defs.filter(p => typeof params[p.name] === 'number').map(p => (
              <button
                key={p.name}
                onClick={() => setVaryParam(p.name)}
                className="text-[10px] px-2 py-0.5 rounded font-mono"
                style={{
                  backgroundColor: varyParam === p.name ? 'var(--primary)' : 'var(--bg-elevated)',
                  color: varyParam === p.name ? '#fff' : 'var(--text-secondary)',
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
          {sensitivityData.length > 0 ? (
            <>
              <FeedbackTrendChart data={sensitivityData} height={180} />
              <div className="mt-2 text-[10px] font-mono flex items-center gap-3" style={{ color: 'var(--text-muted)' }}>
                <span>基准：{sensitivity?.baseX?.toFixed(2)} → Fs = {sensitivity?.baseValue?.toFixed(2)}</span>
                {sensitivity && sensitivity.baseValue && sensitivity.baseValue < 1.3 && (
                  <span className="px-1.5 py-0.5 rounded" style={{ backgroundColor: '#fee2e2', color: '#dc2626' }}>
                    <ShieldAlert size={9} className="inline mr-0.5" />低于规范
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>计算中…</div>
          )}
        </Card>
      )}

      {/* 4. 公式推导（折叠） */}
      {formulaSteps.length > 0 && (
        <Card
          title="公式推导"
          icon={<BookOpen size={13} />}
          collapsible
          expanded={showFormula}
          onToggle={() => setShowFormula(!showFormula)}
        >
          <CalculationAnimation steps={formulaSteps} autoPlay={false} speed={800} title="" />
        </Card>
      )}

      {/* 5. 导出 */}
      {result && (
        <Card title="导出计算书" icon={<FileDown size={13} />}>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={onExportMd} className="text-xs px-3 py-1.5 rounded border flex items-center gap-1.5"
                    style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
              <FileDown size={11} /> Markdown
            </button>
            <button onClick={onExportHtml} className="text-xs px-3 py-1.5 rounded border flex items-center gap-1.5"
                    style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
              <FileText size={11} /> HTML·PDF
            </button>
            <button onClick={onExportJson} className="text-xs px-3 py-1.5 rounded border flex items-center gap-1.5"
                    style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
              <FileDown size={11} /> JSON
            </button>
          </div>
        </Card>
      )}

      {/* 空状态 */}
      {!result && !loading && (
        <div className="text-center text-sm py-12" style={{ color: 'var(--text-muted)' }}>
          <Calculator size={32} className="mx-auto mb-2 opacity-30" />
          <p>输入参数后自动计算，或点上方"立即计算"</p>
        </div>
      )}
    </>
  );
}

function ParamField({ param, value, onChange }: { param: NonNullable<typeof PARAMS_MAP[string]>[number]; value: number | string | undefined; onChange: (v: number | string) => void }) {
  if (param.type === 'select') {
    return (
      <div>
        <label className="flex items-center justify-between mb-1">
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{param.label}</span>
        </label>
        <select
          value={String(value ?? param.default ?? '')}
          onChange={e => onChange(e.target.value)}
          className="w-full text-sm px-3 py-1.5 rounded outline-none border"
          style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
        >
          {(param.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }
  const numVal = typeof value === 'number' ? value : parseFloat(String(value ?? '0'));
  return (
    <div>
      <label className="flex items-center justify-between mb-1">
        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{param.label}</span>
        {param.unit && <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{param.unit}</span>}
      </label>
      <input
        type="number"
        value={Number.isFinite(numVal) ? numVal : ''}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        min={param.min} max={param.max} step="any"
        className="w-full text-sm px-3 py-1.5 rounded outline-none border font-mono"
        style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
      />
    </div>
  );
}

function PlainResult({ result }: { result: CalcResult }) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold font-mono" style={{ color: GRADE_COLOR[result.grade] ?? 'var(--text-primary)' }}>
          {typeof result.value === 'number' ? result.value.toFixed(2) : '-'}
        </span>
        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{result.unit}</span>
      </div>
      <p className="text-sm mt-2 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{result.analysis}</p>
      {result.ref && (
        <div className="mt-2 pt-2 border-t text-[10px] font-mono" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
          规范：{result.ref}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 通用 Card 容器
// ============================================================
function Card({ title, icon, hint, collapsible, expanded, onToggle, children }: {
  title: string;
  icon?: React.ReactNode;
  hint?: string;
  collapsible?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-surface)' }}>
      <div className="px-4 py-2.5 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-elevated)' }}>
        {icon && <span style={{ color: 'var(--primary)' }}>{icon}</span>}
        <span className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-primary)' }}>{title}</span>
        {hint && <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>{hint}</span>}
        {collapsible && (
          <button onClick={onToggle} className="ml-auto p-0.5" style={{ color: 'var(--text-muted)' }}>
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// ============================================================
// 场景对比（全宽视图）
// ============================================================
function CompareModeFull({ scenarios, setScenarios, result }: {
  scenarios: { label: string; params: Record<string, number | string> }[];
  setScenarios: (s: { label: string; params: Record<string, number | string> }[]) => void;
  result: any;
}) {
  const update = (i: number, field: 'label' | string, value: string) => {
    setScenarios(scenarios.map((s, idx) => {
      if (idx !== i) return s;
      if (field === 'label') return { ...s, label: value };
      return { ...s, params: { ...s.params, [field]: parseFloat(value) || 0 } };
    }));
  };
  const add = () => setScenarios([...scenarios, { label: `场景 ${scenarios.length + 1}`, params: applyPreset('slopeFs', 'standard') }]);
  const remove = (i: number) => setScenarios(scenarios.filter((_, idx) => idx !== i));
  const setPreset = (i: number, p: PresetName) => {
    setScenarios(scenarios.map((s, idx) => idx === i ? { ...s, params: applyPreset('slopeFs', p) } : s));
  };

  return (
    <>
      <Card title="场景对比（统一用 slopeFs）" icon={<GitCompare size={13} />} hint={`${scenarios.length} 个场景自动对比`}>
        <div className="space-y-3">
          {scenarios.map((sc, i) => (
            <div key={i} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-base)' }}>
              <div className="flex items-center gap-2 mb-2">
                <input
                  value={sc.label}
                  onChange={e => update(i, 'label', e.target.value)}
                  className="text-sm font-semibold flex-1 px-2 py-1 rounded outline-none border"
                  style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                />
                <select
                  onChange={e => setPreset(i, e.target.value as PresetName)}
                  className="text-[10px] px-2 py-1 rounded border font-mono"
                  style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                >
                  <option value="conservative">保守</option>
                  <option value="standard" selected>标准</option>
                  <option value="aggressive">激进</option>
                </select>
                {scenarios.length > 2 && (
                  <button onClick={() => remove(i)} className="text-[10px] px-1.5 py-1 rounded" style={{ color: '#dc2626' }}>删除</button>
                )}
              </div>
              <div className="grid grid-cols-5 gap-2">
                {Object.entries(sc.params).map(([k, v]) => (
                  <div key={k}>
                    <div className="text-[9px] font-mono mb-0.5" style={{ color: 'var(--text-muted)' }}>{k}</div>
                    <input
                      type="number" value={typeof v === 'number' ? v : 0}
                      onChange={e => update(i, k, e.target.value)} step="any"
                      className="w-full text-[11px] px-1.5 py-1 rounded outline-none border font-mono"
                      style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <button onClick={add} className="text-xs px-3 py-1.5 rounded border mt-3" style={{ borderColor: 'var(--border)', color: 'var(--primary)' }}>
          + 添加场景
        </button>
      </Card>
      {result && (
        <Card title="对比结果" icon={<Sparkles size={13} />}>
          <div className="space-y-2">
            {result.map((r: any, i: number) => {
              const max = Math.max(...result.map((x: any) => x.value || 0), 0);
              const pct = max > 0 ? (r.value / max) * 100 : 0;
              const color = GRADE_COLOR[r.grade as string] ?? 'var(--text-secondary)';
              return (
                <div key={i} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-base)' }}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{r.label}</span>
                    <span className="text-base font-mono font-bold" style={{ color }}>{r.value?.toFixed(2)} {r.unit}</span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg-elevated)' }}>
                    <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </>
  );
}

// ============================================================
// 蒙特卡洛（全宽视图）
// ============================================================
function MonteCarloFull({ params, setParams, preset, result }: {
  params: { param: string; std: number }[];
  setParams: (p: { param: string; std: number }[]) => void;
  preset: PresetName;
  result: any;
}) {
  const add = () => setParams([...params, { param: 'beta', std: 1 }]);
  const remove = (i: number) => setParams(params.filter((_, idx) => idx !== i));
  const update = (i: number, field: 'param' | 'std', value: string) => {
    setParams(params.map((p, idx) => idx === i ? { ...p, [field]: field === 'param' ? value : (parseFloat(value) || 0) } : p));
  };
  return (
    <>
      <Card title="蒙特卡洛风险评估" icon={<Activity size={13} />} hint={`预设：${PRESET_LABELS[preset].name} · 阈值 Fs<1.30`}>
        <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
          给输入参数加正态扰动，模拟 500 次，看 Fs 分布与失败概率。
        </p>
        <div className="space-y-2">
          {params.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <select value={p.param} onChange={e => update(i, 'param', e.target.value)}
                      className="text-xs px-2 py-1 rounded border font-mono"
                      style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}>
                {['H', 'beta', 'gamma', 'c', 'phi'].map(k => <option key={k} value={k}>{k}</option>)}
              </select>
              <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>σ =</span>
              <input type="number" value={p.std} step="any" min="0"
                     onChange={e => update(i, 'std', e.target.value)}
                     className="w-24 text-xs px-2 py-1 rounded outline-none border font-mono"
                     style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-primary)' }} />
              {params.length > 1 && (
                <button onClick={() => remove(i)} className="text-[10px] px-1.5 py-1 rounded" style={{ color: '#dc2626' }}>×</button>
              )}
            </div>
          ))}
        </div>
        <button onClick={add} className="text-[10px] px-2 py-1 rounded border mt-2" style={{ borderColor: 'var(--border)', color: 'var(--primary)' }}>
          + 添加扰动参数
        </button>
      </Card>
      {result && (
        <Card title={`Fs 分布（${result.iterations} 次）`} icon={<Sparkles size={13} />}>
          <HistogramChart samples={result.samples} bins={28} threshold={{ value: 1.30, op: '<', color: '#dc2626' }} height={200} />
          <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
            <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>失败概率 P(Fs &lt; 1.30)</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold font-mono" style={{ color: result.failProb > 0.1 ? '#dc2626' : result.failProb > 0.01 ? '#ea580c' : '#16a34a' }}>
                {(result.failProb * 100).toFixed(1)}%
              </span>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {result.failProb > 0.1 ? '⚠ 高风险，建议加固' : result.failProb > 0.01 ? '注意' : '✓ 满足规范'}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-2 text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
              <div>μ {result.mean.toFixed(2)}</div>
              <div>P5 {result.p5.toFixed(2)}</div>
              <div>P50 {result.p50.toFixed(2)}</div>
              <div>P95 {result.p95.toFixed(2)}</div>
            </div>
          </div>
        </Card>
      )}
    </>
  );
}

// ============================================================
// 成本估算（全宽视图）
// ============================================================
function CostFull({ inputs, setInputs, result }: {
  inputs: { capacityM3: number; leachateM3PerYear: number; monitorWells: number };
  setInputs: (i: { capacityM3: number; leachateM3PerYear: number; monitorWells: number }) => void;
  result: { labor: number; energy: number; chemical: number; monitor: number; total: number };
}) {
  const max = Math.max(result.labor, result.energy, result.chemical, result.monitor, 1);
  const items = [
    { label: '人工', value: result.labor, color: '#0ea5b7' },
    { label: '能耗', value: result.energy, color: '#0891b2' },
    { label: '药剂', value: result.chemical, color: '#7c3aed' },
    { label: '检测', value: result.monitor, color: '#ea580c' },
  ];
  return (
    <Card title="运营成本估算（万元/年）" icon={<TrendingUp size={13} />}>
      <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
        简单经验模型：人工 / 能耗 / 药剂 / 检测 4 大类。输入库容、年渗滤液量、监测井数。
      </p>
      <div className="space-y-3 mb-4">
        <CostField label="总库容" unit="m³" value={inputs.capacityM3} onChange={v => setInputs({ ...inputs, capacityM3: v })} />
        <CostField label="年渗滤液产生量" unit="m³/a" value={inputs.leachateM3PerYear} onChange={v => setInputs({ ...inputs, leachateM3PerYear: v })} />
        <CostField label="监测井数量" unit="口" value={inputs.monitorWells} step="1" onChange={v => setInputs({ ...inputs, monitorWells: v })} />
      </div>
      <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-base)' }}>
        <div className="text-3xl font-bold font-mono" style={{ color: 'var(--primary)' }}>
          {result.total.toFixed(1)} <span className="text-sm font-normal" style={{ color: 'var(--text-muted)' }}>万元/年</span>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {items.map(it => (
          <div key={it.label}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span style={{ color: 'var(--text-secondary)' }}>{it.label}</span>
              <span className="font-mono font-semibold" style={{ color: it.color }}>{it.value.toFixed(1)} 万 ({((it.value / result.total) * 100).toFixed(0)}%)</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg-elevated)' }}>
              <div className="h-full rounded-full" style={{ width: `${(it.value / max) * 100}%`, backgroundColor: it.color }} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function CostField({ label, unit, value, onChange, step }: { label: string; unit: string; value: number; onChange: (v: number) => void; step?: string }) {
  return (
    <div>
      <label className="flex items-center justify-between mb-1">
        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{label}</span>
        <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{unit}</span>
      </label>
      <input type="number" value={value} step={step || "any"} min="0"
             onChange={e => onChange(parseFloat(e.target.value) || 0)}
             className="w-full text-sm px-3 py-1.5 rounded outline-none border font-mono"
             style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border)', color: 'var(--text-primary)' }} />
    </div>
  );
}
