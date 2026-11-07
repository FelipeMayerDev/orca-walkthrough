// What a walkthrough is of, and the git that reads it. Every function takes an
// `Exec`, so the same code runs in the worker and under tests.
//
// A source becomes one or more sections: a patch and the scope its hunk ids
// live in. Staged and unstaged edits of the same lines are different hunks, so
// a step written about the staged version is never quietly matched to an
// unstaged one.

import type { Exec } from './exec'

// Reads write nothing under .git: no index refresh, no lock, no fsmonitor.
const READ = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'diff.autoRefreshIndex=false']
// The user's diff settings (no prefixes, external tools, color) must not change what is parsed.
const DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-M']
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
// Untracked files are read one by one; past these, the rest are listed unread.
const MAX_UNTRACKED = 300
export const MAX_UNTRACKED_BYTES = 1024 * 1024

export type Source =
  | { kind: 'uncommitted' }
  | { kind: 'staged' }
  | { kind: 'unstaged' }
  | { kind: 'branch'; base: string; head?: string }
  | { kind: 'commit'; hash: string; subject?: string }
  | { kind: 'pr'; number: number; title?: string; head?: string; base?: string }

export const SCOPES: { key: Source['kind']; label: string; about: string }[] = [
  { key: 'uncommitted', label: 'Uncommitted', about: 'Everything not committed yet: staged, unstaged and new files' },
  { key: 'staged', label: 'Staged', about: 'What the next commit would hold' },
  { key: 'unstaged', label: 'Unstaged', about: 'The working tree and new files, not staged' },
  { key: 'branch', label: 'Branch', about: 'Everything this branch adds to its base, committed or not' },
  { key: 'commit', label: 'Commit', about: 'One commit, against its first parent' },
  { key: 'pr', label: 'Pull request', about: 'An open pull request on GitHub, as GitHub shows its changes (needs gh)' },
]

export type GitResult = { ok: boolean; code: number; out: string; err: string }

export async function git(exec: Exec, cwd: string, args: string[]): Promise<GitResult> {
  const r = await exec('git', [...READ, ...args], { cwd })
  return { ok: r.code === 0, code: r.code, out: r.stdout ?? '', err: (r.stderr || '').trim() }
}

async function must(exec: Exec, cwd: string, args: string[]): Promise<string> {
  const r = await git(exec, cwd, args)
  if (!r.ok) throw new Error(r.err || `git ${args[0]} failed`)
  return r.out
}

export type Repo = { top: string; name: string; branch: string | null; born: boolean; gitDir: string }

