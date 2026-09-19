/* Video match — attendance roll from a short clip (design: "Video match.html").
   No player anywhere: the clip is deleted after processing; timestamps are for
   the operator's own copy. */
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type SyntheticEvent,
} from "react";
import {
  apiBlob,
  apiRequest,
  apiUrl,
  errorMessage,
  uploadWithProgress,
  type StudentPage,
  type StudentRow,
  type VideoJob,
  type VideoResults,
  type VideoSighting,
  type VideoUnknown,
} from "../api";
import { Button, Icon, Panel, ScoreBar, Verdict, toast, type VerdictKind } from "../ds";
import { CandidateModal } from "./SearchPage";
import { formatNumber, relativeTime } from "../format";

type Kind = VerdictKind;
type Filter = "all" | "match" | "review";

const PHASE: Record<string, string> = {
  probing: "Checking the video…",
  matching: "Matching faces…",
  writing: "Saving results…",
};
const stamp = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const kindOf = (v: VideoSighting["verdict"]): Kind => (v === "MATCH" ? "match" : v === "REVIEW" ? "review" : "no");
const nameOf = (g: VideoSighting) => g.student?.full_name ?? g.title ?? g.drive_file_id;
const unkName = (u: VideoUnknown) => "Unidentified face " + String(u.idx + 1).padStart(2, "0");
const nearName = (u: VideoUnknown) => u.near?.student?.full_name ?? u.near?.title ?? null;
const unkReason = (u: VideoUnknown) =>
  u.reason === "small"
    ? `Small face — about ${u.face_px} px wide`
    : u.reason === "dark"
      ? "Low light in this part of the frame"
      : u.reason === "weak"
        ? "Face partly turned away or hidden from the camera"
        : u.reason === "ambiguous"
          ? "Two enrolled students scored too close to call"
          : u.frames_seen === 1
            ? "Seen in a single frame only"
            : "Not close to any enrolled passport";
const seenLine = (g: { first_ts: number; last_ts: number; frames_seen: number }) =>
  `first ${stamp(g.first_ts)} · last ${stamp(g.last_ts)} · seen in ${g.frames_seen} frame${g.frames_seen > 1 ? "s" : ""}`;

// The clipboard only takes PNG images, so the JPEG crop is re-encoded on a canvas first.
async function copyImage(path: string) {
  if (!navigator.clipboard || typeof ClipboardItem === "undefined")
    return toast("warn", "Copying needs a secure (HTTPS) page");
  try {
    const bmp = await createImageBitmap(await apiBlob(path));
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d")?.drawImage(bmp, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("couldn't encode the image");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    toast("ok", "Copied face crop");
  } catch (error) {
    toast("error", "Couldn't copy the crop", errorMessage(error));
  }
}

const hide = (e: SyntheticEvent<HTMLImageElement>) => {
  e.currentTarget.style.display = "none";
};
const settled = (j: VideoJob | null) => !j || j.status === "done" || j.status === "failed";

function FacePair({ jobId, g }: { jobId: string; g: VideoSighting }) {
  return (
    <div className="crop">
      <img
        className="crop-img"
        src={apiUrl(`/video/${jobId}/crop/${encodeURIComponent(g.drive_file_id)}`)}
        alt=""
        loading="lazy"
        onError={hide}
      />
      <div className="crop-thumb" title="Enrolled passport">
        <img src={apiUrl(`/image/${encodeURIComponent(g.drive_file_id)}`)} alt="" loading="lazy" onError={hide} />
      </div>
    </div>
  );
}

function RollCard({ jobId, g, onOpen }: { jobId: string; g: VideoSighting; onOpen: (g: VideoSighting) => void }) {
  const s = g.student;
  const kind = kindOf(g.verdict);
  return (
    <button className="roll" onClick={() => onOpen(g)}>
      <FacePair jobId={jobId} g={g} />
      <div className="roll-body">
        <div className="cand-name" style={{ lineHeight: 1.2 }}>
          {nameOf(g)}
        </div>
        <div className="cand-meta">
          {s ? [s.student_id, s.programme, s.location].filter(Boolean).join(" · ") : "No student record for this face"}
        </div>
        <div className="roll-conf">
          <span className="score-num" style={{ fontSize: "var(--text-h3)" }}>
            {g.confidence_pct.toFixed(1)}%
          </span>
          <Verdict kind={kind} />
          {g.frames_seen === 1 && <span className="tag caution">1 frame</span>}
        </div>
        <ScoreBar value={g.confidence_pct} kind={kind} />
        <div className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
          {seenLine(g)}
        </div>
      </div>
    </button>
  );
}

