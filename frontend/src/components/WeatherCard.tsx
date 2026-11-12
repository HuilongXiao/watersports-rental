import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Popover } from 'antd'
import dayjs from 'dayjs'
import { useSettings } from '../contexts/SettingsContext'
import {
  buildWeatherUrl,
  DEFAULT_LATITUDE,
  DEFAULT_LONGITUDE,
  weatherLabel,
} from '../weather'

// 顶部天气信息：数据来自 Open-Meteo 免费接口（无需 API Key）
// 坐标取当前 Group 在「店铺设置」中填写的店铺坐标；未填写时用默认值

interface OpenMeteoResponse {
  current: {
    temperature_2m: number
    apparent_temperature: number
    weather_code: number
    wind_speed_10m: number
    wind_direction_10m: number
  }
  hourly: {
    time: string[]
    temperature_2m: number[]
    precipitation: number[]
    weather_code: number[]
  }
  daily: {
    time: string[]
    weather_code: number[]
    temperature_2m_max: number[]
    temperature_2m_min: number[]
    precipitation_sum: number[]
  }
}

interface HourItem {
  time: string
  temp: number
  precipitation: number
  code: number
}

interface WeatherData {
  currentTemp: number
  currentCode: number
  feelsLike: number
  windSpeed: number
  windDirection: number
  hours: HourItem[]
  // 今日逐小时降水量，用于描述降雨时段
  todayHours: { time: string; precipitation: number }[]
  daily: {
    date: string
    code: number
    max: number
    min: number
    precipitation: number
  }[]
}

// 风向角度 → 方位
function windDirectionLabel(degree: number): string {
  const directions = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
  const index = Math.round(((degree % 360) / 45)) % 8
  return `${directions[index]}风`
}

// 风速（km/h）→ 蒲福风力等级
function windLevel(speed: number): number {
  const thresholds = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118]
  for (let i = 0; i < thresholds.length; i += 1) {
    if (speed < thresholds[i]) return i
  }
  return 12
}

// 降水总量展示：无降水时写“无降水”
function formatPrecipitation(mm: number): string {
  return mm > 0 ? `降水 ${mm.toFixed(1)} mm` : '无降水'
}

