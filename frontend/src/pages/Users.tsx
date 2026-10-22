import { useEffect, useState } from 'react'
import {
  App,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { api } from '../api'
import { useAuth } from '../auth'
import { useLayoutMode } from '../layoutMode'
import { formatDateTime } from '../utils'
import type { Group, UserAccount, UserRole } from '../types'

const ROLE_META: Record<UserRole, { label: string; color: string }> = {
  superuser: { label: '超级管理员', color: 'red' },
  admin: { label: '管理员', color: 'gold' },
  user: { label: '用户', color: 'blue' },
}

const ALL_ROLE_OPTIONS = [
  { value: 'superuser', label: '超级管理员' },
  { value: 'admin', label: '管理员' },
  { value: 'user', label: '用户' },
]

const USER_ROLE_OPTIONS = [{ value: 'user', label: '用户' }]

function PermissionCheckboxes() {
  return (
    <Space direction="vertical">
      <Form.Item name="perm_create_order" valuePropName="checked" noStyle>
        <Checkbox>创建订单</Checkbox>
      </Form.Item>
      <Form.Item name="perm_edit_order" valuePropName="checked" noStyle>
        <Checkbox>编辑订单</Checkbox>
      </Form.Item>
      <Form.Item name="perm_export_report" valuePropName="checked" noStyle>
        <Checkbox>导出报表</Checkbox>
      </Form.Item>
      <Form.Item name="perm_manage_users" valuePropName="checked" noStyle>
        <Checkbox>启停用户账户</Checkbox>
      </Form.Item>
      <Form.Item name="perm_view_revenue" valuePropName="checked" noStyle>
        <Checkbox>看营业额</Checkbox>
      </Form.Item>
      <Form.Item name="perm_manage_payment_methods" valuePropName="checked" noStyle>
        <Checkbox>添加支付方式</Checkbox>
      </Form.Item>
      <Form.Item name="perm_boat_dispatch" valuePropName="checked" noStyle>
        <Checkbox>船只调配</Checkbox>
      </Form.Item>
    </Space>
  )
}

export default function Users() {
  const { user } = useAuth()
  const [users, setUsers] = useState<UserAccount[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<UserAccount | null>(null)
  const [createForm] = Form.useForm()
  const [editForm] = Form.useForm()
  const { message } = App.useApp()
  // 手机版列表：全部居中，并尽量保证每行内容单行显示（超宽时横向滚动）
  const { isMobile } = useLayoutMode()
  const mobileCellStyle = {
    padding: '8px 4px',
    textAlign: 'center' as const,
    whiteSpace: 'nowrap' as const,
  }

  const isSuperuser = user?.role === 'superuser'
  const isAdmin = user?.role === 'admin'
  const canManage = Boolean(
    user && (isSuperuser || isAdmin || user.permissions.manage_users),
  )
  const canCreate = isSuperuser || isAdmin

  const groupOptions = groups.map((g) => ({ value: g.id, label: g.name }))

  const load = async () => {
    setLoading(true)
    try {
      setUsers(await api.get<UserAccount[]>('/api/users'))
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (isSuperuser) {
      api.get<Group[]>('/api/groups').then(setGroups).catch(() => {})
    }
  }, [isSuperuser])

  if (!canManage) {
    return (
      <Card>
        <p style={{ color: '#999' }}>无权限访问用户管理。</p>
      </Card>
    )
  }

  const openCreate = () => {
    createForm.resetFields()
    createForm.setFieldsValue({ role: 'user' })
    setCreateOpen(true)
  }

  const submitCreate = async () => {
    const values = await createForm.validateFields()
    const body = {
      username: values.username.trim(),
      display_name: values.display_name.trim(),
      password: values.password,
      role: values.role,
      perm_create_order: values.perm_create_order ?? false,
      perm_edit_order: values.perm_edit_order ?? false,
      perm_export_report: values.perm_export_report ?? false,
      perm_manage_users: values.perm_manage_users ?? false,
      perm_view_revenue: values.perm_view_revenue ?? false,
      perm_manage_payment_methods: values.perm_manage_payment_methods ?? false,
      perm_boat_dispatch: values.perm_boat_dispatch ?? false,
      ...(isSuperuser ? { group_id: values.group_id } : {}),
    }
    try {
      await api.post('/api/users', body)
      message.success('用户已创建')
      setCreateOpen(false)
      load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '创建失败')
    }
  }

  const openEdit = (record: UserAccount) => {
    setEditing(record)
    editForm.setFieldsValue({
      display_name: record.display_name,
      role: record.role,
      perm_create_order: record.perm_create_order,
      perm_edit_order: record.perm_edit_order,
      perm_export_report: record.perm_export_report,
      perm_manage_users: record.perm_manage_users,
      perm_view_revenue: record.perm_view_revenue,
      perm_manage_payment_methods: record.perm_manage_payment_methods,
      perm_boat_dispatch: record.perm_boat_dispatch,
      is_active: record.is_active,
    })
  }

  const submitEdit = async () => {
    if (!editing) return
    const values = await editForm.validateFields()
    const body: Record<string, unknown> = {
      is_active: values.is_active,
    }
    if (isSuperuser) {
      body.display_name = values.display_name.trim()
      body.role = values.role
      body.perm_create_order = values.perm_create_order
      body.perm_edit_order = values.perm_edit_order
      body.perm_export_report = values.perm_export_report
      body.perm_manage_users = values.perm_manage_users
      body.perm_manage_payment_methods = values.perm_manage_payment_methods
      body.perm_boat_dispatch = values.perm_boat_dispatch
    } else if (isAdmin) {
      body.display_name = values.display_name.trim()
      body.perm_create_order = values.perm_create_order
      body.perm_edit_order = values.perm_edit_order
      body.perm_export_report = values.perm_export_report
      body.perm_manage_users = values.perm_manage_users
      body.perm_view_revenue = values.perm_view_revenue
      body.perm_manage_payment_methods = values.perm_manage_payment_methods
      body.perm_boat_dispatch = values.perm_boat_dispatch
    }
    if (values.password) body.password = values.password
    try {
      await api.patch(`/api/users/${editing.id}`, body)
      message.success('用户已更新')
      setEditing(null)
      load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '更新失败')
    }
  }

  const columns: ColumnsType<UserAccount> = [
    { title: '用户名', dataIndex: 'username' },
    {
      title: '姓名',
      dataIndex: 'display_name',
      render: (value: string, record) => (
        <span
          style={{
            display: 'inline-block',
            padding: isMobile ? '0 6px' : '0 8px',
            lineHeight: '22px',
            borderRadius: 4,
            border: `1px solid ${record.is_active ? '#52c41a' : '#bfbfbf'}`,
            color: '#000',
          }}
        >
          {value}
        </span>
      ),
    },
    {
      title: '编号',
      dataIndex: 'operator_code',
      width: 72,
      render: (code: string | null) =>
        code ? <Tag style={{ marginInlineEnd: 0 }}>{code}</Tag> : <span style={{ color: '#999' }}>-</span>,
    },
    ...(isSuperuser
      ? [
          {
            title: 'Group',
            dataIndex: 'group_id' as const,
            width: 120,
            render: (gid: string | null) => {
              const g = groups.find((g) => g.id === gid)
              return g ? g.name : <span style={{ color: '#999' }}>-</span>
            },
          },
        ]
      : []),
    {
      title: '角色',
      dataIndex: 'role',
      width: 110,
      render: (role: UserRole) => (
        <Tag color={ROLE_META[role].color}>{ROLE_META[role].label}</Tag>
      ),
    },
  ]

  // 手机版：所有列内容居中且不换行；列宽按内容自动撑开，超出屏幕时横向滚动
  const tableColumns: ColumnsType<UserAccount> = isMobile
    ? columns.map((column) => ({
        ...column,
        align: 'center' as const,
        onCell: () => ({ style: mobileCellStyle }),
        onHeaderCell: () => ({ style: mobileCellStyle }),
      }))
    : columns

  // 行点击进入编辑：系统用户、自己、以及权限不足的行不可编辑
  const canEditRecord = (record: UserAccount) =>
    !record.is_system &&
    record.id !== user?.id &&
    (isSuperuser || (isAdmin && record.role === 'user') || Boolean(canManage && record.role === 'user'))

  return (
    <Card
      title="用户管理"
      extra={
        canCreate ? (
          <Button type="primary" onClick={openCreate}>
            新建用户
          </Button>
        ) : null
      }
    >
      <Table
        rowKey="id"
        loading={loading}
        columns={tableColumns}
        dataSource={users}
        size={isMobile ? 'small' : 'middle'}
        scroll={isMobile ? { x: 'max-content' } : undefined}
        pagination={{ pageSize: 20 }}
        onRow={(record) => ({
          onClick: () => {
            if (canEditRecord(record)) openEdit(record)
          },
          style: { cursor: canEditRecord(record) ? 'pointer' : 'default' },
        })}
      />

      <Modal
        title="新建用户"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={submitCreate}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical">
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="登录用户名" />
          </Form.Item>
          <Form.Item label="姓名" name="display_name" rules={[{ required: true, message: '请输入姓名' }]}>
            <Input placeholder="显示姓名" />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password placeholder="初始密码" />
          </Form.Item>
          <Form.Item label="角色" name="role" rules={[{ required: true }]}>
            <Select options={isSuperuser ? ALL_ROLE_OPTIONS : USER_ROLE_OPTIONS} />
          </Form.Item>
          {isSuperuser && (
            <Form.Item label="所属Group" name="group_id" rules={[{ required: true, message: '请选择Group' }]}>
              <Select options={groupOptions} placeholder="选择Group" />
            </Form.Item>
          )}
          <Form.Item label="权限" shouldUpdate={(prev, cur) => prev.role !== cur.role}>
            {({ getFieldValue }) =>
              getFieldValue('role') === 'user' ? (
                <PermissionCheckboxes />
              ) : (
                <p style={{ color: '#999' }}>该角色默认拥有全部权限。</p>
              )
            }
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`编辑用户 ${editing?.username ?? ''}`}
        open={Boolean(editing)}
        onCancel={() => setEditing(null)}
        onOk={submitEdit}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical">
          <Form.Item label="姓名" name="display_name">
            <Input />
          </Form.Item>
          <Form.Item label="重置密码（留空则不修改）" name="password">
            <Input.Password placeholder="留空不修改" />
          </Form.Item>
          {isSuperuser && (
            <Form.Item label="角色" name="role">
              <Select options={ALL_ROLE_OPTIONS} />
            </Form.Item>
          )}
          {(isSuperuser || isAdmin) && (
            <Form.Item label="权限" shouldUpdate={(prev, cur) => prev.role !== cur.role}>
              {({ getFieldValue }) =>
                getFieldValue('role') === 'user' ? (
                  <PermissionCheckboxes />
                ) : (
                  <p style={{ color: '#999' }}>该角色默认拥有全部权限。</p>
                )
              }
            </Form.Item>
          )}
          <Form.Item label="账户状态" name="is_active" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="禁用" />
          </Form.Item>
          {editing && (
            <div style={{ color: '#999', fontSize: 12, marginTop: 4 }}>
              创建时间：{formatDateTime(editing.created_at)}
            </div>
          )}
        </Form>
      </Modal>
    </Card>
  )
}
