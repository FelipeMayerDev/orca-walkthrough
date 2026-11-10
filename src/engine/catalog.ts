// The models each agent offers, as Orca itself knows them: Orca keeps a
// catalog of what it discovered per agent (its own model pickers are built
// from it), in a small SQLite file under its config directory. Reading it
// gives the walkthrough the same list the person sees in Orca — including
// which one is the account's default — instead of names guessed here that
// rot. Nothing is written; if the file or its reader is missing, callers fall
// back to each agent's static list.

import { DatabaseSync } from 'node:sqlite'

export type CatalogModel = { key: string; label: string; isDefault: boolean }
/** The catalog: every agent name it holds, and — for the agents of ours it
 *  knows — the latest models. */
export type Catalog = { keys: string[] } & Partial<Record<'codex' | 'opencode' | 'omp', CatalogModel[]>>

type Row = { agent: string; json: string }

/** The catalog rows → the latest models per agent (later rows win: the file keeps snapshots). */
export function parseCatalog(rows: Row[]): Catalog {
  const latest = new Map<string, any>()
  for (const row of rows) {
    try {
      const data = JSON.parse(row.json)
      if (data?.agent && Array.isArray(data?.discovered?.models)) latest.set(String(data.agent), data.discovered.models)
    } catch { /* a row that is not our shape is not ours to read */ }
  }
  const catalog: Catalog = { keys: [...latest.keys()] }
  const take = (orcaAgent: string, ourKey: 'codex' | 'opencode' | 'omp'): void => {
    const models = latest.get(orcaAgent)
    if (!models?.length) return
    const out = models
      .filter((m: any) => typeof m?.id === 'string')
      .map((m: any) => ({ key: String(m.id), label: String(m.label ?? m.id), isDefault: Boolean(m.isDefault) }))
    if (out.length) catalog[ourKey] = out
  }
  // Orca names the codex CLI's agent 'codex', the opencode CLI's 'opencode2',
  // and oh-my-pi's 'omp'.
  take('codex', 'codex')
  take('opencode2', 'opencode')
  take('omp', 'omp')
  return catalog
}

/**
 * Hermes keeps its own model catalog (the picker's cache): providers, each
 * with model ids. The ids carry their provider, so the union of all providers
 * dedupes cleanly; the person's configured default (`model.default` in
 * config.yaml) is marked when the cache holds it.
 */
export function hermesModels(catalogJson: unknown, configuredDefault = ''): CatalogModel[] {
  const providers = (catalogJson as { providers?: Record<string, { models?: { id?: string; default?: boolean }[] }> } | null)?.providers
  if (!providers) return []
  const byKey = new Map<string, CatalogModel>()
  for (const models of Object.values(providers)) {
    for (const m of models?.models ?? []) {
      if (typeof m?.id !== 'string' || byKey.has(m.id)) continue
      byKey.set(m.id, { key: m.id, label: m.id, isDefault: m.id === configuredDefault })
    }
  }
  const out = [...byKey.values()]
  if (!out.some((m) => m.isDefault) && configuredDefault) out.unshift({ key: configuredDefault, label: configuredDefault, isDefault: true })
  return out
}

/** The `model.default:` line of hermes' config.yaml, whatever else is in it. */
export function hermesDefault(configYaml: string | null | undefined): string {
  return /(?:^|\n)model:\n\s*default:\s*(\S+)/.exec(String(configYaml ?? ''))?.[1] ?? ''
}

/**
 * The models the zcode runtime knows, read off its server bundle: the ids
 * (glm-5.3, glm-5.3-flash, …) are named in it. Newest first; the newest
 * plain one (no -flash/-turbo suffix) is the default — the workhorse model,
 * the suffixes are its cheaper variants.
 */
export function zcodeModels(runtimeJs: string | null | undefined): CatalogModel[] {
  const ids = [...new Set(String(runtimeJs ?? '').match(/glm-[45][\w.-]*/g) ?? [])]
    .filter((id) => /^glm-5/.test(id))
  const version = (id: string): number => Number((/^glm-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? '0'))
  const plain = (id: string): boolean => !/-(flash|turbo|highspeed|air|v\b)/.test(id)
  const sorted = ids.sort((a, b) => version(b) - version(a) || a.localeCompare(b))
  const newest = sorted.find(plain)
  const models = sorted.map((id) => ({ key: id, label: id, isDefault: id === newest }))
  // The bundle may name models the account cannot run; the plain newest still
  // leads, and the person picks another if theirs disagrees.
  return models.length ? models : []
}

/** The catalog as it stands, or null when it cannot be read here.
 *  The file keeps snapshots: the newest `seq` per agent is the live one. */
export function readCatalog(path: string): Catalog | null {
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const rows = db.prepare('select key as agent, value as json from rows order by seq').all() as unknown as Row[]
      return parseCatalog(rows)
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** The catalog's models for an agent, with the account's default first — `null` when the catalog had nothing for it. */
export function catalogFor(catalog: Catalog | null, agent: 'codex' | 'opencode' | 'omp'): CatalogModel[] | null {
  const models = catalog?.[agent]
  if (!models?.length) return null
  return [...models].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

/** Where Orca keeps the catalog, for a config directory that may not be Orca's default. */
export const catalogPath = (orcaConfig: string): string => `${orcaConfig}/agent-model-catalog.db`
