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

test('suggesting ideas shows the model the git log and the handoff notes', async ($, on) => {
  mock.store(on)
  on('session.cwd', () => ({ value: CWD }))
  on('fs.list', () => ({ value: [{ name: 'README.md', kind: 'file' }] }) as never)
  on('fs.read', ($, e) => {
    if (e.path === `${CWD}/README.md`) return { value: '# Proj' } as never
    if (e.path === `${CWD}/docs/CHAT_HANDOFF.md`) return { value: 'Walk-in renewal: all eight screens built.' } as never
    throw new Error('ENOENT')
  })
  on('process.run', ($, e) => {
    expect(e.argv[0]).toBe('git')
    expect(e.argv[1]).toBe('log')
    return { value: { exitCode: 0, stdout: 'abc1234 2026-10-09 Add VREG renewal screens\n', stderr: '' } } as never
  })
  const prompts: string[] = []
  on('model.complete', ($, e) => {
    prompts.push(e.prompt as string)
    return { value: { isAnswered: true, text: JSON.stringify([IDEA]), usage: {} } } as never
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.unmount()

  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Already done in this project')
  expect(prompts[0]).toContain('Add VREG renewal screens')
  expect(prompts[0]).toContain('all eight screens built')
})
