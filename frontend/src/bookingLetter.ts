// 预订确认书图片生成：照片为底，白色半透明卡片只落在照片区域（不遮挡下方地图），导出 PNG
import { typeColorHex } from './utils'
import bookingLetterBg from './assets/booking-letter-bg.png'

export interface BookingLetterItem {
  name: string
  quantity: number
  // 船型颜色（catalog 的颜色 key），会转成实际色值
  color?: string | null
  amountFen: number
}

export interface BookingLetterData {
  shopName?: string | null
  shopPhone?: string | null
  shopAddress?: string | null
  wechat: string
  adultCount: number
  childCount: number
  /** 如 2026年11月25日 周三 */
  dateText: string
  /** 如 14:00 */
  timeText: string
  items: BookingLetterItem[]
}

const W = 720
const SCALE = 2
const PAD = 40
// 左右留白
const MARGIN = 56
// 卡片上下内边距（内容较少时卡片仍保持四边等距，内容垂直居中）
const CARD_PAD_Y = 24
// 背景图中「照片」与「地图」的分界线：新底图实测在 750/1106 处
const PHOTO_RATIO = 750 / 1106
const FONT_FAMILY = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif'

const F_SHOP = 19
const F_TITLE = 44
const F_LABEL = 20
const F_VALUE = 23
const F_SECTION = 22
const F_ITEM = 23
const F_FOOT = 19
const F_TIP = 16

function money(fen: number): string {
  const s = (Math.abs(fen) / 100).toFixed(2)
  return `${fen < 0 ? '-' : ''}${s.endsWith('.00') ? s.slice(0, -3) : s}`
}

// 数量转中文：1 → 一，2 → 两，12 → 十二，22 → 二十二
function cnNumber(n: number): string {
  const digits = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九']
  if (n < 10) return digits[n]
  if (n < 20) return `十${n % 10 ? digits[n % 10] : ''}`
  if (n < 100) {
    return `${digits[Math.floor(n / 10)]}十${n % 10 ? digits[n % 10] : ''}`
  }
  return String(n)
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// 按最大宽度折行（中文/英文均按字符折）
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const ch of text) {
    const next = current + ch
    if (ctx.measureText(next).width > maxWidth && current) {
      lines.push(current)
      current = ch
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines
}

// 电话分段美观：11 位手机号写成 176 2148 5829，其他（固话等）原样返回
function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) {
    return `${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}`
  }
  return phone
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('背景图片加载失败'))
    img.src = src
  })
}

