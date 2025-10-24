import { DisplayName } from "@/components/DisplayName";
import { ToxicityEntry } from "@/types";

const JIRA_BASE_URL = "https://portapp.atlassian.net/browse/";

type ToxicityListProps = {
  title: string;
  subtitle: string;
  entries: ToxicityEntry[];
  emptyLabel: string;
  mapping: Record<string, string>;
  deAnonymize: boolean;
  entityLabel?: string;
};

export function ToxicityList({
  title,
  subtitle,
  entries,
  emptyLabel,
  mapping,
  deAnonymize,
  entityLabel = "Entity"
}: ToxicityListProps) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
      <header className="mb-4 flex items-baseline justify-between">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <span className="text-xs uppercase tracking-wide text-slate-400">{subtitle}</span>
      </header>
      <ul className="flex flex-col gap-3">
        {entries.map((entry) => (
          <li
            key={entry.entity}
            className="rounded-xl border border-slate-800/50 bg-slate-900/70 p-4 text-sm text-slate-100"
          >
            <div className="flex items-center justify-between">
              <p className="text-base font-semibold text-white">
                <DisplayName
                  id={entry.entity}
                  mapping={mapping}
                  deAnonymize={deAnonymize}
                  titlePrefix={entityLabel}
                />
              </p>
              <span className="rounded-full bg-red-500/20 px-3 py-1 text-xs font-semibold text-red-200">
                {(entry.meanToxicity * 100).toFixed(0)}%
              </span>
            </div>
            <p className="mt-2 text-xs uppercase tracking-wide text-slate-400">
              {entry.messageCount} flagged message{entry.messageCount === 1 ? "" : "s"}
            </p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-brand-200">
              {entry.ticketKeys.map((key) => (
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
