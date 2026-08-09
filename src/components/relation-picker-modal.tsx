import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { ResultsGrid } from "./results-grid";
import { FilterBar } from "./filter-bar";
import { useProjectStore } from "@/stores/project-store";
import { DriverFactory } from "@/lib/database-driver";
import { quoteIdent } from "@/lib/sql-utils";
import { buildEnumLabelMap } from "@/lib/column-edit-kind";
import {
  classifyFilterColumnKind,
  buildConditionsSql,
  emptyFilterState,
  newColumnCondition,
  type FilterColumnInfo,
} from "@/lib/filter-utils";
import { Loader2, ArrowRight, XCircle, ChevronLeft, ChevronRight } from "lucide-react";
import type { ColumnDetail, FilterState } from "@/types";

const LABEL_COLUMN_CANDIDATES = ["name", "title", "label", "email", "username", "display_name", "full_name"];
const TEXTY_TYPES = new Set(["character varying", "character", "text", "citext"]);

/** Best-effort guess at a human-readable column to filter by alongside the target column's raw id. */
function pickDisplayColumn(colDetails: ColumnDetail[], targetColumn: string): string | null {
  const textCols = colDetails.filter((c) => TEXTY_TYPES.has(c.dataType.toLowerCase()) && c.name !== targetColumn);
  for (const candidate of LABEL_COLUMN_CANDIDATES) {
    const match = textCols.find((c) => c.name.toLowerCase() === candidate);
    if (match) return match.name;
  }
  return textCols[0]?.name ?? null;
}

interface RelationPickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  schema: string;
  table: string;
  column: string;
  nullable: boolean;
  currentValue: string;
  onSelect: (value: string | null) => void;
}

const PAGE_SIZE = 10;

export function RelationPickerModal({
  open, onOpenChange, projectId, schema, table, column, nullable, currentValue, onSelect,
}: RelationPickerModalProps) {
  const [filterState, setFilterState] = useState<FilterState>(emptyFilterState());
  const [allColumns, setAllColumns] = useState<string[]>([]);
  const [columnKinds, setColumnKinds] = useState<Map<string, FilterColumnInfo>>(new Map());
  const [page, setPage] = useState(0);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runQuery = useCallback(async (state: FilterState, pageIndex: number) => {
    const d = useProjectStore.getState().projects[projectId];
    if (!d) return;
    setLoading(true);
    setError(null);
    try {
      const driver = DriverFactory.getDriver(d.driver);
      let sql = `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)}`;
      const whereBody = buildConditionsSql(state);
      if (whereBody) sql += ` WHERE ${whereBody}`;
      // Fetch one extra row past the page so Next can be enabled/disabled without a COUNT(*).
      sql += ` ORDER BY ${quoteIdent(column)} LIMIT ${PAGE_SIZE + 1} OFFSET ${pageIndex * PAGE_SIZE}`;
      const [resultColumns, resultRows] = await driver.runQuery(projectId, sql);
      setColumns(resultColumns);
      setHasNextPage(resultRows.length > PAGE_SIZE);
      setRows(resultRows.slice(0, PAGE_SIZE));
    } catch (err: any) {
      setError(err?.message ?? "Query failed");
      setColumns([]);
      setRows([]);
      setHasNextPage(false);
    } finally {
      setLoading(false);
    }
  }, [projectId, schema, table, column]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setAllColumns([]);
    setColumnKinds(new Map());
    setPage(0);
    setFilterState(emptyFilterState());

    const d = useProjectStore.getState().projects[projectId];
    const driver = d ? DriverFactory.getDriver(d.driver) : null;

    Promise.all([
      useProjectStore.getState().loadColumnDetails(projectId, schema, table),
      driver?.loadEnumTypes?.(projectId) ?? Promise.resolve([]),
    ]).then(([colDetails, enumRows]) => {
      setAllColumns(colDetails.map((c) => c.name));

      const enumLabelMap = buildEnumLabelMap(enumRows);
      const kindMap = new Map<string, FilterColumnInfo>();
      for (const c of colDetails) {
        kindMap.set(c.name, classifyFilterColumnKind(c.dataType, c.udtName, enumLabelMap));
      }
      setColumnKinds(kindMap);

      const seedColumn = pickDisplayColumn(colDetails, column) ?? column;
      const seeded: FilterState = { open: true, conditions: [newColumnCondition(seedColumn, kindMap.get(seedColumn)?.kind ?? "text")] };
      setFilterState(seeded);
      void runQuery(seeded, 0);
    }).catch(() => {
      void runQuery(emptyFilterState(), 0);
    });
    // runQuery is stable for a given projectId/schema/table/column, which are already deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, schema, table, column]);

  const handleFilterChange = (next: FilterState) => setFilterState(next);
  const handleFilterApply = (next: FilterState) => {
    setFilterState(next);
    setPage(0);
    void runQuery(next, 0);
  };

  const goToPage = (nextPage: number) => {
    setPage(nextPage);
    void runQuery(filterState, nextPage);
  };

  const select = (value: string | null) => {
    onSelect(value);
    onOpenChange(false);
  };

  const targetColIdx = columns.indexOf(column);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[720px] p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <ArrowRight className="h-4 w-4 text-primary" />
            Pick a <span className="font-mono">{table}</span> row
          </DialogTitle>
        </DialogHeader>

        {nullable && currentValue.toLowerCase() !== "null" && (
          <div className="px-5 pb-1 flex justify-end">
            <button
              onClick={() => select(null)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <XCircle className="h-3.5 w-3.5" />
              Clear (NULL)
            </button>
          </div>
        )}

        <FilterBar
          state={filterState}
          onChange={handleFilterChange}
          onApply={handleFilterApply}
          columns={allColumns}
          columnKinds={columnKinds}
          builderAvailable
        />

        {error && (
          <div className="flex items-center gap-2 px-5 py-2 text-xs text-destructive font-mono border-t border-border/50">
            <XCircle className="h-3.5 w-3.5 shrink-0" /> {error}
          </div>
        )}

        <div className="h-[320px] border-t border-border/50 flex flex-col">
          {rows.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground font-mono gap-2">
              {loading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading...</> : !error && "No matching rows"}
            </div>
          ) : (
            <ResultsGrid
              columns={columns}
              rows={rows}
              onRowClick={(rowIndex) => {
                if (targetColIdx === -1) return;
                select(rows[rowIndex][targetColIdx]);
              }}
            />
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-2 border-t border-border/50 text-xs font-mono text-muted-foreground">
          <span>Page {page + 1}</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => goToPage(page - 1)}
              disabled={page === 0 || loading}
              className="flex items-center gap-1 px-2 py-1 rounded hover:bg-accent hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </button>
            <button
              onClick={() => goToPage(page + 1)}
              disabled={!hasNextPage || loading}
              className="flex items-center gap-1 px-2 py-1 rounded hover:bg-accent hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
