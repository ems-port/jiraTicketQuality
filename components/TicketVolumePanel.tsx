import { useMemo, useRef, useState } from "react";

import type { ConversationRow, TimeWindow } from "@/types";

const WINDOW_LABELS: Record<TimeWindow, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days"
};

const WINDOW_DURATION_MS: Record<TimeWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000
};

type TicketVolumePanelProps = {
  rows: ConversationRow[];
  window: TimeWindow;
  referenceNow: Date;
};

type VolumePoint = {
  label: string;
  count: number;
  timestamp: number;
};

export function TicketVolumePanel({ rows, window, referenceNow }: TicketVolumePanelProps) {
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const bucketMinutes = resolveBucketMinutes(window);
  const { points, maxCount } = useMemo(
    () => buildVolumeSeries(rows, window, referenceNow, bucketMinutes),
    [rows, window, referenceNow, bucketMinutes]
  );

  const width = 640;
  const height = 220;
  const padding = 32;
  const xForIndex = (index: number) =>
    points.length <= 1
      ? padding
      : padding + (index / (points.length - 1)) * (width - padding * 2);
  const yForCount = (value: number) =>
    height - padding - (value / Math.max(1, maxCount)) * (height - padding * 2);

  const linePath = useMemo(() => buildPath(points, xForIndex, yForCount), [points]);
  const yTicks = useMemo(() => buildYAxisTicks(maxCount), [maxCount]);

  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-900/60 p-6 shadow-inner">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">Ticket Volume</h2>
          <p className="text-sm text-slate-400">
            Total conversations per {bucketMinutes}-minute bucket ({WINDOW_LABELS[window]}).
          </p>
        </div>
      </header>
      {points.length ? (
        <div ref={containerRef} className="relative mt-4">
          <svg
            ref={svgRef}
            width="100%"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label="Ticket volume line chart"
            className="text-slate-500"
            onMouseLeave={() => setHover(null)}
          >
            <line
              x1={padding}
              y1={height - padding}
              x2={width - padding}
              y2={height - padding}
              stroke="currentColor"
              strokeWidth="1"
            />
            <line
              x1={padding}
              y1={padding}
              x2={padding}
              y2={height - padding}
              stroke="currentColor"
              strokeWidth="1"
            />
            {yTicks.map((tick) => (
              <g key={tick}>
                <line
                  x1={padding}
                  x2={width - padding}
                  y1={yForCount(tick)}
                  y2={yForCount(tick)}
                  stroke="currentColor"
                  strokeWidth={0.5}
                  strokeDasharray="4 4"
                  opacity={0.3}
                />
                <text
                  x={padding - 8}
                  y={yForCount(tick)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-current text-[10px]"
                >
                  {tick.toLocaleString()}
                </text>
              </g>
            ))}
            <path d={linePath} fill="none" stroke="#60a5fa" strokeWidth={2} />
            <path
              d={`${linePath} L ${xForIndex(points.length - 1)} ${height - padding} L ${xForIndex(0)} ${height - padding} Z`}
              fill="url(#volumeFill)"
              opacity={0.25}
            />
            <defs>
              <linearGradient id="volumeFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.5" />
                <stop offset="100%" stopColor="#60a5fa" stopOpacity="0" />
              </linearGradient>
            </defs>
            {points.map((point, index) => {
              const cx = xForIndex(index);
              const cy = yForCount(point.count);
              const updateHover = () => {
                const svgBounds = svgRef.current?.getBoundingClientRect();
                const containerBounds = containerRef.current?.getBoundingClientRect();
                if (!svgBounds || !containerBounds) {
                  setHover({
                    index,
                    x: cx,
                    y: cy
                  });
                  return;
                }
                const scaleX = svgBounds.width / width;
                const scaleY = svgBounds.height / height;
                const x = (cx * scaleX) + (svgBounds.left - containerBounds.left);
                const y = (cy * scaleY) + (svgBounds.top - containerBounds.top);
                setHover({ index, x, y });
              };
              return (
                <g key={point.timestamp}>
                  <circle
                    cx={cx}
                    cy={cy}
                    r={hover?.index === index ? 5 : 3}
                    fill="#93c5fd"
                    stroke="#0f172a"
                    strokeWidth={1}
                    onMouseEnter={updateHover}
                    onMouseMove={updateHover}
                    onFocus={updateHover}
                    onBlur={() => setHover(null)}
                  />
                </g>
              );
            })}
          </svg>
          {hover && points[hover.index] && (
            <div
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-full -mt-2 rounded-xl border border-slate-800 bg-slate-900/95 px-3 py-2 text-xs text-white shadow-xl"
              style={{ left: `${hover.x}px`, top: `${hover.y}px` }}
            >
              <p className="font-semibold">{points[hover.index].label}</p>
              <p>{points[hover.index].count.toLocaleString()} tickets</p>
            </div>
          )}
          <div className="mt-2 flex justify-between text-xs text-slate-500">
            <span>{points[0]?.label ?? ""}</span>
            <span>{points[points.length - 1]?.label ?? ""}</span>
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-4 text-sm text-slate-400">
          Not enough ticket data for this window.
        </div>
      )}
    </section>
  );
}

