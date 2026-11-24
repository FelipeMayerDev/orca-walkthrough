// Matching the focused workspace: `workspace.readContext` names it only by
// display name and branch, while `workspace.list` carries paths.

/** What `workspace.readContext` answers for the focused workspace. */
export type FocusedContext = { workspaceId?: string; branch: string; displayName: string }
type Listed = { id?: string; name: string; path: string; branch: string | null }

const shortBranch = (branch: string | null | undefined): string =>
  (branch ?? '').replace(/^refs\/heads\//, '')

/**
 * Match on Orca's own id first: with Orca on a server, the same repository can
 * be listed once per host under the same name and branch. Then on name and branch, then on the name alone. Null when nothing matches
 * or the match is ambiguous.
 */
export function matchFocused<W extends Listed>(
  context: FocusedContext,
  workspaces: readonly W[]
): W | null {
  if (context.workspaceId) {
    const byId = workspaces.find((workspace) => workspace.id === context.workspaceId)
    if (byId) return byId
  }
  const named = workspaces.filter((workspace) => workspace.name === context.displayName)
  const exact = named.filter(
    (workspace) => shortBranch(workspace.branch) === shortBranch(context.branch)
  )
  if (exact.length === 1) return exact[0] ?? null
  if (exact.length === 0 && named.length === 1) return named[0] ?? null
  return null
}
