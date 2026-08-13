import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster } from "sonner";
import { CommandPalette } from "@/components/command-palette";
import { ConnectionModal } from "@/components/connection-modal";
import { CreateFunctionPanel } from "@/components/create-function-panel";
import { CreateTablePanel } from "@/components/create-table-panel";
import { CreateViewPanel } from "@/components/create-view-panel";
import { EditorToolbar } from "@/components/editor-toolbar";
import { EnumsPanel } from "@/components/enums-panel";
import { ERDDiagram } from "@/components/erd-diagram";
import { ExtensionsPanel } from "@/components/extensions-panel";
import { NotifyPanel } from "@/components/notify-panel";
import { ObjectPropertiesPanel } from "@/components/object-properties-modal";
import { PerformanceMonitor } from "@/components/performance-monitor";
import { PgSettingsPanel } from "@/components/pg-settings-panel";
import type { QueryEditorHandle } from "@/components/query-editor";
import { QueryEditor } from "@/components/query-editor";
import { ResizeHandle } from "@/components/resize-handle";
import { ResultsGrid } from "@/components/results-grid";
import { ResultsPanel } from "@/components/results-panel";
import { RolesPanel } from "@/components/roles-panel";
import { SchemaDiffPanel } from "@/components/schema-diff-panel";
import { ServerSidebar } from "@/components/server-sidebar";
import { StatusBar } from "@/components/status-bar";
import { TabBar } from "@/components/tab-bar";
import { TerminalPanel } from "@/components/terminal-panel";
import { TopBar } from "@/components/top-bar";
import { useAppStartup } from "@/hooks/use-app-startup";
import { useQueryLifecycle } from "@/hooks/use-query-lifecycle";
import { serverFingerprint } from "@/lib/server-groups";
import { checkForUpdates } from "@/lib/updater";
import { useProjectStore } from "@/stores/project-store";
import { useActiveTab, useActiveTabId, useTabStore } from "@/stores/tab-store";
import { useUIStore } from "@/stores/ui-store";
import type { ProjectDetails } from "@/types";
import "@/monaco/setup";

