// The walkthrough tab: the file it opens names a change (repository, scope,
// agent, model, language); this draws that change's walkthrough wide — an
// overview, then one step at a time with its code, a rail of every step, and
// your place kept. It reads through the same worker requests as the panel and
// never edits the file. Generating stays in the panel.

import type { AskOut, EntryMeta, HunkLines, HunkRef, Source, StepOut, ViewAnswer } from '../src/protocol'
import { agentOf, modelOf } from '../src/engine/agents'
import { buildHunkBlocks, el, filesOf, short } from '../panel/render'

type WalkFile = { top: string; source: Source; agent: string; model: string; language: string; server?: string }
type Page = { kind: 'overview' } | { kind: 'step'; position: number } | { kind: 'uncovered' } | { kind: 'task' }

const rail = document.getElementById('rail') as HTMLElement
const bar = document.getElementById('bar') as HTMLElement
const pageEl = document.getElementById('page') as HTMLElement
const announcer = document.getElementById('announce') as HTMLElement

let file: WalkFile | null = null
let view: ViewAnswer | null = null
let page: Page = { kind: 'overview' }
const hunksCache = new Map<string, HunkLines>()

/** A worker request; a tab on a paired server's workspace names that server, as the panel that opened it may be gone. */
function request<T>(name: string, input: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
  const body = file?.server ? { ...input, via: file.server } : input
  return orca.plugin.request(name as never, body as never, { timeoutMs }) as Promise<T>
}

const store = {
  get<T>(key: string, fallback: T): T {
    try { const raw = localStorage.getItem(key); return raw === null ? fallback : (JSON.parse(raw) as T) } catch { return fallback }
  },
  put(key: string, value: unknown): void {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* full or blocked */ }
  },
}
const placeKey = (): string => `wt.tab.place.${file?.top}.${view?.key}`

function announce(text: string): void {
  announcer.textContent = ''
  requestAnimationFrame(() => { announcer.textContent = text })
}

const message = (e: unknown): string => (e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e))
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}
const byline = (meta: EntryMeta): string => {
  const who = meta.agent && meta.agent !== 'claude' ? `${agentOf(meta.agent).name} · ` : ''
  return `${who}${modelOf(meta.agent ?? 'claude', meta.model).name}`
}

const steps = (): StepOut[] => view?.parts.flatMap((p) => p.steps) ?? []
const stepAt = (position: number): StepOut | undefined => steps().find((s) => s.position === position)
const partOf = (step: StepOut): ViewAnswer['parts'][number] | undefined => view?.parts[step.part]
/** The first step not yet read, where Resume goes when no place was kept. */
const firstUnread = (): StepOut | undefined => steps().find((s) => !s.read)
const resumeAt = (): number | null => {
  const kept = store.get<number | null>(placeKey(), null)
  if (kept !== null && stepAt(kept)) return kept
  return firstUnread()?.position ?? null
}
const linesOf = (s: StepOut): number => s.hunks.reduce((n, h) => n + h.added + h.deleted, 0)

// ── loading ───────────────────────────────────────────────────────────────

async function load(): Promise<void> {
  let text = ''
  try {
    const doc = await orca.document!.get()
    text = doc.content.kind === 'text' ? doc.content.text : new TextDecoder().decode(doc.content.bytes)
    file = JSON.parse(text) as WalkFile
    if (!file?.top || !file.source) throw new Error('not a walkthrough file')
  } catch (e) {
    fail('This file does not name a walkthrough', `Open walkthroughs from the Walkthrough panel. (${message(e)})`)
    return
  }
  await refresh()
}

async function refresh(): Promise<void> {
  if (!file) return
  try {
    view = await request<ViewAnswer>('walkthrough.view', { top: file.top, source: file.source, agent: file.agent, model: file.model, language: file.language }, 60000)
  } catch (e) {
    fail('Could not read the change', message(e))
    return
  }
  hunksCache.clear()
  if (!view.shown) {
    fail(view.job?.running ? 'The walkthrough is being written' : 'No walkthrough for this change yet',
      view.job?.running ? 'It runs in the background; this tab fills in when you reload it.' : 'Generate it from the Walkthrough panel, then reload this tab.', true)
    return
  }
  if (page.kind === 'step' && !stepAt(page.position)) page = { kind: 'overview' }
  draw()
}

