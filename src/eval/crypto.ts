/** AES-256-GCM envelopes for pilot case sets (E6, §6.3). `node:crypto` only. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export class EvalCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalCryptoError";
  }
}

const ALG = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Throws unless the text is base64 of exactly 32 bytes. Messages never echo the value. */
export function parseKey(b64: string): Buffer {
  const text = b64.trim();
  if (!BASE64.test(text)) throw new EvalCryptoError("GRAFT_EVAL_KEY is not base64");
  const key = Buffer.from(text, "base64");
  if (key.length !== 32) throw new EvalCryptoError("GRAFT_EVAL_KEY must decode to 32 bytes");
  return key;
}

/** First 8 hex characters of SHA-256 of the key: detects a wrong key early, reveals nothing useful. */
export function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export function generateKey(): string {
  return randomBytes(32).toString("base64");
}

/** A fresh random IV for every call: two seals of the same text differ. */
export function seal(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return JSON.stringify({
    graftEval: "enc-v1",
    kid: keyId(key),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  });
}

interface Envelope {
  graftEval: "enc-v1";
  kid: string;
  iv: string;
  tag: string;
  ct: string;
}

function parseEnvelope(text: string): Envelope {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new EvalCryptoError("not an eval envelope");
  }
  const e = v as Partial<Record<keyof Envelope, unknown>>;
  if (
    typeof v !== "object" ||
    v === null ||
    e.graftEval !== "enc-v1" ||
    typeof e.kid !== "string" ||
    typeof e.iv !== "string" ||
    typeof e.tag !== "string" ||
    typeof e.ct !== "string"
  ) {
    throw new EvalCryptoError("not an eval envelope");
  }
  return e as unknown as Envelope;
}

/**
 * Verifies the tag and the AAD before returning any plaintext. Every failure is an
 * `EvalCryptoError` whose message holds no plaintext.
 */
export function open(envelope: string, key: Buffer, aad: string): string {
  const e = parseEnvelope(envelope);
  if (e.kid !== keyId(key)) throw new EvalCryptoError("wrong key (key id mismatch)");
  const iv = Buffer.from(e.iv, "base64");
  const tag = Buffer.from(e.tag, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new EvalCryptoError("malformed envelope");
  }
  try {
    const decipher = createDecipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(e.ct, "base64")), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new EvalCryptoError("decryption failed: tampered data, wrong key or wrong location");
  }
}
