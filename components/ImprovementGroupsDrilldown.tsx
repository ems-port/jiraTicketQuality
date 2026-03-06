import clsx from "clsx";
import { useMemo, useRef, useEffect, useState, useCallback } from "react";

import { DisplayName } from "@/components/DisplayName";
import { formatDateTimeLocal } from "@/lib/date";
import { resolveAgentRole } from "@/lib/roles";
import { ensureReviewIdentity, persistReviewDisplayName } from "@/lib/reviewIdentity";
import type { ReviewIdentity } from "@/lib/reviewIdentity";
import type {
  AgentRole,
  ImprovementFeedbackVerdict,
  ImprovementGroupFeedbackEntry,
  ImprovementGroupFeedbackSummary,
  ImprovementGroupingPayload
} from "@/types";

const JIRA_BASE_URL = "https://portapp.atlassian.net/browse/";

type ImprovementGroupsDrilldownProps = {
  open: boolean;
  grouping: ImprovementGroupingPayload | null;
  groupingId?: string | null;
  onClose: () => void;
  issueAgents: Record<string, string[]>;
  mapping: Record<string, string>;
  agentMapping: Record<string, string>;
  deAnonymize: boolean;
  roleMapping: Record<string, AgentRole>;
  selectedGroupId?: string | null;
};

