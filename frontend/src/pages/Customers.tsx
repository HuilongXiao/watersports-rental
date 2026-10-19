import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  App,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Space,
  Table,
  Tag,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { api } from '../api'
import type { Customer } from '../types'
import { fenToYuan } from '../utils'

interface FormValues {
  name?: string
  gender?: string
  phone?: string
  wechat_nickname?: string
  wechat_id?: string
}

const EMPTY_VALUES: FormValues = {
  name: '',
  gender: undefined,
  phone: '',
  wechat_nickname: '',
  wechat_id: '',
}

export function GenderCheckboxes({
  value,
  onChange,
}: {
  value?: string | null
  onChange?: (value: string | null) => void
}) {
  return (
    <Space>
      <Checkbox
        checked={value === '先生'}
        onChange={(e) => onChange?.(e.target.checked ? '先生' : null)}
      >
        先生
      </Checkbox>
      <Checkbox
        checked={value === '女士'}
        onChange={(e) => onChange?.(e.target.checked ? '女士' : null)}
      >
        女士
      </Checkbox>
    </Space>
  )
}

export default function Customers() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [form] = Form.useForm<FormValues>()
  const { message } = App.useApp()
  const navigate = useNavigate()

  const load = async (q = '') => {
    setLoading(true)
    try {
      const list = await api.get<Customer[]>(`/api/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      list.sort((a, b) => {
        if (a.is_system) return -1
        if (b.is_system) return 1
        return 0
      })
      setCustomers(list)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const openCreate = () => {
    form.setFieldsValue(EMPTY_VALUES)
    setModalOpen(true)
  }

  const onSubmit = async () => {
    const values = await form.validateFields()
    const body = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, value?.trim() ? value.trim() : null]),
    )
    if (!body.name && !body.wechat_nickname) {
      message.warning('请至少填写姓名或微信昵称')
      return
    }
    try {
      await api.post('/api/customers', body)
      message.success('客户已创建')
      setModalOpen(false)
      load(keyword)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  const centerHeader = () => ({ style: { textAlign: 'center' as const } })

  // 列表展示：微信昵称、姓名共享剩余宽度；订单总数（最多 3 位数）、消费总额（最多 5 位数）固定窄列
  const columns: ColumnsType<Customer> = [
    {
      title: '微信昵称',
      dataIndex: 'wechat_nickname',
      onHeaderCell: centerHeader,
      render: (value, record) => (
        <Space>
          {value || '—'}
          {record.is_system ? <Tag color="gold">系统</Tag> : null}
        </Space>
      ),
    },
    {
      title: '姓名',
      dataIndex: 'name',
      onHeaderCell: centerHeader,
      render: (v) => v || '—',
    },
    {
      title: '订单总数',
      dataIndex: 'total_orders',
      width: 88,
      align: 'center',
      onHeaderCell: centerHeader,
      render: (v: number | undefined) => v ?? 0,
    },
    {
      title: '消费总额',
      dataIndex: 'total_spending_fen',
      width: 110,
      align: 'center',
      onHeaderCell: centerHeader,
      render: (v: number | undefined) => `¥${fenToYuan(v ?? 0)}`,
    },
  ]

  return (
    <Card
      title="客户管理"
      extra={
        <Space>
          <Input.Search
            placeholder="姓名 / 手机 / 微信搜索"
            allowClear
            onSearch={(value) => {
              setKeyword(value)
              load(value)
            }}
            style={{ width: 240 }}
          />
          <Button type="primary" onClick={openCreate}>
            新建客户
          </Button>
        </Space>
      }
    >
      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={customers}
        pagination={{ pageSize: 20 }}
        onRow={(record) => ({
          onClick: () => navigate(`/customers/${record.id}`),
          style: { cursor: 'pointer' },
        })}
      />

      <Modal
        title="新建客户"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={onSubmit}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item label="姓名">
            <Form.Item name="name" noStyle>
              <Input placeholder="客户姓名" />
            </Form.Item>
          </Form.Item>
          <Form.Item label="手机号">
            <Form.Item name="phone" noStyle>
              <Input placeholder="手机号" />
            </Form.Item>
          </Form.Item>
          <Form.Item label="性别" name="gender">
            <GenderCheckboxes />
          </Form.Item>
          <Form.Item label="微信昵称" name="wechat_nickname">
            <Input placeholder="微信昵称" />
          </Form.Item>
          <Form.Item label="微信ID" name="wechat_id">
            <Input placeholder="微信ID" />
          </Form.Item>
          <p style={{ color: '#999', marginBottom: 0 }}>
            至少填写姓名或微信昵称中的一项即可保存；手机号、微信ID可选填。
          </p>
        </Form>
      </Modal>
    </Card>
  )
}
