import type { ApiContentBlock, ApiMessage, On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { runsOf } from '../hooks/register'

// MARK: Fixtures

const BASH_ROW = {
  tool_use_id: 'toolu_1',
  tool: 'Bash',
  input: { command: 'cd /Users/arya/repo && grep -rn "needle" packages' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: { stdout: 'a', stderr: '', interrupted: false },
}

const use = (id: string, name = 'Bash') => ({ type: 'tool_use', id, name, input: { command: 'x' } })
const result = (id: string, isError = false) => ({ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'ok' })
const assistant = (...content: ApiContentBlock[]): ApiMessage => ({ role: 'assistant', content })
const user = (...content: ApiContentBlock[]): ApiMessage => ({ role: 'user', content })
const prompt = (text: string) => user({ type: 'text', text })

// Nested Text children read as one line, the way the terminal paints them.
function shown(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''
  const children = (node as { children?: unknown[] }).children ?? []
  return children.map(shown).join('')
}

// The color of every dot in a drawing, left to right.
function dotColors(node: unknown): unknown[] {
  if (typeof node !== 'object' || node === null) return []
  const { type, props, children } = node as { type?: string; props?: { color?: unknown }; children?: unknown[] }
  // Only the leaf Text holding the dot itself, not the Text that wraps the dots.
  const isDot = type === 'Text' && children?.length === 1 && children[0] === '●'
  const own = isDot ? [props?.color] : []
  return [...own, ...(children ?? []).flatMap(dotColors)]
}

// Stands for the host's state beneath the mod: answers the mod's slot reads from `seeded`.
function seedSlots(on: On, seeded: Record<string, unknown>) {
  // A hook beneath the mod answers an event as { value }, the value being what the call resolves to.
  on('state.get', { plugin: 'tool-dots', key: 'slots' }, (_$, e) => ({ value: { value: seeded[String(e.id)], version: 1 } }) as never)
}

async function mountRow(
  $: Engine,
  props: object,
  surface: 'terminal' | 'desktop' = 'terminal',
) {
  return $.ui.mount({
    plugin: 'tool-dots',
    surface,
    component: 'ToolUse',
    props,
    viewport: { columns: 200, rows: 50 },
  } as never)
}

// MARK: runsOf

test('text between calls splits runs', () => {
  const slots = runsOf([
    prompt('go'),
    assistant(use('a'), use('b', 'Read')),
    user(result('a'), result('b')),
    assistant({ type: 'text', text: 'found it' }, use('c')),
    user(result('c')),
  ])
  expect(slots).toEqual({
    a: { members: [{ tool: 'Bash', status: 'done' }, { tool: 'Read', status: 'done' }] },
    b: { leader: 'a' },
    c: { members: [{ tool: 'Bash', status: 'done' }] },
  })
})

test('a tool_result message with reminder text does not split a run', () => {
  const slots = runsOf([
    prompt('go'),
    assistant({ type: 'thinking', thinking: 'hm' }, use('a')),
    user(result('a'), { type: 'text', text: '<system-reminder>todo list changed</system-reminder>' }),
    assistant({ type: 'text', text: '  \n' }, use('b')),
    user(result('b')),
  ])
  expect(slots.b).toEqual({ leader: 'a' })
  expect(slots.a).toEqual({ members: [{ tool: 'Bash', status: 'done' }, { tool: 'Bash', status: 'done' }] })
})

test('a real user prompt splits a run', () => {
  const slots = runsOf([
    assistant(use('a')),
    user(result('a')),
    prompt('and now?'),
    assistant(use('b')),
  ])
  expect(slots.a).toEqual({ members: [{ tool: 'Bash', status: 'done' }] })
  expect(slots.b).toEqual({ members: [{ tool: 'Bash', status: 'running' }] })
})

test('a call is running until its result arrives and errored when the result says so', () => {
  const slots = runsOf([
    assistant(use('a'), use('b'), use('c')),
    user(result('a'), result('b', true)),
  ])
  expect(slots.a).toEqual({
    members: [
      { tool: 'Bash', status: 'done' },
      { tool: 'Bash', status: 'error' },
      { tool: 'Bash', status: 'running' },
    ],
  })
})

// MARK: ToolUse

test('a leader draws its run as dots and per-tool counts', async ($, on) => {
  seedSlots(on, {
    toolu_1: {
      members: [
        { tool: 'Bash', status: 'running' },
        { tool: 'Read', status: 'done' },
        { tool: 'Bash', status: 'done' },
      ],
    },
  })
  const ui = await mountRow($, BASH_ROW)
  const drawn = await ui.drawn()
  expect(shown(drawn)).toBe('●●●tool_call: Bash ×2 · Read ×1')
  expect(dotColors(drawn)).toEqual(['warning', 'success', 'success'])
})

test('a leader marks errored calls and caps long runs', async ($, on) => {
  seedSlots(on, {
    toolu_1: {
      members: Array.from({ length: 30 }, (_, at) => ({ tool: 'mcp__linear__get_issue', status: at === 0 ? 'error' : 'done' })),
    },
  })
  const drawn = await (await mountRow($, BASH_ROW)).drawn()
  expect(dotColors(drawn).length).toBe(24)
  expect(shown(drawn)).toMatch(/\+6tool_call: linear:get_issue ×30 - 1 error$/)
})

test('a follower draws nothing', async ($, on) => {
  seedSlots(on, { toolu_2: { leader: 'toolu_1' } })
  const ui = await mountRow($, { ...BASH_ROW, tool_use_id: 'toolu_2' })
  expect(shown(await ui.drawn())).toBe('')
})

test('a call the index has not reached stays hidden until its run counts it', async $ => {
  const ui = await mountRow($, { ...BASH_ROW, tool_use_id: 'toolu_new', isRunning: true, output: undefined })
  expect(shown(await ui.drawn())).toBe('')
})

// MARK: Index

test('session rows build the index that the rows read back', async ($, on) => {
  // Stands for the session's conversation, which the mod reads after each stored row.
  const messages: object[] = []
  on('session.messages', () => ({ value: messages }) as never)
  const append = (type: 'assistant' | 'user', content: object[], door: string, origin: object) => {
    messages.push({ role: type, content })
    return ($.session as never as { append: (input: unknown) => Promise<unknown> }).append({
      message: { type, role: type, content },
      door,
      origin,
      uuid: crypto.randomUUID(),
    })
  }
  await append('assistant', [use('toolu_1'), use('toolu_2', 'Read')], 'response', { kind: 'model', model: 'm' })
  await append('user', [result('toolu_1')], 'tool-result', { kind: 'tool', tool: 'Bash' })

  const leader = await (await mountRow($, BASH_ROW)).drawn()
  expect(shown(leader)).toBe('●●tool_call: Bash ×1 · Read ×1')
  expect(dotColors(leader)).toEqual(['success', 'warning'])
  expect(shown(await (await mountRow($, { ...BASH_ROW, tool_use_id: 'toolu_2' })).drawn())).toBe('')
})

// MARK: Surfaces

test('leaves a surface that is not the terminal to the engine', async ($, on) => {
  // Stands for what the engine draws at any site the mod passes on.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const ui = await mountRow($, BASH_ROW, 'desktop')
  expect(shown(await ui.drawn())).toBe('engine')
})

test('leaves tool rows to the engine while ctrl+o is open', async ($, on) => {
  seedSlots(on, { toolu_1: { members: [{ tool: 'Bash', status: 'done' }] } })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const mountOn = (component: 'UserMessage' | 'ToolUse' | 'ToolResult', props: object) =>
    $.ui.mount({ plugin: 'tool-dots', surface: 'terminal', component, props, viewport: { columns: 200, rows: 50 } } as never)
  const prompt = { text: 'find the costs', origin: { kind: 'composer' } }

  await mountOn('UserMessage', { ...prompt, isExpanded: true })
  expect(shown(await (await mountOn('ToolUse', BASH_ROW)).drawn())).toBe('engine')

  await mountOn('UserMessage', { ...prompt, isExpanded: false })
  expect(shown(await (await mountOn('ToolUse', BASH_ROW)).drawn())).toMatch(/^●tool_call: Bash/)
})

// MARK: ToolGroup

test('unfolds a group of reads and searches into one row per call', async ($, on) => {
  let isExpanded: boolean | undefined
  // Stands in for the engine beneath the mod, recording what it was asked to draw.
  on('ui.render', { component: 'ToolGroup' }, async ($, e) => {
    isExpanded = e.props.isExpanded
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['engine'] })
  })
  await $.ui.mount({
    plugin: 'tool-dots',
    surface: 'terminal',
    component: 'ToolGroup',
    props: {
      calls: [{ tool: 'Read', input: { file_path: '/a.md' }, isRunning: false, isErrored: false, isInterrupted: false }],
      isActive: false,
      isExpanded: false,
    },
    viewport: { columns: 200, rows: 50 },
  })
  expect(isExpanded).toBe(true)
})

// MARK: ToolResult

test('hides the result block', async $ => {
  const ui = await $.ui.mount({
    plugin: 'tool-dots',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 'toolu_1', tool: 'Bash', output: BASH_ROW.output, isErrored: false },
    viewport: { columns: 200, rows: 50 },
  })
  expect(shown(await ui.drawn())).toBe('')
})
