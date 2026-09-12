import type { ChangedFileSummary, DiffSummary } from "@t3-vibe/core";

export function summarizeUnifiedDiff(
  diff: string,
  range: { fromTurnCount?: number; toTurnCount?: number } = {},
): DiffSummary {
  const files = new Map<string, ChangedFileSummary>();
  let current: ChangedFileSummary | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      const path = line.slice(6);
      current = files.get(path) ?? { path, additions: 0, deletions: 0 };
      files.set(path, current);
    } else if (current && line.startsWith("+") && !line.startsWith("+++")) current.additions++;
    else if (current && line.startsWith("-") && !line.startsWith("---")) current.deletions++;
  }
  const values = [...files.values()];
  return {
    diff,
    files: values,
    additions: values.reduce((sum, file) => sum + file.additions, 0),
    deletions: values.reduce((sum, file) => sum + file.deletions, 0),
    ...range,
  };
}
