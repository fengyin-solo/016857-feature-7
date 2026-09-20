import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore, __resetStorageListenerForTests } from '../../src/stores/chatStore';
import { CONVERSATIONS_STORAGE_KEY } from '../../src/services/storage';
import { MAX_CONVERSATIONS } from '../../src/services/conversationSync';
import { bindNotifier } from '../../src/services/notifier';
import type { ConversationStoreData } from '../../src/types';

// 捕获 store 层发出的提示
const notices: Array<{ type: string; content: string }> = [];
bindNotifier({
  info: (c) => notices.push({ type: 'info', content: c }),
  success: (c) => notices.push({ type: 'success', content: c }),
  warning: (c) => notices.push({ type: 'warning', content: c }),
  error: (c) => notices.push({ type: 'error', content: c }),
});

/** 读取持久化的信封 */
function readStore(): ConversationStoreData {
  return JSON.parse(localStorage.getItem(CONVERSATIONS_STORAGE_KEY)!) as ConversationStoreData;
}

/** 让 localStorage.setItem 抛出配额错误 */
function mockQuotaExceeded() {
  const MemoryStorageCtor = (globalThis as unknown as { MemoryStorage: new () => Storage })
    .MemoryStorage;
  vi.spyOn(MemoryStorageCtor.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota', 'QuotaExceededError');
  });
}

/** 模拟另一个标签页写入并广播 storage 事件 */
function emitRemoteChange(data: ConversationStoreData) {
  localStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(data));
  const addSpy = window.addEventListener as ReturnType<typeof vi.fn>;
  const handler = addSpy.mock.calls
    .filter(([event]) => event === 'storage')
    .map(([, fn]) => fn as (e: StorageEvent) => void)
    .at(-1)!;
  expect(handler).toBeTypeOf('function');
  handler({
    key: CONVERSATIONS_STORAGE_KEY,
    newValue: JSON.stringify(data),
  } as StorageEvent);
}

beforeEach(() => {
  vi.restoreAllMocks();
  notices.length = 0;
  localStorage.clear();
  __resetStorageListenerForTests();
  // 重置 store
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    isStreaming: false,
    streamingContent: '',
    streamingMessageId: null,
    initialized: false,
    unsavedMessageIds: [],
    storageFull: false,
    _tombstones: [],
    _clearedAt: null,
  });
  useChatStore.getState().initConversations();
});

describe('条数上限与淘汰提醒', () => {
  it('达到上限时淘汰最旧的对话，且只提醒一次', () => {
    const store = useChatStore.getState();

    // 先建满
    for (let i = 0; i < MAX_CONVERSATIONS; i++) {
      store.createConversation(`c${i}`);
    }
    expect(useChatStore.getState().conversations).toHaveLength(MAX_CONVERSATIONS);

    // 再建一条 → 淘汰最旧（第一个创建的 c0）
    useChatStore.getState().createConversation('newbie');
    const state = useChatStore.getState();
    expect(state.conversations).toHaveLength(MAX_CONVERSATIONS);
    expect(state.conversations.some((c) => c.title === 'c0')).toBe(false);
    expect(state.conversations[0]?.title).toBe('newbie');

    const warnings = notices.filter((n) => n.type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.content).toContain('上限');

    // 持久化中带有被淘汰者的墓碑，防止其他标签页将其写回
    const persisted = readStore();
    expect(persisted.tombstones.length).toBeGreaterThan(0);
  });

  it('当前活动对话不会被自动淘汰', () => {
    const store = useChatStore.getState();
    const firstId = store.createConversation('keep-active');
    // 建到恰好上限（含活动对话共 MAX_CONVERSATIONS 条）
    for (let i = 0; i < MAX_CONVERSATIONS - 1; i++) {
      store.createConversation(`c${i}`);
    }
    useChatStore.getState().setActiveConversation(firstId);
    useChatStore.getState().createConversation('overflow');

    const state = useChatStore.getState();
    expect(state.conversations.some((c) => c.id === firstId)).toBe(true);
    expect(state.conversations).toHaveLength(MAX_CONVERSATIONS);
  });
});

