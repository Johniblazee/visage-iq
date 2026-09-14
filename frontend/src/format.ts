export function formatNumber(value: number | null | undefined): string {
  return Number(value || 0).toLocaleString();
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// Mirrors backend/scoring.py — keep in sync. Raw ArcFace cosine never reaches
// 1.0, so display uses one fixed piecewise scale: impostor ceiling 0.23 -> 0%,
// 0.40 -> 50%, 0.50 -> 75%, genuine ceiling 0.85 -> 100%. The threshold knobs
// live on this scale too (stock knobs read 75% / 50%).
const XS = [0.23, 0.4, 0.5, 0.85];
const YS = [0, 50, 75, 100];
export function cosinePct(similarity: number): number {
  if (similarity <= XS[0]) return 0;
  for (let i = 1; i < XS.length; i++) {
    if (similarity <= XS[i]) return YS[i - 1] + ((similarity - XS[i - 1]) / (XS[i] - XS[i - 1])) * (YS[i] - YS[i - 1]);
  }
  return 100;
}
export function pctCosine(pct: number): number {
  if (pct <= 0) return XS[0];
  for (let i = 1; i < YS.length; i++) {
    if (pct <= YS[i]) return XS[i - 1] + ((pct - YS[i - 1]) / (YS[i] - YS[i - 1])) * (XS[i] - XS[i - 1]);
  }
  return XS[XS.length - 1];
}
