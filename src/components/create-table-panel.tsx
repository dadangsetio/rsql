import {
  AlertTriangle,
  ChevronRight,
  Copy,
  FileCode,
  Loader2,
  Play,
  TableProperties,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FkeysSection } from "@/components/object-properties-modal/structure-editor/fkeys-section";
import { IndexesSection } from "@/components/object-properties-modal/structure-editor/indexes-section";
import { uid } from "@/components/object-properties-modal/structure-editor/initialization";
import { TriggersSection } from "@/components/object-properties-modal/structure-editor/triggers-section";
import { UniqueSection } from "@/components/object-properties-modal/structure-editor/unique-section";
import { Button } from "@/components/ui/button";
import type { DraftColumn, DraftTrigger, StructureEditorState } from "@/lib/alter-table-sql";
import {
  generateCreateTableSQL,
  PG_COMMON_TYPES,
  validateDraftColumns,
  validateDraftTriggers,
} from "@/lib/alter-table-sql";
import type { ColumnEditInfo } from "@/lib/column-edit-kind";
import { DriverFactory } from "@/lib/database-driver";
import { cn } from "@/lib/utils";
import type { CellValue } from "@/lib/wire";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { ResultsGrid } from "./results-grid";

type AdvancedTab = "fkeys" | "unique" | "indexes" | "triggers";

const GRID_COLUMNS = ["Name", "Type", "Length", "Nullable", "Primary Key", "Default"];
const COLUMN_TYPES = new Map<string, ColumnEditInfo>([
  ["Type", { kind: "enum", enumValues: PG_COMMON_TYPES, nullable: false }],
  ["Nullable", { kind: "boolean", nullable: false }],
  ["Primary Key", { kind: "boolean", nullable: false }],
]);
const [COL_NAME, COL_TYPE, COL_LENGTH, COL_NULLABLE, COL_PK, COL_DEFAULT] = [0, 1, 2, 3, 4, 5];

/** Splits a trailing "(...)" off a data type, e.g. "varchar(255)" -> base "varchar", length "255". */
function splitType(dataType: string): { base: string; length: string } {
  const m = dataType.match(/^(.+?)\(([^)]*)\)$/);
  if (!m) return { base: dataType, length: "" };
  return { base: m[1].trim(), length: m[2].trim() };
}

function composeType(base: string, length: string): string {
  const b = base.trim();
  return length.trim() ? `${b}(${length.trim()})` : b;
}

function initialDraft(): StructureEditorState {
  return {
    columns: [
      {
        _id: uid(),
        _status: "added",
        name: "id",
        dataType: "serial",
        nullable: false,
        defaultValue: null,
      },
    ],
    primaryKey: { constraintName: "id_pkey", columns: ["id"], _status: "added" },
    foreignKeys: [],
    uniqueConstraints: [],
    indexes: [],
  };
}

