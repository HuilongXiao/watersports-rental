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
