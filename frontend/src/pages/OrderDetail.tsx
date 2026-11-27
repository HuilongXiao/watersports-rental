import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import dayjs from 'dayjs'
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Table,
  Tag,
} from 'antd'
import { api } from '../api'
import { useAuth } from '../auth'
import { useSettings } from '../contexts/SettingsContext'
import { fenToYuan, formatDateTime, formatDurationBetween, typeColorHex, readLatestOrdersSnapshot } from '../utils'
import { useLayoutMode } from '../layoutMode'
import FloatingBackButton from '../components/FloatingBackButton'
import { renderBookingLetter } from '../bookingLetter'
import type { BoatUsage, Catalog, Order, OrderItem, OrderStatus, PaymentAdjustment, PaymentView } from '../types'

const STATUS_META: Record<OrderStatus, { label: string; color: string }> = {
  active: { label: '预订', color: 'green' },
  in_progress: { label: '进行中', color: 'orange' },
  completed: { label: '已完成', color: 'blue' },
  cancelled: { label: '已取消', color: 'default' },
  no_show: { label: '爽约', color: 'red' },
}

// Tabler「map-share」图标（内联 SVG，避免引入额外图标包）
function MapShareIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="23"
      height="23"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 19l-4-2l-6 3v-13l6-3l6 3l6-3v9" />
      <path d="M9 4v13" />
      <path d="M15 7v6.5" />
      <path d="M16 22l5-5" />
      <path d="M21 21.5v-4.5h-4.5" />
    </svg>
  )
}

// 调起系统分享面板（微信、相册等）。仅 https 安全上下文与支持 Web Share 的浏览器可用。
async function shareLetterImage(
  dataUrl: string,
  fileName: string,
): Promise<'ok' | 'cancelled' | 'unsupported'> {
  const nav = navigator as Navigator & {
    canShare?: (data?: { files?: File[] }) => boolean
    share?: (data?: { files?: File[]; title?: string; text?: string }) => Promise<void>
  }
  if (typeof nav.share !== 'function') return 'unsupported'
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const file = new File([blob], fileName, { type: 'image/png' })
    if (nav.canShare && !nav.canShare({ files: [file] })) return 'unsupported'
    await nav.share({ files: [file], title: '预订确认书' })
    return 'ok'
  } catch (error) {
    // 用户在系统分享面板点了取消：不当作失败
    if (error instanceof Error && error.name === 'AbortError') return 'cancelled'
    return 'unsupported'
  }
}

// 紧凑表格：缩小单元格内边距（手机端保证表头不换行）
const centerHeader = () => ({
  style: { padding: '4px 6px', textAlign: 'center' as const, whiteSpace: 'nowrap' as const },
})
const nowrapCell = () => ({ style: { padding: '4px 6px', whiteSpace: 'nowrap' as const } })
// 船只调配区域：内容需要显式居中（onCell 的 style 会覆盖列上的 align）
const centeredCell = () => ({
  style: { padding: '4px 6px', textAlign: 'center' as const },
})
const centeredNowrapCell = () => ({
  style: { padding: '4px 6px', textAlign: 'center' as const, whiteSpace: 'nowrap' as const },
})

// 订单详情「船只调配」区域的一行（每条船一行，未调配也占一行）
interface BoatDispatchRow {
  key: string
  specName: string
  color: string | null | undefined
  number: string | null
  departedAt: string | null
  returnedAt: string | null
}

// 订单项目展示行：未拆分的项目一行；已拆分的项目按拆分记录展开为多行。
// 拆分金额能被单价整除时按金额换算数量（如 180 拆 2 份 → 休闲*1），
// 否则沿用原项目数量写法，仅金额不同。
interface ItemDisplayRow {
  key: string
  item: OrderItem
  splitId: string | null
  name: string
  quantity: number
  amountFen: number
  // 该行累计调整（退款/调价，负数为减少），用于金额标红
  adjustedFen: number
}

// 按订单项目 + 支付视图计算表格行与每行净额（含退款/调价）。
// 仅用于详情表格；预订确认书按需求固定展示项目原本标价，不走这份计算。
function computeItemRows(
  items: OrderItem[],
  payment: PaymentView | null,
): { rows: ItemDisplayRow[]; refundedOf: (itemId: string) => number } {
  // 按订单项目汇总调整（含退款与调价，金额为负数表示减少）
  const itemRefunds = new Map<string, PaymentAdjustment[]>()
  // 拆分行的调整合计（退款/调价）
  const splitAdjusted = new Map<string, number>()
  for (const adj of payment?.adjustments ?? []) {
    if (adj.order_item_split_id) {
      splitAdjusted.set(
        adj.order_item_split_id,
        (splitAdjusted.get(adj.order_item_split_id) ?? 0) + adj.amount,
      )
    }
    if (!adj.order_item_id) continue
    const list = itemRefunds.get(adj.order_item_id) ?? []
    list.push(adj)
    itemRefunds.set(adj.order_item_id, list)
  }
  const refundedOf = (itemId: string) =>
    (itemRefunds.get(itemId) ?? []).reduce((sum, a) => sum + a.amount, 0)

  // 拆分记录由支付视图返回（订单详情本身不含），按订单项目 id 归并
  const splitsByItemId = new Map<string, { id: string; amount_fen: number }[]>()
  for (const paymentItem of payment?.order_items ?? []) {
    if (paymentItem.splits?.length) splitsByItemId.set(paymentItem.id, paymentItem.splits)
  }

  const rows: ItemDisplayRow[] = []
  for (const item of items) {
    const name = item.equipment_spec_name ?? item.sale_item_name ?? '—'
    const splits = splitsByItemId.get(item.id) ?? item.splits ?? []
    if (splits.length === 0) {
      const adjusted = refundedOf(item.id)
      rows.push({
        key: item.id,
        item,
        splitId: null,
        name,
        quantity: item.quantity,
        amountFen: item.line_amount + adjusted,
        adjustedFen: adjusted,
      })
      continue
    }
    for (const split of splits) {
      const adjusted = splitAdjusted.get(split.id) ?? 0
      const unit = item.unit_price
      const consistent =
        unit > 0 && split.amount_fen % unit === 0 && split.amount_fen / unit >= 1
      rows.push({
        key: `s-${split.id}`,
        item,
        splitId: split.id,
        name,
        quantity: consistent ? split.amount_fen / unit : item.quantity,
        amountFen: split.amount_fen + adjusted,
        adjustedFen: adjusted,
      })
    }
  }
  return { rows, refundedOf }
}

