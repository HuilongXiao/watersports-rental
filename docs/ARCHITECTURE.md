# Rental App — 技术架构说明

## 1. 文档目的

本文档定义 Rental App V1 的技术架构边界、模块职责、数据访问方式、自动任务、部署方式和未来替换原则。

目标是：

1. 技术实现服从业务规则；
2. V1 足够简单，可以快速运行在 Synology NAS Docker 中；
3. 业务规则集中、清晰、可测试；
4. 前端、Backend、数据库职责清楚；
5. 未来迁移到云端时尽量保留业务模型和数据；
6. 不把 V1 绑定到 Boat、BoatAssignment 或客户在线预订等未来功能。

`BUSINESS_RULES.md` 是业务行为的最高权威，`PRD.md` 定义产品行为，`ER_MODEL.md` 定义逻辑数据模型。

## 2. V1 部署背景

V1 供 2–5 名内部操作员使用，运行在 Synology NAS 的 Docker 中，并需要通过互联网远程访问。

推荐部署边界：

```text
Browser
   ↓ HTTPS
安全的 Reverse Proxy / VPN / 访问控制
   ↓ 内部网络
Web Application Container
   ↓ 持久化 volume
SQLite Database
```

不能把未认证的 HTTP 容器直接暴露到互联网。具体采用 NAS Reverse Proxy、VPN、Tunnel 或其他访问方式，属于部署实施选择，但必须满足 HTTPS、认证、最小暴露面和定期备份要求。

## 3. 总体逻辑架构

V1 可以使用一个包含前端和 Backend 的 Web Application Container：

```text
Browser
   ↓ HTTPS / API
Web UI
   ↓
API / Application Services
   ↓
Business Rules / Domain Logic
   ↓
Repositories / Persistence
   ↓
SQLite
```

前后端也可以分离，但 V1 不要求为了“标准架构”增加多个 Container。对于初学者和 NAS 部署，单应用 Container 加一个持久化数据库 volume 通常更容易维护。

## 4. Frontend 职责

Frontend 负责：

- 页面展示和导航；
- 表单输入；
- 基础客户端校验；
- API 调用；
- loading、成功和错误提示；
- Dashboard、Customer、Order、Equipment/Inventory、Payment、Settings 页面；
- 根据订单业务日期显示或隐藏 Check-in/Return 按钮。

Frontend 不负责最终业务判断。按钮隐藏只是用户体验，不能代替 Backend 对过去、当天、未来日期、库存、状态、时间和权限的校验。

## 5. Backend 职责

Backend 是业务规则的最终权威层，负责：

- Authentication；
- User 和 System User；
- Customer；
- EquipmentType、EquipmentSpec、SaleItem；
- Inventory；
- Order 和 OrderItem；
- Check-in、Return、Auto Return、Daily Forced Return；
- Payment 和 PaymentItem；
- Settings；
- 业务验证、事务、状态转换、数据一致性和操作人记录；
- 定时任务。

V1 不实现 Boat、BoatAssignment、客户使用状态字段、客户在线预订或多门店。（**注**：多门店/Group 多租户已在 V1.1+ 实现，详见 §21 和 PRD §14.1 #83。）

## 6. Application Service

Application Service 负责组织一个完整业务操作，避免把规则分散到多个 API endpoint。

示例：

```text
create_order()
update_order()
cancel_order()
restore_order()
check_in_order()
cancel_check_in()
return_order()
cancel_return()
correct_return_after_auto_return()
update_inventory()
create_customer()
match_customer()
add_payment_adjustment()
```

### 6.1 Check-in 事务

```text
验证登录用户和订单
→ 验证订单为当天且状态允许
→ 验证 start_at、人数、EquipmentSpec 和 OrderItems
→ 计算库存并生成警告（不因不足而自动阻止）
→ 写入 Check-in 和操作人
→ 锁定 OrderItems
→ 保存 Auto Return 快照
→ 提交事务
```

### 6.2 Return 事务

