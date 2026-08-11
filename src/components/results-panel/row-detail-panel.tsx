import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { type ColumnEditInfo, toDateTimeInputValue } from "@/lib/column-edit-kind";
import type { CellValue } from "@/lib/wire";
import { useUIStore } from "@/stores/ui-store";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface RowDetailPanelProps {
  columns: string[];
  rows: CellValue[][];
  editedCells: Map<string, string>;
  deletedRows?: Set<number>;
  columnTypes: Map<string, ColumnEditInfo>;
  /** Whether this result can be edited at all (single editable table, not a virtual/paged
   *  query, has rows). Fields are live the moment this is true — no separate "Edit" step;
   *  onCellEdit starts an edit session transparently on the first change. */
  canEdit: boolean;
  onCellEdit: (rowIndex: number, colIndex: number, value: CellValue) => void;
  onClose: () => void;
}

export function RowDetailPanel({
  columns,
  rows,
  editedCells,
  deletedRows,
  columnTypes,
  canEdit,
  onCellEdit,
  onClose,
}: RowDetailPanelProps) {
  const selectedRow = useUIStore((s) => s.selectedRow);
  const setSelectedRow = useUIStore((s) => s.setSelectedRow);
  const width = useUIStore((s) => s.rowDetailPanelWidth);

  const rowIndex = Math.min(selectedRow, Math.max(0, rows.length - 1));
  const row = rows[rowIndex];
  const isDeleted = !!row && (deletedRows?.has(rowIndex) ?? false);
  const fieldsEditable = canEdit && !isDeleted;

  return (
    <div
      style={{ width }}
      className="flex-shrink-0 flex flex-col border-l border-border bg-card overflow-hidden"
    >
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2 flex-shrink-0">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSelectedRow((i) => Math.max(0, i - 1))}
            disabled={rowIndex <= 0}
            className="p-1 rounded hover:bg-accent disabled:opacity-30 disabled:pointer-events-none text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="text-xs font-mono text-muted-foreground">
            {rows.length > 0 ? `Row ${rowIndex + 1} / ${rows.length.toLocaleString()}` : "No row"}
          </span>
          <button
            type="button"
            onClick={() => setSelectedRow((i) => Math.min(rows.length - 1, i + 1))}
            disabled={rowIndex >= rows.length - 1}
            className="p-1 rounded hover:bg-accent disabled:opacity-30 disabled:pointer-events-none text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Hide row detail panel"
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {!canEdit && (
        <div className="px-3 py-1.5 text-[11px] text-muted-foreground border-b border-border/50 bg-muted/20">
          This result isn't directly editable.
        </div>
      )}

      {!row ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">
          No row selected
        </div>
      ) : (
        <form className="flex-1 overflow-auto p-3 space-y-3" onSubmit={(e) => e.preventDefault()}>
          {columns.map((col, colIdx) => {
            const key = `${rowIndex}:${colIdx}`;
            const edited = editedCells.get(key);
            const value = edited !== undefined ? edited : (row[colIdx] ?? null);
            const fieldId = `row-detail-${colIdx}`;
            return (
              <div key={col} className="space-y-1">
                <Label
                  htmlFor={fieldId}
                  className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
                >
                  {col}
                </Label>
                <RowDetailField
                  id={fieldId}
                  value={value}
                  info={columnTypes.get(col)}
                  editable={fieldsEditable}
                  onChange={(v) => onCellEdit(rowIndex, colIdx, v)}
                />
              </div>
            );
          })}
        </form>
      )}
    </div>
  );
}

const fieldClass = "h-8 font-mono text-xs";
const lockedClass = "bg-muted/30 cursor-default";
const selectClass =
  "h-8 w-full rounded-lg border border-border/50 bg-input px-2 text-xs font-mono text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50";

/** Renders the same widget kind the grid uses for this column — boolean/enum dropdown,
 *  date/time/timestamp picker, or plain text — locked only when the row/result can't be
 *  edited at all; otherwise live immediately, no separate edit-mode step. */
function RowDetailField({
  id,
  value,
  info,
  editable,
  onChange,
}: {
  id: string;
  value: CellValue;
  info: ColumnEditInfo | undefined;
  editable: boolean;
  onChange: (v: CellValue) => void;
}) {
  if (info?.kind === "boolean") {
    const current = value === null ? "null" : value === "t" || value === "true" ? "true" : "false";
    return (
      <select
        id={id}
        disabled={!editable}
        className={selectClass}
        value={current}
        onChange={(e) =>
          onChange(e.target.value === "null" ? null : e.target.value === "true" ? "t" : "f")
        }
      >
        <option value="null">NULL</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (info?.kind === "enum") {
    return (
      <select
        id={id}
        disabled={!editable}
        className={selectClass}
        value={value === null ? "null" : value}
        onChange={(e) => onChange(e.target.value === "null" ? null : e.target.value)}
      >
        <option value="null">NULL</option>
        {(info.enumValues ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  if (info?.kind === "date" || info?.kind === "time" || info?.kind === "timestamp") {
    const inputType =
      info.kind === "date" ? "date" : info.kind === "time" ? "time" : "datetime-local";
    return (
      <Input
        id={id}
        type={inputType}
        step={info.kind === "timestamp" || info.kind === "time" ? 1 : undefined}
        // date/time inputs don't honor `readOnly` in most browsers — `disabled` is the
        // only way to actually lock them when the result can't be edited.
        disabled={!editable}
        className={`${fieldClass} ${!editable ? lockedClass : ""}`}
        value={toDateTimeInputValue(value ?? "", info.kind)}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      />
    );
  }

  const nullable = info?.nullable ?? true;
  return (
    <Input
      id={id}
      type="text"
      readOnly={!editable}
      placeholder={value === null ? "NULL" : undefined}
      className={`${fieldClass} ${!editable ? lockedClass : ""} ${
        value === null ? "italic placeholder:text-muted-foreground" : ""
      }`}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" && nullable ? null : e.target.value)}
    />
  );
}
