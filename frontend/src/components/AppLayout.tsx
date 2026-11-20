import { useMemo, useState, type ReactNode } from 'react'
import { App, Layout, Menu, Dropdown, Typography, Modal, Input, Select, Tag, Popover } from 'antd'
import {
  DashboardOutlined,
  TeamOutlined,
  SettingOutlined,
  LogoutOutlined,
  PlusOutlined,
  KeyOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { useLayoutMode } from '../layoutMode'
import WeatherCard from './WeatherCard'
import OrderForm from '../pages/OrderForm'

const { Header, Sider, Content } = Layout

export default function AppLayout() {
  const { user, logout, activeGroup, activeGroupName, setActiveGroup, groups } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { isMobile } = useLayoutMode()
  const { message } = App.useApp()
  const [pwdOpen, setPwdOpen] = useState(false)
  const [pwdLoading, setPwdLoading] = useState(false)
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [groupOpen, setGroupOpen] = useState(false)
  const [pendingGroupId, setPendingGroupId] = useState<string | null>(activeGroup)
  // 点击“订单管理”菜单时，若已在订单页则递增此值，通知 Orders 组件重置为预订 tab 并回到顶部
  const [ordersRefreshKey, setOrdersRefreshKey] = useState(0)
  // 桌面侧栏「创建订单」气泡
  const [quickCreateOpen, setQuickCreateOpen] = useState(false)

  // 气泡内可能打开 Select / 日期 / 弹窗（都渲染在 body 上的独立浮层），
  // 点击这些浮层时不应把创建订单气泡一起关掉
  const handleQuickCreateOpenChange = (next: boolean) => {
    if (next) {
      setQuickCreateOpen(true)
      return
    }
    const hasOpenPortal = Array.from(
      document.querySelectorAll('.ant-select-dropdown, .ant-picker-dropdown, .ant-modal-wrap'),
    ).some((el) => {
      const style = window.getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden'
    })
    if (!hasOpenPortal) setQuickCreateOpen(false)
  }

  const handleNav = (key: string) => {
    // 仅在订单列表页本身再次点击「订单」时刷新重置；
    // 处于订单子页面（详情 / 新建）时点击「订单」应回到订单列表。
    if (key === '/orders' && location.pathname === '/orders') {
      setOrdersRefreshKey((k) => k + 1)
    } else {
      navigate(key)
    }
  }

  const selectedKey = useMemo(() => {
    if (location.pathname.startsWith('/orders')) return '/orders'
    if (location.pathname.startsWith('/boats')) return '/boats'
    if (location.pathname.startsWith('/customers')) return '/customers'
    if (location.pathname.startsWith('/users')) return '/users'
    if (location.pathname.startsWith('/settings')) return '/settings'
    return '/dashboard'
  }, [location.pathname])

  const isSuperuser = Boolean(user && user.role === 'superuser')

  // 左上角标题：显示当前 Group 名称。超级管理员始终处于某个 Group 内
  // （登录后自动选中第一个 Group，切换时也只能在 Group 之间切换）。
  const headerTitle = useMemo(() => {
    if (isSuperuser) return activeGroupName ?? groups[0]?.name ?? '水上器材租赁'
    return user?.group_name ?? '水上器材租赁'
  }, [isSuperuser, activeGroupName, groups, user?.group_name])

  const openGroupModal = () => {
    setPendingGroupId(activeGroup)
    setGroupOpen(true)
  }

  const handleConfirmSwitchGroup = () => {
    const id = pendingGroupId
    const found = id ? groups.find((g) => g.id === id) : null
    if (!id || !found) {
      message.warning('请选择一个 Group')
      return
    }
    setActiveGroup(id, found.name)
    setGroupOpen(false)
    message.success(`已切换至 Group：${found.name}`)
  }

  const handleChangePassword = async () => {
    if (!oldPwd || !newPwd || !confirmPwd) {
      message.warning('请填写所有字段')
      return
    }
    if (newPwd !== confirmPwd) {
      message.error('两次输入的新密码不一致')
      return
    }
    setPwdLoading(true)
    try {
      await api.post('/api/auth/change-password', {
        old_password: oldPwd,
        new_password: newPwd,
      })
      message.success('密码修改成功')
      setPwdOpen(false)
      setOldPwd('')
      setNewPwd('')
      setConfirmPwd('')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '修改失败')
    } finally {
      setPwdLoading(false)
    }
  }

  const userMenu = (
    <>
      <Dropdown
        menu={{
          items: [
            {
              key: 'settings',
              icon: <KeyOutlined />,
              label: '更改密码',
              onClick: () => setPwdOpen(true),
            },
            ...(isSuperuser
              ? [
                  {
                    key: 'switch-group',
                    icon: <SwapOutlined />,
                    label: activeGroupName
                      ? `切换Group（当前：${activeGroupName}）`
                      : '切换Group',
                    onClick: openGroupModal,
                  },
                ]
              : []),
            {
              key: 'logout',
              icon: <LogoutOutlined />,
              label: '退出登录',
              onClick: async () => {
                await logout()
                navigate('/login')
              },
            },
          ],
        }}
      >
        <Typography.Text style={{ cursor: 'pointer' }}>
          <UserShieldIcon /> {user?.display_name}（{user?.username}）
          {isSuperuser && activeGroupName ? (
            <Tag color="blue" style={{ marginLeft: 8 }}>
              {activeGroupName}
            </Tag>
          ) : null}
        </Typography.Text>
      </Dropdown>
      <Modal
        title="修改密码"
        open={pwdOpen}
        onOk={handleChangePassword}
        confirmLoading={pwdLoading}
        onCancel={() => setPwdOpen(false)}
        destroyOnClose
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          <Input.Password
            placeholder="原密码"
            value={oldPwd}
            onChange={(e) => setOldPwd(e.target.value)}
          />
          <Input.Password
            placeholder="新密码"
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
          />
          <Input.Password
            placeholder="确认新密码"
            value={confirmPwd}
            onChange={(e) => setConfirmPwd(e.target.value)}
          />
        </div>
      </Modal>
      <Modal
        title="切换Group"
        open={groupOpen}
        onOk={handleConfirmSwitchGroup}
        onCancel={() => setGroupOpen(false)}
        destroyOnClose
      >
        <div style={{ marginTop: 16 }}>
          <Typography.Paragraph type="secondary">
            选择一个 Group 后，所有数据（订单、客户、用户、目录、库存、设置、概览、报表）将按该 Group 过滤。「Group管理」不受影响。
          </Typography.Paragraph>
          <Select
            style={{ width: '100%' }}
            value={pendingGroupId ?? undefined}
            placeholder="请选择一个 Group"
            onChange={(value: string) => setPendingGroupId(value)}
            options={groups.map((g) => ({ value: g.id, label: g.name }))}
          />
        </div>
      </Modal>
    </>
  )

  // Mobile layout: no Sider, fixed bottom TabBar with a raised center + button.
  if (isMobile) {
    const tabs: TabItem[] = [
      { key: '/dashboard', icon: <DashboardOutlined />, label: '概览' },
      { key: '/orders', icon: <SquareChevronsRightIcon />, label: '订单' },
      { key: '/boats', icon: <KayakIcon />, label: '船只' },
      { key: '/settings', icon: <SettingOutlined />, label: '设置' },
    ]
    return (
      <Layout className="mobile-app-shell" style={mobileLayoutStyle}>
        <Header
          style={{
            background: 'rgba(255,255,255,.94)',
            padding: '0 16px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          <Typography.Text
            strong
            style={{ color: '#16262e', flexShrink: 0, fontSize: 16, fontWeight: 700, letterSpacing: '.02em' }}
          >
            {headerTitle}
          </Typography.Text>
          <WeatherCard />
          {userMenu}
        </Header>
        <Content style={mobileContentStyle}>
          <Outlet context={{ ordersRefreshKey }} />
        </Content>
        <div style={tabBarStyle}>
          {tabs.slice(0, 2).map((item) => (
            <TabButton
              key={item.key}
              item={item}
              active={selectedKey === item.key}
              onClick={() => handleNav(item.key)}
            />
          ))}
          <div
            onClick={() => navigate('/orders/new')}
            style={addButtonStyle}
            aria-label="新建订单"
          >
            <PlusOutlined style={{ fontSize: 24 }} />
          </div>
          {tabs.slice(2).map((item) => (
            <TabButton
              key={item.key}
              item={item}
              active={selectedKey === item.key}
              onClick={() => handleNav(item.key)}
            />
          ))}
        </div>
      </Layout>
    )
  }

  // Desktop layout
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        theme="light"
        breakpoint="lg"
        collapsedWidth="0"
        style={{
          borderRight: '1px solid #d3dde0',
          // 侧栏固定在视口高度，右侧内容再长也不会把侧栏拉长，滚动时保持不动
          position: 'sticky',
          top: 0,
          height: '100vh',
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
          <div
            style={{
              height: 56,
              margin: 12,
              color: '#2f6474',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              letterSpacing: 1,
              flexShrink: 0,
            }}
          >
            {headerTitle}
          </div>
          <Menu
            theme="light"
            mode="inline"
            selectedKeys={[selectedKey]}
            items={[
              { key: '/dashboard', icon: <DashboardOutlined />, label: '概览' },
              { key: '/orders', icon: <SquareChevronsRightIcon />, label: '订单管理' },
            ]}
            onClick={({ key }) => handleNav(key)}
          />
          <Menu
            theme="light"
            mode="inline"
            selectedKeys={[selectedKey]}
            items={[
              { key: '/boats', icon: <KayakIcon />, label: '船只调配' },
              { key: '/customers', icon: <TeamOutlined />, label: '客户管理' },
            ]}
            onClick={({ key }) => handleNav(key)}
          />
          {/* 目录与设置固定贴在侧栏底部 */}
          <div style={{ flex: 1 }} />
          <Menu
            theme="light"
            mode="inline"
            selectedKeys={[selectedKey]}
            items={[{ key: '/settings', icon: <SettingOutlined />, label: '目录与设置' }]}
            onClick={({ key }) => handleNav(key)}
            style={{ borderTop: '1px solid #eef2f4', flexShrink: 0 }}
          />
        </div>
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingInline: 24,
            gap: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
            {/* 创建订单快捷按钮：位于顶部白色区域最左侧，点击后弹出气泡表单 */}
            <Popover
              trigger="click"
              placement="bottomLeft"
              open={quickCreateOpen}
              onOpenChange={handleQuickCreateOpenChange}
              destroyTooltipOnHide
              overlayInnerStyle={{ padding: 12 }}
              content={
                <div
                  style={{
                    width: 720,
                    maxWidth: 'calc(100vw - 280px)',
                    maxHeight: 'calc(100vh - 160px)',
                    overflowY: 'auto',
                  }}
                >
                  <OrderForm
                    embedded
                    onDone={(order) => {
                      setQuickCreateOpen(false)
                      if (order) setOrdersRefreshKey((k) => k + 1)
                    }}
                  />
                </div>
              }
            >
              <button
                type="button"
                style={{
                  height: 36,
                  padding: '0 16px',
                  border: 'none',
                  borderRadius: 8,
                  background: '#2f6474',
                  color: '#fff',
                  fontSize: 14,
                  letterSpacing: 1,
                  cursor: 'pointer',
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                <PlusOutlined style={{ color: '#fff', fontSize: 14 }} />
                创建订单
              </button>
            </Popover>
            <WeatherCard />
          </div>
          {userMenu}
        </Header>
        <Content style={{ margin: 16 }}>
          <Outlet context={{ ordersRefreshKey }} />
        </Content>
      </Layout>
    </Layout>
  )
}

interface TabItem {
  key: string
  icon: ReactNode
  label: string
}

// Mobile: the whole app is locked to the viewport and only the Content area
// scrolls, so the bottom TabBar can never be pushed around by iOS rubber-band
// scrolling or reveal content beneath it.
const mobileLayoutStyle: React.CSSProperties = {
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
}

const mobileContentStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  // 不允许页面被超宽内容撑出横向滑动
  overflowX: 'hidden',
  WebkitOverflowScrolling: 'touch',
  // Stop scroll chaining to the body at the rubber-band boundaries.
  overscrollBehavior: 'contain',
  padding: 16,
}

const tabBarStyle: React.CSSProperties = {
  // In-flow (not fixed): flex sibling of the scrolling Content, so it stays
  // locked at the bottom. 保留安全区避让 Home 指示条，但设上限：
  // 从主屏图标/书签独立窗口打开时 inset 为 34px，不设上限会让按钮下方多出
  // 一大段空白、整体视觉上移，这里最多保留 20px。
  flexShrink: 0,
  paddingTop: 0,
  paddingBottom: 'min(calc(env(safe-area-inset-bottom, 0px) + 4px), 20px)',
  background: 'rgba(255,255,255,.96)',
  borderTop: '1px solid #d3dde0',
  display: 'flex',
  justifyContent: 'space-around',
  alignItems: 'stretch',
  zIndex: 100,
}

// 用户管理图标：Lucide「user-shield」（ISC），使用 1em 尺寸以跟随菜单字号
function UserShieldIcon() {
  return (
    <span className="anticon" role="img" aria-hidden="true">
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
    >
      <path d="M10 15H6a4 4 0 0 0-4 4v2" />
      <path d="M22 17.5c0 2.499-1.75 3.749-3.83 4.474a.5.5 0 0 1-.335-.005c-2.085-.72-3.835-1.97-3.835-4.47V14a.5.5 0 0 1 .5-.499c1 0 2.25-.6 3.12-1.36a.6.6 0 0 1 .76-.001c.875.765 2.12 1.36 3.12 1.36a.5.5 0 0 1 .5.5z" />
      <circle cx="9" cy="7" r="4" />
    </svg>
    </span>
  )
}

// 订单导航图标：Lucide「square-chevrons-right」（ISC），使用 1em 尺寸以跟随菜单字号
function SquareChevronsRightIcon() {
  return (
    <span className="anticon" role="img" aria-hidden="true">
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="m9 8 4 4-4 4" />
      <path d="m13 8 4 4-4 4" />
    </svg>
    </span>
  )
}

// 船只导航图标：Tabler Icons「kayak」（MIT），使用 1em 尺寸以跟随菜单字号
function KayakIcon() {
  return (
    <span className="anticon" role="img" aria-hidden="true">
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
    >
      <path d="M6.414 6.414a2 2 0 0 0 0 -2.828l-1.414 -1.414l-2.828 2.828l1.414 1.414a2 2 0 0 0 2.828 0" />
      <path d="M17.586 17.586a2 2 0 0 0 0 2.828l1.414 1.414l2.828 -2.828l-1.414 -1.414a2 2 0 0 0 -2.828 0" />
      <path d="M6.5 6.5l11 11" />
      <path d="M22 2.5c-9.983 2.601 -17.627 7.952 -20 19.5c9.983 -2.601 17.627 -7.952 20 -19.5" />
      <path d="M6.5 12.5l5 5" />
      <path d="M12.5 6.5l5 5" />
    </svg>
    </span>
  )
}

const addButtonStyle: React.CSSProperties = {
  width: 52,
  height: 52,
  borderRadius: '50%',
  background: '#2f6474',
  color: '#fff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  marginTop: -20,
  alignSelf: 'center',
  boxShadow: '0 6px 16px rgba(47,100,116,.32)',
  cursor: 'pointer',
}

function TabButton({
  item,
  active,
  onClick,
}: {
  item: TabItem
  active: boolean
  onClick: () => void
}) {
  return (
    <div
      onClick={onClick}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        color: active ? '#2f6474' : '#4e636d',
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '.02em',
      }}
    >
      <span style={{ fontSize: 18 }}>{item.icon}</span>
      <span>{item.label}</span>
    </div>
  )
}
