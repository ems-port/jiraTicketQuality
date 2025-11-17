import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import type { GetStaticProps } from "next";
import clsx from "clsx";

import { AgentMatrixHeatmap } from "@/components/AgentMatrixHeatmap";
import { AgentRankList } from "@/components/AgentRankList";
import { CustomerSentimentPanel } from "@/components/CustomerSentimentPanel";
import { ContactReasonPanel } from "@/components/ContactReasonPanel";
import { CommandCenterPanel } from "@/components/CommandCenterPanel";
import { EscalationCard } from "@/components/EscalationCard";
import { DrilldownTable } from "@/components/DrilldownTable";
import { KPICard } from "@/components/KPICard";
import { ManagerReviewPanel } from "@/components/ManagerReviewPanel";
import { TipsOfTheDayPanel } from "@/components/TipsOfTheDayPanel";
import { SettingsDrawer } from "@/components/SettingsDrawer";
import { TipsDrilldownModal } from "@/components/TipsDrilldownModal";
import { TicketVolumePanel } from "@/components/TicketVolumePanel";
import { ToxicityList } from "@/components/ToxicityList";
import { resolveDisplayName } from "@/lib/displayNames";
import {
  buildMetricSeries,
  buildResolvedSeries,
  computeAgentMatrix,
  computeAverageConversationRating,
  computeAverageDurationToResolution,
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
  AgentDirectoryEntry,
  AgentRole,
  AgentSaveState,
  ConversationRow,
  EscalationMetricKind,
  EscalationSeriesEntry,
  MetricSeries,
  SettingsState,
  TimeWindow
} from "@/types";

type AgentDirectoryState = Record<string, { displayName: string; role: AgentRole }>;

type DashboardPageProps = {
  initialAgentDirectory: AgentDirectoryState;
  initialAgentOrder: string[];
};

const WINDOWS: TimeWindow[] = ["24h", "7d", "30d"];
const WINDOW_LABELS: Record<TimeWindow, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days"
};
const ROLE_FILTERS: AgentRole[] = ["TIER1", "TIER2", "NON_AGENT"];
const SAMPLE_DATA_ENDPOINT = "/api/sample-data";
const ROLE_DATA_ENDPOINT = "/api/roles";
const REFRESH_ENDPOINT = "/api/refresh-data";

const DEFAULT_SETTINGS: SettingsState = {
  toxicity_threshold: 0.8,
  abusive_caps_trigger: 5,
  min_msgs_for_toxicity: 3
};

type RefreshJobStage = "idle" | "ingesting" | "processing" | "completed" | "error";

type RefreshJobState = {
  running: boolean;
  stage: RefreshJobStage;
  startedAt: number | null;
  updatedAt: number | null;
  message?: string;
  fetchedTickets?: number;
  skippedTickets?: number;
  processedTickets?: number;
  totalToProcess?: number;
  etaSeconds?: number;
  lastCompletedAt?: number | null;
  error?: string;
  pendingConversations?: number | null;
};

const DEFAULT_REFRESH_STATE: RefreshJobState = {
  running: false,
  stage: "idle",
  startedAt: null,
  updatedAt: null,
  lastCompletedAt: null,
  pendingConversations: null
};

type DrilldownState = {
  metricLabel: string;
  rows: ConversationRow[];
} | null;

type LatestTicketInfo = {
  key: string;
  dateLabel: string | null;
};

