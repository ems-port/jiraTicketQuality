import { resolveAgentRole } from "@/lib/roles";
import type { AgentRole, ConversationRow, EscalationMetricKind } from "@/types";

export interface EscalationDetails {
  legacy: boolean;
  tierHandoff: boolean;
  handoffAny: boolean;
  path: string;
  owner: string | null;
}

const ROLE_LABEL_FOR_PATH: Record<AgentRole, string> = {
  TIER1: "T1",
  TIER2: "T2",
  NON_AGENT: "NON_USER"
};

export function getEscalationDetails(
  row: ConversationRow,
  roleMapping: Record<string, AgentRole>
): EscalationDetails {
  const sequence = buildAgentSequence(row.agentList);
  const legacy = row.escalated ?? (sequence.length > 1);
  if (!sequence.length) {
    return { legacy, tierHandoff: false, handoffAny: false, path: "", owner: null };
  }
  const roleSequence = sequence.map((agentId) => resolveAgentRole(agentId, roleMapping));
  const firstTier1Index = roleSequence.findIndex((role) => role === "TIER1");
  if (firstTier1Index === -1) {
    return { legacy, tierHandoff: false, handoffAny: false, path: "", owner: null };
  }
  const owner = sequence[firstTier1Index] ?? null;
  const pathDetails = detectEscalation(roleSequence, firstTier1Index);
  return {
    legacy,
    owner,
    ...pathDetails
  };
}

export function isEscalated(
  row: ConversationRow,
  roleMapping: Record<string, AgentRole>,
  kind: EscalationMetricKind
): boolean {
  const details = getEscalationDetails(row, roleMapping);
  return kind === "tier" ? details.tierHandoff : details.handoffAny;
}

function detectEscalation(
  roleSequence: AgentRole[],
  firstTier1Index: number
): { tierHandoff: boolean; handoffAny: boolean; path: string } {
  let pathCaptured = "";
  let handoffAny = false;
  let tierHandoff = false;
  for (let index = firstTier1Index + 1; index < roleSequence.length; index += 1) {
    const role = roleSequence[index]!;
    if (!handoffAny) {
      handoffAny = true;
      pathCaptured = `T1→${ROLE_LABEL_FOR_PATH[role] ?? "UNKNOWN"}`;
    }
    if (role === "TIER2") {
      tierHandoff = true;
      break;
    }
  }
  return { tierHandoff, handoffAny, path: pathCaptured };
}

function buildAgentSequence(agentList: string[]): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  agentList.forEach((agent) => {
    const trimmed = agent?.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    order.push(trimmed);
  });
  return order;
}
