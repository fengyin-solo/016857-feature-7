import type { AppConfig, Conversation, ConversationStoreData, ConversationTombstone, PromptTemplate } from '../types';
import { DEFAULT_CONFIG, DEFAULT_TEMPLATES } from '../types';
import {
  createEmptyStoreData,
  isValidConversation,
  pruneTombstones,
} from './conversationSync';

/** 对话存储使用的 localStorage key（跨标签页 storage 事件据此过滤） */
export const CONVERSATIONS_STORAGE_KEY = 'react-chat-conversations';

// Storage keys
const STORAGE_KEYS = {
  CONFIG: 'react-chat-config',
  CONVERSATIONS: CONVERSATIONS_STORAGE_KEY,
  PROMPT_TEMPLATES: 'react-chat-prompt-templates',
} as const;

/** 本地存储结构版本 */
const CONVERSATION_STORE_VERSION = 2 as const;

/**
 * 存储空间不足错误。
 * 调用方据此明确告知用户"这一条没有保存成功"，并允许重新提交。
 */
export class StorageQuotaError extends Error {
  constructor(message: string = '本地存储空间不足') {
    super(message);
    this.name = 'StorageQuotaError';
  }
}

/** 判断一个异常是否为浏览器存储配额耗尽 */
export function isQuotaExceededError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException) {
    // QuotaExceededError 的 name 在各浏览器中基本稳定
    return (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22 ||
      error.code === 1014
    );
  }
  return error instanceof StorageQuotaError;
}

/**
 * 简单的加密函数（Base64 + 字符偏移）
 * 注意：这不是真正的加密，只是简单的混淆，防止明文存储
 */
function encrypt(text: string): string {
  if (!text) return '';
  
  // 先进行字符偏移
  const shifted = text
    .split('')
    .map(char => String.fromCharCode(char.charCodeAt(0) + 3))
    .join('');
  
  // 然后 Base64 编码
  return btoa(encodeURIComponent(shifted));
}

/**
 * 解密函数
 */
function decrypt(encoded: string): string {
  if (!encoded) return '';
  
  try {
    // 先 Base64 解码
    const shifted = decodeURIComponent(atob(encoded));
    
    // 然后字符偏移还原
    return shifted
      .split('')
      .map(char => String.fromCharCode(char.charCodeAt(0) - 3))
      .join('');
  } catch {
    return '';
  }
}

/**
 * 保存配置到 localStorage
 * @param config 应用配置
 */
export function saveConfig(config: AppConfig): void {
  try {
    // 加密 API Key
    const configToSave = {
      ...config,
      apiKey: encrypt(config.apiKey),
    };
    
    localStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(configToSave));
  } catch (error) {
    console.error('Failed to save config:', error);
    throw new Error('保存配置失败');
  }
}

/**
 * 从 localStorage 加载配置
 * @returns 应用配置，如果不存在则返回默认配置
 */
export function loadConfig(): AppConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.CONFIG);
    
    if (!stored) {
      return DEFAULT_CONFIG;
    }
    
    const parsed = JSON.parse(stored) as AppConfig;
    
    // 解密 API Key
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      apiKey: decrypt(parsed.apiKey),
    };
  } catch (error) {
    console.error('Failed to load config:', error);
    return DEFAULT_CONFIG;
  }
}

/**
 * 清除配置
 */
export function clearConfig(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.CONFIG);
  } catch (error) {
    console.error('Failed to clear config:', error);
  }
}

/**
 * 保存对话存储（v2 信封：对话 + 删除墓碑 + 清空标记）到 localStorage。
 * 不再静默丢弃数据；空间不足时抛出 StorageQuotaError，由上层提示并允许重试。
 * @param data 对话存储数据
 */
export function saveConversations(data: ConversationStoreData): void {
  try {
    const payload: ConversationStoreData = {
      version: CONVERSATION_STORE_VERSION,
      conversations: data.conversations,
      tombstones: pruneTombstones(data.tombstones),
      clearedAt: data.clearedAt,
    };
    localStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(payload));
  } catch (error) {
    console.error('Failed to save conversations:', error);
    if (isQuotaExceededError(error)) {
      throw new StorageQuotaError('存储空间不足，这一条没有保存成功，请删除部分旧对话后重新提交');
    }
    throw new Error('保存对话失败');
  }
}

/**
 * 从 localStorage 加载对话存储。
 * 兼容旧版（v1：裸数组）结构；保留存储时的原始排列顺序，不做重排。
 * @returns 对话存储数据
 */
