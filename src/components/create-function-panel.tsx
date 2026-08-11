import Editor from "@monaco-editor/react";
import { AlertTriangle, Copy, FileCode, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PG_COMMON_TYPES } from "@/lib/alter-table-sql";
import { DriverFactory } from "@/lib/database-driver";
import type { FunctionParam } from "@/lib/function-sql";
import {
  generateCreateFunctionOrProcedureSQL,
  parseFunctionArguments,
  validIdentifier,
} from "@/lib/function-sql";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { useUIStore } from "@/stores/ui-store";

type Volatility = "IMMUTABLE" | "STABLE" | "VOLATILE";
type ParallelSafety = "SAFE" | "RESTRICTED" | "UNSAFE";

const PARAM_MODES: FunctionParam["mode"][] = ["IN", "OUT", "INOUT", "VARIADIC"];
const LANGUAGES = ["plpgsql", "sql", "plperl", "plpython3u"];

const inputClass =
  "h-7 px-2 text-xs font-mono bg-background border border-border/30 rounded-md outline-none focus:border-primary/50";
const labelClass = "text-[10px] font-medium text-muted-foreground uppercase tracking-wide";

const DEFAULT_BODY = "BEGIN\n  \nEND;";

let paramSeq = 0;
function newParam(): FunctionParam {
  paramSeq += 1;
  return { id: `new${paramSeq}`, mode: "IN", name: "", type: "text", defaultValue: "" };
}

