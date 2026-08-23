import { useEffect, useState } from 'react';

interface Threshold {
  min?: number;
  max?: number;
  label: string;
  color: string;
}

interface ResultInterpretationProps {
  value: number;
  unit: string;
  label: string;
  thresholds: Threshold[];
  interpretation: string;
  recommendation?: string;
  reference?: string;
}

export function ResultInterpretation({
  value,
  unit,
  label,
  thresholds,
  interpretation,
  recommendation,
  reference,
}: ResultInterpretationProps) {
  const [animated, setAnimated] = useState(0);

  useEffect(() => {
    const start = performance.now();
    const dur = 800;
    function tick(now: number) {
      const p = Math.min((now - start) / dur, 1);
      setAnimated(Math.round((1 - Math.pow(1 - p, 3)) * value));
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }, [value]);

  const current = thresholds.find((t) => {
    if (t.min !== undefined && t.max !== undefined) return value >= t.min && value < t.max;
    if (t.min !== undefined) return value >= t.min;
    if (t.max !== undefined) return value < t.max;
    return false;
  }) || thresholds[thresholds.length - 1];

  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-surface)' }}>
      <div className="px-4 py-3 flex items-center justify-between" style={{ backgroundColor: current.color + '15' }}>
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{label}</span>
        <span className="text-xs px-2 py-1 rounded-full font-medium" style={{ backgroundColor: current.color + '25', color: current.color }}>
          {current.label}
        </span>
      </div>
      <div className="px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold font-mono" style={{ color: current.color }}>{animated}</span>
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{unit}</span>
        </div>
      </div>
      <div className="px-4 py-3 border-t" style={{ borderColor: 'var(--border)' }}>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{interpretation}</p>
      </div>
      {recommendation && (
        <div className="px-4 py-3 border-t" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-elevated)' }}>
          <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>建议措施</p>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{recommendation}</p>
        </div>
      )}
      {reference && (
        <div className="px-4 py-2 border-t text-xs" style={{ borderColor: 'var(--border)' }}>
          <span style={{ color: 'var(--text-muted)' }}>规范依据：</span>
          <span style={{ color: 'var(--text-secondary)' }}>{reference}</span>
        </div>
      )}
    </div>
  );
}

export default ResultInterpretation;
