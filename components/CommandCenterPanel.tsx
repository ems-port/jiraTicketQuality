import { ChangeEvent, useMemo, useRef, useState } from "react";
import clsx from "clsx";

import { resolveDisplayName } from "@/lib/displayNames";
import { formatRoleLabel, resolveAgentRole } from "@/lib/roles";
import type { AgentRole } from "@/types";

type CommandCenterPanelProps = {
  onUploadConversations: (file: File) => void;
  onLoadSampleData: () => void | Promise<void>;
  sampleDataActive: boolean;
  fileName: string | null;
  fileError: string | null;
  deAnonymize: boolean;
  onToggleDeAnonymize: (value: boolean) => void;
  onUploadMapping: (file: File) => void;
  mappedCount: number;
  conversationCount: number;
  mappingError: string | null;
  roleMapping: Record<string, AgentRole>;
  onUploadRoles: (file: File) => void;
  roleUploadError: string | null;
  onRoleChange: (agentId: string, role: AgentRole) => void;
  agentIds: string[];
  idMapping: Record<string, string>;
};

const ROLE_VALUES: AgentRole[] = ["TIER1", "TIER2", "NON_AGENT"];
const ROLE_OPTIONS = ROLE_VALUES.map((role) => ({
  value: role,
  label: formatRoleLabel(role)
}));

