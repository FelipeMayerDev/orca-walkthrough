// The diff, the cache and the background job, against this machine.
//
// ~/.local/share/orca/walkthrough/
//   entries/<key>.json     a finished walkthrough, named by everything that decides it
//   pointers/<place>.json  the one shown last for a repository and source
//   jobs/<place>/          a generation in progress (run.sh, prompt, answer)
//   read/<repo>.json       the hunks read in a repository, by content
//   turns/<repo>/<turn>/   an agent turn's snapshots (index, objects, meta.json)

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { run, type Exec } from './engine/exec'
import { buildDigest, type Digest, type DigestFile } from './engine/digest'
import { loadSections, repoAt, sourceKey, describe, bigUntracked, type Repo, type Source } from './engine/sources'
import { buildPrompt } from './engine/prompt'
import { normalize, schemaFor, VERSION, type Walkthrough } from './engine/walkthrough'
import { cacheKey, codeKey, placeKey, deadline, MAX_PROMPT_CHARS } from './engine/cache'
import { longHash, shortHash } from './engine/hash'
import { mergeRead, markStep, unmarkStep, type ReadRecord } from './engine/read'
import { jobScript, readOutcome, isRunCommand } from './engine/job'
import { agentVersion as agentVersionOf } from './engine/agents'
import { displayEnv } from './engine/clipboard'
import { parseTranscript, projectSlug, jsonPath, TRANSCRIPTS, taskKey, taskCacheKey, type Task } from './engine/task'
import { excludesLine, parseMeta, snapshotArgs, splitRecent, turnEnv, turnPaths, writeMeta, type TurnMeta } from './engine/turns'

const MAX_ENTRIES = 200
// Turns kept per repository: older ones (and their private objects) are deleted.
const MAX_TURNS = 20
// A parsed diff is kept this long: a panel navigating steps asks for hunks in
// bursts, and the agent's edits arrive slower than that.
const DIFF_TTL = 2500

