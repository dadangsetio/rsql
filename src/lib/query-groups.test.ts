import { describe, expect, it } from "vitest";
import { groupAtOffset, groupsInRange, splitIntoQueryGroups } from "./query-groups";

describe("splitIntoQueryGroups", () => {
  it("returns nothing for empty input", () => {
    expect(splitIntoQueryGroups("")).toEqual([]);
    expect(splitIntoQueryGroups("   \n\n  ")).toEqual([]);
  });

  it("treats a script with no blank lines as one group", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const groups = splitIntoQueryGroups(sql);
    expect(groups).toHaveLength(1);
    expect(groups[0].text).toBe(sql);
    expect(groups[0].startLine).toBe(1);
    expect(groups[0].endLine).toBe(2);
  });

  it("splits on blank lines and preserves exact text/offsets", () => {
    const sql = "SELECT 1;\n\nSELECT 2;\nSELECT 3;\n\n\nSELECT 4;";
    const groups = splitIntoQueryGroups(sql);
    expect(groups.map((g) => g.text)).toEqual(["SELECT 1;", "SELECT 2;\nSELECT 3;", "SELECT 4;"]);
    for (const g of groups) {
      expect(sql.slice(g.startOffset, g.endOffset)).toBe(g.text);
    }
    expect(groups[1].startLine).toBe(3);
    expect(groups[1].endLine).toBe(4);
  });

  it("ignores leading/trailing blank lines", () => {
    const sql = "\n\nSELECT 1;\n\n";
    const groups = splitIntoQueryGroups(sql);
    expect(groups).toHaveLength(1);
    expect(groups[0].text).toBe("SELECT 1;");
  });
});

describe("groupAtOffset", () => {
  const groups = splitIntoQueryGroups("SELECT 1;\n\nSELECT 2;");
  // groups[0] = "SELECT 1;" [0,9), groups[1] = "SELECT 2;" [11,20)

  it("finds the group containing the offset", () => {
    expect(groupAtOffset(groups, 3)).toBe(groups[0]);
    expect(groupAtOffset(groups, 15)).toBe(groups[1]);
  });

  it("falls back to the nearest preceding group inside a blank gap", () => {
    expect(groupAtOffset(groups, 10)).toBe(groups[0]);
  });

  it("falls back to the first group when the offset is before everything", () => {
    expect(groupAtOffset([...groups].reverse().length ? groups : groups, 0)).toBe(groups[0]);
  });
});

describe("groupsInRange", () => {
  const groups = splitIntoQueryGroups("SELECT 1;\n\nSELECT 2;\n\nSELECT 3;");

  it("includes every group the range overlaps", () => {
    const touched = groupsInRange(groups, 5, 15);
    expect(touched).toEqual([groups[0], groups[1]]);
  });

  it("excludes groups entirely outside the range", () => {
    expect(groupsInRange(groups, 0, 9)).toEqual([groups[0]]);
  });
});
