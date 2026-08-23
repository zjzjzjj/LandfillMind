/**
 * 填埋场专业工程计算模块
 * 基于郑总知识库的专业参数
 */

// 物理常数
const GAMMA_WATER = 10; // kN/m³ 水重度
const GAMMA_WASTE = 12; // kN/m³ 垃圾重度（典型值）
const PHI_WASTE = 25; // ° 垃圾内摩擦角（典型值）
const C_WASTE = 5; // kPa 垃圾粘聚力（典型值）

/**
 * 稳定安全系数计算（简化瑞典条分法）
 * Fs = (抗滑力) / (滑动力)
 */
export function calculateStabilityFactor(
  height: number,      // 堆体高度 m
  slopeAngle: number,  // 坡角 °
  waterLevelDepth: number, // 水位埋深 m（从坡顶算起）
  gamma: number = GAMMA_WASTE, // 垃圾重度
  phi: number = PHI_WASTE,     // 内摩擦角
  c: number = C_WASTE          // 粘聚力
): {
  Fs: number;
  riskLevel: 'red' | 'orange' | 'yellow' | 'blue';
  analysis: string;
} {
  // 简化计算：考虑水位影响的稳定系数
  // 水位以下重度增加（考虑浮力）
  const aboveWaterRatio = Math.max(0, (height - waterLevelDepth)) / height;
  const effectiveGamma = GAMMA_WATER * aboveWaterRatio + gamma * (1 - aboveWaterRatio);

  // 简化安全系数公式（基于极限平衡）
  const tanPhi = Math.tan(phi * Math.PI / 180);
  const alpha = slopeAngle * Math.PI / 180; // 坡角弧度

  // 简化计算：Fs = (c + gamma * h * cos²α * tanφ) / (gamma * h * sinα * cosα)
  const h = height;
  const cosAlpha = Math.cos(alpha);
  const sinAlpha = Math.sin(alpha);

  const driving = gamma * h * sinAlpha * cosAlpha;
  const resisting = c + effectiveGamma * h * cosAlpha * cosAlpha * tanPhi;

  const Fs = driving > 0 ? resisting / driving : 999;

  let riskLevel: 'red' | 'orange' | 'yellow' | 'blue';
  let analysis: string;

  if (Fs < 1.0) {
    riskLevel = 'red';
    analysis = `失稳风险高。安全系数${Fs.toFixed(2)}<1.0，滑动力大于抗滑力，需立即采取降水、减载或支护措施。`;
  } else if (Fs < 1.2) {
    riskLevel = 'orange';
    analysis = `稳定风险较大。安全系数${Fs.toFixed(2)}低于常规控制值1.2，建议加强排水、降低水位或放缓边坡。`;
  } else if (Fs < 1.5) {
    riskLevel = 'yellow';
    analysis = `基本稳定。安全系数${Fs.toFixed(2)}在1.2-1.5范围，需常规监测。`;
  } else {
    riskLevel = 'blue';
    analysis = `较安全。安全系数${Fs.toFixed(2)}≥1.5，满足规范要求。`;
  }

  return { Fs: Math.round(Fs * 100) / 100, riskLevel, analysis };
}

/**
 * 有效影响半径计算
 * 基于注气驱水现场试验数据
 * R_eff = f(注气压力, 处理时间, 垃圾渗透性)
 */
export function calculateEffectiveRadius(
  injectionPressure: number, // kPa
  treatmentDays: number,    // 天
  permeability: 'high' | 'medium' | 'low' = 'medium' // 渗透性
): {
  R_eff: number;
  recommendedSpacing: number;
  analysis: string;
} {
  // 基础影响半径（基于海南现场试验数据）
  // 注气压力2-4kPa时，有效影响半径约5-8m
  const baseRadius = 5 + (injectionPressure - 2) * 1.5;

  // 渗透性修正
  const permFactor = permeability === 'high' ? 1.3 : permeability === 'low' ? 0.7 : 1.0;

  // 时间修正（边际递减，7天后基本稳定）
  const timeFactor = Math.min(1.5, 1 + (treatmentDays - 1) * 0.08);

  const R_eff = baseRadius * permFactor * timeFactor;

  // 井间距：D = √3 * R_eff（梅花形）
  const recommendedSpacing = Math.sqrt(3) * R_eff;

  let analysis = '';
  if (injectionPressure < 2) {
    analysis = `注气压力${injectionPressure}kPa低于有效驱替下限(2kPa)，影响半径可能显著减小。`;
  } else if (injectionPressure > 8) {
    analysis = `注气压力${injectionPressure}kPa超过安全上限(8kPa)，可能导致堆体隆起。`;
  } else {
    analysis = `基于注气压力${injectionPressure}kPa、处理${treatmentDays}天、${permeability}渗透性条件估算。`;
  }

  return {
    R_eff: Math.round(R_eff * 10) / 10,
    recommendedSpacing: Math.round(recommendedSpacing * 10) / 10,
    analysis: `有效影响半径约${R_eff.toFixed(1)}m，梅花形布井推荐间距${recommendedSpacing.toFixed(1)}m。` + analysis
  };
}

