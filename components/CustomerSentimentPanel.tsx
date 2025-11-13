import { useMemo, useRef, useState } from "react";
import clsx from "clsx";

import type { ConversationRow, SentimentLabel, TimeWindow } from "@/types";

const SENTIMENT_ORDER: SentimentLabel[] = [
  "Delight",
  "Convenience",
  "Trust",
  "Frustration",
  "Disappointment",
  "Concern",
  "Hostility",
  "Neutral"
];

const SENTIMENT_COLORS: Record<SentimentLabel, string> = {
  Delight: "#10b981",
  Convenience: "#0ea5e9",
  Trust: "#06b6d4",
  Frustration: "#f59e0b",
  Disappointment: "#fb923c",
  Concern: "#fbbf24",
  Hostility: "#f87171",
  Neutral: "#94a3b8"
};

const RECENT_WINDOW_MS = 60 * 60 * 1000;
const LINE_RANGE_HOURS: Record<TimeWindow, number> = {
  "24h": 24,
  "7d": 7 * 24,
  "30d": 30 * 24
};

const LINE_RANGE_LABEL: Record<TimeWindow, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days"
};

type CustomerSentimentPanelProps = {
  rows: ConversationRow[];
  referenceNow: Date;
  window: TimeWindow;
};

type PieTooltip = {
  label: SentimentLabel;
  value: number;
  percent: number;
  x: number;
  y: number;
};

type LineTooltip = {
  label: SentimentLabel;
  bucket: string;
  value: number;
  x: number;
  y: number;
};

export function CustomerSentimentPanel({ rows, referenceNow, window }: CustomerSentimentPanelProps) {
  const { recentBreakdown, recentTotal } = useMemo(() => {
    const horizon = referenceNow.getTime() - RECENT_WINDOW_MS;
    const counts: Record<SentimentLabel, number> = {
      Delight: 0,
      Convenience: 0,
      Trust: 0,
      Frustration: 0,
      Disappointment: 0,
      Concern: 0,
      Hostility: 0,
      Neutral: 0
    };
    rows.forEach((row) => {
      const reference = row.endedAt ?? row.startedAt;
      if (!reference || reference.getTime() < horizon) {
        return;
      }
      const sentiment = row.customerSentimentPrimary ?? "Neutral";
      counts[sentiment] += 1;
    });
    const total = Object.values(counts).reduce((acc, value) => acc + value, 0);
    return { recentBreakdown: counts, recentTotal: total };
  }, [rows, referenceNow]);

  const timeline = useMemo(
    () => buildSentimentTimeline(rows, referenceNow, LINE_RANGE_HOURS[window]),
    [rows, referenceNow, window]
  );

  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-900/60 p-6 shadow-inner">
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-white">Customer Sentiment</h2>
        <p className="text-sm text-slate-400">
          Live mix (last 60 minutes) and hourly trends ({LINE_RANGE_LABEL[window]}).
        </p>
      </header>
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <PiePanel counts={recentBreakdown} total={recentTotal} />
        <LinePanel timeline={timeline} />
      </div>
    </section>
  );
}

