# Rental App — Entity Relationship Model

## 1. 文档目的

本文档定义 Rental App V1 的逻辑数据库模型。它把 `BUSINESS_RULES.md` 和 `PRD.md` 中已经确认的业务规则转换为数据表、字段、关系和数据库约束。

`BUSINESS_RULES.md` 对业务行为具有最高权威。本文件不引入独立的 Reservation、Walk-in、Check-in、Return 或客户实际使用状态实体。

---

## 2. V1 数据库约定

- 数据库：V1 使用 SQLite。
- 主键：UUID，以 SQLite `TEXT` 保存。
- 外键：使用 `<entity>_id` 命名，并在适当位置建立索引。
- 时间：数据库保存 UTC 时间；业务日期使用 `Asia/Shanghai` 判断。
- UTC 时间使用带秒的 ISO 8601 格式，例如 `2026-09-23T12:00:00Z`。
- 金额：使用整数分（fen）保存，界面显示人民币元。
- 布尔值：使用 `0` / `1`。
- 表名和字段名：使用复数和 snake_case，例如 `orders`、`order_items`。
- 历史业务数据不得通过宽泛级联删除而被删除。

---

## 3. V1 实体总览

V1 包含以下实体：

1. `users`
2. `customers`
3. `equipment_types`
4. `equipment_specs`
5. `sale_items`
6. `inventory_configurations`
7. `orders`
8. `order_items`
9. `payments`
10. `payment_items`
11. `settings`

V1 明确不包含：

- `boats`
- `boat_assignments`
- `reservations`
- `reservation_items`
- `walk_ins`
- `actual_usages`
- `actual_usage_items`
- `check_ins`
- `returns`
- `return_items`
- `order_types`
- 客户是否仍在使用设备的独立状态字段

Boat 和 BoatAssignment 可在 V2 根据真实运营需要重新设计，但不属于 V1 的表、页面、API 或定时任务。

---

## 4. `users`

保存内部操作员和受保护的 System User。

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | TEXT | PK, NOT NULL |
| `username` | TEXT | UNIQUE, NOT NULL |
| `display_name` | TEXT | NOT NULL |
| `password_hash` | TEXT | NOT NULL |
| `is_active` | INTEGER | NOT NULL, default 1 |
| `is_system` | INTEGER | NOT NULL, default 0 |
| `created_at` | TEXT | NOT NULL |
| `updated_at` | TEXT | NOT NULL |

规则：

- `username` 唯一。
- V1 的正常用户都是内部操作员，使用用户名和密码登录。
- V1 不实现角色和权限矩阵，正常操作员拥有相同的功能权限。
- System User 必须存在，且 `is_system = 1`。
- System User 不能删除，不能通过普通登录流程登录。
- Auto Return 和 Daily Forced Return 使用 System User 作为操作人。

---

## 5. `customers`

保存可重复使用的客户资料。

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | TEXT | PK, NOT NULL |
| `name` | TEXT | NULL |
| `gender` | TEXT | NULL |
| `wechat_nickname` | TEXT | NULL |
| `wechat_id` | TEXT | UNIQUE when present |
| `phone` | TEXT | UNIQUE when present |
| `is_system` | INTEGER | NOT NULL, default 0 |
| `created_by_user_id` | TEXT | FK, NOT NULL |
| `created_at` | TEXT | NOT NULL |
| `updated_by_user_id` | TEXT | FK, NOT NULL |
| `updated_at` | TEXT | NOT NULL |

规则：

- 独立创建的 Customer 至少满足：`name + phone`，或 `wechat_nickname + wechat_id`。
- `phone` 和 `wechat_id` 在非 NULL 时必须唯一。
- 姓名和微信昵称不要求唯一。
- 系统客户“游客”必须存在，不能删除或改名；其 phone 和 WeChat ID 不可修改。
- Customer 搜索使用简单候选搜索，由操作员确认最终客户。

---

## 6. `equipment_types`

保存设备大类，例如 Kayak、Paddleboard。

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | TEXT | PK, NOT NULL |
| `name` | TEXT | UNIQUE, NOT NULL |
| `created_at` | TEXT | NOT NULL |
| `updated_at` | TEXT | NOT NULL |
| `created_by_user_id` | TEXT | FK, NOT NULL |
| `updated_by_user_id` | TEXT | FK, NOT NULL |

---

## 7. `equipment_specs`

