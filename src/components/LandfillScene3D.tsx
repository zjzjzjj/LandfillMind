import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import * as THREE from 'three';
// 类型/常量/工具：从同目录 geo.ts 导入，避免拖入整个模块
import {
  DEFAULT_GEO, GEO_PRESETS, clampGeo, estimateSite,
  type GeoParams, type LandfillApi, type SiteEstimate,
} from './LandfillScene3D/geo';
import type { DiagnosisResult, RiskItem } from '../types';

// re-export 保持原导入路径兼容
export { DEFAULT_GEO, GEO_PRESETS, clampGeo, estimateSite };
export type { GeoParams, LandfillApi, SiteEstimate };

// 默认描述快照（用于初始 info 面板）
const DEFAULT_DESC = estimateSite(DEFAULT_GEO).desc;

/* ============================================================
 * 山谷型生活垃圾卫生填埋场 · 三维示意模型（React 组件）
 *
 * 由 standalone landfill-3d-model.html 移植，改用项目内 npm `three`
 * 打包（离线可用、与站点暗/亮主题解耦）。完整保留：
 *   - 12 个图层（地形/堆体/覆盖/防渗/渗滤液/填埋气/截洪沟/道路/建筑/车辆/植被/标注）
 *   - 堆体半透明、剖切视图、总体鸟瞰/坝前/顶视/剖面视角、自动旋转
 *   - 悬停拾取 → 信息面板 + 高亮；点击「防渗层 / 覆盖」→ 结构详图 SVG
 *   - 自定义轨道相机（旋转/平移/缩放带阻尼）+ 图例 + 库容实时估算
 *
 * 坐标系：X = 沿山谷纵轴(下游 +X, 垃圾坝 X≈150)，Y = 高程，Z = 横向，单位 m。
 * ============================================================ */

// 几何参数类型/常量已抽到 ./LandfillScene3D/geo.ts（re-export 见文件顶部）

// ---------------- 地形与堆体解析式（standalone 参数化移植） ----------------
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

let CUR: GeoParams = { ...DEFAULT_GEO };

const MOUNTAIN_ROAD: [number, number][] = [[0, -90], [-14, -112], [-38, -130], [-34, -154], [-64, -172], [-58, -198], [-88, -212]];
function segDist(px: number, pz: number, a: [number, number], b: [number, number]) {
  const abx = b[0] - a[0], abz = b[1] - a[1];
  const t = clamp(((px - a[0]) * abx + (pz - a[1]) * abz) / ((abx * abx + abz * abz) || 1), 0, 1);
  const dx = px - (a[0] + abx * t), dz = pz - (a[1] + abz * t);
  return Math.hypot(dx, dz);
}
function roadDist(x: number, z: number) {
  let d = 1e9;
  for (let i = 0; i < MOUNTAIN_ROAD.length - 1; i++) d = Math.min(d, segDist(x, z, MOUNTAIN_ROAD[i], MOUNTAIN_ROAD[i + 1]));
  return d;
}
function kv() { return CUR.valleyWidth; }
function kh() { return CUR.pileHeight; }
function kp() { return CUR.pondVolume; }
function kw() { return CUR.gasWellSpacing; }

function fhw(x: number) { return (x >= -120 ? 110 : Math.max(20, 110 + (x + 120) * 0.75)) * kv(); }
function terrainH(x: number, z: number) {
  const fw = fhw(x);
  const t = Math.max(0, (Math.abs(z) - fw) / 70);
  let h = 45 * Math.pow(Math.min(t, 1.3), 1.7);
  if (z < -92) { const d = roadDist(x, z); const n = Math.min(1, d / 9); h *= 0.18 + 0.82 * n; }
  const noise = (1.6 * Math.sin(x * 0.05) * Math.sin(z * 0.07) + 0.8 * Math.sin(x * 0.021 + 1.7) * Math.sin(z * 0.033 + 0.6)) * (t > 0 ? 1 : 0);
  h = Math.max(-0.02, h + noise);
  if (Math.abs(x) < 85.2 * kv() && Math.abs(z) < 66 * kv()) h = -9;
  return h;
}

function setGeo(geo: Partial<GeoParams> | undefined) {
  CUR = clampGeo({ ...DEFAULT_GEO, ...(geo ?? {}) });
}

// 分层堆体参数
const WASTE_BASE_Y = -3.7;
function liftN() { return Math.max(3, Math.round(12 * kh())); }
function capY() { return WASTE_BASE_Y + 0.55 * liftN(); }
function hxAt(y: number) { const b = 85.2 * kv(); return y <= 0 ? b + 0.6 * (y + 4) : (b + 2.4) - 3 * y; }
function hzAt(y: number) { const b = 66 * kv(); return y <= 0 ? b + 0.6 * (y + 4) : (b + 2.4) - 3 * y; }



// ---------------- 构件说明（悬停展示，随参数动态生成） ----------------
let INFO: Record<string, { n: string; d: string }> = {};

function buildInfo(): Record<string, { n: string; d: string }> {
  return {
    terrain: { n: '山谷地形', d: 'U 形山谷：中央为谷底平台，两侧山体幂函数放坡抬升；西侧上游收口，南侧沿盘山进场路开凿山口。\n山谷型填埋场利用天然地形形成库容，是山区最常见的填埋场形式。' },
    waste: { n: '填埋库区 · 分层作业区', d: '生活垃圾分层摊铺、压实后逐层堆高：\n· 约 ' + liftN() + ' 个分层作业面\n· 边坡不陡于 1:3，分级设马道\n· 每日作业后日覆盖，中间覆盖黏土\n【点击查看覆盖结构详图】' },
    cover: { n: '终场覆盖 / 作业面', d: '顶部绿色为已封场终场覆盖：排气层 → 防渗层 → 排水层 → 植被恢复层。\n【点击查看覆盖结构详图】' },
    liner: { n: '场底及边坡防渗系统', d: '单层复合衬层结构（自下而上）：基础层 → 压实黏土 ≥750mm → HDPE 土工膜 1.5mm → 膜上保护层 → 渗滤液导排碎石层 → 垃圾体。\n膜端设锚固沟固定，场底坡向渗滤液盲沟。\n【点击查看结构详图】' },
    leach: { n: '渗滤液收集导排系统', d: '场底导排层 + 穿孔 HDPE 盲沟（鱼刺状布置），渗滤液重力导排至集水井，经泵站提升汇入调节池。\n提示：开启「堆体半透明」或「剖切视图」可观察场底管网。' },
    gas: { n: '填埋气导排系统', d: '垃圾降解产生填埋气（约 55% CH₄ + 45% CO₂）。\n导气井按约 ' + Math.round(45 * kw()) + ' m 间距网格布置，经集气管汇至火炬燃烧排放，防止无组织排放与爆炸风险。' },
    drain: { n: '环场截洪沟', d: '沿库区周边设置，截流场外山坡雨水（清污分流），减少进入堆体的水量。\n南侧大门处设盖板涵洞通过。' },
    road: { n: '场内道路', d: '进场道路经地磅计量后，沿环场路到达作业平台；南侧盘山进场路翻越山口与外界公路相接。\n路面宽 6~7 m，泥结碎石/混凝土路面。' },
    build: { n: '生产生活辅助设施', d: '办公管理区、机修车间、门卫室、地磅房（进场计量）、大门与围栏。\n管理区位于常年主导风向上风向。' },
    veh: { n: '作业车辆', d: '黄色为履带式压实机，橙色为自卸卡车，另配推土机与场内交通车辆。' },
    dam: { n: '垃圾坝', d: '位于填埋区下游的挡渣构筑物，形成库容、稳定堆体，坝顶兼作检修道路。' },
  };
}


function layerSVG(title: string, layers: { n: string; s: string; t: number; c: string }[]) {
  let y = 8, rows = '';
  for (const L of layers) {
    const h = clamp(L.t * 0.06, 9, 64);
    rows += '<rect x="20" y="' + y + '" width="300" height="' + h + '" fill="' + L.c + '" stroke="#0c141a" stroke-width="1"/>'
      + '<text x="336" y="' + (y + h / 2 + 4) + '" fill="#dfe9ee" font-size="12.5">' + L.n + ' <tspan fill="#8fb3c4">' + L.s + '</tspan></text>';
    y += h + 3;
  }
  return '<svg width="640" height="' + (y + 30) + '" class="layertbl" style="background:#0c141c;border-radius:8px;">'
    + '<text x="20" y="' + (y + 22) + '" fill="#8fb3c4" font-size="11">示意图，厚度不按比例 · ' + title + '</text>' + rows + '</svg>';
}

const SVG_LINER = layerSVG('场底防渗系统（自下而上阅读：从底部基础层到顶部垃圾体）', [
  { n: '生活垃圾体', s: '—', t: 300, c: '#9c8f7a' },
  { n: '反滤层', s: '土工布 200 g/m²', t: 60, c: '#e0d6c2' },
  { n: '渗滤液导排层', s: '碎石/卵石 300 mm', t: 300, c: '#7f8c8d' },
  { n: '膜上保护层', s: '土工布 600 g/m²', t: 60, c: '#d5c9b0' },
  { n: 'HDPE 土工膜', s: '厚 1.5 mm（防渗核心）', t: 30, c: '#222831' },
  { n: '压实黏土层', s: '750 mm，K≤10⁻⁷ cm/s', t: 500, c: '#b0814f' },
  { n: '基础层', s: '压实土壤，压实度≥93%', t: 300, c: '#8f7a5e' },
  { n: '地下水导排层', s: '盲沟（地下水位高时设）', t: 200, c: '#5d6d7e' },
]);

const SVG_COVER = layerSVG('终场覆盖系统（自上而下：植被层到垃圾体）', [
  { n: '植被恢复层', s: '耕植土 ≥500 mm + 浅根草灌', t: 400, c: '#6da854' },
  { n: '排水层', s: '碎石/复合排水网 ≥300 mm', t: 300, c: '#7f8c8d' },
  { n: '防渗层', s: '压实黏土 ≥300 mm（可复合 HDPE 1.0 mm）', t: 300, c: '#b0814f' },
  { n: '排气层', s: '碎石 300 mm', t: 300, c: '#a09380' },
  { n: '生活垃圾体', s: '—', t: 300, c: '#9c8f7a' },
]);

// ---------------- 图例 ----------------
const LEGEND_ITEMS: [string, string][] = [
  ['#7a9a55', '地形/山体'], ['#9c8f7a', '填埋堆体'], ['#6da854', '终场覆盖'], ['#494744', '作业面'],
  ['#1f2733', '防渗衬层'], ['#e67e22', '渗滤液管'], ['#c0392b', '填埋气管'], ['#8b939b', '截洪沟'],
  ['#5f6367', '道路'], ['#a88f66', '垃圾坝'], ['#3a2b18', '渗滤液'], ['#bfc6cc', '导气井'],
];

// ---------------- 时辰光照预设 ----------------
type TimeOfDay = 'day' | 'dusk' | 'night';
interface SkyPreset {
  skyTop: number; skyBottom: number;
  sunColor: number; sunIntensity: number;
  ambientSky: number; ambientGround: number; ambientIntensity: number;
  fogColor: number; bgColor: number;
}
const TIME_PRESETS: Record<TimeOfDay, SkyPreset> = {
  day:   { skyTop: 0x6fa8dc, skyBottom: 0xd7e4ef, sunColor: 0xfff2dd, sunIntensity: 2.3, ambientSky: 0xbfd7ea, ambientGround: 0x6a7f56, ambientIntensity: 0.95, fogColor: 0xd7e4ef, bgColor: 0xd7e4ef },
  dusk:  { skyTop: 0xe88c4d, skyBottom: 0xf6d1a3, sunColor: 0xffb37a, sunIntensity: 2.0, ambientSky: 0xf6b07a, ambientGround: 0x7a5a3a, ambientIntensity: 0.75, fogColor: 0xf6d1a3, bgColor: 0xf6d1a3 },
  night: { skyTop: 0x0a1428, skyBottom: 0x1a2640, sunColor: 0xb8c8e0, sunIntensity: 0.45, ambientSky: 0x4060a0, ambientGround: 0x1a2030, ambientIntensity: 0.35, fogColor: 0x1a2640, bgColor: 0x1a2640 },
};

