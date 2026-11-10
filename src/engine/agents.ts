// The agents that can read a diff for a walkthrough — the ones enabled in
// Orca, each run by its own CLI. Which agents those are is not a list kept
// here: Orca names them in its own config (`settings.agentDefaultArgs` of the
// active profile, plus its model catalog), and engine/orcaConfig.ts reads the
// names from there. This file only knows how to RUN an agent once Orca has
// named it: adapters, grouped by the headless protocol a CLI speaks.
//
// Every adapter answers the same two questions: which command line runs in a
// job folder (`line`, called from run.sh with the model as $1, prompt.txt,
// system.txt and schema.json beside), and what the run left behind (`read`).
// The prompt itself is agent-agnostic prose; `parseJson` accepts a fenced or
// bare JSON answer from whoever wrote it. Availability is `<command>
// --version` — an agent whose CLI is missing shows up unavailable, and one
// Orca knows but no adapter here speaks is simply not offered.

import { parseJson } from './walkthrough'

export type AgentModel = { key: string; name: string; about?: string }

export type AgentDef = {
  /** This plugin's stable key for the agent (cache keys, entries, chips). */
  key: string
  /** The names Orca knows it by (`agentDefaultArgs`, the model catalog). */
  orcaKeys: string[]
  /** What people call it, in errors and chips. */
  name: string
  command: string
  models: AgentModel[]
  defaultModel: string
  /** The run.sh line; $1 is the model key ('' means: whatever the agent is configured with). */
  line: (model: string) => string
  /** Flags the run alone passes together, to recognize our pid in `ps`. */
  marks: string[]
  /** What the finished run left: the raw walkthrough object and its cost. */
  read: (out: string, err: string, code: string) => { raw: any; cost: number | null }
}

/** The last lines of stderr, or the exit status — what a person can act on. */
const fellOver = (name: string, err: string, code: string): Error => {
  const why = String(err ?? '').trim().split('\n').filter(Boolean).slice(-3).join(' ') || `${name} exited with ${String(code ?? '?').trim()}`
  return Object.assign(new Error(why), { code: 'failed' })
}

// The model arrives as `$1` from run.sh: double quotes, so the shell expands
// it (single quotes would pass the dollar sign to the CLI verbatim).

/** The Claude Code protocol: `-p`, JSON envelope, structured output, cost. */
function claudeCodeLike(key: string, name: string, command: string): AgentDef {
  return {
    key, orcaKeys: [key], name, command,
    models: [
      { key: 'haiku', name: 'Haiku', about: 'Fast and cheap; fine for most changes' },
      { key: 'sonnet', name: 'Sonnet', about: 'Better grouping on large or subtle changes' },
      { key: 'opus', name: 'Opus', about: 'The most careful reading, the highest cost' },
    ],
    defaultModel: 'haiku',
    line: (model) =>
      `${command} '-p' '--output-format' 'json' '--tools' '' '--no-session-persistence' '--strict-mcp-config' '--setting-sources' '' '--disable-slash-commands'${model ? ` --model "${model}"` : ''} --json-schema "$(cat schema.json)" --system-prompt "$(cat system.txt)" < prompt.txt > out.json 2> err.txt`,
    marks: ['--json-schema', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands'],
    read(out, err, code) {
      let answer: any = null
      try { answer = out ? JSON.parse(out) : null } catch { answer = null }
      if (!answer) throw fellOver(name, err, code)
      if (answer.is_error || (answer.subtype && answer.subtype !== 'success')) {
        const why = typeof answer.result === 'string' && answer.result.trim() ? answer.result.trim() : answer.subtype ?? `${name} reported an error`
        throw Object.assign(new Error(why), { code: /log ?in/i.test(why) ? 'login' : 'failed' })
      }
      const raw = answer.structured_output ?? parseJson(answer.result)
      return { raw, cost: typeof answer.total_cost_usd === 'number' ? answer.total_cost_usd : null }
    },
  }
}

/** The pi-mono family (OpenCode, oh-my-pi): JSONL events on stdout, text parts carry the answer. */
function piLike(key: string, orcaKeys: string[], name: string, command: string, line: (model: string) => string, marks: string[]): AgentDef {
  return {
    key, orcaKeys, name, command,
    models: [{ key: '', name: 'Default', about: `Whatever ${name} is configured with` }],
    defaultModel: '',
    line,
    marks,
    read(out, err, code) {
      const parts: string[] = []
      for (const line of String(out ?? '').split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (event?.type === 'text' && typeof event.part?.text === 'string') parts.push(event.part.text)
        } catch { /* an event that is not JSON is not ours to read */ }
      }
      if (!parts.length) throw fellOver(name, err, code)
      return { raw: parseJson(parts.join('\n')), cost: null }
    },
  }
}

