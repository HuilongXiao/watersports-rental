# DISTILL_RAW — rental-app 项目全部已确认信息汇总

> 提取自项目从 2026-09-27 到 2026-10-12 的全部对话记录。
> 生成时间：2026-10-12
> 当前系统版本：v1.1.8

---

## 1. 已确认的业务规则（Business Rules）

### 1.1 订单生命周期

1. 订单只有一个实体 `Order`，不区分 reservation/walk-in 为独立实体；系统不根据 `start_at` 推断订单类型分支
2. 订单状态流转：active（预订）→ in_progress（进行中，已签到）→ completed（已完成）；active 可转 cancelled（取消）/ no_show（爽约）；cancelled/no_show/completed 可恢复为 active
3. 签到时间可以早于订单开始时间，但不可早于开始时间超过 1 小时；超过时提示"签到时间不能早于订单开始时间超过1小时"
4. 自动归还规则：每次签到（含取消签到后重新签到）都会重置计时，以最后生效的签到时间为准，在 `auto_return_after_minutes`（默认 120 分钟/2 小时）后执行；不受历史取消签到/取消归还影响
5. 自动归还操作必须由 System User（`is_system=True`）执行
6. 每日 23:59 Asia/Shanghai 执行强制归还任务（兜底处理所有未归还的活跃订单）
7. 订单使用时长计算：有签到时间时为归还时间减签到时间；无签到时间时默认按 2 小时计算；格式为"X小时Y分"（如 1小时45分，不足 1 小时仅"Y分"，未归还显示"—"）
8. 订单创建后客户信息不可修改（任何状态）：前端编辑已有订单时客户字段全部禁用（不灰显、保持原色、仅阻断交互）；后端校验 customer_id / 昵称 / 姓名回退 / is_walk_in 与原值不一致均返回 409

### 1.2 进行中订单编辑规则

9. 进行中订单（已签到）器材项目不可增删改（后端校验 `equipment_spec_id+quantity` 必须与原订单一致，否则 409），仅可添加或调整销售项目
10. 进行中订单已保存的销售项目不可编辑/删除，仅可添加新销售项目（前端通过 `isOriginal` 标记区分）
11. 进行中订单编辑时备注区域可编辑（备注输入框和气泡勾选框不禁用）
12. 终态订单（completed/cancelled/no_show）完全锁定，不可编辑
13. 进行中订单"编辑"按钮显示条件：`order.editable || order.status === 'in_progress'`
14. 进行中订单"+"号在项目表头右侧始终显示，点击新增行仅显示销售项目选项

### 1.3 容量与人数校验

15. 订单总承载人数上限为所选所有器材座位数与数量的乘积之和（如 2 条 2 座 + 1 条 3 座 = 7 人）
16. 成人数量上限为所选器材数量乘以 2（每个器材最多 2 名成人）
17. 至少需要 1 人，至少 1 名成人
18. 桨板型规格（`capacity=NULL`）不参与承载人数计算

### 1.4 客户规则

19. 客户 profile 创建/编辑保存仅要求姓名或微信昵称至少有一项；手机号、微信 ID 均为独立选填项
20. `customers` 表 CHECK 约束允许四种合法形态：name+phone、wechat_nickname+wechat_id、仅 name、仅 wechat_nickname
21. 极速客户模式下创建订单仅显示"客户微信昵称"输入框；输入昵称与同 Group 已有客户 `wechat_nickname` 完全相同则并入该客户，否则创建仅有 `wechat_nickname` 的客户
22. 当客户备注(note)为空时，提醒(remind)自动设为 false
23. 客户创建订单时，若该客户 remind=true 且有 note，系统弹出提示显示备注内容
24. 系统客户"游客"永远在客户管理列表置顶，不可删除、不可编辑
25. 订单 API 入参 `customer_name` 字段保留作为旧客户端兼容回退（按 name 去重复用）

### 1.5 库存与船只用量计算

