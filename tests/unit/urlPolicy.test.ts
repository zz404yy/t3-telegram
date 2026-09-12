import { describe, expect, it } from "vitest";
import { validateT3BaseUrl } from "@t3-vibe/adapter-t3";

describe("T3 URL policy", () => {
  it("rejects non-http protocols and URL credentials", async () => {
    await expect(
      validateT3BaseUrl("file:///etc/passwd", { allowedHosts: [], allowPrivateNetworks: true }),
    ).rejects.toMatchObject({ code: "invalid_url_protocol" });
    await expect(
      validateT3BaseUrl("http://user:pass@localhost:3773", {
        allowedHosts: [],
        allowPrivateNetworks: true,
      }),
    ).rejects.toMatchObject({ code: "url_credentials_forbidden" });
  });

  it("allows explicitly configured private targets", async () => {
    const url = await validateT3BaseUrl("http://127.0.0.1:3773/", {
      allowedHosts: ["127.0.0.1"],
      allowPrivateNetworks: true,
    });
    expect(url.toString()).toBe("http://127.0.0.1:3773/");
  });
});
