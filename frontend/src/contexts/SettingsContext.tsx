// 全局系统设置 Context：初始化阶段尽早读取（sessionStorage 缓存优先），
// 后台静默刷新，供 OrderForm 等页面同步读取 fast_customer_mode，避免挂载后
// 等待网络返回造成 UI 抖动。
//
// 回滚方式：删除本文件、移除 main.tsx 中的 <SettingsProvider> 包裹，并把
// OrderForm / CatalogSettings 还原为各自组件内 api.get('/api/settings') 即可。

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import type { AppSettings } from '../types'

const CACHE_KEY = 'app_settings'
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 分钟缓存失效

// 安全默认值：接口失败且无缓存时使用（极速模式关闭 = 完整表单）。
// payment_methods 为空数组 = 功能未启用或降级，UI 不显示支付方式相关控件。
const DEFAULT_SETTINGS: AppSettings = {
  auto_return_after_minutes: 120,
  fast_customer_mode: false,
  updated_at: '',
  payment_methods: [],
  default_payment_method: null,
}

interface SettingsState {
  settings: AppSettings
  loading: boolean
  refresh: () => Promise<void>
}

const SettingsContext = createContext<SettingsState>(null as unknown as SettingsState)

// 缓存按 group 隔离：超级用户切换 activeGroup 后设置可能不同
interface CacheEntry {
  settings: AppSettings
  ts: number
  group_id: string | null
}

function readCache(groupId: string | null): AppSettings | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEntry
    if (Date.now() - entry.ts > CACHE_TTL_MS) return null
    if ((entry.group_id ?? null) !== groupId) return null
    // 兼容旧缓存条目（缺少 payment_methods 字段）：归一化为默认值，避免 undefined
    return {
      ...DEFAULT_SETTINGS,
      ...entry.settings,
      payment_methods: entry.settings.payment_methods ?? [],
    }
  } catch {
    return null
  }
}

function writeCache(settings: AppSettings, groupId: string | null) {
  try {
    const entry: CacheEntry = { settings, ts: Date.now(), group_id: groupId }
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(entry))
  } catch {
    // sessionStorage 不可用（隐私模式等）时静默忽略
  }
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { user, activeGroup } = useAuth()

  // 初始值优先取缓存：命中时 loading=false，页面首帧即可拿到正确设置
  const [settings, setSettings] = useState<AppSettings>(
    () => readCache(activeGroup) ?? DEFAULT_SETTINGS,
  )
  const [loading, setLoading] = useState(() => readCache(activeGroup) === null)

  const fetchSettings = useCallback(async () => {
    // 未登录时 /api/settings 会 401，跳过；登录后由依赖变化触发
    if (!user) return
    setLoading(readCache(activeGroup) === null)
    try {
      const s = await api.get<AppSettings>('/api/settings')
      setSettings(s)
      writeCache(s, activeGroup)
    } catch {
      // 降级：保留当前值（缓存或默认），不阻塞业务
    } finally {
      setLoading(false)
    }
  }, [user, activeGroup])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const refresh = useCallback(async () => {
    await fetchSettings()
  }, [fetchSettings])

  return (
    <SettingsContext.Provider value={{ settings, loading, refresh }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  return useContext(SettingsContext)
}
