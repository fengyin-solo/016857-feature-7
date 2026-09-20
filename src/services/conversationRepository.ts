import type { Conversation } from '../types';

/**
 * 对话本地存储仓库
 *
 * 设计要点：
 * - 持久化结构为一个信封（Envelope），除对话列表外还保存删除墓碑（tombstones）
 *   与清空标记（clearedAt）。多标签页合并时，墓碑/清空标记可以阻止已删除的记录
 *   被另一个标签页的旧数据“顶回来”，清空操作也能同步过去。
 * - 合并以对话 id 为单位，同一条记录永远整体取用，不会改写已有记录的标题、
 *   时间等任何字段。
 * - 列表顺序即持久化时的数组顺序，读取时不重排，保证刷新后/返回后排列保持原样。
 */

const CONVERSATIONS_KEY = 'react-chat-conversations';

/** 保存的对话条数上限：超过时淘汰最旧（按 createdAt）的记录 */
export const MAX_CONVERSATIONS = 200;

/** 墓碑保留时长（30 天），过期后可被清理，避免无限增长 */
const TOMBSTONE_TTL = 30 * 24 * 60 * 60 * 1000;

/**
 * 持久化信封
 */
export interface ConversationEnvelope {
  /** 版本号，用于后续数据结构迁移 */
  version: 1;
  /** 对话列表（顺序即展示顺序） */
  conversations: Conversation[];
  /** 已删除对话的 id -> 删除时间戳，防止跨标签页同步时记录被顶回来 */
  tombstones: Record<string, number>;
  /** 最近一次“清空全部”的时间戳；早于该时间创建的对话一律视为已清空 */
  clearedAt: number | null;
}

/**
 * 写入结果
 */
export interface CommitResult {
  /** 实际写入的信封 */
  envelope: ConversationEnvelope;
  /** 本次写入是否因条数上限淘汰了记录 */
  evicted: Conversation[];
}

/**
 * 跨标签页同步事件载荷（storage 事件）
 */
export interface RemoteChange {
  envelope: ConversationEnvelope;
}

export function emptyEnvelope(): ConversationEnvelope {
  return { version: 1, conversations: [], tombstones: {}, clearedAt: null };
}

function isValidConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== 'object') return false;
  const conv = value as Record<string, unknown>;
  return (
    typeof conv.id === 'string' &&
    typeof conv.title === 'string' &&
    typeof conv.createdAt === 'number' &&
    typeof conv.updatedAt === 'number' &&
    Array.isArray(conv.messages)
  );
}

function isEnvelope(value: unknown): value is ConversationEnvelope {
  if (!value || typeof value !== 'object') return false;
  const env = value as Record<string, unknown>;
  return (
    env.version === 1 &&
    Array.isArray(env.conversations) &&
    typeof env.tombstones === 'object' &&
    env.tombstones !== null &&
    (env.clearedAt === null || typeof env.clearedAt === 'number')
  );
}

/**
 * 读取并规范化信封。兼容旧版本：旧版直接以数组形式存储，
 * 读取时保留原数组顺序（旧实现曾按 updatedAt 排序落盘，迁移也不重排）。
 */
export function readEnvelope(): ConversationEnvelope {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(CONVERSATIONS_KEY);
  } catch {
    return emptyEnvelope();
  }

  if (!raw) return emptyEnvelope();

  try {
    const parsed: unknown = JSON.parse(raw);

    // 旧版本：裸数组
    if (Array.isArray(parsed)) {
      return {
        version: 1,
        conversations: parsed.filter(isValidConversation),
        tombstones: {},
        clearedAt: null,
      };
    }

    if (isEnvelope(parsed)) {
      return {
        version: 1,
        conversations: parsed.conversations.filter(isValidConversation),
        tombstones: parsed.tombstones,
        clearedAt: parsed.clearedAt,
      };
    }

    return emptyEnvelope();
  } catch {
    return emptyEnvelope();
  }
}

/**
 * 直接写入信封（不做合并、不做淘汰），供“清空”等操作使用。
 * 容量不足时抛出 QuotaExceededError（或原始 DOMException）。
 */
