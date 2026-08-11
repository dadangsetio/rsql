import type { FilterCondition, FilterOperator, FilterState, SortState } from "@/types";
import { quoteIdent, quoteLiteral } from "./sql-utils";

/** Column bucket for picking which comparison operators make sense (distinct from
 *  column-edit-kind.ts's ColumnEditKind — that one lumps integers into "text", which
 *  is wrong here since filtering needs >/< on integer columns). */
export type FilterColumnKind =
  | "numeric"
  | "text"
  | "boolean"
  | "date"
  | "time"
  | "timestamp"
  | "enum";

export interface FilterColumnInfo {
  kind: FilterColumnKind;
  enumValues?: string[];
}

const NUMERIC_TYPES = new Set([
  "smallint",
  "integer",
  "bigint",
  "decimal",
  "numeric",
  "real",
  "double precision",
  "serial",
  "bigserial",
  "money",
]);

/** Classify a Postgres column's information_schema data_type for the filter bar's operator picker. */
export function classifyFilterColumnKind(
  dataType: string,
  udtName: string,
  enumLabelsByType: Map<string, string[]>,
): FilterColumnInfo {
  const type = dataType.toLowerCase();
  if (type === "boolean") return { kind: "boolean" };
  if (type === "date") return { kind: "date" };
  if (type.startsWith("timestamp")) return { kind: "timestamp" };
  if (type.startsWith("time")) return { kind: "time" };
  if (type === "user-defined") {
    const enumValues = enumLabelsByType.get(udtName);
    if (enumValues) return { kind: "enum", enumValues };
  }
  if (NUMERIC_TYPES.has(type)) return { kind: "numeric" };
  return { kind: "text" };
}

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
  contains: "contains",
  starts_with: "starts with",
  ends_with: "ends with",
  between: "between",
  in: "in",
  is_null: "is null",
  is_not_null: "is not null",
  is_true: "is true",
  is_false: "is false",
};

const COMPARISON: FilterOperator[] = ["eq", "neq", "gt", "lt", "gte", "lte", "between"];
const NULL_CHECKS: FilterOperator[] = ["is_null", "is_not_null"];

export const OPERATORS_BY_KIND: Record<FilterColumnKind, FilterOperator[]> = {
  numeric: [...COMPARISON, ...NULL_CHECKS],
  date: [...COMPARISON, ...NULL_CHECKS],
  time: [...COMPARISON, ...NULL_CHECKS],
  timestamp: [...COMPARISON, ...NULL_CHECKS],
  text: ["eq", "neq", "contains", "starts_with", "ends_with", ...NULL_CHECKS],
  boolean: ["is_true", "is_false", ...NULL_CHECKS],
  enum: ["eq", "neq", "in", ...NULL_CHECKS],
};

/** Operators that don't take a value input at all. */
export const VALUELESS_OPERATORS: FilterOperator[] = [
  "is_null",
  "is_not_null",
  "is_true",
  "is_false",
];

export function operatorNeedsValue(op: FilterOperator): boolean {
  return !VALUELESS_OPERATORS.includes(op);
}

/** Build one condition's SQL fragment. Returns null for incomplete conditions (missing value,
 *  blank raw text) so the caller can drop them rather than emit broken SQL. Raw fragments are
 *  parenthesized since they may contain their own AND/OR and would otherwise fight the joiner
 *  buildConditionsSql wraps them in. */
export function conditionToSql(cond: FilterCondition): string | null {
  if (cond.type === "raw") {
    const sql = cond.sql.trim();
    return sql ? `(${sql})` : null;
  }

  const col = quoteIdent(cond.column);
  switch (cond.operator) {
    case "eq":
      return cond.value ? `${col} = ${quoteLiteral(cond.value)}` : null;
    case "neq":
      return cond.value ? `${col} != ${quoteLiteral(cond.value)}` : null;
    case "gt":
      return cond.value ? `${col} > ${quoteLiteral(cond.value)}` : null;
    case "lt":
      return cond.value ? `${col} < ${quoteLiteral(cond.value)}` : null;
    case "gte":
      return cond.value ? `${col} >= ${quoteLiteral(cond.value)}` : null;
    case "lte":
      return cond.value ? `${col} <= ${quoteLiteral(cond.value)}` : null;
    case "contains":
      return cond.value ? `${col} ILIKE ${quoteLiteral(`%${cond.value}%`)}` : null;
    case "starts_with":
      return cond.value ? `${col} ILIKE ${quoteLiteral(`${cond.value}%`)}` : null;
    case "ends_with":
      return cond.value ? `${col} ILIKE ${quoteLiteral(`%${cond.value}`)}` : null;
    case "between":
      return cond.value && cond.value2
        ? `${col} BETWEEN ${quoteLiteral(cond.value)} AND ${quoteLiteral(cond.value2)}`
        : null;
    case "in": {
      const values = cond.value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      return values.length ? `${col} IN (${values.map(quoteLiteral).join(", ")})` : null;
    }
    case "is_null":
      return `${col} IS NULL`;
    case "is_not_null":
      return `${col} IS NOT NULL`;
    case "is_true":
      return `${col} IS TRUE`;
    case "is_false":
      return `${col} IS FALSE`;
    default:
      return null;
  }
}