export default function DashboardPage({
  initialAgentDirectory = {},
  initialAgentOrder = []
}: DashboardPageProps) {
  const buildNumber = process.env.NEXT_PUBLIC_BUILD_NUMBER ?? "dev";
  const rows = useDashboardStore((state) => state.rows);
  const setRows = useDashboardStore((state) => state.setRows);
  const sampleDataActive = useDashboardStore((state) => state.sampleDataActive);
  const deAnonymize = useDashboardStore((state) => state.deAnonymize);
  const setDeAnonymize = useDashboardStore((state) => state.setDeAnonymize);
  const idMapping = useDashboardStore((state) => state.idMapping);
  const setIdMapping = useDashboardStore((state) => state.setIdMapping);
  const mergeIdMapping = useDashboardStore((state) => state.mergeIdMapping);
  const roleMapping = useDashboardStore((state) => state.roleMapping);
  const setRoleMapping = useDashboardStore((state) => state.setRoleMapping);
  const updateAgentRole = useDashboardStore((state) => state.updateAgentRole);

  const [selectedWindow, setSelectedWindow] = useState<TimeWindow>("7d");
  const [searchTerm, setSearchTerm] = useState("");
  const [agentFilter, setAgentFilter] = useState("All");
  const [roleFilter, setRoleFilter] = useState<AgentRole | "All">("All");
  const [hubFilter, setHubFilter] = useState("All");
  const [escalationMetric, setEscalationMetric] = useState<EscalationMetricKind>("tier");
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [drilldownState, setDrilldownState] = useState<DrilldownState>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [agentDirectory, setAgentDirectory] = useState<AgentDirectoryState>(initialAgentDirectory);
  const [agentOrder, setAgentOrder] = useState<string[]>(initialAgentOrder);
  const [agentSaveState, setAgentSaveState] = useState<Record<string, AgentSaveState>>({});
  const [agentDirectoryError, setAgentDirectoryError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [tipsDrilldownOpen, setTipsDrilldownOpen] = useState(false);
  const [isManagerReviewOpen, setIsManagerReviewOpen] = useState(false);
  const [useOnlineData, setUseOnlineData] = useState(true);
  const [refreshState, setRefreshState] = useState<RefreshJobState>(DEFAULT_REFRESH_STATE);
  const [latestOnlineTicket, setLatestOnlineTicket] = useState<LatestTicketInfo | null>(null);
  const initialLoadAttemptedRef = useRef(false);
  const initialRoleLoadAttemptedRef = useRef(false);
  const lastRefreshCompletionRef = useRef<number | null>(null);

  useEffect(() => {
    setIdMapping({});
  }, [setIdMapping]);

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
      setFileName("convo_quality_Nov_5-mini.csv");
    } catch (error) {
      setFileError((error as Error).message ?? "Unable to load sample data.");
    }
  }, [setRows, setFileError, setFileName]);

  const loadOnlineData = useCallback(async () => {
    setFileError(null);
    try {
      const response = await fetch("/api/conversations");
      if (!response.ok) {
        throw new Error(`Failed to load online data (${response.status})`);
      }
      const payload = await response.json();
      const rawRows: Record<string, unknown>[] = payload.rows ?? [];
      const normalised = normaliseRows(rawRows as Record<string, string | number | boolean | null>[]);
      if (!normalised.length) {
        setFileError("Online data source returned no conversations.");
        return;
      }
      setRows(normalised, { sampleData: false });
      setFileName("Supabase Live DB");
      setLatestOnlineTicket(computeLatestTicketInfo(normalised));
    } catch (error) {
      setFileError((error as Error).message ?? "Unable to load online data.");
    }
  }, [setRows, setFileError, setFileName]);

  useEffect(() => {
    if (!rows.length && !initialLoadAttemptedRef.current && !useOnlineData) {
      initialLoadAttemptedRef.current = true;
      void loadSampleData();
    }
  }, [rows.length, loadSampleData, useOnlineData]);

  useEffect(() => {
    if (useOnlineData) {
      void loadOnlineData();
    }
  }, [useOnlineData, loadOnlineData]);

  const fetchRefreshStatus = useCallback(async () => {
    try {
      const response = await fetch(REFRESH_ENDPOINT);
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as RefreshJobState;
      setRefreshState(payload);
      if (
        payload.lastCompletedAt &&
        payload.lastCompletedAt !== lastRefreshCompletionRef.current &&
        typeof window !== "undefined"
      ) {
        lastRefreshCompletionRef.current = payload.lastCompletedAt;
        window.localStorage.setItem("cq_last_fetch_at", new Date(payload.lastCompletedAt).toISOString());
        if (useOnlineData) {
          void loadOnlineData();
        }
      }
    } catch (error) {
      console.error("Failed to fetch refresh status", error);
    }
  }, [loadOnlineData, useOnlineData]);

  useEffect(() => {
    void fetchRefreshStatus();
    const interval = setInterval(() => {
      void fetchRefreshStatus();
    }, 4000);
    return () => clearInterval(interval);
  }, [fetchRefreshStatus]);

  const surfaceRefreshError = useCallback((message: string) => {
    setRefreshState((prev) => ({
      ...prev,
      running: false,
      stage: "error",
      error: message,
      message
    }));
  }, []);

  const handleFetchData = useCallback(async () => {
    try {
      const response = await fetch(REFRESH_ENDPOINT, { method: "POST" });
      const payload = (await response.json()) as RefreshJobState | { error: string };
      if (response.status === 409 || response.status === 202) {
        setRefreshState(payload as RefreshJobState);
      } else if (!response.ok) {
        const errorMessage =
          ("error" in payload && typeof payload.error === "string" && payload.error) ||
          `Refresh request failed (${response.status})`;
        console.error("Refresh request failed", { status: response.status, payload });
        surfaceRefreshError(errorMessage);
      }
    } catch (error) {
      console.error("Failed to trigger refresh", error);
      surfaceRefreshError(error instanceof Error ? error.message : "Failed to trigger refresh");
    } finally {
      void fetchRefreshStatus();
    }
  }, [fetchRefreshStatus, surfaceRefreshError]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const stored = window.localStorage.getItem("cq_last_fetch_at");
    if (stored) {
      const parsed = new Date(stored);
      if (!Number.isNaN(parsed.getTime())) {
        lastRefreshCompletionRef.current = parsed.getTime();
      }
    }
  }, []);

  useEffect(() => {
    if (initialRoleLoadAttemptedRef.current) {
      return;
    }
    if (agentOrder.length) {
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
          throw new Error("Unable to parse default roles CSV. Please verify the columns.");
        }
        const directory: Record<string, { displayName: string; role: AgentRole }> = {};
        const order: string[] = [];
        parsed.data.forEach((row) => {
          if (!row) {
            return;
          }
          const userId = (
            row.user_id ?? row.userId ?? row.id ?? (row as Record<string, unknown>).agent_id ?? ""
          )
            .toString()
            .trim();
          if (!userId) {
            return;
          }
          if (!order.includes(userId)) {
            order.push(userId);
          }
          const displayName = (
            row.display_name ?? row.displayName ?? row.name ?? row.agent_name ?? ""
          )
            .toString()
            .trim();
          const roleValue = (
            row.port_role ?? row.portRole ?? row.role ?? (row as Record<string, unknown>).agent_role ?? ""
          )
            .toString()
            .trim();
          directory[userId] = {
            displayName,
            role: normalizeAgentRole(roleValue)
          };
        });
        if (!order.length) {
          throw new Error("Default roles CSV has no agent entries.");
        }
        setAgentDirectory(directory);
        setAgentOrder(order);
        setAgentSaveState((prev) => {
          const next = { ...prev };
          order.forEach((id) => {
            if (!next[id]) {
              next[id] = "idle";
            }
          });
          return next;
        });
        setAgentDirectoryError(null);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setAgentDirectoryError((error as Error).message ?? "Unable to load default roles CSV.");
      }
    };

    void loadRoles();
    return () => {
      controller.abort();
    };
  }, [agentOrder.length]);

  useEffect(() => {
    if (!deAnonymize) {
      setMappingError(null);
    }
  }, [deAnonymize]);

  useEffect(() => {
    if (!agentOrder.length) {
      return;
    }
    const nextRoleMap: Record<string, AgentRole> = {};
    agentOrder.forEach((id) => {
      nextRoleMap[id] = agentDirectory[id]?.role ?? "NON_AGENT";
    });
    setRoleMapping(nextRoleMap);
  }, [agentDirectory, agentOrder, setRoleMapping]);

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
      return matchesSearch && matchesAgent && matchesRole && matchesHub;
    });
  }, [sourceRows, searchTerm, agentFilter, roleFilter, hubFilter, roleMapping]);

  const referenceNow = useMemo(() => {
    if (!sampleDataActive) {
      return new Date();
    }
    const latestReference = resolveLatestReferenceDate(sourceRows);
    return latestReference ? new Date(latestReference) : new Date();
  }, [sourceRows, sampleDataActive]);

  const filteredRows = useMemo(
    () => filterByWindow(attributeFilteredRows, selectedWindow, referenceNow),
    [attributeFilteredRows, selectedWindow, referenceNow]
  );

  const unresolvedRows = useMemo(
    () => filteredRows.filter((row) => !row.resolved),
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

  const averageDurationSeries = useMemo(
    () => buildMetricSeries(attributeFilteredRows, computeAverageDurationToResolution, referenceNow),
    [attributeFilteredRows, referenceNow]
  );
  const selectedAverageDuration =
    averageDurationSeries.find((entry) => entry.window === selectedWindow)?.value ?? null;

  const selectedRating =
    ratingSeries.find((entry) => entry.window === selectedWindow)?.value ?? null;

  const selectedResolvedStats = useMemo(
    () => computeResolvedStats(filteredRows),
    [filteredRows]
  );

  const unresolvedCount =
    selectedResolvedStats.total - selectedResolvedStats.count;
  const unresolvedPercentage =
    selectedResolvedStats.percentage === null
      ? null
      : 100 - selectedResolvedStats.percentage;

  const topAgents = useMemo(
    () =>
      computeTopAgents(attributeFilteredRows, roleMapping, referenceNow, {
        limit: 5,
        roleFilter
      }),
    [attributeFilteredRows, roleMapping, referenceNow, roleFilter]
  );
  const toxicCustomers = useMemo(
    () =>
      computeToxicCustomers(attributeFilteredRows, settings, referenceNow, {
        window: selectedWindow
      }),
    [attributeFilteredRows, settings, referenceNow, selectedWindow]
  );
  const flaggedAgents = useMemo(
    () =>
      computeFlaggedAgents(attributeFilteredRows, settings, referenceNow, {
        window: selectedWindow
      }),
    [attributeFilteredRows, settings, referenceNow, selectedWindow]
  );
  const agentMatrix = useMemo(
    () =>
      computeAgentMatrix(attributeFilteredRows, selectedWindow, referenceNow, {
        roleMapping,
        escalationMetric,
        roleFilter
      }),
    [attributeFilteredRows, selectedWindow, referenceNow, roleMapping, escalationMetric, roleFilter]
  );

  const averageAgentScore = useMemo(() => {
    const windowed = filterByWindow(attributeFilteredRows, selectedWindow, referenceNow);
    const values = windowed
      .map((row) => row.agentScore)
      .filter((value): value is number => value !== null && !Number.isNaN(value));
    if (!values.length) {
      return null;
    }
    const sum = values.reduce((acc, value) => acc + value, 0);
    return sum / values.length;
  }, [attributeFilteredRows, selectedWindow, referenceNow]);

  const improvementTipSummary = useMemo(
    () => computeImprovementTips(attributeFilteredRows, referenceNow),
    [attributeFilteredRows, referenceNow]
  );

  const contactReasonSummary = useMemo(
    () => computeContactReasonSummary(attributeFilteredRows, selectedWindow, referenceNow),
    [attributeFilteredRows, selectedWindow, referenceNow]
  );

  const agentNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    Object.entries(agentDirectory).forEach(([id, entry]) => {
      if (entry.displayName && entry.displayName.trim()) {
        map[id] = entry.displayName.trim();
      }
    });
    return map;
  }, [agentDirectory]);

  const agentOptions = useMemo(() => {
    const values = new Set<string>();
    sourceRows.forEach((row) => row.agentList.forEach((agent) => values.add(agent)));
    return Array.from(values).sort((a, b) => {
      const aLabel = resolveDisplayName(a, idMapping, deAnonymize, agentNameMap).label.toLowerCase();
      const bLabel = resolveDisplayName(b, idMapping, deAnonymize, agentNameMap).label.toLowerCase();
      return aLabel.localeCompare(bLabel);
    });
  }, [sourceRows, idMapping, deAnonymize, agentNameMap]);

  const agentDirectoryEntries = useMemo<AgentDirectoryEntry[]>(() => {
    const combined = [...agentOrder];
    agentOptions.forEach((id) => {
      if (!combined.includes(id)) {
        combined.push(id);
      }
    });
    Object.keys(agentDirectory).forEach((id) => {
      if (!combined.includes(id)) {
        combined.push(id);
      }
    });
    return combined.map((id) => ({
      agentId: id,
      displayName: agentDirectory[id]?.displayName ?? "",
      role: agentDirectory[id]?.role ?? "NON_AGENT"
    }));
  }, [agentOptions, agentDirectory, agentOrder]);

  const customerMappingCount = Object.keys(idMapping).length;

  const hubOptions = useMemo(() => {
    const values = new Set<string>();
    sourceRows.forEach((row) => values.add(row.hub ?? "Unassigned"));
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
        mergeIdMapping(nextMapping);
      },
      error: () => {
        setMappingError("Unable to read the lookup CSV.");
      }
    });
  };

  const clearCustomerMapping = useCallback(() => {
    setIdMapping({});
    setMappingError(null);
  }, [setIdMapping]);

  const persistAgentDirectory = async (
    nextDirectory: Record<string, { displayName: string; role: AgentRole }>,
    nextOrder: string[]
  ) => {
    const entries = nextOrder.map((id) => ({
      user_id: id,
      display_name: nextDirectory[id]?.displayName ?? "",
      port_role: nextDirectory[id]?.role ?? "NON_AGENT"
    }));
    const response = await fetch(ROLE_DATA_ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries })
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || "Unable to save agent directory.");
    }
  };

  const handleAgentSave = async (
    agentId: string,
    payload: { displayName: string; role: AgentRole }
  ) => {
    const id = agentId.trim();
    if (!id) {
      return;
    }
    const displayName = payload.displayName.trim();
    const normalizedRole = normalizeAgentRole(payload.role);
    setAgentSaveState((prev) => ({ ...prev, [id]: "saving" }));
    const nextDirectory = {
      ...agentDirectory,
      [id]: { displayName, role: normalizedRole }
    };
    const nextOrder = agentOrder.includes(id) ? agentOrder : [...agentOrder, id];
    try {
      await persistAgentDirectory(nextDirectory, nextOrder);
      setAgentDirectory(nextDirectory);
      setAgentOrder(nextOrder);
      setAgentDirectoryError(null);
      if (displayName) {
        mergeIdMapping({ [id]: displayName });
      }
      updateAgentRole(id, normalizedRole);
      setAgentSaveState((prev) => ({ ...prev, [id]: "saved" }));
      setTimeout(() => {
        setAgentSaveState((prev) => ({ ...prev, [id]: "idle" }));
      }, 2000);
    } catch (error) {
      setAgentSaveState((prev) => ({ ...prev, [id]: "error" }));
      setAgentDirectoryError((error as Error).message ?? "Unable to save agent directory.");
    }
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

  const handleMisclassifiedDrilldown = useCallback(
    (agentId: string) => {
      if (!agentId) {
        return;
      }
      const agentRows = filteredRows.filter(
        (row) => row.contactReasonChange && row.agentList.includes(agentId)
      );
      if (!agentRows.length) {
        return;
      }
      const display = resolveDisplayName(agentId, idMapping, deAnonymize, agentNameMap);
      openDrilldown(`Misclassified: ${display.label}`, agentRows);
    },
    [filteredRows, idMapping, deAnonymize, agentNameMap]
  );

  const conversationCount = filteredRows.length;
  const datasetLatestTicket = useMemo(() => computeLatestTicketInfo(sourceRows), [sourceRows]);
  const latestTicket = useMemo(
    () => latestOnlineTicket ?? datasetLatestTicket,
    [latestOnlineTicket, datasetLatestTicket]
  );

  const lastRefreshTimestamp = refreshState.lastCompletedAt ?? lastRefreshCompletionRef.current ?? null;
  const hasPendingBacklog = Boolean((refreshState.pendingConversations ?? 0) > 0);
  const needsDataRefresh =
    !refreshState.running &&
    (!lastRefreshTimestamp || Date.now() - lastRefreshTimestamp > 15 * 60 * 1000 || hasPendingBacklog);
  const unresolvedFooterText = selectedResolvedStats.total
    ? `${unresolvedCount.toLocaleString()} of ${selectedResolvedStats.total.toLocaleString()} not resolved`
    : "No tickets in this window";

  return (
    <main className="min-h-screen bg-slate-950 pb-16">
      <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-4 rounded-3xl border border-amber-500/40 bg-gradient-to-br from-amber-500/10 via-slate-900/70 to-slate-950/60 p-6 shadow-xl">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-3xl font-bold text-white">Conversation Quality Command Center</h1>
                <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-200">
                  Early Alpha
                </span>
              </div>
              <p className="text-sm text-slate-200">
                Monitor Jira LLM-assisted conversations with real-time scoring, escalation trends, and toxicity alerts.
              </p>
            </div>
            <div className="flex flex-col items-end gap-3 text-right">
              <span className="text-xs font-semibold uppercase tracking-wide text-amber-300">
                Build #{buildNumber}
              </span>
              <div className="flex flex-col items-end gap-2">
                <div className="flex flex-wrap justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setIsManagerReviewOpen(true)}
                    className="rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-brand-500 hover:text-brand-200"
                  >
                    Manager review
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsSettingsOpen(true)}
                    className="rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-brand-500 hover:text-brand-200"
                  >
                    Settings
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleFetchData}
                  disabled={refreshState.running || !useOnlineData || process.env.NEXT_PUBLIC_REFRESH_DISABLED === "1"}
                  className={clsx(
                    "flex items-center justify-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition",
                    !useOnlineData
                      ? "cursor-not-allowed border-slate-800 text-slate-500"
                      : refreshState.running
                      ? "cursor-not-allowed border-slate-700 text-slate-500"
                      : hasPendingBacklog
                      ? "border-amber-400 text-amber-200 shadow-[0_0_0_0_rgba(251,191,36,0.4)] animate-pulse"
                      : needsDataRefresh
                      ? "border-amber-400 text-amber-200 hover:bg-amber-500/10"
                      : "border-slate-700 text-slate-200 hover:border-brand-500 hover:text-brand-200"
                  )}
                >
                  {refreshState.running && (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  )}
                  {!useOnlineData
                    ? "Switch to Online DB"
                    : refreshState.running
                    ? "Refreshing…"
                    : "Fetch data"}
                </button>
                <div className="space-y-1 text-xs text-slate-400">
                  <p className="flex items-center gap-2">
                    <StatusIcon
                      state={
                        refreshState.stage === "completed" || refreshState.stage === "processing"
                          ? "done"
                          : refreshState.stage === "ingesting"
                          ? "running"
                          : refreshState.error
                          ? "error"
                          : "idle"
                      }
                    />
                    {refreshState.stage === "error" && refreshState.error
                      ? `Fetch failed · ${refreshState.error}`
                      : refreshState.stage === "ingesting"
                      ? "Fetching latest Jira tickets…"
                      : refreshState.fetchedTickets != null
                      ? `Fetched ${refreshState.fetchedTickets} conversation${
                          refreshState.fetchedTickets === 1 ? "" : "s"
                        }${
                          refreshState.skippedTickets
                            ? `, ${refreshState.skippedTickets} skipped`
                            : ""
                        }`
                      : refreshState.message || "Fetch ready"}
                  </p>
                  <p className="flex items-center gap-2">
                    <StatusIcon
                      state={
                        refreshState.stage === "processing"
                          ? "running"
                          : refreshState.stage === "completed"
                          ? "done"
                          : refreshState.error
                          ? "error"
                          : "idle"
                      }
                    />
                    {refreshState.stage === "error" && refreshState.error ? (
                      `Processing halted · ${refreshState.error}`
                    ) : refreshState.stage === "processing" && refreshState.totalToProcess ? (
                      (() => {
                        const processed = refreshState.processedTickets ?? 0;
                        const total = refreshState.totalToProcess ?? 0;
                        const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
                        return (
                          <>
                            {`GPT processing ${percent}% (${processed}/${total})`}
                            {refreshState.etaSeconds ? ` · ${formatEta(refreshState.etaSeconds)}` : ""}
                          </>
                        );
                      })()
                    ) : refreshState.stage === "completed" ? (
                      `Processed ${refreshState.processedTickets ?? 0} conversations`
                    ) : (
                      refreshState.message || "Awaiting processing"
                    )}
                  </p>
                  {hasPendingBacklog && (
                    <p className="flex items-center gap-2 text-amber-200">
                      <StatusIcon state="idle" />
                      {`${refreshState.pendingConversations?.toLocaleString() ?? 0} conversation${
                        (refreshState.pendingConversations ?? 0) === 1 ? "" : "s"
                      } still queued · Press Fetch data again`}
                    </p>
                  )}
                  {refreshState.stage === "completed" && refreshState.lastCompletedAt ? (
                    <p>{`Updated ${formatRelativeTime(refreshState.lastCompletedAt)}.`}</p>
                  ) : null}
                  {refreshState.stage === "error" && refreshState.error && (
                    <p className="text-red-300">{refreshState.error}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-200">
            <span className="rounded-full border border-brand-500/40 bg-brand-500/15 px-3 py-1 text-brand-100">
              {conversationCount.toLocaleString()} conversations in view
            </span>
            {fileName && (
              <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-200">
                Active dataset: {fileName}
              </span>
            )}
            {latestTicket && (
              <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-200">
                Latest: {latestTicket.key}
                {latestTicket.dateLabel ? ` · ${latestTicket.dateLabel}` : ""}
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
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))]">
                <div className="w-full">
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
                  getLabel={(value) =>
                    resolveDisplayName(value, idMapping, deAnonymize, agentNameMap).label
                  }
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
              </div>
            </section>

            <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <KPICard
                title="Conversation Score"
                value={selectedRating}
                formatValue={(value) => (value === null ? "—" : `${value.toFixed(2)} / 5`)}
                series={ratingSeries}
                selectedWindow={selectedWindow}
                onClick={() => openDrilldown("Conversation Score", filteredRows)}
              />
              <KPICard
                title="Unresolved conversations"
                value={unresolvedPercentage}
                formatValue={(value) =>
                  value === null ? "—" : `${Math.round(value)}%`
                }
                footerText={unresolvedFooterText}
                series={resolvedSeries.map((entry) => ({
                  ...entry,
                  value:
                    entry.value === null
                      ? null
                      : 100 - entry.value,
                  count:
                    entry.total !== undefined && entry.count !== undefined
                      ? entry.total - entry.count
                      : entry.count
                }))}
                selectedWindow={selectedWindow}
                onClick={() => openDrilldown("Unresolved conversations", unresolvedRows)}
              />
              <KPICard
                title="Average time to resolution"
                value={selectedAverageDuration}
                formatValue={formatDurationValue}
                footerText="Mean duration_to_resolution"
                series={averageDurationSeries}
                selectedWindow={selectedWindow}
                onClick={() => openDrilldown("Average resolution duration", filteredRows)}
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
                  agentMapping={agentNameMap}
                  deAnonymize={deAnonymize}
                  roleMapping={roleMapping}
                />
              </div>
              <div className="lg:col-span-1">
                <ToxicityList
                  title="Most abusive customers"
                  subtitle={WINDOW_LABELS[selectedWindow]}
                  entries={toxicCustomers.slice(0, 5)}
                  emptyLabel="No abusive customer behaviour detected."
                  mapping={idMapping}
                  agentMapping={agentNameMap}
                  deAnonymize={deAnonymize}
                  entityLabel="Customer ID"
                />
              </div>
              <div className="lg:col-span-1">
                <ToxicityList
                  title="Flagged abusive agents"
                  subtitle={WINDOW_LABELS[selectedWindow]}
                  entries={flaggedAgents}
                  emptyLabel="No agents exceeded the toxicity threshold."
                  mapping={idMapping}
                  agentMapping={agentNameMap}
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
              agentMapping={agentNameMap}
              deAnonymize={deAnonymize}
              roleMapping={roleMapping}
              escalationMetric={escalationMetric}
              averageAgentScore={averageAgentScore}
              onSelectMisclassified={handleMisclassifiedDrilldown}
            />

            <CustomerSentimentPanel
              rows={filteredRows}
              referenceNow={referenceNow}
              window={selectedWindow}
            />
            <TicketVolumePanel rows={filteredRows} referenceNow={referenceNow} window={selectedWindow} />

            <ContactReasonPanel
              summary={contactReasonSummary}
              window={selectedWindow}
              onSelect={handleContactReasonSelect}
            />

          </div>

          <CommandCenterPanel
            onUploadConversations={handleConversationsFile}
            onLoadSampleData={loadSampleData}
            sampleDataActive={sampleDataActive}
            fileName={fileName}
            fileError={fileError}
            deAnonymize={deAnonymize}
            onToggleDeAnonymize={setDeAnonymize}
            customerMappingCount={customerMappingCount}
            conversationCount={sourceRows.length}
            mappingError={mappingError}
            onUploadCustomerMapping={handleMappingUpload}
            onClearCustomerMapping={clearCustomerMapping}
            agentEntries={agentDirectoryEntries}
            onAgentSave={handleAgentSave}
            agentSaveState={agentSaveState}
            agentDirectoryError={agentDirectoryError}
            usingOnlineData={useOnlineData}
            refreshStage={refreshState.stage}
          />
        </div>
      </div>

      <DrilldownTable
        open={Boolean(drilldownState)}
        metricLabel={drilldownState?.metricLabel ?? ""}
        rows={drilldownState?.rows ?? []}
        onClose={() => setDrilldownState(null)}
        mapping={idMapping}
        agentMapping={agentNameMap}
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
        agentMapping={agentNameMap}
        deAnonymize={deAnonymize}
        roleMapping={roleMapping}
      />

      <SettingsDrawer
        open={isSettingsOpen}
        settings={settings}
        onClose={() => setIsSettingsOpen(false)}
        onChange={setSettings}
        useOnlineData={useOnlineData}
        onToggleDataSource={setUseOnlineData}
      />
      <ManagerReviewPanel
        open={isManagerReviewOpen}
        onClose={() => setIsManagerReviewOpen(false)}
        rows={filteredRows}
        mapping={idMapping}
        agentMapping={agentNameMap}
        deAnonymize={deAnonymize}
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

function formatDurationValue(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "—";
  }
  if (value >= 60) {
    const hours = Math.floor(value / 60);
    const minutes = Math.round(value % 60);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${value.toFixed(1)}m`;
}

function formatShortDate(date: Date | null): string | null {
  if (!date) {
    return null;
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[date.getUTCMonth()];
  const day = date.getUTCDate();
  let hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) {
    hours = 12;
  }
  const paddedMinutes = minutes.toString().padStart(2, "0");
  return `${month} ${day}, ${hours}:${paddedMinutes} ${ampm} UTC`;
}

function formatEta(seconds: number): string {
  if (seconds <= 0) {
    return "finishing up";
  }
  if (seconds < 60) {
    return `${Math.max(1, Math.round(seconds))}s remaining`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes}m remaining`;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) {
    return "just now";
  }
  if (diff < 3_600_000) {
    const minutes = Math.round(diff / 60_000);
    return `${minutes}m ago`;
  }
  if (diff < 86_400_000) {
    const hours = Math.round(diff / 3_600_000);
    return `${hours}h ago`;
  }
  const days = Math.round(diff / 86_400_000);
  return `${days}d ago`;
}