/** The repository a folder is in, or null outside git. */
export async function repoAt(exec: Exec, folder: string): Promise<Repo | null> {
  const top = await git(exec, folder, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return null
  const root = top.out.trim()
  const head = await git(exec, root, ['rev-parse', '--verify', '-q', 'HEAD'])
  const branch = (await git(exec, root, ['branch', '--show-current'])).out.trim()
  // A linked worktree keeps its index and HEAD outside its folder, under the main repository's .git.
  const gitDir = (await git(exec, root, ['rev-parse', '--absolute-git-dir'])).out.trim()
  return { top: root, name: root.split('/').pop() ?? root, branch: branch || null, born: head.ok, gitDir: gitDir || `${root}/.git` }
}

/** What HEAD is now: the branch, or "HEAD@<short hash>" when detached, so each one is a source of its own. */
export async function currentHead(exec: Exec, top: string): Promise<string> {
  const branch = (await git(exec, top, ['branch', '--show-current'])).out.trim()
  if (branch) return branch
  const short = (await git(exec, top, ['rev-parse', '--short', 'HEAD'])).out.trim()
  return short ? `HEAD@${short}` : 'HEAD'
}

/** A source's stable name: part of its cache key and the name of its pointer. */
export function sourceKey(source: Source): string {
  // The branch being read is part of it: two branches against one base are two walkthroughs.
  if (source.kind === 'branch') return `branch:${source.base}...${source.head ?? 'HEAD'}`
  if (source.kind === 'commit') return `commit:${source.hash}`
  // Not pinned to the head commit: when the pull request moves on, its last walkthrough is shown as outdated.
  if (source.kind === 'pr') return `pr:${source.number}`
  return source.kind
}

/** One line for the model and the header: what is being walked through. */
export function describe(source: Source, repo: Repo | null = null): string {
  switch (source.kind) {
    case 'uncommitted': return 'Uncommitted local changes, staged and unstaged, with new files.'
    case 'staged': return 'Staged changes: what the next commit would hold.'
    case 'unstaged': return 'Unstaged changes in the working tree, with new files.'
    case 'branch': return `Everything branch "${source.head ?? repo?.branch ?? 'HEAD'}" adds to "${source.base}", committed or not. Work that came in from ${source.base} is left out.`
    case 'commit': return `Commit ${source.hash.slice(0, 12)}${source.subject ? ` ("${source.subject}")` : ''}, against its first parent.`
    case 'pr': return `Pull request #${source.number}${source.title ? ` ("${source.title}")` : ''}${source.head && source.base ? `, "${source.head}" into "${source.base}"` : ''}, as GitHub shows its changes.`
    default: return 'Local changes.'
  }
}

/**
 * New files git doesn't track yet, as patches. `git diff` never shows them,
 * and a walkthrough of local work without its new files would miss most of it.
 * @returns the patches, and the files that could not be read, each with why
 */
// Untracked patches by repository and path, with the size and modification time
// they were read at. A refresh re-reads the diff, and re-diffing every new file
// each time (up to 300 processes) would keep the CPU busy while an agent edits.
const memo = new Map<string, { stamp: string; patch: string }>()
const MEMO_LIMIT = 4000

export async function untracked(exec: Exec, top: string): Promise<{ patches: string[]; unread: { path: string; why: string }[] }> {
  const list = await must(exec, top, ['ls-files', '--others', '--exclude-standard', '-z'])
  const paths = list.split('\0').filter(Boolean)
  const unread = paths.slice(MAX_UNTRACKED).map((path) => ({ path, why: `Not read: more than ${MAX_UNTRACKED} new files.` }))
  const take = paths.slice(0, MAX_UNTRACKED)
  if (!take.length) return { patches: [], unread }

  const results = new Array<string | null>(take.length).fill(null)
  const queue = await stamps(exec, top, take)
  const problems = new Array<string | null>(take.length).fill(null)
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (!(item.size >= 0)) { problems[item.i] = "Not read: it can't be opened."; continue }
      if (item.size > MAX_UNTRACKED_BYTES) { problems[item.i] = 'Not read: larger than 1 MB.'; continue }
      const key = `${top}\0${item.path}`
      const known = memo.get(key)
      if (known && known.stamp === item.stamp) { results[item.i] = known.patch; continue }
      // --no-index exits 1 when the files differ, which is the point.
      const r = await git(exec, top, ['diff', '--no-index', ...DIFF, '--', '/dev/null', item.path])
      if (r.code <= 1) {
        results[item.i] = r.out
        if (memo.size >= MEMO_LIMIT) memo.clear()
        memo.set(key, { stamp: item.stamp, patch: r.out })
      } else problems[item.i] = `Not read: ${r.err || 'git diff failed'}`
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker))
  // Kept in the order git listed them, whichever worker finished first: the order is part of the cache key.
  const patches = results.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
  take.forEach((path, i) => { const why = problems[i]; if (why) unread.push({ path, why }) })
  return { patches, unread }
}

type Stamp = { path: string; i: number; stamp: string; size: number }

/**
 * Each file's size and modification time, in one call: a stray 40 MB log must
 * not reach the model. Exactly one line per file, in order ("-1" when it can't
 * be read), so no size lands on the wrong path. GNU stat first: BSD's `stat
 * -c` fails, while GNU's `stat -f` would succeed with something else.
 */
