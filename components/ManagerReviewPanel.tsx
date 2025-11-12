import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";

import { formatDateTimeLocal } from "@/lib/date";
import { resolveDisplayName } from "@/lib/displayNames";
import type { ConversationRow, SentimentLabel } from "@/types";

type ManagerReviewPanelProps = {
  rows: ConversationRow[];
  mapping: Record<string, string>;
  deAnonymize: boolean;
};

const MAX_REVIEW_ROWS = 200;
const SENTIMENT_BADGES: Record<SentimentLabel, string> = {
  Delight: "bg-emerald-500/20 text-emerald-100 border-emerald-500/40",
  Convenience: "bg-sky-500/20 text-sky-100 border-sky-500/40",
  Trust: "bg-cyan-500/20 text-cyan-100 border-cyan-500/40",
  Frustration: "bg-amber-500/20 text-amber-100 border-amber-500/40",
  Disappointment: "bg-orange-500/20 text-orange-100 border-orange-500/40",
  Concern: "bg-yellow-500/20 text-yellow-100 border-yellow-500/40",
  Hostility: "bg-rose-500/20 text-rose-100 border-rose-500/40",
  Neutral: "bg-slate-600/30 text-slate-100 border-slate-500/40"
};
const SENTIMENT_ORDER: SentimentLabel[] = [
  "Delight",
  "Convenience",
  "Trust",
  "Frustration",
  "Disappointment",
  "Concern",
  "Hostility",
  "Neutral"
];

