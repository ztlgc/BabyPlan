# BabyPlan /v2 设计合同

对应 `docs/v2/` 的多成员、多项计划与成长档案设计。旧根目录 `/v1` OpenAPI和schemaVersion 1保留为历史，不与新数据混用。

- `openapi.yaml`：接口设计合同，覆盖身份/家庭、编排/参与、增量同步、成长/媒体、内容发布等主要操作；不是已部署API。
- `content-package.schema.json`：schemaVersion 2内容包；支持candidate/release，结构检查之外还需业务引用、预算、阶段、审核门禁。
- `tools/validate_v2_design.py`：内容与合同引用检查；不能证明育儿安全或服务鉴权实现。

2026-11-14 兼容扩展：内容包增加可选 `dailyPlans`（12～24 月龄、365 天、每天一项、最多 5 分钟）及 `m12_14`、`m15_17` 年龄档。旧内容包继续使用 `week`。所有 HTTP 路径保持原合同；`plans/ensure` 为适用孩子生成有序的每日项，`missingSlots` 按当天实际应安排的种类计算。`0011_daily_curriculum.sql` 为计划追加 `planned_kinds`，不修改已冻结的历史迁移。完整说明见 [每日活动原稿](../../docs/content/daily-play-12-to-24-months/README.md)。

所有家庭对象都由登录用户的当前活跃成员关系约束。跨家庭对象返回404，不因幂等重放绕过权限。写操作携带operationId；修改携带baseRevision。重复操作同请求重放原结果，不同请求报OPERATION_REUSED。正文冲突返回current/submitted，不自动用时间戳覆盖。

错误统一 `{code,message,requestId,details?}`；400结构/日期/单位错误，401会话失效，403角色不足，404对象不可见，409版本/幂等/业务冲突，410同步游标过期，413媒体过大，422内容业务校验，429限流，503服务暂不可用。只把可理解信息展示给家长，内部码写脱敏日志。

`day-plan`和`participation`是不同修订域。换活动原子校验PlanItem revision与未开始/未记录状态；写参与只改参与revision，不隐式换项。给未来日期写参与/成长记录返回INVALID_DATE；补记过去保留原业务日期。首版家庭时区固定，历史不随设备时区漂移。

公开身份入口采用速率限制；邀请/重置只存令牌摘要、单次使用、24小时失效。Web会话用HttpOnly Cookie和CSRF防护，手机使用Bearer会话；示例和原型不包含可用凭证。管理工作台角色与家庭角色互不继承。
