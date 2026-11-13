import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionState } from '../../packages/server/src/modules/studio/services/chat-run/types'

const updateMessageDisplayContentMock = vi.fn((_sessionId: string, _messageId: number | string, _displayContent: string | null) => true)
const findOrphanRowsMock = vi.fn(() => [] as Array<{ id: number; timestamp: number; delegationId: string; dispatchPayload: Record<string, unknown> }>)
const getDelegationSweepRowsMock = vi.fn(async () => new Map())

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: vi.fn(() => ({ profile: 'default' })),
  getSessionDetailPaginated: vi.fn(() => null),
  findOrphanBackgroundDispatchRows: (...args: unknown[]) => findOrphanRowsMock(...(args as [])),
  updateMessageDisplayContent: (...args: [string, number | string, string | null]) =>
    (updateMessageDisplayContentMock as unknown as (...a: unknown[]) => boolean)(...args),
}))

vi.mock('../../packages/server/src/modules/hermes/services/history/sessions-db', () => ({
  getDelegationSweepRows: (...args: unknown[]) => getDelegationSweepRowsMock(...(args as [])),
}))

const { sweepStaleBackgroundDelegations } = await import(
  '../../packages/server/src/modules/studio/services/chat-run/load-state'
)

function makeState(overrides?: Partial<SessionState>): SessionState {
  return { messages: [], isWorking: false, events: [], queue: [], ...overrides } as SessionState
}

function orphanRow(overrides?: Partial<{ id: number; timestamp: number; delegationId: string; dispatchPayload: Record<string, unknown> }>) {
  return {
    id: 100,
    timestamp: Math.floor(Date.now() / 1000) - 3600,
    delegationId: 'deleg_orphan',
    dispatchPayload: { mode: 'background', delegation_id: 'deleg_orphan', goals: ['孤儿任务'] },
    ...overrides,
  }
}

afterEach(() => {
  vi.resetAllMocks()
  updateMessageDisplayContentMock.mockReturnValue(true)
  findOrphanRowsMock.mockReturnValue([])
  getDelegationSweepRowsMock.mockResolvedValue(new Map())
})

describe('sweepStaleBackgroundDelegations (option C self-heal)', () => {
  it('settles an orphan zombie (no hermes record, stale) to interrupted', async () => {
    findOrphanRowsMock.mockReturnValue([orphanRow()])
    await sweepStaleBackgroundDelegations('sess-1', makeState())
    expect(getDelegationSweepRowsMock).toHaveBeenCalledWith('default', ['deleg_orphan'])
    expect(updateMessageDisplayContentMock).toHaveBeenCalledTimes(1)
    const [sessionId, rowId, displayContent] = updateMessageDisplayContentMock.mock.calls[0]
    expect(sessionId).toBe('sess-1')
    expect(rowId).toBe(100)
    const payload = JSON.parse(String(displayContent))
    expect(payload).toMatchObject({ runtime: 'hermes', delegation_id: 'deleg_orphan', status: 'interrupted' })
    expect(payload.subagent_id).toBe('deleg_orphan:0')
    expect(payload.goal).toBe('孤儿任务')
  })

  it('restores an orphan to completed with the real per-task summary when hermes finished it', async () => {
    findOrphanRowsMock.mockReturnValue([orphanRow()])
    getDelegationSweepRowsMock.mockResolvedValue(new Map([['deleg_orphan', {
      state: 'completed',
      ownerPid: null,
      dispatchedAt: null,
      resultStatus: 'completed',
      resultSummary: '真实结果摘要',
      taskResults: [{ taskIndex: 0, summary: '真实结果摘要', status: 'completed' }],
    }]]))
    await sweepStaleBackgroundDelegations('sess-1', makeState())
    const [, , displayContent] = updateMessageDisplayContentMock.mock.calls[0]
    const payload = JSON.parse(String(displayContent))
    expect(payload.status).toBe('completed')
    expect(payload.summary).toBe('真实结果摘要')
  })

  it('keeps an orphan that is still running with a live owner process', async () => {
    findOrphanRowsMock.mockReturnValue([orphanRow()])
    getDelegationSweepRowsMock.mockResolvedValue(new Map([['deleg_orphan', {
      state: 'running', ownerPid: 1, dispatchedAt: null, resultStatus: null, resultSummary: null,
    }]]))
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    await sweepStaleBackgroundDelegations('sess-1', makeState())
    expect(updateMessageDisplayContentMock).not.toHaveBeenCalled()
  })

  it('settles a restored in-window running delegation via the state payload path', async () => {
    findOrphanRowsMock.mockReturnValue([])
    getDelegationSweepRowsMock.mockResolvedValue(new Map([['deleg_win', {
      state: 'failed', ownerPid: null, dispatchedAt: null, resultStatus: null, resultSummary: null,
    }]]))
    const state = makeState({
      backgroundDelegations: {
        deleg_win: {
          delegationId: 'deleg_win',
          status: 'running',
          updatedAt: Date.now() - 600_000,
          messageId: 55,
          dispatchPayload: { mode: 'background', delegation_id: 'deleg_win', goals: ['窗口内任务'] },
        },
      },
      backgroundTasks: {
        'sa-0-w': { delegation_id: 'deleg_win', subagent_id: 'sa-0-w', task_index: 0, status: 'running' },
      },
    })
    await sweepStaleBackgroundDelegations('sess-1', state)
    expect(updateMessageDisplayContentMock).toHaveBeenCalledWith('sess-1', 55, expect.stringContaining('"subagent_id":"sa-0-w"'))
    expect(state.backgroundDelegations!.deleg_win.status).toBe('failed')
    expect(state.backgroundTasks!['sa-0-w'].status).toBe('failed')
  })

  it('does nothing (no state.db lookup) when there are no running cards and no orphans', async () => {
    await sweepStaleBackgroundDelegations('sess-1', makeState())
    expect(getDelegationSweepRowsMock).not.toHaveBeenCalled()
    expect(updateMessageDisplayContentMock).not.toHaveBeenCalled()
  })

  it('skips orphans already covered by the restored in-window running state', async () => {
    findOrphanRowsMock.mockReturnValue([orphanRow({ delegationId: 'deleg_dup', dispatchPayload: { mode: 'background', delegation_id: 'deleg_dup' } })])
    const state = makeState({
      backgroundDelegations: {
        deleg_dup: { delegationId: 'deleg_dup', status: 'running', updatedAt: Date.now() - 600_000, messageId: 77 },
      },
    })
    await sweepStaleBackgroundDelegations('sess-1', state)
    // The orphan (same delegation id, outside the window) is deduped; only the
    // restored item is queried and settled once.
    expect(getDelegationSweepRowsMock).toHaveBeenCalledWith('default', ['deleg_dup'])
    expect(updateMessageDisplayContentMock).toHaveBeenCalledTimes(1)
    expect(updateMessageDisplayContentMock.mock.calls[0][1]).toBe(77)
  })
})
