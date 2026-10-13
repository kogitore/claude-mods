export type RunMember = { tool: string; status: 'running' | 'done' | 'error' }

// A run's first call holds the whole run; every later call only points at it.
export type RunSlot = { leader: string } | { members: RunMember[] }

declare module 'claude-code' {
  interface PluginState {
    'tool-dots': { slots: StateFamily<RunSlot> }
  }
}
