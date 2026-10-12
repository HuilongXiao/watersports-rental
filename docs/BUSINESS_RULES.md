# Rental App — Business Rules

## 1. Purpose and Scope

This document defines the authoritative business rules for the V1 rental management system for kayak and paddleboard operations.

V1 is intended for internal operations staff only. It is designed to manage customers, orders, equipment catalog, inventory, check-in, return, and payment for real daily business use.

This document defines business meaning and business constraints. It does not prescribe a specific frontend library, backend implementation, database ORM, or third-party component.

If another project document conflicts with this document, this document takes precedence.

---

## 2. Core Business Concept: Order

### 2.1 Order is the only order concept

The system has one business entity for a customer transaction: `Order`.

The following are not separate system concepts:

- Reservation
- Walk-in
- Reservation Order
- Walk-in Order
- Order Type

“Reservation” and “Walk-in” are only natural-language descriptions of different business scenarios.

Examples:

- Customer asks in advance for tomorrow at 14:00 → create an Order with `start_at` tomorrow at 14:00.
- Customer arrives without booking and wants to rent now → create an Order with `start_at` set to the current time.
- Customer asks in advance for later today → create an Order.

The system MUST NOT infer an order type from `start_at`.

The system MUST NOT create different processing branches merely because the selected start time is in the past, present, or future.

There is no `order_type`, `reservation_type`, or `walk_in_type`.

---

## 3. User

### 3.1 Purpose

A User identifies the operator who performs a business-changing action.

V1 uses username/password authentication.

### 3.2 Fields

A User contains:

- `id`
- `username` unique
- `display_name`
- `password_hash`
- `is_active`
- `is_system`
- `created_at`
- `updated_at`

### 3.3 Rules

- `username` is unique.
- Normal users use username/password login.
- V1 has no role or permission system.
- All normal users have the same functional permissions.
- The System User always exists.
- The System User has `is_system = 1`.
- The System User cannot be deleted.
- The System User cannot log in through normal authentication.
- Automatic business actions are attributed to the System User.

---

## 4. Customer

### 4.1 Customer identity fields

A Customer may contain:

- `name`
- `gender`
- `wechat_nickname`
- `wechat_id`
- `phone`

### 4.2 Uniqueness

The following are unique when present:

- `phone`
- `wechat_id`

Name and WeChat nickname are not unique.

### 4.3 Minimum valid Customer

A standalone Customer must satisfy at least one of:

- `name` + `phone`
- `wechat_nickname` + `wechat_id`

### 4.4 Customer matching

All four fields participate in customer matching:

- name
- WeChat nickname
- WeChat ID
- phone

V1 uses simple candidate search and operator confirmation.

V1 does NOT require:

- fuzzy matching
- pinyin matching
- AI matching
- automatic customer merging
- ranking/scoring of candidates

Once the operator confirms the intended Customer, the order uses that Customer.

### 4.5 System customer

A system customer named “游客” always exists.

Rules:

- cannot be deleted
- cannot be renamed
- its WeChat ID and phone are immutable
- created by the System User

---

## 5. Equipment Catalog

The equipment catalog is configurable in Settings.

### 5.1 EquipmentType

Represents a broad equipment category, such as:

- Kayak
- Paddleboard

Rules:

- name is unique
- can be created and edited by operators

### 5.2 EquipmentSpec

Represents a specific rentable/chargeable equipment specification.

Examples:

- Racing Kayak — 3-seat
- Racing Kayak — 2-seat
- Racing Kayak — 1-seat
- Leisure Kayak — 3-seat
- Paddleboard

Fields include:

- `id`
- `equipment_type_id`
- `name`
- `price`
- `capacity`
- `is_active`
- creation/update actor and timestamps

Rules:

- price is the current standard price
- historical order prices are stored as OrderItem price snapshots
- operators cannot edit an existing OrderItem's unit price from the Order page
- inactive specifications cannot be used for new orders
- historical references remain valid
- historical business data must not be deleted merely to remove an item from current use

### 5.3 SaleItem

A SaleItem is a separately catalogued chargeable item that is not an EquipmentSpec.

Examples may include:

- waterproof bag
- other small rental/sale extras

