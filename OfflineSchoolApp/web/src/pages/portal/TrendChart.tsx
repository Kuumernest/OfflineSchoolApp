// web/src/pages/portal/TrendChart.tsx
//
// A child's average /20 across published results, oldest to newest. One
// series, so no legend: the card's title names it. Plain SVG (no chart
// library on a parent's slow connection), a 2px line, 10px markers with a
// surface ring, a recessive /20 grid, the latest value labelled directly, a
// tooltip on hover and keyboard focus, and the same figures as a table.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface TrendPoint { key: string; label: string; value: number }

const H = 200, PAD = { top: 16, right: 52, bottom: 30, left: 30 };
const GRID = [0, 5, 10, 15, 20];

export function TrendChart({ points }: { points: TrendPoint[] }) {
  const { t } = useTranslation();
  const [active, setActive] = useState<number | null>(null);
  // Drawn at the width it is shown at, so 11px labels stay 11px on a phone
  // rather than shrinking with a scaled-down drawing.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (points.length < 2) return null;

  const x = (i: number) => PAD.left + (i * (W - PAD.left - PAD.right)) / (points.length - 1);
  const y = (v: number) => PAD.top + ((20 - v) / 20) * (H - PAD.top - PAD.bottom);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const tip = active != null ? points[active] : null;

  return (
    <figure className="m-0">
      <div className="relative" ref={box}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full" role="img" aria-label={t("portal.resultsScreen.trendLabel")}>
          {GRID.map((g) => (
            <g key={g}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(g)} y2={y(g)} stroke="var(--color-line)" strokeWidth={1} />
              <text x={PAD.left - 8} y={y(g)} dy="0.32em" textAnchor="end" className="fill-ink-faint text-[11px]">{g}</text>
            </g>
          ))}
          {points.map((p, i) => (
            <text key={p.key} x={x(i)} y={H - 8} className="fill-ink-muted text-[11px]"
              textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>{p.label}</text>
          ))}
          <path d={path} fill="none" stroke="var(--color-primary-600)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {points.map((p, i) => (
            <g key={p.key}>
              <circle cx={x(i)} cy={y(p.value)} r={5} fill="var(--color-primary-600)" stroke="var(--color-surface)" strokeWidth={2} />
              {/* A hit area larger than the mark, reachable by keyboard. */}
              <circle cx={x(i)} cy={y(p.value)} r={18} fill="transparent" tabIndex={0}
                aria-label={`${p.label}: ${p.value.toFixed(2)}/20`}
                onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(i)} onBlur={() => setActive(null)}
                className="cursor-pointer outline-none focus-visible:stroke-primary-600" strokeWidth={2} />
            </g>
          ))}
          <text x={x(points.length - 1) + 10} y={y(last.value)} dy="0.32em" className="fill-ink text-[12px] font-semibold">
            {last.value.toFixed(2)}
          </text>
        </svg>
        {tip && active != null && (
          <div role="status" className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-control border border-line bg-surface px-2.5 py-1.5 text-xs shadow-card"
            style={{ left: `${(x(active) / W) * 100}%`, top: `${(y(tip.value) / H) * 100}%`, marginTop: -10 }}>
            <p className="font-medium text-ink">{tip.label}</p>
            <p className="tabular-nums text-ink-body">{tip.value.toFixed(2)}/20</p>
          </div>
        )}
      </div>
      <details className="mt-2 text-sm">
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-primary-700">{t("portal.resultsScreen.showTable")}</summary>
        <table className="mt-1 w-full text-left">
          <thead><tr className="text-xs text-ink-muted"><th className="py-1 font-medium">{t("portal.resultsScreen.exam")}</th><th className="py-1 text-right font-medium">{t("portal.resultsScreen.average")}</th></tr></thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.key} className="border-t border-line"><td className="py-1.5 text-ink-body">{p.label}</td><td className="py-1.5 text-right tabular-nums text-ink">{p.value.toFixed(2)}/20</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
