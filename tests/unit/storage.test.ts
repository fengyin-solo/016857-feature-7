import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CONVERSATIONS_STORAGE_KEY,
  StorageQuotaError,
  isQuotaExceededError,
  loadConversations,
  saveConversations,
} from '../../src/services/storage';
import { createEmptyStoreData } from '../../src/services/conversationSync';
import type { Conversation } from '../../src/types';

function makeConversation(id: string, createdAt: number): Conversation {
  return {
    id,
    title: `title-${id}`,
    messages: [],
    createdAt,
    updatedAt: createdAt,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('storage 配额', () => {
  it('空间不足时抛出 StorageQuotaError，而不是静默丢弃数据', () => {
    const quotaError = new DOMException('Quota exceeded', 'QuotaExceededError');
    const MemoryStorageCtor = (globalThis as unknown as { MemoryStorage: new () => Storage })
      .MemoryStorage;
    const setItemSpy = vi.spyOn(MemoryStorageCtor.prototype, 'setItem');
    // 让所有 setItem 都抛配额错误
    setItemSpy.mockImplementation(() => {
      throw quotaError;
    });

    const data = createEmptyStoreData();
    data.conversations = [makeConversation('A', 100)];

    expect(() => saveConversations(data)).toThrow(StorageQuotaError);
    expect(() => saveConversations(data)).toThrow(/存储空间不足/);
  });

  it('isQuotaExceededError 识别常见浏览器错误', () => {
    expect(isQuotaExceededError(new StorageQuotaError())).toBe(true);
    expect(isQuotaExceededError(new DOMException('x', 'QuotaExceededError'))).toBe(true);
    expect(isQuotaExceededError(new DOMException('x', 'NS_ERROR_DOM_QUOTA_REACHED'))).toBe(true);
    expect(isQuotaExceededError(new Error('other'))).toBe(false);
    expect(isQuotaExceededError(null)).toBe(false);
  });
});

describe('storage 读写与迁移', () => {
  it('写入后可读回，且保持原有排列顺序（不排序）', () => {
    const data = createEmptyStoreData();
    data.conversations = [
      makeConversation('older', 100),
      makeConversation('newer', 500),
      makeConversation('middle', 300),
    ];
    saveConversations(data);

    const loaded = loadConversations();
    expect(loaded.version).toBe(2);
    expect(loaded.conversations.map((c) => c.id)).toEqual(['older', 'newer', 'middle']);
  });

  it('兼容旧版裸数组数据并迁移为 v2 信封', () => {
    const legacy = [
      {
        id: 'A',
        title: 'a',
        messages: [],
        createdAt: 100,
        updatedAt: 200,
      },
    ];
    localStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(legacy));

    const loaded = loadConversations();
    expect(loaded.version).toBe(2);
    expect(loaded.conversations).toHaveLength(1);
    expect(loaded.tombstones).toEqual([]);
    expect(loaded.clearedAt).toBeNull();
  });

  it('坏数据安全降级为空结构', () => {
    localStorage.setItem(CONVERSATIONS_STORAGE_KEY, 'not-json{');
    expect(loadConversations().conversations).toEqual([]);
  });

  it('过滤结构非法的对话记录', () => {
    const data = createEmptyStoreData();
    data.conversations = [
      makeConversation('valid', 1),
      { id: '', title: 'bad', messages: [], createdAt: 1, updatedAt: 1 } as Conversation,
      { not: 'a conversation' } as unknown as Conversation,
    ];
    saveConversations(data);
    expect(loadConversations().conversations.map((c) => c.id)).toEqual(['valid']);
  });

  it('墓碑与 clearedAt 随存取保留', () => {
    const data = createEmptyStoreData();
    data.conversations = [makeConversation('A', 100)];
    data.tombstones = [{ id: 'gone', deletedAt: 50 }];
    data.clearedAt = 10;
    saveConversations(data);

    const loaded = loadConversations();
    expect(loaded.clearedAt).toBe(10);
    expect(loaded.tombstones.map((t) => t.id)).toEqual(['gone']);
  });
});
