// The Walkthrough panel: pick what to read, generate (or find) a walkthrough,
// and read the change step by step, with the code beside the words.

import type {
  AskOut, DiffAnswer, EntryMeta, HunkLines, HunkRef, ScopesAnswer, Source, StateAnswer,
  StepOut, ViewAnswer,
} from '../src/protocol'
import { MODELS } from '../src/engine/job'
import { LANGUAGES } from '../src/engine/languages'

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
const repoLabel = byId<HTMLButtonElement>('repo')
const statusLine = byId<HTMLDivElement>('status')
const controls = byId<HTMLDivElement>('controls')
const hints = byId<HTMLElement>('hints')

/** A tiny element builder: el('div', {class: 'x', onclick: fn}, ...children). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue
    if (name === 'class') node.className = String(value)
    else if (name === 'text') node.textContent = String(value)
    else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value as EventListener)
    else node.setAttribute(name, String(value))
  }
  for (const child of children) node.append(child instanceof Node ? child : String(child))
  return node
}

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
let model = store.get('wt.model', '')
let language = store.get('wt.language', '')
let view: ViewAnswer | null = null
let stepPos = 1
let page: 'walk' | 'task' = 'walk'
let unreadOnly = false
let taskMode = store.get<TaskMode>('wt.taskMode', 'auto')
let taskText = store.get('wt.taskText', '')
let stepsOpen = false
const hunksCache = new Map<string, HunkLines>()
const uncoveredOpen = new Set<string>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let askAnchor: string | null = null
let lastChoices: { path: string; name: string; branch: string | null }[] = []

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} day${Math.floor(s / 86400) === 1 ? '' : 's'} ago`
}

const steps = (): StepOut[] => view?.parts.flatMap((p) => p.steps) ?? []
const currentStep = (): StepOut | null => steps().find((s) => s.position === stepPos) ?? null

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
    if (!state.workspace && state.choices.length) { pickWorkspace(state.choices); return }
    fail(state.error ?? (state.workspace ? 'The focused workspace is not a git repository.' : 'No workspace is focused in Orca.'))
    return
  }
  top = state.workspace.path
  repoName = state.repo.name
  lastChoices = state.choices
  repoLabel.hidden = false
  repoLabel.textContent = `${state.workspace.name}${state.workspace.branch ? ` · ${state.workspace.branch}` : ''}`
  repoLabel.onclick = () => pickWorkspace(lastChoices)
  controls.hidden = false
  hints.hidden = false
  hints.replaceChildren(template(
    '<kbd>j</kbd>/<kbd>k</kbd> steps · <kbd>x</kbd> read · <kbd>u</kbd> unread · <kbd>t</kbd> task · <kbd>Esc</kbd> back'
  ))
  await loadScopes()
}

function message(e: unknown): string {
  if (e instanceof Error) return e.message
  const any = e as { message?: string }
  return any?.message ?? String(e)
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

async function fillSettings(): Promise<void> {
  const settings = await orca.settings.get().catch(() => ({}) as Record<string, unknown>)
  if (!model) model = typeof settings.model === 'string' ? settings.model : 'haiku'
  if (!language) language = typeof settings.language === 'string' ? settings.language : 'en'
  modelSelect.replaceChildren(...MODELS.map((m) => el('option', { text: m.name, value: m.key, title: m.about })))
  modelSelect.value = model
  modelSelect.onchange = () => { model = modelSelect.value; store.put('wt.model', model); void loadView() }
  languageSelect.replaceChildren(...LANGUAGES.map((l) => el('option', { text: l.name, value: l.tag })))
  languageSelect.value = language
  languageSelect.onchange = () => { language = languageSelect.value; store.put('wt.language', language); void loadView() }
}

// ── the view ──────────────────────────────────────────────────────────────

async function loadView(): Promise<void> {
  if (!top || !source) return
  const before = view
  try { view = await request('walkthrough.view', { top, source, model, language }, { timeoutMs: 60000 }) }
  catch (e) { fail(`Could not read the change: ${message(e)}`); return }
  hunksCache.clear()
  const stepList = steps()
  if (!stepList.some((s) => s.position === stepPos)) {
    const first = unreadOnly ? stepList.find((s) => !s.read) : stepList[0]
    stepPos = first?.position ?? 1
  }
  if (!before?.shown && view.job?.running) startPolling()
  render()
}

function render(): void {
  if (!view) return
  if (page === 'task') { renderTaskPage(); return }
  if (!view.shown) {
    if (view.job?.running) { renderGenerating(); return }
    renderSetup()
    return
  }
  renderWalk()
}

function metaChips(meta: EntryMeta, exact: boolean): HTMLElement {
  const modelName = MODELS.find((m) => m.key === meta.model)?.name ?? meta.model
  const chips = [el('span', { class: 'chip', title: 'Generated' }, `${modelName} · ${ago(meta.generatedAt)}`)]
  if (typeof meta.cost === 'number') chips.push(el('span', { class: 'chip plain', title: 'What this walkthrough cost' }, `$${meta.cost.toFixed(meta.cost < 0.1 ? 3 : 2)}`))
  if (!exact) chips.push(el('span', { class: 'chip warn', title: 'The code has changed since this walkthrough was written; steps that no longer match are marked.' }, 'Outdated'))
  return el('div', { class: 'chips' }, ...chips)
}

// ── setup (nothing to show yet) ───────────────────────────────────────────

function renderSetup(): void {
  const diff = view!.diff
  const task = view!.taskNow
  stopPolling()
  actionButton.textContent = 'Generate'
  actionButton.disabled = diff.hunkCount === 0 || diff.tooBig
  copyButton.hidden = true

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
  actionButton.textContent = 'Cancel'
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
  actionButton.textContent = 'Cancel'
  copyButton.hidden = true
  const started = startedAt ?? view.job?.startedAt ?? Date.now()
  const deadline = view.job?.deadline ?? started + 300000
  const bar = el('div', { class: 'bar' }, el('div', { style: `width:${Math.min(96, ((Date.now() - started) / (deadline - started)) * 100)}%` }))
  main.replaceChildren(el('div', { class: 'generating' },
    el('h2', { text: 'Reading the change…' }),
    el('p', { class: 'counts', text: `${view.diff.fileCount} files · ${view.diff.hunkCount} hunks · model ${view.job?.model ?? model}` }),
    bar,
    el('p', { class: 'counts', text: `started ${ago(started)} · runs in the background, even with this panel closed` })))
  status(view.diff.what)
}

async function generate(): Promise<void> {
  if (!top || !source) return
  actionButton.disabled = true
  try {
    const answer = await request('walkthrough.generate', { top, source, model, language, taskMode, taskText }, { timeoutMs: 60000 })
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

function renderWalk(): void {
  const v = view!
  const shown = v.shown!
  if (v.job?.running) { actionButton.textContent = 'Cancel'; actionButton.disabled = false } else {
    actionButton.textContent = 'Regenerate'
    actionButton.disabled = v.diff.hunkCount === 0 || v.diff.tooBig
  }
  copyButton.hidden = false

  const walk = el('div', { class: 'walk' })
  walk.append(
    el('div', { class: 'head' },
      el('h2', { text: shown.title }),
      shown.summary ? el('p', { class: 'summary', text: shown.summary }) : null,
      metaChips(shown.meta, shown.exact)))

  if (v.task) {
    const chip = el('button', { class: 'ask-chip', title: 'Show how the task maps to the change', onclick: () => { page = 'task'; render() } },
      `${v.asks?.total ?? 0} requests mapped${v.task.changed ? ' · task changed' : ''}`)
    walk.append(el('div', { class: 'chips' }, chip))
  }

  // Part tabs, when the walkthrough has more than one.
  const stepList = steps()
  const step = currentStep()
  if (v.parts.length > 1) {
    const parts = el('div', { class: 'parts' })
    v.parts.forEach((p, i) => {
      const b = el('button', { text: p.title, 'aria-current': String(step ? step.part === i : i === 0) })
      b.onclick = () => {
        const first = p.steps[0]
        if (first) go(first.position)
      }
      parts.append(b)
    })
    walk.append(parts)
  }

  if (step) {
    walk.append(navRow(stepList, step), stepCard(step))
    if (stepsOpen) walk.append(stepsList(stepList))
  }
  if (v.uncovered.length) walk.append(uncoveredBlock())
  main.replaceChildren(walk)

  const stale = v.outdated ? ` · ${v.outdated} step${v.outdated === 1 ? '' : 's'} outdated` : ''
  const regen = v.job?.running ? ' · regenerating…' : ''
  status(`${v.diff.what}${stale}${regen}`)
}

function navRow(stepList: StepOut[], step: StepOut): HTMLElement {
  const prev = el('button', { text: '‹', title: 'Previous step (k)' })
  const next = el('button', { text: '›', title: 'Next step (j)' })
  prev.disabled = !beforePos(step)
  next.disabled = !afterPos(step)
  prev.onclick = () => go(beforePos(step) ?? step.position)
  next.onclick = () => go(afterPos(step) ?? step.position)
  const toggle = el('button', { class: 'ghost', text: stepsOpen ? 'Hide steps' : 'All steps' })
  toggle.onclick = () => { stepsOpen = !stepsOpen; render() }
  return el('div', { class: 'nav' }, prev,
    el('span', { class: 'position', text: `${stepList.indexOf(step) + 1} / ${stepList.length}` }),
    next, el('span', { class: 'steps-toggle' }, toggle))
}

/** The next position each way, honouring the unread-only filter. */
function beforePos(step: StepOut): number | null {
  const list = ordered().filter((s) => s.position < step.position)
  return list.length ? list[list.length - 1]!.position : null
}
function afterPos(step: StepOut): number | null {
  return ordered().find((s) => s.position > step.position)?.position ?? null
}
function ordered(): StepOut[] {
  const all = steps()
  return unreadOnly ? all.filter((s) => !s.read) : all
}

