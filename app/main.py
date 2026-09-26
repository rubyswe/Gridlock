"""
GridLock — utility construction plan overlap detector.

Endpoints:
  GET /projects            -> all projects from all loaded utilities
  GET /overlaps             -> flagged conflicting project pairs
  GET /health                -> simple healthcheck
"""

from datetime import timedelta
from math import radians, sin, cos, sqrt, atan2
from pathlib import Path

import pandas as pd
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import sqlite3
from pydantic import BaseModel

DB_path = Path(__file__).parent / "app.db"

def get_db_connection():
    conn = sqlite3.connect(DB_path)
    conn.row_factory = sqlite3.Row
    return conn


class ProjectIn(BaseModel):
    project_id: str
    utility: str
    name: str
    lat: float
    lon: float
    start_date: str
    end_date: str
    description: str = ""
    estimated_cost: float | None = None


app = FastAPI(title="GridLock API")

# Allow the frontend (served separately, e.g. from file:// or another port)
# to call this API during the demo without CORS headaches.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_DIR = Path(__file__).parent / "data"

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

    # only import CSVs if table is empty, so re-running doesn't duplicate data
    count = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
    if count == 0:
        for csv_path in DATA_DIR.glob("*_projects.csv"):
            df = pd.read_csv(csv_path)
            df.to_sql("projects", conn, if_exists="append", index=False)
    conn.close()

@app.on_event("startup")
def startup():
    init_db()

def load_projects() -> pd.DataFrame:
    conn = get_db_connection()
    df = pd.read_sql_query("SELECT * FROM projects", conn)
    conn.close()
    df["start_date"] = pd.to_datetime(df["start_date"])
    df["end_date"] = pd.to_datetime(df["end_date"])
    return df



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
            elif spatial_conflict:
                severity = "medium-spatial"
            else:
                severity = "medium-temporal"

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
            })

    # Highest severity first
    order = {"high": 0, "medium-spatial": 1, "medium-temporal": 2}
    results.sort(key=lambda r: order[r["severity"]])
    return results


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
    return df.to_dict("records")


@app.get("/overlaps")
def get_overlaps():
    df = load_projects()
    if df.empty:
        return {"count": 0, "overlaps": []}
    overlaps = find_overlaps(df)
    return {"count": len(overlaps), "overlaps": overlaps}

@app.post("/projects")
def create_project(project: ProjectIn):
    conn = get_db_connection()
    conn.execute(
        """INSERT INTO projects
           (project_id, utility, name, lat, lon, start_date, end_date, description, estimated_cost)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (project.project_id, project.utility, project.name, project.lat, project.lon,
         project.start_date, project.end_date, project.description, project.estimated_cost)
    )
    conn.commit()
    conn.close()
    return {"message": "Project added", "project_id": project.project_id}


    