/**
 * 渗滤液产量估算
 * Q = C * A * I（经验公式）
 */
export function calculateLeachate(
  area: number,          // 填埋面积 m²
  rainfall: number,      // 年降雨量 mm
  runoffCoeff: number = 0.3, // 径流系数
  wasteHeight: number = 0   // 垃圾高度 m（有垃圾覆盖时渗滤液减少）
): {
  daily: number;      // m³/d
  monthly: number;    // m³/月
  yearly: number;     // m³/年
  analysis: string;
} {
  // 有效降雨量
  const effectiveRainfall = rainfall * runoffCoeff;

  // 垃圾覆盖减少渗滤液（每米垃圾减少约20%）
  const wasteFactor = wasteHeight > 0 ? Math.max(0.3, 1 - wasteHeight * 0.05) : 1;

  // 年产量 m³/年 —— 量纲修正：Q(m³)=面积(m²)×有效降雨量(mm)/1000；原 (area/1000000) 约偏小千倍
  const yearly = (area * effectiveRainfall) / 1000 * wasteFactor;

  const daily = yearly / 365;
  const monthly = yearly / 12;

  let analysis = `面积${area}万㎡、年降雨量${rainfall}mm条件下，`;
  if (wasteHeight > 0) {
    analysis += `垃圾覆盖厚度${wasteHeight}m使渗滤液产生减少约${((1 - wasteFactor) * 100).toFixed(0)}%，`;
  }
  analysis += `估算日产渗滤液约${daily.toFixed(1)}m³，月产${monthly.toFixed(0)}m³，年产${yearly.toFixed(0)}m³。`;

  return {
    daily: Math.round(daily * 10) / 10,
    monthly: Math.round(monthly),
    yearly: Math.round(yearly),
    analysis
  };
}

/**
 * 含水率预测（基于注气驱水试验数据）
 * 简化模型：含水率随处理时间指数衰减
 */
export function predictMoisture(
  initialMoisture: number, // 初始含水率 %
  injectionPressure: number, // kPa
  days: number,            // 处理天数
  depth: number            // 处理深度 m
): {
  predictedMoisture: number; // 预测含水率 %
  targetAchieved: boolean;
  analysis: string;
} {
  // 基于浙大大尺度模型试验数据
  // 10kPa注气后体积含水率62%→41%（第1天）
  // 20kPa注气后体积含水率62%→27%（第3天）

  // 转换：体积含水率 ≈ 质量含水率 * 1.5（典型垃圾容重比）
  const initialVolumeMoisture = initialMoisture * 1.5;

  // 压力衰减系数（深层压力衰减快）
  const pressureDecay = Math.max(0.3, 1 - depth * 0.08);

  // 注气效率
  const efficiency = injectionPressure * pressureDecay * 0.05;

  // 指数衰减模型
  const decayRate = 0.3 + efficiency;
  const predictedVolumeMoisture = initialVolumeMoisture * Math.exp(-decayRate * days);

  // 转回质量含水率
  const predictedMoisture = predictedVolumeMoisture / 1.5;

  const targetAchieved = predictedMoisture <= 30;
  const targetPercent = ((initialMoisture - predictedMoisture) / (initialMoisture - 30) * 100);

  let analysis = `初始含水率${initialMoisture}%、注气压力${injectionPressure}kPa、深度${depth}m条件下，`;
  if (targetAchieved) {
    analysis += `处理${days}天后预计含水率降至${predictedMoisture.toFixed(1)}%，已达到高效筛分阈值(≤30%)。`;
  } else {
    analysis += `处理${days}天后预计含水率${predictedMoisture.toFixed(1)}%，仍未达到目标(≤30%)，建议延长处理时间或增加注气压力。`;
  }

  return {
    predictedMoisture: Math.round(predictedMoisture * 10) / 10,
    targetAchieved,
    analysis
  };
}

