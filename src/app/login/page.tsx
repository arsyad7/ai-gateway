"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (res.ok) {
      router.replace("/");
      router.refresh();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Login failed");
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={submit} className="card card-hover fade-in w-full max-w-sm p-8">
        <div
          className="grid place-items-center rounded-xl text-white font-bold mb-4"
          style={{
            width: 40,
            height: 40,
            background: "linear-gradient(135deg, var(--series-1), var(--series-7))",
          }}
        >
          A
        </div>
        <h1 className="text-lg font-semibold tracking-tight mb-1">AIcad</h1>
        <p className="text-sm mb-6" style={{ color: "var(--text-secondary)" }}>
          Enter the admin password to open the dashboard.
        </p>
        <input
          type="password"
          className="input mb-3"
          placeholder="Admin password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        {error && (
          <p className="text-sm mb-3" style={{ color: "var(--status-critical)" }}>
            {error}
          </p>
        )}
        <button className="btn w-full" disabled={busy || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