export const exec: Exec = run
export const dataDir = (): string => `${process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`}/orca/walkthrough`
const entryPath = (key: string): string => `${dataDir()}/entries/${key}.json`
const pointerPath = (place: string): string => `${dataDir()}/pointers/${place}.json`
const jobDir = (place: string): string => `${dataDir()}/jobs/${place}`
const readPath = (top: string): string => `${dataDir()}/read/${longHash(top)}.json`

async function readJson<T = any>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, 'utf8')
    return text ? JSON.parse(text) as T : null
  } catch { return null }
}

async function write(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true }).catch(() => undefined)
  await writeFile(path, text, 'utf8')
}

export async function ensureDirs(): Promise<void> {
  const d = dataDir()
  await mkdir(`${d}/entries`, { recursive: true }).catch(() => undefined)
  await mkdir(`${d}/pointers`, { recursive: true }).catch(() => undefined)
  await mkdir(`${d}/jobs`, { recursive: true }).catch(() => undefined)
  await mkdir(`${d}/read`, { recursive: true }).catch(() => undefined)
}

/** The repository a folder is in (see sources.repoAt). */
export const repository = (folder: string) => repoAt(exec, folder)

/**
 * Puts text on the system clipboard. wl-copy on Wayland, xclip on X11, pbcopy on macOS.
 * The worker's environment may lack the display names entirely (it is the
 * daemon's child, not the person's shell), so the wayland or X11 socket the
 * session actually has is discovered and passed along.
 */
export async function copyText(text: string): Promise<void> {
  const path = `${dataDir()}/clipboard.md`
  await write(path, text)
  const r = await exec('sh', ['-c', COPY, 'sh', path], { env: await displayAdditions() })
  if (r.code !== 0) throw new Error((r.stderr || 'No clipboard program found (wl-copy, xclip or pbcopy).').trim())
}

/** The display names the copy command needs beyond the worker's own environment. */
async function displayAdditions(): Promise<Record<string, string>> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const candidates = [process.env.XDG_RUNTIME_DIR, `/run/user/${uid ?? 1000}`].filter((p): p is string => Boolean(p))
  let runtime: { path: string; entries: string[] } | null = null
  for (const path of [...new Set(candidates)]) {
    const entries = await readdir(path).catch(() => null)
    if (entries) {
      runtime = { path, entries }
      break
    }
  }
  const x11Dir = await readdir('/tmp/.X11-unix').catch(() => undefined)
  return displayEnv({ platform: process.platform, uid, env: process.env as Record<string, string | undefined>, runtime, x11Dir })
}

// The text is UTF-8, said so to each program: started from an app, a clipboard
// tool may read the bytes with the wrong locale and "ş" or "日" land garbled.
// wl-copy and xclip fork and hold the clipboard from a child of their own —
// their output goes to /dev/null, or that child would keep the caller's pipes
// open forever (the caller waits for them, not for the exit).
const COPY = 'if command -v pbcopy >/dev/null; then LC_ALL=en_US.UTF-8 pbcopy < "$1"; elif command -v wl-copy >/dev/null; then wl-copy --type "text/plain;charset=utf-8" < "$1" >/dev/null 2>&1; elif command -v xclip >/dev/null; then xclip -selection clipboard -target UTF8_STRING < "$1" >/dev/null 2>&1; else echo "No clipboard program found (wl-copy, xclip or pbcopy)." >&2; exit 1; fi'

/** Whether an agent's CLI can be started: its version, or null. */
export function agentVersion(command: string): Promise<string | null> {
  return agentVersionOf(exec, command)
}

export type Diff = Digest & { sk: string; what: string; unread: { path: string; why: string }[] }

const diffCache = new Map<string, { at: number; diff: Diff }>()

/** The diff of a source as it is now, parsed, with what the model would read. */
export async function readDiff(repo: Repo, source: Source): Promise<Diff> {
  const sk = sourceKey(source)
  const cached = diffCache.get(`${repo.top}\n${sk}`)
  if (cached && Date.now() - cached.at < DIFF_TTL) return cached.diff
  const { sections, unread } = await loadSections(exec, repo.top, source, { dataRoot: dataDir() })
  const digest = buildDigest(sections)
  const files = [...digest.files]
  for (const u of unread) files.push({ path: u.path, oldPath: null, status: 'added', binary: false, scope: 'unread', hunks: [], generated: false, unread: u.why })
  const diff: Diff = { ...digest, files, unread, sk, what: describe(source, repo) }
  if (diffCache.size > 8) diffCache.clear()
  diffCache.set(`${repo.top}\n${sk}`, { at: Date.now(), diff })
  return diff
}

/** The key the walkthrough of this diff would have, by this agent, in this model and language, under these preferences, matched against this task. */
export const keyFor = (repo: Repo, diff: Diff, agent: string, model: string, language: string, preferences = '', task: Task | null = null, review = false): string =>
  cacheKey({ top: repo.top, source: diff.sk, agent, model, language, preferences, files: diff.files, task: taskCacheKey(task), review })

/**
 * What people typed into Claude Code sessions working in a repository since
 * `since` (ms) until `until` (ms; 0 for no bound), oldest first: the task of a
 * change made by an agent, or of one turn. Read from Claude Code's transcripts
 * (its folder names the project by its path; a session started in a subfolder
 * counts too).
 */
export async function transcriptMessages(top: string, since: number, until = 0): Promise<{ at: number; text: string; session: string | null }[]> {
  // Claude Code shortens very long folder names; the prefix finds them, and each line's cwd decides.
  const prefix = projectSlug(top).slice(0, 120)
  const r = await exec('sh', ['-c', TRANSCRIPTS, prefix, String(Math.floor(since / 1000)), jsonPath(top)]).catch(() => null)
  return parseTranscript(r?.stdout ?? '', { top, since, until })
}

// ── turns ────────────────────────────────────────────────────────────────────
//
// Snapshots write into this data folder only — a private index and objects per
// turn — so the repository's .git is never written (see engine/turns.ts).

const turnFolder = (top: string, id: string): string => turnPaths(dataDir(), top, id).dir

/** A turn on disk, or null: an unknown or half-written id is no turn. */
export async function lookupTurn(top: string, id: string): Promise<TurnMeta | null> {
  const text = await readFile(`${turnFolder(top, id)}/meta.json`, 'utf8').catch(() => null)
  return parseMeta(text)
}

/**
 * The working tree as a git tree now, written into the turn's private index
 * and objects. Null when git failed: a snapshot is never worth holding the
 * worker up for, and a turn missing one simply has no diff (or no end).
 */
async function snapshotTree(repo: Repo, id: string): Promise<string | null> {
  try {
    const turn = turnPaths(dataDir(), repo.top, id)
    await mkdir(`${turn.dir}/objects`, { recursive: true })
    const big = await bigUntracked(exec, repo.top)
    await write(`${turn.dir}/exclude`, big.map(excludesLine).join('\n'))
    const env = turnEnv(repo.gitDir, turn.dir)
    const add = await exec('git', ['--no-optional-locks', ...snapshotArgs(`${turn.dir}/exclude`)], { cwd: repo.top, env })
    if (add.code !== 0) return null
    const tree = await exec('git', ['--no-optional-locks', 'write-tree'], { cwd: repo.top, env })
    const hash = tree.stdout.trim()
    return tree.code === 0 && /^[0-9a-f]{40}$/.test(hash) ? hash : null
  } catch { return null }
}

export type OpenTurn = { id: string; startedAt: number; terminalId: string | null; workspaceId: string | null; agent: string | null }

/** Opens a turn: the folder, its meta, the tree of the working tree as the agent got to work. */
export async function openTurn(repo: Repo, turn: OpenTurn): Promise<TurnMeta | null> {
  const beforeTree = await snapshotTree(repo, turn.id)
  const meta: TurnMeta = {
    id: turn.id, top: repo.top, startedAt: turn.startedAt, endedAt: null, outcome: null, complete: false,
    terminalId: turn.terminalId, workspaceId: turn.workspaceId, agent: turn.agent, beforeTree, afterTree: null,
  }
  await write(`${turnFolder(repo.top, turn.id)}/meta.json`, writeMeta(meta))
  await recentTurns(repo.top)
  return meta
}

/**
 * Ends a turn: the second snapshot, when and how it ended. `snapshot: false`
 * closes without one — an orphaned turn ends at its next prompt, and that
 * tree would include the person's own edits made after the interruption.
 * An unknown or already-ended id is left as it is.
 */
export async function closeTurn(repo: Repo, id: string, endedAt: number, outcome: string | null, snapshot = true): Promise<TurnMeta | null> {
  const meta = await lookupTurn(repo.top, id)
  if (!meta || meta.endedAt) return meta
  const afterTree = snapshot ? await snapshotTree(repo, id) : null
  const next: TurnMeta = { ...meta, endedAt, outcome, afterTree, complete: Boolean(meta.beforeTree && afterTree) }
  await write(`${turnFolder(repo.top, id)}/meta.json`, writeMeta(next))
  await recentTurns(repo.top)
  return next
}

/**
 * The repository's recorded turns, newest first, past ones deleted with their
 * objects: twenty per repository, so a busy day cannot fill the disk. Reading
 * is what evicts — callers get the pruning for free.
 */
export async function recentTurns(top: string): Promise<TurnMeta[]> {
  const root = `${dataDir()}/turns/${shortHash(top)}`
  const names = await readdir(root).catch(() => [] as string[])
  const metas = (await Promise.all(names.map(async (name) => {
    const text = await readFile(`${root}/${name}/meta.json`, 'utf8').catch(() => null)
    return parseMeta(text)
  }))).filter((m): m is TurnMeta => m !== null)
  const { kept, drop } = splitRecent(metas, MAX_TURNS)
  for (const gone of drop) await rm(`${root}/${gone.id}`, { recursive: true, force: true }).catch(() => undefined)
  return kept
}

export type Entry = {
  version: number
  key: string
  /** Which agent's CLI wrote this; 'claude' for every walkthrough made before there were others. */
  agent: string
  code: string
  model: string
  language: string
  top: string
  source: Source
  sk: string
  generatedAt: number
  took: number
  cost: number | null
  walkthrough: Walkthrough
  before: string[]
  task: (Task & { key: string }) | null
}

/**
 * What to show for a diff: the walkthrough written for exactly it, else the
 * last one shown here (older code, or another model or language).
 */
export async function findShown(repo: Repo, diff: Diff, key: string): Promise<{ entry: Entry; exact: boolean } | null> {
  const exact = await readJson<Entry>(entryPath(key))
  const place = placeKey(repo.top, diff.sk)
  if (exact?.version === VERSION) {
    await touch(entryPath(key))
    const pointer = await readJson<{ key: string }>(pointerPath(place))
    // Showing it makes it the last one shown, so a regeneration builds on what the reader sees.
    if (pointer?.key !== key) await write(pointerPath(place), JSON.stringify({ key, top: repo.top, source: diff.sk })).catch(() => undefined)
    return { entry: exact, exact: true }
  }
  const pointer = await readJson<{ key: string }>(pointerPath(place))
  const last = pointer?.key ? await readJson<Entry>(entryPath(pointer.key)) : null
  if (last?.version !== VERSION) return null
  await touch(entryPath(last.key))
  return { entry: last, exact: false }
}

/** The walkthrough shown last for a place, or null: the `previous` a regeneration builds on. */
export async function previousEntry(repo: Repo, diff: Diff): Promise<Entry | null> {
  const pointer = await readJson<{ key: string }>(pointerPath(placeKey(repo.top, diff.sk)))
  const last = pointer?.key ? await readJson<Entry>(entryPath(pointer.key)) : null
  return last?.version === VERSION ? last : null
}

// Eviction keeps the newest files, so showing an entry marks it new: the one a reader keeps
// coming back to outlives two hundred they looked at once. Once per entry per run is enough.
const touched = new Set<string>()
async function touch(path: string): Promise<void> {
  if (touched.has(path)) return
  touched.add(path)
  const now = new Date()
  await utimes(path, now, now).catch(() => undefined)
}

/** Whether a walkthrough with exactly this key is stored. */
export const hasEntry = async (key: string): Promise<boolean> => (await readJson<Entry>(entryPath(key)))?.version === VERSION

/** The hunks read in a repository: { "<path>:<digest>": ms }, empty when none are. */
export async function loadRead(top: string): Promise<ReadRecord> {
  const read = await readJson<ReadRecord>(readPath(top))
  return read && typeof read === 'object' && !Array.isArray(read) ? read : {}
}

/**
 * Marks (or unmarks) hunks read and returns the record as written. The record
 * is merged over what is on disk, so two windows on one repository keep each
 * other's marks.
 */
export async function saveRead(top: string, ids: string[], on: boolean): Promise<ReadRecord> {
  await ensureDirs()
  const disk = await readJson<ReadRecord>(readPath(top))
  const base = disk && typeof disk === 'object' && !Array.isArray(disk) ? disk : {}
  const mine = on ? markStep({ hunkIds: ids }, base) : unmarkStep({ hunkIds: ids }, base)
  const keys = ids.map((id) => id.slice(id.indexOf(':') + 1))
  const merged = mergeRead(disk, mine, keys)
  await write(readPath(top), JSON.stringify(merged))
  return merged
}

export const preparePrompt = (diff: Diff, options: { language: string; previous?: Walkthrough | null; preferences?: string; task?: Task | null; review?: boolean }): { system: string; prompt: string } =>
  buildPrompt({ digest: diff.text, fileCount: diff.fileCount, hunkCount: diff.hunkCount, what: diff.what, language: options.language, previous: options.previous ?? null, preferences: options.preferences ?? '', task: options.task ?? null, review: options.review ?? false })

export const promptChars = (p: { system: string; prompt: string }): number => p.system.length + p.prompt.length
export const fits = (p: { system: string; prompt: string }): boolean => promptChars(p) <= MAX_PROMPT_CHARS

export type Job = { dir: string; meta: any; done: boolean; code: string | null; pid?: string | null }

/** The running or finished-but-unread job of a repository and source, or null. */
export async function jobOf(repo: Repo, sk: string): Promise<Job | null> {
  const dir = jobDir(placeKey(repo.top, sk))
  const meta = await readJson<any>(`${dir}/meta.json`)
  if (!meta) return null
  const code = await readFile(`${dir}/code`, 'utf8').catch(() => null)
  return { dir, meta, done: code !== null, code }
}

/** Starts a generation in the background and returns its job. */
export async function startJob(repo: Repo, diff: Diff, { key, agent = 'claude', model, language, prompt, source, task = null, before = [], review = false }: { key: string; agent?: string; model: string; language: string; prompt: { system: string; prompt: string }; source: Source; task?: Task | null; before?: string[]; review?: boolean }): Promise<Job> {
  await ensureDirs()
  const dir = jobDir(placeKey(repo.top, diff.sk))
  // A run still going there (another window started it) is stopped, not orphaned.
  await stopRun(dir)
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  await mkdir(dir, { recursive: true })
  const meta = {
    key, agent, code: codeKey(diff.files), model, language, top: repo.top, source, sk: diff.sk, startedAt: Date.now(), deadline: Date.now() + deadline(diff.hunkCount),
    idByAlias: diff.idByAlias, digestFiles: diff.digestFiles, hunkCount: diff.hunkCount, before,
    // Kept with the walkthrough: where its task came from, and the key that tells when the task has changed since.
    task: task ? { ...task, key: taskKey(task) } : null,
    review,
  }
  await writeFile(`${dir}/system.txt`, prompt.system, 'utf8')
  await writeFile(`${dir}/prompt.txt`, prompt.prompt, 'utf8')
  await writeFile(`${dir}/schema.json`, JSON.stringify(schemaFor(Boolean(task), review)), 'utf8')
  await writeFile(`${dir}/run.sh`, jobScript(agent), 'utf8')
  await writeFile(`${dir}/meta.json`, JSON.stringify(meta), 'utf8')
  // Detached: the run outlives the worker, and Orca with it.
  // run.sh stops the agent itself at the deadline, so a hung run ends even with no one watching.
  const seconds = String(Math.ceil((meta.deadline - meta.startedAt) / 1000))
  const child = spawn('sh', [`${dir}/run.sh`, model, seconds], { detached: true, stdio: 'ignore' })
  child.unref()
  return { dir, meta, done: false, code: null }
}

/**
 * The pid a job folder recorded, only while it is still that folder's claude
 * run. After a reboot the number can belong to anything; it is never signalled
 * on the strength of the file alone.
 */
async function runPid(dir: string, known: string | null = null): Promise<string | null> {
  const pid = known ?? (await readFile(`${dir}/pid`, 'utf8').catch(() => null))?.trim() ?? null
  if (!pid || !/^\d+$/.test(pid)) return null
  const r = await exec('ps', ['-o', 'command=', '-p', pid]).catch(() => null)
  return r?.code === 0 && isRunCommand(r.stdout) ? pid : null
}

async function stopRun(dir: string): Promise<void> {
  const pid = await runPid(dir)
  if (pid) await exec('kill', [pid]).catch(() => undefined)
}

/** Whether a job's agent is still running (a reboot leaves a job with no answer and no process). */
export async function alive(job: Job): Promise<boolean> {
  job.pid ??= (await readFile(`${job.dir}/pid`, 'utf8').catch(() => null))?.trim() || null
  if (!job.pid) return Date.now() - (job.meta.startedAt ?? job.meta.started ?? 0) < 10_000 // not started yet
  return (await runPid(job.dir, job.pid)) !== null
}

export async function cancelJob(job: Job): Promise<void> {
  await stopRun(job.dir)
  await rm(job.dir, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * A finished job → a stored walkthrough (and the pointer at it). The job's
 * folder goes either way; a failure is thrown with the reason. Two windows on
 * one repository both see the answer arrive: the folder is claimed by renaming
 * it (atomic), and the window that loses gets null and simply reads again.
 */
export async function finishJob(job: Job): Promise<Entry | null> {
  const claimed = `${job.dir}.taken-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  try {
    await rename(job.dir, claimed)
  } catch {
    return null
  }
  try {
    const read = (name: string): Promise<string | null> => readFile(`${claimed}/${name}`, 'utf8').catch(() => null)
    const { raw, cost } = readOutcome(job.meta.agent ?? 'claude', { out: await read('out.json'), err: await read('err.txt'), code: job.code })
    const walkthrough = normalize(raw, job.meta.idByAlias ?? {}, job.meta.digestFiles ?? [], { asks: Boolean(job.meta.task), review: Boolean(job.meta.review) })
    const { key, model, language, top, source, sk } = job.meta
    // `before`: the hunks of the walkthrough shown when this one was asked for, to tell what changed since it was read.
    const entry: Entry = { version: VERSION, key, agent: job.meta.agent ?? 'claude', code: job.meta.code, model, language, top, source, sk, generatedAt: Date.now(), took: Date.now() - (job.meta.startedAt ?? job.meta.started ?? Date.now()), cost, walkthrough, before: job.meta.before ?? [], task: job.meta.task ?? null }
    await ensureDirs()
    await write(entryPath(key), JSON.stringify(entry))
    await write(pointerPath(placeKey(top, sk)), JSON.stringify({ key, top, source: sk }))
    await evict()
    return entry
  } finally {
    await rm(claimed, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Keeps the newest entries. An entry is a few KB; nothing goes for being merely old. */
async function evict(): Promise<void> {
  const dir = `${dataDir()}/entries`
  const names = await readdir(dir).catch(() => [] as string[])
  const jsons = names.filter((n) => n.endsWith('.json'))
  if (jsons.length <= MAX_ENTRIES) return
  const dated = await Promise.all(jsons.map(async (name) => ({ name, at: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })))
  for (const { name } of dated.sort((a, b) => b.at - a.at).slice(MAX_ENTRIES)) {
    await unlink(join(dir, name)).catch(() => undefined)
  }
}
