// The walkthrough worker. The panel asks; this reads git, gh and the stored
// walkthroughs, and runs generations of `claude -p` in the background.

import type { OrcaWorkerApi } from 'orca/worker'
import './protocol'
import { matchFocused } from './workspace'
import * as store from './store'
import {
  currentHead, defaultBase, baseChoices, recentCommits, pullRequests, commitMessage, taskSince,
  sourceKey, type Source,
} from './engine/sources'
import type { Task } from './engine/task'
import { overlay, overlayAsks } from './engine/walkthrough'
import { indexHunks } from './engine/hunks'
import { estimateTokens, MAX_PROMPT_CHARS } from './engine/cache'
import { isRead } from './engine/read'
import { resolveTask, taskKey, taskCacheKey, TASK_MODES, type TaskMode } from './engine/task'
import { DEFAULT_MODEL, modelOf } from './engine/job'
import { DEFAULT_LANGUAGE } from './engine/languages'
import { toMarkdown } from './engine/export'
import type {
  AskOut, DiffAnswer, FileSummary, GenerateAnswer, PollAnswer, ScopesAnswer, StateAnswer,
  StepOut, ViewAnswer, EntryMeta, HunkRef, HunkLines, UncoveredOut,
} from './protocol'

const invalid = (message: string): Error => Object.assign(new Error(message), { code: 'invalid_params' })

let claudeChecked: string | null | undefined

async function settings(orca: OrcaWorkerApi): Promise<{ model: string; language: string; preferences: string }> {
  const all = await orca.settings.get().catch(() => ({}) as Record<string, unknown>)
  return {
    model: typeof all.model === 'string' ? modelOf(all.model).key : DEFAULT_MODEL,
    language: typeof all.language === 'string' ? all.language : DEFAULT_LANGUAGE,
    preferences: typeof all.preferences === 'string' ? all.preferences : '',
  }
}

