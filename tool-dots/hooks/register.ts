import { read } from 'claude-code'
import type { ApiMessage, EngineInterface, Register } from 'claude-code'

import type { RunMember, RunSlot } from '../types'

// MARK: Layout

// Past this many calls the dots stop and a dim "+n" says how many are left, so a long run stays on one row.
const MAX_DOTS = 24

// MARK: Runs

// A tool_result block whose is_error is set marks its call errored; no block yet means still running.
function statusOf(result: boolean | undefined): RunMember['status'] {
  return result === undefined ? 'running' : result ? 'error' : 'done'
}

// Splits the conversation into runs of consecutive tool calls and answers the slot of every call.
// Text from the model and a real prompt from the person end a run. A tool_result message never does:
// its reminder text is the engine's, not something said between calls. Thinking blocks are skipped.
export function runsOf(messages: ApiMessage[]): Record<string, RunSlot> {
  const errored = new Map<string, boolean>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result') errored.set(String(block.tool_use_id), block.is_error === true)
    }
  }

  const slots: Record<string, RunSlot> = {}
  let leader: string | undefined
  let members: RunMember[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      if (!message.content.some(block => block.type === 'tool_result')) leader = undefined
      continue
    }
    for (const block of message.content) {
      if (block.type === 'text' && String(block.text ?? '').trim() !== '') leader = undefined
      if (block.type !== 'tool_use') continue
      const id = String(block.id)
      const member: RunMember = { tool: String(block.name), status: statusOf(errored.get(id)) }
      if (leader === undefined) {
        leader = id
        members = [member]
        slots[id] = { members }
      } else {
        members.push(member)
        slots[id] = { leader }
      }
    }
  }
  return slots
}

// MARK: Line

// The three keys follow the person's theme: warning is its yellow, success its green, error its red.
const STATUS_COLOR = { running: 'warning', done: 'success', error: 'error' } as const

// An MCP tool is "mcp__server__tool", too long for a count list; "server:tool" keeps both halves.
function nameOf(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  return mcp ? `${mcp[1]}:${mcp[2]}` : tool
}

// Counts follow the order each tool first appears in the run.
function countsOf(members: RunMember[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const member of members) {
    const name = nameOf(member.tool)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

// MARK: Index

const slotRef = { plugin: 'tool-dots', key: 'slots' } as const
// What each call's slot was last written as, so a refresh writes only the slots that changed.
const written = new Map<string, string>()
let isRefreshing = false
let isStale = false

// A row can't see its neighbours, so the index is built from the conversation and kept in state;
// a write redraws exactly the rows that read that call's slot.
async function refresh($: EngineInterface): Promise<void> {
  // A refresh already under way reads the conversation again before it ends, so this one folds into it.
  if (isRefreshing) {
    isStale = true
    return
  }
  isRefreshing = true
  try {
    do {
      isStale = false
      const messages = await $.session.messages({ as: 'api' })
      if (!Array.isArray(messages)) return
      for (const [id, slot] of Object.entries(runsOf(messages))) {
        const json = JSON.stringify(slot)
        if (written.get(id) === json) continue
        await $.state.set({ ...slotRef, id }, slot)
        written.set(id, json)
      }
    } while (isStale)
  } finally {
    isRefreshing = false
  }
}

// MARK: View

// Tool rows don't say whether the ctrl+o transcript (or --verbose) is open, but the person's own
// prompt rows do; their flag is mirrored here so every tool site leaves that view to the engine.
let isExpandedView = false

function isCompact(surface: string): boolean {
  return surface === 'terminal' && !isExpandedView
}

// MARK: Hooks

export const register: Register = on => {
  // The conversation is stored once next resolves, so the index is read after it. A failed refresh
  // must not cost the row its append: the handler replays what next settled, and the next row refreshes again.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined) await refresh($)
    return stored
  }).catch(($, e, next) => next(e))

  // A resumed session already holds calls.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refresh($)
    return started
  })

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'composer' } } }, async ($, e, next) => {
    if (e.surface === 'terminal' && e.props.isExpanded !== isExpandedView) {
      isExpandedView = e.props.isExpanded
      // Tool rows keep their last answer until asked again, so the switch has to redraw them.
      $.ui.invalidate('ui.render')
    }
    if (!isCompact(e.surface)) return next(e)
    const { Box } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', marginBottom: 1, children: [await next(e)] })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!isCompact(e.surface)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    // Reading the slot subscribes this row: a later write to it draws the row again.
    const slot = await read($, { ...slotRef, id: e.props.tool_use_id })
    // A follower's call is already counted in its run's line. A call the index has not reached yet
    // stays hidden too: drawn alone it would push the transcript down, then fold back up a moment
    // later, so only the run's count moves.
    if (slot === undefined || 'leader' in slot) return Box({})
    const members = slot.members

    const dots = members.slice(0, MAX_DOTS).map(member => Text({ color: STATUS_COLOR[member.status], children: ['●'] }))
    if (members.length > MAX_DOTS) dots.push(Text({ dimColor: true, children: [`+${members.length - MAX_DOTS}`] }))
    const counts = [...countsOf(members)].flatMap(([name, count], at) => [
      ...(at === 0 ? [] : [Text({ dimColor: true, children: [' · '] })]),
      Text({ bold: true, children: [name] }),
      ` ×${count}`,
    ])
    const errors = members.filter(member => member.status === 'error').length

    return Box({
      flexDirection: 'row',
      marginLeft: 2,
      children: [
        // The dots' own column keeps wrapped rows aligned under the text, as the engine's tool rows do.
        Box({ flexShrink: 0, marginRight: 1, children: [Text({ children: dots })] }),
        Box({
          flexShrink: 1,
          children: [
            Text({
              wrap: 'wrap',
              children: [
                Text({ dimColor: true, children: ['tool_call: '] }),
                ...counts,
                ...(errors === 0 ? [] : [Text({ color: 'error', children: [` - ${errors} error${errors === 1 ? '' : 's'}`] })]),
              ],
            }),
          ],
        }),
      ],
    })
  })

  // Unfolding hands each grouped read or search to the ToolUse hook, so it flows like every other call.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!isCompact(e.surface)) return next(e)
    return next({ ...e, props: { ...e.props, isExpanded: true } })
  })

  // The compact line already carries what the result block would say.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!isCompact(e.surface)) return next(e)
    const { Box } = $.ui.resolve(e)
    return Box({})
  })
}
