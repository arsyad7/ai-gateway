"use client";

import { useCallback, useEffect, useState } from "react";
import { api, Badge, EmptyState, PageHeader } from "@/components/ui";

type ProviderRow = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  enabled: boolean;
  modelCount: number;
  apiKeyMasked: string;
};

const KINDS = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "openai", label: "OpenAI" },
  { value: "google", label: "Google Gemini" },
  { value: "openai_compatible", label: "OpenAI-compatible (OpenRouter, Groq, Ollama…)" },
  { value: "claude_cli", label: "Claude CLI (local subscription, no API key)" },
  { value: "codex_cli", label: "Codex CLI (ChatGPT subscription, no API key)" },
];

export default function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [form, setForm] = useState({ name: "", kind: "anthropic", apiKey: "", baseUrl: "" });
  const isCli = form.kind === "claude_cli" || form.kind === "codex_cli";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<ProviderRow[]>("/api/admin/providers").then(setProviders).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/providers", { method: "POST", body: JSON.stringify(form) });
      setForm({ name: "", kind: "anthropic", apiKey: "", baseUrl: "" });
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(p: ProviderRow) {
    await api(`/api/admin/providers/${p.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !p.enabled }),
    });
    load();
  }

  async function rotateKey(p: ProviderRow) {
    const key = prompt(`New API key for ${p.name}:`);
    if (!key) return;
    await api(`/api/admin/providers/${p.id}`, {
      method: "PATCH",
      body: JSON.stringify({ apiKey: key }),
    });
    load();
  }

  async function remove(p: ProviderRow) {
    if (!confirm(`Delete provider '${p.name}' and its ${p.modelCount} model(s)?`)) return;
    await api(`/api/admin/providers/${p.id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Providers"
        description="Upstream AI services the gateway routes to. API keys are stored encrypted."
      />
      {error && (
        <p className="text-sm" style={{ color: "var(--status-critical)" }}>
          {error}
        </p>
      )}

      <section className="card p-5 overflow-x-auto">
        <table className="data" style={{ minWidth: 720 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>API key</th>
              <th>Base URL</th>
              <th>Models</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {providers.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState
                    title="No providers yet"
                    hint="Add one below to start routing requests."
                  />
                </td>
              </tr>
            )}
            {providers.map((p) => (
              <tr key={p.id}>
                <td style={{ color: "var(--text-primary)" }}>{p.name}</td>
                <td>{p.kind}</td>
                <td className="font-mono text-xs">{p.apiKeyMasked}</td>
                <td className="text-xs">{p.baseUrl ?? "—"}</td>
                <td>{p.modelCount}</td>
                <td>
                  {p.enabled ? (
                    <Badge tone="good">✓ enabled</Badge>
                  ) : (
                    <Badge tone="muted">disabled</Badge>
                  )}
                </td>
                <td className="whitespace-nowrap">
                  <span className="flex gap-2">
                    <button className="btn-ghost" onClick={() => rotateKey(p)}>
                      Rotate key
                    </button>
                    <button className="btn-ghost" onClick={() => toggle(p)}>
                      {p.enabled ? "Disable" : "Enable"}
                    </button>
                    <button className="btn-ghost btn-danger" onClick={() => remove(p)}>
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
        <h2 className="text-sm font-medium mb-4">Add provider</h2>
        <form onSubmit={create} className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>Name</span>
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="anthropic-main"
              required
            />
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>Kind</span>
            <select
              className="input"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>
              API key {isCli ? "(not needed — uses the local CLI login)" : "(stored encrypted)"}
            </span>
            <input
              className="input"
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              required={!isCli}
              disabled={isCli}
            />
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>
              {isCli
                ? `CLI command (optional, default: ${form.kind === "codex_cli" ? "codex" : "claude"})`
                : `Base URL ${form.kind === "openai_compatible" ? "(required)" : "(optional override)"}`}
            </span>
            <input
              className="input"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder={isCli ? (form.kind === "codex_cli" ? "codex" : "claude") : "https://openrouter.ai/api/v1"}
            />
          </label>
          <div className="sm:col-span-2">
            <button className="btn" disabled={busy}>
              {busy ? "Adding…" : "Add provider"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
