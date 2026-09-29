"use client";

import { useCallback, useEffect, useState } from "react";
import { api, Badge, compact, EmptyState, Meter, PageHeader, StatusBadge, usd } from "@/components/ui";

type Provider = { id: string; name: string; kind: string };
type ModelRow = {
  id: string;
  alias: string;
  displayName: string | null;
  upstreamModel: string;
  provider: Provider;
  enabled: boolean;
  priority: number;
  tags: string;
  reasoning: boolean;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  limitTokens: number | null;
  limitUsd: number | null;
  period: string;
  alertThreshold: number;
  spend: { tokens: number; usd: number; requests: number };
  limit: {
    used: number;
    exhausted: boolean;
    warning: boolean;
    tokenPct: number | null;
    usdPct: number | null;
  };
};

const PERIODS = ["daily", "weekly", "monthly", "total"];

const emptyForm = {
  providerId: "",
  alias: "",
  upstreamModel: "",
  inputPricePerMTok: "",
  outputPricePerMTok: "",
  limitTokens: "",
  limitUsd: "",
  period: "monthly",
  tags: "",
  priority: "100",
  reasoning: false,
};

export default function ModelsPage() {
  const [models, setModels] = useState<ModelRow[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [form, setForm] = useState({ ...emptyForm });
  const [editing, setEditing] = useState<ModelRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<ModelRow[]>("/api/admin/models").then(setModels).catch((e) => setError(e.message));
    api<Provider[]>("/api/admin/providers").then(setProviders).catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function createModel(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/models", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setForm({ ...emptyForm });
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, data: Record<string, unknown>) {
    setError(null);
    try {
      await api(`/api/admin/models/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(id: string, alias: string) {
    if (!confirm(`Delete model '${alias}'? Usage history is kept.`)) return;
    await api(`/api/admin/models/${id}`, { method: "DELETE" });
    load();
  }

  async function saveLimits(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    await patch(editing.id, {
      limitTokens: editing.limitTokens,
      limitUsd: editing.limitUsd,
      period: editing.period,
      alertThreshold: editing.alertThreshold,
      inputPricePerMTok: editing.inputPricePerMTok,
      outputPricePerMTok: editing.outputPricePerMTok,
      priority: editing.priority,
      tags: editing.tags,
      reasoning: editing.reasoning,
    });
    setEditing(null);
  }

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({
      ...f,
      [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value,
    }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Models & Limits"
        description="Model aliases clients can request, with pricing, routing priority, and per-period budgets."
      />
      {error && (
        <p className="text-sm" style={{ color: "var(--status-critical)" }}>
          {error}
        </p>
      )}

      <section className="card p-5 space-y-3">
        {models.length === 0 && (
          <EmptyState
            title="No models yet"
            hint="Add a provider first, then register models here."
          />
        )}
        {models.map((m) => (
          <div
            key={m.id}
            className="rounded-lg border p-4 card-hover fade-in"
            style={{ borderColor: "var(--grid)", opacity: m.enabled ? 1 : 0.55 }}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium text-sm">{m.alias}</span>
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                → {m.upstreamModel} @ {m.provider.name} ({m.provider.kind})
              </span>
              {m.reasoning && <Badge tone="accent">reasoning</Badge>}
              {!m.enabled && <Badge tone="muted">disabled</Badge>}
              {m.tags &&
                m.tags.split(",").filter(Boolean).map((t) => (
                  <Badge key={t}>{t.trim()}</Badge>
                ))}
              <span className="ml-auto flex items-center gap-2">
                <StatusBadge
                  exhausted={m.limit.exhausted}
                  warning={m.limit.warning}
                  unlimited={!m.limitTokens && !m.limitUsd}
                />
                <button className="btn-ghost" onClick={() => setEditing({ ...m })}>
                  Edit
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => patch(m.id, { enabled: !m.enabled })}
                >
                  {m.enabled ? "Disable" : "Enable"}
                </button>
                <button className="btn-ghost btn-danger" onClick={() => remove(m.id, m.alias)}>
                  Delete
                </button>
              </span>
            </div>

            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <div className="flex justify-between text-xs mb-1" style={{ color: "var(--text-secondary)" }}>
                  <span>Tokens ({m.period})</span>
                  <span>
                    {compact(m.spend.tokens)}
                    {m.limitTokens ? ` / ${compact(m.limitTokens)}` : " (no cap)"}
                  </span>
                </div>
                {m.limitTokens ? (
                  <Meter
                    used={m.limit.tokenPct ?? 0}
                    warning={m.limit.warning}
                    exhausted={(m.limit.tokenPct ?? 0) >= 1}
                  />
                ) : (
                  <div className="h-2 rounded-full" style={{ background: "var(--grid)" }} />
                )}
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1" style={{ color: "var(--text-secondary)" }}>
                  <span>Spend ({m.period})</span>
                  <span>
                    {usd(m.spend.usd)}
                    {m.limitUsd ? ` / ${usd(m.limitUsd)}` : " (no cap)"}
                  </span>
                </div>
                {m.limitUsd ? (
                  <Meter
                    used={m.limit.usdPct ?? 0}
                    warning={m.limit.warning}
                    exhausted={(m.limit.usdPct ?? 0) >= 1}
                  />
                ) : (
                  <div className="h-2 rounded-full" style={{ background: "var(--grid)" }} />
                )}
              </div>
            </div>

            <div className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
              ${m.inputPricePerMTok}/M in · ${m.outputPricePerMTok}/M out ·
              priority {m.priority} · {m.spend.requests} requests this {m.period === "total" ? "lifetime" : m.period.replace(/ly$/, "")}
            </div>
          </div>
        ))}
      </section>

      {editing && (
        <section className="card p-5">
          <h2 className="text-sm font-medium mb-4">Edit {editing.alias}</h2>
          <form onSubmit={saveLimits} className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs space-y-1">
              <span style={{ color: "var(--text-muted)" }}>Token limit (blank = none)</span>
              <input
                className="input"
                type="number"
                min={0}
                value={editing.limitTokens ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, limitTokens: e.target.value === "" ? null : Number(e.target.value) })
                }
              />
            </label>
            <label className="text-xs space-y-1">
              <span style={{ color: "var(--text-muted)" }}>USD limit (blank = none)</span>
              <input
                className="input"
                type="number"
                min={0}
                step="0.01"
                value={editing.limitUsd ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, limitUsd: e.target.value === "" ? null : Number(e.target.value) })
                }
              />
            </label>
            <label className="text-xs space-y-1">
              <span style={{ color: "var(--text-muted)" }}>Period</span>
              <select
                className="input"
                value={editing.period}
                onChange={(e) => setEditing({ ...editing, period: e.target.value })}
              >
                {PERIODS.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            <label className="text-xs space-y-1">
              <span style={{ color: "var(--text-muted)" }}>Warn at (0–1)</span>
              <input
                className="input"
                type="number"
                min={0}
                max={1}
                step="0.05"
                value={editing.alertThreshold}
                onChange={(e) => setEditing({ ...editing, alertThreshold: Number(e.target.value) })}
              />
            </label>
            <label className="text-xs space-y-1">
              <span style={{ color: "var(--text-muted)" }}>$ / M input tok</span>
              <input
                className="input"
                type="number"
                min={0}
                step="0.01"
                value={editing.inputPricePerMTok}
                onChange={(e) => setEditing({ ...editing, inputPricePerMTok: Number(e.target.value) })}
              />
            </label>
            <label className="text-xs space-y-1">
              <span style={{ color: "var(--text-muted)" }}>$ / M output tok</span>
              <input
                className="input"
                type="number"
                min={0}
                step="0.01"
                value={editing.outputPricePerMTok}
                onChange={(e) => setEditing({ ...editing, outputPricePerMTok: Number(e.target.value) })}
              />
            </label>
            <label className="text-xs space-y-1">
              <span style={{ color: "var(--text-muted)" }}>Priority (lower wins ties)</span>
              <input
                className="input"
                type="number"
                value={editing.priority}
                onChange={(e) => setEditing({ ...editing, priority: Number(e.target.value) })}
              />
            </label>
            <label className="text-xs space-y-1">
              <span style={{ color: "var(--text-muted)" }}>Tags (comma-separated)</span>
              <input
                className="input"
                value={editing.tags}
                onChange={(e) => setEditing({ ...editing, tags: e.target.value })}
              />
            </label>
            <label className="text-xs flex items-end gap-2 pb-2">
              <input
                type="checkbox"
                checked={editing.reasoning}
                onChange={(e) => setEditing({ ...editing, reasoning: e.target.checked })}
              />
              <span>Reasoning / thinking model</span>
            </label>
            <div className="sm:col-span-3 flex gap-2">
              <button className="btn" type="submit">
                Save
              </button>
              <button className="btn-ghost" type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}

      <section className="card p-5">
        <h2 className="text-sm font-medium mb-4">Add model</h2>
        <form onSubmit={createModel} className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>Provider</span>
            <select className="input" value={form.providerId} onChange={set("providerId")} required>
              <option value="">Select…</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.kind})
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>Alias (what clients request)</span>
            <input className="input" value={form.alias} onChange={set("alias")} placeholder="claude-opus-5" required />
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>Upstream model id</span>
            <input
              className="input"
              value={form.upstreamModel}
              onChange={set("upstreamModel")}
              placeholder="claude-opus-5"
              required
            />
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>$ / M input tok</span>
            <input className="input" type="number" min={0} step="0.01" value={form.inputPricePerMTok} onChange={set("inputPricePerMTok")} placeholder="5" />
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>$ / M output tok</span>
            <input className="input" type="number" min={0} step="0.01" value={form.outputPricePerMTok} onChange={set("outputPricePerMTok")} placeholder="25" />
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>Period</span>
            <select className="input" value={form.period} onChange={set("period")}>
              {PERIODS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>Token limit (optional)</span>
            <input className="input" type="number" min={0} value={form.limitTokens} onChange={set("limitTokens")} placeholder="10000000" />
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>USD limit (optional)</span>
            <input className="input" type="number" min={0} step="0.01" value={form.limitUsd} onChange={set("limitUsd")} placeholder="50" />
          </label>
          <label className="text-xs space-y-1">
            <span style={{ color: "var(--text-muted)" }}>Tags</span>
            <input className="input" value={form.tags} onChange={set("tags")} placeholder="cheap,fast" />
          </label>
          <label className="text-xs flex items-center gap-2">
            <input type="checkbox" checked={form.reasoning} onChange={set("reasoning")} />
            <span>Reasoning / thinking model</span>
          </label>
          <div className="sm:col-span-3">
            <button className="btn" disabled={busy}>
              {busy ? "Adding…" : "Add model"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
