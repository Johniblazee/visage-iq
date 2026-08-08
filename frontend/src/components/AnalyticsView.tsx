import { AlertTriangle, ChevronLeft, ChevronRight, Image as ImageIcon, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

// Files with no extension surface as "" in the API; the select shows them
// as "(none)" and we translate back when building the query params.
const NONE_EXT = "(none)";

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
      if (fileQuery.ext !== "(any)") params.set("ext", fileQuery.ext === NONE_EXT ? "" : fileQuery.ext);
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
  const extOptions = [
    "(any)",
    ...Object.keys(analytics?.by_ext || {})
      .sort()
      .map((ext) => (ext === "" ? NONE_EXT : ext)),
  ];
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
    <section className="grid gap-5" style={{ display: active ? undefined : "none" }}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Sync Analytics</h2>
          <p className="text-sm text-muted-foreground">
            Inspect the latest Drive sync outcomes and retry failed rows.
          </p>
        </div>
        <Button variant="outline" disabled={analyticsLoading} onClick={loadAnalytics}>
          <RefreshCw />
          <span>{analyticsLoading ? "Refreshing..." : "Refresh"}</span>
        </Button>
      </header>

      {analyticsError && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{analyticsError}</AlertDescription>
        </Alert>
      )}

      {analytics ? (
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Card size="sm" className="gap-1 p-4">
              <span className="text-xs text-muted-foreground">Files seen</span>
              <strong className="text-2xl">{formatNumber(analytics.totals?.file_status_total)}</strong>
            </Card>
            <Card size="sm" className="gap-1 p-4">
              <span className="text-xs text-muted-foreground">Enrolled</span>
              <strong className="text-2xl">{formatNumber(analytics.totals?.persons_total)}</strong>
            </Card>
            <Card size="sm" className="gap-1 p-4">
              <span className="text-xs text-muted-foreground">Skipped</span>
              <strong className="text-2xl">{formatNumber(skippedTotal)}</strong>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>By outcome</CardTitle>
              </CardHeader>
              <CardContent>
                <Table containerClassName="max-h-80 overflow-y-auto">
                  <TableHeader className="sticky top-0 z-10 bg-card">
                    <TableRow>
                      <TableHead>Outcome</TableHead>
                      <TableHead className="text-right">Count</TableHead>
                      <TableHead className="w-1/2">Share</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedOutcomes.map(([key, count]) => (
                      <TableRow key={key}>
                        <TableCell>{outcomeLabel(key)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(count)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-full max-w-44 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${outcomePercent(count)}%`,
                                  background: outcomeColors[key] || "#64748b",
                                }}
                              />
                            </div>
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {outcomePercent(count).toFixed(1)}%
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>By file extension</CardTitle>
              </CardHeader>
              <CardContent>
                <Table containerClassName="max-h-80 overflow-y-auto">
                  <TableHeader className="sticky top-0 z-10 bg-card">
                    <TableRow>
                      <TableHead>Extension</TableHead>
                      <TableHead className="text-right">Count</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedExtensions.map(([ext, count]) => (
                      <TableRow key={ext}>
                        <TableCell>{ext || "(none)"}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(count)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Outcome by extension</CardTitle>
            </CardHeader>
            <CardContent>
              <Table containerClassName="max-h-96 overflow-y-auto">
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead>Extension</TableHead>
                    {matrixOutcomes.map((outcome) => (
                      <TableHead key={outcome}>{outcomeLabel(outcome)}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matrixRows.map((row) => (
                    <TableRow key={row.ext}>
                      <TableCell>{row.ext || "(none)"}</TableCell>
                      {matrixOutcomes.map((outcome) => (
                        <TableCell key={outcome}>{formatNumber(row.counts[outcome])}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Browse files</CardTitle>
              <CardAction className="text-sm text-muted-foreground">{currentRange}</CardAction>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="flex flex-wrap items-end gap-2.5">
                <div className="grid gap-1.5">
                  <Label className="text-xs text-muted-foreground">Outcome</Label>
                  <Select
                    value={fileQuery.outcome}
                    onValueChange={(value) =>
                      setFileQuery((query) => ({ ...query, outcome: String(value), offset: 0 }))
                    }
                  >
                    <SelectTrigger className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {outcomeOptions.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs text-muted-foreground">Extension</Label>
                  <Select
                    value={fileQuery.ext}
                    onValueChange={(value) =>
                      setFileQuery((query) => ({ ...query, ext: String(value), offset: 0 }))
                    }
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {extOptions.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs text-muted-foreground">Filename contains</Label>
                  <Input
                    type="search"
                    className="w-52"
                    value={filenameDraft}
                    onChange={(event) => setFilenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") applyFilters();
                    }}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs text-muted-foreground">Per page</Label>
                  <Select
                    value={String(fileQuery.pageSize)}
                    onValueChange={(value) =>
                      setFileQuery((query) => ({ ...query, pageSize: Number(value), offset: 0 }))
                    }
                  >
                    <SelectTrigger className="w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["50", "100", "200", "500"].map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button variant="outline" onClick={applyFilters}>
                  Apply
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <Button
                  variant="outline"
                  disabled={!selectedFileIds.size}
                  onClick={() => retryFiles([...selectedFileIds])}
                >
                  <RefreshCw />
                  <span>Retry selected ({selectedFileIds.size})</span>
                </Button>
                <Button
                  variant="outline"
                  disabled={!filePage.rows.length}
                  onClick={() => retryFiles(filePage.rows.map((row) => row.drive_file_id))}
                >
                  <RefreshCw />
                  <span>Retry page ({filePage.rows.length})</span>
                </Button>
                {retryMessage && <span className="text-sm text-muted-foreground">{retryMessage}</span>}
              </div>

              <Table containerClassName="max-h-[32rem] overflow-y-auto">
                  <TableHeader className="sticky top-0 z-10 bg-card">
                    <TableRow>
                      <TableHead></TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Ext</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Rotation</TableHead>
                      <TableHead>Detection</TableHead>
                      <TableHead>Last seen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filesLoading && (
                      <TableRow>
                        <TableCell colSpan={8}>Loading files...</TableCell>
                      </TableRow>
                    )}
                    {filePage.rows.map((row) => (
                      <TableRow key={row.drive_file_id}>
                        <TableCell>
                          <Checkbox
                            checked={selectedFileIds.has(row.drive_file_id)}
                            onCheckedChange={(checked) =>
                              toggleSelected(row.drive_file_id, checked === true)
                            }
                          />
                        </TableCell>
                        <TableCell className="min-w-60 break-words whitespace-normal">
                          {row.drive_file_name}
                        </TableCell>
                        <TableCell>{row.ext || ""}</TableCell>
                        <TableCell>{outcomeLabel(row.outcome)}</TableCell>
                        <TableCell className="whitespace-normal">{row.reason || ""}</TableCell>
                        <TableCell>{row.rotation ?? ""}</TableCell>
                        <TableCell>
                          {typeof row.det_score === "number" ? row.det_score.toFixed(3) : ""}
                        </TableCell>
                        <TableCell>{row.last_seen_at ? relativeTime(row.last_seen_at) : ""}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
              </Table>

              <div className="flex flex-wrap gap-2.5">
                <Button
                  variant="outline"
                  disabled={fileQuery.offset === 0}
                  onClick={() =>
                    setFileQuery((query) => ({
                      ...query,
                      offset: Math.max(0, query.offset - query.pageSize),
                    }))
                  }
                >
                  <ChevronLeft />
                  <span>Previous</span>
                </Button>
                <Button
                  variant="outline"
                  disabled={fileQuery.offset + fileQuery.pageSize >= filePage.total}
                  onClick={() =>
                    setFileQuery((query) => ({ ...query, offset: query.offset + query.pageSize }))
                  }
                >
                  <span>Next</span>
                  <ChevronRight />
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        !analyticsLoading && (
          <Alert>
            <ImageIcon />
            <AlertDescription>No sync analytics loaded yet.</AlertDescription>
          </Alert>
        )
      )}
    </section>
  );
}
