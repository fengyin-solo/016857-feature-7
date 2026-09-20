import { Component, useEffect, ErrorInfo, ReactNode } from 'react';
import { ConfigProvider, App as AntApp, Result, Button } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AppLayout } from './components/Layout';
import { bindNotifier } from './services/notifier';
import 'highlight.js/styles/github-dark.css';

// 错误边界组件
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Application error:', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ 
          height: '100vh', 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          background: '#f5f5f5'
        }}>
          <Result
            status="error"
            title="应用出错了"
            subTitle={this.state.error?.message || '发生了未知错误'}
            extra={
              <Button type="primary" onClick={this.handleReload}>
                重新加载
              </Button>
            }
          />
        </div>
      );
    }

    return this.props.children;
  }
}

// 主题配置
const theme = {
  token: {
    colorPrimary: '#6366f1',
    colorSuccess: '#10b981',
    colorWarning: '#f59e0b',
    colorError: '#ef4444',
    colorInfo: '#3b82f6',
    borderRadius: 8,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  components: {
    Button: {
      borderRadius: 8,
    },
    Input: {
      borderRadius: 8,
    },
    Select: {
      borderRadius: 8,
    },
    Card: {
      borderRadius: 12,
    },
  },
};

function App() {
  return (
    <ErrorBoundary>
      <ConfigProvider locale={zhCN} theme={theme}>
        <AntApp>
          <NotifierBinder />
          <AppLayout />
        </AntApp>
      </ConfigProvider>
    </ErrorBoundary>
  );
}

/**
 * 将 antd 的 message 实例注入到 store/service 层使用的全局通知器
 */
function NotifierBinder() {
  const { message } = AntApp.useApp();
  useEffect(() => {
    bindNotifier(message);
  }, [message]);
  return null;
}

export default App;
