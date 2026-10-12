# Rental App — 产品需求文档（PRD）

## 1. 产品概述

Rental App 是供皮划艇、桨板等水上器材租赁业务内部操作员使用的 Web 管理系统。V1 预计供 2–5 名工作人员使用，第一版运行在 Synology NAS Docker 中。V1 不提供客户自助预订。（HTTPS 远程访问为 V1 目标，当前尚未实现，详见 DECISIONS_LOG #164。）

核心流程：

```text
登录 → Customer → Order → Check-in → Inventory → Return → Payment
```

## 2. 产品原则

- 一次交易只有一个 `Order`。
- Reservation 和 Walk-in 只是自然语言描述，不是订单类型或独立实体。
- Backend 是业务规则最终权威，Frontend 校验不能替代 Backend 校验。
- 优先保证日常操作简单、数据一致和可恢复。
- V1 不加入 Boat、BoatAssignment 或客户实际使用状态字段。

## 3. 用户和模块

用户是内部操作员/管理人员。V1 不实现角色权限矩阵；正常用户拥有相同功能权限。System User 只用于自动操作，不能普通登录。

V1 模块：Login、Dashboard、Customer、Order、Check-in、Return、Payment、Equipment、Inventory、Settings，以及不影响核心进度时的 Backup/Restore。

## 4. Login 和 Customer

Login 支持 username、password 和失败提示。inactive 用户不能登录，密码只能保存安全 hash。

Customer 支持 name、gender、WeChat nickname、WeChat ID、phone；独立 Customer 至少满足 `name + phone` 或 `wechat_nickname + wechat_id`。采用简单候选搜索，由操作员确认，不要求模糊、拼音、AI 匹配或自动合并。创建 Order 时保存 Customer 快照。

## 5. Order

操作员可以选择 Customer、start date、start time、成人数、儿童数、OrderItem 和 note。系统自动计算：

```text
end_at = start_at + 2 hours
```

OrderItem 可以是 EquipmentSpec 或普通 SaleItem。创建时复制目录价格作为 `unit_price` 快照。Check-in 后 OrderItems 锁定；如需修改，必须在允许时取消 Check-in 后再修改。

V1 status 只有 `active`、`cancelled`、`no_show`、`completed`。

## 6. 当天操作规则

业务时区是 `Asia/Shanghai`。

- 过去日期订单：不显示 Check-in/Return，Backend 拒绝请求。
- 当天订单：在其他规则允许时显示并允许操作。
- 未来日期订单：不显示 Check-in/Return，Backend 拒绝请求。

Check-in 和 Return 时间由系统在按钮操作时取得，操作员不能输入时间。

## 7. Check-in、Return 和库存

当天且符合条件的 active Order 可以 Check-in。成功后保存时间和操作员、锁定 OrderItems、占用 EquipmentSpec 库存并启动 Auto Return。

如果库存不足，系统显示清晰警告，但 V1 不强制阻止 Check-in；操作员确认后仍可完成。

有 Check-in 的 Return 将 Order 设为 completed 并释放库存。没有 Check-in 的直接 Return 也可在规则允许时执行，不改变库存，且 Return 时间至少为 `start_at + 1 minute`。V1 不设置客户是否仍在使用设备的字段。

## 8. Auto Return 和 Daily Forced Return

Auto Return 是库存保护机制。Check-in 时复制 Auto Return 配置；到期且无有效 Return 时，系统使用 System User 完成 Order 并释放库存。Auto Return 后可以进行人工 Return 修正，修正使用当前系统时间并保持 Order、Return、Auto Return 和库存一致。

Daily Forced Return 是跨午夜库存安全机制，每天 `23:59:01–23:59:59`（Asia/Shanghai）处理仍 Check-in 且无有效 Return 的订单，使用 System User、释放库存并完成订单。两种机制独立。

## 9. Payment

Payment 不表示“已经收到多少钱”，也不记录已付款/未付款、支付方式、支付渠道或客户支付账户。

Payment 根据 OrderItem 计算普通订单金额：

```text
OrderItem amount = unit_price × quantity
```

一个 Payment 可以有多条“其他”调整。系统中“其他”没有子分类，也不是普通 `SaleItem`。每条“其他”只需要：

- 数量 `quantity`；
- 金额 `unit_amount`（UI 可直接显示为“金额”）；
- 必填 `note`，由操作员说明退款、折扣、临时性收款、附加费、修正或其他原因。

该条调整金额为：

```text
PaymentItem.amount = quantity × unit_amount
```

最终 Payment.amount 为：

```text
Payment.amount
= SUM(OrderItem.unit_price × OrderItem.quantity)
+ SUM(PaymentItem.amount)
```

正数增加最终金额，负数减少最终金额。PaymentItem 创建后不可修改，更正通过新增“其他”调整完成。completed、cancelled、no-show 订单仍可增加调整。最终金额和所有明细必须可以查询，用于后续统计分析。

## 10. Equipment、Inventory 和 Settings

支持 EquipmentType、EquipmentSpec、SaleItem 目录、价格、capacity、active 状态和每个 EquipmentSpec 的运营库存。库存按：

```text
available = operational inventory - occupied quantity
```

实时计算。未来订单不占用库存。Order duration 固定为 2 hours；数据库时区固定 UTC；业务时区固定 Asia/Shanghai；Daily Forced Return 时间固定。

