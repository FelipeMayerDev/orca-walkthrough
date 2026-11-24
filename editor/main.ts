// The walkthrough tab: the file it opens names a change (repository, scope,
// agent, model, language); the reader draws that change's walkthrough wide.
// The file is never edited.

import { el } from '../panel/render'
import { mountReader, openReader, type WalkFile } from './reader'

const page = document.getElementById('page') as HTMLElement
mountReader({
  rail: document.getElementById('rail') as HTMLElement,
  bar: document.getElementById('bar') as HTMLElement,
  page,
  announcer: document.getElementById('announce') as HTMLElement,
})

async function load(): Promise<void> {
  try {
    const doc = await orca.document!.get()
    const text = doc.content.kind === 'text' ? doc.content.text : new TextDecoder().decode(doc.content.bytes)
    const file = JSON.parse(text) as WalkFile
    if (!file?.top || !file.source) throw new Error('not a walkthrough file')
    await openReader(file)
  } catch (e) {
    page.replaceChildren(el('div', { class: 'empty' },
      el('h1', { text: 'This file does not name a walkthrough' }),
      el('p', { text: `Open walkthroughs from the Walkthrough panel. (${e instanceof Error ? e.message : String(e)})` })))
  }
}

orca.document?.onDidChange(() => { void load() })
void load()