export function ImprovementGroupsDrilldown({
  open,
  grouping,
  groupingId = null,
  onClose,
  issueAgents,
  mapping,
  agentMapping,
  deAnonymize,
  roleMapping,
  selectedGroupId
}: ImprovementGroupsDrilldownProps) {
  const groups = Array.isArray(grouping?.groups) ? grouping?.groups : [];
  const [reviewIdentity, setReviewIdentity] = useState<ReviewIdentity | null>(null);
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [feedbackMap, setFeedbackMap] = useState<Record<string, ImprovementGroupFeedbackSummary>>({});
  const [feedbackEntriesMap, setFeedbackEntriesMap] = useState<Record<string, ImprovementGroupFeedbackEntry[]>>({});
  const [feedbackDrafts, setFeedbackDrafts] = useState<
    Record<string, { verdict: ImprovementFeedbackVerdict | null; notes: string }>
  >({});
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [savingGroupId, setSavingGroupId] = useState<string | null>(null);

  const agentLookup = useMemo(() => {
    const result: Record<string, { agentId: string; hits: number }[]> = {};
    groups.forEach((group) => {
      const counter = new Map<string, number>();
      const keyIds = Array.isArray(group.keyIds) ? group.keyIds : [];
      keyIds.forEach((key) => {
        (issueAgents[key] ?? []).forEach((agent) => {
          counter.set(agent, (counter.get(agent) ?? 0) + 1);
        });
      });
      result[group.groupId] = Array.from(counter.entries()).map(([agentId, hits]) => ({
        agentId,
        hits
      }));
    });
    return result;
  }, [groups, issueAgents]);

  const selectedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open && selectedRef.current) {
      const node = selectedRef.current;
      // Defer to allow layout to settle
      const timer = setTimeout(() => {
        node.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [open, selectedGroupId, groups.length]);

  const groupIds = useMemo(
    () => groups.map((group) => group.groupId).filter((groupId) => groupId.trim().length > 0),
    [groups]
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const identity = ensureReviewIdentity();
    setReviewIdentity(identity);
    setDisplayNameDraft(identity?.displayName ?? "");
  }, [open]);

  const loadFeedback = useCallback(async () => {
    if (!open || !groupingId || !groupIds.length) {
      setFeedbackMap({});
      setFeedbackEntriesMap({});
      setFeedbackDrafts({});
      return;
    }
    setFeedbackLoading(true);
    setFeedbackError(null);
    try {
      const identity = reviewIdentity ?? ensureReviewIdentity();
      if (identity && !reviewIdentity) {
        setReviewIdentity(identity);
      }
      const params = new URLSearchParams();
      params.set("groupingId", groupingId);
      params.set("groupIds", groupIds.join(","));
      if (identity?.id) {
        params.set("userId", identity.id);
      }
      const response = await fetch(`/api/improvement-group-feedback?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Failed to load feedback (${response.status})`);
      }
      const payload = await response.json();
      const summariesRaw = payload?.summaries && typeof payload.summaries === "object" ? payload.summaries : {};
      const nextSummary: Record<string, ImprovementGroupFeedbackSummary> = {};
      groupIds.forEach((groupId) => {
        const row = summariesRaw[groupId];
        nextSummary[groupId] = {
          groupId,
          upCount: Number(row?.upCount ?? 0),
          downCount: Number(row?.downCount ?? 0),
          entries: Number(row?.entries ?? 0),
          userVerdict: row?.userVerdict === "up" || row?.userVerdict === "down" ? row.userVerdict : null,
          userNotes: typeof row?.userNotes === "string" ? row.userNotes : null,
          userDisplayName: typeof row?.userDisplayName === "string" ? row.userDisplayName : null,
          lastUpdatedAt: typeof row?.lastUpdatedAt === "string" ? row.lastUpdatedAt : null,
          lastUpdatedBy: typeof row?.lastUpdatedBy === "string" ? row.lastUpdatedBy : null
        };
      });
      setFeedbackMap(nextSummary);
      const entriesRaw = payload?.entries && typeof payload.entries === "object" ? payload.entries : {};
      const nextEntries: Record<string, ImprovementGroupFeedbackEntry[]> = {};
      groupIds.forEach((groupId) => {
        const list = Array.isArray(entriesRaw[groupId]) ? entriesRaw[groupId] : [];
        nextEntries[groupId] = list
          .filter((entry) => entry && typeof entry === "object")
          .map((entry) => ({
            groupId,
            verdict: (entry.verdict === "down" ? "down" : "up") as ImprovementFeedbackVerdict,
            notes: String(entry.notes ?? "").trim(),
            userId: String(entry.userId ?? "").trim(),
            userDisplayName:
              typeof entry.userDisplayName === "string" && entry.userDisplayName.trim().length
                ? entry.userDisplayName.trim()
                : null,
            updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
            createdAt: typeof entry.createdAt === "string" ? entry.createdAt : null
          }))
          .filter((entry) => entry.notes.length > 0);
      });
      setFeedbackEntriesMap(nextEntries);
      setFeedbackDrafts(
        groupIds.reduce(
          (acc, groupId) => ({
            ...acc,
            [groupId]: {
              verdict: nextSummary[groupId]?.userVerdict ?? null,
              notes: nextSummary[groupId]?.userNotes ?? ""
            }
          }),
          {} as Record<string, { verdict: ImprovementFeedbackVerdict | null; notes: string }>
        )
      );
      if (typeof payload?.warning === "string" && payload.warning.trim()) {
        setFeedbackError(payload.warning);
      }
    } catch (error) {
      setFeedbackError((error as Error).message ?? "Unable to load feedback.");
    } finally {
      setFeedbackLoading(false);
    }
  }, [open, groupingId, groupIds, reviewIdentity]);

  useEffect(() => {
    void loadFeedback();
  }, [loadFeedback]);

  async function saveFeedback(groupId: string) {
    if (!groupingId) {
      setFeedbackError("Missing grouping id for feedback save.");
      return;
    }
    const identity = reviewIdentity ?? ensureReviewIdentity();
    if (!identity) {
      setFeedbackError("Unable to initialize reviewer identity.");
      return;
    }

    const savedIdentity = persistReviewDisplayName(displayNameDraft);
    const effectiveIdentity = savedIdentity ?? identity;
    if (!reviewIdentity || savedIdentity) {
      setReviewIdentity(effectiveIdentity);
    }

    const draft = feedbackDrafts[groupId] ?? {
      verdict: feedbackMap[groupId]?.userVerdict ?? null,
      notes: feedbackMap[groupId]?.userNotes ?? ""
    };
    if (!draft.verdict) {
      setFeedbackError("Please select Up or Down before saving.");
      return;
    }

    setSavingGroupId(groupId);
    setFeedbackError(null);
    try {
      const response = await fetch("/api/improvement-group-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupingId,
          groupId,
          verdict: draft.verdict,
          notes: draft.notes,
          userId: effectiveIdentity.id,
          userDisplay: displayNameDraft.trim() || null,
          userFingerprint: effectiveIdentity.id
        })
      });
      if (!response.ok) {
        throw new Error(`Failed to save feedback (${response.status})`);
      }
      const payload = await response.json();
      const row = payload?.summaries?.[groupId];
      const entriesRaw = payload?.entries?.[groupId];
      const parsedEntries = Array.isArray(entriesRaw)
        ? entriesRaw
            .filter((entry) => entry && typeof entry === "object")
            .map((entry) => ({
              groupId,
              verdict: (entry.verdict === "down" ? "down" : "up") as ImprovementFeedbackVerdict,
              notes: String(entry.notes ?? "").trim(),
              userId: String(entry.userId ?? "").trim(),
              userDisplayName:
                typeof entry.userDisplayName === "string" && entry.userDisplayName.trim().length
                  ? entry.userDisplayName.trim()
                  : null,
              updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
              createdAt: typeof entry.createdAt === "string" ? entry.createdAt : null
            }))
            .filter((entry) => entry.notes.length > 0)
        : null;
      if (row) {
        setFeedbackMap((prev) => ({
          ...prev,
          [groupId]: {
            groupId,
            upCount: Number(row.upCount ?? 0),
            downCount: Number(row.downCount ?? 0),
            entries: Number(row.entries ?? 0),
            userVerdict: row.userVerdict === "up" || row.userVerdict === "down" ? row.userVerdict : null,
            userNotes: typeof row.userNotes === "string" ? row.userNotes : null,
            userDisplayName: typeof row.userDisplayName === "string" ? row.userDisplayName : null,
            lastUpdatedAt: typeof row.lastUpdatedAt === "string" ? row.lastUpdatedAt : null,
            lastUpdatedBy: typeof row.lastUpdatedBy === "string" ? row.lastUpdatedBy : null
          }
        }));
      }
      if (parsedEntries) {
        setFeedbackEntriesMap((prev) => ({
          ...prev,
          [groupId]: parsedEntries
        }));
      }
    } catch (error) {
      setFeedbackError((error as Error).message ?? "Unable to save feedback.");
    } finally {
      setSavingGroupId(null);
    }
  }

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 backdrop-blur">
      <div className="flex max-h-[90vh] w-[min(1100px,94vw)] flex-col overflow-hidden rounded-3xl border border-slate-800 bg-slate-950/95 shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Improvement Themes Drilldown</h2>
            {grouping?.time_window && (
              <p className="text-xs text-slate-400">
                Window: {formatDateTimeLocal(new Date(grouping.time_window.start_utc))} →{" "}
                {formatDateTimeLocal(new Date(grouping.time_window.end_utc))}
              </p>
            )}
            <p className="mt-2 text-xs text-slate-400">
              Metrics Validation (LLM feedback usefulness): rate each improvement point and add notes.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={displayNameDraft}
              onChange={(event) => setDisplayNameDraft(event.target.value)}
              placeholder="Reviewer name (optional)"
              className="w-44 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500"
            />
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-brand-500 hover:text-brand-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
            >
              Close
            </button>
          </div>
        </header>
        <div className="overflow-auto p-6 space-y-4">
          {feedbackError && <p className="text-sm text-amber-300">{feedbackError}</p>}
          {feedbackLoading && <p className="text-sm text-slate-400">Loading feedback...</p>}
          {groups.map((group) => {
            const keyIds = Array.isArray(group.keyIds) ? group.keyIds : [];
            const steps = Array.isArray(group.nextSteps) ? group.nextSteps : [];
            const metrics = group.metrics || {
              groupSize: keyIds.length,
              coveragePct: 0,
              actionabilityScore: 0,
              severityScore: 0,
              overallScore: 0
            };
            const isSelected = selectedGroupId && group.groupId === selectedGroupId;
            const summary = feedbackMap[group.groupId];
            const draft = feedbackDrafts[group.groupId] ?? {
              verdict: summary?.userVerdict ?? null,
              notes: summary?.userNotes ?? ""
            };
            const reviewerId = reviewIdentity?.id ?? null;
            const allNotes = feedbackEntriesMap[group.groupId] ?? [];
            const otherNotes = reviewerId ? allNotes.filter((entry) => entry.userId !== reviewerId) : allNotes;
            return (
            <article
              key={group.groupId}
              ref={isSelected ? selectedRef : null}
              className={`rounded-2xl border p-4 ${isSelected ? "border-brand-500 bg-slate-900/80" : "border-slate-800 bg-slate-900/70"}`}
            >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-white">{group.title}</h3>
                <p className="text-sm text-slate-200">{group.tip}</p>
                <p className="text-sm text-slate-400">{group.description}</p>
              </div>
              <div className="text-right text-xs text-slate-400">
                <div>Size: {metrics.groupSize}</div>
                <div>Coverage: {metrics.coveragePct != null ? metrics.coveragePct.toFixed(1) : "0.0"}%</div>
                <div>Actionability: {metrics.actionabilityScore}/5</div>
                <div>Severity: {metrics.severityScore}/5</div>
              </div>
            </div>

              <section className="mt-3 flex flex-wrap gap-2">
                {keyIds.map((key) => (
                  <a
                    key={key}
                    href={`${JIRA_BASE_URL}${key}`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-full border border-brand-500/40 bg-brand-500/15 px-3 py-1 text-xs text-brand-100 hover:bg-brand-500/30"
                  >
                    {key}
                  </a>
                ))}
                {!keyIds.length && (
                  <span className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1 text-xs text-slate-300">
                    No linked tickets
                  </span>
                )}
              </section>

              <section className="mt-3">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Agents</h4>
                <div className="mt-2 flex flex-wrap gap-2">
                  {agentLookup[group.groupId]?.length ? (
                    agentLookup[group.groupId].map((entry) => (
                      <span
                        key={`${group.groupId}-${entry.agentId}`}
                        className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1 text-xs text-slate-200"
                      >
                        <DisplayName
                          id={entry.agentId}
                          mapping={mapping}
                          agentMapping={agentMapping}
                          deAnonymize={deAnonymize}
                          titlePrefix="Agent ID"
                          showRole={true}
                          role={resolveAgentRole(entry.agentId, roleMapping)}
                        />{" "}
                        ({entry.hits})
                      </span>
                    ))
                  ) : (
                    <span className="text-xs text-slate-500">No agents mapped.</span>
                  )}
                </div>
              </section>

              <section className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Next steps</h4>
                    <div className="mt-2 grid gap-2">
                      {steps.map((step, idx) => (
                        <div
                          key={`${group.groupId}-step-${idx}`}
                          className="rounded-xl border border-slate-800 bg-slate-900/80 p-3 text-sm text-slate-200"
                        >
                          <p className="font-semibold text-white">Training cue</p>
                          <p className="text-slate-200">{step.trainingCue}</p>
                          <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Success signals</p>
                          <ul className="list-disc pl-5 text-sm text-slate-200">
                            {step.successSignals.map((signal, sIdx) => (
                              <li key={`${group.groupId}-signal-${idx}-${sIdx}`}>{signal}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                      {!steps.length && (
                        <p className="text-sm text-slate-500">No next steps provided.</p>
                      )}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      Metrics Validation (LLM feedback usefulness)
                    </h4>
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <ThumbReviewButton
                        verdict="up"
                        count={summary?.upCount ?? 0}
                        selected={draft.verdict === "up"}
                        disabled={savingGroupId === group.groupId}
                        onClick={() =>
                          setFeedbackDrafts((prev) => ({
                            ...prev,
                            [group.groupId]: { ...draft, verdict: "up" }
                          }))
                        }
                      />
                      <ThumbReviewButton
                        verdict="down"
                        count={summary?.downCount ?? 0}
                        selected={draft.verdict === "down"}
                        disabled={savingGroupId === group.groupId}
                        onClick={() =>
                          setFeedbackDrafts((prev) => ({
                            ...prev,
                            [group.groupId]: { ...draft, verdict: "down" }
                          }))
                        }
                      />
                    </div>
                    {summary?.lastUpdatedAt && (
                      <p className="mt-2 text-xs text-slate-500">
                        Last: {formatDateTimeLocal(new Date(summary.lastUpdatedAt))}
                        {summary.lastUpdatedBy ? ` by ${summary.lastUpdatedBy}` : ""}
                      </p>
                    )}

                    <textarea
                      value={draft.notes}
                      onChange={(event) =>
                        setFeedbackDrafts((prev) => ({
                          ...prev,
                          [group.groupId]: { ...draft, notes: event.target.value.slice(0, 2000) }
                        }))
                      }
                      placeholder="Validation notes for this point..."
                      rows={3}
                      className="mt-3 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500"
                    />
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[11px] text-slate-500">{draft.notes.length}/2000</span>
                      <button
                        type="button"
                        onClick={() => void saveFeedback(group.groupId)}
                        disabled={savingGroupId === group.groupId}
                        className="rounded-full border border-brand-500/60 bg-brand-500/15 px-4 py-1.5 text-xs font-semibold text-brand-100 transition hover:bg-brand-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {savingGroupId === group.groupId ? "Saving..." : "Save feedback"}
                      </button>
                    </div>

                    <div className="mt-4 border-t border-slate-800 pt-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        Team notes
                      </p>
                      <div className="mt-2 space-y-2">
                        {otherNotes.length ? (
                          otherNotes.map((entry, idx) => {
                            const timestamp = entry.updatedAt ?? entry.createdAt;
                            const author = (entry.userDisplayName ?? entry.userId) || "Reviewer";
                            return (
                              <div
                                key={`${group.groupId}-note-${entry.userId || "anon"}-${timestamp || idx}`}
                                className="rounded-lg border border-slate-800 bg-slate-950/60 p-2"
                              >
                                <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
                                  <span className="inline-flex items-center gap-1">
                                    <ThumbIcon direction={entry.verdict} />
                                    <span>{author}</span>
                                  </span>
                                  <span>
                                    {timestamp ? formatDateTimeLocal(new Date(timestamp)) : "Unknown date"}
                                  </span>
                                </div>
                                <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-200">
                                  {entry.notes}
                                </p>
                              </div>
                            );
                          })
                        ) : (
                          <p className="text-xs text-slate-500">No notes from other reviewers yet.</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            </article>
          );
          })}
          {!groups.length && <p className="text-sm text-slate-400">No grouped improvement tips available.</p>}
        </div>
      </div>
    </div>
  );
}

function ThumbReviewButton({
  verdict,
  count,
  selected,
  disabled,
  onClick
}: {
  verdict: ImprovementFeedbackVerdict;
  count: number;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const hasVotes = count > 0;
  const baseClasses =
    "flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
  const verdictClasses =
    verdict === "up"
      ? selected
        ? "border-emerald-400 bg-emerald-500/20 text-emerald-100 focus-visible:outline-emerald-400"
        : hasVotes
        ? "border-emerald-400/60 bg-emerald-500/10 text-emerald-100 focus-visible:outline-emerald-400"
        : "border-slate-700 text-slate-300 hover:border-emerald-400/60 hover:text-emerald-100 focus-visible:outline-emerald-400"
      : selected
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
      aria-pressed={selected}
    >
      <ThumbIcon direction={verdict} />
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

function ThumbIcon({ direction }: { direction: ImprovementFeedbackVerdict }) {
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
