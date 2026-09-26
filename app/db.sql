CREATE TABLE projects(
    project_id TEXT PRIMARY KEY, 
    utility TEXT NOT NULL, 
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    start_data TEXT NOT NULL, 
    end_data TEXT NOT NULL,
    description TEXT,
    estimated_cost REAL,
    create_at TEXT DEFAULT CURRENT_TIMESTAMP
);