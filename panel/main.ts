// The Walkthrough panel: pick what to read, generate (or find) a walkthrough,
// and read the change step by step, with the code beside the words.

import type {
  ScopesAnswer, Source, StateAnswer, ViewAnswer,
} from '../src/protocol'
import { agentOf } from '../src/engine/agents'
import { LANGUAGES } from '../src/engine/languages'
import { el, icon } from './render'
import { hideReader, mountReader, showReader } from '../editor/reader'

type TaskMode = 'auto' | 'own' | 'off'

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id)
  if (!element) throw new Error(`#${id} is missing from index.html`)
  return element as T
}
const main = byId<HTMLDivElement>('main')
const scopeSelect = byId<HTMLSelectElement>('scope')
const modelSelect = byId<HTMLSelectElement>('model')
const languageSelect = byId<HTMLSelectElement>('language')
const actionButton = byId<HTMLButtonElement>('action')
const copyButton = byId<HTMLButtonElement>('copy')
const openButton = byId<HTMLButtonElement>('open')
const repoLabel = byId<HTMLButtonElement>('repo')
const statusLine = byId<HTMLDivElement>('status')
const controls = byId<HTMLDivElement>('controls')
const settingsButton = byId<HTMLButtonElement>('settings')
const settingsRow = byId<HTMLDivElement>('settings-row')
const agentSelect = byId<HTMLSelectElement>('agent')
const hints = byId<HTMLElement>('hints')

const request = orca.plugin.request.bind(orca.plugin)
const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? fallback : (JSON.parse(raw) as T)
    } catch { return fallback }
  },
  put(key: string, value: unknown): void {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* full or blocked */ }
  },
}

// ── state ─────────────────────────────────────────────────────────────────