## 11. Backup / Restore

如果实现 Backup/Restore，至少应保证 SQLite 数据库位于 persistent volume，并能够实际备份和恢复。复杂云备份留到后续版本。

## 12. V1 非目标

V1 不包含：

- Boat、BoatAssignment、具体船号管理；
- Reservation、Walk-in、ActualUsage、独立 Check-in/Return 表；
- 客户账号、自助预订、在线支付、微信登录和小程序；
- ~~角色权限、多门店~~（已实现，见 §14.1 #82/#83）、复杂会计、支付网关；
- Payment 子分类、已付款状态、支付方式；
- 库存调整历史、完整 audit log、高级 BI、预测和 AI 推荐。

## 13. 验收场景

验收场景详见 `BUSINESS_RULES.md` §20（Scenario A–G），此处不再重复。

详细业务规则以 `BUSINESS_RULES.md` 为准，数据结构以 `ER_MODEL.md` 为准，技术边界以 `ARCHITECTURE.md` 为准。

---

## 14. V1.1+ 产品功能演进（2026-09-27 至 2026-10-12）

> 以下内容在实际开发迭代中确认，覆盖上方 V1 PRD 中冲突的条款。编号对应 DISTILL_RAW.md。

### 14.1 核心功能模块

**#71** 客户管理：列表（微信昵称、姓名、操作）、详情页（关联订单、累计消费、爽约次数）、编辑、导出。**覆盖 V1 §4 的简单候选搜索**——已实现搜索+确认+极速模式。

**#72** 订单管理：创建、编辑、签到、归还、取消、爽约、删除（superuser）；列表分预订/进行中/全部三个 tab。**覆盖 V1 §5 的 4 状态**——新增 in_progress 状态。

**#73** 工作台（Dashboard）：船只用量（横向条形图）、订单分布、今日概况、每日概况独立页面。**新增**——V1 未规划 Dashboard 的具体模块。

**#74** 船只用量预测页（/dashboard/forecast）：日期选择器 + SpecSelector + 横向条形图，桌面版左右两列。**新增**——V1 未规划此页面。

**#75** 船只用量详情页（/dashboard/order-distribution）：日期选择器 + 订单分布详情。**新增**。

**#76** 每日概况页（/dashboard/daily-summary）：日期选择器 + 船型使用/销售项目/其他调整项三个表格 + 总收款。**新增**——取代原 DailySummaryModal 弹窗。

**#77** 器材目录管理：器材类型（带颜色）、规格（带价格/容量/数量/排序），停用/启用。**扩展 V1 §5**——增加颜色、数量、排序字段。

**#78** 售卖项目管理：名称、价格、停用/启用。

**#79** 系统设置：极速客户模式开关、自动导出开关、系统版本号显示。**新增**——V1 未规划极速模式和自动导出。

**#80** 数据备份：创建/下载/恢复/删除备份（仅 superuser）。**扩展 V1 §11**——已完整实现。

**#81** 数据导出：手动订单导出、手动客户导出、按客户 ID 导出订单、每日自动导出。**新增**——V1 未规划。

**#82** 用户管理：创建/编辑用户、权限分配、停用/启用。**覆盖 V1 §3 的"无角色权限矩阵"**——已实现 superuser/admin/user 三级 + 5 个权限位。

**#83** Group 管理：创建 Group 和 Group manager（仅 superuser）。**覆盖 V1 §12 的"不包含多门店"**——已实现 Group 多租户隔离。

**#84** superuser 切换 Group：右上角菜单，切换后所有数据按所选 Group 过滤。**新增**。

**#85** 更改密码：右上角用户菜单。**新增**。

### 14.2 前端页面路由

**#86** `/orders` — 订单管理
**#87** `/orders/new` — 创建订单
**#88** `/orders/:id` — 订单详情
**#89** `/customers` — 客户管理
**#90** `/customers/:id` — 客户详情
**#91** `/dashboard` — 工作台
**#92** `/dashboard/forecast` — 船只用量预测
**#93** `/dashboard/order-distribution` — 船只用量详情
**#94** `/dashboard/daily-summary` — 每日概况
**#95** `/settings` — 目录与设置

### 14.3 移动端适配

**#96** 手机端使用底部 Tab 栏 + 悬浮按钮布局；电脑端使用侧边栏导航。**新增**——V1 未规定具体布局。

**#97** 手机端页面禁用缩放（viewport maximum-scale=1.0, minimum-scale=1.0, user-scalable=no）。

**#98** 手机端 CSS 设置 touch-action: pan-x pan-y 禁止双指缩放。

**#99** 手机端输入框强制 16px 字号。

**#100** 手机端功能选择区采用内部滚动架构（100dvh 高度锁定）。

**#101** 手机端创建订单页面拆分日期和时间为独立选择器。

**#102** 手机端订单项目表格隐藏"单价"和"小计"列，数量列使用 [−]数字[+] 步进按钮。

**#103** 手机端订单管理列表项目列仅展示船型，隐藏销售项目。

**#104** 手机端订单管理列表客户名称超 7 个汉字时截断 + 省略号。

**#105** 手机版目录与设置：各设置项竖排列表，点击进入独立子页面。

**#106** PWA 支持：manifest.json、apple-touch-icon.png、apple-mobile-web-app 元标签。
