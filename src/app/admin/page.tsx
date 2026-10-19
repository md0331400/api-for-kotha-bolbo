"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Activity, AlertTriangle, FileStack, HardDrive, Users } from "lucide-react";
import { useAuth } from "@/lib/admin/auth-context";
import { api, ApiClientError } from "@/lib/admin/api-client";
import { formatBytes, formatDate } from "@/lib/format";
import { Badge, Button, Card, ErrorBanner, PageLoading, StatCard, Table } from "@/components/admin/ui";
import { PageHeader } from "@/components/admin/shell";

type Stats = {
  users: { total: number; restricted: number; totalQuotaBytes: number };
  files: { total: number; confirmed: number; pendingDelete: number; deleteFailed: number; totalBytes: number };
  driveAccounts: { total: number; enabled: number; disabled: number; disconnected: number; error: number; verified: number };
  expiringWithin7Days: number;
  failedUploads: number;
  recentFailedUploads: Array<{ uploadId: string; name: string; category: string; error: string | null; updatedAt: string | null }>;
  cleanup: {
    lastRun: {
      id: string;
      status: string;
      startedAt: string | null;
      finishedAt: string | null;
      deleted: number;
      failed: number;
      errors: Array<{ fileId?: string; message: string }>;
    } | null;
    pendingRetries: number;
  };
  generatedAt: string;
};

export default function OverviewPage() {
  const { user } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      setStats(await api.get<Stats>(user, "/api/v1/admin/stats"));
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to load overview.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <PageHeader
        title="Overview"
        description="Real-time figures from the storage database. Empty means zero — nothing is simulated."
        actions={
          <Button variant="secondary" size="sm" onClick={load} loading={loading}>
            Refresh
          </Button>
        }
      />

      {error && <ErrorBanner message={error} />}
      {loading && !stats && <PageLoading label="Loading overview…" />}

      {stats && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Registered users" value={stats.users.total} hint={`${stats.users.restricted} restricted`} />
            <StatCard
              label="Confirmed files"
              value={stats.files.confirmed}
              hint={`${formatBytes(stats.files.totalBytes)} stored`}
            />
            <StatCard
              label="Drive accounts"
              value={`${stats.driveAccounts.enabled} / ${stats.driveAccounts.total}`}
              hint={`${stats.driveAccounts.verified} verified · ${stats.driveAccounts.error} in error`}
              tone={stats.driveAccounts.error > 0 ? "warning" : "default"}
            />
            <StatCard
              label="Expiring within 7 days"
              value={stats.expiringWithin7Days}
              hint={`${stats.failedUploads} failed upload${stats.failedUploads === 1 ? "" : "s"}`}
              tone={stats.expiringWithin7Days > 0 ? "warning" : "default"}
            />
          </div>

          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card
              title="Storage pool"
              subtitle="Google Drive account health"
              actions={
                <Link href="/admin/drive" className="text-sm font-medium text-brand-600 hover:text-brand-700">
                  Manage
                </Link>
              }
            >
              {stats.driveAccounts.total === 0 ? (
                <div className="py-6 text-center">
                  <HardDrive className="mx-auto h-8 w-8 text-slate-300" />
                  <p className="mt-2 text-sm text-slate-600">No Google Drive accounts connected yet.</p>
                  <Link href="/admin/drive" className="mt-2 inline-block text-sm font-medium text-brand-600 hover:underline">
                    Connect Google Drive
                  </Link>
                </div>
              ) : (
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">Enabled</span>
                    <Badge tone="green">{stats.driveAccounts.enabled}</Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">Disabled</span>
                    <Badge tone="amber">{stats.driveAccounts.disabled}</Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">Disconnected</span>
                    <Badge tone="neutral">{stats.driveAccounts.disconnected}</Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">Error</span>
                    <Badge tone={stats.driveAccounts.error ? "red" : "neutral"}>{stats.driveAccounts.error}</Badge>
                  </div>
                </div>
              )}
            </Card>

            <Card
              title="Cleanup job"
              subtitle="60-day expiry pipeline"
              actions={
                <Link href="/admin/logs" className="text-sm font-medium text-brand-600 hover:text-brand-700">
                  History
                </Link>
              }
            >
              {stats.cleanup.lastRun ? (
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">Last run</span>
                    <span className="text-slate-900">{formatDate(stats.cleanup.lastRun.startedAt)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">Status</span>
                    <Badge tone={stats.cleanup.lastRun.status === "success" ? "green" : stats.cleanup.lastRun.status === "running" ? "blue" : "amber"}>
                      {stats.cleanup.lastRun.status}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">Deleted / failed</span>
                    <span className="text-slate-900">
                      {stats.cleanup.lastRun.deleted} / {stats.cleanup.lastRun.failed}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">Pending retries</span>
                    <span className="text-slate-900">{stats.cleanup.pendingRetries}</span>
                  </div>
                </div>
              ) : (
                <div className="py-6 text-center">
                  <Activity className="mx-auto h-8 w-8 text-slate-300" />
                  <p className="mt-2 text-sm text-slate-600">No cleanup runs yet.</p>
                  <p className="text-xs text-slate-400">
                    The scheduled job runs via Vercel Cron (see docs/DEPLOYMENT.md).
                  </p>
                </div>
              )}
            </Card>
          </div>

          <Card className="mt-6" title="Recent failed uploads" subtitle="Upload sessions that ended without a confirmed file">
            {stats.recentFailedUploads.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-500">No failed uploads.</p>
            ) : (
              <Table headers={["File", "Category", "Error", "When"]}>
                {stats.recentFailedUploads.map((u) => (
                  <tr key={u.uploadId}>
                    <td className="px-3 py-2.5 font-medium text-slate-900">{u.name}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone="blue">{u.category}</Badge>
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">{u.error ?? "—"}</td>
                    <td className="px-3 py-2.5 text-slate-500">{formatDate(u.updatedAt)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          {stats.files.pendingDelete > 0 && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {stats.files.pendingDelete} file(s) are queued for deletion and will be processed by the next cleanup run.
            </div>
          )}
        </>
      )}
    </div>
  );
}
