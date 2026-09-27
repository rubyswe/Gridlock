"""
Grid — utility construction plan overlap detector.

Endpoints:
  GET /projects              -> all projects from all loaded utilities
  GET /overlaps               -> flagged conflicting project pairs, plus
                                 dependency risks (stacked outages, shared
                                 road closures); thresholds adjustable via
                                 query params
  GET /health                 -> simple healthcheck
  GET /settings/defaults      -> default conflict-detection thresholds
  POST /projects              -> add a new project (persisted to SQLite)
  POST /projects/bulk         -> import many projects at once (all-or-nothing)
  DELETE /projects/{id}       -> remove a user-added project
  DELETE /projects?source_label=... -> remove every project from one upload
  POST /overlaps/explain      -> AI-generated plain-English explanation of a conflict
"""

import math
import os
import sqlite3
from contextlib import asynccontextmanager
from datetime import date, timedelta
from math import radians, sin, cos, sqrt, atan2
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError, model_validator

APP_DIR = Path(__file__).parent
load_dotenv(APP_DIR / ".env")

DB_PATH = APP_DIR / "app.db"
DATA_DIR = APP_DIR / "data"

GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
_gemini_client = None


def get_gemini_client():
    """Create the Gemini client lazily so the API still starts (and every
    non-AI endpoint still works) when no GEMINI_API_KEY is configured."""
    global _gemini_client
    if _gemini_client is None:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            return None
        from google import genai
        _gemini_client = genai.Client(api_key=api_key)
    return _gemini_client

# Distance threshold in miles: projects closer than this are a "spatial" conflict
DISTANCE_THRESHOLD_MILES = 8

# Date buffer in days: projects whose windows are within this many days of
# each other (including direct overlap) are a "temporal" conflict
DATE_BUFFER_DAYS = 45

# Even a "temporal-only" conflict (same timeframe, not close) only matters if
# the two projects are within the same general region — two projects 200+
# miles apart aren't competing for the same crews/equipment no matter how
# well their dates line up. This caps how far apart a temporal-only flag
# can be before we consider it noise rather than a real regional conflict.
MAX_REGIONAL_MILES = 60

# Dependency risks. Two utilities taking equipment out of service within this
# distance at the same time weakens the local grid — if something else fails
# during that window there's less redundancy to keep customers powered.
OUTAGE_RADIUS_MILES = 25

# Road closures are matched by road name, but the same highway (e.g. US-1)
# runs the length of the state, so closures only count as shared if the
# projects are within the regional radius (MAX_REGIONAL_MILES) of each other.


class ProjectIn(BaseModel):
    project_id: str = Field(min_length=1)
    utility: str = Field(min_length=1)
    name: str = Field(min_length=1)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    start_date: date
    end_date: date
    description: str = ""
    estimated_cost: float | None = Field(default=None, ge=0)
    state: str | None = Field(default=None, pattern=r"^[A-Za-z]{2}$")
    source_label: str | None = Field(default=None, max_length=200)
    source_url: str | None = Field(default=None, pattern=r"^https?://", max_length=500)
    requires_outage: bool = False
    outage_start: date | None = None
    outage_end: date | None = None
    road_affected: str | None = None
    road_closure_start: date | None = None
    road_closure_end: date | None = None

    @model_validator(mode="after")
    def check_dates(self):
        if self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")
        self._check_window("outage", self.outage_start, self.outage_end, self.requires_outage)
        if self.road_affected is not None and not self.road_affected.strip():
            self.road_affected = None
        self._check_window("road closure", self.road_closure_start, self.road_closure_end,
                           self.road_affected is not None)
        return self

    def _check_window(self, label, start, end, required):
        if not required:
            if start or end:
                raise ValueError(f"{label} dates given but no {label} is set")
            return
        if not (start and end):
            raise ValueError(f"{label} start and end dates are required")
        if end < start:
            raise ValueError(f"{label} end must be on or after its start")
        if start < self.start_date or end > self.end_date:
            raise ValueError(f"{label} window must fall within the project dates")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Grid API", lifespan=lifespan)

