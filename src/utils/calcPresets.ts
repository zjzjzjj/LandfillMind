/**
 * 计算中心 3 套预设参数（保守 / 标准 / 激进）
 *
 * 用法：
 *   import { PRESETS, applyPreset } from '@/utils/calcPresets';
 *   const params = applyPreset('slopeFs', 'standard');
 *
 * 设计原则：
 *   - 保守：偏安全（Fos 高、流量低、间距密）
 *   - 标准：工程典型值
 *   - 激进：偏经济（Fos 接近规范下限、流量上限、间距稀）
 */
import type { CalcResult } from '../types';

export type PresetName = 'conservative' | 'standard' | 'aggressive';

export const PRESET_LABELS: Record<PresetName, { name: string; desc: string; color: string }> = {
  conservative: { name: '保守', desc: '偏安全、留大裕度', color: '#16a34a' },
  standard: { name: '标准', desc: '工程典型值', color: '#0ea5b7' },
  aggressive: { name: '激进', desc: '偏经济、接近规范下限', color: '#ea580c' },
};

/**
 * 每个计算器在 3 个预设下的参数集合。
 * 缺的字段会用计算器自己的 default 兜底。
 */
export const PRESETS: Record<string, Record<PresetName, Record<string, number | string>>> = {
  slopeFs: {
    conservative: { H: 20, beta: 4, gamma: 10, c: 8, phi: 30 },
    standard:     { H: 30, beta: 3, gamma: 10, c: 5, phi: 25 },
    aggressive:   { H: 45, beta: 2, gamma: 11, c: 3, phi: 20 },
  },
  capacity: {
    conservative: { A: 15, H: 25, rho: 11, Qd: 400 },
    standard:     { A: 10, H: 30, rho: 10, Qd: 500 },
    aggressive:   { A: 8,  H: 40, rho: 9,  Qd: 700 },
  },
  hdpeCheck: {
    conservative: { D: 2.0, sigma: 27, eps: 700, P: 0.2, hold: 5 },
    standard:     { D: 1.5, sigma: 27, eps: 700, P: 0.2, hold: 5 },
    aggressive:   { D: 1.5, sigma: 30, eps: 600, P: 0.25, hold: 3 },
  },
  wellR: {
    conservative: { Q: 50, t: 60, ne: 0.3, dh: 1.5 },
    standard:     { Q: 100, t: 30, ne: 0.3, dh: 2.0 },
    aggressive:   { Q: 200, t: 15, ne: 0.4, dh: 3.0 },
  },
  injectR: {
    conservative: { Pinj: 2, t: 48, mu: 1.2, k: 0.8 },
    standard:     { Pinj: 4, t: 24, mu: 1.0, k: 1.0 },
    aggressive:   { Pinj: 8, t: 12, mu: 0.8, k: 1.2 },
  },
  leachateCalc: {
    conservative: { area: 20, rainfall: 800,  runoffCoeff: 0.4, wasteHeight: 5 },
    standard:     { area: 30, rainfall: 1200, runoffCoeff: 0.3, wasteHeight: 0 },
    aggressive:   { area: 50, rainfall: 1800, runoffCoeff: 0.2, wasteHeight: 0 },
  },
  lfgYield: {
    conservative: { M: 300, k: 0.05, year: 5,  Lo: 170 },
    standard:     { M: 500, k: 0.1,  year: 10, Lo: 170 },
    aggressive:   { M: 800, k: 0.2,  year: 15, Lo: 170 },
  },
  advect: {
    conservative: { C0: 50,  v: 0.05, x: 30, D: 5 },
    standard:     { C0: 100, v: 0.1,  x: 50, D: 10 },
    aggressive:   { C0: 200, v: 0.2,  x: 80, D: 20 },
  },
  soilScreen: {
    conservative: { pol: '砷', cls: '一类(居住/学校)' },
    standard:     { pol: '砷', cls: '二类(工业/商业)' },
    aggressive:   { pol: '铬(六价)', cls: '二类(工业/商业)' },
  },
  decayCalc: {
    conservative: { C0: 200, Ctarget: 20, t12: 800 },
    standard:     { C0: 500, Ctarget: 50, t12: 1000 },
    aggressive:   { C0: 1000, Ctarget: 100, t12: 1500 },
  },
  linerKeq: {
    conservative: { d1: 2.0, k1: 1e-10, d2: 8, k2: 1e-12, theta: 0.05 },
    standard:     { d1: 1.5, k1: 1e-10, d2: 6, k2: 1e-11, theta: 0.1 },
    aggressive:   { d1: 1.5, k1: 1e-9,  d2: 5, k2: 1e-10, theta: 0.2 },
  },
  settlementHyper: {
    conservative: { t1: 30,  s1: 30,  t2: 180, s2: 120 },
    standard:     { t1: 30,  s1: 50,  t2: 180, s2: 200 },
    aggressive:   { t1: 30,  s1: 80,  t2: 180, s2: 300 },
  },
  optimizeWellSpacing: {
    conservative: { H: 20, Q: 50,  k: 5,  t: 60 },
    standard:     { H: 30, Q: 100, k: 10, t: 30 },
    aggressive:   { H: 40, Q: 200, k: 20, t: 15 },
  },
  moisturePredict: {
    conservative: { inflow: 50,  et: 80, runoff: 10, storageMax: 3000 },
    standard:     { inflow: 100, et: 50, runoff: 20, storageMax: 5000 },
    aggressive:   { inflow: 200, et: 20, runoff: 40, storageMax: 8000 },
  },
  extractionPressure: {
    conservative: { Q: 200, d: 0.15, L: 8,  permeability: 0.5 },
    standard:     { Q: 500, d: 0.20, L: 10, permeability: 1.0 },
    aggressive:   { Q: 800, d: 0.25, L: 15, permeability: 2.0 },
  },
};

