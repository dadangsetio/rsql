# Sidebar Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the always-expanded, everything-visible server/database tree in `src/components/server-sidebar.tsx` with a focused single-database view: two top buttons (Connection / Databases) open picker dialogs, a fixed tab strip lists open databases, and the tree below shows only the active tab's schema content.

**Architecture:** Split the current 992-line `server-sidebar.tsx` into a thin container plus five focused files (two `src/lib` pure-logic modules, three `src/components/sidebar` UI modules). `ui-store.ts` gains the new navigation state (`activeServerFp`, `openDatabaseTabs`, `activeDatabaseTab`) and its actions. All existing per-item behavior (expand/load/context menus/DDL generation/CSV import/properties/backup/restore) is moved, not rewritten — only how a database becomes "active" and how a server/database is *picked* changes.

**Tech Stack:** React 18 + TypeScript, Zustand + immer stores, Radix Dialog (`src/components/ui/dialog.tsx`), Tailwind, lucide-react icons. No test framework is configured in this project (`package.json` has no vitest/jest); pure-logic modules get an ad hoc `assert`-based `.selfcheck.ts` script run via `npx tsx`, matching the existing `src/lib/filter-utils.selfcheck.ts` convention. React components are verified via `npm run build` (tsc) plus a manual walkthrough in the running app — this was called out and approved in the spec's Testing section.

## Global Constraints

- Keep files under 500 lines (project CLAUDE.md rule) — this drove the file split below.
- Never add a new dependency for what existing primitives (`Dialog`, `Button`, `ContextMenu`) already cover.
- No backend "disconnect" RPC exists (only `deleteProject`, which removes the saved connection entirely). Closing a tab is a client-side-only status change to `Disconnected` plus removal from `openDatabaseTabs`; reopening reconnects normally.
- `ServerSidebar`'s external prop signature (`{ onEditConnection?: (projectId: string) => void }`) must not change — `src/App.tsx:435` passes it and must not need edits.
- Preserve every existing per-item action (schema/table/view/matview/function/trigger-function context menus, DDL generation, CSV import, Properties, ERD, Backup/Restore, LISTEN/NOTIFY, Schema Diff, Extensions, Enum Types, Performance Monitor, PG Settings) — only *where* the action is reachable from changes, per the mapping in Task 6 and Task 9.

---

## Task Dependency Graph

```
Group A (fully independent, run in parallel):
  Task 1: ui-store.ts navigation state
  Task 2: src/lib/ddl-queries.ts
  Task 3: src/lib/server-groups.ts
  Task 4: src/components/sidebar/tree-row.tsx

Group B (each depends only on specific Group A tasks; independent of each other):
  Task 5: src/components/sidebar/database-tree.tsx      (needs Task 2, Task 4)
  Task 6: src/components/sidebar/open-database-tabs.tsx  (needs Task 1)
  Task 7: src/components/sidebar/connection-picker-dialog.tsx (needs Task 1, Task 3)
  Task 8: src/components/sidebar/database-picker-dialog.tsx   (needs Task 1, Task 3)

Group C (final integration, needs all of Group B):
  Task 9: rewrite src/components/server-sidebar.tsx
```

---

### Task 1: `ui-store.ts` navigation state

**Files:**
- Modify: `src/stores/ui-store.ts`
- Test: `src/stores/ui-store.selfcheck.ts` (new)

**Interfaces:**
- Consumes: `useProjectStore` (`@/stores/project-store`) — `getState().status`, `getState().connect(projectId)`, `setState`. `ProjectConnectionStatus` from `@/types`.
- Produces: `useUIStore` gains `activeServerFp: string | null`, `openDatabaseTabs: string[]`, `activeDatabaseTab: string | null`, `setActiveServerFp(fp: string | null): void`, `openDatabaseTab(projectId: string): void`, `closeDatabaseTab(projectId: string): void`, `setActiveDatabaseTab(projectId: string): void`. Also exports a pure helper `nextActiveTabAfterClose(openTabs: string[], closingPid: string, currentActive: string | null): string | null` for Tasks 6 and 9 to reason about tab-close behavior if needed (not required elsewhere, but keep it exported for the selfcheck).

- [ ] **Step 1: Write the failing selfcheck**

Create `src/stores/ui-store.selfcheck.ts`:

