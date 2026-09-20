import type { Message } from './message';

/**
 * 对话对象
 */
export interface Conversation {
  /** 对话唯一标识 */
  id: string;
  /** 对话标题 */
  title: string;
  /** 消息列表 */
  messages: Message[];
  /** 创建时间戳 */
  createdAt: number;
  /** 最后更新时间戳 */
  updatedAt: number;
}

/**
 * 创建对话的参数
 */
export interface CreateConversationParams {
  title?: string;
}

/**
 * 已删除对话的墓碑记录
 * 多标签同步时用于标记删除，避免被其他标签页的旧数据重新写回（互相顶掉）
 */
export interface ConversationTombstone {
  /** 被删除的对话 ID */
  id: string;
  /** 删除时间戳 */
  deletedAt: number;
}

/**
 * 本地持久化的对话存储结构（信封格式 v2）
 */
export interface ConversationStoreData {
  /** 存储结构版本 */
  version: 2;
  /** 对话列表（顺序即展示顺序，不做重排） */
  conversations: Conversation[];
  /** 删除墓碑 */
  tombstones: ConversationTombstone[];
  /** 最近一次"清空全部"的时间点，早于该时间创建的对话均视为已清空 */
  clearedAt: number | null;
}

/**
 * 对话列表排序方式
 */
export type ConversationSortBy = 'updatedAt' | 'createdAt' | 'title';

/**
 * 对话列表排序顺序
 */
export type SortOrder = 'asc' | 'desc';
