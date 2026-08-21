import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";
import type { Cfg } from "../App";
import { apiRequest, apiUrl, errorMessage, type MatchResponse } from "../api";
import { Button, Icon, Panel, ScoreBar, Verdict, verdictOf } from "../ds";
import { formatNumber } from "../format";

const FETCH_TOP_K = 20;

export default function SearchPage({ cfg }: { cfg: Cfg }) {
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadUrl, setUploadUrl] = useState("");
  const [matchData, setMatchData] = useState<MatchResponse | null>(null);
  const [matchError, setMatchError] = useState("");
  const [isMatching, setIsMatching] = useState(false);
  const [selectedFaceIndex, setSelectedFaceIndex] = useState(0);
  const [canvasError, setCanvasError] = useState("");
  const [drag, setDrag] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const searchedRef = useRef<File | null>(null);

  const faces = matchData?.faces || [];
  const selectedFace = faces[selectedFaceIndex] || null;
  const visibleCandidates = (selectedFace?.candidates || []).slice(0, cfg.topK);
  const topCandidate = visibleCandidates[0] || null;

  // Mirrors backend/scoring.py — keep in sync. Raw cosine never reaches 1.0,
  // so rescale for display: impostor ceiling -> 0%, review -> 50%,
  // match -> 75%, genuine ceiling -> 100%.
  function confidencePct(similarity: number) {
    const xs = [0.23, cfg.review, cfg.match, 0.85];
    const ys = [0, 50, 75, 100];
    for (let i = 1; i < 4; i++) xs[i] = Math.max(xs[i], xs[i - 1] + 1e-6);
    if (similarity <= xs[0]) return 0;
    for (let i = 1; i < 4; i++) {
      if (similarity <= xs[i]) {
        return ys[i - 1] + ((similarity - xs[i - 1]) / (xs[i] - xs[i - 1])) * (ys[i] - ys[i - 1]);
      }
    }
    return 100;
  }
  // SCRFD det_score: floor 0.5 (det_thresh), empirical ceiling ~0.95.
  function detPct(detScore: number) {
    return Math.max(0, Math.min(1, (detScore - 0.5) / 0.45)) * 100;
  }

  function acceptFile(file: File | undefined | null) {
    if (!file) return;
    clearSearch(false);
    setUploadFile(file);
    setUploadUrl(URL.createObjectURL(file));
  }

  function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    acceptFile((event.target.files || [])[0]);
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    setDrag(false);
    acceptFile(event.dataTransfer.files?.[0]);
  }

  function clearSearch(clearFileInput = true) {
    if (uploadUrl) URL.revokeObjectURL(uploadUrl);
    setUploadFile(null);
    setUploadUrl("");
    setMatchData(null);
    setMatchError("");
    setSelectedFaceIndex(0);
    setCanvasError("");
    if (clearFileInput && fileInputRef.current) fileInputRef.current.value = "";
  }

  async function runMatch() {
    if (!uploadFile) return;
    setIsMatching(true);
    setMatchError("");
    const form = new FormData();
    form.append("file", uploadFile, uploadFile.name);
    try {
      const data = await apiRequest<MatchResponse>(`/match-many?top_k=${FETCH_TOP_K}`, {
        method: "POST",
        body: form,
      });
      setMatchData(data);
      setSelectedFaceIndex(0);
    } catch (error) {
      setMatchData(null);
      setMatchError(errorMessage(error));
    } finally {
      setIsMatching(false);
    }
  }

  function changeFace(delta: number) {
    setSelectedFaceIndex((index) => Math.min(Math.max(index + delta, 0), Math.max(faces.length - 1, 0)));
  }

  // Search starts as soon as an image is picked or dropped — no extra click.
  // The ref keeps StrictMode's double effect run from firing the POST twice.
  useEffect(() => {
    if (uploadFile && searchedRef.current !== uploadFile) {
      searchedRef.current = uploadFile;
      runMatch();
    }
  }, [uploadFile]);

  // Draw the uploaded image (rotated the way the API saw it) plus the
  // selected face's bounding box. Runs after every match / face change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !matchData || !uploadUrl) return;
    const face = matchData.faces?.[selectedFaceIndex] || null;
    let stale = false;
    const img = new Image();
    img.onload = () => {
      if (stale) return;
      const rotation = matchData.query_rotation || 0;
      const swap = rotation === 90 || rotation === 270;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = swap ? img.naturalHeight : img.naturalWidth;
      canvas.height = swap ? img.naturalWidth : img.naturalHeight;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (rotation === 90) {
        ctx.translate(canvas.width, 0);
        ctx.rotate(Math.PI / 2);
      } else if (rotation === 180) {
        ctx.translate(canvas.width, canvas.height);
        ctx.rotate(Math.PI);
      } else if (rotation === 270) {
        ctx.translate(0, canvas.height);
        ctx.rotate((3 * Math.PI) / 2);
      }
      ctx.drawImage(img, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (face?.bbox?.length === 4) {
        const [x1, y1, x2, y2] = face.bbox;
        ctx.strokeStyle = "#5CDAAA";
        ctx.lineWidth = Math.max(4, canvas.width / 220);
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      }
      setCanvasError("");
    };
    img.onerror = () => {
      if (!stale) setCanvasError("Preview unavailable in this browser. The API search result is still valid.");
    };
    img.src = uploadUrl;
    return () => {
      stale = true;
    };
  }, [matchData, selectedFaceIndex, uploadUrl]);

  const bboxSize =
    selectedFace?.bbox?.length === 4
      ? `${Math.round(selectedFace.bbox[2] - selectedFace.bbox[0])} × ${Math.round(selectedFace.bbox[3] - selectedFace.bbox[1])} px`
      : null;

  const dropzone = (label: string) => (
    <div
      className={"dropzone" + (drag ? " drag" : "")}
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={() => fileInputRef.current?.click()}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          fileInputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={handleDrop}
    >
      <div style={{ fontWeight: 600, color: "var(--txt-1)" }}>{label}</div>
      <div className="muted" style={{ marginTop: 4 }}>
        Drop it here or click to browse · JPG, PNG, WebP or HEIC
      </div>
    </div>
  );

  return (
    <div className="page">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.heic,.heif"
        style={{ display: "none" }}
        onChange={handleUpload}
      />
      <div className="page-head">
        <div>
          <div className="eyebrow">Face match</div>
          <h1>Face search</h1>
          <p>
            Upload a portrait, passport or CCTV still. VisageIQ ranks it against every enrolled student
            photo and applies your review thresholds.
          </p>
        </div>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <Button kind="ghost" size="sm" disabled={!uploadFile} iconLeft={<Icon name="x" size={16} />} onClick={() => clearSearch()}>
            Clear
          </Button>
          <Button
            kind="primary"
            size="sm"
            disabled={!uploadFile || isMatching}
            iconLeft={<Icon name="search" size={16} />}
            onClick={runMatch}
          >
            {isMatching ? "Searching…" : matchData ? "Search again" : "Search"}
          </Button>
        </div>
      </div>
      {matchError && <div className="alert">{matchError}</div>}
      <div className="grid-2">
        <Panel
          title="Query image"
          meta={
            uploadFile
              ? `${uploadFile.name}${matchData ? ` · ${matchData.query_face_count} face${matchData.query_face_count === 1 ? "" : "s"} detected` : ""}`
              : "No image loaded"
          }
          pad={false}
        >
          <div className="card-pad" style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
            {!uploadFile ? (
              dropzone("Drop the query photo")
            ) : (
              <>
                <div className="probe">
                  <canvas ref={canvasRef} style={{ display: matchData && !canvasError ? undefined : "none" }} />
                  {(!matchData || canvasError) && uploadUrl && <img src={uploadUrl} alt="Uploaded query preview" />}
                  {canvasError && (
                    <p className="muted" style={{ padding: "var(--s-4)" }}>
                      {canvasError}
                    </p>
                  )}
                </div>
                {faces.length > 1 && (
                  <div className="row" style={{ justifyContent: "center" }}>
                    <Button kind="ghost" size="sm" disabled={selectedFaceIndex === 0} onClick={() => changeFace(-1)}>
                      <Icon name="chevronLeft" size={16} />
                    </Button>
                    <span className="muted">
                      Face {selectedFaceIndex + 1} of {faces.length}
                    </span>
                    <Button
                      kind="ghost"
                      size="sm"
                      disabled={selectedFaceIndex >= faces.length - 1}
                      onClick={() => changeFace(1)}
                    >
                      <Icon name="chevronRight" size={16} />
                    </Button>
                  </div>
                )}
                {matchData && selectedFace && (
                  <dl className="kv">
                    <dt>Detection</dt>
                    <dd>{detPct(selectedFace.det_score).toFixed(0)}%</dd>
                    {bboxSize && (
                      <>
                        <dt>Face box</dt>
                        <dd>{bboxSize}</dd>
                      </>
                    )}
                    {matchData.query_rotation ? (
                      <>
                        <dt>Rotation</dt>
                        <dd>{matchData.query_rotation}°</dd>
                      </>
                    ) : null}
                    <dt>Searched</dt>
                    <dd>{formatNumber(matchData.enrolled_count)} enrolled photos</dd>
                  </dl>
                )}
                {dropzone("Drop a replacement image")}
              </>
            )}
          </div>
        </Panel>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
          {matchData && matchData.enrolled_count === 0 && (
            <div className="alert">Database is empty. Run a Drive sync before comparing images.</div>
          )}
          {topCandidate && (
            <div
              className="card card-pad"
              style={{ display: "flex", alignItems: "center", gap: "var(--s-5)", flexWrap: "wrap" }}
            >
              {(() => {
                const kind = verdictOf(topCandidate.similarity, cfg.match, cfg.review);
                return (
                  <>
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <div className="stat-lab">Top similarity</div>
                      <div className="row" style={{ gap: "var(--s-4)", marginTop: 6 }}>
                        <span className="score-num" style={{ fontSize: "var(--text-h2)" }}>
                          {confidencePct(topCandidate.similarity).toFixed(1)}%
                        </span>
                        <Verdict kind={kind} />
                      </div>
                    </div>
                    <div style={{ flex: 2, minWidth: 220 }}>
                      <div className="muted" style={{ marginBottom: 6 }}>
                        {kind === "no"
                          ? "Below the review threshold — no candidate is close enough to act on."
                          : kind === "review"
                            ? "In the review band — a human decision is required."
                            : "Above the match threshold."}
                      </div>
                      <ScoreBar value={confidencePct(topCandidate.similarity)} kind={kind} />
                    </div>
                  </>
                );
              })()}
            </div>
          )}
          <Panel
            title="Ranked candidates"
            meta={matchData ? `Top ${cfg.topK} of ${formatNumber(matchData.enrolled_count)} searched` : undefined}
            pad={false}
          >
            {!matchData ? (
              <div className="empty">
                <Icon name="search" size={28} color="var(--txt-3)" />
                <div style={{ fontSize: "var(--text-body)", color: "var(--txt-2)" }}>
                  {uploadFile ? "Run search to see ranked matches." : "Upload a query image to search the enrolled index."}
                </div>
              </div>
            ) : (
              <div className="card-pad" style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
                {visibleCandidates.map((candidate, index) => {
                  const kind = verdictOf(candidate.similarity, cfg.match, cfg.review);
                  return (
                    <div key={candidate.drive_file_id} className="cand">
                      <div className="avatar" style={{ width: 64, height: 64 }}>
                        <img
                          src={apiUrl(`/image/${encodeURIComponent(candidate.drive_file_id)}`)}
                          alt={candidate.title}
                          loading="lazy"
                        />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div className="row" style={{ gap: "var(--s-2)", flexWrap: "nowrap" }}>
                          <span className="muted" style={{ fontWeight: 700 }}>
                            #{index + 1}
                          </span>
                          <span className="cand-name">{candidate.title}</span>
                        </div>
                        <div className="cand-meta">cosine {candidate.similarity.toFixed(3)}</div>
                        <div style={{ marginTop: 8, maxWidth: 340 }}>
                          <ScoreBar value={confidencePct(candidate.similarity)} kind={kind} />
                        </div>
                      </div>
                      <div
                        style={{
                          textAlign: "right",
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                          alignItems: "flex-end",
                        }}
                      >
                        <span className="score-num" style={{ fontSize: "var(--text-h4)" }}>
                          {confidencePct(candidate.similarity).toFixed(1)}%
                        </span>
                        <Verdict kind={kind} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
