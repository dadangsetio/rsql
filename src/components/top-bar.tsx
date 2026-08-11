import {
  ChevronDown,
  Database,
  DatabaseBackup,
  Download,
  Moon,
  PanelRight,
  Save,
  Search,
  Server,
  Sun,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { PgBackupModal } from "@/components/pg-backup-modal";
import { ConnectionPickerDialog } from "@/components/sidebar/connection-picker-dialog";
import { DatabasePickerDialog } from "@/components/sidebar/database-picker-dialog";
import { Button } from "@/components/ui/button";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { useProjectStore } from "@/stores/project-store";
import { useActiveTab } from "@/stores/tab-store";
import { useUIStore } from "@/stores/ui-store";
import { ProjectConnectionStatus } from "@/types";

export function TopBar({
  onCheckUpdates,
  onOpenCommandPalette,
  onEditConnection,
}: {
  onCheckUpdates: () => void;
  onOpenCommandPalette: () => void;
  onEditConnection?: (projectId: string) => void;
}) {
  const theme = useUIStore((s) => s.theme);
  const toggleTheme = useUIStore((s) => s.toggleTheme);
  const rowDetailPanelOpen = useUIStore((s) => s.rowDetailPanelOpen);
  const toggleRowDetailPanel = useUIStore((s) => s.toggleRowDetailPanel);
  const activeServerFp = useUIStore((s) => s.activeServerFp);
  const connectionPickerOpen = useUIStore((s) => s.connectionPickerOpen);
  const setConnectionPickerOpen = useUIStore((s) => s.setConnectionPickerOpen);
  const databasePickerOpen = useUIStore((s) => s.databasePickerOpen);
  const setDatabasePickerOpen = useUIStore((s) => s.setDatabasePickerOpen);
  const projects = useProjectStore((s) => s.projects);
  const status = useProjectStore((s) => s.status);
  const activeTab = useActiveTab();
  const activeProject = activeTab?.projectId;
  const activeProjectDetails = activeProject ? projects[activeProject] : undefined;
  const activeConnected =
    !!activeProject && status[activeProject] === ProjectConnectionStatus.Connected;
  const { menu, showMenu, closeMenu } = useContextMenu();
  const [pgBackupTarget, setPgBackupTarget] = useState<{
    mode: "backup" | "restore";
    projectId: string;
    dbName: string;
  } | null>(null);

  return (
    <div className="flex h-11 items-center justify-between border-b border-border/50 bg-card/80 backdrop-blur-xl px-4">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          <span className="font-mono text-sm font-semibold">RSQL</span>
        </div>
        <div className="h-4 w-px bg-border/50" />

        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs font-mono"
          onClick={() => setConnectionPickerOpen(true)}
        >
          <Server className="h-3.5 w-3.5" /> Connection
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs font-mono"
          disabled={!activeServerFp}
          onClick={() => setDatabasePickerOpen(true)}
        >
          <Database className="h-3.5 w-3.5" /> Databases
        </Button>
      </div>

      <div className="flex items-center gap-2">
        {/* Command palette trigger */}
        <button
          type="button"
          onClick={onOpenCommandPalette}
          className="flex items-center gap-2 h-7 px-3 rounded-lg border border-border/50 bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
        >
          <Search className="h-3 w-3" />
          <span className="text-xs font-mono">Search...</span>
          <kbd className="hidden sm:inline-flex h-5 items-center gap-0.5 rounded border border-border/60 bg-muted px-1.5 font-mono text-[10px] text-muted-foreground/70">
            {navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}K
          </kbd>
        </button>

        <div className="h-4 w-px bg-border/50" />

        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5"
          title="Backup or restore a database"
          onClick={(e) =>
            showMenu(e, [
              { header: "Current Database" },
              {
                label: activeConnected
                  ? `Backup ${activeProjectDetails?.database}...`
                  : "Backup... (connect a database first)",
                icon: <Save className="h-3 w-3" />,
                disabled: !activeConnected,
                onClick: () =>
                  setPgBackupTarget({
                    mode: "backup",
                    projectId: activeProject!,
                    dbName: activeProjectDetails?.database ?? activeProject!,
                  }),
              },
              {
                label: activeConnected
                  ? `Restore ${activeProjectDetails?.database}...`
                  : "Restore... (connect a database first)",
                icon: <Upload className="h-3 w-3" />,
                disabled: !activeConnected,
                onClick: () =>
                  setPgBackupTarget({
                    mode: "restore",
                    projectId: activeProject!,
                    dbName: activeProjectDetails?.database ?? activeProject!,
                  }),
              },
            ])
          }
        >
          <DatabaseBackup className="h-4 w-4" />
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>

        <div className="h-4 w-px bg-border/50" />

        <Button
          variant={rowDetailPanelOpen ? "outline" : "ghost"}
          size="icon"
          className="h-8 w-8"
          title="Toggle row detail panel"
          onClick={toggleRowDetailPanel}
        >
          <PanelRight className="h-4 w-4" />
        </Button>

        <div className="h-4 w-px bg-border/50" />

        <Button variant="ghost" size="sm" className="h-8 gap-2" onClick={onCheckUpdates}>
          <Download className="h-4 w-4" />
          <span className="text-xs">Updates</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 hover:rotate-12 transition-all duration-200"
          onClick={toggleTheme}
        >
          {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </Button>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}

      <ConnectionPickerDialog
        open={connectionPickerOpen}
        onOpenChange={setConnectionPickerOpen}
        onEditConnection={onEditConnection}
      />
      <DatabasePickerDialog open={databasePickerOpen} onOpenChange={setDatabasePickerOpen} />

      {pgBackupTarget && (
        <PgBackupModal
          open={!!pgBackupTarget}
          onOpenChange={(v) => {
            if (!v) setPgBackupTarget(null);
          }}
          mode={pgBackupTarget.mode}
          projectId={pgBackupTarget.projectId}
          dbName={pgBackupTarget.dbName}
        />
      )}
    </div>
  );
}
