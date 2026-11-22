"""生成扩展需求的虚构原型样本；不表示API、发布包或真实家庭记录。"""
from __future__ import annotations

import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build() -> dict:
    items = [
        {
            "id": "sample-roll", "segmentId": "afternoon", "kind": "movement",
            "title": "把大软球滚给你", "budgetMinutes": 15,
            "materials": ["完整、适龄的大软球"],
            "steps": ["清空平坦地面，成人和孩子近距离坐下。", "成人轻轻滚出球，停下来等回应。", "孩子愿意时再来一次；想走开就收好球。"],
            "dialogue": {"opening": "球来找你啦。", "whenJoins": "你把球送回来了。", "whenWatches": "你在看球，我慢慢滚一次。", "whenStops": "好，我们先把球放好。"},
            "safety": "成人在旁近距离陪伴，检查球无松脱小零件；不追逐到台阶或障碍旁。",
            "participation": None,
        },
        {
            "id": "sample-basket", "segmentId": "afternoon", "kind": "exploration",
            "title": "毛巾进篮子", "budgetMinutes": 10,
            "materials": ["完整大方巾", "稳定、无锐边的篮子"],
            "steps": ["把篮子放在孩子身边。", "成人示范放入、取出方巾，再等孩子尝试。", "让孩子决定再放一次还是结束。"],
            "dialogue": {"opening": "毛巾放进去了。", "whenJoins": "你把它拿出来啦。", "whenWatches": "我再慢慢放一次。", "whenStops": "我们把毛巾收好。"},
            "safety": "不将布盖在孩子头脸上；不使用带长绳、抽绳或小装饰的材料。",
            "participation": None,
        },
        {
            "id": "sample-read-zh", "segmentId": "after_dinner", "kind": "reading",
            "title": "选一页，一起看看", "budgetMinutes": 10,
            "materials": ["家里一本已确认适合的熟悉绘本"],
            "bookId": "sample-family-book", "language": "zh",
            "steps": ["让孩子从熟悉的书中选一本。", "停在孩子想看的页面，描述眼前一个动作。", "等待看、指或发声，接着回应；不要求读完整本。"],
            "dialogue": {"opening": "你想看这一页呀。", "whenJoins": "你指到它了，我们再看看。", "whenWatches": "我和你一起看。", "whenStops": "今天先看到这里。"},
            "safety": "成人陪同翻页；破损机关或松脱部件先收起。",
            "participation": None,
        },
        {
            "id": "sample-read-en", "segmentId": "after_dinner", "kind": "english",
            "title": "小熊在哪里", "budgetMinutes": 10,
            "materials": ["完整适龄的大玩偶"], "language": "en",
            "steps": ["把玩偶放在孩子看得到的位置。", "说一句原创英文，配合指向和等待。", "孩子看、指或拿起都可回应；需要时用中文解释。"],
            "dialogue": {"opening": "我们看看小熊在哪里。", "whenJoins": "你找到小熊啦。", "whenWatches": "我指给你看，小熊在这里。", "whenStops": "小熊先休息啦。"},
            "english": [{"line": "Where's the bear?", "meaningZh": "小熊在哪里？", "when": "玩偶可见时邀请共同寻找", "action": "看向或指向玩偶，等待回应"}, {"line": "All done.", "meaningZh": "好啦，结束了。", "when": "孩子表示想停时", "action": "一起把玩偶放好"}],
            "safety": "不遮住孩子面部，不要求跟读或测试；玩偶无松脱小零件。",
            "participation": None,
        },
        {
            "id": "sample-child-led-a", "segmentId": "after_dinner", "kind": "child_led",
            "title": "你来选，我跟着玩", "budgetMinutes": 5,
            "materials": [], "steps": ["在安全空间里观察孩子想做什么。", "跟随孩子的动作，用一句话回应。", "愿意时轮流，不强行加入。"],
            "dialogue": {"opening": "你想玩这个呀。", "whenJoins": "我跟你一起。", "whenWatches": "我在这里陪你。", "whenStops": "好，我们歇一歇。"},
            "safety": "只跟随安全、适龄的玩法；不将等待理解成必须完成任务。", "participation": None,
        },
        {
            "id": "sample-child-led-b", "segmentId": "bedtime", "kind": "child_led",
            "title": "还想看哪一页", "budgetMinutes": 5,
            "materials": ["熟悉绘本"], "steps": ["邀请孩子选一页熟悉的图。", "安静地共看，跟随孩子的指向。", "想睡时马上结束。"],
            "dialogue": {"opening": "你还想看看哪一页？", "whenJoins": "我们再看看这里。", "whenWatches": "我陪你看一小会儿。", "whenStops": "好，我们准备休息。"},
            "safety": "并入原有睡前流程，不因预算延迟睡眠。", "participation": None,
        },
        {
            "id": "sample-replay", "segmentId": "bedtime", "kind": "replay",
            "title": "跟小熊说晚安", "budgetMinutes": 5,
            "materials": ["完整大玩偶"], "steps": ["成人示范轻轻挥手。", "接受孩子用动作、声音或观看回应。", "说晚安后收好玩偶，结束互动。"],
            "dialogue": {"opening": "小熊要休息啦。", "whenJoins": "你在跟它道别。", "whenWatches": "我挥挥手，晚安。", "whenStops": "好，我们也休息。"},
            "safety": "不把玩偶留作婴幼儿睡眠环境安全的承诺；遵循家庭和专业人员的安全建议。", "participation": None,
        },
    ]
    cases = [
        ("expanded_today", "今天", "准备好的三段安排；预算非倒计时，任一项可缩短或跳过。"),
        ("expanded_loading", "今天", "正在读取今天安排；加载不能显示为无内容。"),
        ("expanded_service_error", "今天", "服务暂不可用；保留已有内容与重试入口。"),
        ("expanded_connection_expired", "连接恢复", "连接已失效；本机资料保留，不展示凭证输入示例。"),
        ("expanded_empty", "今天", "暂无可用安排，可重试和查看书架；不自动编造已发布内容。"),
        ("expanded_participation", "记录", "陪伴者家长甲，添加者家长乙，保存后返回今天；取消不修改。"),
        ("expanded_other_member", "今天", "模拟切换家长后读取同一条家庭记录，不新增重复条目。"),
        ("expanded_future", "未来安排", "未来内容可查看，不可提前记录已经参与。"),
        ("expanded_offline_cached", "今天", "看已缓存内容，参与记录显示已存本机、待同步。"),
        ("expanded_offline_empty", "今天", "没有下载内容，提示联网；不能离线假装自动排好新一天。"),
        ("expanded_sync_sending", "同步恢复", "发送中保留更晚本机意图；禁止旧响应覆盖新编辑。"),
        ("expanded_sync_failed", "同步恢复", "失败可重试，保留内容和修改；不声称已同步。"),
        ("expanded_sync_success", "同步恢复", "模拟收到对应操作确认才标已同步，原型不发送请求。"),
        ("expanded_conflict", "同步恢复", "本机与另一家长的版本并排，明确采用哪版；可稍后处理。"),
        ("expanded_replace", "换活动", "同段换为候选内容，确认后才改；已开展项不自动重排。"),
        ("expanded_book_unverified", "书架", "版本未确认，只展示系列文字，不出现页码、封面或点读承诺。"),
        ("expanded_stage", "阶段指引", "关注方向和支持玩法，区间为产品编排；不打分。"),
        ("expanded_memory_empty", "成长", "尚无成长记录，可添加故事或原话；不推断第一次。"),
        ("expanded_media_pending", "成长", "照片占位已存本机待上传，不冒充远端可见。"),
        ("expanded_media_failure", "成长", "上传失败可重试；文字可保留，其他设备不可见未上传照片。"),
        ("expanded_media_denied", "成长", "相册权限关闭仍可写故事；仅用户点添加照片后提示权限。"),
        ("expanded_measurement", "测量", "录入日期/单位/方式；无参考资料只列家庭记录，不给百分位。"),
        ("expanded_reminder_denied", "设置", "提醒偏好与系统权限分开；拒绝不阻断使用。"),
        ("expanded_reminder_elapsed", "设置", "今天提醒时间已过，不补发；每日仅一条为候选规则。"),
        ("expanded_parent_web", "家长网页", "与安卓共用家庭安排，查看阶段路线、整理书目和成长，不出现发布权限。"),
        ("expanded_print", "家长网页", "打印预览使用已选内容；默认不包含照片或整份成长档案。"),
        ("expanded_admin_draft", "内容管理", "虚构编辑修改草稿；家长安排仍显示原已发布内容。"),
        ("expanded_admin_review", "内容管理", "送审后展示核验与来源，待修改原因明确；权限规则为候选。"),
        ("expanded_admin_forbidden", "内容管理", "无发布权限显示原因，不允许模拟越权成功。"),
        ("expanded_publish_failed", "内容管理", "模拟发布失败，原活跃版本保持，草稿可恢复。"),
        ("expanded_publish_success", "内容管理", "明确模拟发布成功；不改历史与已开展、家长已调整的项。"),
        ("expanded_withdraw", "内容管理", "确认前说明影响范围；对未开展项的自动处理规则仍待确认。"),
    ]
    for item in items:
        item["sources"] = [{"kind": "design_sample", "title": "原创虚构流程样本（尚未正式内容审阅）"}]
    alternative = {
        "id": "sample-walk", "segmentId": "afternoon", "kind": "movement",
        "title": "跟着脚步慢慢走", "budgetMinutes": 15, "materials": [],
        "steps": ["清空平坦地面，成人慢慢走两步。", "停下等孩子看或跟来，愿意时换孩子带路。", "孩子想停时一起坐下休息。"],
        "dialogue": {"opening": "我慢慢走两步。", "whenJoins": "我跟着你走。", "whenWatches": "你在这里看也可以。", "whenStops": "好，先休息。"},
        "safety": "成人在旁，远离台阶与障碍；不拉拽孩子追赶。",
        "sources": [{"kind": "design_sample", "title": "原创虚构替换候选（尚未正式内容审阅）"}],
        "participation": None,
    }
    result = {
        "fixtureVersion": 1, "kind": "expanded-design-only", "dataClass": "fictional",
        "description": "全部人物、安排和文案均为虚构或原创演示，不代表API响应、正式内容、家庭实际情况或已确认交互。",
        "referenceNow": "2026-11-11T07:00:00Z", "timezone": "Asia/Shanghai",
        "businessDate": "2026-11-11", "networkPolicy": "local-simulation-only",
        "scopeStatus": "confirmed-goals-with-candidate-interactions",
        "family": {"id": "sample-family", "label": "虚构演示家庭", "members": [{"id": "sample-parent-a", "label": "家长甲（虚构）"}, {"id": "sample-parent-b", "label": "家长乙（虚构）"}]},
        "child": {"id": "sample-child", "ageBand": "18～23月", "birthDate": None},
        "books": [{"id": "sample-family-book", "label": "家中熟悉绘本（占位）", "editionStatus": "unverified", "cover": None, "readingPenCompatibility": "unknown"}],
        "day": {"status": "candidate", "budgetMinutes": 60, "budgetNote": "纯亲子互动候选预算；可拆分、缩短或跳过，不要求凑满。",
                "segments": [{"id": "afternoon", "label": "晚饭前", "window": "16:00～17:15内弹性开展", "budgetMinutes": 25}, {"id": "after_dinner", "label": "晚饭后", "window": "18:30～19:20内弹性开展", "budgetMinutes": 25}, {"id": "bedtime", "label": "睡前", "window": "并入原有睡前流程；准确时间待确认", "budgetMinutes": 10}], "items": items},
        "participationDraft": {"itemId": "sample-roll", "status": "played", "participantIds": ["sample-parent-a"], "addedBy": "sample-parent-b", "feedback": None, "persistence": "simulation-only"},
        "memoryDraft": {"text": "今天把球轻轻推回来，抬头看着我。（原创虚构故事）", "firstTimeConfirmed": False, "media": {"placeholder": True, "state": "pending_upload", "remoteVisible": False}},
        "measurementDraft": {"date": "2026-11-11", "kind": "length_height", "value": None, "unit": "cm", "method": None, "measurementSource": None, "referenceStandard": None, "percentile": None},
        "replacementSample": {"targetItemId": "sample-roll", "candidate": alternative, "shortenCandidateMinutes": 5, "confirmed": False, "mechanismStatus": "candidate"},
        "conflictSample": {"itemId": "sample-roll", "local": {"status": "played", "participantIds": ["sample-parent-a"], "addedBy": "sample-parent-b"}, "remote": {"status": "skipped", "feedback": "child_tired", "participantIds": ["sample-parent-b"], "addedBy": "sample-parent-b"}, "resolved": False, "mechanismStatus": "candidate"},
        "stageGuideSample": {"status": "design_sample_pending_content_review", "ageBand": "18～23月（产品编排区间）", "focus": "一起看图、等待和轮流", "everydayExample": "孩子指向书页，成人跟随指向描述眼前内容。", "parentSupport": "回应看、指或发声，不连续提问，不要求读完整本。", "playIdeas": ["选一页熟悉绘本一起看", "用图中主题和实物玩简单找物"], "easierVersion": "成人先描述一个动作，孩子只看也可以。", "optionalNextStep": "孩子愿意时，等待孩子先选页面或物品。", "source": {"title": "CDC18月家庭活动建议（依据研究笔记；此处为产品转译）", "url": "https://www.cdc.gov/act-early/milestones/18-months.html", "boundary": "18月节点不是18～23月逐月标准；此示例不是完整阶段清单或发育筛查。"}},
        "contentWorkflow": {"roles": ["demo_editor", "demo_reviewer"], "roleRulesStatus": "candidate", "draftItemId": "sample-roll", "publishedVersion": 1, "draftVersion": 2, "states": ["draft", "in_review", "changes_requested", "ready", "publishing", "published", "failed", "withdrawal_confirmation"], "operations": "simulation-only"},
        "scenarios": [{"id": sid, "surface": surface, "expected": expected, "simulationOnly": True} for sid, surface, expected in cases],
    }
    # 每次场景切换均复制initialState，再按顶层键替换overrides；嵌套值整块替换。
    # 草稿与已保存集合分开；所有引用只指向本文件，不是网络路径或API。
    result["scenarioInstructions"] = "每次复制initialState，用场景overrides逐个顶层键替换（嵌套对象整块替换），按daySource选择内容。所有#/引用均为本文件JSON Pointer；草稿只在activeDraft指定时展示。切换场景必须重置，不能继承上一场景的状态。"
    result["initialState"] = {
        "referenceNow": result["referenceNow"], "activeMemberId": "sample-parent-a",
        "network": "online", "requestState": "ready", "connectionState": "connected",
        "daySource": "#/day", "selectedItemId": "sample-roll", "activeDraft": None,
        "itemRecords": {}, "syncStates": {}, "memoryRecords": [], "photoPermission": "granted",
        "reminder": {"enabled": True, "time": "16:00", "permission": "granted", "status": "candidate"},
        "adminRole": "demo_editor", "workflowState": "draft", "failureReason": None,
        "printSelection": [], "includeMedia": False, "visiblePublishedVersion": 1,
    }
    future_item = copy.deepcopy(items[0])
    future_item["id"] = "future-sample-roll"
    result["futureDaySample"] = {"date": "2026-11-12", "status": "candidate_readonly_preview", "note": "只有一个未来内容块用于只读演示，不是已生成的完整明日计划", "items": [future_item]}
    saved = {"itemId": "sample-roll", "date": "2026-11-11", "status": "played", "participantIds": ["sample-parent-a"], "addedBy": "sample-parent-b", "feedback": None, "simulationOnly": True}
    result["savedRecordSample"] = saved
    workflow = result["contentWorkflow"]
    workflow["roles"] = ["demo_editor", "demo_reviewer", "demo_publisher", "demo_viewer"]
    workflow["permissions"] = {
        "demo_editor": ["edit_draft", "submit_review"],
        "demo_reviewer": ["review", "request_changes"],
        "demo_publisher": ["publish", "withdraw"],
        "demo_viewer": [],
    }
    workflow["draftContent"] = {**copy.deepcopy(items[0]), "title": "滚球慢慢来（草稿演示）"}
    workflow["reviewReason"] = "演示：补充滚球空间检查，并说明不要求孩子接球。"
    workflow["failureReason"] = "演示：发布暂不可用，请稍后重试。"
    workflow["withdrawalImpact"] = {"affectedItemIds": ["sample-roll"], "history": "保留原快照", "startedOrAdjusted": "不自动改写", "unstarted": "处理方式待确认；本原型仅展示影响提示"}
    pending_memory = {**copy.deepcopy(result["memoryDraft"]), "simulationOnly": True}
    result["textOnlyMemoryDraft"] = {**copy.deepcopy(result["memoryDraft"]), "media": None}
    failed_memory = copy.deepcopy(pending_memory)
    failed_memory["media"]["state"] = "failed"
    overrides = {
        "expanded_loading": {"requestState": "loading"},
        "expanded_service_error": {"requestState": "failed", "failureReason": "演示：服务暂不可用"},
        "expanded_connection_expired": {"connectionState": "expired"},
        "expanded_empty": {"daySource": None},
        "expanded_participation": {"activeDraft": "#/participationDraft"},
        "expanded_other_member": {"activeMemberId": "sample-parent-a", "itemRecords": {"sample-roll": saved}, "syncStates": {"sample-roll": "synced"}},
        "expanded_future": {"daySource": "#/futureDaySample", "selectedItemId": "future-sample-roll"},
        "expanded_offline_cached": {"network": "offline", "itemRecords": {"sample-roll": saved}, "syncStates": {"sample-roll": "pending"}},
        "expanded_offline_empty": {"network": "offline", "daySource": None},
        "expanded_sync_sending": {"itemRecords": {"sample-roll": saved}, "syncStates": {"sample-roll": "sending"}},
        "expanded_sync_failed": {"itemRecords": {"sample-roll": saved}, "syncStates": {"sample-roll": "failed"}, "failureReason": "演示：同步未成功，选择已保存在本机"},
        "expanded_sync_success": {"itemRecords": {"sample-roll": saved}, "syncStates": {"sample-roll": "synced"}},
        "expanded_conflict": {"activeDraft": "#/conflictSample", "syncStates": {"sample-roll": "conflict"}},
        "expanded_replace": {"activeDraft": "#/replacementSample"},
        "expanded_book_unverified": {"activeDraft": "#/books/0"},
        "expanded_stage": {"activeDraft": "#/stageGuideSample"},
        "expanded_memory_empty": {"memoryRecords": [], "activeDraft": None},
        "expanded_media_pending": {"memoryRecords": [pending_memory], "activeDraft": "#/memoryDraft"},
        "expanded_media_failure": {"memoryRecords": [failed_memory], "failureReason": "演示：照片未上传成功，文字已保留"},
        "expanded_media_denied": {"photoPermission": "denied", "activeDraft": "#/textOnlyMemoryDraft", "memoryRecords": []},
        "expanded_measurement": {"activeDraft": "#/measurementDraft"},
        "expanded_reminder_denied": {"reminder": {"enabled": True, "time": "16:00", "permission": "denied", "status": "candidate"}},
        "expanded_reminder_elapsed": {"referenceNow": "2026-11-11T12:00:00Z", "reminder": {"enabled": True, "time": "16:00", "permission": "granted", "status": "candidate"}},
        "expanded_parent_web": {"activeDraft": "#/stageGuideSample"},
        "expanded_print": {"printSelection": ["sample-roll"], "includeMedia": False},
        "expanded_admin_draft": {"adminRole": "demo_editor", "workflowState": "draft", "activeDraft": "#/contentWorkflow/draftContent"},
        "expanded_admin_review": {"adminRole": "demo_reviewer", "workflowState": "changes_requested", "activeDraft": "#/contentWorkflow/draftContent"},
        "expanded_admin_forbidden": {"adminRole": "demo_viewer", "workflowState": "ready"},
        "expanded_publish_failed": {"adminRole": "demo_publisher", "workflowState": "failed", "failureReason": workflow["failureReason"], "visiblePublishedVersion": 1},
        "expanded_publish_success": {"adminRole": "demo_publisher", "workflowState": "published", "visiblePublishedVersion": 2},
        "expanded_withdraw": {"adminRole": "demo_publisher", "workflowState": "withdrawal_confirmation", "activeDraft": "#/contentWorkflow/withdrawalImpact"},
    }
    for case in result["scenarios"]:
        case["overrides"] = overrides.get(case["id"], {})
    return result


def main() -> None:
    target = ROOT / "content/design/expanded-prototype.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    value = build()
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"OK: {target.relative_to(ROOT).as_posix()} ({len(value['scenarios'])} scenarios)")


if __name__ == "__main__":
    main()
