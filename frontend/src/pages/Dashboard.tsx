import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { App, Button, Card, Space, Spin, Table, Tag } from 'antd'
import dayjs from 'dayjs'
import { api } from '../api'
import { useAuth } from '../auth'
import { fenToYuan, typeColorHex } from '../utils'
import { ForecastPanel } from './Forecast'
import type { Catalog, DashboardData, OrderDistribution } from '../types'

const STATUS_OPTIONS: { key: string; label: string; color: string }[] = [
  { key: 'active', label: '预订', color: 'green' },
  { key: 'in_progress', label: '进行中', color: 'blue' },
  { key: 'completed', label: '已完成', color: 'cyan' },
  { key: 'cancelled', label: '已取消', color: 'orange' },
  { key: 'no_show', label: '爽约', color: 'red' },
]

export default function Dashboard() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { message } = App.useApp()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(false)

  const canViewRevenue = Boolean(
    user && (user.role === 'superuser' || user.role === 'admin' || user.permissions.view_revenue),
  )

  useEffect(() => {
    setLoading(true)
    api
      .get<DashboardData>('/api/dashboard')
      .then((d) => setData(d))
      .catch((error) => message.error(error instanceof Error ? error.message : '加载失败'))
      .finally(() => setLoading(false))
  }, [message])

  return (
    <Spin spinning={loading}>
      <Space direction="vertical" style={{ display: 'flex' }} size="middle">
        {/* 船只用量（概览首页默认展示当日） */}
        <Card
          title="船只用量"
          extra={
            <Button type="link" onClick={() => navigate('/dashboard/forecast')}>
              更多
            </Button>
          }
        >
          <ForecastPanel dateStr={data?.today ?? new Date().toISOString().slice(0, 10)} />
        </Card>

        {/* 订单分布 */}
        <Card title="订单分布">
          {data ? (
            <Space direction="vertical" style={{ display: 'flex' }}>
              {STATUS_OPTIONS.map((s) => {
                const count = data.status_counts[s.key as keyof typeof data.status_counts] ?? 0
                const amount = data.status_amounts_fen[s.key as keyof typeof data.status_amounts_fen] ?? 0
                return (
                  <div
                    key={s.key}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
                    onClick={() => {
                      navigate(`/orders?status=${s.key}&day=${data.today}`)
                    }}
                  >
                    <div style={{ width: 64, flexShrink: 0 }}>
                      <Tag color={s.color}>{s.label}</Tag>
                    </div>
                    <div style={{ flex: 1, textAlign: 'center', fontWeight: 600 }}>{count}</div>
                    <div style={{ width: 96, textAlign: 'right', fontWeight: 600 }}>
                      {canViewRevenue ? (
                        `¥${fenToYuan(amount)}`
                      ) : (
                        <span style={{ visibility: 'hidden' }}>¥0</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </Space>
          ) : (
            <p style={{ color: '#999' }}>暂无数据</p>
          )}
        </Card>

        {/* 今日概况 */}
        <Card
          title="今日概况"
          extra={
            <Button type="link" onClick={() => navigate('/dashboard/daily-summary')}>
              更多
            </Button>
          }
        >
          {data ? (
            <Space wrap size="middle">
              <div style={{ textAlign: 'center', minWidth: 100 }}>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{data.today_orders}</div>
                <div style={{ fontSize: 12, color: '#999' }}>今日订单</div>
              </div>
              <div style={{ textAlign: 'center', minWidth: 100 }}>
                <div style={{ fontSize: 24, fontWeight: 700 }}>
                  {canViewRevenue ? `¥${fenToYuan(data.today_completed_amount_fen)}` : '—'}
                </div>
                <div style={{ fontSize: 12, color: '#999' }}>已完成金额</div>
              </div>
              <div style={{ textAlign: 'center', minWidth: 100 }}>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{data.checked_in_now}</div>
                <div style={{ fontSize: 12, color: '#999' }}>当前签到</div>
              </div>
            </Space>
          ) : (
            <p style={{ color: '#999' }}>暂无数据</p>
          )}
        </Card>
      </Space>
    </Spin>
  )
}

// ── OrderDistributionChart（横向条形图）：详情页复用 ──

function lightenHex(hex: string, ratio = 0.55): string {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  const mix = (c: number) => Math.round(c + (255 - c) * ratio)
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
}

export function OrderDistributionChart({
  date,
  showMoreButton = true,
}: {
  date: string
  showMoreButton?: boolean
}) {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const [dist, setDist] = useState<OrderDistribution | null>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [loading, setLoading] = useState(false)
  const chartRef = useRef<HTMLDivElement>(null)
  const isToday = date === dayjs().format('YYYY-MM-DD')

  // 加载分布数据 + 器材目录（取颜色）
  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.get<OrderDistribution>(`/api/dashboard/order-distribution?date=${date}`),
      api.get<Catalog>('/api/catalog'),
    ])
      .then(([d, c]) => {
        setDist(d)
        setCatalog(c)
      })
      .catch((error) => message.error(error instanceof Error ? error.message : '加载失败'))
      .finally(() => setLoading(false))
  }, [date, message])

  // 当前时间红线定位：按槽内分钟比例精确落在对应行（行高 26）
  const nowLineTop = useMemo(() => {
    if (!isToday || !dist) return null
    const now = dayjs()
    const minutes = now.hour() * 60 + now.minute()
    const slotIdx = Math.floor(minutes / 30)
    if (slotIdx < 0 || slotIdx >= dist.slots.length) return null
    const withinPct = (minutes % 30) / 30
    return slotIdx * 26 + withinPct * 26
  }, [isToday, dist])

  // 自动滚动使红线居中
  useEffect(() => {
    if (!chartRef.current || nowLineTop == null) return
    const el = chartRef.current
    const target = nowLineTop - el.clientHeight / 2
    el.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
  }, [nowLineTop])

  // 收集所有器材类型名及其颜色
  const typeColors = useMemo(() => {
    const map: Record<string, string> = {}
    if (!catalog) return map
    catalog.equipment_types.forEach((t) => {
      map[t.name] = typeColorHex(t.color) ?? '#0e7a8c'
    })
    return map
  }, [catalog])

  if (loading) return <Spin spinning />

  if (!dist || dist.slots.every((s) => s.total === 0)) {
    return <p style={{ color: '#999' }}>当日暂无器材使用记录。</p>
  }

  const maxTotal = Math.max(1, ...dist.slots.map((s) => s.total))

  return (
    <div>
      <div
        ref={chartRef}
        style={{ maxHeight: 300, overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}
      >
        {dist.slots.map((slot, idx) => {
          const segments = slot.segments
          return (
            <div
              key={slot.slot}
              style={{
                display: 'flex',
                alignItems: 'center',
                height: 26,
                borderBottom: '1px dashed #f0f0f0',
                position: 'relative',
              }}
            >
              <span style={{ width: 44, flexShrink: 0, fontSize: 12, color: '#666', paddingLeft: 4 }}>
                {slot.slot}
              </span>
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  height: 16,
                  background: '#fafafa',
                  borderRadius: 2,
                  overflow: 'hidden',
                }}
              >
                {segments.map((seg, i) => {
                  const color = typeColors[seg.type] ?? '#0e7a8c'
                  const bg = seg.category === 'reserved' ? lightenHex(color) : color
                  const width = (seg.count / maxTotal) * 100
                  return (
                    <div
                      key={`${seg.type}-${i}`}
                      style={{
                        width: `${width}%`,
                        background: bg,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: seg.category === 'reserved' ? '#333' : '#fff',
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                      title={`${seg.type} · ${seg.category === 'reserved' ? '预订' : '已使用'} ${seg.count}`}
                    >
                      {seg.count}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
        {/* 当前时间红线 */}
        {nowLineTop != null && (
          <div
            style={{
              position: 'absolute',
              left: 44,
              right: 0,
              top: nowLineTop,
              borderTop: '2px solid #ff4d4f',
              pointerEvents: 'none',
              zIndex: 2,
            }}
          >
            <span
              style={{
                position: 'absolute',
                left: 0,
                top: -14,
                fontSize: 11,
                color: '#ff4d4f',
                background: '#fff',
                padding: '0 4px',
                lineHeight: '14px',
              }}
            >
              现在 {dayjs().format('HH:mm')}
            </span>
          </div>
        )}
      </div>

      {/* 图例：仅各器材类型色块+名称 */}
      <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {Object.entries(typeColors).map(([name, color]) => (
          <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: color }} />
            {name}
          </div>
        ))}
      </div>

      {showMoreButton && (
        <div style={{ marginTop: 12, textAlign: 'right' }}>
          <Button type="link" onClick={() => navigate('/dashboard/order-distribution')}>
            更多
          </Button>
        </div>
      )}
    </div>
  )
}