describe('存储空间不足', () => {
  it('保存失败时明确告知该条未保存、标记消息并允许重新提交', () => {
    const convId = useChatStore.getState().createConversation('c');
    mockQuotaExceeded();

    const result = useChatStore.getState().addMessage(convId, {
      role: 'user',
      content: '可能存不下的一条很长的消息',
      status: 'complete',
    });

    expect(result.saved).toBe(false);
    const state = useChatStore.getState();
    expect(state.storageFull).toBe(true);
    expect(state.unsavedMessageIds).toContain(result.id);
    expect(notices.some((n) => n.type === 'error' && n.content.includes('没有保存成功'))).toBe(true);

    // 释放空间后重新提交成功
    vi.restoreAllMocks();
    const ok = useChatStore.getState().retryFailedSaves();
    expect(ok).toBe(true);
    const after = useChatStore.getState();
    expect(after.storageFull).toBe(false);
    expect(after.unsavedMessageIds).toEqual([]);
    // 消息确实落盘
    expect(readStore().conversations[0]?.messages.some((m) => m.id === result.id)).toBe(true);
  });

  it('持续空间不足时重试仍失败，不丢失内存中的消息', () => {
    const convId = useChatStore.getState().createConversation('c');
    mockQuotaExceeded();

    const result = useChatStore.getState().addMessage(convId, {
      role: 'user',
      content: 'x',
      status: 'complete',
    });
    expect(result.saved).toBe(false);
    expect(useChatStore.getState().retryFailedSaves()).toBe(false);
    // 内存里消息仍在，等用户稍后再次重试
    expect(
      useChatStore
        .getState()
        .conversations.find((c) => c.id === convId)
        ?.messages.some((m) => m.id === result.id),
    ).toBe(true);
  });
});

describe('多标签页同步', () => {
  it('另一标签页新增/发送消息会同步过来，且不改动已有记录', () => {
    const local = useChatStore.getState();
    const id = local.createConversation('shared');
    local.addMessage(id, { role: 'user', content: '本标签消息', status: 'complete' });

    const before = useChatStore.getState().conversations.find((c) => c.id === id)!;
    const beforeTitle = before.title;
    const beforeCreatedAt = before.createdAt;

    // 另一个标签页：同一对话追加消息，并试图改标题/时间
    const remote = JSON.parse(JSON.stringify(readStore())) as ConversationStoreData;
    const remoteConv = remote.conversations.find((c) => c.id === id)!;
    remoteConv.messages.push({
      id: 'remote-msg-1',
      role: 'assistant',
      content: '远程标签的回复',
      timestamp: Date.now() + 5000,
      status: 'complete',
    });
    remoteConv.title = '被远程改动的标题';
    remoteConv.createdAt = beforeCreatedAt + 999999;
    emitRemoteChange(remote);

    const merged = useChatStore.getState().conversations.find((c) => c.id === id)!;
    expect(merged.messages.map((m) => m.id)).toContain('remote-msg-1');
    // 已有记录的标题与创建时间保持不变
    expect(merged.title).toBe(beforeTitle);
    expect(merged.createdAt).toBe(beforeCreatedAt);
  });

  it('删除对话会同步到另一标签页，且不会被写回（墓碑）', () => {
    const id = useChatStore.getState().createConversation('to-delete');
    useChatStore.getState().createConversation('kept');

    // 模拟"另一个标签页"删除了 to-delete
    const remote = JSON.parse(JSON.stringify(readStore())) as ConversationStoreData;
    remote.conversations = remote.conversations.filter((c) => c.id !== id);
    remote.tombstones.push({ id, deletedAt: Date.now() });
    emitRemoteChange(remote);

    let state = useChatStore.getState();
    expect(state.conversations.some((c) => c.id === id)).toBe(false);

    // 本标签页之后再触发一次持久化，被删除的对话也不应复活
    useChatStore.getState().createConversation('after-delete');
    state = useChatStore.getState();
    expect(state.conversations.some((c) => c.id === id)).toBe(false);
    expect(readStore().tombstones.some((t) => t.id === id)).toBe(true);
  });

  it('清空全部会同步：已有对话被移除，清空后新建的对话保留', () => {
    const store = useChatStore.getState();
    store.createConversation('old-a');
    store.createConversation('old-b');

    const remote = JSON.parse(JSON.stringify(readStore())) as ConversationStoreData;
    remote.conversations = [];
    remote.clearedAt = Date.now();
    emitRemoteChange(remote);

    expect(useChatStore.getState().conversations).toEqual([]);

    // 远程在清空后又新建了一个对话，应保留
    const remote2 = JSON.parse(JSON.stringify(remote)) as ConversationStoreData;
    remote2.conversations = [
      {
        id: 'fresh',
        title: '清空后新建',
        messages: [],
        createdAt: remote.clearedAt! + 1000,
        updatedAt: remote.clearedAt! + 1000,
      },
    ];
    emitRemoteChange(remote2);
    const ids = useChatStore.getState().conversations.map((c) => c.id);
    expect(ids).toEqual(['fresh']);
  });

  it('本标签页的清空同样通过 clearedAt 阻止旧数据回流', () => {
    const store = useChatStore.getState();
    store.createConversation('a');
    store.clearAllConversations();

    // 另一标签页基于旧快照又写回了 a
    const stale = {
      version: 2 as const,
      conversations: [
        {
          id: 'a',
          title: 'a',
          messages: [],
          createdAt: 100,
          updatedAt: 100,
        },
      ],
      tombstones: [],
      clearedAt: null,
    };
    emitRemoteChange(stale);
    expect(useChatStore.getState().conversations).toEqual([]);
  });
});

