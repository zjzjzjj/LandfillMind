/**
 * 风险地图组件 - 可视化展示填埋场风险区域
 */

import { useRef, useEffect, useState } from 'react';

export type RiskLevel = 'red' | 'orange' | 'yellow' | 'blue' | 'green';

interface RiskZone {
  id: string;
  label: string;
  level: RiskLevel;
  x: number;      // 0-100 百分比
  y: number;      // 0-100 百分比
  radius: number; // 0-100 百分比
  description?: string;
}

interface EscapeRoute {
  id: string;
  label: string;
  color: string;
  points: { x: number; y: number }[];
}

interface RiskMapProps {
  zones: RiskZone[];
  routes?: EscapeRoute[];
  siteName?: string;
  workerLocation?: { x: number; y: number };
  width?: number;
  height?: number;
}

const RISK_COLORS: Record<RiskLevel, string> = {
  red: 'rgba(220, 38, 38, 0.3)',
  orange: 'rgba(234, 88, 12, 0.3)',
  yellow: 'rgba(202, 138, 4, 0.3)',
  blue: 'rgba(37, 99, 235, 0.3)',
  green: 'rgba(22, 163, 74, 0.3)',
};

const RISK_BORDER_COLORS: Record<RiskLevel, string> = {
  red: '#dc2626',
  orange: '#ea580c',
  yellow: '#ca8a04',
  blue: '#2563eb',
  green: '#16a34a',
};

export function RiskMap({ 
  zones, 
  routes = [], 
  siteName = '填埋场作业区',
  workerLocation,
  width = 600,
  height = 400 
}: RiskMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredZone, setHoveredZone] = useState<RiskZone | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);
    drawGrid(ctx, width, height);
    drawSiteBoundary(ctx, width, height);
    zones.forEach(zone => drawRiskZone(ctx, zone, width, height));
    routes.forEach(route => drawEscapeRoute(ctx, route, width, height));

    if (workerLocation) {
      drawWorkerIcon(ctx, workerLocation.x, workerLocation.y, width, height);
    }

    drawLegend(ctx, width, height);

  }, [zones, routes, workerLocation, width, height]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    const found = zones.find(zone => {
      const dx = x - zone.x;
      const dy = y - zone.y;
      return Math.sqrt(dx * dx + dy * dy) <= zone.radius;
    });

    setHoveredZone(found || null);
  };

  return (
    <div className="relative inline-block">
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredZone(null)}
        className="border rounded-lg"
        style={{ borderColor: 'var(--border)', cursor: 'crosshair' }}
      />
      
      {hoveredZone && (
        <div 
          className="absolute bg-white px-3 py-2 rounded shadow-lg text-sm pointer-events-none"
          style={{ 
            left: '50%', 
            bottom: '10px', 
            transform: 'translateX(-50%)',
            zIndex: 10
          }}
        >
          <div className="font-semibold">{hoveredZone.label}</div>
          {hoveredZone.description && (
            <div className="text-xs text-gray-500">{hoveredZone.description}</div>
          )}
        </div>
      )}
    </div>
  );
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 0.5;
  
  for (let x = 0; x <= width; x += 50) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  
  for (let y = 0; y <= height; y += 50) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

function drawSiteBoundary(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const padding = 30;
  ctx.strokeStyle = '#374151';
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 5]);
  ctx.strokeRect(padding, padding, width - padding * 2, height - padding * 2);
  ctx.setLineDash([]);
  
  ctx.fillStyle = '#374151';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('场地边界', width / 2, 20);
}

function drawRiskZone(
  ctx: CanvasRenderingContext2D, 
  zone: RiskZone, 
  width: number, 
  height: number
) {
  const x = (zone.x / 100) * width;
  const y = (zone.y / 100) * height;
  const r = (zone.radius / 100) * Math.min(width, height);

  ctx.fillStyle = RISK_COLORS[zone.level];
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = RISK_BORDER_COLORS[zone.level];
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#1f2937';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(zone.label, x, y + 4);
}

function drawEscapeRoute(
  ctx: CanvasRenderingContext2D, 
  route: EscapeRoute, 
  width: number, 
  height: number
) {
  if (route.points.length < 2) return;

  ctx.strokeStyle = route.color;
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 4]);
  
  ctx.beginPath();
  const first = route.points[0];
  ctx.moveTo((first.x / 100) * width, (first.y / 100) * height);
  
  route.points.slice(1).forEach(point => {
    ctx.lineTo((point.x / 100) * width, (point.y / 100) * height);
  });
  
  ctx.stroke();
  ctx.setLineDash([]);

  const last = route.points[route.points.length - 1];
  const prev = route.points[route.points.length - 2];
  drawArrow(
    ctx,
    (prev.x / 100) * width,
    (prev.y / 100) * height,
    (last.x / 100) * width,
    (last.y / 100) * height,
    route.color
  );

  ctx.fillStyle = route.color;
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    route.label,
    (last.x / 100) * width,
    (last.y / 100) * height - 10
  );
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  color: string
) {
  const headLen = 15;
  const angle = Math.atan2(toY - fromY, toX - fromX);

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - headLen * Math.cos(angle - Math.PI / 6),
    toY - headLen * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    toX - headLen * Math.cos(angle + Math.PI / 6),
    toY - headLen * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fill();
}

function drawWorkerIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number
) {
  const px = (x / 100) * width;
  const py = (y / 100) * height;

  ctx.fillStyle = 'rgba(59, 130, 246, 0.2)';
  ctx.beginPath();
  ctx.arc(px, py, 20, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#3b82f6';
  ctx.beginPath();
  ctx.arc(px, py, 8, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('👤', px, py + 4);

  ctx.fillStyle = '#1e40af';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText('您的位置', px, py - 15);
}

function drawLegend(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const legendX = width - 120;
  const legendY = height - 100;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fillRect(legendX - 10, legendY - 10, 130, 95);
  ctx.strokeStyle = '#d1d5db';
  ctx.strokeRect(legendX - 10, legendY - 10, 130, 95);

  const items: { level: RiskLevel; label: string }[] = [
    { level: 'red', label: '高风险' },
    { level: 'orange', label: '较大风险' },
    { level: 'yellow', label: '一般风险' },
    { level: 'blue', label: '关注' },
    { level: 'green', label: '安全' },
  ];

  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';

  items.forEach((item, i) => {
    const y = legendY + i * 16;
    
    ctx.fillStyle = RISK_COLORS[item.level];
    ctx.fillRect(legendX, y, 12, 12);
    ctx.strokeStyle = RISK_BORDER_COLORS[item.level];
    ctx.strokeRect(legendX, y, 12, 12);

    ctx.fillStyle = '#374151';
    ctx.fillText(item.label, legendX + 18, y + 10);
  });
}
