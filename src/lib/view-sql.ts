import { quoteIdent } from "./sql-utils";

/** pg_get_viewdef returns a trailing semicolon; re-emitting it would split the statement early. */
function normalizeBody(selectBody: string): string {
  return selectBody.trim().replace(/;+\s*$/, "");
}

function qualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

export function validViewName(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name.trim());
}

export function generateCreateViewSQL(
  schema: string,
  name: string,
  selectBody: string,
  withCheckOption: boolean,
): string {
  const body = normalizeBody(selectBody);
  const check = withCheckOption ? "\nWITH CHECK OPTION" : "";
  return `CREATE VIEW ${qualified(schema, name)} AS\n${body}${check};`;
}

export function generateReplaceViewSQL(
  schema: string,
  name: string,
  selectBody: string,
  withCheckOption: boolean,
): string {
  const body = normalizeBody(selectBody);
  const check = withCheckOption ? "\nWITH CHECK OPTION" : "";
  return `CREATE OR REPLACE VIEW ${qualified(schema, name)} AS\n${body}${check};`;
}

export function generateCreateMatviewSQL(
  schema: string,
  name: string,
  selectBody: string,
  withData: boolean,
): string {
  const body = normalizeBody(selectBody);
  return `CREATE MATERIALIZED VIEW ${qualified(schema, name)} AS\n${body}\nWITH ${
    withData ? "DATA" : "NO DATA"
  };`;
}

/** Postgres has no ALTER for a matview's query body, so an edit is a drop and recreate. */
export function generateReplaceMatviewSQL(
  schema: string,
  name: string,
  selectBody: string,
  withData: boolean,
): string[] {
  return [
    `DROP MATERIALIZED VIEW ${qualified(schema, name)};`,
    generateCreateMatviewSQL(schema, name, selectBody, withData),
  ];
}
