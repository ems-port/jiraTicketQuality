import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import clsx from "clsx";

import { DisplayName } from "@/components/DisplayName";
import { formatDateTimeLocal } from "@/lib/date";
import { resolveDisplayName } from "@/lib/displayNames";
import { ConversationRow } from "@/types";

const JIRA_BASE_URL = "https://portapp.atlassian.net/browse/";

type SortDirection = "asc" | "desc";

type SortKey =
  | "issueKey"
  | "agentLabel"
  | "customerLabel"
  | "resolved"
  | "agentScore"
  | "customerScore"
  | "startedAt"
  | "endedAt"
  | "durationMinutes"
  | "abusive"
  | "improvementTip"
  | "ticketSummary";

type DrilldownTableProps = {
  open: boolean;
  metricLabel: string;
  rows: ConversationRow[];
  onClose: () => void;
  mapping: Record<string, string>;
  deAnonymize: boolean;
};

type TableRow = {
  issueKey: string;
  agentId: string;
  agentLabel: string;
  customerId: string;
  customerLabel: string;
  resolved: boolean;
  agentScore: number | null;
  customerScore: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
  durationMinutes: number | null;
  abusive: boolean;
  abusiveReason: string | null;
  improvementTip: string;
  ticketSummary: string;
};

const HEADERS: { key: SortKey; label: string }[] = [
  { key: "issueKey", label: "Issue Key" },
  { key: "agentLabel", label: "Agent" },
  { key: "customerLabel", label: "Customer" },
  { key: "resolved", label: "Resolved" },
  { key: "agentScore", label: "Agent Score" },
  { key: "customerScore", label: "Customer Score" },
  { key: "startedAt", label: "Started" },
  { key: "endedAt", label: "Ended" },
  { key: "durationMinutes", label: "Duration (min)" },
  { key: "abusive", label: "Abusive language used" },
  { key: "improvementTip", label: "Improvement tip" },
  { key: "ticketSummary", label: "Ticket summary" }
];

