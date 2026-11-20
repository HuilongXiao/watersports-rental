import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Popover } from 'antd'
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

// 顶部天气信息：数据由后端代理和风天气（JWT 认证），密钥不出后端。
// 坐标取当前 Group 在「店铺设置」中填写的店铺坐标；未填写时用默认值

// 降水总量展示：无降水时写“无降水”
function formatPrecipitation(mm: number): string {
  return mm > 0 ? `降水 ${mm.toFixed(1)} mm` : '无降水'
}

// 今日降雨时段：把连续有降水的小时合并成时段，
// 如「14:00–16:00 降水 1.2 mm」，多个时段用「；」连接
function rainIntervals(hours: { time: string; precip: number }[]): string[] {
  const parts: string[] = []
  let start = -1
  let total = 0

  hours.forEach((hour, index) => {
    const raining = hour.precip > 0
    if (raining) {
      if (start < 0) {
        start = index
        total = 0
      }
      total += hour.precip
    }
    const isLast = index === hours.length - 1
    if (start >= 0 && (!raining || isLast)) {
      // 降雨在无降水的那一小时前结束；若最后一小时仍在降雨则算到下一小时
      const endIndex = raining ? index + 1 : index
      const startText = dayjs(hours[start].time).format('HH:mm')
      const endText =
        endIndex >= hours.length
          ? dayjs(hours[hours.length - 1].time).add(1, 'hour').format('HH:mm')
          : dayjs(hours[endIndex].time).format('HH:mm')
      parts.push(`${startText}–${endText} 降水 ${total.toFixed(1)} mm`)
      start = -1
      total = 0
    }
  })

  return parts
}

// 一行：左侧灰色标签，右侧数值
function WeatherRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: '#8c8c8c' }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{value}</span>
    </div>
  )
}

const triggerStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#333',
  whiteSpace: 'nowrap',
}

// 最近一次成功获取的天气缓存：登录后先用旧数据展示，避免网络抖动时一片空白
const WEATHER_CACHE_KEY = 'weather_cache_v2'
const WEATHER_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000

interface WeatherCacheEntry {
  latitude: number
  longitude: number
  data: WeatherSummary
  ts: number
}

function readWeatherCache(latitude: number, longitude: number): WeatherSummary | null {
  try {
    const raw = localStorage.getItem(WEATHER_CACHE_KEY)
    if (!raw) return null
    const entry = JSON.parse(raw) as WeatherCacheEntry
    if (entry.latitude !== latitude || entry.longitude !== longitude) return null
    if (Date.now() - entry.ts > WEATHER_CACHE_MAX_AGE_MS) return null
    return entry.data
  } catch {
    return null
  }
}

function writeWeatherCache(latitude: number, longitude: number, data: WeatherSummary) {
  try {
    const entry: WeatherCacheEntry = { latitude, longitude, data, ts: Date.now() }
    localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify(entry))
  } catch {
    // localStorage 不可用时静默忽略
  }
}

