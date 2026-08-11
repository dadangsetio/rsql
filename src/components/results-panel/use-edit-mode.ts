import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildEnumLabelMap,
  type ColumnEditInfo,
  classifyColumnEditKind,
} from "@/lib/column-edit-kind";
import type { ForeignKey } from "@/lib/database-driver";
import { DriverFactory } from "@/lib/database-driver";
import { classifyFilterColumnKind, type FilterColumnInfo } from "@/lib/filter-utils";
import { buildMutations, countPending, emptySession, rowKeys } from "@/lib/mutations";
import { parseSelectTable, quoteIdent, quoteLiteral } from "@/lib/sql-utils";
import type { CellValue } from "@/lib/wire";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import type { QueryResult } from "@/types";

type UndoEntry =
  | { type: "cell"; key: string; column: string; previous: CellValue | undefined }
  | { type: "delete"; key: string; wasDeleted: boolean }
  // `createdRow` marks a draft that did not exist before this edit — undoing
  // it removes the whole row rather than reverting one column to `previous`.
  | {
      type: "insert-cell";
      draftId: string;
      column: string;
      previous: CellValue | undefined;
      createdRow: boolean;
    }
  | { type: "insert-remove"; draftId: string; columns: Record<string, CellValue> };

interface UseEditModeArgs {
  tabId: string | undefined;
  projectId: string | undefined;
  editorValue: string | undefined;
  result: QueryResult | null | undefined;
}