26. 预订（active）订单拆为"预留时间"buffer [start-90min, start) 和"使用时间"usage [start, start+2h)
27. 进行中（in_progress）订单从签到时间起占 4 格（签到在半点格前 15 分钟）或 5 格（后 15 分钟），向后 2 小时
28. 已完成（completed）订单：有签到则按实际使用时长（归还-签到，向上取整到半小时）；无签到直接归还则按订单开始→结束时间
29. 已完成订单计入"已使用"桶，按签到时间（无签到回退订单开始时间）落入，与进行中同一颜色
30. 预留/使用配对去重规则：当某条船的使用时间与另一订单的预留时间重叠、且使用结束时间 ≤ 该订单开始时间时，重叠时段只计 1 条船；配对时必须检查槽位实际相交（2026-10-11 修复）
31. 过去时段（槽结束时间 ≤ 当前时间）不显示 buffer 占用，只显示 usage；配对去重也只在 buffer 可见时段生效
32. 预测页仅显示 `is_active=true` 的器材规格
33. 预测页可使用船只数量 = 船只总量 - 被占用的船只数量
34. 创建订单时船只超售提示所依据的船只使用数量，直接遵循"船只用量"的目标时段船只用量计算逻辑
35. 下单保存前必须先做库存冲突预检（POST /api/orders/conflicts），仅预警不阻断
36. 库存冲突预检与预测页同口径（buffer_cutoff 传入 check_order_conflicts，编辑历史订单不传 cutoff 保持全窗口物理口径）

### 1.6 权限与可见性

37. 功能 Tab 仅对有权限的操作员显示（无权限则不显示）
38. 数据备份 Tab 仅 superuser 可见
39. 数据导出 Tab 仅 superuser、admin 或被赋予 export_report 权限的 user 可见
40. 用户管理 Tab 仅 superuser、admin 或被赋予 manage_users 权限的 user 可见
41. Group 管理 Tab 仅 superuser 可见
42. 器材目录、售卖项目、系统设置 Tab 对所有人可见
43. 非 superuser 用户看不到 superuser 账号
44. 新增 `perm_view_revenue` 权限位，控制营业额查看权限
45. 删除订单、删除客户 profile 为 superuser 专属权限（403 for admin/user）
46. 删除订单为永久删除并显式按序级联：支付调整项→支付记录→订单项目→订单
47. 删除客户 profile：系统客户"游客"返回 409；客户仍有关联订单时返回 409 提示先删订单

### 1.7 时间与显示格式

48. 系统中所有时间显示只到分钟（不显示秒）：前端 formatDateTime 为 YYYY-MM-DD HH:mm
49. 订单管理列表开始时间显示格式为 MM-DD HH:mm（不含年份和秒）
50. 时间选择器以 15 分钟为间隔
51. 时间选择器点击时间数字弹出 5×6 网格选择器（05:30–20:00，30 分钟间隔）
52. 新建订单默认开始时间为当前时间向上取整到下一个 15 分节点（秒/毫秒清零）
53. 日期/时间/数量调整使用 [−][值][+] 步进按钮形式
54. 成人数/儿童数使用步进按钮，0 时减号禁用（不可为负）
55. 订单页面操作按钮文本：编辑订单→编辑、标记爽约→爽约、取消订单→取消（签到、归还保持不变）

### 1.8 其他业务规则

