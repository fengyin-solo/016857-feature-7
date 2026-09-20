import { Alert, Button } from 'antd';
import { useChatStore } from '../../stores/chatStore';
import './StorageNotices.css';

/**
 * 本地存储相关提示：
 * - 容量不足导致某条记录未保存成功时，常驻横幅提示并提供“重新保存”
 * - 达到条数上限淘汰最旧记录时，提醒一次（可关闭）
 */
export function StorageNotices() {
  const saveFailure = useChatStore((s) => s.saveFailure);
  const evictionNotice = useChatStore((s) => s.evictionNotice);
  const retrySave = useChatStore((s) => s.retrySave);
  const clearEvictionNotice = useChatStore((s) => s.clearEvictionNotice);

  if (!saveFailure && !evictionNotice) return null;

  return (
    <div className="storage-notices">
      {evictionNotice && (
        <Alert
          type="warning"
          showIcon
          className="storage-notices-item"
          message="已达到保存条数上限"
          description={`最旧的 ${evictionNotice.titles.length} 条对话已被自动淘汰：${evictionNotice.titles
            .slice(0, 3)
            .map((t) => `《${t}》`)
            .join('、')}${evictionNotice.titles.length > 3 ? ' 等' : ''}`}
          closable
          onClose={clearEvictionNotice}
        />
      )}

      {saveFailure && (
        <Alert
          type="error"
          showIcon
          className="storage-notices-item"
          message={saveFailure.error}
          description={
            <div className="storage-notices-retry">
              <span>《{saveFailure.title}》未写入本地存储，刷新后可能丢失。</span>
              <Button size="small" type="primary" onClick={() => retrySave()}>
                重新保存
              </Button>
            </div>
          }
        />
      )}
    </div>
  );
}
