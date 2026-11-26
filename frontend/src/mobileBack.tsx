// 手机版：左缘右滑改为「返回上一层级」，不再执行浏览器历史后退。
// 页面若有内部层级（如设置页的子页面），用 useMobileBack 注册自己的上跳动作；
// 其余页面由 AppLayout 按路由层级自动处理。
import { createContext, useContext, useEffect, useRef } from 'react'

export const MobileBackContext = createContext<((fn: (() => void) | null) => void) | null>(
  null,
)

export function useMobileBack(handler: () => void) {
  const register = useContext(MobileBackContext)
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  useEffect(() => {
    if (!register) return
    register(() => handlerRef.current())
    return () => register(null)
  }, [register])
}
