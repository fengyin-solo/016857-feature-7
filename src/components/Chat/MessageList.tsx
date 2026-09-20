import { useEffect, useRef } from 'react';
import { Empty } from 'antd';
import { MessageOutlined } from '@ant-design/icons';
import type { Message } from '../../types';
import { MessageItem } from './MessageItem';
import './MessageList.css';

interface MessageListProps {
  messages: Message[];
  isStreaming: boolean;
  streamingMessageId: string | null;
  /** 本地未保存成功的消息 ID */
  unsavedMessageIds?: string[];
  /** 重新提交未保存成功的消息 */
  onRetryMessage?: (messageId: string) => void;
}

/**
 * 消息列表组件
 */
export function MessageList({
  messages,
  isStreaming,
  streamingMessageId,
  unsavedMessageIds = [],
  onRetryMessage,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isStreaming]);

  if (messages.length === 0) {
    return (
      <div className="message-list-empty">
        <Empty
          image={<MessageOutlined style={{ fontSize: 64, color: 'var(--color-text-tertiary)' }} />}
          description={
            <div className="empty-description">
              <h3>开始新对话</h3>
              <p>在下方输入框中输入消息，开始与 AI 对话</p>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="message-list" ref={listRef}>
      <div className="message-list-content">
        {messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            isStreaming={isStreaming && message.id === streamingMessageId}
            unsaved={unsavedMessageIds.includes(message.id)}
            onRetry={
              unsavedMessageIds.includes(message.id) && onRetryMessage
                ? () => onRetryMessage(message.id)
                : undefined
            }
          />
        ))}
      </div>
      <div ref={bottomRef} className="scroll-anchor" />
    </div>
  );
}