let top: string | null = null
let repoName: string | null = null
let scopes: ScopesAnswer | null = null
let source: Source | null = null
let agent = store.get('wt.agent', '')
let agentsList: StateAnswer['agents'] = []
let model = store.get('wt.model', '')
let language = store.get('wt.language', '')
let view: ViewAnswer | null = null
let taskMode = store.get<TaskMode>('wt.taskMode', 'auto')
let taskText = store.get('wt.taskText', '')
let pollTimer: ReturnType<typeof setInterval> | null = null
let lastChoices: { path: string; name: string; branch: string | null }[] = []

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} day${Math.floor(s / 86400) === 1 ? '' : 's'} ago`
}


function status(text: string): void {
  statusLine.textContent = text
}

/** HTML string → nodes (for the few places markup is easier than builders). */
function template(html: string): DocumentFragment {
  const t = document.createElement('template')
  t.innerHTML = html
  return t.content
}

function fail(message: string): void {
  hideReader()
  main.classList.remove('reading')
  main.replaceChildren(el('div', { class: 'center' },
    el('h2', { text: 'Walkthrough' }),
    el('p', { text: message })))
  status('')
}

// ── boot ──────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  const pick = store.get<string>('wt.pick', '')
  let state: StateAnswer
  try { state = await request('walkthrough.state', { pick: pick || '' }, { timeoutMs: 15000 }) }
  catch (e) { fail(`Could not reach the walkthrough worker: ${message(e)}`); return }
  lastContext = state.workspace ? `${state.workspace.name}\n${state.workspace.branch ?? ''}` : ''
  if (state.workspace) { if (pick) store.put('wt.pick', '') }
  if (!state.workspace || !state.repo) {
    controls.hidden = true
    hints.hidden = true
    repoLabel.hidden = true
    lastChoices = state.choices
    if (state.serverSetup) { serverSetup(state.error ?? '', state.serverSetup); return }
    if (!state.workspace && state.choices.length) { pickWorkspace(state.choices); return }
    fail(state.error ?? (state.workspace ? 'The focused workspace is not a git repository.' : 'No workspace is focused in Orca.'))
    return
  }
  top = state.workspace.path
  repoName = state.repo.name
  lastChoices = state.choices
  agentsList = state.agents
  repoLabel.hidden = false
  repoLabel.textContent = `${state.workspace.name}${state.workspace.branch ? ` · ${state.workspace.branch}` : ''}`
  repoLabel.onclick = () => pickWorkspace(lastChoices)
  controls.hidden = false
  hints.hidden = false
  hints.replaceChildren(template(
    '<kbd>j</kbd>/<kbd>k</kbd> steps · <kbd>x</kbd> read · <kbd>Esc</kbd> overview'
  ))
  await loadScopes()
}

function message(e: unknown): string {
  if (e instanceof Error) return e.message
  const any = e as { message?: string }
  return any?.message ?? String(e)
}

/** The one icon button that starts, stops and restarts: what it is now. */
function setAction(kind: 'generate' | 'cancel' | 'regenerate'): void {
  actionButton.replaceChildren(icon(kind === 'generate' ? 'play' : kind === 'cancel' ? 'stop' : 'refresh', 13))
  const name = kind === 'generate' ? 'Generate' : kind === 'cancel' ? 'Cancel' : 'Regenerate'
  actionButton.title = name
  actionButton.setAttribute('aria-label', name)
}

/** The workspace is on a paired server without this plugin loaded there: the command that loads it, to run on the server. */
function serverSetup(why: string, command: string): void {
  const code = el('pre', { class: 'cmd', text: command })
  const copy = el('button', { text: 'Copy command', onclick: async () => {
    try { await navigator.clipboard.writeText(command); status('Command copied: run it in a terminal on the server, approve, then retry.') }
    catch { getSelection()?.selectAllChildren(code); status('Select the command above and copy it.') }
  } })
  main.replaceChildren(el('div', { class: 'setup' },
    el('div', { class: 'center' }, el('h2', { text: 'Set up Walkthrough on the server' }),
      el('p', { text: `${why} Run this in a terminal on the server; Orca there asks you to approve it. Then retry.` })),
    code,
    el('div', {}, copy, ' ', el('button', { text: 'Retry', onclick: () => { void boot() } }))))
  status('')
}

/** The focused workspace could not be matched: offer Orca's workspaces, and remember the choice. */
function pickWorkspace(choices: { path: string; name: string; branch: string | null }[]): void {
  const box = el('div', { class: 'setup' })
  box.append(el('div', { class: 'center' }, el('h2', { text: 'Which workspace is the change in?' }),
    el('p', { text: 'The focused workspace could not be matched to exactly one workspace in Orca. Pick one to read it; the choice is used until a workspace matches on its own.' })))
  const list = el('div', { class: 'steps-list' })
  for (const choice of choices) {
    list.append(el('button', { onclick: () => { store.put('wt.pick', choice.path); void boot() } },
      el('span', { class: 'path', text: choice.name }),
      el('span', { class: 'dim', text: `${choice.branch ? `${choice.branch} · ` : ''}${choice.path}` })))
  }
  box.append(list)
  main.replaceChildren(box)
  status('')
}

async function loadScopes(): Promise<void> {
  if (!top) return
  try { scopes = await request('walkthrough.scopes', { top }, { timeoutMs: 30000 }) }
  catch (e) { fail(`Could not read the repository: ${message(e)}`); return }

  scopeSelect.replaceChildren()
  const option = (label: string, value: Source, group: HTMLOptGroupElement | HTMLSelectElement, disabled = false): void => {
    const o = el('option', { text: label, value: JSON.stringify(value) })
    o.disabled = disabled
    group.append(o)
  }
  const working = el('optgroup', { label: 'Working tree' })
  option('Uncommitted', { kind: 'uncommitted' }, working)
  option('Staged', { kind: 'staged' }, working)
  option('Unstaged', { kind: 'unstaged' }, working)
  scopeSelect.append(working)
  if (scopes.defaultBase) {
    const branch = el('optgroup', { label: 'Branch' })
    option(`This branch, since ${scopes.defaultBase}`, { kind: 'branch', base: scopes.defaultBase, head: scopes.current }, branch)
    scopeSelect.append(branch)
  }
  if (scopes.commits.length) {
    const commits = el('optgroup', { label: 'Commits' })
    for (const c of scopes.commits.slice(0, 20)) option(`${c.short} ${c.subject}`.slice(0, 80), { kind: 'commit', hash: c.hash, subject: c.subject }, commits)
    scopeSelect.append(commits)
  }
  if (scopes.pulls.length) {
    const pulls = el('optgroup', { label: 'Pull requests' })
    for (const p of scopes.pulls.slice(0, 10)) option(`#${p.number} ${p.title}`.slice(0, 80), { kind: 'pr', number: p.number, title: p.title, head: p.head, base: p.base }, pulls)
    scopeSelect.append(pulls)
  }
  if (scopes.turns?.length) {
    const turns = el('optgroup', { label: 'Turns' })
    for (const [i, t] of scopes.turns.slice(0, 20).entries()) {
      const when = new Date(t.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const what = t.prompt || t.agent || 'agent turn'
      const mark = t.complete ? '' : ' · unfinished'
      option(`${i === 0 ? 'Last turn · ' : ''}${when} ${what}${mark}`.slice(0, 90),
        { kind: 'turn', id: t.id, before: t.before ?? undefined, after: t.after ?? undefined, label: what }, turns)
    }
    scopeSelect.append(turns)
  }

  // Restore the last source read here, when it still exists in the list.
  const saved = store.get<Source | null>(`wt.source.${top}`, null)
  const savedJson = saved ? JSON.stringify(saved) : ''
  const match = saved && Array.from(scopeSelect.options).some((o) => o.value === savedJson)
  source = match ? saved : { kind: 'uncommitted' }
  scopeSelect.value = JSON.stringify(source)
  scopeSelect.onchange = () => {
    try { source = JSON.parse(scopeSelect.value) as Source } catch { return }
    if (top) store.put(`wt.source.${top}`, source)
    void loadView()
  }
  void loadView()
}

