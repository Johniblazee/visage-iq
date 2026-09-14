import { useEffect, useRef, useState } from "react";
import { apiRequest, errorMessage, type AppConfig, type Health, type SyncJob, type WorkerStatus } from "./api";
import { OrgControl, UserControl } from "./auth";
import AnalyticsPage from "./components/AnalyticsPage";
import SearchPage from "./components/SearchPage";
import SettingsPage from "./components/SettingsPage";
import StudentsPage from "./components/StudentsPage";
import { Icon, toast, ToastHost, VqLockup, VqMark } from "./ds";
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
  const [page, setPage] = useState<Tab>(() => {
    const saved = localStorage.getItem("visageiq-page");
    return NAV.some(([key]) => key === saved) ? (saved as Tab) : "search";
  });
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("visageiq-collapsed") === "1");
  const [theme, setTheme] = useState(() => localStorage.getItem("visageiq-theme") || "light");
  const [lightPalette, setLightPalette] = useState(() => localStorage.getItem("visageiq-lp") || "cool");
  const [darkPalette, setDarkPalette] = useState(() => localStorage.getItem("visageiq-dp") || "slate");
  const [cfg, setCfgState] = useState<Cfg>(loadCfg);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [model, setModel] = useState(() => localStorage.getItem("visageiq-model") || "");
  const dirtyRef = useRef(false); // local dial change not yet written back
  const patchTimer = useRef(0);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState("");
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [activeSync, setActiveSync] = useState<SyncJob | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("visageiq-theme", theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.setAttribute("data-lp", lightPalette);
    localStorage.setItem("visageiq-lp", lightPalette);
  }, [lightPalette]);
  useEffect(() => {
    document.documentElement.setAttribute("data-dp", darkPalette);
    localStorage.setItem("visageiq-dp", darkPalette);
  }, [darkPalette]);
  useEffect(() => {
    localStorage.setItem("visageiq-page", page);
  }, [page]);
  useEffect(() => {
    localStorage.setItem("visageiq-collapsed", collapsed ? "1" : "0");
  }, [collapsed]);
  useEffect(() => {
    localStorage.setItem("visageiq-cfg", JSON.stringify(cfg));
  }, [cfg]);
  useEffect(() => {
    localStorage.setItem("visageiq-model", model);
  }, [model]);

  // Server config is the source of truth for the dials: adopt it unless a
  // local change is still waiting to be written back.
  function applyServerConfig(next: AppConfig) {
    setConfig(next);
    if (!dirtyRef.current) {
      setCfgState((current) => {
        const fromServer = { match: next.match_threshold, review: next.review_threshold, topK: next.top_k };
        return current.match === fromServer.match &&
          current.review === fromServer.review &&
          current.topK === fromServer.topK
          ? current
          : fromServer;
      });
    }
  }

  async function loadConfig() {
    try {
      applyServerConfig(await apiRequest<AppConfig>("/config"));
    } catch {
      // API down — /health already reports it; keep the local dial values.
    }
  }

  // Dial changes write back (debounced) so the API's verdicts and every
  // other client use the same thresholds.
  function setCfg(next: Cfg) {
    dirtyRef.current = true;
    setCfgState(next);
    window.clearTimeout(patchTimer.current);
    patchTimer.current = window.setTimeout(async () => {
      try {
        const saved = await apiRequest<AppConfig>("/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            match_threshold: next.match,
            review_threshold: next.review,
            top_k: next.topK,
          }),
        });
        dirtyRef.current = false;
        applyServerConfig(saved);
      } catch (error) {
        dirtyRef.current = false;
        toast("error", "Couldn't save the thresholds", errorMessage(error));
      }
    }, 600);
  }

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
    await Promise.all([loadHealth(), loadWorker(), loadConfig()]);
  }

  useEffect(() => {
    refreshOps();
    const id = window.setInterval(refreshOps, 4000);
    return () => window.clearInterval(id);
  }, []);

  async function toggleWorker() {
    if (!worker) return;
    const resuming = worker.suspended;
    try {
      await apiRequest(resuming ? "/worker/resume" : "/worker/pause", { method: "POST" });
      toast("ok", resuming ? "Worker resumed" : "Worker paused",
        resuming ? "Queued sync jobs will be picked up again." : "Queued jobs wait until you resume it.");
      await loadWorker();
    } catch (error) {
      toast("error", "Couldn't change the worker state", errorMessage(error));
    }
  }

  async function triggerSync(prune: boolean) {
    try {
      const body = await apiRequest<{ job_id: string; status?: string }>(`/sync?prune=${prune}`, {
        method: "POST",
      });
      toast("ok", "Drive sync started", `Job ${body.job_id.slice(0, 8)} is queued — progress shows in the topbar.`);
      await refreshOps();
      setActiveSync({ job_id: body.job_id, status: body.status || "queued", progress: null });
    } catch (error) {
      toast("error", "Couldn't start the Drive sync", errorMessage(error));
    }
  }

  async function forceUnlock() {
    const ok = window.confirm("Clear the active sync lock? Use this only when no worker is running a sync.");
    if (!ok) return;
    try {
      await apiRequest("/sync/force-unlock", { method: "POST" });
      toast("ok", "Sync lock cleared", "The next sync can start immediately.");
      await refreshOps();
    } catch (error) {
      toast("error", "Couldn't clear the sync lock", errorMessage(error));
    }
  }

  const dark = theme === "dark";
  const models = config?.models || [];
  // Per-operator pick; falls back to the primary when unset or no longer offered.
  const activeModel = models.some((m) => m.name === model) ? model : config?.model || "";
  const workerRunning = worker ? !worker.suspended : false;
  const coverage = health?.drive_total
    ? ((health.enrolled_count / health.drive_total) * 100).toFixed(1) + "%"
    : null;
  const syncing = activeSync && ["queued", "running"].includes(activeSync.status);

  return (
    <div className={"app" + (collapsed ? " collapsed" : "")}>
      <ToastHost />
      <aside className="side">
        <div className="side-top">
          {/* Logo rules: 32px mark alone when the rail is collapsed, lockup expanded. */}
          {collapsed ? <VqMark size={32} onDark /> : <VqLockup mark={28} type={19} onDark />}
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
          <div className="hide-collapsed">
            <OrgControl />
          </div>
          <UserControl isDark={dark} />
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
        {page === "search" && <SearchPage cfg={cfg} model={activeModel} />}
        {page === "students" && <StudentsPage onNav={setPage} />}
        {page === "analytics" && <AnalyticsPage activeSync={activeSync} onOpsChanged={refreshOps} />}
        {page === "settings" && (
          <SettingsPage
            cfg={cfg}
            setCfg={setCfg}
            config={config}
            model={activeModel}
            setModel={setModel}
            theme={theme}
            setTheme={setTheme}
            lightPalette={lightPalette}
            setLightPalette={setLightPalette}
            darkPalette={darkPalette}
            setDarkPalette={setDarkPalette}
            health={health}
            worker={worker}
            activeSync={activeSync}
            onToggleWorker={toggleWorker}
            onSync={triggerSync}
            onForceUnlock={forceUnlock}
          />
        )}
      </main>
    </div>
  );
}
