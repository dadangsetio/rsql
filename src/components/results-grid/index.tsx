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
import {
  ClipboardPaste,
  Copy,
  Download,
  ExternalLink,
  FileUp,
  Pencil,
  Plus,
  RefreshCw,
  Rows3,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "@glideapps/glide-data-grid/dist/index.css";
import { ContextMenu, type ContextMenuEntry } from "@/components/ui/context-menu";
import type { ColumnEditInfo } from "@/lib/column-edit-kind";
import { copyToClipboard, exportResults } from "@/lib/export";
import { type CellValue, cellText } from "@/lib/wire";
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
  buildInsertOverride,
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
  /** Grid row position where staged insert rows (and the trailing blank one) begin —
   * tinted differently from an edited row and always considered editable, never deleted. */
  insertRowStart?: number;
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
  /** Right-click menu: re-run the current query. */
  onRefresh?: () => void;
  /** Right-click menu: start (or confirm) an edit session — same as double-clicking the blank row. */
  onAddRow?: () => void;
  /** Right-click menu: stage a new draft row seeded from the clicked row's values. */
  onDuplicateRow?: (rowIndex: number) => void;
  /** Right-click menu: stage one draft row per clipboard line, tab-separated, columns matched positionally. */
  onPasteRows?: (rows: CellValue[][]) => void;
  /** Right-click menu: open the CSV import dialog for the current table. */
  onImport?: () => void;
  virtualQuery?: VirtualQuery;
  onPageNeeded?: (pageIndex: number) => void;
  onViewportRowChange?: (topRow: number) => void;
  restoreRowIndex?: number; // can be fractional when smooth scroll is active
  viewportKey?: string;
  gridRef?: MutableRefObject<ResultsGridHandle | null>;
}

export interface ResultsGridHandle {
  invalidatePage: (pageIndex: number) => void;
  /** Drops any manually-resized column widths, going back to the auto-fit-to-content sizing. */
  fitColumns: () => void;
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
  insertRowStart,
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
  onRefresh,
  onAddRow,
  onDuplicateRow,
  onPasteRows,
  onImport,
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
  // Column id -> a width the user dragged to, overriding the auto-fit-to-content
  // one computeGridColumns would otherwise pick. Cleared by "fit columns".
  const [columnWidthOverrides, setColumnWidthOverrides] = useState<Record<string, number>>({});

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
      fitColumns: () => setColumnWidthOverrides({}),
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

  const gridColumns = useMemo((): GridColumn[] => {
    const computed = computeGridColumns(columns, rows, sort);
    if (Object.keys(columnWidthOverrides).length === 0) return computed;
    return computed.map((col) =>
      columnWidthOverrides[col.id ?? ""] !== undefined
        ? { ...col, width: columnWidthOverrides[col.id ?? ""] }
        : col,
    );
  }, [columns, rows, sort, columnWidthOverrides]);

