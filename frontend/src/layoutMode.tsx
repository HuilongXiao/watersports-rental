import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Grid } from 'antd'

export type LayoutMode = 'mobile' | 'desktop'

interface LayoutModeContextValue {
  mode: LayoutMode
  isMobile: boolean
  isDesktop: boolean
  toggle: () => void
}

const LayoutModeContext = createContext<LayoutModeContextValue | null>(null)

export function LayoutModeProvider({ children }: { children: ReactNode }) {
  const screens = Grid.useBreakpoint()
  // 会话内手动覆盖，仅存于内存：刷新页面即失效，重新按宽度推导。
  const [override, setOverride] = useState<LayoutMode | null>(null)

  const mode: LayoutMode = override ?? (screens.md ? 'desktop' : 'mobile')

  const toggle = () => {
    setOverride(mode === 'mobile' ? 'desktop' : 'mobile')
  }

  useEffect(() => {
    const body = document.body
    body.classList.add(mode === 'mobile' ? 'layout-mobile' : 'layout-desktop')
    body.classList.remove(mode === 'mobile' ? 'layout-desktop' : 'layout-mobile')
  }, [mode])

  return (
    <LayoutModeContext.Provider
      value={{ mode, isMobile: mode === 'mobile', isDesktop: mode === 'desktop', toggle }}
    >
      {children}
    </LayoutModeContext.Provider>
  )
}

export function useLayoutMode(): LayoutModeContextValue {
  const ctx = useContext(LayoutModeContext)
  if (!ctx) {
    throw new Error('useLayoutMode 必须在 LayoutModeProvider 内使用')
  }
  return ctx
}
