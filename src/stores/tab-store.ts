import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { EditSession } from "@/lib/mutations";
import type { CellValue } from "@/lib/wire";
import type {
  ExplainPlan,
  FilterState,
  ObjectPanelSpec,
  QueryResult,
  SortState,
  Tab,
  VirtualQuery,
} from "@/types";

let nextId = 1;
function genTabId(): string {
  return `tab-${nextId++}-${Date.now()}`;
}

/** Restored tabs must satisfy Tab's required fields even if a corrupted or
 *  older-schema localStorage entry is missing them, otherwise unguarded
 *  reads like `tab.editorValue.trim()` elsewhere crash on restore. */
export function mergePersistedTabs(
  persistedTabs: unknown[],
  selectedTabIndex: unknown,
): { tabs: Tab[]; selectedTabIndex: number } {
  if (persistedTabs.length === 0) return { tabs: [], selectedTabIndex: -1 };
  const validTabs = persistedTabs
    .filter(
      (t): t is Record<string, unknown> =>
        t != null &&
        typeof t === "object" &&
        typeof (t as Record<string, unknown>).id === "string" &&
        typeof (t as Record<string, unknown>).type === "string" &&
        typeof (t as Record<string, unknown>).title === "string",
    )
    .map(
      (t) =>
        ({
          ...t,
          editorValue: typeof t.editorValue === "string" ? t.editorValue : "",
          isExecuting: false,
        }) as Tab,
    );
  if (validTabs.length === 0) return { tabs: [], selectedTabIndex: -1 };
  const idx = Math.min(Math.max(0, Number(selectedTabIndex) || 0), validTabs.length - 1);
  return { tabs: validTabs, selectedTabIndex: idx };
}

interface TabState {
  tabs: Tab[];
  selectedTabIndex: number;

  openTab: (projectId?: string, editorValue?: string, title?: string) => void;
  duplicateTab: (index: number) => void;
  openMonitorTab: (projectId: string) => void;
  openERDTab: (projectId: string, schema: string) => void;
  openNewTableTab: (projectId: string, schema: string) => void;
  openObjectPanelTab: (projectId: string, spec: ObjectPanelSpec) => void;
  openTerminalTab: () => void;
  openNotifyTab: (projectId: string) => void;
  openRolesTab: (projectId: string) => void;
  openSchemaDiffTab: (projectId: string) => void;
  openExtensionsTab: (projectId: string) => void;
  openEnumsTab: (projectId: string) => void;
  openPgSettingsTab: (projectId: string) => void;
  closeTab: (index: number) => void;
  closeTabById: (tabId: string) => void;
  closeAllTabs: () => void;
  closeOtherTabs: (index: number) => void;
  selectTab: (index: number) => void;
  togglePinTab: (tabId: string) => void;
  updateContent: (tabId: string, value: string) => void;
  updateResult: (tabId: string, result: QueryResult) => void;
  appendResult: (tabId: string, result: QueryResult) => void;
  selectResult: (tabId: string, index: number) => void;
  setResult: (tabId: string, result: QueryResult) => void;
  setExecuting: (tabId: string, executing: boolean, execId?: string) => void;
  setProjectId: (tabId: string, projectId: string) => void;
  setExplainResult: (tabId: string, plan: ExplainPlan | undefined) => void;
  setVirtualQuery: (tabId: string, vq: VirtualQuery | undefined) => void;
  setFilter: (tabId: string, filter: FilterState | undefined) => void;
  setSort: (tabId: string, sort: SortState | undefined) => void;
  setPropertiesTarget: (tabId: string, target: Tab["propertiesTarget"]) => void;
  setShowProperties: (tabId: string, show: boolean) => void;
  toggleSplit: (tabId: string) => void;
  updateSplitContent: (tabId: string, value: string) => void;
  setSplitResult: (tabId: string, result: QueryResult) => void;
  setSplitExecuting: (tabId: string, executing: boolean) => void;
  setQueryTimeout: (tabId: string, timeout: number) => void;