  const handleColumnResize = useCallback((column: GridColumn, newSize: number) => {
    if (!column.id) return;
    setColumnWidthOverrides((prev) => ({ ...prev, [column.id as string]: newSize }));
  }, []);

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
  const insertOverride = useMemo(() => buildInsertOverride(theme), [theme]);

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
        insertRowStart,
        insertOverride,
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
      insertRowStart,
      insertOverride,
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
      if (virtualQuery || !onFKPickerOpen) return;
      const [colIdx, rowIdx] = cell;
      const isInsertRow = insertRowStart !== undefined && rowIdx >= insertRowStart;
      // Same rule as canOverlay in buildCellContent: `editable` alone only
      // opens the picker on the insert row — an existing row needs a session.
      if (!isEditing && !(isInsertRow && editable)) return;
      if (!fkColIndices.has(colIdx)) return;
      const last = lastFKClickRef.current;
      if (last.col === colIdx && last.row === rowIdx && last.inArrow) return;
      const trueRowIdx = rowIndexMap ? rowIndexMap[rowIdx] : rowIdx;
      if (deletedRows?.has(trueRowIdx)) return;
      onFKPickerOpen(trueRowIdx, colIdx);
    },
    [
      virtualQuery,
      onFKPickerOpen,
      isEditing,
      editable,
      fkColIndices,
      rowIndexMap,
      deletedRows,
      insertRowStart,
    ],
  );

  // Right-click on any cell → a menu of row/cell actions, plus FK-specific ones
  // (edit via the relation picker, open the related row) when the column is one.
  const [cellMenu, setCellMenu] = useState<{
    x: number;
    y: number;
    rowIndex: number;
    colIndex: number;
  } | null>(null);
  const closeCellMenu = useCallback(() => setCellMenu(null), []);

  const handlePaste = useCallback(async () => {
    if (!onPasteRows) return;
    const text = await navigator.clipboard.readText();
    if (!text.trim()) return;
    const parsed = text
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => line.split("\t"));
    onPasteRows(parsed);
  }, [onPasteRows]);

  const [selection, setSelection] = useState<GridSelection>({
    rows: CompactSelection.empty(),
    columns: CompactSelection.empty(),
  });

  const handleCellContextMenu = useCallback((cell: Item, event: CellClickedEventArgs) => {
    const [colIdx, rowIdx] = cell;
    event.preventDefault();
    setCellMenu({
      x: event.bounds.x + event.localEventX,
      y: event.bounds.y + event.localEventY,
      rowIndex: rowIdx,
      colIndex: colIdx,
    });
  }, []);

  const cellMenuItems = useMemo((): ContextMenuEntry[] => {
    if (!cellMenu) return [];
    const { rowIndex, colIndex } = cellMenu;
    const colName = columns[colIndex];
    const cellValue = rows[rowIndex]?.[colIndex] ?? "";
    const row = rows[rowIndex];
    const isInsertRow = insertRowStart !== undefined && rowIndex >= insertRowStart;
    const trueRowIdx = rowIndexMap ? rowIndexMap[rowIndex] : rowIndex;
    const isDeleted = !!deletedRows?.has(trueRowIdx);
    const isFK = fkColIndices.has(colIndex);
    const canEditCell = !!isEditing || (isInsertRow && !!editable);

    // Right-clicking inside an existing multi-row selection acts on the whole selection
    // (copy/export/delete all of it); right-clicking outside it acts on just that row.
    const isMultiSelected = selection.rows.length > 1 && selection.rows.hasIndex(rowIndex);
    const selectedRowIndices = isMultiSelected ? [...selection.rows] : [rowIndex];
    const selectedRowsData = selectedRowIndices
      .map((i) => rows[i])
      .filter((r): r is CellValue[] => !!r);
    const rowCountLabel = isMultiSelected ? `${selectedRowIndices.length} Rows` : "Row";

    const items: ContextMenuEntry[] = [
      {
        label: "Copy Cell Value",
        icon: <Copy className="h-3 w-3" />,
        onClick: () => void navigator.clipboard.writeText(cellText(cellValue)),
      },
    ];

    if (row) {
      items.push(
        {
          label: `Copy ${rowCountLabel}`,
          icon: <Rows3 className="h-3 w-3" />,
          onClick: () =>
            void navigator.clipboard.writeText(
              selectedRowsData
                .map((r) => r.map((c) => csvEscape(cellText(c))).join(","))
                .join("\n"),
            ),
        },
        {
          label: `Copy ${rowCountLabel} as CSV`,
          icon: <Copy className="h-3 w-3" />,
          onClick: () => void copyToClipboard("csv", columns, selectedRowsData),
        },
        {
          label: `Copy ${rowCountLabel} as JSON`,
          icon: <Copy className="h-3 w-3" />,
          onClick: () => void copyToClipboard("json", columns, selectedRowsData),
        },
      );
    }

    if (isFK && (onFKPickerOpen || onFKNavigate)) {
      items.push({ separator: true });
      if (onFKPickerOpen && canEditCell && !isDeleted) {
        items.push({
          label: "Edit",
          icon: <Pencil className="h-3 w-3" />,
          onClick: () => onFKPickerOpen(trueRowIdx, colIndex),
        });
      }
      if (onFKNavigate && cellValue !== "") {
        items.push({
          label: "Open relation",
          icon: <ExternalLink className="h-3 w-3" />,
          onClick: () => onFKNavigate(colName, cellValue),
        });
      }
    }

    if (onRefresh || onAddRow || onPasteRows || onDuplicateRow || onImport) {
      items.push({ separator: true });
      if (onRefresh) {
        items.push({
          label: "Refresh",
          icon: <RefreshCw className="h-3 w-3" />,
          onClick: onRefresh,
        });
      }
      if (onAddRow) {
        items.push({ label: "Add Row", icon: <Plus className="h-3 w-3" />, onClick: onAddRow });
      }
      if (onDuplicateRow && row && !isInsertRow) {
        items.push({
          label: "Duplicate Row",
          icon: <Copy className="h-3 w-3" />,
          onClick: () => onDuplicateRow(rowIndex),
        });
      }
      if ((onRowDelete || onRowRestore) && row) {
        const selectedTrueRowIndices = selectedRowIndices.map((i) =>
          rowIndexMap ? rowIndexMap[i] : i,
        );
        const allDeleted = selectedTrueRowIndices.every((t) => deletedRows?.has(t));
        items.push(
          allDeleted
            ? {
                label: `Restore ${rowCountLabel}`,
                icon: <Undo2 className="h-3 w-3" />,
                onClick: () => {
                  for (const t of selectedTrueRowIndices) onRowRestore?.(t);
                },
              }
            : {
                label: `Delete ${rowCountLabel}`,
                icon: <Trash2 className="h-3 w-3" />,
                destructive: true,
                // Mirrors the keyboard Delete key: each row toggles independently, so an
                // already-deleted row inside a mixed selection gets restored, not re-deleted.
                onClick: () => {
                  for (const t of selectedTrueRowIndices) {
                    if (deletedRows?.has(t)) onRowRestore?.(t);
                    else onRowDelete?.(t);
                  }
                },
              },
        );
      }
      if (onPasteRows) {
        items.push({
          label: "Paste",
          icon: <ClipboardPaste className="h-3 w-3" />,
          onClick: () => void handlePaste(),
        });
      }
      if (onImport) {
        items.push({
          label: "Import CSV",
          icon: <FileUp className="h-3 w-3" />,
          onClick: onImport,
        });
      }
    }

    if (rows.length > 0) {
      items.push({ separator: true });
      if (isMultiSelected) {
        items.push({
          label: `Export ${rowCountLabel} as CSV`,
          icon: <Download className="h-3 w-3" />,
          onClick: () => void exportResults("csv", columns, selectedRowsData),
        });
      }
      items.push({
        label: "Export CSV",
        icon: <Download className="h-3 w-3" />,
        onClick: () => void exportResults("csv", columns, rows),
      });
    }

    return items;
  }, [
    cellMenu,
    columns,
    rows,
    rowIndexMap,
    deletedRows,
    fkColIndices,
    isEditing,
    editable,
    insertRowStart,
    onFKPickerOpen,
    onFKNavigate,
    onRefresh,
    onAddRow,
    onDuplicateRow,
    onRowDelete,
    onRowRestore,
    onPasteRows,
    onImport,
    handlePaste,
    selection,
  ]);

  const gridTheme = useMemo((): Partial<Theme> => buildGridTheme(theme), [theme]);

  // The row a Shift+click or Shift+Arrow range extends from — set on every plain
  // or Ctrl/Cmd click so the next Shift interaction has a fixed starting point.
  const selectionAnchorRef = useRef<number | null>(null);
  // glide-data-grid's onGridSelectionChange callback carries no event, so we snapshot
  // Shift/Ctrl/Cmd from the native mousedown (capture phase, ahead of glide's own
  // internal mousedown handling) and consume it the moment the selection change lands.
  const clickModifiersRef = useRef({ shift: false, toggle: false });
  const handleContainerMouseDownCapture = useCallback((event: ReactMouseEvent) => {
    clickModifiersRef.current = { shift: event.shiftKey, toggle: event.ctrlKey || event.metaKey };
  }, []);

  // A click anywhere in a row selects the whole row (not just the clicked cell), so a single
  // click is enough to target a row for keyboard delete. Shift-click extends a contiguous range
  // from the last anchor row; Ctrl/Cmd-click toggles individual rows in and out of the selection.
  const handleSelectionChange = useCallback(
    (newSel: GridSelection) => {
      if (!newSel.current) {
        // No focused cell means glide computed the row selection itself (e.g. Ctrl/Cmd+A) —
        // trust it as-is instead of collapsing to a single row.
        setSelection(newSel);
        const rowsArr = newSel.rows.toArray();
        selectionAnchorRef.current = rowsArr.length > 0 ? rowsArr[0] : null;
        return;
      }
      const rowIdx = newSel.current.cell[1];
      const { shift, toggle } = clickModifiersRef.current;
      clickModifiersRef.current = { shift: false, toggle: false };
      setSelection((prev) => {
        let rows: CompactSelection;
        if (shift && selectionAnchorRef.current !== null) {
          const anchor = selectionAnchorRef.current;
          rows = CompactSelection.fromSingleSelection([
            Math.min(anchor, rowIdx),
            Math.max(anchor, rowIdx) + 1,
          ]);
        } else if (toggle) {
          rows = prev.rows.hasIndex(rowIdx) ? prev.rows.remove(rowIdx) : prev.rows.add(rowIdx);
          selectionAnchorRef.current = rowIdx;
        } else {
          rows = CompactSelection.fromSingleSelection(rowIdx);
          selectionAnchorRef.current = rowIdx;
        }
        return { ...newSel, rows };
      });
      // Feeds the row detail side panel — it always shows whatever row was last
      // clicked/navigated to in the grid, independent of any range selection.
      useUIStore.getState().setSelectedRow(rowIndexMap ? rowIndexMap[rowIdx] : rowIdx);
    },
    [rowIndexMap],
  );

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

      // Shift+Up/Down grows or shrinks the row selection one row at a time from the anchor
      // row (the last plain/Ctrl-clicked row), mirroring spreadsheet range-select behavior.
      if (
        !virtualQuery &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        (event.key === "ArrowDown" || event.key === "ArrowUp") &&
        selection.current
      ) {
        event.preventDefault();
        event.stopPropagation();
        event.cancel();
        const [curCol, curRow] = selection.current.cell;
        const anchor = selectionAnchorRef.current ?? curRow;
        selectionAnchorRef.current = anchor;
        const nextRow = Math.max(
          0,
          Math.min(totalRowCount - 1, curRow + (event.key === "ArrowDown" ? 1 : -1)),
        );
        setSelection((prev) => ({
          ...prev,
          current: {
            cell: [curCol, nextRow],
            range: { x: curCol, y: nextRow, width: 1, height: 1 },
            rangeStack: prev.current?.rangeStack ?? [],
          },
          rows: CompactSelection.fromSingleSelection([
            Math.min(anchor, nextRow),
            Math.max(anchor, nextRow) + 1,
          ]),
        }));
        dataEditorRef.current?.scrollTo(curCol, nextRow, "vertical");
        useUIStore.getState().setSelectedRow(rowIndexMap ? rowIndexMap[nextRow] : nextRow);
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
      totalRowCount,
    ],
  );

  return (
    <div
      ref={containerRef}
      className="results-grid-scroll flex-1 min-h-0 overflow-hidden"
      onMouseDownCapture={handleContainerMouseDownCapture}
    >
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
        onColumnResize={handleColumnResize}
        customRenderers={[typedEditCellRenderer, fkCellRenderer]}
        theme={gridTheme}
        width={containerSize.width}
        height={containerSize.height}
        smoothScrollX
        smoothScrollY={!virtualQuery}
        experimental={{ renderStrategy: "direct" }}
        rowMarkers="number"
        gridSelection={selection}
        onGridSelectionChange={handleSelectionChange}
        getCellsForSelection={true}
        keybindings={{ search: !virtualQuery }}
        overscrollX={0}
        overscrollY={0}
        rowHeight={GRID_ROW_HEIGHT}
        headerHeight={34}
      />
      {cellMenu && (
        <ContextMenu x={cellMenu.x} y={cellMenu.y} items={cellMenuItems} onClose={closeCellMenu} />
      )}
    </div>
  );
}
