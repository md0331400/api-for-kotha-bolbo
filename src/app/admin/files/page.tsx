"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Filter, Trash2 } from "lucide-react";
import { useAuth } from "@/lib/admin/auth-context";
import { api, ApiClientError, describeError, type UiError } from "@/lib/admin/api-client";
import { formatBytes, formatDate } from "@/lib/format";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Input,
  PageLoading,
  Pagination,
  SearchInput,
  Select,
  Table,
  Toast,
} from "@/components/admin/ui";
import { PageHeader } from "@/components/admin/shell";

type AdminFile = {
  id: string;
  uid: string;
  category: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
  status: string;
  daysUntilExpiry: number;
  providerAccountId: string;
  providerFileId: string;
  deleteAttempts: number;
  lastDeleteError: string | null;
};

const STATUS_TONE: Record<string, "green" | "amber" | "red" | "neutral"> = {
  confirmed: "green",
  pending_delete: "amber",
  delete_failed: "red",
  deleted: "neutral",
};

export default function FilesPage() {
  const { user: me } = useAuth();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("confirmed");
  const [expiringDays, setExpiringDays] = useState("");
  const [uid, setUid] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AdminFile[] | null>(null);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<UiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const [target, setTarget] = useState<AdminFile | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!me) return;
    setError(null);
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (q.trim()) params.set("q", q.trim());
      if (category) params.set("category", category);
      if (status) params.set("status", status);
      if (expiringDays) params.set("expiringInDays", expiringDays);
      if (uid.trim()) params.set("uid", uid.trim());
      const res = await api.getPage<AdminFile>(me, `/api/v1/admin/files?${params}`);
      setRows(res.data);
      setTotal(res.pagination.total);
      setTotalPages(res.pagination.totalPages);
    } catch (e) {
      setError(describeError(e, "Failed to load files."));
    } finally {
      setLoading(false);
    }
  }, [me, q, category, status, expiringDays, uid, page]);

  useEffect(() => {
    const t = setTimeout(load, q || uid ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q, uid]);

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await api.del(me!, `/api/v1/admin/files/${target.id}?confirm=1`);
      setToast({ message: `File ${target.name} deleted.`, tone: "success" });
      setTarget(null);
      await load();
    } catch (e) {
      setToast({ message: e instanceof ApiClientError ? e.message : "Delete failed.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Files"
        description="Every stored object across the Drive pool. Filters combine; pagination is server-side."
      />

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search filename or ID…" />
          <Input
            value={uid}
            onChange={(e) => { setUid(e.target.value); setPage(1); }}
            placeholder="Filter by UID…"
            aria-label="Filter by UID"
            className="w-full sm:w-44"
          />
          <Select
            label="Category"
            value={category}
            onChange={(v) => { setCategory(v); setPage(1); }}
            options={[
              { value: "", label: "All" },
              { value: "chat", label: "chat" },
              { value: "voice", label: "voice" },
              { value: "photo", label: "photo" },
              { value: "video", label: "video" },
              { value: "other", label: "other" },
            ]}
          />
          <Select
            label="Status"
            value={status}
            onChange={(v) => { setStatus(v); setPage(1); }}
            options={[
              { value: "", label: "All" },
              { value: "confirmed", label: "confirmed" },
              { value: "pending_delete", label: "pending_delete" },
              { value: "delete_failed", label: "delete_failed" },
              { value: "deleted", label: "deleted" },
            ]}
          />
          <Select
            label="Expiring in"
            value={expiringDays}
            onChange={(v) => { setExpiringDays(v); setPage(1); }}
            options={[
              { value: "", label: "Any time" },
              { value: "3", label: "3 days" },
              { value: "7", label: "7 days" },
              { value: "30", label: "30 days" },
            ]}
          />
          <Button variant="secondary" size="sm" onClick={load}>
            <Filter className="h-3.5 w-3.5" /> Apply
          </Button>
        </div>
      </Card>

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error.message} code={error.code} requestId={error.requestId} onRetry={load} retrying={loading} />
        </div>
      )}
      {!rows && !error && <PageLoading label="Loading files…" />}

      {rows && rows.length === 0 && (
        <Card>
          <EmptyState
            title={q || category || status || expiringDays || uid ? "No files match the current filters." : "No files uploaded yet."}
            description={
              q || category || status || expiringDays || uid
                ? "Adjust filters or clear them to see all files."
                : "Files appear here after clients complete the upload-ticket → upload → upload-confirm flow."
            }
          />
        </Card>
      )}

      {rows && rows.length > 0 && (
        <Card>
          <Table headers={["File", "Owner", "Category", "Size", "Created", "Expires", "Status", ""]}>
            {rows.map((f) => (
              <tr key={f.id} className="hover:bg-slate-50">
                <td className="px-3 py-2.5">
                  <p className="max-w-[220px] truncate font-medium text-slate-900" title={f.name}>
                    {f.name}
                  </p>
                  <p className="font-mono text-[11px] text-slate-400">{f.id}</p>
                </td>
                <td className="px-3 py-2.5">
                  <p className="max-w-[140px] truncate font-mono text-xs text-slate-600" title={f.uid}>
                    {f.uid}
                  </p>
                </td>
                <td className="px-3 py-2.5">
                  <Badge tone="blue">{f.category}</Badge>
                </td>
                <td className="px-3 py-2.5 tabular-nums text-slate-700">{formatBytes(f.sizeBytes)}</td>
                <td className="px-3 py-2.5 text-slate-500">{formatDate(f.createdAt)}</td>
                <td className="px-3 py-2.5">
                  <span className={f.daysUntilExpiry <= 7 && f.status === "confirmed" ? "text-amber-600" : "text-slate-500"}>
                    {formatDate(f.expiresAt)}
                  </span>
                  {f.status === "confirmed" && (
                    <p className="text-[11px] text-slate-400">{f.daysUntilExpiry} day(s) left</p>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <Badge tone={STATUS_TONE[f.status] ?? "neutral"}>{f.status}</Badge>
                  {f.lastDeleteError && <p className="mt-1 max-w-[180px] text-[11px] text-rose-500">{f.lastDeleteError}</p>}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {f.status !== "deleted" && (
                    <Button variant="ghost" size="sm" onClick={() => setTarget(f)} aria-label={`Delete ${f.name}`}>
                      <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
          <div className="mt-3">
            <Pagination page={page} totalPages={totalPages} total={total} onPage={setPage} />
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={Boolean(target)}
        title="Delete file?"
        message={
          <>
            Permanently delete <strong>{target?.name}</strong> ({formatBytes(target?.sizeBytes ?? 0)}) owned by{" "}
            <code className="rounded bg-slate-100 px-1 text-xs">{target?.uid}</code> from the storage pool? Quota usage is
            released. This action is audit-logged and cannot be undone.
          </>
        }
        typedConfirmation="DELETE"
        confirmLabel="Delete file"
        danger
        busy={busy}
        onCancel={() => setTarget(null)}
        onConfirm={remove}
      />

      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}