Fields include:

- `id`
- `name`
- `price`
- `is_active`
- creation/update actor and timestamps

Rules:

- name is unique
- price is the current standard price
- historical order prices are stored as OrderItem snapshots
- inactive SaleItems cannot be added to new orders
- historical references remain valid

For V1, ordinary chargeable products should be represented through `OrderItem` and not require re-selection inside Payment.

---

## 6. Equipment Capacity Rules

`capacity` means the maximum total number of people allowed on the equipment.

It does NOT mean minimum occupants.

### 6.1 Racing / Leisure kayak — 3-seat

Maximum total: 3 people.

At least 1 adult is required.

Maximum adults: 2.

Valid examples:

- 2 adults + 1 child
- 1 adult + 2 children
- 2 adults
- 1 adult + 1 child
- 1 adult

Invalid examples:

- 3 adults
- 0 adults
- more than 3 total people

### 6.2 Racing / Leisure kayak — 2-seat

Maximum total: 2 people.

Valid combinations:

- 2 adults
- 1 adult + 1 child
- 1 adult

Invalid:

- 2 children
- 3 or more people
- 0 adults

### 6.3 Racing / Leisure kayak — 1-seat

Only one adult is allowed.

Valid:

- 1 adult

Invalid:

- any child
- more than one person
- zero adults

### 6.4 Paddleboard

V1 treats the paddleboard as a single-spec equipment item. Any additional adult/child restrictions are only enforced if explicitly defined by business rules.

---

## 7. Order

### 7.1 Purpose

Order is the central business entity.

An Order records:

- customer
- requested/selected start time
- end time
- people count
- ordered items
- operational status
- check-in information
- return information
- payment relationship
- business actors

### 7.2 Core fields

An Order contains:

- `id`
- `order_number`
- `customer_id`
- customer snapshot fields
- `start_at`
- `end_at`
- `adult_count`
- `child_count`
- `note`
- `status`
- `created_at`
- `updated_at`
- `created_by_user_id`
- `updated_by_user_id`
- `check_in_at`
- `check_in_by_user_id`
- `auto_return_after_minutes`
- `auto_return_at`
- `auto_return_occurred`
- `return_at`
- `return_by_user_id`
- `daily_forced_return_occurred`

### 7.3 Order number

`order_number` is system-generated and unique.

### 7.4 Time rules

- The operator selects `start_at`.
- `end_at` is automatically `start_at + 2 hours`.
- `end_at` is not independently editable in V1.
- Database timestamps are stored in UTC.
- Business time is Asia/Shanghai.
- User-entered local times are converted to UTC for storage.
- Business-date decisions use Asia/Shanghai.

The system does not classify an Order based on whether its start time is before, equal to, or after the current time.

### 7.5 Default people count

When equipment is selected, the UI may initialize people counts as follows:

- 2 adults for racing 3-seat
- 2 adults for racing 2-seat
- 2 adults for leisure 3-seat
- 2 adults for leisure 2-seat
- 1 adult for racing 1-seat
- 1 adult for leisure 1-seat
- 1 adult for paddleboard
- children default to 0

Once the operator manually edits adult/child counts, later equipment changes MUST NOT automatically overwrite the operator's manually entered counts.

The final combination must still satisfy applicable equipment capacity rules.

---

## 8. Order Status

V1 has exactly four lifecycle statuses:

- `active`
- `cancelled`
- `no_show`
- `completed`

These are the only lifecycle statuses.

### 8.1 Active

An active Order can be edited subject to the rules for check-in and return.

### 8.2 Terminal statuses

The following are terminal statuses:

- `cancelled`
- `no_show`
- `completed`

Terminal Orders are locked for normal editing.

To modify a terminal Order, it must first be restored to `active`, subject to business rules.

### 8.3 Status transitions

Allowed transitions:

- active → cancelled
- active → no_show
- active → completed
- cancelled → active
- no_show → active
- completed → active

Other direct status transitions are not allowed.

### 8.4 Completed does not imply Return

`completed` is simply a terminal business status.

An Order can be completed without having a Check-in or Return record.

Examples:

- staff confirms at the end of the day that the customer actually used the equipment but Check-in/Return was forgotten
- a direct Return is recorded without a prior Check-in

