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

## 特别说明

`docs/DISTILL_RAW.md` 和 `docs/DECISIONS_LOG.md` 中的 **Open Questions** 部分为未决事项，请勿自行处理，需等待项目负责人确认。