function buildVolumeSeries(
  rows: ConversationRow[],
  window: TimeWindow,
  referenceNow: Date,
  bucketMinutes: number
): { points: VolumePoint[]; maxCount: number } {
  const bucketMs = Math.max(1, bucketMinutes) * 60 * 1000;
  const duration = WINDOW_DURATION_MS[window];
  const endTime = referenceNow.getTime();
  const startTime = endTime - duration;
  const alignedStart = Math.floor(startTime / bucketMs) * bucketMs;
  const alignedEnd = Math.ceil(endTime / bucketMs) * bucketMs;
  const buckets: VolumePoint[] = [];

  for (let ts = alignedStart; ts <= alignedEnd; ts += bucketMs) {
    buckets.push({
      label: formatBucketLabel(ts),
      count: 0,
      timestamp: ts
    });
  }

  rows.forEach((row) => {
    const reference = row.endedAt ?? row.startedAt;
    if (!reference) {
      return;
    }
    const ts = reference.getTime();
    if (ts < alignedStart || ts > alignedEnd) {
      return;
    }
    const bucketIndex = Math.min(
      buckets.length - 1,
      Math.max(0, Math.floor((ts - alignedStart) / bucketMs))
    );
    buckets[bucketIndex].count += 1;
  });

  const maxCount = buckets.reduce((max, point) => Math.max(max, point.count), 0);
  return { points: buckets, maxCount };
}

function resolveBucketMinutes(window: TimeWindow): number {
  if (window === "24h") {
    return 15;
  }
  if (window === "7d") {
    return 60;
  }
  return 24 * 60;
}

function buildPath(
  points: VolumePoint[],
  xForIndex: (index: number) => number,
  yForCount: (value: number) => number
): string {
  if (!points.length) {
    return "";
  }
  return points
    .map((point, index) => {
      const prefix = index === 0 ? "M" : "L";
      return `${prefix}${xForIndex(index)} ${yForCount(point.count)}`;
    })
    .join(" ");
}

function formatBucketLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[date.getUTCMonth()];
  const day = date.getUTCDate();
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  return `${month} ${day} · ${hours}:${minutes} UTC`;
}

function buildYAxisTicks(maxCount: number): number[] {
  if (maxCount <= 0) {
    return [0];
  }
  const tickCount = 4;
  const step = Math.max(1, Math.ceil(maxCount / tickCount));
  const ticks: number[] = [];
  for (let value = 0; value <= maxCount; value += step) {
    ticks.push(value);
  }
  if (ticks[ticks.length - 1] !== maxCount) {
    ticks.push(maxCount);
  }
  return ticks;
}
