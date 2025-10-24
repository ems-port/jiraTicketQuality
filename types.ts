export type TimeWindow = "24h" | "7d" | "30d";

export interface SettingsState {
  toxicity_threshold: number;
  abusive_caps_trigger: number;
  min_msgs_for_toxicity: number;
}

export interface ConversationRow {
  issueKey: string;
  agent: string;
  agentList: string[];
  customerList: string[];
  resolved: boolean;
  startedAt: Date | null;
  endedAt: Date | null;
  durationMinutes: number | null;
  firstAgentResponseMinutes: number | null;
  avgAgentResponseMinutes: number | null;
  messagesTotal: number | null;
  messagesAgent: number | null;
  messagesCustomer: number | null;
  customerAbuseCount: number | null;
  customerAbuseDetected: boolean;
  agentProfanityDetected: boolean;
  agentProfanityCount: number | null;
  agentScore: number | null;
  customerScore: number | null;
  conversationRating: number | null;
  totalScore: number | null;
  improvementTip: string | null;
  ticketSummary: string | null;
  contactReason: string | null;
  contactReasonOriginal: string | null;
  hub?: string | null;
  model?: string | null;
  agentToxicityScore?: number | null;
  agentAbusiveFlag?: boolean;
  customerToxicityScore?: number | null;
  customerAbusiveFlag?: boolean;
  escalated: boolean;
  raw: Record<string, unknown>;
}

export interface MetricSeries {
  window: TimeWindow;
  value: number | null;
  count?: number;
  total?: number;
}

export interface AgentPerformancePoint {
  date: string;
  meanScore: number | null;
}

export interface AgentPerformance {
  agent: string;
  meanScore: number | null;
  sparkline: AgentPerformancePoint[];
  issues: string[];
}

export interface ToxicityEntry {
  entity: string;
  meanToxicity: number;
  ticketKeys: string[];
  messageCount: number;
}

export interface AgentMatrixRow {
  agent: string;
  avgFirstResponseMinutes: number | null;
  avgAgentResponseMinutes: number | null;
  resolvedRate: number | null;
  escalatedCount: number;
}

export interface ImprovementTipEntry {
  tip: string;
  count: number;
  issueKeys: string[];
  agents: string[];
  lastSeen: Date | null;
}

export interface ImprovementTipSummary {
  entries: ImprovementTipEntry[];
  topEntries: ImprovementTipEntry[];
  total: number;
  unique: number;
  windowStart: Date;
  windowEnd: Date;
}

export interface ContactReasonSparkPoint {
  label: string;
  count: number;
}

export interface ContactReasonTrendEntry {
  reason: string;
  count: number;
  percentage: number;
  sparkline: ContactReasonSparkPoint[];
  recentIssues: string[];
}

export interface ContactReasonSummary {
  entries: ContactReasonTrendEntry[];
  total: number;
}
