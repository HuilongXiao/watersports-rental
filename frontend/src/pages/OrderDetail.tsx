import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import dayjs from 'dayjs'
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
import { LeftOutlined, PlusOutlined } from '@ant-design/icons'
import { api } from '../api'
import { useAuth } from '../auth'
import { useSettings } from '../contexts/SettingsContext'
import { fenToYuan, formatDateTime, formatDurationBetween, typeColorHex, readLatestOrdersSnapshot } from '../utils'
import type { Order, OrderStatus, PaymentView } from '../types'

const STATUS_META: Record<OrderStatus, { label: string; color: string }> = {
  active: { label: '预订', color: 'green' },
  in_progress: { label: '进行中', color: 'orange' },
  completed: { label: '已完成', color: 'blue' },
  cancelled: { label: '已取消', color: 'default' },
  no_show: { label: '爽约', color: 'red' },
}

// 紧凑表格：缩小单元格内边距（手机端保证表头不换行）
const compactCell = () => ({ style: { padding: '4px 6px' } })
const centerHeader = () => ({
  style: { padding: '4px 6px', textAlign: 'center' as const, whiteSpace: 'nowrap' as const },
})
const nowrapCell = () => ({ style: { padding: '4px 6px', whiteSpace: 'nowrap' as const } })

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
  const [adjustSubmitting, setAdjustSubmitting] = useState(false)
  // 提交锁：防止快速连点或「成功后 load() 失败误导读用户重试」产生重复调整项
  const adjustSubmittingRef = useRef(false)
  // 支付方式只读展示所需：从全局设置读取 code→name 映射
  const { settings } = useSettings()

  // 返回订单列表：有历史可退则等价浏览器后退（配合列表快照恢复筛选与滚动）；
  // 无历史可退（如直接分享链接打开详情）则跳到列表页并带上快照记录的筛选参数。
  const goBack = () => {
    if (window.history.length > 1) {
      navigate(-1)
    } else {
      const snap = readLatestOrdersSnapshot()
      navigate(`/orders${snap ? snap.search : ''}`)
    }
  }

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
    // 提交锁：请求进行中忽略后续点击，避免重复创建调整项
    if (adjustSubmittingRef.current) return
    adjustSubmittingRef.current = true
    setAdjustSubmitting(true)
    try {
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
      await api.post(`/api/orders/${id}/payment/adjustments`, {
        quantity: adjustTab === 'refund' ? -adjustQty : adjustQty,
        unit_amount: amountFen,
        note: values.note,
      })
      // POST 成功即代表调整项已落库：立即关闭弹窗并重置表单，
      // 避免后续 load() 失败时弹窗仍开着、用户误以为没保存而重试。
      message.success('调整已添加')
      setAdjustOpen(false)
      adjustForm.resetFields()
      setAdjustQty(1)
      setAdjustTab('charge')
      // load() 仅用于刷新展示；失败不应让用户以为调整没加上，
      // 所以单独 catch，只给温和提示，不抛出。
      await load().catch(() => {
        message.warning('调整已保存，但页面刷新失败，请手动下拉刷新')
      })
    } catch (error) {
      // 仅 POST 本身失败才走到这里（后端校验未通过等），提示真实错误
      message.error(error instanceof Error ? error.message : '添加失败')
    } finally {
      adjustSubmittingRef.current = false
      setAdjustSubmitting(false)
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
            {/* 移动端左上角返回按钮（与浏览器后退等价，配合列表快照恢复；左滑手势保留） */}
            {!screens.md && (
              <Button
                size="small"
                type="text"
                icon={<LeftOutlined />}
                onClick={goBack}
                aria-label="返回"
                style={{ marginLeft: -8 }}
              />
            )}
            订单 {order.order_number}
            <Tag color={STATUS_META[order.status].color}>{STATUS_META[order.status].label}</Tag>
          </Space>
        }
        extra={
          // 返回上一页（订单列表），保留列表 URL 的筛选/分页参数以恢复状态与滚动位置
          screens.md ? <Button onClick={goBack}>返回列表</Button> : undefined
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

        {/* label 宽度不限，宽度足够时一行显示；不足时浏览器自动折叠换行（偶数字数自然均分）。
            时间类内容用 <div> 拆成日期/时间两行，确保不出现"日期+时间"/"操作人"被截断的情况。 */}
        {/* 手机端窄屏：label/content 格子内边距由默认 8px 缩至 4px（缩 50%），
            腾出宽度给白色内容格；label 允许自然折行（4 字 → 2+2） */}
        <Descriptions
          bordered
          column={2}
          size="small"
          labelStyle={{ padding: '4px 4px', textAlign: 'center' }}
          contentStyle={{ padding: '4px 4px', textAlign: 'center' }}
        >
          {/* 姓名：始终保留此栏。有姓名+性别 → "张磊先生"；仅有姓名 → "张磊"；无姓名 → 留空。 */}
          {(() => {
            const namePart = order.customer_name?.trim() ?? ''
            const genderPart = order.customer_gender?.trim() ?? ''
            const label = namePart ? namePart + (genderPart || '') : ''
            return order.customer_id && label ? (
              <Descriptions.Item label="姓名">
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0, height: 'auto' }}
                  onClick={() => navigate(`/customers/${order.customer_id}`)}
                >
                  {label}
                </Button>
              </Descriptions.Item>
            ) : (
              <Descriptions.Item label="姓名">{label}</Descriptions.Item>
            )
          })()}
          <Descriptions.Item label="微信">
            {order.customer_wechat_nickname && order.customer_id ? (
              <Button
                type="link"
                size="small"
                style={{ padding: 0, height: 'auto' }}
                onClick={() => navigate(`/customers/${order.customer_id}`)}
              >
                {order.customer_wechat_nickname}
                {order.customer_wechat_id ? ` / ${order.customer_wechat_id}` : ''}
              </Button>
            ) : (
              [order.customer_wechat_nickname, order.customer_wechat_id].filter(Boolean).join(' / ') || ''
            )}
          </Descriptions.Item>
          <Descriptions.Item label="手机号">{order.customer_phone ?? ''}</Descriptions.Item>
          <Descriptions.Item label="散客">{order.is_walk_in ? '是' : '否'}</Descriptions.Item>
          <Descriptions.Item label="人数">
            {order.adult_count} 位成人{order.child_count > 0 ? `，${order.child_count} 位儿童` : ''}
          </Descriptions.Item>
          {/* 支付方式：始终保留此栏（保持 Descriptions 布局稳定） */}
          <Descriptions.Item label="支付方式">
            {settings.payment_methods.length > 0 && order.payment_method_code
              ? settings.payment_methods.find((m) => m.code === order.payment_method_code)?.name ?? ''
              : ''}
          </Descriptions.Item>
          {/* 时间类字段：拆成日期一行 + 时间一行，避免窄屏时被拆成"日期+时间"/"（操作人）" */}
          {(() => {
            if (!order.start_at) return <Descriptions.Item label="开始时间">{null}</Descriptions.Item>
            const d = dayjs(order.start_at)
            return (
              <Descriptions.Item label="开始时间">
                <div>{d.format('YYYY-MM-DD')}</div>
                <div style={{ color: '#888' }}>{d.format('HH:mm')}</div>
              </Descriptions.Item>
            )
          })()}
          {(() => {
            if (!order.check_in_at) return <Descriptions.Item label="签到">{null}</Descriptions.Item>
            const d = dayjs(order.check_in_at)
            const by = order.check_in_by_user_code ?? order.check_in_by_user_name
            return (
              <Descriptions.Item label="签到">
                <div>{d.format('YYYY-MM-DD')}</div>
                <div style={{ color: '#888' }}>
                  {d.format('HH:mm')}{by ? `（${by}）` : ''}
                </div>
              </Descriptions.Item>
            )
          })()}
          {(() => {
            if (!order.return_at) return <Descriptions.Item label="归还">{null}</Descriptions.Item>
            const d = dayjs(order.return_at)
            const by = order.return_by_system
              ? '系统'
              : (order.return_by_user_code ?? order.return_by_user_name ?? '')
            return (
              <Descriptions.Item label="归还">
                <div>{d.format('YYYY-MM-DD')}</div>
                <div style={{ color: '#888' }}>
                  {d.format('HH:mm')}{by ? `（${by}）` : ''}
                </div>
              </Descriptions.Item>
            )
          })()}
          <Descriptions.Item label="使用时长">
            {order.return_at
              ? order.check_in_at
                ? formatDurationBetween(order.check_in_at, order.return_at)
                : '2小时'
              : ''}
          </Descriptions.Item>
          {(() => {
            const d = dayjs(order.created_at)
            const by = order.created_by_user_code ?? order.created_by_user_name
            return (
              <Descriptions.Item label="创建时间">
                <div>{d.format('YYYY-MM-DD')}</div>
                <div style={{ color: '#888' }}>
                  {d.format('HH:mm')}{by ? `（${by}）` : ''}
                </div>
              </Descriptions.Item>
            )
          })()}
          {(() => {
            const d = dayjs(order.updated_at)
            const by = order.updated_by_user_code ?? order.updated_by_user_name
            return (
              <Descriptions.Item label="最后改动">
                <div>{d.format('YYYY-MM-DD')}</div>
                <div style={{ color: '#888' }}>
                  {d.format('HH:mm')}{by ? `（${by}）` : ''}
                </div>
              </Descriptions.Item>
            )
          })()}
          {/* 备注：始终独占最后一行（span=2 跨两列）；备注文字靠左，不随其他格居中 */}
          <Descriptions.Item
            label="备注"
            span={2}
            contentStyle={{ padding: '4px 4px', textAlign: 'left' }}
          >
            {order.note ?? ''}
          </Descriptions.Item>
        </Descriptions>

        <Divider orientation="center">订单项目</Divider>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          tableLayout="fixed"
          dataSource={order.items}
          columns={[
            {
              title: '项目',
              align: 'center',
              onHeaderCell: centerHeader,
              onCell: compactCell,
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
            {
              title: '数量',
              dataIndex: 'quantity',
              width: 56,
              align: 'center',
              onHeaderCell: centerHeader,
              onCell: nowrapCell,
            },
            {
              title: '单价',
              align: 'center',
              onHeaderCell: centerHeader,
              onCell: nowrapCell,
              render: (_, item) => `¥${fenToYuan(item.unit_price)}`,
            },
            {
              title: '小计',
              align: 'center',
              onHeaderCell: centerHeader,
              onCell: nowrapCell,
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

            {/* "调整项"标题行 + 右侧加号按钮（与编辑订单页"添加项目"同款图标） */}
            <div style={{ display: 'flex', alignItems: 'center', margin: '8px 0' }}>
              <div style={{ flex: 1, height: 1, background: '#f0f0f0' }} />
              <span style={{ padding: '0 12px', fontWeight: 500 }}>调整项</span>
              <Button
                type="dashed"
                size="small"
                icon={<PlusOutlined />}
                title="添加调整项"
                style={{ width: 28, height: 24, padding: 0 }}
                onClick={() => {
                  adjustForm.resetFields()
                  setAdjustQty(1)
                  setAdjustTab('charge')
                  setAdjustOpen(true)
                }}
              />
              <div style={{ flex: 1, height: 1, background: '#f0f0f0' }} />
            </div>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={payment.adjustments}
              columns={[
                {
                  title: '说明',
                  dataIndex: 'note',
                  onHeaderCell: centerHeader,
                  onCell: compactCell,
                },
                {
                  title: '金额',
                  width: 96,
                  align: 'right',
                  onHeaderCell: centerHeader,
                  onCell: nowrapCell,
                  render: (_, item) => (
                    <span style={{ color: item.amount > 0 ? '#cf1322' : '#3f8600' }}>
                      {item.amount > 0 ? '+' : ''}¥{fenToYuan(item.amount)}
                    </span>
                  ),
                },
                {
                  title: '时间',
                  width: 162,
                  onHeaderCell: centerHeader,
                  onCell: compactCell,
                  render: (_, item) => {
                    const d = dayjs(item.created_at)
                    const main = `${d.format('YYYY-MM-DD')} ${d.format('HH:mm')}`
                    const by = (item.created_by_user_code ?? item.created_by_user_name)?.trim()
                    return (
                      <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                        {by && by.length >= 3 ? (
                          <>
                            <div style={{ whiteSpace: 'nowrap' }}>{main}</div>
                            <div style={{ whiteSpace: 'nowrap' }}>（{by}）</div>
                          </>
                        ) : (
                          <div style={{ whiteSpace: 'nowrap' }}>
                            {main}
                            {by ? `（${by}）` : ''}
                          </div>
                        )}
                      </div>
                    )
                  },
                },
              ]}
            />
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
        confirmLoading={adjustSubmitting}
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
