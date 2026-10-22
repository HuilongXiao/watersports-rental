import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tabs,
} from 'antd'
import dayjs from 'dayjs'
import { api } from '../api'
import { useSettings } from '../contexts/SettingsContext'
import { formatDurationBetween, typeColorHex } from '../utils'
import type { Catalog } from '../types'

interface BoardAssigned {
  dispatch_id: string
  number: string
  departed_at: string | null
}

interface BoardLine {
  order_item_id: string
  spec_id: string
  spec_name: string
  type_id: string | null
  type_name: string
  type_color: string
  quantity: number
  // 已调配过的船数（含已返还）：返还后不再要求重新填写
  dispatched_total: number
  assigned: BoardAssigned[]
}

interface BoardOrder {
  order_id: string
  order_number: string
  customer_name: string | null
  customer_gender: string | null
  customer_wechat_nickname: string | null
  check_in_at: string | null
  lines: BoardLine[]
}

interface DepartedBoat {
  dispatch_id: string
  order_id: string
  order_number: string
  customer_name: string | null
  customer_gender: string | null
  customer_wechat_nickname: string | null
  spec_name: string
  type_id: string | null
  type_name: string
  type_color: string
  number: string
  departed_at: string | null
}

interface BoardData {
  orders: BoardOrder[]
  departed: DepartedBoat[]
}

// 器材类型筛选按浏览器记住上一次选择（进入页面不重置）
const TYPE_FILTER_KEY = 'boats_type_filter'

function customerLabel(row: {
  customer_name: string | null
  customer_gender: string | null
  customer_wechat_nickname: string | null
}): string {
  const name = row.customer_name?.trim() ?? ''
  const gender = row.customer_gender?.trim() ?? ''
  if (name) return `${name}${gender}`
  return row.customer_wechat_nickname?.trim() || '游客'
}

function formatTime(value: string | null): string {
  if (!value) return ''
  return dayjs(value).format('HH:mm')
}

function formatDuration(value: string | null): string {
  if (!value) return ''
  const minutes = Math.max(0, dayjs().diff(dayjs(value), 'minute'))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours > 0 ? `${hours} 小时 ${rest} 分钟` : `${rest} 分钟`
}

// 单条船编号输入行：回车或失焦时提交，出错后清空要求重新输入
function BoatNumberInput({
  orderItemId,
  specName,
  typeColor,
  onAssigned,
}: {
  orderItemId: string
  specName: string
  typeColor: string
  onAssigned: () => Promise<void>
}) {
  const { message } = App.useApp()
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    const number = value.trim()
    if (!number || submitting) return
    setSubmitting(true)
    try {
      await api.post('/api/boats/assign', { order_item_id: orderItemId, number })
      setValue('')
      await onAssigned()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '调配失败，请重新输入')
      setValue('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
      <span style={{ color: typeColorHex(typeColor), fontWeight: 600, whiteSpace: 'nowrap' }}>
        {specName}
      </span>
      <span style={{ color: '#666', flex: 1, textAlign: 'center', whiteSpace: 'nowrap' }}>
        调配船只编号：
      </span>
      <span
        style={{
          width: 100,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 4,
          whiteSpace: 'nowrap',
        }}
      >
        <Input
          type="tel"
          inputMode="tel"
          pattern="[0-9]*"
          size="small"
          style={{ width: 76, color: typeColorHex(typeColor) }}
          value={value}
          disabled={submitting}
          onChange={(e) => setValue(e.target.value)}
          onPressEnter={submit}
          onBlur={() => {
            if (value.trim()) submit()
          }}
        />
        <span style={{ color: '#666' }}>号</span>
      </span>
    </div>
  )
}