// ── settings-driven selects ───────────────────────────────────────────────

/** The agent's own model list — Orca's catalog when the worker read it —
 *  remembering a choice per agent, and taking the account's default. */
function fillModels(): void {
  const known = agentsList.find((a) => a.key === agent)?.models
  const models = known?.length
    ? known.map((m) => ({ key: m.key, name: m.label, about: m.isDefault ? "This account's default" : undefined }))
    : agentOf(agent).models
  const fallback = known?.find((m) => m.isDefault)?.key ?? agentOf(agent).defaultModel
  const saved = store.get(`wt.model.${agent}`, '')
  model = models.some((m) => m.key === saved) ? saved : fallback
  modelSelect.replaceChildren(...models.map((m) => el('option', { text: m.name, value: m.key, title: m.about })))
  modelSelect.value = model
}

async function fillSettings(): Promise<void> {
  const settings = await orca.settings.get().catch(() => ({}) as Record<string, unknown>)
  if (!agent) agent = typeof settings.agent === 'string' ? settings.agent : 'claude'
  if (!language) language = typeof settings.language === 'string' ? settings.language : 'en'
  // The agents Orca has enabled, as the worker read them; each CLI that is
  // missing shows up, disabled, rather than vanishing. Before the worker has
  // answered, claude alone and unmarked — it is this plugin's default.
  const list = agentsList.length
    ? agentsList
    : [{ key: 'claude', name: 'Claude', available: true, models: [] }]
  agentSelect.replaceChildren(...list.map((a) => {
    const option = el('option', { text: a.available ? a.name : `${a.name} (not found)`, value: a.key })
    option.disabled = !a.available
    return option
  }))
  if (list.some((a) => a.key === agent && a.available)) agentSelect.value = agent
  else {
    const first = list.find((a) => a.available)
    if (first) { agent = first.key; agentSelect.value = agent }
  }
  agentSelect.onchange = () => {
    agent = agentSelect.value
    store.put('wt.agent', agent)
    fillModels()
    void loadView()
  }
  fillModels()
  modelSelect.onchange = () => { model = modelSelect.value; store.put(`wt.model.${agent}`, model); void loadView() }
  languageSelect.replaceChildren(...LANGUAGES.map((l) => el('option', { text: l.name, value: l.tag })))
  languageSelect.value = language
  languageSelect.onchange = () => { language = languageSelect.value; store.put('wt.language', language); void loadView() }
}

