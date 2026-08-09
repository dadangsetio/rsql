import { Code2, Plus, X } from "lucide-react";
import type { FilterCondition, FilterOperator, FilterState } from "@/types";
import {
  OPERATORS_BY_KIND,
  OPERATOR_LABELS,
  operatorNeedsValue,
  newColumnCondition,
  newRawCondition,
  type FilterColumnInfo,
  type FilterColumnKind,
} from "@/lib/filter-utils";

const inputClass = "h-7 rounded border border-border bg-input px-2 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";
const selectClass = "h-7 bg-input border border-border rounded text-xs font-mono text-foreground px-1.5 outline-none focus:ring-1 focus:ring-ring cursor-pointer";
// Every row (including the "Where"/"and"/"or" lead-in) aligns to this width so stacked
// conditions read as a column, not a wall of text — the single biggest scan-ability win.
const GUTTER = "w-11 shrink-0 text-right text-[10px] font-mono uppercase tracking-wide text-muted-foreground";
// Sentinel option value in the column dropdown that switches a row to a raw-SQL condition —
// picking it is how you get raw SQL, not a separate mode or a separate "add" button.
const RAW_OPTION = "__raw_sql__";

interface FilterBarProps {
  state: FilterState;
  onChange: (state: FilterState) => void;
  onApply: (state: FilterState) => void;
  columns: string[];
  columnKinds: Map<string, FilterColumnInfo>;
  builderAvailable: boolean;
}

