import { useMemo, useState, type ReactNode } from 'react'
import { App, Grid, Layout, Menu, Dropdown, Typography, Modal, Input, Select, Tag } from 'antd'
import {
  DashboardOutlined,
  ShoppingOutlined,
  TeamOutlined,
  SettingOutlined,
  UserOutlined,
  LogoutOutlined,
  PlusOutlined,
  KeyOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'

const { Header, Sider, Content } = Layout

export default function AppLayout() {
  const { user, logout, activeGroup, activeGroupName, setActiveGroup, groups } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const screens = Grid.useBreakpoint()
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

  const handleNav = (key: string) => {
    if (key === '/orders' && location.pathname.startsWith('/orders')) {
      setOrdersRefreshKey((k) => k + 1)
    } else {
      navigate(key)
    }
  }

  const selectedKey = useMemo(() => {
    if (location.pathname.startsWith('/orders')) return '/orders'
    if (location.pathname.startsWith('/customers')) return '/customers'
    if (location.pathname.startsWith('/users')) return '/users'
    if (location.pathname.startsWith('/settings')) return '/settings'
    return '/dashboard'
  }, [location.pathname])

  const canManageUsers = Boolean(
    user && (user.role === 'superuser' || user.role === 'admin' || user.permissions.manage_users),
  )

  const isSuperuser = Boolean(user && user.role === 'superuser')

  const openGroupModal = () => {
    setPendingGroupId(activeGroup)
    setGroupOpen(true)
  }

  const handleConfirmSwitchGroup = () => {
    const id = pendingGroupId
    const found = id ? groups.find((g) => g.id === id) : null
    setActiveGroup(id, found ? found.name : null)
    setGroupOpen(false)
    message.success(id && found ? `已切换至 Group：${found.name}` : '已切换至所有 Group')
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
          <UserOutlined /> {user?.display_name}（{user?.username}）
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
            value={pendingGroupId ?? '__all__'}
            onChange={(value: string) =>
              setPendingGroupId(value === '__all__' ? null : value)
            }
            options={[
              { value: '__all__', label: '所有Group' },
              ...groups.map((g) => ({ value: g.id, label: g.name })),
            ]}
          />
        </div>
      </Modal>
    </>
  )

  // Mobile layout: no Sider, fixed bottom TabBar with a raised center + button.
  if (!screens.md) {
    const tabs: TabItem[] = [
      { key: '/dashboard', icon: <DashboardOutlined />, label: '概览' },
      { key: '/orders', icon: <ShoppingOutlined />, label: '订单' },
      { key: '/customers', icon: <TeamOutlined />, label: '客户' },
      { key: '/settings', icon: <SettingOutlined />, label: '设置' },
    ]
    const headerTitle =
      isSuperuser && activeGroupName ? activeGroupName : user?.group_name ?? '水上器材租赁'
    return (
      <Layout className="mobile-app-shell" style={mobileLayoutStyle}>
        <Header
          style={{
            background: '#fff',
            padding: '0 16px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          <Typography.Text strong style={{ color: '#0e7a8c' }}>
            {headerTitle}
          </Typography.Text>
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
      <Sider theme="dark" breakpoint="lg" collapsedWidth="0">
        <div
          style={{
            height: 56,
            margin: 12,
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 600,
            letterSpacing: 1,
          }}
        >
          {isSuperuser && activeGroupName ? activeGroupName : user?.group_name ?? '水上器材租赁'}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={[
            { key: '/dashboard', icon: <DashboardOutlined />, label: '工作台' },
            { key: '/orders', icon: <ShoppingOutlined />, label: '订单管理' },
            { key: '/customers', icon: <TeamOutlined />, label: '客户管理' },
            ...(canManageUsers
              ? [{ key: '/users', icon: <UserOutlined />, label: '用户管理' }]
              : []),
            { key: '/settings', icon: <SettingOutlined />, label: '目录与设置' },
          ]}
          onClick={({ key }) => handleNav(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            paddingInline: 24,
          }}
        >
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
  WebkitOverflowScrolling: 'touch',
  // Stop scroll chaining to the body at the rubber-band boundaries.
  overscrollBehavior: 'contain',
  padding: 12,
}

const tabBarStyle: React.CSSProperties = {
  // In-flow (not fixed): flex sibling of the scrolling Content, so it stays
  // locked at the bottom. Extra bottom padding clears the iPhone home indicator.
  flexShrink: 0,
  paddingTop: 4,
  paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 6px)',
  background: '#fff',
  borderTop: '1px solid #f0f0f0',
  display: 'flex',
  justifyContent: 'space-around',
  alignItems: 'center',
  zIndex: 100,
}

const addButtonStyle: React.CSSProperties = {
  width: 52,
  height: 52,
  borderRadius: '50%',
  background: '#0e7a8c',
  color: '#fff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  marginTop: -20,
  boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
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
        color: active ? '#0e7a8c' : '#999',
        cursor: 'pointer',
        fontSize: 12,
      }}
    >
      <span style={{ fontSize: 18 }}>{item.icon}</span>
      <span>{item.label}</span>
    </div>
  )
}