```text
验证登录用户和订单为当天
→ 验证 Return 时间规则
→ 写入 Return 和操作人
→ 将订单设为 completed
→ 提交事务
```

### 6.3 Auto Return / Daily Forced Return

自动任务必须以事务执行，并且重复运行不能重复创建 Return。每次任务执行前都要重新读取订单并确认仍然符合条件。

## 7. Business Rules Layer

核心规则必须集中在 Backend 的业务层，包括：

- Order status 转换；
- 当天订单限制；
- Check-in 和 Return 时间；
- Customer 创建和匹配；
- Equipment capacity；
- Inventory 计算和不足警告；
- OrderItem 锁定；
- Auto Return 和 Daily Forced Return；
- Payment final amount 和不可变 adjustment。

API 应表达业务操作，而不是直接暴露任意数据库 CRUD。例如：

```text
POST /orders
POST /orders/{id}/check-in
POST /orders/{id}/cancel-check-in
POST /orders/{id}/return
POST /orders/{id}/cancel-return
POST /orders/{id}/return-correction
POST /orders/{id}/restore
POST /orders/{id}/payment-adjustments
```

前端不能直接执行类似 `UPDATE orders SET check_in_at = ...` 的操作。

> **注**：以上为 V1 示例端点。V1.1+ 已扩展 groups、users、auto-exports、orders/conflicts 等端点，详见 API 代码。

## 8. Persistence Layer

Persistence Layer 负责：

- 数据库连接；
- 查询和保存；
- Transaction；
- Migration；
- Index；
- Foreign Key、Unique 和基础 Check 约束。

Repository 可以负责 `find_order_by_id()`、`save_order()`、`get_inventory_configuration()` 等数据访问，但不应自行承担完整的 `check_in_order()` 业务流程。

## 9. Database

V1 使用 SQLite，原因是：

- 单店内部系统；
- 2–5 名操作员；
- 额外数据库服务更复杂；
- Docker 部署简单；
- 文件备份容易；
- 适合第一版验证真实业务。

SQLite 数据库必须放在 Docker persistent volume 中，不能只存在容器可写层。必须定期备份，并且实际测试 Restore。

SQLite 是 V1 的部署选择，不是永久锁定。未来并发量、门店数或云端要求增加时，可以迁移到 PostgreSQL 或云端托管数据库。

V1 核心实体以 `ER_MODEL.md` 为准：

```text
users
customers
equipment_types
equipment_specs
sale_items
inventory_configurations
orders
order_items
payments
payment_items
settings
groups          -- V1.1+ 新增，详见 ER_MODEL §20 #130
```

V1 不创建 `boats`、`boat_assignments`、`reservations`、`walk_ins`、`actual_usages`、`check_ins`、`returns` 或 `order_types` 表。

## 10. Database Integrity

适合由数据库保证：

- PK、FK；
- UNIQUE；
- NOT NULL；
- 基础 CHECK；
- 非负金额和数量；
- OrderItem 必须恰好引用 EquipmentSpec 或 SaleItem；
- 结构性关系。

适合由 Backend 保证：

- 当天 Check-in/Return；
- start_at、Check-in、Return 时间关系；
- Order status 转换；
- Capacity 组合；
- 库存不足警告；
- OrderItem 锁定；
- Auto Return 和 Daily Forced Return；
- Customer 规则；
- Payment adjustment 规则；
- 跨表业务流程。

## 11. Inventory Architecture

库存采用"运营总量配置 + 实时计算占用"的模式（V1.1+ 已演进为 buffer/usage/配对去重复杂逻辑，详见 BUSINESS_RULES §22.5 #26-#36）：

```text
available = operational_total - occupied
occupied = SUM(Equipment OrderItem.quantity)
           where effective Check-in exists
           and effective Return does not exist
```

未来订单不占用库存。SaleItem 不影响设备库存。库存不足时产生警告，但 V1 Check-in 仍可在操作员确认后成功。

## 12. Order、Check-in 和 Return Architecture

