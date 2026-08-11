import { Check, CheckCircle2, Copy, Info, ScrollText, Trash2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { type ActivityEntry, useActivityStore } from "@/stores/activity-store";

const TRUNCATE_AT = 140;

function LevelIcon({ level }: { level: ActivityEntry["level"] }) {
  if (level === "success") return <CheckCircle2 className="h-3 w-3 text-success flex-shrink-0" />;
  if (level === "error") return <XCircle className="h-3 w-3 text-destructive flex-shrink-0" />;
  return <Info className="h-3 w-3 text-muted-foreground flex-shrink-0" />;
}

function entryText(entry: ActivityEntry): string {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  return entry.detail
    ? `[${time}] ${entry.message}\n${entry.detail}`
    : `[${time}] ${entry.message}`;
}

function CopyButton({ getText, className }: { getText: () => string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(getText());
        setCopied(true);
        setTimeout(() => setCopied(false), 1000);
      }}
      className={cn(
        "flex-shrink-0 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity",
        className,
      )}
      title="Copy"
    >
      {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

export function ActivityLog() {
  const entries = useActivityStore((s) => s.entries);
  const clear = useActivityStore((s) => s.clear);
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!open) setSelected(new Set());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && selected.size > 0) {
        e.preventDefault();
        const text = entries
          .filter((en) => selected.has(en.id))
          .reverse()
          .map(entryText)
          .join("\n\n");
        void navigator.clipboard.writeText(text);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, selected, entries]);

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        next.has(id) ? next.delete(id) : next.add(id);
      } else {
        next.clear();
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent/50 transition-colors",
          open && "bg-accent/50",
        )}
        title="Activity log"
      >
        <ScrollText className="h-3 w-3" />
        {entries.length > 0 && <span>{entries.length}</span>}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 w-96 max-h-96 flex flex-col rounded-md border border-border bg-popover shadow-lg z-50">
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5 flex-shrink-0">
            <span className="font-mono text-[11px] font-semibold text-foreground">
              ACTIVITY ({entries.length}){selected.size > 0 && ` • ${selected.size} selected`}
            </span>
            <button
              onClick={() => {
                clear();
                setExpandedId(null);
              }}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <Trash2 className="h-3 w-3" />
              Clear
            </button>
          </div>
          <div className="flex-1 overflow-auto">
            {entries.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                No activity yet
              </div>
            ) : (
              entries.map((entry) => {
                const isExpanded = expandedId === entry.id;
                const isLong = entry.message.length > TRUNCATE_AT || !!entry.detail;
                const shown =
                  !isExpanded && entry.message.length > TRUNCATE_AT
                    ? entry.message.slice(0, TRUNCATE_AT) + "…"
                    : entry.message;

                return (
                  <div
                    key={entry.id}
                    onClick={() => isLong && setExpandedId(isExpanded ? null : entry.id)}
                    onMouseDown={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey) toggleSelect(entry.id, e);
                    }}
                    className={cn(
                      "group flex items-start gap-2 border-b border-border/50 px-3 py-1.5 last:border-b-0",
                      isLong && "cursor-pointer hover:bg-accent/30",
                      selected.has(entry.id) && "bg-primary/10",
                    )}
                  >
                    <LevelIcon level={entry.level} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] text-foreground break-words leading-snug whitespace-pre-wrap">
                        {shown}
                      </div>
                      {isExpanded && entry.detail && (
                        <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/50 p-2 text-[10px] font-mono text-foreground whitespace-pre-wrap break-all">
                          {entry.detail}
                        </pre>
                      )}
                      <div className="text-[10px] text-muted-foreground">
                        {new Date(entry.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </div>
                    </div>
                    <CopyButton getText={() => entryText(entry)} className="mt-0.5" />
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