`completed` MUST NOT be interpreted as evidence that `return_at` exists.

---

## 9. OrderItem

OrderItem represents a normal chargeable item within an Order.

### 9.1 Core fields

An OrderItem contains:

- `id`
- `order_id`
- item reference
- `quantity`
- `unit_price`
- creation/update actor and timestamps

The item reference must identify the relevant EquipmentSpec or SaleItem according to the final implementation model.

### 9.2 Price snapshot

When an OrderItem is created:

- `unit_price` is copied from the current catalog price
- `unit_price` becomes the historical price snapshot for that OrderItem
- operators cannot edit `unit_price` directly from the Order page

### 9.3 Amount

Line amount is:

`quantity × unit_price`

V1 does not store Order total amount as a permanent field.

### 9.4 Editing rules

Before Check-in:

- equipment/item can be added
- equipment/item can be removed
- quantity can be changed
- applicable catalog item can be changed

After Check-in:

- OrderItems are locked.

To change an OrderItem after Check-in:

1. cancel the current Check-in
2. modify the OrderItem
3. Check-in again

An effective Return also keeps the OrderItem locked.

---

## 10. Check-in

Check-in is an operation on an Order, not a separate database entity.

### 10.1 Fields

The current Check-in state is represented by:

- `check_in_at`
- `check_in_by_user_id`

### 10.2 Rules

- Check-in uses the current system time
- The operator performing it is recorded
- V1 has no separate Check-in history entity
- Re-check-in overwrites the current Check-in timestamp and actor
- Cancelled Check-in clears the current Check-in fields
- Manual Check-in is allowed only on the same Asia/Shanghai calendar date as the Order date
- `check_in_at >= start_at`
- An effective Return blocks Check-in changes until Return is cancelled/handled

### 10.3 Effects of Check-in

Successful Check-in:

- locks OrderItems
- starts inventory occupation
- starts the Auto Return cycle

Check-in is the event that makes an OrderItem count against operational inventory.

---

## 11. Return

Return is an operation on an Order, not a separate database entity.

### 11.1 Fields

The current Return state is represented by:

- `return_at`
- `return_by_user_id`

### 11.2 Manual Return after Check-in

If Check-in exists:

- Return must occur after Check-in.
- Return sets the Order to `completed`.
- Inventory occupied by the Check-in is released.

### 11.3 Direct Return without Check-in

A direct Return is allowed.

This means:

- the operator confirms that the business activity has ended
- the Order becomes `completed`
- no inventory release occurs because there was no inventory occupation
- no Check-in is created automatically

For a direct Return without Check-in:

`return_at >= start_at + 1 minute`

### 11.4 Return after end time

Return may occur later than the planned `end_at`.

### 11.5 Return cancellation

Cancelling the current effective Return:

- clears `return_at`
- clears `return_by_user_id`
- resets the current daily forced return marker if applicable
- does not automatically resume a previously invalidated ordinary Auto Return task

If a completed Order had an effective Return, restoring it to active does not automatically remove the historical Auto Return snapshot fields.

---

## 12. Auto Return

Auto Return protects inventory when staff forget to record a Return.

### 12.1 Configuration

Settings contains:

- `auto_return_after_minutes`

Default:

- 120 minutes

Minimum:

- 1 minute

### 12.2 Snapshot behavior

When Check-in occurs:

`auto_return_after_minutes` is copied to the Order.

Later Settings changes do not affect the current Check-in cycle.

### 12.3 Automatic Return

When the scheduled time is reached and the Order still has no effective Return:

- the system creates the current Return
- `return_at` is the scheduled Auto Return time
- `return_by_user_id` is the System User
- the Order becomes `completed`
- inventory is released

The Auto Return operation marks:

- `auto_return_occurred = 1`
- `auto_return_at = actual Auto Return time`

### 12.4 Manual Return before Auto Return

If staff manually Return before the scheduled Auto Return:

- the manual Return becomes the effective Return
- the original scheduled task must not later create another Return

### 12.5 Auto Return followed by human Return

If Auto Return has already occurred and a human later records a Return:

