import { DisplayName } from "@/components/DisplayName";
import { AgentPerformance, AgentPerformancePoint } from "@/types";

type AgentRankListProps = {
  title: string;
  agents: AgentPerformance[];
  mapping: Record<string, string>;
  deAnonymize: boolean;
};

export function AgentRankList({ title, agents, mapping, deAnonymize }: AgentRankListProps) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
      <header className="mb-4 flex items-baseline justify-between">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <span className="text-xs uppercase tracking-wide text-slate-400">
          Last 7 days · Mean score
        </span>
      </header>
      <ul className="flex flex-col gap-3">
        {agents.map((agent, index) => (
          <li
            key={agent.agent}
            className="flex items-center gap-4 rounded-xl border border-slate-800/60 bg-slate-900/60 px-4 py-3"
          >
            <span className="text-lg font-bold text-brand-300">#{index + 1}</span>
            <div className="flex flex-1 flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-white">
                  <DisplayName
                    id={agent.agent}
                    mapping={mapping}
                    deAnonymize={deAnonymize}
                    titlePrefix="Agent ID"
                  />
                </p>
                <span className="text-sm font-semibold text-brand-200">
                  {formatScore(agent.meanScore)}
                </span>
              </div>
              <Sparkline points={agent.sparkline} />
              <p className="text-[11px] uppercase tracking-wide text-slate-500">
                {agent.issues.length} ticket{agent.issues.length === 1 ? "" : "s"}
              </p>
            </div>
          </li>
        ))}
        {!agents.length && (
          <li className="rounded-xl border border-dashed border-slate-700 p-4 text-center text-sm text-slate-400">
            Not enough data to rank agents for this window.
          </li>
        )}
      </ul>
    </section>
  );
}

function Sparkline({ points }: { points: AgentPerformancePoint[] }) {
  if (!points.length) {
    return <div className="h-8 rounded bg-slate-800/70" />;
  }

  const values = points
    .map((point) => point.meanScore ?? 0)
    .filter((value) => Number.isFinite(value));
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 5);
  const width = 140;
  const height = 36;
  const padding = 4;

  const polyline = points
    .map((point, index) => {
      const value = point.meanScore ?? values[values.length - 1] ?? 0;
      const x =
        points.length === 1
          ? padding + (width - padding * 2) / 2
          : padding +
            (index / (points.length - 1)) * Math.max(1, width - padding * 2);
      const ratio = max === min ? 0.5 : (value - min) / (max - min);
      const y = height - padding - ratio * Math.max(1, height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg
      aria-hidden={true}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="text-brand-400"
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={polyline}
      />
    </svg>
  );
}

function formatScore(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "—";
  }
  return value.toFixed(2);
}
