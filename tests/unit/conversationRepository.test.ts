import { describe, it, expect, beforeEach } from 'vitest'
import fc from 'fast-check'
import type { Conversation } from '@/types'
import {
  MAX_CONVERSATIONS,
  applyCapacityLimit,
  commitClearAll,
  commitConversations,
  commitDeletions,
  emptyEnvelope,
  isDeleted,
  mergeEnvelopes,
  mergeForCommit,
  readEnvelope,
  subscribeRemoteChanges,
  writeEnvelope,
  type ConversationEnvelope,
} from '@/services/conversationRepository'

function makeConv(
  id: string,
  createdAt: number,
  updatedAt: number = createdAt,
  extra: Partial<Conversation> = {}
): Conversation {
  return {
    id,
    title: `对话-${id}`,
    messages: [],
    createdAt,
    updatedAt,
    ...extra,
  }
}

function envelope(conversations: Conversation[], extra: Partial<ConversationEnvelope> = {}) {
  return { ...emptyEnvelope(), conversations, ...extra }
}

beforeEach(() => {
  localStorage.clear()
})

describe('readEnvelope / 旧数据迁移', () => {
  it('无数据时返回空信封', () => {
    const env = readEnvelope()
    expect(env.conversations).toEqual([])
    expect(env.tombstones).toEqual({})
    expect(env.clearedAt).toBeNull()
  })

  it('兼容旧版本裸数组，且保留其原始顺序（不重排）', () => {
    const c1 = makeConv('a', 100, 999)
    const c2 = makeConv('b', 200, 100)
    const c3 = makeConv('c', 300, 500)
    // 旧实现落盘前会按 updatedAt 排序，这里故意以乱序写入
    localStorage.setItem('react-chat-conversations', JSON.stringify([c1, c2, c3]))

    const env = readEnvelope()
    expect(env.conversations.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('过滤结构无效的记录', () => {
    localStorage.setItem(
      'react-chat-conversations',
      JSON.stringify([makeConv('ok', 1), { id: 'bad' }, null, 'x'])
    )
    expect(readEnvelope().conversations.map((c) => c.id)).toEqual(['ok'])
  })

  it('损坏的 JSON 返回空信封而不是抛错', () => {
    localStorage.setItem('react-chat-conversations', '{not json')
    expect(readEnvelope().conversations).toEqual([])
  })
})

describe('commitConversations', () => {
  it('写入后可读回，且不重排当前顺序', () => {
    const convs = [makeConv('a', 300), makeConv('b', 100), makeConv('c', 200)]
    commitConversations(envelope(convs))

    expect(readEnvelope().conversations.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('与磁盘上其他标签页的新增记录合并，不整体覆盖', () => {
    // 标签页 A 写入 a,b
    commitConversations(envelope([makeConv('a', 100), makeConv('b', 200)]))

    // 标签页 B（模拟只看到 a 的旧快照）写入 a,c
    const localB = envelope([makeConv('a', 100, 500), makeConv('c', 300)])
    commitConversations(localB)

    const stored = readEnvelope().conversations.map((c) => c.id)
    // b 不被 B 的旧快照顶掉
    expect(stored).toContain('b')
    expect(stored).toContain('c')
    expect(new Set(stored).size).toBe(stored.length)
  })

  it('同一 id 记录取 updatedAt 较新者，且不改写任何字段', () => {
    commitConversations(envelope([makeConv('a', 100, 100, { title: '旧标题' })]))

    const newer = makeConv('a', 100, 200, { title: '新标题' })
    commitConversations(envelope([newer]))

    const stored = readEnvelope().conversations[0]
    expect(stored?.title).toBe('新标题')
    expect(stored?.createdAt).toBe(100) // createdAt 永不被改动
    expect(stored?.updatedAt).toBe(200)
  })

  it('容量不足（配额）时抛出原始错误且不丢已有数据', () => {
    commitConversations(envelope([makeConv('existing', 1)]))

    mockLocalStorage.__setQuota(200) // 200 字节，无法再写入完整信封

    expect(() => commitConversations(envelope([makeConv('new', 2)]))).toThrow()
    // 原有数据仍在
    expect(readEnvelope().conversations.map((c) => c.id)).toEqual(['existing'])
  })
})

describe('条数上限淘汰', () => {
  it('超过 MAX_CONVERSATIONS 时淘汰 createdAt 最旧的记录', () => {
    const convs: Conversation[] = []
    for (let i = 0; i < MAX_CONVERSATIONS + 3; i++) {
      convs.push(makeConv(`c${String(i).padStart(4, '0')}`, 1000 + i))
    }
    const result = commitConversations(envelope(convs))

    expect(result.evicted.map((c) => c.id)).toEqual(['c0000', 'c0001', 'c0002'])
    expect(readEnvelope().conversations).toHaveLength(MAX_CONVERSATIONS)
    expect(result.envelope.conversations[0]?.id).toBe('c0003')
    expect(result.envelope.conversations.at(-1)?.id).toBe(`c${String(MAX_CONVERSATIONS + 2).padStart(4, '0')}`)
  })

  it('淘汰会写入墓碑，被淘汰记录不会被旧快照合并回来', () => {
    const many = Array.from({ length: MAX_CONVERSATIONS + 1 }, (_, i) =>
      makeConv(`c${i}`, 1000 + i)
    )
    commitConversations(envelope(many))
    const stored = readEnvelope()
    expect(stored.tombstones).toHaveProperty('c0')

    // 旧快照仍包含 c0，再次提交
    const staleLocal = envelope(many, {
      tombstones: {},
      clearedAt: null,
    })
    commitConversations(staleLocal)
    expect(readEnvelope().conversations.map((c) => c.id)).not.toContain('c0')
  })

  it('未超限时 applyCapacityLimit 不改动顺序', () => {
    const convs = [makeConv('a', 3), makeConv('b', 1), makeConv('c', 2)]
    const { kept, evicted } = applyCapacityLimit(envelope(convs))
    expect(evicted).toEqual([])
    expect(kept.conversations.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('删除与清空（墓碑）', () => {
  it('删除记录写入墓碑，记录从列表消失', () => {
    commitConversations(envelope([makeConv('a', 1), makeConv('b', 2)]))
    const next = commitDeletions(readEnvelope(), ['a'])

    expect(next.conversations.map((c) => c.id)).toEqual(['b'])
    expect(next.tombstones).toHaveProperty('a')
    expect(readEnvelope().conversations.map((c) => c.id)).toEqual(['b'])
  })

  it('其他标签页基于旧快照提交时，已删除记录不会复活', () => {
    const a = makeConv('a', 1)
    const b = makeConv('b', 2)
    commitConversations(envelope([a, b]))
    commitDeletions(readEnvelope(), ['a'])

    // 另一标签页的旧状态：仍有 a，且新增了 c
    const staleLocal = envelope([a, makeConv('c', 3)], { tombstones: {}, clearedAt: null })
    commitConversations(staleLocal)

    const ids = readEnvelope().conversations.map((c) => c.id)
    expect(ids).not.toContain('a')
    expect(ids).toContain('b') // 本页的数据没被顶掉
    expect(ids).toContain('c')
  })

  it('清空写入 clearedAt，早于该标记的记录即使来自旧快照也不复活', async () => {
    const old = makeConv('old', 1000)
    commitConversations(envelope([old]))

    // 等待确保 createdAt 严格小于 clearedAt
    await new Promise((r) => setTimeout(r, 2))
    const cleared = commitClearAll(readEnvelope())
    expect(cleared.conversations).toEqual([])
    expect(cleared.clearedAt).not.toBeNull()

    // 另一标签页用清空前的旧快照提交
    commitConversations(envelope([old], { tombstones: {}, clearedAt: null }))
    expect(readEnvelope().conversations).toEqual([])
  })

  it('清空后新建的对话不受 clearedAt 影响', async () => {
    commitConversations(envelope([makeConv('old', 1000)]))
    await new Promise((r) => setTimeout(r, 2))
    commitClearAll(readEnvelope())
    await new Promise((r) => setTimeout(r, 2))

    const fresh = makeConv('fresh', Date.now())
    commitConversations(envelope([fresh]))
    const ids = readEnvelope().conversations.map((c) => c.id)
    expect(ids).toEqual(['fresh'])
  })

  it('isDeleted 同时识别墓碑与清空标记', () => {
    const conv = makeConv('a', 100)
    expect(isDeleted(conv, envelope([], { tombstones: { a: 1 }, clearedAt: null }))).toBe(true)
    expect(isDeleted(conv, envelope([], { tombstones: {}, clearedAt: 100 }))).toBe(true)
    expect(isDeleted(conv, envelope([], { tombstones: {}, clearedAt: 50 }))).toBe(false)
  })
})

describe('顺序稳定性（刷新后/返回后排列保持原样）', () => {
  it('mergeEnvelopes 被动同步时以磁盘顺序为准，新本地记录排最前', () => {
    const remote = envelope([makeConv('a', 1), makeConv('b', 2), makeConv('c', 3)])
    // 本页内存顺序被 sort 过（c 在最前），另有一个本地新建 d
    const local = envelope(
      [makeConv('c', 3, 9), makeConv('a', 1, 1), makeConv('b', 2, 2), makeConv('d', 4)],
      { tombstones: {}, clearedAt: null }
    )

    const merged = mergeEnvelopes(local, remote)
    // 已持久化记录保持磁盘顺序 a,b,c；d 是未持久化的新记录
    expect(merged.conversations.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('mergeForCommit 本地提交时以本地顺序为准', () => {
    const remote = envelope([makeConv('a', 1), makeConv('b', 2)])
    const local = envelope([makeConv('b', 2, 99), makeConv('a', 1, 1), makeConv('d', 4)])

    const merged = mergeForCommit(local, remote)
    expect(merged.conversations.map((c) => c.id)).toEqual(['b', 'a', 'd'])
  })
})

describe('跨标签页 storage 事件', () => {
  it('其他标签页写入时收到事件，本页写入不触发', () => {
    const events: ConversationEnvelope[] = []
    const unsub = subscribeRemoteChanges(({ envelope: env }) => events.push(env))

    writeEnvelope(envelope([makeConv('a', 1)])) // 本页：不触发
    expect(events).toHaveLength(0)

    mockLocalStorage.__otherTabSetItem(
      'react-chat-conversations',
      JSON.stringify(envelope([makeConv('b', 2)]))
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.conversations[0]?.id).toBe('b')

    unsub()
    mockLocalStorage.__otherTabSetItem(
      'react-chat-conversations',
      JSON.stringify(envelope([makeConv('c', 3)]))
    )
    expect(events).toHaveLength(1)
  })

  it('忽略无法解析或结构不对的内容', () => {
    const events: unknown[] = []
    subscribeRemoteChanges((e) => events.push(e))

    mockLocalStorage.__otherTabSetItem('react-chat-conversations', '{bad json')
    mockLocalStorage.__otherTabSetItem(
      'react-chat-conversations',
      JSON.stringify([makeConv('a', 1)])
    )
    expect(events).toHaveLength(0)
  })
})

// 属性测试：合并结果的顺序与内容不变量
describe('property: merge invariants', () => {
  const convArb = fc
    .array(
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 3 }).filter((s) => /^[a-z0-9]+$/.test(s)),
        createdAt: fc.integer({ min: 1, max: 1000 }),
        updatedAt: fc.integer({ min: 1, max: 1000 }),
      }),
      { maxLength: 8 }
    )
    .map((items) => {
      const seen = new Set<string>()
      return items
        .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
        .map((item) => makeConv(item.id, item.createdAt, item.updatedAt))
    })

  it('合并不产生重复 id，且存活记录是两边的并集', () => {
    fc.assert(
      fc.property(convArb, convArb, (a, b) => {
        const merged = mergeEnvelopes(envelope(a), envelope(b))
        const ids = merged.conversations.map((c) => c.id)
        expect(new Set(ids).size).toBe(ids.length)

        const expected = new Set([...a.map((c) => c.id), ...b.map((c) => c.id)])
        expect(new Set(ids)).toEqual(expected)
      })
    )
  })

  it('合并是幂等的：merge(a, merge(a,b)) 按 id 一致', () => {
    fc.assert(
      fc.property(convArb, convArb, (a, b) => {
        const once = mergeEnvelopes(envelope(a), envelope(b))
        const twice = mergeEnvelopes(envelope(a), once)
        expect(twice.conversations.map((c) => c.id).sort()).toEqual(
          once.conversations.map((c) => c.id).sort()
        )
      })
    )
  })
})
