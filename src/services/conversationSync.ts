import type {
  Conversation,
  ConversationStoreData,
  ConversationTombstone,
  Message,
} from '../types';

/** 本地保存的对话条数上限，达到上限时淘汰最旧的 */
export const MAX_CONVERSATIONS = 100;

/**
 * 墓碑数量上限。
 * 不按时间过期：只要其他标签页还可能拿着旧快照，墓碑就需要保留，
 * 否则已删除对话可能被"复活"。数量达到上限时保留最近删除的若干条。
 */
export const MAX_TOMBSTONES = 500;

/** 消息状态的优先级：终态优先于流式态，流式态优先于挂起态 */
const MESSAGE_STATUS_RANK: Record<Message['status'], number> = {
  complete: 4,
  error: 3,
  streaming: 2,
  pending: 1,
};

/** 判定一个对象是否为结构合法的对话（尽量宽松，保证旧数据可迁移） */
export function isValidConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== 'object') return false;
  const conv = value as Record<string, unknown>;
  return (
    typeof conv.id === 'string' &&
    conv.id.length > 0 &&
    Array.isArray(conv.messages) &&
    typeof conv.title === 'string' &&
    typeof conv.createdAt === 'number' &&
    typeof conv.updatedAt === 'number'
  );
}

function isValidMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const msg = value as Record<string, unknown>;
  return (
    typeof msg.id === 'string' &&
    msg.id.length > 0 &&
    typeof msg.content === 'string' &&
    typeof msg.timestamp === 'number' &&
    typeof msg.role === 'string'
  );
}

/**
 * 合并同一条消息的两个版本。
 * 规则：已有记录的时间戳永不被改动（取更早值，正常同步中两者本就相等）；
 * 终态内容优先（流到一半的版本不会覆盖已完成的版本），
 * 状态相同时保留内容更完整的一方；合并不会修改入参对象。
 */
export function mergeMessage(existing: Message, incoming: Message): Message {
  const timestamp = Math.min(existing.timestamp, incoming.timestamp);
  const existingRank = MESSAGE_STATUS_RANK[existing.status] ?? 0;
  const incomingRank = MESSAGE_STATUS_RANK[incoming.status] ?? 0;

  let winner: Message;
  if (incomingRank > existingRank) {
    winner = incoming;
  } else if (incomingRank < existingRank) {
    winner = existing;
  } else if (incoming.content.length > existing.content.length) {
    // 状态等级相同时，内容更长的一方更完整
    winner = incoming;
  } else {
    winner = existing;
  }

  return winner.timestamp === timestamp ? winner : { ...winner, timestamp };
}

/**
 * 合并两个对话内的消息数组（按消息 ID 去重，未知消息按时间顺序插入）。
 */
export function mergeMessages(
  existingMessages: Message[],
  incomingMessages: Message[],
): Message[] {
  const merged = new Map<string, Message>();
  for (const msg of existingMessages) {
    if (isValidMessage(msg)) merged.set(msg.id, msg);
  }
  for (const msg of incomingMessages) {
    if (!isValidMessage(msg)) continue;
    const current = merged.get(msg.id);
    merged.set(msg.id, current ? mergeMessage(current, msg) : msg);
  }

  // 已知消息保持各自在列表中的相对位置；仅未知的新消息按时间戳插入
  const knownIds = new Set(existingMessages.map((m) => m.id));
  const result: Message[] = existingMessages
    .filter((m) => isValidMessage(m) && merged.has(m.id))
    .map((m) => merged.get(m.id) as Message);

  const newMessages = incomingMessages.filter(
    (m) => isValidMessage(m) && !knownIds.has(m.id),
  );
  for (const msg of newMessages) {
    const insertAt = result.findIndex((m) => m.timestamp > msg.timestamp);
    if (insertAt === -1) {
      result.push(msg);
    } else {
      result.splice(insertAt, 0, msg);
    }
  }
  return result;
}

/**
 * 合并同一条对话的两个版本。
 * 关键约束：已存在对话的标题与创建时间不会被改动（先写入者为准）；
 * updatedAt 取较大值表示最近活动；消息做追加式合并。
 */
export function mergeConversation(
  existing: Conversation,
  incoming: Conversation,
): Conversation {
  const messages = mergeMessages(existing.messages, incoming.messages);
  return {
    id: existing.id,
    title: existing.title,
    createdAt: Math.min(existing.createdAt, incoming.createdAt),
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
    messages,
  };
}

/**
 * 按创建时间降序排列对话（相同时间用 id 保证确定性）。
 * 仅用于跨标签页合入"本地未知"的新对话时决定插入位置，不会打乱已有对话的相对顺序。
 */
function conversationOrderValue(conv: Conversation): [number, string] {
  return [-conv.createdAt, conv.id];
}

