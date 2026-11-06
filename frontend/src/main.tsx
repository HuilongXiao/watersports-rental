import React from 'react'
import ReactDOM from 'react-dom/client'
import { App as AntApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import 'dayjs/locale/zh-cn'
import dayjs from 'dayjs'
import App from './App'
import { AuthProvider } from './auth'
import { SettingsProvider } from './contexts/SettingsContext'
import { LayoutModeProvider } from './layoutMode'
import './index.css'

dayjs.locale('zh-cn')

// 前端耗时上报开关（存在 localStorage['enable_tracing']）。
// 手机浏览器没有控制台，用网址参数一次性设置最方便：
//   访问 /?tracing=1 开启并记住；/?tracing=0 关闭。
try {
  const tracing = new URLSearchParams(window.location.search).get('tracing')
  if (tracing === '1') {
    localStorage.setItem('enable_tracing', '1')
    console.log('[timing] 前端耗时上报已开启（访问 /?tracing=0 可关闭）')
  } else if (tracing === '0') {
    localStorage.removeItem('enable_tracing')
    console.log('[timing] 前端耗时上报已关闭')
  }
} catch {
  // 浏览器禁用本地存储时忽略，不影响应用启动
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#0e7a8c',
        },
      }}
    >
      <AntApp>
        <AuthProvider>
          {/* 全局设置 Context：须在 AuthProvider 内（依赖登录态与 activeGroup） */}
          <SettingsProvider>
            <LayoutModeProvider>
              <App />
            </LayoutModeProvider>
          </SettingsProvider>
        </AuthProvider>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
)
