// @vitest-environment jsdom
// Regression: 后台子任务运行中的结构化卡片曾被塞进 26px 高的 .tool-calls-panel
// （overflow:hidden），整张卡被裁成一条只有 kicker 的灰条。修复后卡片渲染在
// 面板下方、.streaming-indicator 撑开自适应高度（has-subagent-cards）。
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'

const storeState = reactive({
  messages: [] as any[],
  isRunActive: false,
  abortState: null as any,
  compressionState: null as any,
  activeSessionId: 's1',
  activeSession: { id: 's1', loadedMessageCount: 2, hasMoreBefore: false },
  focusMessageId: null as string | null,
  isLoadingMessages: false,
  isForkPending: false,
  isStreaming: false,
  isAborting: false,
  runStartedAt: new Map<string, number>(),
  sessions: [] as any[],
  queueLengths: new Map<string, number>(),
  isSessionWorking: () => false,
  queueInsertionStates: new Map<string, unknown>(),
  queuedUserMessages: new Map<string, any[]>(),
  activePendingApproval: null as any,
  activePendingClarify: null as any,
  insertQueuedMessage: () => {},
  loadOlderMessages: () => {},
  refreshActiveSession: () => {},
  removeQueuedMessage: () => {},
  respondApproval: () => {},
  respondToClarify: () => {},
  switchSession: () => {},
})

vi.mock('@/stores/hermes/chat', () => ({
  LIVE_CHAT_MAX_LOADED_MESSAGES: 300,
  parseMessageReference: () => null,
  useChatStore: () => storeState,
}))
vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({ activeProfileName: 'default', profiles: [] }),
}))
vi.mock('@/composables/usePageLoading', () => ({ usePageLoadingTask: () => {} }))
vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: true }),
}))
vi.mock('@/utils/hermes/subagent-stream', () => ({
  subagentIdFromToolCall: (id?: string) => (id && id.startsWith('subagent:') ? id.slice('subagent:'.length) : null),
  subagentBatchNumber: () => 1,
  openSubagentStream: () => true,
}))
vi.mock('@/utils/chat-agent-avatar', () => ({
  chatSessionAgentAvatar: () => ({ name: 'Hermes' }),
  personAvatarAnimation: () => null,
  personAvatarStyle: () => ({}),
}))
vi.mock('@/utils/task-plan', () => ({ positionTaskPlansAtTurnEnd: (messages: any[]) => messages }))
vi.mock('@/utils/content-blocks', () => ({
  parseContentBlocks: () => ({ text: '', blocks: [] }),
  blocksQueuePreview: () => null,
}))
vi.mock('@/utils/thinking-parser', () => ({ parseThinking: (content: string) => content }))
vi.mock('@/utils/desktop-bridge', () => ({ desktopBridge: () => null, hasDesktopBrowserBridge: () => false, isDesktopShell: () => false }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  NButton: { name: 'NButton', template: '<button><slot /></button>' },
  NSpin: { name: 'NSpin', template: '<span />' },
  NInput: { name: 'NInput', template: '<input />' },
  NCheckbox: { name: 'NCheckbox', props: ['checked', 'disabled'], emits: ['update:checked'], template: '<input type="checkbox" />' },
  NModal: { name: 'NModal', props: ['show', 'preset', 'type', 'title', 'content', 'positiveText', 'negativeText'], emits: ['update:show', 'positive-click', 'negative-click'], template: '<div v-if="show"><slot /></div>' },
  NDropdown: { name: 'NDropdown', props: ['show', 'x', 'y', 'options'], emits: ['select', 'clickoutside', 'update:show'], template: '<div><slot /></div>' },
  useMessage: () => ({ success: () => {}, error: () => {}, info: () => {}, warning: () => {} }),
}))

