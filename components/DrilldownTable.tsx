import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import clsx from "clsx";
import { createPortal } from "react-dom";

import { DisplayName } from "@/components/DisplayName";
import { formatDateTimeLocal } from "@/lib/date";
import { resolveDisplayName } from "@/lib/displayNames";
import { resolveAgentRole } from "@/lib/roles";
import { ensureReviewIdentity, persistReviewDisplayName } from "@/lib/reviewIdentity";
import type { ReviewIdentity } from "@/lib/reviewIdentity";
import {
  AgentRole,
  ConversationRow,
  MisclassificationVerdict,
  MisclassificationReviewSummary
} from "@/types";

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
  reviewEnabled?: boolean;
  initialAgentFilter?: string | null;
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

type ReviewDialogState = {
  issueKey: string;
  verdict: MisclassificationVerdict;
};

const REVIEW_NOTES_LIMIT = 1000;

type ColumnDescriptor = {
  key: SortKey | "review";
  label: string;
  sortable?: boolean;
  sticky?: "left" | "right";
  render: (row: TableRow) => React.ReactNode;
  headerAlign?: "left" | "right" | "center";
  cellClassName?: (row: TableRow) => string;
};

export function DrilldownTable({
  open,
  metricLabel,
  rows,
  onClose,
  mapping,
  agentMapping,
  deAnonymize,
  roleMapping,
  reviewEnabled = false,
  initialAgentFilter = null
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

  const [agentFilter, setAgentFilter] = useState<string>(initialAgentFilter ?? "all");
  const [agentFilterManuallySet, setAgentFilterManuallySet] = useState(false);
  const [compactReviewView, setCompactReviewView] = useState(true);

  const agentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    tableRows.forEach((row) => {
      counts.set(row.agentId, (counts.get(row.agentId) ?? 0) + 1);
    });
    return counts;
  }, [tableRows]);

  const agentOptions = useMemo(() => {
    const ids = new Set<string>();
    Object.keys(agentMapping || {}).forEach((id) => {
      if (id) {
        ids.add(id);
      }
    });
    tableRows.forEach((row) => ids.add(row.agentId));
    return Array.from(ids)
      .map((id) => {
        const display = resolveDisplayName(id, mapping, deAnonymize, agentMapping);
        const count = agentCounts.get(id) ?? 0;
        const label = display.label || id;
        return { value: id, label: `${label} (${count})`, rawLabel: label, count };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [agentMapping, tableRows, mapping, deAnonymize, agentCounts]);

  const agentsInRows = useMemo(() => {
    const ids = new Set<string>();
    tableRows.forEach((row) => ids.add(row.agentId));
    return Array.from(ids);
  }, [tableRows]);

  useEffect(() => {
    if (!reviewEnabled) {
      if (agentFilter !== "all") {
        setAgentFilter("all");
        setAgentFilterManuallySet(false);
      }
      if (compactReviewView) {
        setCompactReviewView(false);
      }
      return;
    }

    if (!agentOptions.length) {
      if (agentFilter !== "all") {
        setAgentFilter("all");
        setAgentFilterManuallySet(false);
      }
      return;
    }

    if (agentFilter !== "all" && !agentOptions.some((option) => option.value === agentFilter)) {
      setAgentFilter("all");
      setAgentFilterManuallySet(false);
      return;
    }

    if (!agentFilterManuallySet && agentFilter === "all") {
      if (initialAgentFilter && agentOptions.some((option) => option.value === initialAgentFilter)) {
        setAgentFilter(initialAgentFilter);
        return;
      }
      if (agentsInRows.length === 1) {
        setAgentFilter(agentsInRows[0]);
      }
    }
  }, [
    reviewEnabled,
    agentOptions,
    agentFilter,
    compactReviewView,
    agentsInRows,
    initialAgentFilter,
    agentFilterManuallySet
  ]);

  const filteredRows = useMemo(() => {
    if (reviewEnabled && agentFilter !== "all") {
      return tableRows.filter((row) => row.agentId === agentFilter);
    }
    return tableRows;
  }, [tableRows, reviewEnabled, agentFilter]);

  const sortedRows = useMemo(() => {
    const sorted = [...filteredRows];
    const { key, direction } = sortConfig;
    sorted.sort((a, b) => compareRows(a, b, key, direction));
    return sorted;
  }, [filteredRows, sortConfig]);

  const [downloadHref, setDownloadHref] = useState<string | null>(null);
  const [reviewIdentity, setReviewIdentity] = useState<ReviewIdentity | null>(null);
  const [reviewSummaries, setReviewSummaries] = useState<
    Record<string, MisclassificationReviewSummary>
  >({});
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewDialog, setReviewDialog] = useState<ReviewDialogState | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [reviewDisplayName, setReviewDisplayName] = useState("");
  const [reviewSubmitError, setReviewSubmitError] = useState<string | null>(null);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const previousReviewEnabled = useRef(reviewEnabled);

  useEffect(() => {
    if (!previousReviewEnabled.current && reviewEnabled) {
      setCompactReviewView(true);
    }
    previousReviewEnabled.current = reviewEnabled;
  }, [reviewEnabled]);

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

  useEffect(() => {
    if (!open || !reviewEnabled) {
      setReviewSummaries({});
      setReviewError(null);
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    const identity = ensureReviewIdentity();
    setReviewIdentity(identity);

    const issueKeys = Array.from(new Set(tableRows.map((row) => row.issueKey)));
    if (!issueKeys.length) {
      setReviewSummaries({});
      setReviewError(null);
      return;
    }

    let cancelled = false;
    setReviewLoading(true);
    setReviewError(null);

    const load = async () => {
      try {
        const summaries = await requestReviewSummaries(issueKeys, identity?.id);
        if (!cancelled) {
          setReviewSummaries(summaries);
        }
      } catch (error) {
        if (!cancelled) {
          setReviewError((error as Error).message ?? "Unable to load reviews.");
        }
      } finally {
        if (!cancelled) {
          setReviewLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [open, reviewEnabled, tableRows]);

  const handleSort = (column: SortKey) => {
    setSortConfig((current) => {
      if (current.key === column) {
        const nextDirection = current.direction === "asc" ? "desc" : "asc";
        return { key: column, direction: nextDirection };
      }
      return { key: column, direction: "asc" };
    });
  };

  const handleAgentFilterChange = (value: string) => {
    setAgentFilter(value);
    setAgentFilterManuallySet(true);
  };

  const handleReviewClick = (issueKey: string, verdict: MisclassificationVerdict) => {
    if (!reviewEnabled) {
      return;
    }
    const identity = reviewIdentity ?? ensureReviewIdentity();
    if (!identity) {
      return;
    }
    if (!reviewIdentity) {
      setReviewIdentity(identity);
    }
    const summary = reviewSummaries[issueKey];
    const existingNotes = summary?.userNotes ?? "";
    setReviewNotes(existingNotes.slice(0, REVIEW_NOTES_LIMIT));
    const fallbackName = summary?.userDisplayName ?? identity.displayName ?? "";
    setReviewDisplayName(fallbackName.slice(0, 120));
    setReviewSubmitError(null);
    setReviewDialog({ issueKey, verdict });
  };

  const handleReviewClose = () => {
    setReviewDialog(null);
    setReviewSubmitError(null);
    setReviewNotes("");
  };

  const handleReviewSubmit = async () => {
    if (!reviewDialog) {
      return;
    }
    const identity = reviewIdentity ?? ensureReviewIdentity();
    if (!identity) {
      setReviewSubmitError("Unable to resolve your browser identity.");
      return;
    }
    if (!reviewIdentity) {
      setReviewIdentity(identity);
    }

    const trimmedNotes = reviewNotes.trim().slice(0, REVIEW_NOTES_LIMIT);
    const safeNotes = trimmedNotes.length ? trimmedNotes : "";
    const trimmedName = reviewDisplayName.trim().slice(0, 120);
    const fingerprint = getBrowserFingerprint() ?? identity.id;

    setReviewSubmitting(true);
    setReviewSubmitError(null);
    try {
      const response = await fetch("/api/misclassification-reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueKey: reviewDialog.issueKey,
          verdict: reviewDialog.verdict,
          notes: safeNotes,
          userId: identity.id,
          userDisplay: trimmedName,
          userFingerprint: fingerprint
        })
      });

      let payload: ReviewSummariesResponse | { error?: string } | null = null;
      try {
        payload = (await response.json()) as ReviewSummariesResponse | { error?: string } | null;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const message =
          (payload && "error" in (payload as Record<string, unknown>)
            ? ((payload as { error?: string }).error ?? null)
            : null) ?? `Unable to save review (${response.status}).`;
        throw new Error(message);
      }

      const summaries = (payload as ReviewSummariesResponse | null)?.summaries ?? {};
      setReviewSummaries((prev) => ({ ...prev, ...summaries }));
      const updatedIdentity = persistReviewDisplayName(trimmedName);
      if (updatedIdentity) {
        setReviewIdentity(updatedIdentity);
        setReviewDisplayName(updatedIdentity.displayName ?? "");
      }
      setReviewDialog(null);
      setReviewNotes("");
    } catch (error) {
      setReviewSubmitError((error as Error).message ?? "Unable to save review.");
    } finally {
      setReviewSubmitting(false);
    }
  };

  const columns = useMemo<ColumnDescriptor[]>(() => {
    const defaultColumns: ColumnDescriptor[] = [
      {
        key: "issueKey",
        label: "Issue Key",
        sortable: true,
        sticky: "left",
        cellClassName: () => "min-w-[9rem]",
        render: (row) => (
          <a
            href={`${JIRA_BASE_URL}${row.issueKey}`}
            target="_blank"
            rel="noreferrer"
            className="text-brand-200 underline decoration-brand-600 hover:text-brand-100"
          >
            {row.issueKey}
          </a>
        )
      },
      {
        key: "agentLabel",
        label: "Agent",
        sortable: true,
        render: (row) => (
          <DisplayName
            id={row.agentId}
            mapping={mapping}
            agentMapping={agentMapping}
            deAnonymize={deAnonymize}
            titlePrefix="Agent ID"
            showRole={true}
            role={row.agentRole}
          />
        )
      },
      {
        key: "customerLabel",
        label: "Customer",
        sortable: true,
        render: (row) => (
          <DisplayName
            id={row.customerId}
            mapping={mapping}
            deAnonymize={deAnonymize}
            titlePrefix="Customer ID"
          />
        )
      },
      {
        key: "ticketSummary",
        label: "Ticket summary",
        sortable: true,
        cellClassName: () => "min-w-[22rem] max-w-[28rem]",
        render: (row) => <TruncatedText value={row.ticketSummary} />
      },
      {
        key: "resolved",
        label: "Resolved",
        sortable: true,
        render: (row) =>
          row.resolved ? (
            <span className="text-emerald-300">Yes</span>
          ) : (
            <span
              className="text-amber-300"
              title={row.resolutionWhy ? `Resolution summary: ${row.resolutionWhy}` : undefined}
            >
              No
            </span>
          )
      },
      {
        key: "contactReasonOriginal",
        label: "Original contact reason",
        sortable: true,
        render: (row) => (
          <span className="inline-flex max-w-[8rem] items-center gap-2 rounded-full border border-amber-400/40 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-100">
            <span className="h-2 w-2 rounded-full bg-amber-300" />
            <span className="min-w-0 flex-1">
              <TruncatedText value={row.contactReasonOriginal} truncate />
            </span>
          </span>
        )
      },
      {
        key: "contactReason",
        label: "Corrected contact reason",
        sortable: true,
        render: (row) => (
          <span className="inline-flex max-w-[8rem] items-center gap-2 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-100">
            <span className="h-2 w-2 rounded-full bg-emerald-300" />
            <span className="min-w-0 flex-1">
              <TruncatedText value={row.contactReason} truncate />
            </span>
          </span>
        )
      },
      {
        key: "reasonOverride",
        label: "Reason to change",
        sortable: true,
        cellClassName: () => "min-w-[18rem] max-w-[26rem]",
        render: (row) => <TruncatedText value={row.reasonOverride || "—"} />
      },
      {
        key: "agentScore",
        label: "Agent Score",
        sortable: true,
        render: (row) => formatNumber(row.agentScore)
      },
      {
        key: "customerScore",
        label: "Customer Score",
        sortable: true,
        render: (row) => formatNumber(row.customerScore)
      },
      {
        key: "sentiment",
        label: "Customer sentiment",
        sortable: true,
        render: (row) => (
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold ${sentimentBadgeClass(row.sentiment)}`}
          >
            <span className="h-2 w-2 rounded-full bg-current opacity-80" />
            {row.sentiment}
          </span>
        )
      },
      {
        key: "resolutionWhy",
        label: "Resolution summary",
        sortable: true,
        cellClassName: () => "min-w-[18rem] max-w-[26rem]",
        render: (row) => <TruncatedText value={row.resolutionWhy} />
      },
      {
        key: "improvementTip",
        label: "Improvement tip",
        sortable: true,
        render: (row) => <TruncatedText value={row.improvementTip} />
      }
    ];

    const compactOrder: SortKey[] = [
      "issueKey",
      "ticketSummary",
      "contactReasonOriginal",
      "contactReason",
      "reasonOverride",
      "resolutionWhy"
    ];

    const compactColumns = compactOrder
      .map((key) => defaultColumns.find((column) => column.key === key))
      .filter((column): column is ColumnDescriptor => Boolean(column));

    const selectedColumns = compactReviewView ? compactColumns : defaultColumns;

    if (!reviewEnabled) {
      return selectedColumns;
    }

    const reviewColumn: ColumnDescriptor = {
      key: "review",
      label: "Review",
      sortable: false,
      sticky: "right",
      render: (row) => {
        const summary = reviewSummaries[row.issueKey];
        return (
          <div className="flex items-center gap-3">
            <ReviewButton
              verdict="up"
              summary={summary}
              disabled={reviewLoading}
              onClick={() => handleReviewClick(row.issueKey, "up")}
            />
            <ReviewButton
              verdict="down"
              summary={summary}
              disabled={reviewLoading}
              onClick={() => handleReviewClick(row.issueKey, "down")}
            />
          </div>
        );
      }
    };

    return [...selectedColumns, reviewColumn];
  }, [
    agentMapping,
    compactReviewView,
    deAnonymize,
    handleReviewClick,
    mapping,
    reviewEnabled,
    reviewLoading,
    reviewSummaries
  ]);

  const columnCount = columns.length;
  const activeReviewSummary = reviewDialog ? reviewSummaries[reviewDialog.issueKey] : undefined;
  const selectedAgentOption =
    reviewEnabled && agentFilter !== "all"
      ? agentOptions.find((option) => option.value === agentFilter)
      : null;
  const headerLabel =
    reviewEnabled && selectedAgentOption
      ? `${metricLabel.split(":")[0].trim() || metricLabel}: ${selectedAgentOption.rawLabel}`
      : metricLabel;

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/90 backdrop-blur">
      <div className="flex max-h-[90vh] min-h-[60vh] w-[min(1200px,96vw)] flex-col overflow-visible rounded-3xl border border-slate-800 bg-slate-950/95 shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">{headerLabel}</h2>
            <p className="text-xs text-slate-400">
              Showing {sortedRows.length.toLocaleString()} conversation
              {sortedRows.length === 1 ? "" : "s"} in the current filters.
            </p>
            {reviewEnabled && agentOptions.length > 0 && (
              <label className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-300">
                Agent filter
                <select
                  value={agentFilter}
                  onChange={(event) => handleAgentFilterChange(event.target.value)}
                  className="rounded-lg border border-slate-700 bg-slate-900/60 px-2 py-1 text-sm text-white focus:border-brand-500 focus:outline-none"
                >
                  <option value="all">All agents</option>
                  {agentOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="flex items-center gap-3">
            {reviewEnabled && (
              <label className="flex items-center gap-3 text-sm text-slate-300">
                <span>Review metric view</span>
                <button
                  type="button"
                  onClick={() => setCompactReviewView((previous) => !previous)}
                  className={clsx(
                    "relative inline-flex h-7 w-12 items-center rounded-full transition",
                    compactReviewView ? "bg-brand-500/70" : "bg-slate-700"
                  )}
                  role="switch"
                  aria-checked={compactReviewView}
                >
                  <span
                    className={clsx(
                      "h-5 w-5 rounded-full bg-white shadow transition-transform",
                      compactReviewView ? "translate-x-5" : "translate-x-1"
                    )}
                  />
                </button>
              </label>
            )}
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
                {columns.map((column) => {
                  const sortable = column.key !== "review" && column.sortable !== false;
                  const isActiveSort = sortable && sortConfig.key === column.key;
                  return (
                    <th
                      key={column.key}
                      className={clsx(
                        "px-4 py-3 text-left font-semibold",
                        column.sticky === "left" && "sticky left-0 z-20 bg-slate-900/95 backdrop-blur",
                        column.sticky === "right" && "sticky right-0 z-20 bg-slate-900/95 backdrop-blur"
                      )}
                      aria-sort={
                        sortable
                          ? isActiveSort
                            ? sortConfig.direction === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                          : undefined
                      }
                    >
                      {sortable ? (
                        <button
                          type="button"
                          onClick={() => handleSort(column.key as SortKey)}
                          className={clsx(
                            "flex items-center gap-2 rounded-md px-2 py-1 transition",
                            isActiveSort ? "bg-brand-500/20 text-white" : "hover:bg-slate-800/50"
                          )}
                        >
                          <span>{column.label}</span>
                          <span className="text-[10px]">
                            {isActiveSort ? (sortConfig.direction === "asc" ? "▲" : "▼") : "↕"}
                          </span>
                        </button>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span>{column.label}</span>
                          {column.key === "review" && reviewLoading && (
                            <span className="h-2 w-2 animate-pulse rounded-full bg-brand-400" aria-hidden="true" />
                          )}
                        </div>
                      )}
                      {column.key === "review" && reviewError && (
                        <p className="mt-1 text-[11px] text-rose-300">{reviewError}</p>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-900/70">
              {sortedRows.map((row) => (
                <tr key={row.issueKey} className="hover:bg-slate-900/40">
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={clsx(
                        "px-4 py-3 align-top text-slate-100",
                        column.sticky === "left" && "sticky left-0 z-10 bg-slate-950",
                        column.sticky === "right" && "sticky right-0 z-10 bg-slate-950",
                        column.cellClassName?.(row)
                      )}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
              {!sortedRows.length && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-400" colSpan={columnCount}>
                    No conversations match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {reviewEnabled && (
        <ReviewModal
          open={Boolean(reviewDialog)}
          issueKey={reviewDialog?.issueKey ?? ""}
          verdict={reviewDialog?.verdict ?? "up"}
          notes={reviewNotes}
          notesLimit={REVIEW_NOTES_LIMIT}
          onNotesChange={setReviewNotes}
          displayName={reviewDisplayName}
          onDisplayNameChange={setReviewDisplayName}
          submitting={reviewSubmitting}
          error={reviewSubmitError}
          onClose={handleReviewClose}
          onSubmit={handleReviewSubmit}
          summary={activeReviewSummary}
        />
      )}
    </div>
  );
}

function formatNumber(value: number | null): string {
  if (value === null || value === undefined) {
    return "—";
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function TruncatedText({ value, truncate = false }: { value: string; truncate?: boolean }) {
  const display = value && value.trim().length ? value : "—";
  if (display === "—") {
    return <span className="text-slate-300">—</span>;
  }
  if (!truncate) {
    return <div className="whitespace-pre-wrap break-words text-slate-100">{display}</div>;
  }

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<{
    top: number;
    left: number;
    width: number;
    content: string;
  } | null>(null);

  const showTooltip = () => {
    if (!wrapperRef.current || typeof window === "undefined") {
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

  return (
    <>
      <div
        ref={wrapperRef}
        className="max-w-[16rem] cursor-help"
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

type ReviewSummariesResponse = {
  summaries: Record<string, MisclassificationReviewSummary>;
  warning?: string;
};

async function requestReviewSummaries(issueKeys: string[], userId?: string | null) {
  const uniqueKeys = Array.from(new Set(issueKeys));
  const params = new URLSearchParams();
  uniqueKeys.forEach((key) => params.append("issueKey", key));
  if (userId) {
    params.set("userId", userId);
  }
  const response = await fetch(`/api/misclassification-reviews?${params.toString()}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Unable to load reviews (${response.status}).`);
  }
  const payload = (await response.json()) as ReviewSummariesResponse;
  return payload.summaries ?? {};
}

function getBrowserFingerprint(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const userAgent = window.navigator?.userAgent ?? "";
  const language = window.navigator?.language ?? "";
  let timeZone = "";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    timeZone = "";
  }
  const screenInfo =
    typeof window.screen !== "undefined"
      ? `${window.screen.width}x${window.screen.height}@${window.devicePixelRatio ?? 1}`
      : "";
  const raw = [userAgent, language, timeZone, screenInfo].filter(Boolean).join("|");
  return raw ? raw.slice(0, 160) : null;
}

type ReviewModalProps = {
  open: boolean;
  issueKey: string;
  verdict: MisclassificationVerdict;
  notes: string;
  notesLimit: number;
  onNotesChange: (value: string) => void;
  displayName: string;
  onDisplayNameChange: (value: string) => void;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: () => void;
  summary?: MisclassificationReviewSummary;
};

function ReviewModal({
  open,
  issueKey,
  verdict,
  notes,
  notesLimit,
  onNotesChange,
  displayName,
  onDisplayNameChange,
  submitting,
  error,
  onClose,
  onSubmit,
  summary
}: ReviewModalProps) {
  if (!open || typeof document === "undefined") {
    return null;
  }
  const verdictLabel = verdict === "up" ? "Thumbs up" : "Thumbs down";
  const verdictDescription =
    verdict === "up"
      ? "Confirm this ticket really was misclassified."
      : "Flag that the misclassification analysis needs correction.";
  const confirmLabel = verdict === "up" ? "Save thumbs up" : "Save thumbs down";
  const upCount = summary?.upCount ?? 0;
  const downCount = summary?.downCount ?? 0;
  const lastUpdatedDate =
    summary?.lastUpdatedAt && summary.lastUpdatedAt.length ? new Date(summary.lastUpdatedAt) : null;
  const lastUpdatedLabel =
    lastUpdatedDate && !Number.isNaN(lastUpdatedDate.valueOf())
      ? formatDateTimeLocal(lastUpdatedDate)
      : null;
  const ariaLabel = issueKey ? `${verdictLabel} review for ${issueKey}` : "Misclassification review";

  const handleNotesChange = (value: string) => {
    onNotesChange(value.slice(0, notesLimit));
  };
  const handleNameChange = (value: string) => {
    onDisplayNameChange(value.slice(0, 120));
  };

  const body = (
    <div
      className="fixed inset-0 z-[4000] flex items-center justify-center bg-slate-950/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-2xl">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
              <span>{issueKey}</span>
              <span className="text-slate-600">•</span>
              <span>{verdictLabel}</span>
            </div>
            <div className="flex items-center gap-3">
              <div
                className={clsx(
                  "inline-flex items-center justify-center rounded-full border p-2",
                  verdict === "up"
                    ? "border-emerald-400/60 bg-emerald-500/10 text-emerald-200"
                    : "border-rose-400/60 bg-rose-500/10 text-rose-200"
                )}
              >
                <ThumbIcon direction={verdict} />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">{verdictLabel}</h3>
                <p className="text-sm text-slate-400">{verdictDescription}</p>
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300">
            <p className="font-semibold text-slate-200">
              Votes so far:{" "}
              <span className="text-emerald-300">{upCount} up</span>
              <span className="px-2 text-slate-500">·</span>
              <span className="text-rose-300">{downCount} down</span>
            </p>
            {lastUpdatedLabel && (
              <p className="mt-1 text-xs text-slate-500">
                Latest update by {summary?.lastUpdatedBy ?? "someone"} on {lastUpdatedLabel}
              </p>
            )}
          </div>
          <label className="block text-sm text-slate-300">
            Notes (optional)
            <textarea
              rows={4}
              value={notes}
              onChange={(event) => handleNotesChange(event.target.value)}
              placeholder="Add any clarification for this ticket."
              className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-sm text-white focus:border-brand-500 focus:outline-none"
            />
            <div className="mt-1 flex justify-between text-xs text-slate-500">
              <span>Help us understand what went well or wrong.</span>
              <span>
                {notes.length}/{notesLimit}
              </span>
            </div>
          </label>
          <label className="block text-sm text-slate-300">
            Display name (optional)
            <input
              type="text"
              value={displayName}
              onChange={(event) => handleNameChange(event.target.value)}
              placeholder="Add your initials so we can follow up if needed."
              className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-sm text-white focus:border-brand-500 focus:outline-none"
            />
          </label>
          {error && <p className="text-sm text-rose-300">{error}</p>}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-slate-500"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className={clsx(
                "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition",
                verdict === "up"
                  ? "border border-emerald-400 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20"
                  : "border border-rose-400 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20",
                submitting && "cursor-not-allowed opacity-70"
              )}
            >
              {submitting && (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              )}
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}

type ReviewButtonProps = {
  verdict: MisclassificationVerdict;
  summary?: MisclassificationReviewSummary;
  disabled?: boolean;
  onClick: () => void;
};

function ReviewButton({ verdict, summary, disabled, onClick }: ReviewButtonProps) {
  const count = verdict === "up" ? summary?.upCount ?? 0 : summary?.downCount ?? 0;
  const isMine = summary?.userVerdict === verdict;
  const hasVotes = count > 0;
  const baseClasses =
    "flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
  const verdictClasses =
    verdict === "up"
      ? isMine
        ? "border-emerald-400 bg-emerald-500/20 text-emerald-100 focus-visible:outline-emerald-400"
        : hasVotes
        ? "border-emerald-400/60 bg-emerald-500/10 text-emerald-100 focus-visible:outline-emerald-400"
        : "border-slate-700 text-slate-300 hover:border-emerald-400/60 hover:text-emerald-100 focus-visible:outline-emerald-400"
      : isMine
      ? "border-rose-400 bg-rose-500/20 text-rose-100 focus-visible:outline-rose-400"
      : hasVotes
      ? "border-rose-400/60 bg-rose-500/10 text-rose-100 focus-visible:outline-rose-400"
      : "border-slate-700 text-slate-300 hover:border-rose-400/60 hover:text-rose-100 focus-visible:outline-rose-400";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(baseClasses, verdictClasses, disabled && "cursor-not-allowed opacity-60")}
      aria-label={`Leave ${verdict === "up" ? "thumbs up" : "thumbs down"} review`}
      aria-pressed={isMine}
    >
      <ThumbIcon direction={verdict} />
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

function ThumbIcon({ direction }: { direction: MisclassificationVerdict }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={clsx("h-4 w-4", direction === "down" && "rotate-180")}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 11v8a2 2 0 0 0 2 2h5.6a2 2 0 0 0 1.97-1.67l1.05-6.03a2 2 0 0 0-1.97-2.33H13V8.5a3 3 0 0 0-.82-2.05L9 3v8H7z" />
      <path d="M4 11h3v10H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z" />
    </svg>
  );
}