56. 器材规格/售卖项目的停用开关位于编辑弹窗内（列表操作列不显示停用按钮）
57. 器材类型创建时必须选择颜色（红、蓝、绿、黄、紫、橙、青），默认蓝色
58. 订单项目添加时下拉菜单显示格式为"项目名称 - 价格元"（如"休1 - 90元"）
59. 创建订单页"选择项目"下拉菜单：船型与销售项目混合，按近 7 日销售数量降序排列，销量相同按名称升序
60. 「添加调整项」金额限定为正数（最小 0.01 元），分收费/退款两个 Tab，数量不允许负数（最小 1，默认 1）
61. 数据定期自动导出仅在开关开启时执行，每天 00:00 Asia/Shanghai 自动导出过去 24 小时的数据为 CSV
62. 订单/客户自动导出开关独立（`auto_export_orders_enabled` / `auto_export_customers_enabled`），默认关闭
63. 数据导出 B 列为"微信昵称"（取订单快照 `customer_wechat_nickname`，空则留白）；三处订单导出格式一致
64. 三处订单导出 CSV 在 F 列"创建时间"后有 G 列"散客"（勾选写"散客"，未勾选留空），公共列 A–M
65. 订单备注气泡提示：勾选后打开订单时弹出备注对话框，列表中客户名显示为红色
66. 订单管理"预订"tab 迟到标红：active 订单开始时间早于当前时间超过 30 分钟时，时间文字用红色显示
67. 订单管理"全部"tab 语义：只显示从明日开始往后、状态为"预订"的订单
68. 点击"订单管理"按钮时始终刷新为"预订"tab 第一页最顶端
69. 手机版订单列表点击客户区域复制微信昵称到剪贴板，点时间/项目区域进入订单详情
70. 极速客户模式下粘贴按钮仅在系统设置开启时显示，iOS 强制弹出 Paste 授权气泡

---

## 2. 已确认的产品功能与范围（PRD 相关）

### 2.1 核心功能模块

71. 客户管理：列表（微信昵称、姓名、操作）、详情页（关联订单、累计消费、爽约次数）、编辑、导出
72. 订单管理：创建、编辑、签到、归还、取消、爽约、删除（superuser）；列表分预订/进行中/全部三个 tab
73. 工作台（Dashboard）：船只用量（横向条形图）、订单分布、今日概况、每日概况独立页面
74. 船只用量预测页（/dashboard/forecast）：日期选择器 + SpecSelector + 横向条形图，桌面版左右两列
75. 船只用量详情页（/dashboard/order-distribution）：日期选择器 + 订单分布详情
76. 每日概况页（/dashboard/daily-summary）：日期选择器 + 船型使用/销售项目/其他调整项三个表格 + 总收款
77. 器材目录管理：器材类型（带颜色）、规格（带价格/容量/数量/排序），停用/启用
78. 售卖项目管理：名称、价格、停用/启用
79. 系统设置：极速客户模式开关、自动导出开关、系统版本号显示
80. 数据备份：创建/下载/恢复/删除备份（仅 superuser）
81. 数据导出：手动订单导出、手动客户导出、按客户 ID 导出订单、每日自动导出
82. 用户管理：创建/编辑用户、权限分配、停用/启用
83. Group 管理：创建 Group 和 Group manager（仅 superuser）
84. superuser 切换 Group：右上角菜单，切换后所有数据按所选 Group 过滤
85. 更改密码：右上角用户菜单

### 2.2 前端页面路由

86. `/orders` — 订单管理
87. `/orders/new` — 创建订单
88. `/orders/:id` — 订单详情
89. `/customers` — 客户管理
90. `/customers/:id` — 客户详情
91. `/dashboard` — 工作台
92. `/dashboard/forecast` — 船只用量预测
93. `/dashboard/order-distribution` — 船只用量详情
94. `/dashboard/daily-summary` — 每日概况
95. `/settings` — 目录与设置

### 2.3 移动端适配

96. 手机端使用底部 Tab 栏 + 悬浮按钮布局；电脑端使用侧边栏导航
97. 手机端页面禁用缩放（viewport maximum-scale=1.0, minimum-scale=1.0, user-scalable=no）
98. 手机端 CSS 设置 touch-action: pan-x pan-y 禁止双指缩放
99. 手机端输入框强制 16px 字号
100. 手机端功能选择区采用内部滚动架构（100dvh 高度锁定）
101. 手机端创建订单页面拆分日期和时间为独立选择器
102. 手机端订单项目表格隐藏"单价"和"小计"列，数量列使用 [−]数字[+] 步进按钮
103. 手机端订单管理列表项目列仅展示船型，隐藏销售项目
104. 手机端订单管理列表客户名称超 7 个汉字时截断 + 省略号
105. 手机版目录与设置：各设置项竖排列表，点击进入独立子页面
106. PWA 支持：manifest.json、apple-touch-icon.png、apple-mobile-web-app 元标签

