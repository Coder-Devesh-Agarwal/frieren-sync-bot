import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// --- Types ---
interface Group {
  id: string;
  name: string;
  participantCount: number;
}

interface Mapping {
  id: number;
  source_group_id: string;
  source_group_name: string | null;
  target_group_id: string;
  target_group_name: string | null;
  bidirectional: number;
  active: number;
  created_at: number;
}

interface GroupsResponse {
  groups: Group[];
  lastUpdated: number;
}

type Screen = "login" | "qr" | "dashboard" | "mappings" | "reconcile";

interface ReconcileSummaryItem {
  mappingId: number;
  direction: string;
  sourceGroupName: string;
  targetGroupName: string;
  missedCount: number;
}

interface ReconcileMsg {
  id: string;
  timestamp: number;
  senderName: string;
  senderPhone: string;
  body: string;
  hasMedia: boolean;
  type: string;
}

// --- API helpers ---
async function api<T = any>(path: string, opts?: RequestInit): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const res = await fetch(path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...opts?.headers },
    });
    const data = (await res.json()) as any;
    if (!res.ok) return { ok: false, error: data.error || "Request failed" };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

// --- Reusable Toggle ---
function Toggle({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="relative inline-flex items-center cursor-pointer" title={title}>
      <input type="hidden" />
      <div
        className={`toggle-track ${checked ? "checked" : ""}`}
        onClick={() => onChange(!checked)}
      />
    </label>
  );
}

// --- Account Reset Modal ---
function AccountResetModal({ onReset, onDismiss }: { onReset: () => void; onDismiss: () => void }) {
  const [resetting, setResetting] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 max-w-md mx-4 shadow-2xl">
        <h2 className="text-lg font-semibold mb-3 text-amber-400">Account Change Detected</h2>
        <p className="text-slate-300 text-sm mb-2">
          A different WhatsApp account has connected. The existing group mappings and sync data belong to the previous account.
        </p>
        <p className="text-slate-400 text-sm mb-6">
          Reset to clear all mappings and sync cursors, or keep the data if this is the same account reconnecting.
        </p>
        <div className="flex gap-3 justify-end">
          <button
            className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors cursor-pointer border border-slate-600"
            onClick={onDismiss}
            disabled={resetting}
          >
            Keep Data
          </button>
          <button
            className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition-colors cursor-pointer border-none disabled:opacity-50"
            onClick={async () => {
              setResetting(true);
              await api("/api/whatsapp/reset", { method: "POST" });
              setResetting(false);
              onReset();
            }}
            disabled={resetting}
          >
            {resetting ? "Resetting..." : "Reset Data"}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- App ---
function App() {
  const [screen, setScreen] = useState<Screen>("login");
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingReset, setPendingReset] = useState(false);

  useEffect(() => {
    api("/api/auth/status").then(({ data }) => {
      if (data?.authenticated) {
        setAuthed(true);
        if (data.whatsappState === "ready") setScreen("dashboard");
        else setScreen("qr");
      }
      setLoading(false);
    });
  }, []);

  // Poll for account change on post-login screens
  useEffect(() => {
    if (!authed || screen === "login" || screen === "qr") return;
    let active = true;
    const poll = async () => {
      while (active) {
        const { data } = await api("/api/whatsapp/status");
        if (!active) break;
        if (data?.pendingAccountReset) {
          setPendingReset(true);
          return; // Stop polling once detected
        }
        await new Promise((r) => setTimeout(r, 10_000));
      }
    };
    poll();
    return () => { active = false; };
  }, [authed, screen]);

  const onLogin = () => {
    setAuthed(true);
    setScreen("qr");
  };

  const onLogout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    setAuthed(false);
    setScreen("login");
  };

  const onWhatsAppReady = () => setScreen("dashboard");

  if (loading) {
    return (
      <div className="flex justify-center pt-[40vh]">
        <div className="spinner" />
      </div>
    );
  }

  if (screen === "login") {
    return <LoginScreen onLogin={onLogin} />;
  }

  return (
    <>
      <header className="flex items-center justify-between mb-8 pb-4 border-b border-slate-700">
        <h1 className="text-2xl font-bold">Frieren</h1>
        <div className="flex gap-3 items-center">
          {screen !== "qr" && (
            <div className="flex gap-2">
              <button
                className={`px-4 py-2 rounded-lg text-sm cursor-pointer transition-all border ${
                  screen === "dashboard"
                    ? "bg-slate-900 text-slate-100 border-slate-700"
                    : "bg-transparent text-slate-400 border-transparent hover:text-slate-100 hover:bg-slate-800"
                }`}
                onClick={() => setScreen("dashboard")}
              >
                Groups
              </button>
              <button
                className={`px-4 py-2 rounded-lg text-sm cursor-pointer transition-all border ${
                  screen === "mappings"
                    ? "bg-slate-900 text-slate-100 border-slate-700"
                    : "bg-transparent text-slate-400 border-transparent hover:text-slate-100 hover:bg-slate-800"
                }`}
                onClick={() => setScreen("mappings")}
              >
                Mappings
              </button>
              <button
                className={`px-4 py-2 rounded-lg text-sm cursor-pointer transition-all border ${
                  screen === "reconcile"
                    ? "bg-slate-900 text-slate-100 border-slate-700"
                    : "bg-transparent text-slate-400 border-transparent hover:text-slate-100 hover:bg-slate-800"
                }`}
                onClick={() => setScreen("reconcile")}
              >
                Reconcile
              </button>
            </div>
          )}
          <button
            className="inline-flex items-center px-3 py-1.5 text-xs rounded-lg bg-transparent text-slate-400 border border-slate-700 hover:bg-slate-800 hover:text-slate-100 transition-colors cursor-pointer"
            onClick={onLogout}
          >
            Logout
          </button>
        </div>
      </header>

      {screen === "qr" && <QRScreen onReady={onWhatsAppReady} />}
      {screen === "dashboard" && <DashboardScreen />}
      {screen === "mappings" && <MappingsScreen />}
      {screen === "reconcile" && <ReconcileScreen />}

      {pendingReset && (
        <AccountResetModal
          onReset={() => {
            setPendingReset(false);
            setScreen("dashboard");
          }}
          onDismiss={async () => {
            await api("/api/whatsapp/dismiss-reset", { method: "POST" });
            setPendingReset(false);
          }}
        />
      )}
    </>
  );
}