async function stamps(exec: Exec, top: string, paths: string[]): Promise<Stamp[]> {
  const stats = await exec('sh', ['-c', 'for f; do s=$(stat -c \'%s %.9Y\' "$f" 2>/dev/null || stat -f \'%z %Fm\' "$f" 2>/dev/null) || s=-1; echo "${s:--1}"; done', 'sh', ...paths], { cwd: top })
  const lines = (stats.stdout ?? '').split('\n')
  return paths.map((path, i) => {
    const stamp = (lines[i] ?? '-1').trim()
    return { path, i, stamp, size: Number(stamp.split(' ')[0]) }
  })
}

/**
 * A source → sections to parse, and files that could not be read.
 */
export async function loadSections(exec: Exec, top: string, source: Source): Promise<{ sections: { scope: string; patch: string }[]; unread: { path: string; why: string }[] }> {
  const sections: { scope: string; patch: string }[] = []
  let unread: { path: string; why: string }[] = []
  const add = (scope: string, ...patches: (string | null)[]) => {
    const patch = patches.filter((p): p is string => Boolean(p && p.trim())).join('\n')
    if (patch.trim()) sections.push({ scope, patch })
  }
  const withUntracked = async (scope: string, patch: string | null): Promise<void> => {
    const u = await untracked(exec, top)
    unread = u.unread
    add(scope, patch, ...u.patches)
  }

  switch (source.kind) {
    case 'uncommitted':
      add('staged', await must(exec, top, ['diff', '--cached', ...DIFF]))
      await withUntracked('working', await must(exec, top, ['diff', ...DIFF]))
      break
    case 'staged':
      add('staged', await must(exec, top, ['diff', '--cached', ...DIFF]))
      break
    case 'unstaged':
      await withUntracked('working', await must(exec, top, ['diff', ...DIFF]))
      break
    case 'branch': {
      // The merge base, so work that arrived on the base after branching is not counted as this branch's.
      const base = (await must(exec, top, ['merge-base', source.base, 'HEAD'])).trim()
      await withUntracked('branch', await must(exec, top, ['diff', ...DIFF, base]))
      break
    }
    case 'commit': {
      const parents = (await must(exec, top, ['rev-list', '--parents', '-n', '1', source.hash])).trim().split(' ')
      add('commit', await must(exec, top, ['diff', ...DIFF, parents[1] ?? EMPTY_TREE, source.hash]))
      break
    }
    case 'pr':
      add('pr', await gh(exec, top, ['pr', 'diff', String(source.number), '--color=never']))
      break
    default:
      throw new Error(`Unknown source "${(source as Source).kind}"`)
  }
  return { sections, unread }
}

/** Runs the GitHub CLI; its failures come back as one readable sentence. */
async function gh(exec: Exec, top: string, args: string[]): Promise<string> {
  let r
  try { r = await exec('gh', args, { cwd: top }) } catch { throw new Error(GH_MISSING) }
  if (r.code !== 0) throw new Error(ghError(r.stderr || r.stdout))
  return r.stdout ?? ''
}

const GH_MISSING = 'Pull requests are read with the GitHub CLI (gh), and it isn\u2019t installed. Install it, then run gh auth login.'

/** gh's own words, made to say what to do. */
export function ghError(text: string | null | undefined): string {
  const t = String(text ?? '').trim()
  if (/gh auth login|not logged in|authentication/i.test(t)) return 'The GitHub CLI isn\u2019t logged in. Run gh auth login, then try again.'
  if (/no git remotes|none of the git remotes|not a github|could not determine base repo/i.test(t)) return 'This repository has no GitHub remote, so it has no pull requests to read.'
  if (/HTTP 406|too_large|diff exceeded|maximum number of (lines|files)/i.test(t)) return 'GitHub won\u2019t send a diff this large (about 300 files or 20,000 lines). Read it as a Branch instead.'
  if (/could not resolve to a pullrequest|no pull requests? found/i.test(t)) return 'That pull request wasn\u2019t found.'
  return t.split('\n').filter(Boolean).pop() || 'gh failed.'
}

