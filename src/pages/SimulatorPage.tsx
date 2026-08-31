import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Boxes, RotateCcw, Camera, FileDown, MessageCircle, Link2 } from 'lucide-react';
// 常量/类型从纯模块 geo.ts 拿（不拉入 three.js）
import { DEFAULT_GEO, GEO_PRESETS, clampGeo, estimateSite, readSceneBuilt } from '../components/LandfillScene3D/geo';
import type { GeoParams, LandfillApi } from '../components/LandfillScene3D/geo';
// 组件本体懒加载（~500KB three.js）
const LandfillScene3D = lazy(() => import('../components/LandfillScene3D'));
import { buildSimSnapshotMarkdown, downloadDataUrl, downloadJSON, downloadText, timestampName } from '../utils/exporter';
import { SensorPanel } from '../components/SensorPanel';

const STORAGE_KEY = 'sim-geo-v2'; // v2: scale factor 范围重构（v1 的 10-60 m 工程值作废）

/** 跨页联动信封：AI 快诊 / 稳定化计算 / 专家对话 → 3D 场景 */
export interface SceneLink {
  kind: 'ogs';
  scenario: string;
  scenarioName?: string;
  timeSeries: Array<{ varName?: string; name?: string; points: { t: number; v: number }[] }>;
  ts: number;
}
export const SCENE_OGS_KEY = 'scene-ogs';
export function readSceneLink(): SceneLink | null {
  try {
    const raw = sessionStorage.getItem(SCENE_OGS_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(SCENE_OGS_KEY); // 读一次即消费
    return JSON.parse(raw) as SceneLink;
  } catch { return null; }
}

// slider 范围 = geo.ts clampGeo 的真实 min/max（scale factor，无量纲）
// 显示层在末尾标注等效工程值（基于 DEFAULT_GEO 的基准量）
const PARAM_FIELDS: { key: keyof GeoParams; label: string; min: number; max: number; step: number; engHint?: string }[] = [
  { key: 'pileHeight', label: '堆体最大高度 H', min: 0.5, max: 1.8, step: 0.05, engHint: '默认 ≈ 30 m · 范围 15–54 m' },
  { key: 'valleyWidth', label: '谷底宽度 B', min: 0.6, max: 1.6, step: 0.05, engHint: '默认 ≈ 110 m · 范围 66–176 m' },
  { key: 'damHeight', label: '垃圾坝高', min: 0.5, max: 2.0, step: 0.05, engHint: '默认 ≈ 8 m · 范围 4–16 m' },
  { key: 'gasWellSpacing', label: '导气井间距', min: 0.6, max: 1.5, step: 0.05, engHint: '默认 ≈ 45 m · 范围 27–68 m' },
  { key: 'pondVolume', label: '调节池容积', min: 0.4, max: 2.2, step: 0.05, engHint: '默认 ≈ 6,000 m³ · 范围 2,400–13,200 m³' },
];

function loadGeo(): GeoParams {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return clampGeo({ ...DEFAULT_GEO, ...JSON.parse(raw) });
  } catch {}
  return { ...DEFAULT_GEO };
}

