import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encrypts OAuth refresh tokens at rest in the plugin's database namespace.
 *
 * The key is derived (HKDF-SHA256) from the OAuth client secret, which itself
 * lives in the Paperclip secrets vault, bound to the company id. A plugin
 * database dump alone therefore never reveals a usable token. Rotating the
 * client secret invalidates stored tokens, which surfaces as "TOKEN EXPIRED"
 * and asks for a reconnect.
 */
function deriveKey(keyMaterial: string, companyId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(keyMaterial, "utf8"), Buffer.from(companyId, "utf8"), "magnora-gmail-token-v1", 32));
}

export function encryptToken(plaintext: string, keyMaterial: string, companyId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(keyMaterial, companyId), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptToken(payload: string, keyMaterial: string, companyId: string): string | null {
  const [version, iv, tag, data] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(keyMaterial, companyId), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
