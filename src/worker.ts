// The walkthrough worker. The panel asks; this reads git, gh and the stored
// walkthroughs, and runs generations of `claude -p` in the background. Between
// requests it listens to agents starting and stopping, and snapshots each turn
// of theirs into the data folder (see engine/turns.ts).

import type { OrcaWorkerApi, PluginEvents } from 'orca/worker'
import './protocol'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { matchFocused } from './workspace'
import * as store from './store'
import {
  currentHead, defaultBase, baseChoices, recentCommits, pullRequests, commitMessage, taskSince,
  sourceKey, type Repo, type Source,
} from './engine/sources'
import type { Task } from './engine/task'
import { stepTurn, turnId, turnKey, type TurnEvent, type TurnStates } from './engine/turns'
import { overlay, overlayAsks } from './engine/walkthrough'
import { indexHunks } from './engine/hunks'
import { estimateTokens, MAX_PROMPT_CHARS } from './engine/cache'
import { isRead } from './engine/read'
import { resolveTask, taskKey, taskCacheKey, TASK_MODES, type TaskMode } from './engine/task'
import { AGENTS, DEFAULT_AGENT, agentOf, modelOf, agentVersion, agentsEnabled, type AgentDef } from './engine/agents'
import { readCatalog, catalogFor, catalogPath, hermesModels, hermesDefault, zcodeModels, type Catalog } from './engine/catalog'
import { enabledAgents } from './engine/orcaConfig'
import { DEFAULT_LANGUAGE } from './engine/languages'
import { toMarkdown } from './engine/export'
import type {
  AskOut, DiffAnswer, FileSummary, GenerateAnswer, PollAnswer, ScopesAnswer, StateAnswer,
  StepOut, TurnSummary, ViewAnswer, EntryMeta, HunkRef, HunkLines, UncoveredOut,
} from './protocol'

const invalid = (message: string): Error => Object.assign(new Error(message), { code: 'invalid_params' })

// Prompts land in a transcript a moment before (or after) the agent's status
// says it started; a turn's prompts are read with this much slack on each side.
const TURN_SLACK = 5000

let agentsChecked: { key: string; name: string; available: boolean; models: { key: string; label: string; isDefault: boolean }[] }[] | undefined
let modelsCatalog: Catalog | null = null

/** The model to run with: the requested one when the agent offers it, else
 *  the account's default, else whatever the agent is configured with. An
 *  empty request is the panel's "Default" — the agent's own configuration,
 *  never a name guessed from a list. */
function chooseModel(agent: AgentDef, requested: string): string {
  if (requested === '') return ''
  const models = modelsOf(agent)
  if (models.length) {
    if (models.some((m) => m.key === requested)) return requested
    return models.find((m) => m.isDefault)?.key ?? models[0]!.key
  }
  return modelOf(agent.key, requested).key
}

/** An agent's models: Orca's catalog when it has them, hermes' own cache for
 *  hermes, the zcode runtime's bundle for zcode, else the static list. */
function modelsOf(agent: AgentDef): { key: string; label: string; isDefault: boolean }[] {
  const catalog = catalogFor(modelsCatalog, agent.key as 'codex' | 'opencode' | 'omp')
  if (catalog) return catalog
  if (agent.key === 'hermes') return hermesModelsList()
  if (agent.key === 'zcode') return zcodeModelsList()
  return agent.models.map((m, i) => ({ key: m.key, label: m.name, isDefault: m.key === agent.defaultModel && i === 0 }))
}

/** Hermes' model catalog (its picker's cache) with the person's configured
 *  default marked; read once, kept for the worker's life. */
let hermesChecked: { key: string; label: string; isDefault: boolean }[] | null = null
function hermesModelsList(): { key: string; label: string; isDefault: boolean }[] {
  if (hermesChecked) return hermesChecked
  const home = join(homedir(), '.hermes')
  const read = (rel: string): string | null => {
    try { return readFileSync(join(home, rel), 'utf8') } catch { return null }
  }
  let cache: unknown = null
  try { cache = JSON.parse(read('cache/model_catalog.json') ?? 'null') } catch { cache = null }
  hermesChecked = cache ? hermesModels(cache, hermesDefault(read('config.yaml'))) : []
  return hermesChecked
}

/** ZCode's models, read off the runtime's server bundle; read once. */
let zcodeChecked: { key: string; label: string; isDefault: boolean }[] | null = null
function zcodeModelsList(): { key: string; label: string; isDefault: boolean }[] {
  if (zcodeChecked) return zcodeChecked
  try {
    zcodeChecked = zcodeModels(readFileSync(join(homedir(), '.zcode', 'runtime', 'current', 'server', 'entry-http.js'), 'utf8'))
  } catch {
    zcodeChecked = []
  }
  return zcodeChecked
}

