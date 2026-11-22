"""校验设计交接资料并生成ZIP；不访问网络，不执行产品代码。"""
from __future__ import annotations

import copy
import importlib.util
import json
import re
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urldefrag
from zipfile import ZIP_DEFLATED, ZipFile

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[1]
API_PATH = ROOT / "contracts/openapi.yaml"
SCHEMA_PATH = ROOT / "contracts/content-package.schema.json"
OUTPUT = ROOT / "deliverables"
REPORT = OUTPUT / "设计交接包校验报告.md"
BUNDLE = OUTPUT / "BabyPlan-原型设计输入包-v0.2.zip"


def files_to_ship() -> list[Path]:
    files = [ROOT / "README.md", ROOT / "CLAUDE.md", ROOT / "content/README.md", ROOT / "deliverables/README.md"]
    files += sorted((ROOT / "docs").rglob("*.md"))
    files += [API_PATH, SCHEMA_PATH, ROOT / "content/demo/demo-content-package.json", ROOT / "content/design/design-scenarios.json", ROOT / "docs/archive/首周活动模板.json"]
    files += [ROOT / "content/design/expanded-prototype.json", ROOT / "docs/design/visual-tokens.json"]
    files += [ROOT / "tools/validate_content.py", ROOT / "tools/build_design_scenarios.py", ROOT / "tools/build_expanded_prototype.py", ROOT / "tools/package_design_handoff.py"]
    files += [ROOT / "prototype/README.md", ROOT / "prototype/index.html", ROOT / "prototype/验证记录.md"]
    for surface in ("mobile", "parent", "admin"):
        files += sorted((ROOT / "prototype" / surface).glob("*.*"))
    files += [ROOT / "tools/build_mobile_prototype.py", ROOT / "tools/serve_prototype.py"]
    return files


def read_json(path: Path):
    def unique(pairs):
        obj = {}
        for key, value in pairs:
            if key in obj:
                raise ValueError(f"重复JSON键: {key}")
            obj[key] = value
        return obj
    return json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=unique)


