import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import clsx from "clsx";

import { computeContactReasonSummary, filterByWindow, normaliseRows } from "@/lib/metrics";
import type { ContactReasonSummary, ConversationRow, TimeWindow } from "@/types";

type Aggregation = "hourly" | "daily";

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

const BUCKET_MS: Record<Aggregation, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000
};

const AGGREGATION_LABELS: Record<Aggregation, string> = {
  hourly: "Hourly",
  daily: "Daily"
};

const REASON_COLORS = [
  "#60a5fa",
  "#fbbf24",
  "#f472b6",
  "#34d399",
  "#f97316",
  "#a78bfa",
  "#22d3ee",
  "#c084fc",
  "#fca5a5",
  "#4ade80"
];

type Bucket = {
  key: string;
  label: string;
  timestamp: number;
};

type ChartSeries = {
  reason: string;
  color: string;
  points: { key: string; value: number }[];
  total: number;
};

export default function ContactReasonAnalyticsPage() {
  const router = useRouter();
  const initialReason = useMemo(() => {
    const reasonQuery = router.query.reason;
    if (typeof reasonQuery === "string" && reasonQuery.trim()) {
      return decodeURIComponent(reasonQuery);
    }
    return null;
  }, [router.query.reason]);
  const initialWindow = useMemo<TimeWindow | null>(() => {
    const raw = router.query.window;
    if (raw === "24h" || raw === "7d" || raw === "30d") {
      return raw;
    }
    return null;
  }, [router.query.window]);
  const initialHub = useMemo(() => {
    const raw = router.query.hub;
    if (typeof raw === "string" && raw.trim()) {
      return decodeURIComponent(raw);
    }
    if (Array.isArray(raw) && raw[0] && typeof raw[0] === "string") {
      return decodeURIComponent(raw[0]);
    }
    return null;
  }, [router.query.hub]);
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedWindow, setSelectedWindow] = useState<TimeWindow>(initialWindow ?? "7d");
  const [aggregation, setAggregation] = useState<Aggregation>(initialWindow === "24h" ? "hourly" : "daily");
  const [selectedHubs, setSelectedHubs] = useState<string[]>([]);
  const [selectedReasons, setSelectedReasons] = useState<string[]>(initialReason ? [initialReason] : []);
  const [referenceNow, setReferenceNow] = useState(() => new Date());

  useEffect(() => {
    setAggregation(selectedWindow === "24h" ? "hourly" : "daily");
  }, [selectedWindow]);

  useEffect(() => {
    if (initialWindow && initialWindow !== selectedWindow) {
      setSelectedWindow(initialWindow);
    }
  }, [initialWindow, selectedWindow]);

  useEffect(() => {
    if (initialReason && !selectedReasons.length) {
      setSelectedReasons([initialReason]);
    }
  }, [initialReason, selectedReasons.length]);

  useEffect(() => {
    if (initialHub && !selectedHubs.length) {
      setSelectedHubs([initialHub]);
    }
  }, [initialHub, selectedHubs.length]);

  useEffect(() => {
    const loadOnlineData = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/conversations");
        if (!response.ok) {
          throw new Error(`Failed to load online data (${response.status})`);
        }
        const payload = await response.json();
        const rawRows: Record<string, unknown>[] = payload.rows ?? [];
        const normalised = normaliseRows(rawRows as Record<string, string | number | boolean | null>[]);
        setRows(normalised);
        setReferenceNow(new Date());
      } catch (err) {
        setError((err as Error).message ?? "Unable to load conversations.");
      } finally {
        setLoading(false);
      }
    };
    void loadOnlineData();
  }, []);

  const hubOptions = useMemo(() => {
    const hubs = new Set<string>();
    rows.forEach((row) => {
      hubs.add((row.hub ?? "Unassigned").trim() || "Unassigned");
    });
    return Array.from(hubs).sort();
  }, [rows]);

  const hubFilteredRows = useMemo(() => {
    if (!selectedHubs.length) {
      return rows;
    }
    return rows.filter((row) => selectedHubs.includes((row.hub ?? "Unassigned").trim() || "Unassigned"));
  }, [rows, selectedHubs]);

  const windowedRows = useMemo(
    () => filterByWindow(hubFilteredRows, selectedWindow, referenceNow),
    [hubFilteredRows, selectedWindow, referenceNow]
  );

  const reasonSummary: ContactReasonSummary = useMemo(
    () => computeContactReasonSummary(windowedRows, selectedWindow, referenceNow, 50),
    [windowedRows, selectedWindow, referenceNow]
  );

  useEffect(() => {
    if (!selectedReasons.length && reasonSummary.entries.length) {
      const top = reasonSummary.entries.slice(0, Math.min(5, reasonSummary.entries.length)).map((entry) => entry.reason);
      setSelectedReasons(top);
    }
  }, [reasonSummary.entries, selectedReasons.length]);

  const { buckets, chartSeries, maxValue } = useMemo(
    () =>
      buildReasonSeries({
        rows: windowedRows,
        reasons: selectedReasons,
        window: selectedWindow,
        aggregation,
        referenceNow
      }),
    [windowedRows, selectedReasons, selectedWindow, aggregation, referenceNow]
  );

  const previousRangeRows = useMemo(() => {
    const duration = WINDOW_DURATION_MS[selectedWindow];
    const bucketMs = BUCKET_MS[aggregation];
    const alignedEnd = alignToBucket(referenceNow, bucketMs).getTime();
    const start = alignedEnd - bucketMs * (buckets.length - 1);
    const prevStart = start - duration;
    return filterRowsByRange(hubFilteredRows, prevStart, start);
  }, [hubFilteredRows, selectedWindow, aggregation, buckets.length, referenceNow]);

  const currentSelectedCount = useMemo(() => {
    if (!selectedReasons.length) {
      return windowedRows.length;
    }
    return windowedRows.filter((row) => selectedReasons.includes(resolveReasonLabel(row))).length;
  }, [windowedRows, selectedReasons]);

  const previousSelectedCount = useMemo(() => {
    if (!selectedReasons.length) {
      return previousRangeRows.length;
    }
    return previousRangeRows.filter((row) => selectedReasons.includes(resolveReasonLabel(row))).length;
  }, [previousRangeRows, selectedReasons]);

  const reasonDeltaStats = useMemo(
    () =>
      buildReasonDeltaStats({
        currentRows: windowedRows,
        previousRows: previousRangeRows
      }),
    [windowedRows, previousRangeRows]
  );

  const reasonColorMap = useMemo(() => {
    const map = new Map<string, string>();
    selectedReasons.forEach((reason, index) => {
      const color = REASON_COLORS[index % REASON_COLORS.length];
      map.set(reason, color);
    });
    return map;
  }, [selectedReasons]);

  const selectedHubLabel =
    !selectedHubs.length || selectedHubs.length === hubOptions.length
      ? "All hubs"
      : `${selectedHubs.length} hub${selectedHubs.length === 1 ? "" : "s"}`;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-4 rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-900 via-slate-950 to-slate-950 p-6 shadow-xl">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/"
                className="rounded-full border border-slate-800 px-3 py-1 text-xs font-semibold text-slate-300 transition hover:border-brand-400 hover:text-brand-100"
              >
                ← Back to dashboard
              </Link>
              <div>
                <h1 className="text-2xl font-bold text-white">Contact Reason Analytics</h1>
                <p className="text-sm text-slate-400">
                  Drill into top contact reasons with flexible aggregation, hubs, and per-series controls.
                </p>
              </div>
            </div>
            <div className="flex flex-col items-end text-right">
              <span className="text-xs text-slate-400">{WINDOW_LABELS[selectedWindow]}</span>
              <span className="text-[11px] uppercase tracking-wide text-slate-500">{AGGREGATION_LABELS[aggregation]} buckets</span>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <SummaryStat
              label="Tickets in view"
              value={currentSelectedCount}
              previous={previousSelectedCount}
            />
            <SummaryStat label="Active reasons" value={selectedReasons.length || reasonSummary.entries.length} />
            <SummaryStat label="Hubs" value={selectedHubLabel} />
          </div>
        </header>

        <section className="rounded-3xl border border-slate-800 bg-slate-900/60 p-5 shadow-inner">
          <FiltersRow
            selectedWindow={selectedWindow}
            onWindowChange={setSelectedWindow}
            aggregation={aggregation}
            onAggregationChange={setAggregation}
            hubOptions={hubOptions}
            selectedHubs={selectedHubs}
            onHubToggle={(hub) => toggleHub(hub, selectedHubs, setSelectedHubs)}
            onClearHubs={() => setSelectedHubs([])}
          />
          <ReasonSelector
            summary={reasonSummary}
            selectedReasons={selectedReasons}
            onToggle={(reason) => toggleReason(reason, selectedReasons, setSelectedReasons)}
            onClear={() => setSelectedReasons([])}
          />
        </section>

        <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 shadow-inner">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-white">Trend by contact reason</h2>
              <p className="text-sm text-slate-400">
                {AGGREGATION_LABELS[aggregation]} buckets · {WINDOW_LABELS[selectedWindow]} · {selectedHubLabel}
              </p>
            </div>
            <Legend
              reasons={selectedReasons}
              colorMap={reasonColorMap}
              onToggle={(reason) => toggleReason(reason, selectedReasons, setSelectedReasons)}
            />
          </header>
          <div className="mt-4">
            <MultiSeriesChart buckets={buckets} series={chartSeries} maxValue={maxValue} loading={loading} error={error} />
          </div>
        </section>

        <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 shadow-inner">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-white">Reason leaderboard</h2>
              <p className="text-sm text-slate-400">Top reasons with volume, change vs previous window, and top hub.</p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedReasons(reasonSummary.entries.slice(0, Math.min(8, reasonSummary.entries.length)).map((entry) => entry.reason))}
              className="rounded-full border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:border-brand-400 hover:text-brand-100"
            >
              Select top reasons
            </button>
          </header>
          <ReasonTable
            summary={reasonSummary}
            deltas={reasonDeltaStats}
            onToggle={(reason) => toggleReason(reason, selectedReasons, setSelectedReasons)}
            selectedReasons={selectedReasons}
          />
        </section>

        <section className="rounded-3xl border border-slate-800 bg-slate-900/60 p-5 shadow-inner">
          <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-white">Small multiples</h2>
              <p className="text-sm text-slate-400">Quick scan of trend shape per reason. Click to focus.</p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedReasons([])}
              className="rounded-full border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:border-brand-400 hover:text-brand-100"
            >
              Clear selection
            </button>
          </header>
          <SmallMultiples
            summary={reasonSummary}
            selectedReasons={selectedReasons}
            onToggle={(reason) => toggleReason(reason, selectedReasons, setSelectedReasons)}
            aggregation={aggregation}
          />
        </section>
      </div>
    </main>
  );
}

