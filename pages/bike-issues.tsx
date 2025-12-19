import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type BikeIssueRow = {
  bike: string;
  count: number;
  issues: string[];
  subs: { label: string; count: number }[];
};

type ApiResponse = {
  rows: BikeIssueRow[];
  total: number;
  windowDays: number;
};

export default function BikeIssuesPage() {
  const [data, setData] = useState<BikeIssueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(30);
  const [windowInput, setWindowInput] = useState("30");
  const [subFilter, setSubFilter] = useState<string>("All");

  const loadData = async (opts?: { window?: number }) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("window", String(opts?.window ?? 30));
      const response = await fetch(`/api/bike-issues?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Failed to load bike issues (${response.status})`);
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

  useEffect(() => {
    void loadData({ window: 30 });
  }, []);

  const totalTickets = useMemo(() => data.reduce((sum, row) => sum + row.count, 0), [data]);
  const subOptions = useMemo(() => {
    const set = new Set<string>();
    data.forEach((row) => row.subs.forEach((sub) => set.add(sub.label || "Unspecified")));
    return ["All", ...Array.from(set).sort()];
  }, [data]);
  const filteredData = useMemo(() => {
    if (subFilter === "All") return data;
    return data.filter((row) => row.subs.some((sub) => (sub.label || "Unspecified") === subFilter));
  }, [data, subFilter]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-white">Bike Issues Pivot</h1>
            <p className="text-sm text-slate-400">Top bikes by reported issues · Last {windowDays} days</p>
          </div>
          <Link
            href="/"
            className="rounded-full border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-brand-500 hover:text-brand-100"
          >
            ← Back to dashboard
          </Link>
        </header>

        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-200">
          <label className="flex items-center gap-2">
            Window (days):
            <input
              type="number"
              min={1}
              max={180}
              value={windowInput}
              onChange={(e) => setWindowInput(e.target.value)}
              className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1"
            />
          </label>
          <label className="flex items-center gap-2">
            Reported issues filter:
            <select
              value={subFilter}
              onChange={(e) => setSubFilter(e.target.value)}
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1"
            >
              {subOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() =>
              loadData({
                window: Math.max(1, Number.parseInt(windowInput || "30", 10))
              })
            }
            className="rounded-full bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-400"
          >
            Refresh
          </button>
        </div>

        {loading && <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm">Loading…</div>}
        {error && (
          <div className="rounded-xl border border-rose-700 bg-rose-900/40 p-4 text-sm text-rose-100">{error}</div>
        )}

        {!loading && !error && (
          <div className="rounded-3xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="mb-4 flex items-center justify-between text-sm text-slate-300">
              <span>{data.length} bikes · {totalTickets.toLocaleString()} tickets</span>
            </div>
        <div className="overflow-auto rounded-2xl border border-slate-800">
              <table className="min-w-full divide-y divide-slate-800 text-sm">
                <thead className="bg-slate-900/80 text-slate-300">
                  <tr>
                    <th className="px-4 py-3 text-left">Bike QR</th>
                    <th className="px-4 py-3 text-left">Issue count</th>
                    <th className="px-4 py-3 text-left">Issues (latest up to 20)</th>
                    <th className="px-4 py-3 text-left">Sub reasons</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 bg-slate-900/60">
                  {filteredData.map((row) => (
                    <tr key={row.bike}>
                      <td className="px-4 py-3 font-semibold text-white">{row.bike}</td>
                      <td className="px-4 py-3 text-slate-200">{row.count.toLocaleString()}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          {row.issues.map((issue) => (
                            <a
                              key={issue}
                              href={`https://portapp.atlassian.net/browse/${issue}`}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded border border-brand-500/40 bg-brand-500/15 px-2 py-1 text-xs text-brand-100 hover:bg-brand-500/30"
                            >
                              {issue}
                            </a>
                          ))}
                          {!row.issues.length && <span className="text-xs text-slate-400">No issue keys</span>}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="space-y-1 text-xs text-slate-200">
                          {row.subs.map((sub) => (
                            <div key={sub.label} className="flex items-center justify-between">
                              <span className="truncate pr-2">{sub.label}</span>
                              <span className="text-slate-400">{sub.count}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!filteredData.length && (
                    <tr>
                      <td className="px-4 py-4 text-center text-slate-400" colSpan={5}>
                        No data for this window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
