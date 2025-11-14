import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";

import { formatRoleLabel } from "@/lib/roles";
import type { AgentDirectoryEntry, AgentRole, AgentSaveState } from "@/types";

type CommandCenterPanelProps = {
  onUploadConversations: (file: File) => void;
  onLoadSampleData: () => void | Promise<void>;
  sampleDataActive: boolean;
  fileName: string | null;
  fileError: string | null;
  deAnonymize: boolean;
  onToggleDeAnonymize: (value: boolean) => void;
  customerMappingCount: number;
  conversationCount: number;
  mappingError: string | null;
  onUploadCustomerMapping: (file: File) => void;
  onClearCustomerMapping: () => void;
  agentEntries: AgentDirectoryEntry[];
  onAgentSave: (agentId: string, payload: { displayName: string; role: AgentRole }) => void;
  agentSaveState: Record<string, AgentSaveState>;
  agentDirectoryError: string | null;
  usingOnlineData: boolean;
  refreshStage: "idle" | "ingesting" | "processing" | "completed" | "error";
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
  customerMappingCount,
  conversationCount,
  mappingError,
  onUploadCustomerMapping,
  onClearCustomerMapping,
  agentEntries,
  onAgentSave,
  agentSaveState,
  agentDirectoryError,
  usingOnlineData,
  refreshStage
}: CommandCenterPanelProps) {
  const conversationInputRef = useRef<HTMLInputElement | null>(null);
  const customerInputRef = useRef<HTMLInputElement | null>(null);
  const [roleSearch, setRoleSearch] = useState("");

  const filteredAgents = useMemo(() => {
    const search = roleSearch.trim().toLowerCase();
    return agentEntries
      .filter((entry) => {
        if (!search) {
          return true;
        }
        const label = entry.displayName.toLowerCase();
        return label.includes(search) || entry.agentId.toLowerCase().includes(search);
      })
      .sort((a, b) => {
        const aLabel = (a.displayName || a.agentId).toLowerCase();
        const bLabel = (b.displayName || b.agentId).toLowerCase();
        return aLabel.localeCompare(bLabel);
      });
  }, [agentEntries, roleSearch]);

  const assignedCount = agentEntries.filter((entry) => entry.role !== "NON_AGENT").length;

  const handleConversationChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      onUploadConversations(file);
      // Reset the input so the same file can be uploaded again.
      event.target.value = "";
    }
  };

  const handleCustomerUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      onUploadCustomerMapping(file);
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
        <label
          className={clsx(
            "flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition",
           usingOnlineData
              ? "cursor-not-allowed border border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
              : "cursor-pointer border border-brand-500/50 bg-brand-500/20 text-brand-100 hover:bg-brand-500/40"
          )}
        >
          <input
            ref={conversationInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleConversationChange}
            disabled={usingOnlineData}
          />
          {usingOnlineData ? "Online DB" : "Upload CSV"}
        </label>
        <button
          type="button"
          onClick={() => {
            void onLoadSampleData();
          }}
          disabled={usingOnlineData}
          className={clsx(
            "rounded-xl px-4 py-2 text-sm font-semibold transition",
            usingOnlineData
              ? "cursor-not-allowed border border-slate-800 text-slate-500"
              : sampleDataActive
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
          <p>Default dataset: data/convo_quality_Nov_5-mini.csv</p>
          {usingOnlineData && (
            <span
              className={clsx(
                "inline-flex items-center gap-2 rounded-full px-3 py-1 font-semibold",
                refreshStage === "ingesting" || refreshStage === "processing"
                  ? "border border-amber-400/50 bg-amber-400/10 text-amber-200"
                  : "border border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
              )}
            >
              {refreshStage === "ingesting" || refreshStage === "processing" ? "● Online DB syncing" : "● Online DB active"}
            </span>
          )}
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
          Agent names load automatically from <code className="rounded bg-slate-800 px-1 py-px">data/port_roles.csv</code>.
          Upload a customer lookup CSV (columns <code className="rounded bg-slate-800 px-1 py-px">user_id</code> +
          <code className="ml-1 rounded bg-slate-800 px-1 py-px">display_name</code>) whenever you want to reveal frequent riders.
        </p>
        <div className="text-xs text-slate-400">
          <p>
            {deAnonymize
              ? `${customerMappingCount.toLocaleString()} customer lookup${customerMappingCount === 1 ? "" : "s"} active`
              : "Toggle on to activate display name replacement."}
          </p>
          <p className="mt-1">
            Optional lookup file path:{" "}
            <code className="rounded bg-slate-800 px-1 py-px">local_data/user_lookup.csv</code>
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label
            className={clsx(
              "flex cursor-pointer items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition",
              deAnonymize
                ? "border-brand-500/40 bg-brand-500/15 text-brand-100 hover:bg-brand-500/30"
                : "cursor-not-allowed border-slate-800 bg-slate-900 text-slate-500"
            )}
          >
            <input
              ref={customerInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              disabled={!deAnonymize}
              onChange={handleCustomerUpload}
            />
            Upload customer lookup CSV
          </label>
          <button
            type="button"
            onClick={onClearCustomerMapping}
            disabled={!customerMappingCount}
            className={clsx(
              "rounded-xl px-4 py-2 text-sm font-semibold transition",
              customerMappingCount
                ? "border border-slate-800 bg-slate-900/70 text-slate-100 hover:border-brand-500 hover:text-brand-200"
                : "cursor-not-allowed border border-slate-800 bg-slate-900/50 text-slate-500"
            )}
          >
            Clear customer lookup
          </button>
        </div>
        {mappingError && (
          <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {mappingError}
          </p>
        )}
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
        {agentDirectoryError && (
          <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {agentDirectoryError}
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
        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {filteredAgents.length ? (
            filteredAgents.map((entry) => (
              <AgentRow
                key={entry.agentId}
                entry={entry}
                onSave={onAgentSave}
                status={agentSaveState[entry.agentId] ?? "idle"}
              />
            ))
          ) : (
            <p className="rounded-xl border border-dashed border-slate-800 px-3 py-4 text-center text-xs text-slate-400">
              No agents to manage yet. Upload a dataset first.
            </p>
          )}
        </div>
        <AddAgentCard onSave={onAgentSave} />
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

type AgentRowProps = {
  entry: AgentDirectoryEntry;
  onSave: (agentId: string, payload: { displayName: string; role: AgentRole }) => void;
  status: AgentSaveState;
};

function AgentRow({ entry, onSave, status }: AgentRowProps) {
  const [name, setName] = useState(entry.displayName);
  const [role, setRole] = useState<AgentRole>(entry.role);

  useEffect(() => {
    setName(entry.displayName);
  }, [entry.displayName]);

  useEffect(() => {
    setRole(entry.role);
  }, [entry.role]);

  const trimmedName = name.trim();
  const dirty = trimmedName !== entry.displayName.trim() || role !== entry.role;
  const saving = status === "saving";
  const saveDisabled = saving || !dirty || !trimmedName.length;

  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2"
      title={`Agent ID: ${entry.agentId}`}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Display name"
            className="w-full rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-sm text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          />
          <p className="truncate text-[11px] uppercase tracking-wide text-slate-500">{entry.agentId}</p>
        </div>
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as AgentRole)}
          className="rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-1 text-xs font-semibold text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
        >
          {ROLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center justify-between text-xs">
        <button
          type="button"
          disabled={saveDisabled}
          onClick={() => onSave(entry.agentId, { displayName: trimmedName, role })}
          className={clsx(
            "rounded-lg px-3 py-1 font-semibold transition",
            saveDisabled
              ? "cursor-not-allowed border border-slate-800 text-slate-500"
              : "border border-brand-500/60 bg-brand-500/10 text-brand-100 hover:bg-brand-500/30"
          )}
        >
          {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        <span
          className={clsx(
            "text-[11px]",
            status === "saved" && "text-emerald-200",
            status === "error" && "text-red-300",
            status === "idle" && "text-slate-500"
          )}
        >
          {status === "saving" && "Persisting to port_roles.csv…"}
          {status === "saved" && "Saved"}
          {status === "error" && "Unable to save"}
          {status === "idle" && (!entry.displayName ? "Name missing" : "Ready")}
        </span>
      </div>
    </div>
  );
}

type AddAgentCardProps = {
  onSave: (agentId: string, payload: { displayName: string; role: AgentRole }) => void;
};

function AddAgentCard({ onSave }: AddAgentCardProps) {
  const [agentId, setAgentId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<AgentRole>("NON_AGENT");
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    const id = agentId.trim();
    const name = displayName.trim();
    if (!id) {
      setError("Agent ID required.");
      return;
    }
    if (!name) {
      setError("Display name required.");
      return;
    }
    setError(null);
    onSave(id, { displayName: name, role });
    setAgentId("");
    setDisplayName("");
    setRole("NON_AGENT");
  };

  return (
    <div className="rounded-xl border border-dashed border-slate-800 bg-slate-950/30 px-3 py-3 text-xs text-slate-400">
      <p className="text-sm font-semibold text-slate-100">Add new agent</p>
      <div className="mt-2 flex flex-col gap-2">
        <input
          type="text"
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
          placeholder="Agent ID"
          className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
        />
        <input
          type="text"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Display name"
          className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
        />
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as AgentRole)}
          className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm font-semibold text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
        >
          {ROLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleAdd}
          className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/30"
        >
          Save to port_roles.csv
        </button>
        {error && <p className="text-red-300">{error}</p>}
      </div>
    </div>
  );
}
