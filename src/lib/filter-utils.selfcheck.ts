// Ad hoc self-check for filter-utils.ts. No framework — run with:
//   npx tsx src/lib/filter-utils.selfcheck.ts
import assert from "node:assert";
import {
  classifyFilterColumnKind,
  conditionToSql,
  buildFilteredSql,
  buildSortedSql,
} from "./filter-utils";
import type { ColumnFilterCondition, FilterState } from "@/types";

const col = (partial: Partial<ColumnFilterCondition> & Pick<ColumnFilterCondition, "column" | "operator">): ColumnFilterCondition => ({
  id: "c",
  type: "column",
  join: "and",
  value: "",
  ...partial,
});

// All-AND: left-fold still reduces to a flat chain when every join is "and"
const andState: FilterState = {
  open: true,
  conditions: [
    col({ id: "1", column: "status", operator: "eq", value: "active" }),
    col({ id: "2", column: "name", operator: "contains", value: "foo", join: "and" }),
  ],
};
assert.strictEqual(
  buildFilteredSql("SELECT * FROM users", andState),
  `SELECT * FROM (SELECT * FROM users) AS rsql_filtered WHERE ("status" = 'active' AND "name" ILIKE '%foo%')`,
);

// Mixed AND/OR: each condition's own `join` controls only its own connector — toggling one
// must not flip the others. Folded left-to-right with explicit parens, so precedence is
// never ambiguous: a AND b, then OR c, then AND d -> "(((a AND b) OR c) AND d)".
const mixedState: FilterState = {
  open: true,
  conditions: [
    col({ id: "1", column: "status", operator: "eq", value: "active" }),
    col({ id: "2", column: "deleted_at", operator: "is_null", join: "and" }),
    col({ id: "3", column: "age", operator: "between", value: "10", value2: "20", join: "or" }),
    { id: "4", type: "raw", join: "and", sql: "archived is true" },
  ],
};
assert.strictEqual(
  buildFilteredSql("SELECT * FROM users", mixedState),
  `SELECT * FROM (SELECT * FROM users) AS rsql_filtered WHERE ((("status" = 'active' AND "deleted_at" IS NULL) OR "age" BETWEEN '10' AND '20') AND (archived is true))`,
);

// Raw-only condition
const rawState: FilterState = { open: true, conditions: [{ id: "r", type: "raw", join: "and", sql: "age > 18" }] };
assert.strictEqual(
  buildFilteredSql("SELECT * FROM users", rawState),
  `SELECT * FROM (SELECT * FROM users) AS rsql_filtered WHERE (age > 18)`,
);

// LIMIT stripped from base and re-appended after the WHERE clause is applied
assert.strictEqual(
  buildFilteredSql("SELECT * FROM users LIMIT 50", andState),
  `SELECT * FROM (SELECT * FROM users) AS rsql_filtered WHERE ("status" = 'active' AND "name" ILIKE '%foo%') LIMIT 50`,
);

// LIMIT + OFFSET stripped and re-appended in the same order
assert.strictEqual(
  buildFilteredSql("SELECT * FROM users LIMIT 50 OFFSET 100", rawState),
  `SELECT * FROM (SELECT * FROM users) AS rsql_filtered WHERE (age > 18) LIMIT 50 OFFSET 100`,
);

// No active filter -> null (empty conditions list, and a raw condition with blank text)
const empty: FilterState = { open: true, conditions: [] };
assert.strictEqual(buildFilteredSql("SELECT * FROM users", empty), null);
const blankRaw: FilterState = { open: true, conditions: [{ id: "r", type: "raw", join: "and", sql: "   " }] };
assert.strictEqual(buildFilteredSql("SELECT * FROM users", blankRaw), null);

// classifyFilterColumnKind buckets integers as "numeric" (unlike column-edit-kind.ts's "text")
assert.strictEqual(classifyFilterColumnKind("integer", "int4", new Map()).kind, "numeric");
assert.strictEqual(classifyFilterColumnKind("bigint", "int8", new Map()).kind, "numeric");

// conditionToSql returns null for an incomplete condition instead of broken SQL
assert.strictEqual(conditionToSql(col({ column: "status", operator: "eq", value: "" })), null);
assert.strictEqual(conditionToSql(col({ column: "age", operator: "between", value: "10" })), null);
assert.strictEqual(conditionToSql({ id: "r", type: "raw", join: "and", sql: "" }), null);

// buildSortedSql: wraps as a subquery, ORDER BY after WHERE would be if chained, LIMIT/OFFSET
// stripped and re-appended after the ORDER BY
assert.strictEqual(buildSortedSql("SELECT * FROM users", undefined), null);
assert.strictEqual(
  buildSortedSql("SELECT * FROM users", { column: "name", direction: "asc" }),
  `SELECT * FROM (SELECT * FROM users) AS rsql_sorted ORDER BY "name" ASC`,
);
assert.strictEqual(
  buildSortedSql("SELECT * FROM users LIMIT 50", { column: "age", direction: "desc" }),
  `SELECT * FROM (SELECT * FROM users) AS rsql_sorted ORDER BY "age" DESC LIMIT 50`,
);

console.log("OK");