export async function renderBookingLetter(data: BookingLetterData): Promise<string> {
  const bg = await loadImage(bookingLetterBg)
  const H = Math.round((W * bg.height) / bg.width)

  const canvas = document.createElement('canvas')
  canvas.width = W * SCALE
  canvas.height = H * SCALE
  const ctx = canvas.getContext('2d')!
  ctx.scale(SCALE, SCALE)

  // 照片铺满（cover）
  const coverScale = Math.max(W / bg.width, H / bg.height)
  const drawW = bg.width * coverScale
  const drawH = bg.height * coverScale
  const drawX = (W - drawW) / 2
  const drawY = (H - drawH) / 2
  ctx.drawImage(bg, drawX, drawY, drawW, drawH)

  // 照片区域底部（下方是地图，不允许被卡片遮挡）
  const photoBottom = H * PHOTO_RATIO

  const cardX = MARGIN
  const cardW = W - MARGIN * 2
  const innerW = cardW - PAD * 2

  // 信息行
  const infoRows: [string, string][] = []
  infoRows.push(['微信昵称', data.wechat || '—'])
  infoRows.push([
    '人数',
    data.childCount > 0
      ? `成人 ${data.adultCount} 人 / 儿童 ${data.childCount} 人`
      : `成人 ${data.adultCount} 人`,
  ])
  infoRows.push(['日期', data.dateText])
  infoRows.push(['时间', data.timeText])

  // 底部文字折行测量
  const measure = document.createElement('canvas').getContext('2d')!
  const footerLines: string[] = []
  if (data.shopPhone) footerLines.push(`联系电话：${formatPhone(data.shopPhone)}`)
  if (data.shopAddress) {
    measure.font = `400 ${F_FOOT}px ${FONT_FAMILY}`
    footerLines.push(...wrapLines(measure, `店铺地址：${data.shopAddress}`, innerW - 16))
  }
  const tipText = '温馨提示：如需取消或改期，请提前联系我们。'
  measure.font = `400 ${F_TIP}px ${FONT_FAMILY}`
  const tipLines = wrapLines(measure, tipText, innerW - 16)
  const hasFooter = footerLines.length > 0

  // 内容总高度（与下方绘制步长严格一致）
  const footerH = hasFooter ? 34 + footerLines.length * 32 + tipLines.length * 24 : 0
  const contentHeight =
    (data.shopName ? 34 : 0) +
    78 + // 标题 + 下划线
    infoRows.length * 50 +
    20 +
    34 + // 「预订项目」
    data.items.length * 56 +
    (hasFooter ? 20 + footerH : 0)

  // 卡片四边与照片边缘等距：左右为 MARGIN，上下也取 MARGIN；
  // 内容更多时卡片向下扩展，但始终不越过照片区底部（不遮挡地图）
  const cardH = Math.max(photoBottom - MARGIN * 2, contentHeight + CARD_PAD_Y * 2)
  const cardY = Math.max(12, (photoBottom - cardH) / 2)

  // 内容在卡片内垂直居中
  let y = cardY + (cardH - contentHeight) / 2

  // 卡片内部磨砂：裁切区域内绘制模糊照片
  ctx.save()
  roundRect(ctx, cardX, cardY, cardW, cardH, 26)
  ctx.clip()
  ctx.filter = 'blur(18px)'
  ctx.drawImage(bg, drawX - 10, drawY - 10, drawW + 20, drawH + 20)
  ctx.filter = 'none'
  ctx.restore()

  // 白色半透明地板 + 投影
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.34)'
  ctx.shadowBlur = 34
  ctx.shadowOffsetY = 12
  ctx.fillStyle = 'rgba(255, 255, 255, 0.82)'
  roundRect(ctx, cardX, cardY, cardW, cardH, 26)
  ctx.fill()
  ctx.restore()

  // 卡片描边
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)'
  ctx.lineWidth = 1.5
  roundRect(ctx, cardX, cardY, cardW, cardH, 26)
  ctx.stroke()

  ctx.textAlign = 'center'

  // 店名
  if (data.shopName) {
    ctx.fillStyle = '#6b6b6b'
    ctx.font = `400 ${F_SHOP}px ${FONT_FAMILY}`
    ctx.fillText(data.shopName, W / 2, y + 18)
    y += 34
  }

  // 标题
  ctx.fillStyle = '#1f1f1f'
  ctx.font = `700 ${F_TITLE}px ${FONT_FAMILY}`
  ctx.fillText('预订确认书', W / 2, y + 38)
  y += 50

  // 标题下装饰短线
  ctx.fillStyle = '#1677ff'
  roundRect(ctx, W / 2 - 30, y, 60, 4, 2)
  ctx.fill()
  y += 28

  // 订单信息
  ctx.textAlign = 'left'
  for (const [label, value] of infoRows) {
    ctx.fillStyle = '#7a7a7a'
    ctx.font = `400 ${F_LABEL}px ${FONT_FAMILY}`
    ctx.fillText(label, cardX + PAD, y + 22)
    ctx.fillStyle = '#1f1f1f'
    ctx.font = `500 ${F_VALUE}px ${FONT_FAMILY}`
    ctx.fillText(value, cardX + PAD + 130, y + 23)
    y += 50
  }

  y += 20

  // 预订项目标题
  ctx.fillStyle = '#1f1f1f'
  ctx.font = `600 ${F_SECTION}px ${FONT_FAMILY}`
  ctx.fillText('预订项目', cardX + PAD, y + 23)
  y += 34

  // 项目行
  for (const item of data.items) {
    const color = typeColorHex(item.color) ?? '#1677ff'
    ctx.beginPath()
    ctx.fillStyle = color
    ctx.arc(cardX + PAD + 6, y + 28, 6, 0, Math.PI * 2)
    ctx.fill()

    // 三栏对齐：名称靠左、数量居中、金额靠右
    ctx.textAlign = 'left'
    ctx.fillStyle = color
    ctx.font = `600 ${F_ITEM}px ${FONT_FAMILY}`
    ctx.fillText(item.name, cardX + PAD + 26, y + 34)

    ctx.fillStyle = '#1f1f1f'
    ctx.font = `500 ${F_ITEM}px ${FONT_FAMILY}`
    ctx.textAlign = 'center'
    ctx.fillText(`${cnNumber(item.quantity)}条`, W / 2, y + 34)

    ctx.textAlign = 'right'
    ctx.fillText(`${money(item.amountFen)}元`, W - MARGIN - PAD, y + 34)
    ctx.textAlign = 'left'

    y += 56
    ctx.strokeStyle = 'rgba(140, 140, 140, 0.22)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(cardX + PAD, y - 14)
    ctx.lineTo(W - MARGIN - PAD, y - 14)
    ctx.stroke()
  }

  // 门店信息与提示
  if (hasFooter) {
    y += 20
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)'
    roundRect(ctx, cardX + PAD - 10, y, innerW + 20, footerH, 12)
    ctx.fill()

    let fy = y + 22
    ctx.textAlign = 'left'
    for (let i = 0; i < footerLines.length; i += 1) {
      ctx.fillStyle = '#4d4d4d'
      ctx.font = `400 ${F_FOOT}px ${FONT_FAMILY}`
      ctx.fillText(footerLines[i], cardX + PAD, fy + 12)
      fy += 32
    }
    ctx.fillStyle = '#6f6f6f'
    ctx.font = `400 ${F_TIP}px ${FONT_FAMILY}`
    for (const line of tipLines) {
      ctx.fillText(line, cardX + PAD, fy + 12)
      fy += 24
    }
  }

  return canvas.toDataURL('image/png')
}
