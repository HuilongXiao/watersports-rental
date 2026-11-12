import { Button } from 'antd'
import { LeftOutlined } from '@ant-design/icons'

// 浮动返回按钮：固定在左上角，脱离文档流，不占用页面空间、也不影响页面滚动高度。
interface FloatingBackButtonProps {
  onClick: () => void
  ariaLabel?: string
}

export default function FloatingBackButton({
  onClick,
  ariaLabel = '返回',
}: FloatingBackButtonProps) {
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
        left: 4,
        zIndex: 1000,
        width: 30,
        height: 30,
        background: '#fff',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
      }}
    />
  )
}