  startEditSession: (tabId: string, session: EditSession) => void;
  discardEditSession: (tabId: string) => void;
  setCellEdit: (tabId: string, key: string, column: string, value: CellValue | undefined) => void;
  setRowDeleted: (tabId: string, key: string, deleted: boolean) => void;
  setInsertCell: (tabId: string, draftId: string, column: string, value: CellValue) => void;
  unsetInsertCell: (tabId: string, draftId: string, column: string) => void;
  removeInsertRow: (tabId: string, draftId: string) => void;
}

/// Tabs are addressed by id, never by index: an index captured before an await
/// can point at a different tab, or past the end, by the time the action runs.
/// A tab that has since been closed makes the action a no-op.
function withTab(state: TabState, tabId: string, apply: (tab: Tab) => void): void {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (tab) apply(tab);
}

function removeTabAt(state: TabState, index: number): void {
  state.tabs.splice(index, 1);
  if (state.tabs.length === 0) {
    state.selectedTabIndex = -1;
  } else if (state.selectedTabIndex >= state.tabs.length) {
    state.selectedTabIndex = state.tabs.length - 1;
  } else if (state.selectedTabIndex > index) {
    state.selectedTabIndex--;
  } else if (state.selectedTabIndex === index && state.selectedTabIndex > 0) {
    state.selectedTabIndex--;
  }
}

function makeSingletonTab(
  type: Tab["type"],
  projectId: string,
  title: string,
  schema?: string,
): (s: TabState) => void {
  return (s) => {
    const existing = s.tabs.findIndex(
      (t) => t.type === type && t.projectId === projectId && (!schema || t.schema === schema),
    );
    if (existing >= 0) {
      s.selectedTabIndex = existing;
      return;
    }
    const newTab: Tab = {
      id: genTabId(),
      type,
      projectId,
      schema,
      title,
      editorValue: "",
      isExecuting: false,
    };
    s.tabs.push(newTab);
    s.selectedTabIndex = s.tabs.length - 1;
  };
}

