export const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000'

// Colors are validated for color-vision deficiency against the dark surface.
// Keep in sync with the CSS variables in index.css.
export const UTILITY_COLOR = {
  FPL: '#3b82f6',
  'Duke Energy Florida': '#d9661f',
  'Alabama Power': '#c2449a',
}
// Utilities offered in the add-project form, with the state each operates in
export const UTILITY_STATES = { FPL: 'FL', 'Duke Energy Florida': 'FL', 'Alabama Power': 'AL' }
export const SEVERITY_COLOR = {
  high: '#e5484d',
  'medium-spatial': '#8b6fe0',
  'medium-temporal': '#c98208',
}
export const CLEAR_COLOR = '#2e9e6f'
export const NEUTRAL_COLOR = '#8a93a8'

export const SEVERITY_LABEL = {
  high: 'High (place + time)',
  'medium-spatial': 'Same area',
  'medium-temporal': 'Same timeframe',
}
export const SEVERITIES = ['high', 'medium-spatial', 'medium-temporal']

// Dependency risks deliberately get no hue of their own: the palette is
// already at its color-vision limit, so they're drawn in light neutral ink
// with a dotted line and always carry an icon + label.
export const RISK_COLOR = '#e8ecf4'
export const RISK_META = {
  outage: {
    icon: '⚡',
    label: 'Stacked outage',
    explain: 'Both utilities take equipment out of service nearby at the same time, leaving less backup if something else fails.',
  },
  road: {
    icon: '🚧',
    label: 'Shared road closure',
    explain: 'Both utilities close the same road at the same time, compounding detours and traffic.',
  },
}
export const RISK_TYPES = ['outage', 'road']

export function utilityColor(utility) {
  return UTILITY_COLOR[utility] || NEUTRAL_COLOR
}

export function severityColor(sev) {
  return SEVERITY_COLOR[sev] || NEUTRAL_COLOR
}

export function formatMoney(n, compact = false) {
  if (n === null || n === undefined) return null
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: compact ? 1 : 0,
    notation: compact ? 'compact' : 'standard',
  })
}

export function overlapKey(o) {
  return `${o.project_a.id}|${o.project_b.id}`
}

// 'YYYY-MM-DD' strings compare correctly as plain strings, which avoids any
// timezone shifting that `new Date('2027-01-01')` would introduce.
export function toISODate(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function isActiveOn(project, iso) {
  return project.start_date <= iso && iso <= project.end_date
}

export function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/**
 * For each project, collect the conflicts it's part of and its worst severity.
 * Projects with no entry here are "clear".
 */
export function buildConflictIndex(overlaps) {
  const rank = { high: 0, 'medium-spatial': 1, 'medium-temporal': 2 }
  const index = new Map()
  for (const o of overlaps) {
    for (const p of [o.project_a, o.project_b]) {
      const entry = index.get(p.id) || { overlaps: [], worst: null }
      entry.overlaps.push(o)
      if (entry.worst === null || rank[o.severity] < rank[entry.worst]) entry.worst = o.severity
      index.set(p.id, entry)
    }
  }
  return index
}

// Per-viewer preferences (filters, thresholds). Storage can be unavailable
// (private mode, blocked site data), so every access is guarded.
export function loadPref(key, fallback) {
  try {
    const raw = localStorage.getItem(`gridlock:${key}`)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

export function savePref(key, value) {
  try {
    localStorage.setItem(`gridlock:${key}`, JSON.stringify(value))
  } catch {
    // ignore — preferences just won't persist
  }
}

/** True if the project matches the utility filter and is active at some point in [from, to]. */
export function projectInScope(p, filters) {
  if (filters.utilities.length && !filters.utilities.includes(p.utility)) return false
  if (filters.from && p.end_date < filters.from) return false
  if (filters.to && p.start_date > filters.to) return false
  return true
}

/** Order-independent key for a pair of projects. */
export function pairKey(idA, idB) {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`
}

export function riskKey(r) {
  return `${r.type}:${pairKey(r.project_a.id, r.project_b.id)}`
}

/** Group risks by project pair and by project id. */
export function buildRiskIndex(risks) {
  const byPair = new Map()
  const byProject = new Map()
  for (const r of risks) {
    const k = pairKey(r.project_a.id, r.project_b.id)
    byPair.set(k, [...(byPair.get(k) || []), r])
    for (const p of [r.project_a, r.project_b]) {
      byProject.set(p.id, [...(byProject.get(p.id) || []), r])
    }
  }
  return { byPair, byProject }
}

export function formatRange(startIso, endIso) {
  return `${formatDate(startIso)} → ${formatDate(endIso)}`
}

/** "FPL · FL" — utility name plus state when known. */
export function utilityLabel(p) {
  return p.state ? `${p.utility} · ${p.state}` : p.utility
}

// ---------- CSV import / export ----------

/** Parse CSV text (quoted fields, escaped quotes, CRLF, BOM) into row objects keyed by header. */
export function parseCSV(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''))
  if (nonEmpty.length === 0) return { headers: [], records: [] }
  const headers = nonEmpty[0].map((h) => h.trim())
  const records = nonEmpty.slice(1).map((r) => {
    const obj = {}
    headers.forEach((h, i) => {
      const v = (r[i] ?? '').trim()
      if (h && v !== '') obj[h] = v // blank cells are omitted so optional fields stay unset
    })
    return obj
  })
  return { headers, records }
}

function csvCell(v) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCSV(columns, rows) {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n')
}

export function downloadFile(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const IMPORT_COLUMNS = [
  'project_id', 'utility', 'state', 'name', 'lat', 'lon', 'start_date', 'end_date', 'estimated_cost',
  'requires_outage', 'outage_start', 'outage_end', 'road_affected', 'road_closure_start', 'road_closure_end',
  'source_label', 'source_url', 'description',
]
export const REQUIRED_IMPORT_COLUMNS = ['project_id', 'utility', 'name', 'lat', 'lon', 'start_date', 'end_date']

export const IMPORT_TEMPLATE = toCSV(IMPORT_COLUMNS, [
  {
    project_id: 'GP-001',
    utility: 'Georgia Power',
    state: 'GA',
    name: 'Example Substation Upgrade',
    lat: 30.88,
    lon: -84.2,
    start_date: '2027-03-01',
    end_date: '2027-11-30',
    estimated_cost: 9000000,
    requires_outage: 'True',
    outage_start: '2027-06-01',
    outage_end: '2027-06-21',
    road_affected: 'US-84',
    road_closure_start: '2027-04-01',
    road_closure_end: '2027-04-30',
    source_label: 'GA PSC filing (example)',
    source_url: 'https://example.com/filing',
    description: 'Replace this row with your own projects. Only the first 7 columns are required.',
  },
])

/** Where a project came from, for the "Source" badge. */
export function projectSource(p) {
  if (p.source_url) return { kind: 'link', label: p.source_label || 'Source', url: p.source_url }
  if (p.is_seed) return { kind: 'synthetic', label: 'Synthetic' }
  if (p.source_label) return { kind: 'upload', label: p.source_label }
  return { kind: 'hypothetical', label: 'Hypothetical' }
}
