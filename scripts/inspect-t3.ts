import {
  BearerAuthStrategy,
  EffectJsonRpcTransport,
  T3DiscoveryClient,
  T3_PROTOCOL_FINGERPRINT,
} from "@t3-vibe/adapter-t3";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const baseUrl = argument("--url") ?? process.env.T3_BASE_URL ?? "http://127.0.0.1:3773";
const pairingToken = argument("--pairing-token") ?? process.env.T3_PAIRING_TOKEN;
const discovery = new T3DiscoveryClient({ allowedHosts: [], allowPrivateNetworks: true });
const result = await discovery.discover(baseUrl);

const report: Record<string, unknown> = {
  observedAt: result.discoveredAt,
  baseUrl: result.baseUrl,
  serverVersion: result.descriptor.serverVersion,
  descriptor: result.descriptor,
  auth: result.auth,
  descriptorFingerprint: result.descriptorFingerprint,
  adapterProtocolFingerprint: T3_PROTOCOL_FINGERPRINT,
  rpcProbe: pairingToken ? "pending" : "skipped (pass --pairing-token for authenticated safe read)",
};

if (pairingToken) {
  const auth = new BearerAuthStrategy();
  await auth.authenticate({ baseUrl: result.baseUrl, credential: pairingToken });
  const ticket = await auth.issueWebSocketTicket(result.baseUrl);
  const url = new URL(result.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("clientSurface", "web");
  url.searchParams.set("clientDeviceType", "unknown");
  url.searchParams.set("connectionMethod", "direct");
  const rpc = new EffectJsonRpcTransport(url.toString());
  try {
    await rpc.open();
    const response = await rpc.request("orchestration.searchThreads", {
      query: "__t3_gateway_probe__",
      limit: 1,
    });
    report.rpcProbe = { ok: true, responseShape: Object.keys(response as object).sort() };
  } finally {
    await rpc.close();
  }
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
