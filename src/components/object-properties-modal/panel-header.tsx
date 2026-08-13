import { ArrowLeft, Columns3, Database, FileCode, Key, Link2, Pencil, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tab } from "./types";

const tabIcons: Partial<Record<Tab, React.ReactNode>> = {
  overview: <Database className="h-3 w-3" />,
  columns: <Columns3 className="h-3 w-3" />,
  indexes: <Key className="h-3 w-3" />,
  fkeys: <Link2 className="h-3 w-3" />,
  structure: <Pencil className="h-3 w-3" />,
  ddl: <FileCode className="h-3 w-3" />,
  actions: <Zap className="h-3 w-3" />,
};

export function PropertiesPanelHeader({
  availableTabs,
  activeTab,
  setActiveTab,
  onClose,
}: {
  availableTabs: { key: Tab; label: string }[];
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border/30 bg-card/40 backdrop-blur-sm px-3 py-1.5 flex-shrink-0">
      <button
        type="button"
        onClick={onClose}
        className="flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
        title="Back to data"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
      </button>

      <div className="flex gap-0.5 overflow-x-auto">
        {availableTabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium whitespace-nowrap rounded-md transition-colors",
              activeTab === tab.key
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
            )}
          >
            {tabIcons[tab.key]}
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}
