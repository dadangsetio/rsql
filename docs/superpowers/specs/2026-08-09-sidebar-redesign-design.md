# Sidebar Redesign: Connection/Database Focus + Popups

## Problem

`server-sidebar.tsx` (992 lines) renders every connected server, every database,
and every schema's full tree, all expanded/visible at once, grouped by server
fingerprint. As the number of servers/databases grows this becomes a long,
hard-to-scan tree. The user wants a focused, single-database view instead,
switched via two top buttons and a tab strip, with connection/database
selection moved into popups (modal dialogs).

## Goals

- Sidebar shows exactly one database's schema tree at a time.
- Two buttons at the top of the sidebar: **Connection** (pick/add a server)
  and **Databases** (pick/add a database on the currently selected server).
- Both selections happen via popup dialogs, not inline tree navigation.
- A fixed tab strip lists every currently **open** database (across all
  servers), lets you switch the active one, and close (disconnect) it.
- Reuse all existing per-item tree logic (expand/load/context menus/DDL
  generators) unchanged — only the top-level container and navigation model
  change.

## Non-goals

- No backend "disconnect" RPC. Closing a tab is a client-side state change
  (`status = Disconnected`, removed from the open list); reopening reconnects
  normally through the existing `connect` flow.
- No change to how connections are saved/edited (`connection-modal.tsx`) or to
  per-object context menus, DDL generation, CSV import, backup/restore.

## State model

Extend `ui-store.ts`:

- `activeServerFp: string | null` — the server fingerprint currently selected
  via the Connection button; context for what the Databases popup offers.
- `openDatabaseTabs: string[]` — ordered list of project IDs currently open as
  tabs, global across servers.
- `activeDatabaseTab: string | null` — which open tab's tree is rendered.
- Actions:
  - `setActiveServerFp(fp: string | null)`
  - `openDatabaseTab(pid: string)` — adds to `openDatabaseTabs` if absent,
    sets it active, connects via `projectStore.connect` if not already
    connected.
  - `closeDatabaseTab(pid: string)` — removes from `openDatabaseTabs`, sets
    `projectStore.status[pid] = Disconnected`, and if it was active, activates
    the previous tab in the list (or `null` if none remain).
  - `setActiveDatabaseTab(pid: string)`

## Component breakdown

Split the current single 992-line file into:

- **`server-sidebar.tsx`** — thin container. Renders the two top buttons, the
  tab strip, the active tab's tree (or an empty state when
  `activeDatabaseTab` is null), and the fixed Saved Queries panel at the
  bottom (unchanged from today). Owns the two dialogs' open/close state.
- **`connection-picker-dialog.tsx`** — "Connection" popup. Lists servers
  grouped exactly like today's `serverGroups` (by host:port:user:ssh), with a
  status dot per server. Clicking a server sets `activeServerFp` and calls
  `openDatabaseTab` for that server's default/last-used database (the
  project whose `database` matches the connection's configured `database`,
  falling back to the first known project for that server), then closes the
  dialog. A "+ New Connection" row opens the existing `connection-modal.tsx`.
  Row context menu keeps "Edit Connection" and "Delete" (moved from the old
  server tree row).
- **`database-picker-dialog.tsx`** — "Databases" popup. Disabled/prompts to
  pick a connection first if `activeServerFp` is null. Otherwise lists every
  database for that server — both discovered (`serverDatabases`) and already
  saved as projects — with connection status dots, reusing today's
  discovered-vs-project-backed logic from `server-sidebar.tsx`. Clicking one
  calls `openDatabaseTab`. Includes the existing "Add Database" form inline
  (replaces the standalone `AddDatabaseDialog`).
- **`database-tree.tsx`** — the actual schema tree for one `projectId`:
  today's `renderSchemas`, `TreeRow`, `SectionHeader`, `IndentGuides`, and the
  DDL query generator functions, moved here verbatim and scoped to a single
  project instead of iterated per-server. The "Login/Group Roles" and
  "Tablespaces" rows move to the top of this tree (server-level data, using
  the active tab's project as the connected representative for that server).
- **`open-database-tabs.tsx`** — fixed tab strip. Renders `openDatabaseTabs`
  in order, highlights `activeDatabaseTab`, shows a connecting spinner/status
  dot per tab, and a × to `closeDatabaseTab`.

## Interaction flow

1. **No tabs open**: sidebar shows the two buttons (Databases disabled until
   a connection is picked) and an empty state prompting "Pick a Connection to
   get started"; Saved Queries panel is always visible regardless.
2. **Connection button** → dialog lists servers. Picking one sets
   `activeServerFp`, auto-opens its default database tab, closes the dialog.
3. **Databases button** → dialog lists databases for `activeServerFp`.
   Picking one opens/switches to its tab, closes the dialog.
4. **Tab strip**: click switches `activeDatabaseTab`; × closes it via
   `closeDatabaseTab`.
5. **Tree content**: renders `<DatabaseTree projectId={activeDatabaseTab} />`
   — all existing expand/load/context-menu/DDL behavior unchanged.
6. Per-object context menus (schema/table/view/etc.) are untouched.

## Error handling / edge cases

- Closing the last open tab clears `activeDatabaseTab` → empty state shown.
- Opening a database that's still `Connecting` is a no-op (button/tab shows a
  spinner, same as today's per-row loading state).
- If `activeServerFp`'s server has zero known databases yet (freshly added
  connection with no discovery run), the Databases popup shows only the "Add
  Database" form.
- Deleting a project (existing "Delete" action) that is currently an open tab
  also removes it from `openDatabaseTabs` and re-picks the active tab, same
  as `closeDatabaseTab`.

## Testing

- Manual walkthrough covering: add connection → auto-opens default db →
  switch db via Databases popup → open a second server → tabs show both
  databases → close a tab → close the last tab → reopen via popup →
  Saved Queries still works → all existing per-table context menu actions
  (query, DDL, CSV import, properties, backup/restore) still work unchanged
  on the active tab's tree.
- No automated test suite currently covers `server-sidebar.tsx`; none is
  being added here beyond the manual walkthrough (YAGNI — this is UI
  navigation restructuring, not new business logic).
