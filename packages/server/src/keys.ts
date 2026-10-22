// The server's 32-byte secret key, which encrypts stored git credentials and webhook secrets.
// INTRA_SKILLS_SECRET_KEY (base64) wins; otherwise <data>/secret.key is created once, mode 0600.
// Losing the key means re-entering every git credential, so back it up with the database.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function loadSecretKey(dataDir: string): Buffer {
  const env = process.env.INTRA_SKILLS_SECRET_KEY;
  if (env) {
    const key = Buffer.from(env, "base64");
    if (key.length !== 32) throw new Error("INTRA_SKILLS_SECRET_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
    return key;
  }
  const file = join(dataDir, "secret.key");
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error(`${file} does not hold a 32-byte base64 key`);
    return key;
  }
  const key = randomBytes(32);
  writeFileSync(file, key.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  return key;
}
