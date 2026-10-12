import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { App, Button, Card, DatePicker, Spin, Space, Table } from 'antd'
import { LeftOutlined, RightOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { api } from '../api'
import { useAuth } from '../auth'
import { fenToYuan } from '../utils'
import type { DailySummary as DailySummaryData, Order } from '../types'

export default function DailySummary() {
  const [date, setDate] = useState<Dayjs>(dayjs())
  const [summary, setSummary] = useState<DailySummaryData | null>(null)
  const [orderDates, setOrderDates] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const { message } = App.useApp()
  const { user } = useAuth()
  const canViewRevenue = Boolean(
    user && (user.role === 'superuser' || user.role === 'admin' || user.permissions.view_revenue),
  )
  const dateStr = date.format('YYYY-MM-DD')

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

  const amountCol = {
    title: '金额',
    dataIndex: 'amount_fen',
    key: 'amount_fen',
    width: 100,
    align: 'right' as const,
    render: (fen: number) => (canViewRevenue ? `¥${fenToYuan(fen)}` : '—'),
  }

  const usageColumns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '数量', dataIndex: 'quantity', key: 'quantity', width: 80, align: 'right' as const },
    amountCol,
  ]

  const othersColumns = [
    { title: '备注', dataIndex: 'note', key: 'note' },
    { title: '数量', dataIndex: 'quantity', key: 'quantity', width: 80, align: 'right' as const },
    amountCol,
  ]

  const eqTotal = summary?.equipment_usage.reduce((s, e) => s + e.amount_fen, 0) ?? 0
  const saleTotal = summary?.sale_item_usage.reduce((s, e) => s + e.amount_fen, 0) ?? 0
  const othersTotal = summary?.others.reduce((s, e) => s + e.amount_fen, 0) ?? 0
  const totalAmount = eqTotal + saleTotal + othersTotal

  return (
    <div>
      <Button
        type="link"
        onClick={() => navigate('/dashboard')}
        style={{ marginBottom: 16, paddingLeft: 0 }}
      >
        ← 返回工作台
      </Button>
      <Card>
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
              {summary.is_future ? '预订订单预估' : '已完成订单'} · 共 {summary.order_count} 单
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
            </Space>
          ) : (
            <p style={{ color: '#999' }}>暂无数据</p>
          )}
        </Spin>
      </Card>
    </div>
  )
}
