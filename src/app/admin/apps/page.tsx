"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Send } from "lucide-react";
import { useAuth } from "@/lib/admin/auth-context";
import { api, ApiClientError, describeError, type UiError } from "@/lib/admin/api-client";
import { formatDate } from "@/lib/format";
import { Badge, Button, Card, Checkbox, ConfirmDialog, ErrorBanner, Field, InfoBanner, Input, PageLoading, Textarea, Toast } from "@/components/admin/ui";
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
  const [error, setError] = useState<UiError | null>(null);
  const [loading, setLoading] = useState(false);
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
    setLoading(true);
    try {
      const c = await api.get<VersionConfig>(user, "/api/v1/admin/app-version");
      setCfg(c);
      setCurrentVersion(c.currentVersion ?? "");
      setMinSupportedVersion(c.minSupportedVersion ?? "");
      setUpdateUrl(c.updateUrl ?? "");
      setForceUpdate(Boolean(c.forceUpdate));
      setReleaseNotes(c.releaseNotes ?? "");
    } catch (e) {
      setError(describeError(e, "Failed to load version config."));
    } finally {
      setLoading(false);
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
        title="Your Applications"
        description="Published version metadata consumed by the Kotha Bolbo app and Android APK via GET /api/v1/app/version."
      />
      <Card title="Registered Applications" className="mb-6">
        <p className="text-sm text-slate-500 mb-4">Manage registered applications that can use this storage pool.</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => alert("Registration API available. UI expansion pending.")}>
            Add Application
          </Button>
        </div>
      </Card>

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error.message} code={error.code} requestId={error.requestId} onRetry={load} retrying={loading} />
        </div>
      )}

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
              <Field
                label="Current version (semver)"
                htmlFor="currentVersion"
                required
                error={currentVersion && !SEMVER.test(currentVersion.trim()) ? "Must be semver-like, e.g. 1.2.3" : null}
              >
                <Input
                  id="currentVersion"
                  value={currentVersion}
                  onChange={(e) => setCurrentVersion(e.target.value)}
                  placeholder="1.2.0"
                  autoComplete="off"
                  inputMode="decimal"
                  invalid={Boolean(currentVersion) && !SEMVER.test(currentVersion.trim())}
                />
              </Field>
              <Field
                label="Minimum supported version (semver)"
                htmlFor="minSupportedVersion"
                required
                error={minSupportedVersion && !SEMVER.test(minSupportedVersion.trim()) ? "Must be semver-like, e.g. 1.0.0" : null}
              >
                <Input
                  id="minSupportedVersion"
                  value={minSupportedVersion}
                  onChange={(e) => setMinSupportedVersion(e.target.value)}
                  placeholder="1.0.0"
                  autoComplete="off"
                  inputMode="decimal"
                  invalid={Boolean(minSupportedVersion) && !SEMVER.test(minSupportedVersion.trim())}
                />
              </Field>
              <Field
                label="Update URL (https)"
                htmlFor="updateUrl"
                hint="Where clients are sent to download the new version. Leave empty if not applicable."
                error={updateUrl.trim() && !/^https:\/\//.test(updateUrl.trim()) ? "Must start with https://" : null}
              >
                <Input
                  id="updateUrl"
                  type="url"
                  value={updateUrl}
                  onChange={(e) => setUpdateUrl(e.target.value)}
                  placeholder="https://example.com/download"
                  autoComplete="off"
                  invalid={Boolean(updateUrl.trim()) && !/^https:\/\//.test(updateUrl.trim())}
                />
              </Field>
              <Checkbox
                checked={forceUpdate}
                onChange={(e) => setForceUpdate(e.target.checked)}
                label="Force update (block older clients)"
              />
              <Field label="Release notes (optional)" htmlFor="releaseNotes" hint={`${releaseNotes.length}/4000 characters`}>
                <Textarea
                  id="releaseNotes"
                  value={releaseNotes}
                  onChange={(e) => setReleaseNotes(e.target.value)}
                  rows={4}
                  maxLength={4000}
                  placeholder="What changed in this release?"
                />
              </Field>
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
