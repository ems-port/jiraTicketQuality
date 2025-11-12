import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

import { AgentMatrixHeatmap } from "@/components/AgentMatrixHeatmap";
import { AgentRankList } from "@/components/AgentRankList";
import { ContactReasonPanel } from "@/components/ContactReasonPanel";
import { CommandCenterPanel } from "@/components/CommandCenterPanel";
import { EscalationCard } from "@/components/EscalationCard";
import { DrilldownTable } from "@/components/DrilldownTable";
import { KPICard } from "@/components/KPICard";
import { ManagerReviewPanel } from "@/components/ManagerReviewPanel";
import { TipsOfTheDayPanel } from "@/components/TipsOfTheDayPanel";
import { SettingsDrawer } from "@/components/SettingsDrawer";
import { TipsDrilldownModal } from "@/components/TipsDrilldownModal";
import { ToxicityList } from "@/components/ToxicityList";
import { resolveDisplayName } from "@/lib/displayNames";
import {
  buildMetricSeries,
  buildResolvedSeries,
  computeAgentMatrix,
  computeAverageConversationRating,
  computeContactReasonSummary,
  buildEscalationSeries,
  computeFlaggedAgents,
  computeImprovementTips,
  computeResolvedStats,
  computeTopAgents,
  computeToxicCustomers,
  filterByWindow,
  normaliseRows
} from "@/lib/metrics";
import { isEscalated } from "@/lib/escalations";
import { normalizeAgentRole, resolveAgentRole, formatRoleLabel } from "@/lib/roles";
import { useDashboardStore } from "@/lib/useDashboardStore";
import type {
  AgentRole,
  ConversationRow,
  EscalationMetricKind,
  EscalationSeriesEntry,
  MetricSeries,
  SettingsState,
  TimeWindow
} from "@/types";

const WINDOWS: TimeWindow[] = ["24h", "7d", "30d"];
const ROLE_FILTERS: AgentRole[] = ["TIER1", "TIER2", "NON_AGENT"];
const SAMPLE_DATA_ENDPOINT = "/api/sample-data";
const ROLE_DATA_ENDPOINT = "/api/roles";

const DEFAULT_SETTINGS: SettingsState = {
  toxicity_threshold: 0.8,
  abusive_caps_trigger: 5,
  min_msgs_for_toxicity: 3
};

type DrilldownState = {
  metricLabel: string;
  rows: ConversationRow[];
} | null;

