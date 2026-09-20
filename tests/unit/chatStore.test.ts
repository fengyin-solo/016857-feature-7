import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { StoreApi, UseBoundStore } from 'zustand'
import type { Conversation } from '@/types'
import type { ChatStore } from '@/stores/chatStore'
import {
  MAX_CONVERSATIONS,
  readEnvelope,
  writeEnvelope,
  emptyEnvelope,
} from '@/services/conversationRepository'

let useChatStore: UseBoundStore<StoreApi<ChatStore>>

function makeConv(id: string, createdAt: number, updatedAt = createdAt): Conversation {
  return { id, title: `对话-${id}`, messages: [], createdAt, updatedAt }
}

/** 重置模块（隔离 store 闭包内“已提醒淘汰”标记）并重新初始化 */
async function reinit() {
  vi.resetModules()
  const mod = await import('@/stores/chatStore')
  useChatStore = mod.useChatStore
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    isStreaming: false,
    streamingContent: '',
    streamingMessageId: null,
    initialized: false,
    saveFailure: null,
    evictionNotice: null,
  })
  useChatStore.getState().initConversations()
}

beforeEach(async () => {
  localStorage.clear()
  await reinit()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('初始化与顺序', () => {
  it('加载时保留磁盘顺序，不按时间重排', async () => {
    writeEnvelope({
      ...emptyEnvelope(),
      conversations: [makeConv('x', 300), makeConv('y', 100), makeConv('z', 200)],
    })
    await reinit()

    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['x', 'y', 'z'])
    expect(useChatStore.getState().activeConversationId).toBe('x')
  })

  it('空存储初始化后活动对话为 null', async () => {
    expect(useChatStore.getState().conversations).toEqual([])
    expect(useChatStore.getState().activeConversationId).toBeNull()
  })
})

describe('条数上限淘汰', () => {
  it('新建超过上限时淘汰最旧记录，并提醒一次（通知内容为最新一次淘汰）', async () => {
    // 预置上限减 1 条
    const seed = Array.from({ length: MAX_CONVERSATIONS - 1 }, (_, i) =>
      makeConv(`seed-${i}`, 1000 + i)
    )
    writeEnvelope({ ...emptyEnvelope(), conversations: seed })
    await reinit()

    // 第一次超限：新建 2 条 → 淘汰 seed-0
    useChatStore.getState().createConversation('新对话1')
    useChatStore.getState().createConversation('新对话2')

    const state = useChatStore.getState()
    expect(state.conversations).toHaveLength(MAX_CONVERSATIONS)
    expect(state.conversations.map((c) => c.id)).not.toContain('seed-0')
    expect(state.evictionNotice).not.toBeNull()
    expect(state.evictionNotice?.titles).toEqual(['对话-seed-0'])

    // 通知未关闭期间继续超限：同一条通知更新为最新淘汰内容，不重复堆叠
    const firstNoticeAt = state.evictionNotice?.at
    useChatStore.getState().createConversation('新对话3')
    const state2 = useChatStore.getState()
    expect(state2.conversations).toHaveLength(MAX_CONVERSATIONS)
    expect(state2.evictionNotice?.titles).toEqual(['对话-seed-1'])
    expect(state2.evictionNotice?.at).toBeGreaterThanOrEqual(firstNoticeAt!)
  })

  it('关闭通知后再次达到上限会重新提醒', async () => {
    const seed = Array.from({ length: MAX_CONVERSATIONS }, (_, i) => makeConv(`s-${i}`, i + 1))
    writeEnvelope({ ...emptyEnvelope(), conversations: seed })
    await reinit()

    useChatStore.getState().createConversation('new')
    expect(useChatStore.getState().evictionNotice).not.toBeNull()
    useChatStore.getState().clearEvictionNotice()
    expect(useChatStore.getState().evictionNotice).toBeNull()

    // 下一次淘汰事件再次提醒
    useChatStore.getState().createConversation('new2')
    expect(useChatStore.getState().evictionNotice).not.toBeNull()
    expect(useChatStore.getState().evictionNotice?.titles).toEqual(['对话-s-1'])
  })
})

describe('容量不足：明确告知 + 重新提交', () => {
  it('保存时配额不足，设置 saveFailure 且不丢已有数据', async () => {
    useChatStore.getState().createConversation('已有对话')
    expect(useChatStore.getState().saveFailure).toBeNull()

    mockLocalStorage.__setQuota(50)

    useChatStore.getState().createConversation('保存不进去的对话')

    const state = useChatStore.getState()
    expect(state.saveFailure).not.toBeNull()
    expect(state.saveFailure?.error).toContain('存储空间不足')
    expect(state.saveFailure?.error).toContain('没有保存成功')

    // 磁盘上仍只有第一条
    expect(readEnvelope().conversations).toHaveLength(1)
  })

  it('retrySave 释放配额后成功，失败标记清除', async () => {
    useChatStore.getState().createConversation('第一条')
    mockLocalStorage.__setQuota(50)
    useChatStore.getState().createConversation('第二条')
    expect(useChatStore.getState().saveFailure).not.toBeNull()

    mockLocalStorage.__setQuota(null)
    const ok = useChatStore.getState().retrySave()

    expect(ok).toBe(true)
    expect(useChatStore.getState().saveFailure).toBeNull()
    expect(readEnvelope().conversations).toHaveLength(2)
  })

  it('retrySave 仍失败时保留失败标记并更新提示', async () => {
    useChatStore.getState().createConversation('第一条')
    mockLocalStorage.__setQuota(50)
    useChatStore.getState().createConversation('第二条')

    const ok = useChatStore.getState().retrySave()
    expect(ok).toBe(false)
    expect(useChatStore.getState().saveFailure).not.toBeNull()
    expect(useChatStore.getState().saveFailure?.error).toContain('还是没有保存成功')
  })
})

describe('删除与清空', () => {
  it('删除对话后从列表与磁盘同时消失，删除当前对话时自动切换', async () => {
    useChatStore.getState().createConversation('a')
    useChatStore.getState().createConversation('b')
    const activeId = useChatStore.getState().activeConversationId

    useChatStore.getState().deleteConversation(activeId!)

    const state = useChatStore.getState()
    expect(state.conversations).toHaveLength(1)
    expect(state.activeConversationId).not.toBe(activeId)
    expect(readEnvelope().conversations).toHaveLength(1)
    expect(Object.keys(readEnvelope().tombstones)).toHaveLength(1)
  })

  it('清空后列表为空并写入 clearedAt', async () => {
    useChatStore.getState().createConversation('a')
    useChatStore.getState().createConversation('b')

    useChatStore.getState().clearAllConversations()

    expect(useChatStore.getState().conversations).toEqual([])
    expect(useChatStore.getState().activeConversationId).toBeNull()
    expect(readEnvelope().conversations).toEqual([])
    expect(readEnvelope().clearedAt).not.toBeNull()
  })
})

describe('已有记录不可改动', () => {
  it('addMessage 只在新对话首条用户消息时生成标题；旧对话标题与 createdAt 不变', async () => {
    const old = makeConv('old', 1000, 1000)
    old.title = '原始标题'
    old.messages = [
      { id: 'm1', role: 'user', content: '你好', timestamp: 1000, status: 'complete' },
    ]
    writeEnvelope({ ...emptyEnvelope(), conversations: [old] })
    await reinit()

    useChatStore
      .getState()
      .addMessage('old', { role: 'user', content: '这是第二条用户消息' })

    const stored = useChatStore.getState().conversations.find((c) => c.id === 'old')
    expect(stored?.title).toBe('原始标题')
    expect(stored?.createdAt).toBe(1000)
    expect(stored?.messages).toHaveLength(2)
  })
})

describe('多标签页同步（storage 事件）', () => {
  it('另一标签页新建对话后，本页列表同步出现', async () => {
    const remote = {
      ...emptyEnvelope(),
      conversations: [makeConv('remote-1', Date.now())],
    }
    mockLocalStorage.__otherTabSetItem('react-chat-conversations', JSON.stringify(remote))

    const ids = useChatStore.getState().conversations.map((c) => c.id)
    expect(ids).toContain('remote-1')
  })

  it('另一标签页删除记录后，本页同步移除', async () => {
    const a = makeConv('a', 1)
    const b = makeConv('b', 2)
    writeEnvelope({ ...emptyEnvelope(), conversations: [a, b] })
    await reinit()
    expect(useChatStore.getState().conversations).toHaveLength(2)

    // 另一标签页删除 a（带墓碑的信封）
    const remote = {
      ...emptyEnvelope(),
      conversations: [b],
      tombstones: { a: Date.now() },
    }
    mockLocalStorage.__otherTabSetItem('react-chat-conversations', JSON.stringify(remote))

    const ids = useChatStore.getState().conversations.map((c) => c.id)
    expect(ids).toEqual(['b'])
  })

  it('另一标签页清空后，本页列表同步清空', async () => {
    const old = makeConv('a', 1000)
    writeEnvelope({ ...emptyEnvelope(), conversations: [old] })
    await reinit()

    await new Promise((r) => setTimeout(r, 2))
    const remote = { ...emptyEnvelope(), conversations: [], clearedAt: Date.now() }
    mockLocalStorage.__otherTabSetItem('react-chat-conversations', JSON.stringify(remote))

    expect(useChatStore.getState().conversations).toEqual([])
  })

  it('本页正在流式输出时暂缓合并，流结束后不被远端事件破坏状态', async () => {
    useChatStore.getState().createConversation('streaming')
    const id = useChatStore.getState().activeConversationId!
    useChatStore.getState().startStreaming(id)

    const remote = { ...emptyEnvelope(), conversations: [makeConv('remote-x', 999)] }
    mockLocalStorage.__otherTabSetItem('react-chat-conversations', JSON.stringify(remote))

    // 流式期间不同步
    expect(useChatStore.getState().conversations.map((c) => c.id)).not.toContain('remote-x')
    expect(useChatStore.getState().isStreaming).toBe(true)
  })

  it('当前活动对话在另一标签页被删除时，本页自动切到剩余第一条', async () => {
    writeEnvelope({
      ...emptyEnvelope(),
      conversations: [makeConv('a', 1), makeConv('b', 2)],
    })
    await reinit()
    useChatStore.getState().setActiveConversation('a')

    const remote = {
      ...emptyEnvelope(),
      conversations: [makeConv('b', 2)],
      tombstones: { a: Date.now() },
    }
    mockLocalStorage.__otherTabSetItem('react-chat-conversations', JSON.stringify(remote))

    expect(useChatStore.getState().activeConversationId).toBe('b')
  })
})
