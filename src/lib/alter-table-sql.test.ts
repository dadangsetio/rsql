import { describe, expect, it } from "vitest";
import {
  type DraftForeignKey,
  generateAlterTableSQL,
  generateCreateTableSQL,
  type StructureEditorState,
} from "./alter-table-sql";

function emptyState(): StructureEditorState {
  return { columns: [], primaryKey: null, foreignKeys: [], uniqueConstraints: [], indexes: [] };
}

function fk(over: Partial<DraftForeignKey> = {}): DraftForeignKey {
  return {
    _id: "fk1",
    _status: "added",
    constraintName: "fk_orders_customer",
    sourceColumns: ["customer_id"],
    targetSchema: "public",
    targetTable: "customers",
    targetColumns: ["id"],
    onUpdate: "CASCADE",
    onDelete: "SET NULL",
    ...over,
  };
}

describe("foreign key action validation", () => {
  it("accepts a valid ON UPDATE/ON DELETE action pair", () => {
    const draft = { ...emptyState(), foreignKeys: [fk()] };
    const stmts = generateAlterTableSQL("public", "orders", emptyState(), draft);
    expect(stmts.join("\n")).toContain("ON UPDATE CASCADE ON DELETE SET NULL");
  });

  it("rejects a non-whitelisted ON UPDATE action instead of emitting it into SQL", () => {
    const draft = { ...emptyState(), foreignKeys: [fk({ onUpdate: "CASCADE'; DROP TABLE users; --" })] };
    expect(() => generateAlterTableSQL("public", "orders", emptyState(), draft)).toThrow(
      /Invalid ON UPDATE action/,
    );
  });

  it("rejects a non-whitelisted ON DELETE action", () => {
    const draft = { ...emptyState(), foreignKeys: [fk({ onDelete: "" })] };
    expect(() => generateAlterTableSQL("public", "orders", emptyState(), draft)).toThrow(
      /Invalid ON DELETE action/,
    );
  });

  it("also validates FK actions in CREATE TABLE generation", () => {
    const draft = { ...emptyState(), foreignKeys: [fk({ onUpdate: "not-a-real-action" })] };
    expect(() => generateCreateTableSQL("public", "orders", draft)).toThrow(
      /Invalid ON UPDATE action/,
    );
  });
});