保存具体的可租赁设备规格，例如 Racing Kayak 2-seat。

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | TEXT | PK, NOT NULL |
| `equipment_type_id` | TEXT | FK, NOT NULL |
| `name` | TEXT | NOT NULL |
| `price` | INTEGER | NOT NULL, >= 0 |
| `capacity` | INTEGER | NULL 或 NOT NULL，依设备能力决定 |
| `is_active` | INTEGER | NOT NULL, default 1 |
| `created_by_user_id` | TEXT | FK, NOT NULL |
| `created_at` | TEXT | NOT NULL |
| `updated_by_user_id` | TEXT | FK, NOT NULL |
| `updated_at` | TEXT | NOT NULL |

推荐约束：`UNIQUE(equipment_type_id, name)`。

`price` 是当前标准价格，不是历史订单价格。创建 OrderItem 时复制为 `OrderItem.unit_price`。停用的规格不能加入新订单，但历史 OrderItem 仍可引用。

`capacity` 表示最大承载人数。成人/儿童组合规则由业务层校验。

---

## 8. `sale_items`

保存不属于 EquipmentSpec、但可以收费的额外项目，例如 waterproof bag。

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | TEXT | PK, NOT NULL |
| `name` | TEXT | UNIQUE, NOT NULL |
| `price` | INTEGER | NOT NULL, >= 0 |
| `is_active` | INTEGER | NOT NULL, default 1 |
| `created_by_user_id` | TEXT | FK, NOT NULL |
| `created_at` | TEXT | NOT NULL |
| `updated_by_user_id` | TEXT | FK, NOT NULL |
| `updated_at` | TEXT | NOT NULL |

停用的 SaleItem 不能加入新订单，但历史 OrderItem 仍可引用。SaleItem 不占用设备库存。

---

## 9. `inventory_configurations`

保存每种 EquipmentSpec 当前可用于运营的数量。

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | TEXT | PK, NOT NULL |
| `equipment_spec_id` | TEXT | FK, UNIQUE, NOT NULL |
| `total_quantity` | INTEGER | NOT NULL, >= 0 |
| `updated_by_user_id` | TEXT | FK, NOT NULL |
| `updated_at` | TEXT | NOT NULL |

这是当前运营库存，不是物理所有权历史。`available_quantity` 不单独保存，而是动态计算。

V1 库存不足只显示警告，不强制阻止 Check-in。修改库存数量时，不得低于当前已占用数量，除非业务层明确处理该异常情况。

---

## 10. `orders`

Order 是所有客户交易的唯一核心实体。系统不根据订单时间把订单分成 Reservation 或 Walk-in。

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| `id` | TEXT | PK, UUID |
| `order_number` | TEXT | UNIQUE, NOT NULL |
| `customer_id` | TEXT | FK, NOT NULL |
| `customer_name` | TEXT | NULL，客户快照 |
| `customer_gender` | TEXT | NULL，客户快照 |
| `customer_wechat_nickname` | TEXT | NULL，客户快照 |
| `customer_wechat_id` | TEXT | NULL，客户快照 |
| `customer_phone` | TEXT | NULL，客户快照 |
| `start_at` | TEXT | NOT NULL, UTC |
| `end_at` | TEXT | NOT NULL, UTC |
| `adult_count` | INTEGER | NOT NULL, >= 0 |
| `child_count` | INTEGER | NOT NULL, >= 0 |
| `note` | TEXT | NULL |
| `status` | TEXT | NOT NULL, default `active` |
| `created_at` | TEXT | NOT NULL, UTC |
| `updated_at` | TEXT | NOT NULL, UTC |
| `check_in_at` | TEXT | NULL，当前 Check-in 时间 |
| `check_in_by_user_id` | TEXT | FK, NULL |
| `auto_return_after_minutes` | INTEGER | NULL，Check-in 时的配置快照 |
| `auto_return_at` | TEXT | NULL，Auto Return 时间/标记 |
| `auto_return_occurred` | INTEGER | NOT NULL, default 0 |
| `return_at` | TEXT | NULL，当前有效 Return 时间 |
| `return_by_user_id` | TEXT | FK, NULL |（**V1.1+ 重命名为 `returned_by_user_id`**，详见 §20 #122） |
| `daily_forced_return_occurred` | INTEGER | NOT NULL, default 0 |
| `created_by_user_id` | TEXT | FK, NOT NULL |
| `updated_by_user_id` | TEXT | FK, NOT NULL |

允许的 `status`（V1.1+ 新增 `in_progress`，共 5 种）：

