import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildDelegationTerminalPayload,
  decideDelegationSweep,
  FRESH_DISPATCH_GRACE_MS,
  persistDelegationTerminal,
} from '../../packages/server/src/modules/studio/services/chat-run/background-delegation-terminal'
import type { SessionState } from '../../packages/server/src/modules/studio/services/chat-run/types'

const updateMessageDisplayContentMock = vi.fn(() => true)

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  updateMessageDisplayContent: (...args: unknown[]) => updateMessageDisplayContentMock(...(args as [])),
}))

function makeState(overrides?: Partial<SessionState>): SessionState {
  return {
    messages: [],
    isWorking: false,
    events: [],
    queue: [],
    ...overrides,
  } as SessionState
}

afterEach(() => {
  updateMessageDisplayContentMock.mockReset()
  updateMessageDisplayContentMock.mockReturnValue(true)
})

describe('decideDelegationSweep', () => {
  const nowMs = Date.now()

  it('keeps a fresh dispatch whose state.db row is not flushed yet', () => {
    const decision = decideDelegationSweep({
      row: null,
      updatedAtMs: nowMs - 5_000,
      nowMs,
    })
    expect(decision).toEqual({ decision: 'keep' })
  })

  it('settles interrupted when the hermes record is gone after the grace window', () => {
    const decision = decideDelegationSweep({
      row: null,
      updatedAtMs: nowMs - FRESH_DISPATCH_GRACE_MS - 10_000,
      nowMs,
    })
    expect(decision).toMatchObject({ decision: 'terminal', status: 'interrupted' })
  })

  it('keeps running when the state.db row is running and the owner process is alive', () => {
    const decision = decideDelegationSweep({
      row: { state: 'running', ownerPid: 1, dispatchedAt: nowMs / 1000, resultStatus: null, resultSummary: null },
      updatedAtMs: nowMs - 600_000,
      nowMs,
      isAlive: () => true,
    })
    expect(decision).toEqual({ decision: 'keep' })
  })

  it('settles interrupted when the state.db row is running but the owner process is dead', () => {
    const decision = decideDelegationSweep({
      row: { state: 'running', ownerPid: 999_999, dispatchedAt: nowMs / 1000, resultStatus: null, resultSummary: null },
      updatedAtMs: nowMs - 600_000,
      nowMs,
      isAlive: () => false,
    })
    expect(decision).toMatchObject({ decision: 'terminal', status: 'interrupted' })
  })

  it('restores completed with the real summary when the hermes record finished', () => {
    const decision = decideDelegationSweep({
      row: { state: 'completed', ownerPid: null, dispatchedAt: null, resultStatus: 'completed', resultSummary: '实际结果摘要' },
      updatedAtMs: nowMs - 600_000,
      nowMs,
    })
    expect(decision).toMatchObject({ decision: 'terminal', status: 'completed', summary: '实际结果摘要' })
  })

  it('settles failed for failed hermes records', () => {
    const decision = decideDelegationSweep({
      row: { state: 'failed', ownerPid: null, dispatchedAt: null, resultStatus: null, resultSummary: null },
      updatedAtMs: nowMs - 600_000,
      nowMs,
    })
    expect(decision).toMatchObject({ decision: 'terminal', status: 'failed' })
  })

  it('settles interrupted for unknown hermes states', () => {
    const decision = decideDelegationSweep({
      row: { state: 'weird-state', ownerPid: null, dispatchedAt: null, resultStatus: null, resultSummary: null },
      updatedAtMs: nowMs - 600_000,
      nowMs,
    })
    expect(decision).toMatchObject({ decision: 'terminal', status: 'interrupted' })
  })
})

describe('buildDelegationTerminalPayload', () => {
  it('builds a flat payload for a single-task delegation with subagent_id fallback', () => {
    const payload = buildDelegationTerminalPayload({
      delegationId: 'deleg_test',
      dispatchPayload: { goals: ['任务甲'] },
      backgroundTasks: {},
      status: 'interrupted',
      summary: '已中止',
      nowSeconds: 1000,
    })
    expect(payload).toMatchObject({
      runtime: 'hermes',
      mode: 'background',
      delegation_id: 'deleg_test',
      subagent_id: 'deleg_test:0',
      task_index: 0,
      task_count: 1,
      goal: '任务甲',
      status: 'interrupted',
      summary: '已中止',
    })
  })

  it('uses the known subagent_id and started_at from background tasks', () => {
    const payload = buildDelegationTerminalPayload({
      delegationId: 'deleg_test',
      dispatchPayload: { goals: ['任务甲'] },
      backgroundTasks: {
        'sa-0-abc': {
          delegation_id: 'deleg_test',
          subagent_id: 'sa-0-abc',
          task_index: 0,
          goal: '任务甲',
          started_at: 900,
          model: 'test-model',
        },
      },
      status: 'interrupted',
      summary: '已中止',
      nowSeconds: 1000,
    })
    expect(payload).toMatchObject({
      subagent_id: 'sa-0-abc',
      started_at: 900,
      duration_seconds: 100,
      model: 'test-model',
    })
  })

  it('builds tasks[] for multi-task delegations and prefers per-task results for completed', () => {
    const payload = buildDelegationTerminalPayload({
      delegationId: 'deleg_multi',
      dispatchPayload: { goals: ['任务甲', '任务乙'] },
      backgroundTasks: {},
      status: 'completed',
      summary: '兜底摘要',
      taskResults: [
        { taskIndex: 0, summary: '甲的结果', status: 'completed' },
        { taskIndex: 1, summary: '乙的结果', status: 'completed' },
      ],
      nowSeconds: 1000,
    })
    expect(payload).toMatchObject({ delegation_id: 'deleg_multi', status: 'completed' })
    const tasks = payload.tasks as Array<Record<string, unknown>>
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toMatchObject({ task_index: 0, goal: '任务甲', summary: '甲的结果', status: 'completed' })
    expect(tasks[1]).toMatchObject({ task_index: 1, goal: '任务乙', summary: '乙的结果' })
    expect(tasks[0].subagent_id).toBe('deleg_multi:0')
  })
})

describe('persistDelegationTerminal', () => {
  it('writes terminal display_content and settles in-memory state', () => {
    const state = makeState({
      backgroundDelegations: {
        deleg_1: {
          delegationId: 'deleg_1',
          status: 'running',
          updatedAt: 1,
          messageId: 42,
          dispatchPayload: { goals: ['任务甲'] },
        },
      },
      backgroundTasks: {
        'sa-0-x': { delegation_id: 'deleg_1', subagent_id: 'sa-0-x', task_index: 0, status: 'running' },
      },
    })
    const ok = persistDelegationTerminal('sess-1', state, 'deleg_1', 'interrupted', '已中止')
    expect(ok).toBe(true)
    expect(updateMessageDisplayContentMock).toHaveBeenCalledWith('sess-1', 42, expect.stringContaining('"status":"interrupted"'))
    expect(state.backgroundDelegations!.deleg_1.status).toBe('interrupted')
    expect(state.backgroundTasks!['sa-0-x'].status).toBe('interrupted')
  })

  it('does nothing when the delegation has no dispatch message id', () => {
    const state = makeState({
      backgroundDelegations: {
        deleg_2: { delegationId: 'deleg_2', status: 'running', updatedAt: 1 },
      },
    })
    const ok = persistDelegationTerminal('sess-1', state, 'deleg_2', 'interrupted', '已中止')
    expect(ok).toBe(false)
    expect(updateMessageDisplayContentMock).not.toHaveBeenCalled()
    expect(state.backgroundDelegations!.deleg_2.status).toBe('running')
  })
})