---

## 3. 已确认的技术选型与架构（Architecture 相关）

107. 后端：FastAPI + SQLAlchemy 2.0 + SQLite，监听 8000 端口
108. 前端：React 18 + TypeScript + Ant Design 5 + Vite
109. 部署：单容器（Dockerfile.allinone），FastAPI 同时提供网页和 API
110. 容器启动时自动执行数据库迁移（启动迁移自动加列）
111. Docker Compose 双容器开发模式（backend + frontend），生产用 allinone 单容器
112. Docker Compose 卷挂载：`./data:/app/data`、`./backups:/app/backups`、`./exports:/app/exports`
113. 容器端口映射：本地 6688 → 容器 8000
114. 容器需启用自动重新启动
115. 定时任务通过 scheduler.py 的 asyncio 后台任务实现（每 60 秒扫描超时订单）
116. 后端为业务校验唯一来源，前端校验仅为用户体验
117. 前后端双重校验模式：前端 disable + 后端 409
118. tar 部署规范：Dockerfile.allinone 构建，tag 和文件名必须带版本号
119. 容器环境变量：SESSION_SECRET（随机英文数字）、SESSION_COOKIE_SECURE=false、INITIAL_ADMIN_USERNAME=superuserx、INITIAL_ADMIN_PASSWORD=123456、SEED_DEFAULT_DATA=false、TZ=Asia/Shanghai（已内置）
120. 初始管理员凭据统一为 superuserx / 123456
121. GitHub 源仓库：https://github.com/HuilongXiao/rental-app-cursor-validation

---

## 4. 已确认的数据实体与字段（ER Model 相关）

### 4.1 核心模型

122. **Order**：id, order_number, group_id, customer_id, customer_name（快照）, customer_gender（快照）, customer_wechat_nickname（快照）, customer_wechat_id（快照）, customer_phone（快照）, status, start_at, end_at, adult_count, child_count, note, is_walk_in, note_popup, check_in_at, check_in_by_user_id, return_at, returned_by_user_id, auto_return_after_minutes, auto_return_at, auto_return_occurred, daily_forced_return_occurred, auto_return_due_at, created_by_user_id, updated_by_user_id, created_at, updated_at
123. **OrderItem**：id, order_id, equipment_spec_id, sale_item_id, quantity, unit_price, created_by_user_id, updated_by_user_id
124. **Customer**：id, name, gender, wechat_nickname, wechat_id, phone, is_system, note, remind, group_id, created_by_user_id, updated_by_user_id, created_at, updated_at
125. **EquipmentType**：id, name, color, group_id
126. **EquipmentSpec**：id, equipment_type_id, name, price, capacity, sort_order, is_active, group_id, sold_quantity_7d（计算字段）
127. **SaleItem**：id, name, price, is_active, group_id, sold_quantity_7d（计算字段）
128. **InventoryConfiguration**：id, equipment_spec_id, total_quantity, group_id, updated_by_user_id
129. **User**：id, username, display_name, password_hash, role, is_active, is_system, group_id, perm_create_order, perm_edit_order, perm_export_report, perm_manage_users, perm_view_revenue, created_at
130. **Group**：id, name, is_active, created_at
131. **Setting**：id, group_id, auto_return_after_minutes, fast_customer_mode, auto_export_orders_enabled, auto_export_customers_enabled

### 4.2 Group 隔离

132. 所有用户创建的数据都必须有 group_id（订单/客户/用户/器材类型/规格/售卖项目/库存配置/设置）
133. payments 与 order_items 通过所属订单继承 Group，无独立查询路径，不冗余存储
134. 不同 Group 之间允许出现同名内容（客户手机号/微信 ID/器材/售卖项目）
135. 用户名 username 和 Group 名称保持全局唯一（登录身份/租户标识，属刻意例外）
136. 用户名不区分大小写、忽略首尾空格（LOWER + trim 匹配，存储保留原始大小写）
137. 系统客户"游客"归入默认 Group