export type PullRequest = { number: number; title: string; body: string; head: string; base: string; author: string; draft: boolean; updated: string; current: boolean }

/**
 * The repository's open pull requests, newest update first. The description comes
 * with the list, so matching a pull request against it costs no other call.
 */
export async function pullRequests(exec: Exec, top: string, branch: string | null = null): Promise<PullRequest[]> {
  const out = await gh(exec, top, ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,body,headRefName,baseRefName,author,isDraft,updatedAt'])
  let list: any[]
  try { list = JSON.parse(out || '[]') } catch { throw new Error('gh answered with something other than a list of pull requests.') }
  return list
    .map((p) => ({ number: p.number, title: p.title ?? '', body: typeof p.body === 'string' ? p.body : '', head: p.headRefName ?? '', base: p.baseRefName ?? '', author: p.author?.login ?? '',
      draft: Boolean(p.isDraft), updated: p.updatedAt ?? '', current: Boolean(branch) && p.headRefName === branch }))
    .sort((a, b) => b.updated.localeCompare(a.updated))
}

export type Commit = { hash: string; short: string; subject: string; author: string; when: string }

/** The latest commits on HEAD. */
export async function recentCommits(exec: Exec, top: string, count = 40): Promise<Commit[]> {
  const r = await git(exec, top, ['log', `-n${count}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%cr'])
  if (!r.ok) return []
  return r.out.split('\n').filter(Boolean).map((line) => {
    const [hash = '', short = '', subject = '', author = '', when = ''] = line.split('\x1f')
    return { hash, short, subject, author, when }
  })
}

/** A commit's whole message, subject and body; null when git couldn't read it (so it can be asked again). */
export async function commitMessage(exec: Exec, top: string, hash: string): Promise<string | null> {
  const r = await git(exec, top, ['log', '-1', '--format=%B', hash, '--'])
  return r.ok ? r.out.trim() : null
}

/**
 * Since when (ms) the prompts sent to agents count as the task of a working
 * tree or branch source, and how to say so: the last commit for local
 * changes, where the branch left its base for a branch. 0 in a repository
 * with no commits.
 */
export async function taskSince(exec: Exec, top: string, source: Source): Promise<{ since: number; label: string }> {
  let at = 'HEAD', label = 'the last commit'
  if (source.kind === 'branch') {
    const base = await git(exec, top, ['merge-base', source.base, 'HEAD'])
    if (base.ok && base.out.trim()) { at = base.out.trim(); label = `the branch left ${source.base}` }
  }
  const r = await git(exec, top, ['log', '-1', '--format=%ct', at, '--'])
  const seconds = r.ok ? Number(r.out.trim()) : 0
  return { since: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0, label: seconds > 0 ? label : 'the repository began' }
}

/**
 * Where a branch most likely started from: its upstream remote's default
 * branch, else a local main, master, trunk or develop, never itself.
 */
export async function defaultBase(exec: Exec, top: string, current: string | null): Promise<string | null> {
  const head = await git(exec, top, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
  const candidates = [head.ok ? head.out.trim() : '', 'origin/main', 'origin/master', 'main', 'master', 'trunk', 'develop'].filter(Boolean)
  for (const ref of candidates) {
    if (ref === current || ref === `origin/${current}`) continue
    if ((await git(exec, top, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])).ok) return ref
  }
  return null
}

/** Branches to compare against: local ones, then remote ones, most recent first, without the current one. */
export async function baseChoices(exec: Exec, top: string, current: string | null): Promise<string[]> {
  const r = await git(exec, top, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
  return r.out.split('\n').map((s) => s.trim()).filter((s) => s && s !== current && !s.endsWith('/HEAD') && s !== 'origin')
}
