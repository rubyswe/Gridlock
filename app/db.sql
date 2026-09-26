-- Reference schema (main.py creates this automatically on startup).
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
);
