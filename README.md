# GridLock

Cross-utility construction conflict detector. Flags FPL and Duke Energy Florida
projects that overlap in location and/or time, and shows them on a map, as
charts, and on a calendar.

## Run it

Backend (from the repo root):

```bash
.venv/bin/pip install -r app/requirements.txt
.venv/bin/uvicorn main:app --app-dir app --reload
```

Frontend:

```bash
cd app/Frontend && npm install && npm run dev
```

Then open http://localhost:5173.

Optional: put `GEMINI_API_KEY=...` (and optionally `GEMINI_MODEL=...`) in
`app/.env` to enable the "Explain with AI" button. Everything else works without it.

## Data

Seed projects live in `app/data/*_projects.csv` and are synced into
`app/app.db` every time the API starts, so edits to the CSVs show up after a
restart. Projects added through the UI are kept.

## Views

- **Map**: projects colored by utility, ringed by conflict status. The side
  panel switches between **Conflicts** and **No conflicts**.
- **Insights**: conflict vs. no-conflict share, conflicts by severity,
  per-utility breakdown, and active projects per year.
- **Calendar**: month view. Each day shows concurrent conflicts, flagged
  projects, and conflict-free projects. Click a day for details.