- `auto_return_at` remains the original automatic Return time
- `auto_return_occurred` remains true
- `return_at` becomes the human Return time
- `return_by_user_id` becomes the human operator

### 12.6 Check-in cancellation

Cancelling Check-in clears the current Auto Return cycle:

- `auto_return_after_minutes = NULL`
- `auto_return_occurred = 0`
- `auto_return_at = NULL`

A new Check-in starts a new cycle.

---

## 13. Daily Forced Return

Daily Forced Return is a separate end-of-day inventory safety mechanism.

### 13.1 Timing

V1 uses the fixed Asia/Shanghai window:

`23:59:01–23:59:59`

### 13.2 Eligibility

An Order is eligible if:

- it has an effective Check-in
- it has no effective Return

### 13.3 Effects

Daily Forced Return:

- creates the current Return
- uses the System User
- releases occupied inventory
- sets `daily_forced_return_occurred = 1`
- does not change ordinary Auto Return fields

### 13.4 Cancellation

Cancelling the effective Daily Forced Return:

- clears the current Return fields
- resets `daily_forced_return_occurred = 0`

If a new Check-in occurs, the daily forced return marker is reset.

---

## 14. Inventory

### 14.1 Meaning of inventory quantity

V1 inventory represents current operational inventory, not total physical ownership.

Example:

If the business physically owns 20 boats but 5 are currently lent to another club, the operator may change operational inventory to 15.

V1 does not need to record why the quantity changed.

### 14.2 Inventory configuration

Each EquipmentSpec has one InventoryConfiguration containing:

- `equipment_spec_id`
- `total_quantity`
- `updated_by_user_id`
- `updated_at`

### 14.3 Available inventory

Available inventory is calculated:

`available = total operational inventory - currently occupied quantity`

Occupied quantity consists only of OrderItem quantities belonging to Orders that:

- have an effective Check-in
- do not have an effective Return

Future Orders do not reduce available inventory.

> **V1.1+ 更新**：库存计算已演进为 buffer/usage/配对去重复杂逻辑，不再使用此简单公式。详见 §22.5 #26-#36。

### 14.4 Inventory release

Inventory is released when:

- an effective Return occurs
- an effective Check-in is cancelled

Direct Return without Check-in does not change inventory.

### 14.5 Inventory shortage

V1 may warn the operator when an operation would result in insufficient inventory.

V1 does not require a hard inventory reservation block.

### 14.6 Inventory minimum

`total_quantity` cannot be negative and cannot be lower than current occupied quantity.

V1 does not maintain an inventory transaction/history table.

---

## 15. Payment

### 15.1 Payment purpose

Payment records the current financial state associated with an Order.

V1 does not duplicate OrderItem selection in Payment.

The Payment UI displays the Order's current normal chargeable items and their calculated amounts.

### 15.2 Normal order charges

Normal charges come directly from OrderItems:

`SUM(quantity × unit_price)`

The operator does not re-select equipment or SaleItems inside Payment.

### 15.3 Other adjustments

Payment may contain additional adjustment records for cases such as:

- discount
- surcharge
- refund
- correction
- temporary charge
- other manual adjustment

These are represented by PaymentItem records as “other”.

### 15.4 PaymentItem model

A PaymentItem contains:

- `id`
- `payment_id`
- `quantity`
- `unit_amount`
- `amount`
- `note`
- actor and timestamp

The system does not create subcategories for “other”.

A note is mandatory to explain why the adjustment exists.

Rules:

- `quantity != 0`
- `unit_amount >= 0`
- `amount = quantity × unit_amount`
- positive values increase the final amount
- negative values decrease the final amount
- PaymentItem records are immutable after creation

Corrections are made by adding a new adjustment rather than editing the historical PaymentItem.

### 15.5 Final amount

Current received/final amount is dynamically calculated:

`SUM(current OrderItem charges) + SUM(current PaymentItem adjustments)`

The final Order amount is not stored as a separate authoritative field.

### 15.6 Payment status

V1 does not store a separate payment status field.

The application can derive/display payment state from the current Payment data.

Payment remains adjustable even after the Order reaches a terminal status.

### 15.7 “Other” semantics

“Other” is not a separate business category in the system. It is simply a PaymentItem adjustment with a required note.