export default function App() {
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const editorHeightVertical = useUIStore((s) => s.editorHeightVertical);
  const editorHeightHorizontal = useUIStore((s) => s.editorHeightHorizontal);
  const connectionModalOpen = useUIStore((s) => s.connectionModalOpen);
  const setConnectionModalOpen = useUIStore((s) => s.setConnectionModalOpen);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const setEditorHeight = useUIStore((s) => s.setEditorHeight);
  const editorCollapsed = useUIStore((s) => s.editorCollapsed);
  const editorPosition = useUIStore((s) => s.editorPosition);
  const layoutDirection =
    editorPosition === "left" || editorPosition === "right" ? "horizontal" : "vertical";
  const panelSwapped = editorPosition === "left" || editorPosition === "top";
  const editorHeight =
    layoutDirection === "horizontal" ? editorHeightHorizontal : editorHeightVertical;

  const projects = useProjectStore((s) => s.projects);
  const saveConnection = useProjectStore((s) => s.saveConnection);
  const updateConnection = useProjectStore((s) => s.updateConnection);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const activeTabId = useActiveTabId();
  const activeTab = useActiveTab();
  const updateContent = useTabStore((s) => s.updateContent);

  // Sidebar connection follows whichever tab is active (or just opened).
  const activeTabProjectId = activeTab?.projectId;
  useEffect(() => {
    if (!activeTabProjectId) return;
    if (useUIStore.getState().activeDatabaseTab === activeTabProjectId) return;
    useUIStore.getState().openDatabaseTab(activeTabProjectId);
  }, [activeTabProjectId]);

  const [editingConnection, setEditingConnection] = useState<{
    name: string;
    details: ProjectDetails;
  } | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const editorRef = useRef<QueryEditorHandle>(null);

  useAppStartup();
  const { runQuery, runExplain, cancelQuery, runSplitQuery } = useQueryLifecycle({
    setCommandPaletteOpen,
  });
  const executeCurrent = useCallback(
    () => void runQuery(editorRef.current?.getQueriesToRun()),
    [runQuery],
  );

  const handleSaveConnection = useCallback(
    async (connection: {
      name: string;
      driver: string;
      username: string;
      password: string;
      database: string;
      host: string;
      port: string;
      ssl: boolean;
      sshEnabled?: boolean;
      sshHost?: string;
      sshPort?: string;
      sshUser?: string;
      sshPassword?: string;
      sshKeyPath?: string;
    }) => {
      const details = {
        driver: connection.driver as "PGSQL",
        username: connection.username,
        password: connection.password,
        database: connection.database,
        host: connection.host,
        port: connection.port,
        ssl: connection.ssl ? "true" : "false",
        sshEnabled: connection.sshEnabled ? "true" : "false",
        sshHost: connection.sshHost ?? "",
        sshPort: connection.sshPort ?? "22",
        sshUser: connection.sshUser ?? "",
        sshPassword: connection.sshPassword ?? "",
        sshKeyPath: connection.sshKeyPath ?? "",
      };
      if (editingConnection) {
        await updateConnection(connection.name, details);
        if (connection.name !== editingConnection.name) {
          useUIStore.getState().renameOpenDatabaseTab(editingConnection.name, connection.name);
          await deleteProject(editingConnection.name);
        }
        setEditingConnection(null);
      } else {
        await saveConnection(connection.name, details);
        const ui = useUIStore.getState();
        ui.setConnectionModalOpen(false);
        ui.setConnectionPickerOpen(false);
        ui.setDatabasePickerOpen(false);
        ui.setActiveServerFp(serverFingerprint(details));
        ui.openDatabaseTab(connection.name);
      }
    },
    [saveConnection, updateConnection, deleteProject, editingConnection],
  );

  const handleEditConnection = useCallback(
    (projectId: string) => {
      const details = projects[projectId];
      if (details) {
        setEditingConnection({ name: projectId, details });
        setConnectionModalOpen(true);
      }
    },
    [projects, setConnectionModalOpen],
  );

  const handleModalClose = useCallback(
    (open: boolean) => {
      if (!open) setEditingConnection(null);
      setConnectionModalOpen(open);
    },
    [setConnectionModalOpen],
  );

  return (
    <div
      className="flex h-screen flex-col bg-background text-foreground"
      onContextMenu={(e) => e.preventDefault()}
    >
      <TopBar
        onCheckUpdates={() => void checkForUpdates()}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        onEditConnection={handleEditConnection}
      />

      <div className="flex flex-1 overflow-hidden">
        <div
          style={{ width: `${sidebarWidth}px`, minWidth: "180px" }}
          className="flex-shrink-0 overflow-hidden"
        >
          <ServerSidebar onEditConnection={handleEditConnection} />
        </div>
        <ResizeHandle direction="horizontal" onResize={setSidebarWidth} />

        <div className="flex flex-1 flex-col overflow-hidden">
          <TabBar />
          {!activeTab ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-4">
                <div className="text-muted-foreground/40 text-6xl font-mono font-bold select-none">
                  RSQL
                </div>
                <p className="text-muted-foreground/60 text-sm">No tabs open</p>
                <button
                  type="button"
                  onClick={() => useTabStore.getState().openTab()}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors text-sm font-medium"
                >
                  <span className="text-lg leading-none">+</span> New Query
                </button>
              </div>
            </div>
          ) : activeTab?.type === "monitor" && activeTab.projectId ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <PerformanceMonitor projectId={activeTab.projectId} />
            </div>
          ) : activeTab?.type === "erd" && activeTab.projectId && activeTab.schema ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <ERDDiagram projectId={activeTab.projectId} schema={activeTab.schema} />
            </div>
          ) : activeTab?.type === "query" && activeTab.newTableSchema && activeTab.projectId ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <CreateTablePanel
                projectId={activeTab.projectId}
                schema={activeTab.newTableSchema}
                tabId={activeTab.id}
              />
            </div>
          ) : activeTab?.type === "query" &&
            activeTab.objectPanel &&
            activeTab.projectId &&
            (activeTab.objectPanel.kind === "view" || activeTab.objectPanel.kind === "matview") ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <CreateViewPanel
                projectId={activeTab.projectId}
                schema={activeTab.objectPanel.schema}
                tabId={activeTab.id}
                isMaterialized={activeTab.objectPanel.kind === "matview"}
                editName={activeTab.objectPanel.name}
              />
            </div>
          ) : activeTab?.type === "query" &&
            activeTab.objectPanel &&
            activeTab.projectId &&
            activeTab.objectPanel.kind === "function" ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <CreateFunctionPanel
                projectId={activeTab.projectId}
                schema={activeTab.objectPanel.schema}
                tabId={activeTab.id}
                initialIsProcedure={!!activeTab.objectPanel.isProcedure}
                editName={activeTab.objectPanel.name}
              />
            </div>
          ) : activeTab?.type === "terminal" ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <TerminalPanel terminalId={activeTab.id} />
            </div>
          ) : activeTab?.type === "notify" && activeTab.projectId ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <NotifyPanel projectId={activeTab.projectId} />
            </div>
          ) : activeTab?.type === "roles" && activeTab.projectId ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <RolesPanel projectId={activeTab.projectId} />
            </div>
          ) : activeTab?.type === "schema-diff" && activeTab.projectId ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <SchemaDiffPanel projectId={activeTab.projectId} />
            </div>
          ) : activeTab?.type === "extensions" && activeTab.projectId ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <ExtensionsPanel projectId={activeTab.projectId} />
            </div>
          ) : activeTab?.type === "enums" && activeTab.projectId ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <EnumsPanel projectId={activeTab.projectId} />
            </div>
          ) : activeTab?.type === "pg-settings" && activeTab.projectId ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <PgSettingsPanel projectId={activeTab.projectId} />
            </div>
          ) : activeTab?.type === "query" &&
            activeTab.showProperties &&
            activeTab.propertiesTarget &&
            activeTab.projectId ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <ObjectPropertiesPanel
                projectId={activeTab.projectId}
                schema={activeTab.propertiesTarget.schema}
                name={activeTab.propertiesTarget.name}
                objectType={activeTab.propertiesTarget.objectType}
                onClose={() => useTabStore.getState().setShowProperties(activeTab.id, false)}
              />
            </div>
          ) : activeTab?.isSplit ? (
            <>
              <EditorToolbar
                onExecute={executeCurrent}
                onExplain={() => void runExplain()}
                onCancel={() => void cancelQuery()}
              />
              <div className="flex flex-1 min-h-0 overflow-hidden">
                {/* Left pane */}
                <div className="flex flex-1 flex-col overflow-hidden border-r border-border/30">
                  <div
                    style={{ height: `${editorHeight}%` }}
                    className="flex flex-col overflow-hidden"
                  >
                    <QueryEditor
                      ref={editorRef}
                      value={activeTab.editorValue}
                      onChange={(v) => activeTabId && updateContent(activeTabId, v)}
                      onExecute={(blocks) => void runQuery(blocks)}
                      onExplain={() => void runExplain()}
                    />
                  </div>
                  <ResizeHandle direction="vertical" onResize={setEditorHeight} />
                  <div className="flex-1 min-h-0">
                    <ResultsPanel />
                  </div>
                </div>
                {/* Right pane */}
                <div className="flex flex-1 flex-col overflow-hidden">
                  <div
                    style={{ height: `${editorHeight}%` }}
                    className="flex flex-col overflow-hidden"
                  >
                    <QueryEditor
                      value={activeTab.splitEditorValue ?? ""}
                      onChange={(v) =>
                        activeTabId && useTabStore.getState().updateSplitContent(activeTabId, v)
                      }
                      onExecute={() => void runSplitQuery()}
                    />
                  </div>
                  <ResizeHandle direction="vertical" onResize={setEditorHeight} />
                  <div className="flex-1 min-h-0 flex flex-col">
                    {activeTab.isSplitExecuting ? (
                      <div className="flex-1 flex items-center justify-center text-muted-foreground">
                        <span className="animate-spin mr-2">⏳</span> Running...
                      </div>
                    ) : activeTab.splitResult ? (
                      <div className="flex-1 flex flex-col overflow-hidden">
                        <div className="flex items-center gap-2 px-3 py-1 border-b border-border/30 text-xs font-mono text-muted-foreground">
                          <span>{activeTab.splitResult.rows.length} rows</span>
                          {activeTab.splitResult.time > 0 && (
                            <span>· {activeTab.splitResult.time.toFixed(1)}ms</span>
                          )}
                        </div>
                        <div className="flex-1 min-h-0">
                          <ResultsGrid
                            columns={activeTab.splitResult.columns}
                            rows={activeTab.splitResult.rows}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="flex-1 flex items-center justify-center text-muted-foreground/40 text-sm font-mono">
                        Run a query to see results
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div
              className={`flex flex-1 min-h-0 overflow-hidden ${layoutDirection === "horizontal" ? "flex-row" : "flex-col"}`}
            >
              {(() => {
                const resultsSize = `${100 - editorHeight}%`;
                const resultsStyle = editorCollapsed
                  ? undefined
                  : layoutDirection === "horizontal"
                    ? { width: resultsSize }
                    : { height: resultsSize };
                const resultsPane = (
                  <div
                    style={resultsStyle}
                    className={`min-h-0 min-w-0 overflow-hidden ${editorCollapsed ? "flex-1" : "flex-shrink-0"}`}
                  >
                    <ResultsPanel />
                  </div>
                );
                const editorPane = (
                  <div
                    className={`min-h-0 min-w-0 flex flex-col overflow-hidden ${editorCollapsed ? "flex-shrink-0" : "flex-1"}`}
                  >
                    <EditorToolbar
                      onExecute={executeCurrent}
                      onExplain={() => void runExplain()}
                      onCancel={() => void cancelQuery()}
                    />
                    {!editorCollapsed && (
                      <QueryEditor
                        ref={editorRef}
                        value={activeTab?.editorValue ?? ""}
                        onChange={(v) => activeTabId && updateContent(activeTabId, v)}
                        onExecute={(blocks) => void runQuery(blocks)}
                        onExplain={() => void runExplain()}
                      />
                    )}
                  </div>
                );
                const handle = !editorCollapsed && (
                  <ResizeHandle
                    direction={layoutDirection}
                    onResize={(delta) => setEditorHeight(panelSwapped ? delta : -delta)}
                  />
                );
                return panelSwapped ? (
                  <>
                    {editorPane}
                    {handle}
                    {resultsPane}
                  </>
                ) : (
                  <>
                    {resultsPane}
                    {handle}
                    {editorPane}
                  </>
                );
              })()}
            </div>
          )}
        </div>
      </div>

      <StatusBar />

      <ConnectionModal
        open={connectionModalOpen}
        onOpenChange={handleModalClose}
        onSave={handleSaveConnection}
        editData={editingConnection}
      />

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onExecute={executeCurrent}
        onExplain={() => void runExplain()}
        onCheckUpdates={() => void checkForUpdates()}
      />
      <Toaster theme="dark" position="bottom-right" richColors />
    </div>
  );
}
