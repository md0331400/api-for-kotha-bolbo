import { apiRoute, dataResponse } from "@/lib/api/handler";
import { findDuplicateGroups } from "@/lib/storage/account-identity";

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
      accounts: g.accountIds.map((id) => {
        const a = accounts.find((x) => x.id === id)!;
        return {
          id: a.id,
          accountEmail: a.accountEmail,
          status: a.status,
          verified: a.verified,
          fileCount: a.fileCount,
          totalBytes: a.totalBytes,
          connectedAt: new Date(a.connectedAt).toISOString(),
          hasGoogleAccountId: Boolean(a.googleAccountId),
        };
      }),
    }));
    return dataResponse({ groups, total: groups.length });
  },
  { auth: "admin", rateLimit: { limit: 240, windowSec: 60, bucket: "admin" } }
);
