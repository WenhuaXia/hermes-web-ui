import { isNativeCodingAgent } from '../../contracts/agents/native-coding-agents'
import {
  getSession,
  getSessionDetailPaginated,
} from '../../repositories/session-store'
import { getRecordedUsageTotals, getUsage } from '../../repositories/usage-store'
import { logger } from '../../public/logging'
import { handleMessage } from './message-format'
import { estimateUsageTokensFromMessages } from './usage'
import { estimateSessionContextTokens } from './context-usage'
import { getSessionContextUsageEstimate } from '../../repositories/session-context-usage'
import type { ChatRunSource, SessionState } from './types'
import { historySessionSource, isBuiltinEkkoAgent } from '../../contracts/history-source'
import { decideDelegationSweep, persistDelegationTerminal } from './background-delegation-terminal'
import { getDelegationSweepRows } from '../../../hermes/services/history/sessions-db'

/** Map a persisted display_content payload to a terminal background-delegation status. */
export function backgroundDelegationTerminalStatus(displayContent: unknown): 'completed' | 'failed' | 'interrupted' | null {
  if (!displayContent) return null
  try {
    const display = typeof displayContent === 'string' ? JSON.parse(displayContent) : (displayContent as Record<string, unknown>)
    const displayStatus = String(display?.status || '').toLowerCase()
    if (displayStatus === 'completed') return 'completed'
    if (displayStatus === 'failed' || displayStatus === 'error') return 'failed'
    if (displayStatus === 'interrupted' || displayStatus === 'cancelled' || displayStatus === 'canceled') return 'interrupted'
  } catch {
    // Non-JSON display content is not a terminal record.
  }
  return null
}

function restoreBackgroundDelegations(messages: any[]): SessionState['backgroundDelegations'] {
  const delegations: NonNullable<SessionState['backgroundDelegations']> = {}
  for (const message of messages) {
    if (message.role !== 'tool' || message.tool_name !== 'delegate_task') continue
    try {
      const payload = JSON.parse(String(message.content || '')) as Record<string, unknown>
      const delegationId = String(payload.delegation_id || '').trim()
      if (payload.runtime === 'ekko' || payload.mode !== 'background' || !delegationId) continue
      let status: 'running' | 'completed' | 'failed' | 'interrupted' = 'running'
      const terminal = backgroundDelegationTerminalStatus(message.display_content)
      if (terminal) status = terminal
      delegations[delegationId] = {
        delegationId,
        status,
        updatedAt: Number(message.timestamp || 0) * 1000 || Date.now(),
        toolCallId: String(message.tool_call_id || '').trim() || undefined,
        messageId: message.id,
        dispatchPayload: payload,
      }
    } catch {
      // Non-JSON delegate results are not background dispatch records.
    }
  }
  return delegations
}

export function resolveRunSource(source?: string, sessionId?: string): ChatRunSource {
  if (source === 'builtin_agent' || source === 'coding_agent' || source === 'global_agent' || source === 'workflow' || source === 'group_chat' || source === 'cli') return source
  if (sessionId) {
    const storedSession = getSession(sessionId)
    const stored = historySessionSource(storedSession || {})
    if (stored === 'builtin_agent' || stored === 'coding_agent' || stored === 'global_agent' || stored === 'workflow' || stored === 'group_chat' || stored === 'cli') return stored
  }
  return 'cli'
}

export async function loadSessionStateFromDb(sid: string, _sessionMap: Map<string, SessionState>): Promise<SessionState> {
  const state = readSessionStateFromDb(sid)
  try {
    await sweepStaleBackgroundDelegations(sid, state)
  } catch (err) {
    logger.warn(err, '[chat-run-socket] stale background delegation sweep failed for session %s', sid)
  }
  return state
}

/**
 * Self-heal on session load: settle subagent cards that still read 'running'
 * although the hermes-side record proves the child is dead (or finished).
 * Without this, a completion that never reached the mirror leaves the card
 * stuck at 'running' forever and aborts can never make it terminal.
 * Best-effort: any failure keeps the restored state unchanged.
 */
