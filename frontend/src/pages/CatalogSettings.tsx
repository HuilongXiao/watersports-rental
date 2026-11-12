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
import { useLayoutMode } from '../layoutMode'
import LayoutModeSwitch from '../components/LayoutModeSwitch'
import FloatingBackButton from '../components/FloatingBackButton'
import { fenToYuan, formatDateTime, typeColorHex, TYPE_COLOR_OPTIONS, yuanToFen } from '../utils'
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
  label: ReactNode
  children: ReactNode
}

// 列表价格展示：整元不带小数（￥90），非整元保留两位（￥90.50）
function formatSpecPrice(fen: number): string {
  return `¥${fen % 100 === 0 ? String(fen / 100) : (fen / 100).toFixed(2)}`
}

export default function CatalogSettings() {
  const { user } = useAuth()
  const { isMobile } = useLayoutMode()
  // 手机版“进入子页面”的当前选中项（电脑版不使用）
  const [mobileActive, setMobileActive] = useState<string | null>(null)
  const canManageUsers = Boolean(
    user && (user.role === 'superuser' || user.role === 'admin'),
  )
  const canBackup = Boolean(user && user.role === 'superuser')
  const canExport = Boolean(
    user && (user.role === 'superuser' || user.role === 'admin' || user.permissions.export_report),
  )
  const isSuperuser = Boolean(user && user.role === 'superuser')
  // 配置类入口（器材目录/系统设置）仅管理员与超级管理员可见
  const isAdmin = Boolean(user && (user.role === 'superuser' || user.role === 'admin'))

  // 器材目录待完善项（编号未完成 / 数量未填写）时，在「器材目录」入口显示红色感叹号
  const [numberingAllComplete, setNumberingAllComplete] = useState(true)
  const [quantityAllComplete, setQuantityAllComplete] = useState(true)
  const refreshNumbering = useCallback(async () => {
    try {
      const [numbering, inventory, catalogData] = await Promise.all([
        api.get<{ all_complete: boolean }>('/api/boats/numbering'),
        api.get<InventoryRow[]>('/api/inventory'),
        api.get<Catalog>('/api/catalog'),
      ])
      setNumberingAllComplete(numbering.all_complete)
      // 启用中的器材都必须填写数量（0 视为未填写）
      setQuantityAllComplete(
        catalogData.equipment.every(
          (spec) =>
            !spec.is_active ||
            (inventory.find((r) => r.equipment_spec_id === spec.id)?.total_quantity ?? 0) > 0,
        ),
      )
    } catch {
      // 降级：接口失败时不显示提醒，不阻塞页面
    }
  }, [])
  useEffect(() => {
    refreshNumbering()
  }, [refreshNumbering])

  // 店铺管理：店铺设置 + 器材目录 / 类型管理 / 售卖项目
  const storeEntries: SettingsTabDef[] = [
    {
      key: 'store-settings',
      label: '店铺设置',
      children: <StoreTab onNumberingChanged={refreshNumbering} />,
    },
    {
      key: 'catalog',
      label: (
        <span>
          器材目录
          {!(numberingAllComplete && quantityAllComplete) && (
            <span style={{ color: '#ff4d4f', marginLeft: 4 }}>❗</span>
          )}
        </span>
      ),
      children: <EquipmentTab onNumberingChanged={refreshNumbering} />,
    },
    { key: 'types', label: '类型管理', children: <TypeTab /> },
    { key: 'items', label: '售卖项目', children: <SaleTab /> },
  ]

  // 系统设置 - 数据管理：数据导出 + 数据备份合并为一个页面（按权限显示对应卡片）
  const dataManagement = (
    <>
      {canExport && <ExportTab />}
      {canBackup && <BackupTab />}
    </>
  )

  // 系统设置：基础设置 + 数据管理 + 用户管理 + Group 管理
  const systemEntries: SettingsTabDef[] = [
    { key: 'basic', label: '基础设置', children: <BasicTab /> },
    ...(canExport || canBackup
      ? [{ key: 'data', label: '数据管理', children: dataManagement }]
      : []),
    ...(canManageUsers
      ? [{ key: 'users', label: '用户管理', children: <Users /> }]
      : []),
    ...(isSuperuser ? [{ key: 'groups', label: 'Group管理', children: <Groups /> }] : []),
  ]

  // 顶层分为「店铺管理」和「系统设置」两个区域
  const sections: { title: string; entries: SettingsTabDef[] }[] = [
    ...(isAdmin ? [{ title: '店铺管理', entries: storeEntries }] : []),
    { title: '系统设置', entries: systemEntries },
  ]
  const tabs: SettingsTabDef[] = sections.map((section) => ({
    key: section.title,
    label: section.title,
    children: <Tabs items={section.entries} />,
  }))
  const allEntries = sections.flatMap((section) => section.entries)

  // 手机版：竖排菜单，点击后进入独立页面编辑
  if (isMobile) {
    const current = allEntries.find((t) => t.key === mobileActive)
    if (current) {
      return (
        <div>
          <FloatingBackButton onClick={() => setMobileActive(null)} ariaLabel="返回设置" />
          {current.children}
        </div>
      )
    }
    return (
      <div>
        {sections.map((section) => (
          <Card
            key={section.title}
            title={section.title}
            style={{ marginBottom: 16 }}
          >
            <List
              dataSource={section.entries}
              renderItem={(item) => (
                <List.Item
                  style={{ cursor: 'pointer' }}
                  onClick={() => setMobileActive(item.key)}
                >
                  <span style={{ color: '#000' }}>{item.label}</span>
                  <RightOutlined style={{ color: '#bbb', fontSize: 12 }} />
                </List.Item>
              )}
            />
          </Card>
        ))}
      </div>
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

function EquipmentTab({ onNumberingChanged }: { onNumberingChanged?: () => void }) {
  const { isMobile } = useLayoutMode()
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const { message } = App.useApp()
  const [specModal, setSpecModal] = useState(false)
  const [editingSpec, setEditingSpec] = useState<EquipmentSpec | null>(null)
  // 「器材编号」弹窗当前编辑的规格
  const [numberingSpecId, setNumberingSpecId] = useState<string | null>(null)
  const [specForm] = Form.useForm<{
    equipment_type_id: string
    name: string
    price: number
    capacity: number | null
    quantity: number
  }>()
  // 启用状态与器材编号开关都用独立 state 控制，避免与表单绑定冲突
  const [specActive, setSpecActive] = useState(true)
  const [numberingRequired, setNumberingRequired] = useState(true)
  // 是否在概览「船只用量」中展示该器材
  const [showInUsage, setShowInUsage] = useState(true)
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
        quantity: total,
      })
      setSpecActive(spec.is_active)
      setNumberingRequired(spec.boat_numbering_required ?? true)
      setShowInUsage(spec.show_in_usage ?? true)
    } else {
      specForm.resetFields()
      specForm.setFieldsValue({ quantity: 1 })
      setSpecActive(true)
      setNumberingRequired(true)
      setShowInUsage(true)
    }
    setSpecModal(true)
  }

  const submitSpec = async () => {
    const values = await specForm.validateFields()
    const quantity = values.quantity ?? 0
    const body = {
      equipment_type_id: values.equipment_type_id,
      name: values.name,
      price: yuanToFen(values.price),
      capacity: values.capacity === undefined ? null : values.capacity,
    }
    try {
      if (editingSpec) {
        await api.put(`/api/catalog/equipment-specs/${editingSpec.id}`, {
          ...body,
          is_active: specActive,
          boat_numbering_required: numberingRequired,
          show_in_usage: showInUsage,
        })
        // 数量有变化时同步更新库存配置（后端校验不能低于当前占用）
        if (quantity !== editingTotal) {
          await api.put(`/api/inventory/${editingSpec.id}`, { total_quantity: quantity })
        }
      } else {
        await api.post('/api/catalog/equipment-specs', { ...body, quantity })
      }
      message.success('已保存')
      setSpecModal(false)
      load()
      onNumberingChanged?.()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  // 数量为必填项：启用中且总数量为 0 视为「未填写」，在表头与对应行显示红色感叹号
  const missingQuantityIds = new Set(
    (catalog?.equipment ?? [])
      .filter(
        (spec) =>
          spec.is_active &&
          (inventoryRows.find((r) => r.equipment_spec_id === spec.id)?.total_quantity ??
            0) === 0,
      )
      .map((spec) => spec.id),
  )

  const specColumns: ColumnsType<EquipmentSpec> = [
    {
      title: '名称',
      dataIndex: 'name',
      align: 'center',
      // 手机版：收窄各列并让名称单行省略，保证每列内容尽量一行展示
      width: isMobile ? 104 : undefined,
      ellipsis: isMobile,
      render: (value: string, record) => (
        <span
          style={{
            color: typeColorHex(record.equipment_type_color),
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          {value}
        </span>
      ),
    },
    {
      title: '价格',
      dataIndex: 'price',
      align: 'center',
      width: isMobile ? 80 : undefined,
      render: (v: number, record) => (
        <span
          style={{
            display: 'inline-block',
            whiteSpace: 'nowrap',
            // 已停用的器材金额一并置灰
            color: record.is_active ? undefined : '#8c8c8c',
          }}
        >
          {formatSpecPrice(v)}
        </span>
      ),
    },
    {
      title: <span style={{ whiteSpace: 'nowrap' }}>座位数</span>,
      dataIndex: 'capacity',
      align: 'center',
      width: isMobile ? 64 : 90,
      render: (v: number | null, record) => (
        <span
          style={{
            whiteSpace: 'nowrap',
            // 已停用的器材座位数一并置灰
            color: record.is_active ? undefined : '#8c8c8c',
          }}
        >
          {v == null ? '不限' : `${v} 座`}
        </span>
      ),
    },
    {
      title:
        missingQuantityIds.size > 0 ? (
          <span style={{ whiteSpace: 'nowrap' }}>
            数量 <span style={{ color: '#ff4d4f' }}>❗</span>
          </span>
        ) : (
          '数量'
        ),
      width: isMobile ? 62 : 110,
      align: 'center',
      render: (_, record) => {
        const row = inventoryRows.find((r) => r.equipment_spec_id === record.id)
        // 实线框 = 已开启器材编号；虚线框 = 未开启编号
        const dotted = record.boat_numbering_required === false
        return (
          <span style={{ whiteSpace: 'nowrap' }}>
            <span
              style={{
                display: 'inline-block',
                padding: '0 6px',
                border: `1px ${dotted ? 'dashed' : 'solid'} ${record.is_active ? '#000' : '#8c8c8c'}`,
                borderRadius: 4,
                whiteSpace: 'nowrap',
                // 已停用的器材数量（框与数字）一并置灰
                color: record.is_active ? undefined : '#8c8c8c',
              }}
            >
              {row?.total_quantity ?? 0}
            </span>
            {missingQuantityIds.has(record.id) && (
              <span style={{ color: '#ff4d4f', marginLeft: 4 }}>❗</span>
            )}
          </span>
        )
      },
    },
  ]

  // 已停用的器材默认排在列表最后，其余保持目录原有顺序
  const tableData = [...(catalog?.equipment ?? [])].sort(
    (a, b) => Number(b.is_active) - Number(a.is_active),
  )

  return (
    <Card
      title="器材目录"
      extra={
        <Button type="primary" onClick={() => openSpec(null)}>
          新建规格
        </Button>
      }
    >
      <Table
        rowKey="id"
        columns={specColumns}
        dataSource={tableData}
        pagination={false}
        onRow={(record) => ({
          onClick: () => openSpec(record),
          style: { cursor: 'pointer' },
        })}
      />

      <Modal
        title={editingSpec ? '编辑规格' : '新建规格'}
        open={specModal}
        onCancel={() => setSpecModal(false)}
        onOk={submitSpec}
        destroyOnClose
      >
        <Form form={specForm} layout="vertical">
          <div style={{ position: 'relative' }}>
            <Form.Item
              label="器材类型"
              name="equipment_type_id"
              rules={[{ required: true, message: '请选择类型' }]}
            >
              <Select
                placeholder="选择器材类型"
                options={(catalog?.equipment_types ?? [])
                  // 已停用的类型不可再用于新建规格；编辑时保留当前类型用于回显
                  .filter((t) => t.is_active || t.id === editingSpec?.equipment_type_id)
                  .map((t) => ({ value: t.id, label: t.name }))}
              />
            </Form.Item>
            {/* 启用状态开关：与「器材类型」标题同一行，靠最右侧 */}
            {editingSpec && (
              <Switch
                checkedChildren="启用"
                unCheckedChildren="停用"
                checked={specActive}
                onChange={setSpecActive}
                style={{ position: 'absolute', top: 0, right: 0, zIndex: 1 }}
              />
            )}
          </div>
          <Form.Item label="规格名称" name="name" rules={[{ required: true, message: '如：竞速皮划艇（3 座）' }]}>
            <Input />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                label="售价"
                name="price"
                rules={[{ required: true, message: '请输入价格' }]}
              >
                <InputNumber
                  min={0}
                  precision={2}
                  inputMode="tel"
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="座位数"
                name="capacity"
                rules={[{ required: true, message: '请输入座位数' }]}
              >
                <InputNumber
                  min={1}
                  inputMode="tel"
                  style={{ width: '100%' }}
                  placeholder="如：2"
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            label="数量"
            name="quantity"
            rules={[
              { required: true, message: '请输入数量' },
              { type: 'number', min: 1, message: '数量至少为 1 件' },
            ]}
            extra={
              editingSpec && editingOccupied > 0
                ? `该规格可投入使用的总数量；当前已占用 ${editingOccupied}（已签到未归还），不能低于该值。`
                : undefined
            }
          >
            <InputNumber
              min={editingSpec ? Math.max(1, editingOccupied) : 1}
              precision={0}
              inputMode="tel"
              style={{ width: '100%' }}
              addonAfter="件"
            />
          </Form.Item>
          {editingSpec && (
            <Form.Item extra="开启后该器材会出现在概览的「船只用量」区域；关闭后不展示（仅影响概览，不影响下单与调配）。">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <span>显示用量</span>
                <Switch
                  checkedChildren="开"
                  unCheckedChildren="关"
                  checked={showInUsage}
                  onChange={setShowInUsage}
                />
              </div>
            </Form.Item>
          )}
          {editingSpec && (
            <Form.Item extra="关闭后该器材无需编号，也不会出现在「船只」页面的出发/返还调配中；关闭保存时会清空已编好的编号。">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <span>器材编号</span>
                  <Switch
                    checkedChildren="开"
                    unCheckedChildren="关"
                    checked={numberingRequired}
                    onChange={setNumberingRequired}
                  />
                </div>
                <Button
                  disabled={!numberingRequired}
                  onClick={() => setNumberingSpecId(editingSpec.id)}
                >
                  器材编号
                </Button>
              </div>
            </Form.Item>
          )}
        </Form>
      </Modal>

      <NumberingModal
        specId={numberingSpecId}
        open={Boolean(numberingSpecId)}
        onClose={() => setNumberingSpecId(null)}
        onSaved={() => {
          setNumberingSpecId(null)
          onNumberingChanged?.()
        }}
      />
    </Card>
  )
}

/* ---------------- Boat numbering ---------------- */

interface SpecNumbersView {
  spec_id: string
  spec_name: string
  type_name: string
  target_quantity: number
  numbers: { id: string; number: string; in_use: boolean; order_number: string | null }[]
}

// 给单个规格的所有器材编号：顺延生成或逐条手动填写，必须填满且不重复。
function NumberingModal({
  specId,
  open,
  onClose,
  onSaved,
}: {
  specId: string | null
  open: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState<SpecNumbersView | null>(null)
  const [mode, setMode] = useState<'sequence' | 'manual'>('sequence')
  const [numbers, setNumbers] = useState<string[]>([])
  const [firstNumber, setFirstNumber] = useState<number>(1)
  const [step, setStep] = useState<number>(1)

  useEffect(() => {
    if (!open || !specId) return
    setLoading(true)
    api
      .get<SpecNumbersView>(`/api/boats/numbering/${specId}`)
      .then((data) => {
        setView(data)
        setNumbers(
          Array.from({ length: data.target_quantity }, (_, i) => data.numbers[i]?.number ?? ''),
        )
        // 已有编号时直接进入手动模式并回填，便于修改
        setMode(data.numbers.length > 0 ? 'manual' : 'sequence')
        setFirstNumber(1)
        setStep(1)
      })
      .catch((error) => message.error(error instanceof Error ? error.message : '加载失败'))
      .finally(() => setLoading(false))
  }, [open, specId, message])

  const target = view?.target_quantity ?? 0

  const generate = () => {
    if (step < 1) {
      message.warning('数字跳跃间隔至少为 1')
      return
    }
    setNumbers(Array.from({ length: target }, (_, i) => String(firstNumber + i * step)))
  }

  const save = async () => {
    if (!specId) return
    const cleaned = numbers.map((n) => n.trim())
    if (cleaned.length !== target) {
      message.error(`必须为全部 ${target} 件器材填写编号`)
      return
    }
    if (cleaned.some((n) => !n)) {
      message.error('所有器材都必须填写编号')
      return
    }
    if (new Set(cleaned).size !== cleaned.length) {
      message.error('编号不能重复')
      return
    }
    setSaving(true)
    try {
      await api.put(`/api/boats/numbering/${specId}`, { numbers: cleaned })
      message.success('编号已保存')
      onSaved()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`器材编号 · ${view?.spec_name ?? ''}`}
      open={open}
      onCancel={onClose}
      onOk={save}
      okText="保存编号"
      cancelText="取消"
      confirmLoading={saving}
      width={520}
      destroyOnClose
    >
      {loading ? (
        <div style={{ padding: 24, textAlign: 'center' }}>加载中…</div>
      ) : (
        <>
          <p style={{ color: '#666', marginBottom: 12 }}>
            该器材共 <b>{target}</b> 件，必须全部填写编号后才能保存；所有器材之间的编号不能相同。
          </p>
          <Radio.Group
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            style={{ marginBottom: 12 }}
          >
            <Radio.Button value="sequence">顺延编号</Radio.Button>
            <Radio.Button value="manual">手动编号</Radio.Button>
          </Radio.Group>

          {mode === 'sequence' && (
            <div style={{ marginBottom: 12 }}>
              <Space wrap>
                <span>
                  第一个编号数字{' '}
                  <InputNumber
                    min={0}
                    precision={0}
                    inputMode="tel"
                    value={firstNumber}
                    onChange={(v) => setFirstNumber(v ?? 0)}
                    style={{ width: 90 }}
                  />
                </span>
                <span>
                  数字跳跃间隔{' '}
                  <InputNumber
                    min={1}
                    precision={0}
                    inputMode="tel"
                    value={step}
                    onChange={(v) => setStep(v ?? 1)}
                    style={{ width: 90 }}
                  />
                </span>
                <Button onClick={generate}>生成编号</Button>
              </Space>
              <div style={{ color: '#888', fontSize: 12, marginTop: 8 }}>
                示例：首号 {firstNumber}、间隔 {step} → {firstNumber}、
                {firstNumber + step}、{firstNumber + step * 2}…
              </div>
            </div>
          )}

          <div style={{ maxHeight: '48vh', overflowY: 'auto', paddingRight: 4 }}>
            {numbers.map((value, index) => (
              <div
                key={index}
                style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}
              >
                <span style={{ width: 56, color: '#888', flexShrink: 0 }}>{index + 1} 号</span>
                <Input
                  type="tel"
                  inputMode="numeric"
                  value={value}
                  onChange={(e) => {
                    const next = [...numbers]
                    next[index] = e.target.value
                    setNumbers(next)
                  }}
                  placeholder="输入编号"
                />
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}

/* ---------------- Equipment types ---------------- */

function TypeTab() {
  const { isMobile } = useLayoutMode()
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const { message } = App.useApp()
  const [modalOpen, setModalOpen] = useState(false)
  const [editingType, setEditingType] = useState<EquipmentType | null>(null)
  const [form] = Form.useForm<{ name: string; color: string; is_active: boolean }>()
  const color = Form.useWatch('color', form) ?? 'blue'

  const load = useCallback(async () => {
    try {
      setCatalog(await api.get<Catalog>('/api/catalog'))
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载失败')
    }
  }, [message])

  useEffect(() => {
    load()
  }, [load])

  const open = (type: EquipmentType | null) => {
    setEditingType(type)
    if (type) {
      form.setFieldsValue({ name: type.name, color: type.color, is_active: type.is_active })
    } else {
      form.resetFields()
      form.setFieldsValue({ color: 'blue', is_active: true })
    }
    setModalOpen(true)
  }

  const submit = async () => {
    const values = await form.validateFields()
    try {
      if (editingType) {
        await api.put(`/api/catalog/equipment-types/${editingType.id}`, values)
      } else {
        await api.post('/api/catalog/equipment-types', values)
      }
      message.success('已保存')
      setModalOpen(false)
      load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  const columns: ColumnsType<EquipmentType> = [
    {
      title: '类型名称',
      dataIndex: 'name',
      align: 'center',
      // 手机版收窄列宽并用省略号，保证单行展示
      width: isMobile ? 150 : undefined,
      ellipsis: isMobile,
      render: (value: string) => (
        <span
          style={{
            // 类型名称固定用黑色、常规字重，不随类型设定颜色变化
            color: '#000',
            whiteSpace: 'nowrap',
          }}
        >
          {value}
        </span>
      ),
    },
    {
      title: '颜色',
      dataIndex: 'color',
      width: isMobile ? 72 : 90,
      align: 'center',
      render: (value: string) => (
        <span
          style={{
            display: 'inline-block',
            width: 18,
            height: 18,
            borderRadius: '50%',
            backgroundColor: typeColorHex(value),
          }}
        />
      ),
    },
    {
      title: '状态',
      dataIndex: 'is_active',
      width: isMobile ? 84 : 110,
      align: 'center',
      render: (v: boolean) =>
        v ? <Tag color="green">启用</Tag> : <Tag>已停用</Tag>,
    },
  ]

  // 已停用的类型默认排在最后
  const data = [...(catalog?.equipment_types ?? [])].sort(
    (a, b) => Number(b.is_active) - Number(a.is_active),
  )

  return (
    <Card
      title="类型管理"
      extra={
        <Button type="primary" onClick={() => open(null)}>
          新建类型
        </Button>
      }
    >
      <Table
        className="type-table"
        rowKey="id"
        columns={columns}
        dataSource={data}
        pagination={false}
        tableLayout="fixed"
        onRow={(record) => ({
          onClick: () => open(record),
          style: { cursor: 'pointer' },
        })}
      />

      <Modal
        title={editingType ? '编辑类型' : '新建类型'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={submit}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item
            label="类型名称"
            name="name"
            rules={[{ required: true, message: '请输入类型名称，如：皮划艇 / 桨板' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item label="颜色" name="color" rules={[{ required: true }]}>
            <ColorSwatchPicker
              value={color}
              onChange={(value) => form.setFieldValue('color', value)}
            />
          </Form.Item>
          <Form.Item
            label="启用状态"
            name="is_active"
            valuePropName="checked"
            extra="停用后，该类型下的所有器材在新订单中将不可选；历史订单不受影响，可随时重新启用。"
          >
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

/* ---------------- Sale items ---------------- */

function SaleTab() {
  const { isMobile } = useLayoutMode()
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
        className="sale-items-table"
        rowKey="id"
        dataSource={catalog?.sale_items ?? []}
        pagination={false}
        tableLayout="fixed"
        columns={[
          {
            title: '名称',
            dataIndex: 'name',
            align: 'center',
            // 手机版收窄列宽并用省略号，保证单行展示
            width: isMobile ? 108 : undefined,
            ellipsis: isMobile,
            render: (v: string) => <span style={{ whiteSpace: 'nowrap' }}>{v}</span>,
          },
          {
            title: '价格',
            dataIndex: 'price',
            align: 'center',
            width: isMobile ? 84 : 120,
            // 与器材目录一致：纯文本金额，停用后置灰
            render: (v: number, record) => (
              <span
                style={{
                  display: 'inline-block',
                  whiteSpace: 'nowrap',
                  color: record.is_active ? undefined : '#8c8c8c',
                }}
              >
                ¥{fenToYuan(v)}
              </span>
            ),
          },
          {
            title: '状态',
            dataIndex: 'is_active',
            align: 'center',
            width: isMobile ? 84 : 110,
            render: (v: boolean) => (v ? <Tag color="green">启用</Tag> : <Tag>已停用</Tag>),
          },
          {
            title: '操作',
            align: 'center',
            width: isMobile ? 56 : 90,
            render: (_, record) => (
              <Button type="link" size="small" onClick={() => open(record)}>
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
            <InputNumber min={0} precision={2} inputMode="tel" style={{ width: '100%' }} />
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

// 支付方式管理区（付款方式区域）：新增/编辑/删除/设默认仅管理员与超级管理员可操作，
// 普通用户仅只读展示。
function PaymentSection() {
  const { user } = useAuth()
  const { message } = App.useApp()
  const { refresh: refreshGlobalSettings } = useSettings()
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newCode, setNewCode] = useState('')
  const [busy, setBusy] = useState(false)

  // 付款方式管理（含更改默认）仅管理员与超级管理员
  const canManage = Boolean(user && (user.role === 'superuser' || user.role === 'admin'))

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
      <div>
        <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 8 }}>
          <strong>付款方式</strong>
          {canManage && (
            <Button type="primary" size="small" onClick={() => setAddOpen(true)}>
              + 新增支付方式
            </Button>
          )}
        </Space>
        <List
          className="payment-method-list"
          size="small"
          bordered
          // 默认支付方式排在第一行
          dataSource={[...methods].sort(
            (a, b) => Number(b.is_default) - Number(a.is_default),
          )}
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

function StoreTab({ onNumberingChanged }: { onNumberingChanged?: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [minutes, setMinutes] = useState(120)
  const [autoReturnOn, setAutoReturnOn] = useState(true)
  const [boatNumbering, setBoatNumbering] = useState(false)
  // 店铺坐标：经度 / 纬度，均未填写时为 null
  const [longitude, setLongitude] = useState<number | null>(null)
  const [latitude, setLatitude] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const { message } = App.useApp()
  // 保存成功后刷新全局 SettingsContext（更新缓存，OrderForm 等页面立即生效）
  const { refresh: refreshGlobalSettings } = useSettings()

  useEffect(() => {
    api
      .get<AppSettings>('/api/settings')
      .then((data) => {
        setSettings(data)
        setMinutes(data.auto_return_after_minutes)
        setAutoReturnOn(data.auto_return_enabled)
        setBoatNumbering(data.boat_numbering_enabled)
        setLatitude(data.shop_latitude)
        setLongitude(data.shop_longitude)
      })
      .catch((error) => message.error(error.message))
  }, [message])

  const save = async () => {
    // 经度与纬度必须同时填写（都不填表示未设置）
    if ((latitude === null) !== (longitude === null)) {
      message.error('店铺坐标需要同时填写经度与纬度')
      return
    }
    setSaving(true)
    try {
      const result = await api.put<AppSettings>('/api/settings', {
        auto_return_after_minutes: minutes,
        auto_return_enabled: autoReturnOn,
        fast_customer_mode: settings?.fast_customer_mode ?? false,
        boat_numbering_enabled: boatNumbering,
        shop_latitude: latitude,
        shop_longitude: longitude,
      })
      // PUT 只返回基础设置，不包含 payment_methods；合并保留原付款方式，避免保存后付款区域消失
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              ...result,
              payment_methods: prev.payment_methods,
              default_payment_method: prev.default_payment_method,
            }
          : result,
      )
      refreshGlobalSettings()
      onNumberingChanged?.()
      message.success('设置已保存')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title="店铺设置">
      <div style={{ maxWidth: 680 }}>
        {/* 自动归还：名称与开关同一行，第二行为时限 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong>自动归还</strong>
          <Switch
            checked={autoReturnOn}
            onChange={setAutoReturnOn}
            checkedChildren="开"
            unCheckedChildren="关"
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
          <span>自动归还时限</span>
          <InputNumber
            min={1}
            max={9999}
            inputMode="tel"
            value={minutes}
            disabled={!autoReturnOn}
            onChange={(value) => setMinutes(value ?? 120)}
            addonAfter="分钟"
            style={{ width: 116 }}
          />
        </div>
        <Divider style={{ borderColor: '#d9d9d9', margin: '16px 0' }} />
        {/* 船只编号 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong>船只编号</strong>
          <Switch
            checked={boatNumbering}
            onChange={setBoatNumbering}
            checkedChildren="开"
            unCheckedChildren="关"
          />
        </div>
        <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
          开启后可在「器材编号」中为每条船只编号，并在手机版「船只」页面调配出发/返还。开启前必须先给所有器材编号完整。
        </div>
        <Divider style={{ borderColor: '#d9d9d9', margin: '16px 0' }} />
        {/* 店铺坐标：每个 Group 独立，顶部天气信息按此坐标获取 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <strong>店铺坐标</strong>
          <Space size={8}>
            <InputNumber
              min={-180}
              max={180}
              step={0.01}
              value={longitude}
              onChange={(value) => setLongitude(value)}
              addonBefore="经度"
              placeholder="121.52"
              style={{ width: 148 }}
            />
            <InputNumber
              min={-90}
              max={90}
              step={0.01}
              value={latitude}
              onChange={(value) => setLatitude(value)}
              addonBefore="纬度"
              placeholder="31.33"
              style={{ width: 140 }}
            />
          </Space>
        </div>
        <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
          用于顶部天气信息，按该坐标展示当地天气；经度与纬度需同时填写。
        </div>
        {(settings?.payment_methods?.length ?? 0) > 0 && (
          <>
            <Divider style={{ borderColor: '#d9d9d9', margin: '16px 0' }} />
            <PaymentSection />
          </>
        )}
        <Divider style={{ borderColor: '#d9d9d9', margin: '16px 0' }} />
        {/* 保存按钮置于卡片右下角 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="primary" loading={saving} onClick={save}>
            保存设置
          </Button>
        </div>
      </div>
    </Card>
  )
}

function BasicTab() {
  const { user } = useAuth()
  // 极速客户模式仅管理员与超级管理员可改
  const isAdmin = Boolean(user && (user.role === 'superuser' || user.role === 'admin'))
  const [settings, setSettings] = useState<AppSettings | null>(null)
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
        setFastMode(data.fast_customer_mode)
      })
      .catch((error) => message.error(error.message))
  }, [message])

  const save = async () => {
    setSaving(true)
    try {
      const result = await api.put<AppSettings>('/api/settings', {
        auto_return_after_minutes: settings?.auto_return_after_minutes ?? 120,
        auto_return_enabled: settings?.auto_return_enabled ?? true,
        fast_customer_mode: fastMode,
        boat_numbering_enabled: settings?.boat_numbering_enabled ?? false,
        shop_latitude: settings?.shop_latitude ?? null,
        shop_longitude: settings?.shop_longitude ?? null,
      })
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              ...result,
              payment_methods: prev.payment_methods,
              default_payment_method: prev.default_payment_method,
            }
          : result,
      )
      refreshGlobalSettings()
      message.success('设置已保存')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title="基础设置">
      {isAdmin && (
        <>
          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontWeight: 500 }}>极速客户模式</span>
              <Switch
                checked={fastMode}
                onChange={setFastMode}
                checkedChildren="开"
                unCheckedChildren="关"
              />
            </div>
            <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
              开启后创建订单时只需填写客户姓名，无需搜索或新建客户。
            </div>
          </div>
          <Divider />
        </>
      )}
      {/* 调试上报开关：写入当前浏览器（含 PWA 独立存储）的 localStorage，
          开启后所有网络请求会附带一条摘要上报到后端 POST /api/_trace，
          NAS 上 ./data/logs/frontend-trace-YYYY-MM-DD.log 按天生成。 */}
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ fontWeight: 500 }}>调试上报</div>
          <Switch checked={tracingOn} onChange={toggleTracing} />
        </div>
        <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
          开启后，本机所有网络请求会将耗时摘要上报到服务器的 trace 日志，便于定位卡顿。
          仅对当前设备/浏览器生效（PWA 与 Safari 存储隔离，需在各自环境内分别开启）。
        </div>
      </div>
      {/* 手动切换布局模式（手机版 / 桌面版）：仅本次会话生效，刷新后按屏幕宽度重新推导 */}
      <Divider />
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div style={{ fontWeight: 500 }}>页面布局</div>
          <LayoutModeSwitch />
        </div>
        <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
          仅对当前浏览器会话生效，刷新后按屏幕宽度重新判断。
        </div>
      </div>
      <Divider />
      <Descriptions size="small" column={1}>
        <Descriptions.Item label="系统版本">v1.2.0</Descriptions.Item>
        <Descriptions.Item label="最近更新">
          {settings ? new Date(settings.updated_at).toLocaleDateString('zh-CN') : '—'}
        </Descriptions.Item>
      </Descriptions>
      {/* 保存按钮固定在内容之后、卡片右下角（仅管理员可保存） */}
      {isAdmin && (
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="primary" loading={saving} onClick={save}>
            保存设置
          </Button>
        </div>
      )}
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
        {/* 日期范围与导出按钮同一行，按钮靠最右 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: 8,
          }}
        >
          <DatePicker.RangePicker
            value={range}
            onChange={(value) => setRange(value as [Dayjs, Dayjs] | null)}
            allowClear
            style={{ flex: '1 1 auto', minWidth: 0, maxWidth: 320 }}
          />
          <Button type="primary" loading={exporting} onClick={doExport} disabled={!canExport}>
            导出 CSV
          </Button>
        </div>
        {!canExport && <p style={{ color: '#999' }}>当前账号无导出权限。</p>}
        <p style={{ color: '#999' }}>
          导出选定时间范围内所有订单的 CSV（每订单按类目拆分为多行，包含使用时间、消费总额、成人、儿童、类目明细等）。文件将下载到本地下载目录，手机浏览器同样可下载。
        </p>
        {isSuperuser && (
          <div style={{ marginTop: 12 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontWeight: 500 }}>数据定期自动导出</span>
              <Switch
                checked={autoOrders}
                onChange={(value) => updateAutoExport('orders', value)}
                checkedChildren="开"
                unCheckedChildren="关"
              />
            </div>
            <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
              开启后每天 00:00（Asia/Shanghai）自动导出过去 24 小时的订单数据为 CSV，仅生成订单文件，保存到服务器 exports 目录。
            </div>
          </div>
        )}
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
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Input
                placeholder="输入客户ID"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                style={{ width: 300, maxWidth: '100%' }}
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
            </div>
          </Form.Item>
          {!canExport && <p style={{ color: '#999' }}>当前账号无导出权限。</p>}
          {isSuperuser && (
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <span style={{ fontWeight: 500 }}>数据定期自动导出</span>
                <Switch
                  checked={autoCustomers}
                  onChange={(value) => updateAutoExport('customers', value)}
                  checkedChildren="开"
                  unCheckedChildren="关"
                />
              </div>
              <div style={{ color: '#888', fontSize: 12 }}>
                开启后每天 00:00（Asia/Shanghai）自动导出全量客户数据为 CSV，仅生成客户文件，保存到服务器 exports 目录。
              </div>
            </div>
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
  const { isMobile } = useLayoutMode()
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
    {
      title: '文件名',
      dataIndex: 'filename',
      align: 'center',
      // 手机版列宽有限，文件名超长时用省略号保持单行
      ellipsis: isMobile,
      render: (v: string) => <span style={{ whiteSpace: 'nowrap' }}>{v}</span>,
    },
    {
      title: '大小',
      dataIndex: 'size_bytes',
      align: 'center',
      width: isMobile ? 56 : 100,
      render: (v: number) => formatSize(v),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      align: 'center',
      width: isMobile ? 104 : 180,
      render: (v: string) => formatDateTime(v),
    },
    {
      title: '操作',
      align: 'center',
      width: isMobile ? 112 : 200,
      render: (_, record) => (
        <Space size={4}>
          <Button type="link" size="small" href={`/api/backups/${record.filename}/download`}>
            下载
          </Button>
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
      style={{ marginTop: 16 }}
      extra={<Button type="primary" loading={creating} onClick={createBackup}>创建备份</Button>}
    >
      <Table
        className="backup-table"
        rowKey="filename"
        columns={columns}
        dataSource={backups}
        loading={loading}
        pagination={false}
        tableLayout="fixed"
        locale={{ emptyText: '暂无备份文件' }}
      />
      <p style={{ color: '#999', marginTop: 12 }}>
        备份文件存储在服务器 backups 目录。恢复操作会覆盖当前数据库，请谨慎操作。
      </p>
    </Card>
  )
}
