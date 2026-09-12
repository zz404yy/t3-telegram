import { bootstrap } from "./bootstrap.js";
import { loadConfig } from "./config.js";

const application = bootstrap(loadConfig());

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void application.stop().finally(() => process.exit(0));
  });
}

application.start().catch((error: unknown) => {
  process.stderr.write(
    `Gateway startup failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  void application.stop().finally(() => process.exit(1));
});
