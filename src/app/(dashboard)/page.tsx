"use client";

import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  api,
  Badge,
  compact,
  Meter,
  PageHeader,
  seriesColor,
  Skeleton,
  StatTile,
  StatusBadge,
  usd,
} from "@/components/ui";

type SeriesRow = { date: string } & Record<string, number | string>;

type Stats = {
  totals: { requests: number; tokens: number; usd: number; errors: number };
  dailySeries: SeriesRow[];
  usdSeries: SeriesRow[];
  requestSeries: SeriesRow[];
  seriesModels: string[];
  recent: {
    id: string;
    createdAt: string;
    modelAlias: string;
    requestedModel: string;
    routedReason: string;
    totalTokens: number;
    costUsd: number;
    latencyMs: number;
    status: string;
    errorCode: string | null;
    stream: boolean;
  }[];
};

type ModelRow = {
  id: string;
  alias: string;
  provider: { name: string; kind: string };
  enabled: boolean;
  limitTokens: number | null;
  limitUsd: number | null;
  period: string;
  spend: { tokens: number; usd: number; requests: number };
  limit: { used: number; exhausted: boolean; warning: boolean };
};

/** Shared daily bar chart: stacked per-model series or a single series. */
function DailyChart({
  title,
  data,
  seriesKeys,
  format,
  height = 240,
}: {
  title: string;
  data: SeriesRow[];
  seriesKeys: string[];
  format: (v: number) => string;
  height?: number;
}) {
  const stacked = seriesKeys.length > 1;
  return (
    <section className="card p-5">
      <h2 className="text-sm font-medium mb-4">{title}</h2>
      <div style={{ width: "100%", height }}>
        <ResponsiveContainer>
          <BarChart data={data} barCategoryGap="25%">
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => d.slice(5)}
              tick={{ fill: "var(--text-muted)", fontSize: 11 }}
              axisLine={{ stroke: "var(--baseline)" }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={format}
              tick={{ fill: "var(--text-muted)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={52}
            />
            <Tooltip
              cursor={{ fill: "var(--grid)", opacity: 0.4 }}
              contentStyle={{
                background: "var(--surface-1)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value) => format(Number(value))}
            />
            {stacked && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {seriesKeys.map((key, i) => (
              <Bar
                key={key}
                dataKey={key}
                stackId="s"
                fill={stacked ? seriesColor(i) : "var(--accent)"}
                stroke="var(--surface-1)"
                strokeWidth={2}
                radius={i === seriesKeys.length - 1 ? [4, 4, 0, 0] : 0}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

export default function OverviewPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all([
        api<Stats>("/api/admin/stats"),
        api<ModelRow[]>("/api/admin/models"),
      ])
        .then(([s, m]) => {
          if (!live) return;
          setStats(s);
          setModels(m);
          setError(null);
        })
        .catch((e) => live && setError(e.message));
    load();
    const t = setInterval(load, 15_000); // live-ish monitoring
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (error)
    return (
      <p className="text-sm" style={{ color: "var(--status-critical)" }}>
        {error}
      </p>
    );
  if (!stats || !models)
    return (
      <div className="space-y-6">
        <Skeleton className="h-7" style={{ width: 160 }} />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} style={{ height: 96 }} />
          ))}
        </div>
        <Skeleton style={{ height: 300 }} />
      </div>
    );

  const limited = models.filter((m) => m.limitTokens || m.limitUsd);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Live usage, spend, and credit limits. Refreshes every 15 seconds."
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile label="Requests" value={compact(stats.totals.requests)} />
        <StatTile label="Tokens used" value={compact(stats.totals.tokens)} />
        <StatTile label="Spend" value={usd(stats.totals.usd)} />
        <StatTile
          label="Errors"
          value={compact(stats.totals.errors)}
          detail={stats.totals.errors > 0 ? "see recent requests" : undefined}
        />
      </div>

      <DailyChart
        title="Tokens per day, by model (last 14 days)"
        data={stats.dailySeries}
        seriesKeys={stats.seriesModels}
        format={(v) => compact(v)}
        height={260}
      />
      {stats.seriesModels.length === 0 && (
        <p className="text-sm -mt-3" style={{ color: "var(--text-muted)" }}>
          No traffic yet. Point a client at <code>/v1/chat/completions</code>.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <DailyChart
          title="Spend per day (USD)"
          data={stats.usdSeries}
          seriesKeys={stats.seriesModels}
          format={(v) => (v > 0 && v < 1 ? `$${v.toFixed(2)}` : `$${compact(v)}`)}
        />
        <DailyChart
          title="Requests per day"
          data={stats.requestSeries}
          seriesKeys={["requests"]}
          format={(v) => compact(v)}
        />
      </div>

      <section className="card p-5">
        <h2 className="text-sm font-medium mb-4">Credit limits</h2>
        {limited.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            No models have limits yet — set token or USD budgets in Models &
            Limits.
          </p>
        ) : (
          <div className="space-y-4">
            {limited.map((m) => (
              <div key={m.id}>
                <div className="flex flex-wrap items-baseline justify-between mb-1.5 gap-x-3 gap-y-1">
                  <div className="text-sm font-medium truncate">
                    {m.alias}
                    <span
                      className="ml-2 text-xs font-normal"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {m.provider.name} · {m.period}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span
                      className="text-xs"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {m.limitTokens
                        ? `${compact(m.spend.tokens)} / ${compact(m.limitTokens)} tok`
                        : `${usd(m.spend.usd)} / ${usd(m.limitUsd ?? 0)}`}
                    </span>
                    <StatusBadge
                      exhausted={m.limit.exhausted}
                      warning={m.limit.warning}
                      unlimited={false}
                    />
                  </div>
                </div>
                <Meter
                  used={m.limit.used}
                  warning={m.limit.warning}
                  exhausted={m.limit.exhausted}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card p-5 overflow-x-auto">
        <h2 className="text-sm font-medium mb-3">Recent requests</h2>
        <table className="data" style={{ minWidth: 640 }}>
          <thead>
            <tr>
              <th>Time</th>
              <th>Requested</th>
              <th>Served by</th>
              <th>Route</th>
              <th>Tokens</th>
              <th>Cost</th>
              <th>Latency</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {stats.recent.length === 0 && (
              <tr>
                <td colSpan={8} style={{ color: "var(--text-muted)" }}>
                  Nothing yet.
                </td>
              </tr>
            )}
            {stats.recent.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">
                  {new Date(r.createdAt).toLocaleTimeString()}
                </td>
                <td>{r.requestedModel}</td>
                <td style={{ color: "var(--text-primary)" }}>{r.modelAlias}</td>
                <td>{r.routedReason}</td>
                <td>{compact(r.totalTokens)}</td>
                <td>{usd(r.costUsd)}</td>
                <td>{r.latencyMs}ms</td>
                <td>
                  {r.status === "ok" ? (
                    <Badge tone="good">✓ ok</Badge>
                  ) : (
                    <Badge tone="critical">✕ {r.errorCode ?? r.status}</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
