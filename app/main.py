"""
GridLock — utility construction plan overlap detector.

Endpoints:
  GET /projects              -> all projects from all loaded utilities
  GET /overlaps               -> flagged conflicting project pairs
  GET /health                 -> simple healthcheck
  POST /projects              -> add a new project (persisted to SQLite)
  DELETE /projects/{id}       -> remove a project
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
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator

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

    @model_validator(mode="after")
    def check_dates(self):
        if self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")
        return self


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="GridLock API", lifespan=lifespan)

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
    conn.commit()

    # Sync the seed CSVs on every startup. INSERT OR REPLACE keeps the DB in
    # step with edits to the CSVs (previously the DB was only seeded when
    # empty, so CSV changes never showed up) while leaving projects added
    # through the API untouched.
    columns = ["project_id", "utility", "name", "lat", "lon", "start_date",
               "end_date", "description", "estimated_cost"]
    for csv_path in sorted(DATA_DIR.glob("*_projects.csv")):
        df = pd.read_csv(csv_path)
        df = df.astype(object).where(pd.notna(df), None)
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
    df["start_date"] = pd.to_datetime(df["start_date"])
    df["end_date"] = pd.to_datetime(df["end_date"])
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


def find_overlaps(df: pd.DataFrame) -> list[dict]:
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
            spatial_conflict = distance <= DISTANCE_THRESHOLD_MILES
            temporal_conflict = dates_overlap(
                a["start_date"], a["end_date"], b["start_date"], b["end_date"]
            )

            # A pure temporal match only counts if the projects are at least
            # in the same broad region — otherwise same-year-but-500-miles-
            # apart pairs would flood the results with meaningless noise.
            if not spatial_conflict and distance > MAX_REGIONAL_MILES:
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
                "project_a": {
                    "id": a["project_id"], "utility": a["utility"], "name": a["name"],
                    "lat": a["lat"], "lon": a["lon"],
                    "start_date": str(a["start_date"].date()),
                    "end_date": str(a["end_date"].date()),
                },
                "project_b": {
                    "id": b["project_id"], "utility": b["utility"], "name": b["name"],
                    "lat": b["lat"], "lon": b["lon"],
                    "start_date": str(b["start_date"].date()),
                    "end_date": str(b["end_date"].date()),
                },
                "distance_miles": round(distance, 1),
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


# ---------- Endpoints ----------

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/projects")
def get_projects():
    df = load_projects()
    df = df.assign(
        start_date=df["start_date"].dt.strftime("%Y-%m-%d"),
        end_date=df["end_date"].dt.strftime("%Y-%m-%d"),
    )
    return clean_nan(df.to_dict("records"))


@app.get("/overlaps")
def get_overlaps():
    df = load_projects()
    if df.empty:
        return {"count": 0, "overlaps": []}
    overlaps = find_overlaps(df)
    return {"count": len(overlaps), "overlaps": overlaps}


@app.post("/projects", status_code=201)
def create_project(project: ProjectIn):
    conn = get_db_connection()
    try:
        conn.execute(
            """INSERT INTO projects
               (project_id, utility, name, lat, lon, start_date, end_date, description, estimated_cost)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (project.project_id, project.utility, project.name, project.lat, project.lon,
             project.start_date.isoformat(), project.end_date.isoformat(),
             project.description, project.estimated_cost)
        )
        conn.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"A project with ID {project.project_id!r} already exists")
    finally:
        conn.close()
    return {"message": "Project added", "project_id": project.project_id}


@app.delete("/projects/{project_id}")
def delete_project(project_id: str):
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