Examples of business reasons stored in `note`:

- refund
- discount
- temporary fee
- surcharge
- correction
- manual adjustment

The system does not need separate classification or extra fields beyond `quantity`, `unit_amount`, `amount`, `note`, and actor/timestamp metadata.

---

## 16. Order and Customer Snapshot

An Order stores a snapshot of customer information in addition to its `customer_id`.

This preserves the customer information associated with the Order at the time it was created.

Changing the Customer profile later must not silently rewrite historical Order snapshots.

---

## 17. Actor Tracking

Every business-changing action must identify the User responsible for it.

Typical actor fields include:

- `created_by_user_id`
- `updated_by_user_id`
- `check_in_by_user_id`
- `return_by_user_id`

Automatic operations use the System User.

V1 does not require a separate audit-log entity, but the actor fields above are part of the business model.

---

## 18. Data Integrity Rules

### 18.1 IDs

All primary keys use UUID values.

### 18.2 Money

Money is stored as integer fen.

UI displays yuan.

### 18.3 Time

Database timestamps are UTC.

Business timezone is Asia/Shanghai.

UTC timestamps use ISO 8601 with `Z` and seconds precision.

### 18.4 Nullability

NULL means nonexistent, unknown, or not applicable.

NOT NULL means required.

Defaults are used only where they have explicit business meaning.

### 18.5 Foreign keys

Foreign keys must reference valid records.

Historical business records must not be deleted to bypass business rules.

### 18.6 Historical catalog data

If an EquipmentSpec or SaleItem is no longer offered:

- deactivate it
- do not delete historical references merely to remove it from the current catalog

### 18.7 Quantity

OrderItem quantity must be at least 1.

Inventory quantity must not be negative.

### 18.8 People

Adult and child counts must be non-negative.

Total people must be at least 1.

Equipment-specific capacity/composition rules are enforced at the business layer.

### 18.9 Order timing

`end_at > start_at`

`end_at = start_at + 2 hours`

If Check-in exists:

`check_in_at >= start_at`

and Check-in must be on the same Asia/Shanghai calendar date as the Order date.

If both Check-in and Return exist:

`return_at > check_in_at`

If Return exists without Check-in:

`return_at >= start_at + 1 minute`

### 18.10 Auto Return invariants

If `auto_return_occurred = 0`:

`auto_return_at IS NULL`

If `auto_return_occurred = 1`:

`auto_return_at IS NOT NULL`

When an Auto Return has occurred:

`auto_return_at > check_in_at`

and the current Return must not precede the Auto Return time.

### 18.11 Check-in / Return pairing

Check-in state is represented by the pair:

- `check_in_at`
- `check_in_by_user_id`

Return state is represented by the pair:

- `return_at`
- `return_by_user_id`

---

## 19. Non-goals for V1

The following are explicitly not required for V1:

### Customer-facing functions

- customer self-service booking
- customer account
- online payment
- WeChat authorization
- WeChat mini program
- customer notifications

### Advanced customer functions

- AI customer matching
- fuzzy/pinyin matching
- automatic customer merge
- customer segmentation
- loyalty program
- marketing automation

### Advanced rental functions

- Reservation entity
- ReservationItem
- Walk-in entity/type
- Order type
- ActualUsage entity
- ActualUsageItem
- Check-in entity
- Return entity
- ReturnItem
- complex booking workflows
- Boat and BoatAssignment
- overlap conflict engine

### Advanced financial functions

- complex payment allocation
- accounting integration
- invoice management
- payment gateway integration
- multi-currency
- full accounting ledger

### Advanced management functions

- ~~roles and permissions~~（已实现，见 §22.6 #37）
- ~~multi-store management~~（已实现，见 §22.6 #41 和 PRD §14.1 #83）
- advanced audit log
- inventory adjustment history
- advanced BI
- forecasting
- AI recommendations

---

## 20. Acceptance Criteria

V1 should be considered operationally usable when the following work correctly.

### Scenario A — Future-time Order

1. Operator logs in.
2. Operator selects or creates a Customer.
3. Operator creates an Order with a future start time.
4. Operator selects equipment/items.
5. System calculates the two-hour end time.
6. Order is saved as Active.
7. The future Order does not reduce current operational inventory.

