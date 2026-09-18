/* Miva design-system primitives + VisageIQ shared components, ported from the
   Claude Design project (miva-design-system _ds_bundle.js + visageiq/shared.jsx). */
import { type CSSProperties, type ReactNode, useEffect, useId, useState } from "react";

/* ── Icon ────────────────────────────────────────────────── */
const GLYPHS: Record<string, ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  menu: (
    <>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="M12 8l1.6 2.4L16 12l-2.4 1.6L12 16l-1.6-2.4L8 12l2.4-1.6z" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <path d="M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </>
  ),
  video: (
    <>
      <path d="M22 8l-6 4 6 4V8z" />
      <rect x="2" y="5.5" width="14" height="13" rx="2.5" />
    </>
  ),
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <path d="M12 3v12" />
    </>
  ),
  trash: (
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  x: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
  check: <polyline points="20 6 9 17 4 12" />,
  arrowRight: (
    <>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </>
  ),
  chevronLeft: <polyline points="15 6 9 12 15 18" />,
  chevronRight: <polyline points="9 6 15 12 9 18" />,
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <polyline points="21 3 21 8 16 8" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <polyline points="3 21 3 16 8 16" />
    </>
  ),
  user: (
    <>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </>
  ),
  fileText: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </>
  ),
};

export function Icon({
  name,
  size = 20,
  color = "currentColor",
  style,
}: {
  name: keyof typeof GLYPHS | string;
  size?: number;
  color?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0, ...style }}
    >
      {GLYPHS[name] || null}
    </svg>
  );
}

/* ── VisageIQ brand (from the "VisageIQ logo" design page) ──
   Lens + V chevron + handle on a 48-unit grid. Slate carries structure,
   signal orange marks the chevron; on dark surfaces both lighten. Below
   20px the strokes thicken and the handle shortens so the aperture stays open. */
const VQ = {
  struct: "#1E2733",
  structOnDark: "#FFFFFF",
  accent: "#C4602E",
  accentOnDark: "#E0854F",
};

export function VqMark({ size = 26, onDark }: { size?: number; onDark?: boolean }) {
  const small = size < 20;
  // onDark unspecified → follow the theme (safe: theme changes re-render the tree).
  const dark = onDark ?? document.documentElement.getAttribute("data-theme") === "dark";
  const struct = dark ? VQ.structOnDark : VQ.struct;
  const accent = dark ? VQ.accentOnDark : VQ.accent;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0, overflow: "visible" }}
    >
      <circle cx="21" cy="21" r="14" stroke={struct} strokeWidth={small ? 4.2 : 3.4} />
      <path
        d="M14 14 L21 30 L28 14"
        stroke={accent}
        strokeWidth={small ? 4.2 : 3.4}
        strokeLinecap="round"
      />
      <path
        d={small ? "M32 32 L40 40" : "M31 31 L42 42"}
        stroke={struct}
        strokeWidth={small ? 5 : 4.4}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function VqLockup({
  mark = 26,
  type = 16,
  onDark,
}: {
  mark?: number;
  type?: number;
  onDark?: boolean;
}) {
  const dark = onDark ?? document.documentElement.getAttribute("data-theme") === "dark";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.42em", lineHeight: 1 }}>
      <VqMark size={mark} onDark={dark} />
      <span
        style={{
          fontFamily: "'Space Grotesk', var(--font-body)",
          fontWeight: 500,
          fontSize: type,
          letterSpacing: "-0.028em",
          color: dark ? "#fff" : VQ.struct,
          whiteSpace: "nowrap",
        }}
      >
        Visage
        <b style={{ fontWeight: 700, color: dark ? VQ.accentOnDark : VQ.accent }}>IQ</b>
      </span>
    </span>
  );
}

/* ── Toasts (design "Auth screens" component set) ──────────
   Top-right, 392px, one at a time. error/warn persist until dismissed;
   ok/info auto-dismiss after 5s with a life bar. */
