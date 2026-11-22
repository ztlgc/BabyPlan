# 小芽 BabyPlan Android 客户端

## 本机与局域网试用

- Debug、Profile 与 Release 构建均允许连接 HTTP 或 HTTPS 家庭服务，可从手机连接可信局域网内的 `http://电脑IP:4318/v2`。
- HTTP 会明文传输登录凭据、令牌和家庭数据，只应在受控局域网内使用；离开可信网络或对外开放时必须部署带 TLS 的家庭服务。
- 如果 Android 仍提示网络被拦截，请确认手机与服务在同一网络，并检查主机防火墙是否放行 `4318` 端口。

## 照片与成长记录

- 应用只通过系统照片选择器读取家长主动选择的一至五张照片，不申请读取整个相册的权限。
- 正文会先保存在应用本机数据库，再复制照片受控副本并排队上传。照片复制、上传或关联失败不会回滚正文。
- 单张照片上限为 20MB，仅接受 JPEG、PNG 与 WebP。
- 上传票据、create/complete/link operationId 和上传状态保存在本机。杀进程或断网后会继续重试；临时上传地址不会被当作永久照片地址。

## 验证与构建

```powershell
dart format lib test
flutter analyze
flutter test
flutter build apk --debug
```

Debug APK 输出在 `build/app/outputs/flutter-apk/app-debug.apk`。真机通知权限、厂商省电策略、系统选图与局域网连通性仍需在真实 Android 设备上验收。