// 今日降雨时段：把连续有降水的小时合并成时段，
// 如「14:00–16:00 降水 1.2 mm」，多个时段用「；」连接
function rainIntervals(hours: { time: string; precipitation: number }[]): string[] {
  const parts: string[] = []
  let start = -1
  let total = 0

  hours.forEach((hour, index) => {
    const raining = hour.precipitation > 0
    if (raining) {
      if (start < 0) {
        start = index
        total = 0
      }
      total += hour.precipitation
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

function parseWeather(raw: OpenMeteoResponse): WeatherData {
  // 找到当前时间所在的整点，从该条开始取 4 条
  const nowHour = dayjs().format('YYYY-MM-DDTHH:00')
  let start = raw.hourly.time.findIndex((t) => t >= nowHour)
  if (start < 0) start = 0
  const hours: HourItem[] = raw.hourly.time
    .slice(start, start + 4)
    .map((time, offset) => ({
      time,
      temp: raw.hourly.temperature_2m[start + offset],
      precipitation: raw.hourly.precipitation[start + offset] ?? 0,
      code: raw.hourly.weather_code[start + offset],
    }))

  return {
    currentTemp: raw.current.temperature_2m,
    currentCode: raw.current.weather_code,
    feelsLike: raw.current.apparent_temperature,
    windSpeed: raw.current.wind_speed_10m,
    windDirection: raw.current.wind_direction_10m,
    hours,
    todayHours: raw.hourly.time
      .map((time, index) => ({
        time,
        precipitation: raw.hourly.precipitation[index] ?? 0,
      }))
      .filter((hour) => hour.time.startsWith(dayjs().format('YYYY-MM-DD'))),
    daily: raw.daily.time.map((date, index) => ({
      date,
      code: raw.daily.weather_code[index],
      max: raw.daily.temperature_2m_max[index],
      min: raw.daily.temperature_2m_min[index],
      precipitation: raw.daily.precipitation_sum[index] ?? 0,
    })),
  }
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

export default function WeatherCard() {
  const { settings } = useSettings()
  const [data, setData] = useState<WeatherData | null>(null)
  const [failed, setFailed] = useState(false)
  // 最近一次成功获取的时间，用于判断是否已满 1 小时
  const lastFetchedRef = useRef(0)
  const dataRef = useRef<WeatherData | null>(null)
  dataRef.current = data

  // 坐标来自当前 Group 的店铺设置；切换 Group 或保存新坐标后自动重新请求
  const latitude = settings.shop_latitude ?? DEFAULT_LATITUDE
  const longitude = settings.shop_longitude ?? DEFAULT_LONGITUDE
  const weatherUrl = useMemo(
    () => buildWeatherUrl(latitude, longitude),
    [latitude, longitude],
  )

  const loadWeather = useCallback(async () => {
    try {
      const res = await fetch(weatherUrl)
      if (!res.ok) throw new Error(`天气请求失败：${res.status}`)
      const raw = (await res.json()) as OpenMeteoResponse
      setData(parseWeather(raw))
      setFailed(false)
      lastFetchedRef.current = Date.now()
    } catch {
      // 已有数据时保留旧数据，仅在首次加载失败时显示失败提示
      if (!dataRef.current) setFailed(true)
    }
  }, [weatherUrl])

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
    if (!data || data.hours.length === 0) return ''
    const last = data.hours[data.hours.length - 1]
    const currentLabel = weatherLabel(data.currentCode)
    const lastLabel = weatherLabel(last.code)
    const changed = lastLabel !== currentLabel ? `转${lastLabel}` : ''
    return `${Math.round(data.currentTemp)}℃~${Math.round(last.temp)}℃，${currentLabel}${changed}`
  }, [data])

  if (failed) {
    return <span style={{ ...triggerStyle, color: '#bfbfbf' }}>天气加载失败</span>
  }
  if (!data) {
    return <span style={{ ...triggerStyle, color: '#bfbfbf' }}>天气加载中…</span>
  }

  const hours = data.hours
  const nextHoursTemp =
    hours.length > 0
      ? `${Math.round(data.currentTemp)}℃~${Math.round(hours[hours.length - 1].temp)}℃`
      : '—'
  const nextHoursPrecip = hours.reduce((sum, h) => sum + h.precipitation, 0)
  const nextHoursLabel = hours.length > 0 ? weatherLabel(hours[hours.length - 1].code) : '—'
  const currentLabel = weatherLabel(data.currentCode)

  const today = data.daily[0]
  // 今日降雨时段明细（几点到几点、降水量）
  const todayRain = rainIntervals(data.todayHours)
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
        value={today ? `${Math.round(today.min)}℃~${Math.round(today.max)}℃` : '—'}
      />
      <WeatherRow
        label="天气"
        value={
          today
            ? `${weatherLabel(today.code)}，${
                todayRain.length > 0 ? todayRain.join('；') : '无降水'
              }`
            : '—'
        }
      />
      <WeatherRow label="体感温度" value={`${Math.round(data.feelsLike)}℃`} />
      <WeatherRow
        label="风力"
        value={`${windDirectionLabel(data.windDirection)} ${windLevel(data.windSpeed)} 级`}
      />

      <div style={{ borderTop: '1px solid #f0f0f0', margin: '8px 0' }} />

      <div style={{ fontWeight: 600, marginBottom: 2 }}>未来 3 天</div>
      {nextDays.map((day) => (
        <WeatherRow
          key={day.date}
          label={dayjs(day.date).format('M月D日')}
          value={`${weatherLabel(day.code)} ${Math.round(day.min)}℃~${Math.round(day.max)}℃`}
        />
      ))}

      <div style={{ borderTop: '1px solid #f0f0f0', margin: '8px 0' }} />

      {/* 刷新规则说明 */}
      <div style={{ color: '#8c8c8c', fontSize: 11, lineHeight: 1.6 }}>
        自动刷新：每小时更新一次，20:00–次日 06:00 不自动刷新；页面切回前台时若距上次刷新已超过
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