vi.mock('@/components/hermes/chat/VirtualMessageList.vue', () => ({
  default: {
    name: 'VirtualMessageList',
    props: ['messages'],
    template: '<div class="vm-list"><div v-for="m in messages" :key="m.id"><slot name="item" :message="m" /></div><slot name="after" /></div>',
    setup() {
      const noop = () => {}
      return {
        isNearBottom: () => true,
        shouldAutoFollowBottom: () => true,
        scrollToBottom: noop,
        scrollToMessage: noop,
        scrollToAnchor: noop,
        captureViewportPosition: () => null,
        restoreViewportPosition: noop,
        captureScrollPosition: () => null,
        restoreScrollPosition: noop,
      }
    },
    expose: ['isNearBottom', 'shouldAutoFollowBottom', 'scrollToBottom', 'scrollToMessage', 'scrollToAnchor', 'captureViewportPosition', 'restoreViewportPosition', 'captureScrollPosition', 'restoreScrollPosition'],
  },
}))
vi.mock('@/components/hermes/chat/MessageItem.vue', () => ({
  default: { name: 'MessageItem', props: ['message'], template: '<div class="message-stub" />' },
}))
vi.mock('@/components/hermes/chat/ToolRunCard.vue', () => ({
  default: { name: 'ToolRunCard', props: ['runId', 'tools'], template: '<div class="tool-run-stub" />' },
}))
vi.mock('@/components/hermes/chat/LiveReasoningStatus.vue', () => ({
  default: { name: 'LiveReasoningStatus', props: ['elapsed'], template: '<div class="live-reasoning-stub" />' },
}))
vi.mock('@/components/hermes/chat/SubagentCard.vue', () => ({
  default: { name: 'SubagentCard', props: ['toolCallId'], template: '<section class="subagent-card"><span class="stub-scid">{{ toolCallId }}</span></section>' },
}))
vi.mock('@/components/hermes/chat/SubagentProgressSummary.vue', () => ({
  default: { name: 'SubagentProgressSummary', template: '<div class="subagent-summary-stub" />' },
}))
vi.mock('@/components/hermes/chat/MessageQueueFloatPanel.vue', () => ({
  default: { name: 'MessageQueueFloatPanel', template: '<div class="queue-stub" />' },
}))
vi.mock('@/components/hermes/chat/PendingInteractionCountdown.vue', () => ({
  default: { name: 'PendingInteractionCountdown', props: ['deadline'], template: '<span />' },
}))
vi.mock('@/components/hermes/person/PersonFlowConversationCard.vue', () => ({
  default: { name: 'PersonFlowConversationCard', props: ['flow'], template: '<div class="person-flow-stub" />' },
}))

import MessageList from '@/components/hermes/chat/MessageList.vue'

function userMsg(id: string) {
  return { id, role: 'user', content: 'hi', timestamp: 1 }
}
function runningTool(id: string, toolCallId: string, toolName: string) {
  return { id, role: 'tool', toolCallId, toolName, toolStatus: 'running', toolPreview: '', timestamp: 2 }
}

function mountList() {
  return mount(MessageList, { props: {} })
}

describe('MessageList live strip: subagent card placement', () => {
  it('运行中的子任务：卡片在面板外（不再被 26px 面板裁切），live 区域标记撑开', () => {
    storeState.messages = [userMsg('u1'), runningTool('t1', 'subagent:abc', 'delegate_task')]
    storeState.isRunActive = true
    const w = mountList()

    const box = w.find('.streaming-indicator')
    expect(box.exists()).toBe(true)
    expect(box.classes()).toContain('has-subagent-cards')

    const card = w.find('.subagent-card')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('subagent:abc')
    // 关键回归：卡片不得位于 26px overflow-hidden 的 .tool-calls-panel 内
    expect(card.element.closest('.tool-calls-panel')).toBeNull()
    // 卡片仍在 live 区域（streaming-indicator）内
    expect(card.element.closest('.streaming-indicator')).not.toBeNull()
    // 没有普通工具时不渲染空的 26px 面板
    expect(w.find('.tool-calls-panel').exists()).toBe(false)
    w.unmount()
  })

  it('运行中的普通工具：仍走紧凑 26px 面板，live 区域不撑开', () => {
    storeState.messages = [userMsg('u1'), runningTool('t2', 'call_1', 'read_file')]
    storeState.isRunActive = true
    const w = mountList()

    const box = w.find('.streaming-indicator')
    expect(box.exists()).toBe(true)
    expect(box.classes()).not.toContain('has-subagent-cards')
    const panel = w.find('.tool-calls-panel')
    expect(panel.exists()).toBe(true)
    expect(panel.find('.tool-call-item').exists()).toBe(true)
    expect(w.find('.subagent-card').exists()).toBe(false)
    w.unmount()
  })

  it('普通工具 + 子任务同时运行：chip 在面板内、卡片在面板外', () => {
    storeState.messages = [
      userMsg('u1'),
      runningTool('t3', 'call_2', 'read_file'),
      runningTool('t4', 'subagent:def', 'delegate_task'),
    ]
    storeState.isRunActive = true
    const w = mountList()

    const panel = w.find('.tool-calls-panel')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain('read_file')
    const card = w.find('.subagent-card')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('subagent:def')
    expect(card.element.closest('.tool-calls-panel')).toBeNull()
    expect(w.find('.streaming-indicator').classes()).toContain('has-subagent-cards')
    w.unmount()
  })
})
