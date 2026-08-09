import { useRef, useMemo, useState, useCallback, useEffect, useImperativeHandle, useLayoutEffect, type MutableRefObject } from "react";
import DataEditor, {
  type GridColumn,
  type GridCell,
  GridCellKind,
  type Item,
  type EditableGridCell,
  type Theme,
  type GridSelection,
  type GridKeyEventArgs,
  type CellClickedEventArgs,
  CompactSelection,
  type DataEditorRef,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { createPortal } from "react-dom";
import { useUIStore } from "@/stores/ui-store";
import * as virtualCache from "@/lib/virtual-cache";
import type { VirtualQuery } from "@/types";
import { formatNumericDisplay, type ColumnEditInfo } from "@/lib/column-edit-kind";
import type { SortState } from "@/types";
import {
  makeTypedEditCell, typedEditCellRenderer, type TypedEditCell,
  makeFKCell, fkCellRenderer, FK_ARROW_ZONE_WIDTH,
} from "./results-grid-typed-cell";
import { Pencil, ExternalLink } from "lucide-react";

interface ResultsGridProps {
  columns: string[];
  rows: string[][];
  /** Maps a displayed row's position (e.g. after search filtering) back to its index
   * in the unfiltered result — cellEdits/deletedRows/onCellEdit/onRowDelete/onRowRestore
   * all key off that original index. Omit when `rows` is already the unfiltered set. */
  rowIndexMap?: number[];
  isEditing?: boolean;
  /** When true (and not isEditing), plain cells can still be double-clicked to edit a single value directly. */
  editable?: boolean;
  cellEdits?: Map<string, string>;
  deletedRows?: Set<number>;
  /** Column name -> how to edit it (enum dropdown, date/timestamp picker, boolean toggle). */
  columnTypes?: Map<string, ColumnEditInfo>;
  onCellEdit?: (rowIndex: number, colIndex: number, value: string) => void;
  onRowDelete?: (rowIndex: number) => void;
  onRowRestore?: (rowIndex: number) => void;
  /** Ctrl/Cmd+Z — undo the last cell edit or row delete/restore. */
  onUndo?: () => void;
  fkColumns?: Map<string, { schema: string; table: string; column: string }>;
  onFKNavigate?: (colName: string, value: string) => void;
  /** Double-click (or Enter/Space) on an FK cell while editable — opens the relation picker instead of a plain text editor. */
  onFKPickerOpen?: (rowIndex: number, colIndex: number) => void;
  /** Clicking any cell (outside the FK arrow hotspot) while the grid isn't editing/editable — lets a
   *  read-only grid double as a row picker (e.g. the relation picker modal). */
  onRowClick?: (rowIndex: number) => void;
  /** Current column sort (persisted on the tab), shown as an arrow in the header title. */
  sort?: SortState;
  /** Clicking a column header — cycles that column asc -> desc -> unsorted. */
  onSortColumn?: (colIndex: number) => void;
  virtualQuery?: VirtualQuery;
  onPageNeeded?: (pageIndex: number) => void;
  onViewportRowChange?: (topRow: number) => void;
  restoreRowIndex?: number; // can be fractional when smooth scroll is active
  viewportKey?: string;
  gridRef?: MutableRefObject<{ invalidatePage: (pageIndex: number) => void } | null>;
}

const MIN_COL_WIDTH = 80;
const MAX_COL_WIDTH = 400;
const CHAR_WIDTH = 7.5;
const PADDING = 24;
const GRID_ROW_HEIGHT = 32;

function cellToCopyText(cell: GridCell): string {
  if (cell.copyData !== undefined) return cell.copyData;
  if (cell.kind === GridCellKind.Boolean) return cell.data === true ? "true" : cell.data === false ? "false" : "";
  return "data" in cell ? String(cell.data ?? "") : "";
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Pre-allocated static cell for unloaded virtual rows — avoids GC pressure
const LOADING_CELL: GridCell = {
  kind: GridCellKind.Text,
  data: "",
  displayData: "\u2026",
  allowOverlay: false,
  readonly: true,
  themeOverride: { textDark: "#888", textLight: "#666" },
};

export function ResultsGrid({
  columns,
  rows,
  rowIndexMap,
  isEditing,
  editable,
  cellEdits,
  deletedRows,
  columnTypes,
  onCellEdit,
  onRowDelete,
  onRowRestore,
  onUndo,
  fkColumns,
  onFKNavigate,
  onFKPickerOpen,
  onRowClick,
  sort,
  onSortColumn,
  virtualQuery,
  onPageNeeded,
  onViewportRowChange,
  restoreRowIndex,
  viewportKey,
  gridRef,
}: ResultsGridProps) {
  const theme = useUIStore((s) => s.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const dataEditorRef = useRef<DataEditorRef>(null);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 400 });
  const visibleRangeRef = useRef({ y: 0, height: 0 });

  useImperativeHandle(gridRef ?? { current: null }, () => ({
    invalidatePage: (_pageIndex: number) => {
      if (!virtualQuery) return;
      const totalRows = virtualQuery.totalRows;
      if (totalRows <= 0) return;

      const range = visibleRangeRef.current;
      const visibleStart = Math.max(0, Math.floor(range.y) - 2);
      const fallbackVisibleRows = Math.max(24, Math.ceil(containerSize.height / GRID_ROW_HEIGHT) + 4);
      const effectiveHeight = range.height > 0 ? range.height : fallbackVisibleRows;
      const visibleEnd = Math.min(totalRows - 1, Math.ceil(range.y + effectiveHeight) + 2);
      if (visibleStart > visibleEnd) return;

      const cells: { cell: Item }[] = [];
      for (let row = visibleStart; row <= visibleEnd; row++) {
        for (let col = 0; col < columns.length; col++) {
          cells.push({ cell: [col, row] });
        }
      }
      if (cells.length > 0) {
        dataEditorRef.current?.updateCells(cells);
      }
    },
  }), [columns.length, containerSize.height, virtualQuery]);

  // Observe container size (debounced to avoid mid-scroll re-renders)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let rafId = 0;
    const obs = new ResizeObserver((entries) => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const { width, height } = entries[0].contentRect;
        const w = Math.round(width);
        const h = Math.round(height);
        setContainerSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
      });
    });
    obs.observe(el);
    return () => {
      cancelAnimationFrame(rafId);
      obs.disconnect();
    };
  }, []);

  // Calculate column widths based on content
  const gridColumns = useMemo((): GridColumn[] => {
    const sampleRows = rows.slice(0, 100);
    return columns.map((col, colIdx) => {
      let maxLen = col.length + 2;
      for (const row of sampleRows) {
        const cellLen = (row[colIdx] ?? "").length;
        if (cellLen > maxLen) maxLen = cellLen;
      }
      const width = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, maxLen * CHAR_WIDTH + PADDING));
      const arrow = sort?.column === col ? (sort.direction === "asc" ? " ▲" : " ▼") : "";
      return { title: col + arrow, id: col, width };
    });
  }, [columns, rows, sort]);

  // Per-column edit widget kind, aligned to `columns` — undefined means plain text.
  const colEditInfo = useMemo(
    () => columns.map((col) => columnTypes?.get(col)),
    [columns, columnTypes],
  );

  // Build set of FK column indices for fast lookup
  const fkColIndices = useMemo(() => {
    if (!fkColumns || fkColumns.size === 0) return new Set<number>();
    const s = new Set<number>();
    columns.forEach((col, idx) => {
      if (fkColumns.has(col)) s.add(idx);
    });
    return s;
  }, [columns, fkColumns]);

  // Pre-compute theme override objects — avoids creating new objects per cell render
  const deletedOverride = useMemo(() => (
    { bgCell: "rgba(239, 68, 68, 0.1)", textDark: "#999", textLight: "#999" }
  ), []);
  const modifiedOverride = useMemo(() => (
    { bgCell: theme === "dark" ? "rgba(245, 158, 11, 0.15)" : "rgba(245, 158, 11, 0.1)" }
  ), [theme]);

  // Total row count: virtual mode uses totalRows, otherwise rows.length
  const totalRowCount = virtualQuery ? virtualQuery.totalRows : rows.length;

  // Restore previous viewport row when switching back to a tab/query.
  useLayoutEffect(() => {
    if (typeof restoreRowIndex !== "number" || totalRowCount <= 0) return;
    const targetRow = Math.min(restoreRowIndex, totalRowCount - 1);
    if (targetRow > 0) {
      dataEditorRef.current?.scrollTo(
        0,
        { amount: targetRow, unit: "cell" },
        "vertical",
        0,
        0,
        { vAlign: "start" },
      );
    }
    visibleRangeRef.current = { ...visibleRangeRef.current, y: targetRow };
    onViewportRowChange?.(targetRow);
  }, [viewportKey, restoreRowIndex, totalRowCount]);

  // Get cell content callback (the core of glide-data-grid)
  const getCellContent = useCallback(
    (cell: Item): GridCell => {
      const [colIdx, rowIdx] = cell;

      // Virtual mode: read from cache
      if (virtualQuery) {
        const pageIndex = Math.floor(rowIdx / virtualQuery.pageSize);
        const row = virtualCache.getRow(virtualQuery.queryId, rowIdx, virtualQuery.pageSize);
        if (!row) {
          onPageNeeded?.(pageIndex);
          const fallbackRow = rows[rowIdx];
          if (!fallbackRow) return LOADING_CELL;
          const value = fallbackRow[colIdx] ?? "";
          return {
            kind: GridCellKind.Text,
            data: value,
            displayData: value,
            allowOverlay: false,
            readonly: true,
          };
        }
        const value = row[colIdx] ?? "";
        return {
          kind: GridCellKind.Text,
          data: value,
          displayData: value,
          allowOverlay: false,
          readonly: true,
        };
      }

      const trueRowIdx = rowIndexMap ? rowIndexMap[rowIdx] : rowIdx;
      const key = `${trueRowIdx}:${colIdx}`;
      const isModified = cellEdits?.has(key);
      const isDeleted = deletedRows?.has(trueRowIdx);
      const isFK = fkColIndices.has(colIdx);
      const value = isModified ? cellEdits!.get(key)! : (rows[rowIdx]?.[colIdx] ?? "");
      const canOverlay = (!!isEditing || !!editable) && !isFK && !isDeleted;

      // Type info drives read-only display formatting regardless of edit access; the fancier
      // input widgets (dropdown/picker) only take over the cell when it's actually editable.
      const info = colEditInfo[colIdx];
      const widgetInfo = canOverlay ? info : undefined;
      const cellThemeOverride = isDeleted ? deletedOverride : isModified ? modifiedOverride : undefined;

      if (info?.kind === "boolean") {
        return {
          kind: GridCellKind.Boolean,
          allowOverlay: false,
          readonly: !canOverlay,
          data: value === "t" || value === "true" ? true : value === "f" || value === "false" ? false : null,
          themeOverride: cellThemeOverride,
        };
      }
      if (widgetInfo?.kind === "enum" || widgetInfo?.kind === "date" || widgetInfo?.kind === "time" || widgetInfo?.kind === "timestamp") {
        return makeTypedEditCell(value, widgetInfo.kind, widgetInfo.enumValues, !canOverlay, cellThemeOverride);
      }

      if (isFK) {
        return makeFKCell(value, cellThemeOverride);
      }

      const displayValue = info?.kind === "numeric" ? formatNumericDisplay(value) : value;

      const baseCell: GridCell = {
        kind: GridCellKind.Text,
        data: value,
        displayData: displayValue,
        allowOverlay: canOverlay,
        readonly: !canOverlay,
        themeOverride: cellThemeOverride,
      };

      return baseCell;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, rowIndexMap, cellEdits, deletedRows, isEditing, editable, theme, fkColIndices, virtualQuery, onPageNeeded, colEditInfo],
  );

  // Virtual scroll handler: trigger page loads on scroll (throttled via rAF)
  const scrollRafId = useRef(0);
  const handleVisibleRegionChanged = useCallback(
    (range: { x: number; y: number; width: number; height: number }) => {
      visibleRangeRef.current = { y: range.y, height: range.height };
      onViewportRowChange?.(Math.max(0, range.y));
      if (!virtualQuery || !onPageNeeded) return;
      cancelAnimationFrame(scrollRafId.current);
      scrollRafId.current = requestAnimationFrame(() => {
        const { y, height } = range;
        const ps = virtualQuery.pageSize;
        const firstVisible = Math.floor(y / ps);
        const lastVisible = Math.floor((y + height) / ps);
        for (let p = firstVisible - 1; p <= lastVisible + 3; p++) {
          if (p >= 0 && p * ps < virtualQuery.totalRows) {
            onPageNeeded(p);
          }
        }
      });
    },
    [virtualQuery, onPageNeeded, onViewportRowChange],
  );

  useEffect(() => () => {
    cancelAnimationFrame(scrollRafId.current);
  }, []);

  // Handle cell edit
  const onCellEdited = useCallback(
    (cell: Item, newVal: EditableGridCell) => {
      const [colIdx, rowIdx] = cell;
      let value: string | undefined;
      if (newVal.kind === GridCellKind.Text) {
        value = newVal.data;
        // Clearing a nullable cell to empty means "no value", not the empty-string literal.
        if (value === "" && colEditInfo[colIdx]?.nullable) value = "null";
      } else if (newVal.kind === GridCellKind.Boolean) {
        value = newVal.data === true ? "t" : newVal.data === false ? "f" : "null";
      } else if (newVal.kind === GridCellKind.Custom) {
        value = (newVal as TypedEditCell).data.value;
      }
      if (value === undefined) return;
      onCellEdit?.(rowIndexMap ? rowIndexMap[rowIdx] : rowIdx, colIdx, value);
    },
    [onCellEdit, rowIndexMap, colEditInfo],
  );

  // Tracks whether the most recent click on an FK cell landed in its arrow hotspot — read by
  // handleCellActivated so a double-click on the arrow navigates once instead of also opening
  // the edit picker (the two actions would otherwise fire together on that second click).
  const lastFKClickRef = useRef({ col: -1, row: -1, inArrow: false });

  // FK cell click: only the reserved arrow zone at the cell's right edge navigates to the
  // referenced row (see FK_ARROW_ZONE_WIDTH) — clicking the value text just selects, same as
  // any other cell. Works in every mode; it's an explicit, unambiguous hotspot.
  // Any other click, when the grid is read-only (not editing/editable) and `onRowClick` is
  // wired up, picks that row instead — this is how a plain view-only grid doubles as a picker.
  const handleRowClick = useCallback(
    (cell: Item, event: CellClickedEventArgs) => {
      const [colIdx, rowIdx] = cell;
      if (fkColIndices.has(colIdx)) {
        const inArrow = event.localEventX >= event.bounds.width - FK_ARROW_ZONE_WIDTH;
        lastFKClickRef.current = { col: colIdx, row: rowIdx, inArrow };
        if (inArrow && !virtualQuery && onFKNavigate) {
          const colName = columns[colIdx];
          const value = rows[rowIdx]?.[colIdx] ?? "";
          if (value && value !== "null") onFKNavigate(colName, value);
          return;
        }
      }

      if (onRowClick && !isEditing && !editable && !virtualQuery) {
        onRowClick(rowIndexMap ? rowIndexMap[rowIdx] : rowIdx);
      }
    },
    [fkColIndices, virtualQuery, onFKNavigate, columns, rows, onRowClick, isEditing, editable, rowIndexMap],
  );

  // Cell activate (double-click / Enter / Space) on an editable FK cell → open the relation
  // picker instead of the plain text editor glide would otherwise show (allowOverlay is false
  // for FK cells specifically so it never does). Skipped if the triggering click landed on the
  // arrow hotspot — that click already navigated, and shouldn't also pop the picker open.
  const handleCellActivated = useCallback(
    (cell: Item) => {
      if (virtualQuery || !onFKPickerOpen || (!isEditing && !editable)) return;
      const [colIdx, rowIdx] = cell;
      if (!fkColIndices.has(colIdx)) return;
      const last = lastFKClickRef.current;
      if (last.col === colIdx && last.row === rowIdx && last.inArrow) return;
      const trueRowIdx = rowIndexMap ? rowIndexMap[rowIdx] : rowIdx;
      if (deletedRows?.has(trueRowIdx)) return;
      onFKPickerOpen(trueRowIdx, colIdx);
    },
    [virtualQuery, onFKPickerOpen, isEditing, editable, fkColIndices, rowIndexMap, deletedRows],
  );

  // Right-click on an FK cell → small menu offering both actions explicitly, instead of relying
  // solely on the arrow hotspot / double-click gestures.
  const [fkMenu, setFkMenu] = useState<{
    x: number; y: number; rowIndex: number; colIndex: number; colName: string; value: string;
  } | null>(null);

  const handleCellContextMenu = useCallback(
    (cell: Item, event: CellClickedEventArgs) => {
      if (virtualQuery) return;
      const [colIdx, rowIdx] = cell;
      if (!fkColIndices.has(colIdx)) return;
      event.preventDefault();
      setFkMenu({
        x: event.bounds.x + event.localEventX,
        y: event.bounds.y + event.localEventY,
        rowIndex: rowIdx,
        colIndex: colIdx,
        colName: columns[colIdx],
        value: rows[rowIdx]?.[colIdx] ?? "",
      });
    },
    [virtualQuery, fkColIndices, columns, rows],
  );

  const closeFkMenu = useCallback(() => setFkMenu(null), []);

  const fkMenuCanEdit = !!onFKPickerOpen && (!!isEditing || !!editable)
    && !deletedRows?.has(fkMenu ? (rowIndexMap ? rowIndexMap[fkMenu.rowIndex] : fkMenu.rowIndex) : -1);
  const fkMenuCanOpen = !!onFKNavigate && !!fkMenu && fkMenu.value !== "" && fkMenu.value !== "null";

  // Theme for glide-data-grid
  const gridTheme = useMemo((): Partial<Theme> => {
    if (theme === "dark") {
      return {
        accentColor: "hsl(260, 70%, 60%)",
        accentLight: "hsla(260, 70%, 60%, 0.15)",
        bgCell: "hsl(250, 15%, 13%)",
        bgCellMedium: "hsl(250, 15%, 15%)",
        bgHeader: "hsl(250, 15%, 18%)",
        bgHeaderHasFocus: "hsl(250, 15%, 22%)",
        bgHeaderHovered: "hsl(250, 15%, 20%)",
        borderColor: "hsl(250, 12%, 22%)",
        drilldownBorder: "hsl(250, 12%, 30%)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        headerFontStyle: "bold 12px",
        baseFontStyle: "12px",
        textDark: "hsl(250, 15%, 85%)",
        textMedium: "hsl(250, 10%, 60%)",
        textLight: "hsl(250, 10%, 45%)",
        textHeader: "hsl(250, 15%, 75%)",
        textHeaderSelected: "hsl(260, 70%, 75%)",
        bgBubble: "hsl(250, 15%, 20%)",
        bgBubbleSelected: "hsl(260, 70%, 60%)",
        textBubble: "hsl(250, 15%, 85%)",
      };
    }
    return {
      accentColor: "hsl(260, 70%, 55%)",
      accentLight: "hsla(260, 70%, 55%, 0.1)",
      bgCell: "#ffffff",
      bgCellMedium: "#fafafa",
      bgHeader: "#f5f5f8",
      bgHeaderHasFocus: "#eeeef2",
      bgHeaderHovered: "#f0f0f4",
      borderColor: "#e2e2e8",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      headerFontStyle: "bold 12px",
      baseFontStyle: "12px",
      textDark: "#1a1a2e",
      textMedium: "#666680",
      textLight: "#9999a8",
      textHeader: "#333340",
    };
  }, [theme]);

  const [selection, setSelection] = useState<GridSelection>({
    rows: CompactSelection.empty(),
    columns: CompactSelection.empty(),
  });

  // A click anywhere in a row selects the whole row (not just the clicked cell),
  // so a single click is enough to target a row for keyboard delete.
  const handleSelectionChange = useCallback((newSel: GridSelection) => {
    if (!newSel.current) {
      setSelection(newSel);
      return;
    }
    const rowIdx = newSel.current.cell[1];
    setSelection({ ...newSel, rows: CompactSelection.fromSingleSelection(rowIdx) });
  }, []);

  // Delete/Backspace on selected rows stages them for deletion (pressing again restores them);
  // Ctrl/Cmd+Z undoes the last edit or delete/restore. Staged deletes only take effect once
  // the user commits. Both are skipped while a cell's value editor has focus, so they never
  // hijack normal text editing (backspacing a character, etc.) inside the open cell overlay.
  const handleGridKeyDown = useCallback(
    (event: GridKeyEventArgs) => {
      const target = event.rawEvent?.target as HTMLElement | undefined;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        if (!onUndo) return;
        event.preventDefault();
        event.stopPropagation();
        event.cancel(); // stop glide's own keybinding handling from also running
        onUndo();
        return;
      }

      // Cmd/Ctrl+C: override glide's default TSV clipboard copy with CSV, so pasting
      // outside the app (a text editor, another spreadsheet) lands as a real .csv snippet.
      // Ctrl/Cmd-dragging adds extra disjoint rectangles (rangeStack); each becomes its own
      // CSV block, separated by a blank line, since they can differ in shape.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        if (!selection.current) return;
        event.preventDefault();
        event.stopPropagation();
        event.cancel();
        const ranges = [...selection.current.rangeStack, selection.current.range];
        const blocks = ranges.map((range) => {
          const lines: string[] = [];
          for (let r = range.y; r < range.y + range.height; r++) {
            const line: string[] = [];
            for (let c = range.x; c < range.x + range.width; c++) {
              line.push(csvEscape(cellToCopyText(getCellContent([c, r]))));
            }
            lines.push(line.join(","));
          }
          return lines.join("\n");
        });
        void navigator.clipboard.writeText(blocks.join("\n\n"));
        return;
      }

      if (virtualQuery || selection.rows.length === 0) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      event.preventDefault();
      event.stopPropagation();
      // Without this, glide's built-in "delete" keybinding runs right after ours and
      // clears the selected cell/range content — which read back as a blanked value
      // on top of (or instead of) our red "deleted row" tint.
      event.cancel();
      for (const rowIdx of selection.rows) {
        const trueRowIdx = rowIndexMap ? rowIndexMap[rowIdx] : rowIdx;
        if (deletedRows?.has(trueRowIdx)) onRowRestore?.(trueRowIdx);
        else onRowDelete?.(trueRowIdx);
      }
    },
    [virtualQuery, selection, deletedRows, onRowDelete, onRowRestore, onUndo, rowIndexMap, getCellContent],
  );

  return (
    <div ref={containerRef} className="results-grid-scroll flex-1 min-h-0 overflow-hidden">
      <DataEditor
        ref={dataEditorRef}
        columns={gridColumns}
        rows={totalRowCount}
        getCellContent={getCellContent}
        onCellEdited={isEditing || editable ? onCellEdited : undefined}
        onCellClicked={handleRowClick}
        onHeaderClicked={onSortColumn}
        onCellActivated={handleCellActivated}
        onCellContextMenu={handleCellContextMenu}
        onKeyDown={handleGridKeyDown}
        onVisibleRegionChanged={handleVisibleRegionChanged}
        customRenderers={[typedEditCellRenderer, fkCellRenderer]}
        theme={gridTheme}
        width={containerSize.width}
        height={containerSize.height}
        smoothScrollX
        smoothScrollY={!virtualQuery}
        experimental={{ renderStrategy: "direct" }}
        rowMarkers="none"
        gridSelection={selection}
        onGridSelectionChange={handleSelectionChange}
        getCellsForSelection={true}
        keybindings={{ search: !virtualQuery }}
        overscrollX={0}
        overscrollY={0}
        rowHeight={GRID_ROW_HEIGHT}
        headerHeight={34}
      />
      {fkMenu && createPortal(
        <>
          <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={closeFkMenu} onContextMenu={(e) => { e.preventDefault(); closeFkMenu(); }} />
          <div
            className="fixed min-w-[160px] rounded-md border border-border bg-popover shadow-md py-1"
            style={{ zIndex: 9999, top: fkMenu.y, left: fkMenu.x }}
          >
            {fkMenuCanEdit && (
              <button
                onClick={() => { onFKPickerOpen?.(rowIndexMap ? rowIndexMap[fkMenu.rowIndex] : fkMenu.rowIndex, fkMenu.colIndex); closeFkMenu(); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-accent transition-colors"
              >
                <Pencil className="h-3 w-3 text-muted-foreground" />
                Edit
              </button>
            )}
            {fkMenuCanOpen && (
              <button
                onClick={() => { onFKNavigate?.(fkMenu.colName, fkMenu.value); closeFkMenu(); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-accent transition-colors"
              >
                <ExternalLink className="h-3 w-3 text-muted-foreground" />
                Open relation
              </button>
            )}
            {!fkMenuCanEdit && !fkMenuCanOpen && (
              <div className="px-3 py-1.5 text-xs font-mono text-muted-foreground">No actions available</div>
            )}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