/**
 * 产气量估算（简化）
 * 基于垃圾降解模型
 */
export function calculateGasProduction(
  wasteAmount: number,  // 万吨
  wasteAge: number,     // 年
  moisture: number       // 含水率 %
): {
  ch4: number;      // m³/d CH4
  co2: number;      // m³/d CO2
  total: number;    // m³/d 总气量
  analysis: string;
} {
  // 产气模型参数（简化）
  const potentialGas = 100; // m³/吨垃圾（潜在产气量）

  // 降解速率（与龄期、含水率相关）
  const k = 0.1 * (moisture / 50) * Math.exp(-wasteAge * 0.05);

  // 当前产气速率
  const rate = potentialGas * k;

  // 总产气量
  const total = wasteAmount * 10000 * rate;

  // CH4:CO2 ≈ 1:1.2（典型填埋气组成）
  const ch4 = total / 2.2;
  const co2 = total - ch4;

  const Qd = total / 365;
  let analysis = `垃圾量${wasteAmount}万吨、龄期${wasteAge}年、含水率${moisture}%条件下，`;
  analysis += `年产填埋气约 ${total.toFixed(0)} m³（日均约 ${Qd.toFixed(0)} m³），其中CH₄约${ch4.toFixed(0)}m³、CO₂约${co2.toFixed(0)}m³。`;

  return {
    ch4: Math.round(ch4),
    co2: Math.round(co2),
    total: Math.round(total),
    analysis
  };
}

/**
 * 井间距优化计算
 * 基于有效影响半径和布井方式
 */
export function optimizeWellSpacing(
  effectiveRadius: number, // m
  pattern: 'square' | 'hexagonal' = 'hexagonal' // 布井方式
): {
  spacing: number;
  wellsPerArea: number; // 口/万㎡
  analysis: string;
} {
  let spacing: number;
  let wellsPerArea: number;

  if (pattern === 'hexagonal') {
    // 梅花形/六角形：D = √3 * R
    spacing = Math.sqrt(3) * effectiveRadius;
    // 每万㎡井数 = 10000 / (spacing² * 0.866)
    wellsPerArea = 10000 / (spacing * spacing * 0.866);
  } else {
    // 方形：D = 2 * R
    spacing = 2 * effectiveRadius;
    wellsPerArea = 10000 / (spacing * spacing);
  }

  const efficiency = pattern === 'hexagonal' ? 1.4 : 1.0;

  const analysis = `${pattern === 'hexagonal' ? '梅花形' : '方形'}布井，`;

  return {
    spacing: Math.round(spacing * 10) / 10,
    wellsPerArea: Math.round(wellsPerArea * 10) / 10,
    analysis: analysis + `有效影响半径${effectiveRadius}m时，推荐间距${spacing.toFixed(1)}m，每万㎡约需${wellsPerArea.toFixed(1)}口井。六角形布井比方形效率高约${((efficiency - 1) * 100).toFixed(0)}%。`
  };
}

/**
 * 抽气负压计算
 * 保持系统微负压
 */
export function calculateExtractionPressure(
  injectionPressure: number // kPa
): {
  extraction: number; // kPa（负压）
  ratio: number;
  analysis: string;
} {
  // 抽气负压 = 注气压力 × 0.6~0.8
  const ratio = 0.7;
  const extraction = -injectionPressure * ratio;

  return {
    extraction: Math.round(extraction * 10) / 10,
    ratio,
    analysis: `注气压力${injectionPressure}kPa时，推荐抽气负压${extraction.toFixed(1)}kPa（比例${(ratio * 100).toFixed(0)}%），可保持系统微负压，防止气体外逸。`
  };
}

/* ================================================================
 * 以下函数为 v7 的 12 项计算器向 LandfillMind 迁移版（2026-08）
 * 与 KB.m6 / m62 中的 calc 字段一一对应，可被 Agent 工具调用
 * ================================================================ */

/** 统一返回类型：每项计算都给出值 + 单位 + 风险等级 + 文字说明 + 规范引用 */
export interface CalcResult {
  ok: boolean;
  value: number | string;
  unit?: string;
  grade: 'red' | 'orange' | 'yellow' | 'blue' | 'green';
  analysis: string;
  ref?: string;
  /** 规范公式（用于计算书"计算公式"章节） */
  formula?: string;
}

