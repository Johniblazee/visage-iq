import { Activity, BarChart3, Database, LockOpen, Pause, Play, RefreshCw, Search } from "lucide-react";
import { useState } from "react";
import { API_BASE_URL, type Health, type SyncJob, type WorkerStatus } from "../api";
import type { Tab } from "../App";
import { formatNumber, relativeTime } from "../format";

const tabs = [
  { id: "search", label: "Search", icon: Search },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
] as const;

interface SidebarProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  health: Health | null;
  healthError: string;
  worker: WorkerStatus | null;
  onToggleWorker: () => void;
  activeSync: SyncJob | null;
  syncError: string;
  onSync: (prune: boolean) => void;
  onForceUnlock: () => void;
}

export default function Sidebar({
  activeTab,
  onTabChange,
  health,
  healthError,
  worker,
  onToggleWorker,
  activeSync,
  syncError,
  onSync,
  onForceUnlock,
}: SidebarProps) {
  const [pruneDeleted, setPruneDeleted] = useState(true);

  const enrolledCount = health?.enrolled_count ?? 0;
  const driveTotal = health?.drive_total ?? null;
  const coverage = driveTotal ? Math.min(100, (enrolledCount / driveTotal) * 100) : null;
  const progress = activeSync?.progress;

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">VI</div>
        <div>
          <h1>VisageIQ</h1>
          <p>Face match operations</p>
        </div>
      </div>
      <nav className="nav-tabs" aria-label="Main">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={activeTab === tab.id ? "active" : ""}
            type="button"
            onClick={() => onTabChange(tab.id)}
          >
            <tab.icon size={18} />
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>
      <section className="side-section">
        <div className="section-heading">
          <Database size={17} />
          <span>Database</span>
        </div>
        {healthError ? (
          <p className="status-line danger">API unreachable</p>
        ) : health ? (
          <>
            <div className="metric-grid">
              <div>
                <span>Enrolled</span>
                <strong>{formatNumber(health.enrolled_count)}</strong>
              </div>
              <div>
                <span>In Drive</span>
                <strong>{driveTotal === null ? "-" : formatNumber(driveTotal)}</strong>
              </div>
            </div>
            {coverage !== null && (
              <div className="mini-progress">
                <span style={{ width: `${coverage}%` }}></span>
              </div>
            )}
            {coverage !== null && <p className="muted">{coverage.toFixed(1)}% coverage</p>}
            {health.last_sync_finished_at && (
              <p className="muted">Last sync {relativeTime(health.last_sync_finished_at)}</p>
            )}
            <p className="muted">Model: {health.model || "unknown"}</p>
          </>
        ) : (
          <p className="muted">Loading status...</p>
        )}
      </section>
      <section className="side-section">
        <div className="section-heading">
          <Activity size={17} />
          <span>Worker</span>
        </div>
        {worker ? (
          <>
            <p className={`status-line ${worker.suspended ? "warn" : "good"}`}>
              {worker.suspended ? "Paused" : "Running"}
            </p>
            <button className="button secondary full" type="button" onClick={onToggleWorker}>
              {worker.suspended ? <Play size={16} /> : <Pause size={16} />}
              <span>{worker.suspended ? "Resume worker" : "Pause worker"}</span>
            </button>
          </>
        ) : (
          <p className="muted">Status unavailable</p>
        )}
      </section>
      <section className="side-section">
        <div className="section-heading">
          <RefreshCw size={17} />
          <span>Drive Sync</span>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={pruneDeleted}
            onChange={(event) => setPruneDeleted(event.target.checked)}
          />
          <span>Remove deleted Drive files</span>
        </label>
        <button className="button primary full" type="button" onClick={() => onSync(pruneDeleted)}>
          <RefreshCw size={16} />
          <span>Sync now</span>
        </button>
        <button className="button ghost full" type="button" onClick={onForceUnlock}>
          <LockOpen size={16} />
          <span>Force unlock</span>
        </button>
        {syncError && <p className="status-line danger">{syncError}</p>}
      </section>
      {activeSync && (
        <section className="side-section active-sync">
          <div className="section-heading">
            <Activity size={17} />
            <span>Active Sync</span>
          </div>
          <p className="muted">
            Job {String(activeSync.job_id).slice(0, 8)}: {activeSync.status}
          </p>
          {progress && (
            <>
              {progress.phase === "embedding" && progress.total ? (
                <div className="mini-progress">
                  <span
                    style={{
                      width: `${Math.min(100, ((progress.current || 0) / progress.total) * 100)}%`,
                    }}
                  ></span>
                </div>
              ) : null}
              <p className="muted">
                {formatNumber(progress.current || progress.listed || 0)}
                {progress.total ? <>/ {formatNumber(progress.total)}</> : null} {progress.phase || ""}
              </p>
            </>
          )}
        </section>
      )}
      <p className="api-note">API: {API_BASE_URL}</p>
    </aside>
  );
}
