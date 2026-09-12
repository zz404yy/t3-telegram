import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProtocolFingerprintReport {
  methods: string[];
  commands: string[];
  events: string[];
  authPaths: string[];
  approvals: string[];
  fingerprint: string;
}

const watchedFiles = {
  orchestration: "packages/contracts/src/orchestration.ts",
  environmentHttp: "packages/contracts/src/environmentHttp.ts",
  serverWs: "apps/server/src/ws.ts",
} as const;

function matches(source: string, expression: RegExp, group = 1): string[] {
  return [...source.matchAll(expression)].flatMap((match) => (match[group] ? [match[group]!] : []));
}

export function fingerprintT3Source(checkout: string): ProtocolFingerprintReport {
  const orchestration = readFileSync(join(checkout, watchedFiles.orchestration), "utf8");
  const environmentHttp = readFileSync(join(checkout, watchedFiles.environmentHttp), "utf8");
  const serverWs = readFileSync(join(checkout, watchedFiles.serverWs), "utf8");
  const methods = [
    ...new Set(matches(orchestration, /["'](orchestration\.[A-Za-z]+)["']/g)),
  ].sort();
  const commands = [
    ...new Set(
      matches(orchestration, /Schema\.Literal\(["']([^"']+)["']\)/g).filter((value) =>
        value.includes("."),
      ),
    ),
  ].sort();
  const events = commands.filter(
    (value) => value.startsWith("thread.") || value.startsWith("project."),
  );
  const authPaths = [
    ...new Set(matches(environmentHttp, /["'](\/(?:api\/auth|oauth|\.well-known)[^"']*)["']/g)),
  ].sort();
  const approvals = ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"].filter(
    (value) => orchestration.includes(`"${value}"`),
  );
  const canonical = {
    methods,
    commands,
    events,
    authPaths,
    approvals,
    wsRoute: serverWs.includes('"/ws"'),
  };
  return {
    methods,
    commands,
    events,
    authPaths,
    approvals,
    fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`,
  };
}