function go(position: number): void {
  stepPos = position
  page = 'walk'
  render()
  main.querySelector('.step')?.scrollIntoView({ block: 'start' })
}

function stepsList(stepList: StepOut[]): HTMLElement {
  const box = el('div', { class: 'steps-list' })
  for (const s of stepList) {
    if (unreadOnly && s.read) continue
    const dot = s.weight === 'key' ? '●' : s.weight === 'skim' ? '○' : '·'
    const b = el('button', { 'aria-current': String(s.position === stepPos), onclick: () => go(s.position) },
      el('span', { class: 'n', text: String(s.position) }),
      el('span', { class: `dot ${s.weight}`, text: dot }),
      el('span', { text: s.title }),
      s.outdated ? el('span', { class: 'stale', text: 'changed' }) : null,
      s.read ? el('span', { class: 'done', text: '✓' }) : null)
    box.append(b)
  }
  const toggle = el('button', { class: 'ghost', text: unreadOnly ? 'Show all steps' : 'Show unread only' })
  toggle.onclick = () => {
    unreadOnly = !unreadOnly
    store.put('wt.unreadOnly', unreadOnly)
    const first = ordered()[0]
    if (first) stepPos = first.position
    render()
  }
  return el('div', {}, box, toggle)
}

function stepCard(step: StepOut): HTMLElement {
  const card = el('div', { class: 'step' })
  const weight = step.weight === 'key' ? el('span', { class: 'chip', text: 'Key change' }) : step.weight === 'skim' ? el('span', { class: 'chip', text: 'Context' }) : null
  const markBtn = el('button', { class: `mark${step.read ? ' on' : ''}`, title: 'Mark read (x)' }, step.read ? '✓ Read' : 'Mark read')
  markBtn.onclick = () => void toggleRead(step)
  card.append(el('div', { class: 'title-row' }, el('h3', { text: step.title }), weight, markBtn))

  // The requests this step carries out.
  const asks = view?.asks?.list.filter((a) => a.steps.includes(step.position)) ?? []
  if (asks.length) {
    const chips = el('div', { class: 'asks-chips' })
    for (const a of asks) chips.append(el('button', { class: `ask-chip ${a.coverage}`, title: 'Show the task', onclick: () => { page = 'task'; askAnchor = a.id; render() } }, `${mark(a)} ${short(a.text, 42)}`))
    card.append(chips)
  }

  for (const n of step.notes) card.append(el('div', { class: `note ${n.kind}` }, el('b', { text: n.kind }), el('span', { text: n.text })))
  card.append(el('p', { class: 'text', text: step.text }))
  if (step.outdated) card.append(el('div', { class: 'note gap' }, el('b', { text: 'outdated' }), el('span', { text: `${step.missing} of the ${step.hunks.length + step.missing} hunk${step.hunks.length + step.missing === 1 ? '' : 's'} this step described changed or are gone.` })))

  const code = el('div', { class: 'step-code' })
  card.append(code)
  void renderHunkBlocks(code, step.hunks)
  return card
}

