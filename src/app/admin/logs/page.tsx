"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Play, RefreshCw } from "lucide-react";
import { useAuth } from "@/lib/admin/auth-context";
import { api, ApiClientError } from "@/lib/admin/api-client";
import { formatDate } from "@/lib/format";
import { Badge, Button, Card, EmptyState, ErrorBanner, PageLoading, Pagination, Table, Toast } from "@/components/admin/ui";
import { PageHeader } from "@/components/admin/shell";

type AuditLog = {
  id: string;
  at: string;
  actorUid: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string;
  requestId: string | null;
  details: Record<string, unknown>;
};

type CleanupRun = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  scanned: number;
  deleted: number;
  reservationReleased: number;
  notified: number;
  failed: number;
  errors: Array<{ fileId?: string; message: string }>;
  triggeredBy: string;
};

type JobsResponse = { runs: CleanupRun[]; pendingRetries: number };

const RUN_TONE: Record<string, "green" | "amber" | "red" | "blue"> = {
  success: "green",
  partial: "amber",
  failed: "red",
  running: "blue",
};

export default function LogsPage() {
  const { user } = useAuth();
  const [logs, setLogs] = useState<AuditLog[] | null>(null);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [jobs, setJobs] = useState<JobsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setError(null);
    try {
      const [logsRes, jobsRes] = await Promise.all([
        api.get<{ data: AuditLog[]; pagination: { total: number; totalPages: number } }>(
          user,
          `/api/v1/admin/audit-logs?page=${page}&pageSize=25`
        ),
        api.get<JobsResponse>(user, "/api/v1/admin/jobs/cleanup"),
      ]);
      setLogs(logsRes.data);
      setTotal(logsRes.pagination.total);
      setTotalPages(logsRes.pagination.totalPages);
      setJobs(jobsRes);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to load logs.");
    }
  }, [user, page]);

  useEffect(() => {
    load();
  }, [load]);

  const runCleanup = async () => {
    setBusy(true);
    try {
      const run = await api.post<CleanupRun>(user!, "/api/v1/admin/jobs/cleanup");
      setToast({
        message: `Cleanup finished: ${run.deleted} deleted, ${run.failed} failed, ${run.reservationReleased} reservations released.`,
        tone: run.failed > 0 ? "error" : "success",
      });
      await load();
    } catch (e) {
      setToast({ message: e instanceof ApiClientError ? e.message : "Cleanup failed.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Logs & Jobs"
        description="Administrator actions, cleanup runs, and retry state. Secrets, tokens, and file contents are never logged."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={load}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            <Button size="sm" onClick={runCleanup} loading={busy}>
              <Play className="h-3.5 w-3.5" /> Run cleanup now
            </Button>
          </>
        }
      />

      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}

      <Card className="mb-6" title="Cleanup runs" subtitle={jobs ? `${jobs.pendingRetries} pending retr${jobs.pendingRetries === 1 ? "y" : "ies"} in the queue` : undefined}>
        {!jobs && !error && <PageLoading label="Loading cleanup runs…" />}
        {jobs && jobs.runs.length === 0 && (
          <EmptyState
            title="No cleanup runs yet."
            description="Runs execute on the configured Vercel Cron schedule (every 6 hours by default) or when triggered manually above."
          />
        )}
        {jobs && jobs.runs.length > 0 && (
          <Table headers={["Run", "Status", "Started", "Scanned", "Deleted", "Released", "Notified", "Failed", "Trigger"]}>
            {jobs.runs.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2.5 font-mono text-xs text-slate-500">{r.id}</td>
                <td className="px-3 py-2.5"><Badge tone={RUN_TONE[r.status] ?? "neutral"}>{r.status}</Badge></td>
                <td className="px-3 py-2.5 text-slate-500">{formatDate(r.startedAt)}</td>
                <td className="px-3 py-2.5 tabular-nums">{r.scanned}</td>
                <td className="px-3 py-2.5 tabular-nums">{r.deleted}</td>
                <td className="px-3 py-2.5 tabular-nums">{r.reservationReleased}</td>
                <td className="px-3 py-2.5 tabular-nums">{r.notified}</td>
                <td className="px-3 py-2.5 tabular-nums">
                  {r.failed > 0 ? <span className="text-rose-600">{r.failed}</span> : 0}
                </td>
                <td className="px-3 py-2.5 text-slate-500">{r.triggeredBy}</td>
              </tr>
            ))}
          </Table>
        )}
        {jobs && jobs.runs.length > 0 && jobs.runs[0].errors.length > 0 && (
          <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3">
            <p className="text-xs font-medium text-rose-800">Latest run errors</p>
            <ul className="mt-1 space-y-1 text-xs text-rose-700">
              {jobs.runs[0].errors.slice(0, 8).map((e, i) => (
                <li key={i}>
                  {e.fileId ? <code>{e.fileId}</code> : null} {e.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card title="Administrator audit log">
        {!logs && !error && <PageLoading label="Loading audit log…" />}
        {logs && logs.length === 0 && (
          <EmptyState
            title="No audit entries yet."
            description="Actions such as quota changes, Drive account connections, file deletions, and version publishes are recorded here."
          />
        )}
        {logs && logs.length > 0 && (
          <>
            <Table headers={["When", "Actor", "Action", "Target", "Details"]}>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="px-3 py-2.5 text-slate-500">{formatDate(l.at)}</td>
                  <td className="px-3 py-2.5">
                    <p className="max-w-[160px] truncate text-slate-700">{l.actorEmail ?? l.actorUid ?? "system"}</p>
                  </td>
                  <td className="px-3 py-2.5"><Badge tone="blue">{l.action}</Badge></td>
                  <td className="px-3 py-2.5">
                    <p className="text-xs text-slate-500">{l.targetType}</p>
                    <p className="max-w-[140px] truncate font-mono text-[11px] text-slate-400">{l.targetId}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    <details>
                      <summary className="cursor-pointer text-xs text-slate-500">view</summary>
                      <pre className="mt-1 max-w-[320px] overflow-x-auto rounded bg-slate-50 p-2 text-[11px] text-slate-600">
                        {JSON.stringify(l.details, null, 2)}
                      </pre>
                    </details>
                  </td>
                </tr>
              ))}
            </Table>
            <div className="mt-3">
              <Pagination page={page} totalPages={totalPages} total={total} onPage={setPage} />
            </div>
          </>
        )}
      </Card>

      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}