/**
 * 取某个计算器在某预设下的参数
 */
export function applyPreset(calcId: string, preset: PresetName): Record<string, number | string> {
  return PRESETS[calcId]?.[preset] ?? {};
}

/**
 * 3 套预设的统一"敏感参数"分布（蒙特卡洛用）：
 *   哪些参数需要加扰动 + 标准差倍数
 */
export const PRESET_DIST_STD_RATIO: Record<PresetName, number> = {
  conservative: 0.05,  // 5% 标准差（窄分布）
  standard:     0.10,  // 10%
  aggressive:   0.15,  // 15%（宽分布）
};

/**
 * 取某个计算器的"建议变分参数"（用于敏感性分析默认 varyParam）
 *   - slopeFs → H（堆高最常变）
 *   - leachateCalc → rainfall（地区差异大）
 *   - 其他 → 第一个数值参数
 */
export function suggestVaryParam(calcId: string, currentParams: Record<string, number | string>): string {
  const priority: Record<string, string> = {
    slopeFs: 'H',
    capacity: 'H',
    leachateCalc: 'rainfall',
    lfgYield: 'year',
    advect: 'x',
    decayCalc: 't12',
    settlementHyper: 't2',
    wellR: 't',
    injectR: 'Pinj',
  };
  if (priority[calcId]) return priority[calcId];
  // 兜底：第一个数值参数
  for (const k of Object.keys(currentParams)) {
    if (typeof currentParams[k] === 'number') return k;
  }
  return '';
}

/**
 * 估算运营成本（万元/年）
 *   - 人工：30 万 × 库容万 m³
 *   - 能耗：库容 × 2 元/m³
 *   - 药剂：渗滤液量 × 30 元/m³
 *   - 检测：基础 50 万 + 监测井数 × 3 万
 */
export function estimateCost(input: {
  capacityM3: number;     // 库容 m³
  leachateM3PerYear: number; // 年渗滤液 m³
  monitorWells: number;  // 监测井数
}): { labor: number; energy: number; chemical: number; monitor: number; total: number } {
  const labor = 30 * (input.capacityM3 / 10000);
  const energy = input.capacityM3 * 2 / 10000; // → 万元
  const chemical = input.leachateM3PerYear * 30 / 10000;
  const monitor = 50 + input.monitorWells * 3;
  return {
    labor: Math.round(labor * 10) / 10,
    energy: Math.round(energy * 10) / 10,
    chemical: Math.round(chemical * 10) / 10,
    monitor: Math.round(monitor * 10) / 10,
    total: Math.round((labor + energy + chemical + monitor) * 10) / 10,
  };
}

export default PRESETS;
