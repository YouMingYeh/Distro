import { env } from "./env";
import { KEY_SERVICES } from "./scrapers";

// Whose scraper keys a research call runs on. A workspace that saved its own key for any of the
// services a tool can use runs on its own keys only (its bill, no limit). Otherwise the call runs
// on this server's keys and counts against a daily allowance.
// Saved keys are encrypted (AES-256-GCM) with the KEYS_ENCRYPTION_KEY secret before they reach KV.

export const KEY_NAMES = Object.keys(KEY_SERVICES);
type Own = Record<string, string>;

const utf8 = new TextEncoder();
async function aesKey(): Promise<CryptoKey> {
  if (!env.KEYS_ENCRYPTION_KEY) throw new Error("This server cannot store credentials yet (KEYS_ENCRYPTION_KEY is unset).");
  // The secret is random (openssl rand -base64 32), so one SHA-256 is enough to shape it into a key.
  const raw = await crypto.subtle.digest("SHA-256", utf8.encode(env.KEYS_ENCRYPTION_KEY));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypt a value into KV. The KV key name is bound in, so a record copied to another workspace will not decrypt. */
export async function putSealed(name: string, value: unknown): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(name) }, await aesKey(), utf8.encode(JSON.stringify(value)));
  await env.OAUTH_KV.put(name, btoa(String.fromCharCode(...iv, ...new Uint8Array(sealed))));
}

/** Null when nothing is stored or it cannot be decrypted (wrong secret, tampered, or written before encryption). */
export async function getSealed<T>(name: string): Promise<T | null> {
  const stored = await env.OAUTH_KV.get(name);
  if (!stored) return null;
  try {
    const bytes = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: utf8.encode(name) }, await aesKey(), bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

export const userKeys = async (ws: string): Promise<Own> => (await getSealed<Own>(`keys:${ws}`)) ?? {};

/** A 15-minute link to the key form. The key never passes through the agent's conversation. */
export async function keysLink(ws: string): Promise<string> {
  const t = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  await env.OAUTH_KV.put(`keys:link:${t}`, ws, { expirationTtl: 900 });
  return `${env.ORIGIN}/keys?t=${t}`;
}
export const keysLinkWorkspace = async (t: unknown) =>
  typeof t === "string" && /^[0-9a-f]{64}$/.test(t) ? env.OAUTH_KV.get(`keys:link:${t}`) : null;

/** Apply the key form: a filled field replaces that key, a ticked "remove" deletes it, an empty field keeps it. */
export async function saveKeys(ws: string, form: FormData): Promise<Own> {
  const own = await userKeys(ws);
  for (const name of KEY_NAMES) {
    const v = String(form.get(name) ?? "").trim();
    if (form.get(`remove_${name}`)) delete own[name];
    else if (v && !/^[\x21-\x7e]{8,300}$/.test(v)) throw new Error(`The ${KEY_SERVICES[name]} key does not look like a key.`);
    else if (v) own[name] = v;
  }
  await putSealed(`keys:${ws}`, own);
  return own;
}

const cap = () => Number(env.FREE_DAILY_CALLS ?? 20);

/** Run a research call with the right keys, and say in the result whose keys paid for it. */
export async function withKeys<T extends object>(ws: string, names: readonly string[], run: (keys: Record<string, unknown>) => Promise<T>) {
  const own = await userKeys(ws);
  const mine = Object.fromEntries(names.filter((n) => own[n]).map((n) => [n, own[n]]));
  if (Object.keys(mine).length) return { ...(await run(mine)), keys: "yours" };

  const day = `quota:${ws}:${new Date().toISOString().slice(0, 10)}`;
  const used = Number((await env.OAUTH_KV.get(day)) ?? 0);
  if (used >= cap()) {
    throw new Error(
      `Daily limit reached: ${cap()} research calls a day run on Distro's keys. Call connect_keys so the user can add their own, or try again tomorrow (UTC).`,
    );
  }
  // ponytail: read-then-write, so parallel calls can slip a few past the cap. Count in a Durable Object if it must be exact.
  await env.OAUTH_KV.put(day, String(used + 1), { expirationTtl: 172_800 });
  return { ...(await run(env as unknown as Record<string, unknown>)), keys: "distro", calls_left_today: cap() - used - 1 };
}
