import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  App,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Popover,
  Select,
  Space,
  Table,
  Tag,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { FilterOutlined, UserOutlined } from '@ant-design/icons'
import { api } from '../api'
import type { Customer } from '../types'
import { fenToYuan } from '../utils'
import { useLayoutMode } from '../layoutMode'

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
  disabled,
}: {
  value?: string | null
  onChange?: (value: string | null) => void
  disabled?: boolean
}) {
  return (
    <Space>
      <Checkbox
        checked={value === '先生'}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked ? '先生' : null)}
      >
        <UserOutlined style={{ color: '#1677ff', marginRight: 4 }} />
        先生
      </Checkbox>
      <Checkbox
        checked={value === '女士'}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked ? '女士' : null)}
      >
        <UserOutlined style={{ color: '#f5222d', marginRight: 4 }} />
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
  const { isMobile } = useLayoutMode()
  // 网页版筛选：客户状态 / 有备注 / 累计消费、完成订单数阈值
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive'>('all')
  const [filterHasNote, setFilterHasNote] = useState(false)
  const [filterMinSpending, setFilterMinSpending] = useState<number | null>(null)
  const [filterMinCompleted, setFilterMinCompleted] = useState<number | null>(null)

  const resetFilters = () => {
    setFilterStatus('all')
    setFilterHasNote(false)
    setFilterMinSpending(null)
    setFilterMinCompleted(null)
  }

  const load = async (q = '') => {
    setLoading(true)
    try {
      const list = await api.get<Customer[]>(`/api/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      list.sort((a, b) => {
        // 系统客户（游客）排在列表最后
        if (a.is_system) return 1
        if (b.is_system) return -1
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

  // 列表展示：性别、微信昵称、姓名共享剩余宽度；订单总数（最多 3 位数）、消费总额（最多 5 位数）固定窄列
  // 单元格与表头均单行展示，超出宽度用省略号截断
  const columns: ColumnsType<Customer> = [
    {
      title: '性别',
      dataIndex: 'gender',
      // 固定为展示一个图标 + 表头的必要宽度
      width: 64,
      align: 'center',
      ellipsis: true,
      onHeaderCell: centerHeader,
      render: (g: string | null) => (
        <UserOutlined
          style={{ color: g ? (g === '女士' ? '#f5222d' : '#1677ff') : '#bfbfbf' }}
        />
      ),
    },
    {
      title: '微信昵称',
      dataIndex: 'wechat_nickname',
      ellipsis: true,
      onHeaderCell: centerHeader,
      render: (value, record) => (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {value || '—'}
          </span>
          {record.is_system ? <Tag color="gold" style={{ flexShrink: 0 }}>系统</Tag> : null}
          {record.is_active === false ? <Tag color="default" style={{ flexShrink: 0 }}>已停用</Tag> : null}
        </div>
      ),
    },
    {
      title: '姓名',
      dataIndex: 'name',
      ellipsis: true,
      onHeaderCell: centerHeader,
      render: (v) => v || '—',
    },
    {
      title: '订单总数',
      dataIndex: 'total_orders',
      // 网页版留足表头完整展示的宽度，手机版保持 88px 窄列
      width: isMobile ? 88 : 100,
      align: 'center',
      ellipsis: true,
      onHeaderCell: centerHeader,
      render: (v: number | undefined) => v ?? 0,
    },
    {
      title: '消费总额',
      dataIndex: 'total_spending_fen',
      width: 110,
      align: 'center',
      ellipsis: true,
      onHeaderCell: centerHeader,
      render: (v: number | undefined) => `¥${fenToYuan(v ?? 0)}`,
    },
  ]

  // 网页版在「姓名」后插入「手机号」列，并在「订单总数」后插入完成/爽约统计；手机版保持原列不变
  if (!isMobile) {
    columns.splice(2, 0, {
      title: '手机号',
      dataIndex: 'phone',
      ellipsis: true,
      onHeaderCell: centerHeader,
      render: (v: string | null) => v || '—',
    })
    columns.splice(5, 0,
      {
        title: '完成订单数',
        dataIndex: 'completed_orders',
        width: 108,
        align: 'center',
        ellipsis: true,
        onHeaderCell: centerHeader,
        render: (v: number | undefined) => v ?? 0,
      },
      {
        title: '爽约次数',
        dataIndex: 'no_show_orders',
        width: 96,
        align: 'center',
        ellipsis: true,
        onHeaderCell: centerHeader,
        render: (v: number | undefined) => v ?? 0,
      },
    )
  }

  // 筛选后的列表：数据本身已含备注与统计字段，直接前端过滤
  const filteredCustomers = customers.filter((c) => {
    if (filterStatus === 'active' && c.is_active === false) return false
    if (filterStatus === 'inactive' && c.is_active !== false) return false
    if (filterHasNote && !c.note?.trim()) return false
    if (filterMinSpending !== null && (c.total_spending_fen ?? 0) <= filterMinSpending * 100)
      return false
    if (filterMinCompleted !== null && (c.completed_orders ?? 0) <= filterMinCompleted) return false
    return true
  })

  const filterContent = (
    <div style={{ width: 260 }}>
      <Space direction="vertical" size={12} style={{ display: 'flex' }}>
        <div>
          <div style={{ marginBottom: 4, color: '#666' }}>客户状态</div>
          <Select
            style={{ width: '100%' }}
            value={filterStatus}
            onChange={(v) => setFilterStatus(v)}
            options={[
              { value: 'all', label: '全部' },
              { value: 'active', label: '启用' },
              { value: 'inactive', label: '已停用' },
            ]}
          />
        </div>
        <Checkbox checked={filterHasNote} onChange={(e) => setFilterHasNote(e.target.checked)}>
          有备注
        </Checkbox>
        <div>
          <div style={{ marginBottom: 4, color: '#666' }}>累计消费金额超过</div>
          <InputNumber
            style={{ width: '100%' }}
            min={0}
            prefix="¥"
            placeholder="不限"
            value={filterMinSpending}
            onChange={(v) => setFilterMinSpending(v)}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4, color: '#666' }}>完成订单数超过</div>
          <InputNumber
            style={{ width: '100%' }}
            min={0}
            precision={0}
            placeholder="不限"
            value={filterMinCompleted}
            onChange={(v) => setFilterMinCompleted(v)}
          />
        </div>
        <div style={{ textAlign: 'right' }}>
          <Button size="small" onClick={resetFilters}>
            重置
          </Button>
        </div>
      </Space>
    </div>
  )

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
          {/* 网页版筛选：气泡内提供状态/备注/消费与完成订单数条件 */}
          {!isMobile && (
            <Popover
              trigger="click"
              placement="bottomRight"
              open={filterOpen}
              onOpenChange={setFilterOpen}
              content={filterContent}
            >
              <Button icon={<FilterOutlined />}>筛选</Button>
            </Popover>
          )}
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
        dataSource={filteredCustomers}
        tableLayout="fixed"
        pagination={{ pageSize: 20 }}
        onRow={(record) => ({
          onClick: () => navigate(`/customers/${record.id}`),
          style: {
            cursor: 'pointer',
            ...(record.is_active === false ? { color: '#8c8c8c' } : {}),
          },
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
              <Input placeholder="手机号" type="tel" inputMode="tel" />
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
