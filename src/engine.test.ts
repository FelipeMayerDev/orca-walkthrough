// Engine tests: the diff parser, the normalizer that makes a model's answer
// safe, the overlay over a changed diff, and the transcript reader.

import { assert, test } from 'orca/testing'
import { matchFocused } from './workspace'
import { parseDiff, headerPath, unquote, numberLines } from './engine/hunks'
import { jobScript, readOutcome, isRunCommand } from './engine/job'
import { agentOf, modelOf, agentsEnabled } from './engine/agents'
import { parseCatalog, catalogFor, hermesModels, hermesDefault, zcodeModels } from './engine/catalog'
import { agentKeysFrom } from './engine/orcaConfig'
import { displayEnv } from './engine/clipboard'
import { cacheKey } from './engine/cache'
import type { DigestFile } from './engine/digest'
import { buildDigest } from './engine/digest'
import { normalize, overlay, overlayAsks, parseJson, LIMITS, fileTotals } from './engine/walkthrough'
import { parseTranscript, isNoise, cleanCommitMessage, resolveTask, joinMessages, MAX_TASK_CHARS } from './engine/task'
import { readKey, markStep, unmarkStep, mergeRead, changedSince } from './engine/read'
import { isGenerated } from './engine/generated'
import { toMarkdown } from './engine/export'
import { loadSections, sourceKey, describe, pullRequests, type Source } from './engine/sources'
import type { Exec } from './engine/exec'
import {
  stepTurn, turnId, turnKey, turnEnv, turnPaths, excludesLine, parseMeta, writeMeta, splitRecent,
  type TurnEvent, type TurnStates,
} from './engine/turns'

const PATCH = `diff --git a/src/app.ts b/src/app.ts
index 111..222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 import x
+import y
 function main() {
   return x
 }
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const n = 1
+export const m = 2
`

test('parses files and hunks with stable ids', () => {
  const files = parseDiff(PATCH, 'working')
  assert.equal(files.length, 2)
  const app = files[0]!
  assert.equal(app.path, 'src/app.ts')
  assert.equal(app.hunks.length, 1)
  assert.equal(app.hunks[0]!.added, 1)
  assert.equal(app.hunks[0]!.deleted, 0)
  assert.match(app.hunks[0]!.id, /^working:src\/app\.ts:[0-9a-f]{8}$/)
  const created = files[1]!
  assert.equal(created.status, 'added')
  assert.equal(created.hunks[0]!.added, 2)
})

test('numbers lines: old numbers for removals, new for the rest', () => {
  const [file] = parseDiff(PATCH, 'working')
  const lines = numberLines(file!.hunks[0]!)
  assert.deepEqual(
    lines.map((l) => [l.kind, l.number, l.text]),
    [[' ', 1, 'import x'], ['+', 2, 'import y'], [' ', 3, 'function main() {'], [' ', 4, '  return x'], [' ', 5, '}']]
  )
})

test('reads git-quoted paths and header paths with spaces', () => {
  assert.equal(unquote('"caf\\303\\251 x"'), 'café x')
  assert.equal(headerPath('diff --git a/a b.ts b/b b.ts'), 'b b.ts')
  assert.equal(headerPath('diff --git "a/sp ace.ts" "b/sp ace.ts"'), 'sp ace.ts')
})

