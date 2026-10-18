"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Search, UserRound } from "lucide-react";
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
  Table,
  Toast,
} from "@/components/admin/ui";
import { PageHeader } from "@/components/admin/shell";

type AdminUser = {
  uid: string;
  email: string | null;
  displayName: string | null;
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  remainingBytes: number;
  fileCount: number;
  restricted: boolean;
  createdAt: string;
  lastLoginAt: string;
};

type UserDetail = {
  user: AdminUser;
  expiringSoon: Array<{ id: string; name: string; sizeBytes: number; expiresAt: string; category: string }>;
};

const DEFAULT_QUOTA = 2 * 1024 * 1024 * 1024;

export default function UsersPage() {
  const { user: me } = useAuth();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AdminUser[] | null>(null);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<UiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [quotaInput, setQuotaInput] = useState("");
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const [confirm, setConfirm] = useState<"quota" | "restrict" | "unrestrict" | "purge" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!me) return;
    setError(null);
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "20" });
      if (q.trim()) params.set("q", q.trim());
      const res = await api.getPage<AdminUser>(me, `/api/v1/admin/users?${params}`);
      setRows(res.data);
      setTotal(res.pagination.total);
      setTotalPages(res.pagination.totalPages);
    } catch (e) {
      setError(describeError(e, "Failed to load users."));
    } finally {
      setLoading(false);
    }
  }, [me, q, page]);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const openDetail = useCallback(
    async (uid: string) => {
      setDetailError(null);
      try {
        const d = await api.get<UserDetail>(me!, `/api/v1/admin/users/${encodeURIComponent(uid)}`);
        setDetail(d);
        setQuotaInput((d.user.quotaBytes / (1024 * 1024 * 1024)).toString());
      } catch (e) {
        setDetailError(e instanceof ApiClientError ? e.message : "Failed to load user detail.");
      }
    },
    [me]
  );

  const patchUser = async (patch: { quotaBytes?: number; restricted?: boolean }) => {
    if (!detail) return;
    setBusy(true);
    try {
      await api.patch(me!, `/api/v1/admin/users/${encodeURIComponent(detail.user.uid)}`, patch);
      setToast({ message: "User updated and audit-logged.", tone: "success" });
      await openDetail(detail.user.uid);
      await load();
    } catch (e) {
      setToast({ message: e instanceof ApiClientError ? e.message : "Update failed.", tone: "error" });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const purge = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const res = await api.del<{ queuedForDeletion: number }>(
        me!,
        `/api/v1/admin/users/${encodeURIComponent(detail.user.uid)}?confirm=DELETE`
      );
      setToast({ message: `${res.queuedForDeletion} file(s) queued for deletion.`, tone: "success" });
      await openDetail(detail.user.uid);
      await load();
    } catch (e) {
      setToast({ message: e instanceof ApiClientError ? e.message : "Purge failed.", tone: "error" });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Users"
        description="Registered users from the database. Quota changes and deletions are confirmed and audit-logged. Passwords are never stored or displayed."
      />

      <div className="mb-4 flex items-center gap-3">
        <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search by UID, email, or name…" />
        <Button variant="secondary" size="sm" onClick={load} loading={loading}>
          <Search className="h-3.5 w-3.5" /> Search
        </Button>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error.message} code={error.code} requestId={error.requestId} onRetry={load} retrying={loading} />
        </div>
      )}
      {!rows && !error && <PageLoading label="Loading users…" />}

      {rows && rows.length === 0 && (
        <Card>
          <EmptyState
            title={q ? "No users match your search." : "No users yet."}
            description={
              q
                ? "Try a different query."
                : "Users appear here after they sign in with Firebase Authentication for the first time. No sample accounts are created."
            }
          />
        </Card>
      )}

      {rows && rows.length > 0 && (
        <Card>
          <Table headers={["User", "Usage", "Files", "Quota", "Restricted", "Last login", ""]}>
            {rows.map((u) => (
              <tr key={u.uid} className="hover:bg-slate-50">
                <td className="px-3 py-2.5">
                  <p className="font-medium text-slate-900">{u.displayName ?? u.email ?? u.uid}</p>
                  <p className="text-xs text-slate-500">{u.email ?? u.uid}</p>
                </td>
                <td className="px-3 py-2.5 tabular-nums text-slate-700">
                  {formatBytes(u.usedBytes)}
                  {u.reservedBytes > 0 && <span className="text-xs text-amber-600"> (+{formatBytes(u.reservedBytes)} reserved)</span>}
                </td>
                <td className="px-3 py-2.5 tabular-nums text-slate-700">{u.fileCount}</td>
                <td className="px-3 py-2.5 tabular-nums text-slate-700">{formatBytes(u.quotaBytes)}</td>
                <td className="px-3 py-2.5">
                  {u.restricted ? <Badge tone="red">restricted</Badge> : <Badge tone="green">active</Badge>}
                </td>
                <td className="px-3 py-2.5 text-slate-500">{formatDate(u.lastLoginAt)}</td>
                <td className="px-3 py-2.5 text-right">
                  <Button variant="secondary" size="sm" onClick={() => openDetail(u.uid)}>
                    Manage
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
          <div className="mt-3">
            <Pagination page={page} totalPages={totalPages} total={total} onPage={setPage} />
          </div>
        </Card>
      )}

      {detail && (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setDetail(null)} />
          <div className="relative w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-xl">
            <header className="flex items-start justify-between border-b border-slate-100 px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-brand-600">
                  <UserRound className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-slate-900">{detail.user.displayName ?? detail.user.email ?? detail.user.uid}</h2>
                  <p className="text-xs text-slate-500">{detail.user.email ?? detail.user.uid}</p>
                </div>
              </div>
              <button onClick={() => setDetail(null)} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Close">
                ✕
              </button>
            </header>
            <div className="space-y-5 px-6 py-5">
              {detailError && <ErrorBanner message={detailError} />}
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-xs text-slate-500">Used</p>
                  <p className="font-medium text-slate-900">{formatBytes(detail.user.usedBytes)}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Reserved</p>
                  <p className="font-medium text-slate-900">{formatBytes(detail.user.reservedBytes)}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Remaining</p>
                  <p className="font-medium text-slate-900">{formatBytes(detail.user.remainingBytes)}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Files</p>
                  <p className="font-medium text-slate-900">{detail.user.fileCount}</p>
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-slate-700">Storage quota (GiB)</label>
                <div className="mt-1 flex items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    step={0.5}
                    inputMode="decimal"
                    value={quotaInput}
                    onChange={(e) => setQuotaInput(e.target.value)}
                    className="w-36"
                    aria-label="Storage quota in GiB"
                  />
                  <Button variant="secondary" size="sm" onClick={() => setConfirm("quota")}>
                    Change quota
                  </Button>
                  <span className="text-xs text-slate-400">default {formatBytes(DEFAULT_QUOTA)}</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {detail.user.restricted ? (
                  <Button variant="secondary" size="sm" onClick={() => setConfirm("unrestrict")}>
                    Restore storage access
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => setConfirm("restrict")}>
                    Restrict storage access
                  </Button>
                )}
                <Button variant="danger" size="sm" onClick={() => setConfirm("purge")} disabled={detail.user.fileCount === 0}>
                  Delete all stored files
                </Button>
              </div>

              <div>
                <p className="text-xs font-medium text-slate-600">Expiring within 7 days</p>
                {detail.expiringSoon.length === 0 ? (
                  <p className="mt-1 text-sm text-slate-500">None.</p>
                ) : (
                  <ul className="mt-2 space-y-1 text-sm">
                    {detail.expiringSoon.map((f) => (
                      <li key={f.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                        <span className="text-slate-700">{f.name}</span>
                        <span className="text-xs text-slate-500">
                          {formatBytes(f.sizeBytes)} · expires {formatDate(f.expiresAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === "quota"
            ? "Change storage quota?"
            : confirm === "restrict"
              ? "Restrict storage access?"
              : confirm === "unrestrict"
                ? "Restore storage access?"
                : "Delete all stored files?"
        }
        message={
          confirm === "quota" ? (
            <>
              Set the quota for <strong>{detail?.user.email ?? detail?.user.uid}</strong> to{" "}
              <strong>{quotaInput} GiB</strong> ({formatBytes(Number(quotaInput) * 1024 ** 3)}). This is recorded in the
              audit log.
            </>
          ) : confirm === "purge" ? (
            <>
              All {detail?.user.fileCount} file(s) stored by{" "}
              <strong>{detail?.user.email ?? detail?.user.uid}</strong> will be permanently deleted from the storage
              pool and the user&apos;s quota usage will be released. This cannot be undone.
            </>
          ) : confirm === "restrict" ? (
            "The user will no longer be able to request uploads. Existing files remain until they expire or are deleted."
          ) : (
            "The user will be able to upload again."
          )
        }
        typedConfirmation={confirm === "purge" ? "DELETE" : undefined}
        confirmLabel={confirm === "purge" ? "Delete files" : "Confirm"}
        danger={confirm === "purge" || confirm === "restrict"}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm === "quota") {
            const gib = Number(quotaInput);
            if (!Number.isFinite(gib) || gib < 0) {
              setToast({ message: "Enter a valid quota value.", tone: "error" });
              setConfirm(null);
              return;
            }
            patchUser({ quotaBytes: Math.round(gib * 1024 ** 3) });
          } else if (confirm === "restrict") patchUser({ restricted: true });
          else if (confirm === "unrestrict") patchUser({ restricted: false });
          else if (confirm === "purge") purge();
        }}
      />

      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}
