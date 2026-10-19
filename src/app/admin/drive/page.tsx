"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, HardDrive, Plug, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
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
  InfoBanner,
  PageLoading,
  Table,
  Toast,
} from "@/components/admin/ui";
import { PageHeader } from "@/components/admin/shell";

type DriveAccount = {
  id: string;
  accountEmail: string | null;
  displayName: string | null;
  status: "enabled" | "disabled" | "disconnected" | "error";
  verified: boolean;
  connectedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  fileCount: number;
  totalBytes: number;
  quotaInfo: {
    limitBytes: number | null;
    usageBytes: number | null;
    usageInDriveBytes: number | null;
    fetchedAt: number;
  } | null;
  hasManagedFolder: boolean;
  hasStoredCredentials: boolean;
  hasGoogleAccountId?: boolean;
  disabledReason: string | null;
};

type DuplicateGroup = {
  key: string;
  kind: "googleAccountId" | "email";
  accountIds: string[];
  accounts: Array<{ id: string; accountEmail: string | null; status: string; fileCount: number; connectedAt: string | null }>;
};

const STATUS_TONE: Record<DriveAccount["status"], "green" | "amber" | "neutral" | "red"> = {
  enabled: "green",
  disabled: "amber",
  disconnected: "neutral",
  error: "red",
};

