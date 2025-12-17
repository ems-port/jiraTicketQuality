import { formatDateTimeLocal } from "@/lib/date";
import type { ImprovementGroupingPayload, ImprovementGroupingRecord } from "@/types";

const JIRA_BASE_URL = "https://portapp.atlassian.net/browse/";

type ImprovementGroupsPanelProps = {
  record: ImprovementGroupingRecord | null;
  loading?: boolean;
  error?: string | null;
  onOpen?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshStatus?: string | null;
  onSelectGroup?: (groupId: string) => void;
};

export function ImprovementGroupsPanel({
  record,
  loading = false,
  error = null,
  onOpen,
  onRefresh,
  refreshing = false,
  refreshStatus = null,
  onSelectGroup
}: ImprovementGroupsPanelProps) {
  const grouping = record?.payload ?? null;
  const groups = grouping?.groups ?? [];
  const topGroups = groups.slice(0, 3);
  const hasData = Boolean(topGroups.length);
  const timeWindow = grouping?.time_window
    ? `${formatDateTimeLocal(new Date(grouping.time_window.start_utc))} -> ${formatDateTimeLocal(
        new Date(grouping.time_window.end_utc)
      )}`
    : null;
  const ageHours =
    grouping?.time_window?.end_utc != null
      ? (Date.now() - new Date(grouping.time_window.end_utc).getTime()) / (1000 * 60 * 60)
      : null;
  let staleness = "unknown";
  if (ageHours != null) {
    if (ageHours < 1) {
      const minutes = Math.max(1, Math.round(ageHours * 60));
      staleness = `${minutes}m ago`;
    } else {
      const hoursRounded = Math.max(1, Math.round(ageHours));
      staleness = `${hoursRounded}h ago`;
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-inner">
      <header className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Tips of the Day</h2>
          <p className="text-xs text-slate-400">
            Clustered coaching tips with top ticket links. Updated from the latest Supabase grouping.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/70 px-3 py-1 text-xs text-slate-300">
          <ClockGlyph className="h-4 w-4 text-brand-300" aria-hidden={true} />
          <span>{timeWindow ?? "—"}</span>
          <span className="text-slate-500">-</span>
          <span>{staleness}</span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1 text-[11px] font-semibold text-slate-200 transition hover:border-brand-500 hover:text-brand-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error && <p className="text-sm text-rose-300">Unable to load improvement groups: {error}</p>}
      {loading && <p className="text-sm text-slate-400">Loading improvement groups...</p>}
      {refreshStatus && <p className="text-sm text-slate-300">{refreshStatus}</p>}

      <div className="grid gap-3 md:grid-cols-3">
        {hasData ? (
          topGroups.map((group) => (
            <button
              key={group.groupId}
              type="button"
              onClick={() => {
                onSelectGroup?.(group.groupId);
                onOpen?.();
              }}
              className="block w-full text-left rounded-2xl border border-slate-800 bg-slate-900/80 p-0 shadow-sm transition hover:border-brand-500/70 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
            >
              <GroupCard group={group} />
            </button>
          ))
        ) : (
          <div className="md:col-span-3 rounded-2xl border border-dashed border-slate-700 bg-slate-900/60 p-6 text-sm text-slate-400">
            No grouped improvement tips available yet.
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
        <span>
          {grouping?.totals?.notes?.toLocaleString() ?? "0"} notes -{" "}
          {grouping?.totals?.unique_notes?.toLocaleString() ?? "0"} unique
        </span>
        <button
          type="button"
          onClick={onOpen}
          disabled={!hasData}
          className="rounded-full border border-brand-500/60 bg-brand-500/15 px-4 py-2 text-sm font-semibold text-brand-100 transition enabled:hover:bg-brand-500/30 disabled:border-slate-800 disabled:text-slate-500"
        >
          View full improvement report
        </button>
      </footer>
    </section>
  );
}

function GroupCard({ group }: { group: ImprovementGroupingPayload["groups"][number] }) {
  const keyIds = Array.isArray(group.keyIds) ? group.keyIds : [];
  const displayKeys = keyIds.slice(0, 5);
  const remaining = keyIds.length - displayKeys.length;
  const metrics = group.metrics || {
    groupSize: keyIds.length,
    coveragePct: 0,
    actionabilityScore: 0,
    severityScore: 0,
    overallScore: 0
  };
  return (
    <article className="flex flex-col gap-2 rounded-2xl p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-white">{group.title}</h3>
        <span className="rounded-full bg-brand-500/20 px-3 py-1 text-xs font-semibold text-brand-100">
          {metrics.groupSize}x
        </span>
      </div>
      <p className="text-sm text-slate-200">{group.tip}</p>
      <p className="text-[11px] uppercase tracking-wide text-slate-500">
        Coverage {metrics.coveragePct?.toFixed?.(1) ?? "0.0"}% - Actionability {metrics.actionabilityScore}/5 - Severity{" "}
        {metrics.severityScore}/5
      </p>
    </article>
  );
}

function ClockGlyph({ className, "aria-hidden": ariaHidden }: { className?: string; "aria-hidden"?: boolean }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={ariaHidden}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v4.5l3 3" />
    </svg>
  );
}
