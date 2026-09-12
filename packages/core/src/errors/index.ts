export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly safeMessage: string = message,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GatewayError";
  }
}

export class CapabilityUnsupportedError extends GatewayError {
  constructor(capability: string, reason?: string) {
    super(
      `Capability ${capability} is unsupported${reason ? `: ${reason}` : ""}`,
      "capability_unsupported",
      `当前 T3 环境不支持 ${capability}${reason ? `：${reason}` : ""}`,
    );
  }
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof GatewayError) return error.safeMessage;
  return "操作失败。请使用 /status 检查连接状态。";
}
