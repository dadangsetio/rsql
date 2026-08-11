import {
  type GridCell,
  GridCellKind,
  type GridColumn,
  type Item,
  type Theme,
} from "@glideapps/glide-data-grid";
import { type ColumnEditInfo, formatNumericDisplay } from "@/lib/column-edit-kind";
import * as virtualCache from "@/lib/virtual-cache";
import type { CellValue } from "@/lib/wire";
import type { SortState, VirtualQuery } from "@/types";
import { makeFKCell, makeTypedEditCell } from "../results-grid-typed-cell";

export const MIN_COL_WIDTH = 80;
export const MAX_COL_WIDTH = 400;
export const CHAR_WIDTH = 7.5;
export const PADDING = 24;
export const GRID_ROW_HEIGHT = 32;

// Pre-allocated static cell for unloaded virtual rows — avoids GC pressure
export const LOADING_CELL: GridCell = {
  kind: GridCellKind.Text,
  data: "",
  displayData: "…",
  allowOverlay: false,
  readonly: true,
  themeOverride: { textDark: "#888", textLight: "#666" },
};

export const DELETED_OVERRIDE = {
  bgCell: "rgba(239, 68, 68, 0.1)",
  textDark: "#999",
  textLight: "#999",
};

export function buildModifiedOverride(theme: string) {
  return { bgCell: theme === "dark" ? "rgba(245, 158, 11, 0.15)" : "rgba(245, 158, 11, 0.1)" };
}

/// Staged draft rows and the blank row waiting for the next one — a different
/// tint from "modified" so a not-yet-saved row reads as new, not edited.
export function buildInsertOverride(theme: string) {
  return { bgCell: theme === "dark" ? "rgba(34, 197, 94, 0.12)" : "rgba(34, 197, 94, 0.08)" };
}

export const FK_OVERRIDE = { textDark: "hsl(220, 70%, 50%)", textLight: "hsl(220, 70%, 65%)" };

/// SQL NULL is drawn muted and labelled, so it never looks like an empty string
/// or like a column holding the text "null".
export const NULL_OVERRIDE = { textDark: "hsl(250, 10%, 50%)", textLight: "hsl(250, 10%, 55%)" };
export const NULL_DISPLAY = "NULL";

export function computeGridColumns(
  columns: string[],
  rows: CellValue[][],
  sort?: SortState,
): GridColumn[] {
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
}

export function computeFkColIndices(
  columns: string[],
  fkColumns?: Map<string, { schema: string; table: string; column: string }>,
): Set<number> {
  if (!fkColumns || fkColumns.size === 0) return new Set<number>();
  const s = new Set<number>();
  columns.forEach((col, idx) => {
    if (fkColumns.has(col)) s.add(idx);
  });
  return s;
}

export interface CellContentContext {
  rows: CellValue[][];
  /// Maps a displayed row's position back to its index in the unfiltered result;
  /// cellEdits and deletedRows are always keyed by the unfiltered index.
  rowIndexMap?: number[];
  cellEdits?: Map<string, string>;
  deletedRows?: Set<number>;
  isEditing?: boolean;
  /// Single-cell editing without entering the full edit session.
  editable?: boolean;
  /// Per-column edit widget, aligned to `columns`; undefined means plain text.
  colEditInfo?: (ColumnEditInfo | undefined)[];
  fkColIndices: Set<number>;
  virtualQuery?: VirtualQuery;
  onPageNeeded?: (pageIndex: number) => void;
  deletedOverride: typeof DELETED_OVERRIDE;
  modifiedOverride: ReturnType<typeof buildModifiedOverride>;
  fkOverride: typeof FK_OVERRIDE;
  /// Grid row position where staged/blank insert rows begin — everything from
  /// here on is `insertOverride`-tinted instead of the usual edit styling.
  insertRowStart?: number;
  insertOverride?: ReturnType<typeof buildInsertOverride>;
}