export function writeEnvelope(envelope: ConversationEnvelope): void {
  localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(envelope));
}

/**
 * 判断记录是否已被删除（命中墓碑，或创建于最近一次清空之前）
 */
export function isDeleted(conv: Conversation, envelope: ConversationEnvelope): boolean {
  if (envelope.clearedAt !== null && conv.createdAt <= envelope.clearedAt) {
    return true;
  }
  return Object.prototype.hasOwnProperty.call(envelope.tombstones, conv.id);
}

/**
 * 合并两个信封：以对话 id 为单位取较新的一条（按 updatedAt），
 * 绝不修改任何已有记录的字段；删除墓碑与清空标记双向合并。
 *
 * 顺序规则（被动同步用，远端磁盘顺序为准——保证刷新后/返回后排列不变）：
 * - 已持久化的记录保持磁盘上的既有顺序（远端在前）；
 * - 本地新建、从未落盘过的记录排到最前，按本地创建顺序排列。
 */
export function mergeEnvelopes(
  local: ConversationEnvelope,
  remote: ConversationEnvelope
): ConversationEnvelope {
  return mergeWithOrder(local, remote, 'remote');
}

/**
 * 本地写入时的合并：字段取用规则与 mergeEnvelopes 相同，
 * 但顺序以本地为准——本页刚更新（例如刚发消息）的对话按本地排列上浮，
 * 其他标签页新建、本地尚不知道的记录追加到末尾。
 */
export function mergeForCommit(
  local: ConversationEnvelope,
  remote: ConversationEnvelope
): ConversationEnvelope {
  return mergeWithOrder(local, remote, 'local');
}

function mergeWithOrder(
  local: ConversationEnvelope,
  remote: ConversationEnvelope,
  orderPreference: 'local' | 'remote'
): ConversationEnvelope {
  const clearedAt =
    local.clearedAt === null
      ? remote.clearedAt
      : remote.clearedAt === null
        ? local.clearedAt
        : Math.max(local.clearedAt, remote.clearedAt);

  const now = Date.now();
  const tombstones: Record<string, number> = {};
  for (const [id, ts] of Object.entries(local.tombstones)) {
    if (now - ts < TOMBSTONE_TTL) tombstones[id] = ts;
  }
  for (const [id, ts] of Object.entries(remote.tombstones)) {
    if (now - ts >= TOMBSTONE_TTL) continue;
    if (!tombstones[id] || ts > tombstones[id]) {
      tombstones[id] = ts;
    }
  }

  const remoteById = new Map(remote.conversations.map((c) => [c.id, c]));
  const localById = new Map(local.conversations.map((c) => [c.id, c]));

  const merged: Conversation[] = [];
  const seen = new Set<string>();

  const isAlive = (conv: Conversation) => {
    if (clearedAt !== null && conv.createdAt <= clearedAt) return false;
    return !Object.prototype.hasOwnProperty.call(tombstones, conv.id);
  };

  // 同 id 记录取较新版本，整体取用，不改写任何字段。
  // otherById 永远是“另一来源”的索引（与首选方向无关）。
  const otherById = orderPreference === 'remote' ? localById : remoteById;

  // 第一遍：首选顺序来源。只有该记录存活并被采纳时才标记 seen，
  // 否则交由第二遍在另一来源中寻找存活版本。
  const primary = orderPreference === 'remote' ? remote.conversations : local.conversations;
  const secondary = orderPreference === 'remote' ? local.conversations : remote.conversations;
  for (const conv of primary) {
    if (seen.has(conv.id)) continue;
    const other = otherById.get(conv.id);
    const winner = other && other.updatedAt > conv.updatedAt ? other : conv;
    if (isAlive(winner)) {
      merged.push(winner);
      seen.add(winner.id);
    }
  }

  // 第二遍：另一来源中尚未采纳的存活记录，保持其相对顺序追加
  for (const conv of secondary) {
    if (seen.has(conv.id)) continue;
    if (!isAlive(conv)) continue;
    merged.push(conv);
    seen.add(conv.id);
  }

  return { version: 1, conversations: merged, tombstones, clearedAt };
}

