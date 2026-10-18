"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Send } from "lucide-react";
import { useAuth } from "@/lib/admin/auth-context";
import { api, ApiClientError } from "@/lib/admin/api-client";
import { formatDate } from "@/lib/format";
import { Badge, Button, Card, ConfirmDialog, ErrorBanner, InfoBanner, PageLoading, Toast } from "@/components/admin/ui";
import { PageHeader } from "@/components/admin/shell";

type VersionConfig = {
  isPublished?: boolean;
  currentVersion: string | null;
  minSupportedVersion: string | null;
  updateUrl: string | null;
  forceUpdate: boolean;
  releaseNotes: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
};

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$/;

export default function VersionPage() {
  const { user } = useAuth();
  const [cfg, setCfg] = useState<VersionConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState("");
  const [minSupportedVersion, setMinSupportedVersion] = useState("");
  const [updateUrl, setUpdateUrl] = useState("");
  const [forceUpdate, setForceUpdate] = useState(false);
  const [releaseNotes, setReleaseNotes] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setError(null);
    try {
      const c = await api.get<VersionConfig>(user, "/api/v1/admin/app-version");
      setCfg(c);
      setCurrentVersion(c.currentVersion ?? "");
      setMinSupportedVersion(c.minSupportedVersion ?? "");
      setUpdateUrl(c.updateUrl ?? "");
      setForceUpdate(Boolean(c.forceUpdate));
      setReleaseNotes(c.releaseNotes ?? "");
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to load version config.");
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const publish = async () => {
    setBusy(true);
    try {
      const rec = await api.put<VersionConfig>(user!, "/api/v1/admin/app-version", {
        currentVersion: currentVersion.trim(),
        minSupportedVersion: minSupportedVersion.trim(),
        updateUrl: updateUrl.trim(),
        forceUpdate,
        releaseNotes: releaseNotes.trim() || null,
      });
      setCfg(rec);
      setToast({ message: "Version metadata published (audit-logged).", tone: "success" });
    } catch (e) {
      setToast({ message: e instanceof ApiClientError ? e.message : "Publish failed.", tone: "error" });
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  const formValid =
    SEMVER.test(currentVersion.trim()) &&
    SEMVER.test(minSupportedVersion.trim()) &&
    (updateUrl.trim() === "" || /^https:\/\//.test(updateUrl.trim()));

  return (
    <div>
      <PageHeader
        title="App Version"
        description="Published version metadata consumed by the Kotha Bolbo app and Android APK via GET /api/v1/app/version."
      />

      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}

      {!cfg && !error && <PageLoading label="Loading version configuration…" />}

      {cfg && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card title="Current published configuration">
            {cfg.isPublished === false || (!cfg.currentVersion && !cfg.publishedAt) ? (
              <>
                <InfoBanner message="No version has been published yet. The public endpoint reports isPublished=false with null values until you publish." />
              </>
            ) : (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-slate-500">Current version</span><span className="font-medium">{cfg.currentVersion}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Minimum supported</span><span className="font-medium">{cfg.minSupportedVersion}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Update URL</span><span className="font-medium">{cfg.updateUrl || "—"}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Force update</span>{cfg.forceUpdate ? <Badge tone="red">yes</Badge> : <Badge tone="neutral">no</Badge>}</div>
                <div className="flex justify-between"><span className="text-slate-500">Published</span><span>{cfg.publishedAt ? formatDate(cfg.publishedAt) : "—"}</span></div>
                {cfg.releaseNotes && (
                  <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{cfg.releaseNotes}</div>
                )}
              </div>
            )}
          </Card>

          <Card title="Publish new version metadata">
            <div className="space-y-4">
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Current version (semver)</span>
                <input
                  value={currentVersion}
                  onChange={(e) => setCurrentVersion(e.target.value)}
                  placeholder="1.2.0"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Minimum supported version (semver)</span>
                <input
                  value={minSupportedVersion}
                  onChange={(e) => setMinSupportedVersion(e.target.value)}
                  placeholder="1.0.0"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Update URL (https)</span>
                <input
                  value={updateUrl}
                  onChange={(e) => setUpdateUrl(e.target.value)}
                  placeholder="https://example.com/download"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={forceUpdate}
                  onChange={(e) => setForceUpdate(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600"
                />
                Force update (block older clients)
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Release notes (optional)</span>
                <textarea
                  value={releaseNotes}
                  onChange={(e) => setReleaseNotes(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                  placeholder="What changed in this release?"
                />
              </label>
              <Button disabled={!formValid} onClick={() => setConfirm(true)}>
                <Send className="h-4 w-4" /> Publish
              </Button>
              {!formValid && (
                <p className="text-xs text-amber-600">
                  Versions must be semver-like (e.g. 1.2.3) and the update URL must start with https://.
                </p>
              )}
            </div>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={confirm}
        title="Publish version metadata?"
        message={
          <>
            Publish <strong>{currentVersion}</strong> (minimum {minSupportedVersion})?
            {forceUpdate && " Force-update is ON — older clients will be blocked."} Clients will see this immediately.
          </>
        }
        confirmLabel="Publish"
        busy={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={publish}
      />

      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}
