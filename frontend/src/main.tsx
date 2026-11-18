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
          // 「J · 岸雾暖光」视觉主题：只用主题 token 与全局 CSS 呈现，
          // 不涉及任何业务逻辑。回退方式见 git 分支 ui-preview-j。
          colorPrimary: '#2f6474',
          colorInfo: '#2f6474',
          colorSuccess: '#1f7a5c',
          colorWarning: '#c96f4a',
          colorError: '#b93c2f',
          colorLink: '#2f6474',
          colorTextBase: '#16262e',
          colorText: '#16262e',
          colorTextSecondary: '#4e636d',
          colorTextTertiary: '#6f838c',
          colorBorder: '#d3dde0',
          colorBorderSecondary: '#e4ecee',
          colorBgLayout: '#e9eef0',
          colorBgContainer: '#ffffff',
          borderRadius: 12,
          borderRadiusLG: 12,
          borderRadiusSM: 8,
          fontSize: 14,
          fontFamily:
            '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
        components: {
          Layout: {
            bodyBg: '#e9eef0',
            headerBg: '#ffffff',
            siderBg: '#ffffff',
          },
          Menu: {
            itemBorderRadius: 8,
            itemSelectedBg: '#e9f1f3',
            itemSelectedColor: '#2f6474',
            itemHoverBg: '#f2f6f7',
            darkItemBg: '#16262e',
            darkSubMenuItemBg: '#16262e',
            darkItemSelectedBg: '#2f6474',
            darkItemHoverBg: '#23404a',
          },
          Card: {
            headerBg: 'transparent',
            headerFontSize: 15,
          },
          Table: {
            headerBg: '#f2f6f7',
            headerColor: '#4e636d',
            headerSplitColor: '#d3dde0',
            borderColor: '#e4ecee',
            rowHoverBg: '#f6fafb',
          },
          Tabs: {
            itemSelectedColor: '#2f6474',
            itemHoverColor: '#2f6474',
            inkBarColor: '#2f6474',
          },
          Segmented: {
            itemSelectedBg: '#ffffff',
            itemSelectedColor: '#2f6474',
            trackBg: '#eef3f4',
          },
          Button: {
            primaryShadow: '0 3px 10px rgba(47,100,116,.18)',
            defaultShadow: 'none',
          },
          Statistic: {
            contentFontSize: 26,
            titleFontSize: 12,
          },
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