async function sweepStaleBackgroundDelegations(sessionId: string, state: SessionState): Promise<void> {
  const items = Object.values(state.backgroundDelegations || {}).filter(
    (item) => (item.status === 'running' || item.status === 'delivering') && item.messageId != null,
  )
  if (items.length === 0) return
  const profile = items.find((item) => item.profile)?.profile || getSession(sessionId)?.profile
  const rows = await getDelegationSweepRows(profile, items.map((item) => item.delegationId))
  const nowMs = Date.now()
  for (const item of items) {
    const row = rows.get(item.delegationId) || null
    const decision = decideDelegationSweep({ row, updatedAtMs: item.updatedAt, nowMs })
    if (decision.decision !== 'terminal') continue
    persistDelegationTerminal(sessionId, state, item.delegationId, decision.status, decision.summary, row?.taskResults)
  }
}

/** Synchronous SQLite hydration keeps cache creation atomic with run admission. */
export function readSessionStateFromDb(sid: string): SessionState {
  try {
    const displayStartedAt = Date.now()
    const actualDetail = getSessionDetailPaginated(sid)

    const messages = actualDetail?.messages ? handleMessage(actualDetail.messages, sid) : []
    const displayElapsedMs = Date.now() - displayStartedAt
    const displayPayload = {
      sessionId: sid,
      rows: actualDetail?.messages.length || 0,
      total: actualDetail?.total || 0,
      elapsedMs: displayElapsedMs,
    }
    logger.info(displayPayload, '[chat-run-socket] display page loaded')
    if (displayElapsedMs > 1_000) logger.warn(displayPayload, '[chat-run-socket] slow display page load')

    let inputTokens: number
    let outputTokens: number
    let contextTokens: number | undefined
    const session = actualDetail?.session || getSession(sid)
    const usageSource = isBuiltinEkkoAgent(session?.agent)
      ? 'ekko_agent'
      : session?.source === 'coding_agent' || ['codex', 'pi', 'grok', 'opencode', 'dsh', 'claude', 'claude-code', 'claude_code', 'cursor', 'antigravity', 'qwen', 'kimi', 'codebuddy', 'qoder', 'copilot', 'zcode'].includes(session?.agent || '')
        ? 'coding_agent'
        : 'hermes'
    const totals = getRecordedUsageTotals(sid, usageSource)
    const latestUsage = getUsage(sid)
    const hasPersistedUsage = !!latestUsage || totals.inputTokens > 0 || totals.outputTokens > 0
    const pageUsage = hasPersistedUsage ? totals : estimateUsageTokensFromMessages(messages)
    inputTokens = hasPersistedUsage ? totals.inputTokens : pageUsage.inputTokens
    outputTokens = hasPersistedUsage ? totals.outputTokens : pageUsage.outputTokens
    // Cursor reports aggregate turn usage, not a current context snapshot.
    if (latestUsage && (!session?.history_cleared_at || latestUsage.created_at > session.history_cleared_at)
      && (session?.agent !== 'cursor' && (session?.agent !== 'antigravity' && !isNativeCodingAgent(session?.agent)))) {
      contextTokens = Number(latestUsage.input_tokens || 0) + Number(latestUsage.output_tokens || 0)
    }
    if (contextTokens == null && usageSource !== 'coding_agent') {
      contextTokens = getSessionContextUsageEstimate(sid)?.tokens ?? estimateSessionContextTokens(sid)
    }

    logger.info('[chat-run-socket] loaded session %s from DB (%d messages)', sid, messages.length)
    return {
      messages,
      messageTotal: actualDetail?.total || messages.length,
      messageLoadedCount: actualDetail?.messages.length || messages.length,
      messagePageLimit: actualDetail?.limit,
      messageStateBaselineCount: messages.length,
      hasMoreBefore: actualDetail?.hasMore || false,
      isWorking: false,
      events: [],
      inputTokens,
      outputTokens,
      cacheReadTokens: totals.cacheReadTokens || 0,
      cacheWriteTokens: totals.cacheWriteTokens || 0,
      contextTokens,
      queue: [],
      backgroundDelegations: restoreBackgroundDelegations(messages),
    }
  } catch (err) {
    logger.warn(err, '[chat-run-socket] failed to load session %s from DB', sid)
    return { messages: [], isWorking: false, events: [], queue: [] }
  }
}