Order 有五种 status：`active`（预订）、`in_progress`（进行中）、`completed`（已完成）、`cancelled`（取消）、`no_show`（爽约）。V1 基线为 4 种（无 `in_progress`），V1.1+ 新增 `in_progress` 表示已签到但未归还，详见 BUSINESS_RULES §22.1 #2。

Check-in 不是独立实体，使用：

```text
orders.check_in_at
orders.check_in_by_user_id
```

Return 不是独立实体，使用：

```text
orders.return_at
orders.return_by_user_id
```

订单日期、当前时间以及每天 23:59 的判断必须使用 `Asia/Shanghai`。数据库 timestamp 使用 UTC。

过去日期和未来日期订单的 Check-in/Return 请求必须由 Backend 拒绝，即使客户端绕过 UI 直接调用 API。

> **V1.1+ 更新**：签到时间可早于 `start_at` 最多 1 小时（`check_in_at >= start_at - 1 hour`），详见 BUSINESS_RULES §22.1 #3。

V1 不保存客户是否仍在使用设备的字段。Auto Return 和 Daily Forced Return 只是库存保护与安全机制。

## 13. Automatic Operations

### 13.1 Auto Return

Check-in 时计算：

```text
auto_return_at = check_in_at + auto_return_after_minutes
```

定时任务查找仍有有效 Check-in、没有有效 Return、已到期且未处理的订单。任务使用 System User，释放库存，完成订单并记录 Auto Return 字段。

Auto Return 后的人工 Return 修正必须作为原子业务操作，按照最终业务规则更新 Return 和 Auto Return 字段。

### 13.2 Daily Forced Return

每天 Asia/Shanghai `23:59:01–23:59:59` 运行。查找仍有有效 Check-in 且没有有效 Return 的订单，使用 System User 执行 Return、释放库存、完成订单并设置 Daily Forced Return 标记。

它与 Auto Return 独立，不能因为同一订单已经由另一机制处理而重复创建 Return。

### 13.3 任务可靠性

- 定时任务必须支持重复执行而不产生重复结果；
- 任务执行失败时应记录错误并允许下一轮重试；
- 必须考虑 NAS 容器重启后任务继续运行；
- 生产环境必须有明确的 server timezone / application timezone 配置，但业务判断统一使用 `Asia/Shanghai`。

## 14. Authentication 和远程访问

Backend 负责用户名密码认证和 session/token 管理。密码使用安全 hash。inactive 用户不能登录。System User 不能普通登录。

NAS 远程访问至少需要：

- HTTPS；
- 强密码；
- 不暴露数据库端口；
- 不把 SQLite 文件映射为公网下载地址；
- 定期备份；
- 尽可能限制访问来源或使用 VPN/安全 Tunnel；
- 生产环境不使用默认密码和开发模式。

## 15. Time 和 Money

- 数据库时间统一 UTC；
- 业务时间统一 `Asia/Shanghai`；
- UI 显示业务本地时间；
- 金额统一使用整数分；
- 150 元保存为 15000；
- 禁止使用浮点数作为金额权威值。

## 16. Backup 和 Restore

V1 至少需要：

- 数据库 persistent volume；
- 可执行的数据库备份；
- 可执行的 Restore 流程；
- 在实际环境测试备份可用性。

备份不应只停留在“复制文件”的说明，还应明确备份位置、保留数量和恢复步骤。复杂云备份可以留到后续版本。

## 17. Cloud-ready 边界

未来迁移到云端时，优先替换部署和基础设施，不改变 V1 业务含义。以下部分必须保持可替换：

- Docker / 云端运行环境；
- SQLite / PostgreSQL 或云端数据库；
- authentication 实现；
- scheduled job runner；
- backup destination；
- Web server、HTTPS 和 reverse proxy；
- object/file storage（如果未来增加文件）。