export function CreateFunctionPanel({
  projectId,
  schema,
  tabId,
  initialIsProcedure,
  editName,
}: {
  projectId: string;
  schema: string;
  tabId: string;
  initialIsProcedure: boolean;
  editName?: string;
}) {
  const isEdit = !!editName;
  const [name, setName] = useState(editName ?? (initialIsProcedure ? "new_procedure" : "new_func"));
  const [isProcedure, setIsProcedure] = useState(initialIsProcedure);
  const [params, setParams] = useState<FunctionParam[]>([]);
  // Non-null when pg_get_function_arguments could not be parsed into rows — the
  // original text is then spliced into the signature verbatim.
  const [rawArgs, setRawArgs] = useState<string | null>(null);
  const [returnType, setReturnType] = useState("void");
  const [language, setLanguage] = useState("plpgsql");
  const [customLanguage, setCustomLanguage] = useState(false);
  const [volatility, setVolatility] = useState<Volatility>("VOLATILE");
  const [strict, setStrict] = useState(false);
  const [securityDefiner, setSecurityDefiner] = useState(false);
  const [parallelSafety, setParallelSafety] = useState<ParallelSafety>("UNSAFE");
  const [body, setBody] = useState(DEFAULT_BODY);
  const [loading, setLoading] = useState(isEdit);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);

  const theme = useUIStore((s) => s.theme);
  const loadSchemaObjects = useProjectStore((s) => s.loadSchemaObjects);
  const openTab = useTabStore((s) => s.openTab);
  const closeTabById = useTabStore((s) => s.closeTabById);

  const getDriver = () => {
    const d = useProjectStore.getState().projects[projectId];
    if (!d) return null;
    return DriverFactory.getDriver(d.driver);
  };

  useEffect(() => {
    if (!editName) return;
    let cancelled = false;
    const load = async () => {
      const project = useProjectStore.getState().projects[projectId];
      const driver = project ? DriverFactory.getDriver(project.driver) : null;
      if (!driver?.loadFunctionInfo) {
        setLoading(false);
        return;
      }
      try {
        const pairs = await driver.loadFunctionInfo(projectId, schema, editName);
        if (cancelled) return;
        const info = Object.fromEntries(pairs);
        const parsed = parseFunctionArguments(info.arguments ?? "");
        if (parsed) setParams(parsed);
        else setRawArgs(info.arguments ?? "");
        if (info.return_type) setReturnType(info.return_type);
        if (info.language) {
          setLanguage(info.language);
          setCustomLanguage(!LANGUAGES.includes(info.language));
        }
        if (info.volatility) setVolatility(info.volatility as Volatility);
        if (info.parallel_safety) setParallelSafety(info.parallel_safety as ParallelSafety);
        setStrict(info.is_strict === "true");
        setSecurityDefiner(info.security_definer === "true");
        setBody(info.source ?? "");
        if (info.prokind) setIsProcedure(info.prokind === "p");
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? "Failed to load function definition");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, schema, editName]);

  const trimmedName = name.trim();
  const validName = validIdentifier(trimmedName);
  const paramError = params.some((p) => p.name.trim() && !validIdentifier(p.name))
    ? "Parameter names must be valid identifiers"
    : params.some((p) => !p.type.trim())
      ? "Every parameter needs a type"
      : null;
  const canSubmit =
    !loading &&
    validName &&
    !paramError &&
    (isProcedure || returnType.trim().length > 0) &&
    body.trim().length > 0;

  const sql = useMemo(() => {
    if (!canSubmit) return "";
    return generateCreateFunctionOrProcedureSQL({
      schema,
      name: trimmedName,
      isProcedure,
      params: rawArgs ?? params,
      returnType,
      language,
      volatility,
      strict,
      securityDefiner,
      parallelSafety,
      body,
    });
  }, [
    canSubmit,
    schema,
    trimmedName,
    isProcedure,
    rawArgs,
    params,
    returnType,
    language,
    volatility,
    strict,
    securityDefiner,
    parallelSafety,
    body,
  ]);

  const updateParam = (id: string, updates: Partial<FunctionParam>) => {
    setParams((prev) => prev.map((p) => (p.id === id ? { ...p, ...updates } : p)));
  };

  const handleSubmit = async () => {
    const driver = getDriver();
    if (!driver || !sql) return;
    setApplying(true);
    setError(null);
    try {
      await driver.runQuery(projectId, "BEGIN");
      try {
        await driver.runQuery(projectId, sql);
        await driver.runQuery(projectId, "COMMIT");
      } catch (err) {
        await driver.runQuery(projectId, "ROLLBACK").catch(() => {});
        throw err;
      }
      const kind = isProcedure ? "Procedure" : "Function";
      toast.success(`${kind} "${trimmedName}" ${isEdit ? "updated" : "created"}`);
      const key = `${projectId}::${schema}`;
      useProjectStore.setState((s) => {
        delete s.views[key];
        delete s.functions[key];
      });
      void loadSchemaObjects(projectId, schema);
      closeTabById(tabId);
    } catch (err: any) {
      setError(err?.message ?? "Failed to save");
    } finally {
      setApplying(false);
    }
  };

  const submitLabel = isEdit
    ? "Save Changes"
    : isProcedure
      ? "Create Procedure"
      : "Create Function";

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b px-4 py-2 shrink-0">
        <FileCode className="h-4 w-4 text-primary shrink-0" />
        <span className="font-mono text-sm font-semibold shrink-0">
          {isEdit ? "Edit" : "New"} {isProcedure ? "Procedure" : "Function"}
        </span>
        <input
          type="text"
          value={name}
          disabled={isEdit}
          onChange={(e) => setName(e.target.value)}
          placeholder="function_name"
          className={cn(
            "h-7 px-2.5 text-sm font-mono bg-background border rounded-md outline-none focus:border-primary/50 w-56 disabled:opacity-60",
            validName ? "border-border/30" : "border-destructive/50",
          )}
        />
        <span className="font-mono text-xs text-muted-foreground shrink-0">in {schema}</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-3 text-[11px]"
          onClick={() => closeTabById(tabId)}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-7 px-3 text-[11px]"
          disabled={applying || !canSubmit}
          onClick={() => void handleSubmit()}
        >
          {applying ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
          {submitLabel}
        </Button>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading definition...
        </div>
      ) : (
        <>
          <div className="shrink-0 border-b px-4 py-3 flex flex-col gap-3 max-h-[45%] overflow-y-auto">
            <div className="flex gap-0.5 bg-background/30 rounded-lg p-0.5 border border-border/20 w-fit">
              {[false, true].map((proc) => (
                <button
                  key={proc ? "procedure" : "function"}
                  type="button"
                  disabled={isEdit}
                  onClick={() => setIsProcedure(proc)}
                  className={cn(
                    "px-2.5 py-1 text-[10px] font-medium rounded-md transition-all disabled:opacity-50",
                    isProcedure === proc
                      ? "bg-background text-foreground shadow-sm shadow-black/10"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {proc ? "Procedure" : "Function"}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className={labelClass}>Parameters</span>
              {rawArgs !== null ? (
                <textarea
                  value={rawArgs}
                  onChange={(e) => setRawArgs(e.target.value)}
                  rows={2}
                  placeholder="x integer, y text DEFAULT 'a'"
                  className="px-2 py-1.5 text-xs font-mono bg-background border border-border/30 rounded-md outline-none focus:border-primary/50 resize-y"
                />
              ) : (
                <>
                  {params.map((p) => (
                    <div key={p.id} className="flex items-center gap-1.5">
                      <select
                        value={p.mode}
                        onChange={(e) =>
                          updateParam(p.id, { mode: e.target.value as FunctionParam["mode"] })
                        }
                        className={cn(inputClass, "w-24")}
                      >
                        {PARAM_MODES.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={p.name}
                        onChange={(e) => updateParam(p.id, { name: e.target.value })}
                        placeholder="name"
                        className={cn(inputClass, "w-40")}
                      />
                      <input
                        type="text"
                        list="pg-function-types"
                        value={p.type}
                        onChange={(e) => updateParam(p.id, { type: e.target.value })}
                        placeholder="type"
                        className={cn(inputClass, "w-44")}
                      />
                      <input
                        type="text"
                        value={p.defaultValue}
                        onChange={(e) => updateParam(p.id, { defaultValue: e.target.value })}
                        placeholder="default (optional)"
                        className={cn(inputClass, "w-48")}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => setParams((prev) => prev.filter((x) => x.id !== p.id))}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px] w-fit"
                    onClick={() => setParams((prev) => [...prev, newParam()])}
                  >
                    <Plus className="h-3 w-3 mr-1" /> Add Parameter
                  </Button>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-end gap-3">
              {!isProcedure && (
                <label className="flex flex-col gap-1">
                  <span className={labelClass}>Returns</span>
                  <input
                    type="text"
                    list="pg-function-types"
                    value={returnType}
                    onChange={(e) => setReturnType(e.target.value)}
                    placeholder="void"
                    className={cn(inputClass, "w-44")}
                  />
                </label>
              )}

              <div className="flex flex-col gap-1">
                <span className={labelClass}>Language</span>
                {customLanguage ? (
                  <input
                    type="text"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className={cn(inputClass, "w-36")}
                  />
                ) : (
                  <select
                    value={language}
                    onChange={(e) => {
                      if (e.target.value === "__other__") {
                        setCustomLanguage(true);
                        return;
                      }
                      setLanguage(e.target.value);
                    }}
                    className={cn(inputClass, "w-36")}
                  >
                    {LANGUAGES.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                    <option value="__other__">Other...</option>
                  </select>
                )}
              </div>

              {!isProcedure && (
                <label className="flex flex-col gap-1">
                  <span className={labelClass}>Volatility</span>
                  <select
                    value={volatility}
                    onChange={(e) => setVolatility(e.target.value as Volatility)}
                    className={cn(inputClass, "w-36")}
                  >
                    <option value="VOLATILE">VOLATILE</option>
                    <option value="STABLE">STABLE</option>
                    <option value="IMMUTABLE">IMMUTABLE</option>
                  </select>
                </label>
              )}

              <label className="flex flex-col gap-1">
                <span className={labelClass}>Security</span>
                <select
                  value={securityDefiner ? "definer" : "invoker"}
                  onChange={(e) => setSecurityDefiner(e.target.value === "definer")}
                  className={cn(inputClass, "w-40")}
                >
                  <option value="invoker">SECURITY INVOKER</option>
                  <option value="definer">SECURITY DEFINER</option>
                </select>
              </label>

              {!isProcedure && (
                <label className="flex flex-col gap-1">
                  <span className={labelClass}>Parallel</span>
                  <select
                    value={parallelSafety}
                    onChange={(e) => setParallelSafety(e.target.value as ParallelSafety)}
                    className={cn(inputClass, "w-36")}
                  >
                    <option value="UNSAFE">UNSAFE</option>
                    <option value="RESTRICTED">RESTRICTED</option>
                    <option value="SAFE">SAFE</option>
                  </select>
                </label>
              )}

              <label className="flex items-center gap-1.5 h-7 text-xs">
                <input
                  type="checkbox"
                  checked={strict}
                  onChange={(e) => setStrict(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                STRICT
              </label>
            </div>

            <datalist id="pg-function-types">
              {PG_COMMON_TYPES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            <div className="px-4 py-1.5 shrink-0 border-b border-border/30">
              <span className={labelClass}>{isProcedure ? "Procedure" : "Function"} Body</span>
            </div>
            <div className="flex-1 min-h-0">
              <Editor
                height="100%"
                defaultLanguage="pgsql"
                language="pgsql"
                theme={theme === "light" ? "rsql-light" : "rsql-dark"}
                value={body}
                onChange={(v) => setBody(v ?? "")}
                options={{
                  automaticLayout: true,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  fontSize: 13,
                  lineNumbers: "on",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  padding: { top: 8, bottom: 8 },
                }}
              />
            </div>
          </div>
        </>
      )}

      <div className="shrink-0 border-t px-4 py-2 flex flex-col gap-2">
        {error && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-xs font-mono">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          {!validName ? (
            <span className="text-[10px] text-destructive">Enter a valid name</span>
          ) : paramError ? (
            <span className="text-[10px] text-destructive">{paramError}</span>
          ) : !isProcedure && !returnType.trim() ? (
            <span className="text-[10px] text-destructive">Enter a return type</span>
          ) : (
            !body.trim() && (
              <span className="text-[10px] text-destructive">Body cannot be empty</span>
            )
          )}
          <div className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={!sql}
            onClick={() => setShowSql((v) => !v)}
          >
            <FileCode className="h-3 w-3 mr-1" />
            {showSql ? "Hide SQL" : "Review SQL"}
          </Button>
        </div>
        {showSql && sql && (
          <div className="rounded-xl border border-border/40 overflow-hidden bg-[hsl(var(--background))]">
            <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b border-border/30">
              <span className="text-[10px] font-mono text-muted-foreground/60">SQL Preview</span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 text-[10px] px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    openTab(projectId, sql);
                    closeTabById(tabId);
                  }}
                >
                  <Play className="h-2.5 w-2.5" /> Open in Tab
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 text-[10px] px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => navigator.clipboard.writeText(sql)}
                >
                  <Copy className="h-2.5 w-2.5" /> Copy
                </Button>
              </div>
            </div>
            <pre className="p-3 text-[11px] font-mono text-foreground/90 overflow-y-auto whitespace-pre-wrap leading-relaxed max-h-[150px] selection:bg-primary/20">
              {sql}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
