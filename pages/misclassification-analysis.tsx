import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { resolveDisplayName } from "@/lib/displayNames";
import { filterByWindow, isMisclassificationChange, isMisclassificationEligible } from "@/lib/metrics";
import { useDashboardStore } from "@/lib/useDashboardStore";

type CountEntry = {
  label: string;
  count: number;
};

type PairEntry = {
  original: string;
  corrected: string;
  count: number;
  originalTotal: number;
};

type AgentEntry = {
  agentId: string;
  displayName: string;
  eligible: number;
  misclassified: number;
  rate: number;
};

const MIN_AGENT_SAMPLE = 5;
const TOP_LIMIT = 10;

type TimePreset = "24h" | "7d" | "30d" | "all";

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toLabel(value: string | null): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length ? trimmed : "Unknown";
}

function toCountList(map: Map<string, number>, limit = TOP_LIMIT): CountEntry[] {
  return Array.from(map.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function getMaxCount(entries: CountEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.count), 0);
}

export default function MisclassificationAnalysisPage() {
  const { rows, idMapping, deAnonymize } = useDashboardStore();
  const [agentNameMap, setAgentNameMap] = useState<Record<string, string>>({});
  const [timePreset, setTimePreset] = useState<TimePreset>("7d");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  useEffect(() => {
    let active = true;
    const loadRoles = async () => {
      try {
        const response = await fetch("/api/roles?format=json");
        if (!response.ok) {
          return;
        }
        const map: Record<string, string> = {};
        const payload = (await response.json()) as { users?: Array<{ user_id?: string; display_name?: string }> };
        (payload.users ?? []).forEach((entry) => {
          const userId = entry.user_id?.toString().trim() ?? "";
          const displayName = entry.display_name?.toString().trim() ?? "";
          if (userId && displayName) {
            map[userId] = displayName;
          }
        });
        if (active) {
          setAgentNameMap(map);
        }
      } catch {
        // ignore role load issues; fall back to IDs
      }
    };
    loadRoles();
    return () => {
      active = false;
    };
  }, []);

  const filteredRows = useMemo(() => {
    if (startDate && endDate) {
      const start = new Date(`${startDate}T00:00:00.000Z`);
      const end = new Date(`${endDate}T23:59:59.999Z`);
      if (!Number.isNaN(start.valueOf()) && !Number.isNaN(end.valueOf())) {
        return rows.filter((row) => {
          const reference = row.endedAt ?? row.startedAt;
          if (!reference) {
            return false;
          }
          const time = reference.getTime();
          return time >= start.getTime() && time <= end.getTime();
        });
      }
    }

    if (timePreset === "all") {
      return rows;
    }

    return filterByWindow(rows, timePreset);
  }, [rows, startDate, endDate, timePreset]);

  const analytics = useMemo(() => {
    const misclassifiedRows = filteredRows.filter((row) => isMisclassificationChange(row));
    const eligibleRows = filteredRows.filter((row) => isMisclassificationEligible(row));
    const totalMisclassified = misclassifiedRows.length;
    const totalEligible = eligibleRows.length;

    const originalCounts = new Map<string, number>();
    const correctedCounts = new Map<string, number>();
    const pairCounts = new Map<string, number>();
    const originalTotals = new Map<string, number>();

    misclassifiedRows.forEach((row) => {
      const original = toLabel(row.contactReasonOriginal);
      const corrected = toLabel(row.contactReason);
      originalCounts.set(original, (originalCounts.get(original) ?? 0) + 1);
      correctedCounts.set(corrected, (correctedCounts.get(corrected) ?? 0) + 1);
      originalTotals.set(original, (originalTotals.get(original) ?? 0) + 1);
      const key = `${original}||${corrected}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    });

    const topOriginals = toCountList(originalCounts);
    const topCorrected = toCountList(correctedCounts);

    const pairEntries: PairEntry[] = Array.from(pairCounts.entries())
      .map(([key, count]) => {
        const [original, corrected] = key.split("||");
        return {
          original,
          corrected,
          count,
          originalTotal: originalTotals.get(original) ?? count
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 25);

    const agentBuckets = new Map<string, { eligible: number; misclassified: number }>();
    filteredRows.forEach((row) => {
      const agentId = row.agent || "Unassigned";
      const bucket = agentBuckets.get(agentId) ?? { eligible: 0, misclassified: 0 };
      if (isMisclassificationEligible(row)) {
        bucket.eligible += 1;
      }
      if (isMisclassificationChange(row)) {
        bucket.misclassified += 1;
      }
      agentBuckets.set(agentId, bucket);
    });

    const agentEntries: AgentEntry[] = Array.from(agentBuckets.entries()).map(([agentId, data]) => {
      const displayName = resolveDisplayName(agentId, idMapping, deAnonymize, agentNameMap).label;
      const rate = data.eligible > 0 ? data.misclassified / data.eligible : 0;
      return {
        agentId,
        displayName,
        eligible: data.eligible,
        misclassified: data.misclassified,
        rate
      };
    });

    const frequentErrors = [...agentEntries]
      .sort((a, b) => b.misclassified - a.misclassified)
      .slice(0, 10);

    const consistentErrors = agentEntries
      .filter((entry) => entry.eligible >= MIN_AGENT_SAMPLE)
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 10);

    const topOriginalSet = topOriginals.slice(0, 8).map((entry) => entry.label);
    const topCorrectedSet = topCorrected.slice(0, 6).map((entry) => entry.label);
    const pivot = topOriginalSet.map((original) => {
      const row = topCorrectedSet.map((corrected) => {
        const key = `${original}||${corrected}`;
        return pairCounts.get(key) ?? 0;
      });
      return { original, counts: row };
    });

    const improvementTargets = Array.from(originalTotals.entries())
      .map(([original, total]) => {
        let bestCorrected = "";
        let bestCount = 0;
        pairCounts.forEach((count, key) => {
          const [orig, corrected] = key.split("||");
          if (orig !== original) {
            return;
          }
          if (count > bestCount) {
            bestCount = count;
            bestCorrected = corrected;
          }
        });
        return {
          original,
          corrected: bestCorrected || "Unknown",
          count: bestCount,
          total,
          rate: total > 0 ? bestCount / total : 0
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalMisclassified,
      totalEligible,
      topOriginals,
      topCorrected,
      pairEntries,
      frequentErrors,
      consistentErrors,
      pivot,
      topCorrectedSet,
      improvementTargets
    };
  }, [filteredRows, idMapping, deAnonymize, agentNameMap]);

  const topOriginalMax = getMaxCount(analytics.topOriginals);
  const topCorrectedMax = getMaxCount(analytics.topCorrected);

  return (
    <main className="min-h-screen bg-slate-950 pb-16">
      <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-3 rounded-3xl border border-slate-800 bg-slate-900/40 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-white">Misclassification Analysis</h1>
              <p className="text-sm text-slate-400">
                Based on {analytics.totalMisclassified.toLocaleString()} misclassifications out of{" "}
                {analytics.totalEligible.toLocaleString()} eligible conversations in the loaded dataset.
              </p>
            </div>
            <Link
              href="/"
              className="rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-brand-500 hover:text-brand-200"
            >
              Back to dashboard
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
            <div className="flex flex-wrap items-center gap-2">
              {(["24h", "7d", "30d", "all"] as TimePreset[]).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => {
                    setTimePreset(preset);
                    if (preset === "all") {
                      setStartDate("");
                      setEndDate("");
                      return;
                    }
                    const now = new Date();
                    const offsetDays = preset === "24h" ? 1 : preset === "7d" ? 7 : 30;
                    const start = new Date(now.getTime() - offsetDays * 24 * 60 * 60 * 1000);
                    setStartDate(formatDateInput(start));
                    setEndDate(formatDateInput(now));
                  }}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                    timePreset === preset
                      ? "border-brand-400 bg-brand-500/20 text-brand-100"
                      : "border-slate-700 text-slate-300 hover:border-brand-400/60"
                  }`}
                >
                  {preset === "all" ? "All" : preset}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-slate-400">Custom range</label>
              <input
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-900/60 px-2 py-1 text-xs text-white focus:border-brand-500 focus:outline-none"
              />
              <span className="text-xs text-slate-500">to</span>
              <input
                type="date"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-900/60 px-2 py-1 text-xs text-white focus:border-brand-500 focus:outline-none"
              />
              {(startDate || endDate) && (
                <button
                  type="button"
                  onClick={() => {
                    setStartDate("");
                    setEndDate("");
                  }}
                  className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 transition hover:border-slate-500"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </header>

        {!analytics.totalMisclassified ? (
          <div className="rounded-3xl border border-slate-800 bg-slate-900/40 p-8 text-center text-slate-300">
            No misclassified conversations found in the current dataset.
          </div>
        ) : (
          <>
            <section className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-3xl border border-slate-800 bg-slate-900/40 p-6">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                  Most Misclassified Labels
                </h2>
                <div className="mt-4 space-y-3">
                  {analytics.topOriginals.map((entry) => (
                    <div key={entry.label} className="space-y-1">
                      <div className="flex items-center justify-between text-sm text-slate-200">
                        <span>{entry.label}</span>
                        <span className="text-slate-400">{entry.count}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full rounded-full bg-amber-400/70"
                          style={{ width: `${(entry.count / Math.max(1, topOriginalMax)) * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-3xl border border-slate-800 bg-slate-900/40 p-6">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                  Most Common Correct Labels
                </h2>
                <div className="mt-4 space-y-3">
                  {analytics.topCorrected.map((entry) => (
                    <div key={entry.label} className="space-y-1">
                      <div className="flex items-center justify-between text-sm text-slate-200">
                        <span>{entry.label}</span>
                        <span className="text-slate-400">{entry.count}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full rounded-full bg-brand-500/70"
                          style={{ width: `${(entry.count / Math.max(1, topCorrectedMax)) * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="rounded-3xl border border-slate-800 bg-slate-900/40 p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                Most Common Misclassification Paths
              </h2>
              <div className="mt-4 overflow-auto">
                <table className="min-w-full divide-y divide-slate-800 text-sm">
                  <thead className="text-xs uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-4 py-2 text-left">Original label</th>
                      <th className="px-4 py-2 text-left">Correct label</th>
                      <th className="px-4 py-2 text-right">Count</th>
                      <th className="px-4 py-2 text-right">% of original</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-900/70">
                    {analytics.pairEntries.map((entry) => (
                      <tr key={`${entry.original}-${entry.corrected}`}>
                        <td className="px-4 py-2 text-slate-100">{entry.original}</td>
                        <td className="px-4 py-2 text-slate-100">{entry.corrected}</td>
                        <td className="px-4 py-2 text-right text-slate-200">{entry.count}</td>
                        <td className="px-4 py-2 text-right text-slate-400">
                          {entry.originalTotal > 0
                            ? `${Math.round((entry.count / entry.originalTotal) * 100)}%`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-3xl border border-slate-800 bg-slate-900/40 p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                Pivot View (Top Labels)
              </h2>
              <div className="mt-4 overflow-auto">
                <table className="min-w-full divide-y divide-slate-800 text-sm">
                  <thead className="text-xs uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-4 py-2 text-left">Original → Correct</th>
                      {analytics.topCorrectedSet.map((label) => (
                        <th key={label} className="px-4 py-2 text-right">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-900/70">
                    {analytics.pivot.map((row) => (
                      <tr key={row.original}>
                        <td className="px-4 py-2 text-slate-100">{row.original}</td>
                        {row.counts.map((count, index) => (
                          <td key={`${row.original}-${index}`} className="px-4 py-2 text-right text-slate-300">
                            {count || "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-3xl border border-slate-800 bg-slate-900/40 p-6">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                  Agents With Most Misclassifications
                </h2>
                <div className="mt-4 space-y-3">
                  {analytics.frequentErrors.map((entry) => (
                    <div key={entry.agentId} className="flex items-center justify-between text-sm text-slate-200">
                      <span>{entry.displayName}</span>
                      <span className="text-slate-400">
                        {entry.misclassified} / {entry.eligible}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-3xl border border-slate-800 bg-slate-900/40 p-6">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                  Consistently High Error Rates
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Ranked by misclassification rate (min {MIN_AGENT_SAMPLE} eligible conversations).
                </p>
                <div className="mt-4 space-y-3">
                  {analytics.consistentErrors.map((entry) => (
                    <div key={entry.agentId} className="flex items-center justify-between text-sm text-slate-200">
                      <span>{entry.displayName}</span>
                      <span className="text-slate-400">
                        {Math.round(entry.rate * 100)}% ({entry.misclassified}/{entry.eligible})
                      </span>
                    </div>
                  ))}
                  {!analytics.consistentErrors.length && (
                    <p className="text-sm text-slate-500">Not enough data to compute consistency yet.</p>
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-3xl border border-slate-800 bg-slate-900/40 p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                Priority Coaching Opportunities
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Most common corrections per original label.
              </p>
              <div className="mt-4 overflow-auto">
                <table className="min-w-full divide-y divide-slate-800 text-sm">
                  <thead className="text-xs uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-4 py-2 text-left">Original label</th>
                      <th className="px-4 py-2 text-left">Most common correction</th>
                      <th className="px-4 py-2 text-right">Count</th>
                      <th className="px-4 py-2 text-right">% of original</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-900/70">
                    {analytics.improvementTargets.map((entry) => (
                      <tr key={entry.original}>
                        <td className="px-4 py-2 text-slate-100">{entry.original}</td>
                        <td className="px-4 py-2 text-slate-100">{entry.corrected}</td>
                        <td className="px-4 py-2 text-right text-slate-200">{entry.count}</td>
                        <td className="px-4 py-2 text-right text-slate-400">
                          {Math.round(entry.rate * 100)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