test('two identical hunks in one file get distinct ids', () => {
  const twice = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,1 +1,2 @@
+same
@@ -5,1 +6,2 @@
+same
`
  const [file] = parseDiff(twice, 'working')
  assert.notEqual(file!.hunks[0]!.id, file!.hunks[1]!.id)
})

test('generated files are kept out of the digest but stay in the files', () => {
  const sections = [{ scope: 'working', patch: PATCH + `diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,1 +1,2 @@
 locked
+more
` }]
  const digest = buildDigest(sections)
  assert.equal(digest.fileCount, 2)
  assert.equal(digest.hunkCount, 2) // the lockfile's hunk is not sent to the model
  assert.equal(digest.files.length, 3)
  assert.deepEqual(digest.generatedPaths, ['package-lock.json'])
})

test('normalize drops aliases that are not in the digest and keeps limits', () => {
  const digest = buildDigest([{ scope: 'working', patch: PATCH }])
  const raw = {
    title: 'Add y and new module',
    summary: 'Imports y and adds constants.',
    parts: [
      { title: 'Core', blurb: 'The change itself', steps: [
        { title: 'Import y', hunks: ['h1', 'h1', 'h9', 'not-an-alias'], weight: 'key', text: 'The new import makes y available to main.', notes: [{ kind: 'choice', text: 'y is imported at the top for every caller.' }] },
        { title: 'New module', hunks: ['h2'], weight: 'normal', text: 'Two constants are exported from the new file.', notes: [] },
        { title: 'Dropped: no hunks', hunks: [], weight: 'normal', text: 'Nothing points anywhere.', notes: [] },
      ] },
    ],
    skipped: [{ path: 'src/app.ts', note: 'Nothing left out here.' }],
  }
  const w = normalize(raw, digest.idByAlias, digest.digestFiles)
  const step = w.parts[0]!.steps[0]!
  assert.deepEqual(step.hunkIds, [digest.idByAlias['h1']!])
  assert.equal(step.weight, 'key')
  assert.equal(w.parts[0]!.steps.length, 2)
  // A skipped note only lands on a file whose hunks were left out.
  assert.deepEqual(w.skipped, [])
})

test('steps stop at the limits, and each hunk is used once', () => {
  const hunks = Array.from({ length: LIMITS.steps + 5 }, (_, i) => `@@ -${i * 10 + 1},3 +${i * 10 + 1},3 @@\n context ${i}\n+line ${i}\n`).join('')
  const digest = buildDigest([{ scope: 'working', patch: `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n${hunks}` }])
  assert.equal(digest.hunkCount, LIMITS.steps + 5)
  const many = digest.digestFiles[0]!.aliases.map((a, i) => ({ title: `S${i}`, hunks: [a], weight: 'normal', text: `Step ${i}.`, notes: [] }))
  const w = normalize({ title: 't', summary: 's', parts: [{ title: 'P', blurb: '', steps: many }], skipped: [] }, digest.idByAlias)
  assert.equal(w.parts[0]!.steps.length, LIMITS.steps)
})

test('parseJson reads a fenced or prose-wrapped object', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseJson('Here it is: {"a":{"b":2}} — hope it helps'), { a: { b: 2 } })
  assert.throws(() => parseJson('no object at all'), /not JSON/)
})

test('overlay marks a step outdated when its hunk is gone, and lists the uncovered', () => {
  const digest = buildDigest([{ scope: 'working', patch: PATCH }])
  const w = normalize({
    title: 't', summary: 's',
    parts: [{ title: 'P', blurb: '', steps: [{ title: 'Import y', hunks: ['h1', 'h2'], weight: 'normal', text: 'The import.', notes: [] }] }],
    skipped: [{ path: 'src/new.ts', note: 'New constants.' }],
  }, digest.idByAlias, digest.digestFiles)
  const now = buildDigest([{ scope: 'working', patch: PATCH.replace('+import y\n', '') }])
  const view = overlay(w, now.files)
  assert.equal(view.steps[0]!.outdated, true)
  assert.equal(view.steps[0]!.found.length, 1) // h2 (src/new.ts) is still there
  assert.equal(view.steps[0]!.missing, 1) // h1's content changed, so its id is gone
  // The new file's hunk is covered by the step; only the changed hunk counts as uncovered now.
  const uncoveredPaths = view.uncovered.map((u) => u.file.path)
  assert.deepEqual(uncoveredPaths, ['src/app.ts'])
  assert.equal(view.uncovered[0]!.note, '')
})

test('pull requests keep their body inside the task budget', async () => {
  const big = 'x'.repeat(50_000)
  const exec: Exec = async () => ({
    code: 0,
    stdout: JSON.stringify([
      { number: 1, title: 'One', body: big, headRefName: 'b1', baseRefName: 'main', author: { login: 'a' }, isDraft: false, updatedAt: '2026-11-09T10:00:00Z' },
      { number: 2, title: 'Two', body: null, headRefName: 'b2', baseRefName: 'main', author: { login: 'a' }, isDraft: false, updatedAt: '2026-11-09T11:00:00Z' },
    ]),
    stderr: '',
  })
  const pulls = await pullRequests(exec, '/repo', 'b1')
  assert.equal(pulls.length, 2)
  // Newest update first: PR 2, then PR 1 (the checked-out branch, body clipped).
  assert.equal(pulls[0]!.number, 2)
  assert.equal(pulls[0]!.body, '') // gh's null body, not a crash
  assert.equal(pulls[1]!.number, 1)
  assert.equal(pulls[1]!.body.length, MAX_TASK_CHARS)
  assert.equal(pulls[1]!.current, true)
})

test('agents: each adapter builds its run line and reads its answer', () => {
  // The run line: the right CLI, the right delivery of prompt and answer.
  assert.ok(jobScript('claude').includes('claude ') && jobScript('claude').includes('--json-schema'))
  assert.ok(jobScript('codex').includes('codex exec') && jobScript('codex').includes('-o out.json') && jobScript('codex').includes('read-only'))
  assert.ok(jobScript('opencode').includes('opencode run') && jobScript('opencode').includes('--format json'))
  // A model key rides along only when the agent has models to name.
  assert.ok(jobScript('codex').includes('-m'))
  // The answer: codex's final-message file, opencode's text parts joined.
  const codex = readOutcome('codex', { out: '{"title":"t","summary":""}', err: '', code: '0' })
  assert.equal(codex.raw.title, 't')
  assert.equal(codex.cost, null)
  assert.throws(() => readOutcome('codex', { out: '', err: 'boom', code: '1' }), /boom/)
  const oc = readOutcome('opencode', { out: ['{"type":"text","part":{"text":"{\\"title\\":"}}', '{"type":"text","part":{"text":"\\"t\\"}"}}'].join('\n'), err: '', code: '0' })
  assert.equal(oc.raw.title, 't')
  // Claude keeps its envelope: structured output and its own cost.
  const claude = readOutcome('claude', { out: JSON.stringify({ subtype: 'success', structured_output: { title: 'c' }, total_cost_usd: 0.42 }), err: '', code: '0' })
  assert.equal(claude.raw.title, 'c')
  assert.equal(claude.cost, 0.42)
  // A run is recognized by the flags it alone passes together.
  assert.equal(isRunCommand('codex exec --sandbox read-only --skip-git-repo-check -m gpt'), true)
  assert.equal(isRunCommand('codex exec do something else'), false)
  assert.equal(isRunCommand('claude -p --json-schema x --no-session-persistence a --strict-mcp-config b --disable-slash-commands'), true)
  // A model is the chosen agent's: claude's haiku is not codex's anything.
  assert.equal(modelOf('claude', 'haiku').key, 'haiku')
  assert.equal(modelOf('codex', 'haiku').key, 'gpt-6.1-sol')
  assert.equal(agentOf('nope').key, 'claude')
})

test('the model catalog: latest snapshot per agent, mapped to ours', () => {
  const row = (agent: string, models: unknown[]) => ({ agent, json: JSON.stringify({ agent, discovered: { models } }) })
  const catalog = parseCatalog([
    row('codex', [{ id: 'old-model', label: 'Old' }]),
    row('codex', [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', isDefault: true },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
      { id: null, label: 'broken' },
    ]),
    row('opencode2', [{ id: 'opencode/beam-free', label: 'Beam Free' }]),
    row('omp', [{ id: 'anthropic/claude-opus-5-5', label: 'Opus' }]),
    { agent: 'junk', json: 'not json' },
  ])
  // Every agent name the catalog holds — the worker unions it with the
  // profile's map, so agents Orca runs but never mapped are not lost.
  assert.deepEqual([...catalog.keys].sort(), ['codex', 'omp', 'opencode2'])
  // The later codex snapshot wins; unusable entries drop.
  assert.deepEqual(catalog.codex, [
    { key: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', isDefault: true },
    { key: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', isDefault: false },
  ])
  // Orca's 'opencode2' is the opencode CLI; other programs' agents stay out.
  assert.equal(catalog.opencode?.[0]?.key, 'opencode/beam-free')
  assert.equal(catalog.opencode?.length, 1)
  // The account's default sorts first for the picker.
  const sorted = catalogFor(catalog, 'codex')!
  assert.equal(sorted[0]!.key, 'gpt-6.1-sol')
  assert.equal(catalogFor(catalog, 'opencode')!.length, 1)
  assert.equal(catalogFor(null, 'codex'), null)
})

test('enabled agents: Orca names them, adapters claim the ones they can run', () => {
  // Orca's map names 31-odd agents; only the ones with an adapter here stay,
  // and claude — this plugin's default — leads even when Orca listed others first.
  const orcaKeys = ['qwen-code', 'zcode', 'codex', 'hermes', 'gemini', 'omp', 'opencode2', 'devin']
  assert.deepEqual(agentsEnabled(orcaKeys).map((a) => a.key), ['zcode', 'codex', 'opencode', 'omp', 'hermes'])
  assert.deepEqual(agentsEnabled(['codex']).map((a) => a.key), ['codex'])
  // With nothing Orca-side readable, claude alone: the plugin still works.
  assert.deepEqual(agentsEnabled([]).map((a) => a.key), ['claude'])
  // The new adapters each build their own run line.
  assert.ok(jobScript('omp').includes('omp --mode json') && jobScript('omp').includes('@prompt.txt'))
  assert.ok(jobScript('hermes').includes('hermes --cli') && jobScript('hermes').includes('-z'))
  assert.ok(jobScript('zcode').includes('zcode-cli') && jobScript('zcode').includes('-p'))
  // And read what their protocols leave: omp is pi-mono JSONL, hermes plain text.
  const omp = readOutcome('omp', { out: '{"type":"text","part":{"text":"{\\"title\\":\\"o\\"}"}}', err: '', code: '0' })
  assert.equal(omp.raw.title, 'o')
  assert.throws(() => readOutcome('hermes', { out: '', err: 'no provider', code: '1' }), /no provider/)
})

test('the profile state names the agents Orca has enabled', () => {
  const data = { settings: { agentDefaultArgs: { codex: '--x', hermes: '--y', zcode: '' } } }
  assert.deepEqual(agentKeysFrom(data), ['codex', 'hermes', 'zcode'])
  assert.deepEqual(agentKeysFrom(null), [])
  assert.deepEqual(agentKeysFrom({}), [])
})

test('zcode models: read off the runtime bundle, newest plain first', () => {
  const bundle = '"a":"glm-4.6","b":"glm-5.2","c":"glm-5.3","d":"glm-5.3-flash","e":"glm-5-turbo","f":"glm-5.3-flashx","g":"glm-5.1"'
  const models = zcodeModels(bundle)
  assert.deepEqual(models.map((m) => m.key), ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2', 'glm-5.1', 'glm-5-turbo'])
  assert.equal(models[0]!.isDefault, true)
  assert.equal(models.filter((m) => m.isDefault).length, 1)
  // Nothing to read: no invented list.
  assert.deepEqual(zcodeModels(null), [])
  assert.deepEqual(zcodeModels('const x = 1'), [])
})

test('hermes models: the picker cache, the configured default marked', () => {
  const cache = { providers: { openrouter: { models: [{ id: 'z-ai/glm-5.2', default: true }, { id: 'anthropic/claude-opus-4.6' }] }, nous: { models: [{ id: 'z-ai/glm-5.2' }, { id: 'qwen/qwen3' }] } } }
  const models = hermesModels(cache, 'anthropic/claude-opus-4.6')
  assert.deepEqual(models.map((m) => m.key), ['z-ai/glm-5.2', 'anthropic/claude-opus-4.6', 'qwen/qwen3'])
  assert.equal(models.find((m) => m.isDefault)?.key, 'anthropic/claude-opus-4.6')
  // A configured default the cache never heard of still leads it.
  const ahead = hermesModels(cache, 'openai/o3')
  assert.equal(ahead[0]!.key, 'openai/o3')
  assert.equal(ahead[0]!.isDefault, true)
  assert.deepEqual(hermesModels({}, ''), [])
  assert.equal(hermesDefault('x\nmodel:\n  default: anthropic/claude-opus-4.6\n'), 'anthropic/claude-opus-4.6')
  assert.equal(hermesDefault('defaults: nope'), '')
})

test('display env: the sockets the session has, the names the worker lacks', () => {
  // A full environment needs nothing added.
  assert.deepEqual(displayEnv({ platform: 'linux', uid: 1000, env: { XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: 'wayland-1' }, runtime: { path: '/run/user/1000', entries: ['wayland-0', 'wayland-1'] } }), {})
  // The worker's scrubbed environment: runtime and socket are derived, the
  // runtime dir is overridden only when the env's own name would not list.
  assert.deepEqual(
    displayEnv({ platform: 'linux', uid: 1000, env: {}, runtime: { path: '/run/user/1000', entries: ['wayland-0', 'wayland-1', 'pulse'] } }),
    { XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: 'wayland-0' }
  )
  // An env value that lists fine is kept; only the socket is added.
  assert.deepEqual(
    displayEnv({ platform: 'linux', uid: 1000, env: { XDG_RUNTIME_DIR: '/run/user/1000' }, runtime: { path: '/run/user/1000', entries: ['wayland-1'] } }),
    { WAYLAND_DISPLAY: 'wayland-1' }
  )
  // No wayland socket, no DISPLAY: the X socket names the display.
  assert.deepEqual(
    displayEnv({ platform: 'linux', uid: 1000, env: {}, runtime: { path: '/run/user/1000', entries: ['pulse'] }, x11Dir: ['X0', 'X1'] }),
    { XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: ':0' }
  )
  // Nothing discoverable: nothing invented.
  assert.deepEqual(displayEnv({ platform: 'linux', uid: 1000, env: {}, runtime: null }), {})
  assert.deepEqual(displayEnv({ platform: 'darwin', uid: 501, env: {}, runtime: null }), {})
})

test('cache keys: another agent is another walkthrough, claude keeps its names', () => {
  const files: DigestFile[] = [{ path: 'a.ts', oldPath: null, status: 'modified', binary: false, generated: false, unread: undefined, scope: 'working', hunks: [] }]
  const base = { top: '/repo', source: 'uncommitted', model: '', language: 'en', files }
  assert.equal(cacheKey(base), cacheKey({ ...base, agent: 'claude' }))
  assert.notEqual(cacheKey(base), cacheKey({ ...base, agent: 'codex' }))
})

test('fileTotals names the line ranges each step covers', () => {
  const patch = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -10,4 +10,4 @@ fn one
 context
-old
+new
 context
 context
@@ -40,2 +42,0 @@ fn two
-gone
-gone2
@@ -60,3 +63,4 @@ fn three
 ctx
+added
 ctx
 ctx
`
  const digest = buildDigest([{ scope: 'working', patch }])
  // The model points at the hunks bottom-up; the ranges come out ordered anyway.
  const w = normalize({
    title: 't', summary: '',
    parts: [{ title: 'P', blurb: '', steps: [{ title: 'S', hunks: ['h3', 'h2', 'h1'], weight: 'normal', text: 'Changes.', notes: [] }] }],
    skipped: [],
  }, digest.idByAlias, digest.digestFiles)
  const view = overlay(w, digest.files)
  const totals = fileTotals(view.steps[0]!.found)
  assert.equal(totals.length, 1)
  assert.equal(totals[0]!.path, 'a.ts')
  assert.equal(totals[0]!.added, 2)
  assert.equal(totals[0]!.deleted, 3)
  // h1 covers 10–13 and h3 covers 63–66; h2 is a pure deletion, which leaves
  // nothing on the new side and so no range.
  assert.deepEqual(totals[0]!.ranges, [[10, 13], [63, 66]])
})

