import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { GatewayError } from "@t3-vibe/core";

export interface UrlPolicyOptions {
  allowedHosts: string[];
  allowPrivateNetworks: boolean;
}

function isPrivateIp(address: string): boolean {
  if (
    address === "::1" ||
    address.startsWith("fe80:") ||
    address.startsWith("fc") ||
    address.startsWith("fd")
  ) {
    return true;
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function hostAllowed(hostname: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return true;
  return allowedHosts.some((rule) => {
    const normalized = rule.trim().toLowerCase();
    if (normalized.startsWith("*.")) {
      return hostname.toLowerCase().endsWith(normalized.slice(1));
    }
    return hostname.toLowerCase() === normalized;
  });
}

export async function validateT3BaseUrl(input: string, policy: UrlPolicyOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new GatewayError("Invalid T3 URL", "invalid_url", "T3 地址无效。", { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GatewayError(
      "Unsupported URL protocol",
      "invalid_url_protocol",
      "仅支持 HTTP/HTTPS 地址。",
    );
  }
  if (url.username || url.password) {
    throw new GatewayError(
      "URL credentials are forbidden",
      "url_credentials_forbidden",
      "地址中不能包含用户名或密码。",
    );
  }
  if (!hostAllowed(url.hostname, policy.allowedHosts)) {
    throw new GatewayError(
      "Host is not allowlisted",
      "host_not_allowed",
      "该 T3 主机不在允许列表中。",
    );
  }

  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (!policy.allowPrivateNetworks && addresses.some(({ address }) => isPrivateIp(address))) {
    throw new GatewayError(
      "Private network target rejected",
      "private_network_rejected",
      "当前配置禁止连接私有网络地址。",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}
