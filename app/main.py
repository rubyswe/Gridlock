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
DISTANCE_THRESHOLD_MILES = 15

# Date buffer in days: projects whose windows are within this many days of
# each other (including direct overlap) are a "temporal" conflict
DATE_BUFFER_DAYS = 90


def load_projects() -> pd.DataFrame:
    """Load every *_projects.csv in the data directory into one dataframe."""
    frames = []
    for csv_path in DATA_DIR.glob("*_projects.csv"):
        df = pd.read_csv(csv_path, parse_dates=["start_date", "end_date"])
        frames.append(df)
    if not frames:
        return pd.DataFrame(
            columns=[
                "project_id", "utility", "name", "lat", "lon",
                "start_date", "end_date", "description",
            ]
        )
    return pd.concat(frames, ignore_index=True)


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