export default function DriveAccountsPage() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const [accounts, setAccounts] = useState<DriveAccount[] | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const [error, setError] = useState<UiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ account: DriveAccount; kind: "disable" | "disconnect" } | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setError(null);
    setLoading(true);
    try {
      setAccounts(await api.get<DriveAccount[]>(user, "/api/v1/admin/drive-accounts"));
      // Duplicate report is informational; never block the page on it.
      try {
        const dup = await api.get<{ groups: DuplicateGroup[] }>(user, "/api/v1/admin/drive-accounts/duplicates");
        setDuplicates(dup.groups);
      } catch {
        setDuplicates([]);
      }
    } catch (e) {
      setError(describeError(e, "Failed to load Drive accounts."));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const connected = searchParams.get("connected");
    const reconnected = searchParams.get("reconnected");
    const err = searchParams.get("error");
    const account = searchParams.get("account");
    const verified = searchParams.get("verified");
    const verifyNote =
      verified === "1"
        ? "Write test passed."
        : "Write test did NOT pass — the account is connected but not verified. Run Test before relying on it.";
    if (err) setNotice(`Connection failed: ${err}`);
    else if (reconnected === "1") {
      setNotice(
        `This Google account (${account ?? ""}) is already connected. Its stored credentials were updated instead of creating a duplicate record. ${verifyNote}`
      );
    } else if (connected === "1") {
      setNotice(`Google Drive account ${account ?? ""} connected. ${verifyNote}`);
    }
  }, [searchParams]);

  const act = async (account: DriveAccount, action: "enable" | "disable" | "retry") => {
    setBusyId(account.id);
    try {
      await api.patch(user!, `/api/v1/admin/drive-accounts/${account.id}`, { action });
      setToast({ message: `Account ${action}d.`, tone: "success" });
      await load();
    } catch (e) {
      setToast({ message: e instanceof ApiClientError ? e.message : "Action failed.", tone: "error" });
    } finally {
      setBusyId(null);
      setConfirm(null);
    }
  };

  const test = async (account: DriveAccount) => {
    setBusyId(account.id);
    try {
      await api.post(user!, `/api/v1/admin/drive-accounts/${account.id}/test`);
      setToast({ message: "Connectivity test passed (real create + delete).", tone: "success" });
      await load();
    } catch (e) {
      setToast({ message: e instanceof ApiClientError ? e.message : "Test failed.", tone: "error" });
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const disconnect = async (account: DriveAccount) => {
    setBusyId(account.id);
    try {
      await api.del(user!, `/api/v1/admin/drive-accounts/${account.id}?confirm=DISCONNECT`);
      setToast({ message: "Account disconnected.", tone: "success" });
      await load();
    } catch (e) {
      setToast({ message: e instanceof ApiClientError ? e.message : "Disconnect failed.", tone: "error" });
    } finally {
      setBusyId(null);
      setConfirm(null);
    }
  };

  const connect = async () => {
    setConnectBusy(true);
    try {
      const res = await api.get<{ authorizeUrl: string }>(user!, "/api/v1/admin/drive-accounts/connect");
      window.location.href = res.authorizeUrl;
    } catch (e) {
      setToast({ message: e instanceof ApiClientError ? e.message : "Could not start OAuth flow.", tone: "error" });
      setConnectBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Google Drive Accounts"
        description="Storage pool accounts connected via Google OAuth. Tokens are stored server-side only and never shown here."
        actions={
          <Button onClick={connect} loading={connectBusy}>
            <Plug className="h-4 w-4" /> Connect Google Drive
          </Button>
        }
      />

      {notice && (
        <div className="mb-4">
          <InfoBanner message={notice} />
        </div>
      )}
      {error && (
        <div className="mb-4">
          <ErrorBanner message={error.message} code={error.code} requestId={error.requestId} onRetry={load} retrying={loading} />
        </div>
      )}
      {!accounts && !error && <PageLoading label="Loading Drive accounts…" />}

      {duplicates.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" /> {duplicates.length} duplicate account group{duplicates.length === 1 ? "" : "s"} detected
          </p>
          <p className="mt-1 text-xs text-amber-800">
            These records point at the same Google account. Nothing is merged or deleted automatically — files and metadata
            are preserved. New connections for these accounts now update the primary record instead of creating another
            one. Review and disconnect the redundant records manually once their files have expired or been migrated.
          </p>
          <ul className="mt-2 space-y-1 text-xs">
            {duplicates.map((g) => (
              <li key={`${g.kind}:${g.key}`}>
                <span className="font-mono">{g.key}</span> ({g.kind}):{" "}
                {g.accounts.map((a) => `${a.id} (${a.status}, ${a.fileCount} files)`).join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}

      {accounts && accounts.length === 0 && (
        <Card>
          <EmptyState
            title="No Google Drive accounts connected yet."
            description="Connect one or more Google accounts to form the storage pool. Each account is authorized with official Google OAuth and verified with a real write test before it is trusted."
            action={
              <Button onClick={connect} loading={connectBusy}>
                <Plug className="h-4 w-4" /> Connect Google Drive
              </Button>
            }
          />
        </Card>
      )}

      {accounts && accounts.length > 0 && (
        <Card className="mb-4 bg-brand-50">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-brand-900">Storage Pool Summary</h3>
              <p className="text-xs text-brand-700">Total application-managed storage across {accounts.length} account{accounts.length === 1 ? "" : "s"}</p>
            </div>
            <div className="flex items-center gap-6">
              <div>
                <p className="text-xs text-brand-700">Managed Files</p>
                <p className="text-lg font-semibold text-brand-900">{accounts.reduce((sum, a) => sum + a.fileCount, 0)}</p>
              </div>
              <div>
                <p className="text-xs text-brand-700">Managed Storage</p>
                <p className="text-lg font-semibold text-brand-900">{formatBytes(accounts.reduce((sum, a) => sum + a.totalBytes, 0))}</p>
              </div>
            </div>
          </div>
        </Card>
      )}

      {accounts && accounts.length > 0 && (
        <div className="space-y-4">
          {accounts.map((a) => (
            <Card key={a.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                    <HardDrive className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      {a.accountEmail ?? a.displayName ?? a.id}
                      <Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge>
                      {a.verified ? (
                        <Badge tone="green">
                          <ShieldCheck className="mr-1 h-3 w-3" /> verified
                        </Badge>
                      ) : (
                        <Badge tone="amber">not verified</Badge>
                      )}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Connected {formatDate(a.connectedAt)} · {a.fileCount} file{a.fileCount === 1 ? "" : "s"} ·{" "}
                      {formatBytes(a.totalBytes)}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Last success: {a.lastSuccessAt ? formatDate(a.lastSuccessAt) : "—"}
                    </p>
                    {a.lastErrorMessage && (
                      <p className="mt-1 max-w-xl text-xs text-rose-600">Provider error: {a.lastErrorMessage}</p>
                    )}
                    {a.disabledReason && a.status === "disabled" && (
                      <p className="mt-1 text-xs text-amber-600">Disabled: {a.disabledReason}</p>
                    )}
                    {a.quotaInfo ? (
                      <div className="mt-2 rounded bg-slate-50 px-3 py-2 text-xs text-slate-600">
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <div>
                            <span className="block font-medium text-slate-700">Google Storage</span>
                            {a.quotaInfo.usageBytes !== null ? formatBytes(a.quotaInfo.usageBytes) : "Unknown"} /{" "}
                            {a.quotaInfo.limitBytes !== null ? formatBytes(a.quotaInfo.limitBytes) : "Unlimited"}
                          </div>
                          <div>
                            <span className="block font-medium text-slate-700">Free Space</span>
                            {a.quotaInfo.limitBytes !== null && a.quotaInfo.usageBytes !== null
                              ? formatBytes(Math.max(0, a.quotaInfo.limitBytes - a.quotaInfo.usageBytes))
                              : "Unknown"}
                          </div>
                          <div>
                            <span className="block font-medium text-slate-700">Usage %</span>
                            {a.quotaInfo.limitBytes !== null && a.quotaInfo.limitBytes > 0 && a.quotaInfo.usageBytes !== null
                              ? ((a.quotaInfo.usageBytes / a.quotaInfo.limitBytes) * 100).toFixed(1) + "%"
                              : "N/A"}
                          </div>
                          <div>
                            <span className="block font-medium text-slate-700">Managed Usage</span>
                            {formatBytes(a.totalBytes)} ({a.fileCount} files)
                          </div>
                        </div>
                        <p className="mt-1 text-[10px] text-slate-400">Data fresh as of {formatDate(a.quotaInfo.fetchedAt)}</p>
                      </div>
                    ) : (
                      <div className="mt-2 rounded bg-slate-50 px-3 py-2 text-xs text-slate-500">
                        <p>Google Storage: Not available.</p>
                        <p>Managed Usage: {formatBytes(a.totalBytes)} ({a.fileCount} files)</p>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => test(a)} loading={busyId === a.id}>
                    <RefreshCw className="h-3.5 w-3.5" /> Test
                  </Button>
                  {a.status === "enabled" ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setConfirm({ account: a, kind: "disable" })}
                      loading={busyId === a.id}
                    >
                      Disable
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => act(a, "enable")} loading={busyId === a.id}>
                      Enable
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" onClick={() => act(a, "retry")} loading={busyId === a.id}>
                    Retry
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setConfirm({ account: a, kind: "disconnect" })}
                    loading={busyId === a.id}
                  >
                    <Unplug className="h-3.5 w-3.5" /> Disconnect
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.kind === "disconnect" ? "Disconnect Drive account?" : "Disable Drive account?"}
        message={
          confirm?.kind === "disconnect" ? (
            <>
              Stored credentials for <strong>{confirm?.account.accountEmail ?? confirm?.account.id}</strong> will be
              destroyed. Files already uploaded to this account ({confirm?.account.fileCount ?? 0}) stay in its managed
              folder but can no longer be downloaded until the account is reconnected. This does not touch anything else
              in the Google account.
            </>
          ) : (
            <>
              The account will stop receiving new uploads. Existing files remain available. You can re-enable it at any
              time.
            </>
          )
        }
        typedConfirmation={confirm?.kind === "disconnect" ? "DISCONNECT" : undefined}
        confirmLabel={confirm?.kind === "disconnect" ? "Disconnect" : "Disable"}
        danger={confirm?.kind === "disconnect"}
        busy={Boolean(busyId)}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === "disconnect") disconnect(confirm.account);
          else act(confirm.account, "disable");
        }}
      />

      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}