/**
 * C-08. 循环井影响半径（wellR）
 * R≈√(Q·t/(π·ne·Δh))
 * 依据：HJ 25.6-2019 / 工程经验
 */
export function wellR(Q: number, t: number, ne: number, dh: number): CalcResult {
  if (Q <= 0 || t <= 0 || ne <= 0 || dh <= 0) {
    return { ok: false, value: NaN, grade: 'red', analysis: '输入参数须为正数', ref: 'HJ 25.6-2019' };
  }
  const R = Math.sqrt((Q * t) / (Math.PI * ne * dh));
  return {
    ok: true,
    value: Math.round(R * 10) / 10,
    unit: 'm',
    grade: 'green',
    analysis: `输入：Q=${Q}m³/d, t=${t}d, ne=${ne}, Δh=${dh}m；R≈√(Q·t/(π·ne·Δh))=${R.toFixed(1)} m。须抽水试验验证。`,
    ref: 'HJ 25.6-2019',
  };
}

/**
 * C-09. 污染物对流—弥散浓度（advect）
 * C(x)=C0·exp(−v·x/D)
 * 依据：HJ 25.6-2019 / 水文地质
 */
export function advect(C0: number, v: number, x: number, D: number): CalcResult {
  if (C0 < 0 || D <= 0) {
    return { ok: false, value: NaN, grade: 'red', analysis: '源浓度须 ≥0；弥散系数须 >0', ref: 'HJ 25.6-2019' };
  }
  const C = C0 * Math.exp((-v * x) / D);
  return {
    ok: true,
    value: Math.round(C * 1000) / 1000,
    unit: 'mg/L',
    grade: 'green',
    analysis: `输入：C0=${C0}, v=${v}m/d, x=${x}m, D=${D}m²/d；C=C0·exp(−v·x/D)=${C.toFixed(3)} mg/L（下游 ${x}m 处浓度）。`,
    ref: 'HJ 25.6-2019',
  };
}

/**
 * C-10. 土壤筛选值/管制值查询（soilScreen）
 * 依据：GB 36600-2018 表 1
 */
export function soilScreen(
  pol: string,
  cls: '一类(居住/学校)' | '二类(工业/商业)'
): CalcResult {
  const T: Record<string, Record<string, [number, number]>> = {
    '砷': { '一类(居住/学校)': [20, 120], '二类(工业/商业)': [60, 140] },
    '镉': { '一类(居住/学校)': [20, 47], '二类(工业/商业)': [65, 172] },
    '铅': { '一类(居住/学校)': [400, 800], '二类(工业/商业)': [800, 2500] },
    '汞': { '一类(居住/学校)': [8, 33], '二类(工业/商业)': [38, 82] },
    '镍': { '一类(居住/学校)': [150, 600], '二类(工业/商业)': [900, 2000] },
    '苯': { '一类(居住/学校)': [1.0, 10], '二类(工业/商业)': [4.0, 40] },
    '铬(六价)': { '一类(居住/学校)': [3.0, 30], '二类(工业/商业)': [5.7, 78] },
  };
  const row = T[pol];
  if (!row) return { ok: false, value: '未知污染物', grade: 'red', analysis: `未收录 ${pol} 的 GB 36600 限值`, ref: 'GB 36600-2018 表1' };
  const [sv, gv] = row[cls];
  return {
    ok: true,
    value: `筛选值 ${sv} mg/kg · 管制值 ${gv} mg/kg`,
    grade: 'green',
    analysis: `污染物：${pol}；用地类型：${cls}；筛选值 = ${sv} mg/kg；管制值 = ${gv} mg/kg。判定：检出 < 筛选值 → 一般可接受；筛选值 < 检出 < 管制值 → 须风险评估(HJ 25.2)；检出 > 管制值 → 须修复(HJ 25.3)并经监测(HJ 25.4)。`,
    ref: 'GB 36600-2018 表1',
  };
}

/**
 * C-11. 污染物衰减半衰期与达标年限（decayCalc）
 * C(t)=C0·exp(−t·ln2/t½)；T=ln(C0/Ct)·t½/ln2
 * 依据：HJ 25.6-2019 / 一级衰减动力学
 */