// ---------------- 风险等级 → 颜色/位置映射 ----------------
function riskColorHex(level: RiskItem['level']): number {
  return level === 'red' ? 0xdc2626
    : level === 'orange' ? 0xea580c
    : level === 'yellow' ? 0xca8a04
    : level === 'blue' ? 0x2563eb
    : 0x16a34a;
}
function riskColorCss(level: RiskItem['level']): string {
  return level === 'red' ? '#dc2626'
    : level === 'orange' ? '#ea580c'
    : level === 'yellow' ? '#ca8a04'
    : level === 'blue' ? '#2563eb'
    : '#16a34a';
}
// 把风险类别映射到 3D 场景内的（x, y, z）位置（与坐标系对齐：X=山谷纵轴，Y=高程，Z=横向）
function riskPosition(category: string, k: number, cap: number): [number, number, number] {
  switch (category) {
    case '边坡': return [150 * k, 18, 0];                  // 垃圾坝顶
    case '渗滤液': return [130 * k, 4, 0];                // 调节池
    case '填埋气': return [-130 * k, 14, 60 * k];          // 火炬
    case '地下水': return [158 * k, 5, 0];                // 地下水监测井
    default: return [0, cap + 8, 0];                       // 综合 → 堆体中心上空
  }
}

// 监测数据飘字（默认演示数据）
interface MonitoringSnapshot {
  leachateLevel: number;  // m
  ch4: number;            // %
  groundwater: number;    // m
  fs: number;             // 边坡 Fs
  updatedAt: number;
  /** 数据来源：demo=演示随机游走；diagnosis=AI 快诊真实结果；ogs=稳定化计算结果 */
  source?: 'demo' | 'diagnosis' | 'ogs';
}
const DEFAULT_MONITORING: MonitoringSnapshot = {
  leachateLevel: 0.8,
  ch4: 3.2,
  groundwater: 12.5,
  fs: 1.35,
  updatedAt: Date.now(),
  source: 'demo',
};

// estimateSite / SiteEstimate 已抽到 ./LandfillScene3D/geo.ts（re-export 见文件顶部）

// ---------------- UI 配置 ----------------
const LAYER_OPTIONS: { key: string; label: string }[] = [
  { key: 'terrain', label: '地形山体' },
  { key: 'waste', label: '填埋堆体（库区）' },
  { key: 'cover', label: '终场覆盖 / 作业面' },
  { key: 'liner', label: '防渗衬层（HDPE）' },
  { key: 'leach', label: '渗滤液系统（管网+调节池）' },
  { key: 'gas', label: '填埋气系统（导气井+火炬）' },
  { key: 'drain', label: '环场截洪沟' },
  { key: 'roads', label: '道路' },
  { key: 'build', label: '建构筑物（坝/厂房/监测井）' },
  { key: 'veh', label: '作业车辆' },
  { key: 'trees', label: '山体植被' },
  { key: 'labels', label: '文字标注' },
];

const VIEW_OPTIONS: { key: 'bird' | 'dam' | 'top' | 'sec'; label: string }[] = [
  { key: 'bird', label: '总体鸟瞰' },
  { key: 'dam', label: '坝前视角' },
  { key: 'top', label: '顶视' },
  { key: 'sec', label: '剖面视角' },
];

const ALL_LAYERS: Record<string, boolean> = LAYER_OPTIONS.reduce((acc, l) => { acc[l.key] = true; return acc; }, {} as Record<string, boolean>);

// LandfillApi 接口已抽到 ./LandfillScene3D/geo.ts（re-export 见文件顶部）

// 面板基础样式（深色玻璃，叠加于浅色天空场景之上，与主题解耦）
const panelBase: CSSProperties = {
  position: 'absolute',
  background: 'rgba(10,17,23,0.78)',
  color: '#e8eef2',
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: 10,
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
};

const ctrlBtn: CSSProperties = {
  background: '#1d3040',
  color: '#cfe6f5',
  border: '1px solid #33566e',
  borderRadius: 6,
  fontSize: 12,
  padding: '4px 8px',
  cursor: 'pointer',
};

// ---------------- 程序化贴图（参考 V6 参考模型：草/土/垃圾/衬层/沥青） ----------------
// LS1 性能优化：懒加载 — 仅在场景初始化时构建（避免模块加载时阻塞 150-300ms）
const texRnd = (() => { let s = 20260814; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; })();
function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d')!);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
function buildTextures() {
  const grass = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#7d9c66'; ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 5200; i++) {
      const l = texRnd();
      ctx.fillStyle = l < 0.5 ? '#6f8f5a' : (l < 0.85 ? '#8fae77' : '#a9c48e');
      ctx.fillRect(texRnd() * 256, texRnd() * 256, 1 + texRnd() * 2, 1 + texRnd() * 2);
    }
  });
  grass.repeat.set(60, 60);
  const soil = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#a98f62'; ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 4200; i++) {
      ctx.fillStyle = texRnd() < 0.5 ? '#977f54' : '#bda77c';
      ctx.fillRect(texRnd() * 256, texRnd() * 256, 1 + texRnd() * 2, 1 + texRnd() * 2);
    }
  });
  soil.repeat.set(1 / 18, 1 / 18);
  const wasteTex = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#6f5a3e'; ctx.fillRect(0, 0, 256, 256);
    const bits = ['#8f8471', '#6b7480', '#5f6e52', '#7d4a40', '#b8bcc0', '#8a7a58', '#c9b98a', '#4e5966', '#9c9c94'];
    for (let i = 0; i < 1500; i++) {
      ctx.fillStyle = bits[(texRnd() * bits.length) | 0];
      ctx.fillRect(texRnd() * 256, texRnd() * 256, 2 + texRnd() * 4, 2 + texRnd() * 3);
    }
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = bits[(texRnd() * bits.length) | 0];
      ctx.fillRect(texRnd() * 240, texRnd() * 240, 6 + texRnd() * 12, 5 + texRnd() * 9);
    }
  });
  const liner = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#17181c'; ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#3a4149'; ctx.lineWidth = 2;
    for (let i = 0; i <= 256; i += 64) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
    }
  });
  const asphalt = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#4d5156'; ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 5200; i++) {
      const l = texRnd();
      ctx.fillStyle = l < 0.4 ? '#45494e' : (l < 0.7 ? '#555a60' : '#5f656c');
      ctx.fillRect(texRnd() * 256, texRnd() * 256, 1 + texRnd() * 2, 1 + texRnd() * 2);
    }
  });
  const gravel = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#a3a29a'; ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 4800; i++) {
      ctx.fillStyle = texRnd() < 0.45 ? '#8e8d84' : (texRnd() < 0.5 ? '#b6b5ab' : '#7c7b73');
      ctx.fillRect(texRnd() * 256, texRnd() * 256, 1 + texRnd() * 2, 1 + texRnd() * 2);
    }
  });
  return { grass, soil, wasteTex, liner, asphalt, gravel };
}
// 模块加载时不再生成贴图；由 useEffect 内 buildTextures() 懒构建
// ---------------- 巡检漫游 ----------------
interface RoamWaypoint {
  title: string;
  infoKey: string;
  t: [number, number, number];
  r: number; phi: number; theta: number;
  duration: number; hold: number;
}

