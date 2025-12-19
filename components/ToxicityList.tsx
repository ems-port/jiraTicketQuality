import { DisplayName } from "@/components/DisplayName";
import { resolveAgentRole } from "@/lib/roles";
import { AgentRole, ToxicityEntry } from "@/types";

const JIRA_BASE_URL = "https://portapp.atlassian.net/browse/";

type ToxicityListProps = {
  title: string;
  subtitle: string;
  entries: ToxicityEntry[];
  emptyLabel: string;
  mapping: Record<string, string>;
  agentMapping?: Record<string, string>;
  deAnonymize: boolean;
  entityLabel?: string;
  showAgentRoles?: boolean;
  roleMapping?: Record<string, AgentRole>;
  anonymizedLabel?: string;
};

export function ToxicityList({
  title,
  subtitle,
  entries,
  emptyLabel,
  mapping,
  agentMapping,
  deAnonymize,
  entityLabel = "Entity",
  showAgentRoles = false,
  roleMapping = {} as Record<string, AgentRole>,
  anonymizedLabel
}: ToxicityListProps) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
      <header className="mb-4 flex items-baseline justify-between">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <span className="text-xs uppercase tracking-wide text-slate-400">
          {subtitle}
        </span>
      </header>
      <ul className="flex flex-col gap-3">
        {entries.map((entry) => (
          <li
            key={entry.entity}
            className="rounded-xl border border-slate-800/50 bg-slate-900/70 p-4 text-sm text-slate-100"
          >
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <p className="text-sm font-semibold text-white">
                  <DisplayName
                    id={entry.entity}
                    mapping={mapping}
                    agentMapping={agentMapping}
                    deAnonymize={deAnonymize}
                    titlePrefix={entityLabel}
                    showRole={showAgentRoles}
                    anonymizedLabel={anonymizedLabel}
                    role={
                      showAgentRoles ? resolveAgentRole(entry.entity, roleMapping) : undefined
                    }
                  />
                </p>
                <p className="mt-2 text-xs uppercase tracking-wide text-slate-400">
                  {entry.abusiveTicketCount ?? 0}/{entry.totalTicketCount ?? 0} abusive tickets ·{" "}
                  {entry.swearCount ?? 0} swear hit{(entry.swearCount ?? 0) === 1 ? "" : "s"}
                </p>
              </div>
              <div className="text-right">
                <span className="text-sm font-semibold text-brand-200">
                  {formatScore(entry.averageCustomerScore)}
                </span>
                <p className="text-xs font-semibold text-red-200">
                  Swear impact {formatImpact(entry.meanToxicity)}
                </p>
              </div>
            </div>
            {renderTicketChips(entry)}
          </li>
        ))}
        {!entries.length && (
          <li className="rounded-xl border border-dashed border-slate-700 p-4 text-center text-sm text-slate-400">
            {emptyLabel}
          </li>
        )}
      </ul>
    </section>
  );
}

function formatScore(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "—";
  }
  return value.toFixed(2);
}

function formatImpact(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "0";
  }
  return value.toLocaleString();
}

function renderTicketChips(entry: ToxicityEntry) {
  const abuseKeys =
    entry.abusiveTicketKeys && entry.abusiveTicketKeys.length
      ? entry.abusiveTicketKeys
      : entry.ticketKeys;
  if (!abuseKeys.length) {
    return null;
  }
  return (
    <div className="mt-3 flex flex-wrap gap-2 text-xs text-brand-200">
      {abuseKeys.map((key) => (
        <a
          key={key}
          href={`${JIRA_BASE_URL}${key}`}
          target="_blank"
          rel="noreferrer"
          className="rounded-full border border-brand-500/50 bg-brand-500/15 px-3 py-1 font-medium hover:bg-brand-500/30"
        >
          {key}
        </a>
      ))}
    </div>
  );
}
