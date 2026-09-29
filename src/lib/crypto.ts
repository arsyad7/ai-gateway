import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";

const ALGO = "aes-256-gcm";

function secretKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32",
    );
  }
  // A 64-char hex string is used as-is; anything else is stretched with scrypt
  // so a human-typed passphrase still yields a 32-byte key.
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  return scryptSync(raw, "ai-gateway.v1", 32);
}

/** Encrypts a provider API key for storage. Format: iv.tag.ciphertext (base64). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, secretKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    enc.toString("base64"),
  ].join(".");
}

export function decryptSecret(blob: string): string {
  const [ivB64, tagB64, dataB64] = blob.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed ciphertext");
  const decipher = createDecipheriv(
    ALGO,
    secretKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Shows just enough of a secret to recognise it: "sk-ant-…4f9a". */
export function maskSecret(secret: string): string {
  if (secret.length <= 12) return "•".repeat(secret.length);
  return `${secret.slice(0, 7)}…${secret.slice(-4)}`;
}

/** Mints a gateway key. The raw value is returned once and never stored. */
export function generateGatewayKey(): {
  raw: string;
  hash: string;
  prefix: string;
} {
  const raw = `gw_live_${randomBytes(24).toString("base64url")}`;
  return { raw, hash: sha256(raw), prefix: raw.slice(0, 16) };
}
