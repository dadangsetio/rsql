import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { QueryResult } from "@/types";
import { useProjectStore } from "@/stores/project-store";
import { ProjectConnectionStatus } from "@/types";

export function nextActiveTabAfterClose(openTabs: string[], closingPid: string, currentActive: string | null): string | null {
  if (currentActive !== closingPid) return currentActive;
  const idx = openTabs.indexOf(closingPid);
  const remaining = openTabs.filter((pid) => pid !== closingPid);
  if (remaining.length === 0) return null;
  const prevIdx = Math.max(0, idx - 1);
  return remaining[Math.min(prevIdx, remaining.length - 1)];
}

interface PinnedResult {
  columns: string[];
  rows: string[][];
  label: string;
}

interface UIState {
  theme: "light" | "dark";
  sidebarWidth: number;
  editorHeightVertical: number;
  editorHeightHorizontal: number;
  connectionModalOpen: boolean;
  viewMode: "grid" | "record";
  selectedRow: number;
  pinnedResult: PinnedResult | null;
  editorCollapsed: boolean;
  editorPosition: "top" | "right" | "bottom" | "left";
  activeServerFp: string | null;
  openDatabaseTabs: string[];
  activeDatabaseTab: string | null;

  toggleTheme: () => void;
  setTheme: (theme: "light" | "dark") => void;
  setSidebarWidth: (delta: number) => void;
  setEditorHeight: (delta: number) => void;
  setConnectionModalOpen: (open: boolean) => void;
  setViewMode: (mode: "grid" | "record") => void;
  setSelectedRow: (row: number | ((prev: number) => number)) => void;
  pinResult: (result: QueryResult, label: string) => void;
  clearPinnedResult: () => void;
  toggleEditorCollapsed: () => void;
  cyclePanelPosition: () => void;
  setActiveServerFp: (fp: string | null) => void;
  openDatabaseTab: (projectId: string) => void;
  closeDatabaseTab: (projectId: string) => void;
  setActiveDatabaseTab: (projectId: string) => void;
}

const PANEL_POSITION_CYCLE = ["bottom", "right", "top", "left"] as const;

export const useUIStore = create<UIState>()(
  immer((set, get) => ({
    theme: "light",
    sidebarWidth: 280,
    editorHeightVertical: 50,
    editorHeightHorizontal: 50,
    connectionModalOpen: false,
    viewMode: "grid",
    selectedRow: 0,
    pinnedResult: null,
    editorCollapsed: false,
    editorPosition: "bottom",
    activeServerFp: null,
    openDatabaseTabs: [],
    activeDatabaseTab: null,

    toggleTheme: () => {
      set((s) => {
        s.theme = s.theme === "light" ? "dark" : "light";
        if (s.theme === "dark") {
          document.documentElement.classList.add("dark");
        } else {
          document.documentElement.classList.remove("dark");
        }
      });
    },

    setTheme: (theme) => {
      if (theme === "dark") {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
      set({ theme });
    },

    setSidebarWidth: (delta) => {
      set((s) => {
        s.sidebarWidth = Math.max(180, Math.min(700, s.sidebarWidth + delta));
      });
    },

    setEditorHeight: (delta) => {
      const { editorPosition, sidebarWidth } = get();
      const isHorizontal = editorPosition === "left" || editorPosition === "right";
      const containerSize = isHorizontal
        ? window.innerWidth - sidebarWidth
        : window.innerHeight - 48 - 24;
      const deltaPercent = (delta / containerSize) * 100;
      set((s) => {
        const key = isHorizontal ? "editorHeightHorizontal" : "editorHeightVertical";
        s[key] = Math.max(20, Math.min(80, s[key] + deltaPercent));
      });
    },

    setConnectionModalOpen: (open) => set({ connectionModalOpen: open }),

    setViewMode: (mode) => set({ viewMode: mode }),

    setSelectedRow: (row) => {
      set((s) => {
        s.selectedRow = typeof row === "function" ? row(s.selectedRow) : row;
      });
    },

    pinResult: (result, label) => {
      set((s) => {
        s.pinnedResult = { columns: result.columns, rows: result.rows, label };
      });
    },

    clearPinnedResult: () => set({ pinnedResult: null }),

    toggleEditorCollapsed: () => set((s) => { s.editorCollapsed = !s.editorCollapsed; }),
    cyclePanelPosition: () => set((s) => {
      const next = PANEL_POSITION_CYCLE[(PANEL_POSITION_CYCLE.indexOf(s.editorPosition) + 1) % PANEL_POSITION_CYCLE.length];
      s.editorPosition = next;
    }),

    setActiveServerFp: (fp) => set({ activeServerFp: fp }),

    setActiveDatabaseTab: (projectId) => set({ activeDatabaseTab: projectId }),

    openDatabaseTab: (projectId) => {
      set((s) => {
        if (!s.openDatabaseTabs.includes(projectId)) s.openDatabaseTabs.push(projectId);
        s.activeDatabaseTab = projectId;
      });
      const status = useProjectStore.getState().status[projectId];
      if (status !== ProjectConnectionStatus.Connected && status !== ProjectConnectionStatus.Connecting) {
        void useProjectStore.getState().connect(projectId);
      }
    },

    closeDatabaseTab: (projectId) => {
      const { openDatabaseTabs, activeDatabaseTab } = get();
      const nextActive = nextActiveTabAfterClose(openDatabaseTabs, projectId, activeDatabaseTab);
      set((s) => {
        s.openDatabaseTabs = s.openDatabaseTabs.filter((pid) => pid !== projectId);
        s.activeDatabaseTab = nextActive;
      });
      useProjectStore.setState((s) => ({ status: { ...s.status, [projectId]: ProjectConnectionStatus.Disconnected } }));
    },
  })),
);
