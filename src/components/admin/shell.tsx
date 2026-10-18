"use client";

/** Admin shell: responsive sidebar, auth guard, and page container. */
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Database,
  FileStack,
  Gauge,
  HardDrive,
  History,
  LogOut,
  Menu,
  ShieldCheck,
  Smartphone,
  Users,
  X,
} from "lucide-react";
import { AuthProvider, useAuth } from "@/lib/admin/auth-context";
import { Button, ErrorBanner, PageLoading } from "@/components/admin/ui";

const NAV = [
  { href: "/admin", label: "Overview", icon: Gauge },
  { href: "/admin/drive", label: "Drive Accounts", icon: HardDrive },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/files", label: "Files", icon: FileStack },
  { href: "/admin/version", label: "App Version", icon: Smartphone },
  { href: "/admin/logs", label: "Logs & Jobs", icon: History },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { session, signOut } = useAuth();
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">
          <Database className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm font-semibold leading-tight text-slate-900">Kotha Bolbo</p>
          <p className="text-xs text-slate-500">Storage Admin</p>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 px-3" aria-label="Main">
        {NAV.map((item) => {
          const active = pathname === item.href || (item.href !== "/admin" && pathname.startsWith(item.href));
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                active ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              <Icon className="h-4.5 w-4.5 h-[18px] w-[18px]" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-slate-100 p-4">
        <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2.5">
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-slate-700">{session?.email ?? "Administrator"}</p>
            <p className="text-[11px] text-slate-400">Server-verified admin</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full justify-start text-slate-500"
          onClick={() => signOut()}
        >
          <LogOut className="h-4 w-4" /> Sign out
        </Button>
      </div>
    </div>
  );
}

function Guard({ children }: { children: React.ReactNode }) {
  const { loading, user, session, firebaseConfigured, authError, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user && pathname !== "/admin/login") {
      router.replace("/admin/login");
    }
  }, [loading, user, pathname, router]);

  if (pathname === "/admin/login") return <>{children}</>;

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <PageLoading label="Verifying administrator session…" />
      </div>
    );
  }

  if (!firebaseConfigured) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-lg">
          <ErrorBanner
            message="Firebase web configuration is missing. Set FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN and FIREBASE_APP_ID in the deployment environment (see docs/FIREBASE_SETUP.md)."
          />
        </div>
      </div>
    );
  }

  if (!user) return null; // redirecting to login

  if (!session?.isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-lg space-y-4 text-center">
          <ErrorBanner
            message={
              authError ??
              "Administrator access is denied by the server. This account is not an administrator."
            }
          />
          <Button variant="secondary" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <AuthProvider>
      <Guard>
        <div className="min-h-screen lg:flex">
          {/* Mobile top bar */}
          <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
            <p className="text-sm font-semibold text-slate-900">Kotha Bolbo — Admin</p>
            <button
              onClick={() => setMobileOpen(true)}
              className="rounded-lg p-2 text-slate-600 hover:bg-slate-100"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
          </div>
          {mobileOpen && (
            <div className="fixed inset-0 z-40 lg:hidden">
              <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMobileOpen(false)} />
              <aside className="absolute inset-y-0 left-0 w-72 bg-white shadow-xl">
                <button
                  onClick={() => setMobileOpen(false)}
                  className="absolute right-3 top-3 rounded p-1.5 text-slate-400 hover:bg-slate-100"
                  aria-label="Close navigation"
                >
                  <X className="h-4 w-4" />
                </button>
                <SidebarContent onNavigate={() => setMobileOpen(false)} />
              </aside>
            </div>
          )}
          {/* Desktop sidebar */}
          <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white lg:block">
            <div className="sticky top-0 h-screen">
              <SidebarContent />
            </div>
          </aside>
          <main className="min-w-0 flex-1">
            <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">{children}</div>
          </main>
        </div>
      </Guard>
    </AuthProvider>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
