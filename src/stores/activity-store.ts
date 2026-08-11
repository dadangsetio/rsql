import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

export type ActivityLevel = "info" | "success" | "error";

export interface ActivityEntry {
  id: string;
  timestamp: number;
  level: ActivityLevel;
  message: string;
  detail?: string;
}

interface ActivityState {
  entries: ActivityEntry[];
  log: (level: ActivityLevel, message: string, detail?: string) => void;
  clear: () => void;
}

let activityId = 0;

export const useActivityStore = create<ActivityState>()(
  immer((set) => ({
    entries: [],

    log: (level, message, detail) => {
      set((s) => {
        s.entries.unshift({
          id: `act-${++activityId}`,
          timestamp: Date.now(),
          level,
          message,
          detail,
        });
        s.entries.length = Math.min(s.entries.length, 500);
      });
    },

    clear: () => set({ entries: [] }),
  })),
);
