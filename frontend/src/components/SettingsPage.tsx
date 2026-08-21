import { useState } from "react";
import { DEFAULT_CFG, type Cfg } from "../App";
import type { Health, SyncJob, WorkerStatus } from "../api";
import { Button, Checkbox, Icon, Panel, SettingRow, Slider } from "../ds";
import { formatNumber, relativeTime } from "../format";

const SECTIONS: [string, string][] = [
  ["matching", "Matching"],
  ["model", "Model"],
  ["database", "Database & index"],
  ["worker", "Worker"],
  ["sync", "Drive sync"],
];

export default function SettingsPage({
  cfg,
  setCfg,
  health,
  worker,
  activeSync,
  syncError,
  onToggleWorker,
  onSync,
  onForceUnlock,
}: {
  cfg: Cfg;
  setCfg: (cfg: Cfg) => void;
  health: Health | null;
  worker: WorkerStatus | null;
  activeSync: SyncJob | null;
  syncError: string;
  onToggleWorker: () => void;
  onSync: (prune: boolean) => void;
  onForceUnlock: () => void;
}) {
  const [prune, setPrune] = useState(false);
  const set = (key: keyof Cfg, value: number) => setCfg({ ...cfg, [key]: value });
  const workerRunning = worker ? !worker.suspended : false;
  const syncing = activeSync && ["queued", "running"].includes(activeSync.status);
  const coverage = health?.drive_total
    ? ((health.enrolled_count / health.drive_total) * 100).toFixed(1) + "%"
    : "—";
  const pending =
    health?.drive_total != null ? Math.max(0, health.drive_total - (health.enrolled_count || 0)) : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Configuration</div>
          <h1>Settings</h1>
          <p>
            Thresholds, index health, the worker and Drive sync all live here. Threshold changes apply to
            every search immediately.
          </p>
        </div>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <Button kind="ghost" size="sm" onClick={() => setCfg(DEFAULT_CFG)}>
            Reset to defaults
          </Button>
        </div>
      </div>
      <div className="set-grid">
        <nav className="set-nav">
          {SECTIONS.map(([id, label]) => (
            <a
              key={id}
              href={"#set-" + id}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById("set-" + id)?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              {label}
            </a>
          ))}
        </nav>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-6)" }}>
          <section className="set-section" id="set-matching">
            <Panel title="Matching" meta="Where the line falls between a match, a review and a rejection">
              <SettingRow
                title="Match threshold"
                desc="Similarity at or above this is reported as a confirmed match."
              >
                <Slider
                  value={cfg.match}
                  min={0.2}
                  max={0.95}
                  step={0.01}
                  onChange={(value) => set("match", Math.max(value, cfg.review + 0.01))}
                  format={(value) => value.toFixed(2)}
                />
              </SettingRow>
              <SettingRow
                title="Review threshold"
                desc="Scores between this and the match threshold are queued for a human decision. Must stay below the match threshold."
              >
                <Slider
                  value={cfg.review}
                  min={0.1}
                  max={0.9}
                  step={0.01}
                  onChange={(value) => set("review", Math.min(value, cfg.match - 0.01))}
                  format={(value) => value.toFixed(2)}
                />
              </SettingRow>
              <SettingRow
                title="Candidates returned (Top K)"
                desc="How many ranked candidates each search shows."
              >
                <Slider value={cfg.topK} min={1} max={6} step={1} onChange={(value) => set("topK", value)} />
              </SettingRow>
            </Panel>
          </section>

          <section className="set-section" id="set-model">
            <Panel title="Model" meta="Embedding and detection">
              <SettingRow
                title="Embedding model"
                desc="Configured on the API server (EMBED_MODEL). Changing it there invalidates the index and requires a full re-embed."
              >
                <span className="tag" style={{ fontSize: "var(--text-small)", padding: "6px 14px" }}>
                  {health?.model || "unknown"}
                </span>
              </SettingRow>
            </Panel>
          </section>

          <section className="set-section" id="set-database">
            <Panel title="Database & index" meta="Enrolment photos currently searchable">
              <div className="stats-band">
                <div className="stat-card">
                  <div className="stat-lab">Enrolled</div>
                  <div className="stat-val">{formatNumber(health?.enrolled_count)}</div>
                  <div className="stat-foot">Indexed embeddings</div>
                </div>
                <div className="stat-card">
                  <div className="stat-lab">In Drive</div>
                  <div className="stat-val">
                    {health?.drive_total != null ? formatNumber(health.drive_total) : "—"}
                  </div>
                  <div className="stat-foot">Files in the source folder</div>
                </div>
                <div className="stat-card">
                  <div className="stat-lab">Coverage</div>
                  <div className="stat-val">{coverage}</div>
                  <div className="stat-foot">
                    {pending != null ? `${formatNumber(pending)} files pending` : "Drive total unknown"}
                  </div>
                </div>
              </div>
            </Panel>
          </section>

          <section className="set-section" id="set-worker">
            <Panel title="Worker" meta="Background embedding process">
              <SettingRow
                title="Status"
                desc={
                  worker
                    ? workerRunning
                      ? "Running — picks up queued sync jobs."
                      : "Paused — queued jobs resume when you start it again."
                    : "Worker status unavailable."
                }
              >
                <div className="row" style={{ gap: "var(--s-3)", flexWrap: "nowrap" }}>
                  <span className="row" style={{ gap: 8 }}>
                    <span
                      className={"dot" + (workerRunning ? " live" : "")}
                      style={{ background: workerRunning ? "var(--ok)" : "var(--miva-grey-3)" }}
                    ></span>
                    <b style={{ fontFamily: "var(--font-display)" }}>
                      {worker ? (workerRunning ? "Running" : "Paused") : "Unknown"}
                    </b>
                  </span>
                  <Button
                    kind={workerRunning ? "ghost" : "secondary"}
                    size="sm"
                    disabled={!worker}
                    onClick={onToggleWorker}
                  >
                    {workerRunning ? "Pause worker" : "Start worker"}
                  </Button>
                </div>
              </SettingRow>
              <SettingRow
                title="Force unlock"
                desc="Clears a stale job lock left behind by a crashed worker. Use only when no worker is running."
              >
                <Button kind="ghost" size="sm" iconLeft={<Icon name="shield" size={16} />} onClick={onForceUnlock}>
                  Force unlock
                </Button>
              </SettingRow>
            </Panel>
          </section>

          <section className="set-section" id="set-sync">
            <Panel
              title="Drive sync"
              meta={
                syncing
                  ? `Job ${activeSync?.job_id.slice(0, 8)} ${activeSync?.status}${activeSync?.progress?.total ? ` · ${formatNumber(activeSync.progress.current)} of ${formatNumber(activeSync.progress.total)}` : ""}`
                  : health?.last_sync_finished_at
                    ? `Last sync ${relativeTime(health.last_sync_finished_at)}`
                    : "Never synced"
              }
            >
              <SettingRow
                title="Remove deleted Drive files"
                desc="Drops embeddings whose source file no longer exists in Drive. Irreversible."
              >
                <Checkbox label="Prune on next sync" checked={prune} onChange={setPrune} />
              </SettingRow>
              <SettingRow title="Run now" desc="Starts an incremental sync straight away.">
                <Button
                  kind="primary"
                  size="sm"
                  disabled={!!syncing}
                  iconLeft={<Icon name="arrowRight" size={16} />}
                  onClick={() => onSync(prune)}
                >
                  {syncing ? "Sync running…" : "Sync now"}
                </Button>
              </SettingRow>
              {syncError && <div className="alert">{syncError}</div>}
            </Panel>
          </section>
        </div>
      </div>
    </div>
  );
}
