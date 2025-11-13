import { useMemo } from "react";

import { DisplayName } from "@/components/DisplayName";
import { formatDateTimeLocal } from "@/lib/date";
import { resolveAgentRole } from "@/lib/roles";
import { AgentRole, ImprovementTipEntry } from "@/types";

type TipsDrilldownModalProps = {
  open: boolean;
  tips: ImprovementTipEntry[];
  windowStart: Date;
  windowEnd: Date;
  onClose: () => void;
  mapping: Record<string, string>;
  agentMapping: Record<string, string>;
  deAnonymize: boolean;
  roleMapping: Record<string, AgentRole>;
};

export function TipsDrilldownModal({
  open,
  tips,
  windowStart,
  windowEnd,
  onClose,
  mapping,
  agentMapping,
  deAnonymize,
  roleMapping
}: TipsDrilldownModalProps) {
  const sortedTips = useMemo(
    () => [...tips].sort((a, b) => b.count - a.count),
    [tips]
  );

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 backdrop-blur">
      <div className="flex max-h-[90vh] w-[min(960px,94vw)] flex-col overflow-hidden rounded-3xl border border-slate-800 bg-slate-950/95 shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">LLM Improvement Report</h2>
            <p className="text-xs text-slate-400">
              Window: {formatDateTimeLocal(windowStart)} → {formatDateTimeLocal(windowEnd)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-brand-500 hover:text-brand-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
          >
            Close
          </button>
        </header>
        <div className="overflow-auto">
          <table className="min-w-full divide-y divide-slate-800 text-sm">
            <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Tip</th>
                <th className="px-4 py-3 text-left font-semibold">Occurrences</th>
                <th className="px-4 py-3 text-left font-semibold">Agents</th>
                <th className="px-4 py-3 text-left font-semibold">Tickets</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-900/70">
              {sortedTips.map((tip) => (
                <tr key={tip.tip} className="align-top hover:bg-slate-900/40">
                  <td className="px-4 py-4 text-slate-100">{tip.tip}</td>
                  <td className="px-4 py-4 font-semibold text-brand-200">{tip.count}</td>
                  <td className="px-4 py-4">
                    <div className="flex flex-wrap gap-2">
                      {tip.agents.length ? (
                        tip.agents.map((agent) => (
                          <span
                            key={`${tip.tip}-${agent}`}
                            className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1 text-xs text-slate-200"
                          >
                            <DisplayName
                              id={agent}
                              mapping={mapping}
                              agentMapping={agentMapping}
                              deAnonymize={deAnonymize}
                              titlePrefix="Agent ID"
                              showRole={true}
                              role={resolveAgentRole(agent, roleMapping)}
                            />
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-slate-500">—</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <TicketList issueKeys={tip.issueKeys} />
                  </td>
                </tr>
              ))}
              {!sortedTips.length && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-400" colSpan={4}>
                    No improvement tips available for this window.
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

const JIRA_BASE_URL = "https://portapp.atlassian.net/browse/";

function TicketList({ issueKeys }: { issueKeys: string[] }) {
  if (!issueKeys.length) {
    return <span className="text-xs text-slate-500">—</span>;
  }
  const displayKeys = issueKeys.slice(0, 5);
  const remaining = issueKeys.length - displayKeys.length;
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {displayKeys.map((key) => (
        <a
          key={key}
          href={`${JIRA_BASE_URL}${key}`}
          target="_blank"
          rel="noreferrer"
          className="rounded-full border border-brand-500/40 bg-brand-500/15 px-3 py-1 text-brand-100 hover:bg-brand-500/30"
        >
          {key}
        </a>
      ))}
      {remaining > 0 && (
        <span className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1 text-slate-300">
          +{remaining}
        </span>
      )}
    </div>
  );
}
