import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { groupProjectsByServer } from "@/lib/server-groups";
import { useUIStore } from "@/stores/ui-store";
import { useProjectStore } from "@/stores/project-store";
import { ProjectConnectionStatus } from "@/types";
import { Database, Loader2, Plus, Search } from "lucide-react";

export function DatabasePickerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const activeServerFp = useUIStore((s) => s.activeServerFp);
  const openDatabaseTab = useUIStore((s) => s.openDatabaseTab);
  const projects = useProjectStore((s) => s.projects);
  const serverDatabases = useProjectStore((s) => s.serverDatabases);
  const status = useProjectStore((s) => s.status);
  const addDatabaseToServer = useProjectStore((s) => s.addDatabaseToServer);

  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (open) setQuery(""); }, [open]);

  if (!activeServerFp) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">Databases</DialogTitle>
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
  const filteredDbs = allDbs.filter((db) => db.toLowerCase().includes(query.toLowerCase()));
  const exactMatch = allDbs.some((db) => db.toLowerCase() === query.trim().toLowerCase());

  const openExisting = (dbName: string) => {
    const dbPid = dbToProject.get(dbName);
    if (dbPid) { openDatabaseTab(dbPid); onOpenChange(false); }
    else {
      void addDatabaseToServer(pids[0], dbName, dbName).then(() => {
        openDatabaseTab(dbName);
        onOpenChange(false);
      });
    }
  };

  const addNew = () => {
    const name = query.trim();
    if (!name) return;
    void addDatabaseToServer(pids[0], name, name).then(() => {
      openDatabaseTab(name);
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">Databases</DialogTitle>
          <DialogDescription>
            On <span className="font-mono font-semibold text-foreground">{source?.host}:{source?.port}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="relative mb-2">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && query.trim() && !exactMatch) addNew(); }}
            placeholder="Search or type a new database name..."
            className="h-8 pl-8 text-xs font-mono"
          />
        </div>

        <div className="max-h-72 overflow-y-auto space-y-0.5">
          <button
            onClick={() => { if (query.trim() && !exactMatch) addNew(); else inputRef.current?.focus(); }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-primary hover:bg-primary/10 transition-colors"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            {query.trim() && !exactMatch ? `Add "${query.trim()}"` : "Add Database"}
          </button>

          {filteredDbs.map((dbName) => {
            const dbPid = dbToProject.get(dbName);
            const dbStatus = dbPid ? status[dbPid] : undefined;
            const isConnected = dbStatus === ProjectConnectionStatus.Connected;
            const isConnecting = dbStatus === ProjectConnectionStatus.Connecting;
            return (
              <button
                key={dbName}
                onClick={() => openExisting(dbName)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent/60 transition-colors"
              >
                {isConnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" /> : <Database className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                <span className="font-mono flex-1 truncate">{dbName}</span>
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

          {filteredDbs.length === 0 && (
            <p className="px-3 py-4 text-xs text-muted-foreground text-center">
              {allDbs.length === 0 ? "No databases discovered yet." : "No matches."}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