async function repoOf(top: string) {
  const repo = await store.repository(top)
  if (!repo) throw invalid(`"${top}" is not inside a git repository.`)
  return repo
}

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

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('walkthrough.state', async (input): Promise<StateAnswer> => {
    const pick = input?.pick || ''
    const context = await orca.host.call('workspace.readContext').catch(() => null)
    if (!context) return { workspace: null, repo: null, claude: null, error: null, choices: [] }
    const { workspaces } = await orca.host.call('workspace.list')
    // Name and branch first, then the name alone, then a unique branch match (a
    // folder whose display name differs from its folder name still reads).
    let match = matchFocused({ branch: context.branch, displayName: context.displayName }, workspaces)
      ?? (workspaces.filter((w) => (w.branch ?? '').replace(/^refs\/heads\//, '') === context.branch).length === 1
        ? workspaces.find((w) => (w.branch ?? '').replace(/^refs\/heads\//, '') === context.branch)! : null)
      ?? null
    // A reader's explicit choice overrides only when matching failed.
    if (!match && pick) match = workspaces.find((w) => w.path === pick) ?? null
    const choices = workspaces.map((w) => ({ path: w.path, name: w.name, branch: w.branch ?? null }))
    if (!match) {
      return {
        workspace: null, repo: null, claude: null, choices,
        error: `Could not match the focused workspace "${context.displayName}" to exactly one workspace in Orca. Pick one below.`,
      }
    }
    if (claudeChecked === undefined) claudeChecked = await store.claudeVersion()
    const repo = await store.repository(match.path)
    return {
      workspace: { path: match.path, name: context.displayName, branch: context.branch || null },
      repo, claude: claudeChecked, error: null, choices,
    }
  })

  orca.panels.handle('walkthrough.scopes', async ({ top }): Promise<ScopesAnswer> => {
    const current = await currentHead(store.exec, top).catch(() => '')
    const [def, choices, commits] = await Promise.all([
      defaultBase(store.exec, top, current || null),
      baseChoices(store.exec, top, current || null),
      recentCommits(store.exec, top, 30),
    ])
    let pulls: Awaited<ReturnType<typeof pullRequests>> = []
    let prError: string | null = null
    try { pulls = await pullRequests(store.exec, top, current || null) } catch (e) { prError = e instanceof Error ? e.message : String(e) }
    return { current, defaultBase: def, bases: choices, commits, pulls, prError }
  })

  orca.panels.handle('walkthrough.diff', async ({ top, source }): Promise<DiffAnswer> => {
    const repo = await repoOf(top)
    return diffAnswer(await store.readDiff(repo, source))
  })

  orca.panels.handle('walkthrough.view', async ({ top, source, model, language }): Promise<ViewAnswer> => {
    const repo = await repoOf(top)
    const { model: defModel, language: defLanguage, preferences } = await settings(orca)
    const chosenModel = modelOf(model ?? defModel).key
    const chosenLanguage = language ?? defLanguage
    const diff = await store.readDiff(repo, source)
    const taskNow = await taskFor(repo.top, source)
    const key = store.keyFor(repo, diff, chosenModel, chosenLanguage, preferences, taskNow)
    const shown = await store.findShown(repo, diff, key)

    const job = await store.jobOf(repo, diff.sk)
    const running = job && !job.done ? await store.alive(job) : false

    if (!shown) {
      return {
        diff: diffAnswer(diff), key, shown: null, parts: [], uncovered: [], outdated: 0,
        task: null, taskNow, asks: null,
        job: job ? { running, startedAt: job.meta.startedAt, deadline: job.meta.deadline, model: job.meta.model } : null,
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
    const meta: EntryMeta = { key: entry.key, model: entry.model, language: entry.language, generatedAt: entry.generatedAt, took: entry.took, cost: entry.cost }
    return {
      diff: diffAnswer(diff), key,
      shown: { meta, title: entry.walkthrough.title, summary: entry.walkthrough.summary, exact },
      parts, uncovered, outdated: view.outdated,
      task: entry.task ? { ...entry.task, changed: taskKey(entry.task) !== taskKey(taskNow) } : null,
      taskNow, asks,
      job: job ? { running, startedAt: job.meta.startedAt, deadline: job.meta.deadline, model: job.meta.model } : null,
    }
  })

  orca.panels.handle('walkthrough.hunks', async ({ top, source, ids }) => {
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

  orca.panels.handle('walkthrough.task', async ({ top, source }) => ({ task: await taskFor(top, source) }))

  orca.panels.handle('walkthrough.generate', async ({ top, source, model, language, taskMode, taskText }): Promise<GenerateAnswer> => {
    const repo = await repoOf(top)
    const { model: defModel, language: defLanguage, preferences } = await settings(orca)
    const chosenModel = modelOf(model ?? defModel).key
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
    const key = store.keyFor(repo, diff, chosenModel, chosenLanguage, preferences, task)
    if (!store.fits(prompt)) return { cached: false, key, tooBig: true, promptChars: store.promptChars(prompt) }
    if (await store.hasEntry(key)) return { cached: true, key }
    const previous = await store.previousEntry(repo, diff)
    const before = previous ? previous.walkthrough.parts.flatMap((p) => p.steps.flatMap((s) => s.hunkIds)) : []
    await store.startJob(repo, diff, { key, model: chosenModel, language: chosenLanguage, prompt, source, task, before })
    orca.panels.post('walkthrough.job', { top, sk: diff.sk, done: false })
    return { cached: false, key, promptChars: store.promptChars(prompt) }
  })

  orca.panels.handle('walkthrough.poll', async ({ top, source }): Promise<PollAnswer> => {
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

  orca.panels.handle('walkthrough.cancel', async ({ top, source }) => {
    const repo = await repoOf(top)
    const job = await store.jobOf(repo, sourceKey(source))
    if (job) await store.cancelJob(job)
    return { cancelled: true }
  })

  orca.panels.handle('walkthrough.read.load', async ({ top }) => ({ read: await store.loadRead(top) }))

  orca.panels.handle('walkthrough.read.mark', async ({ top, ids, on }) => ({ read: await store.saveRead(top, ids, on) }))

  orca.panels.handle('walkthrough.markdown', async ({ top, source }) => {
    const repo = await repoOf(top)
    const { model, language } = await settings(orca)
    const diff = await store.readDiff(repo, source)
    const taskNow = await taskFor(repo.top, source)
    const key = store.keyFor(repo, diff, model, language, '', taskNow)
    const shown = await store.findShown(repo, diff, key)
    if (!shown) throw invalid('No walkthrough to copy for this change. Generate one first.')
    const view = overlay(shown.entry.walkthrough, diff.files)
    const asks = overlayAsks(shown.entry.walkthrough.asks, view)
    return { text: toMarkdown(view, shown.entry.walkthrough, { what: diff.what, model: shown.entry.model, language: shown.entry.language, cost: shown.entry.cost }, asks, shown.entry.task?.label ?? '') }
  })

  orca.panels.handle('walkthrough.clipboard', async ({ text }) => {
    await store.copyText(text)
    return { copied: true }
  })
}