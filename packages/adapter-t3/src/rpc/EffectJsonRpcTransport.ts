import WebSocket, { type RawData } from "ws";
import { GatewayError } from "@t3-vibe/core";
import { RpcFrameSchema, type RpcFrame } from "../protocol/schemas.js";
import { AsyncQueue } from "./AsyncQueue.js";
import type { RpcTransport } from "./RpcTransport.js";

interface PendingUnary {
  kind: "unary";
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

interface PendingStream {
  kind: "stream";
  queue: AsyncQueue<unknown>;
  abortCleanup?: () => void;
}

type Pending = PendingUnary | PendingStream;

function remoteFailure(exit: unknown): GatewayError {
  let detail = "T3 RPC returned a failure";
  if (exit && typeof exit === "object" && "cause" in exit) {
    const cause = (exit as { cause?: unknown }).cause;
    if (Array.isArray(cause)) {
      const failure = cause.find((item) => item && typeof item === "object" && "error" in item) as
        { error?: unknown } | undefined;
      const error = failure?.error;
      if (
        error &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string"
      ) {
        detail = error.message;
      }
      const defect = cause.find((item) => item && typeof item === "object" && "defect" in item) as
        { defect?: unknown } | undefined;
      if (typeof defect?.defect === "string") detail = defect.defect;
    }
  }
  return new GatewayError(detail, "t3_rpc_failure", detail.slice(0, 500));
}

export class EffectJsonRpcTransport implements RpcTransport {
  private socket: WebSocket | undefined;
  private requestId = 1;
  private readonly pending = new Map<number, Pending>();
  private heartbeat: NodeJS.Timeout | undefined;
  private missedPongs = 0;

  constructor(
    private readonly url: string,
    private readonly openTimeoutMs = 10_000,
  ) {}

  async open(): Promise<void> {
    if (this.isOpen()) return;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url, {
        perMessageDeflate: true,
        handshakeTimeout: this.openTimeoutMs,
        maxPayload: 32 * 1024 * 1024,
      });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(
          new GatewayError(
            "WebSocket open timeout",
            "rpc_open_timeout",
            "连接 T3 WebSocket 超时。",
          ),
        );
      }, this.openTimeoutMs);
      socket.once("open", () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.on("message", (data) => this.onMessage(data));
        socket.on("close", () => this.onClose());
        socket.on("error", () => undefined);
        this.startHeartbeat();
        resolve();
      });
      socket.once("error", (cause) => {
        clearTimeout(timer);
        reject(
          new GatewayError(
            "WebSocket connection failed",
            "rpc_connect_failed",
            "无法连接 T3 WebSocket。",
            { cause },
          ),
        );
      });
    });
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async request<T>(method: string, payload: unknown, timeoutMs = 20_000): Promise<T> {
    await this.open();
    const id = this.requestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new GatewayError(
            `RPC timeout: ${method}`,
            "rpc_timeout",
            "T3 请求超时；为避免重复执行，不会自动重试。",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        kind: "unary",
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.send({ _tag: "Request", id, tag: method, payload, headers: [] });
    });
  }

  stream<T>(method: string, payload: unknown, signal?: AbortSignal): AsyncIterable<T> {
    const queue = new AsyncQueue<T>();
    void this.startStream(method, payload, queue, signal);
    return queue;
  }

  private async startStream<T>(
    method: string,
    payload: unknown,
    queue: AsyncQueue<T>,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.open();
      const id = this.requestId++;
      const abort = () => {
        this.send({ _tag: "Interrupt", requestId: id });
        this.pending.delete(id);
        queue.end();
      };
      queue.setReturnHandler(abort);
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        kind: "stream",
        queue: queue as AsyncQueue<unknown>,
        ...(signal ? { abortCleanup: () => signal.removeEventListener("abort", abort) } : {}),
      });
      this.send({ _tag: "Request", id, tag: method, payload, headers: [] });
    } catch (error) {
      queue.fail(error);
    }
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.stopHeartbeat();
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 1_000);
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.close(1000, "gateway shutdown");
    });
  }

  private send(frame: unknown): void {
    if (!this.isOpen()) throw new Error("RPC WebSocket is not open");
    this.socket!.send(JSON.stringify(frame));
  }

  private onMessage(data: RawData): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(data.toString());
    } catch {
      this.failAll(
        new GatewayError("Invalid RPC JSON", "rpc_invalid_json", "T3 返回了无法解析的 RPC 数据。"),
      );
      return;
    }
    const frames = Array.isArray(decoded) ? decoded : [decoded];
    for (const raw of frames) {
      const parsed = RpcFrameSchema.safeParse(raw);
      if (!parsed.success) continue;
      this.handleFrame(parsed.data);
    }
  }

  private handleFrame(frame: RpcFrame): void {
    if (frame._tag === "Ping") {
      this.send({ _tag: "Pong" });
      return;
    }
    if (frame._tag === "Pong") {
      this.missedPongs = 0;
      return;
    }
    if (frame._tag === "Defect") {
      this.failAll(new GatewayError("T3 RPC defect", "rpc_defect", "T3 RPC 连接发生协议错误。"));
      return;
    }
    const requestId =
      typeof frame.requestId === "number" ? frame.requestId : Number(frame.requestId);
    if (!Number.isFinite(requestId)) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (frame._tag === "Chunk" && pending.kind === "stream") {
      const values = (frame as { values?: unknown }).values;
      for (const value of Array.isArray(values) ? values : [values]) {
        if (value !== undefined) pending.queue.push(value);
      }
      this.send({ _tag: "Ack", requestId });
      return;
    }
    if (frame._tag !== "Exit") return;
    this.pending.delete(requestId);
    const exit = (frame as { exit?: unknown }).exit;
    if (!exit || typeof exit !== "object" || !("_tag" in exit)) {
      const error = new GatewayError(
        "Malformed RPC exit",
        "rpc_malformed_exit",
        "T3 RPC 响应格式不兼容。",
      );
      if (pending.kind === "unary") {
        clearTimeout(pending.timer);
        pending.reject(error);
      } else pending.queue.fail(error);
      return;
    }
    if ((exit as { _tag: string })._tag === "Success") {
      const value = (exit as { value?: unknown }).value;
      if (pending.kind === "unary") {
        clearTimeout(pending.timer);
        pending.resolve(value);
      } else {
        pending.abortCleanup?.();
        pending.queue.end();
      }
    } else {
      const error = remoteFailure(exit);
      if (pending.kind === "unary") {
        clearTimeout(pending.timer);
        pending.reject(error);
      } else {
        pending.abortCleanup?.();
        pending.queue.fail(error);
      }
    }
  }

  private onClose(): void {
    this.socket = undefined;
    this.stopHeartbeat();
    this.failAll(
      new GatewayError(
        "RPC socket closed",
        "rpc_disconnected",
        "T3 连接已断开，将在下一次操作时重连。",
      ),
    );
  }

  private failAll(error: unknown): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.kind === "unary") {
        clearTimeout(pending.timer);
        pending.reject(error);
      } else {
        pending.abortCleanup?.();
        pending.queue.fail(error);
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.missedPongs = 0;
    this.heartbeat = setInterval(() => {
      if (!this.isOpen()) return;
      if (this.missedPongs >= 3) {
        this.socket?.terminate();
        return;
      }
      this.missedPongs++;
      this.send({ _tag: "Ping" });
    }, 5_000);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.missedPongs = 0;
  }
}
