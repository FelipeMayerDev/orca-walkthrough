// The task a change was made for, to match the change against: the prompt an
// agent was answering, a pull request's description, a commit message, the
// prompts sent to agents while the change was made, or the reader's own words.
// Plain functions over text; reading git, gh and transcripts is the worker's.
//
// The task is material for the model to read, never instructions to it.

import { hash } from './hash'
import type { PullRequest, Source } from './sources'

// Long enough for a detailed prompt or a pull request template filled in; short enough that a
// pasted log cannot crowd out the diff.
export const MAX_TASK_CHARS = 6000
export const MAX_MESSAGE_CHARS = 2000
// Prompts listed for a change made over many: the first states the task, the latest refine it.
export const MAX_MESSAGES = 20

export const TASK_MODES = [
  { key: 'auto', name: 'Found', about: 'The prompt, pull request description or commit message this change came with' },
  { key: 'own', name: 'Your own', about: 'Write what the change should do, and it is matched against that' },
  { key: 'off', name: 'Off', about: 'No task: the walkthrough only orders and explains' },
] as const
export type TaskMode = (typeof TASK_MODES)[number]['key']

/** A stored choice → { mode, text }, whatever the store held. */
export function taskChoice(saved: { mode?: string; text?: string } | null | undefined): { mode: TaskMode; text: string } {
  const mode: TaskMode = TASK_MODES.some((m) => m.key === saved?.mode) ? (saved!.mode as TaskMode) : 'auto'
  return { mode, text: typeof saved?.text === 'string' ? saved.text.slice(0, MAX_TASK_CHARS) : '' }
}

/** Claude Code's folder name for a project: every character but a letter or a digit becomes "-". */
export const projectSlug = (path: string): string => String(path ?? '').replace(/[^A-Za-z0-9]/g, '-')

/**
 * Whether a message asks for nothing a diff could show: empty, a bare slash
 * command, a command's echo or output, Claude Code's own notices, an interruption.
 */
export function isNoise(text: string | null | undefined): boolean {
  const t = String(text ?? '').trim()
  if (!t) return true
  if (/^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr|task-notification|user-memory-input)>/.test(t)) return true
  if (/^Caveat: The messages below were generated/i.test(t)) return true
  if (/^\[Request interrupted by user/i.test(t)) return true
  if (/^\/[\w:.-]+$/.test(t)) return true
  return false
}

/** At most `max` characters, cut at the end with a mark. */
export function clip(text: string | null | undefined, max: number): string {
  const t = String(text ?? '').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** The text of a user message's content: a string, or its text blocks; a tool result is no message. */
function contentText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || content.some((b: any) => b?.type === 'tool_result')) return ''
  return content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
}

export type Prompt = { at: number; text: string; session: string | null }

/** A prompt relayed by another program comes wrapped as <hc from="t3">…</hc>. */
export const unwrap = (prompt: string): string => /^<hc from="[^"]*">([\s\S]*?)(?:<\/hc>\s*)?$/.exec(prompt)?.[1] ?? prompt

/**
 * Claude Code transcript lines → what a person typed into an agent working in
 * `top`, since `since` (ms) until `until` (ms; 0 for no bound), oldest first.
 * Subagents' prompts, tool results, meta lines, compaction summaries and
 * commands are left out; a resumed session's copied history is counted once.
 */