- `active`
- `in_progress`
- `completed`
- `cancelled`
- `no_show`

时间和操作规则：

- `end_at = start_at + 2 hours`，不能单独编辑 `end_at`。
- Check-in、Return 的业务日期按照 `Asia/Shanghai` 判断。
- 过去日期和未来日期的订单不允许 Check-in 或 Return；当天订单在其他规则允许时才可以操作。
- Check-in 和 Return 的时间由服务器在操作发生时取得，操作员不能手动输入时间。
- Check-in 必须不早于 `start_at`。（**V1.1+ 更新**：签到时间可早于 `start_at` 最多 1 小时，详见 BUSINESS_RULES §22.1 #3。）
- Check-in 后 Return 必须晚于 Check-in。
- 没有 Check-in 的直接 Return 必须至少晚于 `start_at` 一分钟。
- `status` 只能使用规定的四种生命周期状态；`checked_in`、`returned`、`auto_returned`、`using` 等不是 status 值。
- 订单客户资料快照不能因 Customer 后续修改而被静默改写。

Check-in 状态由 `check_in_at` 和 `check_in_by_user_id` 一起表示。Return 状态由 `return_at` 和 `return_by_user_id` 一起表示。

Auto Return 约束：

- Check-in 时保存 `auto_return_after_minutes` 快照。
- Auto Return 到期后释放库存并将订单完成，使用 System User。
- `auto_return_occurred = 0` 时，`auto_return_at` 应为 NULL。
- `auto_return_occurred = 1` 时，`auto_return_at` 应有值。
- 人工 Return 修正是原子业务操作；不增加客户实际使用字段。

Daily Forced Return 约束：

- 每天 `23:59:01–23:59:59`（Asia/Shanghai）处理仍 Check-in 且没有有效 Return 的订单。
- 使用 System User、释放库存、完成订单，并设置 `daily_forced_return_occurred`。
- 它与 Auto Return 独立，不能被解释为客户实际使用结束的精确事实。

---

## 11. `order_items`

保存订单中的普通收费项目。每条记录必须引用一个 EquipmentSpec 或一个 SaleItem，不能同时引用或都不引用。

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | TEXT | PK, NOT NULL |
| `order_id` | TEXT | FK, NOT NULL |
| `equipment_spec_id` | TEXT | FK, NULL |
| `sale_item_id` | TEXT | FK, NULL |
| `quantity` | INTEGER | NOT NULL, >= 1 |
| `unit_price` | INTEGER | NOT NULL, >= 0 |
| `created_by_user_id` | TEXT | FK, NOT NULL |
| `created_at` | TEXT | NOT NULL |
| `updated_by_user_id` | TEXT | FK, NOT NULL |
| `updated_at` | TEXT | NOT NULL |

关键约束：

```text
exactly one of equipment_spec_id and sale_item_id is non-NULL
```

`unit_price` 在创建时从当前目录价格复制，之后作为历史价格快照。行金额为 `quantity × unit_price`，不需要单独保存 `amount`。引用 EquipmentSpec 的 OrderItem 才会参与库存占用。有效 Check-in 后 OrderItems 锁定；取消 Check-in 后，满足条件时才可再次编辑。

---

## 12. `payments`

Payment 是与订单关联的金额计算容器。

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | TEXT | PK, NOT NULL |
| `order_id` | TEXT | FK, UNIQUE, NOT NULL |

V1 不保存：

- 是否已付款/未付款的状态；
- 支付方式；
- 支付渠道；
- 独立且不可验证的权威 `total_amount`；
- 重复的设备收费明细。

V1 必须能够查询 Payment 的最终金额，用于运营统计和后续数据分析。最终金额由明细计算：

```text
final_amount = SUM(OrderItem.quantity × OrderItem.unit_price)
             + SUM(PaymentItem.amount)
```

实现可以动态计算，也可以保存一个可重建的缓存金额；缓存不能取代明细作为权威数据。

---

## 13. `payment_items`

保存 Payment 的人工调整明细，例如折扣、附加费用、退款或更正。

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | TEXT | PK, NOT NULL |
| `payment_id` | TEXT | FK, NOT NULL |
| `type` | TEXT | NOT NULL，V1 主要为 `other` |
| `item_name` | TEXT | NOT NULL |
| `quantity` | INTEGER | NOT NULL, != 0 |（**V1.1+ 更新**：数量必须为正，正负由 Tab 决定，详见 BUSINESS_RULES §22.8 #60） |
| `unit_price` | INTEGER | NOT NULL, >= 0 |
| `amount` | INTEGER | NOT NULL, != 0 |
| `note` | TEXT | 人工调整必填 |
| `created_by_user_id` | TEXT | FK, NOT NULL |
| `created_at` | TEXT | NOT NULL |

