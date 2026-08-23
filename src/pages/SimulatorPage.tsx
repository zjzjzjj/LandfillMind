import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, RotateCcw, Camera, FileDown } from 'lucide-react';
// 常量/类型从纯模块 geo.ts 拿（不拉入 three.js）
import { DEFAULT_GEO, GEO_PRESETS, clampGeo, estimateSite } from '../components/LandfillScene3D/geo';
import type { GeoParams, LandfillApi } from '../components/LandfillScene3D/geo';
// 组件本体懒加载（~500KB three.js）
const LandfillScene3D = lazy(() => import('../components/LandfillScene3D'));
import { buildSimSnapshotMarkdown, downloadDataUrl, downloadJSON, downloadText, timestampName } from '../utils/exporter';

const STORAGE_KEY = 'sim-geo-v2'; // v2: scale factor 范围重构（v1 的 10-60 m 工程值作废）

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

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(geo)); } catch {}
  }, [geo]);

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
          <div ref={canvasWrap} className="flex-1 min-h-0 overflow-hidden">
            <LandfillScene3D height={canvasHeight} geoParams={geo} apiRef={sceneApi} />
          </div>
          <div className="shrink-0 px-5 py-3 border-t flex items-center gap-2" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-surface)' }}>
            <span className="text-[11px] font-semibold mr-auto" style={{ color: 'var(--text-muted)' }}>
              库容 {estimates.volumeWanM3} 万 m³ · 占地 {estimates.areaHm2} hm²
            </span>
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