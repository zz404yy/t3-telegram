import { describe, expect, it } from "vitest";
import { assessCompatibility } from "@t3-vibe/compatibility";

describe("compatibility assessment", () => {
  it("produces a focused feature failure for an incompatible surface", () => {
    const issues = assessCompatibility({
      methods: ["orchestration.searchThreads"],
      commands: [],
      events: [],
      authPaths: ["/oauth/token"],
      approvals: [],
      fingerprint: "sha256:test",
    });
    expect(issues).toContainEqual({
      feature: "turn start",
      kind: "protocol-breaking-change",
      expected: "command discriminator thread.turn.start",
      observed: "command missing from current upstream contracts",
    });
    expect(issues.some((issue) => issue.feature === "authentication")).toBe(true);
  });
});
