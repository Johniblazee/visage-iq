import { AlertTriangle, ChevronLeft, ChevronRight, Search, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { apiRequest, apiUrl, errorMessage, type MatchResponse } from "../api";
import { formatNumber } from "../format";

const FETCH_TOP_K = 20;

export default function SearchView({ active }: { active: boolean }) {
  const [matchThreshold, setMatchThreshold] = useState(Number(import.meta.env.VITE_DEFAULT_MATCH || 0.5));
  const [reviewThreshold, setReviewThreshold] = useState(Number(import.meta.env.VITE_DEFAULT_REVIEW || 0.4));
  const [topK, setTopK] = useState(3);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadUrl, setUploadUrl] = useState("");
  const [matchData, setMatchData] = useState<MatchResponse | null>(null);
  const [matchError, setMatchError] = useState("");
  const [isMatching, setIsMatching] = useState(false);
  const [selectedFaceIndex, setSelectedFaceIndex] = useState(0);
  const [canvasError, setCanvasError] = useState("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reviewMax = Math.max(0.01, matchThreshold);
  const faces = matchData?.faces || [];
  const selectedFace = faces[selectedFaceIndex] || null;
  const visibleCandidates = (selectedFace?.candidates || []).slice(0, topK);
  const topCandidate = visibleCandidates[0] || null;

  function verdict(similarity: number) {
    if (similarity >= matchThreshold) return "MATCH";
    if (similarity >= reviewThreshold) return "REVIEW";
    return "NO_MATCH";
  }
  function verdictClass(similarity: number) {
    return `verdict ${verdict(similarity).toLowerCase().replace("_", "-")}`;
  }
  function handleMatchThreshold(value: number) {
    setMatchThreshold(value);
    setReviewThreshold((current) => Math.min(current, Math.max(0.01, value)));
  }

  function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const [file] = event.target.files || [];
    if (!file) return;
    clearSearch(false);
    setUploadFile(file);
    setUploadUrl(URL.createObjectURL(file));
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
    setSelectedFaceIndex((index) =>
      Math.min(Math.max(index + delta, 0), Math.max(faces.length - 1, 0)),
    );
  }

  // Draw the uploaded image (rotated the way the API saw it) plus the
  // selected face's bounding box. Runs after every match / face change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !matchData || !uploadUrl) return;
    const face = matchData.faces?.[selectedFaceIndex] || null;
    const img = new Image();
    img.onload = () => {
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
        ctx.strokeStyle = "#16a34a";
        ctx.lineWidth = Math.max(4, canvas.width / 220);
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      }
      setCanvasError("");
    };
    img.onerror = () => {
      setCanvasError("Preview unavailable in this browser. The API search result is still valid.");
    };
    img.src = uploadUrl;
  }, [matchData, selectedFaceIndex, uploadUrl]);

  return (
    <section className="view" style={{ display: active ? undefined : "none" }}>
      <header className="view-header">
        <div>
          <h2>Face Search</h2>
          <p>Upload a portrait, passport, or ID photo and review ranked candidates.</p>
        </div>
        <div className="thresholds">
          <label>
            <span>Match {matchThreshold.toFixed(2)}</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={matchThreshold}
              onChange={(event) => handleMatchThreshold(event.target.valueAsNumber)}
            />
          </label>
          <label>
            <span>Review {reviewThreshold.toFixed(2)}</span>
            <input
              type="range"
              min="0"
              max={reviewMax}
              step="0.01"
              value={reviewThreshold}
              onChange={(event) => setReviewThreshold(event.target.valueAsNumber)}
            />
          </label>
          <label>
            <span>Top K {topK}</span>
            <input
              type="range"
              min="1"
              max={FETCH_TOP_K}
              step="1"
              value={topK}
              onChange={(event) => setTopK(event.target.valueAsNumber)}
            />
          </label>
        </div>
      </header>
      <div className="upload-strip">
        <label className="file-picker" htmlFor="upload-input">
          <Upload size={18} />
          <span>{uploadFile ? uploadFile.name : "Choose image"}</span>
          <input
            id="upload-input"
            ref={fileInputRef}
            type="file"
            accept="image/*,.heic,.heif"
            onChange={handleUpload}
          />
        </label>
        <button
          className="button primary"
          type="button"
          disabled={!uploadFile || isMatching}
          onClick={runMatch}
        >
          <Search size={16} />
          <span>{isMatching ? "Searching..." : matchData ? "Search again" : "Search"}</span>
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={!uploadFile}
          onClick={() => clearSearch()}
        >
          <X size={16} />
          <span>Clear</span>
        </button>
      </div>
      {matchError && (
        <p className="callout danger">
          <AlertTriangle size={17} /> {matchError}
        </p>
      )}
      {!uploadFile && <p className="callout">Upload an image to search the enrolled database.</p>}
      {uploadFile && (
        <div className="search-grid">
          <section className="query-pane">
            <div className="pane-title">
              <h3>Query</h3>
              {matchData && <span>{matchData.query_face_count} face(s)</span>}
            </div>
            <div className="canvas-wrap">
              <canvas
                ref={canvasRef}
                style={{ display: matchData && !canvasError ? undefined : "none" }}
              ></canvas>
              {!matchData && uploadUrl && <img src={uploadUrl} alt="Uploaded query preview" />}
              {canvasError && <p className="muted">{canvasError}</p>}
            </div>
            {matchData && selectedFace && (
              <div className="query-meta">
                <span>
                  Face {selectedFaceIndex + 1} of {faces.length}
                </span>
                <span>Detection {selectedFace.det_score.toFixed(3)}</span>
                {matchData.query_rotation ? <span>Rotation {matchData.query_rotation}deg</span> : null}
              </div>
            )}
          </section>
          <section className="results-pane">
            <div className="pane-title">
              <h3>Top candidates</h3>
              {matchData && <span>{formatNumber(matchData.enrolled_count)} searched</span>}
            </div>
            {matchData && matchData.enrolled_count === 0 ? (
              <p className="callout warn">Database is empty. Run a Drive sync before comparing images.</p>
            ) : !matchData ? (
              <p className="muted">Run search to see ranked matches.</p>
            ) : null}
            {faces.length > 1 && (
              <div className="face-pager">
                <button
                  className="icon-button"
                  type="button"
                  disabled={selectedFaceIndex === 0}
                  title="Previous face"
                  onClick={() => changeFace(-1)}
                >
                  <ChevronLeft size={18} />
                </button>
                <span>
                  Face {selectedFaceIndex + 1} of {faces.length}
                </span>
                <button
                  className="icon-button"
                  type="button"
                  disabled={selectedFaceIndex >= faces.length - 1}
                  title="Next face"
                  onClick={() => changeFace(1)}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            )}
            {topCandidate && (
              <div className="top-match">
                <span>Top match</span>
                <strong>{Math.max(0, topCandidate.similarity * 100).toFixed(1)}%</strong>
                <em className={verdictClass(topCandidate.similarity)}>{verdict(topCandidate.similarity)}</em>
              </div>
            )}
            {visibleCandidates.map((candidate, index) => (
              <article key={candidate.drive_file_id} className="candidate-card">
                <img
                  src={apiUrl(`/image/${encodeURIComponent(candidate.drive_file_id)}`)}
                  alt={candidate.title}
                  loading="lazy"
                />
                <div>
                  <div className="candidate-head">
                    <strong>
                      #{index + 1} {candidate.title}
                    </strong>
                    <span>{Math.max(0, candidate.similarity * 100).toFixed(1)}%</span>
                  </div>
                  <div className="score-bar">
                    <span
                      style={{ width: `${Math.max(0, Math.min(100, candidate.similarity * 100))}%` }}
                    ></span>
                  </div>
                  <em className={verdictClass(candidate.similarity)}>{verdict(candidate.similarity)}</em>
                </div>
              </article>
            ))}
          </section>
        </div>
      )}
    </section>
  );
}