test('markdown export carries each step files with their line ranges', () => {
  const digest = buildDigest([{ scope: 'working', patch: PATCH }])
  const w = normalize({
    title: 't', summary: '',
    parts: [{ title: 'P', blurb: '', steps: [{ title: 'S', hunks: ['h1'], weight: 'normal', text: 'The import.', notes: [] }] }],
    skipped: [],
  }, digest.idByAlias, digest.digestFiles)
  const md = toMarkdown(overlay(w, digest.files), { title: 't', summary: '' })
  // PATCH's first hunk rewrites lines 1–5 of src/app.ts (+1 −0).
  assert.ok(md.includes('`src/app.ts` +1 −0 `L1–5`'), md)
})

test('asks coverage follows the hunks, not the model word', () => {
  const digest = buildDigest([{ scope: 'working', patch: PATCH }])
  const w = normalize({
    title: 't', summary: 's',
    parts: [{ title: 'P', blurb: '', steps: [{ title: 'All', hunks: ['h1', 'h2'], weight: 'normal', text: 'Everything.', notes: [] }] }],
    skipped: [],
    asks: [
      { text: 'Import y', hunks: ['h1'], coverage: 'seen' },
      { text: 'Add retry', hunks: [], coverage: 'seen' },
      { text: 'New constants', hunks: ['h2'], coverage: 'absent' },
    ],
  }, digest.idByAlias, digest.digestFiles, { asks: true })
  assert.deepEqual(w.asks!.map((a) => a.coverage), ['seen', 'absent', 'partly'])
  const view = overlay(w, digest.files)
  const task = overlayAsks(w.asks, view)!
  assert.equal(task.met, 2)
  assert.deepEqual(task.outside, [])
})

