import Link from "next/link";
import { ArrowRight, Database, ShieldCheck } from "lucide-react";

/**
 * Public landing page for the API deployment. Deliberately minimal — it shows
 * real service identity and links to the private admin console and API docs.
 */
export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-900 px-6 py-16 text-white">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600">
        <Database className="h-7 w-7" />
      </div>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">Kotha Bolbo Storage API</h1>
      <p className="mt-3 max-w-xl text-center text-slate-300">
        Secure file storage for the Kotha Bolbo app and Android client — multi-account Google Drive
        storage pool, per-user quotas, 60-day temporary retention, and a private admin console.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-500"
        >
          Admin console <ArrowRight className="h-4 w-4" />
        </Link>
        <a
          href="/api/v1/health"
          className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-5 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800"
        >
          API health
        </a>
      </div>
      <div className="mt-10 flex items-center gap-2 text-xs text-slate-500">
        <ShieldCheck className="h-4 w-4" />
        <span>
          API base path <code className="rounded bg-slate-800 px-1.5 py-0.5">/api/v1</code> · documentation in{" "}
          <code className="rounded bg-slate-800 px-1.5 py-0.5">docs/API.md</code>
        </span>
      </div>
    </main>
  );
}
