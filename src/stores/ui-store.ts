import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { QueryResult } from "@/types";

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
  })),
);