export function ManagerReviewPanel({ rows, mapping, deAnonymize }: ManagerReviewPanelProps) {
  const reviewableRows = useMemo(() => rows.slice(0, MAX_REVIEW_ROWS), [rows]);
  const [selectedIssueKey, setSelectedIssueKey] = useState(reviewableRows[0]?.issueKey ?? "");

  useEffect(() => {
    if (!reviewableRows.length) {
      setSelectedIssueKey("");
      return;
    }
    if (!selectedIssueKey || !reviewableRows.some((row) => row.issueKey === selectedIssueKey)) {
      setSelectedIssueKey(reviewableRows[0].issueKey);
    }
  }, [reviewableRows, selectedIssueKey]);

  if (!reviewableRows.length) {
    return (
      <section className="rounded-3xl border border-slate-800 bg-slate-950/60 p-6">
        <h2 className="text-xl font-semibold text-white">Manager Review Panel</h2>
        <p className="mt-2 text-sm text-slate-400">
          Load a conversation dataset to see model explanations, reasoning, and sentiment diagnostics.
        </p>
      </section>
    );
  }

  const selected =
    reviewableRows.find((row) => row.issueKey === selectedIssueKey) ?? reviewableRows[0];
  const agentDisplay = resolveDisplayName(selected.agent, mapping, deAnonymize);
  const customerId = selected.customerList[0] ?? "Customer";
  const customerDisplay = resolveDisplayName(customerId, mapping, deAnonymize);
  const sentimentPrimary = selected.customerSentimentPrimary ?? "Neutral";
  const sentimentScores = selected.customerSentimentScores;

  const sentimentTooltip = sentimentScores
    ? SENTIMENT_ORDER.map(
        (label) => `${label}: ${Math.round((sentimentScores[label] ?? 0) * 100)}%`
      ).join(" · ")
    : "Sentiment distribution unavailable";

  const steps =
    selected.stepsExtract && selected.stepsExtract.length
      ? selected.stepsExtract
      : ["Model did not return any resolution steps."];

  const resolutionMarker = buildResolutionMarker(selected);

  return (
    <section className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6 shadow-inner">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Manager Review Panel</h2>
          <p className="text-sm text-slate-400">
            Inspect per-ticket reasoning, sentiment, and the exact moment the LLM marked a resolution.
          </p>
        </div>
        <div className="flex flex-col gap-2 text-sm text-slate-200">
          <label className="flex flex-col gap-1">
            Ticket under review
            <select
              value={selected.issueKey}
              onChange={(event) => setSelectedIssueKey(event.target.value)}
              className="rounded-xl border border-slate-700 bg-slate-900/80 px-4 py-2 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            >
              {reviewableRows.map((row) => (
                <option key={row.issueKey} value={row.issueKey}>
                  {row.issueKey} · {row.contactReason ?? row.contactReasonOriginal ?? "Unspecified"}
                </option>
              ))}
            </select>
          </label>
          <div className="text-xs text-slate-400">
            Showing {Math.min(reviewableRows.length, MAX_REVIEW_ROWS)} of{" "}
            {rows.length.toLocaleString()} filtered tickets.
          </div>
        </div>
      </header>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex items-center justify-between text-sm text-slate-300">
            <span>
              <span className="text-slate-500">Issue:</span>{" "}
              <a
                href={`https://portapp.atlassian.net/browse/${selected.issueKey}`}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-brand-200 hover:underline"
              >
                {selected.issueKey}
              </a>
            </span>
            <span>
              <span className="text-slate-500">Status:</span>{" "}
              <span className={selected.resolved ? "text-emerald-300" : "text-amber-300"}>
                {selected.resolved ? "Resolved" : "Unresolved"}
              </span>
            </span>
          </div>
          <p className="mt-3 text-base font-semibold text-white">{selected.ticketSummary ?? "LLM summary not available."}</p>
          <dl className="mt-4 grid gap-2 text-sm text-slate-300">
            <div className="flex flex-col rounded-xl border border-slate-800 bg-slate-950/40 p-3">
              <dt className="text-xs uppercase tracking-wide text-slate-500">Problem extract</dt>
              <dd>{selected.problemExtract ?? selected.raw?.extract_customer_problem ?? "Not provided."}</dd>
            </div>
            <div className="flex flex-col rounded-xl border border-slate-800 bg-slate-950/40 p-3">
              <dt className="text-xs uppercase tracking-wide text-slate-500">Resolution extract</dt>
              <dd>{selected.resolutionExtract ?? "Model did not provide a resolution summary."}</dd>
            </div>
          </dl>
          <div className="mt-4 grid gap-3 text-sm text-slate-300 md:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Original contact reason</p>
              <p className="mt-1 font-semibold text-white">
                {selected.contactReasonOriginal ?? "Not provided"}
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">LLM classification</p>
              <p className="mt-1 font-semibold text-white">{selected.contactReason ?? "Other"}</p>
              <span
                className={clsx(
                  "mt-2 inline-flex rounded-full px-2 py-1 text-[11px] font-semibold",
                  selected.contactReasonChange
                    ? "border border-amber-400/50 bg-amber-500/10 text-amber-200"
                    : "border border-emerald-400/40 bg-emerald-500/10 text-emerald-200"
                )}
              >
                {selected.contactReasonChange ? "Override applied" : "Matches original"}
              </span>
            </div>
          </div>
          <div className="mt-4 grid gap-2 text-sm text-slate-300 md:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Agent</p>
              <p className="font-semibold text-white">{agentDisplay.label}</p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Customer</p>
              <p className="font-semibold text-white">{customerDisplay.label}</p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-lg font-semibold text-white">LLM Explanation</h3>
            <span
              className={clsx(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold",
                SENTIMENT_BADGES[sentimentPrimary]
              )}
              title={sentimentTooltip}
            >
              <span className="h-2 w-2 rounded-full bg-current" />
              {sentimentPrimary}
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-300">
            Ratings — Conversation: {selected.conversationRating ?? "—"} · Agent:{" "}
            {selected.agentScore ?? "—"} · Customer: {selected.customerScore ?? "—"}
          </p>
          <details className="mt-4 rounded-xl border border-slate-800 bg-slate-950/30 p-3" open>
            <summary className="cursor-pointer text-sm font-semibold text-white">
              Reason for Contact-Reason Change
            </summary>
            <p className="mt-2 text-sm text-slate-300">
              {selected.reasonOverrideWhy ?? "Model left this field blank."}
            </p>
          </details>
          <details className="mt-3 rounded-xl border border-slate-800 bg-slate-950/30 p-3" open>
            <summary className="cursor-pointer text-sm font-semibold text-white">
              Why Resolved/Unresolved
            </summary>
            <p className="mt-2 text-sm text-slate-300">
              {selected.resolutionWhy ?? "Model did not explain the resolution state."}
            </p>
          </details>
          <div className="mt-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">Action steps</p>
            <ol className="mt-2 list-decimal space-y-2 rounded-xl border border-slate-800 bg-slate-950/30 p-3 text-sm text-slate-200">
              {steps.map((step, index) => (
                <li key={`${selected.issueKey}-step-${index}`} className="pl-1">
                  {step}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Resolution timeline
          </h3>
          <p className="mt-2 text-sm text-slate-300">
            Estimated resolution point highlighted based on LLM reasoning.
          </p>
          <div className="mt-4 text-xs text-slate-400">
            <div className="flex justify-between">
              <span>{formatDateTimeLocal(selected.startedAt)}</span>
              <span>{formatDateTimeLocal(selected.endedAt)}</span>
            </div>
            <div className="relative mt-2 h-2 rounded-full bg-slate-800">
              {resolutionMarker && (
                <span
                  className="absolute top-1/2 block h-4 w-4 -translate-y-1/2 rounded-full border-2 border-brand-400 bg-white shadow-[0_0_12px_rgba(14,165,233,0.6)]"
                  style={{ left: `${resolutionMarker.position * 100}%`, transform: "translate(-50%, -50%)" }}
                  title={`Resolution marker: ${resolutionMarker.label}`}
                />
              )}
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Resolution marker: {resolutionMarker ? resolutionMarker.label : "Not captured"}
            </p>
          </div>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Sentiment distribution
          </h3>
          {sentimentScores ? (
            <dl className="mt-3 grid gap-2 text-sm text-slate-200 md:grid-cols-2">
              {SENTIMENT_ORDER.map((label) => (
                <div key={label} className="rounded-xl border border-slate-800 bg-slate-950/30 p-3">
                  <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
                  <dd className="mt-1 font-semibold text-white">
                    {Math.round((sentimentScores[label] ?? 0) * 100)}%
                  </dd>
                  <div className="mt-2 h-1.5 rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full bg-brand-500"
                      style={{ width: `${Math.round((sentimentScores[label] ?? 0) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-3 text-sm text-slate-400">
              Sentiment scores are unavailable for this ticket.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function buildResolutionMarker(row: ConversationRow): { position: number; label: string } | null {
  const clamp = (value: number) => Math.min(Math.max(value, 0), 1);
  if (row.resolutionTimestamp && row.startedAt && row.endedAt) {
    const span = row.endedAt.getTime() - row.startedAt.getTime();
    if (span > 0) {
      const offset = row.resolutionTimestamp.getTime() - row.startedAt.getTime();
      return {
        position: clamp(offset / span),
        label: formatDateTimeLocal(row.resolutionTimestamp)
      };
    }
  }
  if (row.resolutionMessageIndex && row.messagesTotal) {
    return {
      position: clamp(row.resolutionMessageIndex / row.messagesTotal),
      label: `Message #${row.resolutionMessageIndex}`
    };
  }
  return null;
}
