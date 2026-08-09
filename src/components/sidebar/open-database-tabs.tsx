import React from "react";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { PgBackupModal } from "@/components/pg-backup-modal";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/stores/ui-store";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { ProjectConnectionStatus } from "@/types";
import {
  Activity, Columns3, Copy, Database, Edit3, List, Loader2, Package,
  Plus, RefreshCw, Save, Settings, Trash2, Upload, X, Zap,
} from "lucide-react";

export function OpenDatabaseTabs({ onEditConnection }: { onEditConnection?: (projectId: string) => void }) {
  const openDatabaseTabs = useUIStore((s) => s.openDatabaseTabs);
  const activeDatabaseTab = useUIStore((s) => s.activeDatabaseTab);
  const setActiveDatabaseTab = useUIStore((s) => s.setActiveDatabaseTab);
  const closeDatabaseTab = useUIStore((s) => s.closeDatabaseTab);
  const projects = useProjectStore((s) => s.projects);
  const status = useProjectStore((s) => s.status);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const openTab = useTabStore((s) => s.openTab);
  const openMonitorTab = useTabStore((s) => s.openMonitorTab);
  const openNotifyTab = useTabStore((s) => s.openNotifyTab);
  const openSchemaDiffTab = useTabStore((s) => s.openSchemaDiffTab);
  const openExtensionsTab = useTabStore((s) => s.openExtensionsTab);
  const openEnumsTab = useTabStore((s) => s.openEnumsTab);
  const openPgSettingsTab = useTabStore((s) => s.openPgSettingsTab);
  const { menu, showMenu, closeMenu } = useContextMenu();
  const [pgBackupTarget, setPgBackupTarget] = React.useState<{ mode: "backup" | "restore"; projectId: string; dbName: string } | null>(null);

  const copy = (text: string) => navigator.clipboard.writeText(text);

  if (openDatabaseTabs.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5 overflow-x-auto overflow-y-hidden whitespace-nowrap scrollbar-none border-b border-sidebar-border px-1.5 py-1">
      {openDatabaseTabs.map((pid) => {
        const isActive = activeDatabaseTab === pid;
        const pStatus = status[pid];
        const isConnected = pStatus === ProjectConnectionStatus.Connected;
        const isConnecting = pStatus === ProjectConnectionStatus.Connecting;
        const isFailed = pStatus === ProjectConnectionStatus.Failed;
        const label = projects[pid]?.database || pid;

        return (
          <div
            key={pid}
            onClick={() => setActiveDatabaseTab(pid)}
            onContextMenu={(e) => showMenu(e, [
              { header: "Database" },
              { label: "New Query", icon: <Plus className="h-3 w-3" />, onClick: () => openTab(pid) },
              ...(isConnected ? [
                { label: "Refresh", icon: <RefreshCw className="h-3 w-3" />, onClick: () => void useProjectStore.getState().refreshConnection(pid) },
                { label: "Performance Monitor", icon: <Activity className="h-3 w-3" />, onClick: () => openMonitorTab(pid) },
                { label: "PG Settings", icon: <Settings className="h-3 w-3" />, onClick: () => openPgSettingsTab(pid) },
                { label: "LISTEN/NOTIFY", icon: <Zap className="h-3 w-3" />, onClick: () => openNotifyTab(pid) },
                { label: "Schema Diff", icon: <Columns3 className="h-3 w-3" />, onClick: () => openSchemaDiffTab(pid) },
                { label: "Extensions", icon: <Package className="h-3 w-3" />, onClick: () => openExtensionsTab(pid) },
                { label: "Enum Types", icon: <List className="h-3 w-3" />, onClick: () => openEnumsTab(pid) },
                { separator: true as const },
                { label: "Backup...", icon: <Save className="h-3 w-3" />, onClick: () => setPgBackupTarget({ mode: "backup", projectId: pid, dbName: label }) },
                { label: "Restore...", icon: <Upload className="h-3 w-3" />, onClick: () => setPgBackupTarget({ mode: "restore", projectId: pid, dbName: label }) },
              ] : []),
              ...(onEditConnection ? [{ separator: true as const }, { label: "Edit Connection", icon: <Edit3 className="h-3 w-3" />, onClick: () => onEditConnection(pid) }] : []),
              { separator: true as const },
              { label: "Copy Name", icon: <Copy className="h-3 w-3" />, onClick: () => copy(label) },
              { separator: true as const },
              { label: "Delete", icon: <Trash2 className="h-3 w-3" />, onClick: () => { closeDatabaseTab(pid); void deleteProject(pid); }, destructive: true },
            ])}
            className={cn(
              "group flex shrink-0 items-center gap-1.5 px-2.5 py-1 rounded-lg transition-all duration-150 cursor-pointer select-none font-mono text-xs",
              isActive ? "bg-accent/80 text-foreground shadow-sm" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
            )}
          >
            {isConnecting ? <Loader2 className="h-3 w-3 animate-spin shrink-0" /> : <Database className={cn("h-3 w-3 shrink-0", isFailed && "text-destructive")} />}
            <span>{label}</span>
            <button
              onClick={(e) => { e.stopPropagation(); closeDatabaseTab(pid); }}
              className="opacity-0 transition-all hover:bg-destructive/20 hover:text-destructive rounded-md p-0.5 group-hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
      {pgBackupTarget && (
        <PgBackupModal
          open={!!pgBackupTarget}
          onOpenChange={(open) => { if (!open) setPgBackupTarget(null); }}
          mode={pgBackupTarget.mode}
          projectId={pgBackupTarget.projectId}
          dbName={pgBackupTarget.dbName}
        />
      )}
    </div>
  );
}
