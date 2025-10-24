import type { ChangeEvent } from "react";

import { SettingsState } from "@/types";

type SettingsDrawerProps = {
  open: boolean;
  settings: SettingsState;
  onClose: () => void;
  onChange: (next: SettingsState) => void;
};

export function SettingsDrawer({ open, settings, onClose, onChange }: SettingsDrawerProps) {
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
        <div className="space-y-6 px-6 py-6 text-sm text-slate-200">
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
