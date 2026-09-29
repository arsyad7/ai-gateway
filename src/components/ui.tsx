"use client";

/** Compact number: 1,284 / 12.9K / 4.2M. */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function usd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 fade-in">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

type Tone = "good" | "warning" | "critical" | "accent" | "muted";

const toneColor: Record<Tone, string> = {
  good: "var(--status-good)",
  warning: "var(--status-warning)",
  critical: "var(--status-critical)",
  accent: "var(--accent)",
  muted: "var(--text-muted)",
};

export function Badge({
  tone = "muted",
  children,
}: {
  tone?: Tone;
  children: React.ReactNode;
}) {
  const color = toneColor[tone];
  return (
    <span
      className="badge"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  hint,
}: {
  title: string;
  hint?: React.ReactNode;
}) {
  return (
    <div className="text-center py-10 px-4">
      <div className="text-sm font-medium">{title}</div>
      {hint && (
        <div className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
          {hint}
        </div>
      )}
    </div>
  );
}

export function Skeleton({
  className = "",
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden />;
}

export function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="card card-hover p-5 fade-in">
      <div className="text-sm" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
      <div className="text-2xl sm:text-3xl font-semibold tracking-tight mt-1">{value}</div>
      {detail && (
        <div className="text-xs mt-1" style={{ color: "var(--text-secondary)" }}>
          {detail}
        </div>
      )}
    </div>
  );
}

/**
 * Budget meter. Fill color carries severity: accent while healthy, warning
 * past the alert threshold, critical at/over the limit. The unfilled track is
 * a lighter step of the accent ramp so state reads across the whole bar.
 */
export function Meter({
  used,
  warning,
  exhausted,
}: {
  used: number; // 0..1+
  warning: boolean;
  exhausted: boolean;
}) {
  const pct = Math.min(100, Math.max(0, used * 100));
  const fill = exhausted
    ? "var(--status-critical)"
    : warning
      ? "var(--status-warning)"
      : "var(--accent)";
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className="h-2 rounded-full overflow-hidden"
      style={{ background: "var(--accent-track)" }}
    >
      <div
        className="h-full rounded-full"
        style={{ width: `${pct}%`, background: fill }}
      />
    </div>
  );
}

export function StatusBadge({
  exhausted,
  warning,
  unlimited,
}: {
  exhausted: boolean;
  warning: boolean;
  unlimited: boolean;
}) {
  if (unlimited)
    return (
      <span className="text-xs" style={{ color: "var(--text-muted)" }}>
        — no limit
      </span>
    );
  const [icon, label, color] = exhausted
    ? ["⛔", "Exhausted", "var(--status-critical)"]
    : warning
      ? ["⚠️", "Near limit", "var(--status-warning)"]
      : ["✓", "OK", "var(--status-good)"];
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-medium"
      style={{ color }}
    >
      <span aria-hidden>{icon}</span>
      {label}
    </span>
  );
}

/** Fixed-order categorical assignment: alias -> series slot, never cycled. */
export function seriesColor(index: number): string {
  const slot = Math.min(index, 7) + 1;
  return `var(--series-${slot})`;
}

export async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("unauthorized");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}
