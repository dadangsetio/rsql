import { Copy, FileText, Trash2 } from "lucide-react";
import React from "react";
import { DatabaseTree } from "@/components/sidebar/database-tree";
import { OpenDatabaseTabs } from "@/components/sidebar/open-database-tabs";
import { cn } from "@/lib/utils";
import { useQueryStore } from "@/stores/query-store";
import { useTabStore } from "@/stores/tab-store";
import { useUIStore } from "@/stores/ui-store";

export function ServerSidebar({
  onEditConnection,
}: {
  onEditConnection?: (projectId: string) => void;
}) {
  const activeDatabaseTab = useUIStore((s) => s.activeDatabaseTab);
  const openTab = useTabStore((s) => s.openTab);
  const savedQueries = useQueryStore((s) => s.queries);
  const loadQueries = useQueryStore((s) => s.loadQueries);
  const queriesLoaded = useQueryStore((s) => s.loaded);
  const removeQuery = useQueryStore((s) => s.removeQuery);

  const [selectedQueryId, setSelectedQueryId] = React.useState<string | null>(null);
  const [rightTab, setRightTab] = React.useState<"tree" | "saved">("tree");

  React.useEffect(() => {
    if (!queriesLoaded) void loadQueries();
  }, [queriesLoaded, loadQueries]);

  const copy = (text: string) => navigator.clipboard.writeText(text);

  return (
    <div className="flex h-full border-r border-sidebar-border bg-sidebar select-none">
      {/* Left: database tabs, TablePlus-style connection dock */}
      <div className="w-[76px] shrink-0 border-r border-sidebar-border overflow-hidden">
        <OpenDatabaseTabs onEditConnection={onEditConnection} />
      </div>

      {/* Right: schema tree for the active database / saved queries, as tabs */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex h-8 shrink-0 items-center border-b border-sidebar-border">
          <button
            onClick={() => setRightTab("tree")}
            className={cn(
              "flex h-full items-center px-3 text-[10px] font-semibold uppercase tracking-widest transition-colors",
              rightTab === "tree"
                ? "border-b-2 border-primary text-sidebar-foreground"
                : "border-b-2 border-transparent text-muted-foreground hover:text-sidebar-foreground",
            )}
          >
            Tables
          </button>
          <button
            onClick={() => setRightTab("saved")}
            className={cn(
              "flex h-full items-center gap-1.5 px-3 text-[10px] font-semibold uppercase tracking-widest transition-colors",
              rightTab === "saved"
                ? "border-b-2 border-primary text-sidebar-foreground"
                : "border-b-2 border-transparent text-muted-foreground hover:text-sidebar-foreground",
            )}
          >
            Saved Queries
            {savedQueries.length > 0 && (
              <span className="text-[10px] text-muted-foreground">{savedQueries.length}</span>
            )}
          </button>
        </div>

        {rightTab === "tree" ? (
          <div className="flex-1 overflow-y-auto overflow-x-auto">
            {activeDatabaseTab ? (
              <DatabaseTree key={activeDatabaseTab} projectId={activeDatabaseTab} />
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-center">
                <p className="text-xs text-muted-foreground/60">
                  Pick a Connection to get started.
                </p>
              </div>
            )}
          </div>
        ) : savedQueries.length > 0 ? (
          <div className="flex-1 overflow-y-auto p-1">
            {savedQueries.map((q) => (
              <button
                key={q.id}
                onClick={() => {
                  setSelectedQueryId(q.id);
                  openTab(q.projectId, q.sql);
                }}
                className={cn(
                  "relative flex w-full items-center gap-1.5 py-1 pl-1 text-left text-sm transition-colors rounded-sm whitespace-nowrap",
                  selectedQueryId === q.id
                    ? "bg-primary/10 text-foreground"
                    : "hover:bg-white/[0.06] dark:hover:bg-white/[0.06] hover:bg-black/[0.04]",
                )}
              >
                <FileText className="h-3.5 w-3.5 text-primary/60 shrink-0" />
                <span className="font-mono text-xs">{q.title}</span>
                <span className="ml-auto mr-1 font-mono text-[10px] text-muted-foreground shrink-0">
                  {q.projectId}
                </span>
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeQuery(q.id);
                  }}
                  className="mr-1 shrink-0 rounded-sm p-0.5 hover:bg-destructive/20 hover:text-destructive"
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" />
                </span>
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    copy(q.sql);
                  }}
                  className="mr-1 shrink-0 rounded-sm p-0.5 hover:bg-accent"
                  title="Copy SQL"
                >
                  <Copy className="h-3 w-3" />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex-1 px-3 pt-2 text-[11px] text-muted-foreground/60">
            No saved queries yet. Use the Save button in the toolbar to save the current query.
          </div>
        )}
      </div>
    </div>
  );
}