### Scenario B — Immediate Order

1. Operator creates an Order for a customer who has arrived without a prior booking.
2. Operator selects the current time as the start time.
3. System treats it exactly like any other Order.
4. No Walk-in-specific entity or processing path is created.

### Scenario C — Check-in and Return

1. Operator opens an eligible active Order.
2. Operator presses Check-in.
3. Inventory becomes occupied.
4. OrderItems become locked.
5. Operator later presses Return.
6. Order becomes Completed.
7. Inventory becomes available again.

### Scenario D — Direct Return without Check-in

1. Operator has an active Order without Check-in.
2. Operator confirms the activity has ended.
3. Operator records Return.
4. Order becomes Completed.
5. Inventory does not change because there was no prior inventory occupation.

### Scenario E — Forgotten Return

1. Operator performs Check-in.
2. Inventory becomes occupied.
3. Operator forgets Return.
4. Auto Return eventually occurs.
5. Inventory is released.
6. Order becomes Completed.

### Scenario F — End-of-day safety

1. An Order has Check-in.
2. No effective Return exists.
3. The normal Auto Return has not resolved the situation.
4. Daily Forced Return runs at the end of the day.
5. Inventory is released.
6. Order becomes Completed.

### Scenario G — Payment

1. Order contains equipment/items.
2. Payment page displays those existing OrderItems.
3. Operator does not re-select them.
4. Operator can add an “Other” adjustment.
5. Multiple “Other” adjustments can exist in the same Payment.
6. Each “Other” has a note describing why it exists.
7. The final displayed amount reflects OrderItems plus adjustment items.

---

## 21. Product Boundary Principle

The V1 product should remain small enough to become usable quickly.

When a proposed feature is not necessary to complete the core workflow:

`Login → Customer → Order → Check-in → Inventory → Return → Payment`

it should normally be deferred until after real-world V1 usage identifies a concrete need.

The product should not introduce a new entity, workflow, or technical dependency merely because that pattern is common in other rental-management systems.

The business model in this document remains authoritative for business constraints.

---

## 22. V1.1+ 演进规则（2026-09-27 至 2026-10-12）

> 以下规则在实际开发迭代中确认，覆盖上方 V1 基线中冲突的条款。编号对应 DISTILL_RAW.md。

### 22.1 订单生命周期演进

**#1** 订单只有一个实体 `Order`，不区分 reservation/walk-in 为独立实体；系统不根据 `start_at` 推断订单类型分支。（与 V1 §2 一致）

**#2** 订单状态从 V1 的 4 个增至 **5 个**：active（预订）→ in_progress（进行中，已签到）→ completed（已完成）；active 可转 cancelled / no_show；cancelled/no_show/completed 可恢复为 active。**覆盖 V1 §8 的 4 状态定义**——新增 `in_progress` 状态表示已签到但未归还。

**#3** 签到时间可以早于订单开始时间，但不可早于开始时间超过 1 小时。**覆盖 V1 §10.2 的 `check_in_at >= start_at`**——改为 `check_in_at >= start_at - 1 hour`。

**#4** 自动归还规则：每次签到（含取消签到后重新签到）都会重置计时，以最后生效的签到时间为准，在 `auto_return_after_minutes`（默认 120 分钟）后执行；不受历史取消签到/取消归还影响。

**#5** 自动归还操作必须由 System User（`is_system=True`）执行。（与 V1 §12.3 一致）

**#6** 每日 23:59 Asia/Shanghai 执行强制归还任务。（与 V1 §13 一致）

**#7** 订单使用时长计算：有签到时间时为归还时间减签到时间；无签到时间时默认按 2 小时计算；格式为"X小时Y分"（如 1小时45 分，不足 1 小时仅"Y分"，未归还显示"—"）。

**#8** 订单创建后客户信息不可修改（任何状态）：前端编辑已有订单时客户字段全部禁用（不灰显、保持原色、仅阻断交互）；后端校验 customer_id / 昵称 / 姓名回退 / is_walk_in 与原值不一致均返回 409。

### 22.2 进行中订单编辑规则