export function decayCalc(C0: number, Ctarget: number, t12 = 1000): CalcResult {
  if (C0 <= 0 || Ctarget <= 0 || t12 <= 0) {
    return { ok: false, value: NaN, grade: 'red', analysis: '输入参数须为正数', ref: 'HJ 25.6-2019' };
  }
  if (Ctarget > C0) {
    return { ok: false, value: 0, unit: 'a', grade: 'green', analysis: '目标浓度高于当前浓度，无衰减需求', ref: 'HJ 25.6-2019' };
  }
  const lam = Math.log(2) / t12;
  const T = Math.log(C0 / Ctarget) / lam; // days
  const Ty = T / 365.25;
  return {
    ok: true,
    value: Math.round(Ty * 10) / 10,
    unit: 'a',
    grade: Ty > 30 ? 'orange' : 'yellow',
    analysis: `输入：C0=${C0}mg/L, 目标 Ct=${Ctarget}mg/L, t½=${t12}d；λ=ln2/t½=${lam.toExponential(3)} d⁻¹；T=ln(C0/Ct)/λ=${T.toFixed(0)}d ≈ ${Ty.toFixed(1)}a。仅一级衰减近似，实际须计入弥散/吸附/源区释放并持续 LTM 监测。`,
    ref: 'HJ 25.6-2019',
  };
}

/**
 * C-12. 复合衬垫等效渗透系数验算（linerKeq）
 * k_eq = d_total² / (d₂²/k₂ + d₁·d₂·θ/k₁)；k_eq ≤ 1×10⁻⁹ cm/s
 * 依据：GB 16889-2008 §5.1 / USEPA EPIC
 */
export function linerKeq(
  d1: number, k1: number, d2: number, k2: number, theta: number
): CalcResult {
  if (d1 <= 0 || d2 <= 0 || k1 <= 0 || k2 <= 0 || theta < 0) {
    return { ok: false, value: NaN, grade: 'red', analysis: '输入参数须为正数', ref: 'GB 16889-2008 §5.1' };
  }
  const dt = d1 + d2;
  const k_eq = (dt * dt) / ((d2 * d2) / k2 + (d1 * d2 * theta) / k1);
  const ok = k_eq <= 1e-9;
  return {
    ok,
    value: k_eq,
    unit: 'cm/s',
    grade: ok ? 'green' : 'red',
    analysis: `HDPE d1=${d1}mm k1=${k1.toExponential(2)}；GCL d2=${d2}mm k2=${k2.toExponential(2)}；缺陷率 θ=${theta}。k_eq = ${k_eq.toExponential(3)} cm/s。GB 16889 §5.1 要求 k_eq ≤ 1×10⁻⁹ cm/s；${ok ? '满足 ✓' : '不满足，需增加 GCL 厚度或选用更高 k₁ 的 HDPE ✗'}。`,
    ref: 'GB 16889-2008 §5.1',
  };
}

/**
 * C-13. HDPE 膜厚度与焊缝验算（hdpeCheck）
 * D ≥ 1.5mm；σ ≥ 27MPa；ε ≥ 700%；焊缝气压 0.2MPa 持 5min 压降<10%
 * 依据：GB/T 17643-2011 / GB 16889-2008 §5.1 / CJJ/T 234
 */
export function hdpeCheck(D: number, sigma: number, eps: number, P = 0.2, hold = 5): CalcResult {
  // eps 单位兼容：业内默认百分数（700%），但表单可能输入小数（2 → 200%）。< 100 视为小数
  const epsPct = eps < 100 ? eps * 100 : eps;
  const tD = D >= 1.5;
  const tSig = sigma >= 27;
  const tEps = epsPct >= 700;
  const ok = tD && tSig && tEps;
  return {
    ok,
    value: `D=${D}mm, σ=${sigma}MPa, ε=${epsPct.toFixed(0)}%`,
    grade: ok ? 'green' : 'red',
    analysis: `① D≥1.5mm：${tD ? '✓' : '✗'}；② σ≥27MPa：${tSig ? '✓' : '✗'}；③ ε≥700%：${tEps ? '✓' : '✗'}；④ 焊缝气压试验：${P}MPa 持压 ${hold}min（实际压降<10%为合格）。${ok ? '全部满足 GB/T 17643 GH-2 + GB 16889 §5.1 ✓' : '不满足，需更换材料或加厚 ✗'}`,
    ref: 'GB/T 17643-2011 / GB 16889-2008 §5.1',
  };
}

