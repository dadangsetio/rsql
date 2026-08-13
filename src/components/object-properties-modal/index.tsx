import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { ActionsContent } from "./actions-tab";
import { ColumnsContent } from "./columns-tab";
import { DDLContent } from "./ddl-tab";
import { ForeignKeysContent } from "./foreign-keys-tab";
import { IndexesContent } from "./indexes-tab";
import { OverviewContent } from "./overview-tab";
import { PropertiesPanelHeader } from "./panel-header";
import { StructureEditorContent } from "./structure-editor";
import type { ObjectPropertiesPanelProps, Tab } from "./types";
import { useObjectData } from "./use-object-data";

export function ObjectPropertiesPanel({
  onClose,
  objectType,
  projectId,
  schema,
  name,
}: ObjectPropertiesPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [copied, setCopied] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [confirmInput, setConfirmInput] = useState("");

  const {
    ddl,
    ddlLoading,
    ddlError,
    tableStats,
    outgoingFKs,
    incomingFKs,
    viewInfo,
    functionMeta,
    matViewStats,
    metaKey,
    getDriver,
    fetchLiveData,
    fetchDDL,
  } = useObjectData(projectId, schema, name, objectType, true);

  const columnDetails = useProjectStore((s) => s.columnDetails);
  const indexes = useProjectStore((s) => s.indexes);
  const constraints = useProjectStore((s) => s.constraints);
  const triggers = useProjectStore((s) => s.triggers);
  const rules = useProjectStore((s) => s.rules);
  const policies = useProjectStore((s) => s.policies);
  const openTab = useTabStore((s) => s.openTab);

  const cols = columnDetails[metaKey];
  const idxs = indexes[metaKey];
  const cons = constraints[metaKey];
  const trigs = triggers[metaKey];
  const rls = rules[metaKey];
  const pols = policies[metaKey];
  const pkCols = new Set((idxs ?? []).filter((i) => i.isPrimary).map((i) => i.columnName));

  useEffect(() => {
    if (activeTab === "ddl" && !ddl && !ddlLoading) {
      void fetchDDL();
    }
  }, [activeTab, ddl, ddlLoading, fetchDDL]);

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const runAction = useCallback(
    async (actionLabel: string) => {
      const driver = getDriver();
      if (!driver?.tableAction) return;
      setActionLoading(true);
      setActionResult(null);
      try {
        const msg = await driver.tableAction(projectId, actionLabel, schema, name, objectType);
        setActionResult({ type: "success", message: msg });
        void fetchLiveData();
      } catch (err: any) {
        setActionResult({
          type: "error",
          message: err?.message ?? "Action failed",
        });
      } finally {
        setActionLoading(false);
        setConfirmAction(null);
      }
    },
    [getDriver, projectId, schema, name, objectType, fetchLiveData],
  );

  const availableTabs: { key: Tab; label: string }[] = [];
  availableTabs.push({ key: "overview", label: "Overview" });
  if (objectType === "table") {
    availableTabs.push({ key: "structure", label: "Structure" });
    availableTabs.push({
      key: "columns",
      label: `Columns${cols ? ` (${cols.length})` : ""}`,
    });
    availableTabs.push({
      key: "indexes",
      label: `Indexes${idxs ? ` (${new Set(idxs.map((i) => i.indexName)).size})` : ""}`,
    });
    availableTabs.push({ key: "fkeys", label: `Foreign Keys` });
  }
  availableTabs.push({ key: "ddl", label: "DDL" });
  availableTabs.push({ key: "actions", label: "Actions" });

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      <PropertiesPanelHeader
        availableTabs={availableTabs}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onClose={onClose}
      />

      <div
        className={cn(
          "flex-1 min-h-0 px-5 pb-5",
          activeTab === "ddl" || activeTab === "structure"
            ? "flex flex-col overflow-hidden"
            : "overflow-y-auto",
        )}
      >
        {activeTab === "structure" && objectType === "table" && (
          <StructureEditorContent
            projectId={projectId}
            schema={schema}
            tableName={name}
            cols={cols}
            idxs={idxs}
            cons={cons}
            outgoingFKs={outgoingFKs}
            getDriver={getDriver}
            onApplied={() => {
              void fetchLiveData();
              useProjectStore.setState((s) => {
                delete s.columnDetails[metaKey];
                delete s.indexes[metaKey];
                delete s.constraints[metaKey];
              });
            }}
            openTab={openTab}
            onClose={onClose}
          />
        )}
        {activeTab === "overview" && (
          <OverviewContent
            objectType={objectType}
            schema={schema}
            name={name}
            projectId={projectId}
            tableStats={tableStats}
            viewInfo={viewInfo}
            matViewStats={matViewStats}
            functionMeta={functionMeta}
            cons={cons}
            trigs={trigs}
            rls={rls}
            pols={pols}
            copyText={copyText}
            copied={copied}
          />
        )}
        {activeTab === "columns" && <ColumnsContent cols={cols} pkCols={pkCols} />}
        {activeTab === "indexes" && <IndexesContent idxs={idxs} />}
        {activeTab === "fkeys" && (
          <ForeignKeysContent
            outgoingFKs={outgoingFKs}
            incomingFKs={incomingFKs}
            openTab={openTab}
            projectId={projectId}
            onClose={onClose}
          />
        )}
        {activeTab === "ddl" && (
          <DDLContent
            ddl={ddl}
            ddlLoading={ddlLoading}
            ddlError={ddlError}
            copied={copied}
            onCopy={() => ddl && copyText(ddl, "ddl")}
            onRetry={fetchDDL}
            onOpenInTab={() => {
              if (ddl) {
                openTab(projectId, ddl);
                onClose();
              }
            }}
          />
        )}
        {activeTab === "actions" && (
          <ActionsContent
            objectType={objectType}
            schema={schema}
            name={name}
            actionResult={actionResult}
            actionLoading={actionLoading}
            confirmAction={confirmAction}
            setConfirmAction={(v) => {
              setConfirmAction(v);
              setConfirmInput("");
            }}
            confirmInput={confirmInput}
            setConfirmInput={setConfirmInput}
            runAction={runAction}
            openTab={openTab}
            projectId={projectId}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
