/* Student search — backed by the live /students directory API. */
import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import type { Tab } from "../App";
import { apiRequest, apiUrl, errorMessage, type StudentFacets, type StudentPage, type StudentRow } from "../api";
import { formatNumber, relativeTime } from "../format";
import { Badge, Button, Checkbox, Icon, Select } from "../ds";

const PAGE_SIZE = 48;

const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("");
const AVATAR_TINTS = ["#E2E8F0", "#DCE7EF", "#EAE1D7", "#D9E9E2", "#F1E3DE", "#E2E5EE"];
const tintFor = (s: StudentRow) =>
  AVATAR_TINTS[(s.natural_key.charCodeAt(s.natural_key.length - 1) + s.full_name.length) % AVATAR_TINTS.length];

function Avatar({ student, size = 64, radius }: { student: StudentRow; size?: number; radius?: string }) {
  if (student.photo_drive_file_id) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: radius || "var(--r-md)",
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <img
          src={apiUrl("/image/" + encodeURIComponent(student.photo_drive_file_id))}
          alt={student.full_name}
          loading="lazy"
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </div>
    );
  }
  return (
    <div
      className="avatar"
      style={{
        width: size,
        height: size,
        background: tintFor(student),
        borderRadius: radius || "var(--r-md)",
        fontSize: size * 0.34,
      }}
    >
      <span style={{ opacity: 0.85 }}>{initials(student.full_name)}</span>
    </div>
  );
}

function StudentDrawer({
  student,
  onClose,
  onProbe,
}: {
  student: StudentRow | null;
  onClose: () => void;
  onProbe: () => void;
}) {
  if (!student) return null;
  const kvRows: [string, string | null | undefined][] = [
    ["Student ID", student.student_id ?? student.natural_key],
    ["Email", student.email],
    ["Location", student.location],
  ];
  return (
    <>
      <div className="scrim" onClick={onClose}></div>
      <aside className="drawer" role="dialog" aria-label={student.full_name}>
        <header className="card-head">
          <div>
            <div className="eyebrow">Student record</div>
            <h3 style={{ marginTop: 2 }}>{student.full_name}</h3>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="drawer-body">
          <div className="row" style={{ alignItems: "flex-start", gap: "var(--s-5)", flexWrap: "nowrap" }}>
            <Avatar student={student} size={124} radius="var(--r-lg)" />
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)", minWidth: 0 }}>
              <div>
                <Badge tone={student.photo_drive_file_id ? "blue" : "gold"}>
                  {student.photo_drive_file_id ? "Photo linked" : "No photo link"}
                </Badge>
              </div>
              <div>
                <Button kind="secondary" size="sm" iconLeft={<Icon name="search" size={16} />} onClick={onProbe}>
                  Use as probe
                </Button>
              </div>
            </div>
          </div>
          <dl className="kv">
            {kvRows
              .filter(([, v]) => v != null)
              .map(([k, v]) => (
                <Fragment key={k}>
                  <dt>{k}</dt>
                  <dd style={k === "Email" ? { wordBreak: "break-all" } : undefined}>{v}</dd>
                </Fragment>
              ))}
          </dl>
        </div>
      </aside>
    </>
  );
}

const FIELDS: { k: string; label: string }[] = [
  { k: "all", label: "All fields" },
  { k: "name", label: "Name" },
  { k: "sid", label: "Student ID" },
  { k: "email", label: "Email" },
  { k: "location", label: "Location" },
];

