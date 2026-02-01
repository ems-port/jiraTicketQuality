import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { DEFAULT_CONTACT_TAXONOMY_ENTRIES } from "@/lib/defaultContactTaxonomy";
import { useDashboardStore } from "@/lib/useDashboardStore";
import type { ContactTaxonomyReason, ContactTaxonomyStatus, SettingsState } from "@/types";

const SETTING_FIELDS: Array<{
  key: keyof SettingsState;
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
}> = [
  {
    key: "toxicity_threshold",
    label: "Toxicity threshold",
    description: "Flag any mean toxicity score above this threshold.",
    min: 0,
    max: 1,
    step: 0.05
  },
  {
    key: "abusive_caps_trigger",
    label: "Abusive caps trigger",
    description: "Heuristic: number of all-caps words before a customer is flagged.",
    min: 1,
    max: 20,
    step: 1
  },
  {
    key: "min_msgs_for_toxicity",
    label: "Min messages for toxicity",
    description: "Heuristic: minimum agent messages before profanity ratio is considered.",
    min: 1,
    max: 50,
    step: 1
  }
];

export default function SettingsPage() {
  const settings = useDashboardStore((state) => state.settings);
  const setSettings = useDashboardStore((state) => state.setSettings);
  const debugLLM = useDashboardStore((state) => state.debugLLM);
  const setDebugLLM = useDashboardStore((state) => state.setDebugLLM);

  const [taxonomyReasons, setTaxonomyReasons] = useState<ContactTaxonomyReason[]>(DEFAULT_CONTACT_TAXONOMY_ENTRIES);
  const [taxonomyBaseline, setTaxonomyBaseline] = useState<ContactTaxonomyReason[] | null>(null);
  const [taxonomyMeta, setTaxonomyMeta] = useState<{ version: number; updated_at?: string | null; updated_by?: string | null }>({ version: 1 });
  const [taxonomySaving, setTaxonomySaving] = useState(false);
  const [taxonomyError, setTaxonomyError] = useState<string | null>(null);
  const [taxonomyLoading, setTaxonomyLoading] = useState(false);
  const [taxonomyStatus, setTaxonomyStatus] = useState<ContactTaxonomyStatus>("IN_USE");

  const labelsToReasons = useCallback(
    (labels: string[]): ContactTaxonomyReason[] =>
      labels
        .map((label) => {
          const value = label.trim();
          if (!value) return null;
          const [topic, ...rest] = value.split(" - ");
          const sub = rest.join(" - ").trim();
          return { topic: topic.trim(), sub_reason: sub || null, status: "IN_USE" };
        })
        .filter(Boolean) as ContactTaxonomyReason[],
    []
  );

  const normalizeReasons = useCallback((input: any): ContactTaxonomyReason[] => {
    if (!Array.isArray(input)) return [];
      return input
        .map((entry, index) => {
          if (typeof entry !== "object" || entry === null) return null;
          const topic = typeof entry.topic === "string" ? entry.topic.trim() : "";
          if (!topic) return null;
        const sub_reason =
          typeof entry.sub_reason === "string" && entry.sub_reason.trim().length
            ? entry.sub_reason.trim()
            : null;
        const description =
          typeof entry.description === "string" && entry.description.trim().length
            ? entry.description.trim()
            : null;
        const keywords =
          Array.isArray(entry.keywords) && entry.keywords.every((kw: unknown) => typeof kw === "string")
            ? entry.keywords.map((kw: string) => kw.trim()).filter(Boolean)
            : [];
        const statusRaw = typeof entry.status === "string" ? entry.status.trim().toUpperCase() : "IN_USE";
        const status: ContactTaxonomyStatus =
          statusRaw === "NEW" || statusRaw === "IN_USE" || statusRaw === "OBSOLETED" || statusRaw === "CANCELLED"
            ? (statusRaw as ContactTaxonomyStatus)
            : "IN_USE";
        return {
          topic,
          sub_reason,
          description,
          keywords,
          sort_order: typeof entry.sort_order === "number" ? entry.sort_order : index,
          status
        } satisfies ContactTaxonomyReason;
      })
      .filter(Boolean) as ContactTaxonomyReason[];
  }, []);

  const loadTaxonomy = useCallback(async () => {
    setTaxonomyLoading(true);
    setTaxonomyError(null);
    try {
      const taxonomyResponse = await fetch("/api/contact-taxonomy");
      if (taxonomyResponse.ok) {
        const taxonomyBody = await taxonomyResponse.json();
        const taxonomy = taxonomyBody?.taxonomy;
        if (taxonomy?.reasons && Array.isArray(taxonomy.reasons)) {
          const normalized = normalizeReasons(taxonomy.reasons);
          setTaxonomyReasons(normalized.length ? normalized : DEFAULT_CONTACT_TAXONOMY_ENTRIES);
          setTaxonomyBaseline(normalized.length ? normalized : DEFAULT_CONTACT_TAXONOMY_ENTRIES);
          setTaxonomyMeta({
            version: taxonomy.version ?? 1,
            updated_at: taxonomy.created_at ?? null,
            updated_by: taxonomy.created_by ?? null
          });
          if (typeof taxonomy.status === "string") {
            const status = taxonomy.status.toUpperCase();
            setTaxonomyStatus(
              status === "NEW" || status === "IN_USE" || status === "OBSOLETED" || status === "CANCELLED"
                ? (status as typeof taxonomyStatus)
                : "IN_USE"
            );
          }
        } else if (taxonomy?.labels && Array.isArray(taxonomy.labels)) {
          const fromLabels = labelsToReasons(
            taxonomy.labels.filter((label: unknown) => typeof label === "string" && label.trim().length > 0)
          );
          setTaxonomyReasons(fromLabels.length ? fromLabels : DEFAULT_CONTACT_TAXONOMY_ENTRIES);
          setTaxonomyBaseline(fromLabels.length ? fromLabels : DEFAULT_CONTACT_TAXONOMY_ENTRIES);
          setTaxonomyMeta({
            version: taxonomy.version ?? 1,
            updated_at: taxonomy.created_at ?? null,
            updated_by: taxonomy.created_by ?? null
          });
          if (typeof taxonomy.status === "string") {
            const status = taxonomy.status.toUpperCase();
            setTaxonomyStatus(
              status === "NEW" || status === "IN_USE" || status === "OBSOLETED" || status === "CANCELLED"
                ? (status as typeof taxonomyStatus)
                : "IN_USE"
            );
          }
        }
      } else {
        setTaxonomyReasons(DEFAULT_CONTACT_TAXONOMY_ENTRIES);
        setTaxonomyBaseline(DEFAULT_CONTACT_TAXONOMY_ENTRIES);
        setTaxonomyMeta({ version: 1 });
        setTaxonomyStatus("IN_USE");
      }
    } catch (error) {
      const message = (error as Error).message ?? "Unable to load project configuration.";
      setTaxonomyError(message);
    } finally {
      setTaxonomyLoading(false);
    }
  }, [labelsToReasons, normalizeReasons]);

  useEffect(() => {
    void loadTaxonomy();
  }, [loadTaxonomy]);

  const handleTaxonomyAddRow = useCallback(() => {
    setTaxonomyReasons((prev) => [
      ...prev,
      { topic: "", sub_reason: null, description: null, keywords: [], status: "NEW" }
    ]);
  }, []);

  const handleTaxonomyRemoveRow = useCallback((index: number) => {
    setTaxonomyReasons((prev) => prev.filter((_, idx) => idx !== index));
  }, []);

  const handleReasonFieldChange = useCallback(
    (index: number, field: keyof ContactTaxonomyReason, value: string) => {
      setTaxonomyReasons((prev) =>
        prev.map((reason, idx) => (idx === index ? { ...reason, [field]: value } : reason))
      );
    },
    []
  );

  const normalizeForSave = useCallback((reasons: ContactTaxonomyReason[]) => {
    return reasons
      .map((reason, idx) => ({
        topic: (reason.topic ?? "").trim(),
        sub_reason: (reason.sub_reason ?? "").trim() || null,
        description: (reason.description ?? "").trim() || null,
        keywords: Array.isArray(reason.keywords)
          ? reason.keywords.map((kw) => kw.trim()).filter(Boolean)
          : [],
        sort_order: idx,
        status: reason.status ?? "IN_USE"
      }))
      .filter((reason) => reason.topic.length > 0);
  }, []);

  const formatReasonLabel = useCallback((reason: ContactTaxonomyReason | undefined) => {
    if (!reason) return "Unknown reason";
    const topic = (reason.topic ?? "").trim();
    const sub = (reason.sub_reason ?? "").trim();
    return sub ? `${topic} - ${sub}` : topic || "Untitled reason";
  }, []);

  const handleTaxonomySave = useCallback(async (reasonsOverride?: ContactTaxonomyReason[], notes?: string, updateReasons = true) => {
    setTaxonomySaving(true);
    setTaxonomyError(null);
    try {
      const sourceReasons = reasonsOverride ?? taxonomyReasons;
      const cleaned = normalizeForSave(sourceReasons);
      if (!cleaned.length) {
        throw new Error("Provide at least one contact taxonomy topic.");
      }
      const response = await fetch("/api/contact-taxonomy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasons: cleaned, created_by: "settings_ui", status: taxonomyStatus, notes })
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Unable to save contact taxonomy.");
      }
      const body = await response.json();
      const entry = body.taxonomy;
      setTaxonomyMeta({
        version: entry?.version ?? taxonomyMeta.version ?? 1,
        updated_at: entry?.created_at ?? new Date().toISOString(),
        updated_by: entry?.created_by ?? "settings_ui"
      });
      if (typeof entry?.status === "string") {
        const status = entry.status.toUpperCase();
        setTaxonomyStatus(
          status === "NEW" || status === "IN_USE" || status === "OBSOLETED" || status === "CANCELLED"
            ? (status as ContactTaxonomyStatus)
            : taxonomyStatus
        );
      }
      setTaxonomyBaseline(cleaned);
      if (updateReasons) {
        setTaxonomyReasons(cleaned);
      }
    } catch (error) {
      setTaxonomyError((error as Error).message ?? "Unable to save contact taxonomy.");
    } finally {
      setTaxonomySaving(false);
    }
  }, [normalizeForSave, taxonomyReasons, taxonomyMeta, taxonomyStatus]);

  const buildRowSaveReasons = useCallback(
    (index: number) => {
      if (!taxonomyBaseline || taxonomyBaseline.length !== taxonomyReasons.length) {
        return taxonomyReasons;
      }
      return taxonomyBaseline.map((reason, idx) => (idx === index ? taxonomyReasons[idx] : reason));
    },
    [taxonomyBaseline, taxonomyReasons]
  );

  const buildRowChangeNote = useCallback(
    (index: number) => {
      const current = taxonomyReasons[index];
      if (!current) return "Row update";
      const previous = taxonomyBaseline?.[index];
      const label = formatReasonLabel(current);
      if (!previous) {
        return `Row update: ${label} | added`;
      }
      const changes: string[] = [];
      const prevTopic = (previous.topic ?? "").trim();
      const nextTopic = (current.topic ?? "").trim();
      if (prevTopic !== nextTopic) {
        changes.push(`topic: "${prevTopic}" -> "${nextTopic}"`);
      }
      const prevSub = (previous.sub_reason ?? "").trim();
      const nextSub = (current.sub_reason ?? "").trim();
      if (prevSub !== nextSub) {
        changes.push(`sub_reason: "${prevSub}" -> "${nextSub}"`);
      }
      const prevDesc = (previous.description ?? "").trim();
      const nextDesc = (current.description ?? "").trim();
      if (prevDesc !== nextDesc) {
        changes.push(`description: "${prevDesc}" -> "${nextDesc}"`);
      }
      const prevKeywords = Array.isArray(previous.keywords) ? previous.keywords.join(", ") : "";
      const nextKeywords = Array.isArray(current.keywords) ? current.keywords.join(", ") : "";
      if (prevKeywords !== nextKeywords) {
        changes.push(`keywords: "${prevKeywords}" -> "${nextKeywords}"`);
      }
      const prevStatus = previous.status ?? "IN_USE";
      const nextStatus = current.status ?? "IN_USE";
      if (prevStatus !== nextStatus) {
        changes.push(`status: "${prevStatus}" -> "${nextStatus}"`);
      }
      if (!changes.length) {
        return `Row save: ${label}`;
      }
      return `Row update: ${label} | ${changes.join("; ")}`;
    },
    [formatReasonLabel, taxonomyBaseline, taxonomyReasons]
  );

  const buildBulkChangeNote = useCallback(() => {
    if (!taxonomyBaseline) {
      return "Bulk update from settings UI";
    }
    const lines: string[] = [];
    const maxRows = Math.max(taxonomyBaseline.length, taxonomyReasons.length);
    for (let idx = 0; idx < maxRows; idx += 1) {
      const previous = taxonomyBaseline[idx];
      const current = taxonomyReasons[idx];
      if (!previous && current) {
        lines.push(`Row added: ${formatReasonLabel(current)}`);
        continue;
      }
      if (previous && !current) {
        lines.push(`Row removed: ${formatReasonLabel(previous)}`);
        continue;
      }
      if (!previous || !current) continue;
      const rowNote = buildRowChangeNote(idx);
      if (rowNote && !rowNote.startsWith("Row save")) {
        lines.push(rowNote);
      }
    }
    if (!lines.length) {
      return "Bulk update from settings UI";
    }
    return lines.join(" | ");
  }, [buildRowChangeNote, formatReasonLabel, taxonomyBaseline, taxonomyReasons]);

  const handleTaxonomySaveAll = useCallback(() => {
    const notes = buildBulkChangeNote();
    return handleTaxonomySave(undefined, notes);
  }, [buildBulkChangeNote, handleTaxonomySave]);

  const handleTaxonomySaveRow = useCallback(
    (index: number) => {
      const rowReasons = buildRowSaveReasons(index);
      const notes = buildRowChangeNote(index);
      return handleTaxonomySave(rowReasons, notes, false);
    },
    [buildRowChangeNote, buildRowSaveReasons, handleTaxonomySave]
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/80 px-6 py-4 backdrop-blur">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Project settings</p>
            <h1 className="text-2xl font-bold text-white">Configuration</h1>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-brand-500 hover:text-brand-200"
            >
              Back to dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-6">
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">LLM Debug mode</h2>
              <p className="text-xs text-slate-400">
                When enabled, processing will print LLM prompts/responses to the terminal via --debug/--debug-prompts.
              </p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                checked={debugLLM}
                onChange={(event) => setDebugLLM(event.target.checked)}
                className="peer sr-only"
              />
              <div className="h-6 w-10 rounded-full bg-slate-700 transition peer-checked:bg-emerald-500" />
              <div className="absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-4" />
            </label>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Heuristic thresholds</h2>
              <p className="text-xs text-slate-400">Adjust scoring heuristics used in the dashboard.</p>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {SETTING_FIELDS.map((field) => (
              <label key={field.key} className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                <div>
                  <p className="text-sm font-semibold text-white">{field.label}</p>
                  <p className="text-xs text-slate-400">{field.description}</p>
                </div>
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={settings[field.key]}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      [field.key]: Number.isFinite(Number(event.target.value))
                        ? Number(event.target.value)
                        : settings[field.key]
                    })
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                />
              </label>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Prompt builder</h2>
              <p className="text-xs text-slate-400">
                Edit and test all prompt configurations on a dedicated page.
              </p>
            </div>
            <Link
              href="/settings/prompt-builder"
              className="inline-flex items-center justify-center rounded-lg border border-brand-500/60 px-3 py-2 text-sm font-semibold text-brand-100 transition hover:bg-brand-500/10"
            >
              Open prompt builder
            </Link>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Contact taxonomy</h2>
              <p className="text-xs text-slate-400">Manage contact reason topics, optional sub-reasons, descriptions, and keywords.</p>
            </div>
            <div className="flex items-center gap-3">
              <select
                value={taxonomyStatus}
                onChange={(event) =>
                  setTaxonomyStatus(event.target.value as ContactTaxonomyStatus)
                }
                className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              >
                <option value="NEW">NEW</option>
                <option value="IN_USE">IN_USE</option>
                <option value="OBSOLETED">OBSOLETED</option>
                <option value="CANCELLED">CANCELLED</option>
              </select>
              <button
                type="button"
                onClick={handleTaxonomyAddRow}
                className="rounded-lg border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:border-brand-500 hover:text-brand-200"
              >
                Add row
              </button>
              <button
                type="button"
                onClick={handleTaxonomySaveAll}
                disabled={taxonomySaving}
                className="rounded-lg border border-brand-500/60 px-3 py-1 text-xs font-semibold text-brand-100 transition hover:bg-brand-500/10 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
              >
                {taxonomySaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
          {taxonomyError && (
            <p className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {taxonomyError}
            </p>
          )}
          <div className="rounded-lg border border-slate-800">
            <div className="grid grid-cols-[1.1fr,1fr,1.3fr,1fr,0.7fr,auto] items-center gap-2 border-b border-slate-800 bg-slate-900/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <span>Topic</span>
              <span>Sub-reason</span>
              <span>Description (when to use)</span>
              <span>Keywords (comma separated)</span>
              <span>Status</span>
              <span>Actions</span>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              {taxonomyReasons.map((reason, index) => (
                <div
                  key={`${reason.topic}-${index}`}
                  className="grid grid-cols-[1.1fr,1fr,1.3fr,1fr,0.7fr,auto] items-center gap-2 border-b border-slate-900/50 px-3 py-2"
                >
                  <input
                    type="text"
                    value={reason.topic}
                    onChange={(event) => handleReasonFieldChange(index, "topic", event.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950/70 px-2 py-1 text-sm text-white focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                  />
                  <input
                    type="text"
                    value={reason.sub_reason ?? ""}
                    onChange={(event) => handleReasonFieldChange(index, "sub_reason", event.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950/70 px-2 py-1 text-sm text-white focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                    placeholder="Optional sub-reason"
                  />
                  <textarea
                    value={reason.description ?? ""}
                    onChange={(event) => handleReasonFieldChange(index, "description", event.target.value)}
                    onInput={(event) => {
                      const target = event.currentTarget;
                      target.style.height = "auto";
                      target.style.height = `${target.scrollHeight}px`;
                    }}
                    ref={(element) => {
                      if (!element) return;
                      element.style.height = "auto";
                      element.style.height = `${element.scrollHeight}px`;
                    }}
                    rows={2}
                    className="w-full min-h-[44px] resize-none rounded-lg border border-slate-700 bg-slate-950/70 px-2 py-1 text-sm text-white focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                    placeholder="When to use this reason"
                  />
                  <input
                    type="text"
                    value={(reason.keywords ?? []).join(", ")}
                    onChange={(event) =>
                      setTaxonomyReasons((prev) =>
                        prev.map((item, idx) =>
                          idx === index
                            ? {
                                ...item,
                                keywords: event.target.value
                                  .split(",")
                                  .map((kw) => kw.trim())
                                  .filter(Boolean)
                              }
                            : item
                        )
                      )
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950/70 px-2 py-1 text-sm text-white focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                    placeholder="bike, payment, subscription"
                  />
                  <select
                    value={reason.status ?? "IN_USE"}
                    onChange={(event) => handleReasonFieldChange(index, "status", event.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                  >
                    <option value="NEW">NEW</option>
                    <option value="IN_USE">IN_USE</option>
                    <option value="OBSOLETED">OBSOLETED</option>
                    <option value="CANCELLED">CANCELLED</option>
                  </select>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleTaxonomySaveRow(index)}
                      disabled={taxonomySaving || !(reason.topic ?? "").trim()}
                      className="rounded-lg border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-200 transition hover:border-brand-500 hover:text-brand-200 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => handleTaxonomyRemoveRow(index)}
                      className="rounded-lg border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-300 transition hover:border-red-500 hover:text-red-200"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              {taxonomyLoading && (
                <div className="px-3 py-2 text-xs text-slate-400">Loading taxonomy…</div>
              )}
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
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
        </section>
      </main>
    </div>
  );
}
