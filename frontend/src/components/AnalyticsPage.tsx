import { useEffect, useState } from "react";
import { apiRequest, errorMessage, type AnalyticsSummary, type FilePage, type SyncJob } from "../api";
import { Button, Checkbox, Icon, Input, Panel, Select } from "../ds";
import { formatNumber, relativeTime } from "../format";

const outcomeLabels: Record<string, string> = {
  enrolled: "Enrolled",
  unchanged: "Unchanged",
  no_face: "No face detected",
  invalid_image: "Invalid image",
  drive_error: "Drive download error",
  embed_error: "Unexpected embed error",
};
const OUT_TONE: Record<string, string> = {
  enrolled: "match",
  unchanged: "neutral",
  no_face: "review",
};
const outcomeBarColour: Record<string, string> = {
  enrolled: "var(--miva-blue)",
  unchanged: "var(--accent-warm)",
};

// Files with no extension surface as "" in the API; the select shows them
// as "(none)" and we translate back when building the query params.
const NONE_EXT = "(none)";

function outcomeLabel(key: string) {
  return outcomeLabels[key] || key;
}

function OutTag({ outcome }: { outcome: string }) {
  const tone = OUT_TONE[outcome] || "no";
  return tone === "neutral" ? (
    <span className="tag">{outcomeLabel(outcome)}</span>
  ) : (
    <span className={"verdict " + tone}>{outcomeLabel(outcome)}</span>
  );
}

interface FileQuery {
  outcome: string;
  ext: string;
  q: string;
  pageSize: number;
  offset: number;
}

