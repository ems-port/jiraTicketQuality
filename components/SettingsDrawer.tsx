import Link from "next/link";
import type { ChangeEvent } from "react";

import { PROJECT_PROMPT_TYPES, PromptConfigType } from "@/lib/defaultProjectConfig";
import { SettingsState } from "@/types";

type SettingsDrawerProps = {
  open: boolean;
  settings: SettingsState;
  onClose: () => void;
  onChange: (next: SettingsState) => void;
  useOnlineData: boolean;
  onToggleDataSource: (value: boolean) => void;
  promptConfigs: Record<PromptConfigType, string>;
  onPromptChange: (type: PromptConfigType, value: string) => void;
  onPromptSave: (type: PromptConfigType) => Promise<void> | void;
  promptConfigSaving: PromptConfigType | null;
  promptConfigError: string | null;
  promptConfigLoading: boolean;
  promptConfigMeta: Record<PromptConfigType, { version: number; updated_at?: string | null; updated_by?: string | null }>;
  onReloadConfigs: () => void;
  taxonomyLabels: string[];
  taxonomyMeta: { version: number; updated_at?: string | null; updated_by?: string | null };
  taxonomySaving: boolean;
  taxonomyError: string | null;
  taxonomyLoading: boolean;
  taxonomyStatus: "NEW" | "IN_USE" | "OBSOLETED" | "CANCELLED";
  onTaxonomyChange: (index: number, value: string) => void;
  onTaxonomyAddRow: () => void;
  onTaxonomyRemoveRow: (index: number) => void;
  onTaxonomySave: () => void;
  onTaxonomyStatusChange: (status: "NEW" | "IN_USE" | "OBSOLETED" | "CANCELLED") => void;
};

