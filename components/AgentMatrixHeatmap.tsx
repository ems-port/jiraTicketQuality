import { useMemo, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { resolveAgentRole } from "@/lib/roles";
import { AgentMatrixRow, AgentRole, EscalationMetricKind, TimeWindow } from "@/types";

type SortKey =
  | "agent"
  | "avgAgentScore"
  | "avgFirstResponseMinutes"
  | "avgAgentResponseMinutes"
  | "avgResolutionDurationMinutes"
  | "resolvedRate"
  | "escalatedCount"
  | "misclassifiedCount";
type SortDirection = "asc" | "desc";

type AgentMatrixHeatmapProps = {
  rows: AgentMatrixRow[];
  window: TimeWindow;
  mapping: Record<string, string>;
  agentMapping: Record<string, string>;
  deAnonymize: boolean;
  roleMapping: Record<string, AgentRole>;
  escalationMetric: EscalationMetricKind;
  averageAgentScore: number | null;
  onSelectMisclassified?: (agentId: string) => void;
};

export function AgentMatrixHeatmap({
  rows,
  window,
  mapping,
  agentMapping,
  deAnonymize,
  roleMapping,
  escalationMetric,
  averageAgentScore,
  onSelectMisclassified
}: AgentMatrixHeatmapProps) {
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: SortDirection }>({
    key: "agent",
    direction: "asc"
  });

  const sortedRows = useMemo(() => {
    const data = [...rows];
    data.sort((a, b) => {
      const { key, direction } = sortConfig;
      const modifier = direction === "asc" ? 1 : -1;
      const aValue = getSortValue(a, key);
      const bValue = getSortValue(b, key);
      if (typeof aValue === "string" && typeof bValue === "string") {
        return aValue.localeCompare(bValue) * modifier;
      }
      const aNumber = typeof aValue === "number" ? aValue : Number(aValue ?? 0);
      const bNumber = typeof bValue === "number" ? bValue : Number(bValue ?? 0);
      return (aNumber - bNumber) * modifier;
    });
    return data;
  }, [rows, sortConfig]);

  const maxFirst = maxValue(sortedRows.map((row) => row.avgFirstResponseMinutes));
  const maxAvg = maxValue(sortedRows.map((row) => row.avgAgentResponseMinutes));
  const maxResolutionDuration = maxValue(sortedRows.map((row) => row.avgResolutionDurationMinutes));
  const maxResolved = maxValue(sortedRows.map((row) => row.resolvedRate));
  const maxEscalated = Math.max(...sortedRows.map((row) => row.escalatedCount), 0);

  const handleSort = (key: SortKey) => {
    setSortConfig((prev) => {
      if (prev.key === key) {
        return {
          key,
          direction: prev.direction === "asc" ? "desc" : "asc"
        };
      }
      return { key, direction: key === "agent" ? "asc" : "desc" };
    });
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-white">Agent Performance Matrix</h3>
          <span className="text-xs uppercase tracking-wide text-slate-400">Window: {window}</span>
        </div>
        <div className="text-right text-xs text-slate-400">
          Mean agent score
          <p className="text-sm font-semibold text-brand-200">
            {averageAgentScore === null ? "—" : averageAgentScore.toFixed(2)}
          </p>
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-900/50 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              {columns(escalationMetric).map((column) => (
                <th key={column.key} className="px-4 py-3 text-left font-semibold">
                  <button
                    type="button"
                    onClick={() => handleSort(column.key)}
                    className="flex items-center gap-2 text-left text-xs uppercase tracking-wide text-slate-300 transition hover:text-white"
                  >
                    <span>{column.label}</span>
                    <span className="text-[10px] text-slate-500">
                      {sortConfig.key === column.key
                        ? sortConfig.direction === "asc"
                          ? "▲"
                          : "▼"
                        : "↕"}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            {sortedRows.map((row) => (
              <tr key={row.agent} className="hover:bg-slate-900/40">
                <td className="px-4 py-3 font-semibold text-white">
                  <DisplayName
                    id={row.agent}
                    mapping={mapping}
                    agentMapping={agentMapping}
                    deAnonymize={deAnonymize}
                    titlePrefix="Agent ID"
                    showRole={true}
                    role={resolveAgentRole(row.agent, roleMapping)}
                  />
                </td>
                <td className="px-4 py-3 text-brand-200 font-semibold">
                  {formatScore(row.avgAgentScore)}
                </td>
                <td className="px-4 py-3" style={{ background: heatmap(row.avgFirstResponseMinutes, maxFirst, true) }}>
                  {formatNumber(row.avgFirstResponseMinutes)}
                </td>
                <td className="px-4 py-3" style={{ background: heatmap(row.avgAgentResponseMinutes, maxAvg, true) }}>
                  {formatNumber(row.avgAgentResponseMinutes)}
                </td>
                <td
                  className="px-4 py-3"
                  style={{ background: heatmap(row.avgResolutionDurationMinutes, maxResolutionDuration, true, 60) }}
                >
                  {formatDuration(row.avgResolutionDurationMinutes)}
                </td>
                <td className="px-4 py-3" style={{ background: heatmap(row.resolvedRate, maxResolved, false, 140) }}>
                  {formatPercent(row.resolvedRate)}
                </td>
                <td className="px-4 py-3" style={{ background: heatmap(row.escalatedCount, maxEscalated, false, 0) }}>
                  {row.escalatedCount}
                </td>
                <td className="px-4 py-3">
                  {onSelectMisclassified && row.misclassifiedCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => onSelectMisclassified(row.agent)}
                      className="rounded-full border border-amber-500/40 bg-amber-500/15 px-3 py-1 text-sm font-semibold text-amber-100 transition hover:bg-amber-500/30"
                    >
                      {row.misclassifiedCount}
                    </button>
                  ) : (
                    row.misclassifiedCount
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td className="px-4 py-6 text-center text-slate-400" colSpan={8}>
                  No agent performance data for this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function maxValue(values: Array<number | null>): number {
  return Math.max(...values.map((value) => value ?? 0), 0);
}

function heatmap(
  value: number | null,
  max: number,
  invert: boolean,
  hue: number = invert ? 140 : 210
): string | undefined {
  if (value === null || max <= 0) {
    return undefined;
  }
  const ratio = clamp(value / max, 0, 1);
  const adjusted = invert ? 1 - ratio : ratio;
  const opacity = 0.15 + adjusted * 0.55;
  return `hsla(${hue}, 85%, 55%, ${opacity.toFixed(2)})`;
}

function formatNumber(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "—";
  }
  return value.toFixed(1);
}

function formatDuration(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "—";
  }
  if (value >= 60) {
    const hours = Math.floor(value / 60);
    const minutes = Math.round(value % 60);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${value.toFixed(1)}m`;
}

function formatPercent(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "—";
  }
  return `${(value * 100).toFixed(0)}%`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatScore(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "—";
  }
  return value.toFixed(2);
}

function columns(metric: EscalationMetricKind) {
  return [
    { key: "agent", label: "Agent" },
    { key: "avgAgentScore", label: "Avg Agent Score" },
    { key: "avgFirstResponseMinutes", label: "Avg First Response (min)" },
    { key: "avgAgentResponseMinutes", label: "Avg Agent Response (min)" },
    { key: "avgResolutionDurationMinutes", label: "Avg Duration to Resolution" },
    { key: "resolvedRate", label: "Resolved Rate" },
    {
      key: "escalatedCount",
      label: metric === "tier" ? "Escalation T1→T2" : "Handovers T1→Any"
    },
    { key: "misclassifiedCount", label: "Misclassified" }
  ] as const;
}

function getSortValue(row: AgentMatrixRow, key: SortKey): number | string | null {
  switch (key) {
    case "agent":
      return row.agent.toLowerCase();
    case "avgFirstResponseMinutes":
      return row.avgFirstResponseMinutes;
    case "avgAgentResponseMinutes":
      return row.avgAgentResponseMinutes;
    case "avgResolutionDurationMinutes":
      return row.avgResolutionDurationMinutes;
    case "avgAgentScore":
      return row.avgAgentScore;
    case "resolvedRate":
      return row.resolvedRate;
    case "escalatedCount":
      return row.escalatedCount;
    case "misclassifiedCount":
      return row.misclassifiedCount;
    default:
      return null;
  }
}
