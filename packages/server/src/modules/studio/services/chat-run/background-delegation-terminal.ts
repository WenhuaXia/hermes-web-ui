/**
 * Terminal-state helpers for Hermes background delegations (subagent cards).
 *
 * A dispatch row's display_content is the card's authoritative terminal record:
 * restoreBackgroundDelegations (load-state.ts) defaults to 'running' when it is absent.
 * Two writers settle running cards to a terminal state:
 *  - abort path (abort.ts): the user stops the session → in-flight delegations settle 'interrupted'
 *  - sweep path (load-state.ts): session load → delegations whose child process is dead settle
 * Late completion reports overwrite these with the real result
 * (persistHermesBackgroundResult writes unconditionally on subagent.complete),
 * so "truth wins": a card settled interrupted by abort/sweep flips to completed
 * if the child actually finished afterwards.
 */
import { updateMessageDisplayContent } from '../../repositories/session-store'
import { logger } from '../../public/logging'
import type { SessionState } from './types'

export type DelegationTerminalStatus = 'completed' | 'failed' | 'interrupted'

/** Row shape returned by getDelegationSweepRows (hermes state.db, read-only). */
export interface DelegationSweepRow {
  state: string | null
  ownerPid: number | null
  dispatchedAt: number | null
  resultStatus: string | null
  resultSummary: string | null
  taskResults?: Array<{ taskIndex?: number; summary?: string | null; status?: string | null }>
}