### 4.3 数据库约束

138. customers 表 CHECK 约束允许四种合法形态
139. 客户手机号/微信 ID 唯一性按 Group 隔离（索引 uq_customers_group_phone / uq_customers_group_wechat）
140. orders 表新增 is_walk_in、note_popup 字段（启动迁移自动加列）
141. EquipmentSpec 新增 sort_order 字段（启动迁移自动加列，默认 0）

---

## 5. 讨论过但最终否决的方案，以及否决原因

142. **os.environ.setdefault 设置测试数据库路径** — 否决原因：环境变量已存在时 setdefault 不生效，导致测试误连开发库并清空用户数据；改用 os.environ["DATABASE_URL"] = ... 强制赋值
143. **测试中使用 drop_all 并重建表** — 否决原因：清除开发库中的用户数据，无法恢复
144. **"未来订单"tab** — 否决原因：被"进行中"tab 替代，最终移除
145. **"活动中"状态名称** — 否决原因：全局统一更名为"预订"
146. **"库存配置"Tab** — 否决原因：已移除，器材数量改在器材目录规格编辑弹窗中设置
147. **"更改顺序"按钮及拖拽排序功能** — 否决原因：2026-10-08 移除，改用近 7 日销量排序；sort_order 字段与 reorder 接口后端保留但无 UI 入口
148. **"立即生成"自动导出按钮** — 否决原因：随 AutoExportCard 一并移除，/api/auto-exports/generate 端点已删除
149. **DailySummaryModal 弹窗** — 否决原因：2026-10-09 改为跳转独立页面 /dashboard/daily-summary
150. **"自动归还时限"信息项** — 否决原因：从详情页移除（auto_return_due_at 字段后端保留）
151. **"结束时间"信息项** — 否决原因：从订单详情页移除（end_at 字段后端保留）
152. **旧 auto_export_enabled 单字段** — 否决原因：拆分为 auto_export_orders_enabled 与 auto_export_customers_enabled 两个字段
153. **初始管理员凭据 admin/admin123** — 否决原因：2026-10-03 从 admin/admin123 改回 superuserx/123456
154. **预测页"全部"按钮** — 否决原因：2026-10-08 移除
155. **订单分布卡片"更多"按钮** — 否决原因：2026-10-08 移除
156. **手机端客户名 JS 截断函数 truncateByDisplayWidth** — 否决原因：改用 CSS -webkit-line-clamp 自适应截断
157. **船只用量预测页 buffer 2 小时** — 否决原因：改为 1 小时 30 分（BUFFER_MINUTES=90）
158. **配对去重不检查槽位重叠** — 否决原因：历史已完成订单浪费配对名额导致当天占用多计 1（2026-10-11 修复）

---

## 6. 仍未解决的问题 / 待确认事项

159. [待确认] NAS 生产库是否仍存在误建的 "false" 超管账号 — 本地已删除，NAS 需单独处理
160. [待确认] 是否需要在前端添加"删除用户"功能 — 目前 users API 无 delete 端点，仅支持停用
161. [待确认] 系统是否需要支持多语言（目前仅中文）
162. [待确认] 是否需要数据保留策略（自动清理过期备份/导出文件）
163. [待确认] 容器健康检查和监控告警是否需要增强
164. [待确认] 是否需要支持 HTTPS 部署（目前局域网 http，粘贴按钮需特殊处理）
165. [待确认] 是否需要更完善的审计日志（目前仅记录 created_by/updated_by）

---

## 统计

- 已确认的业务规则：70 条（#1–#70）
- 已确认的产品功能与范围：35 条（#71–#106）
- 已确认的技术选型与架构：15 条（#107–#121）
- 已确认的数据实体与字段：44 条（#122–#141）（含模型定义和 Group 隔离约束，实际编号到 #141）
- 讨论过但最终否决的方案：17 条（#142–#158）
- 仍未解决的问题 / 待确认事项：7 条（#159–#165）
- **合计：188 条**
