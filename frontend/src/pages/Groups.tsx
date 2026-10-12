import { useCallback, useEffect, useState } from 'react'
import {
  App,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { api } from '../api'
import { formatDateTime } from '../utils'
import type { Group } from '../types'

export default function Groups() {
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<Group | null>(null)
  const [managerFor, setManagerFor] = useState<Group | null>(null)
  const [createForm] = Form.useForm()
  const [editForm] = Form.useForm()
  const [managerForm] = Form.useForm()
  const { message } = App.useApp()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setGroups(await api.get<Group[]>('/api/groups'))
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    load()
  }, [load])

  const submitCreate = async () => {
    const values = await createForm.validateFields()
    try {
      await api.post('/api/groups', { name: values.name.trim() })
      message.success('Group已创建')
      setCreateOpen(false)
      load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '创建失败')
    }
  }

  const submitEdit = async () => {
    if (!editing) return
    const values = await editForm.validateFields()
    try {
      await api.patch(`/api/groups/${editing.id}`, {
        name: values.name?.trim(),
        is_active: values.is_active,
      })
      message.success('已更新')
      setEditing(null)
      load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '更新失败')
    }
  }

  const submitManager = async () => {
    if (!managerFor) return
    const values = await managerForm.validateFields()
    try {
      await api.post(`/api/groups/${managerFor.id}/managers`, {
        username: values.username.trim(),
        display_name: values.display_name.trim(),
        password: values.password,
      })
      message.success('管理员已创建')
      setManagerFor(null)
      load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '创建失败')
    }
  }

  const columns: ColumnsType<Group> = [
    { title: 'Group名称', dataIndex: 'name' },
    { title: '成员数', dataIndex: 'member_count', width: 90 },
    {
      title: '状态',
      dataIndex: 'is_active',
      width: 90,
      render: (v: boolean) => (v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      width: 180,
      render: (v: string | null) => (v ? formatDateTime(v) : '-'),
    },
    {
      title: '操作',
      width: 200,
      render: (_, record) => (
        <Space>
          <Button type="link" onClick={() => { setManagerFor(record); managerForm.resetFields() }}>
            创建管理员
          </Button>
          <Button type="link" onClick={() => {
            setEditing(record)
            editForm.setFieldsValue({ name: record.name, is_active: record.is_active })
          }}>
            编辑
          </Button>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="Group管理"
      extra={
        <Button type="primary" onClick={() => { createForm.resetFields(); setCreateOpen(true) }}>
          新建Group
        </Button>
      }
    >
      <Table rowKey="id" loading={loading} columns={columns} dataSource={groups} pagination={{ pageSize: 20 }} />

      <Modal title="新建Group" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={submitCreate} destroyOnClose>
        <Form form={createForm} layout="vertical">
          <Form.Item label="Group名称" name="name" rules={[{ required: true, message: '请输入Group名称' }]}>
            <Input placeholder="如：XX器材店" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={`编辑Group ${editing?.name ?? ''}`} open={Boolean(editing)} onCancel={() => setEditing(null)} onOk={submitEdit} destroyOnClose>
        <Form form={editForm} layout="vertical">
          <Form.Item label="Group名称" name="name" rules={[{ required: true, message: '请输入Group名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="状态" name="is_active" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`为 ${managerFor?.name ?? ''} 创建管理员`}
        open={Boolean(managerFor)}
        onCancel={() => setManagerFor(null)}
        onOk={submitManager}
        destroyOnClose
      >
        <Form form={managerForm} layout="vertical">
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="登录用户名" />
          </Form.Item>
          <Form.Item label="姓名" name="display_name" rules={[{ required: true, message: '请输入姓名' }]}>
            <Input placeholder="显示姓名" />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password placeholder="初始密码" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
