import { useState, useEffect, useRef, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { save, open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { pgsqlBackup, pgsqlRestore } from "@/tauri";
import { useActivityStore } from "@/stores/activity-store";
import { FolderOpen, Save, Upload, Loader2, Check, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface FlagOption {
  value: string;
  label: string;
}

const BACKUP_FLAGS: FlagOption[] = [
  { value: "--clean", label: "Clean (DROP before CREATE)" },
  { value: "--no-owner", label: "No owner" },
  { value: "--no-acl", label: "No privileges (ACL)" },
  { value: "--data-only", label: "Data only" },
  { value: "--schema-only", label: "Schema only" },
  { value: "--verbose", label: "Verbose" },
];
const BACKUP_DEFAULT_FLAGS = ["--verbose"];

const RESTORE_FLAGS: FlagOption[] = [
  { value: "--clean", label: "Clean (drop before restore)" },
  { value: "--if-exists", label: "If exists" },
  { value: "--no-owner", label: "No owner" },
  { value: "--no-acl", label: "No privileges (ACL)" },
  { value: "--data-only", label: "Data only" },
  { value: "--schema-only", label: "Schema only" },
  { value: "--single-transaction", label: "Single transaction" },
  { value: "--verbose", label: "Verbose" },
];
const RESTORE_DEFAULT_FLAGS = ["--clean", "--if-exists", "--no-owner", "--single-transaction", "--verbose"];

// pg_dump/pg_restore reject these combinations outright — grey them out instead of
// letting the process fail after the file dialog + run.
const FLAG_CONFLICTS: Record<string, string[]> = {
  "--clean": ["--data-only"],
  "--data-only": ["--clean", "--schema-only"],
  "--schema-only": ["--data-only"],
};

function isFlagDisabled(value: string, selected: string[]): boolean {
  if (selected.includes(value)) return false;
  return (FLAG_CONFLICTS[value] ?? []).some((c) => selected.includes(c));
}

interface PgBackupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "backup" | "restore";
  projectId: string;
  dbName: string;
}

export function PgBackupModal({ open: isOpen, onOpenChange, mode, projectId, dbName }: PgBackupModalProps) {
  const flagOptions = mode === "backup" ? BACKUP_FLAGS : RESTORE_FLAGS;
  const defaultFlags = mode === "backup" ? BACKUP_DEFAULT_FLAGS : RESTORE_DEFAULT_FLAGS;
  const [format, setFormat] = useState<string>(mode === "backup" ? "custom" : "archive");
  const [extraArgs, setExtraArgs] = useState(defaultFlags.join(" "));
  const [filePath, setFilePath] = useState("");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [done, setDone] = useState<{ ok: boolean; message: string } | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const currentTokens = extraArgs.split(/\s+/).filter(Boolean);

  useEffect(() => {
    if (isOpen) {
      setFormat(mode === "backup" ? "custom" : "archive");
      setExtraArgs((mode === "backup" ? BACKUP_DEFAULT_FLAGS : RESTORE_DEFAULT_FLAGS).join(" "));
      setFilePath("");
      setRunning(false);
      setLog([]);
      setDone(null);
    }
  }, [isOpen, mode]);

  const addFlag = (flag: string) => {
    if (!flag || currentTokens.includes(flag)) return;
    setExtraArgs([...currentTokens, flag].join(" "));
  };

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [log]);

  const pickPath = async () => {
    if (mode === "backup") {
      const path = await save({
        title: `Backup ${dbName}`,
        defaultPath: `${dbName}-${new Date().toISOString().slice(0, 10)}.dump`,
        filters: [{ name: "PostgreSQL Dump", extensions: ["dump", "sql", "tar"] }],
      });
      if (path) setFilePath(path);
    } else {
      const selected = await openFileDialog({
        title: `Restore into ${dbName}`,
        multiple: false,
        filters: [{ name: "PostgreSQL Dump", extensions: ["dump", "backup", "sql", "tar"] }],
      });
      if (selected) setFilePath(typeof selected === "string" ? selected : selected[0]);
    }
  };

  const handleRun = useCallback(async () => {
    if (!filePath) return;
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setRunning(true);
    setLog([]);
    setDone(null);

    // Simple whitespace split — good enough for flags; quoted values with spaces aren't supported.
    const args = extraArgs.split(/\s+/).filter(Boolean);
    const lines: string[] = [];

    const unlisten = await listen<string>(`pg-dump-log-${jobId}`, (e) => {
      lines.push(e.payload);
      setLog((l) => [...l, e.payload]);
    });

    try {
      if (mode === "backup") {
        await pgsqlBackup(projectId, filePath, { format: format as "custom" | "plain" | "tar", extra_args: args }, jobId);
      } else {
        await pgsqlRestore(projectId, filePath, { source_format: format as "archive" | "plain", extra_args: args }, jobId);
      }
      const message = mode === "backup" ? "Backup completed" : "Restore completed";
      setDone({ ok: true, message });
      toast.success(`${dbName}: ${message.toLowerCase()}`);
      useActivityStore.getState().log("success", `${dbName}: ${message.toLowerCase()}`, lines.join("\n") || undefined);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setDone({ ok: false, message });
      toast.error(`${mode === "backup" ? "Backup" : "Restore"} failed: ${message}`);
      useActivityStore.getState().log(
        "error",
        `${dbName}: ${mode === "backup" ? "backup" : "restore"} failed`,
        [message, lines.join("\n")].filter(Boolean).join("\n\n"),
      );
    } finally {
      setRunning(false);
      unlisten();
    }
  }, [filePath, mode, format, extraArgs, projectId, dbName]);

  return (
    <Dialog open={isOpen} onOpenChange={(v) => { if (!running) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-[560px] p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2">
            {mode === "backup" ? <Save className="h-4 w-4 text-primary" /> : <Upload className="h-4 w-4 text-primary" />}
            {mode === "backup" ? "Backup" : "Restore"} <span className="font-mono">{dbName}</span>
          </DialogTitle>
          <DialogDescription>
            {mode === "backup"
              ? `Dump "${dbName}" to a file using pg_dump.`
              : `Load a dump into "${dbName}" using pg_restore or psql.`}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 pb-5 space-y-4">
          <Button variant="outline" onClick={pickPath} disabled={running} className="w-full justify-center gap-2 font-mono text-xs">
            <FolderOpen className="h-3.5 w-3.5" />
            {filePath ? filePath.split("/").pop() : mode === "backup" ? "Choose destination file..." : "Choose dump file..."}
          </Button>

          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {mode === "backup" ? "Format" : "Dump format"}
            </div>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              disabled={running}
              className="w-full bg-input/80 border border-border/50 rounded-lg px-2 py-1.5 text-xs font-mono text-foreground"
            >
              {mode === "backup" ? (
                <>
                  <option value="custom">Custom (pg_restore)</option>
                  <option value="plain">Plain SQL (psql)</option>
                  <option value="tar">Tar</option>
                </>
              ) : (
                <>
                  <option value="archive">Archive (pg_restore)</option>
                  <option value="plain">Plain SQL (psql)</option>
                </>
              )}
            </select>
          </div>

          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Options</div>
            <select
              value=""
              onChange={(e) => { addFlag(e.target.value); e.target.value = ""; }}
              disabled={running}
              className="w-full bg-input/80 border border-border/50 rounded-lg px-2 py-1.5 text-xs font-mono text-foreground"
            >
              <option value="">+ Add option...</option>
              {flagOptions.map((f) => (
                <option key={f.value} value={f.value} disabled={isFlagDisabled(f.value, currentTokens)}>
                  {f.label}{currentTokens.includes(f.value) ? " (added)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Additional Parameters
            </div>
            <Input
              value={extraArgs}
              onChange={(e) => setExtraArgs(e.target.value)}
              disabled={running}
              placeholder="--exclude-table=logs --jobs=4"
              className="font-mono text-xs"
            />
            <div className="text-[10px] text-muted-foreground/60">
              Raw flags, space-separated. Picking an Option above appends here &mdash; edit freely.
            </div>
          </div>

          {(running || log.length > 0) && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Log</div>
              <div className="rounded-xl border border-border/40 bg-muted/20 max-h-[160px] overflow-y-auto p-2 font-mono text-[11px] text-muted-foreground space-y-0.5">
                {log.length === 0 ? (
                  <div className="opacity-60 flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Starting...</div>
                ) : (
                  log.map((line, i) => <div key={i} className="whitespace-pre-wrap break-all">{line}</div>)
                )}
                <div ref={logEndRef} />
              </div>
            </div>
          )}

          {done && (
            <div className={cn(
              "flex items-center gap-2 text-xs font-mono px-3 py-2 rounded-lg",
              done.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
            )}>
              {done.ok ? <Check className="h-3.5 w-3.5 shrink-0" /> : <AlertCircle className="h-3.5 w-3.5 shrink-0" />}
              <span className="truncate">{done.message}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={running} className="font-mono text-xs">
              {done?.ok ? "Close" : "Cancel"}
            </Button>
            {!done?.ok && (
              <Button variant="gradient" onClick={handleRun} disabled={running || !filePath} className="font-mono text-xs gap-2">
                {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {mode === "backup" ? "Start Backup" : "Start Restore"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