export function CommandCenterPanel({
  onUploadConversations,
  onLoadSampleData,
  sampleDataActive,
  fileName,
  fileError,
  deAnonymize,
  onToggleDeAnonymize,
  onUploadMapping,
  mappedCount,
  conversationCount,
  mappingError,
  roleMapping,
  onUploadRoles,
  roleUploadError,
  onRoleChange,
  agentIds,
  idMapping
}: CommandCenterPanelProps) {
  const conversationInputRef = useRef<HTMLInputElement | null>(null);
  const mappingInputRef = useRef<HTMLInputElement | null>(null);
  const roleInputRef = useRef<HTMLInputElement | null>(null);
  const [roleSearch, setRoleSearch] = useState("");

  const managedAgents = useMemo(() => {
    const ids = new Set(agentIds);
    Object.keys(roleMapping).forEach((id) => ids.add(id));
    return Array.from(ids);
  }, [agentIds, roleMapping]);

  const agentEntries = useMemo(() => {
    const search = roleSearch.trim().toLowerCase();
    return managedAgents
      .map((agentId) => {
        const display = resolveDisplayName(agentId, idMapping, deAnonymize);
        return {
          agentId,
          label: display.label,
          labelForSearch: display.label.toLowerCase(),
          role: resolveAgentRole(agentId, roleMapping),
          title: `Agent ID: ${agentId}`
        };
      })
      .filter((entry) => {
        if (!search) {
          return true;
        }
        return entry.labelForSearch.includes(search) || entry.agentId.toLowerCase().includes(search);
      })
      .sort((a, b) => a.labelForSearch.localeCompare(b.labelForSearch));
  }, [managedAgents, idMapping, deAnonymize, roleMapping, roleSearch]);

  const assignedCount = Object.keys(roleMapping).length;

  const handleConversationChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      onUploadConversations(file);
      // Reset the input so the same file can be uploaded again.
      event.target.value = "";
    }
  };

  const handleMappingChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      onUploadMapping(file);
      event.target.value = "";
    }
  };

  const handleRolesChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      onUploadRoles(file);
      event.target.value = "";
    }
  };

  return (
    <aside className="flex h-full flex-col gap-4 rounded-3xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg">
      <header className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-white">Quality Command Center</h2>
        <p className="text-xs text-slate-400">
          Load datasets, toggle de-anonymization, and manage lookup mappings. Controls below apply
          instantly to the dashboard.
        </p>
      </header>

      <section className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-white">Conversation dataset</span>
          <span className="text-xs uppercase tracking-wide text-slate-400">
            {conversationCount.toLocaleString()} rows
          </span>
        </div>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-brand-500/50 bg-brand-500/20 px-4 py-2 text-sm font-semibold text-brand-100 transition hover:bg-brand-500/40">
          <input
            ref={conversationInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleConversationChange}
          />
          Upload CSV
        </label>
        <button
          type="button"
          onClick={() => {
            void onLoadSampleData();
          }}
          className={clsx(
            "rounded-xl px-4 py-2 text-sm font-semibold transition",
            sampleDataActive
              ? "border border-emerald-500/60 bg-emerald-500/20 text-emerald-200"
              : "border border-slate-700 text-slate-200 hover:border-brand-500 hover:text-brand-200"
          )}
        >
          Load sample dataset
        </button>
        <div className="space-y-2 text-xs text-slate-400">
          {sampleDataActive && (
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3 py-1 font-semibold text-emerald-200">
              ● Sample Data Active
            </span>
          )}
          <p>Default dataset: data/convo_quality_550.csv</p>
          {fileName && (
            <p className="truncate">
              Loaded file: <span className="text-slate-200">{fileName}</span>
            </p>
          )}
          {fileError && (
            <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-red-200">
              {fileError}
            </p>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-white">De-anonymize users/customers</span>
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={deAnonymize}
              onChange={(event) => onToggleDeAnonymize(event.target.checked)}
              className="peer sr-only"
            />
            <div className="h-6 w-10 rounded-full bg-slate-700 transition peer-checked:bg-brand-500" />
            <div className="absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-4" />
          </label>
        </div>
        <p className="text-xs text-slate-400">
          Enable to replace anonymized IDs using a lookup table with columns{" "}
          <code className="rounded bg-slate-800 px-1 py-px">user_id</code> and{" "}
          <code className="rounded bg-slate-800 px-1 py-px">display_name</code>.
        </p>
        <label
          className={clsx(
            "flex cursor-pointer items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition",
            deAnonymize
              ? "border-brand-500/50 bg-brand-500/20 text-brand-100 hover:bg-brand-500/40"
              : "cursor-not-allowed border-slate-800 bg-slate-900 text-slate-500"
          )}
        >
          <input
            ref={mappingInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            disabled={!deAnonymize}
            onChange={handleMappingChange}
          />
          Upload lookup CSV
        </label>
        <div className="text-xs text-slate-400">
          <p>
            {deAnonymize
              ? `${mappedCount} display name${mappedCount === 1 ? "" : "s"} mapped`
              : "Toggle on to activate display name replacement."}
          </p>
          <p className="mt-1">
            Optional lookup (only if you want real names):{" "}
            <code className="rounded bg-slate-800 px-1 py-px">local_data/user_lookup.csv</code>
          </p>
          {mappingError && (
            <p className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-red-200">
              {mappingError}
            </p>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm font-semibold text-white">Agent roles</span>
            <p className="text-xs text-slate-400">Tag Tier 1/Tier 2 agents for filtering and exports.</p>
          </div>
          <span className="text-xs uppercase tracking-wide text-slate-400">
            {assignedCount.toLocaleString()} tagged
          </span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-brand-500/40 bg-brand-500/15 px-4 py-2 text-sm font-semibold text-brand-100 transition hover:bg-brand-500/30">
            <input
              ref={roleInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleRolesChange}
            />
            Upload roles CSV
          </label>
          <p className="text-xs text-slate-400 sm:flex-1">
            Expected columns: <code className="rounded bg-slate-800 px-1 py-px">user_id</code> +
            <code className="ml-1 rounded bg-slate-800 px-1 py-px">port_role</code>. Use{" "}
            <span className="text-slate-200">data/port_roles.csv</span> for bulk updates.
          </p>
        </div>
        {roleUploadError && (
          <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {roleUploadError}
          </p>
        )}
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Search agents
          <input
            type="search"
            value={roleSearch}
            onChange={(event) => setRoleSearch(event.target.value)}
            placeholder="Start typing a display name or ID"
            className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          />
        </label>
        <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
          {agentEntries.length ? (
            agentEntries.map((entry) => (
              <div
                key={entry.agentId}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2"
                title={entry.title}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">{entry.label}</p>
                  <p className="truncate text-[11px] uppercase tracking-wide text-slate-500">{entry.agentId}</p>
                </div>
                <select
                  value={entry.role}
                  onChange={(event) => onRoleChange(entry.agentId, event.target.value as AgentRole)}
                  className="rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-1 text-xs font-semibold text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            ))
          ) : (
            <p className="rounded-xl border border-dashed border-slate-800 px-3 py-4 text-center text-xs text-slate-400">
              No agents to manage yet. Upload a dataset first.
            </p>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-xs text-slate-400">
        <h3 className="text-sm font-semibold text-white">Tips</h3>
        <ul className="mt-2 space-y-2">
          <li>
            Uploading new data clears the sample dataset and applies immediately across metrics and
            drilldowns.
          </li>
          <li>
            When de-anonymization is enabled, any IDs without a match remain visible in gray italics
            so you can spot missing lookup entries quickly.
          </li>
        </ul>
      </section>
    </aside>
  );
}