export function SettingsDrawer({
  open,
  settings,
  onClose,
  onChange,
  useOnlineData,
  onToggleDataSource,
  promptConfigs,
  onPromptChange,
  onPromptSave,
  promptConfigSaving,
  promptConfigError,
  promptConfigLoading,
  promptConfigMeta,
  onReloadConfigs,
  taxonomyLabels,
  taxonomyMeta,
  taxonomySaving,
  taxonomyError,
  taxonomyLoading,
  taxonomyStatus,
  onTaxonomyChange,
  onTaxonomyAddRow,
  onTaxonomyRemoveRow,
  onTaxonomySave,
  onTaxonomyStatusChange
}: SettingsDrawerProps) {
  if (!open) {
    return null;
  }

  const handleNumberChange =
    (key: keyof SettingsState) => (event: ChangeEvent<HTMLInputElement>) => {
      const value = Number(event.target.value);
      onChange({
        ...settings,
        [key]: Number.isFinite(value) ? value : settings[key]
      });
    };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/80 backdrop-blur">
      <aside className="h-full w-full max-w-md border-l border-slate-800 bg-slate-950/95 shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-800 px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold text-white">Settings</h2>
            <p className="text-xs text-slate-400">
              Update thresholds for toxicity detection heuristics.
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
        <div className="flex items-center justify-between border-b border-slate-900/60 px-6 py-4 text-xs">
          <p className="text-slate-400">Need to review recent updates?</p>
          <Link
            href="/changelog"
            className="rounded-full border border-brand-500/60 px-3 py-1 text-[11px] font-semibold text-brand-100 transition hover:bg-brand-500/10"
          >
            View change log
          </Link>
        </div>
        <div className="space-y-6 px-6 py-6 text-sm text-slate-200">
          <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-white">Data source</p>
              <p className="text-xs text-slate-400">
                Switch between local CSV uploads and the future online DB connector.
              </p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={useOnlineData}
                onChange={(event) => onToggleDataSource(event.target.checked)}
              />
              <div className="h-6 w-10 rounded-full bg-slate-700 transition peer-checked:bg-amber-500" />
              <div className="absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-4" />
            </label>
          </div>
          <SettingField
            label="Toxicity threshold"
            description="Flag any mean toxicity score above this threshold."
            value={settings.toxicity_threshold}
            min={0}
            max={1}
            step={0.05}
            onChange={handleNumberChange("toxicity_threshold")}
          />
          <SettingField
            label="Abusive caps trigger"
            description="Heuristic: number of all-caps words before a customer is flagged."
            value={settings.abusive_caps_trigger}
            min={1}
            max={20}
            step={1}
            onChange={handleNumberChange("abusive_caps_trigger")}
          />
          <SettingField
            label="Min messages for toxicity"
            description="Heuristic: minimum agent messages before profanity ratio is considered."
            value={settings.min_msgs_for_toxicity}
            min={1}
            max={50}
            step={1}
            onChange={handleNumberChange("min_msgs_for_toxicity")}
          />
          <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-white">Project configurations</p>
                <p className="text-xs text-slate-400">
                  Edit the prompts used for scoring and instructions. Changes publish to Supabase.
                </p>
              </div>
              <button
                type="button"
                onClick={onReloadConfigs}
                disabled={promptConfigLoading}
                className="rounded-lg border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:border-brand-500 hover:text-brand-200 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
              >
                {promptConfigLoading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            {promptConfigError && (
              <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                {promptConfigError}
              </p>
            )}
            <div className="space-y-3">
              {PROJECT_PROMPT_TYPES.map((type) => (
                <PromptEditor
                  key={type}
                  type={type}
                  value={promptConfigs[type]}
                  meta={promptConfigMeta[type]}
                  saving={promptConfigSaving === type}
                  onChange={(value) => onPromptChange(type, value)}
                  onSave={() => onPromptSave(type)}
                />
              ))}
            </div>
          </div>
          <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-white">Contact taxonomy</p>
                  <p className="text-xs text-slate-400">
                    Manage the list of contact reason labels used in scoring.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-400">
                    Status
                    <select
                      className="ml-2 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                      value={taxonomyStatus}
                      onChange={(event) =>
                        onTaxonomyStatusChange(event.target.value as "NEW" | "IN_USE" | "OBSOLETED" | "CANCELLED")
                      }
                    >
                      <option value="NEW">NEW</option>
                      <option value="IN_USE">IN_USE</option>
                      <option value="OBSOLETED">OBSOLETED</option>
                      <option value="CANCELLED">CANCELLED</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={onTaxonomyAddRow}
                    className="rounded-lg border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:border-brand-500 hover:text-brand-200"
                  >
                    Add row
                  </button>
                  <button
                    type="button"
                    onClick={onTaxonomySave}
                    disabled={taxonomySaving}
                    className="rounded-lg border border-brand-500/60 px-3 py-1 text-xs font-semibold text-brand-100 transition hover:bg-brand-500/10 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
                  >
                    {taxonomySaving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            {taxonomyError && (
              <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                {taxonomyError}
              </p>
            )}
            <div className="rounded-lg border border-slate-800">
              <div className="grid grid-cols-[1fr_auto] items-center gap-2 border-b border-slate-800 bg-slate-900/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                <span>Label</span>
                <span>Actions</span>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {taxonomyLabels.map((label, index) => (
                  <div
                    key={`${label}-${index}`}
                    className="grid grid-cols-[1fr_auto] items-center gap-2 border-b border-slate-900/50 px-3 py-2"
                  >
                    <input
                      type="text"
                      value={label}
                      onChange={(event) => onTaxonomyChange(index, event.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950/70 px-2 py-1 text-sm text-white focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                    />
                    <button
                      type="button"
                      onClick={() => onTaxonomyRemoveRow(index)}
                      className="rounded-lg border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-300 transition hover:border-red-500 hover:text-red-200"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {taxonomyLoading && (
                  <div className="px-3 py-2 text-xs text-slate-400">Loading taxonomy…</div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                v{taxonomyMeta?.version ?? 1} · {taxonomyStatus}
              </span>
              {taxonomyMeta?.updated_at && (
                <span>
                  Updated {new Date(taxonomyMeta.updated_at).toLocaleString()}
                  {taxonomyMeta?.updated_by ? ` by ${taxonomyMeta.updated_by}` : ""}
                </span>
              )}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

type SettingFieldProps = {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

function SettingField({ label, description, value, min, max, step, onChange }: SettingFieldProps) {
  return (
    <label className="flex flex-col gap-2">
      <div>
        <p className="text-sm font-semibold text-white">{label}</p>
        <p className="text-xs text-slate-400">{description}</p>
      </div>
      <input
        type="number"
        className="w-full rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onChange}
      />
    </label>
  );
}

type PromptEditorProps = {
  type: PromptConfigType;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  saving: boolean;
  meta?: { version?: number; updated_at?: string | null; updated_by?: string | null };
};

const PROMPT_LABELS: Record<PromptConfigType, { title: string; description: string }> = {
  system_prompt: {
    title: "System prompt",
    description: "High-level identity and output contract for the model."
  },
  prompt_header: {
    title: "Prompt header",
    description: "Intro text shown before the schema and tasks."
  },
  prompt_json_schema: {
    title: "Prompt JSON schema",
    description: "Structured schema for the model response."
  },
  task_sequence: {
    title: "Task sequence",
    description: "Ordered steps the model must follow for each conversation."
  },
  additional_instructions: {
    title: "Additional instructions",
    description: "Tone, formatting, and validation reminders."
  },
  conversation_rating: {
    title: "Conversation rating",
    description: "Scoring rubric for conversation_rating."
  },
  agent_score: {
    title: "Agent score",
    description: "Scoring rubric for agent_score."
  },
  customer_score: {
    title: "Customer score",
    description: "Scoring rubric for customer_score."
  }
};

function PromptEditor({ type, value, onChange, onSave, saving, meta }: PromptEditorProps) {
  const labels = PROMPT_LABELS[type];
  const updatedAt = meta?.updated_at ? new Date(meta.updated_at).toLocaleString() : null;
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-white">{labels.title}</p>
          <p className="text-xs text-slate-400">{labels.description}</p>
        </div>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="rounded-lg border border-brand-500/60 px-3 py-1 text-xs font-semibold text-brand-100 transition hover:bg-brand-500/10 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <textarea
        className="mt-3 h-40 w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
        <span>v{meta?.version ?? 1}</span>
        {updatedAt && (
          <span>
            Updated {updatedAt}
            {meta?.updated_by ? ` by ${meta.updated_by}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}
