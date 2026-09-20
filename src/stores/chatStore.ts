import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { Conversation, Message, CreateMessageParams } from '../types';
import {
  applyCapacityLimit,
  commitClearAll,
  commitConversations,
  commitDeletions,
  mergeEnvelopes,
  readEnvelope,
  subscribeRemoteChanges,
  type ConversationEnvelope,
} from '../services/conversationRepository';
import { generateConversationTitle } from '../utils/formatters';

/**
 * 保存失败信息
 */
export interface SaveFailure {
  /** 未保存成功的对话 ID */
  conversationId: string;
  /** 对话标题（用于提示文案） */
  title: string;
  /** 错误信息 */
  error: string;
}

/**
 * 条数上限淘汰通知（每次触发淘汰提醒一次，用户关闭后再次触发会重新提醒）
 */
export interface EvictionNotice {
  /** 被淘汰的记录标题列表 */
  titles: string[];
  /** 淘汰时间 */
  at: number;
}

interface ChatState {
  /** 对话列表 */
  conversations: Conversation[];
  /** 当前活动对话 ID */
  activeConversationId: string | null;
  /** 是否正在流式响应 */
  isStreaming: boolean;
  /** 流式响应累积内容 */
  streamingContent: string;
  /** 流式响应消息 ID */
  streamingMessageId: string | null;
  /** 是否已初始化 */
  initialized: boolean;
  /** 最近一次保存失败信息（容量不足等），null 表示无失败 */
  saveFailure: SaveFailure | null;
  /** 条数上限淘汰通知（本标签页只提示一次，提示后可清空） */
  evictionNotice: EvictionNotice | null;
}

interface ChatActions {
  /** 初始化（从 localStorage 加载并订阅跨标签页变更） */
  initConversations: () => void;
  /** 创建新对话 */
  createConversation: (title?: string) => string;
  /** 删除对话 */
  deleteConversation: (id: string) => void;
  /** 设置活动对话 */
  setActiveConversation: (id: string | null) => void;
  /** 添加消息到对话，返回消息 ID */
  addMessage: (conversationId: string, params: CreateMessageParams) => string;
  /** 更新消息 */
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void;
  /** 开始流式响应 */
  startStreaming: (conversationId: string) => string;
  /** 追加流式内容 */
  appendStreamContent: (content: string) => void;
  /** 完成流式响应 */
  finishStreaming: (stats?: Message['stats']) => void;
  /** 取消流式响应 */
  cancelStreaming: () => void;
  /** 获取当前活动对话 */
  getActiveConversation: () => Conversation | null;
  /** 清除所有对话 */
  clearAllConversations: () => void;
  /** 更新对话标题 */
  updateConversationTitle: (id: string, title: string) => void;
  /** 重新保存因容量不足而失败的记录 */
  retrySave: () => boolean;
  /** 清除淘汰通知（用户已知晓） */
  clearEvictionNotice: () => void;
}

export type ChatStore = ChatState & ChatActions;

/** 用当前内存状态 + 磁盘上的墓碑/清空标记构造信封 */
function buildEnvelope(conversations: Conversation[]): ConversationEnvelope {
  const stored = readEnvelope();
  return {
    version: 1,
    conversations,
    tombstones: stored.tombstones,
    clearedAt: stored.clearedAt,
  };
}

function isQuotaError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    (error instanceof Error && /存储空间不足/.test(error.message))
  );
}

// 防抖保存的计时器
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

