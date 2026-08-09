import type { ProjectDetails, ProjectMap } from "@/types";

export function serverFingerprint(d: ProjectDetails): string {
  return `${d.host}\0${d.port}\0${d.username}\0${d.sshEnabled === "true" ? `${d.sshHost}:${d.sshPort}` : ""}`;
}

export function groupProjectsByServer(projects: ProjectMap): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [pid, d] of Object.entries(projects)) {
    const fp = serverFingerprint(d);
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp)!.push(pid);
  }
  return groups;
}

export function serverLabel(fp: string, pids: string[], projects: ProjectMap): string {
  if (pids.length === 1) return pids[0];
  const d = projects[pids[0]];
  return d ? `${d.host}:${d.port}` : fp;
}