test('transcripts: only what a person typed, since a moment, in this tree', () => {
  const line = (j: unknown) => JSON.stringify(j)
  const now = Date.now()
  const out = [
    line({ type: 'user', isSidechain: false, cwd: '/repo', timestamp: new Date(now - 5000).toISOString(), message: { content: 'Fix the login bug' }, sessionId: 's1', uuid: 'u1' }),
    line({ type: 'assistant', cwd: '/repo', timestamp: new Date(now - 4000).toISOString(), message: { content: 'On it' } }),
    line({ type: 'user', isSidechain: true, cwd: '/repo', timestamp: new Date(now - 3000).toISOString(), message: { content: 'subagent prompt' } }),
    line({ type: 'user', isMeta: true, cwd: '/repo', timestamp: new Date(now - 3000).toISOString(), message: { content: 'meta' } }),
    line({ type: 'user', cwd: '/repo', timestamp: new Date(now - 3000).toISOString(), message: { content: [{ type: 'text', text: 'and add a test' }] }, sessionId: 's1', uuid: 'u2' }),
    line({ type: 'user', cwd: '/repo', timestamp: new Date(now - 3000).toISOString(), message: { content: [{ type: 'tool_result', text: 'output' }] } }),
    line({ type: 'user', cwd: '/other', timestamp: new Date(now - 2000).toISOString(), message: { content: 'elsewhere' }, uuid: 'u3' }),
    line({ type: 'user', cwd: '/repo/sub', timestamp: new Date(now - 1000).toISOString(), message: { content: 'in a subfolder' }, sessionId: 's2', uuid: 'u4' }),
    line({ type: 'user', cwd: '/repo', timestamp: new Date(now - 60000).toISOString(), message: { content: 'too old' }, uuid: 'u5' }),
  ].join('\n')
  const prompts = parseTranscript(out, { top: '/repo', since: now - 10000 })
  assert.deepEqual(prompts.map((p) => p.text), ['Fix the login bug', 'and add a test', 'in a subfolder'])
})