function resolveLatestReferenceDate(rows: ConversationRow[]): Date | null {
  let latest: Date | null = null;
  rows.forEach((row) => {
    const candidate = row.endedAt ?? row.startedAt;
    if (candidate && (!latest || candidate.getTime() > latest.getTime())) {
      latest = candidate;
    }
  });
  return latest;
}

function computeLatestTicketInfo(rows: ConversationRow[]): LatestTicketInfo | null {
  if (!rows.length) {
    return null;
  }
  let latestRow: ConversationRow | null = null;
  let latestTime = 0;
  rows.forEach((row) => {
    const reference = row.endedAt ?? row.startedAt;
    if (!reference) {
      return;
    }
    const time = reference.getTime();
    if (!latestRow || time > latestTime) {
      latestRow = row;
      latestTime = time;
    }
  });
  if (!latestRow) {
    return null;
  }
  const resolvedRow: ConversationRow = latestRow;
  const reference = resolvedRow.endedAt ?? resolvedRow.startedAt ?? null;
  return {
    key: resolvedRow.issueKey,
    dateLabel: formatShortDate(reference)
  };
}

function StatusIcon({ state }: { state: "running" | "done" | "error" | "idle" }) {
  if (state === "running") {
    return (
      <span className="inline-flex h-3 w-3 animate-spin rounded-full border border-current border-t-transparent text-amber-300" />
    );
  }
  if (state === "done") {
    return (
      <span className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-emerald-400 text-[8px] text-slate-900">
        ✓
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-red-400 text-[8px] text-slate-900">
        !
      </span>
    );
  }
  return <span className="inline-flex h-3 w-3 rounded-full border border-slate-600" />;
}