export function useEditMode({ tabId, projectId, editorValue, result }: UseEditModeArgs) {
  const [editError, setEditError] = useState<string | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const [confirmingApply, setConfirmingApply] = useState(false);

  const editSession = useTabStore((s) => s.tabs.find((t) => t.id === tabId)?.editSession);
  const isEditing = !!editSession;

  const editableTable = useMemo(() => {
    if (!editorValue) return null;
    return parseSelectTable(editorValue);
  }, [editorValue]);

  // A session belongs to the table it was opened against. If the editor now
  // points somewhere else, applying it would write to the wrong table.
  const sessionMatchesEditor =
    !editSession ||
    (!!editableTable &&
      editableTable.schema === editSession.schema &&
      editableTable.table === editSession.table);

  const keys = useMemo(
    () =>
      editSession && result
        ? rowKeys(result.columns, result.rows, editSession.pkColumns)
        : ([] as (string | null)[]),
    [editSession, result],
  );

  const pending = useMemo(
    () => (editSession ? countPending(editSession) : { updates: 0, deletes: 0, inserts: 0 }),
    [editSession],
  );

  // Insertion order of draft rows staged from the grid's trailing blank row —
  // each one occupies one grid row after the real result rows, in this order.
  const insertRowIds = useMemo(
    () => (editSession ? Object.keys(editSession.inserts) : []),
    [editSession],
  );

  // Draft rows as plain cell arrays, column-ordered like a real result row —
  // what the grid actually appends after the real rows, plus one blank row
  // past the last draft so there is always somewhere to start the next one.
  //
  // Before any session exists, an editable query's result — empty or not —
  // still gets that one blank row on its own: it's the standing invitation to
  // insert, and double-clicking into it is what starts the session (see
  // handleCellEdit below), same as an explicit click on "Edit" would.
  const insertRows = useMemo(() => {
    if (!result) return [];
    if (editSession) {
      const drafted = insertRowIds.map((id) =>
        result.columns.map((col) => editSession.inserts[id]?.[col] ?? ""),
      );
      return [...drafted, result.columns.map(() => "")];
    }
    if (editableTable) {
      return [result.columns.map(() => "")];
    }
    return [];
  }, [editSession, result, insertRowIds, editableTable]);

  // Inverse of each staged change, newest last — Ctrl/Cmd+Z in the grid pops one.
  // Kept out of the tab store because it is scratch UI state, not part of what gets committed.
  const undoStack = useRef<UndoEntry[]>([]);
  const pushUndo = useCallback((entry: UndoEntry) => {
    undoStack.current.push(entry);
  }, []);

  // Reverting the last change (by undo, retyping a cell's original value, or
  // un-deleting the last deleted row) can bring pending back down to zero —
  // an open session with nothing staged has no reason to stay open, so close
  // it instead of leaving the edit toolbar and locked-in row layout behind
  // for changes that no longer exist. Reads the store fresh: called right
  // after the mutation that may have zeroed it out.
  const closeSessionIfEmpty = useCallback(() => {
    if (!tabId) return;
    const session = useTabStore.getState().tabs.find((t) => t.id === tabId)?.editSession;
    if (!session) return;
    const counts = countPending(session);
    if (counts.updates + counts.deletes + counts.inserts === 0) {
      useTabStore.getState().discardEditSession(tabId);
      setEditError(null);
    }
  }, [tabId]);

  const handleUndo = useCallback(() => {
    if (!tabId) return;
    const entry = undoStack.current.pop();
    if (!entry) return;
    const store = useTabStore.getState();
    switch (entry.type) {
      case "cell":
        store.setCellEdit(tabId, entry.key, entry.column, entry.previous);
        break;
      case "delete":
        store.setRowDeleted(tabId, entry.key, entry.wasDeleted);
        break;
      case "insert-cell":
        if (entry.createdRow) {
          store.removeInsertRow(tabId, entry.draftId);
        } else if (entry.previous === undefined) {
          store.unsetInsertCell(tabId, entry.draftId, entry.column);
        } else {
          store.setInsertCell(tabId, entry.draftId, entry.column, entry.previous);
        }
        break;
      case "insert-remove":
        for (const [column, value] of Object.entries(entry.columns)) {
          store.setInsertCell(tabId, entry.draftId, column, value);
        }
        break;
    }
    closeSessionIfEmpty();
  }, [tabId, closeSessionIfEmpty]);

  // Undo history belongs to one tab's session, so switching tabs starts over.
  const undoTabRef = useRef(tabId);
  if (undoTabRef.current !== tabId) {
    undoTabRef.current = tabId;
    undoStack.current = [];
  }

  const [fkMap, setFkMap] = useState<
    Map<string, { schema: string; table: string; column: string }>
  >(new Map());
  const [columnTypes, setColumnTypes] = useState<Map<string, ColumnEditInfo>>(new Map());
  // Column name -> filter-bar operator bucket. Separate from columnTypes, which lumps
  // integers into "text" — wrong for filtering, where integers need >/<.
  const [filterColumnKinds, setFilterColumnKinds] = useState<Map<string, FilterColumnInfo>>(
    new Map(),
  );

  useEffect(() => {
    if (!editableTable || !projectId) {
      setColumnTypes(new Map());
      setFilterColumnKinds(new Map());
      return;
    }
    const pid = projectId;
    const d = useProjectStore.getState().projects[pid];
    if (!d) return;

    const driver = DriverFactory.getDriver(d.driver);
    Promise.all([
      useProjectStore.getState().loadColumnDetails(pid, editableTable.schema, editableTable.table),
      driver.loadEnumTypes?.(pid) ?? Promise.resolve([]),
    ])
      .then(([colDetails, enumRows]) => {
        const enumLabelMap = buildEnumLabelMap(enumRows);
        const typeMap = new Map<string, ColumnEditInfo>();
        const filterKindMap = new Map<string, FilterColumnInfo>();
        for (const c of colDetails) {
          typeMap.set(
            c.name,
            classifyColumnEditKind(c.dataType, c.udtName, c.nullable, enumLabelMap),
          );
          filterKindMap.set(c.name, classifyFilterColumnKind(c.dataType, c.udtName, enumLabelMap));
        }
        setColumnTypes(typeMap);
        setFilterColumnKinds(filterKindMap);
      })
      .catch(() => {
        setColumnTypes(new Map());
        setFilterColumnKinds(new Map());
      });
  }, [editableTable, projectId]);

  useEffect(() => {
    if (!editableTable || !projectId) {
      setFkMap(new Map());
      return;
    }
    const pid = projectId;
    const d = useProjectStore.getState().projects[pid];
    if (!d) return;

    const driver = DriverFactory.getDriver(d.driver);
    driver
      .loadForeignKeys(pid, editableTable.schema)
      .then((fks: ForeignKey[]) => {
        const map = new Map<string, { schema: string; table: string; column: string }>();
        for (const fk of fks) {
          if (fk.sourceTable === editableTable.table) {
            map.set(fk.sourceColumn, {
              schema: editableTable.schema,
              table: fk.targetTable,
              column: fk.targetColumn,
            });
          }
        }
        setFkMap(map);
      })
      .catch(() => setFkMap(new Map()));
  }, [editableTable, projectId]);

  const handleFKNavigate = useCallback(
    (colName: string, value: string) => {
      const target = fkMap.get(colName);
      if (!target || !projectId) return;

      const pid = projectId;
      const sql = `SELECT * FROM ${quoteIdent(target.schema)}.${quoteIdent(target.table)} WHERE ${quoteIdent(target.column)} = ${quoteLiteral(value)} LIMIT 100`;
      useTabStore.getState().openTab(pid, sql);

      const d = useProjectStore.getState().projects[pid];
      if (!d) return;
      const tabs = useTabStore.getState().tabs;
      const newTabId = tabs[tabs.length - 1]?.id;
      if (!newTabId) return;
      useTabStore.getState().setExecuting(newTabId, true);
      const driver = DriverFactory.getDriver(d.driver);
      driver
        .runQuery(pid, sql)
        .then(([cols, rows, time]) => {
          useTabStore.getState().updateResult(newTabId, { columns: cols, rows, time });
        })
        .catch(() => {
          useTabStore.getState().setExecuting(newTabId, false);
        });
    },
    [fkMap, projectId],
  );

  // Concurrent callers (e.g. every keystroke typed into the row detail panel before a
  // session exists yet) share the same in-flight start instead of each kicking off their
  // own driver round trip — the second one would also call startEditSession and wipe out
  // whatever the first one just staged.
  const enterEditPromiseRef = useRef<Promise<boolean> | null>(null);

  // Returns whether a session actually started, so a double-click on the
  // empty-table placeholder row can start one on demand and then, once it
  // has, go on to stage the value that was just typed.
  const handleEnterEdit = useCallback((): Promise<boolean> => {
    // Read the store directly rather than the reactive `editSession` above — a caller
    // racing right behind an enter-edit that just resolved needs this to be current
    // immediately, not after the next render.
    if (useTabStore.getState().tabs.find((t) => t.id === tabId)?.editSession) {
      return Promise.resolve(true);
    }
    if (enterEditPromiseRef.current) return enterEditPromiseRef.current;

    const promise = (async () => {
      if (!editableTable || !projectId || !tabId) return false;
      const d = useProjectStore.getState().projects[projectId];
      if (!d) return false;
      setEditError(null);

      try {
        const driver = DriverFactory.getDriver(d.driver);
        const indexes = await driver.loadIndexes(
          projectId,
          editableTable.schema,
          editableTable.table,
        );
        const pkColumns = [...new Set(indexes.filter((i) => i.isPrimary).map((i) => i.columnName))];

        if (pkColumns.length === 0) {
          setEditError("No primary key found. Inline editing requires a primary key.");
          return false;
        }

        const resultCols = result?.columns ?? [];
        const missingPKs = pkColumns.filter((pk) => !resultCols.includes(pk));
        if (missingPKs.length > 0) {
          setEditError(
            `Primary key column(s) ${missingPKs.join(", ")} not in query results. Select all PK columns to edit.`,
          );
          return false;
        }

        useTabStore
          .getState()
          .startEditSession(
            tabId,
            emptySession(editableTable.schema, editableTable.table, pkColumns),
          );
        return true;
      } catch (err: any) {
        setEditError(err?.message ?? "Failed to load table info");
        return false;
      }
    })();

    enterEditPromiseRef.current = promise;
    void promise.finally(() => {
      enterEditPromiseRef.current = null;
    });
    return promise;
  }, [editableTable, projectId, tabId, result?.columns]);

  const handleDiscard = useCallback(() => {
    if (!tabId) return;
    useTabStore.getState().discardEditSession(tabId);
    setEditError(null);
    setConfirmingApply(false);
  }, [tabId]);

  const handleRequestApply = useCallback(() => {
    if (pending.updates + pending.deletes + pending.inserts === 0) return;
    setConfirmingApply(true);
  }, [pending]);

  const handleCancelApply = useCallback(() => setConfirmingApply(false), []);

  const handleConfirmApply = useCallback(async () => {
    setConfirmingApply(false);
    if (!editSession || !projectId || !tabId) return;

    const mutations = buildMutations(editSession);
    if (mutations.length === 0) {
      handleDiscard();
      return;
    }

    setIsCommitting(true);
    setEditError(null);

    try {
      const d = useProjectStore.getState().projects[projectId];
      if (!d) throw new Error("Project not found");
      const driver = DriverFactory.getDriver(d.driver);
      if (!driver.applyRowMutations) throw new Error("Driver does not support inline editing");

      // One transaction for updates and deletes together. The backend requires
      // each statement to affect exactly one row and rolls the batch back
      // otherwise, so a no-op surfaces as an error rather than a silent success.
      await driver.applyRowMutations(
        projectId,
        editSession.schema,
        editSession.table,
        mutations,
        30000,
      );

      const [cols, rows, time] = await driver.runQuery(projectId, editorValue ?? "");
      useTabStore.getState().updateResult(tabId, { columns: cols, rows, time });

      useTabStore.getState().discardEditSession(tabId);
    } catch (err: any) {
      setEditError(err?.message ?? String(err));
    } finally {
      setIsCommitting(false);
    }
  }, [editSession, projectId, tabId, editorValue, handleDiscard]);

  // Rows at or past the end of the real result are the staged draft rows plus
  // the one ever-present blank row after them — see insertRowIds above and
  // ResultsPanel's gridRows, which is what actually puts them on screen.
  const handleInsertCellEdit = useCallback(
    (rowIndex: number, colIndex: number, value: CellValue) => {
      if (!tabId || !result) return;
      const column = result.columns[colIndex];
      if (!column) return;
      const draftIndex = rowIndex - result.rows.length;
      const createdRow = draftIndex >= insertRowIds.length;
      const draftId = createdRow ? crypto.randomUUID() : insertRowIds[draftIndex];
      const previous = editSession?.inserts[draftId]?.[column];
      pushUndo({ type: "insert-cell", draftId, column, previous, createdRow });
      useTabStore.getState().setInsertCell(tabId, draftId, column, value);
    },
    [tabId, result, insertRowIds, editSession, pushUndo],
  );

  // Right-click "Add Row" — the blank invitation row is already visible even
  // outside a session (see insertRows above); this just starts the session,
  // the same as double-clicking into that row would.
  const handleAddRow = useCallback(() => {
    if (!editSession) void handleEnterEdit();
  }, [editSession, handleEnterEdit]);

  // Right-click "Duplicate Row" — stages a new draft row seeded with the
  // clicked row's current values. Only meaningful for a real row; the blank
  // invitation row and other drafts have nothing distinct to duplicate.
  const handleDuplicateRow = useCallback(
    async (rowIndex: number) => {
      if (!tabId || !result || rowIndex >= result.rows.length) return;
      const sourceRow = result.rows[rowIndex];
      if (!editSession) {
        const started = await handleEnterEdit();
        if (!started) return;
      }
      const draftId = crypto.randomUUID();
      const store = useTabStore.getState();
      result.columns.forEach((col, i) => {
        store.setInsertCell(tabId, draftId, col, sourceRow[i] ?? "");
      });
      // One entry undoes the whole duplicated row — which column it names
      // doesn't matter, `createdRow` is what makes undo remove it outright.
      pushUndo({
        type: "insert-cell",
        draftId,
        column: result.columns[0] ?? "",
        previous: undefined,
        createdRow: true,
      });
    },
    [tabId, result, editSession, handleEnterEdit, pushUndo],
  );

  // Right-click "Paste" — one staged draft row per clipboard line, columns
  // matched positionally. No per-row undo entries; removing a bad paste is a
  // manual delete per row rather than a single Ctrl/Cmd+Z.
  const handlePasteRows = useCallback(
    async (rows: CellValue[][]) => {
      if (!tabId || !result || rows.length === 0) return;
      if (!editSession) {
        const started = await handleEnterEdit();
        if (!started) return;
      }
      const store = useTabStore.getState();
      for (const row of rows) {
        const draftId = crypto.randomUUID();
        result.columns.forEach((col, i) => {
          store.setInsertCell(tabId, draftId, col, row[i] ?? "");
        });
      }
    },
    [tabId, result, editSession, handleEnterEdit],
  );

  // Applies a staged edit to an existing (already-fetched) row. Reads the session fresh
  // from the store instead of the reactive `editSession`/`keys` above — this also runs
  // from inside handleEnterEdit's `.then()`, right after the session was created, before
  // this render's closures have caught up with that.
  const applyExistingRowEdit = useCallback(
    (rowIndex: number, colIndex: number, value: CellValue) => {
      if (!tabId || !result) return;
      const session = useTabStore.getState().tabs.find((t) => t.id === tabId)?.editSession;
      if (!session) return;
      const key = rowKeys(result.columns, result.rows, session.pkColumns)[rowIndex];
      if (!key) {
        setEditError("This row cannot be identified by its primary key and cannot be edited.");
        return;
      }
      const column = result.columns[colIndex];
      if (!column) return;

      const original = result.rows[rowIndex]?.[colIndex] ?? null;
      const next: CellValue | undefined = value === original ? undefined : value;
      const previous = session.edits[key]?.[column];
      pushUndo({ type: "cell", key, column, previous });
      useTabStore.getState().setCellEdit(tabId, key, column, next);
      // Retyping a cell's original value is how an edit gets un-staged outside
      // of undo — check the same way undo does.
      if (next === undefined) closeSessionIfEmpty();
    },
    [tabId, result, pushUndo, closeSessionIfEmpty],
  );

  const handleCellEdit = useCallback(
    (rowIndex: number, colIndex: number, value: CellValue) => {
      if (!tabId || !result) return;

      // A cell past the real rows is the blank invitation row, offered even
      // without a session already open on an empty result (see insertRows
      // above) — typing into it is the "double-click an empty row" trigger
      // that starts the session, then stages the value that was just typed.
      if (rowIndex >= result.rows.length) {
        if (!editSession) {
          void handleEnterEdit().then((started) => {
            if (started) handleInsertCellEdit(rowIndex, colIndex, value);
          });
          return;
        }
        handleInsertCellEdit(rowIndex, colIndex, value);
        return;
      }

      // Same on an existing row — a caller that isn't gated behind the grid's own "Edit"
      // button (the row detail panel edits directly) starts a session transparently on
      // the first edit rather than silently dropping it.
      if (!editSession) {
        void handleEnterEdit().then((started) => {
          if (started) applyExistingRowEdit(rowIndex, colIndex, value);
        });
        return;
      }
      applyExistingRowEdit(rowIndex, colIndex, value);
    },
    [tabId, result, editSession, handleInsertCellEdit, handleEnterEdit, applyExistingRowEdit],
  );

  const setRowDeleted = useCallback(
    (rowIndex: number, deleted: boolean) => {
      if (!tabId || !editSession || !result) return;
      if (rowIndex >= result.rows.length) {
        // The blank trailing row has nothing staged yet — deleting it is a no-op.
        // An actual draft row is removed outright rather than marked deleted
        // (it was never a real row to restore) — its columns are snapshotted
        // first so Ctrl/Cmd+Z can recreate it.
        const draftId = insertRowIds[rowIndex - result.rows.length];
        if (!deleted || !draftId) return;
        const columns = editSession.inserts[draftId] ?? {};
        pushUndo({ type: "insert-remove", draftId, columns: { ...columns } });
        useTabStore.getState().removeInsertRow(tabId, draftId);
        closeSessionIfEmpty();
        return;
      }
      const key = keys[rowIndex];
      if (!key) {
        setEditError("This row cannot be identified by its primary key and cannot be deleted.");
        return;
      }
      pushUndo({ type: "delete", key, wasDeleted: editSession.deletes.includes(key) });
      useTabStore.getState().setRowDeleted(tabId, key, deleted);
      // Un-deleting the last deleted row is how a delete gets un-staged outside
      // of undo — check the same way undo does.
      if (!deleted) closeSessionIfEmpty();
    },
    [tabId, editSession, result, keys, pushUndo, insertRowIds, closeSessionIfEmpty],
  );

  const handleRowDelete = useCallback(
    (rowIndex: number) => setRowDeleted(rowIndex, true),
    [setRowDeleted],
  );
  const handleRowRestore = useCallback(
    (rowIndex: number) => setRowDeleted(rowIndex, false),
    [setRowDeleted],
  );

  // The grid still works in row positions, so translate identities back to it.
  const editedCells = useMemo(() => {
    const map = new Map<string, string>();
    if (!editSession || !result) return map;
    keys.forEach((key, rowIndex) => {
      if (!key) return;
      const columns = editSession.edits[key];
      if (!columns) return;
      for (const [column, value] of Object.entries(columns)) {
        const colIndex = result.columns.indexOf(column);
        if (colIndex >= 0) map.set(`${rowIndex}:${colIndex}`, value ?? "");
      }
    });
    return map;
  }, [editSession, result, keys]);

  const deletedRowIndices = useMemo(() => {
    const set = new Set<number>();
    if (!editSession) return set;
    const marked = new Set(editSession.deletes);
    keys.forEach((key, rowIndex) => {
      if (key && marked.has(key)) set.add(rowIndex);
    });
    return set;
  }, [editSession, keys]);

  return {
    isEditing,
    editSession,
    editError,
    setEditError,
    isCommitting,
    confirmingApply,
    pending,
    sessionMatchesEditor,
    editableTable,
    fkMap,
    columnTypes,
    filterColumnKinds,
    editedCells,
    deletedRowIndices,
    insertRows,
    handleUndo,
    handleFKNavigate,
    handleEnterEdit,
    handleDiscard,
    handleRequestApply,
    handleConfirmApply,
    handleCancelApply,
    handleCellEdit,
    handleRowDelete,
    handleRowRestore,
    handleAddRow,
    handleDuplicateRow,
    handlePasteRows,
  };
}