function UnknownCard({ jobId, g, onOpen }: { jobId: string; g: VideoUnknown; onOpen: (g: VideoUnknown) => void }) {
  const pct = g.scored ? g.confidence_pct : null;
  const near = g.scored ? nearName(g) : null;
  return (
    <button className="roll" onClick={() => onOpen(g)}>
      <div className="crop">
        <img className="crop-img" src={apiUrl(`/video/${jobId}/unknown/${g.idx}/crop`)} alt="" loading="lazy" onError={hide} />
      </div>
      <div className="roll-body">
        <div className="cand-name" style={{ lineHeight: 1.2 }}>
          {unkName(g)}
        </div>
        <div className="cand-meta">{unkReason(g)}</div>
        <div className="roll-conf">
          {pct != null ? (
            <>
              <span className="score-num" style={{ fontSize: "var(--text-h3)", color: "var(--txt-2)" }}>
                {pct.toFixed(1)}%
              </span>
              <Verdict kind="no" />
            </>
          ) : (
            // A score from an unreliable view is noise: showing "75%" beside "No match" would mislead.
            <span className="tag" title="The view was too unreliable to compare against enrolled passports">
              Not scored
            </span>
          )}
          {g.frames_seen === 1 && <span className="tag caution">1 frame</span>}
        </div>
        {pct != null && <ScoreBar value={pct} kind="no" />}
        <div className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
          {near ? `closest ${near} · ` : ""}
          {seenLine(g)}
        </div>
      </div>
    </button>
  );
}

function TimestampChips({ list }: { list: number[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, 30);
  const copy = (t: string) => {
    if (!navigator.clipboard) return toast("warn", "Copying needs a secure (HTTPS) page", `Timestamp ${t}`);
    navigator.clipboard.writeText(t).then(
      () => toast("ok", `Copied ${t}`),
      () => toast("error", "Couldn't copy to the clipboard"),
    );
  };
  return (
    <div>
      <div className="ts-wrap">
        {shown.map((t, i) => (
          <button key={i} className="ts" title="Copy timestamp" onClick={() => copy(stamp(t))}>
            {stamp(t)}
          </button>
        ))}
        {list.length > 30 && (
          <button className="chip" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `+${list.length - 30} more`}
          </button>
        )}
      </div>
      <div className="muted" style={{ marginTop: "var(--s-3)" }}>
        Seek these in your own copy of the clip — the upload was deleted after processing.
      </div>
    </div>
  );
}

