import { AlertTriangle, ChevronLeft, ChevronRight, Search, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { apiRequest, apiUrl, errorMessage, type MatchResponse } from "../api";
import { formatNumber } from "../format";

const FETCH_TOP_K = 20;

// Base UI sliders report number | number[]; we always use a single thumb.
function sliderValue(value: number | readonly number[]): number {
  return Array.isArray(value) ? (value[0] as number) : (value as number);
}

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
  function verdictBadge(similarity: number) {
    const label = verdict(similarity);
    return (
      <Badge
        variant="secondary"
        className={cn(
          "font-bold",
          label === "MATCH" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
          label === "REVIEW" && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
          label === "NO_MATCH" && "bg-red-500/15 text-red-700 dark:text-red-400",
        )}
      >
        {label}
      </Badge>
    );
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
    <section className="grid gap-5" style={{ display: active ? undefined : "none" }}>
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Face Search</h2>
          <p className="text-sm text-muted-foreground">
            Upload a portrait, passport, or ID photo and review ranked candidates.
          </p>
        </div>
        <div className="grid w-full gap-4 sm:grid-cols-3 lg:max-w-md">
          <div className="grid gap-2.5">
            <Label className="text-xs text-muted-foreground">Match {matchThreshold.toFixed(2)}</Label>
            <Slider
              value={[matchThreshold]}
              min={0}
              max={1}
              step={0.01}
              onValueChange={(value) => handleMatchThreshold(sliderValue(value))}
            />
          </div>
          <div className="grid gap-2.5">
            <Label className="text-xs text-muted-foreground">Review {reviewThreshold.toFixed(2)}</Label>
            <Slider
              value={[reviewThreshold]}
              min={0}
              max={reviewMax}
              step={0.01}
              onValueChange={(value) => setReviewThreshold(sliderValue(value))}
            />
          </div>
          <div className="grid gap-2.5">
            <Label className="text-xs text-muted-foreground">Top K {topK}</Label>
            <Slider
              value={[topK]}
              min={1}
              max={FETCH_TOP_K}
              step={1}
              onValueChange={(value) => setTopK(sliderValue(value))}
            />
          </div>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2.5">
        <label
          htmlFor="upload-input"
          className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-input bg-background px-3 text-sm hover:bg-muted"
        >
          <Upload className="size-4" />
          <span>{uploadFile ? uploadFile.name : "Choose image"}</span>
          <input
            id="upload-input"
            ref={fileInputRef}
            type="file"
            accept="image/*,.heic,.heif"
            className="hidden"
            onChange={handleUpload}
          />
        </label>
        <Button disabled={!uploadFile || isMatching} onClick={runMatch}>
          <Search />
          <span>{isMatching ? "Searching..." : matchData ? "Search again" : "Search"}</span>
        </Button>
        <Button variant="outline" disabled={!uploadFile} onClick={() => clearSearch()}>
          <X />
          <span>Clear</span>
        </Button>
      </div>

      {matchError && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>{matchError}</AlertDescription>
        </Alert>
      )}
      {!uploadFile && (
        <Alert>
          <Upload />
          <AlertDescription>Upload an image to search the enrolled database.</AlertDescription>
        </Alert>
      )}

      {uploadFile && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Query</CardTitle>
              {matchData && (
                <CardAction className="text-sm text-muted-foreground">
                  {matchData.query_face_count} face(s)
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid min-h-90 place-items-center overflow-hidden rounded-lg bg-slate-900">
                <canvas
                  ref={canvasRef}
                  className="block max-h-[68vh] max-w-full"
                  style={{ display: matchData && !canvasError ? undefined : "none" }}
                ></canvas>
                {!matchData && uploadUrl && (
                  <img src={uploadUrl} alt="Uploaded query preview" className="block max-h-[68vh] max-w-full" />
                )}
                {canvasError && <p className="p-4 text-sm text-slate-400">{canvasError}</p>}
              </div>
              {matchData && selectedFace && (
                <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
                  <span>
                    Face {selectedFaceIndex + 1} of {faces.length}
                  </span>
                  <span>Detection {selectedFace.det_score.toFixed(3)}</span>
                  {matchData.query_rotation ? <span>Rotation {matchData.query_rotation}deg</span> : null}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Top candidates</CardTitle>
              {matchData && (
                <CardAction className="text-sm text-muted-foreground">
                  {formatNumber(matchData.enrolled_count)} searched
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="grid content-start gap-3">
              {matchData && matchData.enrolled_count === 0 ? (
                <Alert>
                  <AlertTriangle />
                  <AlertDescription>
                    Database is empty. Run a Drive sync before comparing images.
                  </AlertDescription>
                </Alert>
              ) : !matchData ? (
                <p className="text-sm text-muted-foreground">Run search to see ranked matches.</p>
              ) : null}
              {faces.length > 1 && (
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    disabled={selectedFaceIndex === 0}
                    title="Previous face"
                    onClick={() => changeFace(-1)}
                  >
                    <ChevronLeft />
                  </Button>
                  <span>
                    Face {selectedFaceIndex + 1} of {faces.length}
                  </span>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    disabled={selectedFaceIndex >= faces.length - 1}
                    title="Next face"
                    onClick={() => changeFace(1)}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              )}
              {topCandidate && (
                <div className="flex items-center gap-3 rounded-lg border bg-muted/50 p-3">
                  <span className="text-sm text-muted-foreground">Top match</span>
                  <strong className="text-2xl">
                    {Math.max(0, topCandidate.similarity * 100).toFixed(1)}%
                  </strong>
                  {verdictBadge(topCandidate.similarity)}
                </div>
              )}
              {visibleCandidates.map((candidate, index) => (
                <article
                  key={candidate.drive_file_id}
                  className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 rounded-lg border p-2.5 sm:grid-cols-[96px_minmax(0,1fr)]"
                >
                  <img
                    src={apiUrl(`/image/${encodeURIComponent(candidate.drive_file_id)}`)}
                    alt={candidate.title}
                    loading="lazy"
                    className="size-18 rounded-md bg-muted object-cover sm:size-24"
                  />
                  <div className="min-w-0">
                    <div className="mb-2 flex items-start justify-between gap-2 text-sm">
                      <strong className="min-w-0 break-words font-medium">
                        #{index + 1} {candidate.title}
                      </strong>
                      <span>{Math.max(0, candidate.similarity * 100).toFixed(1)}%</span>
                    </div>
                    <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.max(0, Math.min(100, candidate.similarity * 100))}%` }}
                      />
                    </div>
                    {verdictBadge(candidate.similarity)}
                  </div>
                </article>
              ))}
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  );
}
