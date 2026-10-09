import type { EngineInterface, Register } from 'claude-code'

// Suggests three things worth building for the project in the session's folder,
// shown in a pane, each with a Build button that hands the job to Claude.

const PANE = 'feature-ideas'
const MODEL = 'sonnet'
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__', '.DS_Store'])
const TEXT_FILE = /\.(md|txt|json|ya?ml|toml|csv)$/i
const KEY_FILE = /^(readme|claude|agents|package\.json|pyproject\.toml|cargo\.toml|go\.mod)/i
const MAX_ENTRIES = 400
const MAX_FILE_CHARS = 4000
const MAX_FILES_READ = 6

type Idea = { title: string; description: string; why: string; buildPrompt: string }
type Saved = {
  status: 'idle' | 'thinking' | 'ready' | 'error'
  ideas: Idea[]
  error?: string
  builtTitles?: string[]
}

const keyFor = (cwd: string) => `ideas:${cwd}`

async function load($: EngineInterface, cwd: string): Promise<Saved> {
  const saved = (await $.store.get(keyFor(cwd))) as Saved | undefined
  return saved ?? { status: 'idle', ideas: [] }
}

async function save($: EngineInterface, cwd: string, patch: Partial<Saved>) {
  const current = await load($, cwd)
  await $.store.set(keyFor(cwd), { ...current, ...patch })
}

// A snapshot of the project: its file tree two levels deep and the opening
// of a few key text files. Nothing leaves the machine but this, sent to the model.
async function snapshot($: EngineInterface, cwd: string): Promise<string> {
  const lines: string[] = []
  const toRead: string[] = []

  const walk = async (dir: string, depth: number) => {
    if (lines.length >= MAX_ENTRIES) return
    const entries = await $.fs.list(dir).catch(() => [])
    for (const entry of entries) {
      if (SKIP.has(entry.name) || entry.name.startsWith('~$')) continue
      if (lines.length >= MAX_ENTRIES) return
      const path = dir === cwd ? entry.name : `${dir.slice(cwd.length + 1)}/${entry.name}`
      lines.push(`${'  '.repeat(depth)}${entry.name}${entry.kind === 'dir' ? '/' : ''}`)
      if (entry.kind === 'dir' && depth < 1) {
        await walk(`${dir}/${entry.name}`, depth + 1)
      } else if (entry.kind === 'file' && TEXT_FILE.test(entry.name)) {
        if (KEY_FILE.test(entry.name)) toRead.unshift(path)
        else if (depth === 0) toRead.push(path)
      }
    }
  }
  await walk(cwd, 0)

  const files: string[] = []
  for (const path of toRead.slice(0, MAX_FILES_READ)) {
    const text = await $.fs.read(`${cwd}/${path}`).catch(() => '')
    if (text) files.push(`--- ${path} ---\n${text.slice(0, MAX_FILE_CHARS)}`)
  }

  return `Folder: ${cwd}\n\nFiles:\n${lines.join('\n')}\n\n${files.join('\n\n')}`
}

const SYSTEM = `You look at a project folder and suggest the three most valuable things
Claude Code could build in it next. The project may be software, or a folder of
documents for a business, government or consulting programme; fit the ideas to
what is actually there. Each idea must be concrete, buildable in one or a few
Claude Code sessions, and add clear value. Do not suggest things that already exist.

Reply with JSON only, no prose and no code fence:
[{"title": "...", "description": "one or two sentences: what it is",
  "why": "one or two sentences: the value it adds for this project",
  "buildPrompt": "a complete instruction Claude Code can act on to build it, naming the files or folders to start from"}]`

function parseIdeas(text: string): Idea[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error('The reply held no list of ideas.')
  const list = JSON.parse(text.slice(start, end + 1)) as Idea[]
  const ideas = list
    .filter(i => i && i.title && i.description && i.why && i.buildPrompt)
    .slice(0, 3)
  if (ideas.length === 0) throw new Error('The reply held no usable ideas.')
  return ideas
}

async function suggest($: EngineInterface) {
  const cwd = await $.session.cwd()
  const before = await load($, cwd)
  if (before.status === 'thinking') return
  await save($, cwd, { status: 'thinking', error: undefined })

  const context = await snapshot($, cwd)
  const avoid = before.ideas.length
    ? `\n\nSuggest different ideas from these earlier ones: ${before.ideas.map(i => i.title).join('; ')}`
    : ''
  const result = await $.model.complete({
    model: MODEL,
    system: SYSTEM,
    prompt: context + avoid,
    maxTokens: 2000,
    timeoutMs: 120_000,
  })

  if (!result.isAnswered) {
    await save($, cwd, { status: 'error', error: `The model did not answer (${result.reason}).` })
    return
  }
  try {
    await save($, cwd, { status: 'ready', ideas: parseIdeas(result.text), builtTitles: [] })
  } catch (err) {
    await save($, cwd, { status: 'error', error: (err as Error).message })
  }
}

async function build($: EngineInterface, idea: Idea) {
  const cwd = await $.session.cwd()
  const saved = await load($, cwd)
  await save($, cwd, { builtTitles: [...(saved.builtTitles ?? []), idea.title] })
  await $.prompt.submit({
    text: `Build this for the project: ${idea.title}\n\n${idea.buildPrompt}\n\nStart with a short plan, then build it.`,
  })
  $.ui.toast(`Asked Claude to build: ${idea.title}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ideas',
      description: 'Suggest 3 valuable things to build for this project',
    })
    return next(e)
  })

  on('command.run', { command: 'ideas' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Feature ideas' })
    const saved = await load($, await $.session.cwd())
    if (saved.ideas.length === 0 && saved.status !== 'thinking') void suggest($)
    return { text: 'Feature ideas pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const saved = await load($, await $.session.cwd())
    const built = new Set(saved.builtTitles ?? [])

    return (
      <Box flexDirection="column">
        {saved.status === 'thinking' && <Text>Reading your project and thinking up ideas…</Text>}
        {saved.status === 'error' && <Text color="red">Could not get ideas: {saved.error}</Text>}
        {saved.status === 'idle' && saved.ideas.length === 0 && (
          <Text>No ideas yet. Press Suggest ideas to start.</Text>
        )}

        {saved.ideas.map((idea, n) => (
          <Box key={`idea-${n}`} flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
            <Text bold>
              {n + 1}. {idea.title}
            </Text>
            <Text>{idea.description}</Text>
            <Box marginTop={1}>
              <Text>
                <Text bold>Why: </Text>
                {idea.why}
              </Text>
            </Box>
            <Box marginTop={1}>
              <Button
                key={`build-${n}`}
                label={built.has(idea.title) ? 'Sent to Claude ✓' : 'Build it'}
                variant="primary"
                hotkey={String(n + 1)}
                onPress={() => build($, idea)}
              />
            </Box>
          </Box>
        ))}

        <Box marginTop={1}>
          <Button
            key="refresh"
            label={saved.ideas.length ? 'Suggest 3 new ideas' : 'Suggest ideas'}
            hotkey="r"
            onPress={() => suggest($)}
          />
        </Box>
      </Box>
    )
  })
}
