import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Space,
  Statistic,
  Table,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { api } from '../api'
import { useAuth } from '../auth'
import { fenToYuan, formatDateTime, typeColorHex } from '../utils'
import { GenderCheckboxes } from './Customers'
import type { Customer, CustomerStats, Order } from '../types'

interface EditFormValues {
  name?: string
  gender?: string
  phone?: string
  wechat_nickname?: string
  wechat_id?: string
}

const STATUS_LABELS: Record<string, string> = {
  active: '预订',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消',
  no_show: '爽约',
}

// 状态颜色值（CSS 圆点渲染，与 Orders.tsx 配色一致：绿=预订/蓝=已完成/灰=已取消/橙=进行中/红=爽约）
const STATUS_DOT_COLOR: Record<string, string> = {
  active: '#52c41a',
  in_progress: '#fa8c16',
  completed: '#1890ff',
  cancelled: '#bfbfbf',
  no_show: '#ff4d4f',
}

export default function CustomerDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { message } = App.useApp()
  const { user } = useAuth()
  const isSuperuser = user?.role === 'superuser'
  const [deleting, setDeleting] = useState(false)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [stats, setStats] = useState<CustomerStats | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [noShowOpen, setNoShowOpen] = useState(false)
  const [note, setNote] = useState('')
  const [remind, setRemind] = useState(false)
  const [noteSaving, setNoteSaving] = useState(false)
  // 编辑客户 profile 弹窗
  const [editOpen, setEditOpen] = useState(false)
  const [editSaving, setEditSaving] = useState(false)
  const [editForm] = Form.useForm<EditFormValues>()

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const [c, s, o] = await Promise.all([
        api.get<Customer>(`/api/customers/${id}`),
        api.get<CustomerStats>(`/api/customers/${id}/stats`),
        api.get<Order[]>(`/api/customers/${id}/orders`),
      ])
      setCustomer(c)
      setNote(c.note ?? '')
      setRemind(!!c.remind)
      setStats(s)
      setOrders(o)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [id, message])

  useEffect(() => {
    load()
  }, [load])

  const noShowOrders = orders.filter((o) => o.status === 'no_show')

  // superuser 永久删除客户 profile（系统客户/仍有订单的客户由后端拒绝）
  const doDelete = async () => {
    if (!id) return
    setDeleting(true)
    try {
      await api.del(`/api/customers/${id}`)
      message.success('客户已删除')
      navigate('/customers')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败')
      setDeleting(false)
    }
  }

  const saveNote = async () => {
    if (!id) return
    setNoteSaving(true)
    try {
      const updated = await api.put<Customer>(`/api/customers/${id}`, {
        name: customer?.name,
        gender: customer?.gender,
        wechat_nickname: customer?.wechat_nickname,
        wechat_id: customer?.wechat_id,
        phone: customer?.phone,
        note,
        remind: note ? remind : false,
      })
      setCustomer(updated)
      setNote(updated.note ?? '')
      setRemind(!!updated.remind)
      message.success('备注已保存')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setNoteSaving(false)
    }
  }

  // 打开编辑弹窗，回填当前客户资料
  const openEdit = () => {
    if (!customer) return
    editForm.setFieldsValue({
      name: customer.name ?? '',
      gender: customer.gender ?? undefined,
      phone: customer.phone ?? '',
      wechat_nickname: customer.wechat_nickname ?? '',
      wechat_id: customer.wechat_id ?? '',
    })
    setEditOpen(true)
  }

  // 提交编辑：姓名或微信昵称至少一项（与客户列表编辑弹窗规则一致）
  const onEditSubmit = async () => {
    if (!id) return
    const values = await editForm.validateFields()
    const body = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, value?.trim() ? value.trim() : null]),
    )
    if (!body.name && !body.wechat_nickname) {
      message.warning('请至少填写姓名或微信昵称')
      return
    }
    setEditSaving(true)
    try {
      const updated = await api.put<Customer>(`/api/customers/${id}`, {
        ...body,
        note: customer?.note ?? null,
        remind: customer?.remind ?? false,
      })
      setCustomer(updated)
      message.success('客户已更新')
      setEditOpen(false)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setEditSaving(false)
    }
  }

  const centerHeader = () => ({ style: { textAlign: 'center' as const } })

  const orderColumns: ColumnsType<Order> = [
    {
      title: '开始时间',
      dataIndex: 'start_at',
      width: 200,
      onHeaderCell: centerHeader,
      render: (v: string, record: Order) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: STATUS_DOT_COLOR[record.status] ?? '#bfbfbf',
              display: 'inline-block',
              flexShrink: 0,
            }}
            title={STATUS_LABELS[record.status] ?? record.status}
          />
          {formatDateTime(record.check_in_at ?? v)}
        </span>
      ),
    },
    {
      title: '器材',
      width: 160,
      onHeaderCell: centerHeader,
      render: (_: unknown, record: Order) => (
        <div>
          {record.items.map((item, i) => {
            const name = item.equipment_spec_name ?? item.sale_item_name ?? '—'
            const color = item.equipment_type_color
              ? typeColorHex(item.equipment_type_color)
              : undefined
            return (
              <div key={item.id ?? i}>
                <span style={color ? { color } : undefined}>{name}</span>
                <span> * {item.quantity}</span>
              </div>
            )
          })}
        </div>
      ),
    },
    {
      title: '金额',
      dataIndex: 'total_amount_fen',
      width: 100,
      onHeaderCell: centerHeader,
      render: (v: number) => `¥${fenToYuan(v)}`,
    },
  ]

  return (
    <div>
      <Button type="link" onClick={() => navigate('/customers')} style={{ marginBottom: 16, paddingLeft: 0 }}>
        ← 返回客户列表
      </Button>
      <Card
        loading={loading}
        title="客户详情"
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            {customer && !customer.is_system && (
              <>
                {/* 创建订单：预填当前客户信息（通过 URL query 传递 customerId，OrderForm 自动识别） */}
                <Button type="primary" onClick={() => navigate(`/orders/new?customerId=${customer.id}`)}>
                  创建订单
                </Button>
                <Button onClick={openEdit}>编辑</Button>
              </>
            )}
            {isSuperuser && customer && !customer.is_system ? (
              <Popconfirm
                title="确认删除该客户？"
                description="删除后不可恢复；若该客户仍有订单，需先删除相关订单。"
                okText="永久删除"
                okButtonProps={{ danger: true, loading: deleting }}
                cancelText="取消"
                onConfirm={doDelete}
              >
                <Button danger>删除客户</Button>
              </Popconfirm>
            ) : undefined}
          </Space>
        }
      >
        <Descriptions column={{ xs: 1, sm: 2, md: 3 }}>
          <Descriptions.Item label="姓名">{customer?.name ?? ''}</Descriptions.Item>
          <Descriptions.Item label="性别">{customer?.gender ?? ''}</Descriptions.Item>
          <Descriptions.Item label="微信昵称">{customer?.wechat_nickname ?? ''}</Descriptions.Item>
          <Descriptions.Item label="微信ID">{customer?.wechat_id ?? ''}</Descriptions.Item>
          <Descriptions.Item label="手机号">{customer?.phone ?? ''}</Descriptions.Item>
        </Descriptions>
      </Card>

      {!customer?.is_system && (
        <Card title="备注" style={{ marginBottom: 16 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Input.TextArea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="输入客户备注..."
            />
            <Space>
              <Checkbox
                checked={remind}
                disabled={!note}
                onChange={(e) => setRemind(e.target.checked)}
              >
                提醒（创建订单时弹出备注提示）
              </Checkbox>
              <Button type="primary" size="small" loading={noteSaving} onClick={saveNote}>
                保存
              </Button>
            </Space>
          </Space>
        </Card>
      )}

      {stats && (
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6}>
            <Card>
              <Statistic
                title="累计消费"
                value={fenToYuan(stats.total_spending_fen)}
                prefix="¥"
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card>
              <Statistic title="总订单数" value={stats.total_orders} />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card>
              <Statistic title="完成订单数" value={stats.completed_orders} />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card>
              <Statistic
                title="爽约次数"
                value={stats.no_show_orders}
                valueStyle={stats.no_show_orders > 0 ? { color: '#cf1322', cursor: 'pointer' } : undefined}
              />
              {stats.no_show_orders > 0 && (
                <Button type="link" size="small" onClick={() => setNoShowOpen(true)} style={{ padding: 0 }}>
                  查看爽约订单
                </Button>
              )}
            </Card>
          </Col>
        </Row>
      )}

      <Card title="关联订单">
        <Table
          rowKey="id"
          loading={loading}
          columns={orderColumns}
          dataSource={orders}
          pagination={{ pageSize: 20 }}
          onRow={(record) => ({
            onClick: () => navigate(`/orders/${record.id}`),
            style: { cursor: 'pointer' },
          })}
        />
      </Card>

      <Modal
        title="编辑客户"
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={onEditSubmit}
        okText="保存"
        okButtonProps={{ loading: editSaving }}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical">
          <Form.Item label="姓名">
            <Form.Item name="name" noStyle>
              <Input placeholder="客户姓名" />
            </Form.Item>
          </Form.Item>
          <Form.Item label="手机号">
            <Form.Item name="phone" noStyle>
              <Input placeholder="手机号" />
            </Form.Item>
          </Form.Item>
          <Form.Item label="性别" name="gender">
            <GenderCheckboxes />
          </Form.Item>
          <Form.Item label="微信昵称" name="wechat_nickname">
            <Input placeholder="微信昵称" />
          </Form.Item>
          <Form.Item label="微信ID" name="wechat_id">
            <Input placeholder="微信ID" />
          </Form.Item>
          <p style={{ color: '#999', marginBottom: 0 }}>
            至少填写姓名或微信昵称中的一项即可保存；手机号、微信ID可选填。
          </p>
        </Form>
      </Modal>

      <Modal
        title="爽约订单"
        open={noShowOpen}
        onCancel={() => setNoShowOpen(false)}
        footer={null}
        width={600}
      >
        <Table
          rowKey="id"
          columns={orderColumns}
          dataSource={noShowOrders}
          pagination={false}
          onRow={(record) => ({
            onClick: () => {
              setNoShowOpen(false)
              navigate(`/orders/${record.id}`)
            },
            style: { cursor: 'pointer' },
          })}
        />
      </Modal>
    </div>
  )
}
