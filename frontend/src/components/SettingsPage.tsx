import { useEffect, useState } from "react";
import { DEFAULT_CFG, type Cfg } from "../App";
import {
  apiRequest,
  errorMessage,
  type AppConfig,
  type AuditRow,
  type Health,
  type SyncJob,
  type WorkerStatus,
} from "../api";
import { Button, Checkbox, Icon, Panel, SettingRow, Slider, toast } from "../ds";
import { cosinePct, formatNumber, pctCosine, relativeTime } from "../format";

const SECTIONS: [string, string][] = [
  ["appearance", "Appearance"],
  ["matching", "Matching"],
  ["model", "Model"],
  ["database", "Database & index"],
  ["worker", "Worker"],
  ["sync", "Drive sync"],
  ["audit", "Audit"],
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
  config,
  model,
  setModel,
  theme,
  setTheme,
  lightPalette,
  setLightPalette,
  darkPalette,
  setDarkPalette,
  health,
  worker,
  activeSync,
  onToggleWorker,
  onSync,
  onForceUnlock,
}: {
  cfg: Cfg;
  setCfg: (cfg: Cfg) => void;
  config: AppConfig | null;
  model: string;
  setModel: (model: string) => void;
  theme: string;
  setTheme: (theme: string) => void;
  lightPalette: string;
  setLightPalette: (palette: string) => void;
  darkPalette: string;
  setDarkPalette: (palette: string) => void;
  health: Health | null;
  worker: WorkerStatus | null;
  activeSync: SyncJob | null;
  onToggleWorker: () => void;
  onSync: (prune: boolean) => void;
  onForceUnlock: () => void;
}) {
  const [prune, setPrune] = useState(false);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [auditError, setAuditError] = useState("");
  useEffect(() => {
    apiRequest<{ rows: AuditRow[] }>("/audit?limit=50")
      .then((d) => {
        setAuditRows(d.rows);
        setAuditError("");
      })
      .catch((e) => setAuditError(errorMessage(e)));
  }, []);
  const set = (key: keyof Cfg, value: number) => setCfg({ ...cfg, [key]: value });
  // Knobs live on the display scale; dragging one past the other pushes it along.
  const matchPct = Math.round(cosinePct(cfg.match));
  const reviewPct = Math.round(cosinePct(cfg.review));
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
                  value={matchPct}
                  min={1}
                  max={99}
                  step={1}
                  onChange={(pct) =>
                    setCfg({ ...cfg, match: pctCosine(pct), ...(pct <= reviewPct && { review: pctCosine(pct - 1) }) })
                  }
                  format={(pct) => pct + "%"}
                />
              </SettingRow>
              <SettingRow
                title="Review threshold"
                desc="Scores between this and the match threshold are queued for a human decision. Dragging past the match knob moves it too."
              >
                <Slider
                  value={reviewPct}
                  min={0}
                  max={98}
                  step={1}
                  onChange={(pct) =>
                    setCfg({ ...cfg, review: pctCosine(pct), ...(pct >= matchPct && { match: pctCosine(pct + 1) }) })
                  }
                  format={(pct) => pct + "%"}
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
                title="Search model"
                desc="Which embedding set your searches run against. Compare models are enrolled separately (embeddings from different packs are incompatible), so each needs its own index — add packs via COMPARE_MODELS on the API server."
              >
                {config && config.models.length > 1 ? (
                  <select
                    className="side-select"
                    style={{ color: "var(--txt-1)", background: "var(--surface-1)", borderColor: "var(--line)", maxWidth: 320 }}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {config.models.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                        {m.primary ? " (primary)" : ""} · {formatNumber(m.enrolled_count)} enrolled
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="tag" style={{ fontSize: "var(--text-small)", padding: "6px 14px" }}>
                    {health?.model || "unknown"}
                  </span>
                )}
              </SettingRow>
              {(config?.models || [])
                .filter((m) => !m.primary)
                .map((m) => {
                  const primaryCount =
                    config?.models.find((entry) => entry.primary)?.enrolled_count ?? 0;
                  const missing = Math.max(0, primaryCount - m.enrolled_count);
                  return (
                    <SettingRow
                      key={m.name}
                      title={`Backfill ${m.name}`}
                      desc={
                        missing > 0
                          ? `${formatNumber(missing)} enrolled photos have no ${m.name} embedding yet. Backfill embeds them without touching the primary index.`
                          : `Fully enrolled — regular Drive syncs keep it current.`
                      }
                    >
                      <Button
                        kind="secondary"
                        size="sm"
                        disabled={missing === 0}
                        iconLeft={<Icon name="refresh" size={16} />}
                        onClick={() => {
                          apiRequest<{ job_id: string }>(
                            `/models/backfill?model=${encodeURIComponent(m.name)}`,
                            { method: "POST" },
                          )
                            .then((body) =>
                              toast("ok", "Backfill started",
                                `Job ${body.job_id.slice(0, 8)} — progress shows in the topbar.`),
                            )
                            .catch((e) => toast("error", "Couldn't start the backfill", errorMessage(e)));
                        }}
                      >
                        Backfill now
                      </Button>
                    </SettingRow>
                  );
                })}
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
              <SettingRow
                title="Student directory"
                desc="Re-reads the admissions sheet now. Also runs automatically after every Drive photo sync."
              >
                <Button
                  kind="secondary"
                  size="sm"
                  iconLeft={<Icon name="refresh" size={16} />}
                  onClick={() => {
                    apiRequest<{ job_id: string }>("/students/sync", { method: "POST" })
                      .then((body) =>
                        toast("ok", "Student sync started",
                          `Job ${body.job_id.slice(0, 8)} — the Students page shows the result when it finishes.`),
                      )
                      .catch((e) => toast("error", "Couldn't start the student sync", errorMessage(e)));
                  }}
                >
                  Sync students now
                </Button>
              </SettingRow>
            </Panel>
          </section>

          <section className="set-section" id="set-audit">
            <Panel title="Audit" meta="Most recent 50 events — every search, view and control action" pad={false}>
              <div className="table-scroll" style={{ maxHeight: 380 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Actor</th>
                      <th>Action</th>
                      <th>Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditRows.map((row) => (
                      <tr key={row.id}>
                        <td style={{ whiteSpace: "nowrap" }}>{row.ts ? relativeTime(row.ts) : ""}</td>
                        <td>{row.actor}</td>
                        <td>
                          <span className="tag">{row.action}</span>
                        </td>
                        <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {row.target || ""}
                        </td>
                      </tr>
                    ))}
                    {auditRows.length === 0 && (
                      <tr>
                        <td colSpan={4} className="muted">
                          {auditError ? `Couldn't load the audit log: ${auditError}` : "No events yet."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>
          </section>
        </div>
      </div>
    </div>
  );
}
