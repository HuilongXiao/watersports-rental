import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  App,
  Button,
  Calendar,
  Card,
  Checkbox,
  Divider,
  Form,
  Grid,
  InputNumber,
  Input,
  Modal,
  Popover,
  Select,
  Space,
  Table,
  Tag,
} from 'antd'
import { DeleteOutlined, MinusOutlined, PlusOutlined, SnippetsOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { api } from '../api'
import { useAuth } from '../auth'
import { useSettings } from '../contexts/SettingsContext'
import { fenToYuan } from '../utils'
import { GenderCheckboxes } from './Customers'
import type { Catalog, Customer, InventoryConflict, Order } from '../types'

// 支付方式选择器：懒加载，仅在点击编辑时才加载组件 JS，不影响首屏性能
const PaymentMethodSelector = lazy(() => import('../components/PaymentMethodSelector'))

interface DraftItem {
  key: string
  kind: 'equipment' | 'sale'
  item_id: string | null
  quantity: number
  /** 是否为从已有订单加载的原始项（进行中订单的原始项不可修改/删除） */
  isOriginal?: boolean
}

export default function OrderForm() {
  const { id } = useParams()
  const editing = Boolean(id)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { message } = App.useApp()
  const { user } = useAuth()
  const canSubmit = editing
    ? Boolean(user?.permissions.edit_order)
    : Boolean(user?.permissions.create_order)
  const screens = Grid.useBreakpoint()

  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [existingOrder, setExistingOrder] = useState<Order | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // submit 防重入锁：React state 是异步更新的，同一个事件循环里
  // 第二次点击进来时 state 还没来得及变，所以用 ref 做同步挡
  const submitLock = useRef(false)
  // 极速客户模式改从全局 SettingsContext 读取（缓存优先，避免挂载后等网络造成闪烁）
  const { settings } = useSettings()
  const fastMode = settings.fast_customer_mode
  const [customerWechatNickname, setCustomerWechatNickname] = useState('')

  // Customer selection (search → confirm)
  const [customerOptions, setCustomerOptions] = useState<Customer[]>([])
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [createCustomerOpen, setCreateCustomerOpen] = useState(false)
  const [customerForm] = Form.useForm()

  // Order header
  // 新建订单默认时间：当前时间向上取整到下一个 15 分钟节点（分钟仅为 00/15/30/45），秒/毫秒清零
  const [startAt, setStartAt] = useState<dayjs.Dayjs>(() => {
    const now = dayjs()
    return now.add(15 - (now.minute() % 15), 'minute').second(0).millisecond(0)
  })
  const [adultCount, setAdultCount] = useState(1)
  const [childCount, setChildCount] = useState(0)
  const [walkIn, setWalkIn] = useState(false)
  const [notePopup, setNotePopup] = useState(false)
  const [note, setNote] = useState('')
  // 支付方式（feature flag 开启时 settings.payment_methods 非空才显示摘要行）
  const [paymentCode, setPaymentCode] = useState<string | null>(null)
  const [payEditOpen, setPayEditOpen] = useState(false)
  // 用户手动改过支付方式后不再自动填默认值
  const pmTouched = useRef(false)
  // http 局域网环境无法直接读取剪贴板时，用弹窗捕获用户手动粘贴的内容
  const [pasteFallbackOpen, setPasteFallbackOpen] = useState(false)
  // 开始日期日历弹窗
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const peopleTouched = useRef(false)

  // 进入订单创建/编辑页时滚动到顶部，避免停留在上次编辑的底部位置
  useEffect(() => {
    window.scrollTo(0, 0)
    document.querySelector('.ant-layout-content')?.scrollTo(0, 0)
  }, [])

  // 新建订单时默认带一个未选择内容的项目行；编辑订单时会被订单实际项目覆盖
  const [items, setItems] = useState<DraftItem[]>(() => [
    { key: `default-${Date.now()}`, kind: 'equipment', item_id: null, quantity: 1 },
  ])

  const searchCustomers = useCallback(async (value: string) => {
    if (!value.trim()) {
      setCustomerOptions([])
      return
    }
    try {
      setCustomerOptions(await api.get<Customer[]>(`/api/customers?q=${encodeURIComponent(value)}`))
    } catch {
      setCustomerOptions([])
    }
  }, [])

  const handleCustomerChange = useCallback(async (value: string) => {
    setCustomerId(value)
    if (!value) return
    try {
      const c = await api.get<Customer>(`/api/customers/${value}`)
      if (c.remind && c.note) {
        Modal.warning({
          title: '客户备注提醒',
          content: c.note,
        })
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    api.get<Catalog>('/api/catalog').then(setCatalog).catch(() => message.error('目录加载失败'))
    if (id) {
      api
        .get<Order>(`/api/orders/${id}`)
        .then(async (order) => {
          setExistingOrder(order)
          setCustomerId(order.customer_id)
          try {
            const customer = await api.get<Customer>(`/api/customers/${order.customer_id}`)
            setCustomerOptions([customer])
          } catch {
            // Fallback: render the snapshot fields from the order.
            setCustomerOptions([
              {
                id: order.customer_id,
                name: order.customer_name,
                gender: order.customer_gender,
                wechat_nickname: order.customer_wechat_nickname,
                wechat_id: order.customer_wechat_id,
                phone: order.customer_phone,
              },
            ])
          }
          setStartAt(dayjs(order.start_at))
          setAdultCount(order.adult_count)
          setChildCount(order.child_count)
          setWalkIn(order.is_walk_in ?? false)
          setNotePopup(order.note_popup ?? false)
          setNote(order.note ?? '')
          setPaymentCode(order.payment_method_code ?? null)
          setCustomerWechatNickname(order.customer_wechat_nickname ?? '')
          setItems(
            order.items.map((item) => ({
              key: item.id,
              kind: item.equipment_spec_id ? 'equipment' : 'sale',
              item_id: item.equipment_spec_id ?? item.sale_item_id,
              quantity: item.quantity,
              isOriginal: true,
            })),
          )
          peopleTouched.current = true
        })
        .catch((error) => message.error(error.message))
    } else {
      // 新建订单：若 URL 带 ?customerId=xxx 则预填该客户（来自客户详情页"创建订单"按钮）；
      // 否则默认选游客 system customer
      const prefillCustomerId = searchParams.get('customerId')
      if (prefillCustomerId) {
        api
          .get<Customer>(`/api/customers/${prefillCustomerId}`)
          .then((c) => {
            setCustomerId(c.id)
            setCustomerOptions([c])
            setWalkIn(false)
            setCustomerWechatNickname(c.wechat_nickname ?? '')
          })
          .catch(() => {
            // 预填失败时回退到游客
            api
              .get<Customer[]>('/api/customers?q=游客')
              .then((rows) => {
                const guest = rows.find((row) => row.is_system) ?? rows[0]
                if (guest) {
                  setCustomerId(guest.id)
                  setCustomerOptions([guest])
                }
              })
              .catch(() => undefined)
          })
      } else {
        api
          .get<Customer[]>('/api/customers?q=游客')
          .then((rows) => {
            const guest = rows.find((row) => row.is_system) ?? rows[0]
            if (guest) {
              setCustomerId(guest.id)
              setCustomerOptions([guest])
            }
          })
          .catch(() => undefined)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const priceMap = new Map<string, { price: number; name: string; capacity: number | null }>()
  catalog?.equipment.forEach((s) =>
    priceMap.set(s.id, { price: s.price, name: s.name, capacity: s.capacity }),
  )
  catalog?.sale_items.forEach((s) =>
    priceMap.set(s.id, { price: s.price, name: s.name, capacity: null }),
  )

  const applyDefaultPeople = (specId: string | null, kind: 'equipment' | 'sale') => {
    if (peopleTouched.current || !catalog || kind !== 'equipment' || !specId) return
    const spec = catalog.equipment.find((s) => s.id === specId)
    if (!spec) return
    // Paddleboard-style specs (capacity NULL) have no composition rule:
    // keep the generic default of 1 adult. Only seat-carrying boats prefill.
    if (spec.capacity == null) {
      setAdultCount(1)
      setChildCount(0)
    } else {
      setAdultCount(Math.min(2, spec.capacity))
      setChildCount(0)
    }
  }

  // 订单锁定状态：终态（已完成/已取消/爽约）完全锁定；进行中仅允许调整销售项目
  const locked = existingOrder ? !existingOrder.editable : false
  const isInProgress = existingOrder?.status === 'in_progress'
  const terminalLocked = locked && !isInProgress
  // 编辑已有订单时客户信息不可修改（任何状态）
  const isEdit = existingOrder != null

  const addItem = () => {
    setItems((prev) => [
      ...prev,
      { key: `${Date.now()}-${Math.random()}`, quantity: 1, ...firstActiveItem() },
    ])
  }

  // 列表第一项：进行中订单取第一个销售项目；否则启用的器材优先，其次售卖项目
  const firstActiveItem = (): { item_id: string | null; kind: 'equipment' | 'sale' } => {
    if (isInProgress) {
      const sale = catalog?.sale_items.find((s) => s.is_active)
      if (sale) return { item_id: sale.id, kind: 'sale' }
      return { item_id: null, kind: 'sale' }
    }
    const spec = catalog?.equipment.find((s) => s.is_active)
    if (spec) return { item_id: spec.id, kind: 'equipment' }
    const sale = catalog?.sale_items.find((s) => s.is_active)
    if (sale) return { item_id: sale.id, kind: 'sale' }
    return { item_id: null, kind: 'equipment' }
  }

  // 目录加载后，新建订单中未选择的项目行自动填入列表第一项；编辑订单保持实际项目
  useEffect(() => {
    if (id || !catalog) return
    const first = firstActiveItem()
    if (!first.item_id) return
    setItems((prev) =>
      prev.map((item) => (item.item_id ? item : { ...item, item_id: first.item_id, kind: first.kind })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, id])

  const updateItem = (key: string, patch: Partial<DraftItem>) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item
        const next = { ...item, ...patch }
        if (patch.item_id && patch.item_id !== item.item_id) {
          applyDefaultPeople(next.item_id, next.kind)
        }
        return next
      }),
    )
  }

  const removeItem = (key: string) => setItems((prev) => prev.filter((item) => item.key !== key))

  const totalFen = items.reduce((sum, item) => {
    if (!item.item_id) return sum
    const meta = priceMap.get(item.item_id)
    return sum + (meta ? meta.price * item.quantity : 0)
  }, 0)

  // 新建订单：未手动选择过时自动填系统默认支付方式（feature 关闭时默认值为 null，不生效）
  useEffect(() => {
    if (id || pmTouched.current || paymentCode) return
    if (settings.default_payment_method) setPaymentCode(settings.default_payment_method)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.default_payment_method, id])

  // 支付方式紧凑摘要：渲染在订单项目"合计"右侧（feature 未开启时为 null）
  const paymentSummary =
    settings.payment_methods.length > 0 ? (
      <span style={{ color: '#666', fontSize: 13, whiteSpace: 'nowrap' }}>
        支付方式：
        {paymentCode
          ? settings.payment_methods.find((m) => m.code === paymentCode)?.name ??
            `未知方式(${paymentCode})`
          : '未选择'}
        <Button
          size="small"
          type="link"
          disabled={terminalLocked}
          onClick={() => setPayEditOpen(true)}
        >
          编辑
        </Button>
      </span>
    ) : null

  // 库存冲突预检弹窗
  const [conflictOpen, setConflictOpen] = useState(false)
  const [conflicts, setConflicts] = useState<InventoryConflict[]>([])
  const [checkingConflicts, setCheckingConflicts] = useState(false)

  // 校验并组装订单提交体；不通过时给出提示并返回 null
  const buildOrderBody = (): Record<string, unknown> | null => {
    if (fastMode) {
      if (!customerWechatNickname.trim()) {
        message.warning('请填写客户微信昵称')
        return null
      }
    } else if (!customerId) {
      message.warning('请选择或创建客户')
      return null
    }
    if (items.length === 0) {
      message.warning('请至少添加一个项目')
      return null
    }
    if (items.some((item) => !item.item_id)) {
      message.warning('请完善订单项目')
      return null
    }
    if (adultCount + childCount < 1) {
      message.warning('至少需要 1 人')
      return null
    }
    return {
      ...(fastMode
        ? { customer_wechat_nickname: customerWechatNickname.trim() }
        : { customer_id: customerId }),
      start_at: startAt.second(0).millisecond(0).toISOString(),
      adult_count: adultCount,
      child_count: childCount,
      note: note.trim() || null,
      is_walk_in: walkIn,
      // 备注为空时弹窗标记不生效，与客户提醒的约定一致
      note_popup: note.trim() ? notePopup : false,
      // 功能未开启时不发送该字段（后端也会忽略）
      ...(settings.payment_methods.length > 0 ? { payment_method_code: paymentCode } : {}),
      items: items.map((item) =>
        item.kind === 'equipment'
          ? { equipment_spec_id: item.item_id, quantity: item.quantity }
          : { sale_item_id: item.item_id, quantity: item.quantity },
      ),
    }
  }

  // 人数容量预检：规则必须与后端 order_service.validate_people_capacity 完全一致
  // （总人数 ≤ 总座位；每单位器材最多 2 名成人；capacity 为 NULL 的桨板类不限制）。
  // 在发起重复单/库存预检之前即时提示，避免用户走完「库存超售」确认弹窗后，
  // 才在真正保存时被后端 422 拦下，体感上像“超售也不能下单”。
  const peopleCapacityError = (): string | null => {
    const adults = adultCount
    const children = childCount
    if (adults + children < 1) return null // 已由 buildOrderBody 的“至少 1 人”提示覆盖
    const seated: { cap: number; qty: number }[] = []
    for (const it of items) {
      if (it.kind !== 'equipment' || !it.item_id) continue
      const cap = priceMap.get(it.item_id)?.capacity
      if (cap == null) continue // 桨板类 capacity=NULL，不施加人数规则
      seated.push({ cap, qty: it.quantity })
    }
    if (seated.length === 0) return null
    const totalSeats = seated.reduce((sum, x) => sum + x.cap * x.qty, 0)
    const maxAdults = seated.reduce((sum, x) => sum + Math.min(2, x.cap) * x.qty, 0)
    if (adults + children > totalSeats) {
      return `总人数不能超过设备承载人数 ${totalSeats} 人`
    }
    if (adults < 1) return '至少需要 1 名成人'
    if (adults > maxAdults) return `当前器材组合最多 ${maxAdults} 名成人（可增加器材数量或减少成人）`
    return null
  }

  const saveOrder = async (body: Record<string, unknown>) => {
    setSubmitting(true)
    try {
      const order = editing
        ? await api.put<Order>(`/api/orders/${id}`, body)
        : await api.post<Order>('/api/orders', body)
      message.success(editing ? '订单已更新' : '订单已创建')
      navigate(`/orders/${order.id}`, { replace: true })
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  const submit = async (force = false) => {
    // 防重入：ref 是同步的，同一次事件循环里第二次点击进来时立刻挡住；
    // 同时把 submitting 状态前移到最开头，让按钮在 dup-check / conflicts / 保存
    // 三个阶段都处于 loading，彻底杜绝"点一次发三次"。
    if (submitLock.current) return
    submitLock.current = true
    setSubmitting(true)
    try {
      const body = buildOrderBody()
      if (!body) return

      // 人数容量前置校验：与后端同一规则，先于重复单/库存超售预警拦截，
      // 给出明确原因并阻止提交（硬性安全规则，不允许强制保存）。
      const capacityErr = peopleCapacityError()
      if (capacityErr) {
        Modal.warning({
          title: '人数与所选器材不匹配',
          content: capacityErr,
          okText: '知道了',
        })
        return
      }

    // 重复订单检查：仅新建订单（编辑不检查），同一客户+同一业务日期+船型有交集时预警
    if (!force && !editing) {
      try {
        const dupResult = await api.post<{ duplicates: Array<{
          order_id: string
          order_number: string
          start_at: string
          status: string
          customer_name: string | null
          customer_wechat_nickname: string | null
          adult_count: number
          child_count: number
          items: Array<{ name: string; quantity: number }>
        }> }>('/api/orders/duplicate-check', body)
        if (dupResult.duplicates.length > 0) {
          const confirmed = await new Promise<boolean>(resolve => {
            Modal.confirm({
              title: '类似订单提醒',
              content: (
                <div>
                  <p style={{ marginBottom: 12 }}>
                    当前创建的订单与以下订单类似，是否确认创建？
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {dupResult.duplicates.map(d => (
                      <div
                        key={d.order_id}
                        style={{
                          border: '1px solid #ffe58f',
                          background: '#fffbe6',
                          borderRadius: 6,
                          padding: '8px 12px',
                        }}
                      >
                        <div style={{ fontWeight: 600, marginBottom: 4 }}>
                          {d.order_number}
                        </div>
                        <div style={{ fontSize: 13, color: '#666' }}>
                          客户：{d.customer_wechat_nickname || d.customer_name || '—'}
                        </div>
                        <div style={{ fontSize: 13, color: '#666' }}>
                          日期：{dayjs(d.start_at).format('YYYY-MM-DD')}
                        </div>
                        <div style={{ fontSize: 13, color: '#666' }}>
                          开始时间：{dayjs(d.start_at).format('HH:mm')}
                        </div>
                        <div style={{ fontSize: 13, color: '#666' }}>
                          人数：成人 {d.adult_count}，儿童 {d.child_count}
                        </div>
                        <div style={{ fontSize: 13, color: '#666' }}>
                          船型：{d.items.map(i => `${i.name}×${i.quantity}`).join('、')}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ),
              okText: '确认创建',
              cancelText: '返回',
              onOk: () => resolve(true),
              onCancel: () => resolve(false),
            })
          })
          if (!confirmed) return
        }
      } catch (error) {
        // 重复检查失败不阻断保存流程
        console.warn('重复订单检查失败', error)
      }
    }

    // 首次保存先做库存冲突预检；进行中订单仅调整销售项目，无需预检；
    // 用户在预警弹窗中再次确认后跳过预检直接保存
    if (!force && !isInProgress) {
      setCheckingConflicts(true)
      try {
        const query = editing ? `?exclude_order_id=${encodeURIComponent(id ?? '')}` : ''
        const result = await api.post<{ conflicts: InventoryConflict[] }>(
          `/api/orders/conflicts${query}`,
          body,
        )
        if (result.conflicts.length > 0) {
          setConflicts(result.conflicts)
          setConflictOpen(true)
          return
        }
      } catch (error) {
        // 预检失败不阻断保存流程，按原流程提交由后端校验
        console.warn('库存冲突预检失败', error)
      } finally {
        setCheckingConflicts(false)
      }
    } else {
      setConflictOpen(false)
    }

    await saveOrder(body)
    } finally {
      submitLock.current = false
      // 必须在外层 finally 复位 submitting：冲突预警弹窗、类似订单提醒点
      // “返回”都是提前 return 的路径，若不复位，submitting 会残留 true，
      // 导致弹窗里的「保存」按钮一直处于 loading（antd Button loading 时
      // 会禁用点击），submit(true) 永远无法触发，表现为超售后无法下单。
      setSubmitting(false)
    }
  }

  // 点击“贴”：先清空客户微信昵称，再把系统剪贴板内容填入。
  // https/localhost 下可直接读取剪贴板（iOS 首次会弹“Paste/粘贴”授权气泡，
  // 点一下即可；授权后本次会话内再点会直接粘贴）；http 局域网环境浏览器
  // 禁止 JS 读取剪贴板，此时弹出输入框由用户长按粘贴，paste 事件自动捕获。
  const pasteWechatNickname = async () => {
    setCustomerWechatNickname('')
    try {
      if (!navigator.clipboard?.readText) {
        throw new DOMException('clipboard api unavailable', 'NotSupportedError')
      }
      const text = await navigator.clipboard.readText()
      if (!text.trim()) {
        message.warning('剪贴板为空')
        return
      }
      setCustomerWechatNickname(text.trim())
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        // 用户未点屏幕上的 Paste 授权气泡（点到了别处），不是剪贴板不可用
        message.info('读取剪贴板需授权：请点击屏幕上出现的「粘贴 / Paste」气泡，授权后再点粘贴按钮即可直接填入')
        return
      }
      setPasteFallbackOpen(true)
    }
  }

  const createCustomer = async () => {
    const values = await customerForm.validateFields()
    const body = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        typeof value === 'string' && value.trim() ? value.trim() : value || null,
      ]),
    )
    if (!body.name && !body.wechat_nickname) {
      message.warning('请至少填写姓名或微信昵称')
      return
    }
    try {
      const customer = await api.post<Customer>('/api/customers', body)
      message.success('客户已创建')
      setCreateCustomerOpen(false)
      customerForm.resetFields()
      setCustomerId(customer.id)
      setCustomerOptions((prev) => [customer, ...prev])
    } catch (error) {
      message.error(error instanceof Error ? error.message : '创建失败')
    }
  }

  const activeSpecs = catalog?.equipment.filter((s) => s.is_active) ?? []
  const activeSaleItems = catalog?.sale_items.filter((s) => s.is_active) ?? []

  // 船型与销售项目混合，按近 7 日销售数量降序排列（销量高的靠前）；
  // 销量相同时按名称升序稳定兜底。
  const allActiveItems = [
    ...activeSpecs.map((s) => ({
      id: s.id,
      kind: 'equipment' as const,
      name: s.name,
      price: s.price,
      sold_quantity_7d: s.sold_quantity_7d,
    })),
    ...activeSaleItems.map((s) => ({
      id: s.id,
      kind: 'sale' as const,
      name: s.name,
      price: s.price,
      sold_quantity_7d: s.sold_quantity_7d,
    })),
  ].sort((a, b) => b.sold_quantity_7d - a.sold_quantity_7d || a.name.localeCompare(b.name))
  const itemKindMap = new Map(allActiveItems.map((i) => [i.id, i.kind]))

  // 进行中订单：原始项（器材 + 已保存的销售项目）不可改，仅本次新增项可编辑
  const rowDisabled = (record: DraftItem) =>
    terminalLocked || (isInProgress && record.isOriginal)

  const rowOptions = (record: DraftItem) => {
    if (!isInProgress) return allActiveItems
    const saleItems = allActiveItems
      .filter((i) => i.kind === 'sale')
      .sort((a, b) => b.sold_quantity_7d - a.sold_quantity_7d || a.name.localeCompare(b.name))
    // 原始行（器材或已保存的销售项目）需保留当前项用于回显
    if (record.isOriginal && record.item_id) {
      const current = allActiveItems.find((i) => i.id === record.item_id)
      if (current) return [current, ...saleItems]
    }
    return saleItems
  }

  const isMobile = !screens.md
  const itemColumns = [
    {
      // 表头“项目”右侧的加号即“添加项目”按钮，沿用原虚线按钮样式并放大点击区域
      title: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          项目
          <Button
            type="dashed"
            size="small"
            icon={<PlusOutlined />}
            onClick={addItem}
            disabled={terminalLocked}
            title="添加项目"
            style={{ width: 28, height: 24, padding: 0 }}
          />
        </span>
      ),
      render: (_: unknown, record: DraftItem) => (
        <Select
          style={{ width: '100%' }}
          placeholder="选择项目"
          value={record.item_id}
          disabled={rowDisabled(record)}
          onChange={(value) => {
            const kind = itemKindMap.get(value) ?? 'equipment'
            updateItem(record.key, { item_id: value, kind })
          }}
          options={rowOptions(record).map((item) => ({
            value: item.id,
            label: `${item.name} - ${fenToYuan(item.price)}元`,
          }))}
        />
      ),
    },
    ...(isMobile
      ? []
      : [
          {
            title: '单价',
            width: 80,
            align: 'right' as const,
            render: (_: unknown, record: DraftItem) =>
              record.item_id ? `¥${fenToYuan(priceMap.get(record.item_id)?.price ?? 0)}` : '—',
          },
        ]),
    {
      title: '数量',
      width: isMobile ? 100 : 64,
      render: (_: unknown, record: DraftItem) => {
        const disabled = rowDisabled(record)
        return isMobile ? (
          <Space size={4}>
            <Button
              size="small"
              icon={<MinusOutlined />}
              onClick={() => updateItem(record.key, { quantity: Math.max(1, record.quantity - 1) })}
              disabled={disabled || record.quantity <= 1}
            />
            <span style={{ minWidth: 24, textAlign: 'center' }}>{record.quantity}</span>
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={() => updateItem(record.key, { quantity: record.quantity + 1 })}
              disabled={disabled}
            />
          </Space>
        ) : (
          <InputNumber
            min={1}
            value={record.quantity}
            disabled={disabled}
            style={{ width: 60 }}
            onChange={(value) => updateItem(record.key, { quantity: value ?? 1 })}
          />
        )
      },
    },
    ...(isMobile
      ? []
      : [
          {
            title: '小计',
            width: 80,
            align: 'right' as const,
            render: (_: unknown, record: DraftItem) =>
              record.item_id
                ? `¥${fenToYuan((priceMap.get(record.item_id)?.price ?? 0) * record.quantity)}`
                : '—',
          },
        ]),
    {
      title: '',
      // feature 开启时加宽本列（仅桌面端），用于在合计行右侧展示支付方式摘要
      width: !isMobile && settings.payment_methods.length > 0 ? 190 : 36,
      render: (_: unknown, record: DraftItem) => (
        <Button
          type="text"
          danger
          icon={<DeleteOutlined />}
          disabled={rowDisabled(record)}
          onClick={() => removeItem(record.key)}
        />
      ),
    },
  ]


  // --- Date / time steppers ---
  // Past dates/times are allowed when creating orders.

  const incTime = () => {
    setStartAt(startAt.add(15, 'minute').second(0))
  }

  const decTime = () => {
    setStartAt(startAt.subtract(15, 'minute').second(0))
  }

  // Time grid: 05:30–20:00 in 30-minute steps = 30 slots, 5 rows × 6 cols
  const timeSlots: string[] = []
  for (let h = 5, m = 30; h < 20 || (h === 20 && m === 0); ) {
    timeSlots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
    m += 30
    if (m >= 60) { m -= 60; h += 1 }
  }

  const timeGridContent = (
    <div style={{ maxWidth: 280 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
        {timeSlots.map((slot) => {
          const [h, mi] = slot.split(':').map(Number)
          const slotTime = startAt.hour(h).minute(mi).second(0)
          return (
            <Button
              key={slot}
              size="small"
              type={startAt.format('HH:mm') === slot ? 'primary' : 'default'}
              style={{ padding: '4px 0', fontSize: 12 }}
              onClick={() => {
                setStartAt(slotTime)
              }}
            >
              {slot}
            </Button>
          )
        })}
      </div>
    </div>
  )

  const stepperDisplay: React.CSSProperties = {
    flex: 1,
    textAlign: 'center',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid #d9d9d9',
    borderLeft: 'none',
    borderRight: 'none',
    fontWeight: 600,
  }

  return (
    <>
    <Card
      title={editing ? `编辑订单 ${existingOrder?.order_number ?? ''}` : '新建订单'}
    >
      {terminalLocked ? (
        <p style={{ color: '#d4380d' }}>
          该订单已签到或处于终态，项目已锁定。如需修改，请先取消签到或将订单恢复为活动状态。
        </p>
      ) : isInProgress ? (
        <p style={{ color: '#d4380d' }}>
          订单进行中，器材项目不可修改，仅可添加或调整销售项目。
        </p>
      ) : null}

      <Form layout="vertical" className="compact-order-form" style={{ maxWidth: 720 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            // 编辑已有订单时客户信息不可修改：保持原色显示（客户昵称可能含彩色图标），
            // 仅阻断鼠标交互；键盘输入由 readOnly / tabIndex / open 兜底
            pointerEvents: isEdit ? 'none' : undefined,
          }}
        >
          {fastMode ? (
            <Form.Item label="客户微信昵称" required style={{ flex: 1 }}>
              <Input
                placeholder="输入客户微信昵称"
                value={customerWechatNickname}
                onChange={(e) => setCustomerWechatNickname(e.target.value)}
                style={{ maxWidth: 300, caretColor: isEdit ? 'transparent' : undefined }}
                readOnly={isEdit}
                tabIndex={isEdit ? -1 : undefined}
              />
            </Form.Item>
          ) : (
            <Form.Item label="客户（输入姓名/手机/微信搜索后确认）" style={{ flex: 1 }}>
              <Space.Compact style={{ width: '100%' }}>
                <Select
                  style={{ flex: 1 }}
                  showSearch
                  placeholder="搜索并确认客户"
                  value={customerId}
                  filterOption={false}
                  onSearch={searchCustomers}
                  onChange={handleCustomerChange}
                  open={isEdit ? false : undefined}
                  tabIndex={isEdit ? -1 : undefined}
                  options={customerOptions.map((c) => ({
                    value: c.id,
                    label: [c.name, c.phone, c.wechat_nickname].filter(Boolean).join(' / '),
                  }))}
                />
                <Button
                  onClick={() => {
                    if (isEdit) return
                    setCreateCustomerOpen(true)
                  }}
                  tabIndex={isEdit ? -1 : undefined}
                >
                  新建客户
                </Button>
              </Space.Compact>
            </Form.Item>
          )}
          {/* 粘贴按钮位于昵称输入框与散客勾选框中间，仅极速客户模式显示 */}
          {fastMode && (
            <Form.Item label=" " style={{ flex: 'none' }}>
              <Button
                icon={<SnippetsOutlined />}
                onClick={() => {
                  if (isEdit) return
                  pasteWechatNickname()
                }}
                title="粘贴剪贴板内容"
                tabIndex={isEdit ? -1 : undefined}
              />
            </Form.Item>
          )}
          {/* 占位 label 使勾选框与客户输入框在同一水平行 */}
          <Form.Item label=" " style={{ flex: 'none' }}>
            <Checkbox
              checked={walkIn}
              disabled={isInProgress}
              tabIndex={isEdit ? -1 : undefined}
              onChange={(e) => setWalkIn(e.target.checked)}
            >
              散客
            </Checkbox>
          </Form.Item>
        </div>

        <Space wrap size={12}>
          <Form.Item label="开始日期">
            <Space.Compact style={{ width: 220 }}>
              <Button
                style={{ width: 40 }}
                disabled={isInProgress}
                onClick={() => setStartAt(startAt.subtract(1, 'day'))}
              >
                −
              </Button>
              <Popover
                content={
                  <Calendar
                    value={startAt}
                    onSelect={(date) => {
                      setStartAt(
                        startAt.year(date.year()).month(date.month()).date(date.date())
                      )
                      setDatePickerOpen(false)
                    }}
                    fullscreen={false}
                  />
                }
                trigger="click"
                open={datePickerOpen}
                onOpenChange={setDatePickerOpen}
                placement="bottom"
              >
                <div style={{ ...stepperDisplay, cursor: 'pointer' }}>
                  {startAt.format('YYYY-MM-DD')}
                </div>
              </Popover>
              <Button style={{ width: 40 }} disabled={isInProgress} onClick={() => setStartAt(startAt.add(1, 'day'))}>
                +
              </Button>
            </Space.Compact>
          </Form.Item>
          <Form.Item label="开始时间">
            <Space.Compact style={{ width: 160 }}>
              <Button style={{ width: 40 }} disabled={isInProgress} onClick={decTime}>
                −
              </Button>
              <Popover content={timeGridContent} trigger="click" placement="bottom">
                <div style={{ ...stepperDisplay, cursor: 'pointer' }}>{startAt.format('HH:mm')}</div>
              </Popover>
              <Button style={{ width: 40 }} disabled={isInProgress} onClick={incTime}>
                +
              </Button>
            </Space.Compact>
          </Form.Item>
          <Form.Item label="成人">
            <Space.Compact style={{ width: 140 }}>
              <Button
                style={{ width: 40 }}
                disabled={adultCount <= 0 || isInProgress}
                onClick={() => {
                  peopleTouched.current = true
                  setAdultCount((v) => Math.max(0, v - 1))
                }}
              >
                −
              </Button>
              <div style={stepperDisplay}>{adultCount}</div>
              <Button
                style={{ width: 40 }}
                disabled={isInProgress}
                onClick={() => {
                  peopleTouched.current = true
                  setAdultCount((v) => v + 1)
                }}
              >
                +
              </Button>
            </Space.Compact>
          </Form.Item>
          <Form.Item label="儿童">
            <Space.Compact style={{ width: 140 }}>
              <Button
                style={{ width: 40 }}
                disabled={childCount <= 0 || isInProgress}
                onClick={() => {
                  peopleTouched.current = true
                  setChildCount((v) => Math.max(0, v - 1))
                }}
              >
                −
              </Button>
              <div style={stepperDisplay}>{childCount}</div>
              <Button
                style={{ width: 40 }}
                disabled={isInProgress}
                onClick={() => {
                  peopleTouched.current = true
                  setChildCount((v) => v + 1)
                }}
              >
                +
              </Button>
            </Space.Compact>
          </Form.Item>
        </Space>
        <p style={{ color: '#999', marginTop: -4 }}>
          结束时间：{startAt.add(2, 'hour').format('YYYY-MM-DD HH:mm')}
        </p>
      </Form>

      <Divider>订单项目</Divider>
      <Table
        rowKey="key"
        className="order-items-table"
        columns={itemColumns}
        dataSource={items}
        pagination={false}
        summary={() => (
          <Table.Summary.Row>
            {isMobile ? (
              <>
                <Table.Summary.Cell index={0} colSpan={3}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    <strong>合计 ¥{fenToYuan(totalFen)}</strong>
                    {paymentSummary}
                  </div>
                </Table.Summary.Cell>
              </>
            ) : (
              <>
                <Table.Summary.Cell index={0} colSpan={4}>
                  <strong>合计</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4} align="right">
                  <strong>¥{fenToYuan(totalFen)}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={5} align="right">{paymentSummary}</Table.Summary.Cell>
              </>
            )}
          </Table.Summary.Row>
        )}
      />
      {editing && (
        <p style={{ color: '#faad14', marginTop: 12 }}>
          <Tag color="orange">提示</Tag>
          签到前可修改项目；保存将用新的价格快照替换全部项目。
        </p>
      )}

      <Divider>备注</Divider>
      <Input.TextArea
        rows={2}
        value={note}
        onChange={(e) => {
          setNote(e.target.value)
          // 备注清空时弹窗勾选自动取消
          if (!e.target.value.trim()) setNotePopup(false)
        }}
        placeholder="订单备注（选填）"
        style={{ maxWidth: 720 }}
      />
      <div style={{ marginTop: 8 }}>
        <Checkbox
          checked={notePopup}
          disabled={locked || !note.trim()}
          onChange={(e) => setNotePopup(e.target.checked)}
        >
          打开订单时展示气泡对话框，提示备注内容，并点击"确认"关闭气泡对话框
        </Checkbox>
      </div>

      <Modal
        title="选择支付方式"
        open={payEditOpen}
        onCancel={() => setPayEditOpen(false)}
        onOk={() => setPayEditOpen(false)}
        okText="确定"
        cancelText="清除选择"
        cancelButtonProps={{
          onClick: () => {
            pmTouched.current = true
            setPaymentCode(null)
            setPayEditOpen(false)
          },
        }}
        destroyOnClose
      >
        <Suspense fallback={<div style={{ padding: 24, textAlign: 'center' }}>加载中…</div>}>
          <PaymentMethodSelector
            value={paymentCode}
            onChange={(code) => {
              pmTouched.current = true
              setPaymentCode(code)
            }}
          />
        </Suspense>
      </Modal>

      {/* http 环境无法直接读取剪贴板：用户长按输入框选择“粘贴”后自动捕获并回填 */}
      <Modal
        title="粘贴微信昵称"
        open={pasteFallbackOpen}
        onCancel={() => setPasteFallbackOpen(false)}
        footer={null}
        destroyOnClose
      >
        <Input
          autoFocus
          placeholder="长按此处选择“粘贴”"
          onPaste={(e) => {
            const text = e.clipboardData.getData('text').trim()
            setCustomerWechatNickname(text)
            setPasteFallbackOpen(false)
            if (text) message.success('已粘贴')
          }}
        />
      </Modal>

      <Modal
        title="新建客户"
        open={createCustomerOpen}
        onCancel={() => setCreateCustomerOpen(false)}
        onOk={createCustomer}
        destroyOnClose
      >
        <Form form={customerForm} layout="vertical">
          <Form.Item label="姓名" name="name">
            <Input placeholder="客户姓名" />
          </Form.Item>
          <Form.Item label="手机号" name="phone">
            <Input placeholder="手机号" />
          </Form.Item>
          <Form.Item label="微信昵称" name="wechat_nickname">
            <Input placeholder="微信昵称" />
          </Form.Item>
          <Form.Item label="微信ID" name="wechat_id">
            <Input placeholder="微信ID" />
          </Form.Item>
          <Form.Item label="性别" name="gender">
            <GenderCheckboxes />
          </Form.Item>
          <p style={{ color: '#999' }}>
            至少填写姓名或微信昵称中的一项即可；手机号、微信ID可选填。
          </p>
        </Form>
      </Modal>

      <Modal
        title="库存冲突预警"
        open={conflictOpen}
        onCancel={() => setConflictOpen(false)}
        footer={[
          <Button key="back" onClick={() => setConflictOpen(false)}>
            返回
          </Button>,
          <Button
            key="save"
            type="primary"
            danger
            loading={submitting}
            onClick={() => submit(true)}
          >
            保存
          </Button>,
        ]}
      >
        <p style={{ marginBottom: 12 }}>
          以下船型在所选时段预计超出库存，确认仍要保存该订单吗？
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {conflicts.map((c) => (
            <div
              key={c.equipment_spec_id}
              style={{
                border: '1px solid #ffccc7',
                background: '#fff2f0',
                borderRadius: 6,
                padding: '8px 12px',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {c.equipment_spec_name}（库存 {c.total_quantity} 条，本单{' '}
                {c.requested_quantity} 条，最多缺 {c.shortage} 条）
              </div>
              {c.ranges.map((r, idx) => (
                <div key={idx} style={{ fontSize: 13, color: '#5c0011' }}>
                  · {r.start}–{r.end} 已有 {r.existing} 条预订/使用，预计占用 {r.occupied}{' '}
                  条，超出 {r.shortage} 条
                </div>
              ))}
            </div>
          ))}
        </div>
      </Modal>
    </Card>
    <div
      style={{
        position: 'fixed',
        bottom: screens.md ? 24 : 'calc(72px + env(safe-area-inset-bottom, 0px))',
        right: 16,
        zIndex: 100,
      }}
    >
      <Space>
        <Button onClick={() => navigate(id ? `/orders/${id}` : '/orders')}>取消</Button>
        <Button
          type="primary"
          loading={submitting || checkingConflicts}
          onClick={() => submit()}
          disabled={terminalLocked || !canSubmit}
        >
          保存订单
        </Button>
      </Space>
    </div>
    </>
  )
}
