/**
 * Pending grid row edits, keyed by row identity rather than grid position.
 *
 * Row indices are not a stable identity: they shift when a result is refreshed
 * and they mean nothing at all against a different result set, which is how an
 * edit marked in one tab could previously be applied to another table. A pending
 * mutation is therefore keyed by the primary-key tuple captured at the moment it
 * was marked, and that key is itself the serialized tuple, so the key and the
 * values it stands for cannot drift apart.
 */

import type { CellValue } from "@/lib/wire";

export type MutationKind = "update" | "delete" | "insert";

export type KeyTuple = [string, CellValue][];

export interface RowMutation {
  kind: MutationKind;
  set: KeyTuple;
  pk: KeyTuple;
}

export interface MutationReport {
  updated: number;
  deleted: number;
  inserted: number;
}

export interface EditSession {
  schema: string;
  table: string;
  pkColumns: string[];
  /** pkKey -> column -> new value */
  edits: Record<string, Record<string, CellValue>>;
  /** pkKey list */
  deletes: string[];
  /** draftId -> column -> value, for rows staged from the grid's trailing blank row. */
  inserts: Record<string, Record<string, CellValue>>;
}

export function emptySession(schema: string, table: string, pkColumns: string[]): EditSession {
  return { schema, table, pkColumns, edits: {}, deletes: [], inserts: {} };
}

/**
 * Identity of a row, or `null` when the row cannot be identified — a short row,
 * a stale index, or a result that no longer carries every key column. Callers
 * must treat `null` as "not editable" rather than falling back to a position.
 */
export function pkKey(
  columns: string[],
  row: CellValue[] | undefined,
  pkColumns: string[],
): string | null {
  if (!row || pkColumns.length === 0) return null;

  const tuple: KeyTuple = [];
  for (const column of pkColumns) {
    const index = columns.indexOf(column);
    if (index === -1) return null;
    const value = row[index];
    if (value === undefined) return null;
    tuple.push([column, value]);
  }
  return JSON.stringify(tuple);
}

export function parsePkKey(key: string): KeyTuple {
  return JSON.parse(key) as KeyTuple;
}

/** Identity for every row of a result, computed once per result. */
export function rowKeys(
  columns: string[],
  rows: CellValue[][],
  pkColumns: string[],
): (string | null)[] {
  return rows.map((row) => pkKey(columns, row, pkColumns));
}

export function countPending(session: EditSession): {
  updates: number;
  deletes: number;
  inserts: number;
} {
  const deletes = new Set(session.deletes);
  const updates = Object.entries(session.edits).filter(
    ([key, columns]) => !deletes.has(key) && Object.keys(columns).length > 0,
  ).length;
  const inserts = Object.values(session.inserts).filter(
    (columns) => Object.keys(columns).length > 0,
  ).length;
  return { updates, deletes: deletes.size, inserts };
}

/**
 * Turn a session into the backend payload. Updates come first, then deletes,
 * then inserts. Edits on a row that is also marked for deletion are dropped
 * rather than sent — deleting a row makes its cell edits moot. A draft row
 * with no cells set yet (the ever-present blank row at the bottom of the
 * grid) is not a real insert and is skipped.
 */
export function buildMutations(session: EditSession): RowMutation[] {
  const deletes = new Set(session.deletes);
  const out: RowMutation[] = [];

  for (const [key, columns] of Object.entries(session.edits)) {
    if (deletes.has(key)) continue;
    const set = Object.entries(columns) as KeyTuple;
    if (set.length === 0) continue;
    out.push({ kind: "update", set, pk: parsePkKey(key) });
  }

  for (const key of session.deletes) {
    out.push({ kind: "delete", set: [], pk: parsePkKey(key) });
  }

  for (const columns of Object.values(session.inserts)) {
    const set = Object.entries(columns) as KeyTuple;
    if (set.length === 0) continue;
    out.push({ kind: "insert", set, pk: [] });
  }

  return out;
}