export default function Boats() {
  const { message } = App.useApp()
  const { settings } = useSettings()
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [board, setBoard] = useState<BoardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<'depart' | 'return'>('depart')
  const [typeFilter, setTypeFilter] = useState<string>(
    () => localStorage.getItem(TYPE_FILTER_KEY) ?? '',
  )
  // 返还确认弹窗（与「新建规格」弹窗同样式）：保存待返还船只的 dispatch id
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [boardData, catalogData] = await Promise.all([
        api.get<BoardData>('/api/boats/board'),
        api.get<Catalog>('/api/catalog').catch(() => null),
      ])
      setBoard(boardData)
      if (catalogData) setCatalog(catalogData)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    load()
  }, [load])

  const changeTypeFilter = (value: string) => {
    setTypeFilter(value)
    try {
      if (value) localStorage.setItem(TYPE_FILTER_KEY, value)
      else localStorage.removeItem(TYPE_FILTER_KEY)
    } catch {
      // localStorage 不可用时仅当前会话生效
    }
  }

  const typeOptions = useMemo(
    () => [
      { value: '', label: '全部类型' },
      ...(catalog?.equipment_types ?? []).map((t) => ({ value: t.id, label: t.name })),
    ],
    [catalog],
  )

  const matchType = (typeId: string | null) => !typeFilter || typeId === typeFilter

  // 出发：只显示进行中且还有船只待调配的订单，按签到时间先后排序（后端已排序）
  const departCards = useMemo(() => {
    return (board?.orders ?? [])
      .map((order) => ({
        order,
        lines: order.lines.filter((line) => matchType(line.type_id)),
      }))
      .filter((row) =>
        row.lines.some((line) => line.quantity - line.dispatched_total > 0),
      )
  }, [board, typeFilter])

  // 返还：至少有一条已出发船只的订单才出现卡片（部分调配也出现）
  const returnCards = useMemo(() => {
    return (board?.orders ?? [])
      .map((order) => ({
        order,
        lines: order.lines.filter((line) => matchType(line.type_id)),
      }))
      .filter((row) => row.lines.some((line) => line.assigned.length > 0))
  }, [board, typeFilter])

  const departedBoats = useMemo(
    () => (board?.departed ?? []).filter((boat) => matchType(boat.type_id)),
    [board, typeFilter],
  )

  const doReturn = async (dispatchId: string) => {
    try {
      const result = await api.post<{ order_completed: boolean }>(
        `/api/boats/return/${dispatchId}`,
      )
      message.success(result.order_completed ? '已返还，订单已完成' : '已返还')
      setConfirmId(null)
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '返还失败')
    }
  }

  // 出发不足 30 分钟才允许「重新出发」（撤销本次出发，船只回到待调配）
  const canReset = (departedAt: string | null) =>
    Boolean(departedAt) && dayjs().diff(dayjs(departedAt as string), 'minute') < 30

  const doReset = async (dispatchId: string) => {
    try {
      await api.post(`/api/boats/reset/${dispatchId}`)
      message.success('已重新出发，请重新调配船只编号')
      setConfirmId(null)
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '重新出发失败')
    }
  }

  // 待返还船只：取未过滤列表，避免类型筛选后找不到弹窗数据
  const confirmBoat = useMemo(
    () => (board?.departed ?? []).find((b) => b.dispatch_id === confirmId) ?? null,
    [board, confirmId],
  )

  const renderReturnModal = () => (
    <Modal
      open={Boolean(confirmBoat)}
      title={
        <span>
          是否返还
          <span
            style={{
              color: typeColorHex(confirmBoat?.type_color ?? null),
              fontWeight: 600,
            }}
          >
            {confirmBoat?.number ?? ''}
          </span>
          号船只？
        </span>
      }
      onCancel={() => setConfirmId(null)}
      footer={
        <Space>
          <Button onClick={() => setConfirmId(null)}>取消</Button>
          {confirmBoat && canReset(confirmBoat.departed_at) && (
            <Button onClick={() => doReset(confirmBoat.dispatch_id)}>重新出发</Button>
          )}
          {confirmBoat && (
            <Button type="primary" onClick={() => doReturn(confirmBoat.dispatch_id)}>
              确认返还
            </Button>
          )}
        </Space>
      }
    >
      {confirmBoat && (
        // 内容块整体居中，块内各行文字左侧对齐
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <div style={{ fontSize: 14, lineHeight: '28px', textAlign: 'left' }}>
            <div>
              <span style={{ color: '#666' }}>客户信息：</span>
              <span style={{ color: '#000' }}>{customerLabel(confirmBoat)}</span>
            </div>
            <div>
              <span style={{ color: '#666' }}>船只：</span>
              <span style={{ color: typeColorHex(confirmBoat.type_color) }}>
                {confirmBoat.spec_name} {confirmBoat.number}
              </span>
              <span style={{ color: '#000' }}> 号</span>
            </div>
            <div>
              <span style={{ color: '#666' }}>出发时间：</span>
              <span style={{ color: '#000' }}>{formatTime(confirmBoat.departed_at)}</span>
            </div>
            <div>
              <span style={{ color: '#666' }}>占用时长：</span>
              <span style={{ color: '#000' }}>{formatDuration(confirmBoat.departed_at)}</span>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )

  const renderCustomerLine = (row: {
    customer_name: string | null
    customer_gender: string | null
    customer_wechat_nickname: string | null
  }) => (
    <div style={{ fontWeight: 600, marginBottom: 4 }}>
      <span style={{ color: '#666', fontWeight: 400 }}>客户信息：</span>
      {customerLabel(row)}
    </div>
  )

  const departContent = (
    <Spin spinning={loading}>
      {departCards.length === 0 ? (
        <Empty description="暂无进行中的订单" />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {departCards.map(({ order, lines }) => (
            <Card key={order.order_id} size="small">
              {renderCustomerLine(order)}
              {lines.map((line) => {
                const remaining = Math.max(0, line.quantity - line.dispatched_total)
                return (
                  <div key={line.order_item_id}>
                    {line.assigned.map((assigned) => (
                      <div
                        key={assigned.dispatch_id}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}
                      >
                        <span
                          style={{
                            color: typeColorHex(line.type_color),
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {line.spec_name}
                        </span>
                        <span
                          style={{
                            color: '#666',
                            flex: 1,
                            textAlign: 'center',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          调配船只编号：
                        </span>
                        <span
                          style={{
                            width: 100,
                            display: 'flex',
                            justifyContent: 'flex-end',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 600,
                              color: typeColorHex(line.type_color),
                            }}
                          >
                            {assigned.number}
                          </span>
                          <span style={{ color: '#666' }}> 号</span>
                        </span>
                      </div>
                    ))}
                    {Array.from({ length: remaining }).map((_, index) => (
                      <BoatNumberInput
                        key={`${line.order_item_id}-${index}`}
                        orderItemId={line.order_item_id}
                        specName={line.spec_name}
                        typeColor={line.type_color}
                        onAssigned={load}
                      />
                    ))}
                  </div>
                )
              })}
            </Card>
          ))}
        </Space>
      )}
    </Spin>
  )

  const returnContent = (
    <Spin spinning={loading}>
      {departedBoats.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>已出发船只</div>
          <Space size={[8, 8]} wrap>
            {departedBoats.map((boat) => (
              <Button
                key={boat.dispatch_id}
                style={{
                  color: typeColorHex(boat.type_color),
                  fontWeight: 600,
                  height: 48,
                  minWidth: 56,
                  padding: '0 16px',
                  fontSize: 20,
                }}
                onClick={() => setConfirmId(boat.dispatch_id)}
              >
                {boat.number}
              </Button>
            ))}
          </Space>
        </div>
      )}
      {returnCards.length === 0 ? (
        <Empty description="暂无已安排船只的订单" />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {returnCards.map(({ order, lines }) => (
            <Card key={order.order_id} size="small">
              {renderCustomerLine(order)}
              {lines.map((line) => {
                const remaining = Math.max(0, line.quantity - line.dispatched_total)
                return (
                  <div key={line.order_item_id}>
                    {line.assigned.map((assigned) => (
                      <div
                        key={assigned.dispatch_id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          marginTop: 6,
                        }}
                      >
                        <span
                          style={{
                            color: typeColorHex(line.type_color),
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            width: 52,
                            flexShrink: 0,
                          }}
                        >
                          {line.spec_name}
                        </span>
                        <span
                          style={{
                            flex: 1,
                            display: 'flex',
                            justifyContent: 'center',
                            minWidth: 0,
                          }}
                        >
                          {/* 固定宽度的文本块整体居中，保证各行冒号落在同一列 */}
                          <span
                            style={{
                              width: 110,
                              color: '#666',
                              whiteSpace: 'nowrap',
                              textAlign: 'left',
                            }}
                          >
                            使用时长：
                            <span style={{ color: '#000' }}>
                              {assigned.departed_at
                                ? formatDurationBetween(
                                    assigned.departed_at,
                                    new Date().toISOString(),
                                  )
                                : '—'}
                            </span>
                          </span>
                        </span>
                        <span
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            gap: 6,
                            whiteSpace: 'nowrap',
                            width: 106,
                            flexShrink: 0,
                          }}
                        >
                          <span>
                            <span
                              style={{
                                fontWeight: 600,
                                color: typeColorHex(line.type_color),
                              }}
                            >
                              {assigned.number}
                            </span>
                            <span style={{ color: '#666' }}> 号</span>
                          </span>
                          <Button
                            size="small"
                            type="primary"
                            ghost
                            onClick={() => setConfirmId(assigned.dispatch_id)}
                          >
                            返还
                          </Button>
                        </span>
                      </div>
                    ))}
                    {Array.from({ length: remaining }).map((_, index) => (
                      <div
                        key={`${line.order_item_id}-pending-${index}`}
                        style={{ color: '#999', marginTop: 6 }}
                      >
                        {line.spec_name}，还未安排船只
                      </div>
                    ))}
                  </div>
                )
              })}
            </Card>
          ))}
        </Space>
      )}
    </Spin>
  )

  if (!settings.boat_numbering_enabled) {
    return (
      <Card title="船只调配">
        <Empty description="「船只编号」功能未开启，请在「目录与设置 - 系统设置」中开启" />
      </Card>
    )
  }

  return (
    <>
      <Card
        title="船只调配"
        extra={
          <Space size={8}>
            <Select
              size="small"
              style={{ width: 120 }}
              value={typeFilter}
              options={typeOptions}
              onChange={changeTypeFilter}
            />
            <Button size="small" onClick={load} loading={loading}>
              刷新
            </Button>
          </Space>
        }
      >
        <Tabs
          className="boats-tabs"
          activeKey={tab}
          onChange={(key) => setTab(key as 'depart' | 'return')}
          items={[
            { key: 'depart', label: '出发', children: departContent },
            { key: 'return', label: '返还', children: returnContent },
          ]}
        />
      </Card>
      {renderReturnModal()}
    </>
  )
}
