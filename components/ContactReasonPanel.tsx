import { useMemo } from "react";

import { ContactReasonSummary, ContactReasonTrendEntry } from "@/types";

type ContactReasonPanelProps = {
  summary: ContactReasonSummary;
  window: "24h" | "7d" | "30d";
  onSelect: (reason: string) => void;
};

const JIRA_BASE_URL = "https://portapp.atlassian.net/browse/";

export function ContactReasonPanel({ summary, window, onSelect }: ContactReasonPanelProps) {
  const windowLabel = window === "24h" ? "Last 24 hours" : window === "7d" ? "Last 7 days" : "Last 30 days";
  const entries = summary.entries;
  const total = summary.total;

  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-inner">
      <header className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Top 10 Contact Reasons</h2>
          <p className="text-xs text-slate-400">{windowLabel}</p>
        </div>
        <span className="rounded-full border border-slate-800 bg-slate-900/70 px-3 py-1 text-xs text-slate-300">
          {total.toLocaleString()} ticket{total === 1 ? "" : "s"} in view
        </span>
      </header>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => (
          <div key={entry.reason} className="group relative">
            <button
              type="button"
              onClick={() => onSelect(entry.reason)}
              className="flex w-full flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 text-left transition hover:border-brand-500/60 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-white">{entry.reason}</h3>
                <span className="rounded-full bg-brand-500/20 px-3 py-1 text-xs font-semibold text-brand-100">
                  {entry.count.toLocaleString()} · {entry.percentage.toFixed(1)}%
                </span>
              </div>
              <Sparkline points={entry.sparkline} />
            </button>
            <TooltipContent entry={entry} />
          </div>
        ))}
        {!entries.length && (
          <div className="md:col-span-2 xl:col-span-3 rounded-2xl border border-dashed border-slate-700 bg-slate-900/60 p-6 text-sm text-slate-400">
            No contact reason data available for this window.
          </div>
        )}
      </div>
    </section>
  );
}

function Sparkline({
  points
}: {
  points: {
    label: string;
    count: number;
  }[];
}) {
  const values = points.map((point) => point.count);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const width = 160;
  const height = 48;
  const padding = 6;
  const coordinates = points.map((point, index) => {
    const x =
      points.length === 1
        ? width / 2
        : padding + (index / (points.length - 1)) * Math.max(1, width - padding * 2);
    const ratio = max === min ? 0.5 : (point.count - min) / (max - min);
    const y = height - padding - ratio * Math.max(1, height - padding * 2);
    return `${x},${y}`;
  });

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
        points={coordinates.join(" ")}
      />
    </svg>
  );
}

function TooltipContent({ entry }: { entry: ContactReasonTrendEntry }) {
  const ticketLinks = useMemo(
    () =>
      entry.recentIssues.map((issueKey) => (
        <a
          key={issueKey}
          href={`${JIRA_BASE_URL}${issueKey}`}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-brand-500/40 bg-brand-500/15 px-2 py-1 text-xs text-brand-100 hover:bg-brand-500/30"
        >
          {issueKey}
        </a>
      )),
    [entry.recentIssues]
  );

  return (
    <div className="pointer-events-none absolute left-1/2 top-full z-40 hidden w-64 -translate-x-1/2 translate-y-2 rounded-2xl border border-slate-700 bg-slate-900/95 p-4 text-xs text-slate-200 shadow-xl group-hover:block group-focus-within:block">
      <p className="font-semibold text-white">{entry.reason}</p>
      <p className="mt-1 text-[11px] uppercase tracking-wide text-slate-400">
        {entry.count.toLocaleString()} tickets · {entry.percentage.toFixed(1)}%
      </p>
      <div className="pointer-events-auto mt-3 flex flex-wrap gap-2">{ticketLinks}</div>
    </div>
  );
}
