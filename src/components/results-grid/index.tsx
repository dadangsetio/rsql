import DataEditor, {
  type CellClickedEventArgs,
  CompactSelection,
  type DataEditorRef,
  type EditableGridCell,
  type GridCell,
  GridCellKind,
  type GridColumn,
  type GridKeyEventArgs,
  type GridSelection,
  type Item,
  type Theme,
} from "@glideapps/glide-data-grid";
import { ExternalLink, Pencil } from "lucide-react";
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import "@glideapps/glide-data-grid/dist/index.css";
import type { ColumnEditInfo } from "@/lib/column-edit-kind";
import type { CellValue } from "@/lib/wire";
import { useUIStore } from "@/stores/ui-store";
import type { SortState, VirtualQuery } from "@/types";
import {
  FK_ARROW_ZONE_WIDTH,
  fkCellRenderer,
  type TypedEditCell,
  typedEditCellRenderer,
} from "../results-grid-typed-cell";
import {
  buildCellContent,
  buildGridTheme,
  buildModifiedOverride,
  computeFkColIndices,
  computeGridColumns,
  DELETED_OVERRIDE,
  FK_OVERRIDE,
  GRID_ROW_HEIGHT,
} from "./rendering";

interface ResultsGridProps {
  columns: string[];
  rows: CellValue[][];
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
  onCellEdit?: (rowIndex: number, colIndex: number, value: CellValue) => void;
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

function cellToCopyText(cell: GridCell): string {
  if (cell.copyData !== undefined) return cell.copyData;
  if (cell.kind === GridCellKind.Boolean) {
    return cell.data === true ? "true" : cell.data === false ? "false" : "";
  }
  return "data" in cell ? String(cell.data ?? "") : "";
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

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
  viewportKey: _viewportKey,
  gridRef,
}: ResultsGridProps) {
  const theme = useUIStore((s) => s.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const dataEditorRef = useRef<DataEditorRef>(null);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 400 });
  const visibleRangeRef = useRef({ y: 0, height: 0 });

  useImperativeHandle(
    gridRef ?? { current: null },
    () => ({
      invalidatePage: (_pageIndex: number) => {
        if (!virtualQuery) return;
        const totalRows = virtualQuery.totalRows;
        if (totalRows <= 0) return;

        const range = visibleRangeRef.current;
        const visibleStart = Math.max(0, Math.floor(range.y) - 2);
        const fallbackVisibleRows = Math.max(
          24,
          Math.ceil(containerSize.height / GRID_ROW_HEIGHT) + 4,
        );
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
    }),
    [columns.length, containerSize.height, virtualQuery],
  );

  // Debounced via rAF to avoid mid-scroll re-renders
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
        setContainerSize((prev) =>
          prev.width === w && prev.height === h ? prev : { width: w, height: h },
        );
      });
    });
    obs.observe(el);
    return () => {
      cancelAnimationFrame(rafId);
      obs.disconnect();
    };
  }, []);

  const gridColumns = useMemo(
    (): GridColumn[] => computeGridColumns(columns, rows, sort),
    [columns, rows, sort],
  );

  // Per-column edit widget kind, aligned to `columns` — undefined means plain text.
  const colEditInfo = useMemo(
    () => columns.map((col) => columnTypes?.get(col)),
    [columns, columnTypes],
  );

  const fkColIndices = useMemo(() => computeFkColIndices(columns, fkColumns), [columns, fkColumns]);

  // Pre-compute theme override objects — avoids creating new objects per cell render
  const deletedOverride = useMemo(() => DELETED_OVERRIDE, []);
  const modifiedOverride = useMemo(() => buildModifiedOverride(theme), [theme]);
  const fkOverride = useMemo(() => FK_OVERRIDE, []);

  const totalRowCount = virtualQuery ? virtualQuery.totalRows : rows.length;

  // Restore previous viewport row when switching back to a tab/query
  useLayoutEffect(() => {
    if (typeof restoreRowIndex !== "number" || totalRowCount <= 0) return;
    const targetRow = Math.min(restoreRowIndex, totalRowCount - 1);
    if (targetRow > 0) {
      dataEditorRef.current?.scrollTo(0, { amount: targetRow, unit: "cell" }, "vertical", 0, 0, {
        vAlign: "start",
      });
    }
    visibleRangeRef.current = { ...visibleRangeRef.current, y: targetRow };
    onViewportRowChange?.(targetRow);
  }, [restoreRowIndex, totalRowCount, onViewportRowChange]);

  const getCellContent = useCallback(
    (cell: Item): GridCell =>
      buildCellContent(cell, {
        rows,
        rowIndexMap,
        cellEdits,
        deletedRows,
        isEditing,
        editable,
        colEditInfo,
        fkColIndices,
        virtualQuery,
        onPageNeeded,
        deletedOverride,
        modifiedOverride,
        fkOverride,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      rows,
      rowIndexMap,
      cellEdits,
      deletedRows,
      isEditing,
      editable,
      colEditInfo,
      fkColIndices,
      virtualQuery,
      onPageNeeded,
      fkOverride,
      modifiedOverride,
      deletedOverride,
    ],
  );

  // Trigger page loads on scroll, throttled via rAF
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

  useEffect(
    () => () => {
      cancelAnimationFrame(scrollRafId.current);
    },
    [],
  );

  const onCellEdited = useCallback(
    (cell: Item, newVal: EditableGridCell) => {
      const [colIdx, rowIdx] = cell;
      let value: CellValue | undefined;
      if (newVal.kind === GridCellKind.Text) {
        // Clearing a nullable cell means SQL NULL, not the empty-string literal. This has to
        // be a real null: the commit path parameterises values, so the string "null" would be
        // written as the four-character text instead of NULL.
        value = newVal.data === "" && colEditInfo[colIdx]?.nullable ? null : newVal.data;
      } else if (newVal.kind === GridCellKind.Boolean) {
        value = newVal.data === true ? "t" : newVal.data === false ? "f" : null;
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
  // any other cell. Any other click, when the grid is read-only and `onRowClick` is wired up,
  // picks that row instead — this is how a plain view-only grid doubles as a picker.
  const handleRowClick = useCallback(
    (cell: Item, event: CellClickedEventArgs) => {
      const [colIdx, rowIdx] = cell;
      if (fkColIndices.has(colIdx)) {
        const inArrow = event.localEventX >= event.bounds.width - FK_ARROW_ZONE_WIDTH;
        lastFKClickRef.current = { col: colIdx, row: rowIdx, inArrow };
        if (inArrow && !virtualQuery && onFKNavigate) {
          const colName = columns[colIdx];
          const value = rows[rowIdx]?.[colIdx];
          if (value) onFKNavigate(colName, value);
          return;
        }
      }

      if (onRowClick && !isEditing && !editable && !virtualQuery) {
        onRowClick(rowIndexMap ? rowIndexMap[rowIdx] : rowIdx);
      }
    },
    [
      fkColIndices,
      virtualQuery,
      onFKNavigate,
      columns,
      rows,
      onRowClick,
      isEditing,
      editable,
      rowIndexMap,
    ],
  );

  // Cell activate (double-click / Enter / Space) on an editable FK cell → open the relation
  // picker instead of the plain text editor. Skipped if the triggering click landed on the
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
    x: number;
    y: number;
    rowIndex: number;
    colIndex: number;
    colName: string;
    value: string;
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

  const fkMenuCanEdit =
    !!onFKPickerOpen &&
    (!!isEditing || !!editable) &&
    !deletedRows?.has(fkMenu ? (rowIndexMap ? rowIndexMap[fkMenu.rowIndex] : fkMenu.rowIndex) : -1);
  const fkMenuCanOpen = !!onFKNavigate && !!fkMenu && fkMenu.value !== "";

  const gridTheme = useMemo((): Partial<Theme> => buildGridTheme(theme), [theme]);

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
  // Ctrl/Cmd+Z undoes the last edit or delete/restore. Both are skipped while a cell's value
  // editor has focus, so they never hijack normal text editing inside the open cell overlay.
  const handleGridKeyDown = useCallback(
    (event: GridKeyEventArgs) => {
      const target = event.rawEvent?.target as HTMLElement | undefined;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
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
      // outside the app lands as a real .csv snippet. Ctrl/Cmd-dragging adds extra disjoint
      // rectangles (rangeStack); each becomes its own CSV block, since they can differ in shape.
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
      // clears the selected cell/range content — which reads back as a blanked value
      // on top of (or instead of) our red "deleted row" tint.
      event.cancel();
      for (const rowIdx of selection.rows) {
        const trueRowIdx = rowIndexMap ? rowIndexMap[rowIdx] : rowIdx;
        if (deletedRows?.has(trueRowIdx)) onRowRestore?.(trueRowIdx);
        else onRowDelete?.(trueRowIdx);
      }
    },
    [
      virtualQuery,
      selection,
      deletedRows,
      onRowDelete,
      onRowRestore,
      onUndo,
      rowIndexMap,
      getCellContent,
    ],
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
      {fkMenu &&
        createPortal(
          <>
            <div
              className="fixed inset-0"
              style={{ zIndex: 9998 }}
              onClick={closeFkMenu}
              onContextMenu={(e) => {
                e.preventDefault();
                closeFkMenu();
              }}
            />
            <div
              className="fixed min-w-[160px] rounded-md border border-border bg-popover shadow-md py-1"
              style={{ zIndex: 9999, top: fkMenu.y, left: fkMenu.x }}
            >
              {fkMenuCanEdit && (
                <button
                  type="button"
                  onClick={() => {
                    onFKPickerOpen?.(
                      rowIndexMap ? rowIndexMap[fkMenu.rowIndex] : fkMenu.rowIndex,
                      fkMenu.colIndex,
                    );
                    closeFkMenu();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-accent transition-colors"
                >
                  <Pencil className="h-3 w-3 text-muted-foreground" />
                  Edit
                </button>
              )}
              {fkMenuCanOpen && (
                <button
                  type="button"
                  onClick={() => {
                    onFKNavigate?.(fkMenu.colName, fkMenu.value);
                    closeFkMenu();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-accent transition-colors"
                >
                  <ExternalLink className="h-3 w-3 text-muted-foreground" />
                  Open relation
                </button>
              )}
              {!fkMenuCanEdit && !fkMenuCanOpen && (
                <div className="px-3 py-1.5 text-xs font-mono text-muted-foreground">
                  No actions available
                </div>
              )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
