import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;

export class CredentialCipher {
  private readonly key: Buffer;

  constructor(encodedKey: string) {
    const trimmed = encodedKey.trim();
    const key = /^[0-9a-f]{64}$/i.test(trimmed)
      ? Buffer.from(trimmed, "hex")
      : Buffer.from(trimmed, "base64");
    if (key.length !== 32) {
      throw new Error("GATEWAY_MASTER_KEY must be 32 bytes encoded as base64 or 64 hex characters");
    }
    this.key = key;
  }

  encrypt(plaintext: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([VERSION]), nonce, tag, ciphertext]);
  }

  decrypt(payload: Buffer): string {
    if (payload.length < 30 || payload[0] !== VERSION) {
      throw new Error("Unsupported encrypted credential payload");
    }
    const nonce = payload.subarray(1, 13);
    const tag = payload.subarray(13, 29);
    const ciphertext = payload.subarray(29);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}
