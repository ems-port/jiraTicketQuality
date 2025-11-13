import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import clsx from "clsx";
import { createPortal } from "react-dom";

import { DisplayName } from "@/components/DisplayName";
import { formatDateTimeLocal } from "@/lib/date";
import { resolveDisplayName } from "@/lib/displayNames";
import { resolveAgentRole } from "@/lib/roles";
import { AgentRole, ConversationRow } from "@/types";

const JIRA_BASE_URL = "https://portapp.atlassian.net/browse/";

const SENTIMENT_COLORS: Record<string, string> = {
  Delight: "text-emerald-200 bg-emerald-500/15 border-emerald-400/40",
  Convenience: "text-sky-200 bg-sky-500/15 border-sky-400/40",
  Trust: "text-cyan-200 bg-cyan-500/15 border-cyan-400/40",
  Frustration: "text-amber-200 bg-amber-500/15 border-amber-400/40",
  Disappointment: "text-orange-200 bg-orange-500/15 border-orange-400/40",
  Concern: "text-yellow-200 bg-yellow-500/15 border-yellow-400/40",
  Hostility: "text-rose-200 bg-rose-500/15 border-rose-400/40",
  Neutral: "text-slate-200 bg-slate-600/20 border-slate-500/40"
};

type SortDirection = "asc" | "desc";

type SortKey =
  | "issueKey"
  | "agentLabel"
  | "customerLabel"
  | "ticketSummary"
  | "resolved"
  | "contactReasonOriginal"
  | "contactReason"
  | "reasonOverride"
  | "agentScore"
  | "customerScore"
  | "sentiment"
  | "resolutionWhy"
  | "improvementTip";

type DrilldownTableProps = {
  open: boolean;
  metricLabel: string;
  rows: ConversationRow[];
  onClose: () => void;
  mapping: Record<string, string>;
  agentMapping: Record<string, string>;
  deAnonymize: boolean;
  roleMapping: Record<string, AgentRole>;
};

type TableRow = {
  issueKey: string;
  agentId: string;
  agentLabel: string;
  agentRole: AgentRole;
  customerId: string;
  customerLabel: string;
  resolved: boolean;
  ticketSummary: string;
  contactReasonOriginal: string;
  contactReason: string;
  reasonOverride: string;
  agentScore: number | null;
  customerScore: number | null;
  sentiment: string;
  improvementTip: string;
  resolutionWhy: string;
};

const HEADERS: { key: SortKey; label: string }[] = [
  { key: "issueKey", label: "Issue Key" },
  { key: "agentLabel", label: "Agent" },
  { key: "customerLabel", label: "Customer" },
  { key: "ticketSummary", label: "Ticket summary" },
  { key: "resolved", label: "Resolved" },
  { key: "contactReasonOriginal", label: "Original contact reason" },
  { key: "contactReason", label: "Corrected contact reason" },
  { key: "reasonOverride", label: "Reason to change" },
  { key: "agentScore", label: "Agent Score" },
  { key: "customerScore", label: "Customer Score" },
  { key: "sentiment", label: "Customer sentiment" },
  { key: "resolutionWhy", label: "Resolution summary" },
  { key: "improvementTip", label: "Improvement tip" }
];

