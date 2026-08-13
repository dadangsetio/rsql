import { quoteIdent } from "./sql-utils";

export type DraftStatus = "existing" | "added" | "modified" | "removed";

export interface DraftColumn {
  _id: string;
  _status: DraftStatus;
  name: string;
  originalName?: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  originalDataType?: string;
  originalNullable?: boolean;
  originalDefault?: string | null;
}

export interface DraftPrimaryKey {
  constraintName: string;
  columns: string[];
  _status: DraftStatus;
  originalColumns?: string[];
}

export interface DraftForeignKey {
  _id: string;
  _status: DraftStatus;
  constraintName: string;
  sourceColumns: string[];
  targetSchema: string;
  targetTable: string;
  targetColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface DraftUniqueConstraint {
  _id: string;
  _status: DraftStatus;
  constraintName: string;
  columns: string[];
}

export interface DraftIndex {
  _id: string;
  _status: DraftStatus;
  indexName: string;
  columns: string[];
  isUnique: boolean;
}

export interface StructureEditorState {
  columns: DraftColumn[];
  primaryKey: DraftPrimaryKey | null;
  foreignKeys: DraftForeignKey[];
  uniqueConstraints: DraftUniqueConstraint[];
  indexes: DraftIndex[];
}

/** Every column type Postgres ships built in — covers the full CREATE TABLE type dropdown,
 *  not just the handful people reach for most often. */
export const PG_COMMON_TYPES = [
  // Numeric
  "smallint",
  "integer",
  "bigint",
  "decimal",
  "numeric",
  "real",
  "double precision",
  "smallserial",
  "serial",
  "bigserial",
  "money",
  // Character
  "character varying",
  "varchar",
  "character",
  "char",
  "text",
  // Binary
  "bytea",
  // Date/time
  "timestamp",
  "timestamp with time zone",
  "timestamptz",
  "date",
  "time",
  "time with time zone",
  "timetz",
  "interval",
  // Boolean
  "boolean",
  // Geometric
  "point",
  "line",
  "lseg",
  "box",
  "path",
  "polygon",
  "circle",
  // Network address
  "cidr",
  "inet",
  "macaddr",
  "macaddr8",
  // Bit string
  "bit",
  "bit varying",
  "varbit",
  // Text search
  "tsvector",
  "tsquery",
  // UUID
  "uuid",
  // XML
  "xml",
  // JSON
  "json",
  "jsonb",
  // Range
  "int4range",
  "int8range",
  "numrange",
  "tsrange",
  "tstzrange",
  "daterange",
  // Multirange (PG 14+)
  "int4multirange",
  "int8multirange",
  "nummultirange",
  "tsmultirange",
  "tstzmultirange",
  "datemultirange",
  // Log sequence number
  "pg_lsn",
  // Common array shapes
  "integer[]",
  "text[]",
  "varchar[]",
  "jsonb[]",
  "uuid[]",
];

export const FK_ACTIONS = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"];

function assertValidFkAction(action: string, label: "ON UPDATE" | "ON DELETE"): void {
  if (!FK_ACTIONS.includes(action)) {
    throw new Error(`Invalid ${label} action: "${action}"`);
  }
}

export function generateAlterTableSQL(
  schema: string,
  table: string,
  original: StructureEditorState,
  draft: StructureEditorState,
): string[] {
  const stmts: string[] = [];
  const target = `${quoteIdent(schema)}.${quoteIdent(table)}`;

  // Order matters: drop dependents (FKs, uniques, indexes, PK) before columns,
  // and drop everything before adding new objects, otherwise PG errors out.
  for (const fk of draft.foreignKeys) {
    if (fk._status === "removed") {
      stmts.push(`ALTER TABLE ${target} DROP CONSTRAINT ${quoteIdent(fk.constraintName)};`);
    }
  }

  for (const uc of draft.uniqueConstraints) {
    if (uc._status === "removed") {
      stmts.push(`ALTER TABLE ${target} DROP CONSTRAINT ${quoteIdent(uc.constraintName)};`);
    }
  }

  for (const idx of draft.indexes) {
    if (idx._status === "removed") {
      stmts.push(`DROP INDEX ${quoteIdent(schema)}.${quoteIdent(idx.indexName)};`);
    }
  }

  if (original.primaryKey && draft.primaryKey?._status === "removed") {
    stmts.push(
      `ALTER TABLE ${target} DROP CONSTRAINT ${quoteIdent(original.primaryKey.constraintName)};`,
    );
  } else if (draft.primaryKey?._status === "modified" && original.primaryKey) {
    stmts.push(
      `ALTER TABLE ${target} DROP CONSTRAINT ${quoteIdent(original.primaryKey.constraintName)};`,
    );
  }

  for (const col of draft.columns) {
    if (col._status === "removed") {
      stmts.push(`ALTER TABLE ${target} DROP COLUMN ${quoteIdent(col.name)};`);
    }
  }

  for (const col of draft.columns) {
    if (col._status === "added") {
      let stmt = `ALTER TABLE ${target} ADD COLUMN ${quoteIdent(col.name)} ${col.dataType}`;
      if (!col.nullable) stmt += " NOT NULL";
      if (col.defaultValue) stmt += ` DEFAULT ${col.defaultValue}`;
      stmts.push(`${stmt};`);
    }
  }

  for (const col of draft.columns) {
    if (col._status === "modified") {
      if (col.originalName && col.originalName !== col.name) {
        stmts.push(
          `ALTER TABLE ${target} RENAME COLUMN ${quoteIdent(col.originalName)} TO ${quoteIdent(col.name)};`,
        );
      }

      const effectiveName = col.name;

      if (col.originalDataType && col.originalDataType !== col.dataType) {
        stmts.push(
          `ALTER TABLE ${target} ALTER COLUMN ${quoteIdent(effectiveName)} TYPE ${col.dataType} USING ${quoteIdent(effectiveName)}::${col.dataType};`,
        );
      }

      if (col.originalNullable !== undefined && col.originalNullable !== col.nullable) {
        if (col.nullable) {
          stmts.push(
            `ALTER TABLE ${target} ALTER COLUMN ${quoteIdent(effectiveName)} DROP NOT NULL;`,
          );
        } else {
          stmts.push(
            `ALTER TABLE ${target} ALTER COLUMN ${quoteIdent(effectiveName)} SET NOT NULL;`,
          );
        }
      }

      if (col.originalDefault !== undefined && col.originalDefault !== col.defaultValue) {
        if (col.defaultValue) {
          stmts.push(
            `ALTER TABLE ${target} ALTER COLUMN ${quoteIdent(effectiveName)} SET DEFAULT ${col.defaultValue};`,
          );
        } else {
          stmts.push(
            `ALTER TABLE ${target} ALTER COLUMN ${quoteIdent(effectiveName)} DROP DEFAULT;`,
          );
        }
      }
    }
  }

  if (
    draft.primaryKey &&
    (draft.primaryKey._status === "added" || draft.primaryKey._status === "modified")
  ) {
    const pkCols = draft.primaryKey.columns.map(quoteIdent).join(", ");
    stmts.push(
      `ALTER TABLE ${target} ADD CONSTRAINT ${quoteIdent(draft.primaryKey.constraintName)} PRIMARY KEY (${pkCols});`,
    );
  }

  for (const uc of draft.uniqueConstraints) {
    if (uc._status === "added") {
      const ucCols = uc.columns.map(quoteIdent).join(", ");
      stmts.push(
        `ALTER TABLE ${target} ADD CONSTRAINT ${quoteIdent(uc.constraintName)} UNIQUE (${ucCols});`,
      );
    }
  }

  for (const idx of draft.indexes) {
    if (idx._status === "added") {
      const idxCols = idx.columns.map(quoteIdent).join(", ");
      const unique = idx.isUnique ? "UNIQUE " : "";
      stmts.push(`CREATE ${unique}INDEX ${quoteIdent(idx.indexName)} ON ${target} (${idxCols});`);
    }
  }

  for (const fk of draft.foreignKeys) {
    if (fk._status === "added") {
      assertValidFkAction(fk.onUpdate, "ON UPDATE");
      assertValidFkAction(fk.onDelete, "ON DELETE");
      const srcCols = fk.sourceColumns.map(quoteIdent).join(", ");
      const tgtCols = fk.targetColumns.map(quoteIdent).join(", ");
      const tgtTable = `${quoteIdent(fk.targetSchema)}.${quoteIdent(fk.targetTable)}`;
      stmts.push(
        `ALTER TABLE ${target} ADD CONSTRAINT ${quoteIdent(fk.constraintName)} ` +
          `FOREIGN KEY (${srcCols}) REFERENCES ${tgtTable} (${tgtCols}) ` +
          `ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete};`,
      );
    }
  }

  return stmts;
}

export interface DraftTrigger {
  _id: string;
  name: string;
  timing: "BEFORE" | "AFTER";
  events: ("INSERT" | "UPDATE" | "DELETE" | "TRUNCATE")[];
  forEachRow: boolean;
  functionSchema: string;
  functionName: string;
}

/** Skips triggers still missing a name, an event, or a function — same "ignore incomplete
 *  drafts" behavior as the other CREATE TABLE sections instead of erroring on them. */
export function generateCreateTriggerSQL(
  schema: string,
  table: string,
  triggers: DraftTrigger[],
): string[] {
  const target = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  return triggers
    .filter((t) => t.name.trim() && t.events.length > 0 && t.functionName.trim())
    .map((t) => {
      const fn = `${quoteIdent(t.functionSchema.trim() || schema)}.${quoteIdent(t.functionName.trim())}`;
      return (
        `CREATE TRIGGER ${quoteIdent(t.name.trim())} ${t.timing} ${t.events.join(" OR ")} ` +
        `ON ${target} FOR EACH ${t.forEachRow ? "ROW" : "STATEMENT"} EXECUTE FUNCTION ${fn}();`
      );
    });
}

/** Returns a human-readable error if any trigger draft is incomplete, else null. */
export function validateDraftTriggers(triggers: DraftTrigger[]): string | null {
  for (const t of triggers) {
    if (!t.name.trim()) return "Trigger name cannot be empty";
    if (t.events.length === 0) return `Trigger "${t.name}" needs at least one event`;
    if (!t.functionName.trim()) return `Trigger "${t.name}" needs a function to execute`;
  }
  const seen = new Set<string>();
  for (const t of triggers) {
    const name = t.name.trim();
    if (seen.has(name)) return `Duplicate trigger name "${name}"`;
    seen.add(name);
  }
  return null;
}

export function generateCreateTableSQL(
  schema: string,
  table: string,
  draft: StructureEditorState,
  triggers: DraftTrigger[] = [],
): string[] {
  const target = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const activeColumns = draft.columns.filter((c) => c._status !== "removed");

  const colDefs = activeColumns.map((col) => {
    let def = `${quoteIdent(col.name)} ${col.dataType}`;
    if (!col.nullable) def += " NOT NULL";
    if (col.defaultValue) def += ` DEFAULT ${col.defaultValue}`;
    return def;
  });
  if (
    draft.primaryKey &&
    draft.primaryKey._status !== "removed" &&
    draft.primaryKey.columns.length > 0
  ) {
    colDefs.push(`PRIMARY KEY (${draft.primaryKey.columns.map(quoteIdent).join(", ")})`);
  }

  const stmts = [`CREATE TABLE ${target} (\n  ${colDefs.join(",\n  ")}\n);`];

  for (const uc of draft.uniqueConstraints) {
    if (uc._status === "removed") continue;
    const ucCols = uc.columns.map(quoteIdent).join(", ");
    stmts.push(
      `ALTER TABLE ${target} ADD CONSTRAINT ${quoteIdent(uc.constraintName)} UNIQUE (${ucCols});`,
    );
  }

  for (const idx of draft.indexes) {
    if (idx._status === "removed") continue;
    const idxCols = idx.columns.map(quoteIdent).join(", ");
    const unique = idx.isUnique ? "UNIQUE " : "";
    stmts.push(`CREATE ${unique}INDEX ${quoteIdent(idx.indexName)} ON ${target} (${idxCols});`);
  }

  for (const fk of draft.foreignKeys) {
    if (fk._status === "removed") continue;
    assertValidFkAction(fk.onUpdate, "ON UPDATE");
    assertValidFkAction(fk.onDelete, "ON DELETE");
    const srcCols = fk.sourceColumns.map(quoteIdent).join(", ");
    const tgtCols = fk.targetColumns.map(quoteIdent).join(", ");
    const tgtTable = `${quoteIdent(fk.targetSchema)}.${quoteIdent(fk.targetTable)}`;
    stmts.push(
      `ALTER TABLE ${target} ADD CONSTRAINT ${quoteIdent(fk.constraintName)} ` +
        `FOREIGN KEY (${srcCols}) REFERENCES ${tgtTable} (${tgtCols}) ` +
        `ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete};`,
    );
  }

  stmts.push(...generateCreateTriggerSQL(schema, table, triggers));

  return stmts;
}

/** Returns a human-readable error if the draft's columns are invalid, else null. */
export function validateDraftColumns(state: StructureEditorState): string | null {
  const active = state.columns.filter((c) => c._status !== "removed");
  for (const col of active) {
    if (!col.name.trim()) return "Column name cannot be empty";
    if (!col.dataType.trim()) return `Column "${col.name}" needs a data type`;
  }
  const seen = new Set<string>();
  for (const col of active) {
    const name = col.name.trim();
    if (seen.has(name)) return `Duplicate column name "${name}"`;
    seen.add(name);
  }
  return null;
}

export function countChanges(state: StructureEditorState): number {
  let count = 0;
  for (const col of state.columns) {
    if (col._status !== "existing") count++;
  }
  if (state.primaryKey && state.primaryKey._status !== "existing") count++;
  for (const fk of state.foreignKeys) {
    if (fk._status !== "existing") count++;
  }
  for (const uc of state.uniqueConstraints) {
    if (uc._status !== "existing") count++;
  }
  for (const idx of state.indexes) {
    if (idx._status !== "existing") count++;
  }
  return count;
}