export default function DashboardPage() {
  const rows = useDashboardStore((state) => state.rows);
  const setRows = useDashboardStore((state) => state.setRows);
  const sampleDataActive = useDashboardStore((state) => state.sampleDataActive);
  const deAnonymize = useDashboardStore((state) => state.deAnonymize);
  const setDeAnonymize = useDashboardStore((state) => state.setDeAnonymize);
  const idMapping = useDashboardStore((state) => state.idMapping);
  const setIdMapping = useDashboardStore((state) => state.setIdMapping);
  const roleMapping = useDashboardStore((state) => state.roleMapping);
  const mergeRoleMapping = useDashboardStore((state) => state.mergeRoleMapping);
  const updateAgentRole = useDashboardStore((state) => state.updateAgentRole);

  const [selectedWindow, setSelectedWindow] = useState<TimeWindow>("7d");
  const [searchTerm, setSearchTerm] = useState("");
  const [agentFilter, setAgentFilter] = useState("All");
  const [roleFilter, setRoleFilter] = useState<AgentRole | "All">("All");
  const [hubFilter, setHubFilter] = useState("All");
  const [modelFilter, setModelFilter] = useState("All");
  const [escalationMetric, setEscalationMetric] = useState<EscalationMetricKind>("tier");
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [drilldownState, setDrilldownState] = useState<DrilldownState>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [roleUploadError, setRoleUploadError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [tipsDrilldownOpen, setTipsDrilldownOpen] = useState(false);
  const initialLoadAttemptedRef = useRef(false);
  const initialRoleLoadAttemptedRef = useRef(false);

  const loadSampleData = useCallback(async () => {
    initialLoadAttemptedRef.current = true;
    setFileError(null);
    try {
      const response = await fetch(SAMPLE_DATA_ENDPOINT);
      if (!response.ok) {
        throw new Error(`Failed to load sample data (${response.status})`);
      }
      const text = await response.text();
      const parsed = Papa.parse<Record<string, string | number | boolean | null>>(text, {
        header: true,
        skipEmptyLines: true
      });
      if (parsed.errors.length) {
        setFileError("Sample data contains parsing errors.");
        return;
      }
      const parsedRows = parsed.data.filter((row) => {
        const issueKey = (row.issue_key ?? (row as Record<string, unknown>).issueKey ?? "") as
          | string
          | number;
        return String(issueKey).trim().length > 0;
      });
      const normalised = normaliseRows(parsedRows);
      if (!normalised.length) {
        setFileError("Sample data file has no conversations.");
        return;
      }
      setRows(normalised, { sampleData: true });
      setFileName("convo_quality_550.csv");
    } catch (error) {
      setFileError((error as Error).message ?? "Unable to load sample data.");
    }
  }, [setRows, setFileError, setFileName]);

  useEffect(() => {
    if (!rows.length && !initialLoadAttemptedRef.current) {
      initialLoadAttemptedRef.current = true;
      void loadSampleData();
    }
  }, [rows.length, loadSampleData]);

  useEffect(() => {
    if (initialRoleLoadAttemptedRef.current) {
      return;
    }
    if (Object.keys(roleMapping).length > 0) {
      initialRoleLoadAttemptedRef.current = true;
      return;
    }
    initialRoleLoadAttemptedRef.current = true;
    const controller = new AbortController();
    const loadRoles = async () => {
      try {
        const response = await fetch(ROLE_DATA_ENDPOINT, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Failed to load roles CSV (${response.status})`);
        }
        const csvText = await response.text();
        const parsed = Papa.parse<Record<string, string | null | undefined>>(csvText, {
          header: true,
          skipEmptyLines: true
        });
        if (parsed.errors.length) {
          setRoleUploadError("Unable to parse default roles CSV. Please upload manually.");
          return;
        }
        const updates: Record<string, AgentRole> = {};
        parsed.data.forEach((row) => {
          if (!row) {
            return;
          }
          const userId = (
            row.user_id ?? row.userId ?? row.id ?? (row as Record<string, unknown>).agent_id ?? ""
          )
            .toString()
            .trim();
          const roleValue = (
            row.port_role ?? row.portRole ?? row.role ?? (row as Record<string, unknown>).agent_role ?? ""
          )
            .toString()
            .trim();
          if (userId && roleValue) {
            updates[userId] = normalizeAgentRole(roleValue);
          }
        });
        const tieredEntries = Object.fromEntries(
          Object.entries(updates).filter(([, role]) => role !== "NON_AGENT")
        );
        if (!Object.keys(tieredEntries).length) {
          setRoleUploadError("Default roles CSV has no Tier 1 or Tier 2 agents. Upload an updated file.");
          return;
        }
        mergeRoleMapping(tieredEntries);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setRoleUploadError((error as Error).message ?? "Unable to load default roles CSV.");
      }
    };

    void loadRoles();
    return () => {
      controller.abort();
    };
  }, [mergeRoleMapping, roleMapping]);

  useEffect(() => {
    if (!deAnonymize) {
      setMappingError(null);
    }
  }, [deAnonymize]);

  const sourceRows = rows;

  const attributeFilteredRows = useMemo(() => {
    const search = searchTerm.trim().toLowerCase();
    return sourceRows.filter((row) => {
      const matchesSearch = !search || row.issueKey.toLowerCase().includes(search);
      const matchesAgent =
        agentFilter === "All" || row.agentList.some((agent) => agent === agentFilter);
      const matchesRole =
        roleFilter === "All" ||
        row.agentList.some((agent) => resolveAgentRole(agent, roleMapping) === roleFilter);
      const matchesHub = hubFilter === "All" || (row.hub ?? "Unassigned") === hubFilter;
      const matchesModel = modelFilter === "All" || (row.model ?? "Unknown") === modelFilter;
      return matchesSearch && matchesAgent && matchesRole && matchesHub && matchesModel;
    });
  }, [sourceRows, searchTerm, agentFilter, roleFilter, hubFilter, modelFilter, roleMapping]);

  const referenceNow = useMemo(() => {
    let latest: Date | null = null;
    sourceRows.forEach((row) => {
      const candidate = row.endedAt ?? row.startedAt;
      if (candidate && (!latest || candidate.getTime() > latest.getTime())) {
        latest = candidate;
      }
    });
    return latest ? new Date(latest) : new Date();
  }, [sourceRows]);

  const filteredRows = useMemo(
    () => filterByWindow(attributeFilteredRows, selectedWindow, referenceNow),
    [attributeFilteredRows, selectedWindow, referenceNow]
  );

  const resolvedRows = useMemo(
    () => filteredRows.filter((row) => row.resolved),
    [filteredRows]
  );

  const tierEscalatedRows = useMemo(
    () => filteredRows.filter((row) => isEscalated(row, roleMapping, "tier")),
    [filteredRows, roleMapping]
  );
  const handoffRows = useMemo(
    () => filteredRows.filter((row) => isEscalated(row, roleMapping, "handoff")),
    [filteredRows, roleMapping]
  );

  const ratingSeries = useMemo(
    () => buildMetricSeries(attributeFilteredRows, computeAverageConversationRating, referenceNow),
    [attributeFilteredRows, referenceNow]
  );
  const resolvedSeries = useMemo(
    () => buildResolvedSeries(attributeFilteredRows, referenceNow),
    [attributeFilteredRows, referenceNow]
  );
  const escalationSeries = useMemo(
    () => buildEscalationSeries(attributeFilteredRows, roleMapping, referenceNow),
    [attributeFilteredRows, roleMapping, referenceNow]
  );

  const tierPercentSeries = useMemo(
    () =>
      escalationSeries.map((entry) => ({
        window: entry.window,
        value: computePercentage(entry.tierCount, entry.total),
        count: entry.tierCount,
        total: entry.total
      })),
    [escalationSeries]
  );

  const handoffPercentSeries = useMemo(
    () =>
      escalationSeries.map((entry) => ({
        window: entry.window,
        value: computePercentage(entry.handoffCount, entry.total),
        count: entry.handoffCount,
        total: entry.total
      })),
    [escalationSeries]
  );

  const selectedEscalationStats = escalationSeries.find(
    (entry) => entry.window === selectedWindow
  );
  const tierFooterText =
    selectedEscalationStats && selectedEscalationStats.total
      ? `${selectedEscalationStats.tierCount.toLocaleString()} of ${selectedEscalationStats.total.toLocaleString()} escalated`
      : "No tickets in this window";
  const handoffFooterText =
    selectedEscalationStats && selectedEscalationStats.total
      ? `${selectedEscalationStats.handoffCount.toLocaleString()} of ${selectedEscalationStats.total.toLocaleString()} handed over`
      : "No tickets in this window";

  const selectedRating =
    ratingSeries.find((entry) => entry.window === selectedWindow)?.value ?? null;

  const selectedResolvedStats = useMemo(
    () => computeResolvedStats(filteredRows),
    [filteredRows]
  );

  const selectedResolvedPercentage = selectedResolvedStats.percentage;

  const topAgents = useMemo(
    () => computeTopAgents(attributeFilteredRows, referenceNow),
    [attributeFilteredRows, referenceNow]
  );
  const toxicCustomers = useMemo(
    () => computeToxicCustomers(attributeFilteredRows, settings, referenceNow),
    [attributeFilteredRows, settings, referenceNow]
  );
  const flaggedAgents = useMemo(
    () => computeFlaggedAgents(attributeFilteredRows, settings, referenceNow),
    [attributeFilteredRows, settings, referenceNow]
  );
  const agentMatrix = useMemo(
    () =>
      computeAgentMatrix(attributeFilteredRows, selectedWindow, referenceNow, {
        roleMapping,
        escalationMetric
      }),
    [attributeFilteredRows, selectedWindow, referenceNow, roleMapping, escalationMetric]
  );

  const improvementTipSummary = useMemo(
    () => computeImprovementTips(attributeFilteredRows, referenceNow),
    [attributeFilteredRows, referenceNow]
  );

  const contactReasonSummary = useMemo(
    () => computeContactReasonSummary(attributeFilteredRows, selectedWindow, referenceNow),
    [attributeFilteredRows, selectedWindow, referenceNow]
  );

  const agentOptions = useMemo(() => {
    const values = new Set<string>();
    sourceRows.forEach((row) => row.agentList.forEach((agent) => values.add(agent)));
    return Array.from(values).sort((a, b) => {
      const aLabel = resolveDisplayName(a, idMapping, deAnonymize).label.toLowerCase();
      const bLabel = resolveDisplayName(b, idMapping, deAnonymize).label.toLowerCase();
      return aLabel.localeCompare(bLabel);
    });
  }, [sourceRows, idMapping, deAnonymize]);

  const hubOptions = useMemo(() => {
    const values = new Set<string>();
    sourceRows.forEach((row) => values.add(row.hub ?? "Unassigned"));
    return Array.from(values).sort();
  }, [sourceRows]);

  const modelOptions = useMemo(() => {
    const values = new Set<string>();
    sourceRows.forEach((row) => values.add(row.model ?? "Unknown"));
    return Array.from(values).sort();
  }, [sourceRows]);

  const handleConversationsFile = (file: File) => {
    setFileError(null);
    Papa.parse<Record<string, string | number | boolean | null>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (results.errors.length) {
          setFileError("Unable to parse CSV. Please verify the file format.");
          return;
        }
        const parsedRows = results.data.filter((row) => {
          const issueKey = (row.issue_key ?? (row as Record<string, unknown>).issueKey ?? "") as
            | string
            | number;
          return String(issueKey).trim().length > 0;
        });
        const normalised = normaliseRows(parsedRows);
        if (!normalised.length) {
          setFileError("No conversations found in the uploaded CSV.");
          return;
        }
        setRows(normalised, { sampleData: false });
        setFileName(file.name);
      },
      error: () => {
        setFileError("Unable to read the selected file.");
      }
    });
  };

  const handleMappingUpload = (file: File) => {
    setMappingError(null);
    Papa.parse<Record<string, string | null | undefined>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (results.errors.length) {
          setMappingError("Unable to parse lookup CSV. Please verify the columns.");
          return;
        }
        const nextMapping: Record<string, string> = {};
        results.data.forEach((row) => {
          const userId = (row.user_id ?? row.userId ?? row.id ?? "").toString().trim();
          const displayName = (row.display_name ?? row.displayName ?? row.name ?? "").toString().trim();
          if (userId && displayName) {
            nextMapping[userId] = displayName;
          }
        });
        if (!Object.keys(nextMapping).length) {
          setMappingError("No valid user_id and display_name pairs found in the lookup CSV.");
          return;
        }
        setIdMapping(nextMapping);
      },
      error: () => {
        setMappingError("Unable to read the lookup CSV.");
      }
    });
  };

  const handleRolesUpload = (file: File) => {
    setRoleUploadError(null);
    Papa.parse<Record<string, string | null | undefined>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (results.errors.length) {
          setRoleUploadError("Unable to parse roles CSV. Check the header names.");
          return;
        }
        const updates: Record<string, AgentRole> = {};
        results.data.forEach((row) => {
          if (!row) {
            return;
          }
          const userId = (
            row.user_id ?? row.userId ?? row.id ?? (row as Record<string, unknown>).agent_id ?? ""
          )
            .toString()
            .trim();
          const roleValue = (
            row.port_role ?? row.portRole ?? row.role ?? (row as Record<string, unknown>).agent_role ?? ""
          )
            .toString()
            .trim();
          if (userId && roleValue) {
            updates[userId] = normalizeAgentRole(roleValue);
          }
        });
        if (!Object.keys(updates).length) {
          setRoleUploadError("No user_id / role pairs detected in the CSV.");
          return;
        }
        mergeRoleMapping(updates);
      },
      error: () => {
        setRoleUploadError("Unable to read the selected roles CSV.");
      }
    });
  };

  const openDrilldown = (metricLabel: string, data: ConversationRow[]) => {
    setDrilldownState({ metricLabel, rows: data });
  };

  const handleContactReasonSelect = useCallback(
    (reason: string) => {
      const normalized = reason.trim().toLowerCase();
      const reasonRows = filteredRows.filter((row) => {
        const value = (row.contactReason ?? row.contactReasonOriginal ?? "Unspecified").trim();
        const label = value.length ? value : "Unspecified";
        return label.toLowerCase() === normalized;
      });
      openDrilldown(`Contact reason: ${reason}`, reasonRows);
    },
    [filteredRows]
  );

  const conversationCount = filteredRows.length;
  const resolvedFooterText = selectedResolvedStats.total
    ? `${selectedResolvedStats.count.toLocaleString()} of ${selectedResolvedStats.total.toLocaleString()} resolved`
    : "No tickets in this window";

  return (
    <main className="min-h-screen bg-slate-950 pb-16">
      <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-4 rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-900/80 to-slate-950/60 p-6 shadow-xl">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <h1 className="text-3xl font-bold text-white">Conversation Quality Command Center</h1>
              <p className="text-sm text-slate-300">
                Monitor Jira LLM-assisted conversations with real-time scoring, escalation trends, and toxicity alerts.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              className="self-start rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-brand-500 hover:text-brand-200"
            >
              Settings
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
            <span className="rounded-full border border-brand-500/40 bg-brand-500/15 px-3 py-1 text-brand-100">
              {conversationCount.toLocaleString()} conversations in view
            </span>
            {fileName && (
              <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-300">
                Active dataset: {fileName}
              </span>
            )}
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-4 rounded-3xl border border-slate-800 bg-slate-900/60 p-6">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Time window
                </span>
                <div className="flex gap-2">
                  {WINDOWS.map((window) => (
                    <button
                      key={window}
                      type="button"
                      onClick={() => setSelectedWindow(window)}
                      className={
                        window === selectedWindow
                          ? "rounded-full bg-brand-500 px-4 py-2 text-sm font-semibold text-white"
                          : "rounded-full border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:border-brand-500 hover:text-brand-200"
                      }
                    >
                      {window}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="sm:col-span-2">
                  <label className="flex flex-col gap-2 text-sm text-slate-200">
                    Search issue key
                    <input
                      type="search"
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                      placeholder="Filter by Jira issue key"
                      className="rounded-xl border border-slate-700 bg-slate-900/80 px-4 py-2 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                    />
                  </label>
                </div>
                <FilterSelect
                  label="Agent"
                  value={agentFilter}
                  onChange={setAgentFilter}
                  options={agentOptions}
                  getLabel={(value) => resolveDisplayName(value, idMapping, deAnonymize).label}
                />
                <FilterSelect
                  label="Role"
                  value={roleFilter}
                  onChange={(value) => setRoleFilter(value as AgentRole | "All")}
                  options={ROLE_FILTERS}
                  getLabel={(value) => formatRoleLabel(value as AgentRole)}
                />
                <FilterSelect
                  label="Hub"
                  value={hubFilter}
                  onChange={setHubFilter}
                  options={hubOptions}
                />
                <FilterSelect
                  label="Model"
                  value={modelFilter}
                  onChange={setModelFilter}
                  options={modelOptions}
                />
              </div>
            </section>

            <section className="grid gap-4 md:grid-cols-3">
              <KPICard
                title="Conversation Score"
                value={selectedRating}
                formatValue={(value) => (value === null ? "—" : `${value.toFixed(2)} / 5`)}
                series={ratingSeries}
                selectedWindow={selectedWindow}
                onClick={() => openDrilldown("Conversation Score", filteredRows)}
              />
              <KPICard
                title="Resolved conversations"
                value={selectedResolvedPercentage}
                formatValue={(value) =>
                  value === null ? "—" : `${Math.round(value)}%`
                }
                footerText={resolvedFooterText}
                series={resolvedSeries}
                selectedWindow={selectedWindow}
                onClick={() => openDrilldown("Resolved conversations", resolvedRows)}
              />
              <EscalationCard
                mode={escalationMetric}
                onModeChange={setEscalationMetric}
                tierSeries={tierPercentSeries}
                handoffSeries={handoffPercentSeries}
                selectedWindow={selectedWindow}
                footerText={escalationMetric === "tier" ? tierFooterText : handoffFooterText}
                onOpen={() =>
                  openDrilldown(
                    escalationMetric === "tier" ? "Escalation T1→T2" : "Handovers T1→Any",
                    escalationMetric === "tier" ? tierEscalatedRows : handoffRows
                  )
                }
              />
            </section>

            <TipsOfTheDayPanel
              summary={improvementTipSummary}
              onOpen={() => setTipsDrilldownOpen(true)}
            />

            <section className="grid gap-4 lg:grid-cols-3">
              <div className="lg:col-span-1">
                <AgentRankList
                  title="Top performing agents"
                  agents={topAgents.slice(0, 5)}
                  mapping={idMapping}
                  deAnonymize={deAnonymize}
                  roleMapping={roleMapping}
                />
              </div>
              <div className="lg:col-span-1">
                <ToxicityList
                  title="Most abusive customers"
                  subtitle="Last 5 days"
                  entries={toxicCustomers.slice(0, 5)}
                  emptyLabel="No abusive customer behaviour detected."
                  mapping={idMapping}
                  deAnonymize={deAnonymize}
                  entityLabel="Customer ID"
                />
              </div>
              <div className="lg:col-span-1">
                <ToxicityList
                  title="Flagged abusive agents"
                  subtitle="Last 7 days"
                  entries={flaggedAgents}
                  emptyLabel="No agents exceeded the toxicity threshold."
                  mapping={idMapping}
                  deAnonymize={deAnonymize}
                  entityLabel="Agent ID"
                  showAgentRoles={true}
                  roleMapping={roleMapping}
                />
              </div>
            </section>

            <AgentMatrixHeatmap
              rows={agentMatrix}
              window={selectedWindow}
              mapping={idMapping}
              deAnonymize={deAnonymize}
              roleMapping={roleMapping}
              escalationMetric={escalationMetric}
            />

            <ContactReasonPanel
              summary={contactReasonSummary}
              window={selectedWindow}
              onSelect={handleContactReasonSelect}
            />

            <ManagerReviewPanel rows={filteredRows} mapping={idMapping} deAnonymize={deAnonymize} />
          </div>

          <CommandCenterPanel
            onUploadConversations={handleConversationsFile}
            onLoadSampleData={loadSampleData}
            sampleDataActive={sampleDataActive}
            fileName={fileName}
            fileError={fileError}
            deAnonymize={deAnonymize}
            onToggleDeAnonymize={setDeAnonymize}
            onUploadMapping={handleMappingUpload}
          mappedCount={Object.keys(idMapping).length}
          conversationCount={sourceRows.length}
          mappingError={mappingError}
          roleMapping={roleMapping}
          onUploadRoles={handleRolesUpload}
          roleUploadError={roleUploadError}
          onRoleChange={updateAgentRole}
          agentIds={agentOptions}
          idMapping={idMapping}
        />
        </div>
      </div>

      <DrilldownTable
        open={Boolean(drilldownState)}
        metricLabel={drilldownState?.metricLabel ?? ""}
        rows={drilldownState?.rows ?? []}
        onClose={() => setDrilldownState(null)}
        mapping={idMapping}
        deAnonymize={deAnonymize}
        roleMapping={roleMapping}
      />

      <TipsDrilldownModal
        open={tipsDrilldownOpen}
        tips={improvementTipSummary.entries}
        windowStart={improvementTipSummary.windowStart}
        windowEnd={improvementTipSummary.windowEnd}
        onClose={() => setTipsDrilldownOpen(false)}
        mapping={idMapping}
        deAnonymize={deAnonymize}
        roleMapping={roleMapping}
      />

      <SettingsDrawer
        open={isSettingsOpen}
        settings={settings}
        onClose={() => setIsSettingsOpen(false)}
        onChange={setSettings}
      />
    </main>
  );
}

function computePercentage(count: number | null, total: number | null): number | null {
  if (count === null || total === null || total <= 0) {
    return null;
  }
  return (count / total) * 100;
}

type FilterSelectProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  getLabel?: (value: string) => string;
};

function FilterSelect({ label, value, onChange, options, getLabel }: FilterSelectProps) {
  return (
    <label className="flex flex-col gap-2 text-sm text-slate-200">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-xl border border-slate-700 bg-slate-900/80 px-4 py-2 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
      >
        <option value="All">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {getLabel ? getLabel(option) : option}
          </option>
        ))}
      </select>
    </label>
  );
}
