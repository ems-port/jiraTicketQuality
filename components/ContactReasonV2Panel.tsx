import { useMemo, useState } from "react";

import type { ContactReasonV2Summary, ConversationRow } from "@/types";

type Props = {
  summary: ContactReasonV2Summary;
  window: "24h" | "7d" | "30d";
  rows: ConversationRow[];
};

export function ContactReasonV2Panel({ summary, window, rows }: Props) {
  const windowLabel = window === "24h" ? "Last 24 hours" : window === "7d" ? "Last 7 days" : "Last 30 days";
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const [showEbikePivot, setShowEbikePivot] = useState(false);

  const ebikePivot = useMemo(() => {
    const pivot: Record<string, Record<string, number>> = {};
    rows.forEach((row) => {
      const topic = row.contactReasonV2Topic || row.contactReasonV2;
      if (!topic || !topic.toLowerCase().startsWith("ebike")) return;
      const bike = row.bikeQrCode || row.bikeQrMismatch || (row.raw?.bike_qr_code as string) || "Unknown";
      const sub = row.contactReasonV2Sub || "Unspecified";
      pivot[bike] = pivot[bike] || {};
      pivot[bike][sub] = (pivot[bike][sub] || 0) + 1;
    });
    return pivot;
  }, [rows]);

  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-inner">
      <header className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Top 10 Contact Reasons V2</h2>
          <p className="text-xs text-slate-400">{windowLabel}</p>
        </div>
        <span className="rounded-full border border-slate-800 bg-slate-900/70 px-3 py-1 text-xs text-slate-300">
          {summary.total.toLocaleString()} ticket{summary.total === 1 ? "" : "s"} in view
        </span>
      </header>

      <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
        {summary.entries.map((entry) => {
          const isOpen = openTopic === entry.topic;
          return (
            <div key={entry.topic} className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
              <button
                type="button"
                onClick={() => setOpenTopic(isOpen ? null : entry.topic)}
                className="flex w-full items-center justify-between gap-3 text-left"
              >
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-semibold text-white">{entry.topic}</p>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span>{entry.count.toLocaleString()} · {entry.percentage.toFixed(1)}%</span>
                    {entry.deltaPercentage !== undefined && (
                      <span className={entry.deltaPercentage >= 0 ? "text-emerald-300" : "text-rose-300"}>
                        {entry.deltaPercentage >= 0 ? "↑" : "↓"} {entry.deltaPercentage.toFixed(1)}%
                      </span>
                    )}
                  </div>
                </div>
                <span className="text-xs text-slate-300">{isOpen ? "−" : "+"}</span>
              </button>
              {isOpen && (
                <div className="mt-3 space-y-2">
                  {entry.subs.length ? (
                    entry.subs.map((sub) => (
                      <div
                        key={`${entry.topic}-${sub.sub ?? "none"}`}
                        className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-200"
                      >
                        <span className="truncate">{sub.sub ?? "Unspecified"}</span>
                        <div className="flex items-center gap-2 text-slate-400">
                          <span>
                            {sub.count.toLocaleString()} · {sub.percentage.toFixed(1)}%
                          </span>
                          {sub.deltaPercentage !== undefined && (
                            <span className={sub.deltaPercentage >= 0 ? "text-emerald-300" : "text-rose-300"}>
                              {sub.deltaPercentage >= 0 ? "↑" : "↓"} {sub.deltaPercentage.toFixed(1)}%
                            </span>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="rounded-xl border border-dashed border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-400">
                      No sub-reasons available.
                    </p>
                  )}
                  {entry.topic.toLowerCase().startsWith("ebike") && (
                    <div className="mt-3">
                      <Link
                        href="/bike-issues"
                        className="text-xs font-semibold text-brand-100 hover:text-brand-50"
                      >
                        View bike pivot →
                      </Link>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!summary.entries.length && (
          <div className="lg:col-span-2 xl:col-span-3 rounded-2xl border border-dashed border-slate-700 bg-slate-900/60 p-6 text-sm text-slate-400">
            No contact reason data available for this window.
          </div>
        )}
      </div>
    </section>
  );
}
import Link from "next/link";
