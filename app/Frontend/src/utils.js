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
