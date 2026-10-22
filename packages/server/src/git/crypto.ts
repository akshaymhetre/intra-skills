// AES-256-GCM for stored git credentials and webhook secrets, under the server's 32-byte key.
// Stored form: base64(iv[12] | tag[16] | ciphertext). `context` is bound as additional data, so a
// value copied into another row or column (another source's credential) fails to decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

function checkKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("the secret key must be 32 bytes");
}

export function encryptSecret(key: Buffer, plaintext: string, context: string): string {
  checkKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

/** Throws when the value was tampered with, encrypted under another key, or for another context. */
export function decryptSecret(key: Buffer, stored: string, context: string): string {
  checkKey(key);
  const raw = Buffer.from(stored, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("stored secret is truncated");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}
