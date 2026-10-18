/**
 * Google Drive storage pool: token handling, provider construction, account
 * selection, and provider error accounting. Access tokens are cached in
 * process memory only for their short lifetime; refresh tokens live in the
 * server-side database (optionally AES-GCM encrypted at rest).
 */
import type { AppConfig } from "@/lib/config";
import type { Store } from "@/lib/db/store";
import type { DriveAccountRecord } from "@/lib/db/types";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { decryptSecret, encryptSecret, isEncryptedEnvelope } from "@/lib/crypto";
import { GoogleDriveProvider } from "@/lib/storage/google-drive";
import { refreshAccessToken } from "@/lib/storage/google-oauth";
import type { StorageProvider } from "@/lib/storage/provider";

type CachedToken = { accessToken: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();

/** How long an account stays out of rotation after a provider error (ms). */
const ERROR_COOLDOWN_MS = 5 * 60 * 1000;

export function clearTokenCache(accountId?: string) {
  if (accountId) tokenCache.delete(accountId);
  else tokenCache.clear();
}

export function encryptRefreshToken(config: AppConfig, token: string): string {
  if (!config.credentialsEncryptionKey) return token;
  return encryptSecret(config.credentialsEncryptionKey, token);
}

export function decryptRefreshToken(config: AppConfig, stored: string): string {
  if (isEncryptedEnvelope(stored)) {
    if (!config.credentialsEncryptionKey) {
      throw new ApiError("CONFIG_MISSING", "CREDENTIALS_ENCRYPTION_KEY is required to read stored provider credentials.");
    }
    return decryptSecret(config.credentialsEncryptionKey, stored);
  }
  return stored;
}

/**
 * Build a provider for a specific connected account. Access tokens are minted
 * from the stored refresh token and cached briefly per account.
 */
export async function getDriveProvider(
  store: Store,
  config: AppConfig,
  accountId: string
): Promise<StorageProvider> {
  const tokenRec = await store.getDriveToken(accountId);
  if (!tokenRec) {
    throw new ApiError("PROVIDER_UNAVAILABLE", "Drive account has no stored credentials (reconnect required).");
  }
  const getAccessToken = async (): Promise<string> => {
    const cached = tokenCache.get(accountId);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
    const refreshToken = decryptRefreshToken(config, tokenRec.refreshToken);
    try {
      const set = await refreshAccessToken({
        clientId: config.googleOAuthClientId,
        clientSecret: config.googleOAuthClientSecret,
        refreshToken,
      });
      tokenCache.set(accountId, { accessToken: set.accessToken, expiresAt: set.expiresAt });
      return set.accessToken;
    } catch (e) {
      await store
        .updateDriveAccount(accountId, {
          status: "error",
          lastErrorAt: Date.now(),
          lastErrorMessage: "Google rejected the stored refresh token (reconnect required).",
        })
        .catch(() => undefined);
      throw e;
    }
  };
  return new GoogleDriveProvider({ accountId, getAccessToken });
}

/**
 * Eligible accounts for a new upload: enabled accounts, preferring verified
 * ones, then least-loaded. Accounts that recently failed are cooled down.
 */
export async function selectEligibleAccounts(store: Store): Promise<DriveAccountRecord[]> {
  const now = Date.now();
  const accounts = await store.listDriveAccounts();
  return accounts
    .filter((a) => a.status === "enabled")
    .filter((a) => !a.lastErrorAt || now - a.lastErrorAt > ERROR_COOLDOWN_MS || a.lastSuccessAt === null)
    .sort((a, b) => {
      if (a.verified !== b.verified) return a.verified ? -1 : 1;
      if (a.fileCount !== b.fileCount) return a.fileCount - b.fileCount;
      return a.totalBytes - b.totalBytes;
    });
}

export async function recordAccountSuccess(store: Store, accountId: string): Promise<void> {
  const now = Date.now();
  await store
    .updateDriveAccount(accountId, {
      lastSuccessAt: now,
      lastErrorMessage: null,
      verified: true,
      ...(await (async () => {
        const a = await store.getDriveAccount(accountId);
        return a && a.status === "error" ? { status: "enabled" as const } : {};
      })()),
    })
    .catch(() => undefined);
}

const folderLocks = new Map<string, Promise<string>>();

export async function recordAccountError(store: Store, accountId: string, message: string): Promise<void> {
  const now = Date.now();
  await store
    .updateDriveAccount(accountId, {
      lastErrorAt: now,
      lastErrorMessage: message.slice(0, 500),
      status: "error",
    })
    .catch(() => undefined);
  logger.warn("drive.account_error", { accountId, message: message.slice(0, 200) });
}

/**
 * Pick an account and create a resumable session for a new object, failing over
 * across eligible accounts on provider errors.
 */

async function resolveDrivePath(
  store: Store,
  provider: any,
  accountId: string,
  managedFolderId: string,
  appId: string,
  uid: string,
  category: string
): Promise<string> {
  const ensure = async (name: string, parentId: string, key: string): Promise<string> => {
    const lockKey = `${accountId}:${key}`;
    if (folderLocks.has(lockKey)) {
      return folderLocks.get(lockKey)!;
    }
    const p = (async () => {
      let fId = await store.getDriveFolder(accountId, key);
      if (!fId) {
        const res = await provider.ensureFolder(name, parentId);
        fId = await store.setDriveFolder(accountId, key, res.id);
        if (fId !== res.id) {
          // We lost the race to another instance, clean up our duplicate folder
          provider.deleteFile(res.id).catch(() => {});
        }
      }
      return fId;
    })();
    folderLocks.set(lockKey, p);
    try {
      return await p;
    } finally {
      folderLocks.delete(lockKey);
    }
  };

  const appsId = await ensure("Applications", managedFolderId, "sys_Applications");
  const appIdFolder = await ensure(appId, appsId, `app_${appId}`);
  const usersId = await ensure("Users", appIdFolder, `app_${appId}_Users`);
  const uidId = await ensure(uid, usersId, `app_${appId}_usr_${uid}`);
  const catId = await ensure(category, uidId, `app_${appId}_usr_${uid}_cat_${category}`);
  return catId;
}

export async function createResumableOnPool(
  store: Store,
  config: AppConfig,
  input: { name: string; mimeType: string; sizeBytes: number; appId: string; uid: string; category: string }
): Promise<{ accountId: string; managedFolderId: string; uploadUrl: string; expiresAt: number; headers: Record<string, string> }> {
  const eligible = await selectEligibleAccounts(store);
  if (!eligible.length) {
    throw new ApiError(
      "PROVIDER_UNAVAILABLE",
      "No eligible Google Drive storage account is available. An administrator must connect and enable an account."
    );
  }
  const errors: string[] = [];
  for (const account of eligible) {
    try {
      const provider = await getDriveProvider(store, config, account.id);
      let managedFolderId = account.managedFolderId;
      if (!managedFolderId) {
        const folder = await provider.ensureManagedFolder();
        managedFolderId = folder.id;
        await store.updateDriveAccount(account.id, { managedFolderId });
      }
      const targetFolderId = await resolveDrivePath(store, provider, account.id, managedFolderId, input.appId, input.uid, input.category);
      const session = await provider.createResumableUpload({
        name: input.name,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        parentId: targetFolderId,
      });
      return {
        accountId: account.id,
        managedFolderId,
        uploadUrl: session.uploadUrl,
        expiresAt: session.expiresAt,
        headers: session.headers,
      };
    } catch (e) {
      const message = e instanceof ApiError ? e.message : "Unknown provider error";
      errors.push(`${account.id}: ${message}`);
      await recordAccountError(store, account.id, message);
      logger.warn("drive.upload_session_failover", { accountId: account.id });
    }
  }
  throw new ApiError("PROVIDER_ERROR", "All eligible Drive accounts failed to accept the upload.", {
    details: { errors: errors.slice(0, 5) },
  });
}
