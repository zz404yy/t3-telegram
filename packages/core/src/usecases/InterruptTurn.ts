import { CapabilityUnsupportedError, GatewayError } from "../errors/index.js";
import type { CodingBackend } from "../ports/CodingBackend.js";
import type { BindingRecord } from "../domain/types.js";

export async function interruptBoundTurn(
  backend: CodingBackend,
  binding: BindingRecord,
): Promise<"interrupted" | "already_finished"> {
  const status = await backend.connect(binding.environmentId);
  if (status.state !== "connected" && status.state !== "degraded") {
    throw new GatewayError(
      status.message ?? `T3 environment is ${status.state}`,
      "t3_unavailable",
      "T3 环境当前不可用，请用 /status 检查。",
    );
  }
  const capabilities = await backend.getCapabilities(binding.environmentId);
  if (
    capabilities.turnInterrupt.state === "unsupported" ||
    capabilities.turnInterrupt.state === "unknown"
  ) {
    throw new CapabilityUnsupportedError("中断", capabilities.turnInterrupt.reason);
  }
  const threads = await backend.listThreads({
    environmentId: binding.environmentId,
    ...(binding.t3ProjectId ? { projectId: binding.t3ProjectId } : {}),
    limit: 50,
  });
  const thread = threads.find((item) => item.id === binding.t3ThreadId);
  if (thread?.latestTurn?.state !== "running") return "already_finished";
  await backend.interruptTurn({
    environmentId: binding.environmentId,
    threadId: binding.t3ThreadId,
    turnId: thread.latestTurn.id,
  });
  return "interrupted";
}
