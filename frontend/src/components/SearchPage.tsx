import { Fragment, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";
import type { Cfg } from "../App";
import {
  apiRequest,
  apiUrl,
  errorMessage,
  type Candidate,
  type MatchResponse,
  type StudentPage,
  type StudentRow,
} from "../api";
import { Button, Icon, Panel, ScoreBar, SEARCH_LOADER_MSGS, Verdict, verdictOf, VqLoader } from "../ds";
import { cosinePct, formatNumber } from "../format";

const FETCH_TOP_K = 20;

function CandidateModal({
  candidate,
  rank,
  cfg,
  onClose,
}: {
  candidate: Candidate;
  rank: number;
  cfg: Cfg;
  onClose: () => void;
}) {
  const [student, setStudent] = useState<StudentRow | null>(null);
  const sid = candidate.student?.student_id ?? null;
  // The match payload carries only a few student fields; pull the full record.
  useEffect(() => {
    setStudent(null);
    if (!sid) return;
    let cancelled = false;
    apiRequest<StudentPage>(`/students?field=sid&q=${encodeURIComponent(sid)}&limit=5`)
      .then((page) => {
        if (!cancelled) setStudent(page.rows.find((r) => r.student_id === sid) ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sid]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const kind = verdictOf(candidate.similarity, cfg.match, cfg.review);
  const pct = cosinePct(candidate.similarity);
  const name = candidate.student?.full_name ?? candidate.title;
  const rows: [string, string | null | undefined][] = [
    ["Student ID", sid],
    ["Email", student?.email],
    ["Programme", student?.programme ?? candidate.student?.programme],
    ["Cohort", student?.cohort],
    ["Level-Semester", student?.level_semester],
    ["Location", student?.location ?? candidate.student?.location],
    ["Photo file", candidate.title],
  ];
  return (
    <>
      <div className="scrim" onClick={onClose}></div>
      <div className="modal" role="dialog" aria-modal="true" aria-label={name}>
        <header className="card-head">
          <div>
            <div className="eyebrow">Candidate #{rank}</div>
            <h3 style={{ marginTop: 2 }}>{name}</h3>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="modal-body">
          <div className="modal-photo">
            <img src={apiUrl(`/image/${encodeURIComponent(candidate.drive_file_id)}?full=1`)} alt="" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)", minWidth: 0 }}>
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
              <span className="score-num" style={{ fontSize: "var(--text-h3)" }}>
                {pct.toFixed(1)}%
              </span>
              <Verdict kind={kind} />
            </div>
            <ScoreBar value={pct} kind={kind} />
            <div className="muted">cosine {candidate.similarity.toFixed(3)}</div>
            {candidate.student ? (
              <dl className="kv">
                {rows
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <Fragment key={k}>
                      <dt>{k}</dt>
                      <dd style={{ overflowWrap: "anywhere" }}>{v}</dd>
                    </Fragment>
                  ))}
              </dl>
            ) : (
              <div className="muted">No student record is linked to this photo.</div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export default function SearchPage({
  cfg,
  model,
  probeFileId,
  onProbeConsumed,
}: {
  cfg: Cfg;
  model: string;
  probeFileId: string | null;
  onProbeConsumed: () => void;
}) {
  const [openCand, setOpenCand] = useState<{ candidate: Candidate; rank: number } | null>(null);
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
  const requestRef = useRef(0);

  const faces = matchData?.faces || [];
  const selectedFace = faces[selectedFaceIndex] || null;
  const visibleCandidates = (selectedFace?.candidates || []).slice(0, cfg.topK);
  const topCandidate = visibleCandidates[0] || null;

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

  // "Use as probe" on a student record: fetch the linked enrolled photo
  // (?full=1 — the same bytes that were embedded, so rank #1 should be the
  // student themself at ~100%) and run it through the normal upload path;
  // the auto-search effect below takes it from there.
  useEffect(() => {
    if (!probeFileId) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(apiUrl(`/image/${encodeURIComponent(probeFileId)}?full=1`));
        if (!resp.ok) throw new Error(`image fetch failed (${resp.status})`);
        const blob = await resp.blob();
        if (cancelled) return;
        acceptFile(
          new File([blob], `student-${probeFileId}.jpg`, { type: blob.type || "image/jpeg" }),
        );
      } catch (error) {
        if (!cancelled) setMatchError(`Couldn't load the student's photo: ${errorMessage(error)}`);
      } finally {
        if (!cancelled) onProbeConsumed();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [probeFileId]);

  function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    acceptFile((event.target.files || [])[0]);
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    setDrag(false);
    acceptFile(event.dataTransfer.files?.[0]);
  }

  function clearSearch(clearFileInput = true) {
    requestRef.current++; // invalidate any in-flight match response
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
    const reqId = ++requestRef.current;
    setIsMatching(true);
    setMatchError("");
    const form = new FormData();
    form.append("file", uploadFile, uploadFile.name);
    try {
      const modelParam = model ? `&model=${encodeURIComponent(model)}` : "";
      const data = await apiRequest<MatchResponse>(`/match-many?top_k=${FETCH_TOP_K}${modelParam}`, {
        method: "POST",
        body: form,
      });
      if (requestRef.current !== reqId) return; // superseded by a newer upload or clear
      setMatchData(data);
      setSelectedFaceIndex(0);
    } catch (error) {
      if (requestRef.current !== reqId) return;
      setMatchData(null);
      setMatchError(errorMessage(error));
    } finally {
      if (requestRef.current === reqId) setIsMatching(false);
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

  // Switching the model re-runs the current query against the other
  // embedding set — the point of the model dial is side-by-side comparison.
  useEffect(() => {
    if (uploadFile && matchData && matchData.model && matchData.model !== model) {
      runMatch();
    }
  }, [model]);

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
                          {cosinePct(topCandidate.similarity).toFixed(1)}%
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
                      <ScoreBar value={cosinePct(topCandidate.similarity)} kind={kind} />
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
            {isMatching ? (
              <VqLoader messages={SEARCH_LOADER_MSGS} />
            ) : !matchData ? (
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
                  const open = () => setOpenCand({ candidate, rank: index + 1 });
                  return (
                    <div
                      key={candidate.drive_file_id}
                      className="cand"
                      role="button"
                      tabIndex={0}
                      onClick={open}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          open();
                        }
                      }}
                    >
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
                          <span className="cand-name">{candidate.student?.full_name ?? candidate.title}</span>
                        </div>
                        <div className="cand-meta">
                          {[
                            ...(candidate.student
                              ? [candidate.student.student_id, candidate.student.programme, candidate.student.location].filter(Boolean)
                              : ["no student record linked"]),
                            `cosine ${candidate.similarity.toFixed(3)}`,
                          ].join(" · ")}
                        </div>
                        <div style={{ marginTop: 8, maxWidth: 340 }}>
                          <ScoreBar value={cosinePct(candidate.similarity)} kind={kind} />
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
                          {cosinePct(candidate.similarity).toFixed(1)}%
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
      {openCand && (
        <CandidateModal
          candidate={openCand.candidate}
          rank={openCand.rank}
          cfg={cfg}
          onClose={() => setOpenCand(null)}
        />
      )}
    </div>
  );
}