const mark = (a: AskOut): string => (a.coverage === 'seen' ? '✓' : a.coverage === 'partly' ? '◐' : '○')
const short = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

async function toggleRead(step: StepOut): Promise<void> {
  if (!top) return
  const ids = step.hunks.map((h) => h.id)
  try {
    const { read } = await request('walkthrough.read.mark', { top, ids, on: !step.read }, { timeoutMs: 15000 })
    for (const s of steps()) s.read = s.hunks.length > 0 && s.hunks.every((h) => Object.hasOwn(read, h.id.slice(h.id.indexOf(':') + 1))) && !s.outdated
    if (unreadOnly && step.read && afterPos(step)) { stepPos = afterPos(step)! }
    render()
  } catch (e) {
    status(`Could not save the read mark: ${message(e)}`)
  }
}

// ── code ──────────────────────────────────────────────────────────────────

async function fetchHunks(refs: HunkRef[]): Promise<void> {
  const missing = [...new Set(refs.map((r) => r.id))].filter((id) => !hunksCache.has(id))
  if (!missing.length || !top || !source) return
  try {
    const { hunks } = await request('walkthrough.hunks', { top, source, ids: missing }, { timeoutMs: 30000 })
    for (const [id, h] of Object.entries(hunks)) hunksCache.set(id, h)
  } catch { /* the block stays collapsed */ }
}

