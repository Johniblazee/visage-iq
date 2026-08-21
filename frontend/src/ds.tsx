/* Miva design-system primitives + VisageIQ shared components, ported from the
   Claude Design project (miva-design-system _ds_bundle.js + visageiq/shared.jsx). */
import { type CSSProperties, type ReactNode, useState } from "react";

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

/* ── Miva mark (official brand mark — never redraw... this is the DS's own SVG, inlined) ── */
export function MivaMark({ height = 30 }: { height?: number }) {
  return (
    <svg
      width={(97 / 93) * height}
      height={height}
      viewBox="0 0 97 93"
      fill="none"
      aria-label="Miva Open University"
      style={{ display: "block", flexShrink: 0 }}
    >
      <path d="M0 7.46362V92.9999L22.2021 47.9098L0 7.46362Z" fill="white" />
      <path d="M1.26611 3.97998L48.7542 82.7015V49.5485L1.26611 3.97998Z" fill="#E43B31" />
      <path d="M3.0025 0L48.7573 42.5932V24.858L3.0025 0Z" fill="#B79A7F" />
      <path d="M97.0683 7.46362V92.9999L74.8662 47.9098L97.0683 7.46362Z" fill="white" />
      <path d="M95.8173 3.97998L48.3141 82.7015V49.5485L95.8173 3.97998Z" fill="#E43B31" />
      <path d="M94.084 0L48.3171 42.5932V24.858L94.084 0Z" fill="white" />
    </svg>
  );
}

/* ── Button ──────────────────────────────────────────────── */
const KINDS: Record<string, CSSProperties> = {
  primary: { background: "var(--miva-red)", color: "var(--miva-white)", border: "1.5px solid transparent" },
  secondary: { background: "var(--miva-blue)", color: "var(--miva-white)", border: "1.5px solid transparent" },
  ghost: { background: "transparent", color: "var(--miva-blue)", border: "1.5px solid var(--miva-blue)" },
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
  return (
    <div style={{ display: "block", ...style }}>
      {label && <label style={labelStyle}>{label}</label>}
      <input
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
          border: `1.5px solid ${focus ? "var(--miva-blue)" : "var(--border-2)"}`,
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
  const items = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <div style={{ display: "block", ...style }}>
      {label && <label style={labelStyle}>{label}</label>}
      <div style={{ position: "relative" }}>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            width: "100%",
            appearance: "none",
            WebkitAppearance: "none",
            background: "var(--bg-page)",
            border: `1.5px solid ${focus ? "var(--miva-blue)" : "var(--border-2)"}`,
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
  return (
    <label style={{ display: "flex", gap: "var(--s-3)", alignItems: "center", cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
      />
      <span
        style={{
          width: 20,
          height: 20,
          flexShrink: 0,
          borderRadius: "var(--r-xs)",
          background: checked ? "var(--miva-blue)" : "var(--bg-page)",
          border: `1.5px solid ${checked ? "var(--miva-blue)" : "var(--border-2)"}`,
          display: "grid",
          placeItems: "center",
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
