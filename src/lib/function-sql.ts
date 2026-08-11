import { quoteIdent } from "./sql-utils";

export interface FunctionParam {
  id: string;
  mode: "IN" | "OUT" | "INOUT" | "VARIADIC";
  name: string;
  type: string;
  defaultValue: string;
}

export interface CreateFunctionOpts {
  schema: string;
  name: string;
  isProcedure: boolean;
  params: FunctionParam[] | string;
  returnType: string;
  language: string;
  volatility: "IMMUTABLE" | "STABLE" | "VOLATILE";
  strict: boolean;
  securityDefiner: boolean;
  parallelSafety: "SAFE" | "RESTRICTED" | "UNSAFE";
  body: string;
}

export function validIdentifier(s: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s.trim());
}

/** Types whose own name spans several words, so a leading word is not a parameter name. */
const MULTIWORD_TYPE_RE =
  /^(?:character\s+varying|character|double\s+precision|bit\s+varying|timestamp\s+with(?:out)?\s+time\s+zone|time\s+with(?:out)?\s+time\s+zone|national\s+character(?:\s+varying)?)(?:\s*\([^)]*\))?(?:\s*\[\s*\])*$/i;

const MODE_RE = /^(IN|OUT|INOUT|VARIADIC)\s+/i;

/**
 * Splits on commas that separate parameters, ignoring commas nested inside a
 * type's precision (`numeric(10,2)`) or a default expression (`ARRAY[1,2]`).
 */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        if (text[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** Index of the ` DEFAULT ` keyword at nesting depth 0, or -1. */
function findDefaultKeyword(text: string): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        if (text[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && /\s/.test(ch)) {
      const rest = text.slice(i + 1);
      if (/^default\s/i.test(rest)) return i;
    }
  }
  return -1;
}

function splitNameAndType(text: string): { name: string; type: string } | null {
  const remainder = text.trim();
  if (!remainder) return null;

  if (MULTIWORD_TYPE_RE.test(remainder)) return { name: "", type: remainder };

  if (remainder.startsWith('"')) {
    const end = remainder.indexOf('"', 1);
    if (end === -1) return null;
    const type = remainder.slice(end + 1).trim();
    if (!type) return null;
    return { name: remainder.slice(1, end).replace(/""/g, '"'), type };
  }

  const space = remainder.search(/\s/);
  if (space === -1) return { name: "", type: remainder };
  const rest = remainder.slice(space + 1).trim();
  if (!rest) return { name: "", type: remainder.slice(0, space) };
  return { name: remainder.slice(0, space), type: rest };
}

let paramCounter = 0;
function nextParamId(): string {
  paramCounter += 1;
  return `p${paramCounter}`;
}

/**
 * Best-effort parse of a `pg_get_function_arguments()` string. Returns null when
 * a segment has no discernible type, so callers can fall back to raw-text editing.
 */
export function parseFunctionArguments(argsText: string): FunctionParam[] | null {
  const trimmed = argsText.trim();
  if (!trimmed) return [];

  const params: FunctionParam[] = [];
  for (const segment of splitTopLevel(trimmed)) {
    let rest = segment.trim();
    if (!rest) return null;

    let mode: FunctionParam["mode"] = "IN";
    const modeMatch = rest.match(MODE_RE);
    if (modeMatch) {
      mode = modeMatch[1].toUpperCase() as FunctionParam["mode"];
      rest = rest.slice(modeMatch[0].length).trim();
    }

    let defaultValue = "";
    const defaultAt = findDefaultKeyword(rest);
    if (defaultAt !== -1) {
      defaultValue = rest
        .slice(defaultAt)
        .trim()
        .replace(/^default\s+/i, "")
        .trim();
      rest = rest.slice(0, defaultAt).trim();
    }

    const parsed = splitNameAndType(rest);
    if (!parsed) return null;

    params.push({ id: nextParamId(), mode, name: parsed.name, type: parsed.type, defaultValue });
  }
  return params;
}

export function serializeFunctionParams(params: FunctionParam[]): string {
  return params
    .map((p) => {
      const parts: string[] = [];
      if (p.mode !== "IN") parts.push(p.mode);
      if (p.name.trim()) parts.push(p.name.trim());
      parts.push(p.type.trim());
      if (p.defaultValue.trim()) parts.push(`DEFAULT ${p.defaultValue.trim()}`);
      return parts.join(" ");
    })
    .join(", ");
}

/** A dollar-quote tag the body cannot terminate early. */
function dollarTag(body: string): string {
  for (const tag of ["$$", "$function$", "$body$"]) {
    if (!body.includes(tag)) return tag;
  }
  let n = 1;
  while (body.includes(`$fn${n}$`)) n++;
  return `$fn${n}$`;
}

export function generateCreateFunctionOrProcedureSQL(opts: CreateFunctionOpts): string {
  const paramClause =
    typeof opts.params === "string" ? opts.params.trim() : serializeFunctionParams(opts.params);
  const qualified = `${quoteIdent(opts.schema)}.${quoteIdent(opts.name.trim())}`;
  const kind = opts.isProcedure ? "PROCEDURE" : "FUNCTION";

  const lines = [`CREATE OR REPLACE ${kind} ${qualified}(${paramClause})`];
  if (!opts.isProcedure) lines.push(`RETURNS ${opts.returnType.trim()}`);
  lines.push(`LANGUAGE ${opts.language.trim()}`);
  if (!opts.isProcedure) lines.push(opts.volatility);
  if (opts.strict) lines.push("STRICT");
  if (opts.securityDefiner) lines.push("SECURITY DEFINER");
  if (!opts.isProcedure && opts.parallelSafety !== "UNSAFE") {
    lines.push(`PARALLEL ${opts.parallelSafety}`);
  }

  const tag = dollarTag(opts.body);
  lines.push(`AS ${tag}`, opts.body, `${tag};`);
  return lines.join("\n");
}