test('noise stays out of the task', () => {
  assert.equal(isNoise('/clear'), true)
  assert.equal(isNoise('<command-name>/test</command-name>'), true)
  assert.equal(isNoise('[Request interrupted by user'), true)
  assert.equal(isNoise('Retry failed uploads on a 503'), false)
})

test('commit messages lose trailers and merge subjects', () => {
  assert.equal(cleanCommitMessage('Add retries\n\nBody text.\n\nCo-Authored-By: x <x@y>\nSigned-off-by: y <y@x>'), 'Add retries\n\nBody text.')
  assert.equal(cleanCommitMessage("Merge pull request #12 from a/b\n\nThe real title"), 'The real title')
})

test('many prompts become one task, numbered, newest kept', () => {
  const prompts = [
    { at: 1, text: 'Build the upload form', session: null },
    { at: 2, text: 'Make the button blue', session: null },
    { at: 3, text: 'Also retry on 503', session: null },
  ]
  const joined = joinMessages(prompts)
  assert.match(joined, /Message 1:\nBuild the upload form/)
  assert.match(joined, /Message 3:\nAlso retry on 503/)
  const task = resolveTask({ mode: 'auto', source: { kind: 'uncommitted' }, prompts, since: 'the last commit' })
  assert.equal(task!.from, 'prompts')
  assert.match(task!.text, /Build the upload form/)
})

