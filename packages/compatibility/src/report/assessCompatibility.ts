import { T3_PROTOCOL_PROFILE_0040 } from "../../../adapter-t3/src/protocol/profile.js";
import type { ProtocolFingerprintReport } from "../fingerprint/sourceFingerprint.js";

export interface CompatibilityIssue {
  feature: string;
  kind: "protocol-breaking-change";
  expected: string;
  observed: string;
}

const methodFeatures: Record<string, string> = {
  "orchestration.dispatchCommand": "thread/turn mutations",
  "orchestration.getTurnDiff": "turn diff",
  "orchestration.getFullThreadDiff": "thread diff",
  "orchestration.searchThreads": "thread search/attach",
  "orchestration.getArchivedShellSnapshot": "archived thread listing",
  "orchestration.subscribeThread": "thread streaming",
};

const commandFeatures: Record<string, string> = {
  "project.create": "project creation",
  "thread.create": "thread creation",
  "thread.meta.update": "thread rename",
  "thread.archive": "thread archive",
  "thread.turn.start": "turn start",
  "thread.turn.interrupt": "turn interrupt",
  "thread.approval.respond": "approval response",
};

export function assessCompatibility(report: ProtocolFingerprintReport): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  for (const method of T3_PROTOCOL_PROFILE_0040.methods) {
    if (!report.methods.includes(method)) {
      issues.push({
        feature: methodFeatures[method] ?? method,
        kind: "protocol-breaking-change",
        expected: `RPC method ${method}`,
        observed: "method missing from current upstream contracts",
      });
    }
  }
  for (const command of T3_PROTOCOL_PROFILE_0040.commands) {
    if (!report.commands.includes(command)) {
      issues.push({
        feature: commandFeatures[command] ?? command,
        kind: "protocol-breaking-change",
        expected: `command discriminator ${command}`,
        observed: "command missing from current upstream contracts",
      });
    }
  }
  for (const path of ["/oauth/token", "/api/auth/websocket-ticket"]) {
    if (!report.authPaths.includes(path)) {
      issues.push({
        feature: "authentication",
        kind: "protocol-breaking-change",
        expected: `HTTP endpoint ${path}`,
        observed: "endpoint missing from current upstream contracts",
      });
    }
  }
  return issues;
}
