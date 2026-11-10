// Which agents Orca has enabled. Orca itself is the only authority: the
// active profile's state names every agent it knows (the `agentDefaultArgs`
// map — one entry per agent, enabled or merely supported), and its model
// catalog names the ones it has actually run. The union is what the panel
// offers, each name then matched to an adapter this plugin can run.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The agent names Orca's own state carries. Pure: callers lend the parsed files. */
export function agentKeysFrom(orcaData: unknown): string[] {
  const args = (orcaData as { settings?: { agentDefaultArgs?: Record<string, unknown> } } | null)?.settings?.agentDefaultArgs
  return Object.keys(args ?? {})
}

/** Read a JSON file, or null when it is missing or not JSON. */
async function readJson(path: string): Promise<any | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}

/**
 * The agents enabled in Orca: the active profile's `agentDefaultArgs`, plus
 * the raw agent names of the model catalog (some agents Orca runs never
 * appear in the map). Orca's default config directory when none is given.
 */
export async function enabledAgents(configDir: string, catalogKeys: string[] = []): Promise<string[]> {
  const index = await readJson(join(configDir, 'orca-profile-index.json'))
  const profileId = typeof index?.activeProfileId === 'string' ? index.activeProfileId : 'local-default'
  const data = await readJson(join(configDir, 'profiles', profileId, 'orca-data.json'))
  return [...new Set([...agentKeysFrom(data), ...catalogKeys])]
}