export const getStaticProps: GetStaticProps<DashboardPageProps> = async () => {
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const csvPath = path.join(process.cwd(), "data", "port_roles.csv");
    const csvText = await fs.readFile(csvPath, "utf-8");
    const parsed = Papa.parse<Record<string, string | null | undefined>>(csvText, {
      header: true,
      skipEmptyLines: true
    });
    const directory: AgentDirectoryState = {};
    const order: string[] = [];
    parsed.data.forEach((row) => {
      if (!row) {
        return;
      }
      const userId = (
        row.user_id ?? row.userId ?? row.id ?? (row as Record<string, unknown>).agent_id ?? ""
      )
        .toString()
        .trim();
      if (!userId) {
        return;
      }
      if (!order.includes(userId)) {
        order.push(userId);
      }
      const displayName = (
        row.display_name ?? row.displayName ?? row.name ?? row.agent_name ?? ""
      )
        .toString()
        .trim();
      const roleValue = (
        row.port_role ?? row.portRole ?? row.role ?? (row as Record<string, unknown>).agent_role ?? ""
      )
        .toString()
        .trim();
      directory[userId] = {
        displayName,
        role: normalizeAgentRole(roleValue)
      };
    });
    return {
      props: {
        initialAgentDirectory: directory,
        initialAgentOrder: order
      }
    };
  } catch (error) {
    console.warn("Failed to preload agent directory:", error);
    return {
      props: {
        initialAgentDirectory: {},
        initialAgentOrder: []
      }
    };
  }
};

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