export type ToastKind = "error" | "warn" | "ok" | "info";
interface ToastMsg {
  kind: ToastKind;
  title: string;
  body?: string;
}
let pushToast: ((t: ToastMsg) => void) | null = null;

export function toast(kind: ToastKind, title: string, body?: string) {
  pushToast?.({ kind, title, body });
}

const TOAST_ICON: Record<ToastKind, string> = { error: "alert", warn: "alert", ok: "check", info: "info" };

export function ToastHost() {
  const [current, setCurrent] = useState<(ToastMsg & { id: number }) | null>(null);
  useEffect(() => {
    let id = 0;
    pushToast = (t) => setCurrent({ ...t, id: ++id });
    return () => {
      pushToast = null;
    };
  }, []);
  const autoDismiss = current && (current.kind === "ok" || current.kind === "info");
  useEffect(() => {
    if (!autoDismiss) return;
    const t = setTimeout(() => setCurrent(null), 5000);
    return () => clearTimeout(t);
  }, [current, autoDismiss]);
  if (!current) return null;
  return (
    <div className={"toast toast-live " + current.kind} key={current.id} role="status">
      <span className="ic">
        <Icon name={TOAST_ICON[current.kind]} size={15} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{current.title}</b>
        {current.body && <p>{current.body}</p>}
      </div>
      <button className="x" onClick={() => setCurrent(null)} aria-label="Dismiss">
        <Icon name="x" size={15} />
      </button>
      {autoDismiss && <span className="life"></span>}
    </div>
  );
}

/* ── Loader (design "Loader options" — Option 8: dots + rotating copy) ── */
export const SEARCH_LOADER_MSGS = [
  "Detecting faces in the probe image…",
  "Computing the 512-dimension embedding…",
  "Sweeping the enrolment index…",
  "Measuring cosine distance across the shortlist…",
  "Discarding low-confidence neighbours…",
  "Re-ranking the shortlist…",
  "Resolving near-identical twins…",
  "Applying your review thresholds…",
  "Assembling the verdicts…",
];

export function VqLoader({ messages, sub, lockup = false }: { messages: string[]; sub?: string; lockup?: boolean }) {
  const [index, setIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const msg = setInterval(() => setIndex((i) => (i + 1) % messages.length), 1300);
    const tick = setInterval(() => setElapsed((s) => s + 0.1), 100);
    return () => {
      clearInterval(msg);
      clearInterval(tick);
    };
  }, [messages.length]);
  return (
    <div className="vq-load">
      {lockup && (
        <div style={{ marginBottom: "var(--s-2)" }}>
          <VqLockup mark={24} type={15} />
        </div>
      )}
      <div className="vq-dots">
        <i></i>
        <i></i>
        <i></i>
        <i></i>
      </div>
      <div className="msg">{messages[index]}</div>
      <div className="mono">
        {sub ? sub + " · " : ""}
        {elapsed.toFixed(1)}s elapsed
      </div>
    </div>
  );
}