function FiltersRow({
  selectedWindow,
  onWindowChange,
  aggregation,
  onAggregationChange,
  hubOptions,
  selectedHubs,
  onHubToggle,
  onClearHubs
}: {
  selectedWindow: TimeWindow;
  onWindowChange: (window: TimeWindow) => void;
  aggregation: Aggregation;
  onAggregationChange: (aggregation: Aggregation) => void;
  hubOptions: string[];
  selectedHubs: string[];
  onHubToggle: (hub: string) => void;
  onClearHubs: () => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-400">Time window</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {(["24h", "7d", "30d"] as TimeWindow[]).map((window) => (
            <button
              key={window}
              type="button"
              onClick={() => onWindowChange(window)}
              className={clsx(
                "rounded-full border px-3 py-1 text-sm font-semibold transition",
                window === selectedWindow
                  ? "border-brand-400 bg-brand-500/20 text-brand-50"
                  : "border-slate-700 text-slate-300 hover:border-brand-400 hover:text-brand-100"
              )}
            >
              {WINDOW_LABELS[window]}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-400">Aggregation</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {(["hourly", "daily"] as Aggregation[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onAggregationChange(value)}
              className={clsx(
                "rounded-full border px-3 py-1 text-sm font-semibold transition",
                value === aggregation
                  ? "border-brand-400 bg-brand-500/20 text-brand-50"
                  : "border-slate-700 text-slate-300 hover:border-brand-400 hover:text-brand-100"
              )}
            >
              {AGGREGATION_LABELS[value]}
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-slate-400">Hubs</p>
          {selectedHubs.length > 0 && (
            <button
              type="button"
              onClick={onClearHubs}
              className="text-xs font-semibold text-slate-400 underline-offset-2 hover:text-brand-100 hover:underline"
            >
              Clear
            </button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {hubOptions.map((hub) => {
            const active = selectedHubs.includes(hub);
            return (
              <button
                key={hub}
                type="button"
                onClick={() => onHubToggle(hub)}
                className={clsx(
                  "rounded-full border px-3 py-1 text-sm font-semibold transition",
                  active
                    ? "border-brand-400 bg-brand-500/20 text-brand-50"
                    : "border-slate-700 text-slate-300 hover:border-brand-400 hover:text-brand-100"
                )}
              >
                {hub}
              </button>
            );
          })}
          {!hubOptions.length && <p className="text-sm text-slate-500">No hubs detected.</p>}
        </div>
      </div>
    </div>
  );
}

function ReasonSelector({
  summary,
  selectedReasons,
  onToggle,
  onClear
}: {
  summary: ContactReasonSummary;
  selectedReasons: string[];
  onToggle: (reason: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Contact reasons</p>
          <p className="text-sm text-slate-300">
            Toggle the series you want to trend. Legend click also enables/disables a reason.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {selectedReasons.length > 0 && (
            <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-200">
              {selectedReasons.length} selected
            </span>
          )}
          <button
            type="button"
            onClick={onClear}
            className="text-xs font-semibold text-slate-400 underline-offset-2 hover:text-brand-100 hover:underline"
          >
            Clear
          </button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {summary.entries.map((entry) => {
          const active = selectedReasons.includes(entry.reason);
          return (
            <button
              key={entry.reason}
              type="button"
              onClick={() => onToggle(entry.reason)}
              className={clsx(
                "rounded-full border px-3 py-1 text-sm font-semibold transition",
                active
                  ? "border-brand-400 bg-brand-500/20 text-brand-50"
                  : "border-slate-700 text-slate-300 hover:border-brand-400 hover:text-brand-100"
              )}
            >
              {entry.reason}
            </button>
          );
        })}
        {!summary.entries.length && (
          <p className="text-sm text-slate-500">No contact reason data available for this window.</p>
        )}
      </div>
    </div>
  );
}

function Legend({
  reasons,
  colorMap,
  onToggle
}: {
  reasons: string[];
  colorMap: Map<string, string>;
  onToggle: (reason: string) => void;
}) {
  if (!reasons.length) {
    return (
      <div className="rounded-full border border-slate-800 bg-slate-950/50 px-3 py-1 text-xs text-slate-400">
        Select at least one reason to plot.
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {reasons.map((reason) => (
        <button
          key={reason}
          type="button"
          onClick={() => onToggle(reason)}
          className="flex items-center gap-2 rounded-full border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-100 transition hover:border-brand-400 hover:text-brand-50"
        >
          <span className="h-2 w-6 rounded-full" style={{ backgroundColor: colorMap.get(reason) ?? "#60a5fa" }} />
          {reason}
        </button>
      ))}
    </div>
  );
}

function MultiSeriesChart({
  buckets,
  series,
  maxValue,
  loading,
  error
}: {
  buckets: Bucket[];
  series: ChartSeries[];
  maxValue: number;
  loading: boolean;
  error: string | null;
}) {
  const width = 880;
  const height = 320;
  const padding = 40;
  const yTicks = buildYAxisTicks(maxValue);
  const xForIndex = (index: number) =>
    buckets.length <= 1 ? padding : padding + (index / Math.max(1, buckets.length - 1)) * (width - padding * 2);
  const yForValue = (value: number) =>
    height - padding - (value / Math.max(1, maxValue)) * (height - padding * 2);
  const labelStride = Math.max(1, Math.ceil(buckets.length / 6));

  if (loading) {
    return <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/60 p-6 text-sm text-slate-400">Loading conversations…</div>;
  }
  if (error) {
    return (
      <div className="mt-6 rounded-2xl border border-rose-700 bg-rose-950/60 p-6 text-sm text-rose-100">
        {error}
      </div>
    );
  }
  if (!buckets.length || !series.length) {
    return (
      <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/60 p-6 text-sm text-slate-400">
        Select at least one contact reason to see trends.
      </div>
    );
  }

  return (
    <div className="relative mt-4 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Contact reason time series">
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#334155" strokeWidth="1" />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="#334155" strokeWidth="1" />
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={padding}
              x2={width - padding}
              y1={yForValue(tick)}
              y2={yForValue(tick)}
              stroke="#334155"
              strokeWidth={0.5}
              strokeDasharray="4 4"
              opacity={0.4}
            />
            <text x={padding - 8} y={yForValue(tick)} textAnchor="end" dominantBaseline="middle" className="fill-slate-400 text-[10px]">
              {tick.toLocaleString()}
            </text>
          </g>
        ))}
        {buckets.map((bucket, index) => {
          if (index % labelStride !== 0 && index !== buckets.length - 1) {
            return null;
          }
          return (
            <g key={bucket.key}>
              <text
                x={xForIndex(index)}
                y={height - padding + 14}
                textAnchor="middle"
                className="fill-slate-500 text-[10px]"
              >
                {bucket.label}
              </text>
            </g>
          );
        })}
        {series.map((entry) => {
          const path = entry.points
            .map((point, index) => {
              const prefix = index === 0 ? "M" : "L";
              return `${prefix}${xForIndex(index)} ${yForValue(point.value)}`;
            })
            .join(" ");
          return (
            <g key={entry.reason}>
              <path d={path} fill="none" stroke={entry.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
              {entry.points.map((point, index) => (
                <circle
                  key={`${entry.reason}-${point.key}`}
                  cx={xForIndex(index)}
                  cy={yForValue(point.value)}
                  r={3}
                  fill={entry.color}
                  stroke="#0f172a"
                  strokeWidth={1}
                />
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ReasonTable({
  summary,
  deltas,
  onToggle,
  selectedReasons
}: {
  summary: ContactReasonSummary;
  deltas: Map<string, { previous: number; changePct: number | null; topHub: string | null; topHubCount: number }>;
  onToggle: (reason: string) => void;
  selectedReasons: string[];
}) {
  if (!summary.entries.length) {
    return (
      <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-4 text-sm text-slate-400">
        No contact reason data available.
      </div>
    );
  }
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="min-w-full text-sm text-slate-200">
        <thead className="text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-3 py-2 text-left">Reason</th>
            <th className="px-3 py-2 text-right">Tickets</th>
            <th className="px-3 py-2 text-right">% of total</th>
            <th className="px-3 py-2 text-right">Δ vs prev</th>
            <th className="px-3 py-2 text-left">Top hub</th>
            <th className="px-3 py-2 text-right">Toggle</th>
          </tr>
        </thead>
        <tbody>
          {summary.entries.map((entry) => {
            const delta = deltas.get(entry.reason);
            const changeLabel =
              delta && delta.changePct !== null
                ? `${delta.changePct > 0 ? "+" : ""}${delta.changePct.toFixed(1)}%`
                : "—";
            const changeColor =
              delta && delta.changePct !== null
                ? delta.changePct > 0
                  ? "text-emerald-300"
                  : "text-rose-300"
                : "text-slate-400";
            const active = selectedReasons.includes(entry.reason);
            return (
              <tr key={entry.reason} className="border-t border-slate-800">
                <td className="px-3 py-3">{entry.reason}</td>
                <td className="px-3 py-3 text-right">{entry.count.toLocaleString()}</td>
                <td className="px-3 py-3 text-right">{entry.percentage.toFixed(1)}%</td>
                <td className={clsx("px-3 py-3 text-right font-semibold", changeColor)}>{changeLabel}</td>
                <td className="px-3 py-3">
                  {delta?.topHub ? (
                    <span className="rounded-full border border-slate-700 px-2 py-1 text-xs text-slate-200">
                      {delta.topHub} · {delta.topHubCount}
                    </span>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </td>
                <td className="px-3 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => onToggle(entry.reason)}
                    className={clsx(
                      "rounded-full border px-3 py-1 text-xs font-semibold transition",
                      active
                        ? "border-brand-400 bg-brand-500/20 text-brand-50"
                        : "border-slate-700 text-slate-300 hover:border-brand-400 hover:text-brand-100"
                    )}
                  >
                    {active ? "Hide" : "Show"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SmallMultiples({
  summary,
  selectedReasons,
  onToggle,
  aggregation
}: {
  summary: ContactReasonSummary;
  selectedReasons: string[];
  onToggle: (reason: string) => void;
  aggregation: Aggregation;
}) {
  if (!summary.entries.length) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-400">
        No contact reasons available for this window.
      </div>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {summary.entries.map((entry, index) => (
        <button
          key={entry.reason}
          type="button"
          onClick={() => onToggle(entry.reason)}
          className={clsx(
            "flex flex-col gap-2 rounded-2xl border p-4 text-left transition",
            selectedReasons.includes(entry.reason)
              ? "border-brand-400/80 bg-brand-500/10 text-white"
              : "border-slate-800 bg-slate-950/50 text-slate-100 hover:border-brand-400/50"
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold">{entry.reason}</p>
            <span className="text-xs text-slate-400">{entry.count.toLocaleString()} tickets</span>
          </div>
          <MiniSparkline points={entry.sparkline} color={REASON_COLORS[index % REASON_COLORS.length]} aggregation={aggregation} />
        </button>
      ))}
    </div>
  );
}

function MiniSparkline({
  points,
  color,
  aggregation
}: {
  points: { label: string; count: number }[];
  color: string;
  aggregation: Aggregation;
}) {
  const width = 260;
  const height = 70;
  const padding = 8;
  const max = points.reduce((maxValue, point) => Math.max(maxValue, point.count), 1);
  const xForIndex = (index: number) =>
    points.length <= 1 ? padding : padding + (index / Math.max(1, points.length - 1)) * (width - padding * 2);
  const yForCount = (value: number) => height - padding - (value / Math.max(1, max)) * (height - padding * 2);

  const path = points
    .map((point, index) => {
      const prefix = index === 0 ? "M" : "L";
      return `${prefix}${xForIndex(index)} ${yForCount(point.count)}`;
    })
    .join(" ");

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="text-slate-500">
      <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {points.map((point, index) => (
        <circle key={`${point.label}-${aggregation}-${index}`} cx={xForIndex(index)} cy={yForCount(point.count)} r={3} fill={color} />
      ))}
    </svg>
  );
}

function SummaryStat({
  label,
  value,
  previous
}: {
  label: string;
  value: number | string;
  previous?: number;
}) {
  let deltaLabel: string | null = null;
  let deltaColor = "text-slate-300";
  if (typeof value === "number" && typeof previous === "number") {
    if (previous === 0) {
      deltaLabel = "—";
    } else {
      const change = ((value - previous) / previous) * 100;
      deltaLabel = `${change > 0 ? "+" : ""}${change.toFixed(1)}% vs prev`;
      deltaColor = change > 0 ? "text-emerald-300" : "text-rose-300";
    }
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-bold text-white">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      {deltaLabel && <p className={clsx("text-sm font-semibold", deltaColor)}>{deltaLabel}</p>}
    </div>
  );
}

function toggleHub(hub: string, selected: string[], setSelected: (next: string[]) => void) {
  if (selected.includes(hub)) {
    setSelected(selected.filter((item) => item !== hub));
  } else {
    setSelected([...selected, hub]);
  }
}

function toggleReason(reason: string, selected: string[], setSelected: (next: string[]) => void) {
  if (selected.includes(reason)) {
    setSelected(selected.filter((item) => item !== reason));
  } else {
    setSelected([...selected, reason]);
  }
}

function resolveReasonLabel(row: ConversationRow): string {
  const reasonValue = row.contactReason || row.contactReasonOriginal;
  const label = reasonValue && reasonValue.trim().length ? reasonValue.trim() : "Unspecified";
  return label;
}

function alignToBucket(date: Date, bucketMs: number): Date {
  const aligned = new Date(date);
  if (bucketMs >= 24 * 60 * 60 * 1000) {
    aligned.setHours(0, 0, 0, 0);
  } else {
    aligned.setMinutes(0, 0, 0);
  }
  return aligned;
}

function formatBucketKey(timestamp: number, aggregation: Aggregation): string {
  const date = new Date(timestamp);
  return aggregation === "hourly" ? date.toISOString().slice(0, 13) : date.toISOString().slice(0, 10);
}

function formatBucketLabel(timestamp: number, aggregation: Aggregation): string {
  const date = new Date(timestamp);
  const month = date.toLocaleString("default", { month: "short" });
  const day = date.getDate();
  if (aggregation === "hourly") {
    const hours = date.getHours().toString().padStart(2, "0");
    return `${month} ${day} · ${hours}:00`;
  }
  return `${month} ${day}`;
}

function buildReasonSeries({
  rows,
  reasons,
  window,
  aggregation,
  referenceNow
}: {
  rows: ConversationRow[];
  reasons: string[];
  window: TimeWindow;
  aggregation: Aggregation;
  referenceNow: Date;
}): { buckets: Bucket[]; chartSeries: ChartSeries[]; maxValue: number; startTimestamp: number } {
  const bucketMs = BUCKET_MS[aggregation];
  const duration = WINDOW_DURATION_MS[window];
  const bucketCount = Math.max(1, Math.round(duration / bucketMs));
  const alignedEnd = alignToBucket(referenceNow, bucketMs).getTime();
  const start = alignedEnd - bucketMs * (bucketCount - 1);
  const buckets: Bucket[] = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const ts = start + bucketMs * i;
    const key = formatBucketKey(ts, aggregation);
    buckets.push({
      key,
      label: formatBucketLabel(ts, aggregation),
      timestamp: ts
    });
  }
  const bucketIndex = new Map<string, number>();
  buckets.forEach((bucket, index) => bucketIndex.set(bucket.key, index));

  const seriesMap = new Map<string, number[]>();
  reasons.forEach((reason) => {
    seriesMap.set(reason, new Array(bucketCount).fill(0));
  });

  rows.forEach((row) => {
    const reason = resolveReasonLabel(row);
    if (!seriesMap.has(reason)) {
      return;
    }
    const reference = row.endedAt ?? row.startedAt;
    if (!reference) {
      return;
    }
    const ts = reference.getTime();
    if (ts < start || ts > alignedEnd + bucketMs) {
      return;
    }
    const aligned = alignToBucket(reference, bucketMs).getTime();
    const key = formatBucketKey(aligned, aggregation);
    const index = bucketIndex.get(key);
    if (index === undefined) {
      return;
    }
    const values = seriesMap.get(reason);
    if (values) {
      values[index] += 1;
    }
  });

  let maxValue = 0;
  const chartSeries: ChartSeries[] = Array.from(seriesMap.entries()).map(([reason, values], index) => {
    const color = REASON_COLORS[index % REASON_COLORS.length];
    const points = buckets.map((bucket, idx) => ({ key: bucket.key, value: values[idx] ?? 0 }));
    values.forEach((value) => {
      if (value > maxValue) {
        maxValue = value;
      }
    });
    return {
      reason,
      color,
      points,
      total: values.reduce((acc, value) => acc + value, 0)
    };
  });

  return { buckets, chartSeries, maxValue, startTimestamp: start };
}

function buildYAxisTicks(maxValue: number): number[] {
  if (maxValue <= 0) {
    return [0, 1];
  }
  const tickCount = 4;
  const step = Math.max(1, Math.ceil(maxValue / tickCount));
  const ticks: number[] = [];
  for (let value = 0; value <= maxValue; value += step) {
    ticks.push(value);
  }
  if (ticks[ticks.length - 1] !== maxValue) {
    ticks.push(maxValue);
  }
  return ticks;
}

function filterRowsByRange(rows: ConversationRow[], start: number, end: number): ConversationRow[] {
  return rows.filter((row) => {
    const reference = row.endedAt ?? row.startedAt;
    if (!reference) {
      return false;
    }
    const ts = reference.getTime();
    return ts >= start && ts < end;
  });
}

function buildReasonDeltaStats({
  currentRows,
  previousRows
}: {
  currentRows: ConversationRow[];
  previousRows: ConversationRow[];
}): Map<string, { previous: number; changePct: number | null; topHub: string | null; topHubCount: number }> {
  const currentCount = new Map<string, number>();
  const previousCount = new Map<string, number>();
  const hubCounts = new Map<string, Map<string, number>>();

  currentRows.forEach((row) => {
    const reason = resolveReasonLabel(row);
    const hub = (row.hub ?? "Unassigned").trim() || "Unassigned";
    currentCount.set(reason, (currentCount.get(reason) ?? 0) + 1);
    const map = hubCounts.get(reason) ?? new Map<string, number>();
    map.set(hub, (map.get(hub) ?? 0) + 1);
    hubCounts.set(reason, map);
  });

  previousRows.forEach((row) => {
    const reason = resolveReasonLabel(row);
    previousCount.set(reason, (previousCount.get(reason) ?? 0) + 1);
  });

  const deltas = new Map<string, { previous: number; changePct: number | null; topHub: string | null; topHubCount: number }>();
  currentCount.forEach((count, reason) => {
    const prev = previousCount.get(reason) ?? 0;
    const changePct = prev === 0 ? null : ((count - prev) / prev) * 100;
    const hubs = hubCounts.get(reason) ?? new Map<string, number>();
    let topHub: string | null = null;
    let topHubCount = 0;
    hubs.forEach((value, hub) => {
      if (value > topHubCount) {
        topHub = hub;
        topHubCount = value;
      }
    });
    deltas.set(reason, { previous: prev, changePct, topHub, topHubCount });
  });

  return deltas;
}