/** Hunk refs → code blocks, with their lines fetched on demand. */
async function renderHunkBlocks(container: HTMLElement, refs: HunkRef[], grouped = true): Promise<void> {
  const placeholder = el('div', { class: 'center', text: '…' })
  container.replaceChildren(placeholder)
  await fetchHunks(refs)
  const blocks: HTMLElement[] = []
  let lastPath = ''
  let previous: HunkLines | null | undefined
  for (const ref of refs) {
    const hunk = hunksCache.get(ref.id)
    const head = el('div', { class: 'code-head' },
      lastPath === ref.path ? null : el('span', { class: 'path', text: ref.path }),
      el('span', { text: ref.status !== 'modified' ? ref.status : '' }),
      el('span', { text: at(hunk) }),
      hunk?.context ? el('span', { class: 'dim', text: short(hunk.context, 60) }) : null,
      el('span', { class: 'count' }, el('span', { class: 'a', text: `+${ref.added}` }), ' ', el('span', { class: 'd', text: `−${ref.deleted}` })))
    if (grouped && lastPath === ref.path && previous && hunk && hunk.newStart - (previous.newStart + countOf(previous)) > 1) {
      blocks.push(el('div', { class: 'gap-line', text: '⋯ lines skipped' }))
    }
    lastPath = ref.path
    previous = hunk
    blocks.push(el('div', { class: 'code' }, head, hunk ? linesPre(hunk) : el('pre', {}, el('div', { class: 'ln' }, el('span', { class: 'no' }), el('span', { class: 'tx', text: '(hunk not available)' })))))
  }
  container.replaceChildren(...(blocks.length ? blocks : [el('div', { class: 'center', text: 'Nothing to show.' })]))
}

const at = (hunk: HunkLines | undefined): string => (hunk ? `Line ${hunk.newStart}` : '')
/** How many lines the hunk leaves in the new file: its context and added lines. */
const countOf = (hunk: HunkLines): number => hunk.lines.filter((l) => l[0] !== '-').length

/** A hunk's lines, drawn: old numbers on removed lines, new on the rest. */
function linesPre(hunk: HunkLines): HTMLElement {
  const pre = el('pre')
  let old = hunk.oldStart, next = hunk.newStart
  for (const line of hunk.lines) {
    const kind = line[0]
    if (kind === '+') { pre.append(lineRow('plus', next++, line.slice(1))); continue }
    if (kind === '-') { pre.append(lineRow('minus', old++, line.slice(1))); continue }
    if (kind === '\\') { pre.append(lineRow('meta', undefined, line)); continue }
    old++
    pre.append(lineRow(undefined, next++, line.slice(1) || ' '))
  }
  return pre
}

function lineRow(kind: string | undefined, number: number | undefined, text: string): HTMLElement {
  return el('div', { class: `ln${kind ? ` ${kind}` : ''}` },
    el('span', { class: 'no', text: number === undefined ? '' : String(number) }),
    el('span', { class: 'tx', text }))
}

// ── not covered ───────────────────────────────────────────────────────────

