export type UserRole = 'superuser' | 'admin' | 'user'

export interface UserPermissions {
  create_order: boolean
  edit_order: boolean
  export_report: boolean
  manage_users: boolean
  view_revenue: boolean
  manage_payment_methods: boolean
  boat_dispatch: boolean
}

export interface User {
  id: string
  username: string
  display_name: string
  is_system: boolean
  role: UserRole
  permissions: UserPermissions
  group_id: string | null
  group_name: string | null
  operator_code?: string | null
}

export interface UserAccount {
  id: string
  username: string
  display_name: string
  role: UserRole
  is_active: boolean
  is_system: boolean
  group_id: string | null
  perm_create_order: boolean
  perm_edit_order: boolean
  perm_export_report: boolean
  perm_manage_users: boolean
  perm_view_revenue: boolean
  perm_manage_payment_methods: boolean
  perm_boat_dispatch: boolean
  created_at: string
  operator_code?: string | null
}

export interface Group {
  id: string
  name: string
  is_active: boolean
  member_count: number
  created_at: string | null
}

export interface Customer {
  id: string
  name: string | null
  gender: string | null
  wechat_nickname: string | null
  wechat_id: string | null
  phone: string | null
  is_system?: boolean
  note?: string | null
  remind?: boolean
  total_orders?: number
  total_spending_fen?: number
  created_at?: string
  updated_at?: string
}

export interface CustomerStats {
  total_spending_fen: number
  total_orders: number
  completed_orders: number
  no_show_orders: number
  no_show_order_ids: string[]
}

export type EquipmentTypeColor = 'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'cyan'

export interface EquipmentType {
  id: string
  name: string
  color: EquipmentTypeColor
  is_active: boolean
}

export interface EquipmentSpec {
  id: string
  equipment_type_id: string
  equipment_type_name?: string
  equipment_type_color?: EquipmentTypeColor
  // 所属类型是否启用；类型停用后该规格在新订单中不可选
  equipment_type_active?: boolean
  name: string
  price: number
  capacity: number | null
  sort_order: number
  is_active: boolean
  // 是否需要为该器材逐件编号（关闭后不参与船只调配）
  boat_numbering_required: boolean
  // 是否在概览「船只用量」中展示该器材
  show_in_usage: boolean
  sold_quantity_7d: number
}

export interface SaleItem {
  id: string
  name: string
  price: number
  is_active: boolean
  sold_quantity_7d: number
}

export interface Catalog {
  equipment_types: EquipmentType[]
  equipment: EquipmentSpec[]
  sale_items: SaleItem[]
}

export interface InventoryRow {
  equipment_spec_id: string
  equipment_spec_name: string
  total_quantity: number
  occupied_quantity: number
  available_quantity: number
  warning: boolean
}

export type OrderStatus = 'active' | 'in_progress' | 'cancelled' | 'no_show' | 'completed'

export interface OrderItem {
  id: string
  equipment_spec_id: string | null
  equipment_spec_name?: string | null
  equipment_type_color?: EquipmentTypeColor | null
  // 该规格是否启用了船只编号（用于订单详情「船只调配」区域排序）
  requires_numbering?: boolean | null
  sale_item_id: string | null
  sale_item_name?: string | null
  quantity: number
  unit_price: number
  line_amount: number
  locked: boolean
}

export interface InventoryWarning {
  equipment_spec_id: string
  message: string
}

// 下单前库存冲突预检：单个连续冲突时段
export interface InventoryConflictRange {
  start: string
  end: string
  existing: number
  occupied: number
  shortage: number
}

// 下单前库存冲突预检：单个船型的冲突明细
export interface InventoryConflict {
  equipment_spec_id: string
  equipment_spec_name: string
  total_quantity: number
  requested_quantity: number
  max_existing: number
  max_occupied: number
  shortage: number
  ranges: InventoryConflictRange[]
}

export interface BoatUsage {
  number: string
  // 所属订单项（用于把每只船归到对应器材项目下）
  order_item_id: string
  equipment_spec_id: string
  equipment_spec_name: string | null
  equipment_type_color: EquipmentTypeColor | null
  departed_at: string | null
  departed_by_user_name?: string | null
  departed_by_user_code?: string | null
  returned_at: string | null
  returned_by_user_name?: string | null
  returned_by_user_code?: string | null
}