export function parseTranscript(text: string | null | undefined, { top = null as string | null, since = 0, until = 0 } = {}): Prompt[] {
  const out: Prompt[] = []
  const seen = new Set<string>()
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    let j: any
    try { j = JSON.parse(line) } catch { continue }
    if (j?.type !== 'user' || j.isSidechain || j.isMeta || j.isCompactSummary || j.isVisibleInTranscriptOnly) continue
    // Newer versions say who wrote it; a hook or another program isn't the person.
    if (j.origin?.kind && j.origin.kind !== 'human') continue
    const cwd = typeof j.cwd === 'string' ? j.cwd : ''
    if (top && cwd !== top && !cwd.startsWith(`${top}/`)) continue
    const at = Date.parse(j.timestamp ?? '') || 0
    if (at < since) continue
    if (until && at > until) continue
    const body = unwrap(contentText(j.message?.content).trim()).trim()
    if (isNoise(body)) continue
    const id = j.uuid ?? `${at}\n${body}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ at, text: body, session: j.sessionId ?? null })
  }
  return out.sort((a, b) => a.at - b.at)
}

/**
 * Prompts → one text, oldest first, each numbered. Past MAX_TASK_CHARS the
 * first stays (it usually states the task) and the newest that fit follow it.
 */
export function joinMessages(messages: Prompt[], max = MAX_TASK_CHARS): string {
  const items = messages.map((m) => clip(m.text, MAX_MESSAGE_CHARS)).filter(Boolean)
  if (items.length <= 1) return items[0] ?? ''
  const block = (text: string, i: number) => `Message ${i + 1}:\n${text}`
  const all = items.map(block).join('\n\n')
  if (all.length <= max && items.length <= MAX_MESSAGES) return all
  const first = block(items[0]!, 0)
  const kept: string[] = []
  let room = max - first.length - 60
  for (let i = items.length - 1; i > 0 && kept.length < MAX_MESSAGES - 1; i--) {
    const b = block(items[i]!, i)
    if (b.length + 2 > room) break
    kept.unshift(b)
    room -= b.length + 2
  }
  const left = items.length - 1 - kept.length
  return [first, left ? `(${left} message${left === 1 ? '' : 's'} in between left out)` : '', ...kept].filter(Boolean).join('\n\n')
}

/**
 * A pull request's description as a task: HTML comments (templates' hints)
 * and any walkthrough pasted into it (Copy as Markdown marks its bounds) left out.
 */
export function cleanDescription(body: string | null | undefined): string {
  return String(body ?? '')
    .replace(/<!--\s*walkthrough\s*-->[\s\S]*?(<!--\s*\/walkthrough\s*-->|$)/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// The subject git (or GitHub) writes for a merge says which branch came in, not what it does.
const MERGE_SUBJECT = /^Merge (pull request #\d+ from \S+|(remote-tracking )?branch '[^']*'( of \S+)?( into \S+)?|branches .+|commit '[^']*'( into \S+)?|tag '[^']*'( into \S+)?)$/

/**
 * A commit message as a task: its trailers (Signed-off-by, Co-Authored-By, …)
 * left out, and a merge's generated subject, so a merged pull request's title
 * (its body) is what remains.
 */
export function cleanCommitMessage(message: string | null | undefined): string {
  let lines = String(message ?? '').replace(/\r\n/g, '\n').trimEnd().split('\n')
  if (MERGE_SUBJECT.test(lines[0]?.trim() ?? '')) lines = lines.slice(1)
  while (lines.length && !lines[0]!.trim()) lines.shift()
  while (lines.length > 1 && /^[A-Za-z][\w-]*: .+/.test(lines[lines.length - 1]!) && /^(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|change-id|reported-by|suggested-by|helped-by|cc|fixes|closes|refs|generated-by)$/i.test(lines[lines.length - 1]!.split(':')[0]!)) lines.pop()
  return lines.join('\n').trim()
}

export type Task = { from: string; label: string; short: string; about: string; text: string; context: string }

/**
 * What the task is, or null for none. `from` says where it came from, `label`
 * says so to the reader, `about` says so to the model.
 */
export function resolveTask({ mode = 'auto', own = '', source = null, pr = null, commit = null, prompts = null, since = 'the last commit' }: {
  mode?: TaskMode
  own?: string
  source?: Source | null
  pr?: PullRequest | null
  commit?: string | null
  prompts?: Prompt[] | null
  since?: string
}): Task | null {
  if (mode === 'off') return null
  const task = (from: string, label: string, short: string, about: string, text: string, context = ''): Task | null => {
    const t = clip(text, MAX_TASK_CHARS)
    return t ? { from, label, short, about, text: t, context } : null
  }
  if (mode === 'own') return task('own', 'Your own words', 'yours', "the reader's own description of what the change should do", own)
  switch (source?.kind) {
    case 'pr': {
      if (!pr) return null
      const body = cleanDescription(pr.body)
      const text = [String(pr.title ?? '').trim(), body].filter(Boolean).join('\n\n')
      return task('pr', `The description of #${pr.number ?? (source as { number: number }).number}`, 'PR description', "the pull request's title and description", text)
    }
    case 'commit':
      return task('commit', 'The commit message', 'commit message', "the commit's message", cleanCommitMessage(commit))
    case 'uncommitted': case 'staged': case 'unstaged': case 'branch': {
      const list = (prompts ?? []).filter((p) => !isNoise(p.text))
      if (!list.length) return null
      const n = list.length
      return task('prompts', `${n} prompt${n === 1 ? '' : 's'} sent to agents since ${since}`, `${n} prompt${n === 1 ? '' : 's'}`,
        `the prompts sent to coding agents in this repository while the change was made (since ${since}), oldest first`, joinMessages(list))
    }
    case 'turn': {
      const list = (prompts ?? []).filter((p) => !isNoise(p.text))
      if (!list.length) return null
      const n = list.length
      return task('turn', n === 1 ? 'The prompt this turn answered' : `${n} prompts this turn answered`, `${n} prompt${n === 1 ? '' : 's'}`,
        `the prompt${n === 1 ? '' : 's'} the person sent while the agent answered, oldest first`, joinMessages(list))
    }
    default:
      return null
  }
}