function uncoveredBlock(): HTMLElement {
  const v = view!
  const box = el('div', { class: 'uncovered' })
  box.append(el('h3', { text: `Not covered — edits in ${v.uncovered.length} file${v.uncovered.length === 1 ? '' : 's'} no step explains` }))
  for (const u of v.uncovered) {
    const file = el('div', { class: 'uc-file' })
    const head = el('button', {},
      el('span', { class: 'path', text: u.path }),
      el('span', { class: 'note', text: u.note || u.unread || (u.binary ? 'Binary file.' : u.generated ? 'Generated file, not sent to the model.' : '') }),
      el('span', { class: 'count dim', text: u.hunks.length ? `${u.hunks.length} hunk${u.hunks.length === 1 ? '' : 's'}` : 'no hunks' }))
    const body = el('div', { class: 'body', hidden: true })
    head.onclick = () => {
      const open = body.hidden
      body.hidden = !open
      if (open) {
        uncoveredOpen.add(u.path)
        if (!body.childNodes.length) void renderHunkBlocks(body, u.hunks, false)
      } else uncoveredOpen.delete(u.path)
    }
    file.append(head, body)
    if (uncoveredOpen.has(u.path)) head.click()
    box.append(file)
  }
  return box
}

// ── the task page ─────────────────────────────────────────────────────────

function renderTaskPage(): void {
  const v = view!
  const task = v.task
  const box = el('div', { class: 'task-page' })
  box.append(el('h3', { text: 'The task, against the change' }))
  if (task) box.append(el('div', { class: 'task-found' }, el('b', { text: `${task.label}. ` }), task.text))
  else box.append(el('p', { class: 'counts', text: 'This walkthrough was written without a task.' }))
  const asks = v.asks
  if (!asks) {
    box.append(el('p', { class: 'counts', text: 'Regenerate with a task to see which requests the change carries out.' }))
  } else if (!asks.list.length) {
    box.append(el('p', { class: 'counts', text: 'The task names nothing concrete to match against the change.' }))
  } else {
    for (const a of asks.list) {
      const where = [
        a.coverage === 'absent' ? 'not in this diff' : '',
        a.steps.length ? `step${a.steps.length === 1 ? '' : 's'} ${a.steps.join(', ')}` : '',
        a.tail ? 'partly under Not covered' : '',
        a.outdated ? 'changed since' : '',
      ].filter(Boolean).join(' · ')
    const stepsRow = el('div', { class: 'where' })
    if (a.steps.length) {
      for (const p of a.steps) stepsRow.append(el('button', { text: `step ${p}`, onclick: () => go(p) }), ' ')
    }
    if (where) stepsRow.append(where)
    const row = el('div', { class: 'ask-row', id: a.id },
      el('div', { class: 'top' }, el('span', { class: `mark ${a.coverage}`, text: mark(a) }), el('span', { text: a.text })))
    if (stepsRow.childNodes.length) row.append(stepsRow)
    box.append(row)
    }
    if (asks.outside.length) box.append(el('p', { class: 'counts', text: `Not tied to any request: step${asks.outside.length === 1 ? '' : 's'} ${asks.outside.join(', ')}.` }))
  }
  const back = el('button', { class: 'ghost', text: '← Back to the walkthrough (Esc)' })
  back.onclick = () => { page = 'walk'; askAnchor = null; render() }
  box.append(back)
  main.replaceChildren(box)
  status(v.diff.what)
  if (askAnchor) {
    document.getElementById(askAnchor)?.scrollIntoView({ block: 'center' })
    askAnchor = null
  }
}

// ── wiring ────────────────────────────────────────────────────────────────

actionButton.onclick = () => {
  if (pollTimer) void cancel()
  else void generate()
}
copyButton.onclick = () => void copyMarkdown()

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const step = currentStep()
  switch (event.key) {
    case 'j': case 'ArrowRight': case 'ArrowDown':
      if (step && afterPos(step)) { go(afterPos(step)!); event.preventDefault() }
      break
    case 'k': case 'ArrowLeft': case 'ArrowUp':
      if (step && beforePos(step)) { go(beforePos(step)!); event.preventDefault() }
      break
    case 'x':
      if (step && page === 'walk') void toggleRead(step)
      break
    case 'u': {
      unreadOnly = !unreadOnly
      store.put('wt.unreadOnly', unreadOnly)
      const first = ordered()[0]
      if (first) stepPos = first.position
      render()
      break
    }
    case 't':
      if (view?.shown) { page = page === 'task' ? 'walk' : 'task'; render() }
      break
    case 'Escape':
      if (page === 'task') { page = 'walk'; render() }
      else if (stepsOpen) { stepsOpen = false; render() }
      break
  }
})

// While an agent works, the change moves under the walkthrough: refresh gently.
let refreshTimer: ReturnType<typeof setTimeout> | null = null
orca.on('agent.status.changed', () => {
  if (!top || !source || pollTimer) return
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
  unreadOnly = store.get('wt.unreadOnly', false)
  await fillSettings()
  await boot()
})()
