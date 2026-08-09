import { useState } from "react";
import {
  GridCellKind,
  drawTextCell,
  type CustomCell,
  type CustomRenderer,
  type ProvideEditorComponent,
  type Theme,
} from "@glideapps/glide-data-grid";
import { toDateTimeInputValue, nowValueFor, type ColumnEditKind, type DateTimeEditKind } from "@/lib/column-edit-kind";

export interface TypedEditCellData {
  readonly kind: "typed-edit";
  readonly editKind: Extract<ColumnEditKind, "enum" | DateTimeEditKind>;
  /** Raw storage value — the "null" sentinel represents SQL NULL, matching the rest of the grid. */
  readonly value: string;
  readonly options?: readonly string[];
}

export type TypedEditCell = CustomCell<TypedEditCellData>;

export function makeTypedEditCell(
  value: string,
  editKind: TypedEditCellData["editKind"],
  enumValues: string[] | undefined,
  readonly: boolean,
  themeOverride: Partial<Theme> | undefined,
): TypedEditCell {
  return {
    kind: GridCellKind.Custom,
    allowOverlay: true,
    readonly,
    copyData: value,
    themeOverride,
    data: { kind: "typed-edit", editKind, value, options: enumValues },
  };
}

const TypedEditEditor: ProvideEditorComponent<TypedEditCell> = (p) => {
  const data = p.value.data;
  const [local, setLocal] = useState(data.value);

  const commit = (v: string) => {
    const raw = v === "" ? "null" : v;
    p.onFinishedEditing({ ...p.value, copyData: raw, data: { ...data, value: raw } });
  };

  if (data.editKind === "enum") {
    return (
      <select
        autoFocus
        className="typed-edit-select"
        value={local === "" ? "null" : local}
        onChange={(e) => { setLocal(e.target.value); commit(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Escape") p.onFinishedEditing(undefined); }}
      >
        <option value="null">NULL</option>
        {(data.options ?? []).map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }

  const editKind = data.editKind;
  const inputType = editKind === "date" ? "date" : editKind === "time" ? "time" : "datetime-local";
  return (
    <div className="typed-edit-datetime">
      <input
        type={inputType}
        autoFocus
        step={editKind === "timestamp" || editKind === "time" ? 1 : undefined}
        value={toDateTimeInputValue(local, editKind)}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => commit(local)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(local); }
          if (e.key === "Escape") p.onFinishedEditing(undefined);
        }}
      />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { const now = nowValueFor(editKind); setLocal(now); commit(now); }}
      >
        Now
      </button>
    </div>
  );
};

export const typedEditCellRenderer: CustomRenderer<TypedEditCell> = {
  kind: GridCellKind.Custom,
  isMatch: (c): c is TypedEditCell => (c.data as Partial<TypedEditCellData>)?.kind === "typed-edit",
  draw: (args, cell) => {
    drawTextCell(args, cell.data.value, "left");
  },
  provideEditor: () => ({ disablePadding: true, editor: TypedEditEditor }),
};

export interface FKCellData {
  readonly kind: "fk-cell";
  readonly value: string;
}

export type FKCell = CustomCell<FKCellData>;

/** Fixed-width hotspot reserved at a FK cell's right edge for the "open relation" arrow —
 *  callers use this to tell whether a click landed on the arrow vs. the value text. */
export const FK_ARROW_ZONE_WIDTH = 22;

export function makeFKCell(value: string, themeOverride: Partial<Theme> | undefined): FKCell {
  return {
    kind: GridCellKind.Custom,
    allowOverlay: false,
    readonly: true,
    copyData: value,
    themeOverride,
    data: { kind: "fk-cell", value },
  };
}

export const fkCellRenderer: CustomRenderer<FKCell> = {
  kind: GridCellKind.Custom,
  isMatch: (c): c is FKCell => (c.data as Partial<FKCellData>)?.kind === "fk-cell",
  draw: (args, cell) => {
    const { ctx, rect, theme } = args;
    const value = cell.data.value;
    const hasArrow = !!value && value.toLowerCase() !== "null";
    if (!hasArrow) {
      drawTextCell(args, value, "left");
      return;
    }
    // Leave room on the right for the arrow glyph so it never overlaps the value text.
    drawTextCell({ ...args, rect: { ...rect, width: rect.width - FK_ARROW_ZONE_WIDTH } }, value, "left");
    ctx.save();
    ctx.font = `${theme.baseFontStyle} ${theme.fontFamily}`;
    ctx.fillStyle = theme.accentColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("→", rect.x + rect.width - FK_ARROW_ZONE_WIDTH / 2, rect.y + rect.height / 2 + 1);
    ctx.restore();
  },
};