test('read marks are by content, and survive staging and merging', () => {
  const id = 'working:src/app.ts:abcd1234'
  assert.equal(readKey(id), 'src/app.ts:abcd1234')
  let read = markStep({ hunkIds: [id] }, {})
  assert.equal(read['src/app.ts:abcd1234'] !== undefined, true)
  read = unmarkStep({ hunkIds: [id] }, read)
  assert.deepEqual(read, {})
  const disk = { 'a.ts:1': 1, 'b.ts:2': 2 }
  const mine = { 'a.ts:1': 9, 'c.ts:3': 3 }
  assert.deepEqual(mergeRead(disk, mine, ['a.ts:1', 'b.ts:2', 'c.ts:3']), { 'a.ts:1': 9, 'c.ts:3': 3 })
})

test('changedSince finds steps whose code moved under them', () => {
  const idA = 'working:a.ts:aaaa', idB = 'working:b.ts:bbbb'
  const read = markStep({ hunkIds: [idA] }, {})
  // As the overlay would mark them: idA is gone from the diff now, so its step is outdated.
  const steps = [{ hunkIds: [idA], outdated: true }, { hunkIds: [idB], outdated: false }]
  const changed = changedSince(steps, read, { before: [idA, idB], current: [idB] })
  assert.deepEqual(changed.map((s) => s.hunkIds), [[idA]])
})