function fail(title: string, text: string, reload = false): void {
  rail.hidden = true
  bar.replaceChildren()
  pageEl.replaceChildren(el('div', { class: 'empty' },
    el('h1', { text: title }),
    el('p', { text }),
    reload ? el('button', { class: 'btn', text: 'Reload', onclick: () => { void refresh() } }) : null))
}

// ── drawing ───────────────────────────────────────────────────────────────

function go(next: Page): void {
  page = next
  if (next.kind === 'step') store.put(placeKey(), next.position)
  draw()
  pageEl.scrollTop = 0
  if (next.kind === 'step') {
    const s = stepAt(next.position)
    if (s) announce(`Step ${s.position} of ${steps().length}: ${s.title}`)
  }
}

function draw(): void {
  if (!view?.shown) return
  rail.hidden = false
  drawRail()
  drawBar()
  if (page.kind === 'overview') drawOverview()
  else if (page.kind === 'step') drawStep(stepAt(page.position)!)
  else if (page.kind === 'uncovered') drawUncovered()
  else drawTask()
}

function drawRail(): void {
  const v = view!
  const item = (label: string, target: Page, opts: { mark?: string; markClass?: string; current?: boolean; title?: string } = {}) =>
    el('button', {
      class: `rail-item${opts.current ? ' current' : ''}`, title: opts.title ?? label,
      'aria-current': opts.current ? 'step' : null, onclick: () => go(target),
    }, el('span', { class: `mark ${opts.markClass ?? ''}`, text: opts.mark ?? '' }), el('span', { class: 'label', text: label }))

  const items: HTMLElement[] = [item('Overview', { kind: 'overview' }, { mark: '◇', current: page.kind === 'overview' })]
  for (const part of v.parts) {
    if (!part.steps.length) continue
    if (v.parts.length > 1) items.push(el('div', { class: 'rail-part', text: part.title }))
    for (const s of part.steps) {
      const current = page.kind === 'step' && page.position === s.position
      items.push(item(s.title, { kind: 'step', position: s.position }, {
        current,
        mark: s.read ? '✓' : current ? '●' : String(s.position),
        markClass: s.read ? 'read' : s.outdated ? 'stale' : '',
        title: `${s.position}. ${s.title}${s.outdated ? ' (outdated)' : ''}`,
      }))
    }
  }
  if (v.uncovered.length) items.push(item(`Not covered · ${plural(v.uncovered.length, 'file')}`, { kind: 'uncovered' }, { mark: '—', current: page.kind === 'uncovered' }))
  if (v.task) items.push(item('The task', { kind: 'task' }, { mark: '◎', current: page.kind === 'task' }))
  rail.replaceChildren(...items)
  rail.querySelector('.current')?.scrollIntoView({ block: 'nearest' })
}

