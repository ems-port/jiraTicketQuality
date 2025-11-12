import { DisplayName } from "@/components/DisplayName";
import { resolveAgentRole } from "@/lib/roles";
import { AgentMatrixRow, AgentRole, EscalationMetricKind, TimeWindow } from "@/types";

type AgentMatrixHeatmapProps = {
  rows: AgentMatrixRow[];
  window: TimeWindow;
  mapping: Record<string, string>;
  deAnonymize: boolean;
  roleMapping: Record<string, AgentRole>;
  escalationMetric: EscalationMetricKind;
};

export function AgentMatrixHeatmap({
  rows,
  window,
  mapping,
  deAnonymize,
  roleMapping,
  escalationMetric
}: AgentMatrixHeatmapProps) {
  const maxFirst = maxValue(rows.map((row) => row.avgFirstResponseMinutes));
  const maxAvg = maxValue(rows.map((row) => row.avgAgentResponseMinutes));
  const maxResolved = maxValue(rows.map((row) => row.resolvedRate));
  const maxEscalated = Math.max(...rows.map((row) => row.escalatedCount), 0);

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
      <header className="mb-4 flex items-baseline justify-between">
        <h3 className="text-base font-semibold text-white">Agent Performance Matrix</h3>
        <span className="text-xs uppercase tracking-wide text-slate-400">
          Window: {window}
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-900/50 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3 text-left font-semibold text-white">Agent</th>
              <th className="px-4 py-3 text-left font-semibold">Avg First Response (min)</th>
              <th className="px-4 py-3 text-left font-semibold">Avg Agent Response (min)</th>
              <th className="px-4 py-3 text-left font-semibold">Resolved Rate</th>
              <th className="px-4 py-3 text-left font-semibold">
                {escalationMetric === "tier" ? "Escalation T1→T2" : "Handovers T1→Any"}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            {rows.map((row) => (
              <tr key={row.agent} className="hover:bg-slate-900/40">
                <td className="px-4 py-3 font-semibold text-white">
                  <DisplayName
                    id={row.agent}
                    mapping={mapping}
                    deAnonymize={deAnonymize}
                    titlePrefix="Agent ID"
                    showRole={true}
                    role={resolveAgentRole(row.agent, roleMapping)}
                  />
                </td>
                <td className="px-4 py-3" style={{ background: heatmap(row.avgFirstResponseMinutes, maxFirst, true) }}>
                  {formatNumber(row.avgFirstResponseMinutes)}
                </td>
                <td className="px-4 py-3" style={{ background: heatmap(row.avgAgentResponseMinutes, maxAvg, true) }}>
                  {formatNumber(row.avgAgentResponseMinutes)}
                </td>
                <td className="px-4 py-3" style={{ background: heatmap(row.resolvedRate, maxResolved, false, 140) }}>
                  {formatPercent(row.resolvedRate)}
                </td>
                <td className="px-4 py-3" style={{ background: heatmap(row.escalatedCount, maxEscalated, false, 0) }}>
                  {row.escalatedCount}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td className="px-4 py-6 text-center text-slate-400" colSpan={5}>
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

function formatPercent(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "—";
  }
  return `${(value * 100).toFixed(0)}%`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
