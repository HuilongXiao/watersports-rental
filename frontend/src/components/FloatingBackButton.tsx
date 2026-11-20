import { Button, Grid } from 'antd'
import { LeftOutlined } from '@ant-design/icons'
import { useLayoutMode } from '../layoutMode'

// 浮动返回按钮：固定在页面内容区左上角，脱离文档流，不占用页面空间、也不影响页面滚动高度。
interface FloatingBackButtonProps {
  onClick: () => void
  ariaLabel?: string
}

export default function FloatingBackButton({
  onClick,
  ariaLabel = '返回',
}: FloatingBackButtonProps) {
  const { isDesktop } = useLayoutMode()
  const screens = Grid.useBreakpoint()
  // 桌面端侧栏宽 200，按钮放到内容区左侧；侧栏收起（lg 以下）或手机端时贴左边
  const left = isDesktop && screens.lg ? 208 : 4

  return (
    <Button
      shape="circle"
      size="small"
      icon={<LeftOutlined />}
      onClick={onClick}
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        // 顶部导航栏高度 64，再留 6px 间距
        top: 70,
        left,
        zIndex: 1000,
        width: 30,
        height: 30,
        background: '#fff',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
      }}
    />
  )
}
