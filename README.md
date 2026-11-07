# Walkthrough for Orca

A port of [herdr-walkthrough](https://github.com/dmazlum/herdr-walkthrough) as an
[Orca](https://github.com/stablyai/orca) plugin: **read a diff in the order it makes
sense.** Instead of listing files alphabetically, Claude groups the diff's hunks into
steps, orders them so each builds on the last, and explains each one with its code
alongside. It explains; it does not judge.

Open the **Walkthrough** panel in Orca's right sidebar, pick what to read —
uncommitted work, the staged part, the branch, one commit, or a pull request — and
press **Generate**. Navigate with `j`/`k`, mark steps read with `x`, see what no step
covers at the end.

## What it does

- **Readable structure** — related edits across files become one step; types and entry
  points come before the code that uses them; tests sit with the code they prove.
  Steps are grouped into parts; **Key change** flags the critical ones, **Context** the
  skimmable ones.
- **Notes, only where they earn their place** — a note states something the reader
  signs up for by accepting the change, and nothing more: Decisions, Upkeep,
  Limitations, Divergences, Untested aspects. Most steps have none.
- **Coverage honesty** — edits no step explains are listed under **Not covered**;
  lockfiles and generated files are listed but not analyzed.
- **Task matching** — the diff is matched against what was asked: the prompts sent to
  Claude Code agents while the change was made (read from local transcripts), a pull
  request's description, a commit's message, or your own words. Each request is marked
  ✓ carried out, ◐ partly, ○ not in this diff.
- **Staleness** — steps are tied to exact code; when an agent keeps editing, steps mark
  themselves **outdated**. Read marks (`x`) persist across sessions, per repository.
- **Sharing** — **Copy** puts the whole walkthrough on the clipboard as Markdown,
  bounded by `<!-- walkthrough -->` comments so it can be pasted into a PR description
  and later told apart from the task.

## Scopes

Uncommitted, Staged, Unstaged, Branch (everything this branch adds to its base,
committed or not), one Commit, or a Pull request (through the GitHub CLI, `gh`).

## How it works

One generation is one `claude -p` run with no tools, no MCP servers and no session
persistence — the model reads a digest of the diff (every reviewable hunk in full,
under short aliases `h1, h2, …`) and answers with a single JSON object that is
normalized against the digest: an alias that isn't there is dropped, never drawn as a
step pointing at nothing. Lockfiles and generated files are kept out of what the model
reads but never out of what you see.

- Results are cached by everything that decides them (the code, model, language,
  preferences, task) — putting the working tree back the way it was brings the earlier
  walkthrough back free.
- A run goes on in the background even with the panel closed; the next look finds the
  answer. A watchdog stops a hung run.
- Diffs over roughly 175k tokens are refused rather than truncated, because a
  walkthrough of half a diff reads as confidently as one of the whole.
- Nothing is sent to the model until you press Generate.

Data lives under `~/.local/share/orca/walkthrough/` (entries, pointers, jobs, read
marks).

## Settings

In Orca's Settings → Plugins → Walkthrough:

- **Model** — Haiku (default, fast and cheap), Sonnet or Opus.
- **Language** — the language the walkthrough is written in (prose only; code
  identifiers stay as they are).
- **Preferences** — your own wishes for every walkthrough, added to every prompt.

## Development

```sh
npm install
npm run types       # writes .orca/types (Orca plugin typings)
npm run typecheck
npm test            # orca plugin test .
orca plugin dev watch .
```

`orca` is `orca-ide` on Linux. `dev watch` loads the folder into Orca as a development
plugin and reloads on save; the first load needs an access approval it prints.

## License

MIT, like the original herdr-walkthrough by dmazlum.