export function loadConversations(): ConversationStoreData {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.CONVERSATIONS);

    if (!stored) {
      return createEmptyStoreData();
    }

    const parsed: unknown = JSON.parse(stored);

    // 旧版数据迁移：裸数组 → v2 信封
    if (Array.isArray(parsed)) {
      const conversations = (parsed as unknown[]).filter(isValidConversation);
      return {
        version: CONVERSATION_STORE_VERSION,
        conversations,
        tombstones: [],
        clearedAt: null,
      };
    }

    // v2 信封
    if (parsed && typeof parsed === 'object') {
      const envelope = parsed as Partial<ConversationStoreData>;
      const conversations = Array.isArray(envelope.conversations)
        ? envelope.conversations.filter(isValidConversation)
        : [];
      const tombstones = Array.isArray(envelope.tombstones)
        ? envelope.tombstones.filter(
            (t): t is ConversationTombstone =>
              !!t &&
              typeof (t as { id?: unknown }).id === 'string' &&
              typeof (t as { deletedAt?: unknown }).deletedAt === 'number',
          )
        : [];
      return {
        version: CONVERSATION_STORE_VERSION,
        conversations,
        tombstones: pruneTombstones(tombstones),
        clearedAt: typeof envelope.clearedAt === 'number' ? envelope.clearedAt : null,
      };
    }

    return createEmptyStoreData();
  } catch (error) {
    console.error('Failed to load conversations:', error);
    return createEmptyStoreData();
  }
}

/**
 * 清除所有对话
 */
export function clearConversations(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.CONVERSATIONS);
  } catch (error) {
    console.error('Failed to clear conversations:', error);
  }
}

/**
 * 清除所有存储数据
 */
export function clearAllStorage(): void {
  clearConfig();
  clearConversations();
}

/**
 * 获取存储使用情况
 * @returns 存储使用信息
 */
export function getStorageUsage(): { used: number; available: number } {
  let used = 0;
  
  try {
    for (const key of Object.values(STORAGE_KEYS)) {
      const item = localStorage.getItem(key);
      if (item) {
        used += item.length * 2; // UTF-16 编码，每个字符 2 字节
      }
    }
  } catch {
    // 忽略错误
  }
  
  // localStorage 通常限制为 5MB
  const available = 5 * 1024 * 1024 - used;
  
  return { used, available: Math.max(0, available) };
}

/**
 * 导出所有数据
 * @returns 导出的数据对象
 */
export function exportData(): { config: AppConfig; conversations: ConversationStoreData } {
  return {
    config: loadConfig(),
    conversations: loadConversations(),
  };
}

/**
 * 导入数据
 * @param data 要导入的数据
 */
export function importData(data: {
  config?: AppConfig;
  conversations?: ConversationStoreData | Conversation[];
}): void {
  if (data.config) {
    saveConfig(data.config);
  }

  if (data.conversations) {
    if (Array.isArray(data.conversations)) {
      // 兼容旧版裸数组
      saveConversations({
        version: 2,
        conversations: data.conversations.filter(isValidConversation),
        tombstones: [],
        clearedAt: null,
      });
    } else {
      saveConversations(data.conversations);
    }
  }
}

/**
 * 生成默认提示词模板
 * @returns 默认模板列表
 */
function generateDefaultTemplates(): PromptTemplate[] {
  const now = Date.now();
  return DEFAULT_TEMPLATES.map((template, index) => ({
    ...template,
    id: `default-${index}`,
    createdAt: now,
    updatedAt: now,
  }));
}

/**
 * 保存提示词模板到 localStorage
 * @param templates 模板列表
 */
export function savePromptTemplates(templates: PromptTemplate[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.PROMPT_TEMPLATES, JSON.stringify(templates));
  } catch (error) {
    console.error('Failed to save prompt templates:', error);
    throw new Error('保存提示词模板失败');
  }
}

/**
 * 从 localStorage 加载提示词模板
 * @returns 模板列表，如果不存在则返回默认模板
 */
export function loadPromptTemplates(): PromptTemplate[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.PROMPT_TEMPLATES);
    
    if (!stored) {
      const defaultTemplates = generateDefaultTemplates();
      savePromptTemplates(defaultTemplates);
      return defaultTemplates;
    }
    
    const parsed = JSON.parse(stored) as PromptTemplate[];
    
    if (!Array.isArray(parsed)) {
      const defaultTemplates = generateDefaultTemplates();
      savePromptTemplates(defaultTemplates);
      return defaultTemplates;
    }
    
    return parsed
      .filter(t => t && t.id && t.name && t.content)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (error) {
    console.error('Failed to load prompt templates:', error);
    return generateDefaultTemplates();
  }
}

/**
 * 清除所有提示词模板
 */
export function clearPromptTemplates(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.PROMPT_TEMPLATES);
  } catch (error) {
    console.error('Failed to clear prompt templates:', error);
  }
}

/**
 * 重置为默认提示词模板
 * @returns 重置后的模板列表
 */
export function resetPromptTemplates(): PromptTemplate[] {
  const defaultTemplates = generateDefaultTemplates();
  savePromptTemplates(defaultTemplates);
  return defaultTemplates;
}