function SightingModal({
  jobId,
  g,
  onClose,
  onSearchFace,
}: {
  jobId: string;
  g: VideoSighting | VideoUnknown;
  onClose: () => void;
  onSearchFace: (path: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [student, setStudent] = useState<StudentRow | null>(null);
  const [passport, setPassport] = useState(false); // Face search's candidate modal, stacked on top
  const unk = "idx" in g ? g : null;
  const known = "idx" in g ? null : g;
  const sid = known?.student?.student_id ?? null;
  // The sighting carries a few student fields; pull the full record for the drawer.
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
  // Focus the dialog on open and hand focus back on close (basic dialog a11y).
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button,[href],input,select,[tabindex]:not([tabindex="-1"])')?.focus();
    return () => prev?.focus();
  }, []);
  // Focus trap + Esc, as in the design — handed over while the passport modal is on top.
  useEffect(() => {
    const el = ref.current;
    if (!el || passport) return;
    const focusables = () =>
      [...el.querySelectorAll<HTMLElement>('button,[href],input,select,[tabindex]:not([tabindex="-1"])')].filter(
        (n) => !(n as HTMLButtonElement).disabled,
      );
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, passport]);

  const kind: Kind = known ? kindOf(known.verdict) : "no";
  const title = unk ? unkName(unk) : nameOf(known!);
  const evidence = unk
    ? `/video/${jobId}/unknown/${unk.idx}`
    : null; // identified sightings are keyed by the enrolled photo instead
  const frameSrc = evidence ? `${evidence}/frame` : `/video/${jobId}/frame/${encodeURIComponent(known!.drive_file_id)}`;
  const thumbId = unk ? unk.near?.drive_file_id : known!.drive_file_id;
  // An unidentified face kept off the roll for being too unreliable has no score at all:
  // its nearest neighbour is noise, and "75%" beside "No match" would mislead.
  const scored = g.confidence_pct != null && g.best_similarity != null;
  const pct = g.confidence_pct ?? 0;
  // The enrolled photo this block is about, in the shape Face search's candidate modal takes.
  const candidate =
    scored && thumbId
      ? {
          drive_file_id: thumbId,
          title: (unk ? unk.near?.title : known!.title) ?? "",
          similarity: g.best_similarity ?? 0,
          student: unk ? unk.near?.student : known!.student,
        }
      : null;
  const openPassport = candidate
    ? {
        className: "row open-cand",
        role: "button",
        tabIndex: 0,
        title: "Open the enrolled photo and student record",
        onClick: () => setPassport(true),
        onKeyDown: (e: ReactKeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setPassport(true);
          }
        },
      }
    : { className: "row" };
  const s = known?.student;
  const rows: [string, string | null | undefined][] = [
    ["Student ID", sid],
    ["Email", student?.email],
    ["Programme", student?.programme ?? s?.programme],
    ["Cohort", student?.cohort],
    ["Level · semester", student?.level_semester],
    ["Location", student?.location ?? s?.location],
  ];
  return (
    <>
      <div className="scrim" onClick={onClose}></div>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="card-head">
          <div>
            <div className="eyebrow">Sighting</div>
            <h3 style={{ marginTop: 2 }}>{title}</h3>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="drawer-body">
          <div className="modal-top">
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
              <div className="frame-view">
                <img src={apiUrl(frameSrc)} alt="" onError={hide} />
              </div>
              <div className="muted">Best frame at {stamp(g.best_ts)} · face box drawn by the detector</div>
              {g.det_pct != null && (
                <dl className="kv">
                  <dt>Detection</dt>
                  <dd>{g.det_pct.toFixed(0)}%</dd>
                  {g.face_px ? (
                    <>
                      <dt>Face box</dt>
                      <dd>{g.face_px} px</dd>
                    </>
                  ) : null}
                </dl>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
              <div {...openPassport} style={{ alignItems: "center", gap: "var(--s-4)", flexWrap: "nowrap" }}>
                <div
                  style={{
                    width: 56,
                    height: 70,
                    border: "1px solid var(--line)",
                    borderRadius: "var(--r-sm)",
                    overflow: "hidden",
                    flex: "none",
                    background: "var(--surface-3)",
                  }}
                >
                  {thumbId ? (
                    <img
                      src={apiUrl(`/image/${encodeURIComponent(thumbId)}`)}
                      alt=""
                      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      onError={hide}
                    />
                  ) : (
                    <div style={{ height: "100%", display: "grid", placeItems: "center", color: "var(--txt-3)", fontWeight: 700 }}>
                      ?
                    </div>
                  )}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="stat-lab">{!unk ? "Confidence" : scored ? "Closest enrolled face" : "Comparison"}</div>
                  <div className="row" style={{ gap: "var(--s-3)", marginTop: 4 }}>
                    {scored ? (
                      <>
                        <span className="score-num" style={{ fontSize: "var(--text-h2)", color: unk ? "var(--txt-2)" : undefined }}>
                          {pct.toFixed(1)}%
                        </span>
                        <Verdict kind={kind} />
                      </>
                    ) : (
                      <span className="score-num" style={{ fontSize: "var(--text-h3)", color: "var(--txt-2)" }}>
                        Not scored
                      </span>
                    )}
                  </div>
                  <div className="muted" style={{ marginTop: 2 }}>
                    {!unk
                      ? "Enrolled passport"
                      : scored
                        ? `${nearName(unk) ?? "No enrolled photo nearby"} · below the review band`
                        : "The view was too unreliable to compare"}
                  </div>
                </div>
              </div>
              {scored && <ScoreBar value={pct} kind={kind} />}
              {scored && (
                <div className="muted">
                  cosine {(g.best_similarity ?? 0).toFixed(3)} ·{" "}
                  {unk
                    ? "no enrolled student scored high enough to be proposed"
                    : kind === "match"
                      ? "above the match threshold"
                      : g.frames_seen === 1
                        ? "seen in a single frame — a human decision is required"
                        : "in the review band — a human decision is required"}
                </div>
              )}
              <div className="row" style={{ gap: "var(--s-2)" }}>
                <span className="tag">first {stamp(g.first_ts)}</span>
                <span className="tag">last {stamp(g.last_ts)}</span>
                <span className={g.frames_seen === 1 ? "tag caution" : "tag"}>
                  {g.frames_seen} frame{g.frames_seen > 1 ? "s" : ""}
                </span>
              </div>
            </div>
          </div>
          <div>
            <div className="stat-lab" style={{ marginBottom: "var(--s-3)" }}>
              Seen at
            </div>
            <TimestampChips list={g.timestamps} />
          </div>
          <div>
            <div className="stat-lab" style={{ marginBottom: "var(--s-3)" }}>
              {unk ? "No student record" : "Student record"}
            </div>
            {unk ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
                <div className="muted" style={{ maxWidth: "60ch" }}>
                  {unkReason(unk)}.{" "}
                  {scored
                    ? "This face was detected but did not reach the review band against any enrolled passport, so it stays out of the attendance roll."
                    : "This face was detected, but the view was not reliable enough to compare it against enrolled passports, so it is not scored and stays out of the attendance roll."}
                </div>
                <div className="row" style={{ gap: "var(--s-3)" }}>
                  <Button
                    kind="secondary"
                    size="sm"
                    iconLeft={<Icon name="search" size={16} />}
                    onClick={() => onSearchFace(`${evidence}/crop`)}
                  >
                    Search this face
                  </Button>
                  <Button kind="text" size="sm" onClick={() => copyImage(`${evidence}/crop`)}>
                    Copy crop
                  </Button>
                </div>
              </div>
            ) : s ? (
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
              <div className="muted">This face matched a photo with no student record attached. File: {known?.title}</div>
            )}
          </div>
        </div>
      </div>
      {passport && candidate && (
        // Own stacking context, so its scrim covers the sighting modal underneath.
        <div style={{ position: "relative", zIndex: 50 }}>
          <CandidateModal
            candidate={candidate}
            eyebrow={unk ? "Closest enrolled face" : "Enrolled passport"}
            verdict={kind}
            onClose={() => setPassport(false)}
          />
        </div>
      )}
    </>
  );
}

