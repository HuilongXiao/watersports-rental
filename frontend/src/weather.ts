// 天气相关的公共逻辑：Open-Meteo 免费接口地址拼接、WMO 天气代码映射。
// 坐标取当前 Group 在「店铺设置」中填写的店铺坐标；未填写时用默认值。

export const DEFAULT_LATITUDE = 31.33
export const DEFAULT_LONGITUDE = 121.52

const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast'
const TIMEZONE = 'Asia/Shanghai'

// 顶部天气卡片：当前天气 + 逐小时 + 4 天预报
export function buildWeatherUrl(latitude: number, longitude: number): string {
  return (
    `${FORECAST_BASE}?latitude=${latitude}&longitude=${longitude}` +
    '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m' +
    '&hourly=temperature_2m,precipitation,weather_code' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum' +
    `&timezone=${TIMEZONE}&forecast_days=4`
  )
}

// 订单为空时展示的未来一周预报：只需每日最高/最低气温与天气代码
export function buildDailyUrl(latitude: number, longitude: number, days = 7): string {
  return (
    `${FORECAST_BASE}?latitude=${latitude}&longitude=${longitude}` +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min' +
    `&timezone=${TIMEZONE}&forecast_days=${days}`
  )
}

// WMO 天气代码 → 中文名称
export function weatherLabel(code: number): string {
  if (code === 0) return '晴'
  if (code >= 1 && code <= 3) return '多云'
  if (code === 45 || code === 48) return '雾'
  if (code >= 51 && code <= 57) return '毛毛雨'
  if (code >= 61 && code <= 67) return '雨'
  if (code >= 71 && code <= 77) return '雪'
  if (code >= 80 && code <= 82) return '阵雨'
  if (code === 85 || code === 86) return '阵雪'
  if (code >= 95) return '雷雨'
  return '未知'
}