**#9** 进行中订单（已签到）器材项目不可增删改（后端校验 `equipment_spec_id+quantity` 必须与原订单一致，否则 409），仅可添加或调整销售项目。**覆盖 V1 §9.4 的"OrderItems locked after Check-in"**——进行中可添加销售项目。

**#10** 进行中订单已保存的销售项目不可编辑/删除，仅可添加新销售项目（前端通过 `isOriginal` 标记区分）。

**#11** 进行中订单编辑时备注区域可编辑（备注输入框和气泡勾选框不禁用）。

**#12** 终态订单（completed/cancelled/no_show）完全锁定，不可编辑。（与 V1 §8.2 一致）

**#13** 进行中订单"编辑"按钮显示条件：`order.editable || order.status === 'in_progress'`。

**#14** 进行中订单"+"号在项目表头右侧始终显示，点击新增行仅显示销售项目选项。

### 22.3 容量与人数校验

**#15** 订单总承载人数上限为所选所有器材座位数与数量的乘积之和（如 2 条 2 座 + 1 条 3 座 = 7 人）。

**#16** 成人数量上限为所选器材数量乘以 2（每个器材最多 2 名成人）。

**#17** 至少需要 1 人，至少 1 名成人。

**#18** 桨板型规格（`capacity=NULL`）不参与承载人数计算。

### 22.4 客户规则演进

**#19** 客户 profile 创建/编辑保存仅要求姓名或微信昵称至少有一项；手机号、微信 ID 均为独立选填项。**覆盖 V1 §4.3 的最小客户约束**——从 `name+phone` 或 `wechat_nickname+wechat_id` 改为仅需 name 或 wechat_nickname。

**#20** `customers` 表 CHECK 约束允许四种合法形态：name+phone、wechat_nickname+wechat_id、仅 name、仅 wechat_nickname。

**#21** 极速客户模式下创建订单仅显示"客户微信昵称"输入框；输入昵称与同 Group 已有客户 `wechat_nickname` 完全相同则并入该客户，否则创建仅有 `wechat_nickname` 的客户。

**#22** 当客户备注(note)为空时，提醒(remind)自动设为 false。

**#23** 客户创建订单时，若该客户 remind=true 且有 note，系统弹出提示显示备注内容。

**#24** 系统客户"游客"永远在客户管理列表置顶，不可删除、不可编辑。

**#25** 订单 API 入参 `customer_name` 字段保留作为旧客户端兼容回退（按 name 去重复用）。

### 22.5 库存与船只用量计算

**#26** 预订（active）订单拆为"预留时间"buffer [start-90min, start) 和"使用时间"usage [start, start+2h)。buffer 从 V1 的 2 小时改为 **1 小时 30 分**。

**#27** 进行中（in_progress）订单从签到时间起占 4 格（签到在半点格前 15 分钟）或 5 格（后 15 分钟），向后 2 小时。

**#28** 已完成（completed）订单：有签到则按实际使用时长（归还-签到，向上取整到半小时）；无签到直接归还则按订单开始→结束时间。

**#29** 已完成订单计入"已使用"桶，按签到时间（无签到回退订单开始时间）落入，与进行中同一颜色。

**#30** 预留/使用配对去重规则：当某条船的使用时间与另一订单的预留时间重叠、且使用结束时间 ≤ 该订单开始时间时，重叠时段只计 1 条船；配对时必须检查槽位实际相交（2026-10-11 修复）。

**#31** 过去时段（槽结束时间 ≤ 当前时间）不显示 buffer 占用，只显示 usage；配对去重也只在 buffer 可见时段生效。

**#32** 预测页仅显示 `is_active=true` 的器材规格。

**#33** 预测页可使用船只数量 = 船只总量 - 被占用的船只数量。

**#34** 创建订单时船只超售提示所依据的船只使用数量，直接遵循"船只用量"的目标时段船只用量计算逻辑。

**#35** 下单保存前必须先做库存冲突预检（POST /api/orders/conflicts），仅预警不阻断。

**#36** 库存冲突预检与预测页同口径（buffer_cutoff 传入 check_order_conflicts，编辑历史订单不传 cutoff 保持全窗口物理口径）。

### 22.6 权限与可见性