/* ── Badge ───────────────────────────────────────────────── */
const BADGE_TONES: Record<string, CSSProperties> = {
  neutral: { background: "var(--surface-3)", color: "var(--txt-2)" },
  blue: { background: "rgba(15,23,42,0.08)", color: "var(--ink)" },
  red: { background: "rgba(228,59,49,0.10)", color: "var(--miva-red-mid)" },
  gold: { background: "var(--miva-gold-soft)", color: "var(--miva-gold-deep)" },
};
export function Badge({ tone = "neutral", children }: { tone?: keyof typeof BADGE_TONES; children: ReactNode }) {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  return (
    <span
      style={{
        ...BADGE_TONES[tone],
        ...(dark && tone === "blue" ? { background: "rgba(255,255,255,0.14)", color: "#fff" } : null),
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--s-1)",
        padding: "5px 12px",
        borderRadius: "var(--r-pill)",
        fontFamily: "var(--font-body)",
        fontSize: "var(--text-caption)",
        fontWeight: 600,
        lineHeight: 1.3,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/* ── Button ──────────────────────────────────────────────── */
const KINDS: Record<string, CSSProperties> = {
  primary: { background: "var(--miva-red)", color: "var(--miva-white)", border: "1.5px solid transparent" },
  secondary: { background: "var(--ink)", color: "var(--miva-white)", border: "1.5px solid transparent" },
  ghost: { background: "transparent", color: "var(--ink)", border: "1.5px solid var(--ink)" },
  text: { background: "transparent", color: "var(--miva-red)", border: "1.5px solid transparent" },
};
/* The DS Button styles inline off Deep Heritage Blue and ships no dark variant —
   ghost/secondary/text need retinting on dark surfaces to stay legible. */
const DARK_KIND: Record<string, CSSProperties> = {
  ghost: { color: "#F2F6F9", border: "1.5px solid rgba(255,255,255,.30)" },
  secondary: { background: "rgba(255,255,255,.12)", color: "#fff", border: "1.5px solid rgba(255,255,255,.24)" },
  text: { color: "#FF8B84" },
};
const SIZES: Record<string, CSSProperties> = {
  sm: { padding: "9px 16px", fontSize: "var(--text-small)", borderRadius: "var(--r-sm)" },
  md: { padding: "12px 22px", fontSize: "var(--text-small)", borderRadius: "var(--r-sm)" },
};

export function Button({
  kind = "primary",
  size = "md",
  disabled = false,
  iconLeft,
  iconRight,
  onClick,
  style,
  children,
}: {
  kind?: keyof typeof KINDS;
  size?: keyof typeof SIZES;
  disabled?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  onClick?: () => void;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  // Reading the DOM attribute during render is safe here: the theme toggle
  // lives in App state, so every theme change re-renders the whole tree.
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const retint = dark ? DARK_KIND[kind] : undefined;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        ...KINDS[kind],
        ...SIZES[size],
        ...(kind === "text" ? { padding: `${String(SIZES[size].padding).split(" ")[0]} 0` } : null),
        ...retint,
        fontFamily: "var(--font-body)",
        fontWeight: 600,
        lineHeight: 1.2,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--s-2)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transition: "opacity var(--dur-fast) var(--ease-out), transform 100ms var(--ease-out)",
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.opacity = "0.78";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = disabled ? "0.45" : "1";
        e.currentTarget.style.transform = "";
      }}
      onMouseDown={(e) => {
        if (!disabled) e.currentTarget.style.transform = "scale(0.96)";
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.transform = "";
      }}
    >
      {iconLeft}
      {children}
      {iconRight}
    </button>
  );
}

/* ── Form fields (Input / Select / Checkbox) ─────────────── */
const labelStyle: CSSProperties = {
  display: "block",
  fontFamily: "var(--font-body)",
  fontSize: "var(--text-small)",
  fontWeight: 600,
  color: "var(--fg-1)",
  marginBottom: "var(--s-2)",
};

export function Input({
  label,
  value,
  placeholder,
  onChange,
  onEnter,
  style,
}: {
  label?: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  style?: CSSProperties;
}) {
  const [focus, setFocus] = useState(false);
  const id = useId();
  return (
    <div style={{ display: "block", ...style }}>
      {label && (
        <label htmlFor={id} style={labelStyle}>
          {label}
        </label>
      )}
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter?.();
        }}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          width: "100%",
          background: "var(--bg-page)",
          border: `1.5px solid ${focus ? "var(--focus)" : "var(--border-2)"}`,
          borderRadius: "var(--r-sm)",
          padding: "11px var(--s-3)",
          outline: "none",
          fontFamily: "var(--font-body)",
          fontSize: "var(--text-small)",
          color: "var(--fg-1)",
          transition: "border-color var(--dur-fast) var(--ease-out)",
        }}
      />
    </div>
  );
}