export function DrilldownTable({
  open,
  metricLabel,
  rows,
  onClose,
  mapping,
  deAnonymize
}: DrilldownTableProps) {
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: SortDirection }>({
    key: "endedAt",
    direction: "desc"
  });

  const tableRows = useMemo<TableRow[]>(
    () =>
      rows.map((row) => {
        const agentDisplay = resolveDisplayName(row.agent, mapping, deAnonymize);
        const customerId = row.customerList[0] ?? "Customer";
        const customerDisplay = resolveDisplayName(customerId, mapping, deAnonymize);
        const abusiveReason = buildAbusiveReason(row);
        return {
          issueKey: row.issueKey,
          agentId: row.agent,
          agentLabel: agentDisplay.label,
          customerId,
          customerLabel: customerDisplay.label,
          resolved: row.resolved,
          agentScore: row.agentScore,
          customerScore: row.customerScore,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          durationMinutes: row.durationMinutes,
          abusive: row.customerAbuseDetected || row.agentProfanityDetected,
          abusiveReason,
          improvementTip: row.improvementTip ?? "",
          ticketSummary: row.ticketSummary ?? ""
        };
      }),
    [rows, mapping, deAnonymize]
  );

  const sortedRows = useMemo(() => {
    const sorted = [...tableRows];
    const { key, direction } = sortConfig;
    sorted.sort((a, b) => compareRows(a, b, key, direction));
    return sorted;
  }, [tableRows, sortConfig]);

  const [downloadHref, setDownloadHref] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !sortedRows.length) {
      setDownloadHref(null);
      return undefined;
    }

    const csv = Papa.unparse(
      sortedRows.map((row) => ({
        issue_key: row.issueKey,
        agent: row.agentLabel,
        resolved: row.resolved ? "Yes" : "No",
        agent_score: row.agentScore ?? "",
        customer_score: row.customerScore ?? "",
        started_at: formatDateTimeLocal(row.startedAt),
        ended_at: formatDateTimeLocal(row.endedAt),
        duration_minutes: row.durationMinutes ?? "",
        abusive_language_used: row.abusive ? "Yes" : "No",
        abusive_reason: row.abusiveReason ?? "",
        customer: row.customerLabel,
        improvement_tip: row.improvementTip ?? "",
        ticket_summary: row.ticketSummary ?? ""
      }))
    );
    const blob = new Blob([csv], { type: "text/csv" });
    const href = URL.createObjectURL(blob);
    setDownloadHref(href);

    return () => {
      URL.revokeObjectURL(href);
    };
  }, [open, sortedRows]);

  if (!open) {
    return null;
  }

  const handleSort = (column: SortKey) => {
    setSortConfig((current) => {
      if (current.key === column) {
        const nextDirection = current.direction === "asc" ? "desc" : "asc";
        return { key: column, direction: nextDirection };
      }
      return { key: column, direction: "asc" };
    });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/90 backdrop-blur">
      <div className="flex max-h-[90vh] w-[min(1100px,92vw)] flex-col overflow-hidden rounded-3xl border border-slate-800 bg-slate-950/95 shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">{metricLabel}</h2>
            <p className="text-xs text-slate-400">
              Showing {sortedRows.length.toLocaleString()} conversation
              {sortedRows.length === 1 ? "" : "s"} in the current filters.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {downloadHref && (
              <a
                href={downloadHref}
                download={`${metricLabel.replace(/\s+/g, "_").toLowerCase()}_export.csv`}
                className="rounded-full border border-brand-500/60 bg-brand-500/20 px-4 py-2 text-sm font-medium text-brand-100 transition hover:bg-brand-500/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
              >
                Export CSV
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-brand-500 hover:text-brand-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
            >
              Close
            </button>
          </div>
        </header>
        <div className="overflow-auto">
          <table className="min-w-full divide-y divide-slate-800 text-sm">
            <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                {HEADERS.map((column) => (
                  <th
                    key={column.key}
                    className="px-4 py-3 text-left font-semibold"
                    aria-sort={
                      sortConfig.key === column.key
                        ? sortConfig.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      type="button"
                      onClick={() => handleSort(column.key)}
                      className={clsx(
                        "flex items-center gap-2 rounded-md px-2 py-1 transition",
                        sortConfig.key === column.key
                          ? "bg-brand-500/20 text-white"
                          : "hover:bg-slate-800/50"
                      )}
                    >
                      <span>{column.label}</span>
                      <span className="text-[10px]">
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
            <tbody className="divide-y divide-slate-900/70">
              {sortedRows.map((row) => (
                <tr key={row.issueKey} className="hover:bg-slate-900/40">
                  <td className="px-4 py-3 text-brand-200 underline decoration-brand-600 hover:text-brand-100">
                    <a href={`${JIRA_BASE_URL}${row.issueKey}`} target="_blank" rel="noreferrer">
                      {row.issueKey}
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    <DisplayName
                      id={row.agentId}
                      mapping={mapping}
                      deAnonymize={deAnonymize}
                      titlePrefix="Agent ID"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <DisplayName
                      id={row.customerId}
                      mapping={mapping}
                      deAnonymize={deAnonymize}
                      titlePrefix="Customer ID"
                    />
                  </td>
                  <td className="px-4 py-3">
                    {row.resolved ? (
                      <span className="text-emerald-300">Yes</span>
                    ) : (
                      <span className="text-slate-300">No</span>
                    )}
                  </td>
                  <td className="px-4 py-3">{formatNumber(row.agentScore)}</td>
                  <td className="px-4 py-3">{formatNumber(row.customerScore)}</td>
                  <td className="px-4 py-3">{formatDateTimeLocal(row.startedAt)}</td>
                  <td className="px-4 py-3">{formatDateTimeLocal(row.endedAt)}</td>
                  <td className="px-4 py-3">{formatNumber(row.durationMinutes)}</td>
                  <td className="px-4 py-3" title={row.abusiveReason ?? undefined}>
                    {row.abusive ? (
                      <span className="text-red-300">Yes</span>
                    ) : (
                      <span className="text-slate-300">No</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {renderTruncatedCell(row.improvementTip)}
                  </td>
                  <td className="px-4 py-3">
                    {renderTruncatedCell(row.ticketSummary)}
                  </td>
                </tr>
              ))}
              {!sortedRows.length && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-400" colSpan={HEADERS.length}>
                    No conversations match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function formatNumber(value: number | null): string {
  if (value === null || value === undefined) {
    return "—";
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function renderTruncatedCell(value: string): JSX.Element {
  const display = value && value.trim().length ? value : "—";
  if (display === "—") {
    return <span className="text-slate-300">—</span>;
  }
  return (
    <div className="group relative max-w-[18rem]" tabIndex={0}>
      <span className="block truncate text-slate-100">{display}</span>
      <div className="pointer-events-none absolute left-1/2 top-full z-30 hidden w-64 -translate-x-1/2 translate-y-2 rounded-xl border border-slate-700 bg-slate-900/95 p-3 text-xs text-slate-100 shadow-xl group-hover:block group-focus-within:block">
        <div className="pointer-events-auto max-h-48 whitespace-pre-wrap break-words">
          {display}
        </div>
      </div>
    </div>
  );
}

function compareRows(a: TableRow, b: TableRow, key: SortKey, direction: SortDirection): number {
  const multiplier = direction === "asc" ? 1 : -1;
  switch (key) {
    case "issueKey":
    case "agentLabel":
    case "customerLabel":
    case "improvementTip":
    case "ticketSummary":
      return a[key].localeCompare(b[key]) * multiplier;
    case "resolved":
    case "abusive":
      return (numberValue(a[key]) - numberValue(b[key])) * multiplier;
    case "agentScore":
    case "customerScore":
    case "durationMinutes":
      return (numberValue(a[key]) - numberValue(b[key])) * multiplier;
    case "startedAt":
    case "endedAt":
      return (dateValue(a[key]) - dateValue(b[key])) * multiplier;
    default:
      return 0;
  }
}

function numberValue(value: number | boolean | null | undefined): number {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return -Infinity;
}

function dateValue(value: Date | null): number {
  return value ? value.getTime() : -Infinity;
}

function buildAbusiveReason(row: ConversationRow): string | null {
  const reasons: string[] = [];
  if (row.customerAbuseDetected) {
    const scorePart =
      typeof row.customerToxicityScore === "number"
        ? `score ${row.customerToxicityScore.toFixed(2)}`
        : row.customerAbuseCount
        ? `count ${row.customerAbuseCount}`
        : "heuristic trigger";
    reasons.push(`Customer abuse detected (${scorePart})`);
  }
  if (row.agentProfanityDetected) {
    const scorePart =
      typeof row.agentToxicityScore === "number"
        ? `score ${row.agentToxicityScore.toFixed(2)}`
        : row.agentProfanityCount
        ? `count ${row.agentProfanityCount}`
        : "heuristic trigger";
    reasons.push(`Agent profanity detected (${scorePart})`);
  }
  if (!reasons.length) {
    return null;
  }
  return reasons.join(" · ");
}
