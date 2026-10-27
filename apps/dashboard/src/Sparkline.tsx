import { useState, type MouseEvent } from 'react';

interface Props {
  values: number[];
  times: number[];
  color: string;
  /** Accessible name, e.g. "Free drivers over the last 5 minutes". */
  label: string;
  format(v: number): string;
}

const W = 200;
const H = 40;
const PAD = 3;

/**
 * Single-series trend line for a stat tile: no axes, no legend (the tile title
 * names the series), a crosshair and value on hover.
 */
export function Sparkline({ values, times, color, label, format }: Props) {
  const [hover, setHover] = useState<number>();
  if (values.length < 2) return <div className="spark spark-empty">collecting…</div>;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => PAD + (1 - (v - min) / span) * (H - 2 * PAD);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left) / rect.width) * (values.length - 1));
    setHover(Math.max(0, Math.min(values.length - 1, i)));
  };

  const last = times[times.length - 1]!;
  return (
    <div className="spark">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: from ${format(values[0]!)} to ${format(values[values.length - 1]!)}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(undefined)}
      >
        <path d={d} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {hover !== undefined && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} className="spark-crosshair" vectorEffect="non-scaling-stroke" />
            <circle cx={x(hover)} cy={y(values[hover]!)} r={3} fill={color} className="spark-dot" vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
      {hover !== undefined && (
        <div className="spark-tip" style={{ left: `${(hover / (values.length - 1)) * 100}%` }}>
          <strong>{format(values[hover]!)}</strong> · {Math.round((last - times[hover]!) / 1000)} s ago
        </div>
      )}
    </div>
  );
}
