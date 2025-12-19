import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";

type TicketRow = {
  issueKey: string | null;
  contactReasonV2: string | null;
  contactReasonV2Topic: string | null;
  contactReasonV2Sub: string | null;
  summary: string | null;
  problem: string | null;
  resolution: string | null;
  steps: string[];
  processedAt: string | null;
  conversationRating?: number | null;
  customerSentimentPrimary?: string | null;
  durationMinutes?: number | null;
};

type ApiResponse = {
  rows: TicketRow[];
  total: number;
  windowDays: number;
  topic: string;
  sub: string | null;
};

type SortKey =
  | "issueKey"
  | "summary"
  | "problem"
  | "resolution"
  | "steps"
  | "conversationRating"
  | "customerSentimentPrimary"
  | "durationMinutes"
  | "processedAt";

export default function ReasonTicketsPage() {
  const router = useRouter();
  const { topic, sub, window } = router.query;
  const [data, setData] = useState<TicketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<number>(30);
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({
    key: "processedAt",
    direction: "desc"
  });

  useEffect(() => {
    if (!topic || typeof topic !== "string") return;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("topic", topic);
        if (typeof sub === "string" && sub.trim()) params.set("sub", sub.trim());
        if (typeof window === "string" && window.trim()) params.set("window", window.trim());
        const response = await fetch(`/api/reason-tickets?${params.toString()}`);
        if (!response.ok) {
          throw new Error(`Failed to load tickets (${response.status})`);
        }
      const payload: ApiResponse = await response.json();
      setData(payload.rows);
      setWindowDays(payload.windowDays);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [topic, sub, window]);

  const heading = useMemo(() => {
    if (typeof topic !== "string") return "Tickets";
    if (typeof sub === "string" && sub.trim()) {
      return `${topic} — ${sub}`;
    }
    return topic;
  }, [topic, sub]);

  const sorted = useMemo(() => {
    const rows = [...data];
    const dir = sort.direction === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const get = (row: TicketRow) => {
        switch (sort.key) {
          case "issueKey":
            return row.issueKey || "";
          case "summary":
            return row.summary || "";
          case "problem":
            return row.problem || "";
          case "resolution":
            return row.resolution || "";
          case "steps":
            return (row.steps || []).length;
          case "conversationRating":
            return row.conversationRating ?? -Infinity;
          case "customerSentimentPrimary":
            return row.customerSentimentPrimary || "";
          case "durationMinutes":
            return row.durationMinutes ?? -Infinity;
          case "processedAt":
          default:
            return row.processedAt || "";
        }
      };
      const av = get(a);
      const bv = get(b);
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv)) * dir;
    });
    return rows;
  }, [data, sort]);

  const setSortKey = (key: SortKey) => {
    setSort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: "asc" };
    });
  };

  const sortIndicator = (key: SortKey) => {
    if (sort.key !== key) return "";
    return sort.direction === "asc" ? "↑" : "↓";
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-white">{heading}</h1>
            <p className="text-sm text-slate-400">Last {windowDays} days · {data.length} tickets</p>
          </div>
          <Link
            href="/"
            className="rounded-full border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-brand-500 hover:text-brand-100"
          >
            ← Back to dashboard
          </Link>
        </header>

        {loading && <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm">Loading…</div>}
        {error && (
          <div className="rounded-xl border border-rose-700 bg-rose-900/40 p-4 text-sm text-rose-100">{error}</div>
        )}

        {!loading && !error && (
          <div className="overflow-auto rounded-3xl border border-slate-800 bg-slate-900/60">
            <table className="min-w-full divide-y divide-slate-800 text-sm">
              <thead className="bg-slate-900/80 text-slate-300">
                <tr>
                  <th className="px-4 py-3 text-left">
                    <button className="flex items-center gap-1 hover:text-white" onClick={() => setSortKey("issueKey")}>
                      Issue {sortIndicator("issueKey")}
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left">
                    <button className="flex items-center gap-1 hover:text-white" onClick={() => setSortKey("summary")}>
                      Summary {sortIndicator("summary")}
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left">
                    <button className="flex items-center gap-1 hover:text-white" onClick={() => setSortKey("problem")}>
                      Problem {sortIndicator("problem")}
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left">
                    <button className="flex items-center gap-1 hover:text-white" onClick={() => setSortKey("resolution")}>
                      Resolution {sortIndicator("resolution")}
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left">
                    <button className="flex items-center gap-1 hover:text-white" onClick={() => setSortKey("steps")}>
                      Steps {sortIndicator("steps")}
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left">
                    <button
                      className="flex items-center gap-1 hover:text-white"
                      onClick={() => setSortKey("conversationRating")}
                    >
                      Score {sortIndicator("conversationRating")}
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left">
                    <button
                      className="flex items-center gap-1 hover:text-white"
                      onClick={() => setSortKey("customerSentimentPrimary")}
                    >
                      Sentiment {sortIndicator("customerSentimentPrimary")}
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left">
                    <button
                      className="flex items-center gap-1 hover:text-white"
                      onClick={() => setSortKey("durationMinutes")}
                    >
                      Duration (min) {sortIndicator("durationMinutes")}
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left">
                    <button
                      className="flex items-center gap-1 hover:text-white"
                      onClick={() => setSortKey("processedAt")}
                    >
                      Processed {sortIndicator("processedAt")}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 bg-slate-900/60">
                {sorted.map((row, idx) => (
                  <tr key={row.issueKey || idx}>
                    <td className="px-4 py-3 text-xs font-semibold text-brand-100">
                      {row.issueKey ? (
                        <a
                          href={`https://portapp.atlassian.net/browse/${row.issueKey}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded border border-brand-500/40 bg-brand-500/15 px-2 py-1 text-brand-100 hover:bg-brand-500/30"
                        >
                          {row.issueKey}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-200">{row.summary ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-200">{row.problem ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-200">{row.resolution ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-200">
                      <div className="space-y-1">
                        {row.steps.length ? (
                          row.steps.map((step, idx) => (
                            <div key={idx} className="rounded border border-slate-800 bg-slate-900 px-2 py-1 text-[11px]">
                              {step}
                            </div>
                          ))
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-200">{row.conversationRating ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-200">{row.customerSentimentPrimary ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-200">
                      {row.durationMinutes !== null && row.durationMinutes !== undefined
                        ? row.durationMinutes.toFixed(1)
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {row.processedAt ? new Date(row.processedAt).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
                {!data.length && (
                  <tr>
                    <td className="px-4 py-4 text-center text-slate-400" colSpan={9}>
                      No tickets found for this filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
