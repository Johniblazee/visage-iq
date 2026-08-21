/* Student search — ported from the VisageIQ v2 design (page-students.jsx).
   ponytail: runs on the design's demo dataset below; swap STUDENTS for a
   /persons API call when the backend grows one. */
import { useState, type CSSProperties } from "react";
import type { Tab } from "../App";
import { Badge, Button, Checkbox, Icon, Select } from "../ds";

interface Student {
  sid: string;
  matric: string;
  name: string;
  email: string;
  programme: string;
  faculty: string;
  year: number;
  centre: string;
  status: string;
  enrolled: string;
  photos: number;
}

const STUDENTS: Student[] = [
  { sid: "MIVA/2024/04812", matric: "CSC/24/0481", name: "Nosiru Shifau", email: "nosiru.shifau@miva.university", programme: "BSc Computer Science", faculty: "Computing", year: 2024, centre: "Abuja", status: "Active", enrolled: "12 Feb 2024", photos: 3 },
  { sid: "MIVA/2024/06393", matric: "NUR/24/0163", name: "Emmanuella Alali", email: "emmanuella.alali@miva.university", programme: "BNSc Nursing Science", faculty: "Allied Health Sciences", year: 2024, centre: "Lagos", status: "Active", enrolled: "04 Mar 2024", photos: 2 },
  { sid: "MIVA/2023/03401", matric: "MAC/23/0340", name: "Success Oruma", email: "success.oruma@miva.university", programme: "BSc Mass Communication", faculty: "Communication & Media Studies", year: 2023, centre: "Port Harcourt", status: "Active", enrolled: "18 Sep 2023", photos: 4 },
  { sid: "MIVA/2025/21213", matric: "PUH/25/0212", name: "Margaret Dombin", email: "margaret.dombin@miva.university", programme: "BSc Public Health", faculty: "Allied Health Sciences", year: 2025, centre: "Jos", status: "Active", enrolled: "09 Jan 2025", photos: 1 },
  { sid: "MIVA/2024/01907", matric: "CYB/24/0190", name: "Ibrahim Danladi", email: "ibrahim.danladi@miva.university", programme: "BSc Cybersecurity", faculty: "Computing", year: 2024, centre: "Kano", status: "Active", enrolled: "22 Feb 2024", photos: 2 },
  { sid: "MIVA/2023/00744", matric: "BUS/23/0074", name: "Chiamaka Okonkwo", email: "chiamaka.okonkwo@miva.university", programme: "BSc Business Management", faculty: "Management & Social Sciences", year: 2023, centre: "Enugu", status: "Graduated", enrolled: "11 Sep 2023", photos: 3 },
  { sid: "MIVA/2025/11502", matric: "DSC/25/0115", name: "Tunde Balogun", email: "tunde.balogun@miva.university", programme: "BSc Data Science", faculty: "Computing", year: 2025, centre: "Ibadan", status: "Active", enrolled: "14 Jan 2025", photos: 2 },
  { sid: "MIVA/2024/08820", matric: "ECO/24/0882", name: "Halima Yusuf", email: "halima.yusuf@miva.university", programme: "BSc Economics", faculty: "Management & Social Sciences", year: 2024, centre: "Kaduna", status: "Active", enrolled: "29 Feb 2024", photos: 1 },
  { sid: "MIVA/2022/00219", matric: "MBA/22/0021", name: "Peter Adeyemi", email: "peter.adeyemi@miva.university", programme: "MBA", faculty: "Postgraduate Studies", year: 2022, centre: "Lagos", status: "Graduated", enrolled: "03 Oct 2022", photos: 5 },
  { sid: "MIVA/2025/13077", matric: "SWE/25/0307", name: "Blessing Etim", email: "blessing.etim@miva.university", programme: "BSc Software Engineering", faculty: "Computing", year: 2025, centre: "Uyo", status: "Active", enrolled: "20 Jan 2025", photos: 2 },
  { sid: "MIVA/2023/02688", matric: "CRM/23/0268", name: "Yakubu Musa", email: "yakubu.musa@miva.university", programme: "BSc Criminology", faculty: "Management & Social Sciences", year: 2023, centre: "Maiduguri", status: "Suspended", enrolled: "25 Sep 2023", photos: 1 },
  { sid: "MIVA/2024/05531", matric: "MIT/24/0553", name: "Ada Nwachukwu", email: "ada.nwachukwu@miva.university", programme: "MSc Information Technology", faculty: "Postgraduate Studies", year: 2024, centre: "Abuja", status: "Active", enrolled: "07 Mar 2024", photos: 3 },
  { sid: "MIVA/2025/17740", matric: "ACC/25/0774", name: "Grace Ogunleye", email: "grace.ogunleye@miva.university", programme: "BSc Accounting", faculty: "Management & Social Sciences", year: 2025, centre: "Akure", status: "Active", enrolled: "16 Jan 2025", photos: 2 },
  { sid: "MIVA/2022/00095", matric: "MPH/22/0009", name: "Samuel Achike", email: "samuel.achike@miva.university", programme: "MPH Public Health", faculty: "Postgraduate Studies", year: 2022, centre: "Owerri", status: "Graduated", enrolled: "01 Oct 2022", photos: 4 },
];