function JobCard({
  job,
  uploadPct,
  filename,
  etaS,
  onRetry,
}: {
  job: VideoJob | null;
  uploadPct: number | null;
  filename: string;
  etaS: number | null;
  onRetry: () => void;
}) {
  const duration = job?.duration_s ? `${clock(job.duration_s)} clip` : null;
  if (job?.status === "failed") {
    return (
      <div className="job bad">
        <div className="job-head">
          <div className="row" style={{ gap: "var(--s-3)", flexWrap: "nowrap" }}>
            <Icon name="alert" size={20} color="var(--no)" />
            <div className="job-file">{job.filename}</div>
          </div>
          <span className="verdict no">Failed</span>
        </div>
        <div style={{ color: "var(--txt-1)", fontSize: "var(--text-body)", maxWidth: "60ch" }} title={job.detail ?? undefined}>
          {job.error ?? "Video processing failed."}
        </div>
        <div className="muted">The clip was removed from the worker. Nothing was written to the roll.</div>
        <div className="row">
          <Button kind="primary" size="sm" iconLeft={<Icon name="upload" size={16} />} onClick={onRetry}>
            Try another clip
          </Button>
        </div>
      </div>
    );
  }
  const p = job?.progress;
  const uploading = uploadPct !== null;
  const pct = uploading ? uploadPct : p && p.total ? Math.round((p.current / p.total) * 100) : 0;
  const title = uploading
    ? `Uploading ${uploadPct}%`
    : PHASE[p?.phase ?? ""] ?? (job?.status === "queued" ? "Waiting for the video worker…" : "Starting…");
  const sub = uploading
    ? "Keep this tab open until the upload finishes."
    : p && p.phase === "matching"
      ? `Frame ${formatNumber(p.current)} of ${formatNumber(p.total)} · ${formatNumber(p.faces_seen)} faces seen${etaS ? ` · about ${etaS} s left` : ""}`
      : job?.status === "queued"
        ? "Queued — it starts as soon as the worker is free."
        : "This takes a few seconds per minute of video.";
  return (
    <div className="job">
      <div className="job-head">
        <div className="row" style={{ gap: "var(--s-3)", flexWrap: "nowrap" }}>
          <Icon name="video" size={20} color="var(--accent-primary)" />
          <div className="job-file">{uploading ? filename : (job?.filename ?? filename)}</div>
        </div>
        {duration && <span className="tag">{duration}</span>}
      </div>
      <div className="spin-track">
        <div className="spin-fill" style={{ width: pct + "%" }}></div>
      </div>
      <div className="row" style={{ gap: "var(--s-4)", flexWrap: "nowrap" }}>
        <div className="spinner"></div>
        <div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-body)" }}>{title}</div>
          <div className="spin-sub">{sub}</div>
        </div>
      </div>
    </div>
  );
}

