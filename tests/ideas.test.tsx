import { expect, mock, test } from 'claude-code/testing'

const CWD = '/proj'
const IDEA = {
  title: 'Requirements tracker',
  description: 'A spreadsheet of every requirement.',
  why: 'So nothing is lost between workshops.',
  buildPrompt: 'Build a requirements tracker from the files in Business Requirement/.',
}
const PANE = {
  plugin: 'feature-ideas',
  component: 'Pane',
  requestId: 'feature-ideas',
  props: { title: 'Feature ideas', isFocused: true, bodyColumns: 80, placement: 'dock' },
} as const

test('saved ideas draw as cards, and Build it submits the build prompt', async ($, on) => {
  mock.store(on, { [`ideas:${CWD}`]: { status: 'ready', ideas: [IDEA], builtTitles: [] } })
  on('session.cwd', () => ({ value: CWD }))
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Requirements tracker/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /nothing is lost/ })).toBeDefined()

    await ui.press({ key: 'build-0' })
    expect(sent.at(-1)).toContain('Business Requirement/')
    await ui.unmount()
  }
  expect(sent.length).toBe(2)
})

test('with no ideas yet the pane offers to suggest some', async ($, on) => {
  mock.store(on)
  on('session.cwd', () => ({ value: CWD }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  await ui.unmount()
})