function drawBar(): void {
  const all = steps()
  const read = all.filter((s) => s.read).length
  const progress = el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(all.length), 'aria-valuenow': String(read), title: `${read} of ${all.length} steps read` },
    el('div', { style: `width:${all.length ? (read / all.length) * 100 : 0}%` }))
  let where: HTMLElement
  let prev: Page | null = null
  let next: Page | null = null
  if (page.kind === 'step') {
    const s = stepAt(page.position)!
    const i = all.indexOf(s)
    where = el('span', { class: 'where' }, el('b', { text: `Step ${s.position} of ${all.length}` }), ` · ${s.title}`)
    prev = i > 0 ? { kind: 'step', position: all[i - 1]!.position } : { kind: 'overview' }
    next = i < all.length - 1 ? { kind: 'step', position: all[i + 1]!.position } : view!.uncovered.length ? { kind: 'uncovered' } : null
  } else {
    where = el('span', { class: 'where' }, el('b', { text: page.kind === 'overview' ? 'Overview' : page.kind === 'uncovered' ? 'Not covered' : 'The task' }))
    const first = all[0]
    if (page.kind === 'overview' && first) next = { kind: 'step', position: resumeAt() ?? first.position }
    if (page.kind !== 'overview') prev = { kind: 'overview' }
  }
  bar.replaceChildren(
    where,
    progress,
    el('span', { class: 'dim count', text: `${read} of ${all.length} read` }),
    el('button', { class: 'btn ghost', text: '‹ Prev', disabled: prev ? null : 'true', title: 'Previous (k)', onclick: () => prev && go(prev) }),
    el('button', { class: 'btn ghost', text: 'Next ›', disabled: next ? null : 'true', title: 'Next (j)', onclick: () => next && go(next) }))
}

// ── overview ──────────────────────────────────────────────────────────────

function drawOverview(): void {
  const v = view!
  const shown = v.shown!
  const all = steps()
  const resume = resumeAt()
  const started = all.some((s) => s.read)

  const head = el('div', { class: 'ov-head' },
    el('div', { class: 'ov-title' },
      el('h1', { text: shown.title }),
      el('p', { class: 'dim', text: v.diff.what })),
    el('div', { class: 'ov-actions' },
      el('div', { class: 'row' },
        resume !== null
          ? el('button', { class: 'btn primary', text: started ? `Resume at step ${resume} →` : 'Start →', onclick: () => go({ kind: 'step', position: resume }) })
          : el('span', { class: 'done', text: '✓ Every step read' }),
        el('button', { class: 'btn ghost', text: 'Reload', title: 'Read the change again', onclick: () => { void refresh() } })),
      el('p', { class: 'dim meta' },
        `${byline(shown.meta)} · ${ago(shown.meta.generatedAt)}`,
        typeof shown.meta.cost === 'number' ? ` · $${shown.meta.cost.toFixed(shown.meta.cost < 0.1 ? 3 : 2)}` : '',
        !shown.exact ? el('span', { class: 'chip warn', text: 'Outdated', title: 'The code changed since this was written; steps that no longer match are marked.' }) : null)))

  // What it is, and what it was for: labels in a column, like a form read aloud.
  const facts = el('div', { class: 'facts' })
  const fact = (label: string, ...body: (Node | string | null)[]) => facts.append(el('div', { class: 'fact' }, el('span', { class: 'label', text: label }), el('div', { class: 'value' }, ...body)))
  if (shown.summary) fact('Summary', shown.summary)
  if (v.task) {
    fact('Task', el('b', { text: `${v.task.label}. ` }), short(v.task.text, 320),
      v.asks ? el('button', { class: 'link', text: ` ${v.asks.met} of ${v.asks.total} requests carried out →`, onclick: () => go({ kind: 'task' }) }) : null)
  }
  if (v.outdated) fact('Changed since', `${plural(v.outdated, 'step')} no longer match the code: they are marked in the list.`)

  // Where the lines went, by part.
  const total = all.reduce((n, s) => n + linesOf(s), 0) || 1
  const added = v.diff.files.reduce((n, f) => n + f.added, 0)
  const deleted = v.diff.files.reduce((n, f) => n + f.deleted, 0)
  const parts = v.parts.filter((p) => p.steps.length)
  const shares = el('div', { class: 'shares' })
  const rows = el('div', { class: 'part-rows' })
  parts.forEach((p, i) => {
    const lines = p.steps.reduce((n, s) => n + linesOf(s), 0)
    const color = `var(--part-${i % 6})`
    shares.append(el('div', { style: `flex:${lines || 0.5};background:${color}`, title: p.title }))
    const a = p.steps.reduce((n, s) => n + s.hunks.reduce((m, h) => m + h.added, 0), 0)
    const d = p.steps.reduce((n, s) => n + s.hunks.reduce((m, h) => m + h.deleted, 0), 0)
    rows.append(el('button', { class: 'part-row', onclick: () => p.steps[0] && go({ kind: 'step', position: p.steps[0].position }) },
      el('span', { class: 'swatch', style: `background:${color}` }),
      el('span', { class: 'name', text: p.title }),
      el('span', { class: 'dim', text: plural(p.steps.length, 'step') }),
      el('span', { class: 'dim', text: `${Math.round((lines / total) * 100)}%` }),
      el('span', { class: 'a', text: a ? `+${a}` : '' }),
      el('span', { class: 'd', text: d ? `−${d}` : '' })))
  })
  const changes = el('section', { class: 'changes' },
    el('h2', {}, 'Changes ', el('span', { class: 'dim', text: plural(v.diff.fileCount, 'file') })),
    el('div', { class: 'totals' }, el('span', { class: 'a', text: `+${added}` }), el('span', { class: 'd', text: `−${deleted}` })),
    shares, rows)

  // Every step as a card, in reading order.
  const grid = el('div', { class: 'grid' })
  for (const s of all) {
    const here = s.position === resume && started
    grid.append(el('button', { class: `card${s.read ? ' read' : ''}${here ? ' here' : ''}${s.outdated ? ' stale' : ''}`, onclick: () => go({ kind: 'step', position: s.position }) },
      el('span', { class: 'top' },
        el('span', { class: 'n', text: String(s.position) }),
        here ? el('span', { class: 'here-tag', text: 'Resume here' }) : s.read ? el('span', { class: 'tick', text: '✓' }) : null),
      el('span', { class: 'title', text: s.title }),
      el('span', { class: 'foot' },
        s.hunks.length ? el('span', { class: 'dim', text: plural(filesOf(s.hunks).length, 'file') }) : null,
        s.weight === 'key' ? el('span', { class: 'badge key', text: 'Key' }) : s.weight === 'skim' ? el('span', { class: 'badge', text: 'Context' }) : null,
        s.outdated ? el('span', { class: 'badge warn', text: 'Outdated' }) : null)))
  }
  const tour = el('section', { class: 'tour' },
    el('h2', {}, 'Steps ', el('span', { class: 'dim', text: `${all.length} · ${all.filter((s) => s.read).length} read` })),
    grid,
    v.uncovered.length ? el('button', { class: 'link', text: `${plural(v.uncovered.length, 'file')} with edits no step explains →`, onclick: () => go({ kind: 'uncovered' }) }) : null)

  pageEl.replaceChildren(el('div', { class: 'overview' }, head, el('div', { class: 'ov-cols' }, facts, changes), tour))
}

