# BabyPlan Raspberry Pi Linux 部署

本目录使用 Docker Compose 在 64 位 Raspberry Pi 上运行 API、家长网页和 PostgreSQL。当前配置面向局域网 HTTP 部署，不包含公网域名和 TLS；家长网页和 Release APK 均支持 HTTP 或 HTTPS。

## 目标环境

- Raspberry Pi 4，2GB 内存或以上。
- 64 位 Raspberry Pi OS 或 DietPi。
- Docker Engine 与 Docker Compose 插件。
- 使用外部 SSD 保存数据库、照片和备份更可靠；普通 SD 卡只适合试用。

## 目录约定

```text
/srv/babyplan/
├── src/                         # 本仓库工作区
├── config/
│   ├── compose.env              # Compose 插值变量
│   ├── babyplan.env             # API 运行配置
│   └── initial-owner.env        # 首次管理员记录，权限 600
└── data/
    ├── media/
    ├── recovery-outbox/
    ├── deletion-journal/
    ├── backups/
    └── restores/
```

PostgreSQL 数据保存在 Docker 命名卷 `babyplan_babyplan_pgdata` 中。照片、恢复投递、删除台账和备份使用独立目录，不能混在一起。

## 首次准备

在仓库根目录复制文件到目标目录后，编辑 `compose.env` 和 `babyplan.env`：

```bash
sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" \
  /srv/babyplan/config /srv/babyplan/data \
  /srv/babyplan/data/media /srv/babyplan/data/recovery-outbox \
  /srv/babyplan/data/deletion-journal /srv/babyplan/data/backups \
  /srv/babyplan/data/restores
sudo install -m 600 -o "$(id -u)" -g "$(id -g)" \
  ops/linux/compose.env.example /srv/babyplan/config/compose.env
sudo install -m 600 -o "$(id -u)" -g "$(id -g)" \
  ops/linux/babyplan.env.example /srv/babyplan/config/babyplan.env
```

将 `POSTGRES_PASSWORD` 改为随机十六进制值，并把 `PUBLIC_BASE_URL` 改为手机可以访问的 API 地址，例如：

```text
PUBLIC_BASE_URL=http://192.168.5.196:4318
```

网页 Cookie 的 `Secure` 属性跟随 `PUBLIC_BASE_URL` 协议：HTTP 地址自动不加 `Secure`，HTTPS 地址自动加上。因此生产模式不再强制 HTTPS；但生产环境仍须使用 `CONTENT_ENVIRONMENT=private_trial` 或 `public`，不能读取 development 内容。公网访问建议通过反向代理提供 TLS。

## 构建、迁移与首次账号

以下命令假设源码位于 `/srv/babyplan/src`，配置位于 `/srv/babyplan/config`：

```bash
cd /srv/babyplan/src

sudo docker compose \
  --env-file /srv/babyplan/config/compose.env \
  -f ops/linux/compose.yaml up -d db

sudo docker compose \
  --env-file /srv/babyplan/config/compose.env \
  -f ops/linux/compose.yaml run --rm api node dist/cli/migrate.js

sudo docker compose \
  --env-file /srv/babyplan/config/compose.env \
  -f ops/linux/compose.yaml run --rm \
  -e BABYPLAN_INITIAL_CREDENTIAL='替换为至少12位初始口令' \
  api node dist/cli/create-user.js \
  --email owner@babyplan.test \
  --display-name 家庭管理员 \
  --content-roles editor,reviewer,publisher
```

创建管理员后，导入并启用开发内容：

```bash
sudo docker compose \
  --env-file /srv/babyplan/config/compose.env \
  -f ops/linux/compose.yaml run --rm api \
  node dist/cli/content.js import \
  --file /repo/content/candidate/babyplan-18-23-v2.json \
  --environment development \
  --created-by '<上一步返回的 userId>'

sudo docker compose \
  --env-file /srv/babyplan/config/compose.env \
  -f ops/linux/compose.yaml run --rm api \
  node dist/cli/content.js publish --release-id '<导入返回的 releaseId>'
```

启动服务并检查：

```bash
sudo docker compose \
  --env-file /srv/babyplan/config/compose.env \
  -f ops/linux/compose.yaml up -d api web

curl -fsS http://127.0.0.1:4318/health/ready
curl -fsS http://127.0.0.1:4174/
```

家长网页为 `http://192.168.5.196:4174`，开发 APK 的 API 地址为 `http://192.168.5.196:4318`。首次登录后可在网页中创建家庭和孩子资料。

## 日常操作

```bash
cd /srv/babyplan/src
sudo docker compose --env-file /srv/babyplan/config/compose.env -f ops/linux/compose.yaml ps
sudo docker compose --env-file /srv/babyplan/config/compose.env -f ops/linux/compose.yaml logs -f --tail=100 api web
sudo docker compose --env-file /srv/babyplan/config/compose.env -f ops/linux/compose.yaml restart api web
sudo docker compose --env-file /srv/babyplan/config/compose.env -f ops/linux/compose.yaml down
```

不要执行带 `-v` 的 `down`，它会删除 PostgreSQL 命名卷。

## 数据库备份

```bash
sudo docker compose \
  --env-file /srv/babyplan/config/compose.env \
  -f ops/linux/compose.yaml exec -T db \
  pg_dump -U babyplan -Fc babyplan \
  > /srv/babyplan/data/backups/babyplan-$(date +%F-%H%M%S).dump
```

照片和删除台账需要与数据库备份一起复制到另一块受控磁盘。不要只备份数据库，也不要把删除台账放进媒体或备份目录。

## 当前边界

- 当前是局域网 HTTP 部署，不提供公网 TLS。
- 未在本机验证 Release APK 的 HTTP/HTTPS 真机连接、真实手机通知和双机断网恢复。
- 未验证外部 SSD、断电恢复、另一台主机的完整恢复和长期 RPO/RTO。
