import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Divider,
  Form,
  Grid,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { RightOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import { api } from '../api'
import { useAuth } from '../auth'
import { useSettings } from '../contexts/SettingsContext'
import { fenToYuan, typeColorHex, TYPE_COLOR_OPTIONS, yuanToFen } from '../utils'
import type {
  AppSettings,
  Catalog,
  EquipmentSpec,
  EquipmentType,
  InventoryRow,
  PaymentMethod,
  SaleItem,
} from '../types'
import Users from './Users'
import Groups from './Groups'

interface SettingsTabDef {
  key: string
  label: string
  children: ReactNode
}

// 列表价格展示：整元不带小数（￥90），非整元保留两位（￥90.50）
function formatSpecPrice(fen: number): string {
  return `¥${fen % 100 === 0 ? String(fen / 100) : (fen / 100).toFixed(2)}`
}

export default function CatalogSettings() {
  const { user } = useAuth()
  const screens = Grid.useBreakpoint()
  // 手机版“进入子页面”的当前选中项（电脑版不使用）
  const [mobileActive, setMobileActive] = useState<string | null>(null)
  const canManageUsers = Boolean(
    user && (user.role === 'superuser' || user.role === 'admin' || user.permissions.manage_users),
  )
  const canBackup = Boolean(user && user.role === 'superuser')
  const canExport = Boolean(
    user && (user.role === 'superuser' || user.role === 'admin' || user.permissions.export_report),
  )
  const isSuperuser = Boolean(user && user.role === 'superuser')

  const tabs: SettingsTabDef[] = [
    {
      key: 'sale',
      label: '器材售卖',
      children: (
        <Tabs
          items={[
            { key: 'catalog', label: '器材目录', children: <EquipmentTab /> },
            { key: 'items', label: '售卖项目', children: <SaleTab /> },
          ]}
        />
      ),
    },
    { key: 'system', label: '系统设置', children: <SystemTab /> },
    ...(canExport ? [{ key: 'export', label: '数据导出', children: <ExportTab /> }] : []),
    ...(canBackup ? [{ key: 'backup', label: '数据备份', children: <BackupTab /> }] : []),
    ...(canManageUsers
      ? [{ key: 'users', label: '用户管理', children: <Users /> }]
      : []),
    ...(isSuperuser ? [{ key: 'groups', label: 'Group管理', children: <Groups /> }] : []),
  ]

  // 手机版：竖排菜单，点击后进入独立页面编辑
  if (!screens.md) {
    const current = tabs.find((t) => t.key === mobileActive)
    if (current) {
      return (
        <div>
          <Button
            type="link"
            onClick={() => setMobileActive(null)}
            style={{ marginBottom: 12, paddingLeft: 0 }}
          >
            ← 返回设置
          </Button>
          {current.children}
        </div>
      )
    }
    return (
      <Card title="目录与设置">
        <List
          dataSource={tabs}
          renderItem={(item) => (
            <List.Item
              style={{ cursor: 'pointer' }}
              onClick={() => setMobileActive(item.key)}
            >
              <span style={{ fontWeight: 500 }}>{item.label}</span>
              <RightOutlined style={{ color: '#bbb', fontSize: 12 }} />
            </List.Item>
          )}
        />
      </Card>
    )
  }

  // 电脑版：横向 Tabs（保持原样）
  return <Tabs items={tabs} />
}

/* ---------------- Equipment types & specs ---------------- */

function ColorSwatchPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {TYPE_COLOR_OPTIONS.map((c) => (
        <button
          key={c.value}
          type="button"
          onClick={() => onChange(c.value)}
          title={c.label}
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            backgroundColor: c.hex,
            border: value === c.value ? '3px solid #262626' : '2px solid #d9d9d9',
            outline: value === c.value ? `2px solid ${c.hex}` : 'none',
            outlineOffset: 2,
            cursor: 'pointer',
            padding: 0,
          }}
        />
      ))}
    </div>
  )
}

