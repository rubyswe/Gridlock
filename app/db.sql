-- Reference schema (main.py creates and migrates this automatically on startup).
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
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    -- Dependency fields
    requires_outage INTEGER NOT NULL DEFAULT 0,
    outage_start TEXT,
    outage_end TEXT,
    road_affected TEXT,
    road_closure_start TEXT,
    road_closure_end TEXT
);