// ── the view ──────────────────────────────────────────────────────────────

async function loadView(): Promise<void> {
  if (!top || !source) return
  const before = view
  try { view = await request('walkthrough.view', { top, source, agent, model, language }, { timeoutMs: 60000 }) }
  catch (e) { fail(`Could not read the change: ${message(e)}`); return }
  if (!before?.shown && view.job?.running) startPolling()
  render()
}

function render(): void {
  if (!view) return
  if (!view.shown) {
    hideReader()
    main.classList.remove('reading')
    if (view.job?.running) { renderGenerating(); return }
    renderSetup()
    return
  }
  renderWalk()
}

// ── setup (nothing to show yet) ───────────────────────────────────────────

function renderSetup(): void {
  const diff = view!.diff
  const task = view!.taskNow
  stopPolling()
  setAction('generate')
  actionButton.disabled = diff.hunkCount === 0 || diff.tooBig
  copyButton.hidden = true
  openButton.hidden = true

  const counts = el('p', { class: 'counts' },
    el('b', { text: String(diff.fileCount) }), ' file', diff.fileCount === 1 ? '' : 's',
    ' · ', el('b', { text: String(diff.hunkCount) }), ' hunk', diff.hunkCount === 1 ? '' : 's',
    ` · ≈${diff.tokens.toLocaleString()} tokens`)

  const box = el('div', { class: 'setup' })
  if (diff.hunkCount === 0) {
    box.append(el('div', { class: 'center' }, el('h2', { text: 'Nothing to read' }), el('p', { text: 'This scope has no changes. Work in the editor, or pick another scope above.' })))
    main.replaceChildren(box)
    status(diff.what)
    return
  }
  if (diff.tooBig) {
    box.append(el('div', { class: 'center' }, el('h2', { text: 'Too large to read' }), el('p', { text: `This change is about ${diff.tokens.toLocaleString()} tokens. It is not sent to the model clipped, because a walkthrough of half a diff reads as confidently as one of the whole. Split the change, or read it as a commit.` })))
    main.replaceChildren(box)
    status(diff.what)
    return
  }

  // The task: found automatically, written by hand, or none.
  const modes = el('div', { class: 'modes' })
  const own = el('textarea', { class: 'task-text', placeholder: 'What should the change do? Written in your words, matched against the diff.', hidden: taskMode !== 'own' }) as HTMLTextAreaElement
  own.value = taskText
  own.oninput = () => { taskText = own.value; store.put('wt.taskText', taskText) }
  const modeButtons: Record<string, HTMLButtonElement> = {}
  for (const m of [['auto', 'Found'], ['own', 'Your own'], ['off', 'Off']] as const) {
    const b = el('button', { text: m[1], 'aria-pressed': String(taskMode === m[0]) }) as HTMLButtonElement
    b.onclick = () => {
      taskMode = m[0]
      store.put('wt.taskMode', taskMode)
      for (const [key, button] of Object.entries(modeButtons)) button.setAttribute('aria-pressed', String(key === taskMode))
      renderSetup()
    }
    modeButtons[m[0]] = b
    modes.append(b)
  }
  const taskBox = el('div', { class: 'task-box' }, el('span', { class: 'counts', text: 'The task this change is matched against' }), modes, own)
  if (taskMode === 'auto') {
    taskBox.append(task
      ? el('div', { class: 'task-found' }, el('b', { text: `${task.label}. ` }), task.text)
      : el('div', { class: 'task-found', text: 'No task found: no prompts sent to agents in Claude Code sessions here since the change began, no description to read. The walkthrough only orders and explains.' }))
  }
  if (taskMode === 'own' && taskText.trim()) {
    taskBox.append(el('div', { class: 'task-found', text: taskText.trim().slice(0, 200) }))
  }

  // The files, for a glance before paying for anything.
  const files = el('details', { class: 'files' }, el('summary', { text: `${diff.fileCount} files` }))
  const list = el('div', { class: 'file-list' })
  for (const f of diff.files.slice(0, 12)) {
    list.append(el('div', {}, el('span', { class: 'path', text: f.path }),
      el('span', { class: 'dim', text: ` ${f.status}${f.unread ? ` — ${f.unread}` : f.generated ? ' — generated, not read' : f.binary ? ' — binary' : ''}` })))
  }
  if (diff.files.length > 12) list.append(el('div', { class: 'dim', text: `… and ${diff.files.length - 12} more` }))
  files.append(list)

  box.append(el('h2', { text: 'Read this change in the order it makes sense' }), counts, taskBox, files)
  main.replaceChildren(box)
  status(diff.what)
}

