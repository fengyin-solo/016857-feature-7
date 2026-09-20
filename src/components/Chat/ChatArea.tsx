import { useCallback } from 'react';
import { Alert, message } from 'antd';
import { MessageList } from './MessageList';
import { InputArea } from './InputArea';
import { useChatStore } from '../../stores/chatStore';
import { useConfigStore } from '../../stores/configStore';
import { sendMessageStream } from '../../services/api';
import { createStreamHandler, toMessageStats } from '../../services/stream';
import { parseError, logError, shouldShowConfigPanel } from '../../services/errorHandler';
import { useUIStore } from '../../stores/uiStore';
import type { APIMessage } from '../../types';
import './ChatArea.css';

// 创建流处理器实例
const streamHandler = createStreamHandler();

/**
 * 聊天区域主组件
 */
export function ChatArea() {
  const {
    activeConversationId,
    isStreaming,
    streamingMessageId,
    storageFull,
    unsavedMessageIds,
    getActiveConversation,
    addMessage,
    startStreaming,
    appendStreamContent,
    finishStreaming,
    cancelStreaming,
    createConversation,
    retryFailedSaves,
  } = useChatStore();

  const { config, isValid: isConfigValid } = useConfigStore();
  const { setConfigPanelVisible } = useUIStore();

  const conversation = getActiveConversation();
  const messages = conversation?.messages || [];

  /** 向 API 发起一次请求（消息此时已存在于本地对话中） */
  const requestAssistantReply = useCallback(
    async (conversationId: string, historyMessages: APIMessage[]) => {
      startStreaming(conversationId);

      try {
        const stream = sendMessageStream(historyMessages, {
          ...config,
          stream: true,
        });

        await streamHandler.start(stream, {
          onChunk: (chunk) => {
            appendStreamContent(chunk);
          },
          onComplete: (stats) => {
            finishStreaming(toMessageStats(stats));
          },
          onError: (error) => {
            const appError = parseError(error);
            logError(appError, 'ChatArea.handleSend');
            message.error(appError.message);
            cancelStreaming();

            if (shouldShowConfigPanel(appError)) {
              setConfigPanelVisible(true);
            }
          },
        });
      } catch (error) {
        const appError = parseError(error);
        logError(appError, 'ChatArea.handleSend');
        message.error(appError.message);
        cancelStreaming();

        if (shouldShowConfigPanel(appError)) {
          setConfigPanelVisible(true);
        }
      }
    },
    [
      config,
      startStreaming,
      appendStreamContent,
      finishStreaming,
      cancelStreaming,
      setConfigPanelVisible,
    ]
  );

  const handleSend = useCallback(
    async (content: string): Promise<boolean> => {
      if (!isConfigValid) {
        message.warning('请先配置 API Key');
        setConfigPanelVisible(true);
        return false;
      }

      // 如果没有活动对话，自动创建一个
      let conversationId = activeConversationId;
      if (!conversationId) {
        conversationId = createConversation();
      }

      // 获取当前对话的历史消息（在添加新消息之前）
      const stateBeforeAdd = useChatStore.getState();
      const currentConversation = stateBeforeAdd.conversations.find(c => c.id === conversationId);
      const historyMessages = currentConversation?.messages || [];

      // 添加用户消息；本地存储空间不足时明确告知这一条未保存，不发起请求，允许重新提交
      const { saved } = addMessage(conversationId, {
        role: 'user',
        content,
        status: 'complete',
      });
      if (!saved) {
        return false;
      }

      const apiMessages: APIMessage[] = [
        ...historyMessages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
        { role: 'user' as const, content },
      ];

      await requestAssistantReply(conversationId, apiMessages);
      return true;
    },
    [
      activeConversationId,
      isConfigValid,
      addMessage,
      createConversation,
      requestAssistantReply,
    ]
  );

  /**
   * 重新提交一条之前因存储空间不足而没保存成功的消息。
   * 先重试写入（成功后该消息已带着原 ID 与时间落盘）；
   * 对尚无后续助手回复的用户消息，重新向模型发起一次请求。
   */
  const handleRetryMessage = useCallback(
    async (messageId: string) => {
      if (!activeConversationId) return;

      const stateBefore = useChatStore.getState();
      const conv = stateBefore.conversations.find((c) => c.id === activeConversationId);
      const failedMessage = conv?.messages.find((m) => m.id === messageId);
      if (!failedMessage) return;

      const ok = retryFailedSaves();
      if (!ok) return;

      if (failedMessage.role !== 'user') return;

      // 若后面已经有助手回复，说明请求已完成，仅补保存即可，不再重复请求
      const idx = conv!.messages.findIndex((m) => m.id === messageId);
      const hasAssistantAfter = conv!.messages
        .slice(idx + 1)
        .some((m) => m.role === 'assistant');

      if (!hasAssistantAfter) {
        const apiMessages: APIMessage[] = [
          ...conv!.messages
            .slice(0, idx)
            .map((m) => ({ role: m.role, content: m.content })),
          { role: 'user' as const, content: failedMessage.content },
        ];
        await requestAssistantReply(activeConversationId, apiMessages);
      }
    },
    [activeConversationId, retryFailedSaves, requestAssistantReply]
  );

  const handleStop = useCallback(() => {
    streamHandler.abort();
    cancelStreaming();
  }, [cancelStreaming]);

  return (
    <div className="chat-area">
      {storageFull && (
        <Alert
          type="error"
          showIcon
          banner
          message="本地存储空间不足，最近的消息没有保存成功"
          description="可在侧边栏删除部分旧对话后，点击对应消息上的“重新提交”。"
        />
      )}
      <MessageList
        messages={messages}
        isStreaming={isStreaming}
        streamingMessageId={streamingMessageId}
        unsavedMessageIds={unsavedMessageIds}
        onRetryMessage={handleRetryMessage}
      />
      <InputArea
        onSend={handleSend}
        onStop={handleStop}
        isLoading={false}
        isStreaming={isStreaming}
        disabled={false}
      />
    </div>
  );
}
