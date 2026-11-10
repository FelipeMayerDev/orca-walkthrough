// One generation is one agent run in the background, in a folder of its own:
// the prompt goes in as files, the answer comes out as a file. Which agent
// runs is the adapter's word (agents.ts); nothing else here knows one CLI from
// another. Nothing ties a run to the panel or the worker that asked — the
// worker may stop while the run goes on — so the next look finds the answer.

import { agentOf, AGENTS, type AgentDef } from './agents'

export { AGENTS, DEFAULT_AGENT, agentOf, modelOf } from './agents'

/** Whether a process's command line is a walkthrough run (its pid file may outlive it, and pids are reused). */
// Matched by flags the run alone passes together: the program itself can show as claude, codex,
// opencode, a versioned binary or node, depending on how each was installed.
export const isRunCommand = (command: string): boolean => {
  const line = String(command)
  for (const agent of AGENTS) {
    if (agent.marks.every((flag) => line.includes(flag))) return true
  }
  return false
}

/**
 * The script a job folder runs: `sh run.sh <model> <seconds>`. A watchdog
 * stops the agent after <seconds>, so a hung run ends even when no one is
 * watching; it checks every few seconds and leaves with the agent.
 */
export function jobScript(agentKey: string): string {
  const agent = agentOf(agentKey)
  return `#!/bin/sh
# One walkthrough generation. Written by the walkthrough plugin for Orca.
cd "$(dirname "$0")" || exit 1
${agent.line(`$1`)} &
pid=$!
echo $pid > pid
( waited=0
  while kill -0 $pid 2>/dev/null; do
    if [ $waited -ge "\${2:-900}" ]; then echo "Stopped after $2 seconds without an answer." >> err.txt; kill $pid; exit 0; fi
    sleep 3; waited=$((waited + 3))
  done ) &
wait $pid
echo $? > code.tmp && mv code.tmp code
`
}

/**
 * What a finished job left: the walkthrough's raw object and its cost, or an
 * error with a message a person can act on.
 */
export function readOutcome(agentKey: string, { out, err, code }: { out: string | null; err: string | null; code: string | null }): { raw: any; cost: number | null } {
  const agent: AgentDef = agentOf(agentKey)
  return agent.read(String(out ?? ''), String(err ?? ''), String(code ?? ''))
}
