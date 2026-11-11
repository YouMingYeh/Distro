import { env } from "./env";
import { createZernioProfile, deleteZernioProfile } from "./zernio";

/**
 * A profile groups connected accounts: one per brand or client, as in Zernio.
 * Every workspace starts with one named "Default"; the first in the list is the default.
 * `zernio_id` is filled in the first time the profile needs Zernio (connect, list, publish).
 */
export type Profile = { id: string; name: string; zernio_id?: string };

const MAX_PROFILES = 50;
const key = (workspaceId: string) => `profiles:${workspaceId}`;
const pub = ({ id, name }: Profile, i: number) => ({ id, name, default: i === 0 });

// ponytail: the whole list is one KV value, read then written. Two writes in the same
// second can lose one. Fine for a list a person edits by hand; move to D1 if profiles
// are ever created by automation at volume.
async function read(workspaceId: string): Promise<Profile[]> {
  const found = await env.OAUTH_KV.get<Profile[]>(key(workspaceId), "json");
  if (found?.length) return found;
  // First use. Adopt the single Zernio profile this workspace had before profiles existed.
  const legacy = await env.OAUTH_KV.get(`ws:${workspaceId}`);
  const first: Profile[] = [{ id: newId(), name: "Default", ...(legacy ? { zernio_id: legacy } : {}) }];
  await write(workspaceId, first);
  return first;
}
const write = (workspaceId: string, list: Profile[]) => env.OAUTH_KV.put(key(workspaceId), JSON.stringify(list));
const newId = () => `prof_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

/** Finds by id or by name (case-insensitive). No ref means the default profile. */
function find(list: Profile[], ref?: string): Profile {
  if (!ref) return list[0];
  const wanted = ref.trim().toLowerCase();
  const hit = list.find((p) => p.id === ref || p.name.toLowerCase() === wanted);
  if (!hit) throw new Error(`No profile "${ref}". Known profiles: ${list.map((p) => p.name).join(", ")}.`);
  return hit;
}

function cleanName(list: Profile[], raw: string, except?: Profile): string {
  const name = raw.trim();
  if (list.some((p) => p !== except && p.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`A profile named "${name}" already exists.`);
  }
  return name;
}

export async function listProfiles(workspaceId: string) {
  return (await read(workspaceId)).map(pub);
}

export async function createProfile(workspaceId: string, rawName: string) {
  const list = await read(workspaceId);
  if (list.length >= MAX_PROFILES) throw new Error(`Profile limit reached (${MAX_PROFILES}).`);
  const profile: Profile = { id: newId(), name: cleanName(list, rawName) };
  list.push(profile);
  await write(workspaceId, list);
  return pub(profile, list.length - 1);
}

export async function renameProfile(workspaceId: string, ref: string, rawName: string) {
  const list = await read(workspaceId);
  const profile = find(list, ref);
  profile.name = cleanName(list, rawName, profile);
  await write(workspaceId, list);
  return pub(profile, list.indexOf(profile));
}

export async function deleteProfile(workspaceId: string, ref: string) {
  const list = await read(workspaceId);
  const profile = find(list, ref);
  if (list.length === 1) throw new Error("Cannot delete the only profile.");
  if (profile.zernio_id) await deleteZernioProfile(profile.zernio_id); // throws while accounts are still connected
  await write(workspaceId, list.filter((p) => p !== profile));
  return { deleted: profile.id };
}

/** The profile a tool call targets, with its Zernio profile created if this is its first use. */
export async function useProfile(workspaceId: string, ref?: string): Promise<{ id: string; name: string; zernioId: string }> {
  const list = await read(workspaceId);
  const profile = find(list, ref);
  if (!profile.zernio_id) {
    profile.zernio_id = await createZernioProfile(profile.id);
    await write(workspaceId, list);
  }
  return { id: profile.id, name: profile.name, zernioId: profile.zernio_id };
}