export function Select({
  label,
  options,
  value,
  placeholder,
  onChange,
  style,
}: {
  label?: string;
  options: { value: string; label: string }[] | string[];
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  style?: CSSProperties;
}) {
  const [focus, setFocus] = useState(false);
  const id = useId();
  const items = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <div style={{ display: "block", ...style }}>
      {label && (
        <label htmlFor={id} style={labelStyle}>
          {label}
        </label>
      )}
      <div style={{ position: "relative" }}>
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            width: "100%",
            appearance: "none",
            WebkitAppearance: "none",
            background: "var(--bg-page)",
            border: `1.5px solid ${focus ? "var(--focus)" : "var(--border-2)"}`,
            borderRadius: "var(--r-sm)",
            padding: "11px 40px 11px var(--s-3)",
            outline: "none",
            fontFamily: "var(--font-body)",
            fontSize: "var(--text-small)",
            color: "var(--fg-1)",
            cursor: "pointer",
            transition: "border-color var(--dur-fast) var(--ease-out)",
          }}
        >
          {placeholder != null && <option value="">{placeholder}</option>}
          {items.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--fg-2)"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
    </div>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const [focus, setFocus] = useState(false);
  return (
    <label style={{ display: "flex", gap: "var(--s-3)", alignItems: "center", cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
      />
      <span
        style={{
          width: 20,
          height: 20,
          flexShrink: 0,
          borderRadius: "var(--r-xs)",
          background: checked ? "var(--focus)" : "var(--bg-page)",
          border: `1.5px solid ${checked ? "var(--focus)" : "var(--border-2)"}`,
          display: "grid",
          placeItems: "center",
          boxShadow: focus ? "0 0 0 3px color-mix(in srgb, var(--focus) 45%, transparent)" : undefined,
          transition: "background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)",
        }}
      >
        {checked && (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--miva-white)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </span>
      <span style={{ fontSize: "var(--text-small)", fontWeight: 500, color: "var(--fg-1)" }}>{label}</span>
    </label>
  );
}

/* ── VisageIQ shared pieces ──────────────────────────────── */
export type VerdictKind = "match" | "review" | "no";
export const VERDICT_LABEL: Record<VerdictKind, string> = { match: "Match", review: "Review", no: "No match" };

export function verdictOf(value: number, match: number, review: number): VerdictKind {
  return value >= match ? "match" : value >= review ? "review" : "no";
}
export function scoreColour(kind: VerdictKind): string {
  return kind === "match" ? "var(--ok)" : kind === "review" ? "var(--accent-warm)" : "var(--miva-grey-4)";
}

export function Verdict({ kind }: { kind: VerdictKind }) {
  return <span className={"verdict " + kind}>{VERDICT_LABEL[kind]}</span>;
}

export function ScoreBar({ value, kind }: { value: number; kind: VerdictKind }) {
  return (
    <div className="score-track">
      <div
        className="score-fill"
        style={{ width: Math.min(100, Math.max(2, value)) + "%", background: scoreColour(kind) }}
      ></div>
    </div>
  );
}

export function Panel({
  title,
  meta,
  action,
  children,
  pad = true,
}: {
  title?: string;
  meta?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  pad?: boolean;
}) {
  return (
    <section className="card">
      {(title || action) && (
        <header className="card-head">
          <div>
            <h3>{title}</h3>
            {meta && (
              <div className="muted" style={{ marginTop: 2 }}>
                {meta}
              </div>
            )}
          </div>
          {action}
        </header>
      )}
      <div className={pad ? "card-pad" : ""}>{children}</div>
    </section>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}) {
  return (
    <div className="row" style={{ gap: "var(--s-4)", flexWrap: "nowrap" }}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <span className="slider-val">{format ? format(value) : value}</span>
    </div>
  );
}

export function SettingRow({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children?: ReactNode;
}) {
  return (
    <div className="set-row">
      <div>
        <h4>{title}</h4>
        <p>{desc}</p>
      </div>
      <div>{children}</div>
    </div>
  );
}
