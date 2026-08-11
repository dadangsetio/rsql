// Ad hoc self-check for server-groups.ts. No framework — run with:
//   npx tsx src/lib/server-groups.selfcheck.ts
import assert from "node:assert";
import { serverFingerprint, groupProjectsByServer, serverLabel } from "./server-groups";
import type { ProjectMap, ProjectDetails } from "@/types";

const base: Omit<ProjectDetails, "database"> = {
  driver: "PGSQL", username: "postgres", password: "", host: "localhost", port: "5432",
  ssl: "false", sshEnabled: "false", sshHost: "", sshPort: "22", sshUser: "", sshPassword: "", sshKeyPath: "",
};

const projects: ProjectMap = {
  db1: { ...base, database: "db1" },
  db2: { ...base, database: "db2" },
  other_host: { ...base, database: "db3", host: "otherhost" },
};

// db1 and db2 share host/port/username -> same fingerprint
assert.strictEqual(serverFingerprint(projects.db1), serverFingerprint(projects.db2));
// other_host has a different host -> different fingerprint
assert.notStrictEqual(serverFingerprint(projects.db1), serverFingerprint(projects.other_host));

const groups = groupProjectsByServer(projects);
assert.strictEqual(groups.size, 2);
const localFp = serverFingerprint(projects.db1);
assert.deepStrictEqual(new Set(groups.get(localFp)), new Set(["db1", "db2"]));

// Single-project server: label is the project id
assert.strictEqual(serverLabel(serverFingerprint(projects.other_host), ["other_host"], projects), "other_host");
// Multi-project server: label is host:port
assert.strictEqual(serverLabel(localFp, ["db1", "db2"], projects), "localhost:5432");

console.log("OK");