export default function AnalyticsPage({
  activeSync,
  onOpsChanged,
}: {
  activeSync: SyncJob | null;
  onOpsChanged: () => void;
}) {
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [analyticsError, setAnalyticsError] = useState("");
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filePage, setFilePage] = useState<FilePage>({ rows: [], total: 0, limit: 50, offset: 0 });
  const [fileQuery, setFileQuery] = useState<FileQuery>({ outcome: "", ext: "", q: "", pageSize: 50, offset: 0 });
  const [filenameDraft, setFilenameDraft] = useState("");
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [retryMessage, setRetryMessage] = useState("");

  async function loadAnalytics() {
    setAnalyticsLoading(true);
    setAnalyticsError("");
    try {
      setAnalytics(await apiRequest<AnalyticsSummary>("/analytics/summary"));
    } catch (error) {
      setAnalyticsError(errorMessage(error));
    } finally {
      setAnalyticsLoading(false);
    }
  }

  useEffect(() => {
    loadAnalytics();
  }, []);

  // (Re)load the file table whenever the summary refreshes or the query changes.
  useEffect(() => {
    if (!analytics) return;
    let cancelled = false;
    (async () => {
      setFilesLoading(true);
      setSelectedFileIds(new Set());
      setRetryMessage("");
      const params = new URLSearchParams({
        limit: String(fileQuery.pageSize),
        offset: String(fileQuery.offset),
      });
      if (fileQuery.outcome) params.set("outcome", fileQuery.outcome);
      if (fileQuery.ext) params.set("ext", fileQuery.ext === NONE_EXT ? "" : fileQuery.ext);
      if (fileQuery.q) params.set("q", fileQuery.q);
      try {
        const page = await apiRequest<FilePage>(`/analytics/files?${params.toString()}`);
        if (!cancelled) setFilePage(page);
      } catch (error) {
        if (!cancelled) setAnalyticsError(errorMessage(error));
      } finally {
        if (!cancelled) setFilesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [analytics, fileQuery]);

  function applyFilters(patch: Partial<FileQuery> = {}) {
    setFileQuery((query) => ({ ...query, q: filenameDraft.trim(), offset: 0, ...patch }));
  }

  async function retryFiles(fileIds: string[]) {
    if (!fileIds.length) return;
    setRetryMessage("");
    try {
      const body = await apiRequest<{ job_id: string; count?: number }>("/sync/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_ids: fileIds }),
      });
      setRetryMessage(
        `Retry queued for ${body.count || fileIds.length} file(s), job ${String(body.job_id).slice(0, 8)}.`,
      );
      onOpsChanged();
    } catch (error) {
      setRetryMessage(errorMessage(error));
    }
  }

  function toggleSelected(fileId: string) {
    setSelectedFileIds((current) => {
      const next = new Set(current);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  const byOutcome = analytics?.by_outcome || {};
  const totalFiles = analytics?.totals?.file_status_total || 0;
  const enrolledTotal = analytics?.totals?.persons_total || 0;
  const skippedTotal = Object.entries(byOutcome)
    .filter(([key]) => !["enrolled", "unchanged"].includes(key))
    .reduce((sum, [, count]) => sum + Number(count || 0), 0);
  const sortedOutcomes = Object.entries(byOutcome).sort((a, b) => b[1] - a[1]);
  const sortedExtensions = Object.entries(analytics?.by_ext || {}).sort((a, b) => b[1] - a[1]);
  const maxExt = Math.max(1, ...sortedExtensions.map(([, count]) => Number(count || 0)));
  const matrixOutcomes = Object.keys(byOutcome).sort();
  const matrixMap = new Map<string, Record<string, number>>();
  for (const row of analytics?.by_outcome_and_ext || []) {
    if (!matrixMap.has(row.ext)) matrixMap.set(row.ext, {});
    matrixMap.get(row.ext)![row.outcome] = row.count;
  }
  const matrixRows = [...matrixMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const outcomeOptions = Object.keys(byOutcome)
    .sort()
    .map((key) => ({ value: key, label: outcomeLabel(key) }));
  const extOptions = Object.keys(analytics?.by_ext || {})
    .sort()
    .map((ext) => (ext === "" ? NONE_EXT : ext));
  const allOnPage = filePage.rows.length > 0 && filePage.rows.every((row) => selectedFileIds.has(row.drive_file_id));
  const syncing = activeSync && ["queued", "running"].includes(activeSync.status);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Latest sync pass</div>
          <h1>Analytics</h1>
          <p>
            Drive sync outcomes by extension, and every file the last pass touched — retry the ones that
            failed.
          </p>
        </div>
        <div className="row">
          <Button
            kind="ghost"
            size="sm"
            disabled={analyticsLoading}
            iconLeft={<Icon name="arrowRight" size={16} />}
            onClick={loadAnalytics}
          >
            {analyticsLoading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {analyticsError && <div className="alert">{analyticsError}</div>}

      {analytics && (
        <>
          <div className="stats-band">
            <div className="stat-card">
              <div className="stat-lab">Files seen</div>
              <div className="stat-val">{formatNumber(totalFiles)}</div>
              <div className="stat-foot">In the source Drive folder</div>
            </div>
            <div className="stat-card hero">
              <div className="stat-lab">Enrolled</div>
              <div className="stat-val">{formatNumber(enrolledTotal)}</div>
              <div className="stat-foot">Embedded and searchable</div>
            </div>
            <div className="stat-card">
              <div className="stat-lab">Skipped</div>
              <div className="stat-val">{formatNumber(skippedTotal)}</div>
              <div className="stat-foot">No face, invalid or errored</div>
            </div>
            <div className="stat-card">
              <div className="stat-lab">Active job</div>
              <div className="stat-val" style={{ fontSize: "var(--text-h3)" }}>
                {activeSync ? activeSync.job_id.slice(0, 8) : "—"}
              </div>
              <div className="stat-foot">
                {syncing && activeSync?.progress?.total
                  ? `${formatNumber(activeSync.progress.current)} of ${formatNumber(activeSync.progress.total)} embedded`
                  : syncing
                    ? activeSync?.status
                    : "No sync running"}
              </div>
            </div>
          </div>

          <div
            className="an-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr)",
              gap: "var(--s-6)",
              alignItems: "start",
            }}
          >
            <Panel title="By outcome" meta="Latest sync pass" pad={false}>
              <div style={{ padding: "var(--s-4) var(--s-2)" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Outcome</th>
                      <th style={{ textAlign: "right" }}>Count</th>
                      <th style={{ width: "46%" }}>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedOutcomes.map(([key, count]) => {
                      const share = totalFiles ? Number(count) / totalFiles : 0;
                      return (
                        <tr key={key}>
                          <td>
                            <OutTag outcome={key} />
                          </td>
                          <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                            {formatNumber(count)}
                          </td>
                          <td>
                            <div className="row" style={{ gap: "var(--s-3)", flexWrap: "nowrap" }}>
                              <div className="score-track" style={{ flex: 1 }}>
                                <div
                                  className="score-fill"
                                  style={{
                                    width: Math.max(1, share * 100) + "%",
                                    background: outcomeBarColour[key] || "var(--miva-red)",
                                  }}
                                ></div>
                              </div>
                              <span className="muted" style={{ minWidth: 44, textAlign: "right" }}>
                                {(share * 100).toFixed(1)}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
            <Panel title="By file extension" meta={`${sortedExtensions.length} types seen`} pad={false}>
              <div className="table-scroll" style={{ padding: "var(--s-4) var(--s-2)", maxHeight: 320 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Extension</th>
                      <th style={{ width: "45%" }}>Share</th>
                      <th style={{ textAlign: "right" }}>Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedExtensions.map(([ext, count]) => (
                      <tr key={ext || NONE_EXT}>
                        <td>{ext || NONE_EXT}</td>
                        <td>
                          <div className="score-track">
                            <div
                              className="score-fill"
                              style={{
                                width: Math.max(1, (Number(count) / maxExt) * 100) + "%",
                                background: "var(--miva-blue)",
                              }}
                            ></div>
                          </div>
                        </td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {formatNumber(count)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          <Panel title="Outcome by extension" meta="Counts per extension across every outcome" pad={false}>
            <div className="table-scroll" style={{ padding: "var(--s-4) var(--s-2)", maxHeight: 320 }}>
              <table>
                <thead>
                  <tr>
                    <th>Extension</th>
                    {matrixOutcomes.map((outcome) => (
                      <th key={outcome} style={{ textAlign: "right" }}>
                        {outcomeLabel(outcome)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrixRows.map(([ext, counts]) => (
                    <tr key={ext || NONE_EXT}>
                      <td>{ext || NONE_EXT}</td>
                      {matrixOutcomes.map((outcome) => {
                        const value = counts[outcome] || 0;
                        const failure = value > 0 && !["enrolled", "unchanged"].includes(outcome);
                        return (
                          <td
                            key={outcome}
                            style={{
                              textAlign: "right",
                              fontVariantNumeric: "tabular-nums",
                              color: failure ? "var(--no)" : undefined,
                              fontWeight: failure ? 700 : 400,
                            }}
                          >
                            {formatNumber(value)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel
            title="Browse files"
            meta={
              filePage.total
                ? `${formatNumber(filePage.total)} matches · showing ${formatNumber(filePage.offset + 1)}–${formatNumber(Math.min(filePage.offset + filePage.limit, filePage.total))}`
                : "0 matches"
            }
            pad={false}
            action={
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <Button
                  kind="ghost"
                  size="sm"
                  disabled={!selectedFileIds.size}
                  onClick={() => retryFiles([...selectedFileIds])}
                >
                  Retry selected ({selectedFileIds.size})
                </Button>
                <Button
                  kind="secondary"
                  size="sm"
                  disabled={!filePage.rows.length}
                  onClick={() => retryFiles(filePage.rows.map((row) => row.drive_file_id))}
                >
                  Retry page
                </Button>
              </div>
            }
          >
            <div className="card-pad" style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
              <div className="filter-grid">
                <Select
                  label="Outcome"
                  options={outcomeOptions}
                  placeholder="Any outcome"
                  value={fileQuery.outcome}
                  onChange={(value) => applyFilters({ outcome: value })}
                />
                <Select
                  label="Extension"
                  options={extOptions}
                  placeholder="Any extension"
                  value={fileQuery.ext}
                  onChange={(value) => applyFilters({ ext: value })}
                />
                <Input
                  label="Filename contains"
                  value={filenameDraft}
                  placeholder="e.g. PORTRAIT"
                  onChange={setFilenameDraft}
                  onEnter={() => applyFilters()}
                />
                <Select
                  label="Per page"
                  options={["25", "50", "100", "200"]}
                  value={String(fileQuery.pageSize)}
                  onChange={(value) => applyFilters({ pageSize: Number(value) })}
                />
              </div>
              {retryMessage && <div className="muted">{retryMessage}</div>}
              <div className="table-scroll" style={{ maxHeight: 480 }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 34 }}>
                        <input
                          type="checkbox"
                          checked={allOnPage}
                          onChange={(e) =>
                            setSelectedFileIds(
                              e.target.checked ? new Set(filePage.rows.map((row) => row.drive_file_id)) : new Set(),
                            )
                          }
                          aria-label="Select all"
                        />
                      </th>
                      <th>Name</th>
                      <th>Ext</th>
                      <th>Outcome</th>
                      <th>Reason</th>
                      <th style={{ textAlign: "right" }}>Rotation</th>
                      <th style={{ textAlign: "right" }}>Detection</th>
                      <th style={{ textAlign: "right" }}>Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filesLoading && (
                      <tr>
                        <td colSpan={8}>Loading files…</td>
                      </tr>
                    )}
                    {filePage.rows.map((row) => (
                      <tr key={row.drive_file_id}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedFileIds.has(row.drive_file_id)}
                            onChange={() => toggleSelected(row.drive_file_id)}
                            aria-label={"Select " + row.drive_file_name}
                          />
                        </td>
                        <td
                          style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          title={row.drive_file_name}
                        >
                          {row.drive_file_name}
                        </td>
                        <td>{row.ext || ""}</td>
                        <td>
                          <OutTag outcome={row.outcome} />
                        </td>
                        <td style={{ maxWidth: 260, overflowWrap: "anywhere" }}>{row.reason || ""}</td>
                        <td style={{ textAlign: "right" }}>{row.rotation == null ? "—" : row.rotation + "°"}</td>
                        <td style={{ textAlign: "right" }}>
                          <span className="score-num">
                            {typeof row.det_score === "number" ? row.det_score.toFixed(3) : "—"}
                          </span>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          {row.last_seen_at ? relativeTime(row.last_seen_at) : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="muted">
                  Page {Math.floor(fileQuery.offset / fileQuery.pageSize) + 1} of{" "}
                  {formatNumber(Math.max(1, Math.ceil(filePage.total / fileQuery.pageSize)))}
                </div>
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <Button
                    kind="ghost"
                    size="sm"
                    disabled={fileQuery.offset === 0}
                    onClick={() =>
                      setFileQuery((query) => ({ ...query, offset: Math.max(0, query.offset - query.pageSize) }))
                    }
                  >
                    Previous
                  </Button>
                  <Button
                    kind="ghost"
                    size="sm"
                    disabled={fileQuery.offset + fileQuery.pageSize >= filePage.total}
                    iconRight={<Icon name="chevronRight" size={16} />}
                    onClick={() => setFileQuery((query) => ({ ...query, offset: query.offset + query.pageSize }))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
