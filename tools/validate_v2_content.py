"""校验 BabyPlan v2 内容包；只读本地文件，不联网、不写报告或修改输入。"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import SchemaError


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "contracts/v2/content-package.schema.json"
AGE_BANDS = {"m12_14": (12, 14), "m15_17": (15, 17), "m18_23": (18, 23), "m24_29": (24, 29), "m30_35": (30, 35), "m36": (36, 36)}
SOURCE_NODE_AGES = {"CDC12": 12, "CDC15": 15, "CDC18": 18, "CDC24": 24, "CDC30": 30, "CDC36": 36}
SLOTS = {
    "movement": ("before", 15), "explore": ("before", 10),
    "reading": ("after", 10), "english": ("after", 10),
    "child-led": ("after", 5), "calm": ("bedtime", 10),
}
REVIEW_CHECKS = {"sources", "age_safety", "language", "rights"}
ENVIRONMENTS = {"private_trial", "public"}
HASH_EXCLUDED_FIELDS = {"reviewState", "withdrawn", "evidenceRefs"}
EVIDENCE_COMMON_FIELDS = {
    "id", "kind", "cardId", "revision", "contentHash", "actorId", "actorKind",
    "createdAt", "decision", "evidenceRef",
}
EVIDENCE_KIND_FIELDS = {
    "editorial_review": {"authorId", "selfReviewed", "checks"},
    "expert_review": {"authorId", "selfReviewed", "qualificationRef"},
    "family_trial": {"completedAt"},
    "rights_license": {"authorizationRef", "scope", "allowedEnvironments"},
}


@dataclass(frozen=True)
class ValidationIssue:
    path: str
    code: str
    message: str


class ValidatorConfigurationError(ValueError):
    """Schema 配置错误；与输入内容不合格区分。"""


def _pointer(parts: list[Any] | tuple[Any, ...]) -> str:
    return "/" + "/".join(str(p).replace("~", "~0").replace("/", "~1") for p in parts)


def _issue(issues: list[ValidationIssue], path: str, code: str, message: str) -> None:
    issues.append(ValidationIssue(path, code, message))


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"JSON 对象含重复字段：{key}")
        value[key] = item
    return value


def _reject_constant(value: str) -> None:
    raise ValueError(f"JSON 不允许非有限数值：{value}")


def load_json(path: Path | str) -> Any:
    """接受 UTF-8/BOM，拒绝重复键及 NaN/Infinity，不访问网络。"""
    with Path(path).open(encoding="utf-8-sig") as handle:
        return json.load(handle, object_pairs_hook=_unique_object, parse_constant=_reject_constant)


def canonical_card_hash(card: Mapping[str, Any]) -> str:
    """正文 hash 不含审核/撤回状态及证据引用，避免审批状态变化使自身失效。"""
    body = {key: value for key, value in card.items() if key not in HASH_EXCLUDED_FIELDS}
    encoded = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _schema_issues(data: Any, schema: Mapping[str, Any]) -> list[ValidationIssue]:
    # 禁止 JSON Schema 自动读取远程引用；本工具是离线校验器。
    def inspect(value: Any) -> None:
        if isinstance(value, dict):
            for key in ("$ref", "$dynamicRef"):
                if key in value and (not isinstance(value[key], str) or not value[key].startswith("#")):
                    raise ValidatorConfigurationError("Schema 只允许文档内的 # 引用")
            for child in value.values():
                inspect(child)
        elif isinstance(value, list):
            for child in value:
                inspect(child)

    inspect(schema)
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as error:
        raise ValidatorConfigurationError(f"Schema 无效：{error.message}") from error
    issues = []
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    for error in validator.iter_errors(data):
        parts = list(error.absolute_path)
        if error.validator == "required" and isinstance(error.instance, dict):
            for key in error.validator_value:
                if key not in error.instance and error.message == f"{key!r} is a required property":
                    parts.append(key)
                    break
        issues.append(ValidationIssue(_pointer(parts), "SCHEMA_INVALID", error.message))
    return sorted(issues, key=lambda item: (item.path, item.message))


def _index(items: list[dict[str, Any]], field: str, path: str, issues: list[ValidationIssue]) -> dict[str, dict[str, Any]]:
    result = {}
    for index, item in enumerate(items):
        key = item[field]
        if key in result:
            _issue(issues, f"{path}/{index}/{field}", "DUPLICATE_ID", "标识重复")
        else:
            result[key] = item
    return result


def _unique_strings(items: list[str], path: str, issues: list[ValidationIssue]) -> None:
    seen: set[str] = set()
    for index, item in enumerate(items):
        if item in seen:
            _issue(issues, f"{path}/{index}", "DUPLICATE_REFERENCE", "引用重复")
        seen.add(item)


def _validate_nonblank(value: Any, issues: list[ValidationIssue], path: tuple[Any, ...] = ()) -> None:
    if isinstance(value, str) and not value.strip():
        _issue(issues, _pointer(path), "EMPTY_TEXT", "正文或标识不能只有空白")
    elif isinstance(value, dict):
        for key, item in value.items():
            _validate_nonblank(item, issues, (*path, key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _validate_nonblank(item, issues, (*path, index))


def _nonblank(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not FormatChecker().conforms(value, "date-time"):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00").replace("z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.utcoffset() is not None else None


def validate_evidence_registry(registry: Any) -> list[ValidationIssue]:
    """校验可信审核流程导出的台账形状；不能仅凭 JSON 确认真有人完成审读。"""
    issues: list[ValidationIssue] = []
    if not isinstance(registry, dict):
        return [ValidationIssue("/evidenceRegistry", "EVIDENCE_REGISTRY_INVALID", "证据台账必须是对象")]
    if type(registry.get("schemaVersion")) is not int or registry["schemaVersion"] != 1:
        _issue(issues, "/evidenceRegistry/schemaVersion", "EVIDENCE_REGISTRY_INVALID", "证据台账版本必须为 1")
    if set(registry) - {"schemaVersion", "records"}:
        _issue(issues, "/evidenceRegistry", "EVIDENCE_REGISTRY_INVALID", "证据台账含未知字段")
    records = registry.get("records")
    if not isinstance(records, list):
        _issue(issues, "/evidenceRegistry/records", "EVIDENCE_REGISTRY_INVALID", "records 必须是数组")
        return issues
    seen: set[str] = set()
    for index, record in enumerate(records):
        path = f"/evidenceRegistry/records/{index}"
        if not isinstance(record, dict):
            _issue(issues, path, "EVIDENCE_RECORD_INVALID", "证据记录必须是对象")
            continue
        kind = record.get("kind")
        if not isinstance(kind, str) or kind not in EVIDENCE_KIND_FIELDS:
            _issue(issues, f"{path}/kind", "EVIDENCE_KIND_INVALID", "未知证据类型")
            continue
        fields = EVIDENCE_COMMON_FIELDS | EVIDENCE_KIND_FIELDS[kind]
        for missing in sorted(fields - set(record)):
            _issue(issues, f"{path}/{missing}", "EVIDENCE_FIELD_REQUIRED", "缺少证据字段")
        if set(record) - fields:
            _issue(issues, path, "EVIDENCE_UNKNOWN_FIELD", "证据记录含未知字段")
        string_fields = fields - {"revision", "selfReviewed", "checks", "allowedEnvironments"}
        for field in sorted(string_fields & set(record)):
            if not _nonblank(record[field]):
                _issue(issues, f"{path}/{field}", "EVIDENCE_FIELD_INVALID", "必须是非空字符串")
        record_id = record.get("id")
        if _nonblank(record_id):
            if record_id in seen:
                _issue(issues, f"{path}/id", "DUPLICATE_EVIDENCE_ID", "证据 ID 重复")
            seen.add(record_id)
        if type(record.get("revision")) is not int or record["revision"] < 1:
            _issue(issues, f"{path}/revision", "EVIDENCE_FIELD_INVALID", "修订号必须是正整数")
        if not isinstance(record.get("contentHash"), str) or not re.fullmatch(r"[0-9a-f]{64}", record["contentHash"]):
            _issue(issues, f"{path}/contentHash", "EVIDENCE_HASH_INVALID", "正文 hash 必须为小写 SHA-256")
        if record.get("actorKind") != "human":
            _issue(issues, f"{path}/actorKind", "HUMAN_EVIDENCE_REQUIRED", "人工审核和试玩证据不能登记为 AI 生成")
        if record.get("decision") not in ("approved", "rejected"):
            _issue(issues, f"{path}/decision", "EVIDENCE_DECISION_INVALID", "证据结论必须为 approved 或 rejected")
        created_at = _timestamp(record.get("createdAt"))
        if created_at is None:
            _issue(issues, f"{path}/createdAt", "EVIDENCE_DATE_INVALID", "必须是带时区的 ISO 日期时间")
        if kind in ("editorial_review", "expert_review"):
            self_reviewed = record.get("selfReviewed")
            if type(self_reviewed) is not bool:
                _issue(issues, f"{path}/selfReviewed", "EVIDENCE_FIELD_INVALID", "自审状态必须是布尔值")
            elif _nonblank(record.get("actorId")) and _nonblank(record.get("authorId")):
                if self_reviewed != (record["actorId"] == record["authorId"]):
                    _issue(issues, f"{path}/selfReviewed", "SELF_REVIEW_MISMATCH", "自审状态与作者、审读者身份不一致")
        if kind == "editorial_review":
            checks = record.get("checks")
            if not isinstance(checks, list) or not all(isinstance(item, str) for item in checks) or len(checks) != 4 or set(checks) != REVIEW_CHECKS:
                _issue(issues, f"{path}/checks", "REVIEW_CHECKS_INCOMPLETE", "须包含四个不同检查项：来源、适龄材料、语言、权属")
        elif kind == "family_trial":
            completed_at = _timestamp(record.get("completedAt"))
            if completed_at is None:
                _issue(issues, f"{path}/completedAt", "EVIDENCE_DATE_INVALID", "试玩完成时间必须带时区")
            elif created_at is not None and completed_at > created_at:
                _issue(issues, f"{path}/completedAt", "EVIDENCE_DATE_INVALID", "试玩完成不能晚于该完成证据的记录时间")
        elif kind == "rights_license":
            environments = record.get("allowedEnvironments")
            if not isinstance(environments, list) or not environments or not all(isinstance(item, str) and item in ENVIRONMENTS for item in environments) or len(environments) != len(set(environments)):
                _issue(issues, f"{path}/allowedEnvironments", "LICENSE_SCOPE_INVALID", "授权环境须是非空、不重复的 private_trial/public 数组")
    return issues


def _matched_records(card: Mapping[str, Any], records: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    card_hash = canonical_card_hash(card)
    return [record for record in records if record["kind"] == kind and record["cardId"] == card["id"]
            and record["revision"] == card["revision"] and record["contentHash"] == card_hash
            and record["decision"] == "approved"]


def _validate_licenses(package: Mapping[str, Any], records: list[dict[str, Any]]) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    for index, card in enumerate(package["cards"]):
        if card["rights"] != "licensed":
            continue
        licenses = _matched_records(card, records, "rights_license")
        environment = package.get("publicationEnvironment") if package.get("channel") == "release" else None
        if not licenses:
            _issue(issues, f"/cards/{index}/rights", "LICENSE_EVIDENCE_REQUIRED", "licensed 必须有绑定该修订与正文的有效授权证据")
        elif environment and not any(environment in record["allowedEnvironments"] for record in licenses):
            _issue(issues, f"/cards/{index}/rights", "LICENSE_ENVIRONMENT_DENIED", "授权范围不包含本次发布环境")
    return issues


def validate_publication_evidence(package: Any, evidence_registry: Any = None) -> list[ValidationIssue]:
    """独立发布门禁。调用者先做内容结构校验，台账须由可信审核流程提供。"""
    if not isinstance(package, dict) or not isinstance(package.get("cards"), list):
        return [ValidationIssue("/cards", "PACKAGE_STRUCTURE_REQUIRED", "先校验内容包结构")]
    if package.get("channel") != "release":
        return []
    issues: list[ValidationIssue] = []
    environment = package.get("publicationEnvironment")
    if environment not in ("private_trial", "public"):
        _issue(issues, "/publicationEnvironment", "PUBLICATION_ENVIRONMENT_REQUIRED", "release 须声明 private_trial 或 public")
    review = package.get("review")
    if not isinstance(review, dict):
        return issues + [ValidationIssue("/review", "PACKAGE_STRUCTURE_REQUIRED", "缺少审核状态对象")]
    if review.get("editorial") != "approved":
        _issue(issues, "/review/editorial", "EDITORIAL_APPROVAL_REQUIRED", "发布前须完成真实人工审读")
    if environment == "public" and review.get("familyTrial") != "completed":
        _issue(issues, "/review/familyTrial", "FAMILY_TRIAL_REQUIRED", "公开发布须完成家庭试玩")
    references = package.get("evidenceRefs")
    if not isinstance(references, list) or not references or not all(_nonblank(ref) for ref in references):
        _issue(issues, "/evidenceRefs", "EVIDENCE_REFERENCES_REQUIRED", "release 须引用非空的证据 ID 数组")
        references = []
    else:
        _unique_strings(references, "/evidenceRefs", issues)
    if evidence_registry is None:
        return issues + [ValidationIssue("/evidenceRegistry", "EVIDENCE_REGISTRY_REQUIRED", "发布校验必须提供可信审核证据台账")]
    registry_issues = validate_evidence_registry(evidence_registry)
    if registry_issues:
        return issues + registry_issues
    cards = package["cards"]
    required_card_fields = {"id", "revision", "reviewState", "withdrawn", "rights"}
    if any(not isinstance(card, dict) or not required_card_fields <= set(card) for card in cards):
        return issues + [ValidationIssue("/cards", "PACKAGE_STRUCTURE_REQUIRED", "先校验每张卡的完整结构")]
    by_id = {record["id"]: record for record in evidence_registry["records"]}
    by_card = {card["id"]: card for card in cards}
    selected: list[dict[str, Any]] = []
    for index, reference in enumerate(references):
        path = f"/evidenceRefs/{index}"
        record = by_id.get(reference)
        if record is None:
            _issue(issues, path, "EVIDENCE_REFERENCE_UNKNOWN", "证据 ID 不在提供的台账中")
            continue
        card = by_card.get(record["cardId"])
        if card is None:
            _issue(issues, path, "EVIDENCE_SUBJECT_UNKNOWN", "所引证据对应的卡不属于此包")
            continue
        if record["revision"] != card["revision"] or record["contentHash"] != canonical_card_hash(card):
            _issue(issues, path, "EVIDENCE_CONTENT_MISMATCH", "审读证据与当前修订或正文不匹配，须重新审读")
            continue
        if record["decision"] != "approved":
            _issue(issues, path, "EVIDENCE_NOT_APPROVED", "不可用退回结论作为发布凭据")
            continue
        if environment == "public" and record["kind"] == "editorial_review" and record["selfReviewed"]:
            _issue(issues, path, "INDEPENDENT_REVIEW_REQUIRED", "公开发布不能用自审记录代替独立审阅")
        selected.append(record)
    for index, card in enumerate(cards):
        path = f"/cards/{index}"
        if card["reviewState"] != "reviewed":
            _issue(issues, f"{path}/reviewState", "CARD_REVIEW_REQUIRED", "发布卡须经过审读")
        if card["withdrawn"]:
            _issue(issues, f"{path}/withdrawn", "WITHDRAWN_RELEASE_CARD", "撤回卡不能进入新发布包")
        reviews = _matched_records(card, selected, "editorial_review")
        if environment == "public":
            reviews = [record for record in reviews if not record["selfReviewed"]]
        if not reviews:
            _issue(issues, path, "EDITORIAL_EVIDENCE_REQUIRED", "缺少绑定该正文的合格人工审读证据")
        if review.get("familyTrial") == "completed" and not _matched_records(card, selected, "family_trial"):
            _issue(issues, path, "FAMILY_TRIAL_EVIDENCE_REQUIRED", "宣称试玩完成须有该卡实际试玩证据")
        if review.get("expert") == "reviewed" and not _matched_records(card, selected, "expert_review"):
            _issue(issues, path, "EXPERT_EVIDENCE_REQUIRED", "宣称专业审阅须有该卡相应证据")
    return issues + _validate_licenses(package, selected)


def validate_content(
    package: Any, *, schema: Mapping[str, Any] | None = None,
    evidence_registry: Any = None, require_release: bool = False,
    source_node_ages: Mapping[str, int] | None = None,
) -> list[ValidationIssue]:
    """返回字段路径、稳定错误码和说明，不修改输入。结构错误后不继续索引正文。"""
    active_schema = schema if schema is not None else load_json(SCHEMA_PATH)
    issues = _schema_issues(package, active_schema)
    if issues:
        # JSON Schema 的 uniqueItems 能拒绝完全相同的对象，但不会指出哪个业务
        # 标识重复。保留结构错误的同时补上稳定、可定位的诊断，避免维护者
        # 只看到整段数组和笼统的 SCHEMA_INVALID。
        if isinstance(package, Mapping):
            for collection, key, code, message in (
                ("ageBands", "id", "DUPLICATE_ID", "标识重复"),
                ("sources", "id", "DUPLICATE_ID", "标识重复"),
                ("cards", "id", "DUPLICATE_ID", "标识重复"),
                ("books", "id", "DUPLICATE_ID", "标识重复"),
                ("stageGuides", "ageBand", "DUPLICATE_STAGE_GUIDE", "同年龄档的阶段支持组重复"),
            ):
                values = package.get(collection)
                if not isinstance(values, list):
                    continue
                seen: set[Any] = set()
                for index, item in enumerate(values):
                    if not isinstance(item, Mapping):
                        continue
                    value = item.get(key)
                    if not isinstance(value, (str, int)):
                        continue
                    if value in seen:
                        _issue(issues, f"/{collection}/{index}/{key}", code, message)
                    else:
                        seen.add(value)
        return issues
    if require_release and package["channel"] != "release":
        _issue(issues, "/channel", "RELEASE_REQUIRED", "候选包只能用于工程测试，不能作为已发布内容")
    _validate_nonblank(package, issues)
    bands = _index(package["ageBands"], "id", "/ageBands", issues)
    cards = _index(package["cards"], "id", "/cards", issues)
    sources = _index(package["sources"], "id", "/sources", issues)
    _index(package["books"], "id", "/books", issues)
    for index, band in enumerate(package["ageBands"]):
        expected = AGE_BANDS[band["id"]]
        if (band["minMonths"], band["maxMonths"]) != expected:
            _issue(issues, f"/ageBands/{index}", "AGE_RANGE_MISMATCH", "年龄档标识与月份范围不一致")
    for index, source in enumerate(package["sources"]):
        url = urlsplit(source["url"])
        if url.scheme not in ("http", "https") or not url.netloc:
            _issue(issues, f"/sources/{index}/url", "SOURCE_URL_INVALID", "来源应是可核验的 HTTP(S) 页面地址")
    for index, card in enumerate(package["cards"]):
        path = f"/cards/{index}"
        _unique_strings(card["ageBands"], f"{path}/ageBands", issues)
        _unique_strings(card["sourceIds"], f"{path}/sourceIds", issues)
        for position, band in enumerate(card["ageBands"]):
            if band not in bands:
                _issue(issues, f"{path}/ageBands/{position}", "UNKNOWN_AGE_BAND", "该年龄档没有定义")
        for position, source in enumerate(card["sourceIds"]):
            if source not in sources:
                _issue(issues, f"{path}/sourceIds/{position}", "UNKNOWN_SOURCE", "该来源没有定义")
    week = package["week"]
    if week["ageBand"] not in bands:
        _issue(issues, "/week/ageBand", "UNKNOWN_AGE_BAND", "周计划年龄档没有定义")
    if [day["day"] for day in week["days"]] != list(range(1, 8)):
        _issue(issues, "/week/days", "WEEK_DAY_SEQUENCE", "七天须按第 1 至第 7 天排列且不重复")
    item_ids: set[str] = set()
    for day_index, day in enumerate(week["days"]):
        path = f"/week/days/{day_index}/items"
        if sum(item["minutes"] for item in day["items"]) != week["budgetMinutes"]:
            _issue(issues, path, "DAILY_BUDGET_MISMATCH", "当天合计预算与周计划预算不一致")
        if sorted(item["kind"] for item in day["items"]) != sorted(SLOTS):
            _issue(issues, path, "SLOT_COVERAGE_MISMATCH", "每天须各有一个运动、探索、共读、英语、孩子主导和安静收尾项")
        for block, minutes in (("before", 25), ("after", 25), ("bedtime", 10)):
            if sum(item["minutes"] for item in day["items"] if item["block"] == block) != minutes:
                _issue(issues, path, "BLOCK_BUDGET_MISMATCH", f"{block} 分段预算应为 {minutes}")
        for item_index, item in enumerate(day["items"]):
            item_path = f"{path}/{item_index}"
            if item["id"] in item_ids:
                _issue(issues, f"{item_path}/id", "DUPLICATE_ID", "计划项 ID 在一周内重复")
            item_ids.add(item["id"])
            if (item["block"], item["minutes"]) != SLOTS[item["kind"]]:
                _issue(issues, item_path, "SLOT_ALLOCATION_MISMATCH", "项目用途、分段和预算不符合标准六槽安排")
            card = cards.get(item["cardId"])
            if card is None:
                _issue(issues, f"{item_path}/cardId", "UNKNOWN_CARD", "计划引用的卡不存在")
                continue
            if card["kind"] != item["kind"]:
                _issue(issues, f"{item_path}/cardId", "CARD_KIND_MISMATCH", "卡片用途与计划槽位不一致")
            if week["ageBand"] not in card["ageBands"]:
                _issue(issues, f"{item_path}/cardId", "CARD_AGE_MISMATCH", "卡片不属于此计划年龄档")
            if card["withdrawn"]:
                _issue(issues, f"{item_path}/cardId", "WITHDRAWN_CARD_SELECTED", "计划不可选择撤回卡")
    daily = package.get("dailyPlans")
    if daily:
        if [day["day"] for day in daily["days"]] != list(range(1, 366)):
            _issue(issues, "/dailyPlans/days", "DAILY_SEQUENCE", "每日计划须按第 1～365 天连续排列")
        daily_ids: set[str] = set()
        daily_cards: set[str] = set()
        for index, day in enumerate(daily["days"]):
            band = "m12_14" if day["day"] <= 91 else "m15_17" if day["day"] <= 182 else "m18_23"
            for position, item in enumerate(day["items"]):
                path = f"/dailyPlans/days/{index}/items/{position}"
                if item["id"] in daily_ids or item["cardId"] in daily_cards:
                    _issue(issues, path, "DUPLICATE_ID", "每日计划项和活动不可重复引用")
                daily_ids.add(item["id"])
                daily_cards.add(item["cardId"])
                card = cards.get(item["cardId"])
                if not card:
                    _issue(issues, path, "UNKNOWN_CARD", "每日计划引用的活动不存在")
                elif card["kind"] != item["kind"] or band not in card["ageBands"] or card["withdrawn"]:
                    _issue(issues, path, "DAILY_CARD_MISMATCH", "每日活动的用途、月龄或撤回状态不符合要求")
    node_ages = {**SOURCE_NODE_AGES, **(source_node_ages or {})}
    guide_bands: set[str] = set()
    focus_ids: set[str] = set()
    for guide_index, guide in enumerate(package["stageGuides"]):
        path = f"/stageGuides/{guide_index}"
        band_id = guide["ageBand"]
        if band_id not in bands:
            _issue(issues, f"{path}/ageBand", "UNKNOWN_AGE_BAND", "阶段年龄档没有定义")
        if band_id in guide_bands:
            _issue(issues, f"{path}/ageBand", "DUPLICATE_STAGE_GUIDE", "同年龄档的阶段支持组重复")
        guide_bands.add(band_id)
        if guide["sourceAgeMonths"] != AGE_BANDS[band_id][0]:
            _issue(issues, f"{path}/sourceAgeMonths", "SOURCE_NODE_MISMATCH", "来源节点月份与此阶段不对应")
        if guide["sourceId"] not in sources:
            _issue(issues, f"{path}/sourceId", "UNKNOWN_SOURCE", "阶段来源没有定义")
        elif guide["sourceId"] in node_ages and node_ages[guide["sourceId"]] != guide["sourceAgeMonths"]:
            _issue(issues, f"{path}/sourceId", "SOURCE_NODE_MISMATCH", "来源 ID 对应另一年龄节点")
        for focus_index, focus in enumerate(guide["focuses"]):
            focus_path = f"{path}/focuses/{focus_index}"
            if focus["id"] in focus_ids:
                _issue(issues, f"{focus_path}/id", "DUPLICATE_ID", "阶段支持 ID 重复")
            focus_ids.add(focus["id"])
            _unique_strings(focus["cardIds"], f"{focus_path}/cardIds", issues)
            for card_index, card_id in enumerate(focus["cardIds"]):
                card = cards.get(card_id)
                card_path = f"{focus_path}/cardIds/{card_index}"
                if card is None:
                    _issue(issues, card_path, "UNKNOWN_CARD", "阶段支持引用的卡不存在")
                elif band_id not in card["ageBands"]:
                    _issue(issues, card_path, "GUIDE_CARD_AGE_MISMATCH", "阶段支持不可引用其他年龄档卡片")
                elif card["withdrawn"]:
                    _issue(issues, card_path, "WITHDRAWN_CARD_SELECTED", "阶段支持不可继续推荐撤回卡")
    if package["channel"] == "release":
        issues.extend(validate_publication_evidence(package, evidence_registry))
    elif evidence_registry is not None:
        evidence_issues = validate_evidence_registry(evidence_registry)
        issues.extend(evidence_issues)
        if not evidence_issues:
            issues.extend(_validate_licenses(package, evidence_registry["records"]))
    else:
        issues.extend(_validate_licenses(package, []))
    return issues


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path, help="待校验的 UTF-8 v2 内容包")
    parser.add_argument("--schema", type=Path, default=SCHEMA_PATH, help="本地 Schema；禁止远程引用")
    parser.add_argument("--evidence-registry", type=Path, help="可信审核流程导出的证据台账")
    parser.add_argument("--release", action="store_true", help="要求输入为 release，并执行真实证据引用门禁")
    parser.add_argument("--format", choices=("text", "json"), default="text", help="输出格式；不会写入文件")
    args = parser.parse_args(argv)
    exit_code = 1
    try:
        package = load_json(args.package)
        schema = load_json(args.schema)
        registry = load_json(args.evidence_registry) if args.evidence_registry else None
        issues = validate_content(package, schema=schema, evidence_registry=registry, require_release=args.release)
        exit_code = 1 if issues else 0
    except (OSError, ValidatorConfigurationError) as error:
        issues = [ValidationIssue("/", "VALIDATOR_SETUP_ERROR", str(error))]
        exit_code = 2
    except (ValueError, UnicodeError) as error:
        issues = [ValidationIssue("/", "JSON_INVALID", str(error))]
    result = {"valid": exit_code == 0, "errors": [asdict(issue) for issue in issues], "exitCode": exit_code}
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    elif issues:
        for issue in issues:
            print(f"ERROR {issue.code} {issue.path}: {issue.message}", file=sys.stderr)
    else:
        print(f"OK: {package['packageId']} v{package['contentVersion']} ({package['channel']})，{len(package['cards'])} 张卡；未写文件")
    return exit_code


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
