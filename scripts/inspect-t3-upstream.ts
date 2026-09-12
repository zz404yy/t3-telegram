import { fingerprintT3Source } from "@t3-vibe/compatibility";
import { execFileSync } from "node:child_process";

const checkout = process.argv[2];
if (!checkout) throw new Error("Usage: pnpm fingerprint:t3 /path/to/t3code-checkout");
const revision = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
process.stdout.write(
  `${JSON.stringify({ revision, ...fingerprintT3Source(checkout) }, null, 2)}\n`,
);