export function isProcessAlive(pid: number | null | undefined): boolean {
  if (pid == null || !Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Grace for brand-new dispatches whose state.db row may not be flushed yet. */
export const FRESH_DISPATCH_GRACE_MS = 120_000

export type DelegationSweepDecision =
  | { decision: 'keep' }
  | { decision: 'terminal'; status: DelegationTerminalStatus; summary?: string }

/**
 * Pure decision: keep the card running, or settle it terminal.
 * `updatedAtMs` is the dispatch/restore timestamp; `row` is the hermes state.db record.
 */
export function decideDelegationSweep(args: {
  row: DelegationSweepRow | null
  updatedAtMs: number
  nowMs: number
  isAlive?: (pid: number | null) => boolean
}): DelegationSweepDecision {
  const { row, updatedAtMs, nowMs } = args
  const alive = args.isAlive || isProcessAlive
  if (!row) {
    if (nowMs - updatedAtMs < FRESH_DISPATCH_GRACE_MS) return { decision: 'keep' }
    return { decision: 'terminal', status: 'interrupted', summary: '子任务未完成：运行记录已不存在（巡检自动终结）' }
  }
  const state = String(row.state || '').toLowerCase()
  if (state === 'completed') {
    return { decision: 'terminal', status: 'completed', summary: row.resultSummary || undefined }
  }
  if (state === 'failed' || state === 'error') {
    return { decision: 'terminal', status: 'failed', summary: row.resultSummary || undefined }
  }
  if (state === 'interrupted' || state === 'cancelled' || state === 'canceled' || state === 'aborted') {
    return { decision: 'terminal', status: 'interrupted', summary: row.resultSummary || undefined }
  }
  if (state === 'running' || state === 'pending' || state === 'delivering') {
    return alive(row.ownerPid)
      ? { decision: 'keep' }
      : { decision: 'terminal', status: 'interrupted', summary: '子任务未完成：执行进程已不存在（巡检自动终结）' }
  }
  return { decision: 'terminal', status: 'interrupted', summary: '子任务未完成：状态未知（巡检自动终结）' }
}

/**
 * Build the terminal display_content payload for one delegation.
 * Mirrors persistHermesBackgroundResult's shape (single task → flat payload,
 * multiple tasks → { status, tasks[] }) so the client restore branch handles both.
 */
export function buildDelegationTerminalPayload(args: {
  delegationId: string
  dispatchPayload?: Record<string, unknown>
  backgroundTasks?: Record<string, Record<string, unknown> | undefined>
  status: DelegationTerminalStatus
  summary?: string
  /** Per-task results from hermes state.db (completed rows): task_index → real summary/status. */
  taskResults?: Array<{ taskIndex?: number; summary?: string | null; status?: string | null }>
  nowSeconds?: number
}): Record<string, unknown> {
  const { delegationId, status, summary = '' } = args
  const dispatch = args.dispatchPayload || {}
  const dispatchGoals = Array.isArray(dispatch.goals)
    ? dispatch.goals.map((value) => String(value || '').trim()).filter(Boolean)
    : []
  const known = Object.values(args.backgroundTasks || {})
    .filter((task): task is Record<string, unknown> =>
      task != null && String(task.delegation_id || '').trim() === delegationId && task.runtime !== 'ekko')
  const goalFromTasks = known.map((task) => String(task.goal || '').trim()).filter(Boolean)
  const goals = dispatchGoals.length > 0 ? dispatchGoals : goalFromTasks
  const taskCount = Math.max(goals.length, known.length, 1)
  const nowSeconds = args.nowSeconds ?? Date.now() / 1000
  const taskResults = args.taskResults || []
  const tasks = Array.from({ length: taskCount }, (_, taskIndex) => {
    const match = known.find((task) => Number(task.task_index ?? -1) === taskIndex)
      || (known.length === 1 ? known[0] : undefined)
    const startedAt = match?.started_at != null ? Number(match.started_at) : undefined
    const taskResult = taskResults.find((entry) => Number(entry.taskIndex ?? -1) === taskIndex)
      || (taskResults.length === 1 ? taskResults[0] : undefined)
    const taskStatus = status === 'completed' && taskResult?.status
      ? String(taskResult.status) : status
    const taskSummary = taskResult?.summary != null && String(taskResult.summary).trim()
      ? String(taskResult.summary).trim() : summary
    return {
      runtime: 'hermes',
      mode: 'background',
      delegation_id: delegationId,
      subagent_id: String(match?.subagent_id || '').trim() || `${delegationId}:${taskIndex}`,
      task_index: taskIndex,
      task_count: taskCount,
      goal: goals[taskIndex] || '',
      model: match?.model != null ? String(match.model) : undefined,
      status: taskStatus,
      summary: taskSummary,
      output: taskSummary,
      started_at: startedAt,
      completed_at: nowSeconds,
      duration_seconds: Number.isFinite(startedAt) ? Math.max(0, nowSeconds - (startedAt as number)) : undefined,
    }
  })
  return tasks.length === 1 ? { ...tasks[0] } : {
    runtime: 'hermes',
    mode: 'background',
    delegation_id: delegationId,
    status,
    tasks,
  }
}

/**
 * Persist one delegation's terminal state to its dispatch row's display_content
 * and settle the in-memory state (delegation + running tasks).
 */
export function persistDelegationTerminal(
  sessionId: string,
  state: SessionState,
  delegationId: string,
  status: DelegationTerminalStatus,
  summary?: string,
  taskResults?: Array<{ taskIndex?: number; summary?: string | null; status?: string | null }>,
): boolean {
  const item = state.backgroundDelegations?.[delegationId]
  if (!item || item.messageId == null) return false
  const payload = buildDelegationTerminalPayload({
    delegationId,
    dispatchPayload: item.dispatchPayload,
    backgroundTasks: state.backgroundTasks,
    status,
    summary,
    taskResults,
  })
  const displayContent = JSON.stringify(payload)
  const ok = updateMessageDisplayContent(sessionId, item.messageId, displayContent)
  if (!ok) return false
  state.backgroundDelegations = state.backgroundDelegations || {}
  state.backgroundDelegations[delegationId] = { ...item, status, updatedAt: Date.now() }
  for (const [key, task] of Object.entries(state.backgroundTasks || {})) {
    if (task && String(task.delegation_id || '').trim() === delegationId && task.status === 'running') {
      state.backgroundTasks![key] = { ...task, status, completed_at: Date.now() / 1000 }
    }
  }
  logger.info('[background-delegation] persisted %s for %s (session %s)', status, delegationId, sessionId)
  return true
}

/**
 * Settle every in-flight delegation of the session (user abort).
 * Returns the delegation ids actually persisted.
 */
export function persistInterruptedDelegations(
  sessionId: string,
  state: SessionState,
  summary?: string,
): string[] {
  const settled: string[] = []
  for (const item of Object.values(state.backgroundDelegations || {})) {
    if ((item.status === 'running' || item.status === 'delivering') && item.messageId != null) {
      if (persistDelegationTerminal(sessionId, state, item.delegationId, 'interrupted', summary)) {
        settled.push(item.delegationId)
      }
    }
  }
  return settled
}
