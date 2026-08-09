import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useActiveTab } from "@/stores/tab-store";
import { useTabStore } from "@/stores/tab-store";
import { useUIStore } from "@/stores/ui-store";
import { useProjectStore } from "@/stores/project-store";
import { DriverFactory } from "@/lib/database-driver";
import {
  CheckCircle2,
  Clock,
  Copy,
  Diff,
  Download,
  Filter as FilterIcon,
  GitBranch,
  History,
  Loader2,
  Pin,
  Save,
  Square,
  X,
  XCircle,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";
import { ResultsGrid } from "./results-grid";
import { RelationPickerModal } from "./relation-picker-modal";
import { ResultsRecord } from "./results-record";
import { QueryHistory } from "./query-history";
import { ExplainPanel } from "./explain-panel";
import { FilterBar } from "./filter-bar";
import { exportResults, copyToClipboard, type ExportFormat } from "@/lib/export";
import { parseSelectTable, generateUpdate, generateDelete, quoteIdent, quoteLiteral } from "@/lib/sql-utils";
import { ResultsMap, hasGeometryColumn } from "./results-map";
import type { ForeignKey } from "@/lib/database-driver";
import * as virtualCache from "@/lib/virtual-cache";
import { classifyColumnEditKind, buildEnumLabelMap, type ColumnEditInfo } from "@/lib/column-edit-kind";
import { classifyFilterColumnKind, buildFilteredSql, buildSortedSql, conditionToSql, emptyFilterState, newColumnCondition, newRawCondition, type FilterColumnInfo } from "@/lib/filter-utils";
import type { FilterState, SortState } from "@/types";

const CELL_SEP = "\x1F";
const ROW_SEP = "\x1E";
const MAX_CONCURRENT_PAGE_FETCHES = 6;
const MAX_QUEUED_PAGE_FETCHES = 32;
const CACHE_WINDOW_PAGES = 24;

// Removing the last condition (from any row's own remove button) leaves nothing to show —
// close the bar automatically rather than leaving an empty shell with just an "Add" button.
function normalizeFilter(next: FilterState): FilterState {
  return next.conditions.length === 0 ? { ...next, open: false } : next;
}

type PanelView = "grid" | "record" | "history" | "explain" | "diff" | "map";

type UndoEntry =
  | { type: "cell"; rowIndex: number; colIndex: number; previousValue: string | undefined }
  | { type: "deletedRows"; rowIndex: number; wasDeleted: boolean };

interface EditState {
  schema: string;
  table: string;
  pkColumns: string[];
  cellEdits: Map<string, string>;
  deletedRows: Set<number>;
  undoStack: UndoEntry[];
}

export function ResultsPanel() {
  const activeTab = useActiveTab();
  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const pinnedResult = useUIStore((s) => s.pinnedResult);
  const [panelView, setPanelView] = useState<PanelView>("grid");
  const [filterError, setFilterError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const [pendingCommit, setPendingCommit] = useState<{ statements: string[]; deleteCount: number } | null>(null);
  const result = activeTab?.result;
  const isExecuting = activeTab?.isExecuting;
  const vq = activeTab?.virtualQuery;

  // Cancel running query
  const handleCancel = useCallback(async () => {
    if (!activeTab?.projectId || !activeTab.isExecuting) return;
    const d = useProjectStore.getState().projects[activeTab.projectId];
    if (!d) return;
    try {
      const driver = DriverFactory.getDriver(d.driver);
      await driver.cancelQuery?.(activeTab.projectId);
    } catch (err) {
      console.error("Failed to cancel query:", err);
    }
  }, [activeTab?.projectId, activeTab?.isExecuting]);

  // Virtual page loading
  const loadingPages = useRef(new Set<number>());
  const queuedPages = useRef<number[]>([]);
  const queuedPageSet = useRef(new Set<number>());
  const activeFetches = useRef(0);
  const latestRequestedPage = useRef(0);
  const gridRef = useRef<{ invalidatePage: (pageIndex: number) => void }>(null);
  const virtualViewportRows = useRef(new Map<string, number>());

  useEffect(() => {
    loadingPages.current.clear();
    queuedPages.current = [];
    queuedPageSet.current.clear();
    activeFetches.current = 0;
  }, [vq?.queryId, activeTab?.projectId]);

  const handleViewportRowChange = useCallback((rowIndex: number) => {
    if (!vq?.queryId) return;
    virtualViewportRows.current.set(vq.queryId, rowIndex);
  }, [vq?.queryId]);

  const restoreRowIndex = vq?.queryId
    ? (virtualViewportRows.current.get(vq.queryId) ?? 0)
    : 0;

  const fetchPage = useCallback(async (pageIndex: number) => {
    if (!vq || !activeTab?.projectId) return;
    const d = useProjectStore.getState().projects[activeTab.projectId];
    if (!d) return;
    const driver = DriverFactory.getDriver(d.driver);
    if (!driver.fetchPage) return;

    const offset = pageIndex * vq.pageSize;
    const packed = await driver.fetchPage(activeTab.projectId, vq.queryId, vq.colCount, offset, vq.pageSize);

    // Drop stale page responses after tab/query switches.
    const selectedIdx = useTabStore.getState().selectedTabIndex;
    const selectedTab = useTabStore.getState().tabs[selectedIdx];
    if (selectedTab?.virtualQuery?.queryId !== vq.queryId) return;

    const rows = packed ? packed.split(ROW_SEP).map((r) => r.split(CELL_SEP)) : [];
    const expectedRows = Math.max(0, Math.min(vq.pageSize, vq.totalRows - offset));
    if (expectedRows > 0 && rows.length === 0) {
      // Keep page as "missing" so viewport observer can retry instead of caching a permanent empty page.
      return;
    }
    virtualCache.setPage(vq.queryId, pageIndex, rows);
    // Evict around the user's latest viewport, not the page that happened to resolve last.
    virtualCache.evictDistant(vq.queryId, latestRequestedPage.current, CACHE_WINDOW_PAGES);
    gridRef.current?.invalidatePage(pageIndex);
  }, [vq, activeTab?.projectId]);

  const pumpQueue = useCallback(() => {
    if (!vq || !activeTab?.projectId) return;

    if (queuedPages.current.length > 1) {
      const target = latestRequestedPage.current;
      queuedPages.current.sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
    }

    while (activeFetches.current < MAX_CONCURRENT_PAGE_FETCHES && queuedPages.current.length > 0) {
      const pageIndex = queuedPages.current.shift()!;
      queuedPageSet.current.delete(pageIndex);

      if (loadingPages.current.has(pageIndex) || virtualCache.hasPage(vq.queryId, pageIndex)) {
        continue;
      }

      loadingPages.current.add(pageIndex);
      activeFetches.current += 1;

      void fetchPage(pageIndex).finally(() => {
        loadingPages.current.delete(pageIndex);
        activeFetches.current -= 1;
        pumpQueue();
      });
    }
  }, [vq, activeTab?.projectId, fetchPage]);

  const handlePageNeeded = useCallback((pageIndex: number) => {
    if (!vq || !activeTab?.projectId) return;
    latestRequestedPage.current = pageIndex;
    if (
      loadingPages.current.has(pageIndex)
      || virtualCache.hasPage(vq.queryId, pageIndex)
      || queuedPageSet.current.has(pageIndex)
    ) {
      return;
    }

    if (queuedPages.current.length >= MAX_QUEUED_PAGE_FETCHES) {
      queuedPages.current = queuedPages.current.filter((p) => Math.abs(p - pageIndex) <= 8);
      queuedPageSet.current = new Set(queuedPages.current);
    }

    queuedPages.current.push(pageIndex);
    queuedPageSet.current.add(pageIndex);
    pumpQueue();
  }, [vq, activeTab?.projectId, pumpQueue]);

  useEffect(() => {
    if (!vq) return;
    const anchorPage = Math.max(0, Math.floor(restoreRowIndex / vq.pageSize));
    const startPage = Math.max(0, anchorPage - 1);
    const endPage = Math.min(anchorPage + 3, Math.ceil(vq.totalRows / vq.pageSize) - 1);
    for (let p = startPage; p <= endPage; p++) {
      handlePageNeeded(p);
    }
  }, [vq?.queryId, vq?.totalRows, vq?.pageSize, restoreRowIndex, handlePageNeeded]);

  // No client-side row filtering anymore — the filter bar re-queries the database instead
  // (see applyFilter below), so the grid always shows the full current result set.
  const filteredRowIndices = null;
  const filteredRows = result?.rows ?? [];

  const explainResult = activeTab?.explainResult;
  const hasExplain = !!explainResult;

  // Detect if query is a simple SELECT (editable)
  const editableTable = useMemo(() => {
    if (!activeTab?.editorValue) return null;
    return parseSelectTable(activeTab.editorValue);
  }, [activeTab?.editorValue]);

  // FK column map: columnName → { targetSchema, targetTable, targetColumn }
  const [fkMap, setFkMap] = useState<Map<string, { schema: string; table: string; column: string }>>(new Map());
  // Column name → how to edit it (enum dropdown, date/timestamp picker, boolean toggle)
  const [columnTypes, setColumnTypes] = useState<Map<string, ColumnEditInfo>>(new Map());
  // Column name → filter-bar operator bucket (separate from columnTypes/ColumnEditKind, which
  // lumps integers into "text" — wrong for filtering, where integers need >/<).
  const [filterColumnKinds, setFilterColumnKinds] = useState<Map<string, FilterColumnInfo>>(new Map());

  useEffect(() => {
    if (!editableTable || !activeTab?.projectId) {
      setFkMap(new Map());
      return;
    }
    const pid = activeTab.projectId;
    const d = useProjectStore.getState().projects[pid];
    if (!d) return;

    const driver = DriverFactory.getDriver(d.driver);
    driver.loadForeignKeys(pid, editableTable.schema).then((fks: ForeignKey[]) => {
      const map = new Map<string, { schema: string; table: string; column: string }>();
      for (const fk of fks) {
        if (fk.sourceTable === editableTable.table) {
          map.set(fk.sourceColumn, {
            schema: editableTable.schema,
            table: fk.targetTable,
            column: fk.targetColumn,
          });
        }
      }
      setFkMap(map);
    }).catch(() => setFkMap(new Map()));
  }, [editableTable, activeTab?.projectId]);

  useEffect(() => {
    if (!editableTable || !activeTab?.projectId) {
      setColumnTypes(new Map());
      setFilterColumnKinds(new Map());
      return;
    }
    const pid = activeTab.projectId;
    const d = useProjectStore.getState().projects[pid];
    if (!d) return;

    const driver = DriverFactory.getDriver(d.driver);
    Promise.all([
      useProjectStore.getState().loadColumnDetails(pid, editableTable.schema, editableTable.table),
      driver.loadEnumTypes?.(pid) ?? Promise.resolve([]),
    ]).then(([colDetails, enumRows]) => {
      const enumLabelMap = buildEnumLabelMap(enumRows);
      const typeMap = new Map<string, ColumnEditInfo>();
      const filterKindMap = new Map<string, FilterColumnInfo>();
      for (const c of colDetails) {
        typeMap.set(c.name, classifyColumnEditKind(c.dataType, c.udtName, c.nullable, enumLabelMap));
        filterKindMap.set(c.name, classifyFilterColumnKind(c.dataType, c.udtName, enumLabelMap));
      }
      setColumnTypes(typeMap);
      setFilterColumnKinds(filterKindMap);
    }).catch(() => {
      setColumnTypes(new Map());
      setFilterColumnKinds(new Map());
    });
  }, [editableTable, activeTab?.projectId]);

  // FK navigate handler - opens a new tab and auto-executes the query
  const handleFKNavigate = useCallback(
    (colName: string, value: string) => {
      const target = fkMap.get(colName);
      if (!target || !activeTab?.projectId) return;

      const pid = activeTab.projectId;
      const sql = `SELECT * FROM ${quoteIdent(target.schema)}.${quoteIdent(target.table)} WHERE ${quoteIdent(target.column)} = ${quoteLiteral(value)} LIMIT 100`;
      useTabStore.getState().openTab(pid, sql);

      // Auto-execute the query in the new tab
      const d = useProjectStore.getState().projects[pid];
      if (!d) return;
      const newTabIdx = useTabStore.getState().tabs.length - 1;
      useTabStore.getState().setExecuting(newTabIdx, true);
      const driver = DriverFactory.getDriver(d.driver);
      driver.runQuery(pid, sql).then(([cols, rows, time]) => {
        useTabStore.getState().updateResult(newTabIdx, { columns: cols, rows, time });
      }).catch(() => {
        useTabStore.getState().setExecuting(newTabIdx, false);
      });
    },
    [fkMap, activeTab?.projectId],
  );

  // Relation picker — opened by double-clicking (or Enter/Space on) an editable FK cell.
  const [fkPicker, setFkPicker] = useState<{ rowIndex: number; colIndex: number } | null>(null);
  const handleFKPickerOpen = useCallback((rowIndex: number, colIndex: number) => {
    setFkPicker({ rowIndex, colIndex });
  }, []);
  const fkPickerInfo = useMemo(() => {
    if (!fkPicker || !result || !activeTab?.projectId) return null;
    const colName = result.columns[fkPicker.colIndex];
    const target = fkMap.get(colName);
    if (!target) return null;
    const key = `${fkPicker.rowIndex}:${fkPicker.colIndex}`;
    const currentValue = editState?.cellEdits.get(key) ?? result.rows[fkPicker.rowIndex]?.[fkPicker.colIndex] ?? "null";
    const nullable = columnTypes.get(colName)?.nullable ?? true;
    return { rowIndex: fkPicker.rowIndex, colIndex: fkPicker.colIndex, ...target, currentValue, nullable };
  }, [fkPicker, result, activeTab?.projectId, fkMap, editState, columnTypes]);

  // Enter edit mode
  const handleEnterEdit = useCallback(async () => {
    if (!editableTable || !activeTab?.projectId) return;
    const d = useProjectStore.getState().projects[activeTab.projectId];
    if (!d) return;
    setEditError(null);

    try {
      const driver = DriverFactory.getDriver(d.driver);
      const indexes = await driver.loadIndexes(
        activeTab.projectId,
        editableTable.schema,
        editableTable.table,
      );
      const pkColumns = [...new Set(indexes.filter((i) => i.isPrimary).map((i) => i.columnName))];

      if (pkColumns.length === 0) {
        setEditError("No primary key found. Inline editing requires a primary key.");
        return;
      }

      // Check that PK columns exist in result columns
      const resultCols = result?.columns ?? [];
      const missingPKs = pkColumns.filter((pk) => !resultCols.includes(pk));
      if (missingPKs.length > 0) {
        setEditError(`Primary key column(s) ${missingPKs.join(", ")} not in query results. Select all PK columns to edit.`);
        return;
      }

      setEditState({
        schema: editableTable.schema,
        table: editableTable.table,
        pkColumns,
        cellEdits: new Map(),
        deletedRows: new Set(),
        undoStack: [],
      });
      setIsEditing(true);
    } catch (err: any) {
      setEditError(err?.message ?? "Failed to load table info");
    }
  }, [editableTable, activeTab?.projectId, result?.columns]);

  // Discard edits
  const handleDiscard = useCallback(() => {
    setIsEditing(false);
    setEditState(null);
    setEditError(null);
  }, []);

  // Auto-discard once nothing is staged anymore (e.g. undoing the last edit, or
  // restoring the last deleted row). Only fires on a non-empty → empty transition,
  // never on the initial (already-empty) edit state a lazy bootstrap creates just
  // before it applies the edit that triggered entering edit mode.
  const pendingChangeCountRef = useRef(0);
  useEffect(() => {
    const pending = (editState?.cellEdits.size ?? 0) + (editState?.deletedRows.size ?? 0);
    if (editState && pendingChangeCountRef.current > 0 && pending === 0) {
      handleDiscard();
    }
    pendingChangeCountRef.current = pending;
  }, [editState, handleDiscard]);

  // Filter bar — state lives on the tab so it survives tab switches. Applying a filter
  // rewrites the tab's base query (wrapped as a subquery, see buildFilteredSql) and re-runs
  // it, mirroring virtual/non-virtual execution the same way App.tsx's runQuery does.
  const filterState = activeTab?.filter ?? emptyFilterState();
  const hasActiveFilter = filterState.conditions.some((c) => conditionToSql(c) !== null);

  const handleFilterChange = useCallback((next: FilterState) => {
    const idx = useTabStore.getState().selectedTabIndex;
    useTabStore.getState().setFilter(idx, normalizeFilter(next));
  }, []);

  // Dedup so mode/match toggles that don't change the effective WHERE body don't refire
  // an identical query; reset whenever the active tab changes.
  const lastAppliedSqlRef = useRef<string | null>(null);
  useEffect(() => {
    lastAppliedSqlRef.current = null;
  }, [activeTab?.id]);

  const applyFilterAndSort = useCallback(async (nextFilter: FilterState, nextSort: SortState | undefined) => {
    const idx = useTabStore.getState().selectedTabIndex;
    const tab = useTabStore.getState().tabs[idx];
    if (!tab?.projectId) return;
    useTabStore.getState().setFilter(idx, normalizeFilter(nextFilter));
    useTabStore.getState().setSort(idx, nextSort);

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
      useTabStore.getState().setVirtualQuery(idx, undefined);
    }

    useTabStore.getState().setExecuting(idx, true);
    try {
      if (driver.executeVirtual) {
        const queryId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        const pageSize = prevVQ?.pageSize ?? 2000;
        const [colsPacked, totalRows, pagePacked, elapsed] =
          await driver.executeVirtual(tab.projectId, sql, queryId, pageSize);

        if (!colsPacked) {
          const parts = pagePacked ? pagePacked.split(ROW_SEP) : [];
          const columns = parts[0] ? parts[0].split(CELL_SEP) : [];
          const rows = parts.slice(1).map((r) => r.split(CELL_SEP));
          await driver.closeVirtual?.(tab.projectId, queryId).catch(() => {});
          useTabStore.getState().updateResult(idx, { columns, rows, time: elapsed });
        } else {
          const columns = colsPacked.split(CELL_SEP);
          const firstPage = pagePacked ? pagePacked.split(ROW_SEP).map((r) => r.split(CELL_SEP)) : [];
          if (totalRows <= pageSize) {
            await driver.closeVirtual?.(tab.projectId, queryId).catch(() => {});
            useTabStore.getState().updateResult(idx, { columns, rows: firstPage, time: elapsed });
          } else {
            virtualCache.setPage(queryId, 0, firstPage);
            useTabStore.getState().setVirtualQuery(idx, { queryId, columns, totalRows, pageSize, colCount: columns.length, time: elapsed });
            useTabStore.getState().updateResult(idx, { columns, rows: firstPage, time: elapsed });
          }
        }
      } else {
        const [cols, rows, time] = await driver.runQuery(tab.projectId, sql);
        useTabStore.getState().updateResult(idx, { columns: cols, rows, time });
      }
    } catch (err: any) {
      lastAppliedSqlRef.current = null;
      setFilterError(err?.message ?? "Filter query failed");
      useTabStore.getState().setExecuting(idx, false);
    }
  }, []);

  const applyFilter = useCallback((next: FilterState) => {
    const idx = useTabStore.getState().selectedTabIndex;
    return applyFilterAndSort(next, useTabStore.getState().tabs[idx]?.sort);
  }, [applyFilterAndSort]);

  // Column-header click: asc -> desc -> unsorted, restarting at asc when a different column
  // is clicked. Persists on the tab like `filter` does (see SortState).
  const handleSortColumn = useCallback((colIndex: number) => {
    const idx = useTabStore.getState().selectedTabIndex;
    const tab = useTabStore.getState().tabs[idx];
    const col = tab?.result?.columns[colIndex];
    if (!tab || !col) return;
    const current = tab.sort;
    const next: SortState | undefined =
      !current || current.column !== col ? { column: col, direction: "asc" }
      : current.direction === "asc" ? { column: col, direction: "desc" }
      : undefined;
    applyFilterAndSort(tab.filter ?? emptyFilterState(), next);
  }, [applyFilterAndSort]);

  const toggleFilterBar = useCallback(() => {
    const idx = useTabStore.getState().selectedTabIndex;
    const tab = useTabStore.getState().tabs[idx];
    const current = tab?.filter ?? emptyFilterState();

    if (current.open) {
      useTabStore.getState().setFilter(idx, { ...current, open: false });
      return;
    }

    // Opening with nothing set up yet — start from one row instead of an empty shell.
    const columns = tab?.result?.columns ?? [];
    const conditions = current.conditions.length > 0
      ? current.conditions
      : [
          editableTable && columns.length > 0
            ? newColumnCondition(columns[0], filterColumnKinds.get(columns[0])?.kind ?? "text")
            : newRawCondition(),
        ];
    useTabStore.getState().setFilter(idx, { ...current, open: true, conditions });
  }, [editableTable, filterColumnKinds]);

  // Cmd/Ctrl+F opens/closes the filter bar; Escape closes it. Both defer to Monaco's own
  // find widget when the SQL editor has focus.
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

  // Run statements + refresh results helper
  const runAndRefresh = useCallback(async (statements: string[]) => {
    if (!activeTab?.projectId || statements.length === 0) return;
    setIsCommitting(true);
    setEditError(null);

    try {
      const d = useProjectStore.getState().projects[activeTab.projectId];
      if (!d) throw new Error("Project not found");
      const driver = DriverFactory.getDriver(d.driver);

      const txnSql = ["BEGIN", ...statements, "COMMIT"].join(";\n");
      await driver.runQuery(activeTab.projectId, txnSql, 30000);

      const [cols, rows, time] = await driver.runQuery(activeTab.projectId, activeTab.editorValue);
      const tabIdx = useTabStore.getState().selectedTabIndex;
      useTabStore.getState().updateResult(tabIdx, { columns: cols, rows, time });

      setIsEditing(false);
      setEditState(null);
      setPendingCommit(null);
    } catch (err: any) {
      setEditError(err?.message ?? "Commit failed");
    } finally {
      setIsCommitting(false);
    }
  }, [activeTab?.projectId, activeTab?.editorValue]);

  // Commit — cell edits (UPDATEs) and staged row deletions (DELETEs) together.
  // Deletions ask for confirmation first since they're destructive.
  const handleCommit = useCallback(() => {
    if (!editState || !result) return;
    const { schema, table, pkColumns, cellEdits, deletedRows } = editState;
    const columns = result.columns;
    const originalRows = result.rows;

    const editsByRow = new Map<number, Map<number, string>>();
    for (const [key, value] of cellEdits) {
      const [rowStr, colStr] = key.split(":");
      const rowIdx = parseInt(rowStr);
      const colIdx = parseInt(colStr);
      if (deletedRows.has(rowIdx)) continue;
      if (!editsByRow.has(rowIdx)) editsByRow.set(rowIdx, new Map());
      editsByRow.get(rowIdx)!.set(colIdx, value);
    }

    const statements: string[] = [];
    for (const [rowIdx, changes] of editsByRow) {
      statements.push(generateUpdate(schema, table, columns, originalRows[rowIdx], changes, pkColumns));
    }
    for (const rowIdx of deletedRows) {
      statements.push(generateDelete(schema, table, columns, originalRows[rowIdx], pkColumns));
    }

    if (statements.length === 0) {
      handleDiscard();
      return;
    }

    if (deletedRows.size > 0) {
      setPendingCommit({ statements, deleteCount: deletedRows.size });
      return;
    }

    void runAndRefresh(statements);
  }, [editState, result, handleDiscard, runAndRefresh]);

  const handleConfirmCommit = useCallback(() => {
    if (!pendingCommit) return;
    const { statements } = pendingCommit;
    setPendingCommit(null);
    void runAndRefresh(statements);
  }, [pendingCommit, runAndRefresh]);

  const handleCancelCommit = useCallback(() => {
    setPendingCommit(null);
  }, []);

  // Cell edit handler
  const applyCellEdit = useCallback(
    (rowIndex: number, colIndex: number, value: string) => {
      setEditState((prev) => {
        if (!prev) return prev;
        const key = `${rowIndex}:${colIndex}`;
        const previousValue = prev.cellEdits.get(key);
        const newEdits = new Map(prev.cellEdits);
        const original = result?.rows[rowIndex]?.[colIndex] ?? "";
        if (value === original) {
          newEdits.delete(key);
        } else {
          newEdits.set(key, value);
        }
        const undoStack = [...prev.undoStack, { type: "cell" as const, rowIndex, colIndex, previousValue }];
        return { ...prev, cellEdits: newEdits, undoStack };
      });
    },
    [result],
  );

  // A double-click on a cell can edit it directly, without pressing "Edit" first —
  // lazily enter edit mode so the value still lands in editState once it's ready.
  const handleCellEdit = useCallback(
    (rowIndex: number, colIndex: number, value: string) => {
      if (!editState) {
        // Opening a picker (date/time/enum) and closing it without picking anything still
        // fires this via blur/click-outside — don't flip into edit mode for a no-op.
        const original = result?.rows[rowIndex]?.[colIndex] ?? "";
        if (value === original) return;
        void handleEnterEdit().then(() => applyCellEdit(rowIndex, colIndex, value));
        return;
      }
      applyCellEdit(rowIndex, colIndex, value);
    },
    [editState, handleEnterEdit, applyCellEdit, result],
  );

  const applyRowDelete = useCallback((rowIndex: number) => {
    setEditState((prev) => {
      if (!prev || prev.deletedRows.has(rowIndex)) return prev;
      const newDeleted = new Set(prev.deletedRows);
      newDeleted.add(rowIndex);
      const undoStack = [...prev.undoStack, { type: "deletedRows" as const, rowIndex, wasDeleted: false }];
      return { ...prev, deletedRows: newDeleted, undoStack };
    });
  }, []);

  const applyRowRestore = useCallback((rowIndex: number) => {
    setEditState((prev) => {
      if (!prev || !prev.deletedRows.has(rowIndex)) return prev;
      const newDeleted = new Set(prev.deletedRows);
      newDeleted.delete(rowIndex);
      const undoStack = [...prev.undoStack, { type: "deletedRows" as const, rowIndex, wasDeleted: true }];
      return { ...prev, deletedRows: newDeleted, undoStack };
    });
  }, []);

  // Undo the last cell edit or row delete/restore made this edit session.
  const handleUndo = useCallback(() => {
    setEditState((prev) => {
      if (!prev || prev.undoStack.length === 0) return prev;
      const entry = prev.undoStack[prev.undoStack.length - 1];
      const undoStack = prev.undoStack.slice(0, -1);

      if (entry.type === "cell") {
        const key = `${entry.rowIndex}:${entry.colIndex}`;
        const newEdits = new Map(prev.cellEdits);
        if (entry.previousValue === undefined) newEdits.delete(key);
        else newEdits.set(key, entry.previousValue);
        return { ...prev, cellEdits: newEdits, undoStack };
      }

      const newDeleted = new Set(prev.deletedRows);
      if (entry.wasDeleted) newDeleted.add(entry.rowIndex);
      else newDeleted.delete(entry.rowIndex);
      return { ...prev, deletedRows: newDeleted, undoStack };
    });
  }, []);

  // Selecting a row and pressing Delete can stage it too, without pressing "Edit" first —
  // lazily enter edit mode so the deletion still lands in editState once it's ready.
  const handleRowDelete = useCallback(
    (rowIndex: number) => {
      if (!editState) {
        void handleEnterEdit().then(() => applyRowDelete(rowIndex));
        return;
      }
      applyRowDelete(rowIndex);
    },
    [editState, handleEnterEdit, applyRowDelete],
  );

  const handleRowRestore = useCallback(
    (rowIndex: number) => {
      if (!editState) return;
      applyRowRestore(rowIndex);
    },
    [editState, applyRowRestore],
  );

  // Common toolbar props
  const toolbarProps = {
    panelView,
    setPanelView,
    setViewMode,
    viewMode,
    hasExplain,
    isExecuting: !!isExecuting,
    isEditing,
    editState,
    isCommitting,
    editError,
    onCommit: handleCommit,
    pendingCommit,
    onConfirmCommit: handleConfirmCommit,
    onCancelCommit: handleCancelCommit,
    onDiscard: handleDiscard,
    onCancel: handleCancel,
    virtualQuery: vq,
    filterOpen: filterState.open,
    hasActiveFilter,
    onToggleFilter: toggleFilterBar,
  };

  if (panelView === "explain" && hasExplain) {
    return (
      <div className="flex h-full flex-col border-t border-border bg-card">
        <ResultsToolbar {...toolbarProps} result={result ?? null} columns={result?.columns ?? []} filteredRows={filteredRows} />
        <ExplainPanel plan={explainResult} />
      </div>
    );
  }

  if (panelView !== "history" && isExecuting && !result) {
    return (
      <div className="flex h-full flex-col">
        <ResultsToolbar {...toolbarProps} result={null} columns={[]} filteredRows={[]} />
        <div className="flex flex-1 items-center justify-center text-muted-foreground gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Executing query...</span>
        </div>
      </div>
    );
  }

  if (panelView === "history") {
    return (
      <div className="flex h-full flex-col border-t border-border bg-card">
        <ResultsToolbar {...toolbarProps} result={result ?? null} columns={result?.columns ?? []} filteredRows={filteredRows} />
        <QueryHistory />
      </div>
    );
  }

  if (panelView === "diff" && pinnedResult && result) {
    return (
      <div className="flex h-full flex-col border-t border-border bg-card">
        <ResultsToolbar {...toolbarProps} result={result} columns={result.columns} filteredRows={filteredRows} />
        <DiffView
          pinnedColumns={pinnedResult.columns}
          pinnedRows={pinnedResult.rows}
          currentColumns={result.columns}
          currentRows={filteredRows}
        />
      </div>
    );
  }

  if (panelView === "map" && result) {
    return (
      <div className="flex h-full flex-col border-t border-border bg-card">
        <ResultsToolbar {...toolbarProps} result={result} columns={result.columns} filteredRows={filteredRows} />
        <ResultsMap columns={result.columns} rows={filteredRows} />
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex h-full flex-col">
        <ResultsToolbar {...toolbarProps} result={null} columns={[]} filteredRows={[]} />
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          No data to display
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col border-t border-border bg-card">
      <ResultsToolbar {...toolbarProps} result={result} columns={result.columns} filteredRows={filteredRows} />
      {filterState.open && (
        <FilterBar
          state={filterState}
          onChange={handleFilterChange}
          onApply={applyFilter}
          columns={result.columns}
          columnKinds={filterColumnKinds}
          builderAvailable={!!editableTable}
        />
      )}
      {filterError && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-destructive/10 text-destructive text-xs border-b border-border">
          <XCircle className="h-3 w-3" />
          {filterError}
          <button onClick={() => setFilterError(null)} className="ml-auto hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {editError && !isEditing && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-destructive/10 text-destructive text-xs border-b border-border">
          <XCircle className="h-3 w-3" />
          {editError}
          <button onClick={() => setEditError(null)} className="ml-auto hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {viewMode === "grid" ? (
        <ResultsGrid
          key={activeTab?.id ?? "results-grid"}
          columns={result.columns}
          rows={filteredRows}
          rowIndexMap={filteredRowIndices ?? undefined}
          isEditing={isEditing}
          editable={!!editableTable && !vq}
          cellEdits={editState?.cellEdits}
          deletedRows={editState?.deletedRows}
          columnTypes={columnTypes}
          onCellEdit={handleCellEdit}
          onRowDelete={handleRowDelete}
          onRowRestore={handleRowRestore}
          onUndo={handleUndo}
          fkColumns={fkMap}
          onFKNavigate={handleFKNavigate}
          onFKPickerOpen={handleFKPickerOpen}
          sort={activeTab?.sort}
          onSortColumn={handleSortColumn}
          virtualQuery={vq}
          onPageNeeded={vq ? handlePageNeeded : undefined}
          onViewportRowChange={vq ? handleViewportRowChange : undefined}
          restoreRowIndex={vq ? restoreRowIndex : undefined}
          viewportKey={vq?.queryId}
          gridRef={gridRef}
        />
      ) : (
        <ResultsRecord columns={result.columns} rows={filteredRows} />
      )}
      {fkPickerInfo && activeTab?.projectId && (
        <RelationPickerModal
          open
          onOpenChange={(v) => { if (!v) setFkPicker(null); }}
          projectId={activeTab.projectId}
          schema={fkPickerInfo.schema}
          table={fkPickerInfo.table}
          column={fkPickerInfo.column}
          nullable={fkPickerInfo.nullable}
          currentValue={fkPickerInfo.currentValue}
          onSelect={(value) => {
            handleCellEdit(fkPickerInfo.rowIndex, fkPickerInfo.colIndex, value ?? "null");
            setFkPicker(null);
          }}
        />
      )}
    </div>
  );
}

interface ToolbarProps {
  panelView: PanelView;
  setPanelView: (v: PanelView) => void;
  result: { rows: string[][]; time: number; capped?: boolean } | null;
  columns: string[];
  filteredRows: string[][];
  setViewMode: (mode: "grid" | "record") => void;
  viewMode: "grid" | "record";
  hasExplain: boolean;
  isExecuting: boolean;
  isEditing: boolean;
  editState: EditState | null;
  isCommitting: boolean;
  editError: string | null;
  onCommit: () => void;
  pendingCommit: { statements: string[]; deleteCount: number } | null;
  onConfirmCommit: () => void;
  onCancelCommit: () => void;
  onDiscard: () => void;
  onCancel?: () => void;
  virtualQuery?: { queryId: string; totalRows: number; time: number; pageSize: number };
  filterOpen: boolean;
  hasActiveFilter: boolean;
  onToggleFilter: () => void;
}

function ResultsToolbar(props: ToolbarProps) {
  const {
    panelView,
    setPanelView,
    result,
    columns,
    filteredRows,
    setViewMode,
    viewMode,
    hasExplain,
    isExecuting,
    isEditing,
    editState,
    isCommitting,
    editError,
    onCommit,
    pendingCommit,
    onConfirmCommit,
    onCancelCommit,
    onDiscard,
    onCancel,
    virtualQuery,
    filterOpen,
    hasActiveFilter,
    onToggleFilter,
  } = props;

  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const pinnedResult = useUIStore((s) => s.pinnedResult);
  const pinResult = useUIStore((s) => s.pinResult);
  const clearPinnedResult = useUIStore((s) => s.clearPinnedResult);

  const handleExport = (format: ExportFormat) => {
    if (!result) return;
    exportResults(format, columns, filteredRows);
    setExportOpen(false);
  };

  const handleCopy = (format: ExportFormat) => {
    if (!result) return;
    void copyToClipboard(format, columns, filteredRows);
    setExportOpen(false);
  };

  return (
    <div className="flex items-center justify-between border-b border-border/50 bg-card/80 backdrop-blur px-4 h-11 flex-shrink-0">
      <div className="flex items-center gap-3">
        {/* Panel tabs — segment control */}
        <div className="inline-flex rounded-lg bg-muted p-0.5">
          <button
            onClick={() => {
              setPanelView("grid");
              setViewMode("grid");
            }}
            className={`px-2 py-0.5 rounded-md text-xs font-mono transition-all duration-150 ${
              panelView !== "history" && viewMode === "grid"
                ? "bg-accent text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Grid
          </button>
          <button
            onClick={() => {
              setPanelView("record");
              setViewMode("record");
            }}
            className={`px-2 py-0.5 rounded-md text-xs font-mono transition-all duration-150 ${
              panelView !== "history" && viewMode === "record"
                ? "bg-accent text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            disabled={!result?.rows.length || !!virtualQuery}
          >
            Record
          </button>
          {hasExplain && (
            <button
              onClick={() => setPanelView("explain")}
              className={`px-2 py-0.5 rounded-md text-xs font-mono transition-all duration-150 flex items-center gap-1 ${
                panelView === "explain"
                  ? "bg-accent text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <GitBranch className="h-3 w-3" />
              Explain
            </button>
          )}
          <button
            onClick={() => setPanelView("history")}
            className={`px-2 py-0.5 rounded-md text-xs font-mono transition-all duration-150 flex items-center gap-1 ${
              panelView === "history"
                ? "bg-accent text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <History className="h-3 w-3" />
            History
          </button>
          {result && hasGeometryColumn(columns, filteredRows) && (
            <button
              onClick={() => setPanelView("map")}
              className={`px-2 py-0.5 rounded-md text-xs font-mono transition-all duration-150 flex items-center gap-1 ${
                panelView === "map"
                  ? "bg-accent text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Map
            </button>
          )}
        </div>

        {/* Result stats */}
        {panelView !== "history" && result && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {isExecuting ? (
              <Loader2 className="h-3 w-3 animate-spin text-primary" />
            ) : (
              <CheckCircle2 className="h-3 w-3 text-success" />
            )}
            <span>
              {virtualQuery
                ? `${virtualQuery.totalRows.toLocaleString()} rows (virtual)`
                : `${result.rows.length.toLocaleString()} rows`}
              {result.capped && !virtualQuery && (
                <span className="text-warning ml-1">(capped at 500K)</span>
              )}
            </span>
            <span className="text-muted-foreground/50">&bull;</span>
            <Clock className="h-3 w-3" />
            <span>{result.time.toFixed(0)}ms</span>
            {isEditing && editState?.cellEdits.size ? (
              <>
                <span className="text-muted-foreground/50">&bull;</span>
                <span className="text-amber-500 font-medium">{editState.cellEdits.size} edit{editState.cellEdits.size !== 1 ? "s" : ""}</span>
              </>
            ) : null}
            {isEditing && editState?.deletedRows.size ? (
              <>
                <span className="text-muted-foreground/50">&bull;</span>
                <span className="text-destructive font-medium">{editState.deletedRows.size} delete{editState.deletedRows.size !== 1 ? "s" : ""}</span>
              </>
            ) : null}
          </div>
        )}

        {/* Stop button — visible while executing */}
        {isExecuting && onCancel && (
          <button
            onClick={onCancel}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-mono border border-destructive/50 text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Square className="h-3 w-3" />
            Stop
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        {isEditing ? (
          <>
            {/* Edit mode: double-click a value or select a row and press Delete to stage
                changes, then Commit or Discard. Other toolbar actions don't apply mid-edit
                and are hidden rather than shown disabled. */}
            {editError && (
              <span className="text-xs text-destructive max-w-[200px] truncate" title={editError}>
                {editError}
              </span>
            )}
            <button
              onClick={onCommit}
              disabled={((editState?.cellEdits.size ?? 0) === 0 && (editState?.deletedRows.size ?? 0) === 0) || isCommitting}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono bg-success text-success-foreground hover:bg-success/90 transition-colors disabled:opacity-50"
            >
              {isCommitting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Save className="h-3 w-3" />
              )}
              Commit
            </button>
            <button
              onClick={onDiscard}
              disabled={isCommitting}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
            >
              <X className="h-3 w-3" />
              Discard
            </button>
          </>
        ) : (
          <>
            {/* Pin / Diff */}
            {panelView !== "history" && result && result.rows.length > 0 && !virtualQuery && (
              <>
                {pinnedResult ? (
                  <div className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono bg-primary/10 text-primary border border-primary/20">
                    <Pin className="h-3 w-3" />
                    <span>Pinned: {pinnedResult.label}</span>
                    <button
                      onClick={clearPinnedResult}
                      className="hover:text-destructive ml-1"
                      title="Clear pinned result"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() =>
                      pinResult(
                        { columns, rows: filteredRows, time: result.time },
                        `${filteredRows.length} rows`,
                      )
                    }
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    title="Pin current results for later diff comparison"
                  >
                    <Pin className="h-3 w-3" />
                    Pin
                  </button>
                )}
                {pinnedResult && (
                  <button
                    onClick={() => setPanelView(panelView === "diff" ? "grid" : "diff")}
                    className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono transition-colors ${
                      panelView === "diff"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                  >
                    <Diff className="h-3 w-3" />
                    Diff
                  </button>
                )}
              </>
            )}

            {/* Export dropdown */}
            {panelView !== "history" && result && result.rows.length > 0 && !virtualQuery && (
              <div className="relative" ref={exportRef}>
                <button
                  onClick={() => setExportOpen(!exportOpen)}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  <Download className="h-3 w-3" />
                  Export
                </button>
                {exportOpen && createPortal(
                  <>
                    <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={() => setExportOpen(false)} />
                    <div
                      className="fixed w-52 rounded-md border border-border bg-popover shadow-md py-1"
                      style={{
                        zIndex: 9999,
                        top: (() => { const r = exportRef.current?.getBoundingClientRect(); return r ? r.bottom + 4 : 0; })(),
                        left: (() => { const r = exportRef.current?.getBoundingClientRect(); return r ? Math.max(0, r.right - 208) : 0; })(),
                      }}
                    >
                      <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                        Download
                      </div>
                      {(["csv", "json", "sql", "markdown", "xml"] as ExportFormat[]).map((fmt) => (
                        <button
                          key={fmt}
                          onClick={() => handleExport(fmt)}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-accent transition-colors"
                        >
                          <Download className="h-3 w-3 text-muted-foreground" />
                          {fmt.toUpperCase()}
                        </button>
                      ))}
                      <div className="border-t border-border my-1" />
                      <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                        Copy to clipboard
                      </div>
                      {(["csv", "json", "sql", "markdown"] as ExportFormat[]).map((fmt) => (
                        <button
                          key={`copy-${fmt}`}
                          onClick={() => handleCopy(fmt)}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-accent transition-colors"
                        >
                          <Copy className="h-3 w-3 text-muted-foreground" />
                          {fmt.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </>,
                  document.body
                )}
              </div>
            )}
          </>
        )}

        {/* Filter — re-queries the database rather than filtering already-loaded rows, so it
            stays available for virtual/paginated results too. Stays visible in edit mode. */}
        {panelView !== "history" && result && (
          <button
            onClick={onToggleFilter}
            title="Filter results (Cmd/Ctrl+F)"
            className={`relative flex items-center h-7 px-2 rounded text-xs font-mono transition-colors ${
              filterOpen ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"
            }`}
          >
            <FilterIcon className="h-3.5 w-3.5" />
            {hasActiveFilter && (
              <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-primary" />
            )}
          </button>
        )}
      </div>

      {/* Destructive-delete confirmation — shown when committing staged row deletes */}
      <Dialog open={!!pendingCommit} onOpenChange={(open) => { if (!open) onCancelCommit(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete rows</DialogTitle>
            <DialogDescription>
              Are you sure you want to permanently delete {pendingCommit?.deleteCount ?? 0} row{pendingCommit?.deleteCount !== 1 ? "s" : ""}? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={onCancelCommit}
              className="px-3 py-1.5 rounded-lg text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onConfirmCommit}
              className="px-3 py-1.5 rounded-lg text-xs font-mono bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
            >
              Yes, delete {pendingCommit?.deleteCount ?? 0} row{pendingCommit?.deleteCount !== 1 ? "s" : ""}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DiffView({
  pinnedColumns,
  pinnedRows,
  currentColumns,
  currentRows,
}: {
  pinnedColumns: string[];
  pinnedRows: string[][];
  currentColumns: string[];
  currentRows: string[][];
}) {
  const [diffResult, setDiffResult] = useState<{
    added: string[][];
    removed: string[][];
    unchangedCount: number;
  } | null>(null);
  const [computing, setComputing] = useState(false);

  const colsMatch =
    pinnedColumns.length === currentColumns.length && pinnedColumns.every((c, i) => c === currentColumns[i]);

  // Compute diff in Rust backend for performance
  const prevKeyRef = useRef("");
  const diffKey = `${pinnedRows.length}:${currentRows.length}`;
  if (diffKey !== prevKeyRef.current && colsMatch) {
    prevKeyRef.current = diffKey;
    setComputing(true);
    setDiffResult(null);

    // Pack rows into the compact wire format for Rust
    const CELL_SEP = "\x1F";
    const ROW_SEP = "\x1E";
    const packRows = (columns: string[], rows: string[][]) => {
      const header = columns.join(CELL_SEP);
      if (rows.length === 0) return header;
      return header + ROW_SEP + rows.map((r) => r.join(CELL_SEP)).join(ROW_SEP);
    };

    const pinnedPacked = packRows(pinnedColumns, pinnedRows);
    const currentPacked = packRows(currentColumns, currentRows);

    invoke<[string, string, number]>("compute_diff", {
      pinned_packed: pinnedPacked,
      current_packed: currentPacked,
    }).then(([addedPacked, removedPacked, unchangedCount]) => {
      const unpackRows = (packed: string): string[][] => {
        if (!packed) return [];
        const parts = packed.split(ROW_SEP);
        // Skip header (index 0)
        return parts.slice(1).map((r) => r.split(CELL_SEP));
      };
      setDiffResult({
        added: unpackRows(addedPacked),
        removed: unpackRows(removedPacked),
        unchangedCount,
      });
      setComputing(false);
    }).catch(() => {
      // Fallback: compute in JS if Rust command fails
      const pinnedSet = new Set(pinnedRows.map((r) => r.join(CELL_SEP)));
      const currentSet = new Set(currentRows.map((r) => r.join(CELL_SEP)));
      setDiffResult({
        added: currentRows.filter((r) => !pinnedSet.has(r.join(CELL_SEP))),
        removed: pinnedRows.filter((r) => !currentSet.has(r.join(CELL_SEP))),
        unchangedCount: currentRows.filter((r) => pinnedSet.has(r.join(CELL_SEP))).length,
      });
      setComputing(false);
    });
  }

  if (!colsMatch) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground gap-2 p-4">
        <Diff className="h-8 w-8" />
        <div className="text-sm font-mono">Column structures differ</div>
        <div className="text-xs">Pinned: {pinnedColumns.join(", ")}</div>
        <div className="text-xs">Current: {currentColumns.join(", ")}</div>
      </div>
    );
  }

  if (computing || !diffResult) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground gap-2">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Computing diff...</span>
      </div>
    );
  }

  const { added, removed, unchangedCount } = diffResult;

  return (
    <div className="flex-1 overflow-auto p-4 font-mono text-xs">
      <div className="flex items-center gap-4 mb-3">
        <span className="flex items-center gap-1 text-success">
          <span className="h-2 w-2 rounded-full bg-success" /> +{added.length} added
        </span>
        <span className="flex items-center gap-1 text-destructive">
          <span className="h-2 w-2 rounded-full bg-destructive" /> -{removed.length} removed
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">={unchangedCount} unchanged</span>
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="border border-border px-2 py-1 text-left bg-secondary text-[10px] w-8" />
            {pinnedColumns.map((col) => (
              <th key={col} className="border border-border px-2 py-1 text-left bg-secondary text-[10px]">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {removed.map((row, i) => (
            <tr key={`r-${i}`} className="bg-destructive/10">
              <td className="border border-border px-2 py-0.5 text-destructive text-center">-</td>
              {row.map((cell, j) => (
                <td key={j} className="border border-border px-2 py-0.5 text-destructive">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
          {added.map((row, i) => (
            <tr key={`a-${i}`} className="bg-success/10">
              <td className="border border-border px-2 py-0.5 text-success text-center">+</td>
              {row.map((cell, j) => (
                <td key={j} className="border border-border px-2 py-0.5 text-success">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
