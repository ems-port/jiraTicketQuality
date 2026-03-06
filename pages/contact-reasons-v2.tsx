import Link from "next/link";
import { useRouter } from "next/router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import clsx from "clsx";

import { normaliseRows } from "@/lib/metrics";
import type { ConversationRow } from "@/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAY_COUNT = 7;

type Bucket = {
  key: string;
  label: string;
  start: Date;
};

type TrendCounter = {
  count: number;
  daily: number[];
};

type ReasonTrendRow = {
  key: string;
  topic: string;
  sub: string;
  count: number;
  daily: number[];
};

type HubTrendRow = {
  hub: string;
  count: number;
  daily: number[];
};

type HubReasonTrendRow = {
  key: string;
  topic: string;
  sub: string;
  hubCount: number;
  globalCount: number;
  hubShare: number;
  scope: "Hub only" | "Hub concentrated" | "Global";
  hubDaily: number[];
  globalDaily: number[];
};

type TrendModel = {
  buckets: Bucket[];
  reasonRows: ReasonTrendRow[];
  hubRows: HubTrendRow[];
  hubReasonMap: Map<string, TrendCounter>;
  totalRows: number;
};

export default function ContactReasonsV2DrilldownPage() {
  const router = useRouter();
  const queryHub = useMemo(() => {
    const hub = router.query.hub;
    if (typeof hub === "string" && hub.trim()) {
      return decodeURIComponent(hub.trim());
    }
    if (Array.isArray(hub) && hub[0] && typeof hub[0] === "string" && hub[0].trim()) {
      return decodeURIComponent(hub[0].trim());
    }
    return null;
  }, [router.query.hub]);

  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referenceNow, setReferenceNow] = useState(() => new Date());
  const [selectedHub, setSelectedHub] = useState("");

  useEffect(() => {
    const loadConversations = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/conversations");
        if (!response.ok) {
          throw new Error(`Failed to load conversations (${response.status})`);
        }
        const payload = await response.json();
        const rawRows: Record<string, unknown>[] = Array.isArray(payload.rows) ? payload.rows : [];
        setRows(normaliseRows(rawRows as Record<string, string | number | boolean | null>[]));
        setReferenceNow(new Date());
      } catch (err) {
        setError((err as Error).message ?? "Unable to load conversations.");
      } finally {
        setLoading(false);
      }
    };

    void loadConversations();
  }, []);

  const trendModel = useMemo(() => buildTrendModel(rows, referenceNow), [rows, referenceNow]);

  const topReasonRows = useMemo(() => trendModel.reasonRows.slice(0, 10), [trendModel.reasonRows]);
  const hubRankingRows = useMemo(() => trendModel.hubRows.slice(0, 10), [trendModel.hubRows]);
  const hubOptions = useMemo(() => trendModel.hubRows.map((row) => row.hub), [trendModel.hubRows]);

  useEffect(() => {
    if (!hubOptions.length) {
      if (selectedHub !== "") {
        setSelectedHub("");
      }
      return;
    }

    if (queryHub && hubOptions.includes(queryHub)) {
      if (selectedHub !== queryHub) {
        setSelectedHub(queryHub);
      }
      return;
    }

    if (!selectedHub || !hubOptions.includes(selectedHub)) {
      setSelectedHub(hubOptions[0]);
    }
  }, [hubOptions, queryHub, selectedHub]);

  const hubReasonRows = useMemo<HubReasonTrendRow[]>(() => {
    if (!selectedHub) {
      return [];
    }
    return trendModel.reasonRows
      .map((reason) => {
        const scoped = trendModel.hubReasonMap.get(makeHubReasonKey(selectedHub, reason.key));
        const hubCount = scoped?.count ?? 0;
        if (hubCount <= 0) {
          return null;
        }
        const hubShare = reason.count > 0 ? (hubCount / reason.count) * 100 : 0;
        const scope: HubReasonTrendRow["scope"] =
          hubCount === reason.count ? "Hub only" : hubShare >= 60 ? "Hub concentrated" : "Global";

        return {
          key: reason.key,
          topic: reason.topic,
          sub: reason.sub,
          hubCount,
          globalCount: reason.count,
          hubShare,
          scope,
          hubDaily: [...(scoped?.daily ?? createEmptyTrend())],
          globalDaily: [...reason.daily]
        };
      })
      .filter((row): row is HubReasonTrendRow => Boolean(row))
      .sort((a, b) => {
        if (b.hubCount !== a.hubCount) {
          return b.hubCount - a.hubCount;
        }
        return a.key.localeCompare(b.key);
      });
  }, [selectedHub, trendModel.reasonRows, trendModel.hubReasonMap]);

  const lastBucketLabel = trendModel.buckets[trendModel.buckets.length - 1]?.label ?? "N/A";

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
                <h1 className="text-2xl font-bold text-white">Top 10 Contact Reasons V2 Drilldown</h1>
                <p className="text-sm text-slate-400">
                  Daily trends for the last 7 days across reason + subreason and hub distribution.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1 text-xs text-slate-300">
                7-day window
              </span>
              <span className="rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1 text-xs text-slate-300">
                Through {lastBucketLabel}
              </span>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <SummaryStat
              label="Rows with V2 reason"
              value={trendModel.totalRows.toLocaleString()}
            />
            <SummaryStat
              label="Unique reason + subreason"
              value={trendModel.reasonRows.length.toLocaleString()}
            />
            <SummaryStat
              label="Hubs with volume"
              value={trendModel.hubRows.length.toLocaleString()}
            />
          </div>
        </header>

        {loading && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6 text-sm text-slate-300">
            Loading conversations…
          </div>
        )}
        {error && (
          <div className="rounded-2xl border border-rose-700 bg-rose-950/50 p-6 text-sm text-rose-100">
            {error}
          </div>
        )}

        {!loading && !error && (
          <>
            <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 shadow-inner">
              <header className="mb-4">
                <h2 className="text-lg font-semibold text-white">1. Top reason + subreason ranking</h2>
                <p className="text-sm text-slate-400">
                  Sorted by 7-day volume with daily trend sparkline.
                </p>
              </header>
              <RankTableEmptyState rows={topReasonRows} emptyLabel="No V2 reason data available in the last 7 days.">
                <table className="min-w-full divide-y divide-slate-800 text-sm">
                  <thead className="bg-slate-900/80 text-slate-300">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">#</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">Reason</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">Subreason</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">7d count</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">Share</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">Daily trend</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {topReasonRows.map((row, index) => {
                      const share = trendModel.totalRows > 0 ? (row.count / trendModel.totalRows) * 100 : 0;
                      return (
                        <tr key={row.key} className="bg-slate-900/30">
                          <td className="px-3 py-2 text-xs text-slate-400">{index + 1}</td>
                          <td className="px-3 py-2 text-slate-100">{row.topic}</td>
                          <td className="px-3 py-2 text-slate-200">
                            <Link
                              href={`/reason-tickets?topic=${encodeURIComponent(row.topic)}&sub=${encodeURIComponent(row.sub)}&window=7d`}
                              className="rounded border border-slate-700 bg-slate-900/60 px-2 py-1 text-xs text-slate-200 transition hover:border-brand-500 hover:text-white"
                            >
                              {row.sub}
                            </Link>
                          </td>
                          <td className="px-3 py-2 text-right font-semibold text-white">{row.count.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right text-slate-300">{share.toFixed(1)}%</td>
                          <td className="px-3 py-2">
                            <Sparkline
                              values={row.daily}
                              labels={trendModel.buckets.map((bucket) => bucket.label)}
                              colorClassName="text-brand-300"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </RankTableEmptyState>
            </section>

            <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 shadow-inner">
              <header className="mb-4">
                <h2 className="text-lg font-semibold text-white">2. Hub ranking for V2 contact reasons</h2>
                <p className="text-sm text-slate-400">
                  Hubs ordered by total V2 reason occurrences in the last 7 days.
                </p>
              </header>
              <RankTableEmptyState rows={hubRankingRows} emptyLabel="No hub volume available in the last 7 days.">
                <table className="min-w-full divide-y divide-slate-800 text-sm">
                  <thead className="bg-slate-900/80 text-slate-300">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">#</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">Hub</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">7d count</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">Share</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">Daily trend</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {hubRankingRows.map((row, index) => {
                      const share = trendModel.totalRows > 0 ? (row.count / trendModel.totalRows) * 100 : 0;
                      return (
                        <tr key={row.hub} className="bg-slate-900/30">
                          <td className="px-3 py-2 text-xs text-slate-400">{index + 1}</td>
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() => setSelectedHub(row.hub)}
                              className={clsx(
                                "rounded border px-2 py-1 text-left text-xs transition",
                                selectedHub === row.hub
                                  ? "border-brand-500/80 bg-brand-500/20 text-brand-100"
                                  : "border-slate-700 bg-slate-900/60 text-slate-200 hover:border-brand-500 hover:text-white"
                              )}
                            >
                              {row.hub}
                            </button>
                          </td>
                          <td className="px-3 py-2 text-right font-semibold text-white">{row.count.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right text-slate-300">{share.toFixed(1)}%</td>
                          <td className="px-3 py-2">
                            <Sparkline
                              values={row.daily}
                              labels={trendModel.buckets.map((bucket) => bucket.label)}
                              colorClassName="text-sky-300"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </RankTableEmptyState>
            </section>

            <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 shadow-inner">
              <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-white">3. Full reason trends for a selected hub</h2>
                  <p className="text-sm text-slate-400">
                    Compare selected hub trend against global trend to detect local-only issues.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="hub-select" className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Hub
                  </label>
                  <select
                    id="hub-select"
                    value={selectedHub}
                    onChange={(event) => setSelectedHub(event.target.value)}
                    className="rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-brand-400"
                  >
                    {hubOptions.map((hub) => (
                      <option key={hub} value={hub}>
                        {hub}
                      </option>
                    ))}
                  </select>
                </div>
              </header>
              <RankTableEmptyState
                rows={hubReasonRows}
                emptyLabel={selectedHub ? `No reason rows found for ${selectedHub} in this 7-day window.` : "Select a hub to view reason trends."}
              >
                <table className="min-w-full divide-y divide-slate-800 text-sm">
                  <thead className="bg-slate-900/80 text-slate-300">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">#</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">Reason</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">Subreason</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">Hub 7d</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">Global 7d</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">Hub share</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">Scope</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">Hub trend</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">Global trend</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {hubReasonRows.map((row, index) => (
                      <tr key={`${selectedHub}-${row.key}`} className="bg-slate-900/30">
                        <td className="px-3 py-2 text-xs text-slate-400">{index + 1}</td>
                        <td className="px-3 py-2 text-slate-100">{row.topic}</td>
                        <td className="px-3 py-2 text-slate-200">{row.sub}</td>
                        <td className="px-3 py-2 text-right font-semibold text-white">{row.hubCount.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-slate-300">{row.globalCount.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-slate-300">{row.hubShare.toFixed(1)}%</td>
                        <td className="px-3 py-2">
                          <span
                            className={clsx(
                              "inline-flex rounded-full border px-2 py-1 text-xs font-semibold",
                              row.scope === "Hub only"
                                ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-100"
                                : row.scope === "Hub concentrated"
                                  ? "border-amber-500/60 bg-amber-500/20 text-amber-100"
                                  : "border-slate-700 bg-slate-900/70 text-slate-200"
                            )}
                          >
                            {row.scope}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <Sparkline
                            values={row.hubDaily}
                            labels={trendModel.buckets.map((bucket) => bucket.label)}
                            colorClassName="text-emerald-300"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <Sparkline
                            values={row.globalDaily}
                            labels={trendModel.buckets.map((bucket) => bucket.label)}
                            colorClassName="text-slate-300"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </RankTableEmptyState>
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-lg font-semibold text-white">{value}</p>
    </div>
  );
}

function RankTableEmptyState<T>({
  rows,
  emptyLabel,
  children
}: {
  rows: T[];
  emptyLabel: string;
  children: ReactNode;
}) {
  if (!rows.length) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/60 p-6 text-sm text-slate-400">
        {emptyLabel}
      </div>
    );
  }
  return <div className="overflow-auto rounded-2xl border border-slate-800">{children}</div>;
}

function Sparkline({
  values,
  labels,
  colorClassName
}: {
  values: number[];
  labels: string[];
  colorClassName: string;
}) {
  if (!values.length) {
    return <span className="text-xs text-slate-500">No trend</span>;
  }

  const width = 140;
  const height = 36;
  const padding = 4;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);

  const points = values
    .map((value, index) => {
      const x =
        values.length === 1
          ? width / 2
          : padding + (index / (values.length - 1)) * Math.max(1, width - padding * 2);
      const ratio = max === min ? 0.5 : (value - min) / Math.max(1, max - min);
      const y = height - padding - ratio * Math.max(1, height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");

  const startLabel = labels[0] ?? "";
  const endLabel = labels[labels.length - 1] ?? "";
  const aria = `Trend from ${startLabel} to ${endLabel}: ${values.join(", ")}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={aria}
      className={clsx("opacity-90", colorClassName)}
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

function buildTrendModel(rows: ConversationRow[], referenceNow: Date): TrendModel {
  const buckets = buildDailyBuckets(referenceNow, TREND_DAY_COUNT);
  const bucketIndex = new Map<string, number>(buckets.map((bucket, index) => [bucket.key, index]));
  const firstBucketStart = buckets[0]?.start.getTime() ?? referenceNow.getTime();
  const rangeEnd = firstBucketStart + TREND_DAY_COUNT * DAY_MS;

  const reasonMap = new Map<string, TrendCounter & { topic: string; sub: string }>();
  const hubMap = new Map<string, TrendCounter>();
  const hubReasonMap = new Map<string, TrendCounter>();

  let totalRows = 0;

  rows.forEach((row) => {
    const topic = resolveReasonTopic(row);
    if (!topic) {
      return;
    }
    const sub = resolveReasonSub(row);
    const referenceDate = row.endedAt ?? row.startedAt;
    if (!referenceDate) {
      return;
    }
    const timestamp = referenceDate.getTime();
    if (timestamp < firstBucketStart || timestamp >= rangeEnd) {
      return;
    }
    const bucketKey = formatBucketKey(referenceDate);
    const index = bucketIndex.get(bucketKey);
    if (index === undefined) {
      return;
    }

    totalRows += 1;
    const hub = resolveHubLabel(row);
    const reasonKey = makeReasonKey(topic, sub);

    if (!reasonMap.has(reasonKey)) {
      reasonMap.set(reasonKey, { topic, sub, count: 0, daily: createEmptyTrend() });
    }
    incrementCounter(reasonMap.get(reasonKey)!, index);

    if (!hubMap.has(hub)) {
      hubMap.set(hub, { count: 0, daily: createEmptyTrend() });
    }
    incrementCounter(hubMap.get(hub)!, index);

    const hubReasonKey = makeHubReasonKey(hub, reasonKey);
    if (!hubReasonMap.has(hubReasonKey)) {
      hubReasonMap.set(hubReasonKey, { count: 0, daily: createEmptyTrend() });
    }
    incrementCounter(hubReasonMap.get(hubReasonKey)!, index);
  });

  const reasonRows: ReasonTrendRow[] = Array.from(reasonMap.entries())
    .map(([key, value]) => ({
      key,
      topic: value.topic,
      sub: value.sub,
      count: value.count,
      daily: value.daily
    }))
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.key.localeCompare(b.key);
    });

  const hubRows: HubTrendRow[] = Array.from(hubMap.entries())
    .map(([hub, value]) => ({
      hub,
      count: value.count,
      daily: value.daily
    }))
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.hub.localeCompare(b.hub);
    });

  return {
    buckets,
    reasonRows,
    hubRows,
    hubReasonMap,
    totalRows
  };
}

function incrementCounter(counter: TrendCounter, index: number) {
  counter.count += 1;
  counter.daily[index] = (counter.daily[index] ?? 0) + 1;
}

function buildDailyBuckets(referenceNow: Date, days: number): Bucket[] {
  const today = startOfDay(referenceNow);
  return Array.from({ length: days }, (_, index) => {
    const offset = days - index - 1;
    const start = new Date(today.getTime() - offset * DAY_MS);
    return {
      key: formatBucketKey(start),
      label: formatBucketLabel(start),
      start
    };
  });
}

function startOfDay(value: Date): Date {
  const day = new Date(value);
  day.setHours(0, 0, 0, 0);
  return day;
}

function formatBucketLabel(value: Date): string {
  return value.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}

function formatBucketKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function makeReasonKey(topic: string, sub: string): string {
  return `${topic}::${sub}`;
}

function makeHubReasonKey(hub: string, reasonKey: string): string {
  return `${hub}@@${reasonKey}`;
}

function resolveReasonTopic(row: ConversationRow): string | null {
  const value = row.contactReasonV2Topic || row.contactReasonV2 || null;
  if (!value) {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function resolveReasonSub(row: ConversationRow): string {
  const value = row.contactReasonV2Sub;
  if (!value) {
    return "Unspecified";
  }
  const normalized = value.trim();
  return normalized || "Unspecified";
}

function resolveHubLabel(row: ConversationRow): string {
  const value = row.hub;
  if (!value) {
    return "Unassigned";
  }
  const normalized = value.trim();
  return normalized || "Unassigned";
}

function createEmptyTrend(): number[] {
  return Array.from({ length: TREND_DAY_COUNT }, () => 0);
}