const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("");
const AVATAR_TINTS = ["var(--miva-gold-soft)", "#DCE7EF", "#EAE1D7", "#D9E9E2", "#F1E3DE", "#E2E5EE"];
const tintFor = (s: Student) => AVATAR_TINTS[(s.sid.charCodeAt(s.sid.length - 1) + s.name.length) % AVATAR_TINTS.length];

function Avatar({ student, size = 64, radius }: { student: Student; size?: number; radius?: string }) {
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
      <span style={{ opacity: 0.85 }}>{initials(student.name)}</span>
    </div>
  );
}

function StudentDrawer({
  student,
  onClose,
  onProbe,
}: {
  student: Student | null;
  onClose: () => void;
  onProbe: () => void;
}) {
  if (!student) return null;
  return (
    <>
      <div className="scrim" onClick={onClose}></div>
      <aside className="drawer" role="dialog" aria-label={student.name}>
        <header className="card-head">
          <div>
            <div className="eyebrow">Student record</div>
            <h3 style={{ marginTop: 2 }}>{student.name}</h3>
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
                <Badge tone={student.status === "Active" ? "blue" : student.status === "Graduated" ? "gold" : "red"}>
                  {student.status}
                </Badge>
              </div>
              <div className="muted">
                {student.photos} enrolled photo{student.photos > 1 ? "s" : ""} in the index
              </div>
              <div>
                <Button kind="secondary" size="sm" iconLeft={<Icon name="search" size={16} />} onClick={onProbe}>
                  Use as probe
                </Button>
              </div>
            </div>
          </div>
          <dl className="kv">
            <dt>Student ID</dt>
            <dd>{student.sid}</dd>
            <dt>Matric number</dt>
            <dd>{student.matric}</dd>
            <dt>Email</dt>
            <dd style={{ wordBreak: "break-all" }}>{student.email}</dd>
            <dt>Programme</dt>
            <dd>{student.programme}</dd>
            <dt>Faculty</dt>
            <dd>{student.faculty}</dd>
            <dt>Enrolment year</dt>
            <dd>{student.year}</dd>
            <dt>Study centre</dt>
            <dd>{student.centre}</dd>
            <dt>Enrolled on</dt>
            <dd>{student.enrolled}</dd>
          </dl>
        </div>
      </aside>
    </>
  );
}

const FIELDS: { k: string; label: string }[] = [
  { k: "all", label: "All fields" },
  { k: "name", label: "Name" },
  { k: "matric", label: "Matric number" },
  { k: "sid", label: "Student ID" },
  { k: "email", label: "Email" },
  { k: "programme", label: "Programme" },
  { k: "year", label: "Enrolment year" },
];

