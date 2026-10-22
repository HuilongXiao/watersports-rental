import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { App, Button, Card, DatePicker, Space, Spin } from 'antd'
import { LeftOutlined, RightOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { api } from '../api'
import { typeColorHex } from '../utils'
import { useLayoutMode } from '../layoutMode'
import type { ForecastEquipment, InventoryForecast } from '../types'

const FALLBACK_COLOR = '#0e7a8c'
const ROW_HEIGHT = 26
const BAR_HEIGHT = 16
const TIME_GUTTER = 44
const CHART_HEIGHT = 480

function lightenHex(hex: string, ratio = 0.55): string {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  const mix = (c: number) => Math.round(c + (255 - c) * ratio)
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
}

export default function Forecast() {
  const [date, setDate] = useState<Dayjs>(dayjs())
  const navigate = useNavigate()
  const dateStr = date.format('YYYY-MM-DD')

  return (
    <div>
      <Button
        type="link"
        onClick={() => navigate('/dashboard')}
        style={{ marginBottom: 16, paddingLeft: 0 }}
      >
        ← 返回概览
      </Button>
      <Card title="船只用量" style={{ marginBottom: 16 }}>
        <Space style={{ marginBottom: 12 }}>
          <Button icon={<LeftOutlined />} onClick={() => setDate(date.subtract(1, 'day'))} />
          <DatePicker
            value={date}
            onChange={(v) => v && setDate(v)}
            allowClear={false}
            style={{ width: 150 }}
          />
          <Button icon={<RightOutlined />} onClick={() => setDate(date.add(1, 'day'))} />
        </Space>
        <ForecastPanel dateStr={dateStr} />
      </Card>
    </div>
  )
}

// 可复用预测面板：选择器 + 横向条形图；供预测页（带日期选择器）与概览首页（固定当日）共用
export function ForecastPanel({ dateStr }: { dateStr: string }) {
  const [data, setData] = useState<InventoryForecast | null>(null)
  const [loading, setLoading] = useState(false)
  // 左右两列各自独立选中的船型 spec_id；null 表示尚未选择（初始化为第一种船型）
  const [selectedIds, setSelectedIds] = useState<[string | null, string | null]>([null, null])
  const { isMobile } = useLayoutMode()
  const { message } = App.useApp()

  useEffect(() => {
    setLoading(true)
    api
      .get<InventoryForecast>(`/api/dashboard/inventory-forecast?date=${dateStr}`)
      .then((d) => {
        setData(d)
        // 每列默认选中第一种船型；若当前已选中且仍存在则保留
        setSelectedIds((prev) =>
          prev.map((id) =>
            id && d.equipment.some((e) => e.spec_id === id)
              ? id
              : (d.equipment[0]?.spec_id ?? null),
          ) as [string | null, string | null],
        )
      })
      .catch((error) =>
        message.error(error instanceof Error ? error.message : '加载失败'),
      )
      .finally(() => setLoading(false))
  }, [dateStr, message])

  const selected = useMemo(
    () =>
      selectedIds.map(
        (id) => data?.equipment.find((e) => e.spec_id === id) ?? null,
      ),
    [data, selectedIds],
  )

  const renderColumn = (index: 0 | 1) => (
    <SpecSelector
      equipment={data!.equipment}
      selectedId={selectedIds[index]}
      onChange={(id) =>
        setSelectedIds((prev) => {
          const next: [string | null, string | null] = [...prev]
          next[index] = id
          return next
        })
      }
    />
  )

  return (
    <Spin spinning={loading}>
      {!data || data.equipment.length === 0 ? (
        <p style={{ color: '#999' }}>暂无器材目录，请先在“目录与设置”中添加器材。</p>
      ) : isMobile ? (
        // 手机版：单列布局，选择器在上、图表在下
        <div>
          {renderColumn(0)}
          {selected[0] && <ForecastChart eq={selected[0]} slots={data.slots} dateStr={data.date} />}
        </div>
      ) : (
        // 电脑版：左右两列布局，两列独立选择、独立展示
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          {[0, 1].map((i) => (
            <div key={i}>
              {renderColumn(i as 0 | 1)}
              {selected[i] && (
                <ForecastChart eq={selected[i]!} slots={data.slots} dateStr={data.date} />
              )}
            </div>
          ))}
        </div>
      )}
    </Spin>
  )
}

function SpecSelector({
  equipment,
  selectedId,
  onChange,
}: {
  equipment: ForecastEquipment[]
  selectedId: string | null
  onChange: (id: string) => void
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: 8,
        marginBottom: 12,
      }}
    >
      {equipment.map((eq) => {
        const hex = typeColorHex(eq.type_color) ?? FALLBACK_COLOR
        const active = eq.spec_id === selectedId
        return (
          <button
            key={eq.spec_id}
            onClick={() => onChange(eq.spec_id)}
            style={{
              cursor: 'pointer',
              padding: '8px 10px',
              borderRadius: 4,
              border: active ? `2px solid ${hex}` : '1px solid #d9d9d9',
              background: active ? `${hex}14` : '#fff',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
              fontWeight: active ? 600 : 400,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: 2,
                background: hex,
                flexShrink: 0,
              }}
            />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {eq.name}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function ForecastChart({
  eq,
  slots,
  dateStr,
}: {
  eq: ForecastEquipment
  slots: string[]
  dateStr: string
}) {
  const hex = typeColorHex(eq.type_color) ?? FALLBACK_COLOR
  const lightHex = lightenHex(hex)
  const total = eq.total_quantity
  // 占用条封顶：库存总量对应行宽的 94%，右侧 6% 显示可用/超出数量
  const BAR_RATIO = 0.94

  return (
    <div
      style={{
        border: '1px solid #f0f0f0',
        borderRadius: 4,
        maxHeight: CHART_HEIGHT,
        overflowY: 'auto',
        overflowX: 'hidden',
      }}
    >
      <div style={{ position: 'relative' }}>
        {slots.map((slot, i) => {
          const used = eq.occupied_used[i]
          const reserved = eq.occupied_active[i]
          const occupied = used + reserved
          // 当前及过去时段右侧「可用」取该时段最后一刻（槽结束时刻）的真实可用
          // 船只数：例如 15:00-15:30 峰值占用 2 条，但 15:30 时只剩 1 条在用，
          // 可用即 3；未来时段仍按「总量 - 已用 - 预订」算，保留预订占位。
          const slotStart = dayjs(dateStr).hour(+slot.slice(0, 2)).minute(+slot.slice(3, 5))
          const isPastOrCurrent = !slotStart.isAfter(dayjs())
          const avail = isPastOrCurrent
            ? (eq.available_end?.[i] ?? total - occupied)
            : total - occupied
          // 超售时（occupied > total）：按实际占用总量归一化，让两段按比例填满 bar 90%
          // 未超售时：按库存总量归一化，维持原有比例
          const unitPctBase = occupied > total ? occupied : total
          const unitPct = unitPctBase > 0 ? (BAR_RATIO / unitPctBase) * 100 : 0
          const usedW = used * unitPct
          const reservedW = reserved * unitPct
          // 右侧数值：可用剩余（灰）、0（灰）、超出数量（红）
          const shortage = avail < 0
          const rightValue = shortage ? Math.abs(avail) : avail
          return (
            <div
              key={slot}
              style={{
                display: 'flex',
                alignItems: 'center',
                height: ROW_HEIGHT,
                borderBottom: '1px dashed #f0f0f0',
              }}
            >
              <span
                style={{
                  width: TIME_GUTTER,
                  flexShrink: 0,
                  fontSize: 12,
                  color: '#666',
                  paddingLeft: 4,
                }}
              >
                {slot}
              </span>
              <div
                style={{
                  flex: 94,
                  display: 'flex',
                  height: BAR_HEIGHT,
                  background: '#fafafa',
                  borderRadius: '2px 0 0 2px',
                  overflow: 'hidden',
                }}
                title={`${slot} · 已使用 ${used} / 预订 ${reserved} / 可用 ${avail}`}
              >
                {used > 0 && (
                  <div
                    style={{
                      width: `${usedW}%`,
                      flexShrink: 0,
                      background: hex,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#fff',
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    {used}
                  </div>
                )}
                {reserved > 0 && (
                  <div
                    style={{
                      width: `${reservedW}%`,
                      flexShrink: 0,
                      background: lightHex,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#333',
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    {reserved}
                  </div>
                )}
              </div>
              {/* 右侧数值区（6%）：与条形区共用 #fafafa 背景；
                  显示可用剩余数量（灰）、0（灰）或超出数量（红） */}
              <div
                style={{
                  flex: 6,
                  height: BAR_HEIGHT,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: '#fafafa',
                  borderRadius: '0 2px 2px 0',
                  color: shortage ? '#cf1322' : '#999',
                  fontSize: 11,
                  fontWeight: shortage ? 700 : 400,
                }}
              >
                {rightValue}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