/// A non-editable cell that keeps SQL NULL visually distinct from "".
function readonlyCell(raw: CellValue | undefined): GridCell {
  const isNull = raw === null;
  return {
    kind: GridCellKind.Text,
    data: raw ?? "",
    displayData: isNull ? NULL_DISPLAY : (raw ?? ""),
    allowOverlay: false,
    readonly: true,
    themeOverride: isNull ? NULL_OVERRIDE : undefined,
  };
}

export function buildCellContent(cell: Item, ctx: CellContentContext): GridCell {
  const [colIdx, rowIdx] = cell;
  const {
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
  } = ctx;

  // Virtual mode: read from cache
  if (virtualQuery) {
    const pageIndex = Math.floor(rowIdx / virtualQuery.pageSize);
    const row = virtualCache.getRow(virtualQuery.queryId, rowIdx, virtualQuery.pageSize);
    if (!row) {
      onPageNeeded?.(pageIndex);
      const fallbackRow = rows[rowIdx];
      if (!fallbackRow) return LOADING_CELL;
      return readonlyCell(fallbackRow[colIdx]);
    }
    return readonlyCell(row[colIdx]);
  }

  const isInsertRow = insertRowStart !== undefined && rowIdx >= insertRowStart;
  const trueRowIdx = rowIndexMap ? rowIndexMap[rowIdx] : rowIdx;
  const key = `${trueRowIdx}:${colIdx}`;
  const isModified = cellEdits?.has(key);
  const isDeleted = deletedRows?.has(trueRowIdx);
  const raw = isModified ? (cellEdits?.get(key) ?? "") : rows[rowIdx]?.[colIdx];
  const isNull = raw === null;
  const value = raw ?? "";
  const isFK = fkColIndices.has(colIdx);
  // `editable` alone (no active session) only opens a real cell's overlay
  // when double-clicking would insert, not update — an existing row stays
  // read-only until a session is actually open, matching the "Edit" button.
  const canOverlay = (!!isEditing || (isInsertRow && !!editable)) && !isFK && !isDeleted;

  // The blank invitation row stays plain until double-clicking it actually
  // starts a session — only then does it (and any further draft rows) read
  // as "new, not saved yet" rather than looking like an active row already.
  const themeOverride = isDeleted
    ? deletedOverride
    : isInsertRow && isEditing
      ? insertOverride
      : isModified
        ? modifiedOverride
        : isNull
          ? NULL_OVERRIDE
          : isFK
            ? fkOverride
            : undefined;

  // Type info drives read-only display formatting regardless of edit access; the richer
  // input widgets only take over the cell when it is actually editable.
  const info = colEditInfo?.[colIdx];

  if (info?.kind === "boolean") {
    return {
      kind: GridCellKind.Boolean,
      allowOverlay: false,
      readonly: !canOverlay,
      data: isNull ? null : value === "t" || value === "true",
      themeOverride,
    };
  }

  if (
    canOverlay &&
    (info?.kind === "enum" ||
      info?.kind === "date" ||
      info?.kind === "time" ||
      info?.kind === "timestamp")
  ) {
    return makeTypedEditCell(
      value,
      info.kind,
      info.enumValues,
      !canOverlay,
      themeOverride,
      info.nullable,
    );
  }

  // A NULL foreign key still renders as an FK cell so it can be assigned through the
  // relation picker; makeFKCell suppresses the arrow for the NULL label itself.
  if (isFK) {
    return makeFKCell(isNull ? NULL_DISPLAY : value, themeOverride);
  }

  return {
    kind: GridCellKind.Text,
    data: value,
    displayData: isNull
      ? NULL_DISPLAY
      : info?.kind === "numeric"
        ? formatNumericDisplay(value)
        : value,
    allowOverlay: canOverlay,
    readonly: !canOverlay,
    themeOverride,
  };
}

export function buildGridTheme(theme: string): Partial<Theme> {
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
}