export default function StudentsPage({ onNav }: { onNav: (tab: Tab) => void }) {
  const [q, setQ] = useState("");
  const [field, setField] = useState("all");
  const [faculty, setFaculty] = useState("");
  const [year, setYear] = useState("");
  const [programme, setProgramme] = useState("");
  const [centre, setCentre] = useState("");
  const [status, setStatus] = useState("");
  const [photosOnly, setPhotosOnly] = useState(false);
  const [showFilters, setShowFilters] = useState(true);
  const [open, setOpen] = useState<Student | null>(null);

  const faculties = [...new Set(STUDENTS.map((s) => s.faculty))];
  const years = [...new Set(STUDENTS.map((s) => String(s.year)))].sort();
  const programmes = [...new Set(STUDENTS.filter((s) => !faculty || s.faculty === faculty).map((s) => s.programme))].sort();
  const centres = [...new Set(STUDENTS.map((s) => s.centre))].sort();
  const statuses = [...new Set(STUDENTS.map((s) => s.status))];
  const active: [string, string, () => void][] = (
    [
      ["Faculty", faculty, () => setFaculty("")],
      ["Programme", programme, () => setProgramme("")],
      ["Year", year, () => setYear("")],
      ["Centre", centre, () => setCentre("")],
      ["Status", status, () => setStatus("")],
      ["Photos", photosOnly ? "2 or more" : "", () => setPhotosOnly(false)],
    ] as [string, string, () => void][]
  ).filter((f) => f[1]);
  const clearAll = () => {
    setFaculty("");
    setProgramme("");
    setYear("");
    setCentre("");
    setStatus("");
    setPhotosOnly(false);
  };

  const results = STUDENTS.filter((s) => {
    if (faculty && s.faculty !== faculty) return false;
    if (programme && s.programme !== programme) return false;
    if (centre && s.centre !== centre) return false;
    if (status && s.status !== status) return false;
    if (photosOnly && s.photos < 2) return false;
    if (year && String(s.year) !== year) return false;
    if (!q.trim()) return true;
    const t = q.trim().toLowerCase();
    const hay =
      field === "all"
        ? [s.name, s.matric, s.sid, s.email, s.programme, String(s.year), s.faculty, s.centre]
        : [String(s[field as keyof Student])];
    return hay.some((v) => v.toLowerCase().includes(t));
  });

  function exportCsv() {
    const cols: (keyof Student)[] = ["sid", "matric", "name", "email", "programme", "faculty", "year", "centre", "status", "enrolled", "photos"];
    const esc = (v: unknown) => `"${String(v).replaceAll('"', '""')}"`;
    const csv = [cols.join(","), ...results.map((s) => cols.map((c) => esc(s[c])).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "students.csv" });
    a.click();
    URL.revokeObjectURL(url);
  }

  const ellipsis: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Enrolment index</div>
          <h1>Student search</h1>
          <p>
            Look a student up by name, matric number, student ID, email, programme or enrolment year, then
            open the record to see their enrolled photos.
          </p>
        </div>
        <div className="row">
          <Button kind="ghost" size="sm" iconLeft={<Icon name="fileText" size={16} />} onClick={exportCsv}>
            Export results
          </Button>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
        <div className="searchbar">
          <Icon name="search" size={20} color="var(--txt-3)" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. Nosiru Shifau, CSC/24/0481, MIVA/2024/04812, ada.nwachukwu@miva.university"
          />
          {q && (
            <button className="icon-btn" onClick={() => setQ("")} aria-label="Clear search">
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
                label="Faculty"
                options={faculties}
                placeholder="Any faculty"
                value={faculty}
                onChange={(value) => {
                  setFaculty(value);
                  setProgramme("");
                }}
              />
              <Select label="Programme" options={programmes} placeholder="Any programme" value={programme} onChange={setProgramme} />
              <Select label="Enrolment year" options={years} placeholder="Any year" value={year} onChange={setYear} />
              <Select label="Study centre" options={centres} placeholder="Any centre" value={centre} onChange={setCentre} />
              <Select label="Status" options={statuses} placeholder="Any status" value={status} onChange={setStatus} />
              <div style={{ alignSelf: "end", paddingBottom: 6 }}>
                <Checkbox label="Two or more enrolled photos" checked={photosOnly} onChange={setPhotosOnly} />
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
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="muted">
          {results.length} of {STUDENTS.length} shown · searching{" "}
          {FIELDS.find((f) => f.k === field)?.label.toLowerCase()}
        </div>
        <div className="muted">Demo data — student API not connected yet</div>
      </div>
      {results.length === 0 ? (
        <div className="card empty">
          <Icon name="user" size={28} color="var(--txt-3)" />
          <div style={{ fontSize: "var(--text-body)", color: "var(--txt-2)" }}>No student matches that query.</div>
          <Button
            kind="ghost"
            size="sm"
            onClick={() => {
              setQ("");
              clearAll();
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <div className="stud-grid">
          {results.map((s) => (
            <button key={s.sid} className="stud" onClick={() => setOpen(s)}>
              <div className="stud-photo" style={{ background: tintFor(s) }}>
                {initials(s.name)}
                <span style={{ position: "absolute", bottom: 8, right: 8 }}>
                  <span className="tag">
                    {s.photos} photo{s.photos > 1 ? "s" : ""}
                  </span>
                </span>
              </div>
              <div className="stud-body">
                <div className="stud-name">{s.name}</div>
                <div className="stud-line">{s.sid}</div>
                <div className="stud-line">{s.matric}</div>
                <div className="stud-line" style={ellipsis} title={s.email}>
                  {s.email}
                </div>
                <div className="stud-line">{s.programme}</div>
                <div className="stud-line" style={{ color: "var(--txt-2)", marginTop: 4 }}>
                  {s.year} · {s.centre}
                </div>
              </div>
            </button>
          ))}
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