// ── generating ────────────────────────────────────────────────────────────

function startPolling(): void {
  if (pollTimer) return
  setAction('cancel')
  actionButton.disabled = false
  pollTimer = setInterval(() => void poll(), 2000)
  void poll()
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

async function poll(): Promise<void> {
  if (!top || !source) return
  let answer
  try { answer = await request('walkthrough.poll', { top, source }, { timeoutMs: 20000 }) }
  catch { return }
  if (answer.running) {
    renderGenerating(answer.entry?.generatedAt)
    return
  }
  stopPolling()
  await loadView()
  if (answer.error) status(`Generation failed: ${answer.error}`)
}

function renderGenerating(startedAt?: number): void {
  if (!view || view.shown) return // a regeneration keeps the walkthrough on screen
  setAction('cancel')
  copyButton.hidden = true
  openButton.hidden = true
  const started = startedAt ?? view.job?.startedAt ?? Date.now()
  const deadline = view.job?.deadline ?? started + 300000
  const bar = el('div', { class: 'bar' }, el('div', { style: `width:${Math.min(96, ((Date.now() - started) / (deadline - started)) * 100)}%` }))
  main.replaceChildren(el('div', { class: 'generating' },
    el('h2', { text: 'Reading the change…' }),
    el('p', { class: 'counts', text: `${view.diff.fileCount} files · ${view.diff.hunkCount} hunks · ${agentOf(view.job?.agent ?? agent).name} · ${view.job?.model ?? model}` }),
    bar,
    el('p', { class: 'counts', text: `started ${ago(started)} · runs in the background, even with this panel closed` })))
  status(view.diff.what)
}

async function generate(): Promise<void> {
  if (!top || !source) return
  actionButton.disabled = true
  try {
    const answer = await request('walkthrough.generate', { top, source, agent, model, language, taskMode, taskText }, { timeoutMs: 60000 })
    if (answer.tooBig) { await loadView(); return }
    if (answer.cached) { status('Already written for exactly this change — showing it.'); await loadView(); return }
    startPolling()
    renderGenerating(Date.now())
  } catch (e) {
    status(`Could not start: ${message(e)}`)
    actionButton.disabled = false
  }
}

async function cancel(): Promise<void> {
  if (!top || !source) return
  stopPolling()
  try { await request('walkthrough.cancel', { top, source }, { timeoutMs: 15000 }) } catch { /* already gone */ }
  await loadView()
}

/** The walkthrough, wide: an editor tab with an overview and one step at a time. */
async function openTab(): Promise<void> {
  if (!top || !source) return
  openButton.disabled = true
  try { await request('walkthrough.open', { top, source, agent, model, language }, { timeoutMs: 60000 }) }
  catch (e) { status(`Could not open the tab: ${message(e)}`) }
  openButton.disabled = false
}

async function copyMarkdown(): Promise<void> {
  if (!top || !source) return
  copyButton.disabled = true
  try {
    const { text } = await request('walkthrough.markdown', { top, source }, { timeoutMs: 60000 })
    await request('walkthrough.clipboard', { text }, { timeoutMs: 15000 })
    status('Walkthrough copied as Markdown.')
  } catch (e) {
    status(`Could not copy: ${message(e)}`)
  }
  copyButton.disabled = false
}

// ── the walkthrough ───────────────────────────────────────────────────────

// The reader, the same as in a tab: built once, redrawn for each walkthrough.
let readerHost: HTMLElement | null = null
function readerIn(): HTMLElement {
  if (readerHost) return readerHost
  const rail = el('nav', { class: 'rail', 'aria-label': 'Steps' })
  const bar = el('div', { class: 'bar' })
  const page = el('div', { class: 'page' })
  const announcer = el('p', { class: 'sr-only', role: 'status' })
  readerHost = el('div', { class: 'app reader-host' }, rail, el('div', { class: 'body' }, bar, page), announcer)
  mountReader({ rail, bar, page, announcer })
  return readerHost
}

function renderWalk(): void {
  const v = view!
  if (v.job?.running) { setAction('cancel'); actionButton.disabled = false } else {
    setAction('regenerate')
    actionButton.disabled = v.diff.hunkCount === 0 || v.diff.tooBig
  }
  copyButton.hidden = false
  openButton.hidden = false
  const host = readerIn()
  if (main.firstChild !== host || main.childNodes.length !== 1) main.replaceChildren(host)
  main.classList.add('reading')
  showReader({ top: top!, source: source!, agent, model, language }, v)
  const regen = v.job?.running ? ' · regenerating…' : ''
  status(`${v.diff.what}${regen}`)
}

// ── wiring ────────────────────────────────────────────────────────────────

actionButton.onclick = () => {
  if (pollTimer) void cancel()
  else void generate()
}
copyButton.onclick = () => void copyMarkdown()
openButton.onclick = () => void openTab()

// Model and language live behind the sliders; the scope stays in the open.
copyButton.replaceChildren(icon('copy'))
openButton.replaceChildren(icon('open'))
settingsButton.replaceChildren(icon('settings'))
settingsButton.addEventListener('click', () => {
  settingsRow.hidden = !settingsRow.hidden
  settingsButton.setAttribute('aria-pressed', String(!settingsRow.hidden))
})

// While an agent works, the change moves under the walkthrough: refresh gently.
// A turn being read never changes (its snapshots are fixed), but when one ends
// it becomes a new option in the picker, so the scope list is what refreshes.
let refreshTimer: ReturnType<typeof setTimeout> | null = null
orca.on('agent.status.changed', (event) => {
  if (!top || !source || pollTimer) return
  if (source.kind === 'turn') {
    if (event.state !== 'done' && event.state !== 'waiting') return
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => { refreshTimer = null; void loadScopes() }, 2000)
    return
  }
  if (!['uncommitted', 'staged', 'unstaged', 'branch'].includes(source.kind)) return
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => { refreshTimer = null; void loadView() }, 2000)
})

// Only a change of the focused workspace is worth starting over.
let lastContext = ''
orca.on('workspace.changed', ({ context }) => {
  const now = context ? `${context.displayName}\n${context.branch}` : ''
  if (now === lastContext) return
  lastContext = now
  stopPolling()
  void boot()
})

void (async () => {
  await fillSettings() // a quiet first draw, before the worker has answered
  await boot()
  await fillSettings() // now with the agents Orca has enabled
})()
