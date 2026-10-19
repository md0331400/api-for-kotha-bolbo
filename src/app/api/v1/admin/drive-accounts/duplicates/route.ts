import { apiRoute, dataResponse } from "@/lib/api/handler";
import { findDuplicateGroups } from "@/lib/storage/account-identity";
import { safeISOString } from "@/lib/safe-date";

/**
 * GET /api/v1/admin/drive-accounts/duplicates
 * Reports groups of storage-account records that point at the same Google
 * account (by stable Google account id or normalized email). Nothing is
 * merged or deleted automatically — files and metadata stay untouched.
 */
export const GET = apiRoute(
  async (ctx) => {
    const accounts = await ctx.store!.listDriveAccounts();
    const groups = findDuplicateGroups(accounts).map((g) => ({
      ...g,
      accounts: g.accountIds
        .map((id) => accounts.find((x) => x && x.id === id))
        .filter((a): a is NonNullable<typeof a> => Boolean(a))
        .map((a) => ({
          id: a.id,
          accountEmail: a.accountEmail ?? null,
          status: typeof a.status === "string" ? a.status : "unknown",
          verified: Boolean(a.verified),
          fileCount: typeof a.fileCount === "number" ? a.fileCount : 0,
          totalBytes: typeof a.totalBytes === "number" ? a.totalBytes : 0,
          connectedAt: safeISOString((a as unknown as Record<string, unknown>).connectedAt),
          hasGoogleAccountId: Boolean(a.googleAccountId),
        })),
    }));
    return dataResponse({ groups, total: groups.length });
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);
