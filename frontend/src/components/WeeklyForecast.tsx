import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { useSettings } from '../contexts/SettingsContext'
import {
  buildWeatherUrl,
  DEFAULT_LATITUDE,
  DEFAULT_LONGITUDE,
  fetchWeatherJson,
  type WeatherDay,
  type WeatherSummary,
} from '../weather'

// 未来一周天气预报：订单列表为空时替代「暂无数据」展示。
// 坐标与顶部天气卡片一致，取当前 Group 的店铺坐标。

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

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
const dailyCache = new Map<string, WeatherDay[]>()
const dailyRequests = new Map<string, Promise<WeatherDay[]>>()

function cacheKey(latitude: number, longitude: number): string {
  return `${dayjs().format('YYYY-MM-DD')}|${latitude}|${longitude}`
}

function getCached(latitude: number, longitude: number): WeatherDay[] | null {
  return dailyCache.get(cacheKey(latitude, longitude)) ?? null
}

function fetchDaily(latitude: number, longitude: number): Promise<WeatherDay[]> {
  const key = cacheKey(latitude, longitude)
  const pending = dailyRequests.get(key)
  if (pending) return pending
  const request = fetchWeatherJson<WeatherSummary>(buildWeatherUrl(latitude, longitude, 8))
    .then((summary) => {
      dailyCache.set(key, summary.daily)
      dailyRequests.delete(key)
      return summary.daily
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
  const [daily, setDaily] = useState<WeatherDay[] | null>(() =>
    getCached(latitude, longitude),
  )
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
        {/* 从明天开始展示 7 天（跳过今天） */}
        {daily.slice(1, 8).map((day) => (
          <div key={day.date} style={{ ...textStyle, display: 'flex' }}>
            <span style={{ width: 112, textAlign: 'right', whiteSpace: 'nowrap' }}>
              {dayjs(day.date).format('M月D日')}，{WEEKDAYS[dayjs(day.date).day()]}，
            </span>
            <span style={{ whiteSpace: 'nowrap' }}>
              {day.text}，{Math.round(day.temp_min)}℃~{Math.round(day.temp_max)}℃
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
