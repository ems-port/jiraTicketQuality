import { AgentRole } from "@/types";

export const AGENT_ROLE_ORDER: AgentRole[] = ["TIER1", "TIER2", "NON_AGENT"];

const ROLE_LABELS: Record<AgentRole, string> = {
  TIER1: "Tier 1",
  TIER2: "Tier 2",
  NON_AGENT: "Non agent"
};

const ROLE_SHORT_LABELS: Record<AgentRole, string> = {
  TIER1: "T1",
  TIER2: "T2",
  NON_AGENT: "--"
};

export function formatRoleLabel(role: AgentRole, short = false): string {
  return short ? ROLE_SHORT_LABELS[role] : ROLE_LABELS[role];
}

export function resolveAgentRole(
  agentId: string | null | undefined,
  mapping: Record<string, AgentRole | undefined>
): AgentRole {
  if (!agentId) {
    return "NON_AGENT";
  }
  return mapping[agentId] ?? "NON_AGENT";
}

export function normalizeAgentRole(value: unknown): AgentRole {
  if (typeof value !== "string") {
    return "NON_AGENT";
  }
  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    return "NON_AGENT";
  }
  if (["T1", "TIER1", "TIER 1"].includes(normalized)) {
    return "TIER1";
  }
  if (["T2", "TIER2", "TIER 2"].includes(normalized)) {
    return "TIER2";
  }
  if (["NON_AGENT", "NONAGENT", "NON-AGENT", "NONE", "--"].includes(normalized)) {
    return "NON_AGENT";
  }
  return normalized === "AGENT" ? "TIER1" : "NON_AGENT";
}

export function sortRoles(a: AgentRole, b: AgentRole): number {
  return AGENT_ROLE_ORDER.indexOf(a) - AGENT_ROLE_ORDER.indexOf(b);
}
