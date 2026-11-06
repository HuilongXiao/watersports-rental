# 发布说明 · watersports-rental 1.1.12

- 发布日期：2026-10-16
- 镜像：`watersports-rental:1.1.12`
- 交付文件：`watersports-rental_1.1.12_20261016.tar`（约 70 MB，单镜像 all-in-one，前端+后端合并）

---

## 一、本次更新内容

### 1. Group（多公司）数据彻底隔离
本次核心目标是确保每个 group 互相看不到、也改不动对方的任何数据，同时允许**不同 group 之间存在同名内容**。

- **器材目录唯一约束改为 group 作用域**：`equipment_types`、`equipment_specs`、`sale_items` 三张表原先的"全局唯一"会导致 A 公司建了「皮划艇」后，B 公司就无法再建同名类型。现改为按 `(group_id, ...)` 联合唯一 —— 跨 group 可同名，同 group 内仍保持唯一。
- **器材目录接口增加归属校验**：创建/更新器材类型、规格、售卖项时校验归属，非本 group 的数据操作直接拒绝（403）。
- **支付方式（PaymentMethod）按 group 隔离**：
  - 新增 `group_id` 列，唯一约束改为 `(group_id, code)`；
  - 支付方式的查看、新增、修改、删除、下单校验全部按当前 group 过滤；
  - 前端支付方式操作的标识由 `code` 改为 `id`，避免不同 group 同名 code 造成歧义；
  - **新建 group 时自动初始化一条「现金」默认支付方式**，保证新公司开箱即可下单。
- **启动自动迁移（幂等）**：容器每次启动自动完成上述约束与数据的升级，无需人工干预：
  - 清理旧的全局唯一索引，改建 group 作用域唯一索引；
  - 存量支付方式归属到第一个 group，并为没有支付方式的 group 自动补齐「现金」；
  - 若检测到**同一个 group 内存在同名脏数据**，仅打印告警并跳过建索引，**不会导致容器启动失败**（见下方"部署前检查"）。

### 2. 修复：新建 group 报 500 的问题
数据库历史上遗留了一个已废弃的列 `settings.auto_export_enabled`（NOT NULL 且无默认值），导致新建 group 时写入设置失败。现启动迁移会自动删除该遗留列，问题消除。

### 3. 设置页新增「前端调试上报」开关
在「设置 → 数据备份」顶部新增可视化开关，替代原先通过 URL 参数 `?tracing=1` 的开启方式。原因是 iOS「添加到主屏幕」生成的 PWA 图标使用独立的 localStorage 命名空间，URL 参数方式在 PWA 内不生效；改为设置页开关后，可在对应实例内直接读写，稳定可用。

---

## 二、NAS 部署步骤

1. 将 `watersports-rental_1.1.12_20261016.tar` 上传到 NAS，导入镜像：

   ```bash
   docker load -i watersports-rental_1.1.12_20261016.tar
   ```

2. 用随附的 `docker-compose.nas.yml` 替换旧文件（image 已指向 `watersports-rental:1.1.12`），或直接修改旧 compose 中的镜像版本号。

3. 重建容器：

   ```bash
   docker compose -f docker-compose.nas.yml up -d
   ```

4. 浏览器访问 `http://<NAS-IP>:6688`，确认服务正常。

### 需要用户填写的环境变量（仅两项）

| 变量 | 说明 |
|------|------|
| `SESSION_SECRET` | **必填**，填写一段随机长字符串；留空则使用内置默认值（仅建议测试时）。 |
| `SUPERUSER_PASSWORD_RESET` | 仅忘记超级管理员密码时使用：取消注释设为新密码，启动一次后**务必再注释掉**，避免每次重启都重置。 |

> 其余默认值（数据库路径、备份/导出/日志目录、时区、初始管理员账号 superuserx / 123456）均已内置，无需配置。
> 初始管理员账号 `superuserx / 123456` 仅在首次建库时生效，登录后请及时修改密码。

---

## 三、NAS 挂载对应关系

| 宿主机目录 | 容器路径 | 内容 |
|-----------|---------|------|
| `./data` | `/app/data` | SQLite 数据库 `rental_app.db` 及日志目录 `data/logs/`（后端请求耗时日志、前端上报日志，按天生成，保留 30 天） |
| `./backups` | `/app/backups` | 数据库手动/自动备份 |
| `./exports` | `/app/exports` | 每日 00:00 自动导出的订单 CSV |

- 端口映射：`6688 → 8000`
- 容器名：`rental-app`

---

## 四、部署前检查（重要）

若 NAS 上的数据库在升级前**同一 group 内**已存在同名脏数据，group 作用域唯一索引将无法建立（容器仍能正常启动，但仅打印告警）。建议部署前先执行以下 SQL 检查，如返回结果则手动合并/删除重复项后，再重启容器：

```sql
-- 同一 group 内的同名器材类型
SELECT group_id, name, COUNT(*) FROM equipment_types
WHERE name IS NOT NULL AND name != ''
GROUP BY group_id, name HAVING COUNT(*) > 1;

-- 同一 group 内的同名售卖项
SELECT group_id, name, COUNT(*) FROM sale_items
WHERE name IS NOT NULL AND name != ''
GROUP BY group_id, name HAVING COUNT(*) > 1;

-- 同一 group + 同一器材类型下的同名规格
SELECT group_id, equipment_type_id, name, COUNT(*) FROM equipment_specs
WHERE name IS NOT NULL AND name != ''
GROUP BY group_id, equipment_type_id, name HAVING COUNT(*) > 1;
```

均为空则无需处理，可直接部署。
