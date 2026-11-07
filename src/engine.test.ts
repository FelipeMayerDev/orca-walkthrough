// Engine tests: the diff parser, the normalizer that makes a model's answer
// safe, the overlay over a changed diff, and the transcript reader.

import { assert, test } from 'orca/testing'
import { parseDiff, headerPath, unquote, numberLines } from './engine/hunks'
import { buildDigest } from './engine/digest'
import { normalize, overlay, overlayAsks, parseJson, LIMITS } from './engine/walkthrough'
import { parseTranscript, isNoise, cleanCommitMessage, resolveTask, joinMessages } from './engine/task'
import { readKey, markStep, unmarkStep, mergeRead, changedSince } from './engine/read'
import { isGenerated } from './engine/generated'
import { toMarkdown } from './engine/export'

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
