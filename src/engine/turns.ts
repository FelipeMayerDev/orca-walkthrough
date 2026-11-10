// Turns: what an agent changed while answering one prompt. The Orca host tells
// the worker when an agent starts and stops working (`agent.status.changed`);
// at each boundary a snapshot of the working tree is written as a git tree in
// the plugin's own data folder — a private index and object directory, so the
// repository's .git is never written. The diff of the two trees is the turn.
//
// Everything here is plain functions so it runs in the worker and under tests:
// the state machine decides what a status change means, the builders produce
// the git arguments and environment, and the meta type is what lands on disk.
// Reading and writing the files themselves is the worker's (store.ts).

import { shortHash } from './hash'

// The four statuses Orca reports, and the ones a turn cares about: `blocked`
// (a permission question, a clarification) keeps a turn open; `done` and
// `waiting` end it, whatever their outcome — a cancelled turn still changed
// the tree, and the diff up to the cancellation is honest.
export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

/** The part of `agent.status.changed` a turn reads. `at` prefers the main agent's `stateStartedAt` over `receivedAt`. */
export type TurnEvent = {
  workspaceId: string | null
  paneKey: string
  terminalId?: string
  title?: string
  state: AgentState
  at: number
  outcome?: string | null
}

/** What the worker keeps per agent: the last status it saw, '' for never seen. */
export type TurnStates = Record<string, AgentState | ''>

export type TurnAction =
  | { kind: 'open'; key: string; startedAt: number; agent: string | null }
  | { kind: 'close'; key: string; endedAt: number; outcome: string | null }
  | { kind: 'none' }

/** The agent a turn belongs to: its workspace and terminal, as one map key. */
export const turnKey = (event: Pick<TurnEvent, 'workspaceId' | 'paneKey' | 'terminalId'>): string =>
  `${event.workspaceId ?? ''}\u0000${event.terminalId ?? event.paneKey}`

/**
 * What one status change means. A turn opens when an agent that wasn't working
 * starts; a turn seen working without having seen it start (the plugin loaded
 * mid-turn) opens nothing — a diff from the middle of a turn would present a
 * fraction of it as the whole. Closing tolerates the same: the worker just has
 * no turn to close. `blocked` never moves the turn.
 */
export function stepTurn(states: TurnStates, event: TurnEvent): TurnAction {
  if (!event.workspaceId) return { kind: 'none' }
  const key = turnKey(event)
  const was = states[key] ?? ''
  if (was === event.state) return { kind: 'none' }
  if (event.state === 'working') {
    // Blocked was the same turn paused (a permission question), and '' is a
    // turn we never saw begin: neither opens one. Only a turn that ended does.
    if (was === '' || was === 'working' || was === 'blocked') return { kind: 'none' }
    return { kind: 'open', key, startedAt: event.at, agent: event.title ?? null }
  }
  if (event.state === 'done' || event.state === 'waiting') {
    if (was !== 'working') return { kind: 'none' }
    return { kind: 'close', key, endedAt: event.at, outcome: event.outcome ?? null }
  }
  return { kind: 'none' }
}

/** A turn's stable name: part of its pointer, cache key and folder on disk. */
export const turnId = (startedAt: number, key: string): string => `${startedAt}-${shortHash(key)}`

/** Where a turn's files live, under the plugin's data root. Layout: `turns/<repo>/<turn>/`. */
export function turnPaths(dataRoot: string, top: string, id: string): { dir: string; index: string; objects: string } {
  const dir = `${dataRoot}/turns/${shortHash(top)}/${id}`
  return { dir, index: `${dir}/index`, objects: `${dir}/objects` }
}

/**
 * The environment that points git at a turn's private index and objects, with
 * the repository's objects kept readable as alternates: the snapshot needs
 * them to write trees over tracked files, the diff to read them back. Nothing
 * under the repository is written, not even a modification time.
 */
export function turnEnv(gitDir: string, turnDir: string): Record<string, string> {
  return {
    GIT_INDEX_FILE: `${turnDir}/index`,
    GIT_OBJECT_DIRECTORY: `${turnDir}/objects`,
    GIT_ALTERNATIVE_OBJECT_DIRECTORIES: `${gitDir}/objects`,
  }
}

/** `git add -A` for a snapshot: quiet like the reads, with the exclusions file that keeps big new files out. */
export const snapshotArgs = (excludesFile: string): string[] => ['-c', `core.excludesFile=${excludesFile}`, 'add', '-A', '--']

/** One line of the exclusions file for an untracked path: anchored at the root, `#` and `!` escaped. */
export const excludesLine = (path: string): string => `/${path.replace(/^([#!])/, '\\$1')}`

/** What a snapshot leaves on disk about a turn. */
export type TurnMeta = {
  id: string
  top: string
  startedAt: number
  endedAt: number | null
  /** Orca's word for how it ended: success, cancellation, failure, superseded… */
  outcome: string | null
  /** Both snapshots exist, so the diff is the whole turn. */
  complete: boolean
  terminalId: string | null
  workspaceId: string | null
  agent: string | null
  beforeTree: string | null
  afterTree: string | null
}

export const writeMeta = (meta: TurnMeta): string => JSON.stringify(meta)

/** Whatever a file held, as a turn, or null (a hand-edited or half-written file is no turn at all). */
export function parseMeta(text: string | null | undefined): TurnMeta | null {
  let j: any
  try { j = JSON.parse(String(text ?? '')) } catch { return null }
  if (typeof j !== 'object' || j === null) return null
  const at = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const startedAt = at(j.startedAt)
  if (!startedAt || typeof j.id !== 'string' || typeof j.top !== 'string') return null
  const tree = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f]{40}$/.test(v) ? v : null)
  return {
    id: j.id, top: j.top, startedAt,
    endedAt: at(j.endedAt) || null,
    outcome: typeof j.outcome === 'string' ? j.outcome : null,
    complete: j.complete === true,
    terminalId: typeof j.terminalId === 'string' ? j.terminalId : null,
    workspaceId: typeof j.workspaceId === 'string' ? j.workspaceId : null,
    agent: typeof j.agent === 'string' ? j.agent : null,
    beforeTree: tree(j.beforeTree),
    afterTree: tree(j.afterTree),
  }
}

/** Newest first. */
export const recentFirst = (metas: TurnMeta[]): TurnMeta[] => metas.sort((a, b) => b.startedAt - a.startedAt)

/** The turns to keep, and the ones to delete, so a busy day cannot fill the disk. */
export function splitRecent(metas: TurnMeta[], max: number): { kept: TurnMeta[]; drop: TurnMeta[] } {
  return { kept: recentFirst(metas).slice(0, max), drop: recentFirst(metas).slice(max) }
}
