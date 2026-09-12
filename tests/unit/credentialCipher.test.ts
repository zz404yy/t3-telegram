import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CredentialCipher } from "@t3-vibe/persistence";

describe("CredentialCipher", () => {
  it("round trips with AES-256-GCM and a random nonce", () => {
    const cipher = new CredentialCipher(randomBytes(32).toString("base64"));
    const first = cipher.encrypt("secret-token");
    const second = cipher.encrypt("secret-token");
    expect(first.equals(second)).toBe(false);
    expect(cipher.decrypt(first)).toBe("secret-token");
    expect(cipher.decrypt(second)).toBe("secret-token");
  });

  it("rejects tampered ciphertext", () => {
    const cipher = new CredentialCipher(randomBytes(32).toString("hex"));
    const encrypted = cipher.encrypt("secret-token");
    encrypted[encrypted.length - 1] = encrypted.at(-1)! ^ 1;
    expect(() => cipher.decrypt(encrypted)).toThrow();
  });
});
