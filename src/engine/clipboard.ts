// The clipboard programs need a display to serve a paste from, and the
// worker's environment often lacks one: it is spawned by Orca's daemon, not
// from the person's shell, so XDG_RUNTIME_DIR and WAYLAND_DISPLAY can be
// missing — or pointing somewhere unusable — even though the very session the
// person is sitting at has them. This derives the missing names from the
// machine itself: the caller lists what it found, this decides what to add,
// never overriding a value that already works.

export type Sockets = {
  platform: string
  uid: number | undefined
  env: Record<string, string | undefined>
  /** The user's runtime directory that could actually be listed, and its entries. */
  runtime: { path: string; entries: string[] } | null
  /** Entries of /tmp/.X11-unix, when it could be listed. */
  x11Dir?: string[]
}

/** The display environment the copy command needs and the worker lacks. */
export function displayEnv(input: Sockets): Record<string, string> {
  if (input.platform !== 'linux') return {}
  const add: Record<string, string> = {}
  if (input.runtime && input.runtime.path !== input.env.XDG_RUNTIME_DIR) {
    add.XDG_RUNTIME_DIR = input.runtime.path
  }
  const wayland = input.runtime?.entries.filter((e) => e.startsWith('wayland-')).sort()[0]
  if (wayland) {
    if (!input.env.WAYLAND_DISPLAY) add.WAYLAND_DISPLAY = wayland
  } else if (!input.env.WAYLAND_DISPLAY && !input.env.DISPLAY) {
    // No wayland socket to name: the X display a socket exists for, then.
    const display = input.x11Dir?.find((e) => /^X\d+$/.test(e))
    if (display) add.DISPLAY = `:${display.slice(1)}`
  }
  return add
}