**#37** 功能 Tab 仅对有权限的操作员显示（无权限则不显示）。**覆盖 V1 §3.3 的"所有正常用户拥有相同功能权限"**——已实现角色与权限系统。

**#38** 数据备份 Tab 仅 superuser 可见。

**#39** 数据导出 Tab 仅 superuser、admin 或被赋予 export_report 权限的 user 可见。

**#40** 用户管理 Tab 仅 superuser、admin 或被赋予 manage_users 权限的 user 可见。

**#41** Group 管理 Tab 仅 superuser 可见。

**#42** 器材目录、售卖项目、系统设置 Tab 对所有人可见。

**#43** 非 superuser 用户看不到 superuser 账号。

**#44** 新增 `perm_view_revenue` 权限位，控制营业额查看权限。

**#45** 删除订单、删除客户 profile 为 superuser 专属权限（403 for admin/user）。

**#46** 删除订单为永久删除并显式按序级联：支付调整项→支付记录→订单项目→订单。

**#47** 删除客户 profile：系统客户"游客"返回 409；客户仍有关联订单时返回 409 提示先删订单。

### 22.7 时间与显示格式

**#48** 系统中所有时间显示只到分钟（不显示秒）：前端 formatDateTime 为 YYYY-MM-DD HH:mm。

**#49** 订单管理列表开始时间显示格式为 MM-DD HH:mm（不含年份和秒）。

**#50** 时间选择器以 15 分钟为间隔。

**#51** 时间选择器点击时间数字弹出 5×6 网格选择器（05:30–20:00，30 分钟间隔）。

**#52** 新建订单默认开始时间为当前时间向上取整到下一个 15 分节点（秒/毫秒清零）。

**#53** 日期/时间/数量调整使用 [−][值][+] 步进按钮形式。

**#54** 成人数/儿童数使用步进按钮，0 时减号禁用（不可为负）。

**#55** 订单页面操作按钮文本：编辑订单→编辑、标记爽约→爽约、取消订单→取消（签到、归还保持不变）。

### 22.8 其他业务规则

**#56** 器材规格/售卖项目的停用开关位于编辑弹窗内（列表操作列不显示停用按钮）。

**#57** 器材类型创建时必须选择颜色（红、蓝、绿、黄、紫、橙、青），默认蓝色。

**#58** 订单项目添加时下拉菜单显示格式为"项目名称 - 价格元"（如"休1 - 90元"）。

**#59** 创建订单页"选择项目"下拉菜单：船型与销售项目混合，按近 7 日销售数量降序排列，销量相同按名称升序。

**#60** 「添加调整项」金额限定为正数（最小 0.01 元），分收费/退款两个 Tab，数量不允许负数（最小 1，默认 1）。**覆盖 V1 §15.4 的 `quantity != 0`**——改为数量必须为正，正负由 Tab 决定。

**#61** 数据定期自动导出仅在开关开启时执行，每天 00:00 Asia/Shanghai 自动导出过去 24 小时的数据为 CSV。

**#62** 订单/客户自动导出开关独立（`auto_export_orders_enabled` / `auto_export_customers_enabled`），默认关闭。

**#63** 数据导出 B 列为"微信昵称"（取订单快照 `customer_wechat_nickname`，空则留白）；三处订单导出格式一致。

**#64** 三处订单导出 CSV 在 F 列"创建时间"后有 G 列"散客"（勾选写"散客"，未勾选留空），公共列 A–M。

**#65** 订单备注气泡提示：勾选后打开订单时弹出备注对话框，列表中客户名显示为红色。

**#66** 订单管理"预订"tab 迟到标红：active 订单开始时间早于当前时间超过 30 分钟时，时间文字用红色显示。

**#67** 订单管理"全部"tab 语义：只显示从明日开始往后、状态为"预订"的订单。

**#68** 点击"订单管理"按钮时始终刷新为"预订"tab 第一页最顶端。

**#69** 手机版订单列表点击客户区域复制微信昵称到剪贴板，点时间/项目区域进入订单详情。

**#70** 极速客户模式下粘贴按钮仅在系统设置开启时显示，iOS 强制弹出 Paste 授权气泡。
