import { Plus, Trash2 } from "lucide-react";
import type { DraftTrigger } from "@/lib/alter-table-sql";
import { cn } from "@/lib/utils";
import { uid } from "./initialization";

const TIMINGS: DraftTrigger["timing"][] = ["BEFORE", "AFTER"];
const EVENTS: DraftTrigger["events"][number][] = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"];

export function TriggersSection({
  triggers,
  setTriggers,
  tableName,
  schema,
  availableFunctions,
}: {
  triggers: DraftTrigger[];
  setTriggers: React.Dispatch<React.SetStateAction<DraftTrigger[]>>;
  tableName: string;
  schema: string;
  availableFunctions: string[];
}) {
  const update = (id: string, updates: Partial<DraftTrigger>) => {
    setTriggers((prev) => prev.map((t) => (t._id === id ? { ...t, ...updates } : t)));
  };

  const toggleEvent = (id: string, event: DraftTrigger["events"][number]) => {
    setTriggers((prev) =>
      prev.map((t) =>
        t._id === id
          ? {
              ...t,
              events: t.events.includes(event)
                ? t.events.filter((e) => e !== event)
                : [...t.events, event],
            }
          : t,
      ),
    );
  };

  return (
    <div className="space-y-3 py-1">
      {triggers.map((t) => (
        <div
          key={t._id}
          className="rounded-xl border border-green-500/20 bg-green-500/5 px-3.5 py-3 space-y-2"
        >
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={t.name}
              onChange={(e) => update(t._id, { name: e.target.value })}
              className="flex-1 h-7 px-2 text-xs font-mono bg-background border border-border/30 rounded-md outline-none focus:border-primary/50"
              placeholder="Trigger name"
            />
            <select
              value={t.timing}
              onChange={(e) => update(t._id, { timing: e.target.value as DraftTrigger["timing"] })}
              className="h-7 px-2 text-xs font-mono bg-background border border-border/30 rounded-md outline-none focus:border-primary/50"
            >
              {TIMINGS.map((timing) => (
                <option key={timing} value={timing}>
                  {timing}
                </option>
              ))}
            </select>
            <select
              value={t.forEachRow ? "ROW" : "STATEMENT"}
              onChange={(e) => update(t._id, { forEachRow: e.target.value === "ROW" })}
              className="h-7 px-2 text-xs font-mono bg-background border border-border/30 rounded-md outline-none focus:border-primary/50"
            >
              <option value="ROW">FOR EACH ROW</option>
              <option value="STATEMENT">FOR EACH STATEMENT</option>
            </select>
            <button
              type="button"
              onClick={() => setTriggers((prev) => prev.filter((x) => x._id !== t._id))}
              className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="text-[9px] text-muted-foreground/60 uppercase tracking-wider font-semibold">
            Events
          </div>
          <div className="flex flex-wrap gap-1.5">
            {EVENTS.map((event) => {
              const selected = t.events.includes(event);
              return (
                <button
                  key={event}
                  type="button"
                  onClick={() => toggleEvent(t._id, event)}
                  className={cn(
                    "px-2 py-0.5 text-[10px] font-mono rounded-md border transition-all",
                    selected
                      ? "bg-primary/10 border-primary/30 text-foreground"
                      : "border-border/20 text-muted-foreground hover:border-border/40",
                  )}
                >
                  {event}
                </button>
              );
            })}
          </div>

          <div className="text-[9px] text-muted-foreground/60 uppercase tracking-wider font-semibold">
            Execute function
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={t.functionSchema}
              onChange={(e) => update(t._id, { functionSchema: e.target.value })}
              placeholder={schema}
              className="w-28 h-7 px-2 text-xs font-mono bg-background border border-border/30 rounded-md outline-none focus:border-primary/50 placeholder:text-muted-foreground/30"
            />
            <span className="text-muted-foreground/40">.</span>
            <input
              type="text"
              list="trigger-functions"
              value={t.functionName}
              onChange={(e) => update(t._id, { functionName: e.target.value })}
              placeholder="function_name"
              className="flex-1 h-7 px-2 text-xs font-mono bg-background border border-border/30 rounded-md outline-none focus:border-primary/50 placeholder:text-muted-foreground/30"
            />
          </div>
        </div>
      ))}
      <datalist id="trigger-functions">
        {availableFunctions.map((fn) => (
          <option key={fn} value={fn} />
        ))}
      </datalist>
      <button
        type="button"
        onClick={() => {
          setTriggers((prev) => [
            ...prev,
            {
              _id: uid(),
              name: `${tableName}_trigger_${prev.length + 1}`,
              timing: "BEFORE",
              events: ["INSERT"],
              forEachRow: true,
              functionSchema: schema,
              functionName: "",
            },
          ]);
        }}
        className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 rounded-lg transition-colors w-full"
      >
        <Plus className="h-3.5 w-3.5" /> Add Trigger
      </button>
    </div>
  );
}