V1 代码不能依赖 Synology 专用 API、固定 NAS 路径或某个云厂商专用服务。未来仍然只是内部员工使用时，不必现在提前加入客户账号、微信小程序、多门店或在线支付。（**注**：多门店/Group 多租户已在 V1.1+ 实现。）

## 18. 实现选择原则

架构不强制规定具体前端框架、Backend 框架、ORM、UI 组件库或 API 风格（**注**：V1.1+ 已确定选用 FastAPI + React + Ant Design + Vite，详见 §21 #107/#108）。选择开源基座时，必须检查：

- License 是否允许使用；
- 是否支持 Docker；
- 是否仍在维护；
- 登录和安全实现是否可靠；
- 数据库迁移是否清晰；
- 是否容易删去不需要的业务模块；
- 是否能实现本项目的当天操作、库存警告、自动任务和 Payment 明细。

不能因为基座已有 Reservation、Boat、Booking 或 Payment 状态，就强行把这些概念加入 V1。

## 19. V1 测试重点

至少测试：

- 过去、当天、未来日期的 Check-in/Return；
- start_at 和当前系统时间；
- 零库存时警告但允许 Check-in；
- Check-in、取消 Check-in、Return 的事务一致性；
- Auto Return 和 Daily Forced Return 的重复执行安全性；
- 跨午夜处理；
- Payment final amount 和不可变 adjustment；
- Customer 快照；
- SQLite 备份和 Restore；
- NAS 容器重启后定时任务继续运行。

## 20. V1 不是永久架构

V1 先选择能够在 NAS 上稳定运行、容易备份和容易理解的方案。真实使用一段时间后，再根据操作员数量、数据量、远程访问稳定性和云端需求决定是否迁移 PostgreSQL、云端 compute、托管 authentication 或其他服务。

---

## 21. V1.1+ 技术选型与架构演进（2026-09-27 至 2026-10-12）

> 以下内容在实际开发迭代中确认，覆盖上方 V1 架构中冲突的条款。编号对应 DISTILL_RAW.md。

**#107** 后端：FastAPI + SQLAlchemy 2.0 + SQLite，监听 8000 端口。**确定 V1 的"不强制规定具体框架"**——最终选用 FastAPI。

**#108** 前端：React 18 + TypeScript + Ant Design 5 + Vite。**确定 V1 的"不强制规定前端框架"**——最终选用 React + AntD。

**#109** 部署：单容器（Dockerfile.allinone），FastAPI 同时提供网页和 API。**确定 V1 的"单应用 Container"**——使用 Dockerfile.allinone 构建。

**#110** 容器启动时自动执行数据库迁移（启动迁移自动加列）。

**#111** Docker Compose 双容器开发模式（backend + frontend），生产用 allinone 单容器。

**#112** Docker Compose 卷挂载：`./data:/app/data`、`./backups:/app/backups`、`./exports:/app/exports`。

**#113** 容器端口映射：本地 6688 → 容器 8000。

**#114** 容器需启用自动重新启动。

**#115** 定时任务通过 scheduler.py 的 asyncio 后台任务实现（每 60 秒扫描超时订单）。**确定 V1 §13 的"scheduled job runner"**——使用 asyncio 而非外部 cron。

**#116** 后端为业务校验唯一来源，前端校验仅为用户体验。（与 V1 §4-5 一致）

**#117** 前后端双重校验模式：前端 disable + 后端 409。

**#118** tar 部署规范：Dockerfile.allinone 构建，tag 和文件名必须带版本号（rental-app:vX.Y.Z / rental-app-vX.Y.Z.tar）。

**#119** 容器环境变量：SESSION_SECRET（随机英文数字）、SESSION_COOKIE_SECURE=false、INITIAL_ADMIN_USERNAME=superuserx、INITIAL_ADMIN_PASSWORD=123456、SEED_DEFAULT_DATA=false、TZ=Asia/Shanghai（已内置）。

**#120** 初始管理员凭据统一为 superuserx / 123456。

**#121** GitHub 源仓库：https://github.com/HuilongXiao/rental-app-cursor-validation
