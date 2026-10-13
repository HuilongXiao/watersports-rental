import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate, useOutletContext, useSearchParams } from 'react-router-dom'
import { App, Button, Card, DatePicker, Grid, Popover, Select, Space, Table, Tabs, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { FilterOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import type { Dayjs } from 'dayjs'
import { api } from '../api'
import { useAuth } from '../auth'
import { typeColorHex } from '../utils'
import type { Customer, Order, OrderStatus } from '../types'

// 状态展示顺序：进行中 → 预订 → 已完成 → 爽约 → 已取消（与概览“订单分布”配色一致）
const STATUS_OPTIONS: { key: OrderStatus; label: string; color: string }[] = [
  { key: 'in_progress', label: '进行中', color: 'orange' },
  { key: 'active', label: '预订', color: 'green' },
  { key: 'completed', label: '已完成', color: 'blue' },
  { key: 'no_show', label: '爽约', color: 'red' },
  { key: 'cancelled', label: '已取消', color: 'default' },
]
const STATUS_PRIORITY: Record<OrderStatus, number> = {
  in_progress: 0,
  active: 1,
  completed: 2,
  no_show: 3,
  cancelled: 4,
}

// 状态颜色（用于筛选模式下时间列的圆点标记）
const STATUS_HEX: Record<OrderStatus, string> = {
  in_progress: '#fa8c16',
  active: '#52c41a',
  completed: '#1890ff',
  no_show: '#ff4d4f',
  cancelled: '#bfbfbf',
}

interface OrderFilter {
  statuses: OrderStatus[]
  customerId: string | null
  day: string | null
  specName: string | null
  hasRefund: boolean
}

const EMPTY_FILTER: OrderFilter = { statuses: [], customerId: null, day: null, specName: null, hasRefund: false }

export default function Orders() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { ordersRefreshKey } = useOutletContext<{ ordersRefreshKey: number }>()
  const { message } = App.useApp()
  const { user } = useAuth()
  const screens = Grid.useBreakpoint()
  const canCreateOrder = Boolean(user?.permissions.create_order)

  const scrollToTop = () => {
    window.scrollTo(0, 0)
    document.querySelector('.ant-layout-content')?.scrollTo(0, 0)
  }

  // ---- 进入详情前保存滚动位置，返回列表时按 URL 参数匹配恢复 ----
  // 桌面端滚动容器是 window，移动端是 .ant-layout-content，两者都记录。
  const SCROLL_KEY = 'orders_scroll_y'
  const saveScrollPosition = () => {
    try {
      const content = document.querySelector('.ant-layout-content')
      const entry = {
        search: window.location.search,
        windowY: window.scrollY,
        contentY: content?.scrollTop ?? 0,
      }
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify(entry))
    } catch {
      // sessionStorage 不可用时静默忽略
    }
  }
  const pendingScroll = useRef<{ search: string; windowY: number; contentY: number } | null>(null)
  // 首次数据加载完成标记：确保滚动在列表有高度后才恢复（loading 初值为 false，
  // 若不门控会在数据到达前触发 scrollTo 被截断）
  const firstLoadDone = useRef(false)
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(SCROLL_KEY)
      if (!raw) return
      sessionStorage.removeItem(SCROLL_KEY)
      const entry = JSON.parse(raw) as { search: string; windowY: number; contentY: number }
      // 仅当列表状态（URL 参数）与离开时一致才恢复，避免筛选不同却跳滚
      if (entry.search === window.location.search) pendingScroll.current = entry
    } catch {
      // 解析失败静默忽略
    }
  }, [])

  // ---- URL query params <-> 列表状态（tab/分页/筛选/预订日期）双向同步 ----
  // 回滚：删除本段 URL 读取与下方同步 effect，并把各 useState 恢复为硬编码初始值；
  // 同时删除行点击中的 saveScrollPosition 调用与上方滚动恢复 effect。
  const spTab = searchParams.get('tab')
  const spPage = Number(searchParams.get('page') || '0')
  const spDay = searchParams.get('day')
  const urlFilterActive = Boolean(
    searchParams.get('fs') || searchParams.get('fc') || searchParams.get('fd') ||
      searchParams.get('fp') || searchParams.get('fr'),
  )

  // 从工作台“订单分布”跳转过来时，URL 携带 status 参数，自动筛选当日该状态订单
  const initialStatus = searchParams.get('status') as OrderStatus | null
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<OrderStatus | ''>(() => {
    if (urlFilterActive || initialStatus) return '' // 筛选模式展示在“全部”tab 下
    if (spTab !== null) return spTab === 'all' ? '' : (spTab as OrderStatus)
    return 'active'
  })
  const [filter, setFilter] = useState<OrderFilter>(() => {
    if (urlFilterActive) {
      return {
        statuses: (searchParams.get('fs') || '').split(',').filter(Boolean) as OrderStatus[],
        customerId: searchParams.get('fc'),
        day: searchParams.get('fd'),
        specName: searchParams.get('fp'),
        hasRefund: searchParams.get('fr') === '1',
      }
    }
    return initialStatus
      ? { statuses: [initialStatus], customerId: null, day: dayjs().format('YYYY-MM-DD'), specName: null, hasRefund: false }
      : EMPTY_FILTER
  })
  const [filterOpen, setFilterOpen] = useState(false)
  // 弹窗内的草稿，点击“确认”后才应用
  const [draftStatuses, setDraftStatuses] = useState<OrderStatus[]>([])
  const [draftCustomerId, setDraftCustomerId] = useState<string | null>(null)
  const [draftDay, setDraftDay] = useState<Dayjs | null>(null)
  const [draftSpecName, setDraftSpecName] = useState<string | null>(null)
  const [draftHasRefund, setDraftHasRefund] = useState(false)
  const [customerOptions, setCustomerOptions] = useState<Customer[]>([])
  const [specOptions, setSpecOptions] = useState<{ value: string; label: string }[]>([])
  const customerSearchTimer = useRef<number | null>(null)
  const customerFilterSelectRef = useRef<any>(null)
  const [currentPage, setCurrentPage] = useState(() => (spPage > 0 ? spPage : 1))
  // 预订 tab 可翻日期查看，默认今天；- 号在所选日期 ≤ 今天时禁用（过去的日子无预订订单）
  const [bookingDay, setBookingDay] = useState(() => (spDay ? dayjs(spDay) : dayjs()))

  const filtersActive = Boolean(
    filter.statuses.length > 0 || filter.customerId || filter.day || filter.specName || filter.hasRefund,
  )

  // 状态 -> URL query params 同步（replace 避免产生大量历史条目）
  useEffect(() => {
    const next = new URLSearchParams()
    if (filtersActive) {
      if (filter.statuses.length) next.set('fs', filter.statuses.join(','))
      if (filter.customerId) next.set('fc', filter.customerId)
      if (filter.day) next.set('fd', filter.day)
      if (filter.specName) next.set('fp', filter.specName)
      if (filter.hasRefund) next.set('fr', '1')
      next.set('tab', 'all')
    } else {
      next.set('tab', status === '' ? 'all' : status)
      if (status === 'active') next.set('day', bookingDay.format('YYYY-MM-DD'))
    }
    if (currentPage > 1) next.set('page', String(currentPage))
    setSearchParams(next, { replace: true })
  }, [status, filter, filtersActive, bookingDay, currentPage, setSearchParams])

  // 数据加载完成后再恢复滚动（列表高度不足时浏览器会截断 scrollTo）
  useEffect(() => {
    const entry = pendingScroll.current
    if (!firstLoadDone.current || loading || !entry) return
    pendingScroll.current = null
    requestAnimationFrame(() => {
      window.scrollTo(0, entry.windowY)
      document.querySelector('.ant-layout-content')?.scrollTo(0, entry.contentY)
    })
  }, [loading])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filtersActive) {
        if (filter.day) params.set('business_day', filter.day)
      } else {
        if (status) params.set('status', status)
        if (status === 'active') {
          // 预订 tab 按所选日期查看当日预订订单
          params.set('business_day', bookingDay.format('YYYY-MM-DD'))
        } else if (status === 'in_progress') {
          // 进行中 tab 只显示今天的订单
          params.set('business_day', dayjs().format('YYYY-MM-DD'))
        } else {
          // “全部”tab：只显示从明日开始往后的预订订单
          params.set('status', 'active')
          params.set('business_day_from', dayjs().add(1, 'day').format('YYYY-MM-DD'))
        }
      }
      let result = await api.get<Order[]>(`/api/orders?${params.toString()}`)
      if (filtersActive) {
        if (filter.statuses.length > 0) {
          result = result.filter((o) => filter.statuses.includes(o.status))
        }
        if (filter.customerId) {
          result = result.filter((o) => o.customer_id === filter.customerId)
        }
        if (filter.specName) {
          // 订单包含该器材即命中（如订单有休1和竞2，搜休1或竞2都显示）
          result = result.filter((o) =>
            o.items.some((item) => item.equipment_spec_name === filter.specName),
          )
        }
        if (filter.hasRefund) {
          // 有退款：支付调整项中存在负金额（数量 -1 的退款记录）
          result = result.filter((o) => (o.refund_amount_fen ?? 0) < 0)
        }
        if (filter.customerId) {
          // 按客户筛选时按状态由前到后排序：进行中→预订→已完成→爽约→已取消
          result = result.sort((a, b) => {
            const byStatus = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]
            if (byStatus !== 0) return byStatus
            return dayjs(a.start_at).valueOf() - dayjs(b.start_at).valueOf()
          })
        } else if (filter.statuses.length === 1) {
          // 工作台跳转过来的单状态筛选：进行中按签到时间排序，其余按开始时间
          if (filter.statuses[0] === 'in_progress') {
            result = result.sort(
              (a, b) => dayjs(a.check_in_at ?? a.start_at).valueOf() - dayjs(b.check_in_at ?? b.start_at).valueOf(),
            )
          } else {
            result = result.sort(
              (a, b) => dayjs(a.start_at).valueOf() - dayjs(b.start_at).valueOf(),
            )
          }
        }
      } else if (status === 'in_progress') {
        // “进行中”tab 按签到时间先后排序（无签到时间回退开始时间），早的在前
        result = result.sort(
          (a, b) => dayjs(a.check_in_at ?? a.start_at).valueOf() - dayjs(b.check_in_at ?? b.start_at).valueOf(),
        )
      }
      setOrders(result)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    } finally {
      firstLoadDone.current = true
      setLoading(false)
    }
  }, [status, filter, filtersActive, bookingDay, message])

  const searchCustomers = useCallback(async (q: string) => {
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    try {
      const result = await api.get<Customer[]>(`/api/customers?${params.toString()}`)
      setCustomerOptions(result.slice(0, 20))
    } catch {
      // 静默失败：保留现有选项
    }
  }, [])

  const loadSpecOptions = useCallback(async () => {
    try {
      const catalog = await api.get<{
        equipment: { name: string; is_active: boolean }[]
      }>('/api/catalog')
      // 平铺所有规格名称：启用的在前（按名称排序），已禁用的排最后
      const active = catalog.equipment
        .filter((s) => s.is_active)
        .map((s) => s.name)
        .sort((a, b) => a.localeCompare(b, 'zh'))
      const inactive = catalog.equipment
        .filter((s) => !s.is_active)
        .map((s) => s.name)
        .sort((a, b) => a.localeCompare(b, 'zh'))
      const names = [...new Set([...active, ...inactive])]
      setSpecOptions(names.map((n) => ({ value: n, label: n })))
    } catch {
      // 静默失败
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    loadSpecOptions()
  }, [loadSpecOptions])

  // 点击“订单管理”菜单刷新：重置为预订 tab、清除筛选、回到顶部
  const prevRefreshKey = useRef(ordersRefreshKey)
  useEffect(() => {
    if (ordersRefreshKey !== prevRefreshKey.current) {
      prevRefreshKey.current = ordersRefreshKey
      setStatus('active')
      setFilter(EMPTY_FILTER)
      setCurrentPage(1)
      setBookingDay(dayjs())
      scrollToTop()
    }
  }, [ordersRefreshKey])

  const openFilterPopover = () => {
    setDraftStatuses(filter.statuses)
    setDraftCustomerId(filter.customerId)
    setDraftDay(filter.day ? dayjs(filter.day) : null)
    setDraftSpecName(filter.specName)
    setDraftHasRefund(filter.hasRefund)
    if (customerOptions.length === 0) searchCustomers('')
    setFilterOpen(true)
  }

  const applyFilter = () => {
    setFilter({
      statuses: draftStatuses,
      customerId: draftCustomerId,
      day: draftDay ? draftDay.format('YYYY-MM-DD') : null,
      specName: draftSpecName,
      hasRefund: draftHasRefund,
    })
    setFilterOpen(false)
    setStatus('') // 应用筛选后切换到“全部”展示结果
    setCurrentPage(1)
    scrollToTop()
  }

  const clearFilter = () => {
    setFilter(EMPTY_FILTER)
    setDraftStatuses([])
    setDraftCustomerId(null)
    setDraftDay(null)
    setDraftSpecName(null)
    setDraftHasRefund(false)
    setFilterOpen(false)
    setCurrentPage(1)
  }

  const onCustomerSearch = (q: string) => {
    if (customerSearchTimer.current) window.clearTimeout(customerSearchTimer.current)
    customerSearchTimer.current = window.setTimeout(() => searchCustomers(q), 300)
  }

  const isMobile = !screens.md

  // 手机端点击客户区域：复制该订单客户的微信昵称全部内容到剪贴板。
  // http 局域网环境下 navigator.clipboard 不可用，回退到 execCommand 方案。
  const copyCustomerName = async (name: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(name)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = name
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      message.success(`复制${name}成功`)
    } catch {
      message.error('复制失败')
    }
  }

  // 手机端行最大行数 = max(时间列行数, 项目列船型数, 1)
  // "全部"Tab（含筛选）时间列双行 → 2；其余Tab单行 → 1
  const timeLines = filtersActive || status === '' ? 2 : 1
  const getRowMaxLines = (record: Order) => {
    const eqCount = record.items.filter((i) => i.equipment_spec_name).length
    return Math.max(timeLines, eqCount, 1)
  }

  const bookingHeader = (compact: boolean) => {
    const btnStyle = compact
      ? { width: 18, height: 18, padding: 0, minWidth: 18, fontSize: 11, lineHeight: '18px' }
      : { width: 22, height: 22, padding: 0 }
    const dateMin = compact ? 36 : 48
    return (
      <Space size={compact ? 2 : 4}>
        <Button
          size="small"
          style={btnStyle}
          disabled={bookingDay.isSame(dayjs(), 'day')}
          onClick={(e) => {
            e.stopPropagation()
            setBookingDay((d) => d.subtract(1, 'day'))
            setCurrentPage(1)
          }}
        >
          −
        </Button>
        <span style={{ minWidth: dateMin, textAlign: 'center' }}>
          {bookingDay.format('MM-DD')}
        </span>
        <Button
          size="small"
          style={btnStyle}
          onClick={(e) => {
            e.stopPropagation()
            setBookingDay((d) => d.add(1, 'day'))
            setCurrentPage(1)
          }}
        >
          +
        </Button>
      </Space>
    )
  }

  const columns: ColumnsType<Order> = [
    {
      title: '客户',
      render: (_, record) => {
        const name = record.customer_wechat_nickname || record.customer_name || '游客'
        // 勾选备注弹窗的订单，客户名用红色显示以示提醒
        const content = record.note_popup ? (
          <span style={{ color: '#cf1322' }}>{name}</span>
        ) : (
          name
        )
        if (!isMobile) return content
        // 手机版：CSS line-clamp 截断至行高允许的最大行数，点击复制
        const maxLines = getRowMaxLines(record)
        return (
          <div
            onClick={(e) => {
              e.stopPropagation()
              copyCustomerName(name)
            }}
            style={{
              display: '-webkit-box',
              WebkitLineClamp: maxLines,
              WebkitBoxOrient: 'vertical' as any,
              overflow: 'hidden',
              wordBreak: 'break-all',
              cursor: 'pointer',
            }}
          >
            {content}
          </div>
        )
      },
    },
    {
      title:
        !filtersActive && status === 'in_progress'
          ? '签到时间'
          : !filtersActive && status === 'active'
            ? bookingHeader(isMobile)
            : '开始时间',
      dataIndex: 'start_at',
      width: isMobile ? 92 : undefined,
      render: (value: string, record) => {
        const isTodayTab = status === 'active' || status === 'in_progress'
        const source =
          !filtersActive && status === 'in_progress'
            ? (record.check_in_at ?? value)
            : value
        // 预订订单迟到 30 分钟以上 → 时间标红
        const isLate =
          record.status === 'active' &&
          dayjs().diff(dayjs(record.start_at), 'minute', true) > 30
        const timeStyle = isLate ? { color: '#cf1322' } : undefined

        // --- 桌面端 ---
        if (!isMobile) {
          const time = dayjs(source).format(!filtersActive && isTodayTab ? 'HH:mm' : 'MM-DD HH:mm')
          if (filtersActive) {
            const meta = STATUS_OPTIONS.find((s) => s.key === record.status)
            return (
              <Space size={4}>
                <Tag color={meta?.color} style={{ margin: 0, fontSize: 12, lineHeight: '18px' }}>
                  {meta?.label ?? record.status}
                </Tag>
                <span style={timeStyle}>{time}</span>
              </Space>
            )
          }
          return <span style={timeStyle}>{time}</span>
        }

        // --- 手机端 ---
        // "全部"Tab（含筛选）：双行（日期 / 时间），筛选时附状态圆点
        if (filtersActive || status === '') {
          const dateStr = dayjs(source).format('MM-DD')
          const timeStr = dayjs(source).format('HH:mm')
          return (
            <div>
              <div style={timeStyle}>
                {filtersActive && (
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: STATUS_HEX[record.status] || '#999',
                      display: 'inline-block',
                      marginRight: 3,
                      verticalAlign: 'middle',
                    }}
                  />
                )}
                {dateStr}
              </div>
              <div style={timeStyle}>{timeStr}</div>
            </div>
          )
        }
        // 预订/进行中 Tab：单行 HH:mm
        return <span style={timeStyle}>{dayjs(source).format('HH:mm')}</span>
      },
    },
    {
      title: '项目',
      width: isMobile ? 68 : undefined,
      render: (_, record) => {
        const eqItems = record.items.filter((i) => i.equipment_spec_name)
        if (!isMobile) {
          // 桌面端：显示所有项目（船型+销售），保持原格式
          return record.items.map((item, i) => {
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
          })
        }
        // 手机端：仅显示船型，紧凑格式 "休闲*1"，每条独占一行不拆分
        return eqItems.map((item, i) => {
          const name = item.equipment_spec_name!
          const color = item.equipment_type_color
            ? typeColorHex(item.equipment_type_color)
            : undefined
          return (
            <div key={item.id ?? i} style={{ whiteSpace: 'nowrap' }}>
              <span style={color ? { color } : undefined}>{name}</span>
              <span>*{item.quantity}</span>
            </div>
          )
        })
      },
    },
  ]

  const filterContent = (
    <div style={{ width: 300, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ marginBottom: 6, fontWeight: 500 }}>订单状态</div>
        <Space wrap size={[8, 8]}>
          {STATUS_OPTIONS.map((s) => {
            const selected = draftStatuses.includes(s.key)
            return (
              <Tag
                key={s.key}
                color={s.color}
                style={{
                  cursor: 'pointer',
                  margin: 0,
                  padding: '3px 10px',
                  fontSize: 13,
                  opacity: selected ? 1 : 0.38,
                  border: selected ? undefined : '1px dashed #d9d9d9',
                }}
                onClick={() =>
                  setDraftStatuses(
                    selected
                      ? draftStatuses.filter((k) => k !== s.key)
                      : [...draftStatuses, s.key],
                  )
                }
              >
                {s.label}
              </Tag>
            )
          })}
          {/* “有退款”不是订单状态，只是附加过滤条件，可与状态多选叠加 */}
          <Tag
            color="volcano"
            style={{
              cursor: 'pointer',
              margin: 0,
              padding: '3px 10px',
              fontSize: 13,
              opacity: draftHasRefund ? 1 : 0.38,
              border: draftHasRefund ? undefined : '1px dashed #d9d9d9',
            }}
            onClick={() => setDraftHasRefund(!draftHasRefund)}
          >
            有退款
          </Tag>
        </Space>
        <div style={{ marginTop: 4, fontSize: 12, color: '#999' }}>
          不选则显示全部状态
        </div>
      </div>
      <div>
        <div style={{ marginBottom: 6, fontWeight: 500 }}>按客户筛选</div>
        <Select
          ref={customerFilterSelectRef}
          showSearch
          allowClear
          placeholder="输入客户名称搜索"
          style={{ width: '100%' }}
          value={draftCustomerId}
          filterOption={false}
          onSearch={onCustomerSearch}
          onChange={(value) => {
            setDraftCustomerId(value ?? null)
            // 选定客户后收起手机键盘
            setTimeout(() => customerFilterSelectRef.current?.blur(), 0)
          }}
          onClear={() => setDraftCustomerId(null)}
          options={customerOptions.map((c) => ({
            value: c.id,
            label: c.wechat_nickname || c.name || '游客',
          }))}
        />
      </div>
      <div>
        <div style={{ marginBottom: 6, fontWeight: 500 }}>按器材筛选</div>
        <Select
          allowClear
          placeholder="选择器材规格"
          style={{ width: '100%' }}
          value={draftSpecName}
          onChange={(value) => setDraftSpecName(value ?? null)}
          onClear={() => setDraftSpecName(null)}
          options={specOptions}
        />
        <div style={{ marginTop: 4, fontSize: 12, color: '#999' }}>
          订单包含所选器材即显示
        </div>
      </div>
      <div>
        <div style={{ marginBottom: 6, fontWeight: 500 }}>按业务日期筛选</div>
        <DatePicker
          value={draftDay}
          onChange={(value) => setDraftDay(value)}
          allowClear
          style={{ width: '100%' }}
        />
      </div>
      <Space style={{ justifyContent: 'flex-end' }}>
        <Button onClick={clearFilter}>清除</Button>
        <Button type="primary" onClick={applyFilter}>
          确认
        </Button>
      </Space>
    </div>
  )

  return (
    <Card
      title="订单管理"
      extra={
        <Space wrap>
          {/* 电脑版才显示“新建订单”入口，手机版隐藏 */}
          {screens.md && canCreateOrder && (
            <Button type="primary" onClick={() => navigate('/orders/new')}>
              新建订单
            </Button>
          )}
          <Popover
            content={filterContent}
            trigger="click"
            open={filterOpen}
            onOpenChange={setFilterOpen}
            placement="bottomRight"
          >
            <Button icon={<FilterOutlined />}>筛选</Button>
          </Popover>
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 8 }}>
        <Tabs
          activeKey={status}
          onChange={(key) => {
            // 处于“筛选中”时点击其他 tab：清除筛选，真正切换到该 tab
            if (filtersActive) {
              setFilter(EMPTY_FILTER)
            }
            setStatus(key as OrderStatus | '')
            setCurrentPage(1)
            scrollToTop()
          }}
          items={[
            { key: 'active', label: '预订' },
            { key: 'in_progress', label: '进行中' },
            { key: '', label: '全部' },
          ]}
          style={{ marginBottom: 0 }}
        />
        {filtersActive && (
          <Tag
            color="blue"
            closable
            onClose={clearFilter}
            style={{ cursor: 'pointer', marginBottom: 8 }}
          >
            筛选中
          </Tag>
        )}
      </Space>
      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={orders}
        tableLayout={isMobile ? 'fixed' : undefined}
        components={
          isMobile
            ? {
                header: {
                  cell: ({ style, ...rest }: any) => (
                    <th style={{ ...style, padding: '8px 4px', fontSize: 13, whiteSpace: 'nowrap', textAlign: 'center' }} {...rest} />
                  ),
                },
                body: {
                  cell: ({ style, ...rest }: any) => (
                    <td style={{ ...style, padding: '8px 4px', fontSize: 13, textAlign: 'center' }} {...rest} />
                  ),
                },
              }
            : undefined
        }
        pagination={{
          pageSize: 20,
          current: currentPage,
          onChange: (page) => {
            setCurrentPage(page)
            scrollToTop()
          },
        }}
        onRow={(record) => ({
          onClick: () => {
            // 进入详情前保存滚动位置（按当前 URL 参数区分），返回时恢复
            saveScrollPosition()
            navigate(`/orders/${record.id}`)
          },
        })}
      />
    </Card>
  )
}
