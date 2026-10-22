import { Button, type ButtonProps } from 'antd'
import { useLayoutMode } from '../layoutMode'

export default function LayoutModeSwitch(props: ButtonProps) {
  const { mode, toggle } = useLayoutMode()
  return (
    <Button {...props} onClick={toggle}>
      {mode === 'mobile' ? '切换到桌面版' : '切换到手机版'}
    </Button>
  )
}
