import { formatDateTimeLocal } from "@/lib/date";
import { ImprovementTipEntry, ImprovementTipSummary } from "@/types";

type TipsOfTheDayPanelProps = {
  summary: ImprovementTipSummary;
  onOpen?: () => void;
};

export function TipsOfTheDayPanel({ summary, onOpen }: TipsOfTheDayPanelProps) {
  const { topEntries, total, unique, windowStart, windowEnd } = summary;
  const hasData = total > 0 && topEntries.length > 0;

  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-inner">
      <header className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Tips of the Day</h2>
          <p className="text-xs text-slate-400">Highlights pulled from the most recent 24 hours of coaching notes.</p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/70 px-3 py-1 text-xs text-slate-300">
          <ClockGlyph className="h-4 w-4 text-brand-300" aria-hidden="true" />
          <span>
            {formatDateTimeLocal(windowStart)} → {formatDateTimeLocal(windowEnd)}
          </span>
        </div>
      </header>

      <div className="grid gap-3 md:grid-cols-3">
        {hasData ? (
          topEntries.map((entry, index) => (
            <TipCard key={entry.tip} entry={entry} index={index} />
          ))
        ) : (
          <div className="md:col-span-3 rounded-2xl border border-dashed border-slate-700 bg-slate-900/60 p-6 text-sm text-slate-400">
            No recent improvement tips detected in the last 24 hours.
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
        <span>
          {total.toLocaleString()} coaching note{total === 1 ? "" : "s"} · {unique.toLocaleString()} unique
          theme{unique === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={onOpen}
          disabled={!hasData}
          className="rounded-full border border-brand-500/60 bg-brand-500/15 px-4 py-2 text-sm font-semibold text-brand-100 transition enabled:hover:bg-brand-500/30 disabled:border-slate-800 disabled:text-slate-500"
        >
          View full improvement report
        </button>
      </footer>
    </section>
  );
}

function TipCard({ entry, index }: { entry: ImprovementTipEntry; index: number }) {
  const label = `Tip ${index + 1}`;
  return (
    <article className="flex flex-col gap-2 rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-white">{label}</h3>
        <span className="rounded-full bg-brand-500/20 px-3 py-1 text-xs font-semibold text-brand-100">
          {entry.count.toLocaleString()}×
        </span>
      </div>
      <p className="text-sm text-slate-200">{entry.tip}</p>
      <p className="text-[11px] uppercase tracking-wide text-slate-500">
        Touching {entry.issueKeys.length.toLocaleString()} ticket{entry.issueKeys.length === 1 ? "" : "s"}
      </p>
    </article>
  );
}

function ClockGlyph({ className, "aria-hidden": ariaHidden }: { className?: string; "aria-hidden"?: boolean }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={ariaHidden}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v4.5l3 3" />
    </svg>
  );
}