async function settings(orca: OrcaWorkerApi): Promise<{ agent: string; model: string; language: string; preferences: string }> {
  const all = await orca.settings.get().catch(() => ({}) as Record<string, unknown>)
  const agent = agentOf(typeof all.agent === 'string' ? all.agent : DEFAULT_AGENT)
  return {
    agent: agent.key,
    // A model remembered for another agent never reaches that agent's CLI.
    model: modelOf(agent.key, typeof all.model === 'string' ? all.model : agent.defaultModel).key,
    language: typeof all.language === 'string' ? all.language : DEFAULT_LANGUAGE,
    preferences: typeof all.preferences === 'string' ? all.preferences : '',
  }
}

async function repoOf(top: string) {
  const repo = await store.repository(top)
  if (!repo) throw invalid(`"${top}" is not inside a git repository.`)
  return repo
}

/** The agents list, with a quiet shape before any check has run. */
const agentsOf = (checked: { key: string; name: string; available: boolean; models: { key: string; label: string; isDefault: boolean }[] }[]): { key: string; name: string; available: boolean; models: { key: string; label: string; isDefault: boolean }[] }[] =>
  checked.length ? checked : AGENTS.slice(0, 1).map((a) => ({ key: a.key, name: a.name, available: false, models: modelsOf(a) }))

/** The task a source carries with it, in auto mode: the PR's description, the commit's message, or the prompts sent to agents while the change was made. */
async function taskFor(top: string, source: Source): Promise<Task | null> {
  switch (source.kind) {
    case 'pr': {
      const pulls = await pullRequests(store.exec, top).catch(() => [] as Awaited<ReturnType<typeof pullRequests>>)
      const pr = pulls.find((p) => p.number === source.number) ?? null
      return resolveTask({ mode: 'auto', source, pr })
    }
    case 'commit':
      return resolveTask({ mode: 'auto', source, commit: await commitMessage(store.exec, top, source.hash) })
    case 'uncommitted': case 'staged': case 'unstaged': case 'branch': {
      const { since, label } = await taskSince(store.exec, top, source)
      const prompts = await store.transcriptMessages(top, since)
      return resolveTask({ mode: 'auto', source, prompts, since: label })
    }
    case 'turn': {
      // What was asked of this turn: the prompts sent while the agent answered it.
      const meta = await store.lookupTurn(top, source.id)
      if (!meta) return null
      const prompts = await store.transcriptMessages(top, meta.startedAt - TURN_SLACK, meta.endedAt ?? 0)
      return resolveTask({ mode: 'auto', source, prompts })
    }
    default:
      return null
  }
}

function diffAnswer(diff: store.Diff): DiffAnswer {
  const files: FileSummary[] = diff.files.map((f) => {
    const summary: FileSummary = {
      path: f.path, oldPath: f.oldPath, status: f.status, binary: f.binary, generated: f.generated,
      scope: f.scope, hunkCount: f.hunks.length,
      added: f.hunks.reduce((n, h) => n + h.added, 0), deleted: f.hunks.reduce((n, h) => n + h.deleted, 0),
    }
    if (f.unread) summary.unread = f.unread
    return summary
  })
  const tokens = estimateTokens(diff.text.length)
  return { sk: diff.sk, what: diff.what, fileCount: diff.fileCount, hunkCount: diff.hunkCount, tokens, tooBig: tokens * 3.6 > MAX_PROMPT_CHARS, files }
}

const hunkRef = (id: string, header: string, added: number, deleted: number, path: string, status: string, scope: string): HunkRef =>
  ({ id, header, added, deleted, path, status, scope })

// A workspace on a paired Orca server (`runtime:…`) has its files there, not
// here: its requests are forwarded to this plugin's worker on that server.
// ponytail: through the CLI's `plugin dev request`, which reaches only a dev
// plugin keyed `local.walkthrough`; a host API for it would replace this.
const SERVER_PLUGIN = 'local.walkthrough'
// The worker may run in its own Node, so the CLI is looked for in each place it lives.
const cliCandidates = (): string[] => [
  process.env.ORCA_CLI,
  ...(process.platform === 'win32'
    ? [
        join(dirname(process.execPath), 'resources', 'bin', 'orca.exe'),
        join(dirname(process.execPath), '..', 'bin', 'orca.exe'),
        join(cliEnv().LOCALAPPDATA ?? '', 'Programs', 'orca', 'resources', 'bin', 'orca.exe'),
        'orca.exe',
      ]
    : ['orca', 'orca-ide']),
].filter((c): c is string => Boolean(c))
// The worker's environment is stripped: the CLI still needs Windows' profile folders.
const cliEnv = (): Record<string, string> => process.platform === 'win32'
  ? { APPDATA: process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), LOCALAPPDATA: process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local') }
  : {}
