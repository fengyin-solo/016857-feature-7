import { memo } from 'react';
import { Avatar, Button, Tooltip } from 'antd';
import { UserOutlined, RobotOutlined, RedoOutlined } from '@ant-design/icons';
import type { Message } from '../../types';
import { MarkdownRenderer } from '../Common/MarkdownRenderer';
import { CopyButton } from '../Common/CopyButton';
import { TypingIndicator } from '../Common/LoadingIndicator';
import { formatResponseTime, formatTokenCount } from '../../utils/formatters';
import './MessageItem.css';

interface MessageItemProps {
  message: Message;
  isStreaming?: boolean;
  /** 该条是否因存储空间不足而未保存成功 */
  unsaved?: boolean;
  /** 重新提交（仅未保存成功的消息展示） */
  onRetry?: () => void;
}

/**
 * 消息项组件
 */
export const MessageItem = memo(function MessageItem({
  message,
  isStreaming = false,
  unsaved = false,
  onRetry,
}: MessageItemProps) {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const showStats = isAssistant && message.status === 'complete' && message.stats;

  return (
    <div className={`message-item ${isUser ? 'user' : 'assistant'} animate-fadeInUp`}>
      <div className="message-avatar">
        <Avatar
          size={36}
          icon={isUser ? <UserOutlined /> : <RobotOutlined />}
          style={{
            backgroundColor: isUser ? 'var(--color-primary)' : 'var(--color-bg-tertiary)',
            color: isUser ? 'white' : 'var(--color-text-secondary)',
          }}
        />
      </div>

      <div className="message-content-wrapper">
        <div className={`message-bubble ${message.status}${unsaved ? ' unsaved' : ''}`}>
          {isStreaming && message.status === 'streaming' && !message.content ? (
            <TypingIndicator />
          ) : (
            <div className="message-content">
              {isUser ? (
                <p>{message.content}</p>
              ) : (
                <MarkdownRenderer content={message.content} />
              )}
            </div>
          )}

          {unsaved && (
            <div className="message-unsaved">
              <span className="message-unsaved-text">
                存储空间不足，这一条没有保存成功
              </span>
              {onRetry && (
                <Tooltip title="重新提交">
                  <Button
                    size="small"
                    danger
                    type="primary"
                    icon={<RedoOutlined />}
                    onClick={onRetry}
                  >
                    重新提交
                  </Button>
                </Tooltip>
              )}
            </div>
          )}

          {message.status === 'error' && !unsaved && (
            <div className="message-error">
              <span>消息发送失败</span>
            </div>
          )}
        </div>

        <div className="message-footer">
          {showStats && message.stats && (
            <div className="message-stats">
              <span className="stat-item">
                {formatResponseTime(message.stats.responseTime)}
              </span>
              <span className="stat-divider">·</span>
              <span className="stat-item">
                {formatTokenCount(message.stats.tokenCount)} tokens
              </span>
            </div>
          )}

          {isAssistant && message.content && message.status === 'complete' && (
            <div className="message-actions">
              <CopyButton text={message.content} size="small" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