// ── one step ──────────────────────────────────────────────────────────────

function drawStep(s: StepOut): void {
  const all = steps()
  const part = partOf(s)
  const i = all.indexOf(s)
  const next = all[i + 1]

  const head = el('div', { class: 'step-head' },
    el('p', { class: 'eyebrow' }, part && view!.parts.length > 1 ? `${part.title} · ` : '', `Step ${s.position} of ${all.length}`,
      s.weight === 'key' ? el('span', { class: 'badge key', text: 'Key change' }) : s.weight === 'skim' ? el('span', { class: 'badge', text: 'Context' }) : null),
    el('h1', { text: s.title }))

  const notes = s.notes.map((n) => el('div', { class: `callout ${n.kind}` }, el('b', { text: `${n.kind}: ` }), n.text))
  if (s.outdated) notes.push(el('div', { class: 'callout gap' }, el('b', { text: 'outdated: ' }), `${s.missing} of the ${plural(s.hunks.length + s.missing, 'hunk')} this step described changed or are gone.`))

  const asks = view!.asks?.list.filter((a) => a.steps.includes(s.position)) ?? []
  const askRow = asks.length
    ? el('div', { class: 'asks-chips' }, ...asks.map((a) => el('button', { class: `ask-chip ${a.coverage}`, title: 'Show the task', onclick: () => go({ kind: 'task' }) }, `${mark(a)} ${short(a.text, 60)}`)))
    : null

  const code = el('div', { class: 'step-code' })
  if (s.hunks.length) void renderHunks(code, s.hunks)

  const markBtn = el('button', { class: `btn${s.read ? '' : ' ghost'}`, text: s.read ? '✓ Read' : 'Mark read', title: 'Mark read (x)', onclick: () => { void toggleRead(s) } })
  const onward = next
    ? el('button', { class: 'btn primary', text: s.read ? `Next: ${short(next.title, 40)} →` : 'Mark read & next →', onclick: () => { void (s.read ? Promise.resolve(go({ kind: 'step', position: next.position })) : toggleRead(s, next.position)) } })
    : el('button', { class: 'btn primary', text: s.read ? 'Back to overview' : 'Mark read & finish', onclick: () => { void (s.read ? Promise.resolve(go({ kind: 'overview' })) : toggleRead(s, null)) } })

  pageEl.replaceChildren(el('article', { class: 'step-page' },
    head,
    el('div', { class: 'prose' }, ...notes, el('p', { class: 'text', text: s.text }), askRow),
    code,
    askBox(s),
    el('div', { class: 'step-foot' }, markBtn, onward)))
}