let cliFound: string | undefined
let cliTried = ''
async function orcaCliPath(): Promise<string | null> {
  if (cliFound) return cliFound
  const tried: string[] = []
  for (const c of cliCandidates()) {
    const r = await store.exec(c, ['--version'], { env: cliEnv() }).catch((e: Error) => { tried.push(`${c}: ${e.message}`); return null })
    if (r) { cliFound = c; return c }
  }
  cliTried = `execPath ${process.execPath}; ${tried.join('; ')}`
  return null
}
let serverWhy = ''
let serverMissing = false
// What a server answers when this plugin isn't loaded there for development.
const NOT_LOADED = /not a loaded development plugin|only reaches development plugins/
export const SERVER_SETUP =
  'git clone https://github.com/FelipeMayerDev/orca-walkthrough ~/.local/share/orca-walkthrough && orca plugin dev load ~/.local/share/orca-walkthrough'
const onServer = new Map<string, string>() // workspace path or repository top → runtime id
const workspaceOf = new Map<string, string>() // workspace path or repository top → the id this Orca opens editors in

// A walkthrough opens in an editor tab from a small file naming what it reads:
// `.walkthrough/<source>.walkthrough.json` in the workspace, kept out of git.
export type WalkthroughFile = { top: string; source: Source; agent: string; model: string; language: string; /** The paired server it is on, for the tab to name as `via`. */ server?: string }
const fileName = (source: Source): string =>
  `${sourceKey(source).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'change'}.walkthrough.json`

async function writeWalkthroughFile(file: WalkthroughFile): Promise<{ path: string }> {
  const rel = `.walkthrough/${fileName(file.source)}`
  await mkdir(join(file.top, '.walkthrough'), { recursive: true })
  await writeFile(join(file.top, rel), `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  // Out of `git status` without touching a tracked .gitignore.
  const r = await store.exec('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: file.top }).catch(() => null)
  const exclude = r?.code === 0 ? join(file.top, r.stdout.trim()) : null
  if (exclude) {
    const text = await readFile(exclude, 'utf8').catch(() => '')
    if (!text.split('\n').includes('.walkthrough/')) {
      await mkdir(dirname(exclude), { recursive: true })
      await writeFile(exclude, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.walkthrough/\n`, 'utf8')
    }
  }
  return { path: rel }
}

async function forward(runtime: string, name: string, input: unknown): Promise<any> {
  const cli = await orcaCliPath()
  if (!cli) throw new Error(`Orca CLI not found (${cliTried})`)
  const r = await store.exec(cli, [
    'plugin', 'dev', 'request', SERVER_PLUGIN, name, '--data', JSON.stringify(input ?? {}),
    '--panel', 'walkthrough', '--environment', runtime, '--timeout-ms', '120000',
  ], { env: cliEnv() })
  if (r.code !== 0) throw new Error(`Orca server ${runtime}: ${(r.stderr || r.stdout).trim()}`)
  return JSON.parse(r.stdout)
}

/** Runs the Orca CLI with `--json`, on a paired server when `runtime` names one; its `result`, or the error it gave. */
async function orcaJson(args: string[], runtime?: string): Promise<any> {
  const cli = await orcaCliPath()
  if (!cli) throw new Error(`Orca CLI not found (${cliTried})`)
  const r = await store.exec(cli, [...args, '--json', ...(runtime ? ['--environment', runtime] : [])], { env: cliEnv() })
  let answer: any
  try { answer = JSON.parse(r.stdout) } catch { throw new Error((r.stderr || r.stdout).trim() || `orca ${args[0]} failed`) }
  if (!answer?.ok) throw new Error(answer?.error?.message ?? `orca ${args.slice(0, 2).join(' ')} failed`)
  return answer.result
}

// The paired servers this client reaches: Orca lists their workspaces apart,
// so `workspace.list` here leaves them out and only the CLI names them.
async function pairedRuntimes(): Promise<string[]> {
  const cli = await orcaCliPath()
  if (!cli) { serverWhy = `Orca CLI not found (${cliTried})`; return [] }
  const r = await store.exec(cli, ['worktree', 'list', '--json'], { env: cliEnv() }).catch((e: Error) => { serverWhy = e.message; return null })
  if (!r || r.code !== 0) { serverWhy ||= `worktree list: ${r?.stderr || r?.stdout}`; return [] }
  try {
    const scope = JSON.parse(r.stdout)?.result?.hostScope ?? {}
    const ids: string[] = [...(scope.hostIds ?? []), ...(scope.omittedHostIds ?? [])]
    return [...new Set(ids.filter((id) => id.startsWith('runtime:')).map((id) => id.slice('runtime:'.length)))]
  } catch { return [] }
}

