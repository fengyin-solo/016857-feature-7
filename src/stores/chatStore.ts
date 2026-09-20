import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { Conversation, ConversationStoreData, Message, CreateMessageParams } from '../types';
import {
  loadConversations,
  saveConversations,
  CONVERSATIONS_STORAGE_KEY,
  StorageQuotaError,
  isQuotaExceededError,
} from '../services/storage';
import {
  MAX_CONVERSATIONS,
  applyConversationLimit,
  createEmptyStoreData,
  mergeConversationData,
  pruneTombstones,
} from '../services/conversationSync';
import { notify } from '../services/notifier';
import { generateConversationTitle } from '../utils/formatters';

/** 添加消息的返回结果 */
export interface AddMessageResult {
  /** 新消息 ID */
  id: string;
  /** 是否已成功持久化到本地存储 */
  saved: boolean;
}

interface ChatState {
  /** 对话列表（顺序即存储/展示顺序，不重排） */
  conversations: Conversation[];
  /** 当前活动对话 ID（仅本标签页的 UI 状态，不跨标签同步） */
  activeConversationId: string | null;
  /** 是否正在流式响应 */
  isStreaming: boolean;
  /** 流式响应累积内容 */
  streamingContent: string;
  /** 流式响应消息 ID */
  streamingMessageId: string | null;
  /** 是否已初始化 */
  initialized: boolean;
  /** 本地持久化失败、尚未保存成功的消息 ID 集合 */
  unsavedMessageIds: string[];
  /** 当前本地存储是否处于"空间不足/写入失败"状态 */
  storageFull: boolean;
  /** 已删除对话墓碑（持久化元数据） */
  _tombstones: ConversationStoreData['tombstones'];
  /** 最近一次清空全部的时间点（持久化元数据） */
  _clearedAt: number | null;
}

interface ChatActions {
  /** 初始化（从 localStorage 加载并监听跨标签页同步） */
  initConversations: () => void;
  /** 创建新对话 */
  createConversation: (title?: string) => string;
  /** 删除对话（跨标签页同步，保留墓碑） */
  deleteConversation: (id: string) => void;
  /** 删除某条消息（用于重新提交未保存成功的消息） */
  deleteMessage: (conversationId: string, messageId: string) => boolean;
  /** 设置活动对话 */
  setActiveConversation: (id: string | null) => void;
  /** 添加消息到对话 */
  addMessage: (conversationId: string, params: CreateMessageParams) => AddMessageResult;
  /** 更新消息 */
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void;
  /** 开始流式响应 */
  startStreaming: (conversationId: string) => string;
  /** 追加流式内容（仅内存，不持久化） */
  appendStreamContent: (content: string) => void;
  /** 完成流式响应 */
  finishStreaming: (stats?: Message['stats']) => void;
  /** 取消流式响应 */
  cancelStreaming: () => void;
  /** 获取当前活动对话 */
  getActiveConversation: () => Conversation | null;
  /** 清除所有对话（跨标签页同步） */
  clearAllConversations: () => void;
  /** 重新保存之前写入失败的消息 */
  retryFailedSaves: () => boolean;
}

type ChatStore = ChatState & ChatActions;

/** 跨标签页同步监听器（模块级持有引用，便于注销/重置） */
let storageListener: ((event: StorageEvent) => void) | null = null;

/** 测试专用：注销跨标签页监听并重置绑定状态 */
export function __resetStorageListenerForTests(): void {
  if (storageListener && typeof window !== 'undefined') {
    window.removeEventListener('storage', storageListener);
  }
  storageListener = null;
}