export function CreateTablePanel({
  projectId,
  schema,
  tabId,
}: {
  projectId: string;
  schema: string;
  tabId: string;
}) {
  const [tableName, setTableName] = useState("new_table");
  const [draft, setDraft] = useState<StructureEditorState>(initialDraft);
  const [triggers, setTriggers] = useState<DraftTrigger[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedTab, setAdvancedTab] = useState<AdvancedTab>("fkeys");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);

  const tables = useProjectStore((s) => s.tables);
  const schemas = useProjectStore((s) => s.schemas);
  const loadTables = useProjectStore((s) => s.loadTables);
  const loadSchemaObjects = useProjectStore((s) => s.loadSchemaObjects);
  const triggerFunctions = useProjectStore((s) => s.triggerFunctions[`${projectId}::${schema}`]);
  const openTab = useTabStore((s) => s.openTab);
  const closeTabById = useTabStore((s) => s.closeTabById);
  const availableSchemas = schemas[projectId] ?? [];
  const getTablesForSchema = (s: string) => (tables[`${projectId}::${s}`] ?? []).map((t) => t.name);
  const availableFunctions = (triggerFunctions ?? []).map((f) => f.name);

  useEffect(() => {
    void loadSchemaObjects(projectId, schema);
  }, [projectId, schema, loadSchemaObjects]);

  const getDriver = () => {
    const d = useProjectStore.getState().projects[projectId];
    if (!d) return null;
    return DriverFactory.getDriver(d.driver);
  };

  const activeCols = draft.columns.filter((c) => c._status !== "removed");
  const activeColNames = activeCols.map((c) => c.name);
  const validName = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName.trim());
  const columnError = validateDraftColumns(draft);
  const triggerError = validateDraftTriggers(triggers);
  const canCreate = validName && activeColNames.length > 0 && !columnError && !triggerError;

  const sqlStatements = useMemo(
    () => (validName ? generateCreateTableSQL(schema, tableName.trim(), draft, triggers) : []),
    [schema, tableName, draft, triggers, validName],
  );
  const sqlPreview = sqlStatements.join("\n");

  // The column list, rendered through the same grid used for browsing/editing table rows —
  // each "row" here is one column definition, plus a trailing blank row to type a new one into
  // (the same invitation-row pattern the results grid uses to stage a new data row).
  const gridRows = useMemo((): CellValue[][] => {
    const rows = activeCols.map((col) => {
      const { base, length } = splitType(col.dataType);
      const isPk = !!draft.primaryKey?.columns.includes(col.name);
      return [
        col.name,
        base,
        length,
        col.nullable ? "t" : "f",
        isPk ? "t" : "f",
        col.defaultValue ?? "",
      ];
    });
    rows.push(["", "", "", "f", "f", ""]);
    return rows;
  }, [activeCols, draft.primaryKey]);

  const updateColumn = (id: string, updates: Partial<DraftColumn>) => {
    setDraft((prev) => ({
      ...prev,
      columns: prev.columns.map((c) => (c._id === id ? { ...c, ...updates } : c)),
    }));
  };

  const setPk = (name: string, member: boolean) => {
    setDraft((prev) => {
      const current = prev.primaryKey?.columns ?? [];
      const next = member
        ? [...current.filter((c) => c !== name), name]
        : current.filter((c) => c !== name);
      if (next.length === 0) return { ...prev, primaryKey: null };
      return {
        ...prev,
        primaryKey: {
          constraintName: prev.primaryKey?.constraintName ?? `${tableName.trim()}_pkey`,
          columns: next,
          _status: "added",
        },
      };
    });
  };

  const handleCellEdit = (rowIndex: number, colIndex: number, value: CellValue) => {
    const strVal = value ?? "";

    // Editing the trailing blank row materializes a new column, seeded with this one field.
    if (rowIndex >= activeCols.length) {
      const id = uid();
      const seed: DraftColumn = {
        _id: id,
        _status: "added",
        name: "",
        dataType: "text",
        nullable: true,
        defaultValue: null,
      };
      if (colIndex === COL_NAME) seed.name = strVal;
      else if (colIndex === COL_TYPE) seed.dataType = composeType(strVal, "");
      else if (colIndex === COL_LENGTH) seed.dataType = composeType(seed.dataType, strVal);
      else if (colIndex === COL_NULLABLE) seed.nullable = strVal === "t";
      else if (colIndex === COL_DEFAULT) seed.defaultValue = strVal || null;
      setDraft((prev) => ({ ...prev, columns: [...prev.columns, seed] }));
      if (colIndex === COL_PK) setPk(seed.name, strVal === "t");
      return;
    }

    const col = activeCols[rowIndex];
    if (colIndex === COL_NAME) {
      updateColumn(col._id, { name: strVal });
      if (draft.primaryKey?.columns.includes(col.name)) {
        setPk(col.name, false);
        setPk(strVal, true);
      }
    } else if (colIndex === COL_TYPE) {
      updateColumn(col._id, { dataType: composeType(strVal, splitType(col.dataType).length) });
    } else if (colIndex === COL_LENGTH) {
      updateColumn(col._id, { dataType: composeType(splitType(col.dataType).base, strVal) });
    } else if (colIndex === COL_NULLABLE) {
      updateColumn(col._id, { nullable: strVal === "t" });
    } else if (colIndex === COL_PK) {
      setPk(col.name, strVal === "t");
    } else if (colIndex === COL_DEFAULT) {
      updateColumn(col._id, { defaultValue: strVal || null });
    }
  };

  const handleRowDelete = (rowIndex: number) => {
    if (rowIndex >= activeCols.length) return; // the blank invitation row can't be deleted
    const col = activeCols[rowIndex];
    setDraft((prev) => ({
      ...prev,
      columns: prev.columns.filter((c) => c._id !== col._id),
      primaryKey: prev.primaryKey
        ? { ...prev.primaryKey, columns: prev.primaryKey.columns.filter((c) => c !== col.name) }
        : prev.primaryKey,
    }));
  };

  const handleCreate = async () => {
    const driver = getDriver();
    if (!driver || sqlStatements.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      await driver.runQuery(projectId, "BEGIN");
      try {
        for (const stmt of sqlStatements) {
          await driver.runQuery(projectId, stmt);
        }
        await driver.runQuery(projectId, "COMMIT");
      } catch (err) {
        await driver.runQuery(projectId, "ROLLBACK").catch(() => {});
        throw err;
      }
      toast.success(`Table "${tableName.trim()}" created`);
      const tKey = `${projectId}::${schema}`;
      useProjectStore.setState((s) => {
        delete s.tables[tKey];
      });
      void loadTables(projectId, schema);
      closeTabById(tabId);
    } catch (err: any) {
      setError(err?.message ?? "Failed to create table");
    } finally {
      setApplying(false);
    }
  };

  const advancedTabs: { key: AdvancedTab; label: string; count: number }[] = [
    { key: "fkeys", label: "Foreign Keys", count: draft.foreignKeys.length },
    { key: "unique", label: "Unique", count: draft.uniqueConstraints.length },
    { key: "indexes", label: "Indexes", count: draft.indexes.length },
    { key: "triggers", label: "Triggers", count: triggers.length },
  ];

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header — matches the other full-pane panels (roles, enums, etc.), with the table name
          field inline rather than its own bar underneath. */}
      <div className="flex items-center gap-2 border-b px-4 py-2 shrink-0">
        <TableProperties className="h-4 w-4 text-primary shrink-0" />
        <span className="font-mono text-sm font-semibold shrink-0">New Table</span>
        <input
          type="text"
          value={tableName}
          onChange={(e) => setTableName(e.target.value)}
          placeholder="table_name"
          className={cn(
            "h-7 px-2.5 text-sm font-mono bg-background border rounded-md outline-none focus:border-primary/50 w-56",
            validName ? "border-border/30" : "border-destructive/50",
          )}
        />
        <span className="font-mono text-xs text-muted-foreground shrink-0">in {schema}</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-3 text-[11px]"
          onClick={() => closeTabById(tabId)}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-7 px-3 text-[11px]"
          disabled={applying || !canCreate}
          onClick={() => void handleCreate()}
        >
          {applying ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
          Create Table
        </Button>
      </div>

      {/* Column grid — the same results grid used for browsing/editing table data */}
      <div className="flex-[2] min-h-0 flex flex-col border-b">
        <ResultsGrid
          columns={GRID_COLUMNS}
          rows={gridRows}
          isEditing
          columnTypes={COLUMN_TYPES}
          insertRowStart={activeCols.length}
          onCellEdit={handleCellEdit}
          onRowDelete={handleRowDelete}
        />
      </div>

      {/* Advanced: foreign keys / unique / indexes — collapsed by default, rarely needed at creation time */}
      <div className="shrink-0">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-1.5 px-4 py-2 text-[11px] font-medium text-muted-foreground hover:text-foreground w-full transition-colors"
        >
          <ChevronRight
            className={cn("h-3 w-3 transition-transform", advancedOpen && "rotate-90")}
          />
          Advanced (Foreign Keys, Unique, Indexes, Triggers)
        </button>
        {advancedOpen && (
          <div className="px-4 pb-4 max-h-64 overflow-y-auto">
            <div className="flex gap-0.5 bg-background/30 rounded-lg p-0.5 border border-border/20 mb-2 w-fit">
              {advancedTabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setAdvancedTab(t.key)}
                  className={cn(
                    "px-2.5 py-1 text-[10px] font-medium rounded-md transition-all",
                    advancedTab === t.key
                      ? "bg-background text-foreground shadow-sm shadow-black/10"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.label}
                  {t.count > 0 ? ` (${t.count})` : ""}
                </button>
              ))}
            </div>

            {advancedTab === "fkeys" && (
              <FkeysSection
                draft={draft}
                setDraft={setDraft}
                activeColNames={activeColNames}
                tableName={tableName}
                schema={schema}
                availableSchemas={availableSchemas}
                getTablesForSchema={getTablesForSchema}
                loadTables={loadTables}
                projectId={projectId}
                getDriver={getDriver}
              />
            )}
            {advancedTab === "unique" && (
              <UniqueSection
                draft={draft}
                setDraft={setDraft}
                activeColNames={activeColNames}
                tableName={tableName}
              />
            )}
            {advancedTab === "indexes" && (
              <IndexesSection
                draft={draft}
                setDraft={setDraft}
                activeColNames={activeColNames}
                tableName={tableName}
              />
            )}
            {advancedTab === "triggers" && (
              <TriggersSection
                triggers={triggers}
                setTriggers={setTriggers}
                tableName={tableName}
                schema={schema}
                availableFunctions={availableFunctions}
              />
            )}
          </div>
        )}
      </div>

      {/* Footer: validation / SQL preview */}
      <div className="shrink-0 border-t px-4 py-2 flex flex-col gap-2">
        {error && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-xs font-mono">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          {!validName ? (
            <span className="text-[10px] text-destructive">Enter a valid table name</span>
          ) : columnError ? (
            <span className="text-[10px] text-destructive">{columnError}</span>
          ) : (
            triggerError && <span className="text-[10px] text-destructive">{triggerError}</span>
          )}
          <div className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={!canCreate}
            onClick={() => setShowSql((v) => !v)}
          >
            <FileCode className="h-3 w-3 mr-1" />
            {showSql ? "Hide SQL" : "Review SQL"}
          </Button>
        </div>
        {showSql && sqlStatements.length > 0 && (
          <div className="rounded-xl border border-border/40 overflow-hidden bg-[hsl(var(--background))]">
            <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b border-border/30">
              <span className="text-[10px] font-mono text-muted-foreground/60">SQL Preview</span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 text-[10px] px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    openTab(projectId, sqlPreview);
                    closeTabById(tabId);
                  }}
                >
                  <Play className="h-2.5 w-2.5" /> Open in Tab
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 text-[10px] px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => navigator.clipboard.writeText(sqlPreview)}
                >
                  <Copy className="h-2.5 w-2.5" /> Copy
                </Button>
              </div>
            </div>
            <pre className="p-3 text-[11px] font-mono text-foreground/90 overflow-y-auto whitespace-pre-wrap leading-relaxed max-h-[150px] selection:bg-primary/20">
              {sqlPreview}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
