import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AuthSessionStateSchema, EnvironmentDescriptorSchema } from "@t3-vibe/adapter-t3";

describe("T3 0.0.40 fixtures", () => {
  it("decodes additive descriptor and auth fields", () => {
    const descriptor = JSON.parse(
      readFileSync("tests/fixtures/t3/0.0.40/environment.json", "utf8"),
    );
    descriptor.addedInFuture = true;
    expect(EnvironmentDescriptorSchema.parse(descriptor).serverVersion).toBe("0.0.40");
    const auth = JSON.parse(
      readFileSync("tests/fixtures/t3/0.0.40/auth-session-unauthenticated.json", "utf8"),
    );
    expect(AuthSessionStateSchema.parse(auth).auth?.bootstrapMethods).toContain("one-time-token");
  });
});