export default function SimulatorPage() {
  const [geo, setGeo] = useState<GeoParams>(loadGeo);
  const sceneApi = useRef<LandfillApi | null>(null);
  const canvasWrap = useRef<HTMLDivElement>(null);
  const [canvasHeight, setCanvasHeight] = useState(640);
  const [linkInfo, setLinkInfo] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(geo)); } catch {}
  }, [geo]);

  // 消费跨页联动：AI 快诊 / 稳定化计算 / 专家对话跳转过来时注入场景
  useEffect(() => {
    const link = readSceneLink();
    if (!link) return;
    let tries = 0;
    // 场景懒加载 + 重建是异步的，轮询等 apiRef 就绪
    const timer = setInterval(() => {
      tries++;
      if (sceneApi.current) {
        clearInterval(timer);
        sceneApi.current.applyOgsResult(link.scenario, link.timeSeries ?? []);
        setLinkInfo(`已注入${link.scenarioName ?? '稳定化计算'}结果：${link.scenario === 'settlement' ? '堆体按沉降时程可视化下沉（放大 60×）' : '火炬按产气强度增强'}`);
        setTimeout(() => setLinkInfo(null), 10000);
      } else if (tries > 40) {
        clearInterval(timer);
      }
    }, 250);
    return () => clearInterval(timer);
  }, []);

  // 消费 AI 生成的 3D 场景（ChatPage buildScene 回执 → 跳转 /3d-simulator 后按生成参数重建）
  useEffect(() => {
    const built = readSceneBuilt<{
      geo?: Partial<GeoParams>;
      preset?: string;
      snapshot?: { desc?: string };
      ogSummary?: { scenario?: string; peakValue?: number; unit?: string };
    }>();
    if (!built || !built.geo) return;
    setGeo(clampGeo({ ...DEFAULT_GEO, ...built.geo }));
    const head = built.snapshot?.desc?.split('\n')[0] ?? '';
    setLinkInfo(
      `🪄 AI 已生成${built.preset && built.preset !== 'default' ? `「${built.preset}」` : ''}场景：${head}` +
      (built.ogSummary ? ` · 联动 OGS ${built.ogSummary.scenario ?? ''} 峰值 ${built.ogSummary.peakValue ?? ''}${built.ogSummary.unit ?? ''}` : '')
    );
    setTimeout(() => setLinkInfo(null), 12000);
  }, []);

  // 「询问 AI」：把当前场景参数 + 联动状态打包进对话预填
  const askAi = () => {
    const q = [
      '【来自 3D 场景的提问】',
      `当前三维填埋场参数：堆体高度 ${geo.pileHeight.toFixed(2)}×、谷底宽度 ${geo.valleyWidth.toFixed(2)}×、坝高 ${geo.damHeight.toFixed(2)}×、导气井间距 ${geo.gasWellSpacing.toFixed(2)}×、调节池容积 ${geo.pondVolume.toFixed(2)}×（均为相对默认工况的缩放系数）。`,
      `估算库容 ${estimates.volumeWanM3} 万 m³，占地 ${estimates.areaHm2} hm²。`,
      linkInfo ? `（场景已注入：${linkInfo}）` : '',
      '请结合这些参数，从边坡稳定、渗滤液、填埋气收集三方面给出工程要点。',
    ].filter(Boolean).join('\n');
    try { sessionStorage.setItem('chat-prefill', q); } catch {}
    navigate('/chat/new');
  };

  useEffect(() => {
    const el = canvasWrap.current;
    if (!el) return;
    const update = () => {
      const h = el.clientHeight;
      if (h > 240) setCanvasHeight(h);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const estimates = useMemo(() => estimateSite(geo), [geo]);

  const updateField = (key: keyof GeoParams, value: number) => {
    setGeo(prev => clampGeo({ ...prev, [key]: value }));
  };

  const applyPreset = (key: string) => {
    const preset = GEO_PRESETS.find(p => p.key === key);
    if (preset) setGeo(clampGeo({ ...DEFAULT_GEO, ...preset.geo }));
  };

  const capturePng = () => {
    const dataUrl = sceneApi.current?.capturePng();
    if (dataUrl) downloadDataUrl(timestampName('三维模拟', 'png'), dataUrl);
  };
  const exportMd = () => downloadText(timestampName('三维模拟快照', 'md'), buildSimSnapshotMarkdown(geo, estimates));
  const exportJson = () => downloadJSON(timestampName('三维模拟快照', 'json'), { params: geo, estimates });

  return (
    <div className="flex-1 overflow-hidden flex flex-col" style={{ backgroundColor: 'var(--bg-base)' }}>
      {/* 页面标题 */}
      <div className="px-6 pt-5 pb-4 border-b shrink-0" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-surface)' }}>
        <div className="flex items-center gap-2.5">
          <Boxes size={18} style={{ color: 'var(--primary)' }} />
          <div>
            <h1 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>3D 模拟</h1>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>输入工程参数，实时生成可视化三维填埋场模型</p>
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* 左侧：参数面板 */}
        <div className="w-80 flex-shrink-0 border-r overflow-y-auto p-4" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-surface)' }}>
          <div className="flex gap-1.5 mb-4">
            {GEO_PRESETS.map(p => (
              <button
                key={p.key}
                onClick={() => applyPreset(p.key)}
                className="flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors"
                style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.color = 'var(--primary)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="space-y-4">
            {PARAM_FIELDS.map(f => {
              const value = geo[f.key];
              return (
                <div key={f.key}>
                  <label className="flex items-center justify-between mb-1.5">
                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{f.label}</span>
                    <span className="text-xs font-mono" style={{ color: 'var(--primary)' }}>
                      {value.toFixed(2)}×
                    </span>
                  </label>
                  <input
                    type="range"
                    value={value}
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    onChange={e => updateField(f.key, parseFloat(e.target.value))}
                    className="w-full"
                    style={{ accentColor: 'var(--primary)' }}
                  />
                  <div className="flex justify-between mt-0.5">
                    <span className="text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>{f.min}×</span>
                    <span className="text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>{f.max}×</span>
                  </div>
                  {f.engHint && (
                    <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{f.engHint}</p>
                  )}
                </div>
              );
            })}
          </div>

          <button
            onClick={() => setGeo({ ...DEFAULT_GEO })}
            className="mt-4 w-full py-2 rounded-lg text-xs font-medium border flex items-center justify-center gap-1.5 transition-colors"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.color = 'var(--primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            <RotateCcw size={12} /> 恢复默认参数
          </button>

          <div className="mt-4 rounded-xl border p-3" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-elevated)' }}>
            <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>库容估算</p>
            <p className="text-[11px] leading-relaxed whitespace-pre-line" style={{ color: 'var(--text-secondary)' }}>{estimates.desc}</p>
          </div>
        </div>

        {/* 右侧：三维模型 + 导出工具栏 */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <div ref={canvasWrap} className="flex-1 min-h-0 overflow-hidden relative">
            <LandfillScene3D height={canvasHeight} geoParams={geo} apiRef={sceneApi} />
            {/* 实时 IoT 传感器面板：画布右上角悬浮（数字孪生"感知层"） */}
            <div className="absolute top-3 right-3 z-20 w-72 pointer-events-none">
              <div className="pointer-events-auto">
                <SensorPanel />
              </div>
            </div>
          </div>
          {linkInfo && (
            <div className="shrink-0 px-5 py-2 border-b flex items-center gap-2 text-[11px]"
                 style={{ borderColor: 'var(--border)', backgroundColor: 'rgba(16,185,129,0.08)', color: '#10b981' }}>
              <Link2 size={12} /> {linkInfo}
            </div>
          )}
          <div className="shrink-0 px-5 py-3 border-t flex items-center gap-2" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-surface)' }}>
            <span className="text-[11px] font-semibold mr-auto" style={{ color: 'var(--text-muted)' }}>
              库容 {estimates.volumeWanM3} 万 m³ · 占地 {estimates.areaHm2} hm²
            </span>
            <button
              onClick={askAi}
              className="text-[11px] px-2.5 py-1.5 rounded-lg border flex items-center gap-1 transition-colors"
              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.color = 'var(--primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
              title="把当前场景参数带入专家问答"
            >
              <MessageCircle size={12} /> 询问 AI
            </button>
            <button
              onClick={capturePng}
              className="text-[11px] px-2.5 py-1.5 rounded-lg border flex items-center gap-1 transition-colors"
              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.color = 'var(--primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
            >
              <Camera size={12} /> PNG 截图
            </button>
            <button
              onClick={exportMd}
              className="text-[11px] px-2.5 py-1.5 rounded-lg border flex items-center gap-1 transition-colors"
              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.color = 'var(--primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
            >
              <FileDown size={12} /> MD 快照
            </button>
            <button
              onClick={exportJson}
              className="text-[11px] px-2.5 py-1.5 rounded-lg border flex items-center gap-1 transition-colors"
              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.color = 'var(--primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
            >
              <FileDown size={12} /> JSON
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}