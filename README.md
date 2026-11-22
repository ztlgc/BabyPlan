# BabyPlan｜每天一点，一起长大

**当前：0.1.3 已提供 Android 试用包、私人签名包和 Windows 家庭服务包。新增同机多账号隔离、成长记录更正与回收恢复，以及手机、网页双端同步。按月龄和材料生成安排，轻松模式保留已记录项目；提醒在当天记完或过 20:00 后跳过。真实 Android、双机断网、人工内容审读与公网 HTTPS 仍待验收。**

软件和验证详情见 [开发与交付验证报告](docs/implementation/开发与交付验证报告-2026-11-13.md)。家长安装、首次部署和未完成边界见 [家长使用与交付说明](docs/家长使用与交付说明.md)。

可直接查看的本地交付物：

- [完整交付包](releases/v0.1.3/BabyPlan-0.1.3-delivery.zip)：两个 APK、Windows 服务包、公开签名证书与安装说明。
- [完整包与 Windows 服务包校验值](releases/v0.1.3/SHA256-DELIVERY.txt)：下载后可直接核对两个 ZIP。
- [局域网试用 APK](releases/v0.1.3/BabyPlan_0.1.3_lan-debug.apk)：只想先在手机上看看时用这个；不用启动电脑服务也能看到“今天”。
- [私人 Release APK](releases/v0.1.3/BabyPlan_0.1.3_private-release.apk)：历史 0.1.3 包只接受 HTTPS；当前源码的后续 Release 构建同时支持 HTTP 与 HTTPS。
- [Windows 家庭服务包](releases/v0.1.3/BabyPlan-0.1.3-windows-service.zip)：家长网页、API、迁移与首次安装工具。
- [APK 清单与哈希](releases/v0.1.3/manifest.json)、[SHA-256 校验文件](releases/v0.1.3/SHA256SUMS.txt)、[签名验证](releases/v0.1.3/release-signature-verification.txt) 和 [包信息](releases/v0.1.3/release-badging.txt)。
- [开发任务明细](deliverables/v2/开发计划.html)：按真实证据显示 44 项任务的状态、依赖和剩余验收。
- [完整设计入口](docs/v2/00-先看这里.md)、[设计阶段验证](docs/v2/07-验证报告.md) 和 [跨端真实联调报告](docs/qa/跨端真实联调与网页验收-2026-11-13.md)。
- [Android 真机验收卡](docs/qa/Android真机验收卡.md)：按手机上的步骤检查通知、断网和升级。

首次部署可在 Windows PowerShell 运行：

```powershell
cd E:\2025Code\BabyPlan
.\scripts\ops\Install-BabyPlan.ps1 -LanAccess
```

向导会隐藏输入数据库管理员连接和初始登录口令，创建私有环境、数据库、管理员、家庭、18 月龄孩子和开发内容，再启动 API 与家长网页。完整说明见 [私有部署与备份恢复](docs/ops/私有部署与备份恢复.md)。

新设计包括24张原创活动候选、7天×6项安排、四个年龄节点的12条阶段支持。三段25/25/10分钟为可拆分的预算，20分钟轻松方案可选，没有发育评分或连续打卡奖励。

`docs/v2/`、`contracts/v2/`、`content/candidate/` 和 `prototype/v2/` 为本轮新基线。原始讨论稿、旧规格、根级v1合同与旧原型保留为历史，**不要将单设备、一日一卡与新版多成员、多项计划混用**。

本轮没有提交、推送或公网部署；没有收集真实照片、生日或家庭凭证。24 张活动卡仍是 `candidate / draft`，人工编辑审读、专业审阅与家庭试玩未完成，因此不会自动升级成正式公开内容。

维护者可用 [统一验证脚本](scripts/verify.ps1) 复核内容、合同、API、网页与 Flutter。恢复演练和内容撤回的实际范围见 [专项验收](docs/qa/删除恢复与撤回验收-2026-11-13.md)。

<details><summary>以下是历史v1入口，保留供追溯，不作为新版实施依据</summary>

# BabyPlan｜家庭亲子与共读安排（历史）

为家长准备容易开展的游戏与共读，记录真实参与和成长。当前优先打磨内容与设计。

**当前状态：安卓端、网页家长区和内容管理区的低保真可点击原型已形成首版，仍待产品评审。** 三端使用虚构数据演示，覆盖N01—N12、W01—W08、C01—C06代表页面；另有4张静态PNG视觉提案、候选变量和设计简报。尚无Flutter App、真实服务、数据库或部署实现。

## 从哪里开始

从 [设计输入入口](docs/design/README.md) 开始，依次看 [原型范围与三端简报](docs/design/05-原型范围与三端简报.md)、[状态与文案清单](docs/design/03-原型状态与文案清单.md)、[候选视觉基线](docs/design/04-视觉与组件基线.md) 和 [虚构一天说明](docs/design/06-虚构一天与数据说明.md)。完整生成提示词在三端简报末尾。先做低保真，再确认视觉。