describe('排列稳定与不可变性', () => {
  it('新消息到达不会重排列表，刷新后顺序一致', () => {
    const store = useChatStore.getState();
    const a = store.createConversation('a');
    const b = store.createConversation('b');
    const c = store.createConversation('c');
    expect(useChatStore.getState().conversations.map((x) => x.id)).toEqual([c, b, a]);

    // 给最旧的 a 发消息，不应把 a 顶到最前
    store.addMessage(a, { role: 'user', content: 'hello', status: 'complete' });
    expect(useChatStore.getState().conversations.map((x) => x.id)).toEqual([c, b, a]);

    // 重新初始化（模拟刷新）顺序保持
    useChatStore.setState({ initialized: false, conversations: [] });
    useChatStore.getState().initConversations();
    expect(useChatStore.getState().conversations.map((x) => x.id)).toEqual([c, b, a]);
  });

  it('分叉并发：一方删除旧对话、另一方新建对话，删除生效且新对话不丢', () => {
    // 共同快照里已有 X
    const xId = useChatStore.getState().createConversation('X');

    // 本标签（A）在收到远程事件前新建了 Y（远程 B 此刻还不知道 Y）
    const yId = useChatStore.getState().createConversation('Y');

    // 标签 B 从含 X 的共同快照出发，单删 X：信封中 X 被移除并带墓碑，
    // 但 B 的信封里没有 Y（B 尚未知晓）——Y 不应被误删
    const remoteDeleteX: ConversationStoreData = {
      version: 2,
      conversations: [],
      tombstones: [{ id: xId, deletedAt: Date.now() }],
      clearedAt: null,
    };
    emitRemoteChange(remoteDeleteX);

    const after = useChatStore.getState().conversations;
    expect(after.some((c) => c.id === xId)).toBe(false); // 删除生效
    expect(after.map((c) => c.id)).toContain(yId); // Y 未被误删

    // 本标签持久化后，信封里同时保留 Y 与 X 的墓碑（可向其他标签收敛）
    useChatStore.getState().setActiveConversation(yId);
    useChatStore.getState().retryFailedSaves();
    const persisted = readStore();
    expect(persisted.conversations.map((c) => c.id)).toContain(yId);
    expect(persisted.tombstones.some((t) => t.id === xId)).toBe(true);
  });

  it('两个标签页各自新建的对话合并后按创建时间降序，双方视图一致', () => {
    // 本标签新建 c-local（参数是标题，ID 为生成的 UUID）
    const localId = useChatStore.getState().createConversation('c-local');

    // 远程标签基于共同快照（空）新建了 c-remote：
    // 真实多标签场景下双方信封的墓碑/clearedAt 均为空
    const remote: ConversationStoreData = {
      version: 2,
      conversations: [
        {
          id: 'c-remote',
          title: 'c-remote',
          messages: [],
          createdAt: Date.now() + 10_000,
          updatedAt: Date.now() + 10_000,
        },
      ],
      tombstones: [],
      clearedAt: null,
    };
    emitRemoteChange(remote);

    const ids = useChatStore.getState().conversations.map((c) => c.id);
    expect(ids[0]).toBe('c-remote');
    expect(ids).toContain(localId);
    // 顺序即全局创建时间降序
    const convs = useChatStore.getState().conversations;
    expect(convs[0]!.createdAt).toBeGreaterThan(convs[1]!.createdAt);
  });

  it('已有消息的 timestamp 不会被同步过程修改', () => {
    const id = useChatStore.getState().createConversation('c');
    useChatStore.getState().addMessage(id, {
      role: 'user',
      content: 'original',
      status: 'complete',
    });
    const originalMsg = useChatStore
      .getState()
      .conversations.find((x) => x.id === id)!.messages[0]!;
    const originalTs = originalMsg.timestamp;

    const remote = JSON.parse(JSON.stringify(readStore())) as ConversationStoreData;
    const conv = remote.conversations.find((x) => x.id === id)!;
    conv.messages[0]!.timestamp = originalTs + 12345;
    conv.messages[0]!.content = '被远程改过的内容';
    emitRemoteChange(remote);

    const msg = useChatStore
      .getState()
      .conversations.find((x) => x.id === id)!.messages[0]!;
    expect(msg.timestamp).toBe(originalTs);
    expect(msg.content).toBe('original');
  });
});
