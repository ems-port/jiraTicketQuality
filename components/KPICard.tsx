import { MetricSeries, TimeWindow } from "@/types";
import clsx from "clsx";

type KPICardProps = {
  title: string;
  value: number | null;
  formatValue?: (value: number | null) => string;
  series: MetricSeries[];
  selectedWindow: TimeWindow;
  onClick?: () => void;
  footerText?: string | null;
};

const defaultFormat = (value: number | null) =>
  value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function KPICard({
  title,
  value,
  formatValue = defaultFormat,
  series,
  selectedWindow,
  onClick,
  footerText
}: KPICardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-left shadow-sm transition hover:border-brand-500/70 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
        <span className="text-2xl font-bold text-white whitespace-nowrap">{formatValue(value)}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-900/80 p-2 text-xs text-slate-400">
        {series.map((entry) => (
          <div
            key={entry.window}
            className={clsx(
              "flex flex-col gap-1 rounded-md p-2 transition",
              entry.window === selectedWindow ? "bg-brand-500/20 text-white" : "bg-slate-900/80"
            )}
            title={
              entry.count !== undefined && entry.total !== undefined
                ? `${entry.count} of ${entry.total} tickets`
                : undefined
            }
          >
            <span className="font-bold uppercase tracking-wide">{entry.window}</span>
            <span className="text-sm font-semibold text-slate-100">
              {formatValue(entry.value)}
            </span>
            {entry.count !== undefined && entry.total !== undefined && (
              <span className="text-[10px] uppercase tracking-wide text-slate-400">
                {entry.total === 0
                  ? "No tickets"
                  : `${entry.count.toLocaleString()} of ${entry.total.toLocaleString()}`}
              </span>
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        {footerText ?? "Click to view ticket drilldown"}
      </p>
    </button>
  );
}
