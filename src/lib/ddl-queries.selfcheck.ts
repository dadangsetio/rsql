// Ad hoc self-check for ddl-queries.ts. No framework — run with:
//   npx tsx src/lib/ddl-queries.selfcheck.ts
import assert from "node:assert";
import { ddlTableQuery, ddlViewQuery, ddlFunctionQuery } from "./ddl-queries";

assert.ok(ddlTableQuery("public", "users").includes(`c.table_schema = 'public' AND c.table_name = 'users'`));
assert.ok(ddlViewQuery("public", "active_users").includes(`pg_get_viewdef('"public"."active_users"'::regclass, true)`));
assert.ok(ddlFunctionQuery("public", "my_fn").includes(`n.nspname = 'public' AND p.proname = 'my_fn'`));

console.log("OK");