export default function OrderDetail({
  embedded = false,
  orderId,
  onClose,
  onChanged,
  onActionBarHeightChange,
}: {
  /** 嵌入订单管理页气泡时使用：不自带返回按钮与固定底部操作栏 */
  embedded?: boolean
  orderId?: string
  onClose?: () => void
  /** 订单发生变化（签到/完成/取消等）后通知外层刷新列表 */
  onChanged?: () => void
  /** 嵌入时上报底部操作栏实际高度，外层据此预留空间，避免内容与操作栏之间出现空隙 */
  onActionBarHeightChange?: (height: number) => void
} = {}) {
  const { id: routeId } = useParams<{ id: string }>()
  const id = embedded ? orderId : routeId
  const navigate = useNavigate()
  const { message } = App.useApp()
  const { user } = useAuth()
  const canEditOrder = Boolean(user?.permissions.edit_order)
  const isSuperuser = user?.role === 'superuser'
  const { isMobile, isDesktop } = useLayoutMode()

  const [order, setOrder] = useState<Order | null>(null)
  // 嵌入气泡时量出底部操作栏实际高度（按钮换行会变高），供外层预留底部空间
  const actionBarRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!embedded || !onActionBarHeightChange) return
    const el = actionBarRef.current
    if (!el) return
    const report = () => onActionBarHeightChange(el.offsetHeight)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [embedded, onActionBarHeightChange, order])
  const [payment, setPayment] = useState<PaymentView | null>(null)
  // 订单项目「详情」弹窗：查看所有调整项
  const [adjustDetailOpen, setAdjustDetailOpen] = useState(false)
  // 付款勾选（仅前端展示状态）：按订单项目 id 记录
  const [paidItems, setPaidItems] = useState<Record<string, boolean>>({})
  // 完成订单时仍有船只未返还：弹窗确认并一并返还
  const [completeOpen, setCompleteOpen] = useState(false)
  const [completeSubmitting, setCompleteSubmitting] = useState(false)
  // 备注单独编辑：任何状态（含已完成/已取消）都可写
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [noteSaving, setNoteSaving] = useState(false)
  // 预订确认书图片（手机长按保存到相册）
  const [letterOpen, setLetterOpen] = useState(false)
  const [letterLoading, setLetterLoading] = useState(false)
  const [letterUrl, setLetterUrl] = useState<string | null>(null)
  // 按订单项目调整（调整价格 / 退款）
  const [itemAdjustItem, setItemAdjustItem] = useState<OrderItem | null>(null)
  // 该行是拆分后的行时，指向拆分记录 id
  const [itemAdjustSplitId, setItemAdjustSplitId] = useState<string | null>(null)
  const [itemAdjustMode, setItemAdjustMode] = useState<'price' | 'refund'>('refund')
  const [itemAdjustMax, setItemAdjustMax] = useState(0) // 该行当前净额（分）
  const [itemAdjustAmount, setItemAdjustAmount] = useState<number | null>(null)
  const [itemAdjustNote, setItemAdjustNote] = useState('')
  const [itemAdjustSaving, setItemAdjustSaving] = useState(false)
  // 拆分弹窗：均分 / 自定义
  const [splitOpen, setSplitOpen] = useState(false)
  const [splitItemId, setSplitItemId] = useState<string | null>(null)
  const [splitTotalFen, setSplitTotalFen] = useState(0)
  const [splitMode, setSplitMode] = useState<'equal' | 'custom'>('equal')
  const [splitCount, setSplitCount] = useState<number>(2)
  const [splitAmounts, setSplitAmounts] = useState<(number | null)[]>([null, null])
  const [splitSaving, setSplitSaving] = useState(false)
  // 已出发但还未返还的船只明细
  const outstandingBoats = (order?.boat_usage ?? []).filter(
    (u) => u.departed_at && !u.returned_at,
  )

  // 「船只调配」区域：每条船一行。排序：已调配 → 未调配（该规格开启了编号）
  // → 未开启船只编号的规格。未调配的船也按数量逐条展开。
  const boatDispatchRows: BoatDispatchRow[] = []
  if (order) {
    const usageByItem = new Map<string, BoatUsage[]>()
    for (const u of order.boat_usage ?? []) {
      const list = usageByItem.get(u.order_item_id) ?? []
      list.push(u)
      usageByItem.set(u.order_item_id, list)
    }
    const pendingRows: BoatDispatchRow[] = []
    const noNumberingRows: BoatDispatchRow[] = []
    order.items.forEach((item, itemIndex) => {
      // 售卖项不涉及船只调配
      if (!item.equipment_spec_id) return
      const dispatched = usageByItem.get(item.id) ?? []
      dispatched.forEach((u, boatIndex) => {
        boatDispatchRows.push({
          key: `d-${item.id}-${boatIndex}`,
          specName: item.equipment_spec_name ?? '—',
          color: item.equipment_type_color,
          number: u.number,
          departedAt: u.departed_at,
          returnedAt: u.returned_at,
        })
      })
      const missing = Math.max(0, item.quantity - dispatched.length)
      for (let i = 0; i < missing; i += 1) {
        const row: BoatDispatchRow = {
          key: `e-${itemIndex}-${i}`,
          specName: item.equipment_spec_name ?? '—',
          color: item.equipment_type_color,
          number: null,
          departedAt: null,
          returnedAt: null,
        }
        if (item.requires_numbering) pendingRows.push(row)
        else noNumberingRows.push(row)
      }
    })
    boatDispatchRows.push(...pendingRows, ...noNumberingRows)
  }
  // 支付方式只读展示所需：从全局设置读取 code→name 映射
  const { settings } = useSettings()

  // 返回订单列表：直接回到上一层（订单列表），并带上快照记录的筛选参数。
  // 不用 navigate(-1)：手机版边缘返回手势会被拦截改走层级返回，两者需一致。
  const goBack = () => {
    const snap = readLatestOrdersSnapshot()
    navigate(`/orders${snap ? snap.search : ''}`, { replace: true })
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

  // 切换订单时清空付款勾选
  useEffect(() => {
    setPaidItems({})
  }, [id])

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
      onChanged?.()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    }
  }

  // 保存备注：走单独的 PATCH 接口，任何状态都能写
  const saveNote = async () => {
    setNoteSaving(true)
    try {
      const updated = await api.patch<Order>(`/api/orders/${id}/note`, { note: noteDraft })
      setOrder(updated)
      setNoteOpen(false)
      message.success('备注已保存')
      onChanged?.()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setNoteSaving(false)
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
      onChanged?.()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    }
  }

  // 确认返还尚未返还的船只并完成订单（后端在同一事务内一并标记返还）
  const completeWithBoats = async () => {
    setCompleteSubmitting(true)
    try {
      await api.post(`/api/orders/${id}/return`)
      message.success('已完成')
      setCompleteOpen(false)
      await load()
      onChanged?.()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setCompleteSubmitting(false)
    }
  }

  // superuser 永久删除订单（含订单项目与支付记录）
  const [deleting, setDeleting] = useState(false)
  const doDelete = async () => {
    setDeleting(true)
    try {
      await api.del(`/api/orders/${id}`)
      message.success('订单已删除')
      if (embedded) {
        onChanged?.()
        onClose?.()
      } else {
        navigate('/orders')
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败')
      setDeleting(false)
    }
  }

  if (!order) return null

  const today = formatDateTime(order.start_at).slice(0, 10) === dayjsToday()
  // 完成订单：订单日期当天或之后的日期都可以操作，且不要求签到
  const canCompleteByDate = dayjsToday() >= formatDateTime(order.start_at).slice(0, 10)
  // 爽约：仅在订单开始时间已到（不是未来时间）时提供
  const canMarkNoShow = !dayjs(order.start_at).isAfter(dayjs())
  const warnings = order.inventory_warnings ?? []

  // 客户信息单元格内容：桌面/手机两套排版共用
  const nameText = (() => {
    const namePart = order.customer_name?.trim() ?? ''
    const genderPart = order.customer_gender?.trim() ?? ''
    return namePart ? namePart + (genderPart || '') : ''
  })()
  const nameCell =
    order.customer_id && nameText ? (
      <Button
        type="link"
        size="small"
        style={{ padding: 0, height: 'auto' }}
        onClick={() => navigate(`/customers/${order.customer_id}`)}
      >
        {nameText}
      </Button>
    ) : (
      nameText
    )
  const wechatCell =
    order.customer_wechat_nickname && order.customer_id ? (
      <Button
        type="link"
        size="small"
        style={{ padding: 0, height: 'auto' }}
        onClick={() => navigate(`/customers/${order.customer_id}`)}
      >
        {order.customer_wechat_nickname}
      </Button>
    ) : (
      order.customer_wechat_nickname ?? order.customer_wechat_id ?? ''
    )
  const peopleCell =
    isMobile && order.child_count > 0 ? (
      <>
        <div>{order.adult_count} 位成人</div>
        <div>{order.child_count} 位儿童</div>
      </>
    ) : (
      <>
        {order.adult_count} 位成人
        {order.child_count > 0 ? `，${order.child_count} 位儿童` : ''}
      </>
    )
  const paymentCell =
    settings.payment_methods.length > 0 && order.payment_method_code
      ? settings.payment_methods.find((m) => m.code === order.payment_method_code)?.name ?? ''
      : ''

  const { rows: itemRows, refundedOf } = computeItemRows(order.items, payment)
  // 增值税发票：不占用项目行，在合计上方以文字说明税额
  const invoiceTaxRateBp = Math.round((order.invoice_tax_rate ?? 0) * 100)
  const invoiceTaxExtraFen = order.invoice_tax_item_id
    ? order.items.reduce((sum, item) => {
        if (!invoiceTaxRateBp) return sum
        // 反推未税单价，差额即为该行因增值税发票产生的额外金额
        const originalUnit = Math.round((item.unit_price * 10000) / (10000 + invoiceTaxRateBp))
        return sum + (item.unit_price - originalUnit) * item.quantity
      }, 0)
    : 0
  const invoiceTaxText =
    order.invoice_tax_item_id && invoiceTaxRateBp
      ? `订单包含${invoiceTaxExtraFen / 100}元的${invoiceTaxRateBp / 100}%增值税`
      : ''
  const itemsOriginalTotal = order.items.reduce((sum, item) => sum + item.line_amount, 0)
  const adjustedTotal = order.items.reduce((sum, item) => sum + refundedOf(item.id), 0)

  // 金额渲染：整数部分右对齐（个位数对齐），小数部分左对齐；
  // 小数全为 0 时不显示小数点与小数位
  const moneyParts = (fen: number) => {
    const fixed = Math.abs(fen / 100).toFixed(2)
    const [intPart, frac] = fixed.split('.')
    return { intStr: `${fen < 0 ? '-' : ''}${intPart}`, frac }
  }
  const allAmountFen = [...itemRows.map((row) => row.amountFen), itemsOriginalTotal + adjustedTotal]
  const maxIntLen = Math.max(1, ...allAmountFen.map((fen) => moneyParts(fen).intStr.length))
  const renderMoney = (fen: number, color?: string) => {
    const { intStr, frac } = moneyParts(fen)
    return (
      <span
        style={{
          color,
          display: 'inline-flex',
          alignItems: 'baseline',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        <span>¥</span>
        <span style={{ display: 'inline-block', width: `${maxIntLen}ch`, textAlign: 'right' }}>
          {intStr}
        </span>
        {frac !== '00' ? (
          <span style={{ display: 'inline-block', width: '3ch', textAlign: 'left' }}>.{frac}</span>
        ) : null}
      </span>
    )
  }

  // 付款按钮：未付款黑色文字+灰框，已付款绿色；按钮文字为该行应付金额
  const allPaid = itemRows.length > 0 && itemRows.every((row) => paidItems[row.key])
  const moneyText = (fen: number) => {
    const s = (Math.abs(fen) / 100).toFixed(2)
    return `${fen < 0 ? '-' : ''}${s.endsWith('.00') ? s.slice(0, -3) : s}`
  }
  const payButton = (paid: boolean, onClick: () => void, text: string) => (
    <Button
      size="small"
      onClick={onClick}
      style={
        paid
          ? { background: '#52c41a', borderColor: '#52c41a', color: '#fff' }
          : { color: '#000', borderColor: '#bfbfbf' }
      }
    >
      {text}
    </Button>
  )

  // 生成预订确认书图片
  const openBookingLetter = async () => {
    if (!id) return
    setLetterLoading(true)
    try {
      // 确认书固定展示项目原本标价：重新拉取一次订单，金额直接取 line_amount，
      // 不使用退款/调价后的净额。
      const freshOrder = await api.get<Order>(`/api/orders/${id}`)
      setOrder(freshOrder)
      const start = dayjs(freshOrder.start_at)
      const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
      // 器材若有「营业名称」，确认书里优先展示营业名称
      const catalog = await api.get<Catalog>('/api/catalog').catch(() => null)
      const businessNameBySpecId = new Map<string, string>()
      for (const spec of catalog?.equipment ?? []) {
        if (spec.business_name) businessNameBySpecId.set(spec.id, spec.business_name)
      }

      // 同一项目可能被创建为多行：确认书中按项目合并数量与原本标价金额
      const letterItems: {
        name: string
        quantity: number
        color: string | null | undefined
        amountFen: number
      }[] = []
      const mergedIndex = new Map<string, number>()
      for (const item of freshOrder.items) {
        const name =
          (item.equipment_spec_id
            ? businessNameBySpecId.get(item.equipment_spec_id)
            : undefined) ??
          item.equipment_spec_name ??
          item.sale_item_name ??
          '—'
        const key = item.equipment_spec_id ?? item.sale_item_id ?? name
        const index = mergedIndex.get(key)
        if (index === undefined) {
          mergedIndex.set(key, letterItems.length)
          letterItems.push({
            name,
            quantity: item.quantity,
            color: item.equipment_type_color,
            amountFen: item.line_amount,
          })
        } else {
          letterItems[index].quantity += item.quantity
          letterItems[index].amountFen += item.line_amount
        }
      }

      const url = await renderBookingLetter({
        shopName: settings.shop_name,
        shopPhone: settings.shop_phone,
        shopAddress: settings.shop_address,
        wechat: freshOrder.customer_wechat_nickname ?? '—',
        adultCount: freshOrder.adult_count,
        childCount: freshOrder.child_count,
        dateText: `${start.format('YYYY年M月D日')} ${weekdays[start.day()]}`,
        timeText: start.format('HH:mm'),
        items: letterItems,
      })
      setLetterUrl(url)
      // 先展示确认书预览，再由用户点击「转发」调起系统分享面板
      setLetterOpen(true)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '生成确认书失败')
    } finally {
      setLetterLoading(false)
    }
  }

  // 打开某行调整弹窗：退款上限为该行当前净额；调价预填当前净额
  const openItemAdjust = (row: ItemDisplayRow, mode: 'price' | 'refund') => {
    if (mode === 'refund' && row.amountFen <= 0) return
    setItemAdjustItem(row.item)
    setItemAdjustSplitId(row.splitId)
    setItemAdjustMode(mode)
    setItemAdjustMax(row.amountFen)
    setItemAdjustAmount(mode === 'price' ? row.amountFen / 100 : null)
    setItemAdjustNote('')
  }

  // 打开拆分弹窗：均分默认份数 = 项目数量（数量为 1 时用成人数）
  const openSplit = (row: ItemDisplayRow) => {
    setSplitItemId(row.item.id)
    setSplitTotalFen(row.amountFen)
    setSplitMode('equal')
    setSplitCount(row.item.quantity > 1 ? row.item.quantity : Math.max(2, order.adult_count))
    setSplitAmounts([null, null])
    setSplitOpen(true)
  }

  // 提交拆分：均分自动计算，自定义要求合计等于该行当前金额
  const submitSplit = async () => {
    if (!splitItemId) return
    let amounts: number[]
    if (splitMode === 'equal') {
      const count = Math.round(splitCount || 0)
      if (count < 2) {
        message.warning('拆分份数至少为 2')
        return
      }
      const base = Math.floor(splitTotalFen / count)
      if (base < 1) {
        message.warning('拆分份数过多，每份金额不足 0.01 元')
        return
      }
      const remainder = splitTotalFen - base * count
      amounts = Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0))
    } else {
      amounts = splitAmounts.map((value) => yuanToFenSafe(value ?? 0))
      if (amounts.length < 2) {
        message.warning('拆分至少需要 2 行')
        return
      }
      if (amounts.some((a) => a <= 0)) {
        message.warning('每行拆分金额必须大于 0')
        return
      }
      if (amounts.reduce((sum, a) => sum + a, 0) !== splitTotalFen) {
        message.warning('拆分金额合计必须等于该行当前金额')
        return
      }
    }
    setSplitSaving(true)
    try {
      await api.post(`/api/orders/${id}/payment/item-splits`, {
        order_item_id: splitItemId,
        amounts_fen: amounts,
      })
      message.success('已拆分')
      setSplitOpen(false)
      await load()
      onChanged?.()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '拆分失败')
    } finally {
      setSplitSaving(false)
    }
  }

  // 提交按行调整（调整价格 / 退款）
  const submitItemAdjust = async () => {
    if (!itemAdjustItem) return
    const amountFen = yuanToFenSafe(itemAdjustAmount ?? 0)
    if (amountFen < 0) {
      message.warning('金额不能为负数')
      return
    }
    if (itemAdjustMode === 'refund') {
      if (amountFen <= 0) {
        message.warning('请输入退款金额')
        return
      }
      if (amountFen > itemAdjustMax) {
        message.warning('退款金额不能超过该行剩余可退金额')
        return
      }
    } else if (amountFen === itemAdjustMax) {
      message.warning('调整后金额与当前金额相同')
      return
    }
    if (!itemAdjustNote.trim()) {
      message.warning(itemAdjustMode === 'refund' ? '请填写退款备注' : '请填写调价备注')
      return
    }
    setItemAdjustSaving(true)
    try {
      if (itemAdjustMode === 'refund') {
        await api.post(`/api/orders/${id}/payment/item-refunds`, {
          order_item_id: itemAdjustItem.id,
          order_item_split_id: itemAdjustSplitId,
          amount_fen: amountFen,
          note: itemAdjustNote.trim(),
        })
      } else {
        await api.post(`/api/orders/${id}/payment/item-price-adjustments`, {
          order_item_id: itemAdjustItem.id,
          order_item_split_id: itemAdjustSplitId,
          new_amount_fen: amountFen,
          note: itemAdjustNote.trim(),
        })
      }
      message.success(itemAdjustMode === 'refund' ? '退款已记录' : '价格已调整')
      setItemAdjustItem(null)
      setItemAdjustSplitId(null)
      await load()
      onChanged?.()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setItemAdjustSaving(false)
    }
  }

  return (
    <>
    {/* 浮动返回按钮：回到进入本页之前的页面（与浏览器后退等价，配合列表快照恢复） */}
    {!embedded && <FloatingBackButton onClick={goBack} ariaLabel="返回订单列表" />}
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <Card
        title={
          <Space>
            订单 {order.order_number}
            <Tag color={STATUS_META[order.status].color}>{STATUS_META[order.status].label}</Tag>
          </Space>
        }
        extra={
          // 右上角「转发」生成预订确认书图片；气泡内嵌时另显示「关闭」
          <Space>
            <Button
              type="text"
              aria-label="转发预订确认书"
              loading={letterLoading}
              icon={<MapShareIcon />}
              onClick={openBookingLetter}
              style={{ width: 42, height: 42 }}
            />
            {embedded ? <Button onClick={onClose}>关闭</Button> : null}
          </Space>
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
          className="order-detail-info"
          labelStyle={{ padding: '4px 4px', textAlign: 'center' }}
          contentStyle={{ padding: '4px 4px', textAlign: 'center' }}
        >
          {/* 手机版：第一行只放微信（跨两列）→ 第二行姓名+散客 → 第三行人数+支付方式，
              并隐藏手机号；桌面版顺序与内容保持不变 */}
          {isMobile ? (
            <>
              <Descriptions.Item label="微信" span={2}>
                {wechatCell}
              </Descriptions.Item>
              <Descriptions.Item label="姓名">{nameCell}</Descriptions.Item>
              <Descriptions.Item label="散客">{order.is_walk_in ? '是' : '否'}</Descriptions.Item>
              <Descriptions.Item label="人数">{peopleCell}</Descriptions.Item>
              <Descriptions.Item label="支付方式">{paymentCell}</Descriptions.Item>
              {/* 订单日期：单独占一行，后续时间字段只显示时间 */}
              <Descriptions.Item label="订单日期" span={2}>
                {order.start_at ? dayjs(order.start_at).format('YYYY-MM-DD') : ''}
              </Descriptions.Item>
            </>
          ) : (
            <>
              {/* 姓名：有姓名+性别 → "张磊先生"；仅有姓名 → "张磊"；无姓名 → 留空。 */}
              <Descriptions.Item label="姓名">{nameCell}</Descriptions.Item>
              <Descriptions.Item label="微信">{wechatCell}</Descriptions.Item>
              <Descriptions.Item label="手机号">{order.customer_phone ?? ''}</Descriptions.Item>
              <Descriptions.Item label="散客">{order.is_walk_in ? '是' : '否'}</Descriptions.Item>
              <Descriptions.Item label="人数">{peopleCell}</Descriptions.Item>
              <Descriptions.Item label="支付方式">{paymentCell}</Descriptions.Item>
              {/* 订单日期：单独占一行，后续时间字段只显示时间 */}
              <Descriptions.Item label="订单日期" span={2}>
                {order.start_at ? dayjs(order.start_at).format('YYYY-MM-DD') : ''}
              </Descriptions.Item>
            </>
          )}
          {/* 开始时间：有船只出发 → 最早的出发时间；已签到 → 签到时间；否则为下单时填写的开始时间 */}
          {(() => {
            const effective = order.boat_departed_at ?? order.check_in_at ?? order.start_at
            if (!effective) return <Descriptions.Item label="开始时间">{null}</Descriptions.Item>
            return (
              <Descriptions.Item label="开始时间">{dayjs(effective).format('HH:mm')}</Descriptions.Item>
            )
          })()}
          {/* 完成时间：有船只调配且已返还 → 显示返还时间；否则显示操作的完成时间或系统自动归还时间 */}
          {(() => {
            const effective = order.boat_returned_at ?? order.return_at
            if (!effective) return <Descriptions.Item label="完成时间">{null}</Descriptions.Item>
            const d = dayjs(effective)
            const by = order.boat_returned_at
              ? (order.boat_returned_by_user_code ?? order.boat_returned_by_user_name ?? '')
              : order.return_by_system
                ? '系统'
                : (order.return_by_user_code ?? order.return_by_user_name ?? '')
            return (
              <Descriptions.Item label="完成时间">
                {isDesktop ? (
                  `${d.format('HH:mm')}${by ? `（${by}）` : ''}`
                ) : (
                  <>
                    {d.format('HH:mm')}{by ? `（${by}）` : ''}
                  </>
                )}
              </Descriptions.Item>
            )
          })()}
          {(() => {
            const d = dayjs(order.created_at)
            const by = order.created_by_user_code ?? order.created_by_user_name
            return (
              <Descriptions.Item label="创建时间" span={2}>
                {isDesktop ? (
                  `${d.format('YYYY-MM-DD HH:mm')}${by ? `（${by}）` : ''}`
                ) : (
                  <>
                    {d.format('YYYY-MM-DD HH:mm')}{by ? `（${by}）` : ''}
                  </>
                )}
              </Descriptions.Item>
            )
          })()}
          {(() => {
            const d = dayjs(order.updated_at)
            const by = order.updated_by_user_code ?? order.updated_by_user_name
            return (
              <Descriptions.Item label="最后改动" span={2}>
                {isDesktop ? (
                  `${d.format('YYYY-MM-DD HH:mm')}${by ? `（${by}）` : ''}`
                ) : (
                  <>
                    {d.format('YYYY-MM-DD HH:mm')}{by ? `（${by}）` : ''}
                  </>
                )}
              </Descriptions.Item>
            )
          })()}
          <Descriptions.Item label="备注" span={2}>
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', textAlign: 'left' }}>
              {order.note ?? ''}
            </span>
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card
        title="订单项目"
        extra={
          <Button size="small" onClick={() => setAdjustDetailOpen(true)}>
            详情
          </Button>
        }
      >
        <Table
          rowKey="key"
          size="small"
          pagination={false}
          tableLayout="fixed"
          dataSource={itemRows}
          summary={() => (
            <>
              {invoiceTaxText ? (
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={4} align="left">
                    <span style={{ fontSize: 12, color: '#8c8c8c' }}>{invoiceTaxText}</span>
                  </Table.Summary.Cell>
                </Table.Summary.Row>
              ) : null}
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} align="center">
                  合计
                </Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="center">
                  <span style={{ fontWeight: 600 }}>
                    {renderMoney(
                      itemsOriginalTotal + adjustedTotal,
                      adjustedTotal !== 0 ? '#cf1322' : undefined,
                    )}
                  </span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2} align="center" />
                <Table.Summary.Cell index={3} align="center">
                  {payButton(
                    allPaid,
                    () =>
                      setPaidItems(
                        allPaid
                          ? {}
                          : Object.fromEntries(itemRows.map((row) => [row.key, true])),
                      ),
                    moneyText(itemsOriginalTotal + adjustedTotal),
                  )}
                </Table.Summary.Cell>
              </Table.Summary.Row>
            </>
          )}
          columns={[
            {
              title: '项目',
              align: 'center',
              onHeaderCell: centerHeader,
              onCell: centeredCell,
              render: (_, row) => (
                <>
                  <span
                    style={{
                      color: typeColorHex(row.item.equipment_type_color),
                      fontWeight: row.item.equipment_type_color ? 600 : undefined,
                    }}
                  >
                    {row.name}
                  </span>
                  <span style={{ color: '#000' }}>*{row.quantity}</span>
                </>
              ),
            },
            {
              title: '小计',
              width: 92,
              align: 'center',
              onHeaderCell: centerHeader,
              onCell: nowrapCell,
              render: (_, row) =>
                renderMoney(row.amountFen, row.adjustedFen !== 0 ? '#cf1322' : undefined),
            },
            {
              title: '调整',
              width: 72,
              align: 'center',
              onHeaderCell: centerHeader,
              onCell: centeredCell,
              render: (_, row) => {
                if (!canEditOrder) return null
                const menuItems = [
                  { key: 'price', label: '调整价格' },
                  { key: 'refund', label: '退款' },
                  // 已拆分的行不再提供再次拆分
                  ...(row.splitId ? [] : [{ key: 'split', label: '拆分' }]),
                ]
                return (
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: menuItems,
                      onClick: ({ key }) => {
                        if (key === 'split') {
                          openSplit(row)
                        } else {
                          openItemAdjust(row, key as 'price' | 'refund')
                        }
                      },
                    }}
                  >
                    <Button size="small">调整</Button>
                  </Dropdown>
                )
              },
            },
            {
              title: '付款',
              width: 76,
              align: 'center',
              onHeaderCell: centerHeader,
              onCell: centeredCell,
              render: (_, row) =>
                payButton(
                  Boolean(paidItems[row.key]),
                  () => setPaidItems((prev) => ({ ...prev, [row.key]: !prev[row.key] })),
                  moneyText(row.amountFen),
                ),
            },
          ]}
        />
      </Card>

      <Card title="船只调配">
        <Table
          rowKey="key"
          size="small"
          pagination={false}
          tableLayout="fixed"
          dataSource={boatDispatchRows}
          columns={[
            {
              title: '项目',
              align: 'center',
              onHeaderCell: centerHeader,
              onCell: centeredCell,
              render: (_, row) => (
                <span
                  style={{
                    color: typeColorHex(row.color),
                    fontWeight: row.color ? 600 : undefined,
                  }}
                >
                  {row.specName}
                </span>
              ),
            },
            {
              title: '编号',
              align: 'center',
              width: 96,
              onHeaderCell: centerHeader,
              onCell: centeredNowrapCell,
              render: (_, row) =>
                row.number ? (
                  <span>
                    <span style={{ color: typeColorHex(row.color), fontWeight: 600 }}>
                      {row.number}
                    </span>
                    <span style={{ color: '#000' }}>号</span>
                  </span>
                ) : (
                  <span style={{ color: '#999', fontSize: 12 }}>无</span>
                ),
            },
            {
              title: '出发时间',
              align: 'center',
              width: 78,
              onHeaderCell: centerHeader,
              onCell: centeredNowrapCell,
              render: (_, row) => (row.departedAt ? dayjs(row.departedAt).format('HH:mm') : ''),
            },
            {
              title: '使用时长',
              align: 'center',
              width: 100,
              onHeaderCell: centerHeader,
              onCell: centeredNowrapCell,
              render: (_, row) => {
                if (!row.departedAt) return ''
                const text = row.returnedAt
                  ? formatDurationBetween(row.departedAt, row.returnedAt)
                  : formatDurationBetween(row.departedAt, dayjs().toISOString())
                // 未返还的船用「进行中」橙色，已返还的用黑色
                return (
                  <span style={{ color: row.returnedAt ? '#000' : '#fa8c16' }}>{text}</span>
                )
              },
            },
          ]}
        />
      </Card>

      <Modal
        open={adjustDetailOpen}
        title="调整详情"
        footer={null}
        onCancel={() => setAdjustDetailOpen(false)}
        width={560}
      >
        {payment ? (
          payment.adjustments.length === 0 ? (
            <span style={{ color: '#999' }}>暂无调整</span>
          ) : (
            <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              {[...payment.adjustments]
                // 按时间顺序编号：调整1、调整2……
                .sort((a, b) => dayjs(a.created_at).valueOf() - dayjs(b.created_at).valueOf())
                .map((item, index) => {
                  const by = item.created_by_user_code ?? item.created_by_user_name
                  const amount = (
                    <span style={{ color: item.amount > 0 ? '#cf1322' : '#3f8600', fontWeight: 600 }}>
                      {item.amount > 0 ? '+' : ''}¥{fenToYuan(item.amount)}
                    </span>
                  )
                  const time = `${dayjs(item.created_at).format('YYYY-MM-DD HH:mm')}${
                    by ? `（${by}）` : ''
                  }`
                  return isDesktop ? (
                    <div
                      key={item.id}
                      style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '6px 0' }}
                    >
                      <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                        调整{index + 1}
                      </span>
                      <span style={{ whiteSpace: 'nowrap' }}>{amount}</span>
                      <span style={{ whiteSpace: 'nowrap', color: '#666', fontSize: 12 }}>{time}</span>
                      <span style={{ flex: 1, wordBreak: 'break-word' }}>{item.note}</span>
                    </div>
                  ) : (
                    <div key={item.id} style={{ padding: '6px 0' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13 }}>
                        <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                          调整{index + 1}
                        </span>
                        <span style={{ whiteSpace: 'nowrap' }}>{amount}</span>
                        <span style={{ color: '#666', fontSize: 12, whiteSpace: 'nowrap' }}>
                          {time}
                        </span>
                      </div>
                      <div style={{ marginTop: 2, wordBreak: 'break-word', color: '#333' }}>
                        {item.note}
                      </div>
                    </div>
                  )
                })}
            </div>
          )
        ) : (
          <span style={{ color: '#999' }}>支付记录加载失败</span>
        )}
      </Modal>

      {/* 预订确认书：图片预览，手机端长按保存到相册 */}
      <Modal
        open={letterOpen}
        title="预订确认书"
        footer={null}
        onCancel={() => setLetterOpen(false)}
        width={420}
        centered
      >
        {letterUrl && (
          <>
            <img
              src={letterUrl}
              alt="预订确认书"
              style={{
                width: '100%',
                maxHeight: '62vh',
                objectFit: 'contain',
                borderRadius: 8,
                display: 'block',
                background: '#f5f7fa',
              }}
            />
            <div style={{ textAlign: 'center', color: '#8c8c8c', fontSize: 12, marginTop: 8 }}>
              手机端长按图片可保存到相册；也可点「转发」发送到微信等应用
            </div>
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <Space>
                {isMobile && (
                  <Button
                    type="primary"
                    onClick={async () => {
                      if (!letterUrl) return
                      const result = await shareLetterImage(
                        letterUrl,
                        `预订确认书-${order.order_number}.png`,
                      )
                      if (result === 'unsupported') {
                        message.info('当前浏览器不支持直接转发，请长按图片保存后发送')
                      }
                    }}
                  >
                    转发
                  </Button>
                )}
                <Button href={letterUrl} download={`预订确认书-${order.order_number}.png`}>
                  下载图片
                </Button>
              </Space>
            </div>
          </>
        )}
      </Modal>

      {/* 备注编辑：任何状态下均可修改 */}
      <Modal
        open={noteOpen}
        title="编辑备注"
        okText="保存"
        cancelText="取消"
        confirmLoading={noteSaving}
        onOk={saveNote}
        onCancel={() => {
          if (!noteSaving) setNoteOpen(false)
        }}
        width={420}
        maskClosable={!noteSaving}
      >
        <Input.TextArea
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          autoSize={{ minRows: 4, maxRows: 10 }}
          placeholder="填写备注（可留空）"
          maxLength={1000}
          showCount
        />
      </Modal>

      {/* 按订单项目调整：调整价格 / 退款，备注必填 */}
      <Modal
        open={Boolean(itemAdjustItem)}
        title={itemAdjustMode === 'refund' ? '退款' : '调整价格'}
        okText="保存"
        cancelText="取消"
        confirmLoading={itemAdjustSaving}
        onOk={submitItemAdjust}
        onCancel={() => {
          if (!itemAdjustSaving) setItemAdjustItem(null)
        }}
        width={380}
        maskClosable={!itemAdjustSaving}
      >
        {itemAdjustItem && (
          <Form layout="vertical">
            <Form.Item label="调整项目">
              <span>
                {itemAdjustItem.equipment_spec_name ?? itemAdjustItem.sale_item_name ?? '—'}*
                {itemAdjustItem.quantity}
              </span>
            </Form.Item>
            <Form.Item label="当前金额">
              <span>¥{fenToYuan(itemAdjustMax)}</span>
            </Form.Item>
            <Form.Item
              label={
                itemAdjustMode === 'refund'
                  ? `退款金额（最多 ¥${fenToYuan(itemAdjustMax)}）`
                  : '调整后金额'
              }
              required
            >
              <InputNumber
                value={itemAdjustAmount}
                onChange={(value) => setItemAdjustAmount(typeof value === 'number' ? value : null)}
                min={itemAdjustMode === 'refund' ? 0.01 : 0}
                max={itemAdjustMode === 'refund' ? itemAdjustMax / 100 : undefined}
                precision={2}
                addonBefore="¥"
                style={{ width: '100%' }}
                placeholder={itemAdjustMode === 'refund' ? '请输入退款金额' : '请输入调整后金额'}
              />
            </Form.Item>
            <Form.Item label="备注" required>
              <Input.TextArea
                value={itemAdjustNote}
                onChange={(e) => setItemAdjustNote(e.target.value)}
                autoSize={{ minRows: 2, maxRows: 5 }}
                placeholder={itemAdjustMode === 'refund' ? '请填写退款原因' : '请填写调价原因'}
                maxLength={200}
                showCount
              />
            </Form.Item>
          </Form>
        )}
      </Modal>

      {/* 拆分：把一行拆成多行展示，金额合计须等于该行当前金额 */}
      <Modal
        open={splitOpen}
        title="拆分"
        okText="确认拆分"
        cancelText="取消"
        confirmLoading={splitSaving}
        onOk={submitSplit}
        onCancel={() => {
          if (!splitSaving) setSplitOpen(false)
        }}
        width={420}
        maskClosable={!splitSaving}
      >
        <div style={{ marginBottom: 12 }}>
          当前行金额：<span style={{ fontWeight: 600 }}>¥{fenToYuan(splitTotalFen)}</span>
        </div>
        <Radio.Group
          value={splitMode}
          onChange={(e) => setSplitMode(e.target.value)}
          style={{ marginBottom: 12 }}
        >
          <Radio.Button value="equal">均分</Radio.Button>
          <Radio.Button value="custom">自定义</Radio.Button>
        </Radio.Group>
        {splitMode === 'equal' ? (
          <Form layout="vertical">
            <Form.Item label="拆分份数" required>
              <InputNumber
                min={2}
                precision={0}
                value={splitCount}
                onChange={(value) => setSplitCount(typeof value === 'number' ? value : 2)}
                style={{ width: '100%' }}
              />
            </Form.Item>
            {(() => {
              const count = Math.round(splitCount || 0)
              if (count < 2) return null
              const base = Math.floor(splitTotalFen / count)
              const remainder = splitTotalFen - base * count
              return (
                <div style={{ fontSize: 12, color: '#666' }}>
                  {remainder === 0 ? (
                    <>
                      每份：<span style={{ fontWeight: 600 }}>¥{fenToYuan(base)}</span>
                    </>
                  ) : (
                    <>
                      每份：<span style={{ fontWeight: 600 }}>¥{fenToYuan(base)}</span>
                      ，前 {remainder} 份为 ¥{fenToYuan(base + 1)}
                    </>
                  )}
                </div>
              )
            })()}
          </Form>
        ) : (
          <div>
            {splitAmounts.map((amount, index) => (
              <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <InputNumber
                  value={amount}
                  onChange={(value) =>
                    setSplitAmounts((prev) =>
                      prev.map((a, i) =>
                        i === index ? (typeof value === 'number' ? value : null) : a,
                      ),
                    )
                  }
                  min={0.01}
                  precision={2}
                  addonBefore="¥"
                  style={{ flex: 1 }}
                  placeholder={`第 ${index + 1} 行金额`}
                />
                {splitAmounts.length > 2 && (
                  <Button
                    danger
                    onClick={() => setSplitAmounts((prev) => prev.filter((_, i) => i !== index))}
                  >
                    删除
                  </Button>
                )}
              </div>
            ))}
            <Button
              size="small"
              onClick={() => setSplitAmounts((prev) => [...prev, null])}
              style={{ marginBottom: 8 }}
            >
              添加一行
            </Button>
            {(() => {
              const total = splitAmounts.reduce<number>(
                (sum, a) => sum + yuanToFenSafe(a ?? 0),
                0,
              )
              return (
                <div style={{ color: total === splitTotalFen ? '#3f8600' : '#cf1322', fontSize: 12 }}>
                  已填合计 ¥{fenToYuan(total)}，需等于 ¥{fenToYuan(splitTotalFen)}
                </div>
              )
            })()}
          </div>
        )}
      </Modal>

      {/* 有船只已出发未返还时，完成订单前明确列出船只并要求确认返还 */}
      <Modal
        open={completeOpen}
        title="确认返还并完成订单？"
        okText="确认返还并完成"
        cancelText="取消"
        confirmLoading={completeSubmitting}
        onOk={completeWithBoats}
        onCancel={() => {
          if (!completeSubmitting) setCompleteOpen(false)
        }}
        width={360}
        maskClosable={!completeSubmitting}
      >
        <div style={{ textAlign: 'center', padding: '4px 0 8px' }}>
          <div
            style={{
              display: 'inline-block',
              textAlign: 'left',
              color: '#666',
              lineHeight: 1.9,
              fontSize: 13,
            }}
          >
            <div style={{ marginBottom: 4 }}>以下船只还未返还：</div>
            {outstandingBoats.map((u, index) => {
              const color = typeColorHex(u.equipment_type_color ?? undefined)
              const minutes = Math.max(0, dayjs().diff(dayjs(u.departed_at), 'minute'))
              const duration =
                minutes >= 60
                  ? `${Math.floor(minutes / 60)}小时${minutes % 60}分钟`
                  : `${minutes}分钟`
              return (
                <div key={`${u.number}-${index}`}>
                  <span style={{ color }}>{u.equipment_spec_name ?? '—'}</span>
                  <span> </span>
                  <span style={{ color, fontWeight: 600 }}>{u.number}</span>
                  <span style={{ color: '#000' }}>号</span>
                  <span>，出发时间{dayjs(u.departed_at).format('HH:mm')}，出发时长{duration}</span>
                </div>
              )
            })}
          </div>
        </div>
      </Modal>

      {!embedded && (
        <div style={{ height: isDesktop ? 48 : 'calc(72px + env(safe-area-inset-bottom, 0px))' }} />
      )}
      <div
        ref={actionBarRef}
        style={
          embedded
            ? {
                // 气泡内：操作栏浮在气泡可视区域底部（不随内容滚动），随时可点
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 2,
                background: '#fff',
                borderTop: '1px solid #f0f0f0',
                borderRadius: '0 0 8px 8px',
                padding: '8px 12px',
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                justifyContent: 'center',
              }
            : {
                position: 'fixed',
                bottom: isDesktop ? 16 : 'calc(56px + min(env(safe-area-inset-bottom, 0px), 20px))',
                left: isDesktop ? 'auto' : 0,
                right: isDesktop ? 16 : 0,
                zIndex: 100,
                background: '#fff',
                padding: '8px 12px',
                borderTop: isDesktop ? 'none' : '1px solid #f0f0f0',
                borderRadius: isDesktop ? 8 : 0,
                boxShadow: '0 -2px 8px rgba(0,0,0,0.06)',
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                justifyContent: 'center',
              }
        }
      >
        {(order.editable || order.status === 'in_progress') && canEditOrder && (
          <Button onClick={() => navigate(`/orders/${order.id}/edit`)}>编辑</Button>
        )}
        {canEditOrder &&
          (order.status === 'completed' ||
            order.status === 'cancelled' ||
            order.status === 'no_show') && (
          <Button
            onClick={() => {
              setNoteDraft(order.note ?? '')
              setNoteOpen(true)
            }}
          >
            编辑备注
          </Button>
        )}
        {/* 签到仅当天可操作，未来订单不展示该按钮 */}
        {canEditOrder && order.status === 'active' && !order.checked_in && today && (
          <Popconfirm
            title="确认签到？"
            description="签到以服务器当前时间为准，超过自动归还时限后将由系统自动归还。"
            onConfirm={doCheckIn}
            overlayStyle={{ maxWidth: '70vw', width: 'auto' }}
          >
            <Button type="primary">签到</Button>
          </Popconfirm>
        )}
        {canEditOrder && order.status === 'in_progress' && (
          <Popconfirm
            title="取消签到？"
            description="将清除签到与自动归还时限记录，订单恢复为未签到活动状态。"
            onConfirm={() => action(`/api/orders/${order.id}/cancel-check-in`, '已取消签到')}
          >
            <Button>取消签到</Button>
          </Popconfirm>
        )}
        {/* 完成仅订单日期当天及之后可操作，未来订单不展示该按钮 */}
        {canEditOrder &&
          (order.status === 'active' || order.status === 'in_progress') &&
          canCompleteByDate &&
          (outstandingBoats.length > 0 ? (
            <Button type="primary" ghost onClick={() => setCompleteOpen(true)}>
              完成
            </Button>
          ) : (
            <Popconfirm
              title="确认完成？"
              onConfirm={() => action(`/api/orders/${order.id}/return`, '已完成')}
            >
              <Button type="primary" ghost>完成</Button>
            </Popconfirm>
          ))}
        {canEditOrder && order.returned && (
          <Popconfirm
            title="取消完成？"
            description="订单将恢复为活动状态。"
            onConfirm={() => action(`/api/orders/${order.id}/cancel-return`, '已取消完成')}
          >
            <Button>取消完成</Button>
          </Popconfirm>
        )}
        {canEditOrder && order.status === 'active' && canMarkNoShow && (
          <Popconfirm title="确认标记爽约？" onConfirm={() => action(`/api/orders/${order.id}/no-show`, '已标记爽约')}>
            <Button>爽约</Button>
          </Popconfirm>
        )}
        {canEditOrder && order.status === 'active' && (
          <Popconfirm
            title="确认取消订单？" onConfirm={() => action(`/api/orders/${order.id}/cancel`, '订单已取消')}>
            <Button danger>取消</Button>
          </Popconfirm>
        )}
        {canEditOrder && (order.status === 'no_show' || order.status === 'cancelled') && (
          <Popconfirm
            title="恢复为活动订单？"
            description="已取消或爽约的订单将恢复为预订状态。"
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
    </>
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