/**
 * C-14. 沉降预测——双曲线法（settlementHyper）
 * s(t)=s∞·t/(a+t)；用两组 (t,s) 解联立得 s∞ 与 a
 * 依据：CJJ 176-2012 §4.6 / 工程经验（双曲线法）
 */
export function settlementHyper(t1: number, s1: number, t2: number, s2: number): CalcResult {
  if (t1 <= 0 || t2 <= t1 || s1 < 0 || s2 < s1) {
    return { ok: false, value: NaN, grade: 'red', analysis: 't2 须 ≥ t1，s2 须 ≥ s1；输入须为正数', ref: 'CJJ 176-2012 §4.6' };
  }
  const s_inf = (t2 * s2 - t1 * s1) / (t2 - t1);
  const a = s_inf > s1 ? (t1 * s1) / (s_inf - s1) : t1;
  const s5 = (s_inf * 5 * 365) / (a + 5 * 365);
  const s10 = (s_inf * 10 * 365) / (a + 10 * 365);
  const s30 = (s_inf * 30 * 365) / (a + 30 * 365);
  return {
    ok: s_inf > 0,
    value: Math.round(s_inf),
    unit: 'mm',
    grade: 'green',
    analysis: `(t1=${t1}d, s1=${s1}mm) 与 (t2=${t2}d, s2=${s2}mm)；双曲线 s(t)=s∞·t/(a+t)；s∞ = (t2·s2 − t1·s1)/(t2−t1) = ${s_inf.toFixed(0)} mm（≈堆高 25~40%）；a = ${a.toFixed(0)} d；预测：5年 ≈ ${s5.toFixed(0)} mm；10年 ≈ ${s10.toFixed(0)} mm；30年 ≈ ${s30.toFixed(0)} mm。`,
    ref: 'CJJ 176-2012 §4.6',
  };
}

/**
 * C-15. 库容与使用年限（capacity）
 * V = A·H·10000 (m³)；W = V·ρ (t)；T = W / (Q_d·365)
 * 依据：CJJ 176-2012 §3.3 / CJJ 133-2004
 */
export function capacity(A: number, H: number, rho: number, Qd: number): CalcResult {
  if (A <= 0 || H <= 0 || rho <= 0 || Qd <= 0) {
    return { ok: false, value: NaN, grade: 'red', analysis: '输入参数须为正数', ref: 'CJJ 176-2012 §3.3' };
  }
  const V = A * 10000 * H;
  const W = V * rho;
  const T = W / (Qd * 365);
  const meetsStandard = rho >= 0.9;
  return {
    ok: meetsStandard,
    value: Math.round(T * 10) / 10,
    unit: 'a',
    grade: meetsStandard ? 'green' : 'yellow',
    analysis: `A=${A}ha, H=${H}m, ρ=${rho}t/m³, Qd=${Qd}t/d。① 总库容 V = ${V.toFixed(0)} m³；② 总容重 W = ${W.toFixed(0)} t；③ 使用年限 T = ${T.toFixed(1)} 年。${meetsStandard ? '满足' : '不满足'} CJJ 176 §3.3 卫生填埋压实密度 ρ≥0.9 t/m³ 要求。`,
    ref: 'CJJ 176-2012 §3.3',
  };
}

/**
 * C-16. 注气驱替半径（经验式）（injectR）
 * r≈k·√(P_inj·t/μ)
 * 依据：CJJ 176-2012 §5.2 / 研究经验
 */
export function injectR(Pinj: number, t: number, mu = 1.0, k = 1.0): CalcResult {
  if (Pinj <= 0 || t <= 0) {
    return { ok: false, value: NaN, grade: 'red', analysis: 'P_inj 与 t 须为正数', ref: 'CJJ 176-2012 §5.2' };
  }
  const r = k * Math.sqrt((Pinj * t) / mu);
  return {
    ok: true,
    value: Math.round(r * 10) / 10,
    unit: 'm',
    grade: 'yellow',
    analysis: `P_inj=${Pinj}kPa, t=${t}h, μ=${mu}, k=${k}。r≈k·√(P_inj·t/μ)=${r.toFixed(1)} m。属研究经验式，系数 k 须以 CH₄ 监测优化。`,
    ref: 'CJJ 176-2012 §5.2',
  };
}