export function DrilldownTable({
  open,
  metricLabel,
  rows,
  onClose,
  mapping,
  agentMapping,
  deAnonymize,
  roleMapping
}: DrilldownTableProps) {
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: SortDirection }>({
    key: "issueKey",
    direction: "desc"
  });

  const tableRows = useMemo<TableRow[]>(
    () =>
      rows.map((row) => {
        const agentDisplay = resolveDisplayName(row.agent, mapping, deAnonymize, agentMapping);
        const customerId = row.customerList[0] ?? "Customer";
        const customerDisplay = resolveDisplayName(customerId, mapping, deAnonymize);
        const agentRole = resolveAgentRole(row.agent, roleMapping);
        return {
          issueKey: row.issueKey,
          agentId: row.agent,
          agentLabel: agentDisplay.label,
          agentRole,
          customerId,
          customerLabel: customerDisplay.label,
          resolved: row.resolved,
          ticketSummary: row.ticketSummary ?? "",
          contactReasonOriginal: row.contactReasonOriginal ?? "Unspecified",
          contactReason: row.contactReason ?? "Unspecified",
          reasonOverride: row.reasonOverrideWhy ?? "",
          agentScore: row.agentScore,
          customerScore: row.customerScore,
          sentiment: row.customerSentimentPrimary ?? "Neutral",
          improvementTip: row.improvementTip ?? "",
          resolutionWhy: row.resolutionWhy ?? ""
        };
      }),
    [rows, mapping, deAnonymize, roleMapping]
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
        agent_id: row.agentId,
        agent: row.agentLabel,
        agent_role: row.agentRole,
        customer_id: row.customerId,
        customer: row.customerLabel,
        ticket_summary: row.ticketSummary ?? "",
        resolved: row.resolved ? "Yes" : "No",
        contact_reason_original: row.contactReasonOriginal,
        contact_reason_corrected: row.contactReason,
        reason_to_change: row.reasonOverride,
        agent_score: row.agentScore ?? "",
        customer_score: row.customerScore ?? "",
        customer_sentiment: row.sentiment,
        resolution_summary: row.resolutionWhy ?? "",
        improvement_tip: row.improvementTip ?? ""
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
      <div className="flex max-h-[90vh] min-h-[60vh] w-[min(1200px,96vw)] flex-col overflow-visible rounded-3xl border border-slate-800 bg-slate-950/95 shadow-2xl">
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
                      agentMapping={agentMapping}
                      deAnonymize={deAnonymize}
                      titlePrefix="Agent ID"
                      showRole={true}
                      role={row.agentRole}
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
                    <TruncatedText value={row.ticketSummary} />
                  </td>
                  <td className="px-4 py-3">
                    {row.resolved ? (
                      <span className="text-emerald-300">Yes</span>
                    ) : (
                      <span
                        className="text-amber-300"
                        title={row.resolutionWhy ? `Resolution summary: ${row.resolutionWhy}` : undefined}
                      >
                        No
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-100">
                      <span className="h-2 w-2 rounded-full bg-amber-300" />
                      <TruncatedText value={row.contactReasonOriginal} />
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-100">
                      <span className="h-2 w-2 rounded-full bg-emerald-300" />
                      <TruncatedText value={row.contactReason} />
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <TruncatedText value={row.reasonOverride || "—"} />
                  </td>
                  <td className="px-4 py-3">{formatNumber(row.agentScore)}</td>
                  <td className="px-4 py-3">{formatNumber(row.customerScore)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold ${sentimentBadgeClass(row.sentiment)}`}
                    >
                      <span className="h-2 w-2 rounded-full bg-current opacity-80" />
                      {row.sentiment}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <TruncatedText value={row.resolutionWhy} />
                  </td>
                  <td className="px-4 py-3">
                    <TruncatedText value={row.improvementTip} />
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

function TruncatedText({ value }: { value: string }) {
  const display = value && value.trim().length ? value : "—";
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<{ top: number; left: number; width: number; content: string } | null>(null);

  const showTooltip = () => {
    if (!wrapperRef.current || typeof window === "undefined" || display === "—") {
      return;
    }
    const rect = wrapperRef.current.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 40);
    const rawLeft = rect.left + rect.width / 2 - width / 2;
    const left = Math.min(window.innerWidth - 20 - width, Math.max(20, rawLeft));
    const top = Math.min(window.innerHeight - 20, rect.bottom + 12);
    setTooltip({ top, left, width, content: display });
  };

  const hideTooltip = () => {
    setTooltip(null);
  };

  if (display === "—") {
    return <span className="text-slate-300">—</span>;
  }

  return (
    <>
      <div
        ref={wrapperRef}
        className="max-w-[18rem] cursor-help"
        tabIndex={0}
        onMouseEnter={showTooltip}
        onFocus={showTooltip}
        onMouseLeave={hideTooltip}
        onBlur={hideTooltip}
      >
        <span className="block truncate text-slate-100">{display}</span>
      </div>
      {tooltip &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[2000] max-h-48 overflow-auto rounded-xl border border-slate-700 bg-slate-900/95 p-3 text-xs text-slate-100 shadow-2xl"
            style={{ top: tooltip.top, left: tooltip.left, width: tooltip.width }}
          >
            {tooltip.content}
          </div>,
          document.body
        )}
    </>
  );
}

function sentimentBadgeClass(label: string): string {
  return SENTIMENT_COLORS[label] ?? "text-slate-200 bg-slate-600/20 border-slate-500/40";
}

function compareRows(a: TableRow, b: TableRow, key: SortKey, direction: SortDirection): number {
  const multiplier = direction === "asc" ? 1 : -1;
  switch (key) {
    case "issueKey":
    case "agentLabel":
    case "customerLabel":
    case "ticketSummary":
    case "resolutionWhy":
    case "contactReasonOriginal":
    case "contactReason":
    case "reasonOverride":
    case "improvementTip":
    case "sentiment":
      return a[key].localeCompare(b[key]) * multiplier;
    case "resolved":
      return (numberValue(a[key]) - numberValue(b[key])) * multiplier;
    case "agentScore":
    case "customerScore":
      return (numberValue(a[key]) - numberValue(b[key])) * multiplier;
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
