import { describe, expect, it } from "vitest";
import { mergePersistedTabs } from "./tab-store";

describe("mergePersistedTabs", () => {
  it("passes through a well-formed persisted tab unchanged", () => {
    const { tabs } = mergePersistedTabs(
      [{ id: "t1", type: "query", title: "Query 1", editorValue: "select 1" }],
      0,
    );
    expect(tabs).toEqual([{ id: "t1", type: "query", title: "Query 1", editorValue: "select 1", isExecuting: false }]);
  });

  it("defaults a missing editorValue to an empty string instead of leaving it undefined", () => {
    const { tabs } = mergePersistedTabs([{ id: "t1", type: "query", title: "Query 1" }], 0);
    expect(tabs[0].editorValue).toBe("");
  });

  it("drops entries missing id/type/title rather than restoring a broken tab", () => {
    const { tabs } = mergePersistedTabs(
      [
        { id: "t1", type: "query", title: "ok", editorValue: "" },
        { id: "t2", type: "query" }, // missing title
        null,
        "not-an-object",
      ],
      0,
    );
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe("t1");
  });

  it("clamps selectedTabIndex into range and resets to -1 when nothing survives", () => {
    const { selectedTabIndex } = mergePersistedTabs(
      [{ id: "t1", type: "query", title: "ok", editorValue: "" }],
      99,
    );
    expect(selectedTabIndex).toBe(0);

    const empty = mergePersistedTabs([{ notATab: true }], 0);
    expect(empty.selectedTabIndex).toBe(-1);
  });

  it("forces isExecuting to false on restore even if persisted state said otherwise", () => {
    const { tabs } = mergePersistedTabs(
      [{ id: "t1", type: "query", title: "ok", editorValue: "", isExecuting: true }],
      0,
    );
    expect(tabs[0].isExecuting).toBe(false);
  });
});
