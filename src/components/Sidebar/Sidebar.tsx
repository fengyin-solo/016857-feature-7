
import { Button, Popconfirm, Tooltip } from 'antd';
import { PlusOutlined, SettingOutlined, ClearOutlined } from '@ant-design/icons';
import { ConversationList } from './ConversationList';
import { StorageNotices } from './StorageNotices';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { MAX_CONVERSATIONS } from '../../services/conversationRepository';
import './Sidebar.css';

/**
 * 侧边栏组件
 */
export function Sidebar() {
  const {
    conversations,
    activeConversationId,
    createConversation,
    deleteConversation,
    setActiveConversation,
    clearAllConversations,
  } = useChatStore();

  const { setConfigPanelVisible, setMobileDrawerOpen } = useUIStore();

  const handleNewConversation = () => {
    createConversation();
    setMobileDrawerOpen(false);
  };

  const handleSelectConversation = (id: string) => {
    setActiveConversation(id);
    setMobileDrawerOpen(false);
  };

  const handleOpenSettings = () => {
    setConfigPanelVisible(true);
  };

  const handleClearAll = () => {
    clearAllConversations();
  };

  return (
    <div className="sidebar glass-card">
      <div className="sidebar-header">
        <h2 className="sidebar-title">对话历史</h2>
        <div className="sidebar-actions">
          <Popconfirm
            title="清空全部对话"
            description="确定要清空所有对话吗？此操作会同步到所有已打开的页面。"
            onConfirm={handleClearAll}
            okText="清空"
            cancelText="取消"
            placement="bottomRight"
            disabled={conversations.length === 0}
          >
            <Tooltip title="清空全部">
              <Button
                type="text"
                icon={<ClearOutlined />}
                disabled={conversations.length === 0}
              />
            </Tooltip>
          </Popconfirm>
          <Tooltip title="设置">
            <Button
              type="text"
              icon={<SettingOutlined />}
              onClick={handleOpenSettings}
            />
          </Tooltip>
        </div>
      </div>

      <div className="sidebar-new">
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleNewConversation}
          block
        >
          新建对话
        </Button>
      </div>

      <div className="sidebar-content">
        <ConversationList
          conversations={conversations}
          activeId={activeConversationId}
          onSelect={handleSelectConversation}
          onDelete={deleteConversation}
        />
      </div>

      <StorageNotices />

      <div className="sidebar-footer">
        <span className="sidebar-footer-text">
          共 {conversations.length} / {MAX_CONVERSATIONS} 个对话
        </span>
      </div>
    </div>
  );
}
