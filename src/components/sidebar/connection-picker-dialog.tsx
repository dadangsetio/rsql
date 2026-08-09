import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { groupProjectsByServer } from "@/lib/server-groups";
import { useUIStore } from "@/stores/ui-store";
import { useProjectStore } from "@/stores/project-store";
import { ProjectConnectionStatus } from "@/types";
import { Copy, Edit3, Plus, Search, Server, Trash2 } from "lucide-react";

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

  const [query, setQuery] = React.useState("");
  React.useEffect(() => { if (open) setQuery(""); }, [open]);

  const groups = groupProjectsByServer(projects);
  const rows = Array.from(groups.entries())
    .map(([fp, pids]) => {
      const name = pids[0];
      const d = projects[name];
      const address = d ? `${d.host}:${d.port}` : "";
      return { fp, pids, name, address };
    })
    .filter((r) => {
      const q = query.toLowerCase();
      return r.name.toLowerCase().includes(q) || r.address.toLowerCase().includes(q);
    });

  const selectServer = (fp: string, pids: string[]) => {
    setActiveServerFp(fp);
    const defaultPid = pids.find((p) => status[p] === ProjectConnectionStatus.Connected) ?? pids[0];
    openDatabaseTab(defaultPid);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">Connection</DialogTitle>
        </DialogHeader>

        <div className="relative mb-2">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search connections..."
            className="h-8 pl-8 text-xs font-mono"
          />
        </div>

        <div className="max-h-72 overflow-y-auto space-y-0.5">
          <button
            onClick={() => { setConnectionModalOpen(true); onOpenChange(false); }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-primary hover:bg-primary/10 transition-colors"
          >
            <Plus className="h-4 w-4" /> New Connection
          </button>

          {rows.map(({ fp, pids, name, address }) => {
            const anyConnected = pids.some((p) => status[p] === ProjectConnectionStatus.Connected);
            const anyConnecting = pids.some((p) => status[p] === ProjectConnectionStatus.Connecting);
            return (
              <div
                key={fp}
                role="button"
                tabIndex={0}
                onClick={() => selectServer(fp, pids)}
                onKeyDown={(e) => { if (e.key === "Enter") selectServer(fp, pids); }}
                onContextMenu={(e) => showMenu(e, [
                  ...(onEditConnection ? [{ label: "Edit Connection", icon: <Edit3 className="h-3 w-3" />, onClick: () => onEditConnection(pids[0]) }] : []),
                  { separator: true as const },
                  { label: "Copy Name", icon: <Copy className="h-3 w-3" />, onClick: () => copy(name) },
                  { separator: true as const },
                  { label: "Delete", icon: <Trash2 className="h-3 w-3" />, onClick: () => { for (const pid of pids) { closeDatabaseTab(pid); void deleteProject(pid); } }, destructive: true },
                ])}
                className="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent/60 transition-colors cursor-pointer"
              >
                <Server className="h-3.5 w-3.5 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm truncate">{name}</div>
                  {address && <div className="font-mono text-[10px] text-muted-foreground truncate">{address}</div>}
                </div>
                <span className={cn("h-2 w-2 rounded-full shrink-0",
                  anyConnected && "bg-success shadow-[0_0_6px_currentColor]",
                  anyConnecting && "bg-warning shadow-[0_0_6px_currentColor]",
                  !anyConnected && !anyConnecting && "bg-muted",
                )} />
                {onEditConnection && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onEditConnection(pids[0]); }}
                    title="Edit Connection"
                    className="shrink-0 rounded-sm p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-accent transition-opacity"
                  >
                    <Edit3 className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}
          {rows.length === 0 && (
            <p className="px-3 py-4 text-xs text-muted-foreground text-center">
              {groups.size === 0 ? "No connections yet." : "No matches."}
            </p>
          )}
        </div>
      </DialogContent>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </Dialog>
  );
}
