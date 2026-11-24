// The panel <-> worker contract, declared once: panel/main.ts and src/worker.ts both read it.

import type { Source, Commit, PullRequest, Repo } from './engine/sources'
import type { TaskOverlay, Overlay, Walkthrough } from './engine/walkthrough'
import type { ReadRecord } from './engine/read'
import type { Task } from './engine/task'
import type { Entry } from './store'

export type { Source, Commit, PullRequest, Repo, TaskOverlay, Overlay, Walkthrough, ReadRecord, Task, Entry }

export type WorkspaceInfo = { path: string; name: string; branch: string | null }

export type StateAnswer = {
  workspace: WorkspaceInfo | null
  repo: Repo | null
  /** The agents whose CLIs can generate, whether each is installed, and the models each offers — Orca's own catalog when it can be read. */
  agents: { key: string; name: string; available: boolean; models: { key: string; label: string; isDefault: boolean }[] }[]
  error: string | null
  /** Every workspace Orca knows, for a manual pick when the focused one can't be matched. */
  choices: WorkspaceInfo[]
}

/** One recorded turn, for the panel's picker. `prompt` is clipped for the option's label; the trees let the panel build the Source, like a commit's hash does. */
export type TurnSummary = {
  id: string
  startedAt: number
  endedAt: number | null
  outcome: string | null
  complete: boolean
  agent: string | null
  prompt: string
  before: string | null
  after: string | null
}

export type ScopesAnswer = {
  current: string
  defaultBase: string | null
  bases: string[]
  commits: Commit[]
  pulls: PullRequest[]
  prError: string | null
  turns: TurnSummary[]
}

export type FileSummary = {
  path: string
  oldPath: string | null
  status: string
  binary: boolean
  generated: boolean
  scope: string
  unread?: string
  hunkCount: number
  added: number
  deleted: number
}

export type DiffAnswer = {
  sk: string
  what: string
  fileCount: number
  hunkCount: number
  tokens: number
  tooBig: boolean
  files: FileSummary[]
}

export type HunkRef = { id: string; path: string; status: string; scope: string; header: string; added: number; deleted: number }

export type StepOut = {
  id: string
  title: string
  weight: string
  text: string
  notes: { kind: string; text: string }[]
  position: number
  part: number
  hunks: HunkRef[]
  missing: number
  outdated: boolean
  read: boolean
}

export type EntryMeta = {
  key: string
  /** The agent whose CLI wrote this ('claude' for everything made before there were others). */
  agent: string
  model: string
  language: string
  generatedAt: number
  took: number
  cost: number | null
}

export type AskOut = { id: string; text: string; coverage: string; steps: number[]; tail: number; missing: number; outdated: boolean }

export type UncoveredOut = { path: string; status: string; generated: boolean; binary: boolean; note: string; unread?: string; hunks: HunkRef[] }

export type ViewAnswer = {
  diff: DiffAnswer
  /** The key the walkthrough of this diff would have, in this model and language. */
  key: string
  /** The walkthrough shown: exact for this code, or the last one here (older code). */
  shown: { meta: EntryMeta; title: string; summary: string; exact: boolean } | null
  parts: { title: string; blurb: string; steps: StepOut[] }[]
  uncovered: UncoveredOut[]
  outdated: number
  /** The task the shown walkthrough was matched against; `changed` when the task found now differs. */
  task: (Task & { changed: boolean }) | null
  /** The task found now (auto mode), for the exact key. */
  taskNow: Task | null
  asks: { list: AskOut[]; met: number; total: number; outside: number[] } | null
  job: { running: boolean; startedAt: number; deadline: number; agent: string; model: string } | null
}

export type GenerateAnswer = { cached: boolean; key: string; tooBig?: boolean; promptChars?: number }

export type PollAnswer = { running: boolean; entry: Entry | null; error: string | null }

export type HunkLines = { header: string; context: string; oldStart: number; newStart: number; lines: string[] }

export type TaskAnswer = { task: Task | null }

export type MarkdownAnswer = { text: string }

declare module 'orca' {
  interface PluginRequests {
    /** The focused workspace, its repository, and the agents whose CLIs can generate. `pick`: a workspace chosen by hand when matching failed; `path`: read this workspace whatever is focused (a client forwarding to this server). */
    'walkthrough.state': { input: { pick?: string; path?: string }; output: StateAnswer }
    /** What there is to read: branches, commits and pull requests. */
    'walkthrough.scopes': { input: { top: string }; output: ScopesAnswer }
    /** A source's diff as it is now, without hunk contents. */
    'walkthrough.diff': { input: { top: string; source: Source }; output: DiffAnswer }
    /** Everything the panel shows for a source: the walkthrough over the diff as it is now. */
    'walkthrough.view': { input: { top: string; source: Source; agent?: string; model?: string; language?: string }; output: ViewAnswer }
    /** Hunk contents by id, for the step being read. */
    'walkthrough.hunks': { input: { top: string; source: Source; ids: string[] }; output: { hunks: Record<string, HunkLines> } }
    /** The task found for a source (auto mode), to show before generating. */
    'walkthrough.task': { input: { top: string; source: Source }; output: TaskAnswer }
    /** Starts a generation in the background. */
    'walkthrough.generate': { input: { top: string; source: Source; agent?: string; model?: string; language?: string; taskMode?: string; taskText?: string }; output: GenerateAnswer }
    /** Looks at the running job; a finished one becomes an entry. */
    'walkthrough.poll': { input: { top: string; source: Source }; output: PollAnswer }
    /** Stops the running job. */
    'walkthrough.cancel': { input: { top: string; source: Source }; output: { cancelled: boolean } }
    /** The hunks read in a repository. */
    'walkthrough.read.load': { input: { top: string }; output: { read: ReadRecord } }
    /** Marks (or unmarks) hunks read. */
    'walkthrough.read.mark': { input: { top: string; ids: string[]; on: boolean }; output: { read: ReadRecord } }
    /** The walkthrough shown as Markdown. */
    'walkthrough.markdown': { input: { top: string; source: Source }; output: MarkdownAnswer }
    /** Puts text on the system clipboard. */
    'walkthrough.clipboard': { input: { text: string }; output: { copied: boolean } }
  }
  interface PluginPanelEvents {
    'walkthrough.job': { top: string; sk: string; done: boolean }
  }
}