# Allow the frontend (served separately, e.g. from file:// or another port)
# to call this API during the demo without CORS headaches.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Database helpers ----------

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# Columns added after the original schema. Existing app.db files are
# migrated in place and CSVs that lack a column get NULLs.
ADDED_COLUMNS = {
    "state": "TEXT",
    "requires_outage": "INTEGER NOT NULL DEFAULT 0",
    "outage_start": "TEXT",
    "outage_end": "TEXT",
    "road_affected": "TEXT",
    "road_closure_start": "TEXT",
    "road_closure_end": "TEXT",
    # Where the project came from, e.g. "FPSC Docket 20250078-EI" + link
    "source_label": "TEXT",
    "source_url": "TEXT",
}
PROJECT_COLUMNS = ["project_id", "utility", "name", "lat", "lon", "start_date",
                   "end_date", "description", "estimated_cost", *ADDED_COLUMNS]


# IDs of projects that come from the seed CSVs. These are re-imported on
# every startup, so deleting one through the API would be pointless.
SEED_PROJECT_IDS: set[str] = set()


def init_db():
    conn = get_db_connection()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS projects (
            project_id TEXT PRIMARY KEY,
            utility TEXT NOT NULL,
            name TEXT NOT NULL,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            description TEXT,
            estimated_cost REAL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # Add columns introduced after the table was first created, so existing
    # app.db files keep working.
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(projects)")}
    for column, sql_type in ADDED_COLUMNS.items():
        if column not in existing:
            conn.execute(f"ALTER TABLE projects ADD COLUMN {column} {sql_type}")
    conn.commit()

    # Sync the seed CSVs on every startup. INSERT OR REPLACE keeps the DB in
    # step with edits to the CSVs (previously the DB was only seeded when
    # empty, so CSV changes never showed up) while leaving projects added
    # through the API untouched.
    columns = PROJECT_COLUMNS
    SEED_PROJECT_IDS.clear()
    for csv_path in sorted(DATA_DIR.glob("*_projects.csv")):
        df = pd.read_csv(csv_path)
        for column in ADDED_COLUMNS:
            if column not in df:
                df[column] = None
        df["requires_outage"] = df["requires_outage"].fillna(False).astype(bool).astype(int)
        df = df.astype(object).where(pd.notna(df), None)
        SEED_PROJECT_IDS.update(df["project_id"])
        conn.executemany(
            f"INSERT OR REPLACE INTO projects ({', '.join(columns)}) "
            f"VALUES ({', '.join('?' * len(columns))})",
            df[columns].itertuples(index=False, name=None),
        )
    conn.commit()
    conn.close()


def load_projects() -> pd.DataFrame:
    conn = get_db_connection()
    df = pd.read_sql_query("SELECT * FROM projects", conn)
    conn.close()
    for column in ["start_date", "end_date", "outage_start", "outage_end",
                   "road_closure_start", "road_closure_end"]:
        df[column] = pd.to_datetime(df[column])
    df["requires_outage"] = df["requires_outage"].fillna(0).astype(bool)
    return df


def is_missing(value) -> bool:
    """True for None, or for NaN (which is how pandas represents a missing
    numeric value — SQLite NULLs come back this way, not as None)."""
    return value is None or (isinstance(value, float) and math.isnan(value))


def clean_nan(records: list[dict]) -> list[dict]:
    """Replace any NaN float values with None so they serialize as valid JSON."""
    for r in records:
        for k, v in r.items():
            if isinstance(v, float) and math.isnan(v):
                r[k] = None
    return records


# ---------- Overlap detection ----------

def haversine_miles(lat1, lon1, lat2, lon2) -> float:
    """Great-circle distance between two points, in miles."""
    r = 3958.8  # Earth radius in miles
    dlat, dlon = radians(lat2 - lat1), radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return r * 2 * atan2(sqrt(a), sqrt(1 - a))


def dates_overlap(start1, end1, start2, end2, buffer_days=DATE_BUFFER_DAYS) -> bool:
    """True if the two date ranges overlap, or are within buffer_days of each other."""
    buffer = timedelta(days=buffer_days)
    return start1 <= end2 + buffer and start2 <= end1 + buffer


def find_overlaps(
    df: pd.DataFrame,
    distance_threshold=DISTANCE_THRESHOLD_MILES,
    date_buffer_days=DATE_BUFFER_DAYS,
    max_regional_miles=MAX_REGIONAL_MILES,
) -> list[dict]:
    """
    Compare every project pair from DIFFERENT utilities and flag conflicts.
    Returns a list of dicts, one per flagged pair, ready for JSON.
    """
    results = []
    records = df.to_dict("records")

    for i in range(len(records)):
        for j in range(i + 1, len(records)):
            a, b = records[i], records[j]

            # Only compare across different utilities — that's the whole point
            if a["utility"] == b["utility"]:
                continue

            distance = haversine_miles(a["lat"], a["lon"], b["lat"], b["lon"])
            spatial_conflict = distance <= distance_threshold
            temporal_conflict = dates_overlap(
                a["start_date"], a["end_date"], b["start_date"], b["end_date"],
                buffer_days=date_buffer_days,
            )

            # A pure temporal match only counts if the projects are at least
            # in the same broad region — otherwise same-year-but-500-miles-
            # apart pairs would flood the results with meaningless noise.
            if not spatial_conflict and distance > max_regional_miles:
                continue

            if not (spatial_conflict or temporal_conflict):
                continue

            if spatial_conflict and temporal_conflict:
                severity = "high"
                if is_missing(a["estimated_cost"]) or is_missing(b["estimated_cost"]):
                    potential_savings = None
                    relocation_savings = None
                else:
                    smaller_cost = min(a["estimated_cost"], b["estimated_cost"])
                    budget_savings_pct = (1.3 + 6.86) / 2 / 100
                    relocation_savings_pct = 40.33 / 100
                    potential_savings = round(smaller_cost * budget_savings_pct, 2)
                    relocation_savings = round(smaller_cost * relocation_savings_pct, 2)
            elif spatial_conflict:
                severity = "medium-spatial"
                potential_savings = None
                relocation_savings = None
            else:
                severity = "medium-temporal"
                potential_savings = None
                relocation_savings = None

            results.append({
                "project_a": project_summary(a),
                "project_b": project_summary(b),
                "distance_miles": round(distance, 1),
                "cross_state": is_cross_state(a, b),
                "spatial_conflict": spatial_conflict,
                "temporal_conflict": temporal_conflict,
                "severity": severity,
                "potential_savings": potential_savings,
                "relocation_savings": relocation_savings,
            })

    # Highest severity first
    order = {"high": 0, "medium-spatial": 1, "medium-temporal": 2}
    results.sort(key=lambda r: order[r["severity"]])
    return results


# ---------- Dependency risks ----------

def normalize_road(name) -> str | None:
    """'US-441', 'us 441' and 'US441' all refer to the same road."""
    if is_missing(name) or not str(name).strip():
        return None
    return "".join(ch for ch in str(name).lower() if ch.isalnum())


def window_overlap(start1, end1, start2, end2):
    """Return (start, end) of the overlap of two date windows, or None."""
    if any(is_missing(d) for d in (start1, end1, start2, end2)):
        return None
    start, end = max(start1, start2), min(end1, end2)
    return (start, end) if start <= end else None


def project_summary(p) -> dict:
    return {
        "id": p["project_id"], "utility": p["utility"], "name": p["name"],
        "state": None if is_missing(p["state"]) else p["state"],
        "is_seed": p["project_id"] in SEED_PROJECT_IDS,
        "source_label": None if is_missing(p["source_label"]) else p["source_label"],
        "source_url": None if is_missing(p["source_url"]) else p["source_url"],
        "lat": p["lat"], "lon": p["lon"],
        "start_date": str(p["start_date"].date()),
        "end_date": str(p["end_date"].date()),
    }


def is_cross_state(a, b) -> bool:
    """True when both projects have a known state and the states differ."""
    sa, sb = a["state"], b["state"]
    return not is_missing(sa) and not is_missing(sb) and sa != sb


def find_risks(
    df: pd.DataFrame,
    outage_radius_miles=OUTAGE_RADIUS_MILES,
    max_regional_miles=MAX_REGIONAL_MILES,
) -> list[dict]:
    """
    Find cross-utility pairs whose work affects shared systems:
      - "outage": both take equipment out of service nearby at the same time
      - "road":   both close the same road at the same time
    One entry per (pair, type), with the window where the two overlap.
    """
    records = df.to_dict("records")
    results = []

    for i in range(len(records)):
        for j in range(i + 1, len(records)):
            a, b = records[i], records[j]
            if a["utility"] == b["utility"]:
                continue
            distance = haversine_miles(a["lat"], a["lon"], b["lat"], b["lon"])

            found = []
            if a["requires_outage"] and b["requires_outage"] and distance <= outage_radius_miles:
                window = window_overlap(a["outage_start"], a["outage_end"],
                                        b["outage_start"], b["outage_end"])
                if window:
                    found.append(("outage", window, None))

            road_a, road_b = normalize_road(a["road_affected"]), normalize_road(b["road_affected"])
            if road_a and road_a == road_b and distance <= max_regional_miles:
                window = window_overlap(a["road_closure_start"], a["road_closure_end"],
                                        b["road_closure_start"], b["road_closure_end"])
                if window:
                    found.append(("road", window, a["road_affected"]))

            for risk_type, (start, end), road in found:
                results.append({
                    "type": risk_type,
                    "project_a": project_summary(a),
                    "project_b": project_summary(b),
                    "distance_miles": round(distance, 1),
                "cross_state": is_cross_state(a, b),
                    "start_date": str(start.date()),
                    "end_date": str(end.date()),
                    "days": (end - start).days + 1,
                    "road": road,
                })

    # Longest shared windows first — those are the hardest to work around
    results.sort(key=lambda r: (r["type"] != "outage", -r["days"]))
    return results


# ---------- Coordination suggestions ----------

def fmt_date(ts) -> str:
    return f"{ts:%b} {ts.day}, {ts.year}"


def coordination_notes(o: dict, pair_risks: list[dict], a: dict, b: dict) -> list[dict]:
    """
    Rule-based suggestions for how two utilities could coordinate on a flagged
    pair: share crews/equipment, reuse site work, stagger outages, combine road
    closures. Returned as [{"kind": ..., "text": ...}] for the UI and exports.
    """
    notes = []
    d = o["distance_miles"]
    window = window_overlap(a["start_date"], a["end_date"], b["start_date"], b["end_date"])
    first, second = sorted((a, b), key=lambda p: p["start_date"])

    if o["severity"] == "high":
        span = f"{fmt_date(window[0])} to {fmt_date(window[1])}" if window else "overlapping periods"
        notes.append({"kind": "share", "text": (
            f"Share crews and equipment: the sites are {d} mi apart and both under way from {span}. "
            f"One mobilization and a shared staging yard could serve both."
        )})
        notes.append({"kind": "meet", "text": (
            f"Hold a joint planning meeting before {fmt_date(first['start_date'])}, when "
            f"{first['name']} starts."
        )})
    elif o["severity"] == "medium-spatial":
        gap_months = max(1, round((second["start_date"] - first["end_date"]).days / 30))
        notes.append({"kind": "reuse", "text": (
            f"Same area, different times: {second['name']} starts about {gap_months} month"
            f"{'s' if gap_months != 1 else ''} after {first['name']} finishes. Reuse surveys, permits and "
            f"access roads, and avoid digging up the same ground twice."
        )})
    else:
        if window:
            notes.append({"kind": "share", "text": (
                f"Same timeframe, {d} mi apart: both draw on the region's crews and equipment from "
                f"{fmt_date(window[0])} to {fmt_date(window[1])}. Consider a shared contractor pool or "
                f"staggering start dates."
            )})
        else:
            notes.append({"kind": "handoff", "text": (
                f"Back-to-back work {d} mi apart: {first['name']} ends {fmt_date(first['end_date'])} and "
                f"{second['name']} starts {fmt_date(second['start_date'])}. Hand crews and equipment "
                f"straight from one to the other."
            )})

    for r in pair_risks:
        if r["type"] == "outage":
            notes.append({"kind": "outage", "text": (
                f"Stagger the outages: they overlap for {r['days']} days ({fmt_date(pd.Timestamp(r['start_date']))} "
                f"to {fmt_date(pd.Timestamp(r['end_date']))}). Running them back-to-back keeps backup "
                f"capacity in the area."
            )})
        elif r["type"] == "road":
            notes.append({"kind": "road", "text": (
                f"Combine the {r['road']} closures: both close it {fmt_date(pd.Timestamp(r['start_date']))} to "
                f"{fmt_date(pd.Timestamp(r['end_date']))}. "
                f"One shared closure means one detour for the public."
            )})

    if o.get("cross_state"):
        notes.append({"kind": "cross_state", "text": (
            f"Cross-state pair ({a['state']}/{b['state']}): each utility files with a different state "
            f"regulator, so neither filing shows the other's work. Raise it through the regional "
            f"planning process."
        )})
    return notes


def attach_coordination(df: pd.DataFrame, overlaps: list[dict], risks: list[dict]) -> None:
    by_id = {r["project_id"]: r for r in df.to_dict("records")}
    risks_by_pair = {}
    for r in risks:
        key = frozenset((r["project_a"]["id"], r["project_b"]["id"]))
        risks_by_pair.setdefault(key, []).append(r)
    for o in overlaps:
        a, b = by_id[o["project_a"]["id"]], by_id[o["project_b"]["id"]]
        pair_risks = risks_by_pair.get(frozenset((a["project_id"], b["project_id"])), [])
        o["coordination"] = coordination_notes(o, pair_risks, a, b)


# ---------- Endpoints ----------

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/projects")
def get_projects():
    df = load_projects()
    df = df.assign(**{
        column: df[column].dt.strftime("%Y-%m-%d")
        for column in ["start_date", "end_date", "outage_start", "outage_end",
                       "road_closure_start", "road_closure_end"]
    })
    df = df.astype(object).where(pd.notna(df), None)
    df["is_seed"] = df["project_id"].isin(SEED_PROJECT_IDS)
    return clean_nan(df.to_dict("records"))


@app.get("/overlaps")
def get_overlaps(
    distance_miles: float = Query(DISTANCE_THRESHOLD_MILES, ge=0, le=500),
    date_buffer_days: int = Query(DATE_BUFFER_DAYS, ge=0, le=3650),
    max_regional_miles: float = Query(MAX_REGIONAL_MILES, ge=0, le=1000),
    outage_radius_miles: float = Query(OUTAGE_RADIUS_MILES, ge=0, le=500),
):
    thresholds = {
        "distance_miles": distance_miles,
        "date_buffer_days": date_buffer_days,
        "max_regional_miles": max_regional_miles,
        "outage_radius_miles": outage_radius_miles,
    }
    df = load_projects()
    if df.empty:
        return {"count": 0, "overlaps": [], "risks": [], "thresholds": thresholds}
    overlaps = find_overlaps(df, distance_miles, date_buffer_days, max_regional_miles)
    risks = find_risks(df, outage_radius_miles, max_regional_miles)
    attach_coordination(df, overlaps, risks)
    return {"count": len(overlaps), "overlaps": overlaps, "risks": risks, "thresholds": thresholds}


@app.get("/settings/defaults")
def get_default_thresholds():
    return {
        "distance_miles": DISTANCE_THRESHOLD_MILES,
        "date_buffer_days": DATE_BUFFER_DAYS,
        "max_regional_miles": MAX_REGIONAL_MILES,
        "outage_radius_miles": OUTAGE_RADIUS_MILES,
    }


def project_row(project: ProjectIn) -> list:
    row = project.model_dump(mode="json")
    row["requires_outage"] = int(project.requires_outage)
    row["state"] = project.state.upper() if project.state else None
    return [row[c] for c in PROJECT_COLUMNS]


INSERT_PROJECT_SQL = (
    f"INSERT INTO projects ({', '.join(PROJECT_COLUMNS)}) "
    f"VALUES ({', '.join('?' * len(PROJECT_COLUMNS))})"
)


class BulkImport(BaseModel):
    source_label: str = Field(min_length=1, max_length=200)
    projects: list[dict] = Field(min_length=1, max_length=5000)


@app.post("/projects/bulk", status_code=201)
def import_projects(payload: BulkImport):
    """Validate every row first; insert all of them or none, so a bad file
    never leaves half an upload behind."""
    errors, valid, seen = [], [], set()
    conn = get_db_connection()
    try:
        existing = {r[0] for r in conn.execute("SELECT project_id FROM projects")}
        for i, raw in enumerate(payload.projects):
            row_no = i + 2  # +1 for 1-based, +1 for the CSV header line
            try:
                project = ProjectIn.model_validate({**raw, "source_label": raw.get("source_label") or payload.source_label})
            except ValidationError as e:
                first = e.errors()[0]
                field = ".".join(str(x) for x in first["loc"])
                msg = first["msg"].removeprefix("Value error, ")
                errors.append({"row": row_no, "error": f"{field}: {msg}" if field else msg})
                continue
            if project.project_id in seen:
                errors.append({"row": row_no, "error": f"duplicate project_id {project.project_id!r} in file"})
            elif project.project_id in existing:
                errors.append({"row": row_no, "error": f"project_id {project.project_id!r} already exists"})
            else:
                seen.add(project.project_id)
                valid.append(project)
        if errors:
            raise HTTPException(400, {"message": f"{len(errors)} row(s) have problems; nothing was imported",
                                      "errors": errors[:50]})
        conn.executemany(INSERT_PROJECT_SQL, [project_row(p) for p in valid])
        conn.commit()
    finally:
        conn.close()
    return {"message": f"Imported {len(valid)} projects", "count": len(valid)}


@app.delete("/projects")
def delete_projects_by_source(source_label: str = Query(min_length=1)):
    """Remove every user-added project from one upload (seed data is never touched)."""
    conn = get_db_connection()
    ids = [r[0] for r in conn.execute("SELECT project_id FROM projects WHERE source_label = ?", (source_label,))
           if r[0] not in SEED_PROJECT_IDS]
    conn.executemany("DELETE FROM projects WHERE project_id = ?", [(i,) for i in ids])
    conn.commit()
    conn.close()
    return {"message": f"Deleted {len(ids)} projects", "count": len(ids)}


@app.post("/projects", status_code=201)
def create_project(project: ProjectIn):
    conn = get_db_connection()
    try:
        conn.execute(INSERT_PROJECT_SQL, project_row(project))
        conn.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"A project with ID {project.project_id!r} already exists")
    finally:
        conn.close()
    return {"message": "Project added", "project_id": project.project_id}


