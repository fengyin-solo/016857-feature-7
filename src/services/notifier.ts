/**
 * 全局通知器。
 *
 * store / service 层需要在淘汰、保存失败等时机给出一次性提示，
 * 但这些代码运行在 React 组件之外，无法使用 App.useApp() 的上下文实例。
 * UI 层在挂载时通过 bindNotifier 注入 antd 的 message 实例；
 * 未注入时（如单元测试环境）安全降级为 console，不抛异常。
 */

export type NoticeType = 'info' | 'success' | 'warning' | 'error';

interface NoticeApi {
  info: (content: string) => void;
  success: (content: string) => void;
  warning: (content: string) => void;
  error: (content: string) => void;
}

let boundApi: NoticeApi | null = null;

/** 由 UI 层注入 antd message 实例 */
export function bindNotifier(api: NoticeApi): void {
  boundApi = api;
}

function fallback(type: NoticeType, content: string): void {
  const fn =
    type === 'error'
      ? console.error
      : type === 'warning'
        ? console.warn
        : console.log;
  fn(`[notice:${type}] ${content}`);
}

/** 发送一条全局提示 */
export function notify(type: NoticeType, content: string): void {
  if (boundApi) {
    boundApi[type](content);
  } else {
    fallback(type, content);
  }
}