export const useChatStore = create<ChatStore>((set, get) => {
  /** 把当前内存状态写回 localStorage，更新保存失败标记 */
  const persist = (options?: { protectedIds?: string[] }): boolean => {
    const state = get();
    let data: ConversationStoreData = {
      version: 2,
      conversations: state.conversations,
      tombstones: state._tombstones,
      clearedAt: state._clearedAt,
    };

    // 写入前应用条数上限；当前活动对话始终受保护，与调用方显式保护对象取并集
    const protectedIds = new Set(options?.protectedIds ?? []);
    if (state.activeConversationId) {
      protectedIds.add(state.activeConversationId);
    }
    const { data: limited, evicted } = applyConversationLimit(data, {
      limit: MAX_CONVERSATIONS,
      protectedIds: [...protectedIds],
    });
    data = limited;

    if (evicted.length > 0) {
      const evictedIds = new Set(evicted.map((c) => c.id));
      set({
        conversations: data.conversations,
        activeConversationId:
          state.activeConversationId && evictedIds.has(state.activeConversationId)
            ? data.conversations[0]?.id ?? null
            : state.activeConversationId,
        _tombstones: data.tombstones,
      });
      // 淘汰只提醒一次（无论本次淘汰多少条）
      notify(
        'warning',
        `对话条数已达上限（${MAX_CONVERSATIONS} 条），已自动淘汰最旧的 ${evicted.length} 条对话`,
      );
    }

    try {
      saveConversations(data);
      if (state.storageFull || state.unsavedMessageIds.length > 0) {
        set({ storageFull: false, unsavedMessageIds: [] });
      }
      return true;
    } catch (error) {
      const quota = isQuotaExceededError(error) || error instanceof StorageQuotaError;
      if (!state.storageFull) {
        notify(
          'error',
          quota
            ? '本地存储空间不足，这一条没有保存成功。可删除部分旧对话后点击消息上的"重新提交"'
            : '本地保存失败，这一条没有保存成功，请稍后重新提交',
        );
      }
      set({ storageFull: true });
      return false;
    }
  };

  /** 标记某条消息未保存成功 */
  const markUnsaved = (messageIds: string[]) => {
    if (messageIds.length === 0) return;
    set((state) => {
      const ids = new Set(state.unsavedMessageIds);
      for (const id of messageIds) ids.add(id);
      return { unsavedMessageIds: [...ids], storageFull: true };
    });
  };

  return {
    // Initial state
    conversations: [],
    activeConversationId: null,
    isStreaming: false,
    streamingContent: '',
    streamingMessageId: null,
    initialized: false,
    unsavedMessageIds: [],
    storageFull: false,
    // 内部持久化元数据（不参与 UI 订阅）
    _tombstones: [],
    _clearedAt: null,

    initConversations: () => {
      if (get().initialized) return;

      const data = loadConversations();
      const activeId = data.conversations[0]?.id ?? null;

      set({
        conversations: data.conversations,
        _tombstones: data.tombstones,
        _clearedAt: data.clearedAt,
        activeConversationId: activeId,
        initialized: true,
      });

      // 首次加载即把迁移后的结构回写一次（静默，失败也不打扰）
      try {
        saveConversations({
          version: 2,
          conversations: data.conversations,
          tombstones: data.tombstones,
          clearedAt: data.clearedAt,
        });
      } catch {
        // 忽略首次回写失败，后续操作仍会提示
      }

      // 监听其他标签页对 localStorage 的修改（同一浏览器多开同步）
      if (typeof window !== 'undefined' && !storageListener) {
        storageListener = (event: StorageEvent) => {
          if (event.key !== CONVERSATIONS_STORAGE_KEY || event.newValue === null) {
            return;
          }

          let remote: ConversationStoreData;
          try {
            const parsed: unknown = JSON.parse(event.newValue);
            if (Array.isArray(parsed)) {
              remote = {
                version: 2,
                conversations: parsed as Conversation[],
                tombstones: [],
                clearedAt: null,
              };
            } else if (parsed && typeof parsed === 'object') {
              remote = {
                ...createEmptyStoreData(),
                ...(parsed as Partial<ConversationStoreData>),
                version: 2,
              };
            } else {
              return;
            }
          } catch {
            return;
          }

          const state = get();
          const local: ConversationStoreData = {
            version: 2,
            conversations: state.conversations,
            tombstones: state._tombstones,
            clearedAt: state._clearedAt,
          };

          const merged = mergeConversationData(local, remote);

          // 被动同步时同样保证条数上限；此处若被动淘汰不重复提醒
          const { data: limited } = applyConversationLimit(merged, {
            limit: MAX_CONVERSATIONS,
            protectedIds: state.activeConversationId ? [state.activeConversationId] : [],
          });

          set({
            conversations: limited.conversations,
            _tombstones: pruneTombstones(limited.tombstones),
            _clearedAt: limited.clearedAt,
            activeConversationId:
              state.activeConversationId &&
              !limited.conversations.some((c) => c.id === state.activeConversationId)
                ? limited.conversations[0]?.id ?? null
                : state.activeConversationId,
          });
        };
        window.addEventListener('storage', storageListener);
      }
    },

    createConversation: (title) => {
      const id = uuidv4();
      const now = Date.now();
      // 记录切换前的活动对话：溢出淘汰时不淘汰用户刚刚正在查看的对话
      const previousActiveId = get().activeConversationId;

      const newConversation: Conversation = {
        id,
        title: title || '新对话',
        messages: [],
        createdAt: now,
        updatedAt: now,
      };

      // 新对话放在最前，其他对话原有相对位置保持不变
      set((state) => ({
        conversations: [newConversation, ...state.conversations],
        activeConversationId: id,
      }));

      persist({
        protectedIds: previousActiveId ? [id, previousActiveId] : [id],
      });
      return id;
    },

    deleteConversation: (id) => {
      const state = get();
      const nextConversations = state.conversations.filter((c) => c.id !== id);
      const nextActiveId =
        state.activeConversationId === id
          ? nextConversations[0]?.id ?? null
          : state.activeConversationId;
      const tombstone = { id, deletedAt: Date.now() };

      set({
        conversations: nextConversations,
        activeConversationId: nextActiveId,
        _tombstones: pruneTombstones([...state._tombstones, tombstone]),
        unsavedMessageIds: state.unsavedMessageIds.filter((mid) =>
          nextConversations.some((c) => c.messages.some((m) => m.id === mid)),
        ),
      });

      if (!persist()) {
        notify('error', '删除操作未能同步到本地存储，请重试');
      }
    },

    deleteMessage: (conversationId, messageId) => {
      set((state) => ({
        conversations: state.conversations.map((conv) =>
          conv.id !== conversationId
            ? conv
            : { ...conv, messages: conv.messages.filter((m) => m.id !== messageId) },
        ),
        unsavedMessageIds: state.unsavedMessageIds.filter((id) => id !== messageId),
      }));
      return persist();
    },

    setActiveConversation: (id) => {
      set({ activeConversationId: id });
    },

    addMessage: (conversationId, params) => {
      const messageId = uuidv4();
      const now = Date.now();

      const newMessage: Message = {
        id: messageId,
        role: params.role,
        content: params.content,
        timestamp: now,
        status: params.status || 'complete',
      };

      set((state) => ({
        conversations: state.conversations.map((conv) => {
          if (conv.id !== conversationId) return conv;

          // 只有第一条用户消息时生成一次标题，已有标题永不改动
          let title = conv.title;
          if (params.role === 'user' && conv.messages.length === 0) {
            title = generateConversationTitle(params.content);
          }

          return {
            ...conv,
            title,
            messages: [...conv.messages, newMessage],
            updatedAt: now,
          };
        }),
      }));

      const saved = persist({
        protectedIds: [conversationId],
      });
      if (!saved) markUnsaved([messageId]);

      return { id: messageId, saved };
    },

    updateMessage: (conversationId, messageId, updates) => {
      set((state) => ({
        conversations: state.conversations.map((conv) => {
          if (conv.id !== conversationId) return conv;
          return {
            ...conv,
            messages: conv.messages.map((msg) =>
              msg.id !== messageId ? msg : { ...msg, ...updates },
            ),
          };
        }),
      }));
    },

    startStreaming: (conversationId) => {
      const messageId = uuidv4();
      const now = Date.now();

      const streamingMessage: Message = {
        id: messageId,
        role: 'assistant',
        content: '',
        timestamp: now,
        status: 'streaming',
      };

      set((state) => ({
        conversations: state.conversations.map((conv) =>
          conv.id !== conversationId
            ? conv
            : {
                ...conv,
                messages: [...conv.messages, streamingMessage],
                updatedAt: now,
              },
        ),
        isStreaming: true,
        streamingContent: '',
        streamingMessageId: messageId,
      }));

      if (!persist({ protectedIds: [conversationId] })) {
        markUnsaved([messageId]);
      }

      return messageId;
    },

    appendStreamContent: (content) => {
      set((state) => {
        const newContent = state.streamingContent + content;

        const conversations = state.conversations.map((conv) => {
          if (conv.id !== state.activeConversationId) return conv;
          return {
            ...conv,
            messages: conv.messages.map((msg) =>
              msg.id !== state.streamingMessageId ? msg : { ...msg, content: newContent },
            ),
          };
        });

        return { streamingContent: newContent, conversations };
      });
    },

    finishStreaming: (stats) => {
      const state = get();
      const messageId = state.streamingMessageId;

      set((s) => ({
        conversations: s.conversations.map((conv) => {
          if (conv.id !== s.activeConversationId) return conv;
          return {
            ...conv,
            messages: conv.messages.map((msg) =>
              msg.id !== messageId
                ? msg
                : {
                    ...msg,
                    content: s.streamingContent,
                    status: 'complete' as const,
                    stats,
                  },
            ),
          };
        }),
        isStreaming: false,
        streamingContent: '',
        streamingMessageId: null,
      }));

      if (!persist() && messageId) {
        markUnsaved([messageId]);
      }
    },

    cancelStreaming: () => {
      const state = get();
      const messageId = state.streamingMessageId;

      set((s) => ({
        conversations: s.conversations.map((conv) => {
          if (conv.id !== s.activeConversationId) return conv;
          return {
            ...conv,
            messages: conv.messages.map((msg) =>
              msg.id !== messageId
                ? msg
                : {
                    ...msg,
                    content: s.streamingContent || '（响应已中断）',
                    status: 'error' as const,
                  },
            ),
          };
        }),
        isStreaming: false,
        streamingContent: '',
        streamingMessageId: null,
      }));

      if (!persist() && messageId) {
        markUnsaved([messageId]);
      }
    },

    getActiveConversation: () => {
      const { conversations, activeConversationId } = get();
      return conversations.find((c) => c.id === activeConversationId) || null;
    },

    clearAllConversations: () => {
      // clearedAt 标记清空：其他标签页合入时，早于该时间创建的对话都会被移除
      set({
        conversations: [],
        activeConversationId: null,
        _tombstones: [],
        _clearedAt: Date.now(),
        unsavedMessageIds: [],
        storageFull: false,
        isStreaming: false,
        streamingContent: '',
        streamingMessageId: null,
      });

      if (!persist()) {
        notify('error', '清空操作未能同步到本地存储，请重试');
      }
    },

    retryFailedSaves: () => {
      const ok = persist();
      if (ok) {
        set({ storageFull: false, unsavedMessageIds: [] });
      }
      return ok;
    },
  };
});