export default function WeatherCard() {
  const { settings } = useSettings()

  // 坐标来自当前 Group 的店铺设置；切换 Group 或保存新坐标后自动重新请求
  const latitude = settings.shop_latitude ?? DEFAULT_LATITUDE
  const longitude = settings.shop_longitude ?? DEFAULT_LONGITUDE

  const [data, setData] = useState<WeatherSummary | null>(() =>
    readWeatherCache(latitude, longitude),
  )
  const [failed, setFailed] = useState(false)
  // 最近一次成功获取的时间，用于判断是否已满 1 小时
  const lastFetchedRef = useRef(0)
  const dataRef = useRef<WeatherSummary | null>(null)
  dataRef.current = data

  const weatherUrl = useMemo(
    () => buildWeatherUrl(latitude, longitude, 8),
    [latitude, longitude],
  )

  const loadWeather = useCallback(async () => {
    try {
      const summary = await fetchWeatherJson<WeatherSummary>(weatherUrl)
      setData(summary)
      setFailed(false)
      lastFetchedRef.current = Date.now()
      writeWeatherCache(latitude, longitude, summary)
    } catch {
      // 已有数据（含本地缓存）时保留旧数据，仅在完全无数据时显示失败提示
      if (!dataRef.current) setFailed(true)
    }
  }, [weatherUrl, latitude, longitude])

  // 自动刷新：每小时一次；20:00–06:00 不自动刷新；回到前台且已过期时补一次
  useEffect(() => {
    const isQuietHours = () => {
      const hour = dayjs().hour()
      return hour >= 20 || hour < 6
    }
    const refreshIfStale = () => {
      if (isQuietHours()) return
      if (Date.now() - lastFetchedRef.current >= 60 * 60 * 1000) loadWeather()
    }

    loadWeather()
    const timer = window.setInterval(refreshIfStale, 60 * 1000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshIfStale()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadWeather])

  // 顶部摘要：当前温度~4 小时后温度，当前天气[转变化后的天气]
  const summary = useMemo(() => {
    if (!data || data.hourly.length === 0) return ''
    const hours = data.hourly.slice(0, 4)
    const last = hours[hours.length - 1]
    const changed = last.text !== data.current.text ? `转${last.text}` : ''
    return `${Math.round(data.current.temp)}℃~${Math.round(last.temp)}℃，${data.current.text}${changed}`
  }, [data])

  if (failed) {
    return (
      <span
        onClick={() => {
          setFailed(false)
          loadWeather()
        }}
        style={{ ...triggerStyle, color: '#bfbfbf', cursor: 'pointer' }}
      >
        天气加载失败，点击重试
      </span>
    )
  }
  if (!data) {
    return <span style={{ ...triggerStyle, color: '#bfbfbf' }}>天气加载中…</span>
  }

  // 和风逐小时数据从当前整点开始，取前 4 条即「未来 4 小时」
  const hours = data.hourly.slice(0, 4)
  const nextHoursTemp =
    hours.length > 0
      ? `${Math.round(data.current.temp)}℃~${Math.round(hours[hours.length - 1].temp)}℃`
      : '—'
  const nextHoursPrecip = hours.reduce((sum, h) => sum + h.precip, 0)
  const nextHoursLabel = hours.length > 0 ? hours[hours.length - 1].text : '—'
  const currentLabel = data.current.text

  const today: WeatherDay | undefined = data.daily[0]
  // 今日降雨时段明细：只统计当前小时及之后（已过去的时段不再显示）
  const nowHour = dayjs().startOf('hour')
  const todayRain = rainIntervals(
    data.hourly.filter((h) => !dayjs(h.time).isBefore(nowHour)),
  )
  const nextDays = data.daily.slice(1, 4)

  const content = (
    <div style={{ width: 240, fontSize: 12, lineHeight: 1.75, color: '#333' }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>未来 4 小时</div>
      <WeatherRow label="气温" value={nextHoursTemp} />
      <WeatherRow
        label="天气"
        value={`${currentLabel}${nextHoursLabel !== currentLabel ? `转${nextHoursLabel}` : ''}，${formatPrecipitation(nextHoursPrecip)}`}
      />

      <div style={{ borderTop: '1px solid #f0f0f0', margin: '8px 0' }} />

      <div style={{ fontWeight: 600, marginBottom: 2 }}>今日天气</div>
      <WeatherRow
        label="气温"
        value={today ? `${Math.round(today.temp_min)}℃~${Math.round(today.temp_max)}℃` : '—'}
      />
      <WeatherRow
        label="天气"
        value={
          today
            ? `${today.text_night && today.text_night !== today.text ? `${today.text}转${today.text_night}` : today.text}，${
                todayRain.length > 0 ? todayRain.join('；') : '无降水'
              }`
            : '—'
        }
      />
      <WeatherRow label="体感温度" value={`${Math.round(data.current.feels_like)}℃`} />
      <WeatherRow
        label="风力"
        value={`${data.current.wind_dir} ${data.current.wind_scale} 级`}
      />

      <div style={{ borderTop: '1px solid #f0f0f0', margin: '8px 0' }} />

      <div style={{ fontWeight: 600, marginBottom: 2 }}>未来 3 天</div>
      {nextDays.map((day) => (
        <WeatherRow
          key={day.date}
          label={dayjs(day.date).format('M月D日')}
          value={`${day.text} ${Math.round(day.temp_min)}℃~${Math.round(day.temp_max)}℃`}
        />
      ))}

      <div style={{ borderTop: '1px solid #f0f0f0', margin: '8px 0' }} />

      {/* 刷新规则说明 */}
      <div style={{ color: '#8c8c8c', fontSize: 11, lineHeight: 1.6 }}>
        自动刷新：每小时更新一次，20:00至次日 06:00 不自动刷新；页面切回前台时若距上次刷新已超过
        1 小时也会补刷。每次点击展开本气泡都会立即刷新一次（不受夜间限制）。
      </div>
    </div>
  )

  return (
    <Popover
      content={content}
      title={null}
      trigger="click"
      placement="bottom"
      // 每次点开气泡都刷新一次（不受夜间免刷新限制）
      onOpenChange={(open) => {
        if (open) loadWeather()
      }}
    >
      <span
        style={{
          ...triggerStyle,
          cursor: 'pointer',
          borderBottom: '1px dashed #d9d9d9',
        }}
      >
        {summary}
      </span>
    </Popover>
  )
}
