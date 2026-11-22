# 内容包目录

**当前新版基线为 schemaVersion 2。** 见 [v2内容设计](../docs/v2/04-内容体系与首周.md)、[内容审读与发布验收计划](../docs/development/内容审读与发布验收.md) 与 [新版合同](../contracts/v2/README.md)。

原有候选是 `candidate/babyplan-18-23-v2.json`：24张活动卡、7天安排、12条阶段支持，仍为 candidate/draft，没有真实审读和试玩证据。服务现已提供 v2 导入 CLI 与分环境发布门禁。不得用旧 `--release` 命令发布新版，也不得只改审核状态来制造已审证据。

新增 [1～2 岁每日亲子活动](../docs/content/daily-play-12-to-24-months/README.md)：12～23 月龄共 365 天。可导入包为 [`candidate/babyplan-daily-12-24-v1.json`](candidate/babyplan-daily-12-24-v1.json)，包含 365 项每日玩法及原有 24 项活动的新修订。运行 `python -X utf8 tools/build_daily_curriculum.py` 从原稿生成，再以 `python -X utf8 tools/validate_v2_content.py content/candidate/babyplan-daily-12-24-v1.json` 校验。候选包仅在开发内容模式下直接启用，私人试用和公开内容环境仍须真实人工审读。

<details><summary>历史 v1 内容说明（保留追溯，不用于新版实现）</summary>

`demo/demo-content-package.json` 是v0.1合同联调演示包：`family-play-demo` v1，3 张卡、2 套七天模板。仅用于开发和虚构记录。

扩展需求原型另用 `design/expanded-prototype.json`（构建入口 `tools/build_expanded_prototype.py`）：虚构成员、多个内容块、原创话术、媒体占位与异常场景。它既不是API响应，也不是content-package，不可用旧Schema导入或发布。`design/design-scenarios.json` 保留旧A页面场景；两个数据轨道不混用。

正式 `release` 内容包尚未交付。后续放在 `release/family-play-zh-cn-v1.json`，必须使用：

- `schemaVersion: 1`
- `packageId: family-play-zh-cn`
- `contentVersion: 1`（后续修订递增）
- `channel: release`
- 七个固定月龄档；首批为 18～23 月六张主题卡和一套七天模板。

首批排周：小手拍拍 → 球球滚过来 → 杯子进篮子 → 小手拍拍（复玩）→ 两只袜子 → 书里的小狗 → 小熊晚安。

先按 [内容实施规范](../docs/specs/01-内容实施.md) 制作，再做人工试玩和内容审阅；文件交付后，在项目根目录校验：

```bash
python -I tools/validate_content.py content/release/family-play-zh-cn-v1.json --release
```

这条命令是未来正式包的验收方式，当前没有该文件。演示包的校验命令见根目录 README。

`docs/archive/首周活动模板.json` 是旧结构，即使也标记 `schemaVersion: 1`，也不能作为当前正式内容包导入。

</details>
