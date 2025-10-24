import { ChangeEvent, useRef } from "react";
import clsx from "clsx";

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
};

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
  mappingError
}: CommandCenterPanelProps) {
  const conversationInputRef = useRef<HTMLInputElement | null>(null);
  const mappingInputRef = useRef<HTMLInputElement | null>(null);

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
            Recommended file: <code className="rounded bg-slate-800 px-1 py-px">local_data/user_lookup.csv</code>
          </p>
          {mappingError && (
            <p className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-red-200">
              {mappingError}
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
