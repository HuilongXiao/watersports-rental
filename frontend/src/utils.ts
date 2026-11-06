import dayjs from 'dayjs'

// Money is integer fen in the backend; the UI shows yuan.
export function fenToYuan(fen: number): string {
  return (fen / 100).toFixed(2)
}

export function yuanToFen(yuan: number): number {
  return Math.round(yuan * 100)
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return ''
  return dayjs(iso).format('YYYY-MM-DD HH:mm')
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return dayjs(iso).format('YYYY-MM-DD')
}

// 时长（分钟）格式化为“X小时Y分”；不足 1 小时仅显示“Y分”
export function formatDurationMinutes(totalMinutes: number): string {
  const mins = Math.max(0, Math.round(totalMinutes))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `${h}小时${m}分` : `${m}分`
}

// 两个 ISO 时间之间的时长文案（归还时间 − 开始时间）
export function formatDurationBetween(startIso: string, endIso: string): string {
  return formatDurationMinutes(dayjs(endIso).diff(dayjs(startIso), 'minute', true))
}

// Equipment type palette. Hex values are readable-on-white 700-level shades,
// used both for the selection swatches and for colored item names.
export const TYPE_COLOR_OPTIONS: { value: string; label: string; hex: string }[] = [
  { value: 'red', label: '红', hex: '#cf1322' },
  { value: 'blue', label: '蓝', hex: '#1677ff' },
  { value: 'green', label: '绿', hex: '#389e0d' },
  { value: 'yellow', label: '黄', hex: '#d4b106' },
  { value: 'purple', label: '紫', hex: '#722ed1' },
  { value: 'orange', label: '橙', hex: '#d46b08' },
  { value: 'cyan', label: '青', hex: '#08979c' },
]

export const TYPE_COLOR_HEX: Record<string, string> = Object.fromEntries(
  TYPE_COLOR_OPTIONS.map((c) => [c.value, c.hex]),
)

export function typeColorHex(color?: string | null): string | undefined {
  return color ? TYPE_COLOR_HEX[color] : undefined
}

// ---- Orders 列表快照（sessionStorage，用于返回列表时瞬时恢复）----
// key 模式：orders:snapshot:${encodeURIComponent(location.search)}；
// 仅保留当前 searchKey 的一条快照（保存时清掉其它），5 分钟过期即删。
// sessionStorage 不可用（隐私模式等）时全部静默降级为"无快照"，按 URL 正常请求。

const SNAPSHOT_PREFIX = 'orders:snapshot:'
const SNAPSHOT_TTL_MS = 5 * 60 * 1000

export interface OrdersSnapshot {
  /** 当前列表数据（仅保留列表渲染所需的最小字段） */
  items: unknown[]
  pageMeta: { page: number; pageSize: number }
  /** window 滚动位置（桌面端） */
  scrollY: number
  /** .ant-layout-content 滚动位置（移动端） */
  contentY: number
  /** 保存时的 location.search，返回按钮无历史可退时用于恢复筛选 */
  search: string
  ts: number
}

export function ordersSnapshotKey(search: string): string {
  return SNAPSHOT_PREFIX + encodeURIComponent(search)
}

function snapshotKeys(): string[] {
  const keys: string[] = []
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i)
    if (k && k.startsWith(SNAPSHOT_PREFIX)) keys.push(k)
  }
  return keys
}

export function saveOrdersSnapshot(snapshot: OrdersSnapshot): void {
  try {
    // 总量控制：每个 searchKey 只保留一条，保存新快照时清掉其它旧快照
    const keep = ordersSnapshotKey(snapshot.search)
    for (const k of snapshotKeys()) {
      if (k !== keep) sessionStorage.removeItem(k)
    }
    sessionStorage.setItem(keep, JSON.stringify(snapshot))
  } catch {
    // 静默降级
  }
}

export function readOrdersSnapshot(search: string): OrdersSnapshot | null {
  try {
    const key = ordersSnapshotKey(search)
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const snap = JSON.parse(raw) as OrdersSnapshot
    if (!snap || typeof snap.ts !== 'number' || Date.now() - snap.ts > SNAPSHOT_TTL_MS) {
      sessionStorage.removeItem(key) // 过期即删
      return null
    }
    return snap
  } catch {
    return null
  }
}

/** 读取未过期的最新一条快照（详情页无历史可退时用于恢复列表筛选参数） */
export function readLatestOrdersSnapshot(): OrdersSnapshot | null {
  try {
    let best: OrdersSnapshot | null = null
    for (const k of snapshotKeys()) {
      const raw = sessionStorage.getItem(k)
      if (!raw) continue
      try {
        const snap = JSON.parse(raw) as OrdersSnapshot
        if (!snap || typeof snap.ts !== 'number' || Date.now() - snap.ts > SNAPSHOT_TTL_MS) {
          sessionStorage.removeItem(k)
          continue
        }
        if (!best || snap.ts > best.ts) best = snap
      } catch {
        sessionStorage.removeItem(k)
      }
    }
    return best
  } catch {
    return null
  }
}