// --- Login Screen ---
function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    const { ok, error: err } = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, totp }),
    });

    setSubmitting(false);
    if (ok) onLogin();
    else setError(err || "Login failed");
  };

  const inputCls = "w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-lg text-slate-100 text-sm outline-none focus:border-indigo-500 transition-colors";

  return (
    <div className="flex justify-center items-center min-h-[80vh]">
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-sm">
        <div className="flex justify-center mb-4">
          <img src="/freiren.webp" alt="Frieren" className="w-20 h-20 rounded-full object-center object-cover" />
        </div>
        <h1 className="text-2xl font-bold text-center mb-2">Frieren</h1>
        <p className="text-center text-slate-400 mb-6 text-sm">WhatsApp Group Sync Bot</p>

        {error && (
          <div className="bg-red-400/10 text-red-400 px-4 py-3 rounded-lg mb-4 text-sm">{error}</div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm text-slate-400 mb-1.5">Email</label>
            <input
              type="email"
              className={inputCls}
              value={email}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="mb-4">
            <label className="block text-sm text-slate-400 mb-1.5">Password</label>
            <input
              type="password"
              className={inputCls}
              value={password}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="mb-4">
            <label className="block text-sm text-slate-400 mb-1.5">TOTP Code</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              className={inputCls}
              value={totp}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTotp(e.target.value)}
              required
              placeholder="6-digit code"
            />
          </div>
          <button
            className="w-full mt-2 inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors cursor-pointer border-none disabled:opacity-50"
            disabled={submitting}
          >
            {submitting ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}

// --- QR Screen ---
function QRScreen({ onReady }: { onReady: () => void }) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [status, setStatus] = useState("Initializing WhatsApp...");
  const [showRestart, setShowRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const disconnectedCount = React.useRef(0);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      while (active) {
        const { ok, data } = await api("/api/whatsapp/status");
        if (!active) break;

        if (ok && data) {
          if (data.state === "ready") {
            onReady();
            return;
          }
          if (data.state === "qr_pending" && data.qr) {
            setQrDataUrl(data.qr);
            setStatus("Scan the QR code with WhatsApp on your phone");
            disconnectedCount.current = 0;
            setShowRestart(false);
          } else if (data.state === "connecting") {
            setQrDataUrl(null);
            setStatus("Connecting to WhatsApp...");
            disconnectedCount.current = 0;
            setShowRestart(false);
          } else {
            // disconnected state
            disconnectedCount.current++;
            setStatus("Waiting for QR code...");
            if (disconnectedCount.current >= 3) {
              setShowRestart(true);
            }
          }
        } else {
          // API error — server up but WhatsApp crashed
          disconnectedCount.current++;
          if (disconnectedCount.current >= 2) {
            setShowRestart(true);
            setStatus("WhatsApp connection failed");
          }
        }

        await new Promise((r) => setTimeout(r, 2000));
      }
    };

    poll();
    return () => { active = false; };
  }, [onReady]);

  const handleRestart = async () => {
    setRestarting(true);
    setShowRestart(false);
    setStatus("Restarting WhatsApp...");
    setQrDataUrl(null);
    disconnectedCount.current = 0;
    await api("/api/whatsapp/restart", { method: "POST" });
    setRestarting(false);
  };

  return (
    <div className="bg-slate-900 border border-slate-700 rounded-xl p-6">
      <div className="flex flex-col items-center gap-6 p-8">
        <h2 className="text-lg font-semibold">Connect WhatsApp</h2>
        {qrDataUrl ? (
          <img src={qrDataUrl} alt="WhatsApp QR Code" width={300} height={300} className="rounded-xl bg-white p-4" />
        ) : (
          <div className="spinner" />
        )}
        <p className="text-slate-400 text-sm">{status}</p>
        {showRestart && !restarting && (
          <button
            className="inline-flex items-center px-5 py-2.5 rounded-lg text-sm font-medium bg-amber-600 text-white hover:bg-amber-700 transition-colors cursor-pointer border-none"
            onClick={handleRestart}
          >
            Restart WhatsApp
          </button>
        )}
      </div>
    </div>
  );
}

