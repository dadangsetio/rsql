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