function PiePanel({ counts, total }: { counts: Record<SentimentLabel, number>; total: number }) {
  const [active, setActive] = useState<SentimentLabel | null>(null);
  const [tooltip, setTooltip] = useState<PieTooltip | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  if (!total) {
    return (
      <div className="flex h-full flex-col items-center justify-center rounded-2xl border border-slate-800 bg-slate-950/50 p-4 text-sm text-slate-400">
        Not enough data in the last hour.
      </div>
    );
  }
  const segments = buildPieSegments(counts, total);

  const sortedLegend = [...SENTIMENT_ORDER]
    .map((label) => ({ label, value: counts[label] }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value / total - a.value / total);

  const showTooltip = (label: SentimentLabel, clientX: number, clientY: number) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) {
      return;
    }
    const value = counts[label] ?? 0;
    setTooltip({
      label,
      value,
      percent: total ? (value / total) * 100 : 0,
      x: clientX - bounds.left,
      y: clientY - bounds.top
    });
  };

  const hideTooltip = () => {
    setTooltip(null);
    setActive(null);
  };

  const primaryLabel = active ?? sortedLegend[0]?.label ?? "Neutral";
  const primaryValue = counts[primaryLabel] ?? 0;
  const primaryPercent = total ? (primaryValue / total) * 100 : 0;

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
      <div
        ref={containerRef}
        className="relative flex items-center justify-center"
        onMouseLeave={hideTooltip}
        onBlur={hideTooltip}
      >
        <svg
          width="180"
          height="180"
          viewBox="0 0 180 180"
          role="img"
          aria-label="Sentiment pie chart"
          className="cursor-pointer"
        >
          {segments.map((segment) => (
            <path
              key={segment.label}
              d={describeArc(90, 90, 80, segment.from, segment.to)}
              fill={segment.color}
              stroke="#0f172a"
              strokeWidth={1.5}
              opacity={!active || active === segment.label ? 1 : 0.35}
              onMouseEnter={(event) => {
                setActive(segment.label);
                showTooltip(segment.label, event.clientX, event.clientY);
              }}
              onMouseMove={(event) => showTooltip(segment.label, event.clientX, event.clientY)}
              onFocus={(event) => {
                setActive(segment.label);
                const rect = (event.target as SVGPathElement).getBoundingClientRect();
                showTooltip(segment.label, rect.left + rect.width / 2, rect.top);
              }}
              onMouseLeave={hideTooltip}
              onBlur={hideTooltip}
            />
          ))}
        </svg>
        <div className="absolute flex flex-col items-center text-center text-white">
          <span className="text-3xl font-bold">{Math.round(primaryPercent)}%</span>
          <span className="text-xs text-slate-300">{`${primaryValue} issues · ${primaryLabel}`}</span>
        </div>
        {tooltip && (
          <div
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-xl border border-white/10 bg-slate-900/95 px-3 py-2 text-xs text-white shadow-xl"
            style={{ left: `${tooltip.x}px`, top: `${tooltip.y}px` }}
          >
            <p className="font-semibold">{tooltip.label}</p>
            <p className="text-slate-300">
              {tooltip.value.toLocaleString()} issues · {Math.round(tooltip.percent)}%
            </p>
          </div>
        )}
      </div>
      <ul className="space-y-1 text-sm">
        {sortedLegend.map(({ label, value }) => (
          <li key={label} className="flex items-center justify-between text-slate-200">
            <button
              type="button"
              className="inline-flex items-center gap-2 text-left hover:text-white"
              onMouseEnter={() => setActive(label)}
              onFocus={() => setActive(label)}
              onMouseLeave={() => setActive(null)}
              onBlur={() => setActive(null)}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SENTIMENT_COLORS[label] }} />
              {label}
            </button>
            <span className="font-semibold text-white">{Math.round((value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type TimelinePoint = {
  bucketLabel: string;
  counts: Record<SentimentLabel, number>;
};

type TimelineSeries = ReturnType<typeof buildSentimentTimeline>;

function LinePanel({ timeline }: { timeline: TimelineSeries }) {
  const [tooltip, setTooltip] = useState<LineTooltip | null>(null);
  const [hiddenSeries, setHiddenSeries] = useState<SentimentLabel[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const toggleSeries = (label: SentimentLabel) => {
    setHiddenSeries((prev) =>
      prev.includes(label) ? prev.filter((entry) => entry !== label) : [...prev, label]
    );
  };

  if (!timeline.points.length) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-400">
        Sentiment timeline unavailable.
      </div>
    );
  }

  const maxCount = Math.max(1, ...timeline.points.flatMap((bucket) => Object.values(bucket.counts)));
  const width = 640;
  const height = 220;
  const padding = 20;

  const xForIndex = (index: number) => padding + (index / Math.max(1, timeline.points.length - 1)) * (width - padding * 2);
  const yForValue = (value: number) =>
    height - padding - (value / maxCount) * (height - padding * 2);

  const showTooltip = (
    event: React.MouseEvent<SVGCircleElement, MouseEvent>,
    label: SentimentLabel,
    bucket: string,
    value: number
  ) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) {
      return;
    }
    setTooltip({
      label,
      bucket,
      value,
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top
    });
  };

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
      <div className="flex flex-wrap gap-3 text-xs font-semibold text-slate-300">
        {SENTIMENT_ORDER.map((label) => {
          const hidden = hiddenSeries.includes(label);
          return (
            <button
              key={label}
              type="button"
              onClick={() => toggleSeries(label)}
              className={clsx(
                "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 transition",
                hidden
                  ? "border-slate-700 bg-slate-900/70 text-slate-500"
                  : "border-slate-700 bg-slate-900/40 text-slate-100"
              )}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{
                  backgroundColor: SENTIMENT_COLORS[label],
                  opacity: hidden ? 0.3 : 1
                }}
              />
              {label}
            </button>
          );
        })}
      </div>
      <div ref={containerRef} className="relative">
        <svg
          width="100%"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Hourly sentiment trends"
          className="text-slate-600"
          onMouseLeave={() => setTooltip(null)}
        >
          <line
            x1={padding}
            y1={height - padding}
            x2={width - padding}
            y2={height - padding}
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="4 4"
          />
          {SENTIMENT_ORDER.map((label) => {
            if (hiddenSeries.includes(label)) {
              return null;
            }
            const path = timeline.points
              .map((bucket, index) => {
                const x = xForIndex(index);
                const y = yForValue(bucket.counts[label] ?? 0);
                return `${index === 0 ? "M" : "L"}${x},${y}`;
              })
              .join(" ");
            const dimmed = tooltip && tooltip.label !== label;
            return (
              <g key={label} tabIndex={-1}>
                <path
                  d={path || ""}
                  fill="none"
                  stroke={SENTIMENT_COLORS[label]}
                  strokeWidth={dimmed ? 1.5 : 2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={dimmed ? 0.25 : 0.85}
                />
                {timeline.points.map((bucket, index) => {
                  const value = bucket.counts[label] ?? 0;
                  if (!value) {
                    return null;
                  }
                  const x = xForIndex(index);
                  const y = yForValue(value);
                  const isActive = tooltip?.label === label && tooltip?.bucket === bucket.bucketLabel;
                  return (
                    <circle
                      key={`${label}-${bucket.bucketLabel}`}
                      cx={x}
                      cy={y}
                      r={isActive ? 5 : 3.5}
                      fill={SENTIMENT_COLORS[label]}
                      className="cursor-pointer"
                      onMouseEnter={(event) => showTooltip(event, label, bucket.bucketLabel, value)}
                      onMouseMove={(event) => showTooltip(event, label, bucket.bucketLabel, value)}
                      onMouseLeave={() => setTooltip(null)}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
        {tooltip && (
          <div
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-xl border border-white/10 bg-slate-900/95 px-3 py-2 text-xs text-white shadow-xl"
            style={{ left: `${tooltip.x}px`, top: `${tooltip.y}px` }}
          >
            <p className="font-semibold">{tooltip.label}</p>
            <p className="text-slate-300">{tooltip.bucket}</p>
            <p className="text-slate-200">{tooltip.value.toLocaleString()} issues</p>
          </div>
        )}
      </div>
      <div className="flex justify-between text-xs text-slate-500">
        <span>{timeline.points[0]?.bucketLabel ?? ""}</span>
        <span>{timeline.points[timeline.points.length - 1]?.bucketLabel ?? ""}</span>
      </div>
    </div>
  );
}

function buildPieSegments(counts: Record<SentimentLabel, number>, total: number) {
  let current = 0;
  return SENTIMENT_ORDER.map((label) => {
    const value = counts[label];
    const degrees = (value / total) * 360;
    const from = current;
    const to = current + degrees;
    current = to;
    return {
      label,
      color: SENTIMENT_COLORS[label],
      from,
      to
    };
  }).filter((segment) => segment.to > segment.from);
}

function buildSentimentTimeline(rows: ConversationRow[], referenceNow: Date, totalHours: number) {
  const buckets: TimelinePoint[] = [];
  const alignedNow = alignToHour(referenceNow);
  const horizonHours = Math.max(1, totalHours);
  for (let offset = horizonHours - 1; offset >= 0; offset -= 1) {
    const bucketDate = new Date(alignedNow.getTime() - offset * 60 * 60 * 1000);
    buckets.push({
      bucketLabel: bucketDate.toISOString().slice(0, 13).replace("T", " ") + ":00",
      counts: {
        Delight: 0,
        Convenience: 0,
        Trust: 0,
        Frustration: 0,
        Disappointment: 0,
        Concern: 0,
        Hostility: 0,
        Neutral: 0
      }
    });
  }

  const horizon = alignedNow.getTime() - horizonHours * 60 * 60 * 1000;
  rows.forEach((row) => {
    const reference = row.endedAt ?? row.startedAt;
    if (!reference) {
      return;
    }
    const timestamp = reference.getTime();
    if (timestamp < horizon) {
      return;
    }
    const rawIndex = Math.floor((timestamp - horizon) / (60 * 60 * 1000));
    if (rawIndex < 0) {
      return;
    }
    const bucketIndex = Math.min(buckets.length - 1, rawIndex);
    const bucket = buckets[bucketIndex];
    if (!bucket) {
      return;
    }
    const sentiment = row.customerSentimentPrimary ?? "Neutral";
    bucket.counts[sentiment] = (bucket.counts[sentiment] ?? 0) + 1;
  });

  return { points: buckets };
}

function describeArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  return [
    "M",
    start.x,
    start.y,
    "A",
    radius,
    radius,
    0,
    largeArcFlag,
    0,
    end.x,
    end.y,
    "L",
    cx,
    cy,
    "Z"
  ].join(" ");
}

function polarToCartesian(cx: number, cy: number, radius: number, angleInDegrees: number) {
  const radians = ((angleInDegrees - 90) * Math.PI) / 180.0;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians)
  };
}

function alignToHour(date: Date): Date {
  const copy = new Date(date);
  copy.setMinutes(0, 0, 0);
  return copy;
}