// --- Helpers ---
function formatRelativeTime(ts: number): string {
  if (!ts) return "Never";
  const diffMs = Date.now() - ts;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
}

// --- Dashboard Screen ---
function DashboardScreen() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [lastUpdated, setLastUpdated] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    api<GroupsResponse>("/api/groups").then(({ data }) => {
      if (data) {
        setGroups(data.groups);
        setLastUpdated(data.lastUpdated);
      }
      setLoading(false);
    });
  }, []);

  const handleRefetch = async () => {
    setRefreshing(true);
    const { data } = await api<GroupsResponse>("/api/groups?refresh=true");
    if (data) {
      setGroups(data.groups);
      setLastUpdated(data.lastUpdated);
    }
    setRefreshing(false);
  };

  return (
    <>
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 mb-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">WhatsApp Status</h2>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-400/15 text-emerald-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            Connected
          </span>
        </div>
        <p className="text-slate-400 text-sm">
          {groups.length} groups available for syncing
        </p>
      </div>

      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 mb-6">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h2 className="text-lg font-semibold">Available Groups</h2>
            {lastUpdated > 0 && (
              <p className="text-xs text-slate-500 mt-1">Last updated: {formatRelativeTime(lastUpdated)}</p>
            )}
          </div>
          <button
            className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors cursor-pointer border border-slate-600 disabled:opacity-50"
            onClick={handleRefetch}
            disabled={refreshing}
          >
            {refreshing ? "Fetching..." : "Refetch Groups"}
          </button>
        </div>
        {loading ? (
          <div className="flex justify-center p-8">
            <div className="spinner" />
          </div>
        ) : groups.length === 0 ? (
          <p className="text-slate-400">No groups found. Click "Refetch Groups" or make sure you're part of at least one group.</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {groups.map((g) => (
              <div key={g.id} className="bg-slate-950 border border-slate-700 rounded-lg px-4 py-3">
                <div className="font-medium mb-1">{g.name}</div>
                <div className="text-xs text-slate-400">{g.participantCount} participants</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// --- Mappings Screen ---
function MappingsScreen() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [stats, setStats] = useState<Record<number, number>>({});
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [bidir, setBidir] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const [g, m, s] = await Promise.all([
      api<GroupsResponse>("/api/groups"),
      api<Mapping[]>("/api/mappings"),
      api<Record<number, number>>("/api/stats"),
    ]);
    if (g.data) setGroups(g.data.groups);
    if (m.data) setMappings(m.data);
    if (s.data) setStats(s.data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const addMapping = async () => {
    setError("");
    if (!sourceId || !targetId) {
      setError("Select both source and target groups");
      return;
    }
    if (sourceId === targetId) {
      setError("Source and target must be different groups");
      return;
    }

    const sourceName = groups.find((g) => g.id === sourceId)?.name || null;
    const targetName = groups.find((g) => g.id === targetId)?.name || null;

    const { ok, error: err } = await api("/api/mappings", {
      method: "POST",
      body: JSON.stringify({
        sourceGroupId: sourceId,
        sourceGroupName: sourceName,
        targetGroupId: targetId,
        targetGroupName: targetName,
        bidirectional: bidir,
      }),
    });

    if (ok) {
      setSourceId("");
      setTargetId("");
      setBidir(false);
      fetchData();
    } else {
      setError(err || "Failed to create mapping");
    }
  };

  const toggleActive = async (id: number, active: boolean) => {
    await api(`/api/mappings/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ active }),
    });
    fetchData();
  };

  const toggleDirection = async (id: number, bidirectional: boolean) => {
    await api(`/api/mappings/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ bidirectional }),
    });
    fetchData();
  };

  const remove = async (id: number) => {
    await api(`/api/mappings/${id}`, { method: "DELETE" });
    fetchData();
  };

  const selectCls = "w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-lg text-slate-100 text-sm outline-none focus:border-indigo-500 transition-colors";

  if (loading) {
    return (
      <div className="flex justify-center p-16">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <>
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 mb-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">Create Mapping</h2>
          <button
            className="text-xs text-indigo-400 hover:text-indigo-300 bg-transparent border-none cursor-pointer"
            onClick={async () => {
              const { data } = await api<GroupsResponse>("/api/groups?refresh=true");
              if (data) setGroups(data.groups);
            }}
          >
            Refetch groups
          </button>
        </div>
        {error && (
          <div className="bg-red-400/10 text-red-400 px-4 py-3 rounded-lg mb-4 text-sm">{error}</div>
        )}

        <div className="grid grid-cols-[1fr_auto_1fr_auto_auto] gap-3 items-end mb-6 max-sm:grid-cols-1">
          <div>
            <label className="block text-sm text-slate-400 mb-1.5">Source Group (A)</label>
            <select
              className={selectCls}
              value={sourceId}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSourceId(e.target.value)}
            >
              <option value="">Select group...</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center h-10 text-slate-400 text-xl max-sm:justify-center">
            {bidir ? "\u2194" : "\u2192"}
          </div>

          <div>
            <label className="block text-sm text-slate-400 mb-1.5">Target Group (B)</label>
            <select
              className={selectCls}
              value={targetId}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTargetId(e.target.value)}
            >
              <option value="">Select group...</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>

          <Toggle checked={bidir} onChange={setBidir} title="Bidirectional sync" />

          <button
            className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors cursor-pointer border-none"
            onClick={addMapping}
          >
            Add
          </button>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">Active Mappings</h2>
        {mappings.length === 0 ? (
          <p className="text-slate-400 py-4">
            No mappings configured yet. Create one above to start syncing messages.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider border-b border-slate-700">Source</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider border-b border-slate-700"></th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider border-b border-slate-700">Target</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider border-b border-slate-700">Messages</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider border-b border-slate-700">Active</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider border-b border-slate-700"></th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-800">
                    <td className="px-4 py-3 text-sm border-b border-slate-700">
                      {m.source_group_name || m.source_group_id}
                    </td>
                    <td className="px-4 py-3 border-b border-slate-700">
                      <button
                        className="font-semibold text-indigo-400 text-lg bg-transparent border-none cursor-pointer hover:text-indigo-300"
                        onClick={() => toggleDirection(m.id, !m.bidirectional)}
                        title={m.bidirectional ? "Click for one-way" : "Click for bidirectional"}
                      >
                        {m.bidirectional ? "\u2194" : "\u2192"}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-sm border-b border-slate-700">
                      {m.target_group_name || m.target_group_id}
                    </td>
                    <td className="px-4 py-3 text-sm border-b border-slate-700 tabular-nums text-slate-400">
                      {stats[m.id] || 0}
                    </td>
                    <td className="px-4 py-3 border-b border-slate-700">
                      <Toggle checked={!!m.active} onChange={(v) => toggleActive(m.id, v)} />
                    </td>
                    <td className="px-4 py-3 border-b border-slate-700">
                      <button
                        className="inline-flex items-center px-3 py-1.5 text-xs rounded-lg bg-red-400/15 text-red-400 hover:bg-red-400/25 transition-colors cursor-pointer border-none"
                        onClick={() => remove(m.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// --- Reconcile Screen ---
function ReconcileScreen() {
  const [summary, setSummary] = useState<ReconcileSummaryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMapping, setSelectedMapping] = useState<number | null>(null);
  const [selectedDirection, setSelectedDirection] = useState("forward");
  const [messages, setMessages] = useState<ReconcileMsg[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [mappings, setMappings] = useState<Mapping[]>([]);

  useEffect(() => {
    Promise.all([
      api<ReconcileSummaryItem[]>("/api/reconcile/summary"),
      api<Mapping[]>("/api/mappings"),
    ]).then(([s, m]) => {
      if (s.data) setSummary(s.data);
      if (m.data) setMappings(m.data.filter(mp => mp.active));
      setLoading(false);
    });
  }, []);

  const fetchMessages = useCallback(async (mapId: number, dir: string) => {
    setLoadingMessages(true);
    setError("");
    setSuccessMsg("");
    setSelectedIds(new Set());
    const { ok, data, error: err } = await api<{ messages: ReconcileMsg[]; hasMore: boolean }>(
      `/api/reconcile/messages?mappingId=${mapId}&direction=${dir}`
    );
    if (ok && data) {
      setMessages(data.messages);
      setHasMore(data.hasMore);
    } else {
      setError(err || "Failed to load messages");
    }
    setLoadingMessages(false);
  }, []);

  useEffect(() => {
    if (selectedMapping !== null) {
      fetchMessages(selectedMapping, selectedDirection);
    }
  }, [selectedMapping, selectedDirection, fetchMessages]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedIds.size === messages.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(messages.map(m => m.id)));
    }
  };

  const handleSync = async () => {
    if (selectedMapping === null || selectedIds.size === 0) return;
    setSyncing(true);
    setError("");
    setSuccessMsg("");
    const { ok, data, error: err } = await api<{ synced: number; errors: string[] }>(
      "/api/reconcile/sync",
      {
        method: "POST",
        body: JSON.stringify({
          mappingId: selectedMapping,
          direction: selectedDirection,
          messageIds: Array.from(selectedIds),
        }),
      }
    );
    setSyncing(false);
    if (ok && data) {
      setSuccessMsg(`Synced ${data.synced} message(s)${data.errors.length ? `, ${data.errors.length} error(s)` : ""}`);
      fetchMessages(selectedMapping, selectedDirection);
    } else {
      setError(err || "Sync failed");
    }
  };

  const handleIgnore = async () => {
    if (selectedMapping === null || selectedIds.size === 0) return;
    setSyncing(true);
    setError("");
    setSuccessMsg("");
    const { ok, data, error: err } = await api<{ ignored: number }>(
      "/api/reconcile/ignore",
      {
        method: "POST",
        body: JSON.stringify({
          mappingId: selectedMapping,
          direction: selectedDirection,
          messageIds: Array.from(selectedIds),
        }),
      }
    );
    setSyncing(false);
    if (ok && data) {
      setSuccessMsg(`Ignored ${data.ignored} message(s)`);
      fetchMessages(selectedMapping, selectedDirection);
    } else {
      setError(err || "Ignore failed");
    }
  };

  const handleLoadMore = async () => {
    if (selectedMapping === null) return;
    setLoadingMessages(true);
    const { ok, data, error: err } = await api<{ messages: ReconcileMsg[]; hasMore: boolean }>(
      "/api/reconcile/load-more",
      {
        method: "POST",
        body: JSON.stringify({
          mappingId: selectedMapping,
          direction: selectedDirection,
          currentCount: messages.length,
        }),
      }
    );
    if (ok && data) {
      setMessages(data.messages);
      setHasMore(data.hasMore);
      setSelectedIds(new Set());
    } else {
      setError(err || "Failed to load more");
    }
    setLoadingMessages(false);
  };

  const currentMapping = mappings.find(m => m.id === selectedMapping);

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleString();
  };

  const selectCls = "w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-lg text-slate-100 text-sm outline-none focus:border-indigo-500 transition-colors";

  if (loading) {
    return (
      <div className="flex justify-center p-16">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <>
      {/* Summary */}
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold mb-2">Message Reconciliation</h2>
        <p className="text-slate-400 text-sm mb-4">
          Review and sync messages that were missed while the bot was offline.
        </p>

        {summary.length === 0 ? (
          <p className="text-emerald-400 text-sm">All caught up! No missed messages detected.</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {summary.map((s) => (
              <button
                key={`${s.mappingId}-${s.direction}`}
                className={`text-left bg-slate-950 border rounded-lg px-4 py-3 cursor-pointer transition-all ${
                  selectedMapping === s.mappingId && selectedDirection === s.direction
                    ? "border-indigo-500"
                    : "border-slate-700 hover:border-slate-500"
                }`}
                onClick={() => {
                  setSelectedMapping(s.mappingId);
                  setSelectedDirection(s.direction);
                }}
              >
                <div className="font-medium mb-1 text-sm">
                  {s.sourceGroupName} {"\u2192"} {s.targetGroupName}
                </div>
                <div className="text-xs text-amber-400">
                  {s.missedCount} missed message{s.missedCount !== 1 ? "s" : ""}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Mapping Selector */}
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 mb-6">
        <div className="flex gap-4 items-end max-sm:flex-col">
          <div className="flex-1">
            <label className="block text-sm text-slate-400 mb-1.5">Select Mapping</label>
            <select
              className={selectCls}
              value={selectedMapping ?? ""}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                const val = parseInt(e.target.value, 10);
                setSelectedMapping(isNaN(val) ? null : val);
                setSelectedDirection("forward");
              }}
            >
              <option value="">Choose a mapping...</option>
              {mappings.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.source_group_name || m.source_group_id} {m.bidirectional ? "\u2194" : "\u2192"} {m.target_group_name || m.target_group_id}
                </option>
              ))}
            </select>
          </div>

          {currentMapping?.bidirectional ? (
            <div>
              <label className="block text-sm text-slate-400 mb-1.5">Direction</label>
              <button
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-slate-950 border border-slate-700 text-indigo-400 hover:border-indigo-500 transition-colors cursor-pointer whitespace-nowrap"
                onClick={() =>
                  setSelectedDirection(prev => prev === "forward" ? "reverse" : "forward")
                }
                title="Toggle direction"
              >
                {selectedDirection === "forward"
                  ? `${currentMapping.source_group_name || "A"} \u2192 ${currentMapping.target_group_name || "B"}`
                  : `${currentMapping.target_group_name || "B"} \u2192 ${currentMapping.source_group_name || "A"}`
                }
                <span className="text-lg">{"\u21C4"}</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Messages */}
      {selectedMapping !== null && (
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 mb-6">
          {error && (
            <div className="bg-red-400/10 text-red-400 px-4 py-3 rounded-lg mb-4 text-sm">{error}</div>
          )}
          {successMsg && (
            <div className="bg-emerald-400/10 text-emerald-400 px-4 py-3 rounded-lg mb-4 text-sm">{successMsg}</div>
          )}

          <div className="flex justify-between items-center mb-4 max-sm:flex-col max-sm:gap-3">
            <h3 className="text-md font-semibold">
              Missed Messages ({messages.length})
            </h3>
            <div className="flex gap-2">
              <button
                className="inline-flex items-center px-3 py-1.5 text-xs rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors cursor-pointer border-none disabled:opacity-50"
                disabled={selectedIds.size === 0 || syncing}
                onClick={handleSync}
              >
                {syncing ? "Syncing..." : `Sync Selected (${selectedIds.size})`}
              </button>
              <button
                className="inline-flex items-center px-3 py-1.5 text-xs rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors cursor-pointer border-none disabled:opacity-50"
                disabled={selectedIds.size === 0 || syncing}
                onClick={handleIgnore}
              >
                Ignore Selected ({selectedIds.size})
              </button>
            </div>
          </div>

          {loadingMessages ? (
            <div className="flex justify-center p-8">
              <div className="spinner" />
            </div>
          ) : messages.length === 0 ? (
            <p className="text-slate-400 py-4">No missed messages for this mapping.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="px-4 py-3 text-left border-b border-slate-700 w-10">
                        <input
                          type="checkbox"
                          checked={selectedIds.size === messages.length && messages.length > 0}
                          onChange={selectAll}
                          className="accent-indigo-500 cursor-pointer"
                        />
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider border-b border-slate-700">Time</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider border-b border-slate-700">Sender</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider border-b border-slate-700">Message</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider border-b border-slate-700">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {messages.map((m) => (
                      <tr
                        key={m.id}
                        className={`hover:bg-slate-800 cursor-pointer ${
                          selectedIds.has(m.id) ? "bg-indigo-500/10" : ""
                        }`}
                        onClick={() => toggleSelect(m.id)}
                      >
                        <td className="px-4 py-3 border-b border-slate-700">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(m.id)}
                            onChange={() => toggleSelect(m.id)}
                            className="accent-indigo-500 cursor-pointer"
                            onClick={(e: React.MouseEvent) => e.stopPropagation()}
                          />
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-400 border-b border-slate-700 whitespace-nowrap tabular-nums">
                          {formatTime(m.timestamp)}
                        </td>
                        <td className="px-4 py-3 text-sm border-b border-slate-700">
                          <div>{m.senderName}</div>
                          <div className="text-xs text-slate-500">+{m.senderPhone}</div>
                        </td>
                        <td className="px-4 py-3 text-sm border-b border-slate-700 max-w-xs truncate">
                          {m.body}
                        </td>
                        <td className="px-4 py-3 border-b border-slate-700">
                          <span className={`inline-flex px-2 py-0.5 rounded text-xs ${
                            m.hasMedia
                              ? "bg-purple-400/15 text-purple-400"
                              : "bg-slate-700 text-slate-300"
                          }`}>
                            {m.hasMedia ? "media" : "text"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {hasMore && (
                <div className="flex flex-col items-center gap-2 mt-4">
                  <p className="text-xs text-slate-400">
                    First {messages.length} messages shown. There may be more missed messages.
                  </p>
                  <button
                    className="inline-flex items-center px-5 py-2 rounded-lg text-sm bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors cursor-pointer border border-slate-600"
                    onClick={handleLoadMore}
                    disabled={loadingMessages}
                  >
                    Load More Messages
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="text-center py-4">
        <p className="text-xs text-slate-600">made by geeklord</p>
      </div>
    </>
  );
}

// --- Mount ---
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
