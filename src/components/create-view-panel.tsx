import Editor from "@monaco-editor/react";
import { AlertTriangle, Copy, Eye, FileCode, Layers, Loader2, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DriverFactory } from "@/lib/database-driver";
import { cn } from "@/lib/utils";
import {
  generateCreateMatviewSQL,
  generateCreateViewSQL,
  generateReplaceMatviewSQL,
  generateReplaceViewSQL,
  validViewName,
} from "@/lib/view-sql";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { useUIStore } from "@/stores/ui-store";

const DEFAULT_BODY = "SELECT * FROM ";

export function CreateViewPanel({
  projectId,
  schema,
  tabId,
  isMaterialized,
  editName,
}: {
  projectId: string;
  schema: string;
  tabId: string;
  isMaterialized: boolean;
  editName?: string;
}) {
  const isEdit = !!editName;
  const [viewName, setViewName] = useState(
    editName ?? (isMaterialized ? "new_matview" : "new_view"),
  );
  const [selectBody, setSelectBody] = useState(isEdit ? "" : DEFAULT_BODY);
  const [withCheckOption, setWithCheckOption] = useState(false);
  const [withData, setWithData] = useState(true);
  const [loadingDefinition, setLoadingDefinition] = useState(isEdit);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);

  const theme = useUIStore((s) => s.theme);
  const loadSchemaObjects = useProjectStore((s) => s.loadSchemaObjects);
  const openTab = useTabStore((s) => s.openTab);
  const closeTabById = useTabStore((s) => s.closeTabById);

  const kindLabel = isMaterialized ? "Materialized View" : "View";
  const Icon = isMaterialized ? Layers : Eye;

  useEffect(() => {
    if (!editName) return;
    let cancelled = false;
    const load = async () => {
      const project = useProjectStore.getState().projects[projectId];
      if (!project) return;
      const driver = DriverFactory.getDriver(project.driver);
      try {
        const info = isMaterialized
          ? await driver.loadMatviewInfo?.(projectId, schema, editName)
          : await driver.loadViewInfo?.(projectId, schema, editName);
        if (cancelled || !info) return;
        const infoMap = Object.fromEntries(info);
        setSelectBody(infoMap.definition ?? "");
        if (!isMaterialized) {
          setWithCheckOption((infoMap.check_option ?? "NONE") !== "NONE");
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? "Failed to load definition");
      } finally {
        if (!cancelled) setLoadingDefinition(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, schema, editName, isMaterialized]);

  const validName = validViewName(viewName);
  const canCreate = validName && selectBody.trim().length > 0 && !loadingDefinition;

  const sqlStatements = useMemo((): string[] => {
    if (!validName || !selectBody.trim()) return [];
    const name = viewName.trim();
    if (isMaterialized) {
      return isEdit
        ? generateReplaceMatviewSQL(schema, name, selectBody, withData)
        : [generateCreateMatviewSQL(schema, name, selectBody, withData)];
    }
    return [
      isEdit
        ? generateReplaceViewSQL(schema, name, selectBody, withCheckOption)
        : generateCreateViewSQL(schema, name, selectBody, withCheckOption),
    ];
  }, [schema, viewName, selectBody, isMaterialized, isEdit, withData, withCheckOption, validName]);
  const sqlPreview = sqlStatements.join("\n");

  const handleApply = async () => {
    const project = useProjectStore.getState().projects[projectId];
    if (!project || sqlStatements.length === 0) return;
    const driver = DriverFactory.getDriver(project.driver);
    const name = viewName.trim();
    setApplying(true);
    setError(null);
    try {
      await driver.runQuery(projectId, "BEGIN");
      try {
        for (const stmt of sqlStatements) {
          await driver.runQuery(projectId, stmt);
        }
        await driver.runQuery(projectId, "COMMIT");
      } catch (err) {
        await driver.runQuery(projectId, "ROLLBACK").catch(() => {});
        throw err;
      }
      toast.success(`${kindLabel} "${name}" ${isEdit ? "updated" : "created"}`);
      const key = `${projectId}::${schema}`;
      useProjectStore.setState((s) => {
        delete s.views[key];
        delete s.materializedViews[key];
      });
      void loadSchemaObjects(projectId, schema);
      closeTabById(tabId);
    } catch (err: any) {
      setError(err?.message ?? `Failed to ${isEdit ? "update" : "create"} ${kindLabel}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b px-4 py-2 shrink-0">
        <Icon className="h-4 w-4 text-primary shrink-0" />
        <span className="font-mono text-sm font-semibold shrink-0">
          {isEdit ? `Edit ${kindLabel}` : `New ${kindLabel}`}
        </span>
        <input
          type="text"
          value={viewName}
          disabled={isEdit}
          onChange={(e) => setViewName(e.target.value)}
          placeholder={isMaterialized ? "matview_name" : "view_name"}
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
          disabled={applying || !canCreate}
          onClick={() => void handleApply()}
        >
          {applying ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
          {isEdit ? "Save Changes" : `Create ${kindLabel}`}
        </Button>
      </div>

      {isEdit && isMaterialized && (
        <div className="shrink-0 flex items-center gap-2 mx-4 mt-2 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-xs">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>
            Editing a materialized view drops and recreates it — any indexes, permissions, or grants
            on it will be lost.
          </span>
        </div>
      )}

      <div className="flex items-center gap-3 px-4 py-2 shrink-0">
        <span className="text-[11px] font-medium text-muted-foreground">SELECT Statement</span>
        <div className="flex-1" />
        {isMaterialized ? (
          <div className="flex gap-0.5 bg-background/30 rounded-lg p-0.5 border border-border/20">
            {[
              { value: true, label: "WITH DATA" },
              { value: false, label: "WITH NO DATA" },
            ].map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => setWithData(opt.value)}
                className={cn(
                  "px-2.5 py-1 text-[10px] font-medium rounded-md transition-all",
                  withData === opt.value
                    ? "bg-background text-foreground shadow-sm shadow-black/10"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        ) : (
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={withCheckOption}
              onChange={(e) => setWithCheckOption(e.target.checked)}
              className="h-3 w-3 accent-primary"
            />
            WITH CHECK OPTION
          </label>
        )}
      </div>

      <div className="flex-1 min-h-0 border-y">
        {loadingDefinition ? (
          <div className="flex h-full items-center justify-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading definition...
          </div>
        ) : (
          <Editor
            height="100%"
            defaultLanguage="pgsql"
            language="pgsql"
            theme={theme === "light" ? "rsql-light" : "rsql-dark"}
            options={{
              automaticLayout: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 13,
              lineNumbers: "on",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              padding: { top: 8, bottom: 8 },
            }}
            value={selectBody}
            onChange={(v) => setSelectBody(v ?? "")}
          />
        )}
      </div>

      <div className="shrink-0 px-4 py-2 flex flex-col gap-2">
        {error && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-xs font-mono">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          {!validName ? (
            <span className="text-[10px] text-destructive">
              Enter a valid {kindLabel.toLowerCase()} name
            </span>
          ) : (
            !selectBody.trim() && (
              <span className="text-[10px] text-destructive">Enter a SELECT statement</span>
            )
          )}
          <div className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={!canCreate}
            onClick={() => setShowSql((v) => !v)}
          >
            <FileCode className="h-3 w-3 mr-1" />
            {showSql ? "Hide SQL" : "Review SQL"}
          </Button>
        </div>
        {showSql && sqlStatements.length > 0 && (
          <div className="rounded-xl border border-border/40 overflow-hidden bg-[hsl(var(--background))]">
            <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b border-border/30">
              <span className="text-[10px] font-mono text-muted-foreground/60">SQL Preview</span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 text-[10px] px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    openTab(projectId, sqlPreview);
                    closeTabById(tabId);
                  }}
                >
                  <Play className="h-2.5 w-2.5" /> Open in Tab
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 text-[10px] px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => navigator.clipboard.writeText(sqlPreview)}
                >
                  <Copy className="h-2.5 w-2.5" /> Copy
                </Button>
              </div>
            </div>
            <pre className="p-3 text-[11px] font-mono text-foreground/90 overflow-y-auto whitespace-pre-wrap leading-relaxed max-h-[150px] selection:bg-primary/20">
              {sqlPreview}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
