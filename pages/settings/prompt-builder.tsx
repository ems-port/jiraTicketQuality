import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { DEFAULT_PROJECT_CONFIG, PROJECT_PROMPT_TYPES, PromptConfigType } from "@/lib/defaultProjectConfig";
import { DEFAULT_CONTACT_TAXONOMY_ENTRIES } from "@/lib/defaultContactTaxonomy";
import { useDashboardStore } from "@/lib/useDashboardStore";

const SYSTEM_PROMPT =
  "You are a meticulous quality assurance analyst who responds in JSON. Conversation transcript lines use 'A:' for agent and 'C:' for customer to optimise tokens.";

const PROMPT_LABELS: Record<PromptConfigType, string> = {
  system_prompt: "System prompt",
  prompt_header: "Prompt header",
  prompt_json_schema: "JSON schema block",
  task_sequence: "Task sequence",
  additional_instructions: "Additional instructions",
  conversation_rating: "Conversation rating rubric",
  agent_score: "Agent score rubric",
  customer_score: "Customer score rubric"
};

const CODE_BLOCK_REGEX = /```(?:json)?\s*([\s\S]*?)```/i;

const renderValue = (value: any) => {
  if (value === null || value === undefined) {
    return <span className="text-slate-400">—</span>;
  }
  if (typeof value === "boolean") {
    return <span className="font-semibold text-slate-100">{value ? "True" : "False"}</span>;
  }
  if (typeof value === "number" || typeof value === "string") {
    return <span className="text-slate-100">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-slate-400">None</span>;
    return (
      <ul className="list-disc space-y-1 pl-4 text-slate-100">
        {value.map((item, idx) => (
          <li key={idx} className="break-words text-sm text-slate-100">
            {typeof item === "object" ? JSON.stringify(item, null, 2) : String(item)}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded border border-slate-800 bg-slate-950/70 p-2 text-[11px] text-slate-100">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
};

const ParsedJsonGrid = ({ data }: { data: Record<string, any> }) => {
  const entries = Object.entries(data);
  if (!entries.length) return null;
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {entries.map(([key, value]) => (
        <div key={key} className="rounded-lg border border-slate-800 bg-slate-950/80 p-3">
          <p className="text-[11px] uppercase tracking-wide text-slate-400">{key}</p>
          <div className="mt-1 text-sm">{renderValue(value)}</div>
        </div>
      ))}
    </div>
  );
};

const extractJsonPayload = (content: string): any | null => {
  if (!content) return null;
  const candidates: string[] = [];
  const trimmed = content.trim();
  if (trimmed) {
    candidates.push(trimmed);
    const codeMatch = CODE_BLOCK_REGEX.exec(trimmed);
    if (codeMatch?.[1]) {
      candidates.push(codeMatch[1].trim());
    }
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        const slice = candidate.slice(start, end + 1);
        try {
          return JSON.parse(slice);
        } catch {
          // keep trying next candidate
        }
      }
    }
  }
  return null;
};

export default function PromptBuilderPage() {
  const debugLLM = useDashboardStore((state) => state.debugLLM);
  const [promptConfigs, setPromptConfigs] = useState<Record<PromptConfigType, string>>(() =>
    PROJECT_PROMPT_TYPES.reduce(
      (acc, type) => ({ ...acc, [type]: DEFAULT_PROJECT_CONFIG[type] }),
      {} as Record<PromptConfigType, string>
    )
  );
  const [promptConfigMeta, setPromptConfigMeta] = useState<
    Record<PromptConfigType, { version: number; updated_at?: string | null; updated_by?: string | null }>
  >(() =>
    PROJECT_PROMPT_TYPES.reduce(
      (acc, type) => ({
        ...acc,
        [type]: { version: 1, updated_at: null, updated_by: null }
      }),
      {} as Record<PromptConfigType, { version: number; updated_at?: string | null; updated_by?: string | null }>
    )
  );
  const [promptConfigError, setPromptConfigError] = useState<string | null>(null);
  const [promptConfigLoading, setPromptConfigLoading] = useState(false);
  const [savingPromptType, setSavingPromptType] = useState<PromptConfigType | null>(null);

  const [conversationContext, setConversationContext] = useState("");
  const [testModel, setTestModel] = useState("");
  const [testResult, setTestResult] = useState<string>("");
  const [testPretty, setTestPretty] = useState<string>("");
  const [testParsed, setTestParsed] = useState<Record<string, any> | null>(null);
  const [testRaw, setTestRaw] = useState<string>("");
  const [testError, setTestError] = useState<string | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [taxonomyReasons, setTaxonomyReasons] = useState(DEFAULT_CONTACT_TAXONOMY_ENTRIES);
  const [preparedOptions, setPreparedOptions] = useState<
    { issue_key: string; prepared_at?: string | null; payload: any; contextText: string }[]
  >([]);
  const [selectedPrepared, setSelectedPrepared] = useState<string>("");
  const [preparedInitialized, setPreparedInitialized] = useState(false);

  const handlePromptChange = useCallback((type: PromptConfigType, value: string) => {
    setPromptConfigs((prev) => ({ ...prev, [type]: value }));
  }, []);

  const handlePromptSave = useCallback(
    async (type: PromptConfigType) => {
      setSavingPromptType(type);
      setPromptConfigError(null);
      try {
        const response = await fetch("/api/project-config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, payload: promptConfigs[type], updated_by: "prompt_builder" })
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || "Unable to save project configuration.");
        }
        const body = await response.json();
        const entry = body.entry;
        setPromptConfigMeta((prev) => ({
          ...prev,
          [type]: {
            version: entry?.version ?? (prev[type]?.version ?? 1),
            updated_at: entry?.updated_at ?? new Date().toISOString(),
            updated_by: entry?.updated_by ?? "prompt_builder"
          }
        }));
      } catch (error) {
        setPromptConfigError((error as Error).message ?? "Unable to save project configuration.");
      } finally {
        setSavingPromptType(null);
      }
    },
    [promptConfigs]
  );

  const loadPromptConfigs = useCallback(async () => {
    setPromptConfigLoading(true);
    setPromptConfigError(null);
    try {
      const promptResponse = await fetch(`/api/project-config?types=${PROJECT_PROMPT_TYPES.join(",")}`);
      if (!promptResponse.ok) {
        throw new Error(`Failed to load project configs (${promptResponse.status})`);
      }
      const promptBody = await promptResponse.json();
      const entries = Array.isArray(promptBody.entries) ? promptBody.entries : [];
      setPromptConfigs((prev) => {
        const next = { ...prev };
        PROJECT_PROMPT_TYPES.forEach((type) => {
          const entry = entries.find((item: any) => item?.type === type);
          if (entry && typeof entry.payload === "string") {
            next[type] = entry.payload;
          } else if (!next[type]) {
            next[type] = DEFAULT_PROJECT_CONFIG[type];
          }
        });
        return next;
      });
      setPromptConfigMeta((prev) => {
        const meta = { ...prev };
        PROJECT_PROMPT_TYPES.forEach((type) => {
          const entry = entries.find((item: any) => item?.type === type);
          if (entry) {
            meta[type] = {
              version: entry.version ?? meta[type]?.version ?? 1,
              updated_at: entry.updated_at ?? meta[type]?.updated_at ?? null,
              updated_by: entry.updated_by ?? meta[type]?.updated_by ?? null
            };
          }
        });
        return meta;
      });
    } catch (error) {
      setPromptConfigError((error as Error).message ?? "Unable to load project configuration.");
    } finally {
      setPromptConfigLoading(false);
    }
  }, []);

  const loadTaxonomy = useCallback(async () => {
    try {
      const response = await fetch("/api/contact-taxonomy");
      if (!response.ok) return;
      const body = await response.json();
      const taxonomy = body?.taxonomy;
      if (taxonomy?.reasons && Array.isArray(taxonomy.reasons) && taxonomy.reasons.length) {
        setTaxonomyReasons(taxonomy.reasons);
      }
    } catch {
      // ignore, fall back to defaults
    }
  }, []);

  const normalizeRole = (role: unknown, author: unknown): string => {
    const roleText = (role ?? "").toString().trim().toUpperCase();
    if (roleText === "~A" || roleText === "A") return "A";
    if (roleText === "~C" || roleText === "C") return "C";
    if (roleText === "~U" || roleText === "U") return "U";
    const authorText = (author ?? "").toString().trim().toLowerCase();
    if (authorText.startsWith("712020") || authorText.startsWith("port ")) return "A";
    if (authorText.startsWith("qm:")) return "C";
    return "U";
  };

  const buildContextFromPrepared = useCallback(
    (payload: any): string => {
      const normalizeExtraField = (value: unknown): string => {
        const text = (value ?? "").toString().trim();
        return text && text !== "--" ? text : "Not provided";
      };

      const commentsRaw = Array.isArray(payload?.comments) ? payload.comments : [];
      const comments = commentsRaw
        .map((c: any, idx: number) => ({
          role: normalizeRole(c?.role, c?.author),
          date: c?.date ?? c?.created,
          text: typeof c?.text === "string" ? c.text.trim() : "",
          idx
        }))
        .filter((c: any) => c.text);
      const sorted = comments
        .slice()
        .sort((a: any, b: any) => {
          const aTime = Date.parse(a.date || "") || 0;
          const bTime = Date.parse(b.date || "") || 0;
          return aTime - bTime;
        });
      const startDate = sorted.length ? new Date(sorted[0].date || Date.now()) : null;
      const endDate = sorted.length ? new Date(sorted[sorted.length - 1].date || Date.now()) : null;
      const durationMinutes =
        startDate && endDate ? ((endDate.getTime() - startDate.getTime()) / 60000).toFixed(2) : "";
      const totalMessages = sorted.length;
      const agentMessages = sorted.filter((c: any) => c.role === "A").length;
      const customerMessages = sorted.filter((c: any) => c.role === "C").length;

      const transcript = sorted
        .map((c: any, index: number) => {
          const ts = c.date && !Number.isNaN(Date.parse(c.date)) ? new Date(c.date).toISOString() : "unknown";
          return `${String(index + 1).padStart(2, "0")}. ${c.role}: [${ts}] ${c.text}`;
        })
        .join("\n");

      const taxonomyBlock = taxonomyReasons
        .map((entry: any) => {
          const topic = String(entry?.topic ?? "").trim();
          if (!topic) return null;
          const sub = entry?.sub_reason ? String(entry.sub_reason).trim() : "";
          const keywords = Array.isArray(entry?.keywords) ? entry.keywords.filter((kw: any) => typeof kw === "string" && kw.trim()).slice(0, 3) : [];
          const parts = [`- ${topic}`];
          if (sub) {
            parts[0] = `${parts[0]}: ${sub}`;
          }
          if (keywords.length) {
            parts[0] = `${parts[0]} (${keywords.join(", ")})`;
          }
          return parts.join("");
        })
        .filter(Boolean)
        .join("\n");

      const originalContact =
        (payload?.custom_fields && typeof payload.custom_fields === "object"
          ? payload.custom_fields.contact_reason || payload.custom_fields.contactReason
          : "") || "Not specified";
      const rentalId = normalizeExtraField(payload?.["Rental ID"] ?? payload?.rental_id);
      const bikeQrCode = normalizeExtraField(payload?.["Bike QR Code"] ?? payload?.bike_qr_code);

      return [
        `Issue key: ${payload?.issue_key ?? payload?.issueKey ?? ""}`,
        `Status: ${payload?.status ?? ""}`,
        `Resolution: ${payload?.resolution ?? ""}`,
        `Rental ID: ${rentalId}`,
        `Bike QR Code: ${bikeQrCode}`,
        `Conversation start (UTC): ${startDate ? startDate.toISOString() : "unknown"}`,
        `Conversation end (UTC): ${endDate ? endDate.toISOString() : "unknown"}`,
        `Total messages: ${totalMessages}`,
        `Agent messages: ${agentMessages}`,
        `Customer messages: ${customerMessages}`,
        `Estimated duration (minutes): ${durationMinutes}`,
        `Original contact reason: ${originalContact}`,
        `Contact taxonomy:`,
        taxonomyBlock || "None provided.",
        "",
        "Transcript (A = agent, C = customer, U = unknown):",
        transcript || "No transcript available."
      ].join("\n");
    },
    [taxonomyReasons, normalizeRole]
  );

  const loadPreparedConversations = useCallback(async () => {
    try {
      const response = await fetch("/api/prepared-conversations?limit=10");
      if (!response.ok) return;
      const body = await response.json();
      const entries = Array.isArray(body?.entries) ? body.entries : [];
      const mapped = entries
        .map((entry: any) => ({
          issue_key: entry?.issue_key ?? "",
          prepared_at: entry?.prepared_at ?? null,
          payload: entry?.payload ?? {},
          contextText: buildContextFromPrepared(entry?.payload ?? {})
        }))
        .filter((item: { issue_key: string }) => Boolean(item.issue_key));
      setPreparedOptions(mapped);
      if (!mapped.length) {
        return;
      }
      const hasSelection =
        selectedPrepared && mapped.some((item: { issue_key: string }) => item.issue_key === selectedPrepared);
      if (!preparedInitialized && mapped.length) {
        setSelectedPrepared(mapped[0].issue_key);
        setConversationContext(mapped[0].contextText);
        setPreparedInitialized(true);
        return;
      }
      if (!hasSelection) {
        setSelectedPrepared(mapped[0].issue_key);
        setConversationContext(mapped[0].contextText);
        return;
      }
    } catch {
      // ignore
    }
  }, [buildContextFromPrepared, preparedInitialized, selectedPrepared]);

  useEffect(() => {
    void loadPromptConfigs();
    void loadTaxonomy();
    void loadPreparedConversations();
  }, []);

  const assembledPrompt = useMemo(() => {
    const parts = [
      promptConfigs.prompt_header,
      promptConfigs.task_sequence,
      promptConfigs.prompt_json_schema,
      promptConfigs.additional_instructions,
      promptConfigs.conversation_rating,
      promptConfigs.agent_score,
      promptConfigs.customer_score
    ];
    return parts.filter(Boolean).join("\n\n");
  }, [promptConfigs]);

  const testPayload = useMemo(() => {
    const promptText = conversationContext.trim()
      ? `${conversationContext.trim()}\n\n${assembledPrompt}`
      : assembledPrompt;
    return {
      prompt: promptText,
      systemPrompt: promptConfigs.system_prompt || SYSTEM_PROMPT,
      model: testModel || undefined
    };
  }, [assembledPrompt, conversationContext, promptConfigs.system_prompt, testModel]);

  const handleRunTest = useCallback(async () => {
    setTestRunning(true);
    setTestError(null);
    setTestResult("");
    setTestPretty("");
    setTestParsed(null);
    setTestRaw("");
    try {
      const response = await fetch("/api/test-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testPayload)
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || `Request failed (${response.status})`);
      }
      const completion = data?.completion;
      const requestLog = data?.request;
      setTestResult(JSON.stringify(completion, null, 2));
      const messageContent = completion?.choices?.[0]?.message?.content;
      if (typeof messageContent === "string") {
        let pretty = messageContent.trim();
        const parsed = extractJsonPayload(messageContent);
        if (parsed) {
          pretty = JSON.stringify(parsed, null, 2);
          setTestParsed(parsed);
        }
        setTestPretty(pretty);
      } else {
        setTestPretty(JSON.stringify(completion, null, 2));
      }
      setTestRaw(
        JSON.stringify(
          {
            request: requestLog ?? testPayload,
            response: completion
          },
          null,
          2
        )
      );
    } catch (error) {
      setTestError((error as Error).message || "Unable to run test.");
    } finally {
      setTestRunning(false);
    }
  }, [testPayload]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/80 px-6 py-4 backdrop-blur">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Project settings</p>
            <h1 className="text-2xl font-bold text-white">Prompt Builder</h1>
            <p className="text-xs text-slate-400">Edit the full prompt, preview, and run a quick test.</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full border border-slate-700 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-300">
              Debug: {debugLLM ? "On" : "Off"}
            </span>
            <Link
              href="/settings"
              className="rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-brand-500 hover:text-brand-200"
            >
              Settings
            </Link>
            <Link
              href="/"
              className="rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-brand-500 hover:text-brand-200"
            >
              Dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-6">
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Prompt configurations</h2>
              <p className="text-xs text-slate-400">Edit each section of the prompt stored in Supabase.</p>
            </div>
            <button
              type="button"
              onClick={loadPromptConfigs}
              disabled={promptConfigLoading}
              className="rounded-lg border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:border-brand-500 hover:text-brand-200 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
            >
              {promptConfigLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {promptConfigError && (
            <p className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {promptConfigError}
            </p>
          )}
          <div className="space-y-4">
            {PROJECT_PROMPT_TYPES.map((type) => (
              <div key={type} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-white">{PROMPT_LABELS[type]}</p>
                    <p className="text-[11px] text-slate-400">
                      v{promptConfigMeta[type]?.version ?? 1}
                      {promptConfigMeta[type]?.updated_at
                        ? ` · updated ${new Date(promptConfigMeta[type].updated_at as string).toLocaleString()}`
                        : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handlePromptSave(type)}
                    disabled={savingPromptType === type}
                    className="rounded-lg border border-brand-500/60 px-3 py-1 text-xs font-semibold text-brand-100 transition hover:bg-brand-500/10 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
                  >
                    {savingPromptType === type ? "Saving…" : "Save"}
                  </button>
                </div>
                <textarea
                  className="h-56 w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                  value={promptConfigs[type]}
                  onChange={(event) => handlePromptChange(type, event.target.value)}
                />
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Conversation context (optional)</h2>
              <p className="text-xs text-slate-400">
                Load a recent prepared ticket or paste your own metadata + transcript. This text is prepended to the prompt.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selectedPrepared}
                onChange={(event) => {
                  const value = event.target.value;
                  setSelectedPrepared(value);
                  const match = preparedOptions.find((item) => item.issue_key === value);
                  if (match) {
                    setConversationContext(match.contextText);
                  }
                }}
                className="min-w-[220px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              >
                {preparedOptions.length === 0 && <option value="">No recent tickets</option>}
                {preparedOptions.map((item) => (
                  <option key={item.issue_key} value={item.issue_key}>
                    {item.issue_key} {item.prepared_at ? `· ${new Date(item.prepared_at).toLocaleString()}` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  const match = preparedOptions.find((item) => item.issue_key === selectedPrepared);
                  if (match) {
                    setConversationContext(match.contextText);
                  }
                }}
                className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-brand-500 hover:text-brand-200 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
                disabled={!selectedPrepared}
              >
                Load ticket
              </button>
              <button
                type="button"
                onClick={() => void loadPreparedConversations()}
                className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-brand-500 hover:text-brand-200"
              >
                Refresh list
              </button>
              <button
                type="button"
                onClick={() => {
                  if (typeof navigator !== "undefined" && navigator.clipboard) {
                    void navigator.clipboard.writeText(conversationContext);
                  }
                }}
                className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-brand-500 hover:text-brand-200"
              >
                Copy context
              </button>
            </div>
          </div>
          <textarea
            className="h-48 w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            placeholder="Paste conversation meta + transcript..."
            value={conversationContext}
            onChange={(event) => setConversationContext(event.target.value)}
          />
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Assembled prompt preview</h2>
              <p className="text-xs text-slate-400">System prompt + user prompt that will be sent to the model.</p>
            </div>
            <span className="text-[11px] text-slate-400">Length: {assembledPrompt.length.toLocaleString()} chars</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
              <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-400">System prompt</p>
              <pre className="max-h-[240px] overflow-y-auto text-xs text-slate-100 whitespace-pre-wrap">
                {promptConfigs.system_prompt || SYSTEM_PROMPT}
              </pre>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
              <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-400">User prompt</p>
              <pre className="max-h-[520px] overflow-y-auto text-xs text-slate-100 whitespace-pre-wrap">
                {testPayload.prompt}
              </pre>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Run test</h2>
              <p className="text-xs text-slate-400">Sends the current prompt to OpenAI and shows the raw completion.</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Model (optional; defaults to env)"
                value={testModel}
                onChange={(event) => setTestModel(event.target.value)}
                className="w-48 rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              />
              <button
                type="button"
                onClick={handleRunTest}
                disabled={testRunning}
                className="rounded-lg border border-brand-500/60 px-4 py-2 text-sm font-semibold text-brand-100 transition hover:bg-brand-500/10 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
              >
                {testRunning ? "Running…" : "Send test"}
              </button>
            </div>
          </div>
          {testError && (
            <p className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {testError}
            </p>
          )}
          {testPretty && (
            <div className="space-y-3">
              <div>
                <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">Decoded response</p>
                {testParsed ? (
                  <div className="space-y-3">
                    <ParsedJsonGrid data={testParsed} />
                    <div>
                      <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">Formatted JSON</p>
                      <pre className="max-h-[240px] overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-[11px] text-emerald-100 whitespace-pre-wrap">
                        {JSON.stringify(testParsed, null, 2)}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <pre className="max-h-[320px] overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-xs text-emerald-100 whitespace-pre-wrap">
                    {testPretty}
                  </pre>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowAdvanced((prev) => !prev)}
                className="text-xs font-semibold text-brand-200 underline-offset-2 hover:underline"
              >
                {showAdvanced ? "Hide" : "Show"} API request/response
              </button>
              {showAdvanced && (
                <div className="space-y-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">Full API payloads</p>
                  <pre className="max-h-[420px] overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-[11px] text-slate-100 whitespace-pre-wrap">
                    {testRaw || testResult}
                  </pre>
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