/** Which task a walkthrough was written for: "" for none. Tells a walkthrough's task from the one found now. */
export const taskKey = (task: Task | null): string => (task ? hash(`${task.from}\n${task.text}\n${task.context ?? ''}`) : '')

/**
 * What a task adds to a cache key: "" for none, so a walkthrough without one
 * keeps the key it had. Prompts sent to agents grow with every message (a
 * "thanks", the walkthrough's own Send), so a walkthrough matched against them
 * is keyed by that kind of task alone: it stays the walkthrough of this code,
 * matched against the prompts as they were when it was written. A turn's
 * prompts are bounded by the turn, but keyed the same way, for the same reason.
 */
export const taskCacheKey = (task: Task | null): string => (!task ? '' : task.from === 'prompts' || task.from === 'turn' ? task.from : taskKey(task))

/** A repository's path as it stands inside Claude Code's JSON, to find its lines with grep -F. */
export const jsonPath = (path: string): string => JSON.stringify(String(path ?? '')).slice(1, -1)

/**
 * The listing script the worker runs for transcripts: $0 the folder-name
 * prefix, $1 since (seconds), $2 the repository as JSON writes it. Only lines
 * of sessions in the repository (or below it) are kept, before anything is
 * cut, so a sibling folder sharing the prefix can't crowd them out. An image's
 * data is emptied rather than the line cut, so a prompt sent with a
 * screenshot keeps its words.
 */
export const TRANSCRIPTS = `root="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
[ -d "$root" ] || exit 0
for d in "$root/$0"*; do
  [ -d "$d" ] || continue
  for f in "$d"/*.jsonl; do
    [ -f "$f" ] || continue
    m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null) || continue
    [ "\${m:-0}" -ge "$1" ] 2>/dev/null || continue
    grep -h '"type":"user"' "$f" 2>/dev/null | grep -F -e "\\"cwd\\":\\"$2\\"" -e "\\"cwd\\":\\"$2/" | grep -v -e '"tool_result"' -e '"isSidechain":true' -e '"isMeta":true' | sed -e 's|"data":"[A-Za-z0-9+/=]*"|"data":""|g'
  done
done | tail -c 4000000
exit 0`
