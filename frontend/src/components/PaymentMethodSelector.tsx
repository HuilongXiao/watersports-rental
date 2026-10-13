// 支付方式选择器：懒加载组件（React.lazy 导入），仅在编辑订单时按需加载。
// 从 SettingsContext 读取 payment_methods 列表，Radio.Group 选择后通过 onChange 回调。
// 回滚：删除本文件，移除 OrderForm/OrderDetail 中的 React.lazy 导入与 <PaymentMethodSelector /> 使用。

import { Radio, Space, Tag } from 'antd'
import { useSettings } from '../contexts/SettingsContext'
import type { PaymentMethod } from '../types'

interface Props {
  value?: string | null
  onChange: (code: string | null) => void
}

export default function PaymentMethodSelector({ value, onChange }: Props) {
  const { settings } = useSettings()
  const methods = settings.payment_methods ?? []

  if (methods.length === 0) {
    return <span style={{ color: '#999' }}>暂无启用的支付方式</span>
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Radio.Group
        value={value ?? undefined}
        onChange={(e) => onChange(e.target.value ?? null)}
      >
        <Space direction="vertical">
          {methods.map((m: PaymentMethod) => (
            <Radio key={m.code} value={m.code}>
              <Space>
                <span>{m.name}</span>
                <Tag>{m.code}</Tag>
                {m.is_default && <Tag color="blue">默认</Tag>}
              </Space>
            </Radio>
          ))}
        </Space>
      </Radio.Group>
      <div style={{ color: '#999', fontSize: 12 }}>
        选择订单的支付方式，留空表示未指定
      </div>
    </Space>
  )
}
