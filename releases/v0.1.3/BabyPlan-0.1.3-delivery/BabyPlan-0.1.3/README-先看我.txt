BabyPlan 小芽 0.1.3 交付包

先阅读：
- docs/家长使用与交付说明.md
- docs/私有部署与备份恢复.md
- release-signature-verification.txt
- manifest.json

本包包含私人签名的 Release APK 和同局域网试用 Debug APK。两者 applicationId 不同，可按文档分别安装。
需要两位家长共享记录时，另外解压 Windows 家庭服务包并阅读它的“先看这里.txt”。
SHA256SUMS.txt 用于核对原始发布文件；DELIVERY-MANIFEST.json 记录本 ZIP 内每个文件的来源与哈希。

本包不包含签名私钥、keystore、数据库、备份、媒体、环境变量、管理员口令或真实家庭资料。
自动化构建与联调不等同于真实 Android 设备、通知送达、照片选择、双机同步、公网 TLS、生产部署和人工内容审读验收。