function RecentVideos({ rows, onOpen, onDelete }: { rows: VideoJob[]; onOpen: (j: VideoJob) => void; onDelete: (ids: string[]) => void }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [bulk, setBulk] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const badge = (j: VideoJob) => (j.status === "done" ? "match" : j.status === "failed" ? "no" : "review");
  const t = q.trim().toLowerCase();
  const hit = rows.filter((j) => !t || j.filename.toLowerCase().includes(t) || j.status.includes(t));
  const chosen = rows.filter((j) => picked.includes(j.id)); // ids that vanished on refresh drop out here
  const allOn = hit.length > 0 && hit.every((j) => picked.includes(j.id));
  // Changing the selection cancels a pending bulk confirmation.
  const pick = (next: string[]) => {
    setBulk(false);
    setPicked(next);
  };
  const toggle = (id: string) => pick(picked.includes(id) ? picked.filter((x) => x !== id) : picked.concat(id));
  return (
    <Panel title="Recent videos" meta={rows.length ? `${rows.length} processed` : undefined} pad={false}>
      <div className="card-pad">
        {!rows.length ? (
          <div className="empty">
            <Icon name="video" size={26} color="var(--txt-3)" />
            <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-body)", color: "var(--txt-2)" }}>
              No videos yet — upload a clip to build a roll.
            </div>
          </div>
        ) : (
          <>
            <div className="searchbar" style={{ height: 44, marginBottom: "var(--s-4)" }}>
              <Icon name="search" size={16} color="var(--txt-3)" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search a video analysis by filename or status"
                aria-label="Search recent videos"
              />
              {q && (
                <button
                  className="icon-btn"
                  style={{ width: 26, height: 26, border: 0, background: "none" }}
                  aria-label="Clear search"
                  onClick={() => setQ("")}
                >
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>
            <div className="vid-row" style={{ borderTop: 0, paddingTop: 0 }}>
              <label className="row" style={{ gap: "var(--s-3)", flex: 1, minWidth: 0, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={allOn}
                  disabled={!hit.length}
                  onChange={() => pick(allOn ? [] : hit.map((j) => j.id))}
                  aria-label="Select all shown videos"
                />
                <span className="muted">
                  {chosen.length ? `${chosen.length} selected` : `${hit.length} of ${rows.length} shown`}
                </span>
              </label>
              {chosen.length > 0 &&
                (bulk ? (
                  <div className="row" style={{ gap: "var(--s-2)", flexWrap: "nowrap" }}>
                    <span className="muted" style={{ maxWidth: "34ch" }}>
                      Delete results for {chosen.length} video{chosen.length > 1 ? "s" : ""}? The clips themselves were
                      already removed.
                    </span>
                    <Button
                      kind="primary"
                      size="sm"
                      onClick={() => {
                        onDelete(chosen.map((j) => j.id));
                        pick([]);
                      }}
                    >
                      Delete
                    </Button>
                    <Button kind="ghost" size="sm" onClick={() => setBulk(false)}>
                      Keep
                    </Button>
                  </div>
                ) : (
                  <div className="row" style={{ gap: "var(--s-2)", flexWrap: "nowrap" }}>
                    <Button kind="ghost" size="sm" iconLeft={<Icon name="trash" size={15} />} onClick={() => setBulk(true)}>
                      Delete results
                    </Button>
                    <Button kind="text" size="sm" onClick={() => pick([])}>
                      Clear
                    </Button>
                  </div>
                ))}
            </div>
            {!hit.length ? (
              <div className="empty" style={{ padding: "40px var(--s-6)" }}>
                <div className="muted">No video matches “{q}”.</div>
              </div>
            ) : (
              <div className="vid-list">
                {hit.map((j) => (
                  <div key={j.id} className="vid-row">
                    <input type="checkbox" checked={picked.includes(j.id)} onChange={() => toggle(j.id)} aria-label={"Select " + j.filename} />
                    <button className="vid-name" onClick={() => onOpen(j)}>
                      <b>{j.filename}</b>
                      <span className="muted">
                        {relativeTime(j.created_at)}
                        {j.duration_s ? ` · ${clock(j.duration_s)}` : ""}
                      </span>
                    </button>
                    <span className={"verdict " + badge(j)}>{j.status}</span>
                    <span className="muted" style={{ maxWidth: "34ch", textAlign: "right" }}>
                      {j.status === "failed"
                        ? j.error
                        : j.status === "done"
                          ? `${formatNumber(j.students)} student${j.students === 1 ? "" : "s"}`
                          : ""}
                    </span>
                    {confirm === j.id ? (
                      <div className="row" style={{ gap: "var(--s-2)", flexWrap: "nowrap" }}>
                        <span className="muted" style={{ maxWidth: "24ch" }}>
                          Delete this video's results? The clip itself was already removed.
                        </span>
                        <Button
                          kind="primary"
                          size="sm"
                          onClick={() => {
                            setConfirm(null);
                            pick(picked.filter((x) => x !== j.id));
                            onDelete([j.id]);
                          }}
                        >
                          Delete
                        </Button>
                        <Button kind="ghost" size="sm" onClick={() => setConfirm(null)}>
                          Keep
                        </Button>
                      </div>
                    ) : (
                      <button className="icon-btn" aria-label={"Delete results for " + j.filename} onClick={() => setConfirm(j.id)}>
                        <Icon name="trash" size={15} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

export default function VideoPage({ onSearchFace }: { onSearchFace: (path: string) => void }) {
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [active, setActive] = useState<VideoJob | null>(null);
  const [results, setResults] = useState<VideoResults | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<VideoSighting | VideoUnknown | null>(null);
  const [tab, setTab] = useState<"known" | "unknown" | null>(null); // null = pick for the operator
  const [drag, setDrag] = useState(false);
  const [etaS, setEtaS] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const rateRef = useRef<{ t0: number; c0: number } | null>(null);
  // Bumped on every selection change; in-flight responses check it so a late
  // upload/poll/results reply can never clobber a newer selection.
  const seqRef = useRef(0);
  function select(j: VideoJob | null) {
    seqRef.current++;
    rateRef.current = null;
    setEtaS(null);
    setUploadPct(null);
    setOpen(null);
    setTab(null);
    setResults(null);
    setActive(j);
  }

  async function loadJobs() {
    try {
      setJobs(await apiRequest<VideoJob[]>("/video"));
    } catch {
      /* the topbar already shows API reachability */
    }
  }
  useEffect(() => {
    loadJobs();
  }, []);
  // The list is not reconciled server-side; keep it fresh while anything is in flight.
  const inFlight = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    if (!inFlight) return;
    const id = window.setInterval(loadJobs, 10000);
    return () => window.clearInterval(id);
  }, [inFlight]);

  // Poll the active job until it settles, then fetch the roll.
  useEffect(() => {
    if (settled(active)) return;
    const seq = seqRef.current;
    const jobId = active!.id;
    const id = window.setInterval(async () => {
      try {
        const j = await apiRequest<VideoJob>(`/video/${jobId}`);
        if (seqRef.current !== seq) return;
        // ETA from the observed matching rate.
        const p = j.progress;
        if (p?.phase === "matching" && p.current > 0) {
          rateRef.current ??= { t0: Date.now(), c0: p.current };
          const done = p.current - rateRef.current.c0;
          const secs = (Date.now() - rateRef.current.t0) / 1000;
          setEtaS(done > 0 && secs > 1 ? Math.max(1, Math.round(((p.total - p.current) * secs) / done)) : null);
        } else {
          rateRef.current = null;
          setEtaS(null);
        }
        setActive(j);
        if (j.status === "done") {
          const r = await apiRequest<VideoResults>(`/video/${j.id}/results`);
          if (seqRef.current !== seq) return;
          setResults(r);
          loadJobs();
        } else if (j.status === "failed") {
          loadJobs(); // the job card is the failure surface
        }
      } catch (error) {
        if (seqRef.current !== seq) return;
        toast("error", "Lost track of the job", errorMessage(error));
        select(null);
      }
    }, 1500);
    return () => window.clearInterval(id);
  }, [active?.id, active?.status]);

  async function upload(file: File | undefined | null) {
    if (!file) return;
    select(null);
    const seq = seqRef.current;
    setUploadName(file.name);
    setUploadPct(0);
    const form = new FormData();
    form.append("file", file, file.name);
    try {
      const { job_id } = await uploadWithProgress<{ job_id: string }>("/video", form, setUploadPct);
      if (seqRef.current !== seq) return loadJobs(); // user moved on; the job still shows in Recent
      try {
        const job = await apiRequest<VideoJob>(`/video/${job_id}`);
        if (seqRef.current !== seq) return;
        setActive(job);
      } catch (error) {
        toast("error", "Uploaded, but couldn't open the job", errorMessage(error));
      }
      loadJobs();
    } catch (error) {
      if (seqRef.current === seq) toast("error", "Couldn't upload the video", errorMessage(error));
    } finally {
      if (seqRef.current === seq) setUploadPct(null);
    }
  }

  async function openJob(j: VideoJob) {
    select(j);
    setFilter("all");
    if (j.status !== "done") return;
    const seq = seqRef.current;
    try {
      const r = await apiRequest<VideoResults>(`/video/${j.id}/results`);
      if (seqRef.current !== seq) return;
      setResults(r);
    } catch (error) {
      if (seqRef.current !== seq) return;
      toast("error", "Couldn't load the roll", errorMessage(error));
      select(null);
    }
  }

  async function remove(ids: string[]) {
    const outcomes = await Promise.allSettled(ids.map((id) => apiRequest(`/video/${id}`, { method: "DELETE" })));
    const failed = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    if (failed.length) {
      toast("error", `Couldn't delete ${failed.length} of ${ids.length}`, errorMessage(failed[0].reason));
    } else {
      toast("ok", ids.length === 1 ? "Results deleted" : `Results deleted for ${ids.length} videos`);
    }
    if (active && ids.includes(active.id)) select(null);
    loadJobs();
  }

  function closeRoll() {
    select(null);
  }

  const busy = uploadPct !== null || (active !== null && !settled(active));
  const failed = active?.status === "failed";
  const roll = active?.status === "done" && results !== null;
  const sightings = results?.sightings ?? [];
  const unknowns = results?.unknowns ?? [];
  // Nothing identified but faces were found: open on what there is to look at.
  const activeTab = tab ?? (sightings.length === 0 && unknowns.length > 0 ? "unknown" : "known");
  const counts = {
    all: sightings.length,
    match: sightings.filter((g) => g.verdict === "MATCH").length,
    review: sightings.filter((g) => g.verdict === "REVIEW").length,
  };
  const shown = sightings
    .filter((g) => filter === "all" || kindOf(g.verdict) === filter)
    .sort((a, b) => b.confidence_pct - a.confidence_pct);

  const emptyRoll = (
    <div className="card">
      <div className="empty">
        <Icon name="video" size={28} color="var(--txt-3)" />
        <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-h4)", color: "var(--txt-1)" }}>
          No enrolled students identified · {formatNumber(results?.job.faces_seen ?? 0)} faces seen
        </div>
        <div className="muted" style={{ maxWidth: "52ch" }}>
          Faces smaller than about 80 px, turned away from the camera, or only weakly detected stay off the roll. A
          closer or better-lit export usually returns one.
        </div>
        <Button kind="primary" size="sm" iconLeft={<Icon name="upload" size={16} />} onClick={() => fileRef.current?.click()}>
          Upload another clip
        </Button>
      </div>
    </div>
  );

  return (
    <div className="page">
      <input
        ref={fileRef}
        type="file"
        accept="video/*,.mp4,.mov,.avi,.mkv,.webm"
        hidden
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          upload((e.target.files || [])[0]);
          e.target.value = "";
        }}
      />
      <div className="page-head">
        <div>
          <div className="eyebrow">Attendance roll</div>
          <h1>Video match</h1>
          <p>
            Upload a short clip and VisageIQ returns every enrolled student it can identify in it, with timestamps and
            frame evidence. The video is deleted once processing finishes.
          </p>
        </div>
        {roll && (
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <Button kind="ghost" size="sm" iconLeft={<Icon name="x" size={16} />} onClick={closeRoll}>
              Close roll
            </Button>
            <Button kind="primary" size="sm" iconLeft={<Icon name="upload" size={16} />} onClick={() => fileRef.current?.click()}>
              New clip
            </Button>
          </div>
        )}
      </div>

      {!busy && !failed && !roll && (
        <div className="card card-pad">
          <div
            className={"dropzone" + (drag ? " drag" : "")}
            style={{
              padding: "40px var(--s-6)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--s-3)",
              alignItems: "center",
            }}
            onDragOver={(e: DragEvent) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e: DragEvent) => {
              e.preventDefault();
              setDrag(false);
              upload(e.dataTransfer.files[0]);
            }}
          >
            <Icon name="video" size={28} color="var(--accent-primary)" />
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-h4)", color: "var(--txt-1)" }}>
              Drop a clip or browse
            </div>
            <div className="muted">MP4, MOV, AVI, MKV or WebM · up to 500 MB · up to 15 minutes</div>
            <div className="row" style={{ marginTop: "var(--s-3)" }}>
              <Button kind="primary" size="sm" iconLeft={<Icon name="upload" size={16} />} onClick={() => fileRef.current?.click()}>
                Browse files
              </Button>
            </div>
          </div>
        </div>
      )}

      {(busy || failed) && (
        <JobCard
          job={active}
          uploadPct={uploadPct}
          filename={uploadName}
          etaS={etaS}
          onRetry={() => {
            closeRoll();
            fileRef.current?.click();
          }}
        />
      )}

      {roll && (
        <>
          <div className="roll-band">
            <span className="pip">
              <b>{formatNumber(counts.all)}</b> students identified
            </span>
            <span className="pip">
              <b>{formatNumber(unknowns.length)}</b> unidentified faces
            </span>
            <span className="pip">
              <b>{formatNumber(results.job.sampled_frames)}</b> frames analysed
            </span>
            {results.job.duration_s != null && (
              <span className="pip">
                <b>{clock(results.job.duration_s)}</b> clip
              </span>
            )}
            <span className="muted" style={{ marginLeft: "auto", maxWidth: "30ch", textAlign: "right" }}>
              {results.job.filename} · uploaded {relativeTime(results.job.created_at)} · video deleted
            </span>
          </div>
          {sightings.length === 0 && unknowns.length === 0 ? (
            emptyRoll
          ) : (
            <>
              <div className="vtabs" role="tablist">
                <button className="vtab" role="tab" aria-selected={activeTab === "known"} onClick={() => setTab("known")}>
                  Identified students<span className="vtab-n">{sightings.length}</span>
                </button>
                <button className="vtab" role="tab" aria-selected={activeTab === "unknown"} onClick={() => setTab("unknown")}>
                  Unidentified faces<span className="vtab-n">{unknowns.length}</span>
                </button>
              </div>
              {activeTab === "unknown" ? (
                <>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="muted" style={{ maxWidth: "64ch" }}>
                      Faces the detector found but could not tie to an enrolled passport. They are not counted in the
                      attendance roll.{unknowns.length >= 60 ? " Only the first 60 are kept." : ""}
                    </span>
                    <span className="muted">Most seen first</span>
                  </div>
                  <div className="roll-grid">
                    {unknowns.map((u) => (
                      <UnknownCard key={u.idx} jobId={results.job.id} g={u} onOpen={setOpen} />
                    ))}
                  </div>
                </>
              ) : sightings.length === 0 ? (
                emptyRoll
              ) : (
                <>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <div className="row">
                      {(
                        [
                          ["all", "All"],
                          ["match", "Match"],
                          ["review", "Review"],
                        ] as [Filter, string][]
                      ).map(([k, l]) => (
                        <button key={k} className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
                          {l}
                          <span style={{ opacity: 0.7, marginLeft: 2 }}>{counts[k]}</span>
                        </button>
                      ))}
                    </div>
                    <span className="muted">Sorted by confidence, highest first</span>
                  </div>
                  <div className="roll-grid">
                    {shown.map((g) => (
                      <RollCard key={g.drive_file_id} jobId={results.job.id} g={g} onOpen={setOpen} />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}

      {!roll && <RecentVideos rows={jobs} onOpen={openJob} onDelete={remove} />}

      {open && results && (
        <SightingModal
          jobId={results.job.id}
          g={open}
          onClose={() => setOpen(null)}
          onSearchFace={onSearchFace}
        />
      )}
    </div>
  );
}
