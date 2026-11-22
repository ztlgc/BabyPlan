# BabyPlan 私有部署入口

本目录和 `scripts/ops/` 提供 Windows 本机或私人服务器的可复现操作。它不包含真实数据库口令、证书、签名密钥或家庭资料。

不会编辑文件时，优先运行首次安装向导。它会隐藏读取数据库管理员连接与初始口令，生成随机数据库口令，创建专用数据库、初始管理员、一个家庭和开发内容；秘密只写入 `.work` 或仓库外的人工指定私有目录。

```powershell
.\scripts\ops\Install-BabyPlan.ps1 -LanAccess
```

去掉 `-LanAccess` 时只允许本机访问。使用 `-LanAccess` 时两个服务只监听当前 Windows 主机的局域网地址，脚本会输出手机应填写的 API 地址；Windows 防火墙仍需由维护者按实际网络放行端口。后续构建的正式 APK 支持 HTTP 或 HTTPS；HTTP 只适合可信局域网，离开可信网络时应使用 HTTPS。

建议的手工维护顺序：

1. 用 `scripts/ops/Initialize-BabyPlanEnvironment.ps1` 建立隔离目录和配置。本机试用可使用默认 `http://127.0.0.1:4174`；外部 HTTPS 域名通过 `-PublicBaseUrl` 写入。
2. 通过环境变量 `BABYPLAN_ADMIN_DATABASE_URL` 运行 `Initialize-BabyPlanDatabase.ps1`，创建专用角色和空数据库。管理员连接只存在于当前进程环境。
3. 运行 `Deploy-BabyPlan.ps1` 安装、构建、迁移；内容包与发布版本必须显式提供。
4. 运行 `Start-BabyPlan.ps1`，外部 HTTPS 入口参考 `Caddyfile.example`。
5. 从当前进程临时设置 `BABYPLAN_RESTORE_ADMIN_DATABASE_URL`，再用 `Test-BabyPlanBackupRestore.ps1` 演练；正式备份使用 `Backup-BabyPlan.ps1`。恢复管理员连接不会被写入环境文件或日志。

`RECOVERY_OUTBOX_ROOT` 必须存在，并独立于媒体、备份和恢复目录；它只供维护者接收账号恢复投递，不能放入静态网页目录。

完整命令、局域网地址、停机边界、升级/回滚和发布检查见 [私有部署与备份恢复](../docs/ops/私有部署与备份恢复.md)。数据库与媒体必须通过清单中的 SHA-256 一起校验；普通应用角色不需要、也不应获得建库权限。
