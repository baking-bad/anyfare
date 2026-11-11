'use client';

import { useEffect, useRef, useState } from 'react';

import { count, usd } from '../format';

export interface BarChartPoint {
  // The value of the bar
  readonly value: number;
  // What the browser's tooltip says next to the value, such as a date
  readonly label: string;
  // A short label under the bar. Ones that would touch are skipped.
  readonly tick?: string;
  readonly tone?: 'default' | 'dim' | 'near';
}

// The smallest "nice" number at or above the value: 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 times a power of ten
const niceMax = (value: number): number => {
  const power = 10 ** Math.floor(Math.log10(value || 1));
  const n = value / power;

  return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(step => n <= step) ?? 10) * power;
};

const compact = (value: number): string => value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${+(value / 1_000).toFixed(1)}k` : `${+value.toFixed(2)}`;

const useWidth = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element)
      return undefined;
    setWidth(Math.round(element.clientWidth));
    const observer = new ResizeObserver(() => setWidth(Math.round(element.clientWidth)));
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
};

/**
 * A bar chart, one series, drawn in SVG at the width of its box. `unit` picks how values read: `count` or
 * `usd`. Every bar has a tooltip (its `label` and value). An empty series, or all zeros, draws the empty
 * frame: the base line and two grid lines. `label` names the chart for screen readers.
 */
export const BarChart = ({ data, unit = 'count', height = 200, label }: {
  readonly data: readonly BarChartPoint[];
  readonly unit?: 'count' | 'usd';
  readonly height?: number;
  readonly label: string;
}) => {
  const [ref, measured] = useWidth();
  const width = Math.max(240, measured);
  const padLeft = 40;
  const padBottom = 24;
  const padTop = 8;
  const empty = data.every(point => point.value <= 0);
  const max = empty ? 1 : niceMax(Math.max(...data.map(point => point.value)));
  const slot = data.length > 0 ? (width - padLeft) / data.length : 0;
  const gap = Math.max(2, slot * 0.28);
  const format = unit === 'usd' ? usd : count;
  const axis = (value: number): string => unit === 'usd' ? `$${compact(value)}` : compact(value);
  const y = (value: number): number => padTop + (height - padTop - padBottom) * (1 - value / max);
  let lastTick = -1e9;

  return (
    <div ref={ref} className="chart">
      {measured === 0 ? <div className="chart-pending" aria-hidden="true" /> : (
        <svg viewBox={`0 0 ${width} ${height}`} height={height} role="img" aria-label={label}>
          {[0, 0.5, 1].map(fraction => (
            <g key={fraction}>
              <line className={fraction === 0 ? 'base-line' : 'grid-line'} x1={padLeft} x2={width} y1={y(max * fraction)} y2={y(max * fraction)} />
              {empty && fraction > 0 ? null : <text className="axis" x={padLeft - 8} y={y(max * fraction) + 4} textAnchor="end">{empty ? '0' : axis(max * fraction)}</text>}
            </g>
          ))}
          {data.map((point, i) => {
            const x = padLeft + i * slot + gap / 2;
            const w = slot - gap;
            const top = y(Math.max(0, point.value));
            const h = Math.max(0, y(0) - top);
            const r = Math.min(4, w / 2, h);
            const path = h > 0 ? `M${x},${y(0)}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${y(0)}Z` : '';
            const center = x + w / 2;
            const showTick = point.tick !== undefined && center - lastTick >= 44;
            if (showTick)
              lastTick = center;

            return (
              <g key={i} className="col">
                <title>{`${point.label}: ${format(point.value)}`}</title>
                <rect className="hit" x={padLeft + i * slot} y={padTop} width={slot} height={height - padTop - padBottom} />
                <path className={point.tone && point.tone !== 'default' ? `bar ${point.tone}` : 'bar'} d={path} />
                {showTick ? <text className="axis" x={center} y={height - 6} textAnchor="middle">{point.tick}</text> : null}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
};