export default function StudentsPage({ onNav }: { onNav: (tab: Tab) => void }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [field, setField] = useState("all");
  const [location, setLocation] = useState("");
  const [photosOnly, setPhotosOnly] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<StudentPage>({ rows: [], total: 0, limit: PAGE_SIZE, offset: 0 });
  const [facets, setFacets] = useState<StudentFacets | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<StudentRow | null>(null);
  const fetchSeq = useRef(0);

  // Commit the search box to a query 300ms after typing stops (Enter commits immediately below).
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Any filter change restarts pagination at the first page.
  useEffect(() => {
    setOffset(0);
  }, [query, field, location, photosOnly]);

  useEffect(() => {
    (async () => {
      try {
        setFacets(await apiRequest<StudentFacets>("/students/facets"));
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
  }, []);

  useEffect(() => {
    // Sequence guard: a filter change while offset > 0 fires two fetches
    // (stale offset, then the reset-to-0 one) — only the latest may land.
    const seq = ++fetchSeq.current;
    (async () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), field });
      if (query) params.set("q", query);
      if (location) params.set("location", location);
      if (photosOnly) params.set("has_photo", "true");
      try {
        const result = await apiRequest<StudentPage>(`/students?${params.toString()}`);
        if (fetchSeq.current === seq) {
          setPage(result);
          setError("");
        }
      } catch (e) {
        if (fetchSeq.current === seq) setError(errorMessage(e));
      }
    })();
  }, [query, field, location, photosOnly, offset]);

  const active: [string, string, () => void][] = (
    [
      ["Location", location, () => setLocation("")],
      ["Photo", photosOnly ? "Has photo" : "", () => setPhotosOnly(false)],
    ] as [string, string, () => void][]
  ).filter((f) => f[1]);
  const clearAll = () => {
    setLocation("");
    setPhotosOnly(false);
  };

  const ellipsis: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Enrolment index</div>
          <h1>Student search</h1>
          <p>
            Look a student up by name, student ID, email or location, then open the record to see their
            enrolled photo.
          </p>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
        <div className="searchbar">
          <Icon name="search" size={20} color="var(--txt-3)" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setQuery(q);
            }}
            placeholder="e.g. a name, student ID, email or location"
          />
          {q && (
            <button
              className="icon-btn"
              onClick={() => {
                setQ("");
                setQuery("");
              }}
              aria-label="Clear search"
            >
              <Icon name="x" size={16} />
            </button>
          )}
        </div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row">
            {FIELDS.map((f) => (
              <button key={f.k} className="chip" aria-pressed={field === f.k} onClick={() => setField(f.k)}>
                {f.label}
              </button>
            ))}
          </div>
          <button className="chip" aria-pressed={showFilters} onClick={() => setShowFilters(!showFilters)}>
            <Icon name="grid" size={14} />
            Filters{active.length ? " · " + active.length : ""}
          </button>
        </div>
        {showFilters && (
          <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
            <div className="filter-grid">
              <Select
                label="Location"
                options={facets?.locations ?? []}
                placeholder="Any location"
                value={location}
                onChange={setLocation}
              />
              <div style={{ alignSelf: "end", paddingBottom: 6 }}>
                <Checkbox label="Has enrolled photo" checked={photosOnly} onChange={setPhotosOnly} />
              </div>
            </div>
            {active.length > 0 && (
              <div
                className="row"
                style={{ justifyContent: "space-between", borderTop: "1px solid var(--line)", paddingTop: "var(--s-4)" }}
              >
                <div className="row">
                  {active.map(([k, v, clear]) => (
                    <button key={k} className="chip" aria-pressed={true} onClick={clear}>
                      {k}: {v}
                      <Icon name="x" size={12} />
                    </button>
                  ))}
                </div>
                <Button kind="text" size="sm" onClick={clearAll}>
                  Clear all filters
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      {error && <div className="alert">{error}</div>}
      {facets?.last_sync?.error && (
        <div className="alert" title={facets.last_sync.detail || undefined}>
          Student sync failed — {facets.last_sync.error}
        </div>
      )}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="muted">
          {formatNumber(page.total)} matches · showing {page.rows.length}
        </div>
        <div className="muted">
          {facets?.last_sync?.at ? "Directory synced " + relativeTime(facets.last_sync.at) : "Directory never synced"}
        </div>
      </div>
      {page.rows.length === 0 ? (
        <div className="card empty">
          <Icon name="user" size={28} color="var(--txt-3)" />
          <div style={{ fontSize: "var(--text-body)", color: "var(--txt-2)" }}>No student matches that query.</div>
          <Button
            kind="ghost"
            size="sm"
            onClick={() => {
              setQ("");
              setQuery("");
              clearAll();
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <div className="stud-grid">
          {page.rows.map((s) => (
            <button key={s.id} className="stud" onClick={() => setOpen(s)}>
              <div className="stud-photo" style={s.photo_drive_file_id ? undefined : { background: tintFor(s) }}>
                {s.photo_drive_file_id ? (
                  <img
                    src={apiUrl("/image/" + encodeURIComponent(s.photo_drive_file_id))}
                    alt={s.full_name}
                    loading="lazy"
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : (
                  <>
                    {initials(s.full_name)}
                    <span style={{ position: "absolute", bottom: 8, right: 8 }}>
                      <span className="tag">No photo</span>
                    </span>
                  </>
                )}
              </div>
              <div className="stud-body">
                <div className="stud-name">{s.full_name}</div>
                <div className="stud-line">{s.student_id ?? s.natural_key}</div>
                {s.email && (
                  <div className="stud-line" style={ellipsis} title={s.email}>
                    {s.email}
                  </div>
                )}
                {s.location && (
                  <div className="stud-line" style={{ color: "var(--txt-2)", marginTop: 4 }}>
                    {s.location}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
      {page.total > PAGE_SIZE && (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="muted">
            Page {Math.floor(offset / PAGE_SIZE) + 1} of {formatNumber(Math.max(1, Math.ceil(page.total / PAGE_SIZE)))}
          </div>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <Button
              kind="ghost"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              kind="ghost"
              size="sm"
              disabled={offset + PAGE_SIZE >= page.total}
              iconRight={<Icon name="chevronRight" size={16} />}
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
      <StudentDrawer
        student={open}
        onClose={() => setOpen(null)}
        onProbe={() => {
          setOpen(null);
          onNav("search");
        }}
      />
    </div>
  );
}
