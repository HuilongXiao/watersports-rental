import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { useSettings } from '../contexts/SettingsContext'
import {
  buildDailyUrl,
  DEFAULT_LATITUDE,
  DEFAULT_LONGITUDE,
  weatherLabel,
} from '../weather'

// 未来一周天气预报：订单列表为空时替代「暂无数据」展示。
// 坐标与顶部天气卡片一致，取当前 Group 的店铺坐标。

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

interface DailyResponse {
  daily: {
    time: string[]
    weather_code: number[]
    temperature_2m_max: number[]
    temperature_2m_min: number[]
  }
}

const wrapStyle = {
  padding: '24px 8px',
  textAlign: 'center' as const,
  // 内容不可选中
  userSelect: 'none' as const,
}

// 字体样式与 AntD 空状态「暂无数据」保持一致
const textStyle = {
  fontSize: 14,
  lineHeight: 1.9,
  color: 'rgba(0, 0, 0, 0.45)',
}

// 未来 7 天天气当天不会有大变化：按「日期 + 坐标」缓存，
// 同一天内反复切换「预订 / 进行中」tab 时直接复用，不再重复请求。
type Daily = DailyResponse['daily']

const dailyCache = new Map<string, Daily>()
const dailyRequests = new Map<string, Promise<Daily>>()

function cacheKey(latitude: number, longitude: number): string {
  return `${dayjs().format('YYYY-MM-DD')}|${latitude}|${longitude}`
}

function getCached(latitude: number, longitude: number): Daily | null {
  return dailyCache.get(cacheKey(latitude, longitude)) ?? null
}

function fetchDaily(latitude: number, longitude: number): Promise<Daily> {
  const key = cacheKey(latitude, longitude)
  const pending = dailyRequests.get(key)
  if (pending) return pending
  const request = fetch(buildDailyUrl(latitude, longitude, 7))
    .then((res) => {
      if (!res.ok) throw new Error(`天气请求失败：${res.status}`)
      return res.json() as Promise<DailyResponse>
    })
    .then((raw) => {
      dailyCache.set(key, raw.daily)
      dailyRequests.delete(key)
      return raw.daily
    })
    .catch((error) => {
      dailyRequests.delete(key)
      throw error
    })
  dailyRequests.set(key, request)
  return request
}

export default function WeeklyForecast() {
  const { settings } = useSettings()
  const latitude = settings.shop_latitude ?? DEFAULT_LATITUDE
  const longitude = settings.shop_longitude ?? DEFAULT_LONGITUDE

  // 重新挂载（如切换 tab）时优先用当天已缓存的数据，直接展示、不再出现加载态
  const [daily, setDaily] = useState<Daily | null>(() => getCached(latitude, longitude))
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const cached = getCached(latitude, longitude)
    if (cached) {
      setDaily(cached)
      setFailed(false)
      return
    }
    fetchDaily(latitude, longitude)
      .then((data) => {
        if (cancelled) return
        setDaily(data)
        setFailed(false)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [latitude, longitude])

  if (failed) {
    return (
      <div style={wrapStyle}>
        <span style={textStyle}>天气加载失败</span>
      </div>
    )
  }
  if (!daily) {
    return (
      <div style={wrapStyle}>
        <span style={textStyle}>天气加载中…</span>
      </div>
    )
  }

  return (
    <div style={wrapStyle}>
      {/* 整体居中，但每行以「周X，」后的逗号对齐：左段定宽右对齐，右段左对齐 */}
      <div style={{ display: 'inline-block', textAlign: 'left' }}>
        {daily.time.map((date, index) => (
          <div key={date} style={{ ...textStyle, display: 'flex' }}>
            <span style={{ width: 112, textAlign: 'right', whiteSpace: 'nowrap' }}>
              {dayjs(date).format('M月D日')}，{WEEKDAYS[dayjs(date).day()]}，
            </span>
            <span style={{ whiteSpace: 'nowrap' }}>
              {weatherLabel(daily.weather_code[index])}，
              {Math.round(daily.temperature_2m_min[index])}℃~
              {Math.round(daily.temperature_2m_max[index])}℃
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
