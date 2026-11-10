// Running programs, the way the engine expects: a program, its arguments and a
// working folder, and back its exit code and what it printed. Every engine
// function takes this `Exec`, so the same code runs in the worker and under tests.

import { execFile, type ExecException } from 'node:child_process'

export type ExecResult = { code: number; stdout: string; stderr: string }
export type ExecOptions = { cwd?: string; /** Additions and overrides over the worker's own environment (git's GIT_INDEX_FILE and friends). */ env?: Record<string, string> }
export type Exec = (program: string, args: string[], options?: ExecOptions) => Promise<ExecResult>

const MAX_BUFFER = 256 * 1024 * 1024

/** The `Exec` the worker uses: git's diff of a big change must fit. Throws when the program isn't there. */
export function run(program: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { cwd: options?.cwd, env: options?.env ? { ...process.env, ...options.env } : undefined, encoding: 'utf8', maxBuffer: MAX_BUFFER }, (error: ExecException | null, stdout: string, stderr: string) => {
      if (error && typeof error.code !== 'number') reject(error)
      else resolve({ code: error ? (error.code as number) : 0, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}
