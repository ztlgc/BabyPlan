"""生成虚构设计场景；只读取本项目演示包，写入 content/design。"""
from __future__ import annotations

import copy
import json
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_NOW = "2026-11-11T04:00:00Z"
WEEK_ID = "00000000-0000-4000-8000-000000000001"


def demo_uuid(number: int) -> str:
    return f"00000000-0000-4000-8000-{number:012d}"


def build() -> dict:
    package = json.loads((ROOT / "content/demo/demo-content-package.json").read_text(encoding="utf-8"))
    cards = {card["id"]: card for card in package["cards"]}
    template = next(item for item in package["weekTemplates"] if item["id"] == "demo_week_m18")
    start = date(2026, 11, 9)
    tasks = []
    for index, card_id in enumerate(template["cardIds"]):
        day = start + timedelta(days=index)
        check_in = None
        if index < 2:
            check_in = {
                "status": "played" if index == 0 else "skipped",
                "feedback": "want_again" if index == 0 else "family_busy",
                "recordedAt": f"{day.isoformat()}T11:30:00Z",
                "syncedAt": f"{day.isoformat()}T11:30:01Z",
                "operationId": demo_uuid(201 + index),
            }
        tasks.append({
            "id": demo_uuid(101 + index), "date": day.isoformat(), "dayNumber": index + 1,
            "cardId": card_id, "cardSnapshot": copy.deepcopy(cards[card_id]),
            "checkIn": check_in, "revision": 1 if check_in else 0,
        })
    week = {
        "id": WEEK_ID, "startDate": start.isoformat(), "endDate": (start + timedelta(days=6)).isoformat(),
        "timezone": "Asia/Shanghai", "packageId": package["packageId"], "contentVersion": package["contentVersion"],
        "templateId": template["id"], "ageBand": template["ageBand"], "tasks": tasks,
    }
    cases = [
        {"id": "fresh_start", "stage": "M1", "pages": ["A01", "A07"], "weekSource": None, "network": "online", "local": {"baseMonths": 18, "baseDate": "2026-11-11", "reminderTime": "19:30", "reminderEnabled": False}, "expected": "确认开始日期和模板；未创建前无任务"},
        {"id": "today_unrecorded", "stage": "M1", "pages": ["A02", "A03"], "weekSource": "#/week", "selectedTaskId": tasks[2]["id"], "expected": "第3天拍手卡，当前未记录；可选玩过或跳过"},
        {"id": "core_fields_only", "stage": "M1", "pages": ["A02", "A03"], "weekSource": "#/week", "selectedTaskId": tasks[1]["id"], "expected": "历史滚球卡，无儿歌/英语/数感标题，可修改跳过结果"},
        {"id": "permission_denied", "stage": "M1", "pages": ["A06"], "weekSource": "#/week", "local": {"reminderEnabled": True, "notificationPermission": "denied"}, "expected": "显示系统权限关闭，与用户偏好区分；继续可记录"},
        {"id": "content_not_available_for_age", "stage": "M1", "pages": ["A01", "A07"], "weekSource": None, "local": {"baseMonths": 7}, "expected": "没有6～8月模板；不能开始或借用18月卡"},
        {"id": "content_stale", "stage": "M1", "pages": ["A01"], "weekSource": None, "httpStatus": 409, "errorCode": "CONTENT_STALE", "expected": "刷新内容选项并再次确认，不暗中改版本"},
        {"id": "offline_cached", "stage": "M2", "pages": ["A02", "A08"], "weekSource": "#/week", "network": "offline", "localIntents": [{"taskId": tasks[2]["id"], "status": "played", "feedback": "want_again", "syncState": "pending"}], "expected": "本机可见玩过待同步；服务器汇总仍1/1/1/4"},
        {"id": "offline_empty", "stage": "M2", "pages": ["A07"], "weekSource": None, "network": "offline", "expected": "没有已下载活动，提示联网；不伪造今日卡"},
        {"id": "revision_conflict", "stage": "M2", "pages": ["A08"], "weekSource": "#/week", "selectedTaskId": tasks[0]["id"], "httpStatus": 409, "errorCode": "REVISION_CONFLICT", "localIntents": [{"taskId": tasks[0]["id"], "status": "skipped", "feedback": "child_tired", "syncState": "conflict", "baseRevision": 0}], "expected": "服务端played/want_again/revision1与本机skipped分开；确认后新操作提交"},
        {"id": "future_readonly", "stage": "M2", "pages": ["A04", "A05"], "weekSource": "#/week", "selectedTaskId": tasks[4]["id"], "expected": "11月13日只读，不计未记录"},
        {"id": "week_ended", "stage": "M2", "pages": ["A04", "A07"], "weekSource": "#/week", "referenceNowOverride": "2026-11-16T04:00:00Z", "expected": "current为null，旧周仍可看；开始日11月16日，不自动建周"},
        {"id": "review_not_enough_data", "stage": "M4", "pages": ["A09"], "weekSource": "#/week", "reviewSimulation": {"outcome": "insufficient_data", "note": "仅原型状态，不对应已定义API或真实模型结果"}, "expected": "基础周报继续可见，建议不改任何计划"},
    ]
    # 下列状态仅供旧A页面验证，不为扩展需求增加接口或业务字段。
    cases.extend([
        {"id": "initial_loading", "stage": "M1", "pages": ["A01", "A02"], "weekSource": None, "requestState": "loading", "expected": "加载中有文字提示，不能当作无内容"},
        {"id": "request_failed", "stage": "M1", "pages": ["A01", "A02"], "weekSource": None, "network": "unavailable", "expected": "读取失败保留输入，明确重试，不按无历史创建"},
        {"id": "service_unavailable", "stage": "M1", "pages": ["A02", "A06"], "weekSource": None, "httpStatus": 503, "expected": "服务暂不可用，有恢复说明，不能显示没有内容"},
        {"id": "unauthorized", "stage": "M1", "pages": ["A02", "A06"], "weekSource": "#/week", "httpStatus": 401, "errorCode": "UNAUTHORIZED", "expected": "家庭服务连接已失效，请更新连接配置；保留本机数据"},
        {"id": "start_date_conflict", "stage": "M1", "pages": ["A01"], "weekSource": None, "httpStatus": 409, "errorCode": "START_DATE_CONFLICT", "expected": "刷新排期，用户重新确认日期；不暗中变更"},
        {"id": "planned_week_exists", "stage": "M1", "pages": ["A01", "A07"], "weekSource": None, "httpStatus": 409, "errorCode": "PLANNED_WEEK_EXISTS", "expected": "重新读取已有未来周；不假装样本旧周是未来周，不创建第二周"},
        {"id": "save_sending", "stage": "M1", "pages": ["A03"], "weekSource": "#/week", "selectedTaskId": tasks[2]["id"], "requestState": "sending", "expected": "正在保存并禁止重复点击；不提前标成功"},
        {"id": "save_unconfirmed", "stage": "M1", "pages": ["A03"], "weekSource": "#/week", "selectedTaskId": tasks[2]["id"], "requestState": "timeout", "expected": "结果未确认，保留输入；原操作重试，不生成新意图"},
        {"id": "sync_sending", "stage": "M2", "pages": ["A08"], "weekSource": "#/week", "localIntents": [{"taskId": tasks[2]["id"], "status": "played", "feedback": None, "syncState": "sending"}], "expected": "发送中；旧响应不覆盖更晚本机意图"},
        {"id": "sync_failed", "stage": "M2", "pages": ["A08"], "weekSource": "#/week", "localIntents": [{"taskId": tasks[2]["id"], "status": "played", "feedback": None, "syncState": "failed"}], "expected": "保留本机选择，显示失败与重试，不显示已同步"},
        {"id": "sync_success", "stage": "M2", "pages": ["A08"], "weekSource": "#/week", "selectedTaskId": tasks[2]["id"], "simulation": {"result": "acknowledged", "note": "仅模拟对应操作确认，不修改基础快照"}, "expected": "模拟收到对应确认后标同步成功；若仍有更晚意图则继续待同步"},
        {"id": "reminder_time_elapsed", "stage": "M1", "pages": ["A06"], "weekSource": "#/week", "referenceNowOverride": "2026-11-11T12:00:00Z", "local": {"reminderEnabled": True, "reminderTime": "19:30", "notificationPermission": "granted"}, "expected": "家庭20:00已过19:30，今天不追发；未声称真实投递"},
        {"id": "today_outside_plan", "stage": "M1", "pages": ["A07"], "weekSource": "#/week", "referenceNowOverride": "2026-11-08T04:00:00Z", "expected": "今天尚无任务，展示已排11月9日开始计划，不显示历史或未来卡为今日"},
        {"id": "edit_cancel", "stage": "M1", "pages": ["A03"], "weekSource": "#/week", "selectedTaskId": tasks[0]["id"], "expected": "played切skipped清除want_again；未保存取消仍保留原played结果"},
        {"id": "review_proposal", "stage": "M4", "pages": ["A09"], "weekSource": "#/week", "reviewSimulation": {"outcome": "proposal", "candidateTitle": "下周再玩一次熟悉活动", "note": "只有设计占位；基础样本只有一次want_again，不声称满足两次偏好证据或可调用建议API"}, "expected": "替换前后和目标日期在正式样本补齐前使用占位；不能真实确认或修改计划"},
        {"id": "review_failed", "stage": "M4", "pages": ["A09"], "weekSource": "#/week", "reviewSimulation": {"outcome": "unavailable", "note": "仅原型，不对应API"}, "expected": "建议暂不可用，基础周报仍可看"},
        {"id": "review_expired", "stage": "M4", "pages": ["A09"], "weekSource": "#/week", "reviewSimulation": {"outcome": "expired", "note": "仅原型，不对应API"}, "expected": "旧建议已失效，先刷新，不允许直接确认"},
    ])
    return {
        "fixtureVersion": 2,
        "description": "虚构设计数据；只用于原型，不包含凭证或真实家庭记录。scenarios不是API响应。",
        "referenceNow": REFERENCE_NOW, "timezone": "Asia/Shanghai",
        "instructions": "weekSource指向本文件JSON Pointer；复用week，应用场景的本地覆盖项，不修改服务器快照。无override时使用固定referenceNow。",
        "week": week,
        "expectedBaseCounts": {"played": 1, "skipped": 1, "unrecorded": 1, "future": 4},
        "scenarios": cases,
    }


def main() -> None:
    result = build()
    target = ROOT / "content/design/design-scenarios.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"OK: {target.relative_to(ROOT).as_posix()} ({len(result['scenarios'])} scenarios)")


if __name__ == "__main__":
    main()