def nodes(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from nodes(child)


def pointer(document, fragment):
    current = document
    if not fragment:
        return current
    if not fragment.startswith("/"):
        raise ValueError(f"不支持非JSON Pointer引用: {fragment}")
    for segment in fragment[1:].split("/"):
        key = unquote(segment).replace("~1", "/").replace("~0", "~")
        current = current[int(key)] if isinstance(current, list) else current[key]
    return current


def source_module(filename: str):
    path = ROOT / "tools" / filename
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_expanded_fixture(fixture: dict) -> int:
    if fixture["kind"] != "expanded-design-only" or fixture["dataClass"] != "fictional":
        raise ValueError("扩展样本必须标记为虚构设计数据")
    if fixture["networkPolicy"] != "local-simulation-only":
        raise ValueError("扩展原型不能连接旧API")
    if fixture != source_module("build_expanded_prototype.py").build():
        raise ValueError("扩展样本与构建脚本不一致，请重建")
    if fixture["referenceNow"] != "2026-11-11T07:00:00Z" or fixture["timezone"] != "Asia/Shanghai" or fixture["businessDate"] != "2026-11-11":
        raise ValueError("扩展样本必须使用约定的固定时钟与业务日")
    members = {member["id"] for member in fixture["family"]["members"]}
    if len(members) != 2:
        raise ValueError("扩展样本需要两个不同虚构成员")
    segments = fixture["day"]["segments"]
    segment_ids = {segment["id"] for segment in segments}
    if len(segment_ids) != 3:
        raise ValueError("扩展样本分段ID重复或数量错误")
    items = fixture["day"]["items"]
    item_ids = {item["id"] for item in items}
    if len(item_ids) != len(items):
        raise ValueError("扩展样本内容ID重复")
    books = {book["id"] for book in fixture["books"]}
    for item in items:
        if item["segmentId"] not in segment_ids or item["budgetMinutes"] <= 0:
            raise ValueError("扩展内容的分段引用或预算无效")
        if item.get("bookId") and item["bookId"] not in books:
            raise ValueError("扩展内容引用未知书目")
        if set(item["dialogue"]) != {"opening", "whenJoins", "whenWatches", "whenStops"}:
            raise ValueError("扩展内容缺少四类家长回应")
        if not item["steps"] or not item["safety"] or item["participation"] is not None:
            raise ValueError("扩展内容必须有步骤和安全提示，初始不能伪造已开展")
        for line in item.get("english", []):
            if not all(line.get(key) for key in ("line", "meaningZh", "when", "action")):
                raise ValueError("英语示例必须包含中文意思、时机与动作")
    for segment in segments:
        total = sum(item["budgetMinutes"] for item in items if item["segmentId"] == segment["id"])
        if total != segment["budgetMinutes"]:
            raise ValueError("分段预算与内容合计不符")
    if sum(segment["budgetMinutes"] for segment in segments) != fixture["day"]["budgetMinutes"] or fixture["day"]["budgetMinutes"] != 60:
        raise ValueError("一天候选预算应为60分钟")
    draft = fixture["participationDraft"]
    if draft["itemId"] not in item_ids or draft["addedBy"] not in members or not set(draft["participantIds"]) <= members:
        raise ValueError("记录草稿引用无效成员或内容")
    if draft["addedBy"] in draft["participantIds"] or draft["persistence"] != "simulation-only":
        raise ValueError("示例需体现添加者与陪伴者可不同，且仅模拟")
    if fixture["memoryDraft"]["media"] != {"placeholder": True, "state": "pending_upload", "remoteVisible": False}:
        raise ValueError("媒体必须使用待上传占位，不伪造远端可见")
    measurement = fixture["measurementDraft"]
    if any(measurement[key] is not None for key in ("value", "referenceStandard", "percentile")):
        raise ValueError("无精确资料不能伪造测量参考值")
    replacement = fixture["replacementSample"]
    if replacement["targetItemId"] not in item_ids or replacement["candidate"]["id"] in item_ids or replacement["confirmed"]:
        raise ValueError("换项示例需引用原项、独立候选，初始未确认")
    if replacement["candidate"]["segmentId"] not in segment_ids or not replacement["candidate"]["safety"]:
        raise ValueError("换项候选缺分段或安全说明")
    conflict = fixture["conflictSample"]
    if conflict["itemId"] not in item_ids or conflict["resolved"]:
        raise ValueError("冲突样本必须引用现有内容且保留未解决状态")
    for side in (conflict["local"], conflict["remote"]):
        if side["addedBy"] not in members or not set(side["participantIds"]) <= members:
            raise ValueError("冲突样本成员引用无效")
    guide = fixture["stageGuideSample"]
    if not all(guide.get(key) for key in ("focus", "everydayExample", "parentSupport", "playIdeas", "easierVersion", "optionalNextStep", "source")):
        raise ValueError("阶段示例缺少七段结构")
    if fixture["contentWorkflow"]["draftItemId"] not in item_ids:
        raise ValueError("管理草稿引用不存在的演示内容")
    scenarios = fixture["scenarios"]
    if len({case["id"] for case in scenarios}) != len(scenarios):
        raise ValueError("扩展场景ID重复")
    initial = fixture["initialState"]
    if initial["itemRecords"] or initial["memoryRecords"] or initial["activeDraft"] is not None:
        raise ValueError("初始空态不能把草稿当作已保存内容")
    if set(workflow_role for workflow_role in fixture["contentWorkflow"]["roles"]) != set(fixture["contentWorkflow"]["permissions"]):
        raise ValueError("虚构角色与候选权限矩阵不一致")
    resolved_states = {}
    for case in scenarios:
        if not case["simulationOnly"] or not case["expected"] or not case["surface"]:
            raise ValueError("扩展场景缺模拟标识、目标界面或预期")
        if set(case["overrides"]) - set(initial):
            raise ValueError("场景覆盖项出现未知键")
        state = copy.deepcopy(initial)
        state.update(copy.deepcopy(case["overrides"]))
        for key in ("daySource", "activeDraft"):
            if state[key] is not None:
                if not state[key].startswith("#/"):
                    raise ValueError("场景数据只能引用本文件")
                pointer(fixture, state[key][1:])
        if state["activeMemberId"] not in members or state["adminRole"] not in fixture["contentWorkflow"]["permissions"]:
            raise ValueError("场景成员或管理角色引用无效")
        selected_day = pointer(fixture, state["daySource"][1:]) if state["daySource"] else None
        if selected_day and state["selectedItemId"] not in {item["id"] for item in selected_day["items"]}:
            raise ValueError("场景所选内容不在当前日期样本内")
        for item_id, record in state["itemRecords"].items():
            if item_id not in item_ids or record["itemId"] != item_id or record["addedBy"] not in members or not set(record["participantIds"]) <= members:
                raise ValueError("场景已保存记录引用不一致")
        if not set(state["syncStates"]) <= item_ids or any(value not in {"pending", "sending", "failed", "synced", "conflict"} for value in state["syncStates"].values()):
            raise ValueError("场景同步状态或引用无效")
        if state["workflowState"] not in fixture["contentWorkflow"]["states"]:
            raise ValueError("场景管理工作流状态无效")
        if state["workflowState"] == "published" and "publish" not in fixture["contentWorkflow"]["permissions"][state["adminRole"]]:
            raise ValueError("无发布权限不能演示发布成功")
        resolved_states[case["id"]] = state
    reminder_state = resolved_states["expanded_reminder_elapsed"]
    local_now = datetime.fromisoformat(reminder_state["referenceNow"].replace("Z", "+00:00")).astimezone(timezone(timedelta(hours=8)))
    if local_now.strftime("%H:%M") <= reminder_state["reminder"]["time"]:
        raise ValueError("提醒已过场景的固定时间并未超过提醒时刻")
    future_state = resolved_states["expanded_future"]
    future_day = pointer(fixture, future_state["daySource"][1:])
    if date.fromisoformat(future_day["date"]) <= date.fromisoformat(fixture["businessDate"]):
        raise ValueError("未来只读场景日期不在未来")
    if resolved_states["expanded_memory_empty"]["memoryRecords"] or resolved_states["expanded_memory_empty"]["activeDraft"]:
        raise ValueError("成长空态不能自动载入草稿")
    if resolved_states["expanded_sync_success"]["syncStates"].get("sample-roll") != "synced":
        raise ValueError("同步成功场景缺少已确认的本地模拟状态")
    return len(scenarios)


def validate_mobile_prototype(fixture: dict) -> int:
    files = sorted((ROOT / "prototype/mobile").glob("*.*"))
    names = {path.name for path in files}
    if names != {"index.html", "styles.css", "app.js", "fixture.js"}:
        raise ValueError("安卓原型文件清单与约定不一致")
    expected = "// 由 tools/build_mobile_prototype.py 生成；仅含虚构演示数据。\nwindow.BABYPLAN_FIXTURE = " + json.dumps(fixture, ensure_ascii=False, indent=2) + ";\n"
    if (ROOT / "prototype/mobile/fixture.js").read_text(encoding="utf-8") != expected:
        raise ValueError("安卓原型演示数据与扩展样本不一致，请运行 build_mobile_prototype.py")
    entry = (ROOT / "prototype/mobile/index.html").read_text(encoding="utf-8")
    for asset in ("styles.css", "fixture.js", "app.js"):
        if asset not in entry:
            raise ValueError(f"安卓原型入口缺少引用: {asset}")
    return len(files)


def validate_prototype_entries() -> int:
    """检查随包交付的入口、资源与本地链接，不替代浏览器交互验收。"""
    class References(HTMLParser):
        def __init__(self):
            super().__init__()
            self.targets = []

        def handle_starttag(self, tag, attrs):
            values = dict(attrs)
            key = "src" if tag in {"script", "img"} else "href" if tag in {"link", "a"} else None
            if key and values.get(key):
                self.targets.append(values[key])

    root = ROOT / "prototype"
    shipped = {path.resolve() for path in files_to_ship()}
    count = 0
    for surface in ("parent", "admin"):
        expected = {"index.html", "styles.css", "app.js"}
        if {path.name for path in (root / surface).glob("*.*")} != expected:
            raise ValueError(f"{surface}原型文件清单与约定不一致")
    for path in [root / "index.html", *(root / name / "index.html" for name in ("mobile", "parent", "admin"))]:
        parser = References()
        parser.feed(path.read_text(encoding="utf-8"))
        for target in parser.targets:
            if target.startswith("#"):
                continue
            if re.match(r"^[a-zA-Z]+:", target) or target.startswith("//"):
                raise ValueError(f"原型入口不能依赖外部资源: {path.relative_to(ROOT)} -> {target}")
            resolved = (path.parent / unquote(target.split("#", 1)[0].split("?", 1)[0])).resolve()
            if resolved not in shipped or not resolved.is_file():
                raise ValueError(f"原型入口引用缺失或未打包: {path.relative_to(ROOT)} -> {target}")
            count += 1
    return count


def validate_design_inventory(fixture: dict) -> tuple[int, int]:
    inventory = (ROOT / "docs/design/03-原型状态与文案清单.md").read_text(encoding="utf-8")
    scenario_ids = {case["id"] for case in fixture["scenarios"]}
    documented_scenarios = set(re.findall(r"`(expanded_[a-z_]+)`", inventory))
    if scenario_ids != documented_scenarios:
        raise ValueError("扩展场景与页面映射清单不一致")
    copy_references = set(re.findall(r"\bT-[A-Z]+(?:-[A-Z]+)*\b", inventory))
    copy_definitions = set(re.findall(r"^\| `(?P<id>T-[A-Z]+(?:-[A-Z]+)*)` \|", inventory, re.MULTILINE))
    if copy_references - copy_definitions:
        raise ValueError("原型文案引用未定义: " + ", ".join(sorted(copy_references - copy_definitions)))
    expected_pages = {f"{prefix}{index:02d}" for prefix, count in (("N", 12), ("W", 8), ("C", 6)) for index in range(1, count + 1)}
    defined_pages = set(re.findall(r"^#### `(N\d{2}|W\d{2}|C\d{2})`", inventory, re.MULTILINE))
    if defined_pages != expected_pages:
        raise ValueError("原型页面说明数量或编号错误")
    expected_checks = {f"P{index:02d}" for index in range(1, 19)}
    defined_checks = set(re.findall(r"^\| `(P\d{2})` \|", inventory, re.MULTILINE))
    if defined_checks != expected_checks:
        raise ValueError("扩展P验收清单缺失或编号错误")
    return len(defined_pages), len(copy_definitions)


def validate_visual_tokens(tokens: dict) -> tuple[int, float]:
    if tokens["status"] != "candidate":
        raise ValueError("未确认的视觉变量必须标为candidate")

    def luminance(color: str) -> float:
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            raise ValueError(f"候选颜色必须为六位实色: {color}")
        channels = [int(color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
        linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
        return sum(value * weight for value, weight in zip(linear, (0.2126, 0.7152, 0.0722)))

    results = []
    for theme_name, theme in tokens["themes"].items():
        for pair in tokens["contrastPairs"]:
            foreground, background = luminance(theme[pair["foreground"]]), luminance(theme[pair["background"]])
            ratio = (max(foreground, background) + 0.05) / (min(foreground, background) + 0.05)
            if ratio < pair["minimum"]:
                raise ValueError(f"候选对比度不足: {theme_name}/{pair['foreground']}/{pair['background']} = {ratio:.2f}")
            results.append(ratio)
    if set(tokens["themes"]) != {"light", "dark"} or tokens["layout"]["touchTarget"] < 48:
        raise ValueError("需要深浅主题和至少48的触控目标")
    return len(results), min(results)


def main() -> None:
    files = files_to_ship()
    for path in files:
        if not path.is_file():
            raise ValueError(f"缺少交接文件: {path.relative_to(ROOT)}")
    api = yaml.safe_load(API_PATH.read_text(encoding="utf-8"))
    if api.get("openapi") != "3.1.0":
        raise ValueError("OpenAPI版本必须为3.1.0")
    content_schema = read_json(SCHEMA_PATH)
    documents = {API_PATH.resolve(): api, SCHEMA_PATH.resolve(): content_schema}
    ref_count = 0
    for path, document in list(documents.items()):
        for node in nodes(document):
            if "$ref" not in node:
                continue
            target, fragment = urldefrag(node["$ref"])
            if re.match(r"^[a-z]+:", target):
                raise ValueError(f"交接合同不应依赖远端$ref: {target}")
            referenced_path = (path.parent / unquote(target)).resolve() if target else path
            if referenced_path not in documents:
                raise ValueError(f"未包含引用文件: {referenced_path}")
            pointer(documents[referenced_path], fragment)
            ref_count += 1

    registry = Registry().with_resources((path.as_uri(), DRAFT202012.create_resource(document)) for path, document in documents.items())
    checker = FormatChecker()
    schema_count = 0
    for schema in api.get("components", {}).get("schemas", {}).values():
        Draft202012Validator.check_schema(schema)
        schema_count += 1
    Draft202012Validator.check_schema(content_schema)
    week_validator = Draft202012Validator({"$ref": API_PATH.as_uri() + "#/components/schemas/Week"}, registry=registry, format_checker=checker)
    fixture = read_json(ROOT / "content/design/design-scenarios.json")
    week_validator.validate(fixture["week"])
    invalid_week = copy.deepcopy(fixture["week"])
    invalid_week.pop("id")
    if week_validator.is_valid(invalid_week):
        raise ValueError("Week负例未被拒绝")
    tasks = fixture["week"]["tasks"]
    if len(tasks) != 7 or len({task["id"] for task in tasks}) != 7:
        raise ValueError("设计样本任务数/唯一性错误")
    first = date.fromisoformat(fixture["week"]["startDate"])
    for index, task in enumerate(tasks):
        if (date.fromisoformat(task["date"]) - first).days != index:
            raise ValueError("设计样本日期不连续")
        if task["cardId"] != task["cardSnapshot"]["id"]:
            raise ValueError("设计样本快照引用错误")
    reference_today = date.fromisoformat("2026-11-11")
    counts = {"played": 0, "skipped": 0, "unrecorded": 0, "future": 0}
    for task in tasks:
        status = "future" if date.fromisoformat(task["date"]) > reference_today else (task["checkIn"]["status"] if task["checkIn"] else "unrecorded")
        counts[status] += 1
    if counts != fixture["expectedBaseCounts"] or sum(counts.values()) != 7:
        raise ValueError("设计样本计数错误")
    if fixture != source_module("build_design_scenarios.py").build():
        raise ValueError("旧合同场景与构建脚本不一致，请重建")
    scenario_ids = {scenario["id"] for scenario in fixture["scenarios"]}
    if len(scenario_ids) != len(fixture["scenarios"]):
        raise ValueError("旧合同场景ID重复")
    task_ids = {task["id"] for task in tasks}
    for scenario in fixture["scenarios"]:
        if scenario.get("selectedTaskId") and scenario["selectedTaskId"] not in task_ids:
            raise ValueError("场景引用未知任务")
        if scenario.get("weekSource") not in (None, "#/week"):
            raise ValueError("场景引用未知周")
        if scenario["stage"] not in {"M1", "M2", "M4"} or not all(page in {f"A{number:02d}" for number in range(1, 10)} for page in scenario["pages"]):
            raise ValueError("旧场景页面或阶段无效")
        for intent in scenario.get("localIntents", []):
            allowed = {"played": {None, "want_again"}, "skipped": {None, "family_busy", "child_tired", "time_unfit"}}
            if intent["taskId"] not in task_ids or intent["status"] not in allowed or intent.get("feedback") not in allowed[intent["status"]]:
                raise ValueError("本机意图引用或状态反馈配对无效")
        if scenario.get("referenceNowOverride"):
            datetime.fromisoformat(scenario["referenceNowOverride"].replace("Z", "+00:00"))
    scenario_count = len(fixture["scenarios"])
    expanded_fixture = read_json(ROOT / "content/design/expanded-prototype.json")
    expanded_count = validate_expanded_fixture(expanded_fixture)
    page_count, copy_count = validate_design_inventory(expanded_fixture)
    contrast_count, minimum_contrast = validate_visual_tokens(read_json(ROOT / "docs/design/visual-tokens.json"))
    prototype_count = validate_mobile_prototype(expanded_fixture)
    prototype_refs = validate_prototype_entries()
    example_count = 0
    for node in nodes(api):
        if "schema" not in node or not isinstance(node["schema"], dict):
            continue
        schema = dict(node["schema"])
        schema["$id"] = API_PATH.as_uri()
        schema["components"] = api.get("components", {})
        validator = Draft202012Validator(schema, registry=registry, format_checker=checker)
        if "example" in node:
            validator.validate(node["example"])
            example_count += 1
        if isinstance(node.get("examples"), dict):
            for example in node["examples"].values():
                if isinstance(example, dict) and "value" in example:
                    validator.validate(example["value"])
                    example_count += 1
    create_schema = api["paths"]["/weeks"]["post"]["requestBody"]["content"]["application/json"]["schema"]
    create_validator = Draft202012Validator({"$id": API_PATH.as_uri(), "components": api["components"], **create_schema}, registry=registry, format_checker=checker)
    create_validator.validate({"requestId": "00000000-0000-4000-8000-000000000301", "startDate": "2026-11-11", "timezone": "Asia/Shanghai", "packageId": "family-play-demo", "contentVersion": 1, "templateId": "demo_week_m18"})
    checkin_schema = api["paths"]["/tasks/{taskId}/check-in"]["put"]["requestBody"]["content"]["application/json"]["schema"]
    checkin_validator = Draft202012Validator({"$id": API_PATH.as_uri(), "components": api["components"], **checkin_schema}, registry=registry, format_checker=checker)
    valid_operation = {"operationId": "00000000-0000-4000-8000-000000000302", "baseRevision": 0, "status": "played", "feedback": "want_again", "recordedAt": "2026-11-11T04:00:00Z"}
    checkin_validator.validate(valid_operation)
    invalid_operation = {**valid_operation, "status": "unrecorded"}
    if checkin_validator.is_valid(invalid_operation):
        raise ValueError("未记录写入负例未被拒绝")
    spec = importlib.util.spec_from_file_location("babyplan_content_validator", ROOT / "tools/validate_content.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    demo = read_json(ROOT / "content/demo/demo-content-package.json")
    errors = module.validate_content(demo)
    if errors:
        raise ValueError("演示包校验失败: " + "; ".join(errors))
    if not module.validate_content(demo, require_release=True):
        raise ValueError("正式校验模式未拒绝演示包")

    # 检查打包后仍存在的相对文档链接，而不是只检查本机路径。
    shipped = {path.resolve() for path in files} | {REPORT.resolve()}
    link_count = 0
    for path in files:
        if path.suffix != ".md":
            continue
        for target in re.findall(r"\]\(([^)]+)\)", path.read_text(encoding="utf-8")):
            target = target.strip("<>")
            if re.match(r"^[a-z]+:", target) or target.startswith("#"):
                continue
            relative = unquote(target.split("#", 1)[0])
            resolved = (path.parent / relative).resolve()
            if resolved not in shipped:
                raise ValueError(f"文档链接未在交接包中: {path.relative_to(ROOT)} -> {relative}")
            link_count += 1
    operation_count = sum(1 for item in api["paths"].values() for method in item if method in {"get", "post", "put", "delete", "patch"})
    OUTPUT.mkdir(parents=True, exist_ok=True)
    report = f"""# 设计交接包校验报告

执行日期：{datetime.now().date().isoformat()}。这是本地合同与资料校验，不是产品运行或设计稿验收。

| 检查 | 结果 |
| --- | --- |
| 演示内容包结构、引用与业务校验 | 通过；3张卡、2套模板 |
| 正式模式拒绝demo | 通过 |
| OpenAPI YAML解析与结构检查 | 通过；{operation_count}个操作 |
| 合同引用可解析 | 通过；{ref_count}处引用 |
| 组件JSON Schema检查 | 通过；{schema_count}个组件 |
| 合同媒体类型样例校验 | 通过；{example_count}个样例 |
| 虚构周、建周与打卡样本 | 通过；Week与请求匹配合同 |
| 缺ID周/未记录写入负例 | 均被拒绝 |
| 旧合同场景日期、任务、意图与计数 | 通过；{scenario_count}种场景；基础计数1/1/1/4 |
| 扩展虚构样本、引用与预算 | 通过；{expanded_count}种场景；三段25/25/10，共60分钟候选预算 |
| 场景覆盖、固定时钟与候选权限 | 通过；覆盖项键/本文件引用/保存与同步状态可解析；未来日和提醒已过边界成立；发布角色有对应权限 |
| 扩展页面、场景映射与文案引用 | 通过；{page_count}个页面/弹层；P01～P18清单；{copy_count}条文案定义，引用可解析 |
| 两类样本可复建一致性 | 通过；生成脚本结果与JSON逐项相等 |
| 安卓低保真原型 | 通过；{prototype_count}个静态文件；演示数据与扩展样本一致、入口引用完整 |
| 三端入口与静态资源 | 通过；4个HTML入口、{prototype_refs}个本地引用均在包内；家长区/管理区各3个源码文件 |
| 候选变量实色对比度 | 通过；深浅主题共{contrast_count}组；最低{minimum_contrast:.2f}:1；各自达到声明阈值 |
| 文档相对链接及打包目标 | 通过；{link_count}条链接 |

本次输出为扩展需求的原型设计输入包v0.2，旧v0.1 ZIP及PNG保持原样。新ZIP含三端低保真源码（`prototype/index.html`为总入口，`mobile/`、`parent/`、`admin/`分别为安卓、网页家长区与内容管理区；动作均为本地模拟）。PNG是已存在的静态视觉提案，未按新N/W/C和P用例验收，不在新ZIP内。扩展数据不是API响应、正式内容包或真实家庭记录；候选颜色未获品牌确认。

本脚本未运行完整OpenAPI专用规范验证器；上述检查不等同于官方文档元Schema或代码生成器兼容性认证。扩展样本只检查声明的模拟标识、引用、预算、占位与复建一致性，不证明内容适龄、安全或权限设计通过。对比度只检查声明的实色组合，不覆盖实际浏览器混色、透明度、图片和全部组件状态。

浏览器交互验证独立记在`prototype/验证记录.md`，本脚本只检查文件与数据，不能把打包通过等同于P/D设计验收通过。安卓端历史检查见`prototype/README.md`。未执行：正式合同升级、App或服务端构建、真实数据库与接口集成、真实权限、跨设备同步、上传与发布、安卓真机与TalkBack、家庭试用与部署恢复。本打包脚本不连接设计工具、不上传文件、不调用模型。

复验：在项目根目录执行 `python -I tools/package_design_handoff.py`，需要Python、PyYAML和jsonschema。它重建v0.2输入ZIP及本报告；修改虚构样本须先运行相应build脚本。
"""
    REPORT.write_text(report, encoding="utf-8")
    with ZipFile(BUNDLE, "w", ZIP_DEFLATED) as archive:
        for path in files + [REPORT]:
            archive.write(path, path.relative_to(ROOT).as_posix())
    with ZipFile(BUNDLE) as archive:
        if archive.testzip() is not None:
            raise ValueError("ZIP完整性检查失败")
    print(f"OK: {operation_count} API operations, {ref_count} refs, {example_count} examples, {scenario_count} legacy scenarios, {link_count} links")
    print(f"OK: {expanded_count} expanded scenarios, {contrast_count} contrast pairs (minimum {minimum_contrast:.2f}:1)")
    print(f"OK: {BUNDLE.relative_to(ROOT).as_posix()} ({len(files) + 1} files, {prototype_count} prototype files)")
    print(f"OK: {REPORT.relative_to(ROOT).as_posix()}")


if __name__ == "__main__":
    main()