export function FilterBar({ state, onChange, onApply, columns, columnKinds, builderAvailable }: FilterBarProps) {
  const kindFor = (col: string): FilterColumnKind => columnKinds.get(col)?.kind ?? "text";

  const addCondition = () => {
    const next: FilterState = {
      ...state,
      conditions: [
        ...state.conditions,
        builderAvailable && columns.length > 0 ? newColumnCondition(columns[0], kindFor(columns[0])) : newRawCondition(),
      ],
    };
    onChange(next);
  };

  const replaceCondition = (id: string, cond: FilterCondition, apply: boolean) => {
    const next = { ...state, conditions: state.conditions.map((c) => (c.id === id ? cond : c)) };
    onChange(next);
    if (apply) onApply(next);
  };

  const toggleJoin = (id: string) => {
    const next = {
      ...state,
      conditions: state.conditions.map((c) => (c.id === id ? { ...c, join: c.join === "or" ? ("and" as const) : ("or" as const) } : c)),
    };
    onChange(next);
    onApply(next);
  };

  const removeCondition = (id: string) => {
    const next = { ...state, conditions: state.conditions.filter((c) => c.id !== id) };
    onChange(next);
    onApply(next);
  };

  return (
    <div className="flex flex-col gap-1.5 border-b border-border/50 bg-card/60 px-4 py-2.5">
      {state.conditions.map((cond, i) => {
        const kind = cond.type === "column" ? kindFor(cond.column) : "text";
        return (
          <div key={cond.id} className="flex items-center gap-2">
            {i === 0 ? (
              <span className={GUTTER}>Where</span>
            ) : (
              <button onClick={() => toggleJoin(cond.id)} className={`${GUTTER} hover:text-foreground transition-colors`} title="Toggle AND / OR for this condition">
                {cond.join === "or" ? "or" : "and"}
              </button>
            )}

            <div className="flex flex-1 items-center gap-1.5">
              <select
                autoFocus={i === 0 && cond.type === "column"}
                value={cond.type === "raw" ? RAW_OPTION : cond.column}
                onChange={(e) => {
                  if (e.target.value === RAW_OPTION) {
                    replaceCondition(cond.id, { id: cond.id, type: "raw", join: cond.join, sql: "" }, false);
                  } else {
                    const newKind = kindFor(e.target.value);
                    const defaultOp = OPERATORS_BY_KIND[newKind][0];
                    replaceCondition(
                      cond.id,
                      { id: cond.id, type: "column", join: cond.join, column: e.target.value, operator: defaultOp, value: "" },
                      !operatorNeedsValue(defaultOp),
                    );
                  }
                }}
                className={`${selectClass} w-32`}
              >
                {builderAvailable && columns.map((c) => <option key={c} value={c}>{c}</option>)}
                <option value={RAW_OPTION}>Raw SQL</option>
              </select>

              {cond.type === "raw" ? (
                <>
                  <Code2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <input
                    type="text"
                    autoFocus={i === 0}
                    placeholder="status = 'active' or archived is true"
                    value={cond.sql}
                    onChange={(e) => replaceCondition(cond.id, { ...cond, sql: e.target.value }, false)}
                    onKeyDown={(e) => { if (e.key === "Enter") replaceCondition(cond.id, cond, true); }}
                    onBlur={() => replaceCondition(cond.id, cond, true)}
                    className={`${inputClass} flex-1 min-w-0`}
                  />
                </>
              ) : (
                <>
                  <select
                    value={cond.operator}
                    onChange={(e) => {
                      const op = e.target.value as FilterOperator;
                      replaceCondition(cond.id, { ...cond, operator: op, value: "", value2: undefined }, !operatorNeedsValue(op));
                    }}
                    className={`${selectClass} w-28`}
                  >
                    {OPERATORS_BY_KIND[kind].map((op) => (
                      <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>
                    ))}
                  </select>
                  {operatorNeedsValue(cond.operator) && (
                    <div className="flex flex-1 items-center gap-1.5">
                      <ValueInput
                        kind={kind}
                        columnKinds={columnKinds}
                        column={cond.column}
                        operator={cond.operator}
                        value={cond.value}
                        onChange={(v) => replaceCondition(cond.id, { ...cond, value: v }, false)}
                        onApply={() => replaceCondition(cond.id, cond, true)}
                      />
                      {cond.operator === "between" && (
                        <>
                          <span className="text-[10px] font-mono text-muted-foreground shrink-0">and</span>
                          <ValueInput
                            kind={kind}
                            columnKinds={columnKinds}
                            column={cond.column}
                            operator={cond.operator}
                            value={cond.value2 ?? ""}
                            onChange={(v) => replaceCondition(cond.id, { ...cond, value2: v }, false)}
                            onApply={() => replaceCondition(cond.id, cond, true)}
                          />
                        </>
                      )}
                    </div>
                  )}
                </>
              )}

              <button
                onClick={() => removeCondition(cond.id)}
                className="ml-auto shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                title="Remove condition"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
        );
      })}

      <div className="flex items-center gap-2">
        <span className={GUTTER} aria-hidden />
        <button
          onClick={addCondition}
          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
            state.conditions.length === 0 ? "border border-dashed border-border" : ""
          }`}
        >
          <Plus className="h-3 w-3" />
          {state.conditions.length === 0 ? "Add condition" : "Add another"}
        </button>
      </div>
    </div>
  );
}

function ValueInput({
  kind,
  columnKinds,
  column,
  operator,
  value,
  onChange,
  onApply,
}: {
  kind: FilterColumnKind;
  columnKinds: Map<string, FilterColumnInfo>;
  column: string;
  operator: FilterOperator;
  value: string;
  onChange: (v: string) => void;
  onApply: () => void;
}) {
  const shared = {
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter") onApply(); },
    onBlur: onApply,
    className: `${inputClass} flex-1 min-w-0`,
  };

  if (kind === "date") return <input type="date" {...shared} />;
  if (kind === "time") return <input type="time" {...shared} />;
  if (kind === "timestamp") return <input type="datetime-local" {...shared} />;
  if (kind === "enum" && operator !== "in") {
    const options = columnKinds.get(column)?.enumValues ?? [];
    return (
      <select value={value} onChange={(e) => { onChange(e.target.value); onApply(); }} className={`${selectClass} flex-1 min-w-0`}>
        <option value="">—</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return <input type="text" placeholder={operator === "in" ? "value1, value2" : "value"} {...shared} />;
}
