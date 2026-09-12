import { describe, expect, it } from "vitest";
import { chunkTelegramText, renderDiffSummary } from "@t3-vibe/frontend-telegram";
import { summarizeUnifiedDiff } from "@t3-vibe/adapter-t3";

describe("Telegram rendering", () => {
  it("chunks at line boundaries within Telegram limits", () => {
    const chunks = chunkTelegramText(
      `${"a".repeat(2000)}\n${"b".repeat(2000)}\n${"c".repeat(2000)}`,
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 3900)).toBe(true);
    expect(chunks.join("\n").replace(/\n+/g, "\n")).toContain("b".repeat(100));
  });

  it("summarizes unified diffs", () => {
    const diff = summarizeUnifiedDiff(
      ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1,2 @@", "-old", "+new", "+more"].join("\n"),
    );
    expect(diff).toMatchObject({ additions: 2, deletions: 1 });
    expect(renderDiffSummary(diff)).toContain("src/a.ts  +2 -1");
  });
});
