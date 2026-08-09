import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { groupProjectsByServer, serverLabel } from "@/lib/server-groups";
import { useUIStore } from "@/stores/ui-store";
import { useProjectStore } from "@/stores/project-store";
import { ProjectConnectionStatus } from "@/types";
import { Copy, Edit3, Plus, Server, Trash2 } from "lucide-react";

export function ConnectionPickerDialog({
  open, onOpenChange, onEditConnection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEditConnection?: (projectId: string) => void;
}) {
  const projects = useProjectStore((s) => s.projects);
  const status = useProjectStore((s) => s.status);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const setActiveServerFp = useUIStore((s) => s.setActiveServerFp);
  const openDatabaseTab = useUIStore((s) => s.openDatabaseTab);
  const closeDatabaseTab = useUIStore((s) => s.closeDatabaseTab);
  const setConnectionModalOpen = useUIStore((s) => s.setConnectionModalOpen);
  const { menu, showMenu, closeMenu } = useContextMenu();
  const copy = (text: string) => navigator.clipboard.writeText(text);

  const groups = groupProjectsByServer(projects);

  const selectServer = (fp: string, pids: string[]) => {
    setActiveServerFp(fp);
    const defaultPid = pids.find((p) => status[p] === ProjectConnectionStatus.Connected) ?? pids[0];
    openDatabaseTab(defaultPid);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="font-mono">Connection</DialogTitle>
          <DialogDescription>Pick a server to work with, or add a new one.</DialogDescription>
        </DialogHeader>

        <button
          onClick={() => { setConnectionModalOpen(true); onOpenChange(false); }}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-primary hover:bg-primary/10 transition-colors mb-2"
        >
          <Plus className="h-4 w-4" /> New Connection
        </button>

        <div className="max-h-80 overflow-y-auto space-y-0.5">
          {Array.from(groups.entries()).map(([fp, pids]) => {
            const label = serverLabel(fp, pids, projects);
            const anyConnected = pids.some((p) => status[p] === ProjectConnectionStatus.Connected);
            const anyConnecting = pids.some((p) => status[p] === ProjectConnectionStatus.Connecting);
            return (
              <button
                key={fp}
                onClick={() => selectServer(fp, pids)}
                onContextMenu={(e) => showMenu(e, [
                  ...(onEditConnection ? [{ label: "Edit Connection", icon: <Edit3 className="h-3 w-3" />, onClick: () => onEditConnection(pids[0]) }] : []),
                  { separator: true as const },
                  { label: "Copy Name", icon: <Copy className="h-3 w-3" />, onClick: () => copy(label) },
                  { separator: true as const },
                  { label: "Delete", icon: <Trash2 className="h-3 w-3" />, onClick: () => { for (const pid of pids) { closeDatabaseTab(pid); void deleteProject(pid); } }, destructive: true },
                ])}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent/60 transition-colors"
              >
                <Server className="h-3.5 w-3.5 text-primary shrink-0" />
                <span className="font-mono flex-1 truncate">{label}</span>
                <span className={cn("h-2 w-2 rounded-full shrink-0",
                  anyConnected && "bg-success shadow-[0_0_6px_currentColor]",
                  anyConnecting && "bg-warning shadow-[0_0_6px_currentColor]",
                  !anyConnected && !anyConnecting && "bg-muted",
                )} />
              </button>
            );
          })}
          {groups.size === 0 && (
            <p className="px-3 py-4 text-xs text-muted-foreground text-center">No connections yet.</p>
          )}
        </div>
      </DialogContent>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </Dialog>
  );
}