export const useTabStore = create<TabState>()(
  persist(
    immer((set) => ({
      tabs: [
        {
          id: genTabId(),
          type: "query",
          title: "Query 1",
          editorValue: "",
          isExecuting: false,
        },
      ],
      selectedTabIndex: 0,

      openTab: (projectId?: string, editorValue: string = "", title?: string) => {
        set((s) => {
          s.tabs.push({
            id: genTabId(),
            type: "query",
            projectId,
            title: title ?? `Query ${s.tabs.length + 1}`,
            editorValue,
            isExecuting: false,
          });
          s.selectedTabIndex = s.tabs.length - 1;
        });
      },

      duplicateTab: (index) => {
        set((s) => {
          const tab = s.tabs[index];
          if (!tab) return;
          s.tabs.splice(index + 1, 0, {
            ...tab,
            id: genTabId(),
            title: `${tab.title} (copy)`,
            isExecuting: false,
            execId: undefined,
            result: undefined,
            results: undefined,
            activeResultIndex: undefined,
            explainResult: undefined,
            virtualQuery: undefined,
            splitResult: undefined,
            isSplitExecuting: false,
            editSession: undefined,
            filter: undefined,
            sort: undefined,
            showProperties: false,
          });
          s.selectedTabIndex = index + 1;
        });
      },

      openMonitorTab: (projectId) => set(makeSingletonTab("monitor", projectId, "Monitor")),
      openERDTab: (projectId, schema) =>
        set(makeSingletonTab("erd", projectId, `ERD: ${schema}`, schema)),
      openNewTableTab: (projectId, schema) => {
        set((s) => {
          s.tabs.push({
            id: genTabId(),
            type: "query",
            projectId,
            newTableSchema: schema,
            title: "New Table",
            editorValue: "",
            isExecuting: false,
          });
          s.selectedTabIndex = s.tabs.length - 1;
        });
      },
      openObjectPanelTab: (projectId, spec) => {
        set((s) => {
          const kindLabel =
            spec.kind === "view"
              ? "View"
              : spec.kind === "matview"
                ? "Materialized View"
                : spec.isProcedure
                  ? "Procedure"
                  : "Function";
          const title = spec.name ? `Edit ${kindLabel}: ${spec.name}` : `New ${kindLabel}`;
          s.tabs.push({
            id: genTabId(),
            type: "query",
            projectId,
            schema: spec.schema,
            objectPanel: spec,
            title,
            editorValue: "",
            isExecuting: false,
          });
          s.selectedTabIndex = s.tabs.length - 1;
        });
      },
      openTerminalTab: () => {
        set((s) => {
          s.tabs.push({
            id: genTabId(),
            type: "terminal",
            title: "Terminal",
            editorValue: "",
            isExecuting: false,
          });
          s.selectedTabIndex = s.tabs.length - 1;
        });
      },
      openNotifyTab: (projectId) => set(makeSingletonTab("notify", projectId, "LISTEN/NOTIFY")),
      openRolesTab: (projectId) => set(makeSingletonTab("roles", projectId, "Roles")),
      openSchemaDiffTab: (projectId) =>
        set(makeSingletonTab("schema-diff", projectId, "Schema Diff")),
      openExtensionsTab: (projectId) =>
        set(makeSingletonTab("extensions", projectId, "Extensions")),
      openEnumsTab: (projectId) => set(makeSingletonTab("enums", projectId, "Enum Types")),
      openPgSettingsTab: (projectId) =>
        set(makeSingletonTab("pg-settings", projectId, "PG Settings")),

      closeTab: (index) => {
        set((s) => {
          removeTabAt(s, index);
        });
      },

      closeTabById: (tabId) => {
        set((s) => {
          const index = s.tabs.findIndex((t) => t.id === tabId);
          if (index < 0) return;
          removeTabAt(s, index);
        });
      },

      closeAllTabs: () =>
        set((s) => {
          const kept = s.tabs.filter((t) => t.pinned);
          s.tabs = kept;
          s.selectedTabIndex = kept.length === 0 ? -1 : 0;
        }),

      closeOtherTabs: (index) => {
        set((s) => {
          const keep = s.tabs[index];
          if (!keep) return;
          const kept = s.tabs.filter((t, i) => i === index || t.pinned);
          s.tabs = kept;
          s.selectedTabIndex = kept.findIndex((t) => t.id === keep.id);
        });
      },

      selectTab: (index) =>
        set((s) => {
          s.selectedTabIndex = index;
        }),

      togglePinTab: (tabId) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.pinned = !tab.pinned;
          });
        }),

      updateContent: (tabId, value) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.editorValue = value;
          });
        }),
      updateResult: (tabId, result) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.result = result;
            tab.results = [result];
            tab.activeResultIndex = 0;
            tab.isExecuting = false;
            tab.execId = undefined;
          });
        }),
      // Adds another group's result onto a run already started by updateResult,
      // without touching isExecuting — the batch is still going.
      appendResult: (tabId, result) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.results ??= [];
            tab.results.push(result);
            tab.activeResultIndex = tab.results.length - 1;
            tab.result = result;
          });
        }),
      selectResult: (tabId, index) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            const r = tab.results?.[index];
            if (!r) return;
            tab.activeResultIndex = index;
            tab.result = r;
          });
        }),
      setResult: (tabId, result) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.result = result;
          });
        }),
      setExecuting: (tabId, executing, execId) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.isExecuting = executing;
            tab.execId = executing ? execId : undefined;
          });
        }),
      setProjectId: (tabId, projectId) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.projectId = projectId;
          });
        }),
      setExplainResult: (tabId, plan) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.explainResult = plan;
          });
        }),
      setVirtualQuery: (tabId, vq) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.virtualQuery = vq;
          });
        }),
      setFilter: (tabId, filter) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.filter = filter;
          });
        }),
      setSort: (tabId, sort) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.sort = sort;
          });
        }),
      setPropertiesTarget: (tabId, target) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.propertiesTarget = target;
          });
        }),
      setShowProperties: (tabId, show) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.showProperties = show;
          });
        }),

      toggleSplit: (tabId) => {
        set((s) => {
          withTab(s, tabId, (tab) => {
            if (tab.type !== "query") return;
            tab.isSplit = !tab.isSplit;
            tab.splitEditorValue = tab.splitEditorValue ?? "";
          });
        });
      },

      updateSplitContent: (tabId, value) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.splitEditorValue = value;
          });
        }),
      setSplitResult: (tabId, result) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.splitResult = result;
            tab.isSplitExecuting = false;
          });
        }),
      setSplitExecuting: (tabId, executing) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.isSplitExecuting = executing;
          });
        }),
      setQueryTimeout: (tabId, timeout) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.queryTimeout = timeout;
          });
        }),

      startEditSession: (tabId, session) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.editSession = session;
          });
        }),

      discardEditSession: (tabId) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            tab.editSession = undefined;
          });
        }),

      // `undefined` means the cell was returned to its original value, so the
      // pending edit is dropped rather than recorded as a no-op assignment.
      setCellEdit: (tabId, key, column, value) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            const session = tab.editSession;
            if (!session) return;
            if (value === undefined) {
              const columns = session.edits[key];
              if (!columns) return;
              delete columns[column];
              if (Object.keys(columns).length === 0) delete session.edits[key];
              return;
            }
            session.edits[key] ??= {};
            session.edits[key][column] = value;
          });
        }),

      setRowDeleted: (tabId, key, deleted) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            const session = tab.editSession;
            if (!session) return;
            const marked = session.deletes.includes(key);
            if (deleted && !marked) session.deletes.push(key);
            if (!deleted && marked) {
              session.deletes = session.deletes.filter((k) => k !== key);
            }
          });
        }),

      setInsertCell: (tabId, draftId, column, value) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            const session = tab.editSession;
            if (!session) return;
            session.inserts[draftId] ??= {};
            session.inserts[draftId][column] = value;
          });
        }),

      unsetInsertCell: (tabId, draftId, column) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            const columns = tab.editSession?.inserts[draftId];
            if (!columns) return;
            delete columns[column];
          });
        }),

      removeInsertRow: (tabId, draftId) =>
        set((s) => {
          withTab(s, tabId, (tab) => {
            const session = tab.editSession;
            if (!session) return;
            delete session.inserts[draftId];
          });
        }),
    })),
    {
      name: "rsql-tabs",
      partialize: (state) => ({
        tabs: state.tabs
          .filter((tab) => tab.type !== "terminal" && tab.type !== "notify")
          .map((tab) => ({
            id: tab.id,
            type: tab.type,
            projectId: tab.projectId,
            schema: tab.schema,
            title: tab.title,
            pinned: tab.pinned,
            editorValue: tab.editorValue,
            isExecuting: false,
            queryTimeout: tab.queryTimeout,
            isSplit: tab.isSplit,
            splitEditorValue: tab.splitEditorValue,
          })),
        selectedTabIndex:
          state.tabs.filter((t) => t.type !== "terminal").length === 0
            ? -1
            : Math.min(
                state.selectedTabIndex,
                state.tabs.filter((t) => t.type !== "terminal").length - 1,
              ),
      }),
      merge: (persisted: unknown, current: TabState) => {
        const p = persisted as Partial<TabState> | undefined;
        if (!p?.tabs || !Array.isArray(p.tabs)) return current;
        const { tabs, selectedTabIndex } = mergePersistedTabs(p.tabs, p.selectedTabIndex);
        return { ...current, tabs, selectedTabIndex };
      },
    },
  ),
);

export function useActiveTab(): Tab | undefined {
  return useTabStore((s) => s.tabs[s.selectedTabIndex]);
}

export function useActiveTabId(): string | undefined {
  return useTabStore((s) => s.tabs[s.selectedTabIndex]?.id);
}

/// Id of a tab by position, for the few callers that still hold an index.
export function tabIdAt(index: number): string | undefined {
  return useTabStore.getState().tabs[index]?.id;
}
