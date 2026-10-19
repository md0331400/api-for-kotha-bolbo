"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { useAuth } from "@/lib/admin/auth-context";
import { api, describeError, type UiError } from "@/lib/admin/api-client";
import { formatDate } from "@/lib/format";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Field,
  InfoBanner,
  Input,
  NativeSelect,
  PageLoading,
  Table,
  Toast,
} from "@/components/admin/ui";
import { PageHeader } from "@/components/admin/shell";

type ApiKey = {
  id: string;
  name: string;
  maskedKey: string;
  subjectUid: string;
  appId?: string | null;
  scopes: string[];
  status: "active" | "revoked";
  createdAt: string | null;
  createdBy: string;
  createdByEmail: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  expiresAt: string | null;
};

const SCOPES: Array<{ id: string; label: string; help: string }> = [
  { id: "storage:read", label: "storage:read", help: "List files, read metadata, download, read quota" },
  { id: "storage:write", label: "storage:write", help: "Request upload tickets and confirm uploads" },
  { id: "storage:delete", label: "storage:delete", help: "Delete the subject's own files" },
  { id: "notifications:write", label: "notifications:write", help: "Register FCM notification tokens" },
];

const EXPIRY_OPTIONS = [
  { value: "", label: "Never expires" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];

export default function ApiKeysPage() {
  const { user } = useAuth();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);

  // create form
  const [name, setName] = useState("");
  const [subjectUid, setSubjectUid] = useState("");
  const [scopes, setScopes] = useState<string[]>(["storage:read"]);
  const [expiresInDays, setExpiresInDays] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<UiError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [apps, setApps] = useState<{id:string;name:string}[]>([]);
  const [appId, setAppId] = useState("");

  // one-time reveal
  const [revealed, setRevealed] = useState<{ rawKey: string; key: ApiKey } | null>(null);
  const [copied, setCopied] = useState(false);

  const [confirm, setConfirm] = useState<{ key: ApiKey; kind: "revoke" | "delete" | "expire" } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setError(null);
    setLoading(true);
    try {
      setKeys(await api.get<ApiKey[]>(user, "/api/v1/admin/api-keys"));
    } catch (e) {
      setError(describeError(e, "Failed to load API keys."));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleScope = (id: string) =>
    setScopes((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setCreateError(null);
    setFieldErrors({});
    setCreating(true);
    try {
      const res = await api.post<{ key: ApiKey; rawKey: string }>(user, "/api/v1/admin/api-keys", {
        name: name.trim(),
        subjectUid: subjectUid.trim(),
        appId: appId || null,
        scopes,
        expiresInDays: expiresInDays ? Number(expiresInDays) : null,
      });
      setRevealed(res);
      setCopied(false);
      setName("");
      setScopes(["storage:read"]);
      setExpiresInDays("");
      await load();
    } catch (err) {
      const d = describeError(err, "Could not create the API key.");
      const issues = ((err as { details?: { issues?: Array<{ path: string; message: string }> } })?.details?.issues ?? []) as Array<{
        path: string;
        message: string;
      }>;
      if (issues.length) {
        const fe: Record<string, string> = {};
        for (const i of issues) fe[i.path.split(".")[0]] = i.message;
        setFieldErrors(fe);
      }
      setCreateError(d);
    } finally {
      setCreating(false);
    }
  };

  const copyKey = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.rawKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setToast({ message: "Clipboard unavailable — select the key text and copy it manually.", tone: "error" });
    }
  };

  const setExpiry = async (key: ApiKey) => {
    setBusyId(key.id);
    try {
      await api.patch(user!, `/api/v1/admin/api-keys/${encodeURIComponent(key.id)}`, { action: "set_expiry", expiresInDays: 7 });
      setToast({ message: `Key "${key.name}" will expire in 7 days.`, tone: "success" });
      await load();
    } catch (e) {
      setToast({ message: describeError(e, "Set expiry failed.").message, tone: "error" });
    } finally {
      setBusyId(null);
      setConfirm(null);
    }
  };

  const revoke = async (key: ApiKey) => {
    setBusyId(key.id);
    try {
      await api.patch(user!, `/api/v1/admin/api-keys/${encodeURIComponent(key.id)}`, { action: "revoke" });
      setToast({ message: `Key "${key.name}" revoked. Requests using it are rejected immediately.`, tone: "success" });
      await load();
    } catch (e) {
      setToast({ message: describeError(e, "Revoke failed.").message, tone: "error" });
    } finally {
      setBusyId(null);
      setConfirm(null);
    }
  };

  const remove = async (key: ApiKey) => {
    setBusyId(key.id);
    try {
      await api.del(user!, `/api/v1/admin/api-keys/${encodeURIComponent(key.id)}`);
      setToast({ message: `Metadata for "${key.name}" deleted (audit entry kept).`, tone: "success" });
      await load();
    } catch (e) {
      setToast({ message: describeError(e, "Delete failed.").message, tone: "error" });
    } finally {
      setBusyId(null);
      setConfirm(null);
    }
  };

  const formValid = name.trim().length > 0 && subjectUid.trim().length > 0 && scopes.length > 0;

  return (
    <div>
      <PageHeader
        title="API Keys"
        description="Client credentials for server-to-server integrations. Keys act on behalf of one Firebase user, carry explicit scopes, and can never access administrator endpoints."
        actions={
          <Button variant="secondary" size="sm" onClick={load} loading={loading}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        }
      />

      {revealed && (
        <Card className="mb-6 border-emerald-300">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
              <KeyRound className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-semibold text-slate-900">Key &ldquo;{revealed.key.name}&rdquo; created</h3>
              <p className="mt-1 text-sm text-rose-700">
                <ShieldAlert className="mr-1 inline h-4 w-4" />
                Copy this key now and store it securely. It is shown <strong>only once</strong> — the server keeps only a
                hash and cannot display it again.
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  readOnly
                  value={revealed.rawKey}
                  onFocus={(e) => e.currentTarget.select()}
                  className="font-mono text-xs"
                  aria-label="New API key"
                />
                <Button onClick={copyKey} className="shrink-0">
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="mt-3 text-xs text-slate-600">
                Use it with the <code className="rounded bg-slate-100 px-1">X-API-Key</code> header, e.g.{" "}
                <code className="rounded bg-slate-100 px-1">
                  curl -H &quot;X-API-Key: {revealed.key.maskedKey}&quot; https://swkf.vercel.app/api/v1/storage/quota
                </code>
              </p>
              <div className="mt-3">
                <Button variant="secondary" size="sm" onClick={() => setRevealed(null)}>
                  I have saved the key
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-2" title="Generate a new key">
          <form onSubmit={create} className="space-y-4" noValidate>
            <Field label="Key name" htmlFor="keyName" required error={fieldErrors.name} hint="Shown in lists and audit logs.">
              <Input
                id="keyName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Backup worker (production)"
                maxLength={64}
                autoComplete="off"
                invalid={Boolean(fieldErrors.name)}
              />
            </Field>

            <Field label="Associated Application" htmlFor="appId" hint="Required for application-scoped endpoints (e.g. storage uploads).">
              <NativeSelect id="appId" value={appId} onChange={(e) => setAppId(e.target.value)}>
                <option value="">-- None --</option>
                {apps.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </NativeSelect>
            </Field>
            <Field
              label="Subject user UID"
              htmlFor="subjectUid"
              required
              error={fieldErrors.subjectUid}
              hint="Firebase UID the key acts as. Ownership and quota checks apply to this user."
            >
              <Input
                id="subjectUid"
                value={subjectUid}
                onChange={(e) => setSubjectUid(e.target.value)}
                placeholder="Firebase user UID"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                invalid={Boolean(fieldErrors.subjectUid)}
              />
            </Field>
            <Field label="Scopes" required error={fieldErrors.scopes}>
              <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                {SCOPES.map((s) => (
                  <div key={s.id}>
                    <Checkbox checked={scopes.includes(s.id)} onChange={() => toggleScope(s.id)} label={<span className="font-mono text-xs">{s.label}</span>} />
                    <p className="ml-6 text-xs text-slate-500">{s.help}</p>
                  </div>
                ))}
              </div>
            </Field>
            <Field label="Expiry" htmlFor="expiry">
              <NativeSelect id="expiry" value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)}>
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {createError && <ErrorBanner message={createError.message} code={createError.code} requestId={createError.requestId} />}
            <Button type="submit" disabled={!formValid} loading={creating} className="w-full sm:w-auto">
              <Plus className="h-4 w-4" /> Generate key
            </Button>
            <p className="text-xs text-slate-500">
              Key creation is rate limited (10 per hour per administrator) and audit-logged. The server-side{" "}
              <code className="rounded bg-slate-100 px-1">API_SECRET_KEY</code> is unrelated and is never shown here.
            </p>
          </form>
        </Card>

        <Card className="lg:col-span-3" title="Existing keys" subtitle={keys ? `${keys.length} key${keys.length === 1 ? "" : "s"}` : undefined}>
          {error && (
            <div className="mb-3">
              <ErrorBanner message={error.message} code={error.code} requestId={error.requestId} onRetry={load} retrying={loading} />
            </div>
          )}
          {!keys && !error && <PageLoading label="Loading API keys…" />}
          {keys && keys.length === 0 && (
            <EmptyState title="No API keys yet." description="Generate a key with the form to allow a client to call the storage API without a Firebase ID token." />
          )}
          {keys && keys.length > 0 && (
            <Table headers={["Key", "Subject", "Scopes", "Created", "Last used", "Status", ""]}>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td className="px-3 py-2.5">
                    <p className="font-medium text-slate-900">{k.name}</p>
                    <p className="font-mono text-[11px] text-slate-500">{k.maskedKey}</p>
                    <p className="font-mono text-[11px] text-slate-400">{k.id}</p>
                  </td>
                  <td className="max-w-[140px] truncate px-3 py-2.5 font-mono text-xs text-slate-600" title={k.subjectUid}>
                    {k.subjectUid}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">
                    {k.appId || "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex max-w-[200px] flex-wrap gap-1">
                      {k.scopes.map((s) => (
                        <Badge key={s} tone="blue">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-500">
                    {formatDate(k.createdAt)}
                    {k.expiresAt && <p className="text-[11px] text-amber-600">expires {formatDate(k.expiresAt)}</p>}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-500">{k.lastUsedAt ? formatDate(k.lastUsedAt) : "never"}</td>
                  <td className="px-3 py-2.5">
                    {k.status === "active" ? <Badge tone="green">active</Badge> : <Badge tone="red">revoked</Badge>}
                  </td>
                  <td className="px-3 py-2.5 text-right flex justify-end gap-2">
                    {k.status === "active" ? (
                      <>
                        <Button variant="secondary" size="sm" onClick={() => setConfirm({ key: k, kind: "expire" })} loading={busyId === k.id}>
                          Set Expiry (7d)
                        </Button>
                        <Button variant="danger" size="sm" onClick={() => setConfirm({ key: k, kind: "revoke" })} loading={busyId === k.id}>
                          Revoke
                        </Button>
                      </>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => setConfirm({ key: k, kind: "delete" })} loading={busyId === k.id} aria-label={`Delete ${k.name}`}>
                        <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <Card className="mt-6" title="How clients authenticate">
        <div className="space-y-3 text-sm text-slate-700">
          <p>
            Send the key in the <code className="rounded bg-slate-100 px-1">X-API-Key</code> header instead of a Firebase
            bearer token. The request runs as the key&apos;s subject user with only the granted scopes; admin endpoints always
            reject API keys.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
{`curl -H "X-API-Key: kb_xxxxxxxxxxxx_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy" \\
     "https://swkf.vercel.app/api/v1/storage/files?page=1&pageSize=20"`}
          </pre>
          <InfoBanner message="Treat keys like passwords: never embed them in mobile apps or browser code, rotate them by creating a new key and revoking the old one, and revoke immediately if leaked." />
        </div>
      </Card>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.kind === "revoke" ? "Revoke API key?" : confirm?.kind === "expire" ? "Set Expiry" : "Delete key metadata?"}
        message={
          confirm?.kind === "revoke" ? (
            <>
              Requests using <strong>{confirm?.key.name}</strong> ({confirm?.key.maskedKey}) will be rejected immediately.
              This cannot be undone — create a new key to restore access.
            </>
          ) : confirm?.kind === "expire" ? (
            <>
              Set <strong>{confirm?.key.name}</strong> to expire in 7 days? This allows a grace period for rotation.
            </>
          ) : (
            <>
              Remove the stored metadata for revoked key <strong>{confirm?.key.name}</strong>? The creation and revocation
              audit-log entries are kept.
            </>
          )
        }
        confirmLabel={confirm?.kind === "revoke" ? "Revoke" : confirm?.kind === "expire" ? "Set Expiry" : "Delete"}
        danger
        typedConfirmation={confirm?.kind === "revoke" ? "REVOKE" : undefined}
        busy={Boolean(busyId)}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === "revoke") revoke(confirm.key);
          else if (confirm.kind === "expire") setExpiry(confirm.key);
          else remove(confirm.key);
        }}
      />

      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}
