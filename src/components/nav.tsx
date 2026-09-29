"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Minimal inline icon set (24x24 stroke paths) — avoids an icon dependency. */
const icons = {
  overview: "M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z",
  agent: "M12 2a4 4 0 0 1 4 4v1h1a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3h1V6a4 4 0 0 1 4-4zM9 13h.01M15 13h.01",
  models: "M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  providers: "M4 6h16M4 12h16M4 18h16M8 6v0M8 12v0M8 18v0",
  keys: "M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7z",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  system: "M3 4h18v12H3zM8 20h8M12 16v4",
} as const;

export function Icon({ name, size = 16 }: { name: keyof typeof icons; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={icons[name]} />
    </svg>
  );
}

const links = [
  { href: "/", label: "Overview", icon: "overview" },
  { href: "/agent", label: "Agent", icon: "agent" },
  { href: "/models", label: "Models & Limits", icon: "models" },
  { href: "/providers", label: "Providers", icon: "providers" },
  { href: "/keys", label: "API Keys", icon: "keys" },
] as const;

type Theme = "system" | "light" | "dark";
const THEMES: Theme[] = ["system", "light", "dark"];

function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    const saved = localStorage.getItem("theme") as Theme | null;
    if (saved && THEMES.includes(saved)) setTheme(saved);
  }, []);

  function pick(t: Theme) {
    setTheme(t);
    localStorage.setItem("theme", t);
    applyTheme(t);
  }

  const iconFor = { system: "system", light: "sun", dark: "moon" } as const;
  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="inline-flex rounded-lg border p-0.5"
      style={{ borderColor: "var(--baseline)" }}
    >
      {THEMES.map((t) => (
        <button
          key={t}
          role="radio"
          aria-checked={theme === t}
          title={t}
          onClick={() => pick(t)}
          className="rounded-md p-1.5 cursor-pointer transition-colors"
          style={
            theme === t
              ? { background: "var(--accent-track)", color: "var(--text-primary)" }
              : { color: "var(--text-muted)" }
          }
        >
          <Icon name={iconFor[t]} size={14} />
        </button>
      ))}
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <div
        className="grid place-items-center rounded-lg text-white text-sm font-bold"
        style={{
          width: 28,
          height: 28,
          background: "linear-gradient(135deg, var(--series-1), var(--series-7))",
        }}
      >
        A
      </div>
      <div className="leading-tight">
        <div className="font-semibold text-sm">AIcad</div>
        <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          credit-aware routing
        </div>
      </div>
    </div>
  );
}

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/admin/login", { method: "DELETE" });
    router.replace("/login");
  }

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  const linkStyle = (active: boolean) =>
    active
      ? {
          background: "var(--accent-track)",
          color: "var(--text-primary)",
          fontWeight: 500,
        }
      : { color: "var(--text-secondary)" };

  return (
    <>
      {/* Mobile / tablet: sticky top bar with horizontally scrollable nav */}
      <header
        className="lg:hidden sticky top-0 z-20 border-b backdrop-blur"
        style={{
          borderColor: "var(--grid)",
          background: "color-mix(in srgb, var(--surface-1) 85%, transparent)",
        }}
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <Brand />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button onClick={logout} className="btn-ghost" aria-label="Sign out">
              <Icon name="logout" size={14} />
            </button>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 py-2">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={isActive(l.href) ? "page" : undefined}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors"
              style={linkStyle(isActive(l.href))}
            >
              <Icon name={l.icon} size={14} />
              {l.label}
            </Link>
          ))}
        </nav>
      </header>

      {/* Desktop: sidebar */}
      <aside
        className="hidden lg:flex sticky top-0 h-screen w-60 shrink-0 border-r p-4 flex-col gap-1"
        style={{ borderColor: "var(--grid)", background: "var(--surface-1)" }}
      >
        <div className="px-2 py-2 mb-4">
          <Brand />
        </div>
        <div
          className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider"
          style={{ color: "var(--text-muted)" }}
        >
          Menu
        </div>
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            aria-current={isActive(l.href) ? "page" : undefined}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-[color-mix(in_srgb,var(--grid)_40%,transparent)]"
            style={linkStyle(isActive(l.href))}
          >
            <Icon name={l.icon} />
            {l.label}
          </Link>
        ))}
        <div className="mt-auto space-y-3 pt-4 border-t" style={{ borderColor: "var(--grid)" }}>
          <div className="flex items-center justify-between px-1">
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              Theme
            </span>
            <ThemeToggle />
          </div>
          <button onClick={logout} className="btn-ghost w-full justify-center">
            <Icon name="logout" size={14} />
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}