// ── asking an agent about a step ──────────────────────────────────────────

type Agents = { running: { terminalId: string; title: string | null; agent: string | null; state: string }[]; launchable: { key: string; name: string }[] }
let agentsSeen: Agents | null = null
const lastTarget = (): string => store.get('wt.tab.askTarget', '')

/** The step, as an agent needs it: what the walkthrough said and where the code is. */
function stepContext(s: StepOut): string {
  const where = filesOf(s.hunks).map((f) => {
    const ranges = s.hunks.filter((h) => h.path === f.path).map((h) => hunksCache.get(h.id)).filter(Boolean)
      .map((h) => { const n = h!.lines.filter((l) => l[0] !== '-').length; return n > 1 ? `${h!.newStart}-${h!.newStart + n - 1}` : String(h!.newStart) })
    return ranges.length ? `${f.path}:${ranges.join(',')}` : f.path
  })
  return [
    `About step ${s.position} of the walkthrough "${view!.shown!.title}" (${view!.diff.what})`,
    `Step: ${s.title}`,
    `What it says: ${s.text}`,
    where.length ? `Code: ${where.join('; ')}` : '',
  ].filter(Boolean).join('\n')
}

function askBox(s: StepOut): HTMLElement {
  const question = el('textarea', { class: 'ask-text', rows: '2', placeholder: 'Ask about this step, or tell an agent what to do with it…', 'aria-label': 'Question for the agent' }) as HTMLTextAreaElement
  const target = el('select', { class: 'ask-target', 'aria-label': 'Agent' }) as HTMLSelectElement
  const send = el('button', { class: 'btn primary', text: 'Send' }) as HTMLButtonElement
  const session = el('button', { class: 'btn', text: 'New session', title: 'A new worktree off this branch, with the agent started on this step' }) as HTMLButtonElement
  const note = el('span', { class: 'dim ask-note', text: 'Sent with the step, its explanation and where its code is.' })

  const fill = (a: Agents): void => {
    const options: HTMLOptionElement[] = []
    for (const r of a.running) options.push(el('option', { value: `t:${r.terminalId}`, text: `${r.title || r.agent || 'Agent'} · ${r.state}` }))
    for (const l of a.launchable) options.push(el('option', { value: `n:${l.key}`, text: `New ${l.name} terminal` }))
    target.replaceChildren(...options)
    if (options.some((o) => o.value === lastTarget())) target.value = lastTarget()
  }
  if (agentsSeen) fill(agentsSeen)
  void request<Agents>('walkthrough.agents', { top: file!.top, agent: file!.agent }).then((a) => { agentsSeen = a; fill(a) }).catch(() => {
    if (!agentsSeen) fill({ running: [], launchable: [{ key: file!.agent || 'claude', name: agentOf(file!.agent || 'claude').name }] })
  })
  target.onchange = () => store.put('wt.tab.askTarget', target.value)

  const submit = async (): Promise<void> => {
    const q = question.value.trim()
    if (!q || !target.value) { question.focus(); return }
    send.disabled = true
    const [kind, id] = [target.value.slice(0, 1), target.value.slice(2)]
    try {
      await request('walkthrough.ask', { top: file!.top, text: `${stepContext(s)}\n\n${q}`, ...(kind === 't' ? { terminalId: id } : { agent: id }) }, 60000)
      question.value = ''
      note.textContent = kind === 't' ? 'Sent to the agent’s terminal.' : 'Started a new agent with it.'
      agentsSeen = null
    } catch (e) {
      note.textContent = `Could not send: ${message(e)}`
    }
    send.disabled = false
  }
  send.onclick = () => void submit()

  // A session of its own: a child worktree on this branch, its agent given the step.
  session.onclick = async () => {
    const q = question.value.trim()
    if (!q) { question.focus(); note.textContent = 'Say what the new session should do with this step.'; return }
    const kind = target.value.slice(0, 1)
    const running = agentsSeen?.running.find((r) => `t:${r.terminalId}` === target.value)
    const agent = kind === 'n' ? target.value.slice(2) : running?.agent ?? file!.agent
    const name = `step-${s.position}-${s.title}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
    session.disabled = true
    note.textContent = 'Creating the worktree…'
    try {
      const made = await request<{ name: string }>('walkthrough.session', { top: file!.top, text: `${stepContext(s)}\n\n${q}`, agent, name }, 120000)
      question.value = ''
      note.textContent = `Started “${made.name}” with the step.`
    } catch (e) {
      note.textContent = `Could not create the session: ${message(e)}`
    }
    session.disabled = false
  }
  question.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit() } }

  return el('section', { class: 'ask' },
    el('h2', { text: 'Ask an agent about this step' }),
    question,
    el('div', { class: 'ask-row-controls' }, target, send, session, note))
}

const mark = (a: AskOut): string => (a.coverage === 'seen' ? '✓' : a.coverage === 'partly' ? '◐' : '○')

/** Marks a step read or unread; `then` moves on afterwards (a position, null for the overview). */
async function toggleRead(s: StepOut, then?: number | null): Promise<void> {
  if (!file) return
  try {
    const { read } = await request<{ read: Record<string, unknown> }>('walkthrough.read.mark', { top: file.top, ids: s.hunks.map((h) => h.id), on: !s.read }, 15000)
    for (const st of steps()) st.read = st.hunks.length > 0 && st.hunks.every((h) => Object.hasOwn(read, h.id.slice(h.id.indexOf(':') + 1))) && !st.outdated
    if (then === undefined) draw()
    else go(then === null ? { kind: 'overview' } : { kind: 'step', position: then })
  } catch (e) {
    announce(`Could not save the read mark: ${message(e)}`)
  }
}

async function renderHunks(container: HTMLElement, refs: HunkRef[], perFile = true): Promise<void> {
  container.replaceChildren(el('div', { class: 'dim loading', text: 'Loading the code…' }))
  const missing = [...new Set(refs.map((r) => r.id))].filter((id) => !hunksCache.has(id))
  if (missing.length && file) {
    try {
      const { hunks } = await request<{ hunks: Record<string, HunkLines> }>('walkthrough.hunks', { top: file.top, source: file.source, ids: missing })
      for (const [id, h] of Object.entries(hunks)) hunksCache.set(id, h)
    } catch { /* drawn as unavailable */ }
  }
  const blocks = buildHunkBlocks(refs, (id) => hunksCache.get(id), perFile)
  container.replaceChildren(...(blocks.length ? blocks : [el('div', { class: 'dim', text: 'Nothing to show.' })]))
}

// ── not covered, and the task ─────────────────────────────────────────────

function drawUncovered(): void {
  const v = view!
  const list = el('div', { class: 'uncovered' })
  for (const u of v.uncovered) {
    const body = el('div', { class: 'body', hidden: true })
    const head = el('button', {},
      el('span', { class: 'path', text: u.path }),
      el('span', { class: 'note', text: u.note || u.unread || (u.binary ? 'Binary file.' : u.generated ? 'Generated file, not sent to the model.' : '') }),
      el('span', { class: 'count dim', text: u.hunks.length ? plural(u.hunks.length, 'hunk') : 'no hunks' }))
    head.onclick = () => {
      body.hidden = !body.hidden
      if (!body.hidden && !body.childNodes.length) void renderHunks(body, u.hunks, false)
    }
    list.append(el('div', { class: 'uc-file' }, head, body))
  }
  pageEl.replaceChildren(el('article', { class: 'step-page' },
    el('div', { class: 'step-head' }, el('p', { class: 'eyebrow', text: 'After the steps' }), el('h1', { text: 'Not covered' })),
    el('p', { class: 'text dim', text: `Edits in ${plural(v.uncovered.length, 'file')} that no step explains. Read them yourself: nothing here was ordered or explained.` }),
    list))
}

function drawTask(): void {
  const v = view!
  const box = el('article', { class: 'step-page' },
    el('div', { class: 'step-head' }, el('p', { class: 'eyebrow', text: 'What the change was for' }), el('h1', { text: 'The task, against the change' })))
  if (v.task) box.append(el('div', { class: 'callout' }, el('b', { text: `${v.task.label}. ` }), v.task.text))
  const asks = v.asks
  if (!asks) box.append(el('p', { class: 'dim', text: 'Regenerate with a task to see which requests the change carries out.' }))
  else if (!asks.list.length) box.append(el('p', { class: 'dim', text: 'The task names nothing concrete to match against the change.' }))
  else {
    for (const a of asks.list) {
      const where = el('div', { class: 'where' })
      for (const p of a.steps) where.append(el('button', { text: `step ${p}`, onclick: () => go({ kind: 'step', position: p }) }), ' ')
      const extra = [a.coverage === 'absent' ? 'not in this diff' : '', a.tail ? 'partly under Not covered' : '', a.outdated ? 'changed since' : ''].filter(Boolean).join(' · ')
      if (extra) where.append(extra)
      box.append(el('div', { class: 'ask-row' }, el('div', { class: 'top' }, el('span', { class: `mark ${a.coverage}`, text: mark(a) }), el('span', { text: a.text })), where.childNodes.length ? where : null))
    }
    if (asks.outside.length) box.append(el('p', { class: 'dim', text: `Not tied to any request: step${asks.outside.length === 1 ? '' : 's'} ${asks.outside.join(', ')}.` }))
  }
  pageEl.replaceChildren(box)
}

// ── keys ──────────────────────────────────────────────────────────────────

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return
  if (event.metaKey || event.ctrlKey || event.altKey || !view?.shown) return
  const all = steps()
  const at = page.kind === 'step' ? all.findIndex((s) => s.position === (page as { position: number }).position) : -1
  switch (event.key) {
    case 'j': case 'ArrowRight': {
      const next = page.kind === 'overview' ? all.find((s) => s.position === resumeAt()) ?? all[0] : all[at + 1]
      if (next) { go({ kind: 'step', position: next.position }); event.preventDefault() }
      break
    }
    case 'k': case 'ArrowLeft':
      if (at > 0) go({ kind: 'step', position: all[at - 1]!.position })
      else if (page.kind !== 'overview') go({ kind: 'overview' })
      event.preventDefault()
      break
    case 'x':
      if (at >= 0) void toggleRead(all[at]!)
      break
    case 'Escape': case 'o':
      go({ kind: 'overview' })
      break
  }
})

orca.document?.onDidChange(() => { void load() })
void load()
