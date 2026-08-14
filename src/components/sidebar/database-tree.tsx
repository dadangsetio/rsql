import {
  Columns3,
  Copy,
  Eye,
  FileCode,
  FileUp,
  FolderOpen,
  HardDrive,
  Key,
  Layers,
  Link2,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  ScrollText,
  Settings2,
  Shield,
  Table,
  Zap,
} from "lucide-react";
import React from "react";
import { CSVImportModal } from "@/components/csv-import-modal";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { DriverFactory } from "@/lib/database-driver";
import { ddlFunctionQuery, ddlTableQuery, ddlViewQuery } from "@/lib/ddl-queries";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { ProjectConnectionStatus } from "@/types";
import { I, SectionHeader, TreeRow } from "./tree-row";

export function DatabaseTree({ projectId }: { projectId: string }) {
  const status = useProjectStore((s) => s.status[projectId]);
  const schemasRaw = useProjectStore((s) => s.schemas[projectId]);
  const schemas = schemasRaw || [];
  // Matches the schema `connect()` already warms and loads tables for, so the
  // tree opens straight to it instead of landing on a collapsed schema list.
  const preferredSchema = schemas.includes("public") ? "public" : schemas[0];
  const tables = useProjectStore((s) => s.tables);
  const columnDetails = useProjectStore((s) => s.columnDetails);
  const indexes = useProjectStore((s) => s.indexes);
  const constraints = useProjectStore((s) => s.constraints);
  const triggers = useProjectStore((s) => s.triggers);
  const rules = useProjectStore((s) => s.rules);
  const policies = useProjectStore((s) => s.policies);
  const views = useProjectStore((s) => s.views);
  const materializedViews = useProjectStore((s) => s.materializedViews);
  const functions = useProjectStore((s) => s.functions);
  const triggerFunctions = useProjectStore((s) => s.triggerFunctions);
  const serverTablespacesRaw = useProjectStore((s) => s.serverTablespaces[projectId]);
  const serverTablespaces = serverTablespacesRaw || [];
  const connect = useProjectStore((s) => s.connect);
  const loadTables = useProjectStore((s) => s.loadTables);
  const loadColumns = useProjectStore((s) => s.loadColumns);
  const loadTableMetadata = useProjectStore((s) => s.loadTableMetadata);
  const loadSchemaObjects = useProjectStore((s) => s.loadSchemaObjects);
  const openTab = useTabStore((s) => s.openTab);
  const openERDTab = useTabStore((s) => s.openERDTab);
  const openRolesTab = useTabStore((s) => s.openRolesTab);
  const openNewTableTab = useTabStore((s) => s.openNewTableTab);
  const openObjectPanelTab = useTabStore((s) => s.openObjectPanelTab);
  const { menu, showMenu, closeMenu } = useContextMenu();

  const [csvImportTarget, setCsvImportTarget] = React.useState<{
    schema: string;
    table: string;
    columns: string[];
  } | null>(null);

  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [loading, setLoading] = React.useState<Record<string, boolean>>({});
  const [selectedItem, setSelectedItem] = React.useState<string | null>(null);
  const toggle = (key: string) => setExpanded((p) => ({ ...p, [key]: !p[key] }));
  const isOpen = (key: string, defaultOpen = false) => expanded[key] ?? defaultOpen;
  const setLoad = (key: string, v: boolean) => setLoading((p) => ({ ...p, [key]: v }));
  const copy = (text: string) => navigator.clipboard.writeText(text);

  const onExpandSchema = async (schema: string) => {
    const key = `schema::${schema}`;
    toggle(key);
    if (!isOpen(key)) {
      const tKey = `${projectId}::${schema}`;
      if (!tables[tKey]) {
        setLoad(key, true);
        try {
          await Promise.all([loadTables(projectId, schema), loadSchemaObjects(projectId, schema)]);
        } catch (e) {
          console.error("Failed to load schema objects:", e);
        } finally {
          setLoad(key, false);
        }
      }
    }
  };

  const onExpandTable = async (schema: string, table: string) => {
    const key = `table::${schema}::${table}`;
    toggle(key);
    const metaKey = `${projectId}::${schema}::${table}`;
    if (!isOpen(key) && !columnDetails[metaKey]) {
      setLoad(key, true);
      try {
        await loadTableMetadata(projectId, schema, table);
      } catch (e) {
        console.error("Failed to load table metadata:", e);
      } finally {
        setLoad(key, false);
      }
    }
  };

  const onNewTable = (schema: string) => openNewTableTab(projectId, schema);
  const onNewView = (schema: string) => openObjectPanelTab(projectId, { kind: "view", schema });
  const onNewMatview = (schema: string) =>
    openObjectPanelTab(projectId, { kind: "matview", schema });
  const onNewFunction = (schema: string) =>
    openObjectPanelTab(projectId, { kind: "function", schema, isProcedure: false });

  type PropertiesObjectType = "table" | "view" | "matview" | "function" | "trigger-function";

  const onOpenTableQuery = (
    schema: string,
    table: string,
    objectType: "table" | "view" | "matview" = "table",
  ) => {
    const sql = `SELECT * FROM "${schema}"."${table}" LIMIT 100;`;
    openTab(projectId, sql, table);
    const tabs = useTabStore.getState().tabs;
    const newTabId = tabs[tabs.length - 1]?.id;
    if (!newTabId) return;
    useTabStore.getState().setPropertiesTarget(newTabId, { objectType, schema, name: table });
    const d = useProjectStore.getState().projects[projectId];
    if (!d) return;
    useTabStore.getState().setExecuting(newTabId, true);
    const driver = DriverFactory.getDriver(d.driver);
    driver
      .runQuery(projectId, sql)
      .then(([cols, rows, time]) => {
        useTabStore.getState().updateResult(newTabId, { columns: cols, rows, time });
      })
      .catch(() => {
        useTabStore.getState().setExecuting(newTabId, false);
      });
  };

  const onOpenDefinitionTab = (
    objectType: "function" | "trigger-function",
    schema: string,
    name: string,
  ) => {
    openTab(projectId, ddlFunctionQuery(schema, name));
    const tabs = useTabStore.getState().tabs;
    const newTabId = tabs[tabs.length - 1]?.id;
    if (newTabId) {
      useTabStore.getState().setPropertiesTarget(newTabId, { objectType, schema, name });
    }
  };

  /** Opens (or focuses) the tab for this schema object and switches it to the inline
   *  Properties view — reusing whichever tab already shows that object's data/definition
   *  instead of spawning a duplicate. */
  const openPropertiesTab = (objectType: PropertiesObjectType, schema: string, name: string) => {
    const existing = useTabStore
      .getState()
      .tabs.find(
        (t) =>
          t.projectId === projectId &&
          t.propertiesTarget?.objectType === objectType &&
          t.propertiesTarget?.schema === schema &&
          t.propertiesTarget?.name === name,
      );
    if (existing) {
      const index = useTabStore.getState().tabs.indexOf(existing);
      useTabStore.getState().selectTab(index);
      useTabStore.getState().setShowProperties(existing.id, true);
      return;
    }

    if (objectType === "table" || objectType === "view" || objectType === "matview") {
      onOpenTableQuery(schema, name, objectType);
    } else {
      onOpenDefinitionTab(objectType, schema, name);
    }

    const tabs = useTabStore.getState().tabs;
    const newTabId = tabs[tabs.length - 1]?.id;
    if (newTabId) useTabStore.getState().setShowProperties(newTabId, true);
  };

  const isConnected = status === ProjectConnectionStatus.Connected;
  const tspKey = "tablespaces";

  return (
    <div className="p-1">
      {status === ProjectConnectionStatus.Connecting && (
        <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Connecting…
        </div>
      )}
      {status === ProjectConnectionStatus.Failed && (
        <div className="px-3 py-2 text-xs text-destructive">Connection failed.</div>
      )}

      <TreeRow
        indent={I.cat}
        icon={<Shield className="h-3.5 w-3.5 text-muted-foreground" />}
        label="Login/Group Roles"
        onClick={() => {
          if (isConnected) openRolesTab(projectId);
          else
            void connect(projectId).then(() => {
              if (
                useProjectStore.getState().status[projectId] === ProjectConnectionStatus.Connected
              )
                openRolesTab(projectId);
            });
        }}
      />

      <TreeRow
        indent={I.cat}
        icon={<HardDrive className="h-3.5 w-3.5 text-muted-foreground" />}
        label={`Tablespaces${serverTablespaces.length > 0 ? ` (${serverTablespaces.length})` : ""}`}
        expanded={isOpen(tspKey)}
        onClick={() => {
          if (isConnected) toggle(tspKey);
          else void connect(projectId);
        }}
      />
      {isOpen(tspKey) &&
        serverTablespaces.map(([name, owner, location]) => (
          <div
            key={name}
            className="relative flex items-center gap-1.5 py-0.5 hover:bg-sidebar-accent rounded-sm whitespace-nowrap"
            style={{ paddingLeft: `${I.db}px` }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              showMenu(e, [
                {
                  label: "Copy Name",
                  icon: <Copy className="h-3 w-3" />,
                  onClick: () => copy(name),
                },
              ]);
            }}
          >
            <HardDrive className="h-3 w-3 shrink-0 text-muted-foreground/50" />
            <span className="font-mono text-[11px] text-foreground">{name}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{owner}</span>
            {location && (
              <span className="font-mono text-[9px] text-muted-foreground/40">{location}</span>
            )}
          </div>
        ))}

      {isConnected &&
        schemas.map((schema) => {
          const sKey = `schema::${schema}`;
          const schemaStoreKey = `${projectId}::${schema}`;
          const schemaTables = tables[schemaStoreKey];
          const schemaViews = views[schemaStoreKey];
          const schemaMatViews = materializedViews[schemaStoreKey];
          const schemaFns = functions[schemaStoreKey];
          const schemaTrigFns = triggerFunctions[schemaStoreKey];
          const isSchemaOpen = isOpen(sKey, schema === preferredSchema);

          return (
            <div key={schema}>
              <TreeRow
                indent={I.schema}
                icon={<FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />}
                label={schema}
                expanded={isSchemaOpen}
                loading={loading[sKey]}
                onClick={() => void onExpandSchema(schema)}
                onContextMenu={(e) =>
                  showMenu(e, [
                    {
                      label: "ERD Diagram",
                      icon: <Layers className="h-3 w-3" />,
                      onClick: () => openERDTab(projectId, schema),
                    },
                    {
                      label: "Copy Schema Name",
                      icon: <Copy className="h-3 w-3" />,
                      onClick: () => copy(schema),
                    },
                    { separator: true as const },
                    {
                      label: "New Table",
                      icon: <Plus className="h-3 w-3" />,
                      onClick: () => onNewTable(schema),
                    },
                    {
                      label: "New View",
                      icon: <Plus className="h-3 w-3" />,
                      onClick: () => onNewView(schema),
                    },
                    {
                      label: "New Materialized View",
                      icon: <Plus className="h-3 w-3" />,
                      onClick: () => onNewMatview(schema),
                    },
                    {
                      label: "New Function or Procedure",
                      icon: <Plus className="h-3 w-3" />,
                      onClick: () => onNewFunction(schema),
                    },
                    {
                      label: "New Query",
                      icon: <Plus className="h-3 w-3" />,
                      onClick: () => openTab(projectId, `-- Schema: ${schema}\n`),
                    },
                  ])
                }
              />

              {isSchemaOpen && (
                <>
                  <SectionHeader
                    indent={I.schemaObj}
                    label={`Tables${schemaTables ? ` (${schemaTables.length})` : ""}`}
                    icon={<Table className="h-3 w-3" />}
                    sectionKey={`${sKey}::tables`}
                    expanded={isOpen(`${sKey}::tables`, true)}
                    onClick={() => toggle(`${sKey}::tables`)}
                  />
                  {isOpen(`${sKey}::tables`, true) &&
                    schemaTables?.map((ti) => {
                      const tKey = `table::${schema}::${ti.name}`;
                      const metaKey = `${projectId}::${schema}::${ti.name}`;
                      const isTableOpen = isOpen(tKey);
                      const cols = columnDetails[metaKey];
                      const idxs = indexes[metaKey];
                      const cons = constraints[metaKey];
                      const trigs = triggers[metaKey];
                      const rls = rules[metaKey];
                      const pols = policies[metaKey];
                      const pkCols = new Set(
                        (idxs ?? []).filter((i) => i.isPrimary).map((i) => i.columnName),
                      );

                      return (
                        <div key={ti.name}>
                          <TreeRow
                            indent={I.table}
                            icon={<Table className="h-3.5 w-3.5 text-muted-foreground" />}
                            label={ti.name}
                            expanded={isTableOpen}
                            loading={loading[tKey]}
                            selected={selectedItem === tKey}
                            onClick={() => {
                              setSelectedItem(tKey);
                              onOpenTableQuery(schema, ti.name);
                            }}
                            onChevronClick={() => {
                              setSelectedItem(tKey);
                              void onExpandTable(schema, ti.name);
                            }}
                            onContextMenu={(e) => {
                              setSelectedItem(tKey);
                              showMenu(e, [
                                { header: "Query" },
                                {
                                  label: "SELECT TOP 100",
                                  icon: <Table className="h-3 w-3" />,
                                  onClick: () => onOpenTableQuery(schema, ti.name),
                                },
                                {
                                  label: "SELECT COUNT(*)",
                                  icon: <Table className="h-3 w-3" />,
                                  onClick: () =>
                                    openTab(
                                      projectId,
                                      `SELECT COUNT(*) FROM "${schema}"."${ti.name}";`,
                                    ),
                                },
                                { separator: true as const },
                                {
                                  label: "New Table",
                                  icon: <Plus className="h-3 w-3" />,
                                  onClick: () => onNewTable(schema),
                                },
                                { separator: true as const },
                                {
                                  label: "Import CSV",
                                  icon: <FileUp className="h-3 w-3" />,
                                  onClick: () => {
                                    void loadColumns(projectId, schema, ti.name).then((cols) => {
                                      setCsvImportTarget({ schema, table: ti.name, columns: cols });
                                    });
                                  },
                                },
                                { separator: true as const },
                                {
                                  label: "Properties",
                                  icon: <Settings2 className="h-3 w-3" />,
                                  onClick: () => openPropertiesTab("table", schema, ti.name),
                                },
                                {
                                  label: "Show CREATE TABLE",
                                  icon: <FileCode className="h-3 w-3" />,
                                  onClick: () => openTab(projectId, ddlTableQuery(schema, ti.name)),
                                },
                                { separator: true as const },
                                {
                                  label: "Copy Name",
                                  icon: <Copy className="h-3 w-3" />,
                                  onClick: () => copy(`"${schema}"."${ti.name}"`),
                                  shortcut: navigator.platform.includes("Mac") ? "⌘C" : "Ctrl+C",
                                },
                              ]);
                            }}
                            trailing={
                              <span className="rounded-full bg-accent/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground shrink-0">
                                {ti.size}
                              </span>
                            }
                          />
                          {isTableOpen && cols && (
                            <>
                              <SectionHeader
                                indent={I.section}
                                label={`Columns (${cols.length})`}
                                icon={<Columns3 className="h-3 w-3" />}
                                sectionKey={`${tKey}::cols`}
                                expanded={isOpen(`${tKey}::cols`, true)}
                                onClick={() => toggle(`${tKey}::cols`)}
                              />
                              {isOpen(`${tKey}::cols`, true) &&
                                cols.map((c) => (
                                  <div
                                    key={c.name}
                                    className="relative flex items-center gap-1.5 py-0.5 hover:bg-sidebar-accent rounded-sm whitespace-nowrap"
                                    style={{ paddingLeft: `${I.item}px` }}
                                    onContextMenu={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      showMenu(e, [
                                        {
                                          label: "Copy Column Name",
                                          icon: <Copy className="h-3 w-3" />,
                                          onClick: () => copy(c.name),
                                        },
                                      ]);
                                    }}
                                  >
                                    {pkCols.has(c.name) ? (
                                      <Key className="h-3 w-3 shrink-0 text-warning" />
                                    ) : (
                                      <Columns3 className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                                    )}
                                    <span className="font-mono text-[11px] text-foreground">
                                      {c.name}
                                    </span>
                                    <span className="font-mono text-[10px] text-muted-foreground">
                                      {c.dataType}
                                    </span>
                                    {c.nullable && (
                                      <span className="font-mono text-[9px] text-muted-foreground/40">
                                        NULL
                                      </span>
                                    )}
                                  </div>
                                ))}

                              {idxs && idxs.length > 0 && (
                                <>
                                  <SectionHeader
                                    indent={I.section}
                                    label={`Indexes (${new Set(idxs.map((i) => i.indexName)).size})`}
                                    icon={<Key className="h-3 w-3" />}
                                    sectionKey={`${tKey}::idx`}
                                    expanded={isOpen(`${tKey}::idx`)}
                                    onClick={() => toggle(`${tKey}::idx`)}
                                  />
                                  {isOpen(`${tKey}::idx`) &&
                                    Array.from(new Set(idxs.map((i) => i.indexName))).map(
                                      (name) => {
                                        const idxEntries = idxs.filter((i) => i.indexName === name);
                                        const f = idxEntries[0];
                                        return (
                                          <div
                                            key={name}
                                            className="relative flex items-center gap-1.5 py-0.5 hover:bg-sidebar-accent rounded-sm whitespace-nowrap"
                                            style={{ paddingLeft: `${I.item}px` }}
                                          >
                                            {f.isPrimary ? (
                                              <Key className="h-3 w-3 shrink-0 text-warning" />
                                            ) : f.isUnique ? (
                                              <Shield className="h-3 w-3 shrink-0 text-blue-500" />
                                            ) : (
                                              <Key className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                                            )}
                                            <span className="font-mono text-[11px] text-foreground">
                                              {name}
                                            </span>
                                            <span className="font-mono text-[10px] text-muted-foreground">
                                              ({idxEntries.map((e) => e.columnName).join(", ")})
                                            </span>
                                            {f.isUnique && (
                                              <span className="font-mono text-[9px] text-blue-500/60">
                                                UNIQUE
                                              </span>
                                            )}
                                          </div>
                                        );
                                      },
                                    )}
                                </>
                              )}

                              {cons && cons.length > 0 && (
                                <>
                                  <SectionHeader
                                    indent={I.section}
                                    label={`Constraints (${new Set(cons.map((c) => c.constraintName)).size})`}
                                    icon={<Link2 className="h-3 w-3" />}
                                    sectionKey={`${tKey}::con`}
                                    expanded={isOpen(`${tKey}::con`)}
                                    onClick={() => toggle(`${tKey}::con`)}
                                  />
                                  {isOpen(`${tKey}::con`) &&
                                    Array.from(new Set(cons.map((c) => c.constraintName))).map(
                                      (name) => {
                                        const f = cons.find((c) => c.constraintName === name)!;
                                        return (
                                          <div
                                            key={name}
                                            className="relative flex items-center gap-1.5 py-0.5 hover:bg-sidebar-accent rounded-sm whitespace-nowrap"
                                            style={{ paddingLeft: `${I.item}px` }}
                                          >
                                            <Link2 className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                                            <span className="font-mono text-[11px] text-foreground">
                                              {name}
                                            </span>
                                            <span className="font-mono text-[10px] text-muted-foreground">
                                              {f.constraintType}
                                            </span>
                                          </div>
                                        );
                                      },
                                    )}
                                </>
                              )}

                              {trigs && trigs.length > 0 && (
                                <>
                                  <SectionHeader
                                    indent={I.section}
                                    label={`Triggers (${trigs.length})`}
                                    icon={<Zap className="h-3 w-3" />}
                                    sectionKey={`${tKey}::trig`}
                                    expanded={isOpen(`${tKey}::trig`)}
                                    onClick={() => toggle(`${tKey}::trig`)}
                                  />
                                  {isOpen(`${tKey}::trig`) &&
                                    trigs.map((t) => (
                                      <div
                                        key={`${t.triggerName}-${t.event}`}
                                        className="relative flex items-center gap-1.5 py-0.5 hover:bg-sidebar-accent rounded-sm whitespace-nowrap"
                                        style={{ paddingLeft: `${I.item}px` }}
                                      >
                                        <Zap className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                                        <span className="font-mono text-[11px] text-foreground">
                                          {t.triggerName}
                                        </span>
                                        <span className="font-mono text-[10px] text-muted-foreground">
                                          {t.timing} {t.event}
                                        </span>
                                      </div>
                                    ))}
                                </>
                              )}

                              {rls && rls.length > 0 && (
                                <>
                                  <SectionHeader
                                    indent={I.section}
                                    label={`Rules (${rls.length})`}
                                    icon={<ScrollText className="h-3 w-3" />}
                                    sectionKey={`${tKey}::rules`}
                                    expanded={isOpen(`${tKey}::rules`)}
                                    onClick={() => toggle(`${tKey}::rules`)}
                                  />
                                  {isOpen(`${tKey}::rules`) &&
                                    rls.map((r) => (
                                      <div
                                        key={r.ruleName}
                                        className="relative flex items-center gap-1.5 py-0.5 hover:bg-sidebar-accent rounded-sm whitespace-nowrap"
                                        style={{ paddingLeft: `${I.item}px` }}
                                      >
                                        <ScrollText className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                                        <span className="font-mono text-[11px] text-foreground">
                                          {r.ruleName}
                                        </span>
                                        <span className="font-mono text-[10px] text-muted-foreground">
                                          {r.event}
                                        </span>
                                      </div>
                                    ))}
                                </>
                              )}

                              {pols && pols.length > 0 && (
                                <>
                                  <SectionHeader
                                    indent={I.section}
                                    label={`RLS Policies (${pols.length})`}
                                    icon={<Lock className="h-3 w-3" />}
                                    sectionKey={`${tKey}::pol`}
                                    expanded={isOpen(`${tKey}::pol`)}
                                    onClick={() => toggle(`${tKey}::pol`)}
                                  />
                                  {isOpen(`${tKey}::pol`) &&
                                    pols.map((p) => (
                                      <div
                                        key={p.policyName}
                                        className="relative flex items-center gap-1.5 py-0.5 hover:bg-sidebar-accent rounded-sm whitespace-nowrap"
                                        style={{ paddingLeft: `${I.item}px` }}
                                      >
                                        <Lock className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                                        <span className="font-mono text-[11px] text-foreground">
                                          {p.policyName}
                                        </span>
                                        <span className="font-mono text-[10px] text-muted-foreground">
                                          {p.permissive} {p.command}
                                        </span>
                                      </div>
                                    ))}
                                </>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}

                  {schemaViews && schemaViews.length > 0 && (
                    <>
                      <SectionHeader
                        indent={I.schemaObj}
                        label={`Views (${schemaViews.length})`}
                        icon={<Eye className="h-3 w-3" />}
                        sectionKey={`${sKey}::views`}
                        expanded={isOpen(`${sKey}::views`)}
                        onClick={() => toggle(`${sKey}::views`)}
                      />
                      {isOpen(`${sKey}::views`) &&
                        schemaViews.map((v) => {
                          const vKey = `view::${schema}::${v}`;
                          return (
                            <TreeRow
                              key={v}
                              indent={I.table}
                              icon={<Eye className="h-3.5 w-3.5 text-muted-foreground" />}
                              label={v}
                              selected={selectedItem === vKey}
                              onClick={() => {
                                setSelectedItem(vKey);
                                onOpenTableQuery(schema, v, "view");
                              }}
                              onContextMenu={(e) => {
                                setSelectedItem(vKey);
                                showMenu(e, [
                                  {
                                    label: "SELECT TOP 100",
                                    icon: <Eye className="h-3 w-3" />,
                                    onClick: () => onOpenTableQuery(schema, v, "view"),
                                  },
                                  { separator: true as const },
                                  {
                                    label: "Edit",
                                    icon: <Pencil className="h-3 w-3" />,
                                    onClick: () =>
                                      openObjectPanelTab(projectId, {
                                        kind: "view",
                                        schema,
                                        name: v,
                                      }),
                                  },
                                  {
                                    label: "Properties",
                                    icon: <Settings2 className="h-3 w-3" />,
                                    onClick: () => openPropertiesTab("view", schema, v),
                                  },
                                  {
                                    label: "Show CREATE VIEW",
                                    icon: <FileCode className="h-3 w-3" />,
                                    onClick: () => openTab(projectId, ddlViewQuery(schema, v)),
                                  },
                                  { separator: true as const },
                                  {
                                    label: "Copy Name",
                                    icon: <Copy className="h-3 w-3" />,
                                    onClick: () => copy(`"${schema}"."${v}"`),
                                  },
                                ]);
                              }}
                            />
                          );
                        })}
                    </>
                  )}

                  {schemaMatViews && schemaMatViews.length > 0 && (
                    <>
                      <SectionHeader
                        indent={I.schemaObj}
                        label={`Materialized Views (${schemaMatViews.length})`}
                        icon={<Layers className="h-3 w-3" />}
                        sectionKey={`${sKey}::matviews`}
                        expanded={isOpen(`${sKey}::matviews`)}
                        onClick={() => toggle(`${sKey}::matviews`)}
                      />
                      {isOpen(`${sKey}::matviews`) &&
                        schemaMatViews.map((mv) => {
                          const mvKey = `matview::${schema}::${mv}`;
                          return (
                            <TreeRow
                              key={mv}
                              indent={I.table}
                              icon={<Layers className="h-3.5 w-3.5 text-muted-foreground" />}
                              label={mv}
                              selected={selectedItem === mvKey}
                              onClick={() => {
                                setSelectedItem(mvKey);
                                onOpenTableQuery(schema, mv, "matview");
                              }}
                              onContextMenu={(e) => {
                                setSelectedItem(mvKey);
                                showMenu(e, [
                                  {
                                    label: "SELECT TOP 100",
                                    icon: <Layers className="h-3 w-3" />,
                                    onClick: () => onOpenTableQuery(schema, mv, "matview"),
                                  },
                                  {
                                    label: "REFRESH",
                                    icon: <RefreshCw className="h-3 w-3" />,
                                    onClick: () =>
                                      openTab(
                                        projectId,
                                        `REFRESH MATERIALIZED VIEW "${schema}"."${mv}";`,
                                      ),
                                  },
                                  { separator: true as const },
                                  {
                                    label: "Edit",
                                    icon: <Pencil className="h-3 w-3" />,
                                    onClick: () =>
                                      openObjectPanelTab(projectId, {
                                        kind: "matview",
                                        schema,
                                        name: mv,
                                      }),
                                  },
                                  {
                                    label: "Properties",
                                    icon: <Settings2 className="h-3 w-3" />,
                                    onClick: () => openPropertiesTab("matview", schema, mv),
                                  },
                                  { separator: true as const },
                                  {
                                    label: "Copy Name",
                                    icon: <Copy className="h-3 w-3" />,
                                    onClick: () => copy(`"${schema}"."${mv}"`),
                                  },
                                ]);
                              }}
                            />
                          );
                        })}
                    </>
                  )}

                  {schemaFns && schemaFns.length > 0 && (
                    <>
                      <SectionHeader
                        indent={I.schemaObj}
                        label={`Functions (${schemaFns.length})`}
                        icon={<FileCode className="h-3 w-3" />}
                        sectionKey={`${sKey}::fns`}
                        expanded={isOpen(`${sKey}::fns`)}
                        onClick={() => toggle(`${sKey}::fns`)}
                      />
                      {isOpen(`${sKey}::fns`) &&
                        schemaFns.map((fn) => {
                          // name + arguments, not array index: Postgres allows overloading
                          // (same name, different signature), and an index-based key remounts
                          // every row whenever the list order changes on refresh.
                          const fnKey = `fn::${schema}::${fn.name}::${fn.arguments}`;
                          return (
                            <div
                              key={fnKey}
                              className={
                                selectedItem === fnKey
                                  ? "relative flex items-center gap-1.5 py-0.5 rounded-sm whitespace-nowrap select-none bg-primary/10"
                                  : "relative flex items-center gap-1.5 py-0.5 rounded-sm whitespace-nowrap select-none hover:bg-sidebar-accent"
                              }
                              style={{ paddingLeft: `${I.table}px` }}
                              onClick={() => setSelectedItem(fnKey)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setSelectedItem(fnKey);
                                showMenu(e, [
                                  {
                                    label: "Show Definition",
                                    icon: <FileCode className="h-3 w-3" />,
                                    onClick: () => onOpenDefinitionTab("function", schema, fn.name),
                                  },
                                  {
                                    label: "Edit",
                                    icon: <Pencil className="h-3 w-3" />,
                                    onClick: () =>
                                      openObjectPanelTab(projectId, {
                                        kind: "function",
                                        schema,
                                        name: fn.name,
                                        isProcedure: false,
                                      }),
                                  },
                                  {
                                    label: "Properties",
                                    icon: <Settings2 className="h-3 w-3" />,
                                    onClick: () => openPropertiesTab("function", schema, fn.name),
                                  },
                                  { separator: true as const },
                                  {
                                    label: "Copy Name",
                                    icon: <Copy className="h-3 w-3" />,
                                    onClick: () => copy(fn.name),
                                  },
                                ]);
                              }}
                            >
                              <FileCode className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                              <span className="font-mono text-[11px] text-foreground">
                                {fn.name}({fn.arguments ? "..." : ""})
                              </span>
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {fn.returnType}
                              </span>
                            </div>
                          );
                        })}
                    </>
                  )}

                  {schemaTrigFns && schemaTrigFns.length > 0 && (
                    <>
                      <SectionHeader
                        indent={I.schemaObj}
                        label={`Trigger Functions (${schemaTrigFns.length})`}
                        icon={<Zap className="h-3 w-3" />}
                        sectionKey={`${sKey}::trigfns`}
                        expanded={isOpen(`${sKey}::trigfns`)}
                        onClick={() => toggle(`${sKey}::trigfns`)}
                      />
                      {isOpen(`${sKey}::trigfns`) &&
                        schemaTrigFns.map((fn) => {
                          const tfKey = `trigfn::${schema}::${fn.name}::${fn.arguments}`;
                          return (
                            <div
                              key={tfKey}
                              className={
                                selectedItem === tfKey
                                  ? "relative flex items-center gap-1.5 py-0.5 rounded-sm whitespace-nowrap select-none bg-primary/10"
                                  : "relative flex items-center gap-1.5 py-0.5 rounded-sm whitespace-nowrap select-none hover:bg-sidebar-accent"
                              }
                              style={{ paddingLeft: `${I.table}px` }}
                              onClick={() => setSelectedItem(tfKey)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setSelectedItem(tfKey);
                                showMenu(e, [
                                  {
                                    label: "Show Definition",
                                    icon: <FileCode className="h-3 w-3" />,
                                    onClick: () =>
                                      onOpenDefinitionTab("trigger-function", schema, fn.name),
                                  },
                                  {
                                    label: "Properties",
                                    icon: <Settings2 className="h-3 w-3" />,
                                    onClick: () =>
                                      openPropertiesTab("trigger-function", schema, fn.name),
                                  },
                                  { separator: true as const },
                                  {
                                    label: "Copy Name",
                                    icon: <Copy className="h-3 w-3" />,
                                    onClick: () => copy(fn.name),
                                  },
                                ]);
                              }}
                            >
                              <Zap className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                              <span className="font-mono text-[11px] text-foreground">
                                {fn.name}()
                              </span>
                              <span className="font-mono text-[10px] text-muted-foreground">
                                trigger
                              </span>
                            </div>
                          );
                        })}
                    </>
                  )}
                </>
              )}
            </div>
          );
        })}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
      {csvImportTarget && (
        <CSVImportModal
          open={!!csvImportTarget}
          onOpenChange={(open) => {
            if (!open) setCsvImportTarget(null);
          }}
          projectId={projectId}
          schema={csvImportTarget.schema}
          table={csvImportTarget.table}
          tableColumns={csvImportTarget.columns}
        />
      )}
    </div>
  );
}
