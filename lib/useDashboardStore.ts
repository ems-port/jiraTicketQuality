import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { AgentRole, ConversationRow } from "@/types";

type IdMapping = Record<string, string>;
type RoleMapping = Record<string, AgentRole>;

interface DashboardState {
  rows: ConversationRow[];
  sampleDataActive: boolean;
  deAnonymize: boolean;
  idMapping: IdMapping;
  roleMapping: RoleMapping;
  setRows: (rows: ConversationRow[], options?: { sampleData?: boolean }) => void;
  clearRows: () => void;
  setSampleDataActive: (active: boolean) => void;
  setDeAnonymize: (value: boolean) => void;
  setIdMapping: (mapping: IdMapping) => void;
  mergeIdMapping: (mapping: IdMapping) => void;
  setRoleMapping: (mapping: RoleMapping) => void;
  mergeRoleMapping: (mapping: RoleMapping) => void;
  updateAgentRole: (agentId: string, role: AgentRole) => void;
}

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set, get) => ({
      rows: [],
      sampleDataActive: false,
      deAnonymize: false,
      idMapping: {},
      roleMapping: {},
      setRows: (rows, options) => {
        const isSample = options?.sampleData ?? false;
        set({
          rows,
          sampleDataActive: isSample
        });
      },
      clearRows: () => set({ rows: [], sampleDataActive: false }),
      setSampleDataActive: (active) => set({ sampleDataActive: active }),
      setDeAnonymize: (value) => set({ deAnonymize: value }),
      setIdMapping: (mapping) => set({ idMapping: mapping }),
      mergeIdMapping: (mapping) => {
        const next = { ...get().idMapping, ...mapping };
        set({ idMapping: next });
      },
      setRoleMapping: (mapping) => set({ roleMapping: mapping }),
      mergeRoleMapping: (mapping) => {
        const next = { ...get().roleMapping, ...mapping };
        set({ roleMapping: next });
      },
      updateAgentRole: (agentId, role) => {
        if (!agentId) {
          return;
        }
        const current = get().roleMapping;
        set({ roleMapping: { ...current, [agentId]: role } });
      }
    }),
    {
      name: "conversation-quality-dashboard",
      partialize: (state) => ({
        deAnonymize: state.deAnonymize
      })
    }
  )
);
