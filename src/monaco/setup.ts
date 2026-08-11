// monaco-editor is pinned to 0.55.0 on purpose. 0.56 narrowed its `exports`
// map to `"./*": "./esm/vs/*.js"`, and monaco-sql-languages' own worker still
// imports `monaco-editor/esm/vs/editor/editor.worker.js`, which no longer
// resolves — the build fails inside that package. Bumping monaco-editor
// requires monaco-sql-languages to fix its import first.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import pgWorker from "monaco-sql-languages/esm/languages/pgsql/pgsql.worker?worker";

import "monaco-sql-languages/esm/languages/pgsql/pgsql.contribution";
import { LanguageIdEnum } from "monaco-sql-languages/esm/common/constants";
import { setupLanguageFeatures } from "monaco-sql-languages/esm/setupLanguageFeatures";
import { registerCompletion } from "./completion/provider";
import { registerTheme } from "./theme";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "pgsql") {
      return new pgWorker();
    }
    return new editorWorker();
  },
};

loader.config({ monaco });

setupLanguageFeatures(LanguageIdEnum.PG, {
  // Completion is registered directly in registerCompletion below (see c689a03
  // for why: the library resolves its worker through its own monaco-editor
  // import, separate from the app's, so anything routed through it can't
  // reach our models). Diagnostics hits the same worker path and never
  // resolves either — it only spammed "doValidation" errors with no actual
  // squiggles to show for it, so it stays off until it's worth an inline
  // implementation like completion got.
  completionItems: false,
  diagnostics: false,
  definitions: true,
  references: true,
});

registerTheme(monaco);
registerCompletion(monaco);
