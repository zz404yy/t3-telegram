import { readFileSync } from "node:fs";
import { assessCompatibility, type ProtocolFingerprintReport } from "@t3-vibe/compatibility";

const reportPath = process.argv[2];
if (!reportPath) throw new Error("Usage: tsx scripts/check-t3-compatibility.ts report.json");
const report = JSON.parse(readFileSync(reportPath, "utf8")) as ProtocolFingerprintReport;
const issues = assessCompatibility(report);
process.stdout.write(`${JSON.stringify({ compatible: issues.length === 0, issues }, null, 2)}\n`);
if (issues.length > 0) process.exitCode = 1;