function EquipmentTab() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const { message } = App.useApp()
  const [typeModal, setTypeModal] = useState(false)
  const [specModal, setSpecModal] = useState(false)
  const [editingType, setEditingType] = useState<EquipmentType | null>(null)
  const [editingSpec, setEditingSpec] = useState<EquipmentSpec | null>(null)
  const [typeForm] = Form.useForm<{ name: string; color: string }>()
  const typeColor = Form.useWatch('color', typeForm) ?? 'blue'
  const [specForm] = Form.useForm<{
    equipment_type_id: string
    name: string
    price: number
    capacity: number | null
    is_active: boolean
    quantity: number
  }>()
  // 编辑规格时的库存现状（来自 /api/inventory；未配置过的规格视为 0）
  const [editingOccupied, setEditingOccupied] = useState(0)
  const [editingTotal, setEditingTotal] = useState(0)
  const [inventoryRows, setInventoryRows] = useState<InventoryRow[]>([])

  const load = useCallback(async () => {
    try {
      const [catalogData, invRows] = await Promise.all([
        api.get<Catalog>('/api/catalog'),
        api.get<InventoryRow[]>('/api/inventory'),
      ])
      setCatalog(catalogData)
      setInventoryRows(invRows)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    }
  }, [message])

  useEffect(() => {
    load()
  }, [load])

  const submitType = async () => {
    const values = await typeForm.validateFields()
    try {
      if (editingType) {
        await api.put(`/api/catalog/equipment-types/${editingType.id}`, values)
      } else {
        await api.post('/api/catalog/equipment-types', values)
      }
      message.success('已保存')
      setTypeModal(false)
      load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  const openSpec = (spec: EquipmentSpec | null) => {
    setEditingSpec(spec)
    if (spec) {
      const row = inventoryRows.find((r) => r.equipment_spec_id === spec.id)
      const total = row?.total_quantity ?? 0
      setEditingOccupied(row?.occupied_quantity ?? 0)
      setEditingTotal(total)
      specForm.setFieldsValue({
        equipment_type_id: spec.equipment_type_id,
        name: spec.name,
        price: spec.price / 100,
        capacity: spec.capacity,
        is_active: spec.is_active,
        quantity: total,
      })
    } else {
      specForm.resetFields()
    }
    setSpecModal(true)
  }

  const submitSpec = async () => {
    const values = await specForm.validateFields()
    const body = {
      equipment_type_id: values.equipment_type_id,
      name: values.name,
      price: yuanToFen(values.price),
      capacity: values.capacity === undefined ? null : values.capacity,
      ...(editingSpec ? { is_active: values.is_active ?? true } : {}),
    }
    try {
      if (editingSpec) {
        await api.put(`/api/catalog/equipment-specs/${editingSpec.id}`, body)
        // 数量有变化时同步更新库存配置（后端校验不能低于当前占用）
        if ((values.quantity ?? 0) !== editingTotal) {
          await api.put(`/api/inventory/${editingSpec.id}`, {
            total_quantity: values.quantity ?? 0,
          })
        }
      } else {
        await api.post('/api/catalog/equipment-specs', body)
      }
      message.success('已保存')
      setSpecModal(false)
      load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  const specColumns: ColumnsType<EquipmentSpec> = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (value: string, record) => (
        <span style={{ color: typeColorHex(record.equipment_type_color), fontWeight: 600 }}>
          {value}
        </span>
      ),
    },
    { title: '价格', dataIndex: 'price', align: 'right', render: (v: number) => formatSpecPrice(v) },
    {
      title: '座位数',
      dataIndex: 'capacity',
      width: 90,
      render: (v: number | null) => (v == null ? '不限（桨板）' : `${v} 座`),
    },
    {
      title: '数量',
      width: 110,
      align: 'right',
      render: (_, record) => {
        const row = inventoryRows.find((r) => r.equipment_spec_id === record.id)
        return `${row?.total_quantity ?? 0}`
      },
    },
    {
      title: '状态',
      dataIndex: 'is_active',
      width: 90,
      render: (v: boolean) => (v ? <Tag color="green">启用</Tag> : <Tag>已停用</Tag>),
    },
    {
      key: 'action',
      title: '操作',
      width: 80,
      render: (_, record) => (
        <Button type="link" onClick={() => openSpec(record)}>
          编辑
        </Button>
      ),
    },
  ]

  const tableData = catalog?.equipment ?? []

  return (
    <Card
      title="器材类型与规格"
      extra={
        <Space>
          <Button
            onClick={() => {
              setEditingType(null)
              typeForm.resetFields()
              setTypeModal(true)
            }}
          >
            新建类型
          </Button>
          <Button type="primary" onClick={() => openSpec(null)}>
            新建规格
          </Button>
        </Space>
      }
    >
      <Table rowKey="id" columns={specColumns} dataSource={tableData} pagination={false} />

      <Modal
        title={editingType ? '编辑类型' : '新建类型'}
        open={typeModal}
        onCancel={() => setTypeModal(false)}
        onOk={submitType}
        destroyOnClose
      >
        <Form
          form={typeForm}
          layout="vertical"
          initialValues={{ name: editingType?.name, color: editingType?.color ?? 'blue' }}
        >
          <Form.Item
            label="类型名称"
            name="name"
            rules={[{ required: true, message: '请输入类型名称，如：皮划艇 / 桨板' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item label="颜色" name="color" rules={[{ required: true }]}>
            <ColorSwatchPicker
              value={typeColor}
              onChange={(value) => typeForm.setFieldValue('color', value)}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editingSpec ? '编辑规格' : '新建规格'}
        open={specModal}
        onCancel={() => setSpecModal(false)}
        onOk={submitSpec}
        destroyOnClose
      >
        <Form form={specForm} layout="vertical">
          <Form.Item
            label="器材类型"
            name="equipment_type_id"
            rules={[{ required: true, message: '请选择类型' }]}
          >
            <Select
              placeholder="选择器材类型"
              options={(catalog?.equipment_types ?? []).map((t) => ({ value: t.id, label: t.name }))}
            />
          </Form.Item>
          <Form.Item label="规格名称" name="name" rules={[{ required: true, message: '如：竞速皮划艇（3 座）' }]}>
            <Input />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                label="2 小时价格（元）"
                name="price"
                rules={[{ required: true, message: '请输入价格' }]}
              >
                <InputNumber min={0} precision={2} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="座位数（桨板留空表示不限）" name="capacity">
                <InputNumber min={1} style={{ width: '100%' }} placeholder="不限" />
              </Form.Item>
            </Col>
          </Row>
          {editingSpec && (
            <Form.Item
              label="启用状态"
              name="is_active"
              valuePropName="checked"
              extra="停用后新订单将无法选择该规格；已停用的规格可在此重新启用，历史订单不受影响。"
            >
              <Switch checkedChildren="启用" unCheckedChildren="停用" />
            </Form.Item>
          )}
          {editingSpec && (
            <Form.Item
              label="数量"
              name="quantity"
              rules={[{ required: true, message: '请输入数量' }]}
              extra={
                editingOccupied > 0
                  ? `该规格可投入使用的总数量；当前已占用 ${editingOccupied}（已签到未归还），不能低于该值。`
                  : '该规格可投入使用的总数量。'
              }
            >
              <InputNumber min={editingOccupied} precision={0} style={{ width: '100%' }} addonAfter="件" />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Card>
  )
}

/* ---------------- Sale items ---------------- */

function SaleTab() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const { message } = App.useApp()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<SaleItem | null>(null)
  const [form] = Form.useForm<{ name: string; price: number; is_active: boolean }>()

  const load = useCallback(async () => {
    setCatalog(await api.get<Catalog>('/api/catalog'))
  }, [])

  useEffect(() => {
    load().catch((error) => message.error(error.message))
  }, [load, message])

  const open = (item: SaleItem | null) => {
    setEditing(item)
    if (item) form.setFieldsValue({ name: item.name, price: item.price / 100, is_active: item.is_active })
    else form.resetFields()
    setModalOpen(true)
  }

  const submit = async () => {
    const values = await form.validateFields()
    const body = {
      name: values.name,
      price: yuanToFen(values.price),
      ...(editing ? { is_active: values.is_active ?? true } : {}),
    }
    try {
      if (editing) await api.put(`/api/catalog/sale-items/${editing.id}`, body)
      else await api.post('/api/catalog/sale-items', body)
      message.success('已保存')
      setModalOpen(false)
      load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  return (
    <Card
      title="售卖项目"
      extra={
        <Button type="primary" onClick={() => open(null)}>
          新建售卖项目
        </Button>
      }
    >
      <Table
        rowKey="id"
        dataSource={catalog?.sale_items ?? []}
        pagination={false}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '价格', dataIndex: 'price', align: 'right', render: (v: number) => `¥${fenToYuan(v)}` },
          {
            title: '状态',
            dataIndex: 'is_active',
            render: (v: boolean) => (v ? <Tag color="green">启用</Tag> : <Tag>已停用</Tag>),
          },
          {
            title: '操作',
            render: (_, record) => (
              <Button type="link" onClick={() => open(record)}>
                编辑
              </Button>
            ),
          },
        ]}
      />
      <Modal
        title={editing ? '编辑售卖项目' : '新建售卖项目'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={submit}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item label="名称" name="name" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：防水袋、手机防水套" />
          </Form.Item>
          <Form.Item label="价格（元）" name="price" rules={[{ required: true, message: '请输入价格' }]}>
            <InputNumber min={0} precision={2} style={{ width: '100%' }} />
          </Form.Item>
          {editing && (
            <Form.Item
              label="启用状态"
              name="is_active"
              valuePropName="checked"
              extra="停用后新订单将无法选择该项目；已停用的项目可在此重新启用，历史订单不受影响。"
            >
              <Switch checkedChildren="启用" unCheckedChildren="停用" />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Card>
  )
}

/* ---------------- System settings ---------------- */

// 支付方式管理区（付款方式区域）：新增/编辑/删除/设默认需要
// manage_payment_methods 权限（或 superuser/admin），无权限时只读展示。
function PaymentSection() {
  const { user } = useAuth()
  const { message } = App.useApp()
  const { refresh: refreshGlobalSettings } = useSettings()
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newCode, setNewCode] = useState('')
  const [busy, setBusy] = useState(false)

  const canManage = Boolean(
    user && (user.role === 'superuser' || user.role === 'admin' || user.permissions.manage_payment_methods),
  )

  const load = useCallback(async () => {
    try {
      setMethods(await api.get<PaymentMethod[]>('/api/payment-methods?active_only=true'))
    } catch {
      // 功能未启用/接口异常时静默，不影响其它设置加载
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const afterChange = async () => {
    await load()
    refreshGlobalSettings()
  }

  const addMethod = async () => {
    if (!newName.trim()) {
      message.warning('请输入支付方式名称')
      return
    }
    setBusy(true)
    try {
      await api.post('/api/payment-methods', {
        name: newName.trim(),
        code: newCode.trim() || undefined,
      })
      message.success('支付方式已添加')
      setAddOpen(false)
      setNewName('')
      setNewCode('')
      await afterChange()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '添加失败')
    } finally {
      setBusy(false)
    }
  }

  const setDefault = async (id: number) => {
    setBusy(true)
    try {
      await api.put(`/api/payment-methods/${id}`, { is_default: true })
      message.success('默认支付方式已更新')
      await afterChange()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const renameMethod = (method: PaymentMethod) => {
    let name = method.name
    Modal.confirm({
      title: `重命名 ${method.code}`,
      content: (
        <Input
          defaultValue={method.name}
          onChange={(e) => {
            name = e.target.value
          }}
        />
      ),
      okText: '保存',
      cancelText: '取消',
      onOk: async () => {
        if (!name.trim() || name.trim() === method.name) return
        try {
          await api.put(`/api/payment-methods/${method.id}`, { name: name.trim() })
          message.success('已更新')
          await afterChange()
        } catch (error) {
          message.error(error instanceof Error ? error.message : '更新失败')
        }
      },
    })
  }

  const removeMethod = async (id: number) => {
    try {
      await api.del(`/api/payment-methods/${id}`)
      message.success('支付方式已停用')
      await afterChange()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '停用失败')
    }
  }

  return (
    <>
      <Divider />
      <div style={{ maxWidth: 420 }}>
        <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 8 }}>
          <strong>付款方式</strong>
          {canManage && (
            <Button type="primary" size="small" onClick={() => setAddOpen(true)}>
              + 新增支付方式
            </Button>
          )}
        </Space>
        <List
          size="small"
          bordered
          dataSource={methods}
          locale={{ emptyText: '暂无启用的支付方式' }}
          renderItem={(m) => (
            <List.Item
              actions={
                canManage
                  ? [
                      ...(m.is_default
                        ? []
                        : [
                            <Button key="default" size="small" type="link" disabled={busy} onClick={() => setDefault(m.id)}>
                              设为默认
                            </Button>,
                            <Button key="edit" size="small" type="link" onClick={() => renameMethod(m)}>
                              重命名
                            </Button>,
                            <Popconfirm
                              key="del"
                              title="停用该支付方式？"
                              description="停用为软删除，历史订单仍保留该方式。"
                              onConfirm={() => removeMethod(m.id)}
                            >
                              <Button size="small" type="link" danger>
                                停用
                              </Button>
                            </Popconfirm>,
                          ]),
                    ]
                  : []
              }
            >
              <Space>
                <Radio checked={m.is_default} disabled={!canManage || m.is_default} onClick={() => canManage && !m.is_default && setDefault(m.id)} />
                <span>{m.name}</span>
                <Tag>{m.code}</Tag>
                {m.is_default && <Tag color="blue">默认</Tag>}
              </Space>
            </List.Item>
          )}
        />
      </div>
      <Modal
        title="新增支付方式"
        open={addOpen}
        onOk={addMethod}
        okText="添加"
        cancelText="取消"
        confirmLoading={busy}
        onCancel={() => setAddOpen(false)}
      >
        <Form layout="vertical">
          <Form.Item label="展示名称" required>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如：POS机" />
          </Form.Item>
          <Form.Item label="code（可选，大写字母/数字/下划线，留空自动生成）">
            <Input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="如：POS" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

function SystemTab() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [minutes, setMinutes] = useState(120)
  const [fastMode, setFastMode] = useState(false)
  const [saving, setSaving] = useState(false)
  // 调试上报开关：写入当前浏览器（含 PWA 独立存储）的 localStorage，仅本机生效。
  const [tracingOn, setTracingOn] = useState<boolean>(
    () => localStorage.getItem('enable_tracing') === '1',
  )
  const { message } = App.useApp()
  // 保存成功后刷新全局 SettingsContext（更新缓存，OrderForm 等页面立即生效）
  const { refresh: refreshGlobalSettings } = useSettings()

  const toggleTracing = (on: boolean) => {
    setTracingOn(on)
    if (on) localStorage.setItem('enable_tracing', '1')
    else localStorage.removeItem('enable_tracing')
    message.success(on ? '调试上报已开启' : '调试上报已关闭')
  }

  useEffect(() => {
    api
      .get<AppSettings>('/api/settings')
      .then((data) => {
        setSettings(data)
        setMinutes(data.auto_return_after_minutes)
        setFastMode(data.fast_customer_mode)
      })
      .catch((error) => message.error(error.message))
  }, [message])

  const save = async () => {
    setSaving(true)
    try {
      const result = await api.put<AppSettings>('/api/settings', {
        auto_return_after_minutes: minutes,
        fast_customer_mode: fastMode,
      })
      setSettings(result)
      refreshGlobalSettings()
      message.success('设置已保存')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title="系统设置">
      <Form layout="vertical" style={{ maxWidth: 420 }}>
        <Form.Item
          label="自动归还时限（分钟）"
          extra="客户签到后经过此时长仍未人工归还的订单，将由系统任务自动归还（System User）。默认 120 分钟，修改对新签到的订单生效。"
        >
          <InputNumber
            min={1}
            value={minutes}
            onChange={(value) => setMinutes(value ?? 120)}
            addonAfter="分钟"
          />
        </Form.Item>
        <Form.Item
          label="极速客户模式"
          extra="开启后创建订单时只需填写客户姓名，无需搜索或新建客户。"
        >
          <Switch
            checked={fastMode}
            onChange={setFastMode}
            checkedChildren="开"
            unCheckedChildren="关"
          />
        </Form.Item>
        <Button type="primary" loading={saving} onClick={save}>
          保存设置
        </Button>
        {settings && (
          <p style={{ color: '#999', marginTop: 16 }}>
            最近更新：{new Date(settings.updated_at).toLocaleString('zh-CN')}
          </p>
        )}
      </Form>
      {/* 调试上报开关：写入当前浏览器（含 PWA 独立存储）的 localStorage，
          开启后所有网络请求会附带一条摘要上报到后端 POST /api/_trace，
          NAS 上 ./data/logs/frontend-trace-YYYY-MM-DD.log 按天生成。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, marginBottom: 12, padding: '10px 12px', background: '#fafafa', borderRadius: 6 }}>
        <Switch checked={tracingOn} onChange={toggleTracing} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500 }}>调试上报</div>
          <div style={{ color: '#888', fontSize: 12 }}>
            开启后，本机所有网络请求会将耗时摘要上报到服务器的 trace 日志，便于定位卡顿。
            仅对当前设备/浏览器生效（PWA 与 Safari 存储隔离，需在各自环境内分别开启）。
          </div>
        </div>
      </div>
      {/* 付款区域：功能启用（payment_methods 非空）时显示，以横线与上方隔开 */}
      {(settings?.payment_methods?.length ?? 0) > 0 && <PaymentSection />}
      <Divider />
      <Descriptions size="small" column={1}>
        <Descriptions.Item label="系统版本">v1.1.14</Descriptions.Item>
      </Descriptions>
    </Card>
  )
}

/* ---------------- Data export ---------------- */

function ExportTab() {
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null)
  const [exporting, setExporting] = useState(false)
  const [customerExporting, setCustomerExporting] = useState(false)
  const [orderExporting, setOrderExporting] = useState(false)
  const [customerId, setCustomerId] = useState('')
  const [autoOrders, setAutoOrders] = useState(false)
  const [autoCustomers, setAutoCustomers] = useState(false)
  const { message } = App.useApp()
  const { user } = useAuth()
  const canExport = Boolean(user?.permissions.export_report)
  const isSuperuser = Boolean(user?.role === 'superuser')

  useEffect(() => {
    if (!isSuperuser) return
    api
      .get<{ orders_enabled: boolean; customers_enabled: boolean }>('/api/auto-exports/enabled')
      .then((data) => {
        setAutoOrders(data.orders_enabled)
        setAutoCustomers(data.customers_enabled)
      })
      .catch(() => {})
  }, [isSuperuser])

  const updateAutoExport = async (type: 'orders' | 'customers', enabled: boolean) => {
    const next = {
      orders_enabled: type === 'orders' ? enabled : autoOrders,
      customers_enabled: type === 'customers' ? enabled : autoCustomers,
    }
    try {
      await api.post('/api/auto-exports/enabled', next)
      setAutoOrders(next.orders_enabled)
      setAutoCustomers(next.customers_enabled)
      message.success(enabled ? '已开启数据定期自动导出' : '已关闭数据定期自动导出')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '设置失败')
    }
  }

  const downloadCsv = async (url: string, filename: string) => {
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let detail = '导出失败'
      try { detail = JSON.parse(text).detail ?? detail } catch { /* ignore */ }
      throw new Error(detail)
    }
    const blob = await res.blob()
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(blobUrl)
  }

  const doExport = async () => {
    if (!range) {
      message.warning('请选择时间范围')
      return
    }
    const start = range[0].format('YYYY-MM-DD')
    const end = range[1].format('YYYY-MM-DD')
    setExporting(true)
    try {
      await downloadCsv(
        `/api/reports/orders/export?start=${start}&end=${end}`,
        `orders_${start}_${end}.csv`,
      )
      message.success('导出成功')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <Card title="订单数据导出">
        <Form layout="vertical" style={{ maxWidth: 480 }}>
          <Form.Item label="选择时间范围" required>
            <DatePicker.RangePicker
              value={range}
              onChange={(value) => setRange(value as [Dayjs, Dayjs] | null)}
              allowClear
            />
          </Form.Item>
          <Button type="primary" loading={exporting} onClick={doExport} disabled={!canExport}>
            导出 CSV
          </Button>
          {!canExport && <p style={{ color: '#999', marginTop: 12 }}>当前账号无导出权限。</p>}
          <p style={{ color: '#999', marginTop: 12 }}>
            导出选定时间范围内所有订单的 CSV（每订单按类目拆分为多行，包含使用时间、消费总额、成人、儿童、类目明细等）。文件将下载到本地下载目录，手机浏览器同样可下载。
          </p>
          {isSuperuser && (
            <Form.Item
              label="数据定期自动导出"
              style={{ marginBottom: 0 }}
              extra="开启后每天 00:00（Asia/Shanghai）自动导出过去 24 小时的订单数据为 CSV，仅生成订单文件，保存到服务器 exports 目录。"
            >
              <Switch
                checked={autoOrders}
                onChange={(value) => updateAutoExport('orders', value)}
                checkedChildren="开"
                unCheckedChildren="关"
              />
            </Form.Item>
          )}
        </Form>
      </Card>

      <Card title="客户数据导出" style={{ marginTop: 16 }}>
        <Form layout="vertical" style={{ maxWidth: 480 }}>
          <Form.Item label="全量客户导出">
            <Space>
              <Button
                type="primary"
                loading={customerExporting}
                onClick={async () => {
                  setCustomerExporting(true)
                  try {
                    await downloadCsv('/api/reports/customers/export', 'customers_all.csv')
                    message.success('导出成功')
                  } catch (error) {
                    message.error(error instanceof Error ? error.message : '导出失败')
                  } finally {
                    setCustomerExporting(false)
                  }
                }}
                disabled={!canExport}
              >
                导出全部客户 CSV
              </Button>
            </Space>
          </Form.Item>
          <Form.Item label="按客户ID导出订单">
            <Space>
              <Input
                placeholder="输入客户ID"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                style={{ width: 300 }}
              />
              <Button
                type="primary"
                loading={orderExporting}
                disabled={!canExport || !customerId.trim()}
                onClick={async () => {
                  setOrderExporting(true)
                  try {
                    await downloadCsv(
                      `/api/reports/customers/${customerId.trim()}/orders/export`,
                      `customer_${customerId.trim()}_orders.csv`,
                    )
                    message.success('导出成功')
                  } catch (error) {
                    message.error(error instanceof Error ? error.message : '导出失败')
                  } finally {
                    setOrderExporting(false)
                  }
                }}
              >
                导出该客户订单 CSV
              </Button>
            </Space>
          </Form.Item>
          {!canExport && <p style={{ color: '#999' }}>当前账号无导出权限。</p>}
          {isSuperuser && (
            <Form.Item
              label="数据定期自动导出"
              style={{ marginBottom: 0 }}
              extra="开启后每天 00:00（Asia/Shanghai）自动导出全量客户数据为 CSV，仅生成客户文件，保存到服务器 exports 目录。"
            >
              <Switch
                checked={autoCustomers}
                onChange={(value) => updateAutoExport('customers', value)}
                checkedChildren="开"
                unCheckedChildren="关"
              />
            </Form.Item>
          )}
        </Form>
      </Card>
    </>
  )
}

/* ---------------- Database backup / restore ---------------- */

interface BackupFile {
  filename: string
  size_bytes: number
  created_at: string
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function BackupTab() {
  const { message } = App.useApp()
  const [backups, setBackups] = useState<BackupFile[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setBackups(await api.get<BackupFile[]>('/api/backups'))
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    load()
  }, [load])

  const createBackup = async () => {
    setCreating(true)
    try {
      await api.post<{ filename: string }>('/api/backups')
      message.success('备份已创建')
      load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '备份失败')
    } finally {
      setCreating(false)
    }
  }

  const restore = async (filename: string) => {
    try {
      await api.post(`/api/backups/${filename}/restore`)
      message.success('数据库已恢复，建议刷新页面')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '恢复失败')
    }
  }

  const remove = async (filename: string) => {
    try {
      await api.del(`/api/backups/${filename}`)
      message.success('已删除')
      load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败')
    }
  }

  const columns: ColumnsType<BackupFile> = [
    { title: '文件名', dataIndex: 'filename' },
    {
      title: '大小',
      dataIndex: 'size_bytes',
      width: 100,
      render: (v: number) => formatSize(v),
    },
    { title: '创建时间', dataIndex: 'created_at', width: 180 },
    {
      title: '操作',
      width: 220,
      render: (_, record) => (
        <Space>
          <a href={`/api/backups/${record.filename}/download`}>下载</a>
          <Popconfirm
            title="恢复将覆盖当前数据库，确定？"
            onConfirm={() => restore(record.filename)}
          >
            <Button type="link" size="small">
              恢复
            </Button>
          </Popconfirm>
          <Popconfirm title="确定删除此备份？" onConfirm={() => remove(record.filename)}>
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="数据库备份与恢复"
      extra={<Button type="primary" loading={creating} onClick={createBackup}>创建备份</Button>}
    >
      <Table
        rowKey="filename"
        columns={columns}
        dataSource={backups}
        loading={loading}
        pagination={false}
        size="small"
        locale={{ emptyText: '暂无备份文件' }}
      />
      <p style={{ color: '#999', marginTop: 12 }}>
        备份文件存储在服务器 backups 目录。恢复操作会覆盖当前数据库，请谨慎操作。
      </p>
    </Card>
  )
}