test('markdown keeps order, weights, notes and bounds', () => {
  const digest = buildDigest([{ scope: 'working', patch: PATCH }])
  const w = normalize({
    title: 'Add y', summary: 'Two small additions.',
    parts: [{ title: 'Core', blurb: 'The change', steps: [{ title: 'Import y', hunks: ['h1'], weight: 'key', text: 'The import.', notes: [{ kind: 'gap', text: 'y is never used yet.' }] }] }],
    skipped: [{ path: 'src/new.ts', note: 'Two new constants.' }],
  }, digest.idByAlias, digest.digestFiles)
  const view = overlay(w, digest.files)
  const md = toMarkdown(view, w, { what: 'Uncommitted local changes', model: 'haiku', language: 'en', cost: 0.002 })
  assert.match(md, /^<!-- walkthrough -->/)
  assert.match(md, /\*\*Key change\*\*/)
  assert.match(md, />\s*\*\*Limitation:\*\* y is never used yet\./)
  assert.match(md, /### Not covered/)
  assert.match(md, /`src\/new\.ts` \(1 hunk\) — Two new constants\./)
  assert.match(md, /<!-- \/walkthrough -->\n$/)
})

test('generated files are recognized conservatively', () => {
  assert.equal(isGenerated('pnpm-lock.yaml'), true)
  assert.equal(isGenerated('src/app.min.js'), true)
  assert.equal(isGenerated('src/__snapshots__/app.test.snap'), true)
  assert.equal(isGenerated('src/lock.ts'), false)
  assert.equal(isGenerated('codegen.py'), false)
})

// ── turns ────────────────────────────────────────────────────────────────────

const said = (over: Partial<TurnEvent>): TurnEvent => ({
  workspaceId: 'w1', paneKey: 'p1', terminalId: 't1', state: 'working', at: 1000, ...over,
})
const key = turnKey(said({}))

test('a turn opens when a known agent starts working', () => {
  const states: TurnStates = {}
  assert.equal(stepTurn(states, said({})).kind, 'none') // never seen before: the turn under way is not opened half-way
  states[key] = 'done'
  const open = stepTurn(states, said({ at: 2000, title: 'claude' }))
  assert.deepEqual(open, { kind: 'open', key, startedAt: 2000, agent: 'claude' })
})

test('a permission question keeps the turn open; the answer ends it once', () => {
  const states: TurnStates = { [key]: 'working' }
  // The worker records each event's state after the step, as the reducer is pure.
  const see = (over: Partial<TurnEvent>): ReturnType<typeof stepTurn> => {
    const event = said(over)
    const action = stepTurn(states, event)
    states[key] = event.state
    return action
  }
  assert.equal(see({ state: 'blocked', at: 2000 }).kind, 'none')
  assert.equal(see({ state: 'working', at: 3000 }).kind, 'none') // back to work: same turn
  assert.deepEqual(see({ state: 'done', at: 4000, outcome: 'success' }), { kind: 'close', key, endedAt: 4000, outcome: 'success' })
  assert.equal(see({ state: 'done', at: 5000 }).kind, 'none')
  assert.equal(see({ state: 'waiting', at: 6000 }).kind, 'none')
})

test('a cancelled turn still ends, with its outcome', () => {
  const close = stepTurn({ [key]: 'working' }, said({ state: 'done', at: 4000, outcome: 'cancellation' }))
  assert.deepEqual(close, { kind: 'close', key, endedAt: 4000, outcome: 'cancellation' })
})

test('an agent seen only mid-turn opens nothing; its end closes nothing on disk', () => {
  const states: TurnStates = {}
  assert.equal(stepTurn(states, said({ state: 'done', at: 2000 })).kind, 'none') // never seen: nothing to close
  assert.equal(stepTurn(states, said({ state: 'working', at: 3000 })).kind, 'none') // started before we looked: no diff from the middle
  // The worker has recorded `working` from that event; the turn's end yields a
  // close the worker no-ops (no turn on disk for this key).
  assert.equal(stepTurn({ ...states, [key]: 'working' }, said({ state: 'done', at: 4000 })).kind, 'close')
})

test('a pane Orca cannot tie to a workspace is ignored', () => {
  const states: TurnStates = {}
  assert.equal(stepTurn(states, said({ workspaceId: null, state: 'working' })).kind, 'none')
  assert.equal(stepTurn(states, said({ workspaceId: null, state: 'done' })).kind, 'none')
})

test('two agents in one workspace are two turns', () => {
  const other = turnKey(said({ terminalId: 't2' }))
  const states: TurnStates = { [key]: 'working', [other]: 'done' }
  assert.deepEqual(stepTurn(states, said({ state: 'done', at: 2000 })), { kind: 'close', key, endedAt: 2000, outcome: null })
  assert.deepEqual(stepTurn(states, said({ terminalId: 't2', state: 'working', at: 2000 })), { kind: 'open', key: other, startedAt: 2000, agent: null })
})

test('turn ids are stable and filename-safe', () => {
  assert.equal(turnId(1000, key), turnId(1000, key))
  assert.notEqual(turnId(1000, key), turnId(2000, key))
  assert.notEqual(turnId(1000, key), turnId(1000, turnKey(said({ terminalId: 't2' }))))
  assert.match(turnId(1000, key), /^1000-[0-9a-f]{8}$/)
})

test('the snapshot environment points git at the turn\u2019s private files only', () => {
  const env = turnEnv('/repo/.git', '/data/turns/x/t1')
  assert.equal(env.GIT_INDEX_FILE, '/data/turns/x/t1/index')
  assert.equal(env.GIT_OBJECT_DIRECTORY, '/data/turns/x/t1/objects')
  assert.equal(env.GIT_ALTERNATIVE_OBJECT_DIRECTORIES, '/repo/.git/objects')
})

test('exclusion lines are anchored and escaped', () => {
  assert.equal(excludesLine('logs/big.bin'), '/logs/big.bin')
  assert.equal(excludesLine('#weird'), '/\\#weird')
  assert.equal(excludesLine('!no'), '/\\!no')
})

test('a turn\u2019s meta round-trips, and junk is no turn', () => {
  const meta = {
    id: '1000-abcd1234', top: '/repo', startedAt: 1000, endedAt: 4000, outcome: 'success', complete: true,
    terminalId: 't1', workspaceId: 'w1', agent: 'claude', beforeTree: 'a'.repeat(40), afterTree: 'b'.repeat(40),
  }
  assert.deepEqual(parseMeta(writeMeta(meta)), meta)
  assert.equal(parseMeta('not json'), null)
  assert.equal(parseMeta('{"id":"x"}'), null) // no startedAt, no top
  assert.equal(parseMeta(writeMeta({ ...meta, beforeTree: 'zz' }))?.beforeTree, null) // not a tree hash
})

test('the newest turns are kept, the rest are named for deletion', () => {
  const one = (n: number) => parseMeta(writeMeta({ id: `t${n}`, top: '/repo', startedAt: n, endedAt: n, outcome: null, complete: true, terminalId: null, workspaceId: null, agent: null, beforeTree: null, afterTree: null }))!
  const { kept, drop } = splitRecent([1, 3, 5, 2, 4].map(one), 3)
  assert.deepEqual(kept.map((m) => m.id), ['t5', 't4', 't3'])
  assert.deepEqual(drop.map((m) => m.id), ['t2', 't1'])
})

test('a turn reads as the diff of its two trees, through the private objects', async () => {
  const calls: { args: string[]; env?: Record<string, string> }[] = []
  const exec: Exec = async (_program, args, options) => {
    calls.push({ args, env: options?.env })
    // The quiet READ flags come before the subcommand, so look past them.
    if (args.includes('--absolute-git-dir')) return { code: 0, stdout: '/repo/.git\n', stderr: '' }
    if (args.includes('diff')) return { code: 0, stdout: PATCH, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const { sections } = await loadSections(exec, '/repo', { kind: 'turn', id: 't1', before: 'a'.repeat(40), after: 'b'.repeat(40) }, { dataRoot: '/data' })
  assert.equal(sections.length, 1)
  assert.equal(sections[0]!.scope, 'turn')
  const diff = calls.find((c) => c.args.includes('diff'))!
  assert.ok(diff.args.includes('a'.repeat(40)))
  assert.ok(diff.args.includes('b'.repeat(40)))
  const dir = turnPaths('/data', '/repo', 't1').dir
  assert.equal(diff.env?.GIT_OBJECT_DIRECTORY, `${dir}/objects`)
  assert.equal(diff.env?.GIT_ALTERNATIVE_OBJECT_DIRECTORIES, '/repo/.git/objects')
  // The patch parses like any other; its hunks live in the turn's scope.
  const digest = buildDigest(sections)
  assert.equal(digest.hunkCount, 2)
  assert.match(digest.files[0]!.hunks[0]!.id, /^turn:src\/app\.ts:[0-9a-f]{8}$/)
})

test('a turn without both trees is an honest empty diff, reading nothing', async () => {
  const calls: unknown[] = []
  const exec: Exec = async (_program, args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' } }
  const { sections, unread } = await loadSections(exec, '/repo', { kind: 'turn', id: 't1' }, { dataRoot: '/data' })
  assert.deepEqual(sections, [])
  assert.deepEqual(unread, [])
  assert.deepEqual(calls, []) // nothing ran: there is nothing to claim
})

test('a turn whose snapshots were evicted reads as empty, not as an error', async () => {
  const exec: Exec = async (_program, args) => {
    if (args.includes('--absolute-git-dir')) return { code: 0, stdout: '/repo/.git\n', stderr: '' }
    return { code: 128, stdout: '', stderr: "fatal: bad object" } // the private objects are gone
  }
  const { sections } = await loadSections(exec, '/repo', { kind: 'turn', id: 't1', before: 'a'.repeat(40), after: 'b'.repeat(40) }, { dataRoot: '/data' })
  assert.deepEqual(sections, [])
})

test('turn sources name and describe themselves', () => {
  const source: Source = { kind: 'turn', id: '1000-abcd1234', label: 'Fix the login bug' }
  assert.equal(sourceKey(source), 'turn:1000-abcd1234')
  assert.match(describe(source), /answering one prompt/)
  assert.match(describe({ kind: 'turn', id: 'x' }), /answering one prompt/)
})

test('a turn\u2019s task is what was asked in its window, and out-of-window prompts stay out', () => {
  const source: Source = { kind: 'turn', id: 't1' }
  // The window is [startedAt - 5000, endedAt]: the slack catches the prompt that
  // started the turn, and nothing before or after belongs to it.
  const startedAt = 10000, endedAt = 12000
  const prompts = [
    { at: 4000, text: 'Before the turn', session: null },
    { at: 10000, text: 'Fix the login bug', session: null },
    { at: 11000, text: 'also add a test', session: null },
    { at: 20000, text: 'After the turn', session: null },
  ]
  const inWindow = prompts.filter((p) => p.at >= startedAt - 5000 && p.at <= endedAt)
  const task = resolveTask({ mode: 'auto', source, prompts: inWindow })
  assert.equal(task!.from, 'turn')
  assert.match(task!.text, /Fix the login bug/)
  assert.ok(!/Before the turn/.test(task!.text))
  assert.ok(!/After the turn/.test(task!.text))
  assert.equal(resolveTask({ mode: 'auto', source, prompts: [] }), null)
})

test('parseTranscript bounds a turn at both ends', () => {
  const line = (at: number, text: string, uuid: string) => JSON.stringify({ type: 'user', cwd: '/repo', timestamp: new Date(at).toISOString(), message: { content: text }, uuid })
  const text = [line(1000, 'in the middle', 'u1'), line(2000, 'too late', 'u2'), line(500, 'too early', 'u3')].join('\n')
  const prompts = parseTranscript(text, { top: '/repo', since: 800, until: 1500 })
  assert.deepEqual(prompts.map((p) => p.text), ['in the middle'])
})

test('matchFocused: the id tells apart one repository listed on two hosts', () => {
  const local = { id: 'a::/w', name: 'Walkthough', path: '/w', branch: 'refs/heads/x' }
  const server = { id: 'b::/w', name: 'Walkthough', path: '/w', branch: 'refs/heads/x' }
  assert.equal(matchFocused({ workspaceId: 'b::/w', branch: 'x', displayName: 'Walkthough' }, [local, server]), server)
  assert.equal(matchFocused({ branch: 'x', displayName: 'Walkthough' }, [local, server]), null)
})

test('matchFocused: a client-prefixed id still finds the workspace by its uuid', () => {
  const w = { id: 'identity:wt2:local:u1', name: 'a', path: '/a', branch: null }
  assert.equal(matchFocused({ workspaceId: 'identity:wt2:runtime:srv:u1', branch: '', displayName: 'x' }, [w]), w)
})