/**
 * C-17. 填埋气产气量 LandGEM 简化（lfgYield）
 * Q(t) = k·L₀·M·exp(−k·t)
 * 依据：USEPA LandGEM / 工程经验
 */
export function lfgYield(M: number, k: number, year: number, Lo = 170): CalcResult {
  if (M <= 0 || k <= 0 || year < 0) {
    return { ok: false, value: NaN, grade: 'red', analysis: '输入参数须为正数', ref: 'USEPA LandGEM' };
  }
  const Mt = M * 1e4; // 万吨→吨
  const Q = k * Lo * Mt * Math.exp(-k * year); // m³/年 CH₄
  const Qd = Q / 365;
  const MWh = (Q * 9.97 / 1e6) * 0.4; // 9.97 kWh/m³ CH₄ × 40% 效率
  return {
    ok: true,
    value: Math.round(Qd),
    unit: 'm³/d',
    grade: 'green',
    analysis: `M=${M}万吨, k=${k}/年, t=${year}年, L₀=${Lo}m³/t。LandGEM 一阶衰减：Q(t) = k·L₀·M·exp(−k·t) = ${Q.toFixed(0)} m³ CH₄/年；日均 ${Qd.toFixed(0)} m³/d；发电潜力（40%效率）≈ ${MWh.toFixed(1)} MW。爆炸极限 5~15% 须实时监测。`,
    ref: 'USEPA LandGEM',
  };
}

export default {
  calculateStabilityFactor,
  calculateEffectiveRadius,
  calculateLeachate,
  predictMoisture,
  calculateGasProduction,
  optimizeWellSpacing,
  calculateExtractionPressure,
  // v7 迁移版（12 项，含别名兼容）
  wellR,
  advect,
  soilScreen,
  decayCalc,
  linerKeq,
  hdpeCheck,
  settlementHyper,
  capacity,
  injectR,
  lfgYield,
};

// ============================================================
// v4.3 新增：敏感性分析 + 蒙特卡洛风险评估（Design Center 用）
// ============================================================

/**
 * 一维敏感性分析
 * 固定其他参数，沿 varyParam 在 [lo, hi] 区间取 n 个点，调用指定计算器，返回结果序列。
 *
 * - 用于前端画 Fs vs H、leachate vs 降雨量 等曲线
 * - 若不传 range，默认在 baseParams[varyParam] ± 50% 范围（且 ≥ 0）
 * - 计算器名与 CALC_REGISTRY 对齐（index.ts 中注册的 key）
 */
export function sensitivity1D(
  calcName: string,
  baseParams: Record<string, number>,
  varyParam: string,
  n: number = 20,
  range?: [number, number]
): { xs: number[]; ys: number[]; baseValue: number; baseX: number; param: string; unit?: string } {
  // 占位实现：等待 index.ts 注入真正的 CALC_REGISTRY；这里只导出契约。
  // 实际执行在 server/index.ts 的路由里完成（避免循环依赖）。
  return { xs: [], ys: [], baseValue: 0, baseX: 0, param: varyParam, unit: undefined };
}

/**
 * 蒙特卡洛风险评估（v4.3 新增）
 * 参数加正态扰动，统计结果分布。
 *
 * - paramDist: { paramName: { mean, std } } 哪些参数加扰动（用 N(mean, std²) 抽样）
 * - threshold: 失败条件（如 {op: '<', value: 1.30} 表示 Fs<1.30 判失败）
 * - iterations: 抽样次数（默认 500，0 维边界走 100）
 *
 * 返回：samples 全样本 + 统计量 + 失败概率。
 * 占位实现：实际执行在 index.ts 路由里完成（需要 CALC_REGISTRY）。
 */
export function monteCarloRisk(
  calcName: string,
  baseParams: Record<string, number>,
  paramDist: Record<string, { mean: number; std: number }>,
  threshold: { op: '<' | '<=' | '>' | '>='; value: number },
  iterations: number = 500
): {
  samples: number[];
  mean: number;
  p5: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  failProb: number;
  threshold: number;
  iterations: number;
} {
  return {
    samples: [], mean: 0, p5: 0, p50: 0, p95: 0, min: 0, max: 0,
    failProb: 0, threshold: threshold.value, iterations: 0,
  };
}

/**
 * Box-Muller 标准正态采样（用于蒙特卡洛）
 */
export function gaussian(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