```ts
// Ad hoc self-check for the tab-close reducer in ui-store.ts. No framework — run with:
//   npx tsx src/stores/ui-store.selfcheck.ts
import assert from "node:assert";
import { nextActiveTabAfterClose } from "./ui-store";

// Closing a tab that isn't active leaves the active tab untouched
assert.strictEqual(nextActiveTabAfterClose(["a", "b", "c"], "b", "a"), "a");

// Closing the active middle tab activates the previous (left) tab
assert.strictEqual(nextActiveTabAfterClose(["a", "b", "c"], "b", "b"), "a");

// Closing the active first tab activates the new first tab (no "previous" exists)
assert.strictEqual(nextActiveTabAfterClose(["a", "b", "c"], "a", "a"), "b");

// Closing the active last tab activates the previous (now-last) tab
assert.strictEqual(nextActiveTabAfterClose(["a", "b", "c"], "c", "c"), "b");

// Closing the only open tab leaves nothing active
assert.strictEqual(nextActiveTabAfterClose(["a"], "a", "a"), null);

console.log("OK");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx src/stores/ui-store.selfcheck.ts`
Expected: FAIL — `nextActiveTabAfterClose is not a function` (it doesn't exist in `ui-store.ts` yet).

- [ ] **Step 3: Add the pure helper and new state/actions to `ui-store.ts`**

Add these imports at the top of `src/stores/ui-store.ts` (alongside the existing `import type { QueryResult } from "@/types";`):

```ts
import { useProjectStore } from "@/stores/project-store";
import { ProjectConnectionStatus } from "@/types";
```

Add this exported pure function above `const PANEL_POSITION_CYCLE = ...`:

```ts
export function nextActiveTabAfterClose(openTabs: string[], closingPid: string, currentActive: string | null): string | null {
  if (currentActive !== closingPid) return currentActive;
  const idx = openTabs.indexOf(closingPid);
  const remaining = openTabs.filter((pid) => pid !== closingPid);
  if (remaining.length === 0) return null;
  const prevIdx = Math.max(0, idx - 1);
  return remaining[Math.min(prevIdx, remaining.length - 1)];
}
```

In the `UIState` interface, add after `editorPosition: "top" | "right" | "bottom" | "left";`:

```ts
  activeServerFp: string | null;
  openDatabaseTabs: string[];
  activeDatabaseTab: string | null;
```

And after `cyclePanelPosition: () => void;`:

```ts
  setActiveServerFp: (fp: string | null) => void;
  openDatabaseTab: (projectId: string) => void;
  closeDatabaseTab: (projectId: string) => void;
  setActiveDatabaseTab: (projectId: string) => void;
```

In the store implementation, add after `editorPosition: "bottom",`:

```ts
    activeServerFp: null,
    openDatabaseTabs: [],
    activeDatabaseTab: null,
```

And after the existing `cyclePanelPosition: () => {...}` action (before the final `})),`), add:

```ts
    setActiveServerFp: (fp) => set({ activeServerFp: fp }),

    setActiveDatabaseTab: (projectId) => set({ activeDatabaseTab: projectId }),

    openDatabaseTab: (projectId) => {
      set((s) => {
        if (!s.openDatabaseTabs.includes(projectId)) s.openDatabaseTabs.push(projectId);
        s.activeDatabaseTab = projectId;
      });
      const status = useProjectStore.getState().status[projectId];
      if (status !== ProjectConnectionStatus.Connected && status !== ProjectConnectionStatus.Connecting) {
        void useProjectStore.getState().connect(projectId);
      }
    },

    closeDatabaseTab: (projectId) => {
      const { openDatabaseTabs, activeDatabaseTab } = get();
      const nextActive = nextActiveTabAfterClose(openDatabaseTabs, projectId, activeDatabaseTab);
      set((s) => {
        s.openDatabaseTabs = s.openDatabaseTabs.filter((pid) => pid !== projectId);
        s.activeDatabaseTab = nextActive;
      });
      useProjectStore.setState((s) => ({ status: { ...s.status, [projectId]: ProjectConnectionStatus.Disconnected } }));
    },
```

- [ ] **Step 4: Run the selfcheck to verify it passes**

Run: `npx tsx src/stores/ui-store.selfcheck.ts`
Expected: prints `OK`

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors from `ui-store.ts` or `ui-store.selfcheck.ts`

- [ ] **Step 6: Commit**

```bash
git add src/stores/ui-store.ts src/stores/ui-store.selfcheck.ts
git commit -m "feat: add open-database-tab navigation state to ui-store"
```

---

### Task 2: `src/lib/ddl-queries.ts`

**Files:**
- Create: `src/lib/ddl-queries.ts`
- Test: `src/lib/ddl-queries.selfcheck.ts` (new)
- (Later, Task 5 will delete the copies of these three functions from `server-sidebar.tsx` — no edit to `server-sidebar.tsx` in this task.)

**Interfaces:**
- Produces: `ddlTableQuery(schema: string, table: string): string`, `ddlViewQuery(schema: string, view: string): string`, `ddlFunctionQuery(schema: string, fnName: string): string`.

- [ ] **Step 1: Write the failing selfcheck**

Create `src/lib/ddl-queries.selfcheck.ts`:

```ts
// Ad hoc self-check for ddl-queries.ts. No framework — run with:
//   npx tsx src/lib/ddl-queries.selfcheck.ts
import assert from "node:assert";
import { ddlTableQuery, ddlViewQuery, ddlFunctionQuery } from "./ddl-queries";

assert.ok(ddlTableQuery("public", "users").includes(`c.table_schema = 'public' AND c.table_name = 'users'`));
assert.ok(ddlViewQuery("public", "active_users").includes(`pg_get_viewdef('"public"."active_users"'::regclass, true)`));
assert.ok(ddlFunctionQuery("public", "my_fn").includes(`n.nspname = 'public' AND p.proname = 'my_fn'`));

console.log("OK");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx src/lib/ddl-queries.selfcheck.ts`
Expected: FAIL — cannot find module `./ddl-queries`

- [ ] **Step 3: Create `src/lib/ddl-queries.ts`**

```ts
export function ddlTableQuery(schema: string, table: string): string {
  return `-- Generate CREATE TABLE DDL for "${schema}"."${table}"
SELECT 'CREATE TABLE "' || schemaname || '"."' || tablename || '" (' || E'\\n' ||
  string_agg('  "' || column_name || '" ' || data_type ||
    CASE WHEN character_maximum_length IS NOT NULL THEN '(' || character_maximum_length || ')' ELSE '' END ||
    CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END ||
    CASE WHEN column_default IS NOT NULL THEN ' DEFAULT ' || column_default ELSE '' END,
    ',' || E'\\n' ORDER BY ordinal_position) || E'\\n' || ');' AS ddl
FROM information_schema.columns c
JOIN pg_tables t ON t.schemaname = c.table_schema AND t.tablename = c.table_name
WHERE c.table_schema = '${schema}' AND c.table_name = '${table}'
GROUP BY schemaname, tablename;`;
}

export function ddlViewQuery(schema: string, view: string): string {
  return `-- View definition for "${schema}"."${view}"
SELECT pg_get_viewdef('"${schema}"."${view}"'::regclass, true) AS view_definition;`;
}

export function ddlFunctionQuery(schema: string, fnName: string): string {
  return `-- Function definition for "${schema}"."${fnName}"
SELECT pg_get_functiondef(p.oid) AS function_definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = '${schema}' AND p.proname = '${fnName}'
LIMIT 1;`;
}
```

- [ ] **Step 4: Run the selfcheck to verify it passes**

Run: `npx tsx src/lib/ddl-queries.selfcheck.ts`
Expected: prints `OK`

- [ ] **Step 5: Commit**

```bash
git add src/lib/ddl-queries.ts src/lib/ddl-queries.selfcheck.ts
git commit -m "refactor: extract DDL query generators out of server-sidebar"
```

---

### Task 3: `src/lib/server-groups.ts`

**Files:**
- Create: `src/lib/server-groups.ts`
- Test: `src/lib/server-groups.selfcheck.ts` (new)

**Interfaces:**
- Consumes: `ProjectDetails`, `ProjectMap` from `@/types`.
- Produces: `serverFingerprint(d: ProjectDetails): string`, `groupProjectsByServer(projects: ProjectMap): Map<string, string[]>`, `serverLabel(fp: string, pids: string[], projects: ProjectMap): string`.

- [ ] **Step 1: Write the failing selfcheck**

Create `src/lib/server-groups.selfcheck.ts`:

```ts
// Ad hoc self-check for server-groups.ts. No framework — run with:
//   npx tsx src/lib/server-groups.selfcheck.ts
import assert from "node:assert";
import { serverFingerprint, groupProjectsByServer, serverLabel } from "./server-groups";
import type { ProjectMap, ProjectDetails } from "@/types";

const base: Omit<ProjectDetails, "database"> = {
  driver: "PGSQL", username: "postgres", password: "", host: "localhost", port: "5432",
  ssl: "false", sshEnabled: "false", sshHost: "", sshPort: "22", sshUser: "", sshPassword: "", sshKeyPath: "",
};

const projects: ProjectMap = {
  db1: { ...base, database: "db1" },
  db2: { ...base, database: "db2" },
  other_host: { ...base, database: "db3", host: "otherhost" },
};

// db1 and db2 share host/port/username -> same fingerprint
assert.strictEqual(serverFingerprint(projects.db1), serverFingerprint(projects.db2));
// other_host has a different host -> different fingerprint
assert.notStrictEqual(serverFingerprint(projects.db1), serverFingerprint(projects.other_host));

const groups = groupProjectsByServer(projects);
assert.strictEqual(groups.size, 2);
const localFp = serverFingerprint(projects.db1);
assert.deepStrictEqual(new Set(groups.get(localFp)), new Set(["db1", "db2"]));

// Single-project server: label is the project id
assert.strictEqual(serverLabel(serverFingerprint(projects.other_host), ["other_host"], projects), "other_host");
// Multi-project server: label is host:port
assert.strictEqual(serverLabel(localFp, ["db1", "db2"], projects), "localhost:5432");

console.log("OK");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx src/lib/server-groups.selfcheck.ts`
Expected: FAIL — cannot find module `./server-groups`

- [ ] **Step 3: Create `src/lib/server-groups.ts`**

```ts
import type { ProjectDetails, ProjectMap } from "@/types";

export function serverFingerprint(d: ProjectDetails): string {
  return `${d.host}\0${d.port}\0${d.username}\0${d.sshEnabled === "true" ? `${d.sshHost}:${d.sshPort}` : ""}`;
}

export function groupProjectsByServer(projects: ProjectMap): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [pid, d] of Object.entries(projects)) {
    const fp = serverFingerprint(d);
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp)!.push(pid);
  }
  return groups;
}

export function serverLabel(fp: string, pids: string[], projects: ProjectMap): string {
  if (pids.length === 1) return pids[0];
  const d = projects[pids[0]];
  return d ? `${d.host}:${d.port}` : fp;
}
```

- [ ] **Step 4: Run the selfcheck to verify it passes**

Run: `npx tsx src/lib/server-groups.selfcheck.ts`
Expected: prints `OK`

- [ ] **Step 5: Commit**

```bash
git add src/lib/server-groups.ts src/lib/server-groups.selfcheck.ts
git commit -m "refactor: extract server-fingerprint grouping out of server-sidebar"
```

---

### Task 4: `src/components/sidebar/tree-row.tsx`

**Files:**
- Create: `src/components/sidebar/tree-row.tsx`

**Interfaces:**
- Produces: `I` (indent-level constants object: `{ server, cat, db, schema, schemaObj, table, section, item }`), `IndentGuides({ indent: number })`, `TreeRow(props)`, `SectionHeader(props)` — same prop shapes as today's `server-sidebar.tsx` internals (see code below).

This is a mechanical, behavior-preserving move of four internal helpers (currently `src/components/server-sidebar.tsx:53-54` and `:838-927`) into their own file so `database-tree.tsx` (Task 5) can import them instead of redefining them. No test — pure presentational components, verified visually in Task 9's manual walkthrough.

- [ ] **Step 1: Create `src/components/sidebar/tree-row.tsx`**

```tsx
import React from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Indent levels (px)
export const I = { server: 4, cat: 14, db: 24, schema: 32, schemaObj: 40, table: 48, section: 56, item: 64 };

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
  indent, icon, label, bold, expanded, loading: isLoading, trailing, selected,
  onClick, onDoubleClick, onContextMenu, onChevronClick,
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
        isLoading ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
          : onChevronClick ? (
            <span
              role="button"
              onClick={(e) => { e.stopPropagation(); onChevronClick(); }}
              className="shrink-0 -m-1 p-1 rounded-sm hover:bg-black/[0.08] dark:hover:bg-white/[0.12]"
            >
              {expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
            </span>
          ) : expanded ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
      ) : null}
      <span className="shrink-0">{icon}</span>
      <span className={cn("font-mono text-xs", bold && "font-semibold")}>{label}</span>
      {trailing && <span className="ml-auto mr-1">{trailing}</span>}
    </button>
  );
}

/** Collapsible section header */
export function SectionHeader({
  indent, label, icon, expanded, onClick,
}: {
  indent: number;
  label: string;
  icon: React.ReactNode;
  sectionKey?: string;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className="relative flex w-full items-center gap-1.5 py-0.5 text-left hover:bg-sidebar-accent transition-colors rounded-sm whitespace-nowrap"
      style={{ paddingLeft: `${indent}px` }}>
      <IndentGuides indent={indent} />
      {expanded ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
      <span className="shrink-0">{icon}</span>
      <span className="font-mono text-[11px] font-semibold text-muted-foreground">{label}</span>
    </button>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors from this new file (it isn't imported anywhere yet, so it only needs to be self-consistent)

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebar/tree-row.tsx
git commit -m "refactor: extract TreeRow/SectionHeader/IndentGuides out of server-sidebar"
```

---

### Task 5: `src/components/sidebar/database-tree.tsx`

**Files:**
- Create: `src/components/sidebar/database-tree.tsx`

**Interfaces:**
- Consumes: `I`, `TreeRow`, `SectionHeader` from `./tree-row` (Task 4); `ddlTableQuery`, `ddlViewQuery`, `ddlFunctionQuery` from `@/lib/ddl-queries` (Task 2); `useProjectStore` (schemas/tables/columnDetails/indexes/constraints/triggers/rules/policies/views/materializedViews/functions/triggerFunctions/serverTablespaces/status, `loadTables`, `loadColumns`, `loadTableMetadata`, `loadSchemaObjects`, `connect`); `useTabStore` (`openTab`, `openERDTab`, `openRolesTab`); `DriverFactory` from `@/lib/database-driver`; `ObjectPropertiesModal`, `CSVImportModal` (existing components, unchanged props).
- Produces: `DatabaseTree({ projectId }: { projectId: string }): JSX.Element` — the full schema tree (Roles, Tablespaces, then Schemas → Tables/Views/Materialized Views/Functions/Trigger Functions → Columns/Indexes/Constraints/Triggers/Rules/Policies) for exactly one project. Renders nothing extra when disconnected other than a small status line.

This moves `renderSchemas` (today's `server-sidebar.tsx:246-551`), the Roles row (`:704-712`), the Tablespaces block (`:714-744`), and the `propsModal`/`csvImportTarget` state + `ObjectPropertiesModal`/`CSVImportModal` rendering (`:132-145`, `:806-823`) into one component scoped to a single `projectId` instead of iterated per-server.

- [ ] **Step 1: Create `src/components/sidebar/database-tree.tsx`**

```tsx
import React from "react";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { ObjectPropertiesModal } from "@/components/object-properties-modal";
import { CSVImportModal } from "@/components/csv-import-modal";
import { I, TreeRow, SectionHeader } from "./tree-row";
import { ddlTableQuery, ddlViewQuery, ddlFunctionQuery } from "@/lib/ddl-queries";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { DriverFactory } from "@/lib/database-driver";
import { ProjectConnectionStatus } from "@/types";
import {
  Columns3, Copy, Eye, FileCode, FileUp, FolderOpen, HardDrive, Key, Layers,
  Link2, Loader2, Lock, Plus, RefreshCw, ScrollText, Settings2, Shield, Table, Zap,
} from "lucide-react";

export function DatabaseTree({ projectId }: { projectId: string }) {
  const status = useProjectStore((s) => s.status[projectId]);
  const schemas = useProjectStore((s) => s.schemas[projectId] || []);
  const tables = useProjectStore((s) => s.tables);
  const columnDetails = useProjectStore((s) => s.columnDetails);
  const indexes = useProjectStore((s) => s.indexes);
  const constraints = useProjectStore((s) => s.constraints);
  const triggers = useProjectStore((s) => s.triggers);
  const rules = useProjectStore((s) => s.rules);
  const policies = useProjectStore((s) => s.policies);
  const views = useProjectStore((s) => s.views);
  const materializedViews = useProjectStore((s) => s.materializedViews);
  const functions = useProjectStore((s) => s.functions);
  const triggerFunctions = useProjectStore((s) => s.triggerFunctions);
  const serverTablespaces = useProjectStore((s) => s.serverTablespaces[projectId] || []);
  const connect = useProjectStore((s) => s.connect);
  const loadTables = useProjectStore((s) => s.loadTables);
  const loadColumns = useProjectStore((s) => s.loadColumns);
  const loadTableMetadata = useProjectStore((s) => s.loadTableMetadata);
  const loadSchemaObjects = useProjectStore((s) => s.loadSchemaObjects);
  const openTab = useTabStore((s) => s.openTab);
  const openERDTab = useTabStore((s) => s.openERDTab);
  const openRolesTab = useTabStore((s) => s.openRolesTab);
  const { menu, showMenu, closeMenu } = useContextMenu();

  const [propsModal, setPropsModal] = React.useState<{
    open: boolean;
    objectType: "table" | "view" | "matview" | "function" | "trigger-function";
    schema: string;
    name: string;
  }>({ open: false, objectType: "table", schema: "", name: "" });
  const openProperties = (objectType: typeof propsModal.objectType, schema: string, name: string) => {
    setPropsModal({ open: true, objectType, schema, name });
  };

  const [csvImportTarget, setCsvImportTarget] = React.useState<{ schema: string; table: string; columns: string[] } | null>(null);

  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [loading, setLoading] = React.useState<Record<string, boolean>>({});
  const [selectedItem, setSelectedItem] = React.useState<string | null>(null);
  const toggle = (key: string) => setExpanded((p) => ({ ...p, [key]: !p[key] }));
  const isOpen = (key: string, defaultOpen = false) => expanded[key] ?? defaultOpen;
  const setLoad = (key: string, v: boolean) => setLoading((p) => ({ ...p, [key]: v }));
  const copy = (text: string) => navigator.clipboard.writeText(text);

  const onExpandSchema = async (schema: string) => {
    const key = `schema::${schema}`;
    toggle(key);
    if (!isOpen(key)) {
      const tKey = `${projectId}::${schema}`;
      if (!tables[tKey]) {
        setLoad(key, true);
        try {
          await Promise.all([loadTables(projectId, schema), loadSchemaObjects(projectId, schema)]);
        } catch (e) {
          console.error("Failed to load schema objects:", e);
        } finally {
          setLoad(key, false);
        }
      }
    }
  };

  const onExpandTable = async (schema: string, table: string) => {
    const key = `table::${schema}::${table}`;
    toggle(key);
    const metaKey = `${projectId}::${schema}::${table}`;
    if (!isOpen(key) && !columnDetails[metaKey]) {
      setLoad(key, true);
      try {
        await loadTableMetadata(projectId, schema, table);
      } catch (e) {
        console.error("Failed to load table metadata:", e);
      } finally {
        setLoad(key, false);
      }
    }
  };

  const onOpenTableQuery = (schema: string, table: string) => {
    const sql = `SELECT * FROM "${schema}"."${table}" LIMIT 100;`;
    openTab(projectId, sql);
    const d = useProjectStore.getState().projects[projectId];
    if (!d) return;
    const newTabIdx = useTabStore.getState().tabs.length - 1;
    useTabStore.getState().setExecuting(newTabIdx, true);
    const driver = DriverFactory.getDriver(d.driver);
    driver.runQuery(projectId, sql).then(([cols, rows, time]) => {
      useTabStore.getState().updateResult(newTabIdx, { columns: cols, rows, time });
    }).catch(() => {
      useTabStore.getState().setExecuting(newTabIdx, false);
    });
  };

  const isConnected = status === ProjectConnectionStatus.Connected;
  const tspKey = "tablespaces";

  return (
    <div className="p-1">
      {status === ProjectConnectionStatus.Connecting && (
        <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Connecting…
        </div>
      )}
      {status === ProjectConnectionStatus.Failed && (
        <div className="px-3 py-2 text-xs text-destructive">Connection failed.</div>
      )}

      <TreeRow indent={I.cat} icon={<Shield className="h-3.5 w-3.5 text-muted-foreground" />} label="Login/Group Roles"
        onClick={() => {
          if (isConnected) openRolesTab(projectId);
          else void connect(projectId).then(() => {
            if (useProjectStore.getState().status[projectId] === ProjectConnectionStatus.Connected) openRolesTab(projectId);
          });
        }}
      />

      <TreeRow indent={I.cat} icon={<HardDrive className="h-3.5 w-3.5 text-muted-foreground" />}
        label={`Tablespaces${serverTablespaces.length > 0 ? ` (${serverTablespaces.length})` : ""}`}
        expanded={isOpen(tspKey)}
        onClick={() => { if (isConnected) toggle(tspKey); else void connect(projectId); }}
      />
      {isOpen(tspKey) && serverTablespaces.map(([name, owner, location]) => (
        <div key={name} className="relative flex items-center gap-1.5 py-0.5 hover:bg-sidebar-accent rounded-sm whitespace-nowrap"
          style={{ paddingLeft: `${I.db}px` }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); showMenu(e, [
            { label: "Copy Name", icon: <Copy className="h-3 w-3" />, onClick: () => copy(name) },
          ]); }}>
          <HardDrive className="h-3 w-3 shrink-0 text-muted-foreground/50" />
          <span className="font-mono text-[11px] text-foreground">{name}</span>
          <span className="font-mono text-[10px] text-muted-foreground">{owner}</span>
          {location && <span className="font-mono text-[9px] text-muted-foreground/40">{location}</span>}
        </div>
      ))}

      {isConnected && schemas.map((schema) => {
        const sKey = `schema::${schema}`;
        const schemaStoreKey = `${projectId}::${schema}`;
        const schemaTables = tables[schemaStoreKey];
        const schemaViews = views[schemaStoreKey];
        const schemaMatViews = materializedViews[schemaStoreKey];
        const schemaFns = functions[schemaStoreKey];
        const schemaTrigFns = triggerFunctions[schemaStoreKey];
        const isSchemaOpen = isOpen(sKey);

        return (
          <div key={schema}>
            <TreeRow indent={I.schema}
              icon={<FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />}
              label={schema}
              expanded={isSchemaOpen}
              loading={loading[sKey]}
              onClick={() => void onExpandSchema(schema)}
              onContextMenu={(e) => showMenu(e, [
                { label: "ERD Diagram", icon: <Layers className="h-3 w-3" />, onClick: () => openERDTab(projectId, schema) },
                { label: "Copy Schema Name", icon: <Copy className="h-3 w-3" />, onClick: () => copy(schema) },
                { label: "New Query", icon: <Plus className="h-3 w-3" />, onClick: () => openTab(projectId, `-- Schema: ${schema}\n`) },
              ])}
            />

            {isSchemaOpen && (
              <>
                <SectionHeader indent={I.schemaObj} label={`Tables${schemaTables ? ` (${schemaTables.length})` : ""}`}
                  icon={<Table className="h-3 w-3" />} sectionKey={`${sKey}::tables`}
                  expanded={isOpen(`${sKey}::tables`, true)} onClick={() => toggle(`${sKey}::tables`)} />
                {isOpen(`${sKey}::tables`, true) && schemaTables?.map((ti) => {
                  const tKey = `table::${schema}::${ti.name}`;
                  const metaKey = `${projectId}::${schema}::${ti.name}`;
                  const isTableOpen = isOpen(tKey);
                  const cols = columnDetails[metaKey];
                  const idxs = indexes[metaKey];
                  const cons = constraints[metaKey];
                  const trigs = triggers[metaKey];
                  const rls = rules[metaKey];
                  const pols = policies[metaKey];
                  const pkCols = new Set((idxs ?? []).filter((i) => i.isPrimary).map((i) => i.columnName));

                  return (
                    <div key={ti.name}>
                      <TreeRow indent={I.table}
                        icon={<Table className="h-3.5 w-3.5 text-muted-foreground" />}
                        label={ti.name}
                        expanded={isTableOpen}
                        loading={loading[tKey]}
                        selected={selectedItem === tKey}
                        onClick={() => { setSelectedItem(tKey); onOpenTableQuery(schema, ti.name); }}
                        onChevronClick={() => { setSelectedItem(tKey); void onExpandTable(schema, ti.name); }}
                        onContextMenu={(e) => { setSelectedItem(tKey); showMenu(e, [
                          { header: "Query" },
                          { label: "SELECT TOP 100", icon: <Table className="h-3 w-3" />, onClick: () => onOpenTableQuery(schema, ti.name) },
                          { label: "SELECT COUNT(*)", icon: <Table className="h-3 w-3" />, onClick: () => openTab(projectId, `SELECT COUNT(*) FROM "${schema}"."${ti.name}";`) },
                          { separator: true as const },
                          { label: "Import CSV", icon: <FileUp className="h-3 w-3" />, onClick: () => {
                            void loadColumns(projectId, schema, ti.name).then((cols) => {
                              setCsvImportTarget({ schema, table: ti.name, columns: cols });
                            });
                          }},
                          { separator: true as const },
                          { label: "Properties", icon: <Settings2 className="h-3 w-3" />, onClick: () => openProperties("table", schema, ti.name) },
                          { label: "Show CREATE TABLE", icon: <FileCode className="h-3 w-3" />, onClick: () => openTab(projectId, ddlTableQuery(schema, ti.name)) },
                          { separator: true as const },
                          { label: "Copy Name", icon: <Copy className="h-3 w-3" />, onClick: () => copy(`"${schema}"."${ti.name}"`), shortcut: navigator.platform.includes("Mac") ? "⌘C" : "Ctrl+C" },
                        ]); }}
                        trailing={<span className="rounded-full bg-accent/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground shrink-0">{ti.size}</span>}
                      />
                      {isTableOpen && cols && (
                        <>
                          <SectionHeader indent={I.section} label={`Columns (${cols.length})`}
                            icon={<Columns3 className="h-3 w-3" />} sectionKey={`${tKey}::cols`}
                            expanded={isOpen(`${tKey}::cols`, true)} onClick={() => toggle(`${tKey}::cols`)} />
                          {isOpen(`${tKey}::cols`, true) && cols.map((c) => (
                            <div key={c.name} className="relative flex items-center gap-1.5 py-0.5 hover:bg-sidebar-accent rounded-sm whitespace-nowrap"
                              style={{ paddingLeft: `${I.item}px` }}
                              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); showMenu(e, [
                                { label: "Copy Column Name", icon: <Copy className="h-3 w-3" />, onClick: () => copy(c.name) },
                              ]); }}>
                              {pkCols.has(c.name) ? <Key className="h-3 w-3 shrink-0 text-warning" /> : <Columns3 className="h-3 w-3 shrink-0 text-muted-foreground/50" />}
                              <span className="font-mono text-[11px] text-foreground">{c.name}</span>
                              <span className="font-mono text-[10px] text-muted-foreground">{c.dataType}</span>
                              {c.nullable && <span className="font-mono text-[9px] text-muted-foreground/40">NULL</span>}
                            </div>
                          ))}

                          {idxs && idxs.length > 0 && (
                            <>
                              <SectionHeader indent={I.section} label={`Indexes (${new Set(idxs.map((i) => i.indexName)).size})`}
                                icon={<Key className="h-3 w-3" />} sectionKey={`${tKey}::idx`}
                                expanded={isOpen(`${tKey}::idx`)} onClick={() => toggle(`${tKey}::idx`)} />
                              {isOpen(`${tKey}::idx`) && Array.from(new Set(idxs.map((i) => i.indexName))).map((name) => {
                                const idxEntries = idxs.filter((i) => i.indexName === name);
                                const f = idxEntries[0];
                                return (
                                  <div key={name} className="relative flex items-center gap-1.5 py-0.5 hover:bg-sidebar-accent rounded-sm whitespace-nowrap" style={{ paddingLeft: `${I.item}px` }}>
                                    {f.isPrimary ? <Key className="h-3 w-3 shrink-0 text-warning" /> : f.isUnique ? <Shield className="h-3 w-3 shrink-0 text-blue-500" /> : <Key className="h-3 w-3 shrink-0 text-muted-foreground/50" />}
                                    <span className="font-mono text-[11px] text-foreground">{name}</span>
                                    <span className="font-mono text-[10px] text-muted-foreground">({idxEntries.map((e) => e.columnName).join(", ")})</span>
                                    {f.isUnique && <span className="font-mono text-[9px] text-blue-500/60">UNIQUE</span>}
                                  </div>
                                );
                              })}
                            </>
                          )}

                          {cons && cons.length > 0 && (
                            <>
                              <SectionHeader indent={I.section} label={`Constraints (${new Set(cons.map((c) => c.constraintName)).size})`}
                                icon={<Link2 className="h-3 w-3" />} sectionKey={`${tKey}::con`}
                                expanded={isOpen(`${tKey}::con`)} onClick={() => toggle(`${tKey}::con`)} />
                              {isOpen(`${tKey}::con`) && Array.from(new Set(cons.map((c) => c.constraintName))).map((name) => {
                                const f = cons.find((c) => c.constraintName === name)!;
                                return (
                                  <div key={name} className="relative flex items-center gap-1.5 py-0.5 hover:bg-sidebar-accent rounded-sm whitespace-nowrap" style={{ paddingLeft: `${I.item}px` }}>
                                    <Link2 className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                                    <span className="font-mono text-[11px] text-foreground">{name}</span>
                                    <span className="font-mono text-[10px] text-muted-foreground">{f.constraintType}</span>
                                  </div>
                                );
                              })}
                            </>
                          )}

                          {trigs && trigs.length > 0 && (
                            <>
                              <SectionHeader indent={I.section} label={`Triggers (${trigs.length})`}
                                icon={<Zap className="h-3 w-3" />} sectionKey={`${tKey}::trig`}
                                expanded={isOpen(`${tKey}::trig`)} onClick={() => toggle(`${tKey}::trig`)} />
                              {isOpen(`${tKey}::trig`) && trigs.map((t) => (
                                <div key={`${t.triggerName}-${t.event}`} className="relative flex items-center gap-1.5 py-0.5 hover:bg-sidebar-accent rounded-sm whitespace-nowrap" style={{ paddingLeft: `${I.item}px` }}>
                                  <Zap className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                                  <span className="font-mono text-[11px] text-foreground">{t.triggerName}</span>
                                  <span className="font-mono text-[10px] text-muted-foreground">{t.timing} {t.event}</span>
                                </div>
                              ))}
                            </>
                          )}

                          {rls && rls.length > 0 && (
                            <>
                              <SectionHeader indent={I.section} label={`Rules (${rls.length})`}
                                icon={<ScrollText className="h-3 w-3" />} sectionKey={`${tKey}::rules`}
                                expanded={isOpen(`${tKey}::rules`)} onClick={() => toggle(`${tKey}::rules`)} />
                              {isOpen(`${tKey}::rules`) && rls.map((r) => (
                                <div key={r.ruleName} className="relative flex items-center gap-1.5 py-0.5 hover:bg-sidebar-accent rounded-sm whitespace-nowrap" style={{ paddingLeft: `${I.item}px` }}>
                                  <ScrollText className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                                  <span className="font-mono text-[11px] text-foreground">{r.ruleName}</span>
                                  <span className="font-mono text-[10px] text-muted-foreground">{r.event}</span>
                                </div>
                              ))}
                            </>
                          )}

                          {pols && pols.length > 0 && (
                            <>
                              <SectionHeader indent={I.section} label={`RLS Policies (${pols.length})`}
                                icon={<Lock className="h-3 w-3" />} sectionKey={`${tKey}::pol`}
                                expanded={isOpen(`${tKey}::pol`)} onClick={() => toggle(`${tKey}::pol`)} />
                              {isOpen(`${tKey}::pol`) && pols.map((p) => (
                                <div key={p.policyName} className="relative flex items-center gap-1.5 py-0.5 hover:bg-sidebar-accent rounded-sm whitespace-nowrap" style={{ paddingLeft: `${I.item}px` }}>
                                  <Lock className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                                  <span className="font-mono text-[11px] text-foreground">{p.policyName}</span>
                                  <span className="font-mono text-[10px] text-muted-foreground">{p.permissive} {p.command}</span>
                                </div>
                              ))}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}

                {schemaViews && schemaViews.length > 0 && (
                  <>
                    <SectionHeader indent={I.schemaObj} label={`Views (${schemaViews.length})`}
                      icon={<Eye className="h-3 w-3" />} sectionKey={`${sKey}::views`}
                      expanded={isOpen(`${sKey}::views`)} onClick={() => toggle(`${sKey}::views`)} />
                    {isOpen(`${sKey}::views`) && schemaViews.map((v) => {
                      const vKey = `view::${schema}::${v}`;
                      return (
                        <TreeRow key={v} indent={I.table}
                          icon={<Eye className="h-3.5 w-3.5 text-muted-foreground" />}
                          label={v}
                          selected={selectedItem === vKey}
                          onClick={() => { setSelectedItem(vKey); onOpenTableQuery(schema, v); }}
                          onContextMenu={(e) => { setSelectedItem(vKey); showMenu(e, [
                            { label: "SELECT TOP 100", icon: <Eye className="h-3 w-3" />, onClick: () => onOpenTableQuery(schema, v) },
                            { separator: true as const },
                            { label: "Properties", icon: <Settings2 className="h-3 w-3" />, onClick: () => openProperties("view", schema, v) },
                            { label: "Show CREATE VIEW", icon: <FileCode className="h-3 w-3" />, onClick: () => openTab(projectId, ddlViewQuery(schema, v)) },
                            { separator: true as const },
                            { label: "Copy Name", icon: <Copy className="h-3 w-3" />, onClick: () => copy(`"${schema}"."${v}"`) },
                          ]); }}
                        />
                      );
                    })}
                  </>
                )}

                {schemaMatViews && schemaMatViews.length > 0 && (
                  <>
                    <SectionHeader indent={I.schemaObj} label={`Materialized Views (${schemaMatViews.length})`}
                      icon={<Layers className="h-3 w-3" />} sectionKey={`${sKey}::matviews`}
                      expanded={isOpen(`${sKey}::matviews`)} onClick={() => toggle(`${sKey}::matviews`)} />
                    {isOpen(`${sKey}::matviews`) && schemaMatViews.map((mv) => {
                      const mvKey = `matview::${schema}::${mv}`;
                      return (
                        <TreeRow key={mv} indent={I.table}
                          icon={<Layers className="h-3.5 w-3.5 text-muted-foreground" />}
                          label={mv}
                          selected={selectedItem === mvKey}
                          onClick={() => { setSelectedItem(mvKey); onOpenTableQuery(schema, mv); }}
                          onContextMenu={(e) => { setSelectedItem(mvKey); showMenu(e, [
                            { label: "SELECT TOP 100", icon: <Layers className="h-3 w-3" />, onClick: () => onOpenTableQuery(schema, mv) },
                            { label: "REFRESH", icon: <RefreshCw className="h-3 w-3" />, onClick: () => openTab(projectId, `REFRESH MATERIALIZED VIEW "${schema}"."${mv}";`) },
                            { separator: true as const },
                            { label: "Properties", icon: <Settings2 className="h-3 w-3" />, onClick: () => openProperties("matview", schema, mv) },
                            { separator: true as const },
                            { label: "Copy Name", icon: <Copy className="h-3 w-3" />, onClick: () => copy(`"${schema}"."${mv}"`) },
                          ]); }}
                        />
                      );
                    })}
                  </>
                )}

                {schemaFns && schemaFns.length > 0 && (
                  <>
                    <SectionHeader indent={I.schemaObj} label={`Functions (${schemaFns.length})`}
                      icon={<FileCode className="h-3 w-3" />} sectionKey={`${sKey}::fns`}
                      expanded={isOpen(`${sKey}::fns`)} onClick={() => toggle(`${sKey}::fns`)} />
                    {isOpen(`${sKey}::fns`) && schemaFns.map((fn, i) => {
                      const fnKey = `fn::${schema}::${fn.name}::${i}`;
                      return (
                        <div key={`${fn.name}-${i}`}
                          className={selectedItem === fnKey ? "relative flex items-center gap-1.5 py-0.5 rounded-sm whitespace-nowrap select-none bg-primary/10" : "relative flex items-center gap-1.5 py-0.5 rounded-sm whitespace-nowrap select-none hover:bg-sidebar-accent"}
                          style={{ paddingLeft: `${I.table}px` }}
                          onClick={() => setSelectedItem(fnKey)}
                          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedItem(fnKey); showMenu(e, [
                            { label: "Show Definition", icon: <FileCode className="h-3 w-3" />, onClick: () => openTab(projectId, ddlFunctionQuery(schema, fn.name)) },
                            { label: "Properties", icon: <Settings2 className="h-3 w-3" />, onClick: () => openProperties("function", schema, fn.name) },
                            { separator: true as const },
                            { label: "Copy Name", icon: <Copy className="h-3 w-3" />, onClick: () => copy(fn.name) },
                          ]); }}>
                          <FileCode className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                          <span className="font-mono text-[11px] text-foreground">{fn.name}({fn.arguments ? "..." : ""})</span>
                          <span className="font-mono text-[10px] text-muted-foreground">{fn.returnType}</span>
                        </div>
                      );
                    })}
                  </>
                )}

                {schemaTrigFns && schemaTrigFns.length > 0 && (
                  <>
                    <SectionHeader indent={I.schemaObj} label={`Trigger Functions (${schemaTrigFns.length})`}
                      icon={<Zap className="h-3 w-3" />} sectionKey={`${sKey}::trigfns`}
                      expanded={isOpen(`${sKey}::trigfns`)} onClick={() => toggle(`${sKey}::trigfns`)} />
                    {isOpen(`${sKey}::trigfns`) && schemaTrigFns.map((fn, i) => {
                      const tfKey = `trigfn::${schema}::${fn.name}::${i}`;
                      return (
                        <div key={`${fn.name}-${i}`}
                          className={selectedItem === tfKey ? "relative flex items-center gap-1.5 py-0.5 rounded-sm whitespace-nowrap select-none bg-primary/10" : "relative flex items-center gap-1.5 py-0.5 rounded-sm whitespace-nowrap select-none hover:bg-sidebar-accent"}
                          style={{ paddingLeft: `${I.table}px` }}
                          onClick={() => setSelectedItem(tfKey)}
                          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedItem(tfKey); showMenu(e, [
                            { label: "Show Definition", icon: <FileCode className="h-3 w-3" />, onClick: () => openTab(projectId, ddlFunctionQuery(schema, fn.name)) },
                            { label: "Properties", icon: <Settings2 className="h-3 w-3" />, onClick: () => openProperties("trigger-function", schema, fn.name) },
                            { separator: true as const },
                            { label: "Copy Name", icon: <Copy className="h-3 w-3" />, onClick: () => copy(fn.name) },
                          ]); }}>
                          <Zap className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                          <span className="font-mono text-[11px] text-foreground">{fn.name}()</span>
                          <span className="font-mono text-[10px] text-muted-foreground">trigger</span>
                        </div>
                      );
                    })}
                  </>
                )}
              </>
            )}
          </div>
        );
      })}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
      <ObjectPropertiesModal
        open={propsModal.open}
        onOpenChange={(open) => setPropsModal((p) => ({ ...p, open }))}
        objectType={propsModal.objectType}
        projectId={projectId}
        schema={propsModal.schema}
        name={propsModal.name}
      />
      {csvImportTarget && (
        <CSVImportModal
          open={!!csvImportTarget}
          onOpenChange={(open) => { if (!open) setCsvImportTarget(null); }}
          projectId={projectId}
          schema={csvImportTarget.schema}
          table={csvImportTarget.table}
          tableColumns={csvImportTarget.columns}
        />
      )}
    </div>
  );
}
```

Note the `Loader2` import in the icon list — it's used for the new "Connecting…" status line only (`TreeRow`/`SectionHeader` handle their own spinners internally via `tree-row.tsx`).

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (component isn't wired into the app yet, but must be internally type-correct — pay attention to the `ObjectPropertiesModal`/`CSVImportModal` prop types matching their existing definitions in `src/components/object-properties-modal.tsx` and `src/components/csv-import-modal.tsx`)

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebar/database-tree.tsx
git commit -m "refactor: extract single-project schema tree into DatabaseTree"
```

---

### Task 6: `src/components/sidebar/open-database-tabs.tsx`

**Files:**
- Create: `src/components/sidebar/open-database-tabs.tsx`

**Interfaces:**
- Consumes: `useUIStore` (`openDatabaseTabs`, `activeDatabaseTab`, `setActiveDatabaseTab`, `closeDatabaseTab`) from Task 1; `useProjectStore` (`projects`, `status`, `deleteProject`); `useTabStore` (`openTab`, `openMonitorTab`, `openNotifyTab`, `openSchemaDiffTab`, `openExtensionsTab`, `openEnumsTab`, `openPgSettingsTab`); `PgBackupModal` (existing component, unchanged props: `open`, `onOpenChange`, `mode`, `projectId`, `dbName`).
- Produces: `OpenDatabaseTabs({ onEditConnection }: { onEditConnection?: (projectId: string) => void }): JSX.Element`.

This is the fixed tab strip. Each tab represents one open database (`projectId`). Right-clicking a tab exposes everything that used to live on the per-database tree row's context menu (`server-sidebar.tsx:651-670`) plus the connected-only server actions that used to live on the server row (`:596-599`: New Query, Performance Monitor, PG Settings) — since a tab now *is* one specific connected database, folding those in here means no functionality is lost.

- [ ] **Step 1: Create `src/components/sidebar/open-database-tabs.tsx`**

```tsx
import React from "react";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { PgBackupModal } from "@/components/pg-backup-modal";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/stores/ui-store";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { ProjectConnectionStatus } from "@/types";
import {
  Activity, Columns3, Copy, Database, Edit3, List, Loader2, Package,
  Plus, RefreshCw, Save, Settings, Trash2, Upload, X, Zap,
} from "lucide-react";

export function OpenDatabaseTabs({ onEditConnection }: { onEditConnection?: (projectId: string) => void }) {
  const openDatabaseTabs = useUIStore((s) => s.openDatabaseTabs);
  const activeDatabaseTab = useUIStore((s) => s.activeDatabaseTab);
  const setActiveDatabaseTab = useUIStore((s) => s.setActiveDatabaseTab);
  const closeDatabaseTab = useUIStore((s) => s.closeDatabaseTab);
  const projects = useProjectStore((s) => s.projects);
  const status = useProjectStore((s) => s.status);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const openTab = useTabStore((s) => s.openTab);
  const openMonitorTab = useTabStore((s) => s.openMonitorTab);
  const openNotifyTab = useTabStore((s) => s.openNotifyTab);
  const openSchemaDiffTab = useTabStore((s) => s.openSchemaDiffTab);
  const openExtensionsTab = useTabStore((s) => s.openExtensionsTab);
  const openEnumsTab = useTabStore((s) => s.openEnumsTab);
  const openPgSettingsTab = useTabStore((s) => s.openPgSettingsTab);
  const { menu, showMenu, closeMenu } = useContextMenu();
  const [pgBackupTarget, setPgBackupTarget] = React.useState<{ mode: "backup" | "restore"; projectId: string; dbName: string } | null>(null);

  const copy = (text: string) => navigator.clipboard.writeText(text);

  if (openDatabaseTabs.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5 overflow-x-auto overflow-y-hidden whitespace-nowrap scrollbar-none border-b border-sidebar-border px-1.5 py-1">
      {openDatabaseTabs.map((pid) => {
        const isActive = activeDatabaseTab === pid;
        const pStatus = status[pid];
        const isConnected = pStatus === ProjectConnectionStatus.Connected;
        const isConnecting = pStatus === ProjectConnectionStatus.Connecting;
        const isFailed = pStatus === ProjectConnectionStatus.Failed;
        const label = projects[pid]?.database || pid;

        return (
          <div
            key={pid}
            onClick={() => setActiveDatabaseTab(pid)}
            onContextMenu={(e) => showMenu(e, [
              { header: "Database" },
              { label: "New Query", icon: <Plus className="h-3 w-3" />, onClick: () => openTab(pid) },
              ...(isConnected ? [
                { label: "Refresh", icon: <RefreshCw className="h-3 w-3" />, onClick: () => void useProjectStore.getState().refreshConnection(pid) },
                { label: "Performance Monitor", icon: <Activity className="h-3 w-3" />, onClick: () => openMonitorTab(pid) },
                { label: "PG Settings", icon: <Settings className="h-3 w-3" />, onClick: () => openPgSettingsTab(pid) },
                { label: "LISTEN/NOTIFY", icon: <Zap className="h-3 w-3" />, onClick: () => openNotifyTab(pid) },
                { label: "Schema Diff", icon: <Columns3 className="h-3 w-3" />, onClick: () => openSchemaDiffTab(pid) },
                { label: "Extensions", icon: <Package className="h-3 w-3" />, onClick: () => openExtensionsTab(pid) },
                { label: "Enum Types", icon: <List className="h-3 w-3" />, onClick: () => openEnumsTab(pid) },
                { separator: true as const },
                { label: "Backup...", icon: <Save className="h-3 w-3" />, onClick: () => setPgBackupTarget({ mode: "backup", projectId: pid, dbName: label }) },
                { label: "Restore...", icon: <Upload className="h-3 w-3" />, onClick: () => setPgBackupTarget({ mode: "restore", projectId: pid, dbName: label }) },
              ] : []),
              ...(onEditConnection ? [{ separator: true as const }, { label: "Edit Connection", icon: <Edit3 className="h-3 w-3" />, onClick: () => onEditConnection(pid) }] : []),
              { separator: true as const },
              { label: "Copy Name", icon: <Copy className="h-3 w-3" />, onClick: () => copy(label) },
              { separator: true as const },
              { label: "Delete", icon: <Trash2 className="h-3 w-3" />, onClick: () => { closeDatabaseTab(pid); void deleteProject(pid); }, destructive: true },
            ])}
            className={cn(
              "group flex shrink-0 items-center gap-1.5 px-2.5 py-1 rounded-lg transition-all duration-150 cursor-pointer select-none font-mono text-xs",
              isActive ? "bg-accent/80 text-foreground shadow-sm" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
            )}
          >
            {isConnecting ? <Loader2 className="h-3 w-3 animate-spin shrink-0" /> : <Database className={cn("h-3 w-3 shrink-0", isFailed && "text-destructive")} />}
            <span>{label}</span>
            <button
              onClick={(e) => { e.stopPropagation(); closeDatabaseTab(pid); }}
              className="opacity-0 transition-all hover:bg-destructive/20 hover:text-destructive rounded-md p-0.5 group-hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
      {pgBackupTarget && (
        <PgBackupModal
          open={!!pgBackupTarget}
          onOpenChange={(open) => { if (!open) setPgBackupTarget(null); }}
          mode={pgBackupTarget.mode}
          projectId={pgBackupTarget.projectId}
          dbName={pgBackupTarget.dbName}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebar/open-database-tabs.tsx
git commit -m "feat: add fixed open-database tab strip"
```

---

### Task 7: `src/components/sidebar/connection-picker-dialog.tsx`

**Files:**
- Create: `src/components/sidebar/connection-picker-dialog.tsx`

**Interfaces:**
- Consumes: `groupProjectsByServer`, `serverLabel` from `@/lib/server-groups` (Task 3); `useUIStore` (`setActiveServerFp`, `openDatabaseTab`, `setConnectionModalOpen`) from Task 1 and existing `ui-store.ts`; `useProjectStore` (`projects`, `status`, `deleteProject`); `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription` from `@/components/ui/dialog`; `ContextMenu`/`useContextMenu` from `@/components/ui/context-menu`.
- Produces: `ConnectionPickerDialog({ open, onOpenChange, onEditConnection }: { open: boolean; onOpenChange: (open: boolean) => void; onEditConnection?: (projectId: string) => void }): JSX.Element`.

Picking a server sets it active and auto-opens a database tab for it: prefer a project that's already `Connected` on that server (closest available approximation of "last used" — this project has no persisted last-used field; add one later if this default proves wrong), else fall back to the first known project for that server.

- [ ] **Step 1: Create `src/components/sidebar/connection-picker-dialog.tsx`**

```tsx
import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { groupProjectsByServer, serverLabel } from "@/lib/server-groups";
import { useUIStore } from "@/stores/ui-store";
import { useProjectStore } from "@/stores/project-store";
import { ProjectConnectionStatus } from "@/types";
import { Copy, Edit3, Plus, Server, Trash2 } from "lucide-react";

export function ConnectionPickerDialog({
  open, onOpenChange, onEditConnection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEditConnection?: (projectId: string) => void;
}) {
  const projects = useProjectStore((s) => s.projects);
  const status = useProjectStore((s) => s.status);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const setActiveServerFp = useUIStore((s) => s.setActiveServerFp);
  const openDatabaseTab = useUIStore((s) => s.openDatabaseTab);
  const closeDatabaseTab = useUIStore((s) => s.closeDatabaseTab);
  const setConnectionModalOpen = useUIStore((s) => s.setConnectionModalOpen);
  const { menu, showMenu, closeMenu } = useContextMenu();
  const copy = (text: string) => navigator.clipboard.writeText(text);

  const groups = groupProjectsByServer(projects);

  const selectServer = (fp: string, pids: string[]) => {
    setActiveServerFp(fp);
    const defaultPid = pids.find((p) => status[p] === ProjectConnectionStatus.Connected) ?? pids[0];
    openDatabaseTab(defaultPid);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="font-mono">Connection</DialogTitle>
          <DialogDescription>Pick a server to work with, or add a new one.</DialogDescription>
        </DialogHeader>

        <button
          onClick={() => { setConnectionModalOpen(true); onOpenChange(false); }}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-primary hover:bg-primary/10 transition-colors mb-2"
        >
          <Plus className="h-4 w-4" /> New Connection
        </button>

        <div className="max-h-80 overflow-y-auto space-y-0.5">
          {Array.from(groups.entries()).map(([fp, pids]) => {
            const label = serverLabel(fp, pids, projects);
            const anyConnected = pids.some((p) => status[p] === ProjectConnectionStatus.Connected);
            const anyConnecting = pids.some((p) => status[p] === ProjectConnectionStatus.Connecting);
            return (
              <button
                key={fp}
                onClick={() => selectServer(fp, pids)}
                onContextMenu={(e) => showMenu(e, [
                  ...(onEditConnection ? [{ label: "Edit Connection", icon: <Edit3 className="h-3 w-3" />, onClick: () => onEditConnection(pids[0]) }] : []),
                  { separator: true as const },
                  { label: "Copy Name", icon: <Copy className="h-3 w-3" />, onClick: () => copy(label) },
                  { separator: true as const },
                  { label: "Delete", icon: <Trash2 className="h-3 w-3" />, onClick: () => { for (const pid of pids) { closeDatabaseTab(pid); void deleteProject(pid); } }, destructive: true },
                ])}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent/60 transition-colors"
              >
                <Server className="h-3.5 w-3.5 text-primary shrink-0" />
                <span className="font-mono flex-1 truncate">{label}</span>
                <span className={cn("h-2 w-2 rounded-full shrink-0",
                  anyConnected && "bg-success shadow-[0_0_6px_currentColor]",
                  anyConnecting && "bg-warning shadow-[0_0_6px_currentColor]",
                  !anyConnected && !anyConnecting && "bg-muted",
                )} />
              </button>
            );
          })}
          {groups.size === 0 && (
            <p className="px-3 py-4 text-xs text-muted-foreground text-center">No connections yet.</p>
          )}
        </div>
      </DialogContent>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </Dialog>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebar/connection-picker-dialog.tsx
git commit -m "feat: add Connection picker dialog"
```

---

### Task 8: `src/components/sidebar/database-picker-dialog.tsx`

**Files:**
- Create: `src/components/sidebar/database-picker-dialog.tsx`

**Interfaces:**
- Consumes: `groupProjectsByServer` from `@/lib/server-groups` (Task 3); `useUIStore` (`activeServerFp`, `openDatabaseTab`) from Task 1; `useProjectStore` (`projects`, `serverDatabases`, `status`, `addDatabaseToServer`).
- Produces: `DatabasePickerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element`. This replaces the standalone `AddDatabaseDialog` from today's `server-sidebar.tsx:929-992` — its "Add Database" form is folded in here.

- [ ] **Step 1: Create `src/components/sidebar/database-picker-dialog.tsx`**

```tsx
import React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { groupProjectsByServer } from "@/lib/server-groups";
import { useUIStore } from "@/stores/ui-store";
import { useProjectStore } from "@/stores/project-store";
import { ProjectConnectionStatus } from "@/types";
import { Database, Loader2, Plus } from "lucide-react";

export function DatabasePickerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const activeServerFp = useUIStore((s) => s.activeServerFp);
  const openDatabaseTab = useUIStore((s) => s.openDatabaseTab);
  const projects = useProjectStore((s) => s.projects);
  const serverDatabases = useProjectStore((s) => s.serverDatabases);
  const status = useProjectStore((s) => s.status);
  const addDatabaseToServer = useProjectStore((s) => s.addDatabaseToServer);

  const [dbName, setDbName] = React.useState("");
  const [connName, setConnName] = React.useState("");

  React.useEffect(() => {
    if (open) { setDbName(""); setConnName(""); }
  }, [open]);

  if (!activeServerFp) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="font-mono">Databases</DialogTitle>
            <DialogDescription>Pick a Connection first.</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  const pids = groupProjectsByServer(projects).get(activeServerFp) ?? [];
  const source = projects[pids[0]];

  const discoveredDbs = new Set<string>();
  for (const pid of pids) {
    const dbs = serverDatabases[pid];
    if (dbs) dbs.forEach((db) => discoveredDbs.add(db));
    const d = projects[pid];
    if (d?.database) discoveredDbs.add(d.database);
  }
  const dbToProject = new Map<string, string>();
  for (const pid of pids) {
    const d = projects[pid];
    if (d?.database) dbToProject.set(d.database, pid);
  }
  const allDbs = Array.from(discoveredDbs).sort();

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!dbName.trim()) return;
    const name = connName.trim() || dbName.trim();
    void addDatabaseToServer(pids[0], name, dbName.trim()).then(() => {
      openDatabaseTab(name);
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="font-mono">Databases</DialogTitle>
          <DialogDescription>
            On <span className="font-mono font-semibold text-foreground">{source?.host}:{source?.port}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-64 overflow-y-auto space-y-0.5 mb-3">
          {allDbs.map((dbName_) => {
            const dbPid = dbToProject.get(dbName_);
            const dbStatus = dbPid ? status[dbPid] : undefined;
            const isConnected = dbStatus === ProjectConnectionStatus.Connected;
            const isConnecting = dbStatus === ProjectConnectionStatus.Connecting;
            return (
              <button
                key={dbName_}
                onClick={() => {
                  if (dbPid) { openDatabaseTab(dbPid); onOpenChange(false); }
                  else {
                    void addDatabaseToServer(pids[0], dbName_, dbName_).then(() => {
                      openDatabaseTab(dbName_);
                      onOpenChange(false);
                    });
                  }
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent/60 transition-colors"
              >
                {isConnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" /> : <Database className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                <span className="font-mono flex-1 truncate">{dbName_}</span>
                {dbPid && (
                  <span className={cn("h-2 w-2 rounded-full shrink-0",
                    isConnected && "bg-success shadow-[0_0_6px_currentColor]",
                    isConnecting && "bg-warning shadow-[0_0_6px_currentColor]",
                    !isConnected && !isConnecting && "bg-muted",
                  )} />
                )}
              </button>
            );
          })}
          {allDbs.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No databases discovered yet — add one below.</p>
          )}
        </div>

        <form onSubmit={handleAdd} className="space-y-3 border-t border-border/40 pt-3">
          <div className="space-y-1">
            <Label htmlFor="pickerDbName" className="font-mono text-xs">Database Name</Label>
            <Input id="pickerDbName" value={dbName} onChange={(e) => setDbName(e.target.value)} placeholder="analytics_db" className="font-mono text-sm h-8" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pickerConnName" className="font-mono text-xs text-muted-foreground">Connection Name</Label>
            <Input id="pickerConnName" value={connName} onChange={(e) => setConnName(e.target.value)} placeholder={dbName || "optional"} className="font-mono text-sm h-8" />
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="gradient" className="text-xs" disabled={!dbName.trim()}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add Database
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebar/database-picker-dialog.tsx
git commit -m "feat: add Databases picker dialog"
```

---

### Task 9: Rewrite `src/components/server-sidebar.tsx`

**Files:**
- Modify: `src/components/server-sidebar.tsx` (full rewrite — drops in size from 992 lines to roughly 130)

**Interfaces:**
- Consumes: `DatabaseTree` (Task 5), `OpenDatabaseTabs` (Task 6), `ConnectionPickerDialog` (Task 7), `DatabasePickerDialog` (Task 8), `useUIStore.activeDatabaseTab` (Task 1), existing `useQueryStore` (`queries`, `loadQueries`, `loaded`, `removeQuery`), existing `useTabStore.openTab`.
- Produces: `ServerSidebar({ onEditConnection }: { onEditConnection?: (projectId: string) => void }): JSX.Element` — **same external signature as today**, so `src/App.tsx:435` needs no changes.

This is the final integration step: it must run after Tasks 5–8 all exist. It replaces the entire body of `server-sidebar.tsx` — the old `renderSchemas`, `TreeRow`, `SectionHeader`, `IndentGuides`, DDL generators, and `AddDatabaseDialog` are all gone from this file now (they live in the files created by Tasks 2–8). Only the Saved Queries panel (today's `:755-790`) is carried over unchanged, with its own local `selectedQueryId` state (previously it shared `selectedItem` with the tree — now the tree's selection state lives inside `DatabaseTree`, so Saved Queries gets its own small piece of local state).

- [ ] **Step 1: Replace the full contents of `src/components/server-sidebar.tsx`**

```tsx
import React from "react";
import { Button } from "@/components/ui/button";
import { DatabaseTree } from "@/components/sidebar/database-tree";
import { OpenDatabaseTabs } from "@/components/sidebar/open-database-tabs";
import { ConnectionPickerDialog } from "@/components/sidebar/connection-picker-dialog";
import { DatabasePickerDialog } from "@/components/sidebar/database-picker-dialog";
import { useUIStore } from "@/stores/ui-store";
import { useTabStore } from "@/stores/tab-store";
import { useQueryStore } from "@/stores/query-store";
import { cn } from "@/lib/utils";
import { Copy, Database, FileText, Server, Trash2 } from "lucide-react";

export function ServerSidebar({
  onEditConnection,
}: {
  onEditConnection?: (projectId: string) => void;
}) {
  const activeServerFp = useUIStore((s) => s.activeServerFp);
  const activeDatabaseTab = useUIStore((s) => s.activeDatabaseTab);
  const openTab = useTabStore((s) => s.openTab);
  const savedQueries = useQueryStore((s) => s.queries);
  const loadQueries = useQueryStore((s) => s.loadQueries);
  const queriesLoaded = useQueryStore((s) => s.loaded);
  const removeQuery = useQueryStore((s) => s.removeQuery);

  const [connectionDialogOpen, setConnectionDialogOpen] = React.useState(false);
  const [databaseDialogOpen, setDatabaseDialogOpen] = React.useState(false);
  const [selectedQueryId, setSelectedQueryId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!queriesLoaded) void loadQueries();
  }, [queriesLoaded, loadQueries]);

  const copy = (text: string) => navigator.clipboard.writeText(text);

  return (
    <div className="flex h-full flex-col border-r border-sidebar-border bg-sidebar select-none">
      <div className="flex items-center gap-1.5 border-b border-sidebar-border px-2 py-2">
        <Button variant="outline" size="sm" className="h-7 flex-1 justify-start gap-1.5 text-xs font-mono" onClick={() => setConnectionDialogOpen(true)}>
          <Server className="h-3.5 w-3.5" /> Connection
        </Button>
        <Button variant="outline" size="sm" className="h-7 flex-1 justify-start gap-1.5 text-xs font-mono" disabled={!activeServerFp} onClick={() => setDatabaseDialogOpen(true)}>
          <Database className="h-3.5 w-3.5" /> Databases
        </Button>
      </div>

      <OpenDatabaseTabs onEditConnection={onEditConnection} />

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

      {/* Saved Queries — always visible */}
      <div className="border-t border-sidebar-border">
        <div className="flex h-8 items-center justify-between px-3">
          <span className="tracking-widest uppercase text-[10px] font-semibold text-sidebar-foreground">SAVED QUERIES</span>
          {savedQueries.length > 0 && (
            <span className="text-[10px] text-muted-foreground">{savedQueries.length}</span>
          )}
        </div>
        {savedQueries.length > 0 ? (
          <div className="overflow-y-auto p-1 max-h-48">
            {savedQueries.map((q) => (
              <button
                key={q.id}
                onClick={() => { setSelectedQueryId(q.id); openTab(q.projectId, q.sql); }}
                className={cn(
                  "relative flex w-full items-center gap-1.5 py-1 pl-1 text-left text-sm transition-colors rounded-sm whitespace-nowrap",
                  selectedQueryId === q.id ? "bg-primary/10 text-foreground" : "hover:bg-white/[0.06] dark:hover:bg-white/[0.06] hover:bg-black/[0.04]",
                )}
              >
                <FileText className="h-3.5 w-3.5 text-primary/60 shrink-0" />
                <span className="font-mono text-xs">{q.title}</span>
                <span className="ml-auto mr-1 font-mono text-[10px] text-muted-foreground shrink-0">{q.projectId}</span>
                <span
                  role="button"
                  onClick={(e) => { e.stopPropagation(); void removeQuery(q.id); }}
                  className="mr-1 shrink-0 rounded-sm p-0.5 hover:bg-destructive/20 hover:text-destructive"
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" />
                </span>
                <span
                  role="button"
                  onClick={(e) => { e.stopPropagation(); copy(q.sql); }}
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

      <ConnectionPickerDialog open={connectionDialogOpen} onOpenChange={setConnectionDialogOpen} onEditConnection={onEditConnection} />
      <DatabasePickerDialog open={databaseDialogOpen} onOpenChange={setDatabaseDialogOpen} />
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors anywhere in `src/`

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 4: Manual walkthrough**

Run: `npm run dev`, open the app, and verify:
1. Empty state shows "Pick a Connection to get started", Databases button is disabled.
2. Connection button → dialog lists servers (or "No connections yet."); "+ New Connection" opens the existing connection modal.
3. Picking a server auto-opens a tab for its default database and shows that database's schema tree.
4. Databases button → dialog lists databases on the active server, including the "Add Database" form; picking one opens/switches its tab.
5. Opening a second server's database adds a second tab; both tabs are visible together (global tab strip).
6. Clicking a tab switches the tree content; the × on a tab closes it (and reassigns the active tab per the "previous tab" rule); closing the last tab returns to the empty state.
7. Within the tree: expand a schema/table, verify columns/indexes/constraints/triggers/rules/policies still load; right-click a table for the full context menu (SELECT TOP 100, SELECT COUNT(*), Import CSV, Properties, Show CREATE TABLE, Copy Name) — each still works.
8. Right-click an open tab: New Query, Refresh, Performance Monitor, PG Settings, LISTEN/NOTIFY, Schema Diff, Extensions, Enum Types, Backup, Restore, Edit Connection, Copy Name, Delete — each still works.
9. "Login/Group Roles" and "Tablespaces" rows at the top of the tree still work.
10. Saved Queries panel still lists/opens/deletes/copies saved queries.

- [ ] **Step 5: Commit**

```bash
git add src/components/server-sidebar.tsx
git commit -m "refactor: rewrite ServerSidebar as focused single-database view"
```

---

## Post-plan cleanup (part of Task 9, not a separate task)

None — the old `AddDatabaseDialog`, `renderSchemas`, `TreeRow`, `SectionHeader`, `IndentGuides`, and the three DDL generator functions are removed simply by virtue of Task 9 replacing the whole file; nothing references the old definitions afterward.