export const useChatStore = create<ChatStore>((set, get) => {
  /**
   * 记录保存失败（容量不足等）。定位最近更新的对话作为“这一条”。
   */
  const markSaveFailure = (conversations: Conversation[], error: unknown) => {
    const message = isQuotaError(error)
      ? '本地存储空间不足，这一条没有保存成功'
      : '保存失败，这一条没有保存成功';
    const target = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    set({
      saveFailure: {
        conversationId: target?.id ?? '',
        title: target?.title ?? '当前对话',
        error: message,
      },
    });
  };

  /**
   * 持久化当前对话列表。
   * - 与磁盘内容合并，避免多标签页互相覆盖（保留一条记录，不互相顶掉）
   * - 条数超限时淘汰最旧记录并提醒一次（通知关闭前不重复弹；关闭后再次触发会再提醒）
   * - 容量不足时设置 saveFailure（不静默删数据），由 UI 提示并允许重新提交
   *
   * @returns 同步保存（immediate）时是否完整成功；防抖模式恒为 true
   */
  const persist = (immediate = false): boolean => {
    const run = (): boolean => {
      const state = get();
      try {
        const result = commitConversations(buildEnvelope(state.conversations));

        // 淘汰后以仓库结果为准（被淘汰记录从内存移除，其他标签页经 storage 事件同步）
        if (result.evicted.length > 0) {
          const evictedIds = new Set(result.evicted.map((c) => c.id));
          const remaining = state.conversations.filter((c) => !evictedIds.has(c.id));
          const patch: Partial<ChatState> = {
            conversations: remaining,
            // 已在展示通知时覆盖为最新一次淘汰内容，避免重复堆叠
            evictionNotice: {
              titles: result.evicted.map((c) => c.title),
              at: Date.now(),
            },
          };

          if (
            state.activeConversationId &&
            !remaining.some((c) => c.id === state.activeConversationId)
          ) {
            patch.activeConversationId = remaining[0]?.id ?? null;
          }

          set(patch);
        }

        if (get().saveFailure) {
          set({ saveFailure: null });
        }
        return true;
      } catch (error) {
        console.error('Failed to save conversations:', error);
        markSaveFailure(get().conversations, error);
        return false;
      }
    };

    if (immediate) {
      if (saveTimeout) {
        clearTimeout(saveTimeout);
        saveTimeout = null;
      }
      return run();
    }

    if (saveTimeout) {
      clearTimeout(saveTimeout);
    }
    saveTimeout = setTimeout(() => {
      saveTimeout = null;
      run();
    }, 500);
    return true;
  };

  /**
   * 处理来自其他标签页的存储变更：按 id 合并，
   * 删除/清空同步过来，已有记录的标题与时间不被改动，列表顺序以磁盘为准。
   */
  const handleRemoteChange = ({ envelope: remote }: { envelope: ConversationEnvelope }) => {
    const state = get();

    // 本页正在流式输出时暂缓合并，避免打断流式状态；流结束落盘时会再次合并
    if (state.isStreaming) return;

    const local = buildEnvelope(state.conversations);
    const merged = mergeEnvelopes(local, remote);

    // 远端可能带来淘汰：本地同样应用条数上限。淘汰由对端提示，本页静默对齐
    const { kept } = applyCapacityLimit(merged);
    const conversations = kept.conversations;

    let activeConversationId = state.activeConversationId;
    if (activeConversationId && !conversations.some((c) => c.id === activeConversationId)) {
      // 当前对话在另一标签页被删除/清空：切到列表第一条，没有则置空
      activeConversationId = conversations[0]?.id ?? null;
    }

    set({ conversations, activeConversationId });
  };

  return {
    // Initial state
    conversations: [],
    activeConversationId: null,
    isStreaming: false,
    streamingContent: '',
    streamingMessageId: null,
    initialized: false,
    saveFailure: null,
    evictionNotice: null,

    // Actions
    initConversations: () => {
      if (get().initialized) return;

      const envelope = readEnvelope();
      // 加载时同样应用条数上限，但不弹通知（旧数据迁移/他端淘汰对齐）
      const { kept } = applyCapacityLimit(envelope);
      const conversations = kept.conversations;
      const activeId = conversations[0]?.id ?? null;

      subscribeRemoteChanges(handleRemoteChange);

      set({
        conversations,
        activeConversationId: activeId,
        initialized: true,
      });
    },

    createConversation: (title) => {
      const id = uuidv4();
      const now = Date.now();

      const newConversation: Conversation = {
        id,
        title: title || '新对话',
        messages: [],
        createdAt: now,
        updatedAt: now,
      };

      set(state => ({
        conversations: [newConversation, ...state.conversations],
        activeConversationId: id,
      }));

      // 新建即落盘：达到条数上限或容量不足时能第一时间得到明确结果
      persist(true);
      return id;
    },

    deleteConversation: (id) => {
      const state = get();
      const remaining = state.conversations.filter(c => c.id !== id);

      let activeConversationId = state.activeConversationId;
      if (activeConversationId === id) {
        activeConversationId = remaining[0]?.id ?? null;
      }

      // 墓碑提交：删除会同步到其他标签页，且不会被他端旧数据顶回来
      try {
        commitDeletions(buildEnvelope(remaining), [id]);
      } catch (error) {
        console.error('Failed to delete conversation:', error);
      }

      set({ conversations: remaining, activeConversationId });
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

      set(state => {
        const conversations = state.conversations.map(conv => {
          if (conv.id !== conversationId) return conv;

          const messages = [...conv.messages, newMessage];

          // 仅在尚无消息的新记录收到第一条用户消息时自动生成标题，
          // 已存在记录的标题不会被改动
          let title = conv.title;
          if (params.role === 'user' && conv.messages.length === 0) {
            title = generateConversationTitle(params.content);
          }

          return {
            ...conv,
            messages,
            title,
            updatedAt: now,
          };
        });

        // 最近有更新的对话上浮到最前，其余对话相对顺序保持不变
        conversations.sort((a, b) => b.updatedAt - a.updatedAt);

        return { conversations };
      });

      persist(true);
      return messageId;
    },

    updateMessage: (conversationId, messageId, updates) => {
      set(state => ({
        conversations: state.conversations.map(conv => {
          if (conv.id !== conversationId) return conv;

          return {
            ...conv,
            messages: conv.messages.map(msg =>
              msg.id === messageId ? { ...msg, ...updates } : msg
            ),
            updatedAt: Date.now(),
          };
        }),
      }));

      persist();
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

      set(state => ({
        conversations: state.conversations.map(conv =>
          conv.id === conversationId
            ? {
                ...conv,
                messages: [...conv.messages, streamingMessage],
                updatedAt: now,
              }
            : conv
        ),
        isStreaming: true,
        streamingContent: '',
        streamingMessageId: messageId,
      }));

      return messageId;
    },

    appendStreamContent: (content) => {
      set(state => {
        const newContent = state.streamingContent + content;

        const conversations = state.conversations.map(conv => {
          if (conv.id !== state.activeConversationId) return conv;

          return {
            ...conv,
            messages: conv.messages.map(msg =>
              msg.id === state.streamingMessageId
                ? { ...msg, content: newContent }
                : msg
            ),
          };
        });

        return {
          streamingContent: newContent,
          conversations,
        };
      });
    },

    finishStreaming: (stats) => {
      set(state => ({
        conversations: state.conversations.map(conv => {
          if (conv.id !== state.activeConversationId) return conv;

          return {
            ...conv,
            messages: conv.messages.map(msg =>
              msg.id === state.streamingMessageId
                ? {
                    ...msg,
                    content: state.streamingContent,
                    status: 'complete' as const,
                    stats,
                  }
                : msg
            ),
            updatedAt: Date.now(),
          };
        }),
        isStreaming: false,
        streamingContent: '',
        streamingMessageId: null,
      }));

      persist(true);
    },

    cancelStreaming: () => {
      set(state => ({
        conversations: state.conversations.map(conv => {
          if (conv.id !== state.activeConversationId) return conv;

          return {
            ...conv,
            messages: conv.messages.map(msg =>
              msg.id === state.streamingMessageId
                ? {
                    ...msg,
                    content: state.streamingContent || '（响应已中断）',
                    status: 'error' as const,
                  }
                : msg
            ),
          };
        }),
        isStreaming: false,
        streamingContent: '',
        streamingMessageId: null,
      }));

      persist(true);
    },

    getActiveConversation: () => {
      const { conversations, activeConversationId } = get();
      return conversations.find(c => c.id === activeConversationId) || null;
    },

    clearAllConversations: () => {
      // clearedAt 标记：清空同步到其他标签页，他端的旧记录也不会顶回来
      try {
        commitClearAll(buildEnvelope(get().conversations));
      } catch (error) {
        console.error('Failed to clear conversations:', error);
      }

      set({
        conversations: [],
        activeConversationId: null,
      });
    },

    updateConversationTitle: (id, title) => {
      set(state => ({
        conversations: state.conversations.map(conv =>
          conv.id === id ? { ...conv, title } : conv
        ),
      }));

      persist();
    },

    retrySave: () => {
      const state = get();
      if (!state.saveFailure) return true;

      try {
        const result = commitConversations(buildEnvelope(state.conversations));
        const patch: Partial<ChatState> = { saveFailure: null };

        if (result.evicted.length > 0) {
          const evictedIds = new Set(result.evicted.map((c) => c.id));
          const remaining = state.conversations.filter((c) => !evictedIds.has(c.id));
          patch.conversations = remaining;
          patch.evictionNotice = {
            titles: result.evicted.map((c) => c.title),
            at: Date.now(),
          };

          if (
            state.activeConversationId &&
            !remaining.some((c) => c.id === state.activeConversationId)
          ) {
            patch.activeConversationId = remaining[0]?.id ?? null;
          }
        }

        set(patch);
        return true;
      } catch (error) {
        console.error('Retry save failed:', error);
        const message = isQuotaError(error)
          ? '本地存储空间仍然不足，这一条还是没有保存成功，请清理浏览器存储后重试'
          : '保存仍然失败，请稍后重试';
        set({
          saveFailure: { ...state.saveFailure, error: message },
        });
        return false;
      }
    },

    clearEvictionNotice: () => {
      set({ evictionNotice: null });
    },
  };
});
