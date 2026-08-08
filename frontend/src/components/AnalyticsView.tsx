import { AlertTriangle, ChevronLeft, ChevronRight, Image as ImageIcon, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { apiRequest, errorMessage, type AnalyticsSummary, type FilePage } from "../api";
import { formatNumber, relativeTime } from "../format";

const outcomeLabels: Record<string, string> = {
  enrolled: "Enrolled",
  unchanged: "Unchanged",
  no_face: "No face detected",
  invalid_image: "Invalid image",
  drive_error: "Drive download error",
  embed_error: "Unexpected embed error",
};
const outcomeColors: Record<string, string> = {
  enrolled: "#16a34a",
  unchanged: "#2563eb",
  no_face: "#ca8a04",
  invalid_image: "#ea580c",
  drive_error: "#dc2626",
  embed_error: "#dc2626",
};

// One object describing the current /analytics/files query. Committing a new
// object (even with identical fields) re-runs the fetch effect below.
interface FileQuery {
  outcome: string;
  ext: string;
  q: string;
  pageSize: number;
  offset: number;
}

interface AnalyticsViewProps {
  active: boolean;
  onOpsChanged: () => void;
}

export default function AnalyticsView({ active, onOpsChanged }: AnalyticsViewProps) {
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [analyticsError, setAnalyticsError] = useState("");
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filePage, setFilePage] = useState<FilePage>({ rows: [], total: 0, limit: 50, offset: 0 });
  const [fileQuery, setFileQuery] = useState<FileQuery>({
    outcome: "(any)",
    ext: "(any)",
    q: "",
    pageSize: 50,
    offset: 0,
  });
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

  // Load the summary the first time this tab is opened.
  useEffect(() => {
    if (active && !analytics && !analyticsLoading) loadAnalytics();
  }, [active]);

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
      if (fileQuery.outcome !== "(any)") params.set("outcome", fileQuery.outcome);
      if (fileQuery.ext !== "(any)") params.set("ext", fileQuery.ext);
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

  function applyFilters() {
    setFileQuery((query) => ({ ...query, q: filenameDraft.trim(), offset: 0 }));
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

  function toggleSelected(fileId: string, checked: boolean) {
    setSelectedFileIds((current) => {
      const next = new Set(current);
      if (checked) next.add(fileId);
      else next.delete(fileId);
      return next;
    });
  }

  const byOutcome = analytics?.by_outcome || {};
  const totalFiles = analytics?.totals?.file_status_total || 0;
  const skippedTotal = Object.entries(byOutcome)
    .filter(([key]) => !["enrolled", "unchanged"].includes(key))
    .reduce((sum, [, count]) => sum + Number(count || 0), 0);
  const outcomeOptions = ["(any)", ...Object.keys(byOutcome).sort()];
  const extOptions = ["(any)", ...Object.keys(analytics?.by_ext || {}).sort()];
  const sortedOutcomes = Object.entries(byOutcome).sort((a, b) => b[1] - a[1]);
  const sortedExtensions = Object.entries(analytics?.by_ext || {}).sort((a, b) => b[1] - a[1]);
  const matrixOutcomes = Object.keys(byOutcome).sort();
  const matrixMap = new Map<string, { ext: string; counts: Record<string, number> }>();
  for (const row of analytics?.by_outcome_and_ext || []) {
    if (!matrixMap.has(row.ext)) matrixMap.set(row.ext, { ext: row.ext, counts: {} });
    matrixMap.get(row.ext)!.counts[row.outcome] = row.count;
  }
  const matrixRows = Array.from(matrixMap.values()).sort((a, b) =>
    String(a.ext).localeCompare(String(b.ext)),
  );
  const currentRange = filePage.total
    ? `${filePage.total.toLocaleString()} matches. Showing ${(filePage.offset + 1).toLocaleString()}-${Math.min(filePage.offset + filePage.limit, filePage.total).toLocaleString()}.`
    : "0 matches";

  function outcomeLabel(key: string) {
    return outcomeLabels[key] || key || "";
  }
  function outcomePercent(count: number) {
    return totalFiles ? (Number(count) / totalFiles) * 100 : 0;
  }

  return (
    <section className="view" style={{ display: active ? undefined : "none" }}>
      <header className="view-header">
        <div>
          <h2>Sync Analytics</h2>
          <p>Inspect the latest Drive sync outcomes and retry failed rows.</p>
        </div>
        <button
          className="button secondary"
          type="button"
          disabled={analyticsLoading}
          onClick={loadAnalytics}
        >
          <RefreshCw size={16} />
          <span>{analyticsLoading ? "Refreshing..." : "Refresh"}</span>
        </button>
      </header>
      {analyticsError && (
        <p className="callout danger">
          <AlertTriangle size={17} /> {analyticsError}
        </p>
      )}
      {analytics ? (
        <div className="analytics-layout">
          <div className="stat-row">
            <div>
              <span>Files seen</span>
              <strong>{formatNumber(analytics.totals?.file_status_total)}</strong>
            </div>
            <div>
              <span>Enrolled</span>
              <strong>{formatNumber(analytics.totals?.persons_total)}</strong>
            </div>
            <div>
              <span>Skipped</span>
              <strong>{formatNumber(skippedTotal)}</strong>
            </div>
          </div>
          <div className="split-grid">
            <section>
              <h3>By outcome</h3>
              {sortedOutcomes.map(([key, count]) => (
                <div key={key} className="bar-row">
                  <div>
                    <span>{outcomeLabel(key)}</span>
                    <strong>{formatNumber(count)}</strong>
                    <em>{outcomePercent(count).toFixed(1)}%</em>
                  </div>
                  <div className="score-bar">
                    <span
                      style={{
                        width: `${outcomePercent(count)}%`,
                        background: outcomeColors[key] || "#64748b",
                      }}
                    ></span>
                  </div>
                </div>
              ))}
            </section>
            <section>
              <h3>By file extension</h3>
              <table>
                <thead>
                  <tr>
                    <th>Extension</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedExtensions.map(([ext, count]) => (
                    <tr key={ext}>
                      <td>{ext || "(none)"}</td>
                      <td>{formatNumber(count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
          <section>
            <h3>Outcome by extension</h3>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Extension</th>
                    {matrixOutcomes.map((outcome) => (
                      <th key={outcome}>{outcomeLabel(outcome)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrixRows.map((row) => (
                    <tr key={row.ext}>
                      <td>{row.ext || "(none)"}</td>
                      {matrixOutcomes.map((outcome) => (
                        <td key={outcome}>{formatNumber(row.counts[outcome])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <div className="browse-head">
              <h3>Browse files</h3>
              <span>{currentRange}</span>
            </div>
            <div className="filters">
              <label>
                <span>Outcome</span>
                <select
                  value={fileQuery.outcome}
                  onChange={(event) =>
                    setFileQuery((query) => ({ ...query, outcome: event.target.value, offset: 0 }))
                  }
                >
                  {outcomeOptions.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Extension</span>
                <select
                  value={fileQuery.ext}
                  onChange={(event) =>
                    setFileQuery((query) => ({ ...query, ext: event.target.value, offset: 0 }))
                  }
                >
                  {extOptions.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Filename contains</span>
                <input
                  type="search"
                  value={filenameDraft}
                  onChange={(event) => setFilenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") applyFilters();
                  }}
                />
              </label>
              <label>
                <span>Per page</span>
                <select
                  value={fileQuery.pageSize}
                  onChange={(event) =>
                    setFileQuery((query) => ({
                      ...query,
                      pageSize: Number(event.target.value),
                      offset: 0,
                    }))
                  }
                >
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                  <option value={500}>500</option>
                </select>
              </label>
              <button className="button secondary" type="button" onClick={applyFilters}>
                Apply
              </button>
            </div>
            <div className="retry-row">
              <button
                className="button secondary"
                type="button"
                disabled={!selectedFileIds.size}
                onClick={() => retryFiles([...selectedFileIds])}
              >
                <RefreshCw size={16} />
                <span>Retry selected ({selectedFileIds.size})</span>
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={!filePage.rows.length}
                onClick={() => retryFiles(filePage.rows.map((row) => row.drive_file_id))}
              >
                <RefreshCw size={16} />
                <span>Retry page ({filePage.rows.length})</span>
              </button>
              {retryMessage && <span className="muted">{retryMessage}</span>}
            </div>
            <div className="table-scroll">
              <table className="files-table">
                <thead>
                  <tr>
                    <th></th>
                    <th>Name</th>
                    <th>Ext</th>
                    <th>Outcome</th>
                    <th>Reason</th>
                    <th>Rotation</th>
                    <th>Detection</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {filesLoading && (
                    <tr>
                      <td colSpan={8}>Loading files...</td>
                    </tr>
                  )}
                  {filePage.rows.map((row) => (
                    <tr key={row.drive_file_id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedFileIds.has(row.drive_file_id)}
                          onChange={(event) => toggleSelected(row.drive_file_id, event.target.checked)}
                        />
                      </td>
                      <td>{row.drive_file_name}</td>
                      <td>{row.ext || ""}</td>
                      <td>{outcomeLabel(row.outcome)}</td>
                      <td>{row.reason || ""}</td>
                      <td>{row.rotation ?? ""}</td>
                      <td>{typeof row.det_score === "number" ? row.det_score.toFixed(3) : ""}</td>
                      <td>{row.last_seen_at ? relativeTime(row.last_seen_at) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <button
                className="button secondary"
                type="button"
                disabled={fileQuery.offset === 0}
                onClick={() =>
                  setFileQuery((query) => ({
                    ...query,
                    offset: Math.max(0, query.offset - query.pageSize),
                  }))
                }
              >
                <ChevronLeft size={16} />
                <span>Previous</span>
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={fileQuery.offset + fileQuery.pageSize >= filePage.total}
                onClick={() =>
                  setFileQuery((query) => ({ ...query, offset: query.offset + query.pageSize }))
                }
              >
                <span>Next</span>
                <ChevronRight size={16} />
              </button>
            </div>
          </section>
        </div>
      ) : (
        !analyticsLoading && (
          <p className="callout">
            <ImageIcon size={17} /> No sync analytics loaded yet.
          </p>
        )
      )}
    </section>
  );
}
