"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/admin/auth-context";
import { api, ApiClientError, describeError, type UiError } from "@/lib/admin/api-client";
import { formatDate } from "@/lib/format";
import { Badge, Button, Card, ConfirmDialog, ErrorBanner, Field, Input, PageLoading, Toast } from "@/components/admin/ui";
import { PageHeader } from "@/components/admin/shell";
import { Download, Plus, Smartphone, Trash2 } from "lucide-react";

type AppRecord = {
  id: string;
  name: string;
  packageName: string;
  status: "enabled" | "disabled";
  createdAt: number;
};

export default function AppsPage() {
  const { user } = useAuth();
  const [apps, setApps] = useState<AppRecord[] | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [editApp, setEditApp] = useState<AppRecord | null>(null);
  const [form, setForm] = useState({ name: "", packageName: "" });
  const [confirmDelete, setConfirmDelete] = useState<AppRecord | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const res = await api.get<AppRecord[]>(user, "/api/v1/admin/apps");
      setApps(res);
      setError(null);
    } catch (e) {
      setError(describeError(e, "Failed to load applications."));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (editApp) {
        await api.patch(user!, `/api/v1/admin/apps/\${editApp.id}`, form);
        setToast({ message: "Application updated.", tone: "success" });
      } else {
        await api.post(user!, "/api/v1/admin/apps", form);
        setToast({ message: "Application created.", tone: "success" });
      }
      setCreateOpen(false);
      setEditApp(null);
      await load();
    } catch (err) {
      setToast({ message: err instanceof ApiClientError ? err.message : "Save failed.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      await api.del(user!, `/api/v1/admin/apps/\${confirmDelete.id}`);
      setToast({ message: "Application deleted.", tone: "success" });
      setConfirmDelete(null);
      await load();
    } catch (err) {
      setToast({ message: err instanceof ApiClientError ? err.message : "Delete failed.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const downloadConfig = async (app: AppRecord) => {
    if (!user) return;
    setBusy(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/v1/admin/apps/${app.id}/config`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        let message = `Config download failed (HTTP ${res.status}).`;
        try {
          const payload = await res.json();
          message = payload?.error?.message || message;
        } catch {}
        throw new Error(message);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = "kotha-bolbo-storage-server.json";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      setToast({ message: "SDK config downloaded.", tone: "success" });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : "Config download failed.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (app: AppRecord) => {
    setBusy(true);
    try {
      await api.patch(user!, `/api/v1/admin/apps/\${app.id}`, { status: app.status === "enabled" ? "disabled" : "enabled" });
      setToast({ message: "Status updated.", tone: "success" });
      await load();
    } catch (err) {
      setToast({ message: err instanceof ApiClientError ? err.message : "Update failed.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Your Applications"
        description="Register client applications to enforce boundaries and isolate storage folders."
        actions={
          <Button onClick={() => { setForm({ name: "", packageName: "" }); setEditApp(null); setCreateOpen(true); }}>
            <Plus className="mr-1 h-4 w-4" /> Add Application
          </Button>
        }
      />

      {error && <div className="mb-4"><ErrorBanner message={error.message} onRetry={load} /></div>}
      {!apps && !error && <PageLoading label="Loading applications..." />}

      {apps && (
        <div className="grid gap-4 md:grid-cols-2">
          {apps.map((app) => (
            <Card key={app.id}>
              <div className="flex justify-between items-start mb-4">
                <div className="flex gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                    <Smartphone className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-slate-900 flex items-center gap-2">
                      {app.name}
                      <Badge tone={app.status === "enabled" ? "green" : "amber"}>{app.status}</Badge>
                    </h3>
                    <p className="text-xs font-mono text-slate-500 mt-1">{app.packageName}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">ID: {app.id}</p>
                  </div>
                </div>
              </div>
              <div className="flex gap-2 justify-end flex-wrap">
                <Button variant="secondary" size="sm" onClick={() => downloadConfig(app)} disabled={busy}>
                  <Download className="mr-1 h-3.5 w-3.5" /> Download JSON
                </Button>
                <Button variant="secondary" size="sm" onClick={() => { setForm({ name: app.name, packageName: app.packageName }); setEditApp(app); setCreateOpen(true); }}>
                  Edit
                </Button>
                <Button variant="secondary" size="sm" onClick={() => toggle(app)} disabled={busy}>
                  {app.status === "enabled" ? "Disable" : "Enable"}
                </Button>
                <Button variant="danger" size="sm" onClick={() => setConfirmDelete(app)} disabled={busy}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {(createOpen || editApp) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h3 className="text-lg font-semibold mb-4">{editApp ? "Edit Application" : "Register Application"}</h3>
            <form onSubmit={save} className="space-y-4">
              <Field label="Display Name" required>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
              </Field>
              <Field label="Android Package Name" required>
                <Input value={form.packageName} onChange={(e) => setForm({ ...form, packageName: e.target.value })} placeholder="com.example.app" required pattern="^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$" />
              </Field>
              <div className="flex justify-end gap-2 mt-6">
                <Button variant="secondary" type="button" onClick={() => { setCreateOpen(false); setEditApp(null); }}>Cancel</Button>
                <Button type="submit" loading={busy}>Save</Button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="Delete Application"
        message="This will unregister the application. Associated Google Drive folders will NOT be deleted automatically, but API keys for this app will stop working."
        confirmLabel="Delete"
        danger
        busy={busy}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={del}
      />

      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}
