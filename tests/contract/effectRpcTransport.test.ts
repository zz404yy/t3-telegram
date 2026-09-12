import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { EffectJsonRpcTransport } from "@t3-vibe/adapter-t3";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function server(
  handler: (frame: Record<string, unknown>, send: (frame: unknown) => void) => void,
) {
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  ws.on("connection", (socket) => {
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      handler(frame, (reply) => socket.send(JSON.stringify(reply)));
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  cleanup.push(async () => {
    ws.clients.forEach((client) => client.terminate());
    await new Promise<void>((resolve) => ws.close(() => http.close(() => resolve())));
  });
  return `ws://127.0.0.1:${address.port}`;
}

describe("Effect JSON RPC transport", () => {
  it("correlates unary Success exits", async () => {
    const url = await server((frame, send) => {
      expect(frame).toMatchObject({
        _tag: "Request",
        tag: "safe.read",
        payload: { value: 1 },
        headers: [],
      });
      send({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: { ok: true } } });
    });
    const transport = new EffectJsonRpcTransport(url);
    expect(await transport.request("safe.read", { value: 1 })).toEqual({ ok: true });
    await transport.close();
  });

  it("surfaces request-scoped defects so capability probes can detect unknown methods", async () => {
    const url = await server((frame, send) => {
      send({
        _tag: "Exit",
        requestId: frame.id,
        exit: {
          _tag: "Failure",
          cause: [{ _tag: "Die", defect: `Unknown request tag: ${String(frame.tag)}` }],
        },
      });
    });
    const transport = new EffectJsonRpcTransport(url);
    await expect(transport.request("missing.method", {})).rejects.toMatchObject({
      code: "t3_rpc_failure",
      message: "Unknown request tag: missing.method",
    });
    await transport.close();
  });

  it("acks chunks and ends streams on Success", async () => {
    let acked = false;
    const url = await server((frame, send) => {
      if (frame._tag === "Request") {
        send({ _tag: "Chunk", requestId: frame.id, values: [{ event: 1 }, { event: 2 }] });
      } else if (frame._tag === "Ack") {
        acked = true;
        send({ _tag: "Exit", requestId: frame.requestId, exit: { _tag: "Success", value: null } });
      }
    });
    const transport = new EffectJsonRpcTransport(url);
    const values: unknown[] = [];
    for await (const value of transport.stream("safe.subscribe", {})) values.push(value);
    expect(values).toEqual([{ event: 1 }, { event: 2 }]);
    expect(acked).toBe(true);
    await transport.close();
  });

  it("sends Interrupt when a consumer stops a subscription", async () => {
    let interrupted = false;
    let release!: () => void;
    const receivedInterrupt = new Promise<void>((resolve) => {
      release = resolve;
    });
    const url = await server((frame, send) => {
      if (frame._tag === "Request") {
        send({ _tag: "Chunk", requestId: frame.id, values: [{ event: 1 }] });
      } else if (frame._tag === "Interrupt") {
        interrupted = true;
        release();
      }
    });
    const transport = new EffectJsonRpcTransport(url);
    for await (const value of transport.stream("safe.subscribe", {})) {
      expect(value).toEqual({ event: 1 });
      break;
    }
    await receivedInterrupt;
    expect(interrupted).toBe(true);
    await transport.close();
  });
});
