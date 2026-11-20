import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { App, Button, Card, DatePicker, Select, Spin, Space, Table } from 'antd'
import { LeftOutlined, RightOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { api } from '../api'
import { useAuth } from '../auth'
import { fenToYuan, typeColorHex } from '../utils'
import FloatingBackButton from '../components/FloatingBackButton'
import { useLayoutMode } from '../layoutMode'
import type {
  DailySummary as DailySummaryData,
  Order,
  RevenueCalendar,
  RevenueCalendarDay,
} from '../types'

export default function DailySummary({
  embedded = false,
  rightTop = null,
}: {
  embedded?: boolean
  /** 桌面端右列上方插入的内容（如概览页的看板卡片） */
  rightTop?: ReactNode
}) {
  const [date, setDate] = useState<Dayjs>(dayjs())
  // 销售额日历：当前查看的月份（每月 1 日）及该月每日销售额
  const [month, setMonth] = useState<Dayjs>(dayjs().startOf('month'))
  const [revenue, setRevenue] = useState<RevenueCalendar | null>(null)
  const [revLoading, setRevLoading] = useState(false)
  const [summary, setSummary] = useState<DailySummaryData | null>(null)
  const [orderDates, setOrderDates] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const { isMobile } = useLayoutMode()
  const { message } = App.useApp()
  const { user } = useAuth()
  const canViewRevenue = Boolean(
    user && (user.role === 'superuser' || user.role === 'admin' || user.permissions.view_revenue),
  )
  const dateStr = date.format('YYYY-MM-DD')
  const monthKey = month.format('YYYY-MM')

  // 销售额日历：按月份拉取每日销售额
  useEffect(() => {
    setRevLoading(true)
    api
      .get<RevenueCalendar>(`/api/dashboard/revenue-calendar?month=${monthKey}`)
      .then(setRevenue)
      .catch((error) => message.error(error.message))
      .finally(() => setRevLoading(false))
  }, [monthKey, message])

  const dailyAmount = useMemo(() => {
    const map = new Map<string, RevenueCalendarDay>()
    for (const d of revenue?.days ?? []) map.set(d.date, d)
    return map
  }, [revenue])

  // 日历展示内容：销售额 / 订单数 / 预订散客 / 指定船型数量
  const [metric, setMetric] = useState('revenue')
  const metricOptions = useMemo(
    () => [
      { value: 'revenue', label: '销售额' },
      { value: 'orders', label: '订单数' },
      { value: 'booking', label: '预/散' },
      ...(revenue?.specs ?? []).map((s) => ({ value: `spec:${s.id}`, label: s.name })),
    ],
    [revenue],
  )

  // 月度日历格子：周一起始，前置空位补齐
  const calendarCells = useMemo(() => {
    const firstWeekday = (month.day() + 6) % 7
    const cells: (number | null)[] = Array.from({ length: firstWeekday }, () => null)
    for (let d = 1; d <= month.daysInMonth(); d += 1) cells.push(d)
    return cells
  }, [month])

  // 金额显示：整元不带小数，整数部分加英文逗号千位符（如 1,280 / 1,280.50）
  const formatThousands = (fen: number) => {
    const negative = fen < 0
    const abs = Math.abs(fen)
    const text = abs % 100 === 0 ? String(abs / 100) : (abs / 100).toFixed(2)
    const [intPart, decPart] = text.split('.')
    const withComma = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return `${negative ? '-' : ''}${decPart ? `${withComma}.${decPart}` : withComma}`
  }

  // 日历格子内展示的数字，随上方下拉菜单切换
  // 没有数据的日期（金额/数量为 0）统一显示灰色的 “-”，而不是留空
  const renderCellValue = (dayData: RevenueCalendarDay | undefined) => {
    const dash = <span style={{ fontSize: 11, color: '#bfbfbf' }}>-</span>
    const amount = dayData?.amount_fen ?? 0
    const orderCount = dayData?.order_count ?? 0
    const bookingCount = dayData?.booking_count ?? 0
    const walkinCount = dayData?.walkin_count ?? 0
    if (metric === 'revenue') {
      if (!canViewRevenue) return null
      if (amount === 0) return dash
      return (
        <span style={{ fontSize: 11, fontWeight: 600, color: '#1f7a5c' }}>
          {formatThousands(amount)}
        </span>
      )
    }
    if (metric === 'orders') {
      if (orderCount === 0) return dash
      return <span style={{ fontSize: 11, fontWeight: 600, color: '#2f6474' }}>{orderCount}</span>
    }
    if (metric === 'booking') {
      if (bookingCount === 0 && walkinCount === 0) return dash
      // 预订/散客：只显示两个数字，没有的用 - 代替（如 57/-、68/31）
      return (
        <span style={{ fontSize: 11, fontWeight: 600, color: '#2f6474', whiteSpace: 'nowrap' }}>
          {bookingCount === 0 ? '-' : bookingCount}/{walkinCount === 0 ? '-' : walkinCount}
        </span>
      )
    }
    if (metric.startsWith('spec:')) {
      const specId = metric.slice(5)
      const qty = dayData?.spec_quantities[specId] ?? 0
      if (qty === 0) return dash
      // 数量使用该船型预设的颜色，未配置颜色时回退主题蓝
      const specColor = typeColorHex(revenue?.specs.find((s) => s.id === specId)?.type_color) ?? '#2f6474'
      return <span style={{ fontSize: 11, fontWeight: 600, color: specColor }}>{qty}</span>
    }
    return null
  }

  useEffect(() => {
    api
      .get<Order[]>('/api/orders')
      .then((orders) => {
        const dates = [
          ...new Set(orders.map((o) => dayjs(o.start_at).format('YYYY-MM-DD'))),
        ].sort()
        setOrderDates(dates)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    setLoading(true)
    api
      .get<DailySummaryData>(`/api/dashboard/daily-summary?date=${dateStr}`)
      .then(setSummary)
      .catch((error) => message.error(error.message))
      .finally(() => setLoading(false))
  }, [dateStr, message])

  const nextOrderDate = useMemo(() => {
    const next = orderDates.find((d) => dayjs(d).isAfter(date, 'day'))
    return next ? dayjs(next) : null
  }, [orderDates, date])

  const prevOrderDate = useMemo(() => {
    const prev = [...orderDates].reverse().find((d) => dayjs(d).isBefore(date, 'day'))
    return prev ? dayjs(prev) : null
  }, [orderDates, date])

  // 表头文字居中，数据列仍保持原有对齐方式
  const centerHeaderCell = () => ({ style: { textAlign: 'center' as const } })

  const amountCol = {
    title: '金额',
    dataIndex: 'amount_fen',
    key: 'amount_fen',
    width: 100,
    align: 'right' as const,
    onHeaderCell: centerHeaderCell,
    render: (fen: number) => (canViewRevenue ? `¥${fenToYuan(fen)}` : '—'),
  }

  const usageColumns = [
    { title: '名称', dataIndex: 'name', key: 'name', onHeaderCell: centerHeaderCell },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 80,
      align: 'right' as const,
      onHeaderCell: centerHeaderCell,
    },
    amountCol,
  ]

  const othersColumns = [
    { title: '备注', dataIndex: 'note', key: 'note', onHeaderCell: centerHeaderCell },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 80,
      align: 'right' as const,
      onHeaderCell: centerHeaderCell,
    },
    amountCol,
  ]

  const eqTotal = summary?.equipment_usage.reduce((s, e) => s + e.amount_fen, 0) ?? 0
  const saleTotal = summary?.sale_item_usage.reduce((s, e) => s + e.amount_fen, 0) ?? 0
  const othersTotal = summary?.others.reduce((s, e) => s + e.amount_fen, 0) ?? 0
  const totalAmount = eqTotal + saleTotal + othersTotal

  return (
    <div>
      {!embedded && (
        <FloatingBackButton onClick={() => navigate('/dashboard')} ariaLabel="返回概览" />
      )}
      {/* 桌面端左右并排：当日总结够宽即可，销售日历移到右侧；手机端仍上下堆叠 */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          alignItems: 'flex-start',
        }}
      >
      <Card
        title="当日总结"
        style={{
          width: isMobile ? '100%' : 720,
          boxSizing: 'border-box',
          marginBottom: isMobile ? 16 : 0,
        }}
      >
        <Space style={{ marginBottom: 16 }}>
          <Button
            icon={<LeftOutlined />}
            onClick={() => setDate(date.subtract(1, 'day'))}
          />
          <DatePicker
            value={date}
            onChange={(v) => v && setDate(v)}
            allowClear={false}
            style={{ width: 150 }}
          />
          <Button
            icon={<RightOutlined />}
            onClick={() => setDate(date.add(1, 'day'))}
          />
          {summary && (
            <span style={{ color: '#999', fontSize: 12 }}>
              {summary.is_future ? '预订订单预估' : '已完成/进行中订单'} · 共 {summary.order_count} 单
            </span>
          )}
        </Space>

        <Spin spinning={loading}>
          {summary ? (
            <Space direction="vertical" style={{ display: 'flex' }} size="large">
              <div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>船型使用</div>
                <Table
                  size="small"
                  tableLayout="fixed"
                  columns={usageColumns}
                  dataSource={summary.equipment_usage.map((e, i) => ({ ...e, key: i }))}
                  pagination={false}
                  summary={() =>
                    canViewRevenue ? (
                      <Table.Summary fixed>
                        <Table.Summary.Row>
                          <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
                          <Table.Summary.Cell index={1} align="right">
                            {summary.equipment_usage.reduce((s, e) => s + e.quantity, 0)}
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={2} align="right">
                            ¥{fenToYuan(eqTotal)}
                          </Table.Summary.Cell>
                        </Table.Summary.Row>
                      </Table.Summary>
                    ) : null
                  }
                />
              </div>

              <div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>销售项目</div>
                <Table
                  size="small"
                  tableLayout="fixed"
                  columns={usageColumns}
                  dataSource={summary.sale_item_usage.map((e, i) => ({ ...e, key: i }))}
                  pagination={false}
                  summary={() =>
                    canViewRevenue ? (
                      <Table.Summary fixed>
                        <Table.Summary.Row>
                          <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
                          <Table.Summary.Cell index={1} align="right">
                            {summary.sale_item_usage.reduce((s, e) => s + e.quantity, 0)}
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={2} align="right">
                            ¥{fenToYuan(saleTotal)}
                          </Table.Summary.Cell>
                        </Table.Summary.Row>
                      </Table.Summary>
                    ) : null
                  }
                />
              </div>

              <div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>
                  其他{summary.is_future ? '（未来日期无调整项）' : ''}
                </div>
                <Table
                  size="small"
                  tableLayout="fixed"
                  columns={othersColumns}
                  dataSource={summary.others.map((e, i) => ({ ...e, key: i }))}
                  pagination={false}
                  locale={{ emptyText: '暂无' }}
                  summary={() =>
                    canViewRevenue && !summary.is_future ? (
                      <Table.Summary fixed>
                        <Table.Summary.Row>
                          <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
                          <Table.Summary.Cell index={1} align="right">
                            {summary.others.reduce((s, e) => s + e.quantity, 0)}
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={2} align="right">
                            ¥{fenToYuan(othersTotal)}
                          </Table.Summary.Cell>
                        </Table.Summary.Row>
                      </Table.Summary>
                    ) : null
                  }
                />
              </div>

              {canViewRevenue && (
                <div style={{ textAlign: 'right', fontWeight: 600, fontSize: 14 }}>
                  总收款金额：¥{fenToYuan(totalAmount)}
                </div>
              )}

              {/* 收款方式统计（最底部） */}
              {canViewRevenue && !summary.is_future && (
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>收款方式</div>
                  {summary.payment_method_totals.length > 0 ? (
                    <Table
                      size="small"
                      tableLayout="fixed"
                      columns={[
                        { title: '方式', dataIndex: 'name', key: 'name', onHeaderCell: centerHeaderCell },
                        {
                          title: '代码',
                          dataIndex: 'code',
                          key: 'code',
                          width: 80,
                          onHeaderCell: centerHeaderCell,
                        },
                        {
                          title: '金额',
                          dataIndex: 'amount_fen',
                          key: 'amount_fen',
                          width: 100,
                          align: 'right' as const,
                          onHeaderCell: centerHeaderCell,
                          render: (fen: number) => `¥${fenToYuan(fen)}`,
                        },
                      ]}
                      dataSource={summary.payment_method_totals.map((p, i) => ({ ...p, key: i }))}
                      pagination={false}
                      summary={() => (
                        <Table.Summary fixed>
                          <Table.Summary.Row>
                            <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
                            <Table.Summary.Cell index={1} />
                            <Table.Summary.Cell index={2} align="right">
                              ¥{fenToYuan(summary.payment_method_totals.reduce((s, p) => s + p.amount_fen, 0))}
                            </Table.Summary.Cell>
                          </Table.Summary.Row>
                        </Table.Summary>
                      )}
                    />
                  ) : (
                    <p style={{ color: '#999', margin: 0 }}>暂无收款记录</p>
                  )}
                </div>
              )}
            </Space>
          ) : (
            <p style={{ color: '#999' }}>暂无数据</p>
          )}
        </Spin>
      </Card>

      {/* 桌面端右列：上方可插入其他卡片（如看板），下方固定销售日历 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {rightTop}
      {/* 销售日历：按月展示每日销售额 */}
      <Card
        title="销售日历"
        style={{
          width: isMobile ? '100%' : 460,
          boxSizing: 'border-box',
          marginBottom: isMobile ? 16 : 0,
        }}
        extra={
          <Space size={4}>
            <Button
              size="small"
              icon={<LeftOutlined />}
              aria-label="上个月"
              onClick={() => setMonth(month.subtract(1, 'month'))}
            />
            <span style={{ fontWeight: 600, fontSize: 13 }}>{month.format('YYYY年M月')}</span>
            <Button
              size="small"
              icon={<RightOutlined />}
              aria-label="下个月"
              onClick={() => setMonth(month.add(1, 'month'))}
            />
            <Select
              size="small"
              value={metric}
              onChange={setMetric}
              options={metricOptions}
              style={{ width: 108 }}
              popupMatchSelectWidth={false}
            />
          </Space>
        }
      >
        <div style={{ marginBottom: 8, fontSize: 13, color: '#4e636d' }}>
          本月销售额：
          {canViewRevenue ? (
            <strong>¥{formatThousands(revenue?.total_fen ?? 0)}</strong>
          ) : (
            <strong>—</strong>
          )}
        </div>
        <Spin spinning={revLoading}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(7, 1fr)',
              gap: 2,
              textAlign: 'center',
            }}
          >
            {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
              <div key={w} style={{ fontSize: 12, color: '#4e636d', fontWeight: 600, padding: '2px 0' }}>
                {w}
              </div>
            ))}
            {calendarCells.map((day, index) => {
              if (day === null) return <div key={`empty-${index}`} />
              const cellDate = month.date(day).format('YYYY-MM-DD')
              const dayData = dailyAmount.get(cellDate)
              const isToday = cellDate === dayjs().format('YYYY-MM-DD')
              return (
                <div
                  key={cellDate}
                  style={{
                    minHeight: 44,
                    padding: '3px 2px',
                    borderRadius: 4,
                    border: isToday ? '1px solid #c96f4a' : '1px solid #e4ecee',
                    background: isToday ? '#fbeee8' : '#fff',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 1,
                  }}
                >
                  <span style={{ fontSize: 12, color: isToday ? '#c96f4a' : '#4e636d', fontWeight: isToday ? 700 : 500 }}>{day}</span>
                  {renderCellValue(dayData)}
                </div>
              )
            })}
          </div>
        </Spin>
      </Card>
      </div>
      </div>
    </div>
  )
}
