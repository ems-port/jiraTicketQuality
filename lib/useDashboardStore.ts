import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { ConversationRow } from "@/types";

type IdMapping = Record<string, string>;

interface DashboardState {
  rows: ConversationRow[];
  sampleDataActive: boolean;
  deAnonymize: boolean;
  idMapping: IdMapping;
  setRows: (rows: ConversationRow[], options?: { sampleData?: boolean }) => void;
  clearRows: () => void;
  setSampleDataActive: (active: boolean) => void;
  setDeAnonymize: (value: boolean) => void;
  setIdMapping: (mapping: IdMapping) => void;
  mergeIdMapping: (mapping: IdMapping) => void;
}

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set, get) => ({
      rows: [],
      sampleDataActive: false,
      deAnonymize: false,
      idMapping: {},
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
      }
    }),
    {
      name: "conversation-quality-dashboard",
      partialize: (state) => ({
        deAnonymize: state.deAnonymize,
        idMapping: state.idMapping
      })
    }
  )
);
