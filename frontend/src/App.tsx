import { useCallback, useEffect, useState } from "react";
import { apiRequest, errorMessage, type Health, type SyncJob, type WorkerStatus } from "./api";
import AnalyticsView from "./components/AnalyticsView";
import SearchView from "./components/SearchView";
import Sidebar from "./components/Sidebar";

export type Tab = "search" | "analytics";

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("search");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState("");
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [activeSync, setActiveSync] = useState<SyncJob | null>(null);
  const [syncError, setSyncError] = useState("");

  const loadHealth = useCallback(async () => {
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
  }, []);

  const loadWorker = useCallback(async () => {
    try {
      setWorker(await apiRequest<WorkerStatus>("/worker/status"));
    } catch {
      setWorker(null);
    }
  }, []);

  const refreshOps = useCallback(async () => {
    await Promise.all([loadHealth(), loadWorker()]);
  }, [loadHealth, loadWorker]);

  useEffect(() => {
    refreshOps();
    const id = window.setInterval(refreshOps, 4000);
    return () => window.clearInterval(id);
  }, [refreshOps]);

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

  return (
    <div className="app-shell">
      <Sidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        health={health}
        healthError={healthError}
        worker={worker}
        onToggleWorker={toggleWorker}
        activeSync={activeSync}
        syncError={syncError}
        onSync={triggerSync}
        onForceUnlock={forceUnlock}
      />
      <main className="main-panel">
        <SearchView active={activeTab === "search"} />
        <AnalyticsView active={activeTab === "analytics"} onOpsChanged={refreshOps} />
      </main>
    </div>
  );
}
