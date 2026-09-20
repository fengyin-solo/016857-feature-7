import { beforeEach, vi } from 'vitest'

/**
 * 内存版 localStorage（基于原型方法实现，便于测试中 vi.spyOn 模拟配额错误）
 */
class MemoryStorage implements Storage {
  private store: Record<string, string> = {}

  get length(): number {
    return Object.keys(this.store).length
  }

  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key]! : null
  }

  setItem(key: string, value: string): void {
    this.store[key] = String(value)
  }

  removeItem(key: string): void {
    delete this.store[key]
  }

  clear(): void {
    this.store = {}
  }

  key(index: number): string | null {
    return Object.keys(this.store)[index] ?? null
  }
}

const localStorageMock = new MemoryStorage()

// 暴露到全局，便于测试中通过 vi.spyOn 模拟配额错误
;(globalThis as Record<string, unknown>).MemoryStorage = MemoryStorage
;(globalThis as Record<string, unknown>).__localStorageMock = localStorageMock

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  configurable: true,
  writable: true,
})

Object.defineProperty(globalThis, 'window', {
  value: {
    localStorage: localStorageMock,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
  configurable: true,
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
})
