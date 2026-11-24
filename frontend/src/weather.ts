// 天气相关的公共逻辑：统一请求后端 /api/weather（和风天气代理，密钥不出后端）。
// 坐标取当前 Group 在「店铺设置」中填写的店铺坐标；未填写时用默认值。

export const DEFAULT_LATITUDE = 31.33
export const DEFAULT_LONGITUDE = 121.52

export interface WeatherCurrent {
  temp: number
  feels_like: number
  text: string
  wind_dir: string
  // 和风返回的风力等级为字符串，可能形如「1-3」
  wind_scale: string
}

export interface WeatherHour {
  time: string
  temp: number
  text: string
  // 该小时降水量（mm）
  precip: number
}

export interface WeatherDay {
  date: string
  text: string
  text_night: string
  temp_max: number
  temp_min: number
  precip: number
  // 日出/日落（和风返回 "06:28" / "16:52"，部分接口为 ISO 时间）
  sunrise?: string | null
  sunset?: string | null
}

export interface WeatherSummary {
  current: WeatherCurrent
  hourly: WeatherHour[]
  daily: WeatherDay[]
}

// days 最多 8 天（含今天），订单空状态从中取「明天起 7 天」
export function buildWeatherUrl(latitude: number, longitude: number, days = 8): string {
  return `/api/weather?latitude=${latitude}&longitude=${longitude}&days=${days}`
}

// 白天与夜间天气不同时显示为「多云转小雨」
export function dayLabel(day: WeatherDay): string {
  return day.text_night && day.text_night !== day.text
    ? `${day.text}转${day.text_night}`
    : day.text
}

// 天气请求：8 秒超时，失败后自动重试 1 次
const WEATHER_TIMEOUT_MS = 8000

export async function fetchWeatherJson<T>(url: string): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS)
    try {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) throw new Error(`天气请求失败：${res.status}`)
      return (await res.json()) as T
    } catch (error) {
      lastError = error
    } finally {
      window.clearTimeout(timer)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('天气请求失败')
}
