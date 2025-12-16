import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { AgentRole, ConversationRow, SettingsState } from "@/types";

const DEFAULT_SETTINGS: SettingsState = {
  toxicity_threshold: 0.8,
  abusive_caps_trigger: 5,
  min_msgs_for_toxicity: 3
};

const IS_VERCEL =
  typeof process !== "undefined" && (process.env.VERCEL === "1" || process.env.NEXT_PUBLIC_VERCEL === "1");

type IdMapping = Record<string, string>;
type RoleMapping = Record<string, AgentRole>;

interface DashboardState {
  rows: ConversationRow[];
  sampleDataActive: boolean;
  deAnonymize: boolean;
  settings: SettingsState;
  debugLLM: boolean;
  idMapping: IdMapping;
  roleMapping: RoleMapping;
  setRows: (rows: ConversationRow[], options?: { sampleData?: boolean }) => void;
  clearRows: () => void;
  setSampleDataActive: (active: boolean) => void;
  setDeAnonymize: (value: boolean) => void;
  setSettings: (next: SettingsState) => void;
  setDebugLLM: (value: boolean) => void;
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
      settings: DEFAULT_SETTINGS,
      debugLLM: false,
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
      setSettings: (next) => set({ settings: next }),
      setDebugLLM: (value) => set({ debugLLM: value }),
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
        deAnonymize: state.deAnonymize,
        settings: state.settings
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) {
          return;
        }
        if (IS_VERCEL) {
          state.debugLLM = false;
        }
      }
    }
  )
);
