export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

export async function apiRequest<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
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

export interface Candidate {
  drive_file_id: string;
  title: string;
  similarity: number;
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
