// Pure DOM builders the panel draws with. No `orca` here: nothing in this
// module talks to the worker, only to the document.

import type { HunkLines, HunkRef } from '../src/protocol'

/** A tiny element builder: el('div', {class: 'x', onclick: fn}, ...children). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue
    if (name === 'class') node.className = String(value)
    else if (name === 'text') node.textContent = String(value)
    else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value as EventListener)
    else node.setAttribute(name, String(value))
  }
  for (const child of children) {
    if (child === null || child === undefined) continue
    node.append(child instanceof Node ? child : String(child))
  }
  return node
}

export const short = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/** A step's hunks → one entry per file, in order of appearance. */
export function filesOf(refs: HunkRef[]): { path: string; added: number; deleted: number }[] {
  const by = new Map<string, { path: string; added: number; deleted: number }>()
  for (const ref of refs) {
    const t = by.get(ref.path) ?? { path: ref.path, added: 0, deleted: 0 }
    t.added += ref.added
    t.deleted += ref.deleted
    by.set(ref.path, t)
  }
  return [...by.values()]
}

/**
 * Hunk refs → code grouped by file: a card per file naming it and what moved,
 * and inside, one labelled excerpt per hunk — the lines it covers, the
 * function it sits in, what it added and removed. With `perFile` false (the
 * Not covered rows, which already name the file) only the excerpts are drawn.
 */
export function buildHunkBlocks(refs: HunkRef[], lookup: (id: string) => HunkLines | undefined, perFile = true): HTMLElement[] {
  const groups: { path: string; status: string; hunks: HunkRef[] }[] = []
  for (const ref of refs) {
    const last = groups[groups.length - 1]
    if (last && last.path === ref.path) last.hunks.push(ref)
    else groups.push({ path: ref.path, status: ref.status, hunks: [ref] })
  }
  const blocks: HTMLElement[] = []
  groups.forEach((group, index) => {
    const parts: HTMLElement[] = []
    let previous: HunkLines | null = null
    for (const ref of group.hunks) {
      const hunk = lookup(ref.id)
      if (previous && hunk) {
        const skipped = hunk.newStart - (previous.newStart + countOf(previous))
        if (skipped > 1) parts.push(el('div', { class: 'gap-line', text: `⋯ ${skipped} line${skipped === 1 ? '' : 's'} skipped` }))
      }
      previous = hunk ?? previous
      parts.push(el('div', { class: 'hunk' },
        el('div', { class: 'hunk-head' },
          el('span', { class: 'range', text: rangeOf(hunk) }),
          hunk?.context ? el('span', { class: 'dim', text: short(hunk.context, 60) }) : null,
          el('span', { class: 'count' }, el('span', { class: 'a', text: `+${ref.added}` }), ' ', el('span', { class: 'd', text: `−${ref.deleted}` }))),
        hunk ? linesPre(hunk) : el('pre', {}, el('div', { class: 'ln' }, el('span', { class: 'no' }), el('span', { class: 'tx', text: '(hunk not available)' })))))
    }
    if (perFile) {
      const totals = group.hunks.reduce((t, h) => ({ a: t.a + h.added, d: t.d + h.deleted }), { a: 0, d: 0 })
      // `data-file` names the card so a step's file chip can scroll to it.
      blocks.push(el('div', { class: 'code', 'data-file': String(index) },
        el('div', { class: 'code-head' },
          el('span', { class: 'path', text: group.path }),
          el('span', { text: group.status !== 'modified' ? group.status : '' }),
          el('span', { class: 'dim', text: `${group.hunks.length} excerpt${group.hunks.length === 1 ? '' : 's'}` }),
          el('span', { class: 'count' }, el('span', { class: 'a', text: `+${totals.a}` }), ' ', el('span', { class: 'd', text: `−${totals.d}` }))),
        ...parts))
    } else blocks.push(...parts)
  })
  return blocks
}

/** Which lines of the new file the hunk covers: `lines 42–58`, or `line 42`. */
export const rangeOf = (hunk: HunkLines | undefined): string => {
  if (!hunk) return ''
  const span = countOf(hunk)
  return span <= 1 ? `line ${hunk.newStart}` : `lines ${hunk.newStart}–${hunk.newStart + span - 1}`
}
/** How many lines the hunk leaves in the new file: its context and added lines. */
export const countOf = (hunk: HunkLines): number => hunk.lines.filter((l) => l[0] !== '-').length

/** A hunk's lines, drawn: old numbers on removed lines, new on the rest. */
export function linesPre(hunk: HunkLines): HTMLElement {
  const pre = el('pre')
  let old = hunk.oldStart, next = hunk.newStart
  for (const line of hunk.lines) {
    const kind = line[0]
    if (kind === '+') { pre.append(lineRow('plus', next++, line.slice(1))); continue }
    if (kind === '-') { pre.append(lineRow('minus', old++, line.slice(1))); continue }
    if (kind === '\\') { pre.append(lineRow('meta', undefined, line)); continue }
    old++
    pre.append(lineRow(undefined, next++, line.slice(1) || ' '))
  }
  return pre
}

export function lineRow(kind: string | undefined, number: number | undefined, text: string): HTMLElement {
  return el('div', { class: `ln${kind ? ` ${kind}` : ''}` },
    el('span', { class: 'no', text: number === undefined ? '' : String(number) }),
    el('span', { class: 'tx', text }))
}

// ── icons ─────────────────────────────────────────────────────────────────
//
// One drawing language for the panel's buttons: 24px grid, 2px round stroke,
// currentColor so the theme and each state color them. Two weights with
// roles — the run states (play, stop) are solid, to read strongly on the
// primary button; the utilities (copy, refresh, settings) are stroked, to
// stay quiet beside them. Paths in the Feather tradition (MIT).

const ICONS: Record<string, { body: string; solid?: boolean }> = {
  play: { body: '<path d="M7 4.5v15l12-7.5z"/>', solid: true },
  stop: { body: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>', solid: true },
  refresh: { body: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/>' },
  copy: { body: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' },
  settings: {
    body: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1.5 14h5"/><path d="M9.5 8h5"/><path d="M17.5 16h5"/>',
  },
}

/** One of the panel's icons, drawn to size. */
export function icon(name: keyof typeof ICONS, size = 15): SVGSVGElement {
  const entry = ICONS[name]
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('aria-hidden', 'true')
  if (entry.solid) {
    svg.setAttribute('fill', 'currentColor')
    svg.innerHTML = entry.body
  } else {
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.innerHTML = entry.body
  }
  return svg
}
