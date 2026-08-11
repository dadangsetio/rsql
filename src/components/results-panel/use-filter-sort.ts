import { useCallback, useEffect, useRef, useState } from "react";
import { DriverFactory } from "@/lib/database-driver";
import {
  buildFilteredSql,
  buildSortedSql,
  conditionToSql,
  emptyFilterState,
  type FilterColumnInfo,
  newColumnCondition,
  newRawCondition,
} from "@/lib/filter-utils";
import { PAGE_SIZE } from "@/lib/query-helpers";
import * as virtualCache from "@/lib/virtual-cache";
import { decodeColumns, decodePage, decodeResult } from "@/lib/wire";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import type { FilterState, SortState } from "@/types";
import type { PanelView } from "./types";

/// Conditions that produce no SQL are kept (the user is still typing one) but never
/// counted as active, so an empty row doesn't make the toolbar claim a filter is on.
function normalizeFilter(next: FilterState): FilterState {
  return { ...next, conditions: [...next.conditions] };
}

interface UseFilterSortArgs {
  tabId: string | undefined;
  filter: FilterState | undefined;
  result: { columns: string[] } | null | undefined;
  editableTable: { schema: string; table: string } | null;
  filterColumnKinds: Map<string, FilterColumnInfo>;
  panelView: PanelView;
}

export function useFilterSort({
  tabId,
  filter,
  result,
  editableTable,
  filterColumnKinds,
  panelView,
}: UseFilterSortArgs) {
  const [filterError, setFilterError] = useState<string | null>(null);

  const filterState = filter ?? emptyFilterState();
  const hasActiveFilter = filterState.conditions.some((c) => conditionToSql(c) !== null);

  const handleFilterChange = useCallback(
    (next: FilterState) => {
      if (!tabId) return;
      useTabStore.getState().setFilter(tabId, normalizeFilter(next));
    },
    [tabId],
  );

  // Dedup so mode/match toggles that don't change the effective SQL don't refire an
  // identical query; reset whenever the active tab changes.
  const lastAppliedSqlRef = useRef<string | null>(null);
  useEffect(() => {
    lastAppliedSqlRef.current = null;
  }, []);

  const applyFilterAndSort = useCallback(
    async (nextFilter: FilterState, nextSort: SortState | undefined) => {
      if (!tabId) return;
      const tab = useTabStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab?.projectId) return;
      useTabStore.getState().setFilter(tabId, normalizeFilter(nextFilter));
      useTabStore.getState().setSort(tabId, nextSort);

      let sql = buildFilteredSql(tab.editorValue, nextFilter) ?? tab.editorValue;
      sql = buildSortedSql(sql, nextSort) ?? sql;
      if (sql === lastAppliedSqlRef.current) return;
      lastAppliedSqlRef.current = sql;

      const d = useProjectStore.getState().projects[tab.projectId];
      if (!d) return;
      const driver = DriverFactory.getDriver(d.driver);
      setFilterError(null);

      const prevVQ = tab.virtualQuery;
      if (prevVQ?.queryId) {
        await driver.closeVirtual?.(tab.projectId, prevVQ.queryId).catch(() => {});
        virtualCache.clearQuery(prevVQ.queryId);
        useTabStore.getState().setVirtualQuery(tabId, undefined);
      }

      useTabStore.getState().setExecuting(tabId, true);
      try {
        if (driver.executeVirtual) {
          const queryId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
          const pageSize = prevVQ?.pageSize ?? PAGE_SIZE;
          const [colsPacked, totalRows, pagePacked, elapsed] = await driver.executeVirtual(
            tab.projectId,
            sql,
            queryId,
            pageSize,
          );

          if (!colsPacked) {
            const { columns, rows } = decodeResult(pagePacked);
            await driver.closeVirtual?.(tab.projectId, queryId).catch(() => {});
            useTabStore.getState().updateResult(tabId, { columns, rows, time: elapsed });
          } else {
            const columns = decodeColumns(colsPacked);
            const firstPage = decodePage(pagePacked);
            if (totalRows <= pageSize) {
              await driver.closeVirtual?.(tab.projectId, queryId).catch(() => {});
              useTabStore
                .getState()
                .updateResult(tabId, { columns, rows: firstPage, time: elapsed });
            } else {
              virtualCache.setPage(queryId, 0, firstPage);
              useTabStore.getState().setVirtualQuery(tabId, {
                queryId,
                columns,
                totalRows,
                pageSize,
                colCount: columns.length,
                time: elapsed,
              });
              useTabStore
                .getState()
                .updateResult(tabId, { columns, rows: firstPage, time: elapsed });
            }
          }
        } else {
          const [cols, rows, time] = await driver.runQuery(tab.projectId, sql);
          useTabStore.getState().updateResult(tabId, { columns: cols, rows, time });
        }
      } catch (err: any) {
        lastAppliedSqlRef.current = null;
        setFilterError(err?.message ?? "Filter query failed");
        useTabStore.getState().setExecuting(tabId, false);
      }
    },
    [tabId],
  );

  const applyFilter = useCallback(
    (next: FilterState) => {
      const tab = useTabStore.getState().tabs.find((t) => t.id === tabId);
      return applyFilterAndSort(next, tab?.sort);
    },
    [applyFilterAndSort, tabId],
  );

  // Column-header click: asc -> desc -> unsorted, restarting at asc when a different
  // column is clicked. Persists on the tab like `filter` does.
  const handleSortColumn = useCallback(
    (colIndex: number) => {
      const tab = useTabStore.getState().tabs.find((t) => t.id === tabId);
      const col = tab?.result?.columns[colIndex];
      if (!tab || !col) return;
      const current = tab.sort;
      const next: SortState | undefined =
        !current || current.column !== col
          ? { column: col, direction: "asc" }
          : current.direction === "asc"
            ? { column: col, direction: "desc" }
            : undefined;
      void applyFilterAndSort(tab.filter ?? emptyFilterState(), next);
    },
    [applyFilterAndSort, tabId],
  );

  const toggleFilterBar = useCallback(() => {
    if (!tabId) return;
    const tab = useTabStore.getState().tabs.find((t) => t.id === tabId);
    const current = tab?.filter ?? emptyFilterState();

    if (current.open) {
      useTabStore.getState().setFilter(tabId, { ...current, open: false });
      return;
    }

    // Opening with nothing set up yet — start from one row instead of an empty shell.
    const columns = tab?.result?.columns ?? [];
    const conditions =
      current.conditions.length > 0
        ? current.conditions
        : [
            editableTable && columns.length > 0
              ? newColumnCondition(columns[0], filterColumnKinds.get(columns[0])?.kind ?? "text")
              : newRawCondition(),
          ];
    useTabStore.getState().setFilter(tabId, { ...current, open: true, conditions });
  }, [tabId, editableTable, filterColumnKinds]);

  // Cmd/Ctrl+F opens/closes the filter bar; Escape closes it. Both defer to Monaco's
  // own find widget when the SQL editor has focus.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".monaco-editor")) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        if (!result || panelView === "history") return;
        e.preventDefault();
        toggleFilterBar();
      } else if (e.key === "Escape" && filterState.open) {
        toggleFilterBar();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [result, panelView, filterState.open, toggleFilterBar]);

  return {
    filterState,
    hasActiveFilter,
    filterError,
    setFilterError,
    handleFilterChange,
    applyFilter,
    handleSortColumn,
    toggleFilterBar,
  };
}
