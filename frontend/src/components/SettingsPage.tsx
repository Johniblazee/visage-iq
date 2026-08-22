import { useState } from "react";
import { DEFAULT_CFG, type Cfg } from "../App";
import type { Health, SyncJob, WorkerStatus } from "../api";
import { Button, Checkbox, Icon, Panel, SettingRow, Slider } from "../ds";
import { formatNumber, relativeTime } from "../format";

const SECTIONS: [string, string][] = [
  ["appearance", "Appearance"],
  ["matching", "Matching"],
  ["model", "Model"],
  ["database", "Database & index"],
  ["worker", "Worker"],
  ["sync", "Drive sync"],
];

// Swatch pairs are (nav, page) colors — static previews, not live tokens.
const LIGHT_PALETTES: [string, string, [string, string]][] = [
  ["cool", "Cool grey", ["#0F172A", "#F8FAFC"]],
  ["warm", "Warm paper", ["#09314F", "#F8F5F2"]],
  ["sand", "Sand", ["#85705A", "#F1EAE1"]],
];
const DARK_PALETTES: [string, string, [string, string]][] = [
  ["slate", "Slate", ["#0B1120", "#1B2537"]],
  ["ink", "Ink", ["#050914", "#0B1120"]],
  ["navy", "Heritage navy", ["#02223A", "#0C2B44"]],
];

function PaletteCard({
  name,
  swatch,
  selected,
  onPick,
}: {
  name: string;
  swatch: [string, string];
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button className="pal" aria-pressed={selected} onClick={onPick}>
      <span className="pal-swatch">
        <span style={{ background: swatch[0] }}></span>
        <span style={{ background: swatch[1] }}></span>
      </span>
      <span className="pal-name">{name}</span>
    </button>
  );
}

export default function SettingsPage({
  cfg,
  setCfg,
  theme,
  setTheme,
  lightPalette,
  setLightPalette,
  darkPalette,
  setDarkPalette,
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
  theme: string;
  setTheme: (theme: string) => void;
  lightPalette: string;
  setLightPalette: (palette: string) => void;
  darkPalette: string;
  setDarkPalette: (palette: string) => void;
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
  // drive_total: null = unknown (no sync yet), 0 = folder listed but empty.
  const driveEmpty = health?.drive_total === 0;
  const coverage = health?.drive_total
    ? ((health.enrolled_count / health.drive_total) * 100).toFixed(1) + "%"
    : "—";
  const pending =
    health?.drive_total != null ? Math.max(0, health.drive_total - (health.enrolled_count || 0)) : null;
  const coverageFoot = driveEmpty
    ? "Drive folder is empty"
    : pending != null
      ? `${formatNumber(pending)} files pending`
      : "Drive total unknown";

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
          <section className="set-section" id="set-appearance">
            <Panel title="Appearance" meta="Applies to this browser only">
              <SettingRow title="Mode" desc="The sidebar toggle switches between your chosen light and dark palettes.">
                <div className="row">
                  <button className="chip" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>
                    Light
                  </button>
                  <button className="chip" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>
                    Dark
                  </button>
                </div>
              </SettingRow>
              <SettingRow
                title="Light palette"
                desc="Cool grey is the neutral default. Warm paper is the original Miva cream; Sand leans on Wisdom Gold."
              >
                <div className="pal-row">
                  {LIGHT_PALETTES.map(([key, name, swatch]) => (
                    <PaletteCard
                      key={key}
                      name={name}
                      swatch={swatch}
                      selected={lightPalette === key}
                      onPick={() => {
                        setLightPalette(key);
                        setTheme("light");
                      }}
                    />
                  ))}
                </div>
              </SettingRow>
              <SettingRow
                title="Dark palette"
                desc="Slate is the soft blue-grey default. Ink is near-black for low-light rooms; Heritage navy keeps the brand blue."
              >
                <div className="pal-row">
                  {DARK_PALETTES.map(([key, name, swatch]) => (
                    <PaletteCard
                      key={key}
                      name={name}
                      swatch={swatch}
                      selected={darkPalette === key}
                      onPick={() => {
                        setDarkPalette(key);
                        setTheme("dark");
                      }}
                    />
                  ))}
                </div>
              </SettingRow>
            </Panel>
          </section>

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
                  format={(value) => (value * 100).toFixed(0) + "%"}
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
                  format={(value) => (value * 100).toFixed(0) + "%"}
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
                  <div className="stat-foot">{coverageFoot}</div>
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
              {syncing && (
                <div style={{ padding: "var(--s-5) 0", borderTop: "1px solid var(--line)" }}>
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, color: "var(--txt-1)" }}>
                      Sync job {activeSync?.job_id.slice(0, 8)}
                      {activeSync?.progress?.phase ? ` · ${activeSync.progress.phase}` : ""}
                    </span>
                    <span className="muted">
                      {activeSync?.progress?.total
                        ? `${formatNumber(activeSync.progress.current)} of ${formatNumber(activeSync.progress.total)}`
                        : activeSync?.progress?.listed
                          ? `${formatNumber(activeSync.progress.listed)} files listed`
                          : activeSync?.status}
                    </span>
                  </div>
                  <div className="score-track">
                    <div
                      className="score-fill"
                      style={{
                        width: activeSync?.progress?.total
                          ? Math.min(100, ((activeSync.progress.current || 0) / activeSync.progress.total) * 100) + "%"
                          : "4%",
                        background: "var(--bar)",
                      }}
                    ></div>
                  </div>
                </div>
              )}
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
                  iconLeft={<Icon name="refresh" size={16} />}
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
