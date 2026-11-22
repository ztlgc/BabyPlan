# BabyPlan 家长网页

零依赖静态 ES module 家长入口。页面通过 `/v2` 合同读取真实家庭、当天与七天安排，并支持参与记录、成长文字与照片、测量、阶段观察、书架、导出、家庭管理，以及按角色显示的内容审阅工作台。登录页也支持凭家庭管理员设置的邀请码创建家长账号。当前不会生成虚构安排，也不把 token 写入 `localStorage`。

## 启动

在项目根目录运行：

```powershell
cd apps/web
npm start
```

然后打开 `http://127.0.0.1:4174`。首次启动不需要 `npm install`。

可换端口：

```powershell
npm start -- --port 4175
```

页面默认请求同源 `/v2`。本地服务器把这个路径代理到 `127.0.0.1:4318/v2`，让 HttpOnly Cookie、严格同源和 CSRF 校验保持一致。登录页的“连接设置”可以修改 API 地址；修改后只把 API 地址保存在当前浏览器，不会保存访问令牌、刷新令牌或密码。

如 API 不在默认地址，可在启动时指定：

```powershell
npm start -- --api http://127.0.0.1:4319
```

## 自检

```powershell
cd apps/web
npm test
```

测试使用 Node 内置测试运行器，覆盖日期、输入校验、Cookie/CSRF 请求行为、真实合同路径、家庭管理、重新认证与删除、照片上传顺序、内容差异、409 冲突文案、静态服务器启动与目录穿越防护。仓库中的 API 集成测试还会用真实 PostgreSQL、Fastify 与 Chromium 验证网页登录、跨端读回、360px 窄屏和 200% 字号。

## 已按合同接入

- `POST /sessions`，请求体显式使用 `clientType: "web"`。
- `POST /invitations/redeem`，在登录页凭一次性邀请码创建家长账号并加入家庭。
- `GET /sessions/csrf`，CSRF 令牌只保存在页面内存。
- `GET /bootstrap`。
- `GET /children/{childId}/days/{date}`，七天视图由七个真实日请求组成。
- `GET`、`PUT /families/{familyId}/preferences`。
- `PUT /plan-items/{itemId}/participation`，携带 `operationId`、`baseRevision` 和 `X-CSRF-Token`。
- 家庭创建、邀请接受、成员移除、孩子资料更新和家庭删除；家庭删除先调用 `POST /sessions/reauth`。
- 成长小记、测量、阶段观察、家庭书架的读取或写入，以及 `POST /media/uploads` → signed URL `PUT` → `POST /media/{mediaId}/complete` 的照片流程。
- 异步导出申请与任务查询；过期或失败任务会显示真实状态，不展示伪造下载按钮。
- 内容修订创建/送审/审核、审读证据、来源、发布门禁与发布版本撤回，并按 `editor`、`reviewer`、`publisher` 角色显示可用操作。
- `DELETE /sessions/current`。

所有请求都设置 `credentials: "include"`。

## 真实边界

`contracts/v2/openapi.yaml` 是实施合同。服务端不可达、角色不足或某个接口尚未实现时，页面会显示真实错误，不会用本地假数据伪造登录、安排、证据或保存成功。内容审核按钮只登记当前真人填写的证据，公开内容仍需独立人工审阅与完成试玩。

网页采用在线写入边界：照片正文先保存，照片失败可在当前页面针对同一条正文重试；离开或刷新页面后不保证保留本地文件对象，也不把这个限制描述成已同步。完整离线队列、Android 系统选图与通知、公网 TLS 部署、真实双设备验收和人工内容审读不属于本目录自动化测试的通过范围。

网页生产部署也应与 API 同源，由反向代理把 `/v2` 转发到服务端。本地服务器已提供同样的代理路径。
