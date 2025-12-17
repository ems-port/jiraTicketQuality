import { useMemo } from "react";

import { DisplayName } from "@/components/DisplayName";
import { formatDateTimeLocal } from "@/lib/date";
import { resolveAgentRole } from "@/lib/roles";
import type { AgentRole, ImprovementGroupingPayload } from "@/types";

const JIRA_BASE_URL = "https://portapp.atlassian.net/browse/";

type ImprovementGroupsDrilldownProps = {
  open: boolean;
  grouping: ImprovementGroupingPayload | null;
  onClose: () => void;
  issueAgents: Record<string, string[]>;
  mapping: Record<string, string>;
  agentMapping: Record<string, string>;
  deAnonymize: boolean;
  roleMapping: Record<string, AgentRole>;
};

export function ImprovementGroupsDrilldown({
  open,
  grouping,
  onClose,
  issueAgents,
  mapping,
  agentMapping,
  deAnonymize,
  roleMapping
}: ImprovementGroupsDrilldownProps) {
  const groups = Array.isArray(grouping?.groups) ? grouping?.groups : [];

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
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-brand-500 hover:text-brand-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
          >
            Close
          </button>
        </header>
        <div className="overflow-auto p-6 space-y-4">
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
            return (
            <article key={group.groupId} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
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

              <section className="mt-3">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Next steps</h4>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
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
                    <p className="text-sm text-slate-500 md:col-span-2">No next steps provided.</p>
                  )}
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
