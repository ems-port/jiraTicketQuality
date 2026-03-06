import type { ImprovementTopicTrendEntry } from "@/types";

type ImprovementTopicTrendsPanelProps = {
  entries: ImprovementTopicTrendEntry[];
  windowDays: number;
  loading?: boolean;
  error?: string | null;
};

export function ImprovementTopicTrendsPanel({
  entries,
  windowDays,
  loading = false,
  error = null
}: ImprovementTopicTrendsPanelProps) {
  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-inner">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">Improvement Topic Trends</h2>
          <p className="text-xs text-slate-400">Last {windowDays} days - volume + manager usefulness signal</p>
        </div>
      </header>

      {error && <p className="text-sm text-rose-300">Unable to load trends: {error}</p>}
      {loading && <p className="text-sm text-slate-400">Loading trend data...</p>}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => (
          <article
            key={entry.topicKey}
            className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-white">{entry.title}</h3>
              <span className="rounded-full bg-brand-500/20 px-2 py-1 text-[11px] font-semibold text-brand-100">
                {entry.totalCount}
              </span>
            </div>

            <p className="mt-1 text-xs text-slate-400">
              7d delta:{" "}
              <span className={entry.delta7d >= 0 ? "text-emerald-300" : "text-rose-300"}>
                {entry.delta7d >= 0 ? "+" : ""}
                {entry.delta7d}
              </span>
            </p>
            <p className="text-xs text-slate-400">
              Useful votes:{" "}
              {entry.positiveRate == null
                ? "no feedback yet"
                : `${Math.round(entry.positiveRate * 100)}% (${entry.upCount}/${entry.upCount + entry.downCount})`}
            </p>
            <Sparkline points={entry.series.map((point) => point.count)} />
          </article>
        ))}
        {!entries.length && !loading && (
          <div className="md:col-span-2 xl:col-span-3 rounded-2xl border border-dashed border-slate-700 bg-slate-900/60 p-6 text-sm text-slate-400">
            No trend rows available yet.
          </div>
        )}
      </div>
    </section>
  );
}

function Sparkline({ points }: { points: number[] }) {
  const safePoints = points.length ? points : [0];
  const max = Math.max(...safePoints, 1);
  const min = Math.min(...safePoints, 0);
  const width = 160;
  const height = 48;
  const padding = 6;
  const coordinates = safePoints.map((value, index) => {
    const x =
      safePoints.length === 1
        ? width / 2
        : padding + (index / (safePoints.length - 1)) * Math.max(1, width - padding * 2);
    const ratio = max === min ? 0.5 : (value - min) / (max - min);
    const y = height - padding - ratio * Math.max(1, height - padding * 2);
    return `${x},${y}`;
  });

  return (
    <svg
      aria-hidden={true}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="mt-3 text-brand-400"
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={coordinates.join(" ")}
      />
    </svg>
  );
}