| 资料 | 作用与边界 |
| --- | --- |
| [三端低保真原型](prototype/README.md) | [总入口](prototype/index.html)、[家长网页](prototype/parent/index.html)、[内容管理](prototype/admin/index.html)、[安卓端](prototype/mobile/index.html)；所有保存/同步/上传/发布均为本地模拟 |
| [网页验证记录](prototype/验证记录.md) | 浏览器检查、P用例代表路径与未验证项 |
| [产品与三端架构讨论稿](docs/BabyPlan-产品与三端架构讨论稿.md) | v0.4记载已确认扩展需求及设计建议，尚未替代正式接口 |
| [原型范围与三端简报](docs/design/05-原型范围与三端简报.md) | 本次默认设计范围，N/W/C页面、P验收、本地模拟 |
| [扩展原型样本](content/design/expanded-prototype.json) | 虚构成员、完整一天、原创内容与异常场景，不是API响应 |
| [儿童内容研究](docs/BabyPlan-儿童内容与书目研究笔记-2026-11-11.md) | 选题与书目依据、核验边界；不是正式发布内容 |
| [总体框架](docs/specs/00-总体框架.md)、[内容实施](docs/specs/01-内容实施.md)、[开发实施](docs/specs/02-开发实施.md) | 现有v0.1一日一卡、单设备开发基线，新需求评审后统一升级 |
| [安卓交互](docs/specs/03-安卓交互与状态规格.md)、[服务端规则](docs/specs/04-服务端数据与接口规格.md)、[阶段验收](docs/specs/05-实施阶段与验收规格.md) | 旧A/D编号、M阶段，不代表扩展能力已设计完或实现 |
| [OpenAPI](contracts/openapi.yaml)、[内容Schema](contracts/content-package.schema.json) | 现有M1/M2接口和内容包结构，未支持多成员、多项、媒体或管理发布 |
| [旧设计场景](content/design/design-scenarios.json) | 固定时钟的旧A页面场景，不与扩展数据混装 |
| [演示内容包](content/demo/demo-content-package.json) | 3张卡、2套模板，demo；仅开发联调 |
| [18月龄素材](docs/content/18月龄内容清单.md)、[内容目录说明](content/README.md) | 六主题文字素材，正式release包仍待制作、审阅与试玩 |
| [启动指南](docs/00-项目启动指南.md)、[决策记录](docs/01-文档梳理与决策记录.md) | 旧实施顺序与新旧轨道衔接，阅读范围标识 |
| [交付物说明](deliverables/README.md) | PNG和ZIP用途、版本与未验证项 |

扩展需求包括系统自动安排、每日多个内容块、父母账号共享、阶段指引、书架与成长媒体。三段弹性窗口、内容预算、导航、权限和发布撤回交互仍按设计候选处理。不要将旧合同“每天一个任务”与新三端页面拼接为开发要求；原型评审后共同修订规格、OpenAPI、Schema、校验与验收。

## 目录与验证

`docs/design/` 是设计入口；`prototype/` 为三端低保真原型源码和验证记录；`docs/specs/` 保留现有开发基线；`content/design/` 为虚构原型数据；`content/demo/` 为旧合同联调数据；`deliverables/` 为静态提案、输入ZIP和报告；`docs/archive/` 为历史资料；`.work/` 为整理与绘图脚本，非产品入口。

未来技术候选为Flutter + SQLite、React + TypeScript、Fastify + TypeScript + PostgreSQL及私有媒体存储，实际实现时再建目录。当前未初始化Git，未配置真实服务或部署环境。

在项目根目录使用Python、jsonschema，打包另需PyYAML：

```bash
python -I tools/validate_content.py content/demo/demo-content-package.json
```

```bash
python -I tools/build_design_scenarios.py
```

```bash
python -I tools/build_expanded_prototype.py
```

```bash
python -I tools/package_design_handoff.py
```

```bash
python -I tools/build_mobile_prototype.py
```

```bash
python -I tools/serve_prototype.py --port 4173
```

```bash
python -I tools/serve_prototype.py --surface all --port 4174
```

上述build与package命令会更新虚构数据或生成物；serve命令只在本机提供静态原型，不包含API。三端入口 `http://127.0.0.1:4174`，也可直接打开 `prototype/index.html`。最新包为 `deliverables/BabyPlan-原型设计输入包-v0.2.zip`，旧v0.1包保留为历史输入。校验脚本检查声明的结构、引用、预算和候选配色，不证明适龄安全、来源支持、交互、浏览器样式、真机、鉴权或部署已通过。

资料整理于2026-11-10～11；来源原文保留，扩展讨论不归档为废案。所有对外设计只用虚构数据、原创话术和占位资源，不上传真实家庭资料、凭证、密钥或私人配置。
</details>