/** A focused workspace on a paired server: its id ends in `::<path there>`; the first server that knows that path reads it. */
async function serverState(workspaceId: string | undefined): Promise<StateAnswer | null> {
  const at = workspaceId?.indexOf('::') ?? -1
  if (!workspaceId || at < 0) return null
  const path = workspaceId.slice(at + 2)
  serverWhy = ''
  serverMissing = false
  const runtimes = await pairedRuntimes()
  if (!runtimes.length) { serverWhy ||= 'no paired Orca server'; return null }
  const why: string[] = []
  for (const runtime of runtimes) {
    const answer: StateAnswer | null = await forward(runtime, 'walkthrough.state', { path }).catch((e: Error) => { why.push(e.message); if (NOT_LOADED.test(e.message)) serverMissing = true; return null })
    if (!answer?.workspace) { if (answer) why.push(`${runtime}: ${answer.error ?? 'unknown path'}`); continue }
    onServer.set(answer.workspace.path, runtime)
    if (answer.repo) onServer.set(answer.repo.top, runtime)
    return answer
  }
  serverWhy = why.join('; ')
  return null
}

export default function activate(orca: OrcaWorkerApi): void {
  // Every handler but the state one is keyed by `top`: a server's top goes there.
  // An editor tab names its server itself (`via`): it may outlive the panel that taught this worker.
  const handle = ((name: string, fn: (input: any) => unknown) =>
    orca.panels.handle(name as never, (async (input: any) => {
      const { via, ...rest } = input ?? {}
      const runtime = (typeof rest.top === 'string' ? onServer.get(rest.top) : undefined) ?? via
      return runtime ? forward(runtime, name, rest) : fn(rest)
    }) as never)) as typeof orca.panels.handle

  orca.panels.handle('walkthrough.state', async (input): Promise<StateAnswer> => {
    const pick = input?.pick || ''
    const context = await orca.host.call('workspace.readContext').catch(() => null)
    if (!context) return { workspace: null, repo: null, agents: agentsOf([]), error: null, choices: [] }
    const { workspaces } = await orca.host.call('workspace.list')
    // Name and branch first, then the name alone, then a unique branch match (a
    // folder whose display name differs from its folder name still reads).
    let match = matchFocused(context, workspaces)
      ?? (workspaces.filter((w) => (w.branch ?? '').replace(/^refs\/heads\//, '') === context.branch).length === 1
        ? workspaces.find((w) => (w.branch ?? '').replace(/^refs\/heads\//, '') === context.branch)! : null)
      ?? null
    // A forwarding client names the workspace outright.
    if (input?.path) match = workspaces.find((w) => w.path === input.path) ?? null
    // A reader's explicit choice overrides only when matching failed.
    if (!match && pick) match = workspaces.find((w) => w.path === pick) ?? null
    const choices = workspaces.map((w) => ({ path: w.path, name: w.name, branch: w.branch ?? null }))
    if (!match && !input?.path) {
      const remote = await serverState(context.workspaceId)
      if (remote) {
        if (context.workspaceId) for (const p of [remote.workspace?.path, remote.repo?.top]) if (p) workspaceOf.set(p, context.workspaceId)
        return { ...remote, choices: [...remote.choices, ...choices] }
      }
    }
    if (!match && serverMissing) {
      return {
        workspace: null, repo: null, agents: agentsOf([]), choices: [], serverSetup: SERVER_SETUP,
        error: `"${context.displayName}" is on a paired Orca server, where Walkthrough is not loaded for development.`,
      }
    }
    if (!match) {
      return {
        workspace: null, repo: null, agents: agentsOf([]), choices,
        error: `Could not match the focused workspace "${context.displayName}" to exactly one workspace in Orca. Pick one below. (id ${context.workspaceId ?? 'none'}; listed: ${workspaces.filter((w) => w.name === context.displayName).map((w) => `${w.id} @ ${w.hostId}`).join(', ') || 'none by that name'}${serverWhy ? `; server: ${serverWhy}` : ''})`,
      }
    }
    const runtime = match.hostId?.startsWith('runtime:') ? match.hostId.slice('runtime:'.length) : null
    if (runtime) {
      const answer: StateAnswer = await forward(runtime, 'walkthrough.state', { path: match.path })
      onServer.set(match.path, runtime)
      workspaceOf.set(match.path, match.id)
      if (answer.repo) { onServer.set(answer.repo.top, runtime); workspaceOf.set(answer.repo.top, match.id) }
      return { ...answer, choices }
    }
    if (agentsChecked === undefined) {
      // Which agents Orca has enabled, and what each offers: its own profile
      // state and model catalog say — the same lists its pickers are built of.
      // Only the ones whose CLI actually runs are offered; an agent Orca
      // merely knows about would only be noise with "(not found)" on it.
      const configDir = process.env.ORCA_CONFIG_DIR ?? join(homedir(), '.config', 'orca')
      modelsCatalog = readCatalog(catalogPath(configDir))
      const orcaKeys = await enabledAgents(configDir, modelsCatalog?.keys ?? []).catch(() => [] as string[])
      const checked = await Promise.all(agentsEnabled(orcaKeys).map(async (a) => ({
        key: a.key, name: a.name,
        available: (await agentVersion(store.exec, a.command).catch(() => null)) !== null,
        models: modelsOf(a),
      })))
      const usable = checked.filter((a) => a.available)
      agentsChecked = usable.length ? usable : checked
    }
    const repo = await store.repository(match.path)
    workspaceOf.set(match.path, match.id)
    if (repo) workspaceOf.set(repo.top, match.id)
    return {
      workspace: input?.path
        ? { path: match.path, name: match.name, branch: match.branch?.replace(/^refs\/heads\//, '') || null }
        : { path: match.path, name: context.displayName, branch: context.branch || null },
      repo, agents: agentsOf(agentsChecked), error: null, choices,
    }
  })

  // Where the files are: here, or (forwarded) on the server.
  handle('walkthrough.write', (file: WalkthroughFile) => writeWalkthroughFile(file))

  // Opening is this Orca's own: its window shows the tab, whichever host writes the file.
  orca.panels.handle('walkthrough.open', async (input) => {
    const workspaceId = workspaceOf.get(input.top)
    if (!workspaceId) throw invalid('This workspace is not known yet: reopen the panel.')
    const via = onServer.get(input.top)
    const file: WalkthroughFile = { ...input, ...(via ? { server: via } : {}) }
    const { path } = via ? await forward(via, 'walkthrough.write', file) : await writeWalkthroughFile(file)
    await orca.host.call('editor.open', { workspaceId, path })
    return { path }
  })

  // Asking an agent about a step: this Orca's own terminals and agents, never forwarded.
  orca.panels.handle('walkthrough.agents', async ({ top, agent }) => {
    const workspaceId = workspaceOf.get(top)
    const { agents } = await orca.host.call('agents.list', workspaceId ? { workspaceId } : undefined).catch(() => ({ agents: [] }))
    const running = agents.filter((a) => a.terminalId).map((a) => ({ terminalId: a.terminalId!, title: a.title, agent: a.agent, state: a.state }))
    // What can start one: the agents found here, else the one that wrote the walkthrough.
    const keys = agentsChecked?.filter((a) => a.available).map((a) => a.key) ?? [agent || DEFAULT_AGENT]
    const launchable = keys.map((key) => ({ key, name: agentOf(key).name }))
    return { running, launchable }
  })

  orca.panels.handle('walkthrough.ask', async ({ top, text, terminalId, agent }) => {
    if (terminalId) {
      // ponytail: one line, as Enter submits in agent TUIs; a paste API would keep the line breaks.
      const { accepted } = await orca.host.call('terminal.sendText', { terminalId, text: text.replace(/\s*\n\s*/g, ' · '), enter: true })
      if (!accepted) throw invalid('The terminal did not take the text.')
      await orca.host.call('terminal.focus', { terminalId }).catch(() => undefined)
      return { terminalId }
    }
    const workspaceId = workspaceOf.get(top)
    if (!workspaceId) throw invalid('This workspace is not known yet: reopen the panel.')
    const launched = await orca.host.call('agent.launch', { workspaceId, agent: agentOf(agent ?? DEFAULT_AGENT).orcaKeys[0] ?? 'claude', prompt: text })
    await orca.host.call('terminal.focus', { terminalId: launched.terminalId }).catch(() => undefined)
    return { terminalId: launched.terminalId }
  })

  // A new session from a step: a child worktree of this one, on its branch, with an agent given the step.
  orca.panels.handle('walkthrough.session', async ({ top, text, agent, name }) => {
    const runtime = onServer.get(top)
    const { worktree } = await orcaJson(['worktree', 'show', '--worktree', `path:${top}`], runtime)
    const branch = String(worktree?.branch ?? '').replace(/^refs\/heads\//, '')
    const result = await orcaJson([
      'worktree', 'create', '--name', name, '--repo', `id:${worktree.repoId}`, '--parent-worktree', `path:${top}`,
      ...(branch ? ['--base-branch', branch] : []),
      '--agent', agentOf(agent || DEFAULT_AGENT).orcaKeys[0] ?? 'claude', '--prompt', text, '--activate',
    ], runtime)
    return { name: String(result?.worktree?.displayName ?? name), path: String(result?.worktree?.path ?? '') }
  })

  handle('walkthrough.scopes', async ({ top }): Promise<ScopesAnswer> => {
    const current = await currentHead(store.exec, top).catch(() => '')
    const [def, choices, commits, metas] = await Promise.all([
      defaultBase(store.exec, top, current || null),
      baseChoices(store.exec, top, current || null),
      recentCommits(store.exec, top, 30),
      store.recentTurns(top),
    ])
    let pulls: Awaited<ReturnType<typeof pullRequests>> = []
    let prError: string | null = null
    try { pulls = await pullRequests(store.exec, top, current || null) } catch (e) { prError = e instanceof Error ? e.message : String(e) }
    // Each turn's own prompt for its label, in one transcript read for all of them.
    let sent: Awaited<ReturnType<typeof store.transcriptMessages>> = []
    if (metas.length) sent = await store.transcriptMessages(top, metas[metas.length - 1]!.startedAt - TURN_SLACK).catch(() => [])
    const turns: TurnSummary[] = metas.map((m) => {
      const mine = sent.filter((p) => p.at >= m.startedAt - TURN_SLACK && (!m.endedAt || p.at <= m.endedAt))
      return {
        id: m.id, startedAt: m.startedAt, endedAt: m.endedAt, outcome: m.outcome, complete: m.complete, agent: m.agent,
        prompt: (mine[0]?.text ?? '').split('\n')[0]?.slice(0, 70) ?? '',
        before: m.beforeTree, after: m.afterTree,
      }
    })
    return { current, defaultBase: def, bases: choices, commits, pulls, prError, turns }
  })

  handle('walkthrough.diff', async ({ top, source }): Promise<DiffAnswer> => {
    const repo = await repoOf(top)
    return diffAnswer(await store.readDiff(repo, source))
  })

  handle('walkthrough.view', async ({ top, source, agent, model, language }): Promise<ViewAnswer> => {
    const repo = await repoOf(top)
    const { agent: defAgent, model: defModel, language: defLanguage, preferences } = await settings(orca)
    const chosenAgent = agentOf(agent ?? defAgent)
    const chosenModel = chooseModel(chosenAgent, model ?? defModel)
    const chosenLanguage = language ?? defLanguage
    const diff = await store.readDiff(repo, source)
    const taskNow = await taskFor(repo.top, source)
    const key = store.keyFor(repo, diff, chosenAgent.key, chosenModel, chosenLanguage, preferences, taskNow)
    const shown = await store.findShown(repo, diff, key)

    const job = await store.jobOf(repo, diff.sk)
    const running = job && !job.done ? await store.alive(job) : false
    const jobOut = job ? { running, startedAt: job.meta.startedAt, deadline: job.meta.deadline, agent: job.meta.agent ?? 'claude', model: job.meta.model } : null

    if (!shown) {
      return {
        diff: diffAnswer(diff), key, shown: null, parts: [], uncovered: [], outdated: 0,
        task: null, taskNow, asks: null,
        job: jobOut,
      }
    }

    const { entry, exact } = shown
    const view = overlay(entry.walkthrough, diff.files)
    const read = await store.loadRead(repo.top)
    const parts = view.parts.map((part) => ({
      title: part.title, blurb: part.blurb,
      steps: part.steps.map<StepOut>((s) => ({
        id: s.id, title: s.title, weight: s.weight, text: s.text, notes: s.notes, position: s.position, part: s.part,
        hunks: s.found.map((f) => hunkRef(f.hunk.id, f.hunk.header, f.hunk.added, f.hunk.deleted, f.file.path, f.file.status, f.file.scope)),
        missing: s.missing, outdated: s.outdated, read: isRead(s, read),
      })),
    }))
    const uncovered = view.uncovered.map((u) => {
      const out: UncoveredOut = {
        path: u.file.path, status: u.file.status, generated: u.file.generated, binary: u.file.binary, note: u.note,
        hunks: u.hunks.map((h) => hunkRef(h.id, h.header, h.added, h.deleted, u.file.path, u.file.status, u.file.scope)),
      }
      if (u.file.unread) out.unread = u.file.unread
      return out
    })
    const asksView = overlayAsks(entry.walkthrough.asks, view)
    const asks = asksView ? {
      list: asksView.asks.map<AskOut>((a) => ({ id: a.id, text: a.text, coverage: a.coverage, steps: a.steps.map((s) => s.position), tail: a.tail, missing: a.missing, outdated: a.outdated })),
      met: asksView.met, total: asksView.total, outside: asksView.outside.map((s) => s.position),
    } : null
    const meta: EntryMeta = { key: entry.key, agent: entry.agent ?? 'claude', model: entry.model, language: entry.language, generatedAt: entry.generatedAt, took: entry.took, cost: entry.cost }
    return {
      diff: diffAnswer(diff), key,
      shown: { meta, title: entry.walkthrough.title, summary: entry.walkthrough.summary, exact },
      parts, uncovered, outdated: view.outdated,
      task: entry.task ? { ...entry.task, changed: taskKey(entry.task) !== taskKey(taskNow) } : null,
      taskNow, asks,
      job: jobOut,
    }
  })

  handle('walkthrough.hunks', async ({ top, source, ids }) => {
    const repo = await repoOf(top)
    const diff = await store.readDiff(repo, source)
    const index = indexHunks(diff.files)
    const hunks: Record<string, HunkLines> = {}
    for (const id of ids.slice(0, 64)) {
      const h = index.get(id)
      if (h) hunks[id] = { header: h.header, context: h.context, oldStart: h.oldStart, newStart: h.newStart, lines: h.lines }
    }
    return { hunks }
  })

  handle('walkthrough.task', async ({ top, source }) => ({ task: await taskFor(top, source) }))

  handle('walkthrough.generate', async ({ top, source, agent, model, language, taskMode, taskText }): Promise<GenerateAnswer> => {
    const repo = await repoOf(top)
    const { agent: defAgent, model: defModel, language: defLanguage, preferences } = await settings(orca)
    const chosenAgent = agentOf(agent ?? defAgent)
    const chosenModel = chooseModel(chosenAgent, model ?? defModel)
    const chosenLanguage = language ?? defLanguage
    const diff = await store.readDiff(repo, source)
    const mode: TaskMode = TASK_MODES.some((m) => m.key === taskMode) ? (taskMode as TaskMode) : 'auto'
    const task = mode === 'off'
      ? null
      : mode === 'own'
        ? await resolveTask({ mode: 'own', own: taskText ?? '' })
        : await taskFor(top, source)
    const prompt = store.preparePrompt(diff, {
      language: chosenLanguage,
      previous: (await store.previousEntry(repo, diff))?.walkthrough ?? null,
      preferences, task,
    })
    const key = store.keyFor(repo, diff, chosenAgent.key, chosenModel, chosenLanguage, preferences, task)
    if (!store.fits(prompt)) return { cached: false, key, tooBig: true, promptChars: store.promptChars(prompt) }
    if (await store.hasEntry(key)) return { cached: true, key }
    const previous = await store.previousEntry(repo, diff)
    const before = previous ? previous.walkthrough.parts.flatMap((p) => p.steps.flatMap((s) => s.hunkIds)) : []
    await store.startJob(repo, diff, { key, agent: chosenAgent.key, model: chosenModel, language: chosenLanguage, prompt, source, task, before })
    orca.panels.post('walkthrough.job', { top, sk: diff.sk, done: false })
    return { cached: false, key, promptChars: store.promptChars(prompt) }
  })

  handle('walkthrough.poll', async ({ top, source }): Promise<PollAnswer> => {
    const repo = await repoOf(top)
    const job = await store.jobOf(repo, sourceKey(source))
    if (!job) return { running: false, entry: null, error: null }
    if (!job.done) return { running: await store.alive(job), entry: null, error: null }
    try {
      const entry = await store.finishJob(job)
      orca.panels.post('walkthrough.job', { top, sk: sourceKey(source), done: true })
      return { running: false, entry, error: null }
    } catch (e) {
      orca.panels.post('walkthrough.job', { top, sk: sourceKey(source), done: true })
      return { running: false, entry: null, error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('walkthrough.cancel', async ({ top, source }) => {
    const repo = await repoOf(top)
    const job = await store.jobOf(repo, sourceKey(source))
    if (job) await store.cancelJob(job)
    return { cancelled: true }
  })

  handle('walkthrough.read.load', async ({ top }) => ({ read: await store.loadRead(top) }))

  handle('walkthrough.read.mark', async ({ top, ids, on }) => ({ read: await store.saveRead(top, ids, on) }))

  handle('walkthrough.markdown', async ({ top, source }) => {
    const repo = await repoOf(top)
    const { agent, model, language } = await settings(orca)
    const diff = await store.readDiff(repo, source)
    const taskNow = await taskFor(repo.top, source)
    const key = store.keyFor(repo, diff, agent, model, language, '', taskNow)
    const shown = await store.findShown(repo, diff, key)
    if (!shown) throw invalid('No walkthrough to copy for this change. Generate one first.')
    const view = overlay(shown.entry.walkthrough, diff.files)
    const asks = overlayAsks(shown.entry.walkthrough.asks, view)
    return { text: toMarkdown(view, shown.entry.walkthrough, { what: diff.what, agent: shown.entry.agent ?? 'claude', model: shown.entry.model, language: shown.entry.language, cost: shown.entry.cost }, asks, shown.entry.task?.label ?? '') }
  })

  handle('walkthrough.clipboard', async ({ text }) => {
    await store.copyText(text)
    return { copied: true }
  })

  // ── turns: what each agent changes while answering one prompt ────────────
  //
  // The host says when an agent starts and stops working; at each boundary the
  // working tree is snapshotted into this data folder (engine/turns.ts). The
  // status bar item is what keeps this worker running from Orca's boot —
  // without it, a turn could be missed before the first panel opens — and it
  // says so: visible while a turn is being recorded, gone otherwise.

  const states: TurnStates = {}
  const open = new Map<string, { id: string; repo: Repo }>()
  const busy = new Map<string, Promise<unknown>>()
  // One snapshot at a time per agent: rapid status flips must not interleave
  // git runs over one turn's private index.
  const places = new Map<string, { path: string; repo: Repo | null; checked: boolean }>()

  const status = (recording: boolean, tooltip: string): void => {
    void orca.host.call('statusBar.update', {
      id: 'turn', visible: recording, text: recording ? '● turn' : '', tone: 'accent', tooltip,
    }).catch(() => undefined)
  }

  /** The git repository an agent's workspace points at, remembered per workspace. */
  async function repoOfPlace(workspaceId: string | null): Promise<Repo | null> {
    if (!workspaceId) return null
    let place = places.get(workspaceId)
    if (!place) {
      const { workspaces } = await orca.host.call('workspace.list').catch(() => ({ workspaces: [] }))
      const w = workspaces.find((x) => x.id === workspaceId)
      if (!w) return null
      place = { path: w.path, repo: null, checked: false }
      places.set(workspaceId, place)
    }
    if (!place.checked) {
      place.repo = await store.repository(place.path)
      place.checked = true
    }
    return place.repo
  }

  async function onStatus(event: PluginEvents['agent.status.changed']): Promise<void> {
    const said: TurnEvent = {
      workspaceId: event.workspaceId, paneKey: event.paneKey, terminalId: event.terminalId, title: event.title,
      state: event.state, at: event.mainAgent?.stateStartedAt || event.receivedAt, outcome: event.mainAgent?.outcome ?? null,
    }
    const action = stepTurn(states, said)
    states[turnKey(said)] = event.state
    if (action.kind === 'none') return
    const repo = await repoOfPlace(event.workspaceId)
    if (!repo) return
    const previous = busy.get(action.key) ?? Promise.resolve()
    const mine = previous.then(async () => {
      if (action.kind === 'open') {
        const id = turnId(action.startedAt, action.key)
        // A turn a worker restart left open ends where its next prompt begins —
        // never snapshotted then, so the person's edits after the interruption
        // are not claimed as the agent's.
        const orphan = (await store.recentTurns(repo.top)).find((m) => !m.endedAt && m.workspaceId === event.workspaceId && m.terminalId === (event.terminalId ?? null))
        if (orphan) await store.closeTurn(repo, orphan.id, action.startedAt, null, false)
        await store.openTurn(repo, { id, startedAt: action.startedAt, terminalId: event.terminalId ?? null, workspaceId: event.workspaceId, agent: action.agent })
        open.set(action.key, { id, repo })
        status(true, `${repo.name}${action.agent ? ` · ${action.agent}` : ''}`)
      } else if (action.kind === 'close') {
        const running = open.get(action.key)
        if (!running) return
        open.delete(action.key)
        await store.closeTurn(running.repo, running.id, action.endedAt, action.outcome)
        if (open.size === 0) status(false, '')
      }
    }).catch(() => undefined)
    busy.set(action.key, mine)
  }

  orca.events.on('agent.status.changed', (event) => { void onStatus(event) })

  // Agents already at work when this worker starts are seeded, so the turn
  // under way is never opened half-way; their next prompt starts a whole one.
  void (async () => {
    try {
      const context = await orca.host.call('workspace.readContext')
      if (!context) return
      const { workspaces } = await orca.host.call('workspace.list')
      const match = matchFocused(context, workspaces)
        ?? workspaces.find((w) => (w.branch ?? '').replace(/^refs\/heads\//, '') === context.branch)
      if (!match) return
      const { agents } = await orca.host.call('agents.list')
      for (const a of agents) {
        if (!a.terminalId) continue
        states[`${match.id}\u0000${a.terminalId}`] = a.state
      }
    } catch { /* nothing focused yet; the events will teach the states */ }
  })()
}