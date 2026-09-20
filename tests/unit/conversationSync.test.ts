import { describe, it, expect } from 'vitest';
import type { Conversation, ConversationStoreData, Message } from '../../src/types';
import {
  MAX_CONVERSATIONS,
  applyConversationLimit,
  createEmptyStoreData,
  mergeConversationData,
  mergeConversationLists,
  mergeMessage,
  mergeMessages,
  pruneTombstones,
} from '../../src/services/conversationSync';

function makeMessage(overrides: Partial<Message> & { id: string }): Message {
  return {
    role: 'user',
    content: 'content',
    timestamp: 1000,
    status: 'complete',
    ...overrides,
  };
}

function makeConversation(
  overrides: Partial<Conversation> & { id: string },
): Conversation {
  return {
    title: `title-${overrides.id}`,
    messages: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeStore(conversations: Conversation[] = []): ConversationStoreData {
  return { ...createEmptyStoreData(), conversations };
}

describe('mergeMessage', () => {
  it('终态内容不被流式版本覆盖', () => {
    const complete = makeMessage({ id: 'm1', status: 'complete', content: '最终内容' });
    const streaming = makeMessage({ id: 'm1', status: 'streaming', content: '流' });
    expect(mergeMessage(complete, streaming)).toBe(complete);
    expect(mergeMessage(streaming, complete)).toBe(complete);
  });

  it('同等级时保留内容更完整的一方', () => {
    const a = makeMessage({ id: 'm1', status: 'complete', content: '短' });
    const b = makeMessage({ id: 'm1', status: 'complete', content: '更长的最终内容' });
    expect(mergeMessage(a, b)).toBe(b);
    expect(mergeMessage(b, a)).toBe(b);
  });

  it('错误态不会把已完成态改回去', () => {
    const complete = makeMessage({ id: 'm1', status: 'complete', content: 'ok' });
    const pending = makeMessage({ id: 'm1', status: 'pending', content: '' });
    expect(mergeMessage(complete, pending)).toBe(complete);
  });
});

describe('mergeMessages', () => {
  it('按 id 合并且不改变已有消息顺序', () => {
    const m1 = makeMessage({ id: 'a', timestamp: 100 });
    const m2 = makeMessage({ id: 'b', timestamp: 200, content: '旧' });
    const incoming = [
      makeMessage({ id: 'b', timestamp: 200, content: '新的最终内容' }),
      makeMessage({ id: 'c', timestamp: 150 }),
    ];
    const merged = mergeMessages([m1, m2], incoming);
    expect(merged.map((m) => m.id)).toEqual(['a', 'c', 'b']);
    // 已知消息保持位置，新消息按时间戳插入
    expect(merged[2]?.content).toBe('新的最终内容');
  });
});

describe('mergeConversationLists', () => {
  it('已有对话保持原相对位置，未知对话按创建时间降序插入', () => {
    // 应用内新建总是前插，故本地顺序天然按 createdAt 降序：B(200) 在 A(100) 前
    const local = [
      makeConversation({ id: 'B', createdAt: 200 }),
      makeConversation({ id: 'A', createdAt: 100 }),
    ];
    const remote = [
      makeConversation({ id: 'C', createdAt: 300 }),
      makeConversation({ id: 'D', createdAt: 150 }),
    ];
    const merged = mergeConversationLists(local, remote);
    // B 仍在 A 前（本地相对位置不变），整体按创建时间降序
    expect(merged.map((c) => c.id)).toEqual(['C', 'B', 'D', 'A']);
  });

  it('已有对话的标题与创建时间不被改动', () => {
    const local = makeConversation({ id: 'A', title: '我的标题', createdAt: 100 });
    const remote = makeConversation({ id: 'A', title: '被改的标题', createdAt: 50 });
    const merged = mergeConversationLists([local], [remote]);
    expect(merged[0]?.title).toBe('我的标题');
    expect(merged[0]?.createdAt).toBe(50); // 取更早值，不会变晚
  });

  it('消息做追加式合并，不产生重复消息', () => {
    const local = makeConversation({
      id: 'A',
      messages: [makeMessage({ id: 'm1', timestamp: 1 })],
    });
    const remote = makeConversation({
      id: 'A',
      messages: [
        makeMessage({ id: 'm1', timestamp: 1 }),
        makeMessage({ id: 'm2', timestamp: 2 }),
      ],
    });
    const merged = mergeConversationLists([local], [remote]);
    expect(merged[0]?.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

describe('mergeConversationData —— 删除/清空同步', () => {
  it('一方删除（墓碑）后，另一方的旧数据不会把它复活', () => {
    const local = makeStore([makeConversation({ id: 'A' })]);
    const remote = makeStore([
      makeConversation({ id: 'A' }),
      makeConversation({ id: 'B' }),
    ]);
    remote.tombstones = [{ id: 'A', deletedAt: 2000 }];

    const merged = mergeConversationData(local, remote);
    expect(merged.conversations.map((c) => c.id)).toEqual(['B']);
    expect(merged.tombstones.map((t) => t.id)).toContain('A');

    // 再来一轮：A 仍然不能复活（墓碑在双方并集中）
    const localAgain = makeStore([makeConversation({ id: 'A' })]);
    localAgain.tombstones = merged.tombstones;
    const mergedAgain = mergeConversationData(localAgain, merged);
    expect(mergedAgain.conversations.map((c) => c.id)).toEqual(['B']);
  });

  it('一方清空后，早于 clearedAt 创建的对话都被移除，新对话保留', () => {
    const local = makeStore([
      makeConversation({ id: 'old1', createdAt: 100 }),
      makeConversation({ id: 'old2', createdAt: 200 }),
    ]);
    const remote: ConversationStoreData = {
      ...makeStore([
        makeConversation({ id: 'old1', createdAt: 100 }),
        makeConversation({ id: 'new', createdAt: 2000 }),
      ]),
      clearedAt: 1000,
    };
    const merged = mergeConversationData(local, remote);
    expect(merged.conversations.map((c) => c.id)).toEqual(['new']);
    expect(merged.clearedAt).toBe(1000);
  });

  it('双方各删各的，墓碑取并集', () => {
    const local = makeStore([makeConversation({ id: 'B' })]);
    local.tombstones = [{ id: 'A', deletedAt: 100 }];
    const remote = makeStore([makeConversation({ id: 'A' })]);
    remote.tombstones = [{ id: 'B', deletedAt: 100 }];

    const merged = mergeConversationData(local, remote);
    expect(merged.conversations).toEqual([]);
    expect(merged.tombstones.map((t) => t.id).sort()).toEqual(['A', 'B']);
  });
});

describe('applyConversationLimit', () => {
  it('未超上限时不淘汰', () => {
    const data = makeStore([makeConversation({ id: 'A' })]);
    const { data: result, evicted } = applyConversationLimit(data, { limit: 10 });
    expect(evicted).toEqual([]);
    expect(result.conversations.map((c) => c.id)).toEqual(['A']);
  });

  it('超上限时按创建时间淘汰最旧的，并写入墓碑', () => {
    const convs = [
      makeConversation({ id: 'newest', createdAt: 300 }),
      makeConversation({ id: 'oldest', createdAt: 100 }),
      makeConversation({ id: 'middle', createdAt: 200 }),
    ];
    const { data, evicted } = applyConversationLimit(makeStore(convs), { limit: 2 });
    expect(evicted.map((c) => c.id)).toEqual(['oldest']);
    expect(data.conversations.map((c) => c.id)).toEqual(['newest', 'middle']);
    expect(data.tombstones.map((t) => t.id)).toEqual(['oldest']);
  });

  it('受保护与流式中的对话不被淘汰', () => {
    const convs = [
      makeConversation({ id: 'new', createdAt: 300 }),
      makeConversation({
        id: 'streaming-old',
        createdAt: 100,
        messages: [makeMessage({ id: 's', status: 'streaming', content: '' })],
      }),
      makeConversation({ id: 'mid', createdAt: 200 }),
    ];
    const { data } = applyConversationLimit(makeStore(convs), {
      limit: 2,
      protectedIds: ['streaming-old'],
    });
    expect(data.conversations.map((c) => c.id).sort()).toEqual(['new', 'streaming-old']);
  });

  it('默认上限为 100 条', () => {
    expect(MAX_CONVERSATIONS).toBe(100);
  });
});

describe('pruneTombstones', () => {
  it('过滤掉结构非法的墓碑', () => {
    const result = pruneTombstones([
      { id: 'ok', deletedAt: 1000 },
      { id: 'bad' } as unknown as ConversationStoreData['tombstones'][number],
      { deletedAt: 1 } as ConversationStoreData['tombstones'][number],
    ]);
    expect(result.map((t) => t.id)).toEqual(['ok']);
  });

  it('超过数量上限时保留最新删除的若干条', () => {
    const tombstones = Array.from({ length: 600 }, (_, i) => ({
      id: `t${i}`,
      deletedAt: 1_000_000 - i,
    }));
    const result = pruneTombstones(tombstones);
    expect(result).toHaveLength(500);
    expect(result[0]?.id).toBe('t0');
  });
});