// ease-in-out cubic 缓动
function easeInOutCubic(p: number) {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

// 方位角球面最短路径差值（防止 180° 翻转绕远一周）
function shortestDelta(from: number, to: number) {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// 7 站巡检路线（进场→作业→坝顶→渗滤液→填埋气→防渗剖切）
const ROAM_WAYPOINTS: RoamWaypoint[] = [
  { title: '进场大门与地磅', infoKey: 'build', t: [335, 12, 4], r: 170, phi: 0.85, theta: -2.7, duration: 3.5, hold: 1.6 },
  { title: '环场道路与作业车辆', infoKey: 'road', t: [-70, 45, 22], r: 300, phi: 0.7, theta: -2.1, duration: 3.5, hold: 1.6 },
  { title: '作业面与压实设备', infoKey: 'cover', t: [-110, 60, 30], r: 260, phi: 0.9, theta: -2.4, duration: 3.5, hold: 1.8 },
  { title: '垃圾坝顶俯瞰全场', infoKey: 'dam', t: [150, 30, 0], r: 300, phi: 0.5, theta: 0.6, duration: 4, hold: 2 },
  { title: '渗滤液调节池与处理站', infoKey: 'leach', t: [250, 25, 20], r: 250, phi: 0.85, theta: -0.9, duration: 3.5, hold: 1.8 },
  { title: '导气井与火炬', infoKey: 'gas', t: [180, 45, -32], r: 240, phi: 0.9, theta: -1.5, duration: 3.5, hold: 1.8 },
  { title: '防渗衬层（剖切透视）', infoKey: 'liner', t: [-90, 45, 0], r: 380, phi: 1.1, theta: 1.4, duration: 4, hold: 2.2 },
];

export default function LandfillScene3D({
  height = 560,
  geoParams,
  apiRef: externalApiRef,
}: {
  height?: number;
  geoParams?: Partial<GeoParams>;
  apiRef?: { current: LandfillApi | null };
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<LandfillApi | null>(null);
  const autoRotateRef = useRef(false);

  const [layers, setLayers] = useState<Record<string, boolean>>(ALL_LAYERS);
  const [transparent, setTransparent] = useState(false);
  const [clip, setClip] = useState(false);
  const [clipAxis, setClipAxis] = useState<'x' | 'z'>('x');
  const [clipPos, setClipPos] = useState(-20);
  const [autoRotate, setAutoRotate] = useState(false);
  const [info, setInfo] = useState<{ n: string; d: string }>({ n: '项目概况', d: DEFAULT_DESC });
  const [modal, setModal] = useState<{ title: string; svg: string } | null>(null);
  const [ctrlOpen, setCtrlOpen] = useState(true);
  const [webglError, setWebglError] = useState<string | null>(null);
  const [roaming, setRoaming] = useState(false);
  const [roamStep, setRoamStep] = useState<{ idx: number; title: string; total: number } | null>(null);

  // ===== 改造新增 state =====
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDay>('day');
  const [liveGeo, setLiveGeo] = useState<GeoParams>({ ...DEFAULT_GEO });
  const [diagnosis, setDiagnosis] = useState<DiagnosisResult | null>(null);
  const [diagnosisLoading, setDiagnosisLoading] = useState(false);
  const [monitoring, setMonitoring] = useState<MonitoringSnapshot>(DEFAULT_MONITORING);
  const monitoringRef = useRef<MonitoringSnapshot>(DEFAULT_MONITORING);
  useEffect(() => { monitoringRef.current = monitoring; }, [monitoring]);
  const [showHotspots, setShowHotspots] = useState(true);
  const [showLiveLabels, setShowLiveLabels] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  // 诊断数据联动：读取 AI 快诊写入的最新结果（DiagnosisPage 保存于 sessionStorage 'diagnosis-latest'）。
  // 修复：原实现向 /api/diagnose 发送伪造 payload（后端 parseSiteData 不认识 params/contaminants，
  // 恒返回 risks:[]），且场景 effect 依赖数组不含 diagnosis，导致联动永久失效。
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('diagnosis-latest');
      if (!raw) return;
      const parsed = JSON.parse(raw) as { risks?: RiskItem[]; overallRisk?: string; ts?: number };
      if (parsed?.risks?.length) {
        setDiagnosis(prev => ({ ...(prev ?? {}), risks: parsed.risks, overallRisk: parsed.overallRisk } as DiagnosisResult));
        // 同步实时态势：用诊断值替换随机演示基线
        const by = (c: string) => parsed.risks!.find(r => r.category === c);
        const fsRisk = by('边坡'), leaRisk = by('渗滤液'), gasRisk = by('填埋气'), gwRisk = by('地下水');
        setMonitoring(m => ({
          ...m,
          fs: typeof fsRisk?.value === 'number' ? fsRisk.value : m.fs,
          leachateLevel: typeof leaRisk?.value === 'number' ? Math.min(4, leaRisk.value) : m.leachateLevel,
          ch4: typeof gasRisk?.value === 'number' ? Math.min(8, gasRisk.value) : m.ch4,
          groundwater: typeof gwRisk?.value === 'number' ? gwRisk.value : m.groundwater,
          source: 'diagnosis' as const,
          updatedAt: Date.now(),
        }));
      }
    } catch { /* 忽略脏数据 */ }
  }, []);

  // 监测数据飘字：有真实诊断数据时只做微小抖动（保序），否则演示随机游走
  useEffect(() => {
    const live = monitoring.source === 'diagnosis';
    const id = setInterval(() => {
      setMonitoring(prev => live ? prev : ({
        ...prev,
        leachateLevel: Math.max(0.3, Math.min(2.5, prev.leachateLevel + (Math.random() - 0.5) * 0.06)),
        ch4: Math.max(0.5, Math.min(8, prev.ch4 + (Math.random() - 0.5) * 0.18)),
        groundwater: Math.max(8, Math.min(20, prev.groundwater + (Math.random() - 0.5) * 0.05)),
        fs: Math.max(1.05, Math.min(1.6, prev.fs + (Math.random() - 0.5) * 0.008)),
        updatedAt: Date.now(),
      }));
    }, 1800);
    return () => clearInterval(id);
  }, [monitoring.source]);

  // 几何参数优先级：geoParams prop > liveGeo（preset/slider 状态）。
  // 修复：不再把 diagnosis.site（工程量纲：m/°）合入 GeoParams（无量纲缩放 0.5~1.8），
  // 原先 clampGeo 会把 landfillHeight:25 钳到 1.8，导致模型尺寸畸变。
  // LS4 性能修复：用 useMemo 稳定对象引用（避免 JSON.stringify 每帧重复计算）
  const mergedGeo: GeoParams = useMemo(() => {
    const base: GeoParams = { ...DEFAULT_GEO, ...liveGeo, ...(geoParams ?? {}) };
    return clampGeo(base);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveGeo, geoParams]);
  const geoKey = useMemo(() => JSON.stringify(mergedGeo), [mergedGeo]);

  // LS5 性能修复：防抖 geoKey — 用户拖动 slider 时不重建场景，松手 200ms 后才重建
  // 这把"每帧重建场景"降为"调整完成才重建一次"
  const [debouncedGeoKey, setDebouncedGeoKey] = useState(geoKey);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => setDebouncedGeoKey(geoKey), 200);
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [geoKey]);

  // 防抖后更新 CUR/INFO（避免拖动 slider 时 React state 抖动）
  useEffect(() => {
    setGeo(mergedGeo);
    INFO = buildInfo();
    setInfo({ n: '项目概况', d: estimateSite(mergedGeo).desc });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedGeoKey]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    autoRotateRef.current = autoRotate;
    // setGeo/INFO/setInfo 由下方 debouncedGeoKey 触发的子 effect 处理，避免拖动 slider 时抖动

    let width = mount.clientWidth || 600;
    let heightPx = mount.clientHeight || height;

    // LS1 性能优化：贴图懒构建（避免模块加载时阻塞 150-300ms）
    const { grass: grassTex, soil: soilTex, wasteTex, liner: linerTex, asphalt: asphaltTex, gravel: gravelTex } = buildTextures();

    // ---------------- 渲染器 / 场景 / 相机 / 灯光 ----------------
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch (e) {
      setWebglError('当前浏览器不支持 WebGL：' + (e as Error).message);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, heightPx);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const preset = TIME_PRESETS[timeOfDay];
    scene.background = new THREE.Color(preset.bgColor);
    // 天空穹顶渐变 + 低多边形云（参考 V6 参考模型）
    {
      const skyMat = new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: {
          top: { value: new THREE.Color(preset.skyTop) },
          bottom: { value: new THREE.Color(preset.skyBottom) },
        },
        vertexShader: 'varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'varying vec3 vPos; uniform vec3 top; uniform vec3 bottom; void main(){ float t = pow(clamp(normalize(vPos).y, 0.0, 1.0), 0.6); gl_FragColor = vec4(mix(bottom, top, t), 1.0); }',
      });
      const sky = new THREE.Mesh(new THREE.SphereGeometry(1900, 24, 16), skyMat);
      sky.renderOrder = -10;
      scene.add(sky);
    }
    {
      const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: timeOfDay === 'night' ? 0.10 : 0.9, fog: false });
      const spots: [number, number, number][] = [[-430, 215, -370], [120, 265, -480], [490, 245, -170], [-510, 205, 310], [390, 255, 430], [-40, 225, 570], [-185, 235, 60], [270, 205, -330]];
      for (const [x, y, z] of spots) {
        const r = 26 + texRnd() * 16;
        const cg = new THREE.Group();
        const m1 = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), cloudMat);
        const m2 = new THREE.Mesh(new THREE.SphereGeometry(r * 0.7, 10, 8), cloudMat); m2.position.set(r * 0.9, r * 0.25, r * 0.3);
        const m3 = new THREE.Mesh(new THREE.SphereGeometry(r * 0.6, 10, 8), cloudMat); m3.position.set(-r * 0.85, r * 0.2, -r * 0.25);
        cg.add(m1, m2, m3); cg.position.set(x, y, z); scene.add(cg);
      }
    }

    const camera = new THREE.PerspectiveCamera(50, width / heightPx, 0.5, 4000);

    const hemi = new THREE.HemisphereLight(preset.ambientSky, preset.ambientGround, preset.ambientIntensity); scene.add(hemi);
    const sun = new THREE.DirectionalLight(preset.sunColor, preset.sunIntensity);
    sun.position.set(260, 340, 180); sun.castShadow = timeOfDay !== 'night'; // 夜间关闭阴影提升帧率
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -360; sun.shadow.camera.right = 360;
    sun.shadow.camera.top = 360; sun.shadow.camera.bottom = -360;
    sun.shadow.camera.near = 20; sun.shadow.camera.far = 1100;
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 1.5;
    scene.add(sun); scene.add(sun.target); sun.target.position.set(0, 30, 0);
    // 夜间补充：环境点光（让堆体仍可见）
    if (timeOfDay === 'night') {
      const fillA = new THREE.PointLight(0x60a5fa, 0.7, 600, 2); fillA.position.set(-150, 60, 80); scene.add(fillA);
      const fillB = new THREE.PointLight(0xa78bfa, 0.5, 500, 2); fillB.position.set(150, 40, -60); scene.add(fillB);
    }

    // 远景地面
    {
      const g = new THREE.Mesh(new THREE.CircleGeometry(1600, 48),
        new THREE.MeshStandardMaterial({ color: 0x81996b, roughness: 1 }));
      g.rotation.x = -Math.PI / 2; g.position.y = -4; g.receiveShadow = true; scene.add(g);
    }

    // ---------------- 构件注册（拾取/图层/高亮） ----------------
    const pickList: THREE.Object3D[] = [];
    const compMats: Record<string, THREE.MeshStandardMaterial[]> = {};
    const groups: Record<string, THREE.Object3D[]> = {};
    function regLayer(layer: string, obj: THREE.Object3D) { (groups[layer] = groups[layer] || []).push(obj); scene.add(obj); }
    function regPick(obj: THREE.Object3D, k: string) {
      obj.userData.k = k;
      pickList.push(obj);
      compMats[k] = compMats[k] || [];
      obj.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.material) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach(m => { if ((m as THREE.MeshStandardMaterial).emissive) compMats[k].push(m as THREE.MeshStandardMaterial); });
        }
      });
    }

    // =============== standalone 场景移植（4 参数缩放） ===============
    const std = (color: number, opts: any = {}) => new THREE.MeshStandardMaterial({ color, roughness: opts.roughness ?? 0.95, metalness: opts.metalness ?? 0, ...opts });
    const mesh2 = (geo: THREE.BufferGeometry | THREE.PlaneGeometry | THREE.BoxGeometry | THREE.CylinderGeometry | THREE.SphereGeometry | THREE.ConeGeometry, mat: THREE.Material, x: number, y: number, z: number, ry = 0, cast = false, receive = false) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.y = ry;
      if (cast) m.castShadow = true; if (receive) m.receiveShadow = true;
      return m;
    };
    const cyl = (a: [number, number, number], b: [number, number, number], r: number, mat: THREE.Material) => {
      const pa = new THREE.Vector3(...a), pb = new THREE.Vector3(...b);
      const dir = pb.clone().sub(pa); const len = dir.length();
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12), mat);
      m.position.copy(pa).add(dir.clone().multiplyScalar(0.5));
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      m.castShadow = true; return m;
    };
    const ribbon = (pts: [number, number][], halfW: number, lift: number, yFn: (x: number, z: number) => number, color: number, rough = 0.9) => {
      const pos: number[] = [], idx: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = (i < pts.length - 1) ? pts[i + 1] : pts[i - 1];
        let dx = q[0] - p[0], dz = q[1] - p[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
        if (i === pts.length - 1) { dx = -dx; dz = -dz; }
        const nx = -dz, nz = dx;
        const lx = p[0] + nx * halfW, lz = p[1] + nz * halfW, rx = p[0] - nx * halfW, rz = p[1] - nz * halfW;
        pos.push(lx, yFn(lx, lz) + lift, lz, rx, yFn(rx, rz) + lift, rz);
      }
      for (let i = 0; i < pts.length - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx); g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: rough, side: THREE.DoubleSide }));
      m.receiveShadow = true; return m;
    };
    // gravelTex 已在上面从 buildTextures() 解构得到

    // 山谷地形（实体：顶面 + 底面 + 侧裙，盘山路开凿）
    const terrainGroup = new THREE.Group();
    {
      const X0 = -220, X1 = 220, NX = 110, Z0 = -220, Z1 = 220, NZ = 110;
      const yBase = -35;
      const sx = (X1 - X0) / NX, sz = (Z1 - Z0) / NZ;
      const W = NZ + 1;
      const pos: number[] = [], col: number[] = [], idx: number[] = [];
      const cLow = new THREE.Color(0x77a35e), cHigh = new THREE.Color(0x4a6b36), rock = new THREE.Color(0x8b7d66), tmp = new THREE.Color();
      const cBase = new THREE.Color(0x3c3528);
      const topAt = (i: number, j: number) => i * W + j;
      for (let i = 0; i <= NX; i++) {
        const x = X0 + sx * i;
        for (let j = 0; j <= NZ; j++) {
          const z = Z0 + sz * j, h = terrainH(x, z);
          pos.push(x, h, z);
          const gx = (terrainH(x + 2, z) - terrainH(x - 2, z)) / 4;
          const gz = (terrainH(x, z + 2) - terrainH(x, z - 2)) / 4;
          const slope = Math.hypot(gx, gz);
          tmp.copy(cLow).lerp(cHigh, clamp((h - 2) / 40, 0, 1));
          if (slope > 0.5) tmp.lerp(rock, Math.min(1, (slope - 0.5) * 1.5) * 0.7);
          col.push(tmp.r, tmp.g, tmp.b);
        }
      }
      const bottomStart = (NX + 1) * (NZ + 1);
      for (let i = 0; i <= NX; i++) {
        const x = X0 + sx * i;
        for (let j = 0; j <= NZ; j++) {
          const z = Z0 + sz * j;
          pos.push(x, yBase, z);
          col.push(cBase.r, cBase.g, cBase.b);
        }
      }
      for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
        const a = topAt(i, j), b = a + 1, a2 = topAt(i + 1, j), b2 = a2 + 1;
        idx.push(a, b, a2, b, b2, a2);
      }
      for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
        const a = bottomStart + topAt(i, j), b = a + 1, a2 = bottomStart + topAt(i + 1, j), b2 = a2 + 1;
        idx.push(a, a2, b, b, a2, b2);
      }
      const skirt = (t0: number, t1: number) => { idx.push(t0, bottomStart + t0, t1, t1, bottomStart + t0, bottomStart + t1); };
      for (let i = 0; i < NX; i++) { const a = topAt(i, 0), b = topAt(i + 1, 0); skirt(a, b); }
      for (let i = 0; i < NX; i++) { const a = topAt(i, NZ), b = topAt(i + 1, NZ); skirt(a, b); }
      for (let j = 0; j < NZ; j++) { const a = topAt(0, j), b = topAt(0, j + 1); skirt(a, b); }
      for (let j = 0; j < NZ; j++) { const a = topAt(NX, j), b = topAt(NX, j + 1); skirt(a, b); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx); g.computeVertexNormals();
      const mountain = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
      mountain.receiveShadow = true; mountain.castShadow = true; terrainGroup.add(mountain);

      // 场区地面（收窄到建模范围）
      const k = kv();
      const groundShape = new THREE.Shape();
      groundShape.moveTo(-210, -210); groundShape.lineTo(210, -210); groundShape.lineTo(210, 210); groundShape.lineTo(-210, 210); groundShape.closePath();
      const holePit = new THREE.Path();
      holePit.moveTo(-44.4 * k, 34.9 * k); holePit.lineTo(-4.7 * k, 34.9 * k); holePit.lineTo(-4.7 * k, 73.2 * k); holePit.lineTo(4.7 * k, 73.2 * k);
      holePit.lineTo(4.7 * k, 34.9 * k); holePit.lineTo(44.4 * k, 34.9 * k); holePit.lineTo(44.4 * k, -34.9 * k); holePit.lineTo(-44.4 * k, -34.9 * k); holePit.closePath();
      groundShape.holes.push(holePit);
      const ground = new THREE.Mesh(new THREE.ShapeGeometry(groundShape), std(0xffffff, { map: grassTex, roughness: 1 }));
      ground.rotation.x = -Math.PI / 2; ground.position.y = 0.01; ground.receiveShadow = true; terrainGroup.add(ground);
    }
    regLayer('terrain', terrainGroup); regPick(terrainGroup, 'terrain');

    // 防渗衬层（黏土 + HDPE + 砂砾层 + 锚固沟）
    function pitGeometry(innerHW: number, innerHD: number, outerHW: number, outerHD: number, yBot: number, yTop: number) {
      const verts: number[] = [], uvs: number[] = [];
      const add = (x: number, y: number, z: number) => { verts.push(x, y, z); uvs.push(x / 12 + 0.5, z / 12 + 0.5); };
      add(-innerHW, yBot, -innerHD); add(innerHW, yBot, -innerHD); add(innerHW, yBot, innerHD); add(-innerHW, yBot, innerHD);
      add(-outerHW, yTop, -outerHD); add(outerHW, yTop, -outerHD); add(outerHW, yTop, outerHD); add(-outerHW, yTop, outerHD);
      const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 4, 0, 1, 4, 1, 5, 5, 1, 2, 5, 2, 6, 6, 2, 3, 6, 3, 7, 7, 3, 0, 7, 0, 4];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      g.setIndex(idx); g.computeVertexNormals();
      return g;
    }
    const linerGroup = new THREE.Group();
    {
      const k = kv();
      const clay = mesh2(pitGeometry(85.2 * k, 66 * k, 88 * k, 69.2 * k, -4, 0), std(0xffffff, { map: soilTex, roughness: 1 }), 0, 0, 0, 0, false, true);
      clay.renderOrder = 0; linerGroup.add(clay);
      const hdpe = mesh2(pitGeometry(84.6 * k, 65.4 * k, 90 * k, 71.2 * k, -3.86, -0.06), std(0xffffff, { map: linerTex, roughness: 0.55, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }), 0, 0, 0);
      hdpe.renderOrder = 1; linerGroup.add(hdpe);
      const gravel = mesh2(new THREE.PlaneGeometry(164 * k, 132 * k), std(0xffffff, { map: gravelTex, roughness: 1 }), 0, -3.72, 0);
      gravel.rotation.x = -Math.PI / 2; gravel.renderOrder = 2; linerGroup.add(gravel);
      const tm = std(0x2a2f36, { roughness: 0.9 });
      linerGroup.add(mesh2(new THREE.BoxGeometry(1, 0.5, 150 * k), tm, 90.5 * k, -0.25, 0));
      linerGroup.add(mesh2(new THREE.BoxGeometry(1, 0.5, 150 * k), tm, -90.5 * k, -0.25, 0));
      linerGroup.add(mesh2(new THREE.BoxGeometry(190 * k, 0.5, 1), tm, 0, -0.25, 71.2 * k));
      linerGroup.add(mesh2(new THREE.BoxGeometry(190 * k, 0.5, 1), tm, 0, -0.25, -71.2 * k));
    }
    regLayer('liner', linerGroup); regPick(linerGroup, 'liner');

    // 渗滤液系统（鱼刺盲沟 + 泵站 + 调节池）
    const leachGroup = new THREE.Group();
    {
      const k = kv(), pk = Math.cbrt(kp());
      const pipeMat = std(0x54657a, { roughness: 0.6 });
      leachGroup.add(cyl([-64 * k, -3.5, -48 * k], [64 * k, -3.5, -48 * k], 0.16, pipeMat));
      for (let x = -60; x <= 60; x += 12) {
        leachGroup.add(cyl([x * k, -3.5, -48 * k], [x * k, -3.5, 48 * k], 0.12, pipeMat));
        leachGroup.add(cyl([x * k, -3.5, 48 * k], [(x + 4.8) * k, -3.5, 54.4 * k], 0.1, pipeMat));
        leachGroup.add(cyl([x * k, -3.5, 48 * k], [(x - 4.8) * k, -3.5, 54.4 * k], 0.1, pipeMat));
      }
      leachGroup.add(mesh2(new THREE.CylinderGeometry(1.2, 1.2, 0.9, 16), std(0x333a42), -64 * k, -3.25, -48 * k));
      leachGroup.add(cyl([-64 * k, -2.8, -48 * k], [-95 * k, 0.5, -79 * k], 0.13, pipeMat));
      leachGroup.add(mesh2(new THREE.BoxGeometry(2.4, 2.4, 2.4), std(0xc9d2d7, { roughness: 0.7 }), -95 * k, 1.2, -79 * k));
      leachGroup.add(mesh2(new THREE.BoxGeometry(2.7, 0.18, 2.7), std(0x6d7680), -95 * k, 2.5, -79 * k));
      leachGroup.add(cyl([-95 * k, 0.5, -79 * k], [-4 * k, 0.5, -79 * k], 0.15, pipeMat));
      leachGroup.add(cyl([4 * k, 0.5, -79 * k], [127 * k, 0.5, -79 * k], 0.15, pipeMat));
      leachGroup.add(cyl([127 * k, 0.5, -79 * k], [127 * k, 1.0, -8 * k], 0.15, pipeMat));
      leachGroup.add(cyl([127 * k, 1.0, -8 * k], [119.6 * k, 1.4, -8 * k], 0.15, pipeMat));
      const pond = new THREE.Group();
      const pondBase = mesh2(new THREE.PlaneGeometry(22 * pk, 14 * pk), std(0xffffff, { map: linerTex, roughness: 0.55, transparent: true, opacity: 0.95 }), 130 * k, 0.12, 0);
      pondBase.rotation.x = -Math.PI / 2; pond.add(pondBase);
      const pondWater = mesh2(new THREE.PlaneGeometry(20 * pk, 12 * pk), std(0x4a94bd, { roughness: 0.15, metalness: 0.05, transparent: true, opacity: 0.85 }), 130 * k, 0.5, 0);
      pondWater.rotation.x = -Math.PI / 2; pond.add(pondWater);
      const bermMat = std(0xc3d8ae, { map: grassTex, roughness: 1 });
      pond.add(mesh2(new THREE.BoxGeometry(22 * pk, 1.8, 2), bermMat, 130 * k, 0.9, 8 * pk, 0, true, true));
      pond.add(mesh2(new THREE.BoxGeometry(22 * pk, 1.8, 2), bermMat, 130 * k, 0.9, -8 * pk, 0, true, true));
      pond.add(mesh2(new THREE.BoxGeometry(2, 1.8, 14 * pk), bermMat, 119 * k, 0.9, 0, 0, true, true));
      pond.add(mesh2(new THREE.BoxGeometry(2, 1.8, 14 * pk), bermMat, 141 * k, 0.9, 0, 0, true, true));
      leachGroup.add(pond);
    }
    regLayer('leach', leachGroup); regPick(leachGroup, 'leach');

    // 填埋堆体（分层台阶）+ 终场覆盖
    const wasteGroup = new THREE.Group();
    const coverGroup = new THREE.Group();
    {
      const baseY = WASTE_BASE_Y, n = liftN(), cap = capY();
      const tints = [0x9a8f7f, 0x948a7a, 0x8f8474, 0x897f6f, 0x84796a, 0x7e7465, 0x786e5f, 0x73695a, 0x6d6455, 0x675e50, 0x62594b, 0x5c5447];
      for (let i = 0; i < n; i++) {
        const y0 = baseY + 0.55 * i, y1 = y0 + 0.55;
        const hx = Math.max(2, hxAt(y1)), hz = Math.max(2, hzAt(y1));
        wasteGroup.add(mesh2(new THREE.BoxGeometry(hx * 2, 0.55, hz * 2), std(tints[i % 12], { map: wasteTex, roughness: 0.98 }), 0, (y0 + y1) / 2, 0, 0, true, true));
        if (i < n - 1) {
          const nx = Math.max(2, hxAt(y1 + 0.55)), nz = Math.max(2, hzAt(y1 + 0.55));
          coverGroup.add(mesh2(new THREE.BoxGeometry(nx * 2 + 0.12, 0.06, nz * 2 + 0.12), std(0xffffff, { map: soilTex, roughness: 1 }), 0, y1 + 0.03, 0, 0, false, true));
        }
      }
      coverGroup.add(mesh2(new THREE.BoxGeometry(hxAt(cap) * 2 + 0.9, 0.15, hzAt(cap) * 2 + 0.9), std(0xd5c6a8, { map: soilTex, roughness: 1 }), 0, cap + 0.075, 0, 0, false, true));
      coverGroup.add(mesh2(new THREE.BoxGeometry(hxAt(cap) * 2 + 0.6, 0.12, hzAt(cap) * 2 + 0.6), std(0xb9d3a0, { map: grassTex, roughness: 1 }), 0, cap + 0.2, 0, 0, false, true));
    }
    regLayer('waste', wasteGroup); regPick(wasteGroup, 'waste');
    regLayer('cover', coverGroup); regPick(coverGroup, 'cover');
    const wasteMesh = wasteGroup;

    // 垃圾坝（下游挡渣构筑物）
    const damGroup = new THREE.Group();
    {
      const k = kv();
      const topX = hxAt(capY());
      const z = (hzAt(capY()) + 8) * k;
      const dh = 8 * CUR.damHeight;
      const crestX = (topX + 12) * k;
      const toeUp = crestX - 10 * k, toeDown = crestX + 14 * k;
      const shape = new THREE.Shape();
      shape.moveTo(toeUp, 0); shape.lineTo(crestX, dh); shape.lineTo(crestX + 4 * k, dh); shape.lineTo(toeDown, 0); shape.closePath();
      const g = new THREE.ExtrudeGeometry(shape, { depth: z * 2, bevelEnabled: false });
      g.translate(0, 0, -z);
      const dam = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xffffff, map: soilTex, roughness: 1 }));
      dam.castShadow = true; dam.receiveShadow = true; damGroup.add(dam);
      const crest = new THREE.Mesh(new THREE.BoxGeometry(4 * k, 0.5, z * 2), new THREE.MeshStandardMaterial({ color: 0xffffff, map: asphaltTex, roughness: 1 }));
      crest.position.set(crestX + 2 * k, dh + 0.2, 0); crest.castShadow = true; crest.receiveShadow = true; damGroup.add(crest);
    }
    regLayer('build', damGroup); regPick(damGroup, 'dam');

    // 导气井 + 火炬
    const gasGroup = new THREE.Group();
    const flameParts: { flame?: THREE.Mesh } = {};
    {
      const k = kv(), sp = kw(), cap = capY();
      const wellMat = std(0x4a535c, { roughness: 0.5 }), headMat = std(0x3a4048);
      const xs: number[] = [];
      for (let x = -60; x <= 60; x += Math.max(15, 40 * sp)) xs.push(x);
      for (const x of xs) for (const z of [-48 * k, 0, 48 * k]) {
        gasGroup.add(mesh2(new THREE.CylinderGeometry(0.22, 0.22, 3, 12), wellMat, x * k, cap - 0.75, z, 0, true, true));
        gasGroup.add(mesh2(new THREE.SphereGeometry(0.32, 12, 10), headMat, x * k, cap + 0.9, z, 0, true, false));
      }
      const flare = new THREE.Group();
      flare.add(mesh2(new THREE.BoxGeometry(1.8, 1.2, 1.8), std(0x6d7680), -130 * k, 0.6, 60 * k));
      flare.add(mesh2(new THREE.CylinderGeometry(0.35, 0.35, 4.2, 12), std(0x4a535c, { roughness: 0.5 }), -130 * k, 2.1, 60 * k, 0, true, true));
      const flameMat = std(0xff8a2a, { emissive: 0xff6a00, emissiveIntensity: 2.2, transparent: true, opacity: 0.92 });
      const flame = mesh2(new THREE.ConeGeometry(0.5, 1.3, 14), flameMat, -130 * k, 4.7, 60 * k);
      flare.add(flame); flameParts.flame = flame;
      gasGroup.add(flare);
    }
    regLayer('gas', gasGroup); regPick(gasGroup, 'gas');

    // 环场截洪沟 + 地下水监测井
    const drainGroup = new THREE.Group();
    {
      const k = kv();
      const addRibbon = (pts: [number, number][], hw: number) => drainGroup.add(ribbon(pts.map(([x, z]) => [x * k, z * k] as [number, number]), hw, 0.14, () => 0, 0x8b939b, 0.9));
      addRibbon([[-116, -84], [-116, 84]], 1.1);
      addRibbon([[-116, 84], [116, 84]], 1.1);
      addRibbon([[116, 84], [116, -84]], 1.1);
      addRibbon([[-116, -84], [-13, -84]], 1.1);
      addRibbon([[13, -84], [116, -84]], 1.1);
      const gwMat = std(0xeef2f5, { roughness: 0.5 }), gwCap = std(0xc0392b, { roughness: 0.6 });
      for (const [x, z] of [[-160, 0], [0, -96], [0, 100], [155, -30], [158, 30]]) {
        drainGroup.add(mesh2(new THREE.CylinderGeometry(0.45, 0.45, 3, 8), gwMat, x * k, 1.5, z * k, 0, true, true));
        drainGroup.add(mesh2(new THREE.BoxGeometry(1.1, 0.25, 1.1), gwCap, x * k, 3.12, z * k));
      }
    }
    regLayer('drain', drainGroup); regPick(drainGroup, 'drain');

    // 场内道路
    const roadGroup = new THREE.Group();
    {
      const k = kv();
      const roadMat = std(0xffffff, { map: asphaltTex, roughness: 1 });
      roadGroup.add(mesh2(new THREE.BoxGeometry(5 * k, 0.1, 20 * k), roadMat, 0, 0.05, -80 * k));
      roadGroup.add(mesh2(new THREE.BoxGeometry(208 * k, 0.1, 5 * k), roadMat, 0, 0.05, -76 * k));
      roadGroup.add(mesh2(new THREE.BoxGeometry(5 * k, 0.1, 152 * k), roadMat, 104 * k, 0.05, 0));
      roadGroup.add(mesh2(new THREE.BoxGeometry(5 * k, 0.1, 152 * k), roadMat, -104 * k, 0.05, 0));
      roadGroup.add(mesh2(new THREE.BoxGeometry(208 * k, 0.1, 5 * k), roadMat, 0, 0.05, 76 * k));
      roadGroup.add(mesh2(new THREE.BoxGeometry(42 * k, 0.1, 5 * k), roadMat, -125 * k, 0.05, -45 * k));
      roadGroup.add(ribbon(MOUNTAIN_ROAD.map(([x, z]) => [x * k, z * k] as [number, number]), 1.6, 0.22, terrainH, 0x5f6367, 1));
    }
    regLayer('roads', roadGroup); regPick(roadGroup, 'road');

    // 建构筑物
    const buildGroup = new THREE.Group();
    {
      const k = kv();
      const wMat = std(0xffffff, { roughness: 0.8 }), roofMat = std(0x6d7680);
      const admin = new THREE.Group();
      admin.add(mesh2(new THREE.BoxGeometry(18, 6, 10), wMat, -140 * k, 3, -60 * k));
      admin.add(mesh2(new THREE.BoxGeometry(19, 0.35, 11), roofMat, -140 * k, 6.18, -60 * k));
      buildGroup.add(admin);
      const workshop = new THREE.Group();
      workshop.add(mesh2(new THREE.BoxGeometry(14, 5, 9), wMat, -140 * k, 2.5, 60 * k));
      workshop.add(mesh2(new THREE.BoxGeometry(15, 0.3, 10), roofMat, -140 * k, 5.15, 60 * k));
      buildGroup.add(workshop);
      const guard = new THREE.Group();
      guard.add(mesh2(new THREE.BoxGeometry(4.5, 3.2, 4.5), wMat, 10 * k, 1.6, -87 * k));
      guard.add(mesh2(new THREE.BoxGeometry(5, 0.2, 5), roofMat, 10 * k, 3.3, -87 * k));
      buildGroup.add(guard);
      const weigh = new THREE.Group();
      weigh.add(mesh2(new THREE.BoxGeometry(3.6, 3, 3.6), wMat, -6.6 * k, 1.5, -83.2 * k));
      weigh.add(mesh2(new THREE.BoxGeometry(4, 0.15, 4), roofMat, -6.6 * k, 3.08, -83.2 * k));
      buildGroup.add(weigh);
    }
    regLayer('build', buildGroup); regPick(buildGroup, 'build');

    // 作业车辆
    const vehGroup = new THREE.Group();
    function dumpTruck(color: number) {
      const g = new THREE.Group();
      g.add(mesh2(new THREE.BoxGeometry(3.6, 0.55, 1.6), std(0x3a4048), 0, 0.9, 0));
      g.add(mesh2(new THREE.BoxGeometry(1.3, 1.15, 1.4), std(color), -1.25, 1.35, 0));
      g.add(mesh2(new THREE.BoxGeometry(2.3, 0.8, 1.6), std(0xb0b4b8, { roughness: 0.7 }), 1.15, 1.28, 0));
      for (const [x, z] of [[-1.3, 0.85], [1.2, 0.85], [-1.3, -0.85], [1.2, -0.85]]) {
        const w = mesh2(new THREE.CylinderGeometry(0.45, 0.45, 0.32, 12), std(0x2b2f33, { roughness: 0.8 }), x, 0.45, z);
        w.rotation.z = Math.PI / 2; g.add(w);
      }
      return g;
    }
    {
      const k = kv();
      const truckSpecs: [number, [number, number], number][] = [
        [0xd9a441, [-40, 16], 0.7],
        [0xc96a1e, [0, -78], -Math.PI / 2],
        [0xb86a1d, [0, -86], Math.PI / 2],
        [0x2f6db3, [104, 12], Math.PI / 2],
        [0x7a5c1e, [48, -30], 0.3],
        [0x8a6d2b, [-80, 40], -0.5],
        [0x5577aa, [60, 40], 1.2],
        [0x9a6d3b, [-60, -40], -1.0],
      ];
      const vn = Math.max(0, Math.min(8, Math.round(CUR.vehicleCount)));
      truckSpecs.slice(0, vn).forEach(([color, [x, z], ry]) => {
        const t = dumpTruck(color);
        t.position.set(x * k, 0.12, z * k); t.rotation.y = ry; vehGroup.add(t);
      });
      const comp = new THREE.Group();
      comp.add(mesh2(new THREE.CylinderGeometry(0.5, 0.5, 1.75, 14), std(0x3a4048, { roughness: 0.5 }), 1.35, 0.5, 0));
      comp.children[0].rotation.z = Math.PI / 2;
      comp.add(mesh2(new THREE.BoxGeometry(2.6, 0.9, 1.7), std(0xd9a441), 0.1, 0.95, 0));
      comp.position.set(-110 * k, 0.12, 29 * k); comp.rotation.y = 0.5; vehGroup.add(comp);
    }
    regLayer('veh', vehGroup); regPick(vehGroup, 'veh');

    // 山体植被
    const treeGroup = new THREE.Group();
    {
      const rnd = (() => { let s = 20260814; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; })();
      const spots: [number, number, number][] = [];
      let guard = 0;
      const targetTrees = Math.max(30, Math.round(170 * CUR.treeDensity));
      while (spots.length < targetTrees && guard < 6000) {
        guard++;
        const x = -250 + rnd() * 530, z = -245 + rnd() * 490;
        const h = terrainH(x, z);
        if (h < 0.7) continue;
        if (Math.abs(x) < 178 && Math.abs(z) < 115) continue;
        if (roadDist(x, z) < 7) continue;
        spots.push([x, z, 0.75 + rnd() * 0.85]);
      }
      const trunkG = new THREE.CylinderGeometry(0.3, 0.42, 2.1, 5);
      const canG = new THREE.ConeGeometry(2.4, 5.6, 7);
      const trunkI = new THREE.InstancedMesh(trunkG, std(0x6b4a2f, { roughness: 1 }), spots.length);
      const canI = new THREE.InstancedMesh(canG, std(0x4d7a3a, { roughness: 1 }), spots.length);
      const d = new THREE.Object3D();
      spots.forEach((s, i) => {
        const y = terrainH(s[0], s[1]);
        d.position.set(s[0], y + 1.05 * s[2], s[1]); d.scale.setScalar(s[2]); d.updateMatrix(); trunkI.setMatrixAt(i, d.matrix);
        d.position.set(s[0], y + (2.1 + 2.8) * s[2], s[1]); d.updateMatrix(); canI.setMatrixAt(i, d.matrix);
      });
      trunkI.castShadow = canI.castShadow = true;
      treeGroup.add(trunkI, canI);
    }
    regLayer('trees', treeGroup);

    // 文字标注
    const labelGroup = new THREE.Group();
    function makeLabel(text: string) {
      const c = document.createElement('canvas'); c.width = 512; c.height = 128;
      const ctx = c.getContext('2d')!;
      const r = 22; ctx.fillStyle = 'rgba(10,18,26,.66)';
      ctx.beginPath(); ctx.moveTo(8 + r, 22); ctx.arcTo(504, 22, 504, 106, r); ctx.arcTo(504, 106, 8, 106, r);
      ctx.arcTo(8, 106, 8, 22, r); ctx.arcTo(8, 22, 504, 22, r); ctx.closePath(); ctx.fill();
      ctx.font = 'bold 44px "Microsoft YaHei","PingFang SC",sans-serif';
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 256, 66);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true }));
      sp.scale.set(15, 3.75, 1); return sp;
    }
    {
      const k = kv(), cap = capY();
      const L = (t: string, x: number, y: number, z: number) => { const s = makeLabel(t); s.position.set(x, y, z); labelGroup.add(s); };
      L('填埋库区 · 分层作业', 0, cap + 4, 0);
      L('渗滤液调节池', 130 * k, 4.5, 0);
      L('火炬', -130 * k, 9.5, 60 * k);
      L('环场截洪沟', 122 * k, 2, 40 * k);
      L('导气井', -44 * k, cap + 5, 24 * k);
      L('地下水监测井', 158 * k, 5, 0);
      L('盘山进场路', -48 * k, terrainH(-48 * k, -156 * k) + 6, -156 * k);
    }
    regLayer('labels', labelGroup);

    // ============== 风险热点浮标（A1 + B6 联动） ==============
    // 每个浮标：底部发光球（脉冲动画）+ 顶部 risk 标签 sprite + 连线
    const hotspotGroup = new THREE.Group();
    const hotspots: { group: THREE.Group; ring: THREE.Mesh; ringMat: THREE.MeshBasicMaterial; level: RiskItem['level']; pos: [number, number, number] }[] = [];
    function makeHotspotTex(color: string) {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const ctx = c.getContext('2d')!;
      const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, color); g.addColorStop(0.45, color + 'aa'); g.addColorStop(1, color + '00');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(c);
    }
    function addHotspot(level: RiskItem['level'], pos: [number, number, number], title: string) {
      const colorCss = riskColorCss(level);
      const colorHex = riskColorHex(level);
      const grp = new THREE.Group();
      // 底部光晕（始终面向相机）
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeHotspotTex(colorCss),
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      sprite.scale.set(14, 14, 1);
      grp.add(sprite);
      // 中心小环（脉冲用）
      const ringGeo = new THREE.RingGeometry(0.4, 0.6, 24);
      const ringMat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(pos[0], 0.1, pos[2]);
      grp.add(ring);
      // 顶部文字标签
      const lbl = makeLabel(title);
      lbl.position.set(pos[0], pos[1] + 6, pos[2]);
      grp.add(lbl);
      // 垂直连线（地面到标签）
      const lineMat = new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity: 0.55 });
      const linePts = [new THREE.Vector3(pos[0], 0.1, pos[2]), new THREE.Vector3(pos[0], pos[1] + 5, pos[2])];
      const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
      grp.add(new THREE.Line(lineGeo, lineMat));
      grp.position.set(0, 0, 0);
      hotspotGroup.add(grp);
      hotspots.push({ group: grp, ring, ringMat, level, pos });
    }
    // 演示热点：仅在没有真实诊断数据时展示样例（修复：原先无条件叠加导致双份热点）
    if (!diagnosis?.risks?.length) {
      const k = kv(), cap = capY();
      const sample = [
        { level: 'orange' as const, pos: riskPosition('边坡', k, cap), title: '⚠ 边坡 Fs=1.18（演示）' },
        { level: 'yellow' as const, pos: riskPosition('渗滤液', k, cap), title: '▲ 渗滤液液位（演示）' },
        { level: 'red' as const, pos: riskPosition('填埋气', k, cap), title: '● CH₄ 超限（演示）' },
      ];
      sample.forEach(s => addHotspot(s.level, s.pos, s.title));
    }
    // 接入诊断数据：把 risks 转成 hotspot
    if (diagnosis?.risks?.length) {
      const k = kv(), cap = capY();
      diagnosis.risks.slice(0, 6).forEach(r => {
        const pos = riskPosition(r.category, k, cap);
        const tag = r.level === 'red' ? '●' : r.level === 'orange' ? '⚠' : r.level === 'yellow' ? '▲' : 'ℹ';
        const title = `${tag} ${r.category} · ${r.title?.slice(0, 10) ?? r.value ?? ''}`;
        addHotspot(r.level, pos, title);
      });
    }
    scene.add(hotspotGroup);
    hotspotGroup.visible = showHotspots;

    // ============== 监测数据飘字标签（A2） ==============
    const liveLabelGroup = new THREE.Group();
    function makeLiveLabel(text: string, accent: string) {
      const c = document.createElement('canvas'); c.width = 512; c.height = 128;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = 'rgba(10,18,26,0.78)';
      ctx.strokeStyle = accent; ctx.lineWidth = 2;
      const r = 22;
      ctx.beginPath();
      ctx.moveTo(8 + r, 22); ctx.arcTo(504, 22, 504, 106, r); ctx.arcTo(504, 106, 8, 106, r);
      ctx.arcTo(8, 106, 8, 22, r); ctx.arcTo(8, 22, 504, 22, r); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.font = 'bold 36px "Microsoft YaHei","PingFang SC",sans-serif';
      ctx.fillStyle = accent; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, 256, 64);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true }));
      sp.scale.set(18, 4.5, 1);
      return sp;
    }
    // 渗滤液调节池（130,0）  ·  导气井平均（堆体）  ·  地下水井（158,0）
    const liveLblLeach = makeLiveLabel('渗滤液 0.8 m', '#38bdf8');
    liveLblLeach.position.set(130 * kv(), 8, 0);
    liveLabelGroup.add(liveLblLeach);
    const liveLblGas = makeLiveLabel('CH₄ 3.2 %', '#fbbf24');
    liveLblGas.position.set(-44 * kv(), capY() + 12, 24 * kv());
    liveLabelGroup.add(liveLblGas);
    const liveLblGw = makeLiveLabel('水位 12.5 m', '#22d3ee');
    liveLblGw.position.set(158, 10, 0);
    liveLabelGroup.add(liveLblGw);
    scene.add(liveLabelGroup);
    liveLabelGroup.visible = showLiveLabels;

    // ============== 渗滤液池水波纹动画（B7） ==============
    // 给 pondWater 加自定义 uniform 驱动顶点位移 + 动态液位
    const waterUniforms = { uTime: { value: 0 }, uLevel: { value: 0.5 } };
    // 找到 pondWater（在 leachGroup 的子节点中），给它替换 material
    leachGroup.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry instanceof THREE.PlaneGeometry && (m.material as THREE.MeshStandardMaterial)?.color?.getHex() === 0x4a94bd) {
        const mat = new THREE.ShaderMaterial({
          uniforms: { uTime: waterUniforms.uTime, uLevel: waterUniforms.uLevel, uColor: { value: new THREE.Color(0x4a94bd) }, uOpacity: { value: 0.85 } },
          transparent: true,
          vertexShader: `
            uniform float uTime; uniform float uLevel;
            varying vec2 vUv;
            void main() {
              vUv = uv;
              vec3 p = position;
              // 液面高度跟随 uLevel（0..1）上下浮动
              p.y = (uv.y - 0.5) * 0.4 + uLevel * 0.4;
              float w = sin(p.x * 0.4 + uTime * 1.4) * 0.12
                      + cos(p.y * 0.5 + uTime * 1.1) * 0.10
                      + sin((p.x + p.y) * 0.7 + uTime * 2.0) * 0.06;
              p.z += w;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
            }
          `,
          fragmentShader: `
            uniform vec3 uColor; uniform float uOpacity; uniform float uLevel; uniform float uTime;
            varying vec2 vUv;
            void main() {
              vec2 c = vUv - 0.5;
              float r = length(c);
              float edge = smoothstep(0.5, 0.46, r);
              // 水面波光
              float sparkle = sin(vUv.x * 60.0 + uTime * 3.0) * sin(vUv.y * 50.0 - uTime * 2.0);
              sparkle = smoothstep(0.7, 1.0, sparkle) * 0.25;
              // 液位色阶：低=深蓝、高=绿→黄（溢出感）
              vec3 high = vec3(0.85, 0.75, 0.30);
              vec3 col = mix(uColor, high, smoothstep(0.6, 0.95, uLevel));
              col += vec3(sparkle);
              gl_FragColor = vec4(col, uOpacity * edge);
            }
          `,
        });
        m.material = mat;
      }
    });

    // ============== 风险区着色（B6 增强：堆体顶部按风险等级染色）==============
    // 在堆体顶部添加半透明风险色层（最高风险类别决定颜色）
    const riskOverlayGroup = new THREE.Group();
    {
      const k = kv(), cap = capY();
      // 根据 diagnosis 找出最严重的风险类别
      let topLevel: RiskItem['level'] | null = null;
      let topCategory = '';
      if (diagnosis?.risks?.length) {
        const order = ['red', 'orange', 'yellow', 'blue', 'green'];
        const sorted = [...diagnosis.risks].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
        if (sorted[0]) { topLevel = sorted[0].level; topCategory = sorted[0].category; }
      }
      // 染色：仅在最高风险为 红/橙/黄 时上色
      if (topLevel && ['red', 'orange', 'yellow'].includes(topLevel)) {
        const color = new THREE.Color(riskColorHex(topLevel));
        // 在堆体顶部生成一个略大的盒子代表风险扩散区
        const hx = hxAt(cap + 0.5) * 1.15;
        const hz = hzAt(cap + 0.5) * 1.15;
        const overlay = new THREE.Mesh(
          new THREE.BoxGeometry(hx * 2, 0.08, hz * 2),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
        );
        overlay.position.set(0, cap + 0.7, 0);
        riskOverlayGroup.add(overlay);
        // 风险扩散波纹（脉冲圈）
        for (let i = 0; i < 3; i++) {
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(2, 2.6, 32),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
          );
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(0, cap + 0.75, 0);
          ring.userData.phase = i * 0.6;
          ring.userData.baseColor = color;
          riskOverlayGroup.add(ring);
        }
        // 标识文字
        const lbl = makeLabel(`${topLevel === 'red' ? '●' : topLevel === 'orange' ? '⚠' : '▲'} ${topCategory} 风险区`);
        lbl.position.set(0, cap + 4, 0);
        riskOverlayGroup.add(lbl);
      }
    }
    scene.add(riskOverlayGroup);
    riskOverlayGroup.visible = showHotspots;


    // ---------------- 自定义轨道相机（旋转/平移/缩放，带阻尼） ----------------
    const ctl = {
      t: new THREE.Vector3(-30, 40, 0), dt: new THREE.Vector3(-30, 40, 0),
      r: 480, dr: 480, phi: 0.62, dphi: 0.62, theta: -2.2, dtheta: -2.2,
    };
    const el = renderer.domElement;
    const ptrs = new Map<number, { x: number; y: number; b: number }>();
    let pinchD = 0, downX = 0, downY = 0, suppressClick = false;
    let hoverX = 0, hoverY = 0, hoverDirty = false, hoverK: string | null = null;

    const onContextMenu = (e: Event) => e.preventDefault();
    const onPointerDown = (e: PointerEvent) => {
      // 巡检中任何触摸立即交还控制权
      if (roamActive) {
        stopRoamInternal();
        setRoaming(false);
        setRoamStep(null);
        setClip(false);
      }
      el.setPointerCapture(e.pointerId);
      downX = e.clientX; downY = e.clientY;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, b: e.button });
      if (ptrs.size === 2) { const p = [...ptrs.values()]; pinchD = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); }
    };
    const onPointerMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      hoverX = e.clientX - r.left; hoverY = e.clientY - r.top; hoverDirty = true;
      if (!ptrs.has(e.pointerId)) return;
      const prev = ptrs.get(e.pointerId)!;
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, b: prev.b });
      if (ptrs.size === 2) {
        const p = [...ptrs.values()]; const nd = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        if (pinchD > 0) ctl.dr = clamp(ctl.dr * pinchD / Math.max(nd, 1), 12, 1500);
        pinchD = nd; return;
      }
      if (prev.b === 0) { ctl.dtheta -= dx * 0.005; ctl.dphi = clamp(ctl.dphi - dy * 0.005, 0.06, 1.53); }
      else {
        const k = ctl.r * 0.0016;
        const fwd = new THREE.Vector3().subVectors(ctl.t, camera.position).normalize();
        const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
        const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
        ctl.dt.addScaledVector(right, -dx * k).addScaledVector(up, dy * k); // 抓取式平移（两轴手感一致）
      }
    };
    const onPointerUp = (e: PointerEvent) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinchD = 0; };
    const onWheel = (e: WheelEvent) => { e.preventDefault(); ctl.dr = clamp(ctl.dr * Math.pow(1.0015, e.deltaY), 12, 1500); };
    const onDblClick = () => { suppressClick = true; setTimeout(() => { suppressClick = false; }, 350); stopRoamInternal(); setRoaming(false); setRoamStep(null); setClip(false); view('bird'); };

    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('dblclick', onDblClick);
    window.addEventListener('pointerup', onPointerUp);

    function view(name: 'bird' | 'dam' | 'top' | 'sec') {
      if (name === 'bird') { ctl.dt.set(-30, 40, 0); ctl.dr = 480; ctl.dphi = 0.62; ctl.dtheta = -2.2; }
      if (name === 'dam') { ctl.dt.set(150, 25, 0); ctl.dr = 220; ctl.dphi = 1.12; ctl.dtheta = 0.5; }
      if (name === 'top') { ctl.dt.set(-30, 30, 0); ctl.dr = 560; ctl.dphi = 0.06; ctl.dtheta = -2.2; }
      if (name === 'sec') { ctl.dt.set(-20, 45, 0); ctl.dr = 360; ctl.dphi = 1.25; ctl.dtheta = Math.PI / 2; }
    }

    // ---------------- 半透明 / 剖切 ----------------
    function setTransparent(on: boolean) {
      wasteMesh.traverse(o => {
        const mm = o as THREE.Mesh;
        if (mm.isMesh && mm.material) {
          const mats = Array.isArray(mm.material) ? mm.material : [mm.material];
          mats.forEach(mt => {
            const sm = mt as THREE.MeshStandardMaterial;
            sm.transparent = on; sm.opacity = on ? 0.35 : 1; sm.depthWrite = !on; sm.needsUpdate = true;
          });
        }
      });
    }
    const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), -20);
    function applyClip(on: boolean, axis: 'x' | 'z', pos: number) {
      if (!on) { renderer.clippingPlanes = []; return; }
      if (axis === 'x') { clipPlane.normal.set(-1, 0, 0); }
      else { clipPlane.normal.set(0, 0, -1); }
      clipPlane.constant = pos; renderer.clippingPlanes = [clipPlane];
    }

    // ---------------- 悬停拾取 / 信息面板 / 点击详图 ----------------
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    function applyInfo(k: string | null) {
      const base = { n: '项目概况', d: estimateSite(mergedGeo).desc };
      const infoObj = k ? (INFO[k] || base) : base;
      setInfo(infoObj);
    }
    const onClick = (e: MouseEvent) => {
      if (suppressClick) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // 拖拽后松手不算点击
      if (hoverK === 'liner') setModal({ title: '场底防渗系统结构', svg: SVG_LINER });
      else if (hoverK === 'cover') setModal({ title: '终场覆盖系统结构', svg: SVG_COVER });
    };
    el.addEventListener('click', onClick);

    function doHover() {
      if (!hoverDirty) return; hoverDirty = false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      ndc.set(hoverX / r.width * 2 - 1, -(hoverY / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObjects(pickList.filter(o => o.visible), true);
      let k: string | null = null;
      if (hits.length) { let o: THREE.Object3D | null = hits[0].object; while (o) { if (o.userData && o.userData.k) { k = o.userData.k as string; break; } o = o.parent; } }
      if (k !== hoverK) {
        if (hoverK && compMats[hoverK]) compMats[hoverK].forEach(m => { if (m.emissive) m.emissive.setHex(0); });
        hoverK = k;
        applyInfo(k);
        if (k && compMats[k]) compMats[k].forEach(m => { if (m.emissive) m.emissive.setHex(0x1d3a52); });
        el.style.cursor = k ? 'pointer' : 'default';
      }
      if (hoverK && INFO[hoverK] && tipRef.current) {
        tipRef.current.style.display = 'block';
        tipRef.current.textContent = INFO[hoverK].n;
        tipRef.current.style.left = (hoverX + 14) + 'px';
        tipRef.current.style.top = (hoverY + 10) + 'px';
      } else if (tipRef.current) tipRef.current.style.display = 'none';
    }

    // ---------------- 巡检漫游 ----------------
    let roamActive = false;
    let roamNeedAdvance = false;
    let roamIdx = -1;
    let roamPhase: 'fly' | 'hold' = 'fly';
    let roamLegStart = 0;         // clock.elapsedTime（由 animate 传入）
    const roamFrom = { t: new THREE.Vector3(), r: 0, phi: 0, theta: 0 };
    const roamTo = { t: new THREE.Vector3(), r: 0, phi: 0, theta: 0 };
    let roamDuration = 3.5, roamHold = 1.6;

    function clearHighlight() {
      Object.keys(compMats).forEach(k => compMats[k].forEach(m => { if (m.emissive) m.emissive.setHex(0); }));
    }

    function snapTo(tt: THREE.Vector3, r: number, phi: number, theta: number) {
      ctl.t.copy(tt); ctl.dt.copy(tt);
      ctl.r = r; ctl.dr = r;
      ctl.phi = phi; ctl.dphi = phi;
      ctl.theta = theta; ctl.dtheta = theta;
    }

    function applyRoamStation(idx: number, wp: RoamWaypoint) {
      clearHighlight();
      if (wp.infoKey && compMats[wp.infoKey]) compMats[wp.infoKey].forEach(m => { if (m.emissive) m.emissive.setHex(0x1d3a52); });
      applyInfo(wp.infoKey);
      // 剖切联动：liner 站开剖切，其他站关闭
      if (wp.infoKey === 'liner') {
        applyClip(true, 'x', -20);
        setClip(true); setClipAxis('x'); setClipPos(-20);
      } else {
        applyClip(false, 'x', -20);
        setClip(false);
      }
      setRoamStep({ idx: idx + 1, title: wp.title, total: ROAM_WAYPOINTS.length });
    }

    function beginLeg(idx: number, t: number) {
      const wp = ROAM_WAYPOINTS[idx];
      roamFrom.t.copy(ctl.t); roamFrom.r = ctl.r; roamFrom.phi = ctl.phi; roamFrom.theta = ctl.theta;
      roamTo.t.set(wp.t[0], wp.t[1], wp.t[2]);
      roamTo.r = wp.r; roamTo.phi = wp.phi; roamTo.theta = wp.theta;
      roamDuration = wp.duration; roamHold = wp.hold;
      roamPhase = 'fly'; roamLegStart = t;
      applyRoamStation(idx, wp);
    }

    function stopRoamInternal() {
      roamActive = false;
      roamNeedAdvance = false;
      // 目标=当前，无残余阻尼追逐
      ctl.dt.copy(ctl.t); ctl.dr = ctl.r; ctl.dphi = ctl.phi; ctl.dtheta = ctl.theta;
      clearHighlight();
      applyInfo(null);
      applyClip(false, 'x', -20);
    }

    // ---------------- 对外 API ----------------
    // OGS 结果驱动状态（applyOgsResult 写入，animate 循环消费）
    let ogsSinkMeters = 0;         // 沉降可视化下沉量（已含放大系数）
    let ogsGasBoost = 0;           // 产气结果 → 火炬额外增量
    apiRef.current = {
      setLayerVisible(layer, visible) { (groups[layer] || []).forEach(o => { o.visible = visible; }); },
      setTransparent,
      applyClip,
      view,
      capturePng() {
        renderer.render(scene, camera);
        return renderer.domElement.toDataURL('image/png');
      },
      startRoaming() {
        if (roamActive) return;
        roamActive = true;
        roamIdx = -1;
        roamNeedAdvance = true;
        setRoaming(true);
      },
      stopRoaming() {
        stopRoamInternal();
        setRoaming(false);
        setRoamStep(null);
        setClip(false);
      },
      setHotspotsVisible(v) { hotspotGroup.visible = v; },
      setLiveLabelsVisible(v) { liveLabelGroup.visible = v; },
      /** 稳定化计算联动：产气结果→火炬增强；沉降结果→堆体可视化下沉（放大 60× 并在面板标注） */
      applyOgsResult(scenario, series) {
        const find = (name: string) => series.find(s => s.varName === name);
        if (scenario === 'gas-production') {
          const rate = find('ch4_rate');
          const peak = rate ? Math.max(...rate.points.map(p => p.v)) : 0;
          // 899 万m³/d 峰值 → 额外 1.2；封顶 2
          ogsGasBoost = Math.min(2, (peak / 900) * 1.2);
          setMonitoring(m => ({ ...m, ch4: Math.min(8, 3.2 + ogsGasBoost * 2.4), source: 'ogs', updatedAt: Date.now() }));
        } else if (scenario === 'settlement') {
          const disp = find('DISPLACEMENT_Y1');
          const lastM = disp ? Math.abs(disp.points[disp.points.length - 1].v) : 0;
          // 真实沉降 ~0.02 m 在 1:1 场景中不可见，放大 60×（面板已注明）
          ogsSinkMeters = Math.min(4, lastM * 60);
          setMonitoring(m => ({ ...m, source: 'ogs', updatedAt: Date.now() }));
        }
      },
    };
    if (externalApiRef) externalApiRef.current = apiRef.current;

    // ---------------- 主循环 ----------------
    const clock = new THREE.Clock();
    let rafId = 0;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;

      // 巡检漫游状态机：advance → fly（缓动插值）→ hold → advance …
      if (roamActive) {
        if (roamNeedAdvance) {
          roamIdx++;
          if (roamIdx >= ROAM_WAYPOINTS.length) {
            // 巡礼结束
            stopRoamInternal();
            setRoaming(false);
            setRoamStep(null);
            setClip(false);
          } else {
            beginLeg(roamIdx, t);
            roamNeedAdvance = false;
          }
        }
        if (roamActive && roamPhase === 'fly') {
          const p = Math.min(1, (t - roamLegStart) / roamDuration);
          const e = easeInOutCubic(p);
          const dTheta = shortestDelta(roamFrom.theta, roamTo.theta);
          const dPhi = roamTo.phi - roamFrom.phi;
          const tt = roamFrom.t.clone().lerp(roamTo.t, e);
          snapTo(tt, roamFrom.r + (roamTo.r - roamFrom.r) * e, clamp(roamFrom.phi + dPhi * e, 0.06, 1.53), roamFrom.theta + dTheta * e);
          if (p >= 1) { roamPhase = 'hold'; roamLegStart = t; }
        } else if (roamActive && roamPhase === 'hold') {
          if (t - roamLegStart >= roamHold) roamNeedAdvance = true;
        }
      }

      if (autoRotateRef.current && !roamActive) ctl.dtheta += 0.12 * dt;
      const k = 1 - Math.exp(-8 * dt);
      ctl.theta += (ctl.dtheta - ctl.theta) * k; ctl.phi += (ctl.dphi - ctl.phi) * k;
      ctl.r += (ctl.dr - ctl.r) * k; ctl.t.lerp(ctl.dt, k);
      camera.position.set(
        ctl.t.x + ctl.r * Math.sin(ctl.phi) * Math.sin(ctl.theta),
        ctl.t.y + ctl.r * Math.cos(ctl.phi),
        ctl.t.z + ctl.r * Math.sin(ctl.phi) * Math.cos(ctl.theta));
      camera.lookAt(ctl.t);
      if (flameParts.flame) {
        const ch4 = monitoringRef.current.ch4;
        // CH4 越高，火炬越大（0.5..8 → 0.7..2.2）；稳定化产气结果额外增强
        const scale = 0.7 + (ch4 / 8) * 1.5 + ogsGasBoost;
        flameParts.flame.scale.set(
          scale * (1 + 0.18 * Math.sin(t * 13)),
          scale * (1 + 0.3 * Math.sin(t * 11) + 0.15 * Math.sin(t * 29)),
          scale,
        );
      }
      // 稳定化沉降联动：堆体+覆盖整体缓慢下沉（缓动到目标，直观可见）
      {
        const cur = wasteGroup.position.y;
        const target = -ogsSinkMeters;
        if (Math.abs(cur - target) > 0.001) {
          const ny = cur + (target - cur) * Math.min(1, 2.5 * dt);
          wasteGroup.position.y = ny;
          coverGroup.position.y = ny;
        }
      }
      // 风险热点脉冲（呼吸效果）
      hotspots.forEach((hs, i) => {
        const pulse = 1 + 0.35 * Math.sin(t * 2.2 + i * 0.7);
        const child = hs.group.children[0] as THREE.Sprite;
        child.scale.set(14 * pulse, 14 * pulse, 1);
        hs.ringMat.opacity = 0.4 + 0.4 * Math.sin(t * 2.5 + i);
        // 垂直上下浮动
        hs.group.position.y = 0.6 * Math.sin(t * 1.4 + i * 0.9);
      });
      // 风险扩散波纹（脉冲圈）
      riskOverlayGroup.children.forEach(child => {
        const m = child as THREE.Mesh;
        const ud = m.userData;
        if (ud && ud.phase !== undefined) {
          const phase = (ud.phase as number);
          const r = 2 + 4.5 * ((t * 0.8 + phase) % 1.5) / 1.5;
          m.scale.setScalar(r);
          (m as THREE.Mesh<THREE.RingGeometry>).geometry = (m as THREE.Mesh<THREE.RingGeometry>).geometry;
          const mat = m.material as THREE.MeshBasicMaterial;
          mat.opacity = Math.max(0, 0.6 * (1 - (r - 2) / 4.5));
        }
      });
      // 水波动画时间 + 液位（来自监测数据）
      waterUniforms.uTime.value = t;
      // monitoring.leachateLevel 0.3..2.5m  →  uLevel 0..1
      waterUniforms.uLevel.value = Math.max(0, Math.min(1, (monitoringRef.current.leachateLevel - 0.3) / 2.0));
      doHover();
      renderer.render(scene, camera);
    };
    animate();

    // ---------------- 尺寸自适应 ----------------
    const onResize = () => {
      width = mount.clientWidth || 600;
      heightPx = mount.clientHeight || height;
      camera.aspect = width / heightPx; camera.updateProjectionMatrix();
      renderer.setSize(width, heightPx);
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    if (ro) ro.observe(mount);
    else window.addEventListener('resize', onResize);

    // ---------------- 清理 ----------------
    return () => {
      cancelAnimationFrame(rafId);
      el.removeEventListener('contextmenu', onContextMenu);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('dblclick', onDblClick);
      el.removeEventListener('click', onClick);
      window.removeEventListener('pointerup', onPointerUp);
      if (ro) ro.disconnect();
      else window.removeEventListener('resize', onResize);
      scene.traverse(obj => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach(m => m.dispose());
        }
      });
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      apiRef.current = null;
      if (externalApiRef) externalApiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, debouncedGeoKey, timeOfDay, diagnosis]);

  useEffect(() => { autoRotateRef.current = autoRotate; }, [autoRotate]);
  useEffect(() => { apiRef.current?.setHotspotsVisible?.(showHotspots); }, [showHotspots]);
  useEffect(() => { apiRef.current?.setLiveLabelsVisible?.(showLiveLabels); }, [showLiveLabels]);
  useEffect(() => {
    const onFsChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      mountRef.current?.parentElement?.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  };

  // ---------------- 事件处理 ----------------
  const onToggleLayer = (key: string, checked: boolean) => {
    setLayers(prev => ({ ...prev, [key]: checked }));
    apiRef.current?.setLayerVisible(key, checked);
  };
  const onToggleTransparent = (on: boolean) => { setTransparent(on); apiRef.current?.setTransparent(on); };
  const onToggleClip = (on: boolean) => {
    setClip(on);
    apiRef.current?.applyClip(on, clipAxis, clipPos);
  };
  const onChangeClipAxis = (axis: 'x' | 'z') => {
    setClipAxis(axis);
    if (clip) apiRef.current?.applyClip(true, axis, clipPos);
  };
  const onChangeClipPos = (pos: number) => {
    setClipPos(pos);
    if (clip) apiRef.current?.applyClip(true, clipAxis, pos);
  };
  const onView = (name: 'bird' | 'dam' | 'top' | 'sec') => {
    apiRef.current?.stopRoaming();
    if (name === 'sec') {
      setClip(true); setClipAxis('x'); setClipPos(-20);
      apiRef.current?.applyClip(true, 'x', -20);
    }
    apiRef.current?.view(name);
  };
  const onToggleRoam = () => {
    if (roaming) {
      apiRef.current?.stopRoaming();
    } else {
      apiRef.current?.startRoaming();
    }
  };

  // ---------------- 渲染 ----------------
  return (
    <div className="relative w-full overflow-hidden select-none" style={{ height, background: '#0d141a' }}>
      <div ref={mountRef} className="absolute inset-0" aria-label="山谷型生活垃圾填埋场三维模型" />

      {webglError ? (
        <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm" style={{ color: '#ff9d8a', background: '#0d141a' }}>
          {webglError}
        </div>
      ) : (
        <>
          {/* 跟随光标的提示 */}
          <div ref={tipRef} className="pointer-events-none z-30" style={{ position: 'absolute', display: 'none', background: 'rgba(8,14,20,0.88)', border: '1px solid #3a5a72', color: '#eaf4fb', fontSize: 12, padding: '3px 9px', borderRadius: 6 }} />

          {/* 左侧控制面板 */}
          {ctrlOpen ? (
            <div className="z-20" style={{ ...panelBase, top: 12, left: 12, width: 248, padding: '12px 14px', maxHeight: 'calc(100% - 24px)', overflowY: 'auto' }}>
              <div className="flex items-center justify-between mb-1">
                <h1 style={{ fontSize: 16, margin: 0, color: '#7fd4ff', letterSpacing: 0.5 }}>填埋场三维模型</h1>
                <button onClick={() => setCtrlOpen(false)} style={{ ...ctrlBtn, padding: '1px 7px', fontSize: 11 }} title="收起面板">收起</button>
              </div>
              <div style={{ fontSize: 11, color: '#9fb3bd', marginBottom: 10 }}>山谷型生活垃圾卫生填埋场 · 示意（单位：m）</div>

              <fieldset style={{ border: '1px solid rgba(255,255,255,0.10)', borderRadius: 8, margin: '0 0 10px', padding: '6px 8px 8px' }}>
                <legend style={{ fontSize: 12, color: '#8fd0a8', padding: '0 4px' }}>图层</legend>
                {LAYER_OPTIONS.map(l => (
                  <label key={l.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, lineHeight: 1.9, cursor: 'pointer', userSelect: 'none', color: '#dfe9ee' }}>
                    <input type="checkbox" checked={!!layers[l.key]} onChange={e => onToggleLayer(l.key, e.target.checked)} style={{ accentColor: '#4fc3f7' }} />
                    {l.label}
                  </label>
                ))}
              </fieldset>

              <fieldset style={{ border: '1px solid rgba(255,255,255,0.10)', borderRadius: 8, margin: '0 0 10px', padding: '6px 8px 8px' }}>
                <legend style={{ fontSize: 12, color: '#8fd0a8', padding: '0 4px' }}>内部结构</legend>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, lineHeight: 1.9, cursor: 'pointer', userSelect: 'none', color: '#dfe9ee' }}>
                  <input type="checkbox" checked={transparent} onChange={e => onToggleTransparent(e.target.checked)} style={{ accentColor: '#4fc3f7' }} />堆体半透明（透视管网/衬层）
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, lineHeight: 1.9, cursor: 'pointer', userSelect: 'none', color: '#dfe9ee' }}>
                  <input type="checkbox" checked={clip} onChange={e => onToggleClip(e.target.checked)} style={{ accentColor: '#4fc3f7' }} />剖切视图
                </label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                  <select value={clipAxis} onChange={e => onChangeClipAxis(e.target.value as 'x' | 'z')}
                    style={{ background: '#16222b', color: '#dfe9ee', border: '1px solid #33424d', borderRadius: 5, fontSize: 12, padding: '2px 4px' }}>
                    <option value="x">沿 X 轴剖切</option>
                    <option value="z">沿 Z 轴剖切</option>
                  </select>
                </div>
                <input type="range" value={clipPos} min={clipAxis === 'x' ? -260 : -240} max={clipAxis === 'x' ? 200 : 240} step={2}
                  onChange={e => onChangeClipPos(parseFloat(e.target.value))} style={{ width: '100%', accentColor: '#4fc3f7' }} />
              </fieldset>

              <fieldset style={{ border: '1px solid rgba(255,255,255,0.10)', borderRadius: 8, margin: 0, padding: '6px 8px 8px' }}>
                <legend style={{ fontSize: 12, color: '#8fd0a8', padding: '0 4px' }}>视角</legend>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {VIEW_OPTIONS.map(v => (
                    <button key={v.key} onClick={() => onView(v.key)} style={ctrlBtn}>{v.label}</button>
                  ))}
                  <button
                    onClick={onToggleRoam}
                    style={{ ...ctrlBtn, background: roaming ? '#7c2d12' : '#1d3040', borderColor: roaming ? '#b45309' : '#33566e' }}
                  >
                    {roaming ? '⏹ 停止巡检' : '▶ 巡检漫游'}
                  </button>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, lineHeight: 1.9, cursor: 'pointer', userSelect: 'none', color: '#dfe9ee', marginTop: 6 }}>
                  <input type="checkbox" checked={autoRotate} onChange={e => setAutoRotate(e.target.checked)} style={{ accentColor: '#4fc3f7' }} />自动旋转
                </label>
              </fieldset>

              <fieldset style={{ border: '1px solid rgba(255,255,255,0.10)', borderRadius: 8, margin: '10px 0 0', padding: '6px 8px 8px' }}>
                <legend style={{ fontSize: 12, color: '#8fd0a8', padding: '0 4px' }}>时辰（A3）</legend>
                <div style={{ display: 'flex', gap: 5 }}>
                  {(['day', 'dusk', 'night'] as TimeOfDay[]).map(t => (
                    <button key={t} onClick={() => setTimeOfDay(t)}
                      style={{ ...ctrlBtn, background: timeOfDay === t ? '#0e7490' : '#1d3040', borderColor: timeOfDay === t ? '#22d3ee' : '#33566e', flex: 1 }}>
                      {t === 'day' ? '☀ 日' : t === 'dusk' ? '🌅 暮' : '🌙 夜'}
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset style={{ border: '1px solid rgba(255,255,255,0.10)', borderRadius: 8, margin: '10px 0 0', padding: '6px 8px 8px' }}>
                <legend style={{ fontSize: 12, color: '#8fd0a8', padding: '0 4px' }}>场地规模（A5）</legend>
                <div style={{ display: 'flex', gap: 5 }}>
                  {GEO_PRESETS.map(p => (
                    <button key={p.key}
                      onClick={() => setLiveGeo({ ...DEFAULT_GEO, ...p.geo })}
                      style={{ ...ctrlBtn, flex: 1, fontSize: 11.5 }}>{p.label}</button>
                  ))}
                </div>
              </fieldset>

              <fieldset style={{ border: '1px solid rgba(255,255,255,0.10)', borderRadius: 8, margin: '10px 0 0', padding: '6px 8px 8px' }}>
                <legend style={{ fontSize: 12, color: '#8fd0a8', padding: '0 4px' }}>叠加层（A1/A2）</legend>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, lineHeight: 1.9, cursor: 'pointer', userSelect: 'none', color: '#dfe9ee' }}>
                  <input type="checkbox" checked={showHotspots} onChange={e => setShowHotspots(e.target.checked)} style={{ accentColor: '#4fc3f7' }} />风险热点浮标（脉动 + 标签）
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, lineHeight: 1.9, cursor: 'pointer', userSelect: 'none', color: '#dfe9ee' }}>
                  <input type="checkbox" checked={showLiveLabels} onChange={e => setShowLiveLabels(e.target.checked)} style={{ accentColor: '#4fc3f7' }} />监测数据飘字（液位 / CH₄ / 水位）
                </label>
              </fieldset>
            </div>
          ) : (
            <button onClick={() => setCtrlOpen(true)} className="z-20" style={{ ...panelBase, top: 12, left: 12, padding: '6px 12px', fontSize: 12, color: '#7fd4ff', cursor: 'pointer' }}>
              图层 / 视角 ▾
            </button>
          )}

          {/* 右侧信息面板 */}
          <div className="pointer-events-none z-20" style={{ ...panelBase, top: 12, right: 12, width: 280, padding: '12px 14px', maxHeight: 'calc(100% - 24px)', overflowY: 'auto' }}>
            <h2 style={{ fontSize: 14, margin: '0 0 6px', color: '#ffd479' }}>{info.n}</h2>
            <div style={{ fontSize: 12.5, lineHeight: 1.75, color: '#cfdbe2', whiteSpace: 'pre-line' }}>{info.d}</div>
          </div>

          {/* 微型仪表盘（A4）— 右下角实时监测 */}
          <div className="z-20" style={{ ...panelBase, bottom: 12, right: 12, padding: '10px 12px', minWidth: 200, fontSize: 11.5 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: monitoring.source === 'demo' ? '#94a3b8' : '#22d3ee', boxShadow: monitoring.source === 'demo' ? 'none' : '0 0 6px #22d3ee' }} />
              <span style={{ color: '#7fd4ff', fontWeight: 600 }}>实时态势 · LF-01</span>
              <span style={{ marginLeft: 'auto', fontSize: 9.5, padding: '1px 6px', borderRadius: 999,
                border: '1px solid ' + (monitoring.source === 'demo' ? 'rgba(148,163,184,0.5)' : 'rgba(34,211,238,0.55)'),
                color: monitoring.source === 'demo' ? '#94a3b8' : '#22d3ee' }}>
                {monitoring.source === 'diagnosis' ? 'AI 快诊' : monitoring.source === 'ogs' ? '稳定化计算' : '演示值'}
              </span>
            </div>
            {[
              { l: '边坡 Fs', v: monitoring.fs.toFixed(2), c: monitoring.fs >= 1.30 ? '#10b981' : monitoring.fs >= 1.10 ? '#ea580c' : '#dc2626' },
              { l: '渗滤液', v: monitoring.leachateLevel.toFixed(2) + ' m', c: monitoring.leachateLevel <= 1.5 ? '#10b981' : monitoring.leachateLevel <= 2.0 ? '#ea580c' : '#dc2626' },
              { l: 'CH₄', v: monitoring.ch4.toFixed(1) + ' %', c: monitoring.ch4 <= 5 ? '#10b981' : monitoring.ch4 <= 8 ? '#ea580c' : '#dc2626' },
              { l: '地下水位', v: monitoring.groundwater.toFixed(1) + ' m', c: '#38bdf8' },
            ].map(m => (
              <div key={m.l} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' }}>
                <span style={{ color: '#9fb3bd' }}>{m.l}</span>
                <span className="font-mono" style={{ color: m.c, fontWeight: 600 }}>{m.v}</span>
              </div>
            ))}
            <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#6e7d8b', fontSize: 10.5 }}>诊断 {diagnosis?.risks?.length ?? '—'} 项</span>
              <button onClick={toggleFullscreen}
                style={{ background: 'transparent', border: 'none', color: '#7fd4ff', fontSize: 10.5, cursor: 'pointer', padding: 0 }}>
                {fullscreen ? '⊗ 退出全屏' : '⛶ 全屏演示'}
              </button>
            </div>
          </div>

          {/* 巡检站点提示条（顶部中央） */}
          {roamStep && (
            <div className="pointer-events-none z-30" style={{ ...panelBase, top: 12, left: '50%', transform: 'translateX(-50%)', padding: '6px 16px', fontSize: 12.5, color: '#7fd4ff', whiteSpace: 'nowrap' }}>
              巡检中 {roamStep.idx}/{roamStep.total} · {roamStep.title}
            </div>
          )}

          {/* 底部图例 */}
          <div className="pointer-events-none z-20" style={{ ...panelBase, bottom: 12, left: 12, padding: '8px 12px', display: 'flex', flexWrap: 'wrap', gap: 10, maxWidth: 'calc(100% - 24px)' }}>
            {LEGEND_ITEMS.map(item => (
              <span key={item[1]} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: '#d5dee4' }}>
                <span style={{ width: 13, height: 13, borderRadius: 3, border: '1px solid rgba(255,255,255,0.25)', background: item[0] }} />
                {item[1]}
              </span>
            ))}
          </div>

          {/* 底部操作提示 */}
          <div className="pointer-events-none z-20" style={{ ...panelBase, bottom: 12, right: 12, padding: '6px 12px', fontSize: 11.5, color: '#9fb3bd' }}>
            左键旋转 · 右键平移 · 滚轮缩放 · 悬停查看 · 双击复位
          </div>

          {/* 结构详图弹窗 */}
          {modal && (
            <div className="absolute inset-0 z-40 flex items-center justify-center" style={{ background: 'rgba(4,8,12,0.66)' }} onClick={() => setModal(null)}>
              <div style={{ background: '#101a22', border: '1px solid #2c4254', borderRadius: 12, padding: '18px 20px', maxWidth: '92%', maxHeight: '88%', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
                <div className="flex items-start justify-between mb-2 gap-4">
                  <h3 style={{ margin: 0, color: '#7fd4ff', fontSize: 15 }}>{modal.title}</h3>
                  <button onClick={() => setModal(null)} style={{ ...ctrlBtn, flexShrink: 0 }}>关闭 ✕</button>
                </div>
                <div dangerouslySetInnerHTML={{ __html: modal.svg }} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
