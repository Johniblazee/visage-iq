import { useEffect, useState } from "react";
import { apiRequest, errorMessage, type Health, type SyncJob, type WorkerStatus } from "./api";
import AnalyticsPage from "./components/AnalyticsPage";
import SearchPage from "./components/SearchPage";
import SettingsPage from "./components/SettingsPage";
import StudentsPage from "./components/StudentsPage";
import { Icon, MivaMark } from "./ds";
import { formatNumber, relativeTime } from "./format";

export type Tab = "search" | "students" | "analytics" | "settings";

export interface Cfg {
  match: number;
  review: number;
  topK: number;
}

export const DEFAULT_CFG: Cfg = {
  match: Number(import.meta.env.VITE_DEFAULT_MATCH || 0.5),
  review: Number(import.meta.env.VITE_DEFAULT_REVIEW || 0.4),
  topK: 4,
};

const NAV: [Tab, string, string][] = [
  ["search", "Face search", "search"],
  ["students", "Student search", "user"],
  ["analytics", "Analytics", "grid"],
  ["settings", "Settings", "shield"],
];

function loadCfg(): Cfg {
  try {
    return { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem("visageiq-cfg") || "{}") };
  } catch {
    return DEFAULT_CFG;
  }
}

export default function App() {
  const [page, setPage] = useState<Tab>(() => (localStorage.getItem("visageiq-page") as Tab) || "search");
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("visageiq-collapsed") === "1");
  const [theme, setTheme] = useState(() => localStorage.getItem("visageiq-theme") || "light");
  const [cfg, setCfg] = useState<Cfg>(loadCfg);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState("");
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [activeSync, setActiveSync] = useState<SyncJob | null>(null);
  const [syncError, setSyncError] = useState("");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("visageiq-theme", theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("visageiq-page", page);
  }, [page]);
  useEffect(() => {
    localStorage.setItem("visageiq-collapsed", collapsed ? "1" : "0");
  }, [collapsed]);
  useEffect(() => {
    localStorage.setItem("visageiq-cfg", JSON.stringify(cfg));
  }, [cfg]);

  async function loadHealth() {
    try {
      const body = await apiRequest<Health>("/health");
      setHealth(body);
      setHealthError("");
      if (body.active_sync_job_id) {
        try {
          setActiveSync(await apiRequest<SyncJob>(`/sync/${body.active_sync_job_id}`));
        } catch {
          setActiveSync(null);
        }
      } else {
        setActiveSync(null);
      }
    } catch (error) {
      setHealthError(errorMessage(error));
      setHealth(null);
      setActiveSync(null);
    }
  }

  async function loadWorker() {
    try {
      setWorker(await apiRequest<WorkerStatus>("/worker/status"));
    } catch {
      setWorker(null);
    }
  }

  async function refreshOps() {
    await Promise.all([loadHealth(), loadWorker()]);
  }

  useEffect(() => {
    refreshOps();
    const id = window.setInterval(refreshOps, 4000);
    return () => window.clearInterval(id);
  }, []);

  async function toggleWorker() {
    if (!worker) return;
    await apiRequest(worker.suspended ? "/worker/resume" : "/worker/pause", { method: "POST" });
    await loadWorker();
  }

  async function triggerSync(prune: boolean) {
    setSyncError("");
    try {
      const body = await apiRequest<{ job_id: string; status?: string }>(`/sync?prune=${prune}`, {
        method: "POST",
      });
      await refreshOps();
      setActiveSync({ job_id: body.job_id, status: body.status || "queued", progress: null });
    } catch (error) {
      setSyncError(errorMessage(error));
    }
  }

  async function forceUnlock() {
    const ok = window.confirm("Clear the active sync lock? Use this only when no worker is running a sync.");
    if (!ok) return;
    setSyncError("");
    try {
      await apiRequest("/sync/force-unlock", { method: "POST" });
      await refreshOps();
    } catch (error) {
      setSyncError(errorMessage(error));
    }
  }

  const dark = theme === "dark";
  const workerRunning = worker ? !worker.suspended : false;
  const coverage =
    health?.drive_total && health.enrolled_count
      ? ((health.enrolled_count / health.drive_total) * 100).toFixed(1) + "%"
      : null;
  const syncing = activeSync && ["queued", "running"].includes(activeSync.status);

  return (
    <div className={"app" + (collapsed ? " collapsed" : "")}>
      <aside className="side">
        <div className="side-top">
          <MivaMark height={30} />
          <div className="hide-collapsed" style={{ minWidth: 0 }}>
            <div className="side-title">VisageIQ</div>
            <div className="side-sub">Face match operations</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map(([key, label, icon]) => (
            <button
              key={key}
              className="nav-item"
              aria-current={page === key ? "page" : undefined}
              onClick={() => setPage(key)}
              title={label}
            >
              <span className="nav-rail"></span>
              <Icon name={icon} size={18} />
              <span className="hide-collapsed">{label}</span>
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <div className="row" style={{ gap: "var(--s-2)", flexWrap: "nowrap" }}>
            <button className="icon-btn on-dark" onClick={() => setCollapsed(!collapsed)} aria-label="Toggle sidebar">
              <Icon name="menu" size={16} />
            </button>
            <button
              className="icon-btn on-dark"
              onClick={() => setTheme(dark ? "light" : "dark")}
              aria-label="Toggle theme"
            >
              <Icon name={dark ? "sparkles" : "globe"} size={16} />
            </button>
            <span className="side-meta hide-collapsed">{dark ? "Dark" : "Light"} theme</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="row" style={{ gap: "var(--s-3)", flexWrap: "nowrap" }}>
            <span className="eyebrow" style={{ color: "var(--txt-3)" }}>
              VisageIQ
            </span>
            <span className="muted">/</span>
            <span
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                fontSize: "var(--text-h4)",
                whiteSpace: "nowrap",
              }}
            >
              {NAV.find(([key]) => key === page)?.[1]}
            </span>
          </div>
          <div className="status-strip">
            {healthError ? (
              <span className="pip">
                <span className="dot" style={{ background: "var(--no)" }}></span>API unreachable
              </span>
            ) : (
              <>
                <span className="pip">
                  <b>{formatNumber(health?.enrolled_count)}</b> enrolled
                </span>
                {coverage && (
                  <span className="pip">
                    <b>{coverage}</b> coverage
                  </span>
                )}
                <span className="pip">
                  <span
                    className={"dot" + (workerRunning ? " live" : "")}
                    style={{ background: workerRunning ? "var(--ok)" : "var(--miva-grey-3)" }}
                  ></span>
                  Worker {worker ? (workerRunning ? "running" : "paused") : "unknown"}
                </span>
                <span className="pip">
                  <Icon name="clock" size={14} color="var(--txt-3)" />
                  {syncing
                    ? `Syncing ${activeSync?.progress?.current ?? "…"}${activeSync?.progress?.total ? ` of ${formatNumber(activeSync.progress.total)}` : ""}`
                    : health?.last_sync_finished_at
                      ? `Synced ${relativeTime(health.last_sync_finished_at)}`
                      : "Never synced"}
                </span>
              </>
            )}
          </div>
        </header>
        {page === "search" && <SearchPage cfg={cfg} model={health?.model} onNav={setPage} />}
        {page === "students" && <StudentsPage onNav={setPage} />}
        {page === "analytics" && <AnalyticsPage activeSync={activeSync} onOpsChanged={refreshOps} />}
        {page === "settings" && (
          <SettingsPage
            cfg={cfg}
            setCfg={setCfg}
            health={health}
            worker={worker}
            activeSync={activeSync}
            syncError={syncError}
            onToggleWorker={toggleWorker}
            onSync={triggerSync}
            onForceUnlock={forceUnlock}
          />
        )}
      </main>
    </div>
  );
}
