import React from 'react'
import ReactDOM from 'react-dom/client'
import { App as AntApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import 'dayjs/locale/zh-cn'
import dayjs from 'dayjs'
import App from './App'
import { AuthProvider } from './auth'
import { SettingsProvider } from './contexts/SettingsContext'
import './index.css'

dayjs.locale('zh-cn')

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
            <App />
          </SettingsProvider>
        </AuthProvider>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
)
