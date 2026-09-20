import type { AppConfig, Conversation, PromptTemplate } from '../types';
import { DEFAULT_CONFIG, DEFAULT_TEMPLATES } from '../types';
import {
  commitConversations,
  readEnvelope,
  writeEnvelope,
} from './conversationRepository';

// Storage keys
const STORAGE_KEYS = {
  CONFIG: 'react-chat-config',
  CONVERSATIONS: 'react-chat-conversations',
  PROMPT_TEMPLATES: 'react-chat-prompt-templates',
} as const;

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
 * 保存对话列表到 localStorage
 *
 * 通过 conversationRepository 与磁盘最新内容合并后写入：多标签页场景下
 * 不会整体覆盖其他标签页的改动，已有记录的标题与时间也不会被改写。
 * 条数超限时由仓库层淘汰最旧记录；容量不足时抛出错误，由调用方提示。
 * @param conversations 对话列表
 */
export function saveConversations(conversations: Conversation[]): void {
  try {
    // 保留既有墓碑/清空标记，只替换对话列表
    const current = readEnvelope();
    commitConversations({ ...current, conversations });
  } catch (error) {
    console.error('Failed to save conversations:', error);
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new Error('存储空间不足，无法保存对话');
    }
    throw new Error('保存对话失败');
  }
}

/**
 * 从 localStorage 加载对话列表
 *
 * 不做任何重排：列表顺序与上次持久化时完全一致，
 * 刷新页面或返回后排列保持原样。
 * @returns 对话列表
 */
export function loadConversations(): Conversation[] {
  return readEnvelope().conversations;
}

/**
 * 清除所有对话
 */
export function clearConversations(): void {
  try {
    writeEnvelope({ version: 1, conversations: [], tombstones: {}, clearedAt: Date.now() });
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
export function exportData(): { config: AppConfig; conversations: Conversation[] } {
  return {
    config: loadConfig(),
    conversations: loadConversations(),
  };
}

/**
 * 导入数据
 * @param data 要导入的数据
 */
export function importData(data: { config?: AppConfig; conversations?: Conversation[] }): void {
  if (data.config) {
    saveConfig(data.config);
  }
  
  if (data.conversations) {
    saveConversations(data.conversations);
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