@app.delete("/projects/{project_id}")
def delete_project(project_id: str):
    if project_id in SEED_PROJECT_IDS:
        raise HTTPException(
            400, "Seed projects come from app/data/*.csv and are re-imported on startup; edit the CSV instead"
        )
    conn = get_db_connection()
    cur = conn.execute("DELETE FROM projects WHERE project_id = ?", (project_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, "Project not found")
    return {"message": "Project deleted", "project_id": project_id}


@app.post("/overlaps/explain")
def explain_conflict(conflict: dict):
    prompt = f"""You are analyzing a construction scheduling conflict between two utility companies.

Project A: {conflict['project_a']['name']} ({conflict['project_a']['utility']}), {conflict['project_a']['start_date']} to {conflict['project_a']['end_date']}
Project B: {conflict['project_b']['name']} ({conflict['project_b']['utility']}), {conflict['project_b']['start_date']} to {conflict['project_b']['end_date']}
Distance apart: {conflict['distance_miles']} miles
Severity: {conflict['severity']}

In 2 sentences, explain why this is a conflict and suggest one concrete action the utilities could take."""

    client = get_gemini_client()
    if client is None:
        return {"explanation": "AI explanations are disabled — set GEMINI_API_KEY in app/.env.",
                "error": "missing_api_key"}

    try:
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
        )
        return {"explanation": response.text}
    except Exception as e:
        return {"explanation": "Unable to generate explanation right now.", "error": str(e)}