/**
 * Splits editor text into "query groups" separated by blank lines. A group
 * can itself contain several `;`-terminated statements — those still run
 * together as one backend call, same as today.
 */
export interface QueryGroup {
  text: string;
  startOffset: number;
  endOffset: number;
  /** 1-based, inclusive — matches Monaco's line numbering. */
  startLine: number;
  endLine: number;
}

export function splitIntoQueryGroups(sql: string): QueryGroup[] {
  const lines = sql.split("\n");
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  const groups: QueryGroup[] = [];
  let start: { offset: number; line: number } | null = null;

  const flush = (endLineIdx: number) => {
    if (!start) return;
    const endOffset = lineOffsets[endLineIdx] + lines[endLineIdx].length;
    groups.push({
      text: sql.slice(start.offset, endOffset),
      startOffset: start.offset,
      endOffset,
      startLine: start.line,
      endLine: endLineIdx + 1,
    });
    start = null;
  };

  lines.forEach((line, i) => {
    if (line.trim() === "") {
      flush(i - 1);
    } else if (!start) {
      start = { offset: lineOffsets[i], line: i + 1 };
    }
  });
  flush(lines.length - 1);

  return groups;
}

/** The group the cursor is in, or the most recently passed one if it's sitting in a blank gap. */
export function groupAtOffset(groups: QueryGroup[], offset: number): QueryGroup | undefined {
  let candidate: QueryGroup | undefined;
  for (const g of groups) {
    if (g.startOffset <= offset) candidate = g;
    else break;
  }
  return candidate ?? groups[0];
}

/** Every group with at least one character inside [start, end). */
export function groupsInRange(groups: QueryGroup[], start: number, end: number): QueryGroup[] {
  return groups.filter((g) => g.startOffset < end && g.endOffset > start);
}