约束：

- `amount = quantity × unit_price`。
- 正数表示增加金额，负数表示退款或扣减。
- PaymentItem 创建后不可修改。
- 更正通过新增 PaymentItem 实现。
- Payment adjustment 在订单 completed、cancelled 或 no-show 后仍可以添加。

---

## 14. `settings`

保存真正的系统级设置，不使用一个无法约束的巨大 JSON 配置表。

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | TEXT | PK, NOT NULL |
| `auto_return_after_minutes` | INTEGER | NOT NULL, default 120, >= 1 |
| `updated_by_user_id` | TEXT | FK, NOT NULL |
| `updated_at` | TEXT | NOT NULL |

V1 不再需要 `boat_management_enabled`。EquipmentSpec、SaleItem、库存数量、固定订单时长和 Daily Forced Return 时间不属于此表。（**V1.1+ 新增** `group_id`、`fast_customer_mode`、`auto_export_orders_enabled`、`auto_export_customers_enabled`，详见 §20 #131。）

---

## 15. 关系

- `customers 1 : N orders`
- `equipment_types 1 : N equipment_specs`
- `equipment_specs 1 : 1 inventory_configurations`
- `orders 1 : N order_items`
- `equipment_specs 1 : N order_items`
- `sale_items 1 : N order_items`
- `orders 1 : 0..1 payments`
- `payments 1 : N payment_items`
- `users 1 : N` 各类创建、更新及操作人字段

---

## 16. 库存计算

对于某个 EquipmentSpec：

```text
occupied_quantity = SUM(OrderItem.quantity)
```

只统计同时满足以下条件的 OrderItem：

1. 引用了该 EquipmentSpec；
2. 所属订单有有效 Check-in；
3. 所属订单没有有效 Return。

然后：

```text
available_quantity = total_quantity - occupied_quantity
```

未来订单不会提前占用库存。取消 Check-in 或产生有效 Return 后，该订单不再计入占用。库存不足可以产生警告，但不阻止 V1 Check-in。

---

## 17. 删除和历史完整性

EquipmentSpec 或 SaleItem 不再提供时，应设置 `is_active = 0`，不能为了从当前目录移除它而删除历史引用。

Orders、OrderItems、Payments、PaymentItems 及历史操作人引用不能为了绕过业务状态规则而删除。数据库外键、唯一约束、基本 CHECK 约束和业务层校验应共同保证数据完整性。

---

## 18. V2 方向

未来可以增加：

- Boat 和 BoatAssignment；
- 库存调整历史；
- audit log；
- ~~roles 和 permissions~~（已实现，见 §20 #129）；
- 客户在线预订；
- ~~多门店~~（已实现，见 §20 #130/#132）；
- 更丰富的 Payment 功能；
- 客户合并和历史；
- 云端部署。

这些功能必须保持现有 V1 Order、OrderItem、Payment 明细的历史含义不变。

---

## 19. Implementation Independence

本文档定义逻辑数据模型，不强制规定编程语言、ORM、前端框架或代码目录。采用开源基座时可以适配其内部实现，但不得仅因为基座包含这些概念，就自动引入 Reservation、ActualUsage、Check-in、Return、OrderType、Boat 或 BoatAssignment 实体。

---

## 20. V1.1+ 数据模型演进（2026-09-27 至 2026-10-12）

> 以下内容在实际开发迭代中确认，覆盖上方 V1 ER Model 中冲突的条款。编号对应 DISTILL_RAW.md。

### 20.1 核心模型字段变更

**#122** **Order** 新增字段（覆盖 V1 §10）：
- `group_id`（TEXT, FK, NOT NULL）— Group 隔离
- `is_walk_in`（INTEGER, NOT NULL, DEFAULT 0）— 散客标记
- `note_popup`（INTEGER, NOT NULL, DEFAULT 0）— 备注气泡提示
- `auto_return_due_at`（TEXT, NULL）— 自动归还到期时间
- `returned_by_user_id`（TEXT, FK, NULL）— 重命名自 V1 的 `return_by_user_id`

**#123** **OrderItem**：与 V1 §11 一致，无新增字段。

