# Rental App

水上器材（皮划艇 / 桨板）租赁管理系统，供内部操作员管理客户、订单、签到、归还、库存和收款。

## 目标平台

- PC 浏览器（Chrome / Edge）
- iPhone Safari（PWA 模式，支持添加到主屏幕）
- Synology NAS Docker 单容器部署

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + TypeScript + Ant Design 5 + Vite |
| 后端 | FastAPI + Python + SQLAlchemy 2.0 |
| 数据库 | SQLite |
| 部署 | Docker（Dockerfile.allinone 单容器） |

## 本地启动

```bash
# 克隆仓库
git clone <repo-url> && cd rental-app

# 使用 Docker Compose 一键启动（后端 8000 + 前端 8080）
docker compose up -d --build

# 访问
# 前端: http://localhost:8080
# 后端 API: http://localhost:8000
# 默认管理员: superuserx / 123456
```

## 文档地图

所有文档位于 `docs/` 目录下：

| 文件 | 作用 |
|---|---|
| `BUSINESS_RULES.md` | 业务规则权威文档（V1 基线 + V1.1+ 演进规则） |
| `PRD.md` | 产品需求文档（功能范围、模块、路由、移动端适配） |
| `ARCHITECTURE.md` | 技术架构说明（分层、部署、定时任务、云端迁移边界） |
| `ER_MODEL.md` | 数据模型定义（表结构、字段、约束、Group 隔离） |
| `DECISIONS_LOG.md` | 已否决方案记录 + 未决开放问题 |
| `DISTILL_RAW.md` | 全部已确认信息的原始蒸馏稿（188 条） |

## 请求耗时追踪（Request Timing）

后端内置请求耗时中间件，前端 API 层同步记录客户端耗时，便于定位慢请求。

### 后端

- **开关**：环境变量 `REQUEST_TIMING`（默认开启；生产设 `0`/`false` 关闭）。
- **响应头**：每个请求返回 `X-Server-Timing: total=123.4; db=45.2; handler=78.2`（单位 ms）。
- **日志**：JSON 行写入 `LOG_DIR/backend-requests.log`（默认 `<项目>/data/logs/`，
  已随 `./data` 挂载到宿主机；RotatingFileHandler，5MB × 5 份轮转）。
  每行字段：`timestamp / path / method / status_code / total_ms / db_ms / handler_ms / client_ip / user_id`。
  示例行：

  ```json
  {"timestamp": "2026-10-13T09:12:30+00:00", "path": "/api/orders", "method": "GET",
   "status_code": 200, "total_ms": 18.3, "db_ms": 6.1, "handler_ms": 12.2,
   "client_ip": "172.20.0.1", "user_id": null}
  ```

- **DB 耗时采集**：通过 SQLAlchemy `before/after_cursor_execute` event hooks 按请求累加。
  若该 hook 引发异常，回滚只需注释掉 `main.py` 中的 `setup_db_timing()` 并重启。

### 前端

- 浏览器 console 每次 API 请求输出一行：
  `[timing] GET /api/orders — client:120ms — server total=100.0; db=40.0; handler=60.0 (status 200)`
- **集中上报（默认关闭）**：仅当浏览器 `localStorage.setItem('enable_tracing','1')`
  **且** 后端 `TRACE_REPORT_ENABLED=1` 时，才 POST summary 到 `/api/_trace` 落日志。

### 查看方式

- 本地/Docker Compose：`type data\logs\backend-requests.log`（Windows）或 `tail -f data/logs/backend-requests.log`。
- NAS 单容器：日志在挂载目录 `./data/logs/backend-requests.log`，SSH 到 NAS 直接查看；
  或 `docker logs rental-app`（stdout，若配置了 propagate）。

## 支付方式（Payment Methods）

功能受环境变量 `ENABLE_PAYMENT_METHOD` 控制（默认 `0` 关闭）。开启（`1`）后：

- 后端：`/api/payment-methods` CRUD 可用（新增/修改/停用需要 `manage_payment_methods`
  权限或 superuser/admin）；订单可读写 `payment_method_code`（校验必须为启用中的 code）。
- 数据：`payment_methods` 表由启动时自动创建并幂等写入初始方式 `CASH/现金`（默认）；
  `orders.payment_method_code` 为增量列（nullable），关闭功能后历史值保留、编辑忽略。
- 前端："目录与设置 → 系统设置"出现"付款"区域（横线隔开）；订单表单/详情显示支付方式
  摘要行，编辑使用懒加载弹窗；用户管理权限勾选新增"添加支付方式"。
- 关闭时管理 API 返回 404、`/api/settings` 的 `payment_methods` 为空数组，前端不显示
  任何支付方式 UI。

NAS 开关：修改 `docker-compose.nas.yml` 中 `ENABLE_PAYMENT_METHOD` 后重建容器。
回滚：设 `ENABLE_PAYMENT_METHOD=0` 即时回退行为；schema 回滚可手动
`DROP TABLE payment_methods; ALTER TABLE orders DROP COLUMN payment_method_code`
（SQLite 3.35+）或还原备份 DB（备份：停容器后复制 `data/rental_app.db` 到 `backups/`）。

## 特别说明

`docs/DISTILL_RAW.md` 和 `docs/DECISIONS_LOG.md` 中的 **Open Questions** 为未决事项，请勿自行处理，需等待项目负责人确认。
