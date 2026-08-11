import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type React from "react";
import { cn } from "@/lib/utils";

// Indent levels (px)
export const I = {
  server: 4,
  cat: 14,
  db: 24,
  schema: 32,
  schemaObj: 40,
  table: 48,
  section: 56,
  item: 64,
};

/** Indent guide lines */
export function IndentGuides({ indent }: { indent: number }) {
  const guides: number[] = [];
  // Draw guides at each nesting level (every 12px starting from the first nested level)
  for (let x = I.cat + 4; x < indent; x += 12) {
    guides.push(x);
  }
  return (
    <>
      {guides.map((x) => (
        <span key={x} className="sidebar-indent-guide" style={{ left: `${x}px` }} />
      ))}
    </>
  );
}

/** Generic tree row */
export function TreeRow({
  indent,
  icon,
  label,
  bold,
  expanded,
  loading: isLoading,
  trailing,
  selected,
  onClick,
  onDoubleClick,
  onContextMenu,
  onChevronClick,
}: {
  indent: number;
  icon: React.ReactNode;
  label: string;
  bold?: boolean;
  expanded?: boolean;
  loading?: boolean;
  trailing?: React.ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** When set, the chevron becomes its own click target (expand/collapse) separate from the row's onClick. */
  onChevronClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className={cn(
        "relative flex w-full items-center gap-1.5 py-1 text-left text-sm transition-colors rounded-sm whitespace-nowrap",
        selected
          ? "bg-primary/10 text-foreground"
          : "hover:bg-white/[0.06] dark:hover:bg-white/[0.06] hover:bg-black/[0.04]",
      )}
      style={{ paddingLeft: `${indent}px` }}
    >
      <IndentGuides indent={indent} />
      {expanded !== undefined ? (
        isLoading ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        ) : onChevronClick ? (
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              onChevronClick();
            }}
            className="shrink-0 -m-1 p-1 rounded-sm hover:bg-black/[0.08] dark:hover:bg-white/[0.12]"
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )}
          </span>
        ) : expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )
      ) : null}
      <span className="shrink-0">{icon}</span>
      <span className={cn("font-mono text-xs", bold && "font-semibold")}>{label}</span>
      {trailing && <span className="ml-auto mr-1">{trailing}</span>}
    </button>
  );
}

/** Collapsible section header */
export function SectionHeader({
  indent,
  label,
  icon,
  expanded,
  onClick,
}: {
  indent: number;
  label: string;
  icon: React.ReactNode;
  sectionKey?: string;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="relative flex w-full items-center gap-1.5 py-0.5 text-left hover:bg-sidebar-accent transition-colors rounded-sm whitespace-nowrap"
      style={{ paddingLeft: `${indent}px` }}
    >
      <IndentGuides indent={indent} />
      {expanded ? (
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}
      <span className="shrink-0">{icon}</span>
      <span className="font-mono text-[11px] font-semibold text-muted-foreground">{label}</span>
    </button>
  );
}