**#124** **Customer** 新增字段（覆盖 V1 §5）：
- `note`（TEXT, NULL）— 客户备注
- `remind`（INTEGER, NOT NULL, DEFAULT 0）— 备注提醒开关
- `group_id`（TEXT, FK, NOT NULL）— Group 隔离

**#125** **EquipmentType** 新增字段（覆盖 V1 §6）：
- `color`（TEXT, NOT NULL, DEFAULT 'blue'）— 颜色（红/蓝/绿/黄/紫/橙/青）
- `group_id`（TEXT, FK, NOT NULL）

**#126** **EquipmentSpec** 新增字段（覆盖 V1 §7）：
- `sort_order`（INTEGER, NOT NULL, DEFAULT 0）— 排序权重
- `group_id`（TEXT, FK, NOT NULL）
- `sold_quantity_7d`（计算字段，非持久化）— 近 7 日销量

**#127** **SaleItem** 新增字段（覆盖 V1 §8）：
- `group_id`（TEXT, FK, NOT NULL）
- `sold_quantity_7d`（计算字段，非持久化）— 近 7 日销量

**#128** **InventoryConfiguration** 新增字段（覆盖 V1 §9）：
- `group_id`（TEXT, FK, NOT NULL）

**#129** **User** 新增字段（覆盖 V1 §4）：
- `role`（TEXT, NOT NULL, DEFAULT 'user'）— 角色（superuser/admin/user）
- `group_id`（TEXT, FK, NULL）— 用户所属 Group
- `perm_create_order`（INTEGER, NOT NULL, DEFAULT 0）
- `perm_edit_order`（INTEGER, NOT NULL, DEFAULT 0）
- `perm_export_report`（INTEGER, NOT NULL, DEFAULT 0）
- `perm_manage_users`（INTEGER, NOT NULL, DEFAULT 0）
- `perm_view_revenue`（INTEGER, NOT NULL, DEFAULT 0）

**#130** **Group**（全新实体，V1 不存在）：
- `id`（TEXT, PK, NOT NULL）
- `name`（TEXT, UNIQUE, NOT NULL）
- `is_active`（INTEGER, NOT NULL, DEFAULT 1）
- `created_at`（TEXT, NOT NULL）

**#131** **Setting** 新增字段（覆盖 V1 §14）：
- `group_id`（TEXT, FK, NOT NULL）— Group 隔离
- `fast_customer_mode`（INTEGER, NOT NULL, DEFAULT 0）— 极速客户模式
- `auto_export_orders_enabled`（INTEGER, NOT NULL, DEFAULT 0）— 订单自动导出开关
- `auto_export_customers_enabled`（INTEGER, NOT NULL, DEFAULT 0）— 客户自动导出开关

### 20.2 Group 隔离规则

**#132** 所有用户创建的数据都必须有 group_id（订单/客户/用户/器材类型/规格/售卖项目/库存配置/设置）。

**#133** payments 与 order_items 通过所属订单继承 Group，无独立查询路径，不冗余存储 group_id。

**#134** 不同 Group 之间允许出现同名内容（客户手机号/微信 ID/器材/售卖项目）。**覆盖 V1 §4.2 的全局唯一约束**——phone/wechat_id 唯一性改为按 Group 隔离。

**#135** 用户名 username 和 Group 名称保持全局唯一（登录身份/租户标识，属刻意例外）。**V1 §3.2 的 username 唯一性保持不变**。

**#136** 用户名不区分大小写、忽略首尾空格（LOWER + trim 匹配，存储保留原始大小写）。

**#137** 系统客户"游客"归入默认 Group。

### 20.3 数据库约束演进

**#138** customers 表 CHECK 约束允许四种合法形态：name+phone、wechat_nickname+wechat_id、仅 name、仅 wechat_nickname。**覆盖 V1 §4.3 的最小约束**——从"必须 name+phone 或 wechat_nickname+wechat_id"改为"仅需 name 或 wechat_nickname"。

**#139** 客户手机号/微信 ID 唯一性按 Group 隔离（索引 uq_customers_group_phone / uq_customers_group_wechat）。**覆盖 V1 §4.2 的全局 UNIQUE**——改为按 Group 隔离的唯一索引。

**#140** orders 表新增 is_walk_in、note_popup 字段（启动迁移自动加列）。

**#141** EquipmentSpec 新增 sort_order 字段（启动迁移自动加列，默认 0）。