export interface Order {
  id: string
  order_number: string
  status: OrderStatus
  customer_id: string
  customer_name: string | null
  customer_gender: string | null
  customer_wechat_nickname: string | null
  customer_wechat_id: string | null
  customer_phone: string | null
  start_at: string
  end_at: string
  adult_count: number
  child_count: number
  note: string | null
  is_walk_in: boolean
  note_popup: boolean
  payment_method_code: string | null
  items: OrderItem[]
  items_total_fen: number
  refund_amount_fen: number
  total_amount_fen: number
  editable: boolean
  checked_in: boolean
  returned: boolean
  check_in_at: string | null
  check_in_by_user_name?: string | null
  check_in_by_user_code?: string | null
  auto_return_after_minutes: number | null
  auto_return_due_at: string | null
  auto_return_at: string | null
  auto_return_occurred: boolean
  return_at: string | null
  return_by_user_name?: string | null
  return_by_user_code?: string | null
  return_by_system: boolean
  daily_forced_return_occurred: boolean
  created_by_user_name?: string | null
  created_by_user_code?: string | null
  created_at: string
  updated_by_user_name?: string | null
  updated_by_user_code?: string | null
  updated_at: string
  // 船只调配时间：最早出发时间 / 全部船只返还完成时间（无调配记录时为空）
  boat_departed_at: string | null
  boat_departed_by_user_name?: string | null
  boat_departed_by_user_code?: string | null
  boat_returned_at: string | null
  boat_returned_by_user_name?: string | null
  boat_returned_by_user_code?: string | null
  // 逐条船只的出发 / 返还明细（含编号与操作人）
  boat_usage?: BoatUsage[]
  inventory_warnings?: InventoryWarning[]
}

export interface PaymentAdjustment {
  id: string
  quantity: number
  unit_amount: number
  amount: number
  note: string
  created_at: string
  created_by_user_name?: string | null
  created_by_user_code?: string | null
}

export interface PaymentView {
  order_id: string
  payment_id: string | null
  items_total_fen: number
  adjustments_total_fen: number
  amount_fen: number
  order_items: OrderItem[]
  adjustments: PaymentAdjustment[]
}

export interface PaymentMethod {
  id: number
  code: string
  name: string
  is_default: boolean
  active?: boolean
}

export interface AppSettings {
  auto_return_after_minutes: number
  fast_customer_mode: boolean
  boat_numbering_enabled: boolean
  updated_at: string
  payment_methods: PaymentMethod[]
  default_payment_method: string | null
}

export interface DashboardData {
  today: string
  today_orders: number
  status_counts: Record<OrderStatus, number>
  status_amounts_fen: Record<OrderStatus, number>
  checked_in_now: number
  today_completed_amount_fen: number
  low_inventory: Array<{
    equipment_spec_id: string
    available_quantity: number
    total_quantity: number
    occupied_quantity: number
  }>
}

export interface DailySummary {
  date: string
  is_future: boolean
  order_count: number
  summary_status: string
  completed_amount_fen: number
  estimated_amount_fen: number
  equipment_usage: Array<{ name: string; quantity: number; amount_fen: number }>
  sale_item_usage: Array<{ name: string; quantity: number; amount_fen: number }>
  others: Array<{ note: string; quantity: number; amount_fen: number }>
  payment_method_totals: Array<{ code: string; name: string; amount_fen: number }>
}

export interface OrderSegment {
  type: string
  count: number
  // reserved = 预订（未使用，浅色）；used = 进行中/已完成（已使用，原色）
  category?: 'reserved' | 'used'
}

export interface OrderSlot {
  slot: string
  total: number
  segments: OrderSegment[]
}

export interface OrderDistribution {
  date: string
  slots: OrderSlot[]
}

export interface ForecastEquipment {
  spec_id: string
  name: string
  type_name: string
  type_color: string
  total_quantity: number
  // 25 个半小时槽位（08:00–20:00）的被占用 / 可用数量
  occupied: number[]
  occupied_active: number[] // 预订占用
  occupied_used: number[] // 已使用（进行中）占用
  available: number[]
  // 时段最后一刻的可用数量：总量 - 该槽结束时刻仍在占用的数量
  available_end: number[]
}

export interface InventoryForecast {
  date: string
  slots: string[]
  equipment: ForecastEquipment[]
}
