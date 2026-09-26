# Grid

Cross-utility construction conflict detector. Flags projects from different
utilities (FPL, Duke Energy Florida, and Alabama Power) that overlap in
location and/or time, and shows them on a map, as charts, and on a calendar.
Pairs that cross a state line (e.g. FPL in Northwest Florida vs. Alabama Power
across Perdido Bay) are marked **Cross-state**.

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

Seed projects live in `app/data/*_projects.csv` (any new file matching that
pattern is picked up automatically; give each project a two-letter `state`) and are synced into
`app/app.db` every time the API starts, so edits to the CSVs show up after a
restart. Projects added through the UI are kept.

## Views

- **Map**: projects colored by utility, ringed by conflict status. The side
  panel switches between **Conflicts** and **No conflicts**.
- **Insights**: conflict vs. no-conflict share, conflicts by severity,
  per-utility breakdown, and active projects per year.
- **Calendar**: month view. Each day shows concurrent conflicts, dependency
  risks, flagged projects, and conflict-free projects. Click a day for details.

## Dependency risks

Beyond "same place, same time", Grid flags cases where one utility's work
affects the other's:

- **⚡ Stacked outage**: both utilities take equipment out of service within
  the outage radius (default 25 mi) during overlapping windows, leaving less
  backup if something else fails.
- **🚧 Shared road closure**: both utilities close the same road (matched by
  name, e.g. `US-441` = `us 441`) at the same time, within the regional radius.

Each project can carry these optional CSV columns: `requires_outage`,
`outage_start`, `outage_end`, `road_affected`, `road_closure_start`,
`road_closure_end`. The values in the seed CSVs are synthetic.
