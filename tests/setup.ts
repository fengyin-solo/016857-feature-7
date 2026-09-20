import { afterEach, vi } from 'vitest'

type StorageListener = (event: {
  key: string | null
  oldValue: string | null
  newValue: string | null
}) => void

/**
 * 可控的 localStorage mock：
 * - 支持通过 __setQuota 模拟容量配额
 * - 支持 __otherTabSetItem / __otherTabRemoveItem 模拟“另一个标签页”的写入，
 *   写入会更新共享存储并派发 storage 事件（本页直接 setItem 不触发，与浏览器一致）
 *
 * 监听集合定义在 setup 模块作用域（setup 不参与 vi.resetModules），
 * 因此即使被测模块被重置，旧 store 残留的监听也能在 afterEach 中被统一清空。
 */
const storageListeners = new Set<StorageListener>()

export interface MockLocalStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
  clear: () => void
  key: (index: number) => string | null
  readonly length: number
  /** 模拟容量配额（字节），null 表示不限 */
  __setQuota: (bytes: number | null) => void
  /** 模拟另一标签页写入（会派发 storage 事件） */
  __otherTabSetItem: (key: string, value: string) => void
  /** 模拟另一标签页删除（会派发 storage 事件） */
  __otherTabRemoveItem: (key: string) => void
  /** 模拟另一标签页清空（会派发 storage 事件） */
  __otherTabClear: () => void
  /** 清空 storage 事件监听（测试隔离用） */
  __clearListeners: () => void
}

const localStorageMock: MockLocalStorage = (() => {
  let store: Record<string, string> = {}
  let quota: number | null = null

  const dispatch = (
    key: string | null,
    oldValue: string | null,
    newValue: string | null
  ) => {
    for (const listener of [...storageListeners]) {
      listener({ key, oldValue, newValue })
    }
  }

  const usedBytes = () =>
    Object.values(store).reduce((sum, value) => sum + value.length * 2, 0)

  const makeQuotaError = () => {
    const error = new Error('The quota has been exceeded.')
    error.name = 'QuotaExceededError'
    return error
  }

  return {
    getItem: (key: string) =>
      Object.prototype.hasOwnProperty.call(store, key) ? store[key]! : null,
    setItem: (key: string, value: string) => {
      const serialized = String(value)
      const incoming = serialized.length * 2
      const replacing = store[key] ? store[key].length * 2 : 0
      if (quota !== null && usedBytes() - replacing + incoming > quota) {
        throw makeQuotaError()
      }
      store[key] = serialized
      // 本页写入不派发 storage 事件（浏览器行为）
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      store = {}
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
    get length() {
      return Object.keys(store).length
    },

    // —— 测试辅助方法 ——
    __setQuota(bytes: number | null) {
      quota = bytes
    },
    __otherTabSetItem(key: string, value: string) {
      const oldValue = store[key] ?? null
      store[key] = String(value)
      dispatch(key, oldValue, String(value))
    },
    __otherTabRemoveItem(key: string) {
      const oldValue = store[key] ?? null
      delete store[key]
      dispatch(key, oldValue, null)
    },
    __otherTabClear() {
      store = {}
      dispatch(null, null, null)
    },
    __clearListeners() {
      storageListeners.clear()
    },
  }
})()

const windowMock = {
  localStorage: localStorageMock,
  addEventListener: (_type: string, listener: StorageListener) => {
    storageListeners.add(listener)
  },
  removeEventListener: (_type: string, listener: StorageListener) => {
    storageListeners.delete(listener)
  },
  innerWidth: 1280,
}

globalThis.window = windowMock as unknown as Window & typeof globalThis
globalThis.localStorage = localStorageMock as unknown as Storage

// btoa / atob（storage.ts 配置加密使用）
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (str: string) => Buffer.from(str, 'binary').toString('base64')
  globalThis.atob = (str: string) => Buffer.from(str, 'base64').toString('binary')
}

afterEach(() => {
  localStorage.clear()
  localStorageMock.__setQuota(null)
  localStorageMock.__clearListeners()
  vi.useRealTimers()
})

// 供测试直接以类型安全的方式访问 mock 辅助方法
declare global {
  // eslint-disable-next-line no-var
  var mockLocalStorage: MockLocalStorage
}
globalThis.mockLocalStorage = localStorageMock

export { localStorageMock }
