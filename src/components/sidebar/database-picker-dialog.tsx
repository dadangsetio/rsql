import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { groupProjectsByServer } from "@/lib/server-groups";
import { useUIStore } from "@/stores/ui-store";
import { useProjectStore } from "@/stores/project-store";
import { ProjectConnectionStatus } from "@/types";
import { Database, Loader2, Plus } from "lucide-react";

export function DatabasePickerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const activeServerFp = useUIStore((s) => s.activeServerFp);
  const openDatabaseTab = useUIStore((s) => s.openDatabaseTab);
  const projects = useProjectStore((s) => s.projects);
  const serverDatabases = useProjectStore((s) => s.serverDatabases);
  const status = useProjectStore((s) => s.status);
  const addDatabaseToServer = useProjectStore((s) => s.addDatabaseToServer);

  const [dbName, setDbName] = React.useState("");
  const [connName, setConnName] = React.useState("");

  React.useEffect(() => {
    if (open) { setDbName(""); setConnName(""); }
  }, [open]);

  if (!activeServerFp) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="font-mono">Databases</DialogTitle>
            <DialogDescription>Pick a Connection first.</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  const pids = groupProjectsByServer(projects).get(activeServerFp) ?? [];
  const source = projects[pids[0]];

  const discoveredDbs = new Set<string>();
  for (const pid of pids) {
    const dbs = serverDatabases[pid];
    if (dbs) dbs.forEach((db) => discoveredDbs.add(db));
    const d = projects[pid];
    if (d?.database) discoveredDbs.add(d.database);
  }
  const dbToProject = new Map<string, string>();
  for (const pid of pids) {
    const d = projects[pid];
    if (d?.database) dbToProject.set(d.database, pid);
  }
  const allDbs = Array.from(discoveredDbs).sort();

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!dbName.trim()) return;
    const name = connName.trim() || dbName.trim();
    void addDatabaseToServer(pids[0], name, dbName.trim()).then(() => {
      openDatabaseTab(name);
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="font-mono">Databases</DialogTitle>
          <DialogDescription>
            On <span className="font-mono font-semibold text-foreground">{source?.host}:{source?.port}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-64 overflow-y-auto space-y-0.5 mb-3">
          {allDbs.map((dbName_) => {
            const dbPid = dbToProject.get(dbName_);
            const dbStatus = dbPid ? status[dbPid] : undefined;
            const isConnected = dbStatus === ProjectConnectionStatus.Connected;
            const isConnecting = dbStatus === ProjectConnectionStatus.Connecting;
            return (
              <button
                key={dbName_}
                onClick={() => {
                  if (dbPid) { openDatabaseTab(dbPid); onOpenChange(false); }
                  else {
                    void addDatabaseToServer(pids[0], dbName_, dbName_).then(() => {
                      openDatabaseTab(dbName_);
                      onOpenChange(false);
                    });
                  }
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent/60 transition-colors"
              >
                {isConnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" /> : <Database className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                <span className="font-mono flex-1 truncate">{dbName_}</span>
                {dbPid && (
                  <span className={cn("h-2 w-2 rounded-full shrink-0",
                    isConnected && "bg-success shadow-[0_0_6px_currentColor]",
                    isConnecting && "bg-warning shadow-[0_0_6px_currentColor]",
                    !isConnected && !isConnecting && "bg-muted",
                  )} />
                )}
              </button>
            );
          })}
          {allDbs.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No databases discovered yet — add one below.</p>
          )}
        </div>

        <form onSubmit={handleAdd} className="space-y-3 border-t border-border/40 pt-3">
          <div className="space-y-1">
            <Label htmlFor="pickerDbName" className="font-mono text-xs">Database Name</Label>
            <Input id="pickerDbName" value={dbName} onChange={(e) => setDbName(e.target.value)} placeholder="analytics_db" className="font-mono text-sm h-8" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pickerConnName" className="font-mono text-xs text-muted-foreground">Connection Name</Label>
            <Input id="pickerConnName" value={connName} onChange={(e) => setConnName(e.target.value)} placeholder={dbName || "optional"} className="font-mono text-sm h-8" />
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="gradient" className="text-xs" disabled={!dbName.trim()}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add Database
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
