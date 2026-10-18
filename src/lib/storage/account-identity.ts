/**
 * Duplicate protection for Google Drive storage accounts.
 *
 * Identity keys:
 *   sub:<google account id>   — primary (immutable per Google account)
 *   email:<normalized email>  — secondary (emails can change / be re-used)
 *
 * The store exposes an atomic "claim" on an identity key (a Realtime Database
 * transaction in production), so concurrent OAuth callbacks for the same Google
 * account converge on a single `driveAccounts/{id}` record. Records created
 * before this protection existed (no `googleAccountId`) are matched by their
 * normalized email and back-filled on the next successful connection — they
 * are never deleted automatically.
 */
import type { Store } from "@/lib/db/store";
import type { DriveAccountRecord } from "@/lib/db/types";
import { newAccountId } from "@/lib/ids";

export type GoogleAccountIdentity = {
  /** Verified, stable Google account id (`sub`). */
  sub: string | null;
  email: string | null;
  name: string | null;
};

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  return e.length ? e : null;
}

export function subKey(sub: string): string {
  return `sub:${sub}`;
}
export function emailKey(normalizedEmail: string): string {
  return `email:${normalizedEmail}`;
}

export type ResolveResult = {
  account: DriveAccountRecord;
  /** True when a brand-new record was created in this call. */
  created: boolean;
  /** Existing record ids that also match this identity (not auto-merged). */
  conflicts: string[];
};

function matchesIdentity(a: DriveAccountRecord, sub: string | null, email: string | null): boolean {
  if (sub && a.googleAccountId && a.googleAccountId === sub) return true;
  if (email) {
    const recEmail = a.normalizedEmail ?? normalizeEmail(a.accountEmail);
    if (recEmail && recEmail === email) return true;
  }
  return false;
}

/** Prefer records with the strongest evidence: sub match, then most recently updated. */
function pickPrimary(cands: DriveAccountRecord[], sub: string | null): DriveAccountRecord {
  return [...cands].sort((a, b) => {
    const aSub = sub && a.googleAccountId === sub ? 1 : 0;
    const bSub = sub && b.googleAccountId === sub ? 1 : 0;
    if (aSub !== bSub) return bSub - aSub;
    const aCred = a.status !== "disconnected" ? 1 : 0;
    const bCred = b.status !== "disconnected" ? 1 : 0;
    if (aCred !== bCred) return bCred - aCred;
    return b.updatedAt - a.updatedAt;
  })[0];
}

async function waitForAccount(store: Store, id: string, attempts = 20, delayMs = 100): Promise<DriveAccountRecord | null> {
  for (let i = 0; i < attempts; i += 1) {
    const rec = await store.getDriveAccount(id);
    if (rec) return rec;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

/**
 * Find the single storage-account record for a Google identity or create one.
 * Safe under concurrent calls for the same identity: exactly one caller
 * observes `created: true`; the others receive the same record.
 */
export async function resolveOrCreateDriveAccount(
  store: Store,
  identity: GoogleAccountIdentity,
  input: { scope: string }
): Promise<ResolveResult> {
  const sub = identity.sub && identity.sub.trim() ? identity.sub.trim() : null;
  const email = normalizeEmail(identity.email);
  if (!sub && !email) {
    throw new Error("Google did not return a verifiable account identity (sub/email).");
  }
  const keys: string[] = [];
  if (sub) keys.push(subKey(sub));
  if (email) keys.push(emailKey(email));

  // 1. Existing records (including legacy ones without googleAccountId).
  const all = await store.listDriveAccounts();
  const matches = all.filter((a) => matchesIdentity(a, sub, email));
  if (matches.length) {
    const primary = pickPrimary(matches, sub);
    // Back-fill identity index + fields without touching credentials/files.
    for (const k of keys) await store.claimDriveIdentity(k, primary.id);
    const patch: Partial<Pick<DriveAccountRecord, "googleAccountId" | "normalizedEmail" | "accountEmail" | "displayName">> = {};
    if (sub && primary.googleAccountId !== sub) patch.googleAccountId = sub;
    if (email && primary.normalizedEmail !== email) patch.normalizedEmail = email;
    if (identity.email && !primary.accountEmail) patch.accountEmail = identity.email;
    if (identity.name && !primary.displayName) patch.displayName = identity.name;
    const updated = Object.keys(patch).length ? await store.updateDriveAccount(primary.id, patch) : primary;
    return {
      account: updated ?? primary,
      created: false,
      conflicts: matches.filter((m) => m.id !== primary.id).map((m) => m.id),
    };
  }

  // 2. No record yet: atomically claim the identity key(s) before inserting.
  const candidateId = newAccountId();
  const primaryKey = keys[0];
  const owner = await store.claimDriveIdentity(primaryKey, candidateId);
  if (owner !== candidateId) {
    // Lost the race (or an index entry already pointed somewhere): reuse it.
    const existing = await waitForAccount(store, owner);
    if (existing) {
      for (const k of keys.slice(1)) await store.claimDriveIdentity(k, existing.id);
      return { account: existing, created: false, conflicts: [] };
    }
    // Dangling index entry (record missing) — fall through and create the
    // record under the id the index already points to so they stay linked.
    const rec = await store.createDriveAccount({
      id: owner,
      accountEmail: identity.email,
      displayName: identity.name,
      scope: input.scope,
      googleAccountId: sub,
    });
    for (const k of keys.slice(1)) await store.claimDriveIdentity(k, rec.id);
    return { account: rec, created: true, conflicts: [] };
  }

  const conflicts: string[] = [];
  for (const k of keys.slice(1)) {
    const o = await store.claimDriveIdentity(k, candidateId);
    if (o !== candidateId) conflicts.push(o);
  }
  const rec = await store.createDriveAccount({
    id: candidateId,
    accountEmail: identity.email,
    displayName: identity.name,
    scope: input.scope,
    googleAccountId: sub,
  });
  return { account: rec, created: true, conflicts };
}

export type DuplicateGroup = {
  key: string;
  kind: "googleAccountId" | "email";
  accountIds: string[];
};

/**
 * Report (never fix) groups of records that refer to the same Google account,
 * so administrators can reconcile them deliberately.
 */
export function findDuplicateGroups(accounts: DriveAccountRecord[]): DuplicateGroup[] {
  const bySub = new Map<string, string[]>();
  const byEmail = new Map<string, string[]>();
  for (const a of accounts) {
    if (a.googleAccountId) bySub.set(a.googleAccountId, [...(bySub.get(a.googleAccountId) ?? []), a.id]);
    const e = a.normalizedEmail ?? normalizeEmail(a.accountEmail);
    if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), a.id]);
  }
  const groups: DuplicateGroup[] = [];
  for (const [key, ids] of bySub) if (ids.length > 1) groups.push({ key, kind: "googleAccountId", accountIds: ids });
  for (const [key, ids] of byEmail) {
    if (ids.length > 1 && !groups.some((g) => g.accountIds.join() === ids.join())) {
      groups.push({ key, kind: "email", accountIds: ids });
    }
  }
  return groups;
}
