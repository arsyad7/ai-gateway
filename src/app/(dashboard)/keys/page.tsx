"use client";

import { useCallback, useEffect, useState } from "react";
import { api, Badge, compact, EmptyState, PageHeader, StatusBadge, usd } from "@/components/ui";

type KeyRow = {
  id: string;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  limitTokens: number | null;
  limitUsd: number | null;
  period: string;
  allowedModels: string;
  lastUsedAt: string | null;
  spend: { tokens: number; usd: number; requests: number };
  limit: { used: number; exhausted: boolean; warning: boolean };
};

export default function KeysPage() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [form, setForm] = useState({
    name: "",
    limitTokens: "",
    limitUsd: "",
    period: "monthly",
    allowedModels: "",
  });
  const [minted, setMinted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<KeyRow[]>("/api/admin/keys").then(setKeys).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ key: string }>("/api/admin/keys", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setMinted(res.key);
      setForm({ name: "", limitTokens: "", limitUsd: "", period: "monthly", allowedModels: "" });
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(k: KeyRow) {
    await api(`/api/admin/keys/${k.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !k.enabled }),
    });
    load();
  }

  async function remove(k: KeyRow) {
    if (!confirm(`Revoke and delete key '${k.name}'?`)) return;
    await api(`/api/admin/keys/${k.id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Gateway API Keys"
        description="Keys your clients use as the Bearer token. Each key can have its own budget and model allowlist."
      />
      {error && (
        <p className="text-sm" style={{ color: "var(--status-critical)" }}>
          {error}
        </p>
      )}

      {minted && (
        <div
          className="card p-4 text-sm"
          style={{ borderColor: "var(--status-good)" }}
        >
          <div className="font-medium mb-1">Key created — copy it now</div>
          <code className="font-mono text-xs break-all select-all">{minted}</code>
          <p className="text-xs mt-2" style={{ color: "var(--text-muted)" }}>
            This is the only time the full key is shown. It is stored hashed.
          </p>
          <button className="btn-ghost mt-2" onClick={() => setMinted(null)}>
            Dismiss
          </button>
        </div>
      )}

      <section className="card p-5 overflow-x-auto">
        <table className="data" style={{ minWidth: 760 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Usage ({`this period`})</th>
              <th>Limits</th>
              <th>Models</th>
              <th>Last used</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && (
              <tr>
                <td colSpan={8}>
                  <EmptyState
                    title="No keys yet"
                    hint="Create one below and use it as the Bearer token."
                  />
                </td>
              </tr>
            )}
            {keys.map((k) => (
              <tr key={k.id} style={{ opacity: k.enabled ? 1 : 0.55 }}>
                <td style={{ color: "var(--text-primary)" }}>{k.name}</td>
                <td className="font-mono text-xs">{k.keyPrefix}…</td>
                <td>
                  {compact(k.spend.tokens)} tok · {usd(k.spend.usd)} ·{" "}
                  {k.spend.requests} req
                </td>
                <td className="text-xs">
                  {k.limitTokens ? `${compact(k.limitTokens)} tok` : ""}
                  {k.limitTokens && k.limitUsd ? " / " : ""}
                  {k.limitUsd ? usd(k.limitUsd) : ""}
                  {!k.limitTokens && !k.limitUsd ? "—" : ` per ${k.period}`}
                </td>
                <td className="text-xs">{k.allowedModels || "all"}</td>
                <td className="text-xs">
                  {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}
                </td>
                <td>
                  {k.enabled ? (
                    <StatusBadge
                      exhausted={k.limit.exhausted}
                      warning={k.limit.warning}
                      unlimited={!k.limitTokens && !k.limitUsd}
                    />
                  ) : (
                    <Badge tone="muted">disabled</Badge>
                  )}
                </td>
                <td className="whitespace-nowrap">
                  <span className="flex gap-2">
                    <button className="btn-ghost" onClick={() => toggle(k)}>
                      {k.enabled ? "Disable" : "Enable"}
                    </button>
                    <button className="btn-ghost btn-danger" onClick={() => remove(k)}>
                      Delete
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card p-5">
        <h2 className="text-sm font-medium mb-4">Create key</h2>
        <form onSubmit={create} className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>Name</span>
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="my-app"
              required
            />
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>Token limit (optional)</span>
            <input
              className="input"
              type="number"
              min={0}
              value={form.limitTokens}
              onChange={(e) => setForm({ ...form, limitTokens: e.target.value })}
            />
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>USD limit (optional)</span>
            <input
              className="input"
              type="number"
              min={0}
              step="0.01"
              value={form.limitUsd}
              onChange={(e) => setForm({ ...form, limitUsd: e.target.value })}
            />
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>Period</span>
            <select
              className="input"
              value={form.period}
              onChange={(e) => setForm({ ...form, period: e.target.value })}
            >
              {["daily", "weekly", "monthly", "total"].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label className="text-xs space-y-1 sm:col-span-2">
            <span style={{ color: "var(--text-muted)" }}>
              Allowed models (comma-separated aliases, blank = all)
            </span>
            <input
              className="input"
              value={form.allowedModels}
              onChange={(e) => setForm({ ...form, allowedModels: e.target.value })}
              placeholder="claude-opus-5, gpt-5-mini"
            />
          </label>
          <div className="sm:col-span-3">
            <button className="btn" disabled={busy}>
              {busy ? "Creating…" : "Create key"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
