/** How a column's value should be edited in the results grid. "numeric" edits as plain text
 *  (a native number input would round arbitrary-precision numeric/decimal) but gets a
 *  comma-grouped read-only display. */
export type ColumnEditKind =
  | "text"
  | "numeric"
  | "boolean"
  | "date"
  | "time"
  | "timestamp"
  | "enum";

/** The subset of kinds that render as an <input type="date"|"time"|"datetime-local">. */
export type DateTimeEditKind = "date" | "time" | "timestamp";

export interface ColumnEditInfo {
  kind: ColumnEditKind;
  /** Dropdown choices, only set when kind === "enum". */
  enumValues?: string[];
  /** Whether the column accepts NULL — clearing a cell to empty saves as NULL only when true. */
  nullable: boolean;
}

/** Classify a Postgres column's information_schema data_type into an edit widget kind. */
export function classifyColumnEditKind(
  dataType: string,
  udtName: string,
  nullable: boolean,
  enumLabelsByType: Map<string, string[]>,
): ColumnEditInfo {
  const type = dataType.toLowerCase();
  if (type === "boolean") return { kind: "boolean", nullable };
  if (type === "date") return { kind: "date", nullable };
  if (type.startsWith("timestamp")) return { kind: "timestamp", nullable };
  if (type.startsWith("time")) return { kind: "time", nullable };
  if (type === "user-defined") {
    const enumValues = enumLabelsByType.get(udtName);
    if (enumValues) return { kind: "enum", enumValues, nullable };
  }
  // "numeric"/"decimal" both report as "numeric"; float4/float8 report as "real"/"double precision".
  // Integers (integer, bigint, smallint) are deliberately left as plain "text" — comma-grouping an
  // id/count column fights copy-paste and visual scanning, which is why most DB tools skip it too.
  if (type === "numeric" || type === "real" || type === "double precision")
    return { kind: "numeric", nullable };
  // Everything else (character, uuid, json[b], arrays, bytea, ...) stays plain text — it's
  // already edited and displayed fine as raw text.
  return { kind: "text", nullable };
}

/**
 * Comma-group the integer part of a plain decimal number string for display, keeping every
 * fractional digit exactly as Postgres printed it. Pure string manipulation — never routes through
 * `Number()`/`parseFloat`, which would silently round an arbitrary-precision `numeric` value.
 * Non-numeric-looking input (NULL sentinel, NaN, scientific notation, money's "$" prefix, ...) is
 * returned unchanged.
 */
export function formatNumericDisplay(raw: string): string {
  const match = raw.match(/^(-?)(\d+)(\.\d+)?$/);
  if (!match) return raw;
  const [, sign, intPart, fracPart = ""] = match;
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}${fracPart}`;
}

/** Build a Map<enumTypeName, labels[]> from driver.loadEnumTypes() rows ([schema, name, "a, b, c"]). */
export function buildEnumLabelMap(enumRows: string[][]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [, name, labels] of enumRows) {
    map.set(name, labels.split(", "));
  }
  return map;
}

/**
 * Convert a raw Postgres text value into the value an <input type="date"|"time"|"datetime-local">
 * expects. Any timezone offset Postgres prints for `timestamptz`/`timetz` (e.g. "+07") is dropped —
 * these inputs don't accept one, so an edit is written back in the session's local timezone.
 */
export function toDateTimeInputValue(raw: string, kind: DateTimeEditKind): string {
  if (!raw || raw.toLowerCase() === "null") return "";
  if (kind === "date") return raw.slice(0, 10);
  if (kind === "time") {
    const match = raw.match(/^(\d{2}:\d{2}(?::\d{2})?)/);
    return match ? match[1] : "";
  }
  // "2024-01-15 10:30:00.123456+07" -> "2024-01-15T10:30:00"
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  return match ? `${match[1]}T${match[2]}` : "";
}

/** Current local date/time formatted for the given edit kind's raw storage value. */
export function nowValueFor(kind: DateTimeEditKind): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  if (kind === "date") return datePart;
  if (kind === "time") return timePart;
  return `${datePart}T${timePart}`;
}
