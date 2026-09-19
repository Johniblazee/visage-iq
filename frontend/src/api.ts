export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

// Set by auth.tsx when Clerk is active; null in no-auth dev mode.
let getAuthToken: (() => Promise<string | null>) | null = null;
export function setAuthTokenGetter(fn: (() => Promise<string | null>) | null) {
  getAuthToken = fn;
}

export async function apiRequest<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  if (getAuthToken) {
    const token = await getAuthToken();
    if (token) {
      options = { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } };
    }
  }
  const response = await fetch(apiUrl(path), options);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null
        ? body.detail || JSON.stringify(body)
        : body || response.statusText;
    throw new Error(message);
  }

  return body as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Shapes of the FastAPI responses (see backend README "API endpoints").

export interface Health {
  enrolled_count: number;
  drive_total: number | null;
  last_sync_finished_at: string | null;
  active_sync_job_id: string | null;
  model?: string;
}

export interface ModelInfo {
  name: string;
  primary: boolean;
  enrolled_count: number;
}

// GET/PATCH /config — dial values shared by every client and the API itself.
export interface AppConfig {
  match_threshold: number;
  review_threshold: number;
  top_k: number;
  model: string;
  models: ModelInfo[];
}

export interface WorkerStatus {
  suspended: boolean;
}

export interface SyncProgress {
  phase?: string;
  current?: number;
  total?: number;
  listed?: number;
}

export interface SyncJob {
  job_id: string;
  status: string;
  progress: SyncProgress | null;
}

export interface CandidateStudent {
  full_name: string;
  student_id?: string | null;
  location?: string | null;
  programme?: string | null;
}

export interface Candidate {
  drive_file_id: string;
  title: string;
  similarity: number;
  student?: CandidateStudent | null;
}

export interface Face {
  bbox: number[];
  det_score: number;
  candidates: Candidate[];
}

export interface MatchResponse {
  faces: Face[];
  query_face_count: number;
  query_rotation?: number;
  enrolled_count: number;
  model?: string;
}

export interface AnalyticsSummary {
  totals?: { file_status_total?: number; persons_total?: number };
  by_outcome?: Record<string, number>;
  by_ext?: Record<string, number>;
  by_outcome_and_ext?: { ext: string; outcome: string; count: number }[];
}

export interface FileRow {
  drive_file_id: string;
  drive_file_name: string;
  ext?: string;
  outcome: string;
  reason?: string;
  rotation?: number | null;
  det_score?: number | null;
  last_seen_at?: string | null;
}

export interface FilePage {
  rows: FileRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface StudentRow {
  id: number;
  natural_key: string;
  student_id?: string | null;
  full_name: string;
  email?: string | null;
  location?: string | null;
  programme?: string | null;
  cohort?: string | null;
  level_semester?: string | null;
  photo_drive_file_id?: string | null;
}

export interface StudentPage {
  rows: StudentRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface StudentSyncSummary {
  at?: string;
  ok?: boolean;
  error?: string | null;
  detail?: string | null;
  rows?: number;
  upserted?: number;
  deleted?: number;
  skipped_no_key?: number;
}

export interface StudentFacets {
  locations: string[];
  programmes: string[];
  cohorts: string[];
  levels: string[];
  total: number;
  last_sync?: StudentSyncSummary | null;
}

export interface AuditRow {
  id: number;
  ts?: string | null;
  actor: string;
  action: string;
  target?: string | null;
  details?: Record<string, unknown> | null;
}

export interface VideoJob {
  id: string;
  actor: string;
  filename: string;
  size_bytes: number;
  status: "queued" | "running" | "done" | "failed";
  error?: string | null;
  detail?: string | null;
  duration_s?: number | null;
  fps?: number | null;
  width?: number | null;
  height?: number | null;
  sampled_frames: number;
  faces_seen: number;
  unknown_faces: number;
  students: number;
  match_threshold?: number | null;
  review_threshold?: number | null;
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  progress?: { phase: string; current: number; total: number; faces_seen: number } | null;
}

export interface VideoSighting {
  drive_file_id: string;
  title?: string | null;
  student?: CandidateStudent | null;
  best_similarity: number;
  confidence_pct: number;
  verdict: "MATCH" | "REVIEW" | "NO_MATCH";
  best_ts: number;
  first_ts: number;
  last_ts: number;
  frames_seen: number;
  timestamps: number[];
}

export interface VideoResults {
  job: VideoJob;
  sightings: VideoSighting[];
}

// Multipart upload with progress events — fetch() cannot report upload progress.
export function uploadWithProgress<T = unknown>(
  path: string,
  form: FormData,
  onProgress: (pct: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const send = async () => {
      const token = getAuthToken ? await getAuthToken() : null;
      const xhr = new XMLHttpRequest();
      xhr.open("POST", apiUrl(path));
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onerror = () => reject(new Error("The upload was interrupted — check your connection and try again."));
      xhr.onload = () => {
        const isJson = (xhr.getResponseHeader("content-type") || "").includes("application/json");
        let body: unknown = xhr.responseText;
        if (isJson) {
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            /* keep the raw text */
          }
        }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(body as T);
        const detail = typeof body === "object" && body !== null ? (body as { detail?: string }).detail : null;
        // The api's own 413 carries the configured limit; nginx's is an HTML page.
        reject(new Error(detail || (xhr.status === 413 ? "Video is too large." : isJson ? JSON.stringify(body) : xhr.statusText || `Upload failed (${xhr.status})`)));
      };
      xhr.send(form);
    };
    send().catch(reject);
  });
}
