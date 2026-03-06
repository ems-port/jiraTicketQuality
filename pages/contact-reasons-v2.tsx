import Link from "next/link";
import { useRouter } from "next/router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";

import { normaliseRows } from "@/lib/metrics";
import { useDashboardStore } from "@/lib/useDashboardStore";
import type { ConversationRow, TimeWindow } from "@/types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_OPTIONS: TimeWindow[] = ["24h", "7d", "30d"];
const WINDOW_LABELS: Record<TimeWindow, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days"
};
const WINDOW_DURATION_MS: Record<TimeWindow, number> = {
  "24h": 24 * HOUR_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS
};
const WINDOW_BUCKET_COUNT: Record<TimeWindow, number> = {
  "24h": 24,
  "7d": 7,
  "30d": 30
};
const WINDOW_GRANULARITY: Record<TimeWindow, "hourly" | "daily"> = {
  "24h": "hourly",
  "7d": "daily",
  "30d": "daily"
};

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

type HubRankingRow = {
  hub: string;
  count: number;
  share: number;
  sales: number | null;
  normalizedToSales: number | null;
  daily: number[];
};

type HubSortKey = "count" | "normalizedToSales";
type SortDirection = "asc" | "desc";

type HubConcentratedIssue = {
  key: string;
  topic: string;
  sub: string;
  hub: string;
  hubCount: number;
  globalCount: number;
  hubShare: number;
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

type HubSalesTelemetryRow = {
  hubName: string;
  passSoldCount: number;
  subscriptionsSoldCount: number;
  totalSales: number;
};

type HubSalesFallbackEntry = {
  totalSales: number;
  rowCount: number;
  hasGen4: boolean;
  hasGen5: boolean;
};

export default function ContactReasonsV2DrilldownPage() {
  const router = useRouter();
  const queryWindow = useMemo<TimeWindow | null>(() => {
    const raw = router.query.window;
    if (raw === "24h" || raw === "7d" || raw === "30d") {
      return raw;
    }
    return null;
  }, [router.query.window]);
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
  const [selectedWindow, setSelectedWindow] = useState<TimeWindow>(queryWindow ?? "7d");
  const [selectedHub, setSelectedHub] = useState("");
  const [hubSalesRows, setHubSalesRows] = useState<HubSalesTelemetryRow[]>([]);
  const [hubSalesWarning, setHubSalesWarning] = useState<string | null>(null);
  const [salesRefreshStatus, setSalesRefreshStatus] = useState<string | null>(null);
  const sharedDashboardRows = useDashboardStore((state) => state.rows);
  const initLoadStartedRef = useRef(false);
  const [hubSort, setHubSort] = useState<{ key: HubSortKey; direction: SortDirection }>({
    key: "count",
    direction: "desc"
  });

  useEffect(() => {
    if (!rows.length && sharedDashboardRows.length) {
      console.info(`[contact-reasons-v2] Reusing ${sharedDashboardRows.length} dashboard conversations from shared store.`);
      setRows(sharedDashboardRows);
      setReferenceNow(new Date());
    }
  }, [rows.length, sharedDashboardRows]);

  useEffect(() => {
    if (initLoadStartedRef.current) {
      return;
    }
    initLoadStartedRef.current = true;

    let cancelled = false;

    const applyHubSalesPayload = (hubSalesPayload: Record<string, unknown>) => {
      const telemetryRows = Array.isArray(hubSalesPayload.rows) ? hubSalesPayload.rows : [];
      setHubSalesRows(
        telemetryRows.map((row: Record<string, unknown>) => ({
          hubName: String(row.hubName ?? ""),
          passSoldCount: toFiniteNumber(row.passSoldCount),
          subscriptionsSoldCount: toFiniteNumber(row.subscriptionsSoldCount),
          totalSales: toFiniteNumber(row.totalSales)
        }))
      );
      setHubSalesWarning(typeof hubSalesPayload.warning === "string" ? hubSalesPayload.warning : null);
    };

    const loadLatestHubSales = async () => {
      const hubSalesResponse = await fetch("/api/hub-telemetry/latest");
      if (hubSalesResponse.ok) {
        const hubSalesPayload = (await hubSalesResponse.json()) as Record<string, unknown>;
        if (!cancelled) {
          applyHubSalesPayload(hubSalesPayload);
        }
      } else if (!cancelled) {
        setHubSalesRows([]);
        setHubSalesWarning(`Hub sales normalization unavailable (${hubSalesResponse.status}).`);
      }
    };

    const refreshHubSales = async () => {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const requestSalesRefresh = async (): Promise<{
        ok: boolean;
        status: string;
        message: string;
        responseStatus: number;
        payload: Record<string, unknown>;
      }> => {
        const refreshResponse = await fetch("/api/hub-telemetry/refresh-for-drilldown", {
          method: "POST"
        });
        let refreshPayload: Record<string, unknown> = {};
        try {
          refreshPayload = (await refreshResponse.json()) as Record<string, unknown>;
        } catch {
          refreshPayload = {};
        }
        const status = String(refreshPayload.status ?? "");
        const message =
          typeof refreshPayload.message === "string"
            ? refreshPayload.message
            : refreshResponse.ok
              ? "Sales refresh completed."
              : `Refresh failed (${refreshResponse.status}).`;
        return {
          ok: refreshResponse.ok && refreshPayload.ok === true,
          status,
          message,
          responseStatus: refreshResponse.status,
          payload: refreshPayload
        };
      };

      setSalesRefreshStatus("Refreshing sales from ThingsBoard...");
      console.info("[contact-reasons-v2] Starting sales refresh for drilldown view.");
      try {
        const maxPollAttempts = 6;
        let pollAttempt = 0;
        let lastInProgressMessage = "Sales refresh already running.";
        while (!cancelled) {
          const refreshResult = await requestSalesRefresh();
          if (!refreshResult.ok) {
            const message =
              typeof refreshResult.payload.error === "string"
                ? String(refreshResult.payload.error)
                : `Refresh failed (${refreshResult.responseStatus}).`;
            console.warn("[contact-reasons-v2] Sales refresh failed:", message);
            if (!cancelled) {
              setSalesRefreshStatus(`Sales refresh failed: ${message}`);
            }
            break;
          }

          if (refreshResult.status === "in_progress") {
            lastInProgressMessage = refreshResult.message;
            pollAttempt += 1;
            console.info(`[contact-reasons-v2] Sales refresh in progress (poll ${pollAttempt}/${maxPollAttempts}).`);
            if (!cancelled) {
              setSalesRefreshStatus(`${refreshResult.message} Waiting for completion...`);
            }
            if (pollAttempt >= maxPollAttempts) {
              if (!cancelled) {
                setSalesRefreshStatus(`${lastInProgressMessage} Showing latest available sales snapshot.`);
              }
              break;
            }
            await sleep(2500);
            continue;
          }

          if (refreshResult.status === "refreshed") {
            console.info("[contact-reasons-v2] Sales refresh complete:", refreshResult.payload);
          } else if (refreshResult.status === "skipped") {
            console.info("[contact-reasons-v2] Sales refresh skipped (cooldown):", refreshResult.payload);
          } else {
            console.info("[contact-reasons-v2] Sales refresh response:", refreshResult.payload);
          }

          if (!cancelled) {
            setSalesRefreshStatus(refreshResult.message);
          }
          break;
        }
      } catch (error) {
        const message = (error as Error).message ?? "Unknown refresh error.";
        console.error("[contact-reasons-v2] Sales refresh exception:", message);
        if (!cancelled) {
          setSalesRefreshStatus(`Sales refresh failed: ${message}`);
        }
      } finally {
        try {
          await loadLatestHubSales();
        } catch (error) {
          const message = (error as Error).message ?? "Unable to load latest sales.";
          console.error("[contact-reasons-v2] Failed to load latest sales after refresh:", message);
          if (!cancelled) {
            setHubSalesWarning(message);
          }
        }
      }
    };

    const loadConversations = async () => {
      setLoading(true);
      setError(null);
      setHubSalesWarning(null);
      try {
        if (sharedDashboardRows.length) {
          console.info("[contact-reasons-v2] Using shared dashboard conversations; skipping initial API fetch.");
          if (!cancelled) {
            setRows(sharedDashboardRows);
            setReferenceNow(new Date());
          }
          return;
        }
        const maxLimit = Math.max(1, Number(process.env.NEXT_PUBLIC_CONVERSATION_FETCH_LIMIT ?? 5000));
        const pageSize = Math.max(1, Number(process.env.NEXT_PUBLIC_CONVERSATION_PAGE_SIZE ?? 200));
        let offset = 0;
        const collected: Record<string, unknown>[] = [];

        while (collected.length < maxLimit) {
          const remaining = maxLimit - collected.length;
          const page = Math.min(pageSize, remaining);
          const conversationsResponse = await fetch(
            `/api/conversations?offset=${offset}&limit=${maxLimit}&pageSize=${page}`
          );
          if (!conversationsResponse.ok) {
            throw new Error(`Failed to load conversations (${conversationsResponse.status})`);
          }
          const payload = await conversationsResponse.json();
          const batch: Record<string, unknown>[] = Array.isArray(payload.rows) ? payload.rows : [];
          collected.push(...batch);
          const nextOffset = typeof payload.nextOffset === "number" ? payload.nextOffset : null;
          if (!nextOffset || !batch.length) {
            break;
          }
          offset = nextOffset;
        }

        if (!collected.length) {
          throw new Error("No conversations returned from API.");
        }

        console.info(`[contact-reasons-v2] Loaded ${collected.length} conversations across paginated API calls.`);
        if (!cancelled) {
          setRows(normaliseRows(collected as Record<string, string | number | boolean | null>[]));
          setReferenceNow(new Date());
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message ?? "Unable to load conversations.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadConversations();
    void refreshHubSales();
    return () => {
      cancelled = true;
    };
  }, [sharedDashboardRows]);

  useEffect(() => {
    if (queryWindow && queryWindow !== selectedWindow) {
      setSelectedWindow(queryWindow);
    }
  }, [queryWindow, selectedWindow]);

  const trendModel = useMemo(
    () => buildTrendModel(rows, referenceNow, selectedWindow),
    [rows, referenceNow, selectedWindow]
  );

  const topReasonRows = useMemo(() => trendModel.reasonRows.slice(0, 10), [trendModel.reasonRows]);
  const hubOptions = useMemo(() => trendModel.hubRows.map((row) => row.hub), [trendModel.hubRows]);
  const hubSalesLookup = useMemo(() => {
    const exactByKey = new Map<string, number>();
    const fallbackByBase = new Map<string, HubSalesFallbackEntry>();

    hubSalesRows.forEach((row) => {
      const hubKey = normalizeHubKey(row.hubName);
      exactByKey.set(hubKey, row.totalSales);

      const baseKey = normalizeHubBaseKey(row.hubName);
      const generation = extractGeneration(row.hubName);
      const previous = fallbackByBase.get(baseKey) ?? {
        totalSales: 0,
        rowCount: 0,
        hasGen4: false,
        hasGen5: false
      };
      previous.totalSales += row.totalSales;
      previous.rowCount += 1;
      if (generation === "gen4") {
        previous.hasGen4 = true;
      }
      if (generation === "gen5") {
        previous.hasGen5 = true;
      }
      fallbackByBase.set(baseKey, previous);
    });

    return { exactByKey, fallbackByBase };
  }, [hubSalesRows]);

  const allHubRankingRows = useMemo<HubRankingRow[]>(() => {
    return trendModel.hubRows.map((row) => {
      const share = trendModel.totalRows > 0 ? (row.count / trendModel.totalRows) * 100 : 0;
      const sales = resolveHubSalesTotal(row.hub, hubSalesLookup);
      const normalizedToSales = typeof sales === "number" && sales > 0 ? row.count / sales : null;
      return {
        hub: row.hub,
        count: row.count,
        share,
        sales,
        normalizedToSales,
        daily: row.daily
      };
    });
  }, [trendModel.hubRows, trendModel.totalRows, hubSalesLookup]);

  const sortedHubRankingRows = useMemo<HubRankingRow[]>(() => {
    const direction = hubSort.direction === "asc" ? 1 : -1;
    const rowsToSort = [...allHubRankingRows];
    rowsToSort.sort((a, b) => {
      const valueA = hubSort.key === "count" ? a.count : a.normalizedToSales;
      const valueB = hubSort.key === "count" ? b.count : b.normalizedToSales;
      if (valueA === null && valueB === null) {
        return b.count - a.count || a.hub.localeCompare(b.hub);
      }
      if (valueA === null) {
        return 1;
      }
      if (valueB === null) {
        return -1;
      }
      if (valueA !== valueB) {
        return (valueA - valueB) * direction;
      }
      return b.count - a.count || a.hub.localeCompare(b.hub);
    });
    return rowsToSort;
  }, [allHubRankingRows, hubSort]);

  const displayedHubRankingRows = useMemo<HubRankingRow[]>(() => {
    if (hubSort.key === "normalizedToSales") {
      return sortedHubRankingRows;
    }
    return sortedHubRankingRows.slice(0, 10);
  }, [sortedHubRankingRows, hubSort.key]);

  const topHubConcentratedIssues = useMemo<HubConcentratedIssue[]>(() => {
    const concentrated: HubConcentratedIssue[] = [];
    trendModel.reasonRows.forEach((reason) => {
      if (reason.count <= 0) {
        return;
      }
      let bestHub: string | null = null;
      let bestHubCount = 0;
      hubOptions.forEach((hub) => {
        const hubReason = trendModel.hubReasonMap.get(makeHubReasonKey(hub, reason.key));
        const hubCount = hubReason?.count ?? 0;
        if (hubCount > bestHubCount) {
          bestHubCount = hubCount;
          bestHub = hub;
        }
      });
      if (!bestHub || bestHubCount <= 0) {
        return;
      }
      const hubShare = (bestHubCount / reason.count) * 100;
      // Concentrated issues are dominated by one hub, but not strictly hub-only.
      if (hubShare >= 60 && hubShare < 100) {
        concentrated.push({
          key: `${bestHub}@@${reason.key}`,
          topic: reason.topic,
          sub: reason.sub,
          hub: bestHub,
          hubCount: bestHubCount,
          globalCount: reason.count,
          hubShare
        });
      }
    });

    return concentrated
      .sort((a, b) => {
        if (b.hubCount !== a.hubCount) {
          return b.hubCount - a.hubCount;
        }
        if (b.hubShare !== a.hubShare) {
          return b.hubShare - a.hubShare;
        }
        return a.key.localeCompare(b.key);
      })
      .slice(0, 5);
  }, [trendModel.reasonRows, trendModel.hubReasonMap, hubOptions]);

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
          hubDaily: [...(scoped?.daily ?? createEmptyTrend(trendModel.buckets.length))],
          globalDaily: [...reason.daily]
        };
      })
      .sort((a, b) => {
        if (b.hubCount !== a.hubCount) {
          return b.hubCount - a.hubCount;
        }
        return a.key.localeCompare(b.key);
      });
  }, [selectedHub, trendModel.reasonRows, trendModel.hubReasonMap, trendModel.buckets.length]);

  const lastBucketLabel = trendModel.buckets[trendModel.buckets.length - 1]?.label ?? "N/A";
  const countColumnLabel =
    selectedWindow === "24h" ? "24h count" : selectedWindow === "7d" ? "7d count" : "30d count";
  const trendColumnLabel = WINDOW_GRANULARITY[selectedWindow] === "hourly" ? "Hourly trend" : "Daily trend";
  const hubSortIndicator = (key: HubSortKey) => {
    if (hubSort.key !== key) {
      return "";
    }
    return hubSort.direction === "desc" ? "↓" : "↑";
  };
  const onHubSort = (key: HubSortKey) => {
    setHubSort((previous) => {
      if (previous.key === key) {
        return { key, direction: previous.direction === "desc" ? "asc" : "desc" };
      }
      return { key, direction: "desc" };
    });
  };
  const onWindowChange = (window: TimeWindow) => {
    if (window === selectedWindow) {
      return;
    }
    setSelectedWindow(window);
    const nextQuery: Record<string, string> = { window };
    if (selectedHub) {
      nextQuery.hub = selectedHub;
    }
    void router.replace(
      {
        pathname: "/contact-reasons-v2",
        query: nextQuery
      },
      undefined,
      { shallow: true }
    );
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-4 rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-900 via-slate-950 to-slate-950 p-6 shadow-xl">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href={{ pathname: "/", query: { window: selectedWindow } }}
                className="rounded-full border border-slate-800 px-3 py-1 text-xs font-semibold text-slate-300 transition hover:border-brand-400 hover:text-brand-100"
              >
                ← Back to dashboard
              </Link>
              <div>
                <h1 className="text-2xl font-bold text-white">Top 10 Contact Reasons V2 Drilldown</h1>
                <p className="text-sm text-slate-400">
                  Trend view across reason + subreason and hub distribution.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1 text-xs text-slate-300">
                {WINDOW_LABELS[selectedWindow]}
              </span>
              <span className="rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1 text-xs text-slate-300">
                Through {lastBucketLabel}
              </span>
              {salesRefreshStatus && (
                <span className="max-w-[360px] truncate rounded-full border border-sky-700/50 bg-sky-950/30 px-3 py-1 text-xs text-sky-100">
                  {salesRefreshStatus}
                </span>
              )}
              {hubSalesWarning && (
                <span className="max-w-[360px] truncate rounded-full border border-amber-700/60 bg-amber-950/30 px-3 py-1 text-xs text-amber-100">
                  {hubSalesWarning}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Time window</span>
            {WINDOW_OPTIONS.map((window) => (
              <button
                key={window}
                type="button"
                onClick={() => onWindowChange(window)}
                className={clsx(
                  "rounded-full border px-3 py-1 text-xs font-semibold transition",
                  window === selectedWindow
                    ? "border-brand-400 bg-brand-500/20 text-brand-50"
                    : "border-slate-700 text-slate-300 hover:border-brand-400 hover:text-brand-100"
                )}
              >
                {WINDOW_LABELS[window]}
              </button>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-4">
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
            <SummaryStat
              label="Hubs with sales data"
              value={hubSalesRows.length.toLocaleString()}
            />
          </div>
        </header>

        {!loading && !error && topHubConcentratedIssues.length > 0 && (
          <section className="rounded-3xl border border-amber-600/30 bg-amber-950/20 p-4 shadow-inner">
            <header className="mb-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-100">
                Top Hub Concentrated Issues
              </h2>
              <p className="text-xs text-amber-200/80">
                Top 5 concentrated issues in {WINDOW_LABELS[selectedWindow].toLowerCase()}.
              </p>
            </header>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
              {topHubConcentratedIssues.map((issue) => (
                <button
                  key={issue.key}
                  type="button"
                  onClick={() => setSelectedHub(issue.hub)}
                  className="rounded-xl border border-amber-500/30 bg-slate-900/60 p-3 text-left transition hover:border-amber-400/60 hover:bg-slate-900/80"
                >
                  <p className="truncate text-xs font-semibold text-amber-100">{issue.hub}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-slate-200">
                    {issue.topic} · {issue.sub}
                  </p>
                  <p className="mt-2 text-[11px] text-slate-300">
                    {issue.hubCount.toLocaleString()}/{issue.globalCount.toLocaleString()} · {issue.hubShare.toFixed(1)}%
                  </p>
                </button>
              ))}
            </div>
          </section>
        )}

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
            <div className="grid gap-6 xl:grid-cols-2">
              <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 shadow-inner">
                <header className="mb-4">
                  <h2 className="text-lg font-semibold text-white">Top reason ranking</h2>
                  <p className="text-sm text-slate-400">
                    Sorted by volume in {WINDOW_LABELS[selectedWindow].toLowerCase()} with trend sparkline.
                  </p>
                </header>
                <RankTableEmptyState rows={topReasonRows} emptyLabel={`No V2 reason data available in ${WINDOW_LABELS[selectedWindow].toLowerCase()}.`}>
                  <table className="min-w-full divide-y divide-slate-800 text-sm">
                    <thead className="bg-slate-900/80 text-slate-300">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">#</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">Reason + subreason</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">{countColumnLabel}</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">Share</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">{trendColumnLabel}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {topReasonRows.map((row, index) => {
                        const share = trendModel.totalRows > 0 ? (row.count / trendModel.totalRows) * 100 : 0;
                        return (
                          <tr key={row.key} className="bg-slate-900/30">
                            <td className="px-3 py-2 text-xs text-slate-400">{index + 1}</td>
                            <td className="px-3 py-2 text-slate-200">
                              <Link
                                href={`/reason-tickets?topic=${encodeURIComponent(row.topic)}&sub=${encodeURIComponent(row.sub)}&window=${selectedWindow}`}
                                className="rounded border border-slate-700 bg-slate-900/60 px-2 py-1 text-xs text-slate-200 transition hover:border-brand-500 hover:text-white"
                              >
                                {row.topic} · {row.sub}
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
                  <h2 className="text-lg font-semibold text-white">Hub ranking issue rankings</h2>
                  <p className="text-sm text-slate-400">
                    {hubSort.key === "normalizedToSales"
                      ? `Sorted by normalized sales across all ${allHubRankingRows.length} hubs.`
                      : `Hubs ordered by total V2 reason occurrences in ${WINDOW_LABELS[selectedWindow].toLowerCase()} (top 10 shown).`}
                  </p>
                </header>
                <RankTableEmptyState rows={displayedHubRankingRows} emptyLabel={`No hub volume available in ${WINDOW_LABELS[selectedWindow].toLowerCase()}.`}>
                  <table className="min-w-full divide-y divide-slate-800 text-sm">
                    <thead className="bg-slate-900/80 text-slate-300">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">#</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">Hub</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">
                          <button
                            type="button"
                            onClick={() => onHubSort("count")}
                            className="inline-flex items-center gap-1 hover:text-white"
                          >
                            {countColumnLabel} {hubSortIndicator("count")}
                          </button>
                        </th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">Share</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">
                          <button
                            type="button"
                            onClick={() => onHubSort("normalizedToSales")}
                            className="inline-flex items-center gap-1 hover:text-white"
                          >
                            Normalized to sales (%) {hubSortIndicator("normalizedToSales")}
                          </button>
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">{trendColumnLabel}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {displayedHubRankingRows.map((row, index) => {
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
                            <td className="px-3 py-2 text-right text-slate-300">{row.share.toFixed(1)}%</td>
                            <td className="px-3 py-2 text-right text-slate-300">
                              {formatSalesNormalizedValue(row.normalizedToSales)}
                            </td>
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
            </div>

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
                emptyLabel={
                  selectedHub
                    ? `No reason rows found for ${selectedHub} in ${WINDOW_LABELS[selectedWindow].toLowerCase()}.`
                    : "Select a hub to view reason trends."
                }
              >
                <table className="min-w-full divide-y divide-slate-800 text-sm">
                  <thead className="bg-slate-900/80 text-slate-300">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">#</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">Reason + subreason</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">Hub {selectedWindow}</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">Global {selectedWindow}</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide">Hub share</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">Scope</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">Hub {trendColumnLabel.toLowerCase()}</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">Global {trendColumnLabel.toLowerCase()}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {hubReasonRows.map((row, index) => (
                      <tr key={`${selectedHub}-${row.key}`} className="bg-slate-900/30">
                        <td className="px-3 py-2 text-xs text-slate-400">{index + 1}</td>
                        <td className="px-3 py-2 text-slate-200">{row.topic} · {row.sub}</td>
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

function buildTrendModel(rows: ConversationRow[], referenceNow: Date, window: TimeWindow): TrendModel {
  const buckets = buildBuckets(referenceNow, window);
  const bucketIndex = new Map<string, number>(buckets.map((bucket, index) => [bucket.key, index]));
  const windowStart = referenceNow.getTime() - WINDOW_DURATION_MS[window];
  const granularity = WINDOW_GRANULARITY[window];
  const trendLength = buckets.length;

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
    if (timestamp < windowStart || timestamp > referenceNow.getTime()) {
      return;
    }
    const bucketKey = formatBucketKey(referenceDate, granularity);
    const index = bucketIndex.get(bucketKey);
    if (index === undefined) {
      return;
    }

    totalRows += 1;
    const hub = resolveHubLabel(row);
    const reasonKey = makeReasonKey(topic, sub);

    if (!reasonMap.has(reasonKey)) {
      reasonMap.set(reasonKey, { topic, sub, count: 0, daily: createEmptyTrend(trendLength) });
    }
    incrementCounter(reasonMap.get(reasonKey)!, index);

    if (!hubMap.has(hub)) {
      hubMap.set(hub, { count: 0, daily: createEmptyTrend(trendLength) });
    }
    incrementCounter(hubMap.get(hub)!, index);

    const hubReasonKey = makeHubReasonKey(hub, reasonKey);
    if (!hubReasonMap.has(hubReasonKey)) {
      hubReasonMap.set(hubReasonKey, { count: 0, daily: createEmptyTrend(trendLength) });
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

function buildBuckets(referenceNow: Date, window: TimeWindow): Bucket[] {
  const granularity = WINDOW_GRANULARITY[window];
  const count = WINDOW_BUCKET_COUNT[window];
  const bucketMs = granularity === "hourly" ? HOUR_MS : DAY_MS;
  const aligned = granularity === "hourly" ? startOfHour(referenceNow) : startOfDay(referenceNow);
  return Array.from({ length: count }, (_, index) => {
    const offset = count - index - 1;
    const start = new Date(aligned.getTime() - offset * bucketMs);
    return {
      key: formatBucketKey(start, granularity),
      label: formatBucketLabel(start, granularity),
      start
    };
  });
}

function startOfHour(value: Date): Date {
  const hour = new Date(value);
  hour.setMinutes(0, 0, 0);
  return hour;
}

function startOfDay(value: Date): Date {
  const day = new Date(value);
  day.setHours(0, 0, 0, 0);
  return day;
}

function formatBucketLabel(value: Date, granularity: "hourly" | "daily"): string {
  if (granularity === "hourly") {
    return value.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit"
    });
  }
  return value.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}

function formatBucketKey(value: Date, granularity: "hourly" | "daily"): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  if (granularity === "hourly") {
    const hour = String(value.getHours()).padStart(2, "0");
    return `${year}-${month}-${day}-${hour}`;
  }
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

function normalizeHubKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeHubBaseKey(value: string): string {
  return normalizeHubKey(value)
    .replace(/\bgen\s*\d+\b/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractGeneration(value: string): "gen4" | "gen5" | null {
  const match = normalizeHubKey(value).match(/\bgen\s*(\d+)\b/);
  if (!match?.[1]) {
    return null;
  }
  if (match[1] === "4") {
    return "gen4";
  }
  if (match[1] === "5") {
    return "gen5";
  }
  return null;
}

function resolveHubSalesTotal(
  hubName: string,
  lookup: {
    exactByKey: Map<string, number>;
    fallbackByBase: Map<string, HubSalesFallbackEntry>;
  }
): number | null {
  const direct = lookup.exactByKey.get(normalizeHubKey(hubName));
  if (typeof direct === "number") {
    return direct;
  }

  const fallback = lookup.fallbackByBase.get(normalizeHubBaseKey(hubName));
  if (!fallback) {
    return null;
  }

  // Fallback applies when telemetry is split into GEN4 + GEN5 rows.
  if (fallback.hasGen4 && fallback.hasGen5 && fallback.rowCount >= 2) {
    return fallback.totalSales;
  }

  return null;
}

function formatSalesNormalizedValue(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "—";
  }
  return `${(value * 100).toFixed(2)}%`;
}

function toFiniteNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return parsed;
}

function createEmptyTrend(length: number): number[] {
  return Array.from({ length }, () => 0);
}