function compareOrderValue(a: [number, string], b: [number, string]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

/**
 * 合并两个对话数组：
 * - 本地已有对话保持原来的相对位置，只做内容合并；
 * - 本地没有的对话按创建时间降序插入到合适位置，保证多个标签页最终顺序一致。
 */
export function mergeConversationLists(
  local: Conversation[],
  remote: Conversation[],
): Conversation[] {
  const byId = new Map<string, Conversation>();
  for (const conv of local) {
    if (isValidConversation(conv)) byId.set(conv.id, conv);
  }

  // 先合并双方都存在的对话（消息追加、标题/创建时间保持先写入者）
  for (const remoteConv of remote) {
    if (!isValidConversation(remoteConv)) continue;
    const localConv = byId.get(remoteConv.id);
    if (localConv) {
      byId.set(remoteConv.id, mergeConversation(localConv, remoteConv));
    }
  }

  const result: Conversation[] = local
    .filter((c) => isValidConversation(c))
    .map((c) => byId.get(c.id) as Conversation);

  // 本地未知的远程对话先统一按创建时间降序排序，再依次插入；
  // 这样新对话之间的相对顺序也是确定的
  const remoteOnly = remote
    .filter((remoteConv) => isValidConversation(remoteConv) && !local.some((l) => l.id === remoteConv.id))
    .sort((a, b) => compareOrderValue(conversationOrderValue(a), conversationOrderValue(b)));

  for (const remoteConv of remoteOnly) {
    const remoteValue = conversationOrderValue(remoteConv);
    const insertAt = result.findIndex(
      (c) => compareOrderValue(conversationOrderValue(c), remoteValue) > 0,
    );
    if (insertAt === -1) {
      result.push(remoteConv);
    } else {
      result.splice(insertAt, 0, remoteConv);
    }
    byId.set(remoteConv.id, remoteConv);
  }

  return result;
}

/** 清理超额墓碑（按删除时间倒序保留最近的 MAX_TOMBSTONES 条） */
export function pruneTombstones(
  tombstones: ConversationTombstone[],
): ConversationTombstone[] {
  return tombstones
    .filter((t) => t && typeof t.id === 'string' && typeof t.deletedAt === 'number')
    .slice()
    .sort((a, b) => b.deletedAt - a.deletedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_TOMBSTONES);
}

/**
 * 合并两个标签页的持久化数据。
 * - 删除（墓碑）与清空（clearedAt）对双方都生效，不会被另一边的旧数据复活；
 * - 已有记录的标题与创建时间保持先写入者不变。
 */
export function mergeConversationData(
  local: ConversationStoreData,
  remote: ConversationStoreData,
): ConversationStoreData {
  const clearedAt =
    local.clearedAt === null
      ? remote.clearedAt
      : remote.clearedAt === null
        ? local.clearedAt
        : Math.max(local.clearedAt, remote.clearedAt);

  // 先取双方墓碑并集，再连同 clearedAt 一起过滤掉已删除/已清空的对话
  const tombstoneMap = new Map<string, ConversationTombstone>();
  for (const t of local.tombstones) {
    if (t && typeof t.id === 'string') tombstoneMap.set(t.id, t);
  }
  for (const t of remote.tombstones) {
    if (t && typeof t.id !== 'string') continue;
    const current = tombstoneMap.get(t.id);
    if (!current || t.deletedAt > current.deletedAt) {
      tombstoneMap.set(t.id, t);
    }
  }

  // 删除集（墓碑并集 + 最近一次清空时刻）对双方对话都生效：
  // 对话取并集——任一方新建的对话都保留；仅当某对话在删除集中时才移除。
  // 这样既不会因"远程信封里没有本地新对话"而误删（并集保留），
  // 也不会让对方尚未同步的删除被旧数据复活。
  const isRemoved = (conv: Conversation): boolean => {
    if (tombstoneMap.has(conv.id)) return true;
    if (clearedAt !== null && conv.createdAt <= clearedAt) return true;
    return false;
  };

  const conversations = mergeConversationLists(
    local.conversations.filter((c) => !isRemoved(c)),
    remote.conversations.filter((c) => !isRemoved(c)),
  );

  return {
    version: 2,
    conversations,
    tombstones: pruneTombstones([...tombstoneMap.values()]),
    clearedAt,
  };
}

/** 判定一个对话是否仍处于流式响应过程中（不能被自动淘汰） */
function isConversationInFlight(conv: Conversation): boolean {
  return conv.messages.some((m) => m.status === 'streaming' || m.status === 'pending');
}

export interface ApplyLimitOptions {
  /** 条数上限，默认 MAX_CONVERSATIONS */
  limit?: number;
  /** 受保护不被淘汰的对话 ID（如当前活动对话、正在响应的对话） */
  protectedIds?: string[];
}

/**
 * 应用条数上限：超出 limit 时按创建时间淘汰最旧的对话，
 * 正在流式响应或显式受保护的对话不参与淘汰。
 * @returns 被淘汰掉的对话列表（用于生成墓碑与提示）
 */
export function applyConversationLimit(
  data: ConversationStoreData,
  options: ApplyLimitOptions = {},
): { data: ConversationStoreData; evicted: Conversation[] } {
  const limit = options.limit ?? MAX_CONVERSATIONS;
  const protectedIds = new Set(options.protectedIds ?? []);
  const excess = data.conversations.length - limit;
  if (excess <= 0) return { data, evicted: [] };

  // 可淘汰对象按创建时间从旧到新排列；
  // 时间戳相同时，按其在列表中的位置决胜——列表越靠后创建得越早（新建总是前插）
  const indexMap = new Map(data.conversations.map((c, i) => [c.id, i]));
  const evictable = data.conversations
    .filter((c) => !protectedIds.has(c.id) && !isConversationInFlight(c))
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return (indexMap.get(b.id) ?? 0) - (indexMap.get(a.id) ?? 0);
    });

  const evicted = evictable.slice(0, excess);
  const evictedIds = new Set(evicted.map((c) => c.id));
  if (evicted.length === 0) return { data, evicted: [] };

  const tombstoneMap = new Map<string, ConversationTombstone>(
    data.tombstones.map((t) => [t.id, t]),
  );
  for (const conv of evicted) {
    tombstoneMap.set(conv.id, { id: conv.id, deletedAt: Date.now() });
  }

  return {
    data: {
      ...data,
      conversations: data.conversations.filter((c) => !evictedIds.has(c.id)),
      tombstones: pruneTombstones([...tombstoneMap.values()]),
    },
    evicted,
  };
}

/** 构造一份空的 v2 存储结构 */
export function createEmptyStoreData(): ConversationStoreData {
  return {
    version: 2,
    conversations: [],
    tombstones: [],
    clearedAt: null,
  };
}
