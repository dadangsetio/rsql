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

  React.useEffect(() => {
    if (!queriesLoaded) void loadQueries();
  }, [queriesLoaded, loadQueries]);

  const copy = (text: string) => navigator.clipboard.writeText(text);

  return (
    <div className="flex h-full flex-col border-r border-sidebar-border bg-sidebar select-none">
      <OpenDatabaseTabs onEditConnection={onEditConnection} />

      <div className="flex-1 overflow-y-auto overflow-x-auto">
        {activeDatabaseTab ? (
          <DatabaseTree key={activeDatabaseTab} projectId={activeDatabaseTab} />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center">
            <p className="text-xs text-muted-foreground/60">Pick a Connection to get started.</p>
          </div>
        )}
      </div>

      {/* Saved Queries — always visible */}
      <div className="border-t border-sidebar-border">
        <div className="flex h-8 items-center justify-between px-3">
          <span className="tracking-widest uppercase text-[10px] font-semibold text-sidebar-foreground">
            SAVED QUERIES
          </span>
          {savedQueries.length > 0 && (
            <span className="text-[10px] text-muted-foreground">{savedQueries.length}</span>
          )}
        </div>
        {savedQueries.length > 0 ? (
          <div className="overflow-y-auto p-1 max-h-48">
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
          <div className="px-3 pb-2 text-[11px] text-muted-foreground/60">
            No saved queries yet. Use the Save button in the toolbar to save the current query.
          </div>
        )}
      </div>
    </div>
  );
}