/** Every adapter this plugin can run, in the order the picker shows them. */
export const AGENTS: AgentDef[] = [
  claudeCodeLike('claude', 'Claude', 'claude'),
  // OpenClaude speaks the Claude Code protocol; Orca names it separately.
  claudeCodeLike('openclaude', 'OpenClaude', 'openclaude'),
  {
    key: 'zcode',
    orcaKeys: ['zcode'],
    name: 'ZCode',
    command: 'zcode-cli',
    // The zcode CLI has no model flag of its own (the session's model is used)
    // and takes the prompt as an argument; the system prompt rides in front.
    models: [{ key: '', name: 'Default', about: 'The model the zcode session is set to' }],
    defaultModel: '',
    line: (model) =>
      `zcode-cli ${model ? `--model "${model}" ` : ''}-p "$(printf '%%s\\n\\n' "$(cat system.txt)"; cat prompt.txt)" --json > out.json 2> err.txt`,
    marks: ['-p', '--json'],
    read(out, err, code) {
      // --json may answer with an envelope or plain text; either way the
      // walkthrough is the JSON object inside it.
      const text = String(out ?? '').trim()
      if (!text) throw fellOver('zcode', err, code)
      try {
        const envelope = JSON.parse(text)
        const inner = typeof envelope?.result === 'string' ? envelope.result
          : typeof envelope?.text === 'string' ? envelope.text
          : typeof envelope?.message === 'string' ? envelope.message : null
        return { raw: inner !== null ? parseJson(inner) : envelope, cost: null }
      } catch {
        return { raw: parseJson(text), cost: null }
      }
    },
  },
  {
    key: 'codex',
    orcaKeys: ['codex'],
    name: 'Codex',
    command: 'codex',
    // Fallback only: the real list is Orca's catalog (engine/catalog.ts), the
    // same one Orca's own model picker shows. A ChatGPT account's codex wants
    // the model named explicitly, so there is no "default" entry.
    models: [{ key: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }],
    defaultModel: 'gpt-6.1-sol',
    line: (model) =>
      // read-only sandbox, no repo check (the job folder is not one); the system
      // prompt rides in front of the user prompt — codex takes no system prompt
      // of its own — and the final message lands in out.json, clean of progress.
      `{ printf '%%s\\n\\n' "$(cat system.txt)"; cat prompt.txt; } | codex exec --sandbox read-only --skip-git-repo-check --color never${model ? ` -m "${model}"` : ''} -o out.json - > events.txt 2> err.txt`,
    marks: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check'],
    read(out, err, code) {
      // out.json is the final message file (-o): the answer as written.
      const text = String(out ?? '').trim()
      if (!text) throw fellOver('codex', err, code)
      return { raw: parseJson(text), cost: null }
    },
  },
  piLike(
    'opencode', ['opencode2', 'opencode'], 'OpenCode', 'opencode',
    (model) => `{ printf '%%s\\n\\n' "$(cat system.txt)"; cat prompt.txt; } | opencode run${model ? ` --model "${model}"` : ''} --format json > out.json 2> err.txt`,
    ['run', '--format', 'json'],
  ),
  piLike(
    'omp', ['omp'], 'Oh My Pi', 'omp',
    (model) => `omp --mode json${model ? ` --model "${model}"` : ''} --system-prompt "$(cat system.txt)" @prompt.txt > out.json 2> err.txt`,
    ['--mode', 'json'],
  ),
  {
    key: 'hermes',
    orcaKeys: ['hermes'],
    name: 'Hermes',
    command: 'hermes',
    models: [{ key: '', name: 'Default', about: 'Whatever hermes is configured with' }],
    defaultModel: '',
    line: (model) =>
      // --cli is the non-TUI run, -z the one prompt; the system prompt rides in
      // front. The prompt travels as an argument: past ~120 KB the shell itself
      // refuses it, and the run's error says so.
      `hermes --cli${model ? ` -m "${model}"` : ''} -z "$(printf '%%s\\n\\n' "$(cat system.txt)"; cat prompt.txt)" > out.json 2> err.txt`,
    marks: ['--cli', '-z'],
    read(out, err, code) {
      const text = String(out ?? '').trim()
      if (!text) throw fellOver('hermes', err, code)
      return { raw: parseJson(text), cost: null }
    },
  },
]

export const DEFAULT_AGENT = 'claude'
export const agentOf = (key: string): AgentDef => AGENTS.find((a) => a.key === key) ?? AGENTS[0]!
export const modelOf = (agent: string, key: string): AgentModel =>
  agentOf(agent).models.find((m) => m.key === key) ?? agentOf(agent).models[0]!

/** The adapters for the agents Orca has enabled — and only those; what Orca
 *  does not list, the panel does not offer. With nothing Orca-side readable,
 *  claude alone: the plugin still works. */
export function agentsEnabled(orcaKeys: string[]): AgentDef[] {
  if (!orcaKeys.length) return [AGENTS[0]!]
  const set = new Set(orcaKeys)
  return AGENTS.filter((a) => a.orcaKeys.some((k) => set.has(k)))
}

/** Whether `<command> --version` answers — installed and runnable. */
export function agentVersion(exec: (program: string, args: string[]) => Promise<{ code: number; stdout: string }>, command: string): Promise<string | null> {
  return exec(command, ['--version'])
    .then((r) => (r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null))
    .catch(() => null)
}
