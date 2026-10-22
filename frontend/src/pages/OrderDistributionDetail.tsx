import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, DatePicker, Space } from 'antd'
import { LeftOutlined, RightOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { api } from '../api'
import { OrderDistributionChart } from './Dashboard'
import type { Order } from '../types'

export default function OrderDistributionDetail() {
  const [date, setDate] = useState<Dayjs>(dayjs())
  const [orderDates, setOrderDates] = useState<string[]>([])
  const navigate = useNavigate()
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
      .catch(() => {
        // ignore — buttons will be disabled
      })
  }, [])

  const nextOrderDate = useMemo(() => {
    const next = orderDates.find((d) => dayjs(d).isAfter(date, 'day'))
    return next ? dayjs(next) : null
  }, [orderDates, date])

  const prevOrderDate = useMemo(() => {
    const prev = [...orderDates].reverse().find((d) => dayjs(d).isBefore(date, 'day'))
    return prev ? dayjs(prev) : null
  }, [orderDates, date])

  return (
    <div>
      <Button
        type="link"
        onClick={() => navigate('/dashboard')}
        style={{ marginBottom: 16, paddingLeft: 0 }}
      >
        ← 返回概览
      </Button>
      <Card title="当日订单分布" style={{ marginBottom: 16 }}>
        <Space style={{ marginBottom: 16 }}>
          <Button
            icon={<LeftOutlined />}
            onClick={() => {
              if (prevOrderDate) setDate(prevOrderDate)
            }}
            disabled={!prevOrderDate}
          />
          <DatePicker
            value={date}
            onChange={(v) => v && setDate(v)}
            allowClear={false}
            style={{ width: 160 }}
          />
          <Button
            icon={<RightOutlined />}
            onClick={() => {
              if (nextOrderDate) setDate(nextOrderDate)
            }}
            disabled={!nextOrderDate}
          />
        </Space>
        <OrderDistributionChart date={dateStr} showMoreButton={false} />
      </Card>
    </div>
  )
}