/**
 * 应用条数上限：超过 MAX_CONVERSATIONS 时淘汰 createdAt 最小（最旧）的记录。
 * 返回保留记录与被淘汰记录。淘汰只针对本次合并后的全集，顺序其余部分不变。
 */
export function applyCapacityLimit(envelope: ConversationEnvelope): {
  kept: ConversationEnvelope;
  evicted: Conversation[];
} {
  if (envelope.conversations.length <= MAX_CONVERSATIONS) {
    return { kept: envelope, evicted: [] };
  }

  const overflow = envelope.conversations.length - MAX_CONVERSATIONS;
  // 取 createdAt 最小的 overflow 条；同时间用 id 保证确定性
  const evictedIds = new Set(
    [...envelope.conversations]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(0, overflow)
      .map((c) => c.id)
  );

  const kept: Conversation[] = [];
  const evicted: Conversation[] = [];
  for (const conv of envelope.conversations) {
    if (evictedIds.has(conv.id)) {
      evicted.push(conv);
    } else {
      kept.push(conv);
    }
  }

  const now = Date.now();
  const tombstones = { ...envelope.tombstones };
  for (const conv of evicted) {
    tombstones[conv.id] = now;
  }

  return {
    kept: { ...envelope, conversations: kept, tombstones },
    evicted,
  };
}

/**
 * 持久化本地状态：先与磁盘最新内容合并（防止覆盖另一标签页的改动），
 * 再按条数上限淘汰最旧记录，最后写入。
 *
 * 容量不足（QuotaExceededError）时不吞错、不静默删数据，原样抛出，
 * 由调用方告知用户“这一条没有保存成功”并允许重新提交。
 */
export function commitConversations(local: ConversationEnvelope): CommitResult {
  const remote = readEnvelope();
  const merged = mergeForCommit(local, remote);
  const { kept, evicted } = applyCapacityLimit(merged);
  writeEnvelope(kept);
  return { envelope: kept, evicted };
}

/**
 * 追加删除墓碑并持久化（与磁盘状态合并，避免顶掉其他标签页的新增内容）。
 */
export function commitDeletions(
  local: ConversationEnvelope,
  deletedIds: string[]
): ConversationEnvelope {
  const remote = readEnvelope();
  const merged = mergeForCommit(local, remote);
  const now = Date.now();
  const tombstones = { ...merged.tombstones };
  for (const id of deletedIds) {
    tombstones[id] = now;
  }
  const conversations = merged.conversations.filter((c) => !tombstones[c.id]);
  const next: ConversationEnvelope = { ...merged, conversations, tombstones };
  writeEnvelope(next);
  return next;
}

/**
 * 清空全部对话：记录 clearedAt 时间戳（而非简单 removeItem），
 * 这样其他标签页里尚未落盘或晚于本页同步的旧记录也会被判定为已清空。
 */
export function commitClearAll(local: ConversationEnvelope): ConversationEnvelope {
  const remote = readEnvelope();
  const clearedAt = Date.now();
  const next: ConversationEnvelope = {
    version: 1,
    conversations: [],
    tombstones: { ...remote.tombstones, ...local.tombstones },
    clearedAt,
  };
  writeEnvelope(next);
  return next;
}

/**
 * 订阅其他标签页的对话存储变更。storage 事件只在“其他”标签页触发，
 * 不会形成回环。返回取消订阅函数。
 */
export function subscribeRemoteChanges(
  listener: (change: RemoteChange) => void
): () => void {
  if (typeof window === 'undefined' || !window.addEventListener) {
    return () => undefined;
  }

  const handler = (event: StorageEvent) => {
    if (event.key !== CONVERSATIONS_KEY || !event.newValue) return;
    try {
      const parsed: unknown = JSON.parse(event.newValue);
      if (isEnvelope(parsed)) {
        listener({ envelope: parsed });
      }
    } catch {
      // 忽略无法解析的存储内容
    }
  };

  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
