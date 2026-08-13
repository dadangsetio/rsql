import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { groupAtOffset, groupsInRange, splitIntoQueryGroups } from "@/lib/query-groups";
import { useUIStore } from "@/stores/ui-store";

interface QueryEditorProps {
  value: string;
  onChange: (value: string) => void;
  onExecute: (sqlBlocks?: string[]) => void;
  onExplain?: () => void;
}

export interface QueryEditorHandle {
  /** The group under the cursor, or every group touched by the current selection. */
  getQueriesToRun: () => string[];
}

export const QueryEditor = forwardRef<QueryEditorHandle, QueryEditorProps>(function QueryEditor(
  { value, onChange, onExecute, onExplain },
  ref,
) {
  const theme = useUIStore((s) => s.theme);
  const onExecuteRef = useRef(onExecute);
  onExecuteRef.current = onExecute;
  const onExplainRef = useRef(onExplain);
  onExplainRef.current = onExplain;
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);

  const getQueriesToRun = useCallback((): string[] => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return [];
    const groups = splitIntoQueryGroups(model.getValue());
    if (groups.length === 0) return [];

    const selection = editor.getSelection();
    if (selection && !selection.isEmpty()) {
      const start = model.getOffsetAt(selection.getStartPosition());
      const end = model.getOffsetAt(selection.getEndPosition());
      const touched = groupsInRange(groups, start, end);
      if (touched.length > 0) return touched.map((g) => g.text);
    }

    const position = editor.getPosition();
    const offset = position ? model.getOffsetAt(position) : 0;
    const current = groupAtOffset(groups, offset);
    return current ? [current.text] : [groups[0].text];
  }, []);

  useImperativeHandle(ref, () => ({ getQueriesToRun }), [getQueriesToRun]);

  const updateGroupDecoration = useCallback((monaco: typeof Monaco) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const groups = splitIntoQueryGroups(model.getValue());

    // A single group spans the whole document — highlighting it would just
    // tint everything, which says nothing useful.
    let target: ReturnType<typeof groupAtOffset> | undefined;
    let targets: ReturnType<typeof splitIntoQueryGroups> = [];
    if (groups.length > 1) {
      const selection = editor.getSelection();
      if (selection && !selection.isEmpty()) {
        const start = model.getOffsetAt(selection.getStartPosition());
        const end = model.getOffsetAt(selection.getEndPosition());
        targets = groupsInRange(groups, start, end);
      } else {
        const position = editor.getPosition();
        const offset = position ? model.getOffsetAt(position) : 0;
        target = groupAtOffset(groups, offset);
        if (target) targets = [target];
      }
    }

    const decorations = targets.map((g) => ({
      range: new monaco.Range(g.startLine, 1, g.endLine, 1),
      options: { isWholeLine: true, className: "query-group-active" },
    }));
    if (decorationsRef.current) decorationsRef.current.set(decorations);
    else decorationsRef.current = editor.createDecorationsCollection(decorations);
  }, []);

  const handleMount = useCallback(
    (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
      editorRef.current = editor;
      editor.addAction({
        id: "run-query",
        label: "Run Query",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
        run: () => onExecuteRef.current(getQueriesToRun()),
      });
      editor.addAction({
        id: "explain-query",
        label: "Explain Query",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
        run: () => onExplainRef.current?.(),
      });
      const refresh = () => updateGroupDecoration(monaco);
      editor.onDidChangeCursorPosition(refresh);
      editor.onDidChangeCursorSelection(refresh);
      editor.onDidChangeModelContent(refresh);
      refresh();
    },
    [getQueriesToRun, updateGroupDecoration],
  );

  return (
    <div
      className="relative flex-1 overflow-hidden bg-[var(--color-editor-bg)]"
      suppressHydrationWarning
    >
      <div className="absolute inset-0 overflow-auto bg-editor-bg">
        <Editor
          height="100%"
          defaultLanguage="pgsql"
          language="pgsql"
          theme={theme === "light" ? "rsql-light" : "rsql-dark"}
          loading={
            <div className="flex h-full w-full items-center justify-center bg-editor-bg">
              <span className="text-muted-foreground text-sm">Loading editor...</span>
            </div>
          }
          options={{
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 13,
            lineNumbers: "on",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontLigatures: false,
            renderLineHighlight: "all",
            padding: { top: 8, bottom: 8 },
            quickSuggestions: {
              other: true,
              comments: false,
              // A literal is not a place to complete identifiers.
              strings: false,
            },
            suggestOnTriggerCharacters: true,
            // The document's own words competed with real schema suggestions.
            wordBasedSuggestions: "off",
            // Enter accepts only when the suggestion would actually change the
            // text, and breaks the line otherwise. Bound to accept
            // unconditionally, every newline typed with the widget open
            // inserted whatever happened to be highlighted; never accepting
            // meant reaching for Tab even mid-word. Tab always accepts.
            acceptSuggestionOnEnter: "smart",
            tabCompletion: "on",
            suggest: {
              showKeywords: true,
              showSnippets: true,
              showFunctions: true,
              showWords: false,
              preview: true,
              filterGraceful: true,
            },
          }}
          value={value}
          onChange={(v) => onChange(v ?? "")}
          onMount={handleMount}
        />
      </div>
    </div>
  );
});
