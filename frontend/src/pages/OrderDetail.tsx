import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Divider,
  Form,
  Grid,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tabs,
  Tag,
} from 'antd'
import { api } from '../api'
import { useAuth } from '../auth'
import { fenToYuan, formatDateTime, formatDurationBetween, typeColorHex } from '../utils'
import type { Order, OrderStatus, PaymentView } from '../types'

const STATUS_META: Record<OrderStatus, { label: string; color: string }> = {
  active: { label: '预订', color: 'green' },
  in_progress: { label: '进行中', color: 'orange' },
  completed: { label: '已完成', color: 'blue' },
  cancelled: { label: '已取消', color: 'default' },
  no_show: { label: '爽约', color: 'red' },
}

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { message } = App.useApp()
  const { user } = useAuth()
  const canEditOrder = Boolean(user?.permissions.edit_order)
  const isSuperuser = user?.role === 'superuser'
  const screens = Grid.useBreakpoint()

  const [order, setOrder] = useState<Order | null>(null)
  const [payment, setPayment] = useState<PaymentView | null>(null)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [adjustForm] = Form.useForm()
  const [adjustQty, setAdjustQty] = useState(1)
  const [adjustTab, setAdjustTab] = useState<'charge' | 'refund'>('charge')

  const load = useCallback(async (): Promise<Order> => {
    if (!id) return order!
    const [orderData, paymentData] = await Promise.all([
      api.get<Order>(`/api/orders/${id}`),
      api.get<PaymentView>(`/api/orders/${id}/payment`).catch(() => null),
    ])
    setOrder(orderData)
    setPayment(paymentData)
    return orderData
  }, [id])

  // 勾选"备注弹窗"的订单：首次打开详情时展示备注内容，点击"确认"关闭
  const notePopupShown = useRef(false)

  useEffect(() => {
    load()
      .then((data) => {
        if (!notePopupShown.current && data.note_popup && data.note) {
          notePopupShown.current = true
          Modal.warning({ title: '备注提醒', content: data.note, okText: '确认' })
        }
      })
      .catch((error) => message.error(error.message))
  }, [load, message])

  const doCheckIn = async () => {
    try {
      const updated = await api.post<Order>(`/api/orders/${id}/check-in`)
      setOrder(updated)
      if (updated.inventory_warnings && updated.inventory_warnings.length > 0) {
        message.warning('签到成功，但存在库存超占')
      } else {
        message.success('签到成功')
      }
      const paymentData = await api
        .get<PaymentView>(`/api/orders/${id}/payment`)
        .catch(() => null)
      setPayment(paymentData)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    }
  }

  const action = async (
    path: string,
    successText: string,
    options?: { confirm?: string },
  ) => {
    try {
      await api.post(path)
      message.success(successText)
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    }
  }

  const submitAdjustment = async () => {
    const values = await adjustForm.validateFields()
    const amountFen = yuanToFenSafe(values.amount)
    if (amountFen <= 0) {
      message.warning('金额必须大于 0（最小 0.01 元）')
      return
    }
    if (adjustQty === 0) {
      message.warning('数量不能为 0')
      return
    }
    try {
      await api.post(`/api/orders/${id}/payment/adjustments`, {
        quantity: adjustTab === 'refund' ? -adjustQty : adjustQty,
        unit_amount: amountFen,
        note: values.note,
      })
      message.success('调整已添加')
      setAdjustOpen(false)
      adjustForm.resetFields()
      setAdjustQty(1)
      setAdjustTab('charge')
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '添加失败')
    }
  }

  // Quantity stepper: always positive (min 1)
  const decQty = () => setAdjustQty((q) => Math.max(1, q - 1))
  const incQty = () => setAdjustQty((q) => q + 1)

  // superuser 永久删除订单（含订单项目与支付记录）
  const [deleting, setDeleting] = useState(false)
  const doDelete = async () => {
    setDeleting(true)
    try {
      await api.del(`/api/orders/${id}`)
      message.success('订单已删除')
      navigate('/orders')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败')
      setDeleting(false)
    }
  }

  if (!order) return null

  const today = formatDateTime(order.start_at).slice(0, 10) === dayjsToday()
  const warnings = order.inventory_warnings ?? []

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <Card
        title={
          <Space>
            订单 {order.order_number}
            <Tag color={STATUS_META[order.status].color}>{STATUS_META[order.status].label}</Tag>
            {order.checked_in && <Tag color="processing">已签到</Tag>}
            {order.returned && <Tag color="success">已归还</Tag>}
            {order.auto_return_occurred && <Tag color="purple">系统自动归还</Tag>}
            {order.daily_forced_return_occurred && <Tag color="magenta">每日强制归还</Tag>}
          </Space>
        }
        extra={
          screens.md ? <Button onClick={() => navigate('/orders')}>返回列表</Button> : undefined
        }
      >
        {warnings.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="库存超占提示"
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {warnings.map((w) => (
                  <li key={w.equipment_spec_id}>{w.message}</li>
                ))}
              </ul>
            }
          />
        )}

        <Descriptions bordered column={2} size="small">
          <Descriptions.Item label="订单状态">
            <Tag color={STATUS_META[order.status].color} style={{ margin: 0 }}>
              {STATUS_META[order.status].label}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="客户">
            {order.customer_name || order.customer_wechat_nickname || '游客'}
          </Descriptions.Item>
          <Descriptions.Item label="性别">{order.customer_gender || '—'}</Descriptions.Item>
          <Descriptions.Item label="手机号">{order.customer_phone || '—'}</Descriptions.Item>
          <Descriptions.Item label="微信">
            {[order.customer_wechat_nickname, order.customer_wechat_id].filter(Boolean).join(' / ') || '—'}
          </Descriptions.Item>
          <Descriptions.Item label="开始时间">{formatDateTime(order.start_at)}</Descriptions.Item>
          <Descriptions.Item label="人数">
            {order.adult_count} 位成人{order.child_count > 0 ? `，${order.child_count} 位儿童` : ''}
          </Descriptions.Item>
          <Descriptions.Item label="散客">{order.is_walk_in ? '是' : '否'}</Descriptions.Item>
          <Descriptions.Item label="使用时长">
            {order.return_at
              ? order.check_in_at
                ? formatDurationBetween(order.check_in_at, order.return_at)
                : '2小时'
              : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="签到">
            {order.check_in_at
              ? `${formatDateTime(order.check_in_at)}（${order.check_in_by_user_name ?? ''}）`
              : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="归还">
            {order.return_at
              ? `${formatDateTime(order.return_at)}（${order.return_by_system ? '系统' : (order.return_by_user_name ?? '')}）`
              : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="创建时间">
            {`${formatDateTime(order.created_at)}（${order.created_by_user_name ?? ''}）`}
          </Descriptions.Item>
          <Descriptions.Item label="最后改动">
            {`${formatDateTime(order.updated_at)}（${order.updated_by_user_name ?? ''}）`}
          </Descriptions.Item>
          <Descriptions.Item label="备注" span={2}>
            {order.note || '—'}
          </Descriptions.Item>
        </Descriptions>

        <Divider orientation="left">订单项目（价格快照，不可修改）</Divider>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={order.items}
          columns={[
            {
              title: '项目',
              render: (_, item) => {
                const name = item.equipment_spec_name ?? item.sale_item_name ?? '—'
                return (
                  <span
                    style={{
                      color: typeColorHex(item.equipment_type_color),
                      fontWeight: item.equipment_type_color ? 600 : undefined,
                    }}
                  >
                    {name}
                  </span>
                )
              },
            },
            { title: '数量', dataIndex: 'quantity', width: 90, align: 'right' },
            {
              title: '单价',
              width: 110,
              align: 'right',
              render: (_, item) => `¥${fenToYuan(item.unit_price)}`,
            },
            {
              title: '小计',
              width: 110,
              align: 'right',
              render: (_, item) => `¥${fenToYuan(item.line_amount)}`,
            },
          ]}
        />
      </Card>

      {!today && (order.status === 'active' || order.status === 'in_progress') && (
        <Alert
          type="info"
          showIcon
          message="签到与归还仅允许处理当天（Asia/Shanghai）订单；历史订单如需修正请使用取消类操作。"
        />
      )}

      <Card title="支付面板">
        {payment ? (
          <>
            <Descriptions column={1} size="small" style={{ maxWidth: 360 }}>
              <Descriptions.Item label="订单项目金额">¥{fenToYuan(payment.items_total_fen)}</Descriptions.Item>
              <Descriptions.Item label="调整项合计">
                {payment.adjustments_total_fen === 0 ? (
                  '¥0.00'
                ) : (
                  <span style={{ color: payment.adjustments_total_fen > 0 ? '#cf1322' : '#3f8600' }}>
                    {payment.adjustments_total_fen > 0 ? '+' : ''}
                    ¥{fenToYuan(payment.adjustments_total_fen)}
                  </span>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="应收总额">
                <strong>¥{fenToYuan(payment.amount_fen)}</strong>
              </Descriptions.Item>
            </Descriptions>

            <Divider orientation="left">调整项（Other，可正可负）</Divider>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={payment.adjustments}
              columns={[
                { title: '说明', dataIndex: 'note' },
                {
                  title: '金额',
                  width: 140,
                  align: 'right',
                  render: (_, item) => (
                    <span style={{ color: item.amount > 0 ? '#cf1322' : '#3f8600' }}>
                      {item.amount > 0 ? '+' : ''}¥{fenToYuan(item.amount)}
                    </span>
                  ),
                },
                { title: '时间', dataIndex: 'created_at', width: 180, render: (v) => formatDateTime(v) },
              ]}
            />
            <Button
              style={{ marginTop: 12 }}
              onClick={() => {
                adjustForm.resetFields()
                setAdjustQty(1)
                setAdjustTab('charge')
                setAdjustOpen(true)
              }}
            >
              添加调整项
            </Button>
          </>
        ) : (
          <span style={{ color: '#999' }}>支付记录加载失败</span>
        )}
      </Card>

      <Modal
        title="添加调整项"
        open={adjustOpen}
        onCancel={() => setAdjustOpen(false)}
        onOk={submitAdjustment}
        destroyOnClose
      >
        <Tabs
          activeKey={adjustTab}
          onChange={(key) => setAdjustTab(key as 'charge' | 'refund')}
          items={[
            { key: 'charge', label: '收费' },
            { key: 'refund', label: '退款' },
          ]}
        />
        <Form form={adjustForm} layout="vertical">
          <Form.Item
            label="金额（元，最小 0.01）"
            name="amount"
            rules={[
              { required: true, message: '请输入金额（大于 0，最小 0.01 元）' },
              {
                validator: (_, value) =>
                  typeof value === 'number' && value >= 0.01
                    ? Promise.resolve()
                    : Promise.reject(new Error('金额必须大于 0（最小 0.01 元）')),
              },
            ]}
          >
            <InputNumber
              style={{ width: '100%' }}
              min={0.01}
              step={0.01}
              precision={2}
              parser={(value) => (value || '').replace(/[^\d.]/g, '') as unknown as number}
            />
          </Form.Item>
          <Form.Item label="数量" required>
            <Space.Compact style={{ width: '100%' }}>
              <Button style={{ width: 44 }} onClick={decQty} disabled={adjustQty <= 1}>
                −
              </Button>
              <div
                style={{
                  flex: 1,
                  textAlign: 'center',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '1px solid #d9d9d9',
                  borderLeft: 'none',
                  borderRight: 'none',
                  fontWeight: 600,
                }}
              >
                {adjustQty}
              </div>
              <Button style={{ width: 44 }} onClick={incQty}>
                +
              </Button>
            </Space.Compact>
          </Form.Item>
          <Form.Item
            label="说明"
            name="note"
            rules={[{ required: true, message: '请填写调整说明' }]}
          >
            <Input placeholder={adjustTab === 'refund' ? '如：会员折扣 / 退款' : '如：超时费 / 押金'} />
          </Form.Item>
        </Form>
      </Modal>

      <div style={{ height: screens.md ? 48 : 'calc(72px + env(safe-area-inset-bottom, 0px))' }} />
      <div
        style={{
          position: 'fixed',
          bottom: screens.md ? 16 : 'calc(56px + env(safe-area-inset-bottom, 0px))',
          left: screens.md ? 'auto' : 0,
          right: screens.md ? 16 : 0,
          zIndex: 100,
          background: '#fff',
          padding: '8px 12px',
          borderTop: screens.md ? 'none' : '1px solid #f0f0f0',
          borderRadius: screens.md ? 8 : 0,
          boxShadow: '0 -2px 8px rgba(0,0,0,0.06)',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          justifyContent: 'center',
        }}
      >
        {(order.editable || order.status === 'in_progress') && canEditOrder && (
          <Button onClick={() => navigate(`/orders/${order.id}/edit`)}>编辑</Button>
        )}
        {order.status === 'active' && !order.checked_in && (
          today ? (
            <Popconfirm
              title="确认签到？"
              description="签到以服务器当前时间为准，超过自动归还时限后将由系统自动归还。"
              onConfirm={doCheckIn}
              overlayStyle={{ maxWidth: '70vw', width: 'auto' }}
            >
              <Button type="primary">签到</Button>
            </Popconfirm>
          ) : (
            <Button disabled title="仅当天订单可签到">签到</Button>
          )
        )}
        {order.status === 'in_progress' && (
          <Popconfirm
            title="取消签到？"
            description="将清除签到与自动归还时限记录，订单恢复为未签到活动状态。"
            onConfirm={() => action(`/api/orders/${order.id}/cancel-check-in`, '已取消签到')}
          >
            <Button>取消签到</Button>
          </Popconfirm>
        )}
        {(order.status === 'active' || order.status === 'in_progress') && (
          today ? (
            <Popconfirm
              title="确认归还？"
              onConfirm={() => action(`/api/orders/${order.id}/return`, '归还成功')}
            >
              <Button type="primary" ghost>归还</Button>
            </Popconfirm>
          ) : (
            <Button disabled title="仅当天订单可归还">归还</Button>
          )
        )}
        {order.returned && (
          <Popconfirm
            title="取消归还？"
            description="订单将恢复为活动状态。"
            onConfirm={() => action(`/api/orders/${order.id}/cancel-return`, '已取消归还')}
          >
            <Button>取消归还</Button>
          </Popconfirm>
        )}
        {order.status === 'active' && (
          <Popconfirm title="确认标记爽约？" onConfirm={() => action(`/api/orders/${order.id}/no-show`, '已标记爽约')}>
            <Button>爽约</Button>
          </Popconfirm>
        )}
        {order.status === 'active' && (
          <Popconfirm title="确认取消订单？" onConfirm={() => action(`/api/orders/${order.id}/cancel`, '订单已取消')}>
            <Button danger>取消</Button>
          </Popconfirm>
        )}
        {(order.status === 'completed' || order.status === 'no_show' || order.status === 'cancelled') && (
          <Popconfirm
            title="恢复为活动订单？"
            description="仅未到原结束时间之后的订单可恢复。"
            onConfirm={() => action(`/api/orders/${order.id}/restore`, '订单已恢复')}
          >
            <Button>恢复订单</Button>
          </Popconfirm>
        )}
        {isSuperuser && (
          <Popconfirm
            title="确认删除该订单？"
            description="将永久删除订单及其项目、支付记录，此操作不可恢复。"
            okText="永久删除"
            okButtonProps={{ danger: true, loading: deleting }}
            cancelText="取消"
            onConfirm={doDelete}
          >
            <Button danger>删除订单</Button>
          </Popconfirm>
        )}
      </div>
    </Space>
  )
}

function dayjsToday(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function yuanToFenSafe(value: number): number {
  return Math.round(value * 100)
}
