import { Loader2, X, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CSVImportModal } from "@/components/csv-import-modal";
import { ResizeHandle } from "@/components/resize-handle";
import { DriverFactory } from "@/lib/database-driver";
import { cellText } from "@/lib/wire";
import { useProjectStore } from "@/stores/project-store";
import { useActiveTab, useTabStore } from "@/stores/tab-store";
import { useUIStore } from "@/stores/ui-store";
import { ExplainPanel } from "../explain-panel";
import { FilterBar } from "../filter-bar";
import { QueryHistory } from "../query-history";
import { RelationPickerModal } from "../relation-picker-modal";
import { ResultsGrid } from "../results-grid";
import { ResultsMap } from "../results-map";
import { ResultsRecord } from "../results-record";
import { DiffView } from "./diff-view";
import { RowDetailPanel } from "./row-detail-panel";
import { ResultsToolbar } from "./toolbar";
import type { PanelView } from "./types";
import { useEditMode } from "./use-edit-mode";
import { useFilterSort } from "./use-filter-sort";
import { useVirtualPaging } from "./use-virtual-paging";

export function ResultsPanel() {
  const activeTab = useActiveTab();
  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const pinnedResult = useUIStore((s) => s.pinnedResult);
  const rowDetailPanelOpen = useUIStore((s) => s.rowDetailPanelOpen);
  const toggleRowDetailPanel = useUIStore((s) => s.toggleRowDetailPanel);
  const setRowDetailPanelWidth = useUIStore((s) => s.setRowDetailPanelWidth);
  const [panelView, setPanelView] = useState<PanelView>("grid");
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce search term — avoids filtering 50K rows on every keystroke
  useEffect(() => {
    if (!searchTerm.trim()) {
      setDebouncedSearch("");
      return;
    }
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), 200);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const result = activeTab?.result;
  const isExecuting = activeTab?.isExecuting;
  const vq = activeTab?.virtualQuery;
  const groupResults = activeTab?.results;
  const activeResultIndex = activeTab?.activeResultIndex ?? 0;
  const selectResult = useTabStore((s) => s.selectResult);

  const handleCancel = useCallback(async () => {
    if (!activeTab?.projectId || !activeTab.isExecuting || !activeTab.execId) return;
    const d = useProjectStore.getState().projects[activeTab.projectId];
    if (!d) return;
    try {
      const driver = DriverFactory.getDriver(d.driver);
      await driver.cancelQuery?.(activeTab.execId);
    } catch (err) {
      console.error("Failed to cancel query:", err);
    }
  }, [activeTab?.projectId, activeTab?.isExecuting, activeTab?.execId]);

  const { gridRef, handlePageNeeded, handleViewportRowChange, restoreRowIndex } = useVirtualPaging({
    vq,
    projectId: activeTab?.projectId,
  });

  const handleFitColumns = useCallback(() => gridRef.current?.fitColumns(), [gridRef]);

  // Right-click "Refresh" — a plain re-run of the current query, deliberately
  // not routed through useFilterSort's applyFilter: that skips re-running SQL
  // it already applied, which is the one thing a forced refresh must not do.
  const handleRefresh = useCallback(async () => {
    if (!activeTab?.projectId || !activeTab.editorValue.trim()) return;
    const tabId = activeTab.id;
    const projectId = activeTab.projectId;
    const d = useProjectStore.getState().projects[projectId];
    if (!d) return;
    const driver = DriverFactory.getDriver(d.driver);
    useTabStore.getState().setExecuting(tabId, true);
    try {
      const [cols, rows, time] = await driver.runQuery(projectId, activeTab.editorValue);
      useTabStore.getState().updateResult(tabId, { columns: cols, rows, time });
    } catch {
      useTabStore.getState().setExecuting(tabId, false);
    }
  }, [activeTab?.projectId, activeTab?.editorValue, activeTab?.id]);

  const {
    isEditing,
    editError,
    setEditError,
    isCommitting,
    confirmingApply,
    pending,
    sessionMatchesEditor,
    editableTable,
    fkMap,
    columnTypes,
    filterColumnKinds,
    editedCells,
    deletedRowIndices,
    insertRows,
    handleUndo,
    handleFKNavigate,
    handleEnterEdit,
    handleDiscard,
    handleRequestApply,
    handleConfirmApply,
    handleCancelApply,
    handleCellEdit,
    handleRowDelete,
    handleRowRestore,
    handleAddRow,
    handleDuplicateRow,
    handlePasteRows,
  } = useEditMode({
    tabId: activeTab?.id,
    projectId: activeTab?.projectId,
    editorValue: activeTab?.editorValue,
    result,
  });

  const [csvImportTarget, setCsvImportTarget] = useState<{ columns: string[] } | null>(null);
  const handleImport = useCallback(async () => {
    if (!editableTable || !activeTab?.projectId) return;
    const cols = await useProjectStore
      .getState()
      .loadColumns(activeTab.projectId, editableTable.schema, editableTable.table);
    setCsvImportTarget({ columns: cols });
  }, [editableTable, activeTab?.projectId]);

  // Search-filtering trims which rows are shown, but nothing else knows about
  // that — edit-session row identity and the insert row's position are both
  // computed against the unfiltered result. That's fine while editing, since
  // search is already disabled then; it now also has to stay disabled the
  // moment an editable table's blank insert row appears, or double-clicking
  // it would target the wrong row entirely.
  const filteredRows = useMemo(() => {
    if (isEditing || editableTable) return result?.rows ?? [];
    if (!result || !debouncedSearch.trim()) return result?.rows ?? [];
    const term = debouncedSearch.toLowerCase();
    return result.rows.filter((row) =>
      row.some((cell) => cellText(cell).toLowerCase().includes(term)),
    );
  }, [result, debouncedSearch, isEditing, editableTable]);

  // insertRows already decides whether there is anything to offer (an active
  // session's drafts, or a lone invitation row on an empty editable result) —
  // vq is still checked directly since a virtual (paged) query has no stable
  // "end of results" to append a row to.
  const canInsert = !vq && insertRows.length > 0;
  const gridRows = useMemo(
    () => (canInsert ? [...filteredRows, ...insertRows] : filteredRows),
    [canInsert, filteredRows, insertRows],
  );
  const insertRowStart = canInsert ? filteredRows.length : undefined;

  const {
    filterState,
    hasActiveFilter,
    filterError,
    setFilterError,
    handleFilterChange,
    applyFilter,
    handleSortColumn,
    toggleFilterBar,
  } = useFilterSort({
    tabId: activeTab?.id,
    filter: activeTab?.filter,
    result,
    editableTable,
    filterColumnKinds,
    panelView,
  });

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
    const currentValue =
      editedCells.get(key) ?? result.rows[fkPicker.rowIndex]?.[fkPicker.colIndex] ?? "";
    const nullable = columnTypes.get(colName)?.nullable ?? true;
    return {
      rowIndex: fkPicker.rowIndex,
      colIndex: fkPicker.colIndex,
      ...target,
      currentValue,
      nullable,
    };
  }, [fkPicker, result, activeTab?.projectId, fkMap, editedCells, columnTypes]);

  const explainResult = activeTab?.explainResult;
  const hasExplain = !!explainResult;

  const toolbarProps = {
    filterOpen: filterState.open,
    hasActiveFilter,
    onToggleFilter: toggleFilterBar,
    panelView,
    setPanelView,
    searchTerm,
    setSearchTerm,
    setViewMode,
    viewMode,
    hasExplain,
    isExecuting: !!isExecuting,
    isEditing,
    editableTable: !!editableTable && !vq,
    isCommitting,
    editError,
    pending,
    sessionMatchesEditor,
    confirmingApply,
    onEnterEdit: handleEnterEdit,
    onRequestApply: handleRequestApply,
    onConfirmApply: handleConfirmApply,
    onCancelApply: handleCancelApply,
    onDiscard: handleDiscard,
    onCancel: handleCancel,
    virtualQuery: vq,
    onFitColumns: handleFitColumns,
  };

  if (panelView === "explain" && hasExplain) {
    return (
      <div className="flex h-full flex-col border-t border-border bg-card">
        <ResultsToolbar
          {...toolbarProps}
          result={result ?? null}
          columns={result?.columns ?? []}
          filteredRows={filteredRows}
          filteredCount={filteredRows.length}
        />
        <ExplainPanel plan={explainResult} />
      </div>
    );
  }

  if (panelView !== "history" && isExecuting && !result) {
    return (
      <div className="flex h-full flex-col">
        <ResultsToolbar
          {...toolbarProps}
          result={null}
          columns={[]}
          filteredRows={[]}
          filteredCount={0}
        />
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
        <ResultsToolbar
          {...toolbarProps}
          result={result ?? null}
          columns={result?.columns ?? []}
          filteredRows={filteredRows}
          filteredCount={filteredRows.length}
        />
        <QueryHistory />
      </div>
    );
  }

  if (panelView === "diff" && pinnedResult && result) {
    return (
      <div className="flex h-full flex-col border-t border-border bg-card">
        <ResultsToolbar
          {...toolbarProps}
          result={result}
          columns={result.columns}
          filteredRows={filteredRows}
          filteredCount={filteredRows.length}
        />
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
        <ResultsToolbar
          {...toolbarProps}
          result={result}
          columns={result.columns}
          filteredRows={filteredRows}
          filteredCount={filteredRows.length}
        />
        <ResultsMap columns={result.columns} rows={filteredRows} />
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex h-full flex-col">
        <ResultsToolbar
          {...toolbarProps}
          result={null}
          columns={[]}
          filteredRows={[]}
          filteredCount={0}
        />
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          No data to display
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col border-t border-border bg-card">
      <ResultsToolbar
        {...toolbarProps}
        result={result}
        columns={result.columns}
        filteredRows={filteredRows}
        filteredCount={filteredRows.length}
      />
      {groupResults && groupResults.length > 1 && activeTab && (
        <div className="flex items-center gap-1 border-b border-border/30 bg-muted/20 px-2 py-1 overflow-x-auto">
          {groupResults.map((r, i) => (
            <button
              key={`${i}-${r.sql}`}
              type="button"
              onClick={() => selectResult(activeTab.id, i)}
              className={`shrink-0 rounded px-2 py-0.5 text-xs font-mono transition-colors ${
                i === activeResultIndex
                  ? r.error
                    ? "bg-destructive/15 text-destructive"
                    : "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-muted/50"
              }`}
              title={r.sql?.trim()}
            >
              Query {i + 1}
              {r.error ? " ✗" : ` · ${r.rows.length}`}
            </button>
          ))}
        </div>
      )}
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
          <button
            type="button"
            onClick={() => setFilterError(null)}
            className="ml-auto hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {editError && !isEditing && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-destructive/10 text-destructive text-xs border-b border-border">
          <XCircle className="h-3 w-3" />
          {editError}
          <button
            type="button"
            onClick={() => setEditError(null)}
            className="ml-auto hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      <div className="flex flex-1 min-h-0">
        <div className="flex flex-1 min-w-0 flex-col">
          {viewMode === "grid" ? (
            <ResultsGrid
              key={activeTab?.id ?? "results-grid"}
              columns={result.columns}
              rows={gridRows}
              isEditing={isEditing}
              editable={!!editableTable && !vq}
              cellEdits={editedCells}
              deletedRows={deletedRowIndices}
              columnTypes={columnTypes}
              insertRowStart={insertRowStart}
              onCellEdit={handleCellEdit}
              onRowDelete={handleRowDelete}
              onRowRestore={handleRowRestore}
              onUndo={handleUndo}
              fkColumns={fkMap}
              onFKNavigate={handleFKNavigate}
              onFKPickerOpen={handleFKPickerOpen}
              sort={activeTab?.sort}
              onSortColumn={handleSortColumn}
              onRefresh={!vq ? handleRefresh : undefined}
              onAddRow={!vq && editableTable ? handleAddRow : undefined}
              onDuplicateRow={!vq && editableTable ? handleDuplicateRow : undefined}
              onPasteRows={!vq && editableTable ? handlePasteRows : undefined}
              onImport={!vq && editableTable ? handleImport : undefined}
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
        </div>
        {rowDetailPanelOpen && (
          <>
            <ResizeHandle direction="horizontal" onResize={(d) => setRowDetailPanelWidth(-d)} />
            <RowDetailPanel
              columns={result.columns}
              rows={gridRows}
              editedCells={editedCells}
              deletedRows={deletedRowIndices}
              columnTypes={columnTypes}
              canEdit={!!editableTable && !vq && result.rows.length > 0}
              onCellEdit={handleCellEdit}
              onClose={toggleRowDetailPanel}
            />
          </>
        )}
      </div>
      {fkPickerInfo && activeTab?.projectId && (
        <RelationPickerModal
          open
          onOpenChange={(v) => {
            if (!v) setFkPicker(null);
          }}
          projectId={activeTab.projectId}
          schema={fkPickerInfo.schema}
          table={fkPickerInfo.table}
          column={fkPickerInfo.column}
          nullable={fkPickerInfo.nullable}
          currentValue={fkPickerInfo.currentValue}
          onSelect={(value) => {
            handleCellEdit(fkPickerInfo.rowIndex, fkPickerInfo.colIndex, value);
            setFkPicker(null);
          }}
        />
      )}
      {csvImportTarget && editableTable && activeTab?.projectId && (
        <CSVImportModal
          open
          onOpenChange={(v) => {
            if (!v) setCsvImportTarget(null);
          }}
          projectId={activeTab.projectId}
          schema={editableTable.schema}
          table={editableTable.table}
          tableColumns={csvImportTarget.columns}
        />
      )}
    </div>
  );
}