/** Combine every condition (column-based or raw) into one WHERE body, dropping incomplete rows.
 *  Each surviving condition's own `join` says how it combines with everything before it — folded
 *  left-to-right with explicit parens (`(a AND b) OR c`, not `a AND b OR c`) so mixed AND/OR
 *  chains never depend on SQL's AND-binds-tighter-than-OR precedence to mean what they show. */
export function buildConditionsSql(state: FilterState): string {
  const parts = state.conditions
    .map((c) => ({ sql: conditionToSql(c), join: c.join }))
    .filter((p): p is { sql: string; join: FilterCondition["join"] } => !!p.sql);
  if (parts.length === 0) return "";

  let result = parts[0].sql;
  for (let i = 1; i < parts.length; i++) {
    result = `(${result} ${parts[i].join === "or" ? "OR" : "AND"} ${parts[i].sql})`;
  }
  return result;
}

/** Strip a trailing `;`, then a trailing LIMIT and/or OFFSET clause (either order), returning
 *  the base query and the removed clause(s) so they can be re-appended after the query is
 *  rewritten to filter the *whole* result set rather than just whatever the LIMIT already cut. */
function stripTrailingLimitOffset(sql: string): { base: string; tail: string } {
  let base = sql.trim().replace(/;+\s*$/, "");
  const tailParts: string[] = [];
  for (let i = 0; i < 2; i++) {
    const m = base.match(/^([\s\S]*?)\s+(LIMIT\s+\d+|OFFSET\s+\d+)\s*$/i);
    if (!m) break;
    base = m[1];
    tailParts.unshift(m[2].toUpperCase());
  }
  return { base, tail: tailParts.length ? ` ${tailParts.join(" ")}` : "" };
}

/** Compose the SQL to run for the current filter state, wrapping the tab's base query as a
 *  subquery so filtering works whether it's a simple table browse or an arbitrary/JOIN query.
 *  Returns null when there's no active WHERE body (nothing to apply). */
export function buildFilteredSql(baseSql: string, state: FilterState): string | null {
  const whereBody = buildConditionsSql(state);
  if (!whereBody) return null;
  const { base, tail } = stripTrailingLimitOffset(baseSql);
  return `SELECT * FROM (${base}) AS rsql_filtered WHERE ${whereBody}${tail}`;
}

/** Compose the SQL to run for a column-header sort, wrapping the query as a subquery the same
 *  way buildFilteredSql does — so sorting works on arbitrary/JOIN queries too, and (critically)
 *  re-runs the sort against the *whole* result set rather than just whatever page is loaded. */
export function buildSortedSql(baseSql: string, sort: SortState | undefined): string | null {
  if (!sort) return null;
  const { base, tail } = stripTrailingLimitOffset(baseSql);
  return `SELECT * FROM (${base}) AS rsql_sorted ORDER BY ${quoteIdent(sort.column)} ${sort.direction.toUpperCase()}${tail}`;
}

export function emptyFilterState(): FilterState {
  return { open: false, conditions: [] };
}

export function newColumnCondition(column: string, kind: FilterColumnKind): FilterCondition {
  return {
    id: crypto.randomUUID(),
    type: "column",
    join: "and",
    column,
    operator: OPERATORS_BY_KIND[kind][0],
    value: "",
  };
}

export function newRawCondition(): FilterCondition {
  return { id: crypto.randomUUID(), type: "raw", join: "and", sql: "" };
}
