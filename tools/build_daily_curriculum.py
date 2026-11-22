"""从已经编写的每日活动原稿生成服务内容包；不改变审阅状态，不访问数据库。"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs/content/daily-play-12-to-24-months"
OUTPUT = ROOT / "content/candidate/babyplan-daily-12-24-v1.json"
BANDS = [
    ("12-14", "m12_14", 1, 91, "一起看、听和动", "CDC12"),
    ("15-17", "m15_17", 92, 182, "我也来试一下", "CDC15"),
    ("18-20", "m18_23", 183, 273, "轮流、假装、一起做", "CDC18"),
    ("21-23", "m18_23", 274, 365, "我来选，我们一起做", "CDC18"),
]
SAFETY = (
    "成人全程在近处看护，材料须适龄、完整、无松脱小件，整个放不进嘴。"
    "收走纽扣电池、磁铁、吸水珠、气球、小配件、塑料袋和长绳，不用食物当玩具。"
    "在平坦防滑地面玩，远离台阶、家具尖角和车辆；不拉手臂带走，不扶着跳。"
    "宝宝转开、推开、烦躁或累了就停止。"
)


def activity_kind(title: str) -> str:
    if title.startswith("复玩") or any(word in title for word in ("选一", "宝宝选", "带头", "喜欢")):
        return "child-led"
    if any(word in title for word in ("晚安", "安静", "休息", "轻轻抱", "睡前")):
        return "calm"
    if any(word in title for word in ("书", "翻页", "照片", "共读")):
        return "reading"
    if any(word in title for word in ("球", "脚", "走", "蹲", "跑", "推", "滚", "爬")):
        return "movement"
    return "explore"


def build() -> dict:
    package = json.loads((ROOT / "content/candidate/babyplan-18-23-v2.json").read_text(encoding="utf-8"))
    package.update(
        packageId="babyplan-daily-12-24",
        contentVersion=1,
        channel="candidate",
        createdOn="2026-11-14",
        review={"editorial": "draft", "expert": "not_reviewed", "familyTrial": "not_started"},
    )
    # 既有活动采用新修订，保留历史活动正文和计划快照。
    for card in package["cards"]:
        card["revision"] += 1
    package["ageBands"][:0] = [
        {"id": "m12_14", "label": "12～14月", "minMonths": 12, "maxMonths": 14},
        {"id": "m15_17", "label": "15～17月", "minMonths": 15, "maxMonths": 17},
    ]
    reference_section = (SOURCE / "README.md").read_text(encoding="utf-8").split("## 资料和适用范围", 1)[1]
    references = re.findall(r"\[([^\]]+)\]\((https?://[^)]+)\)", reference_section)
    assert len(references) == 11, "资料应与原稿的 11 条来源一致"
    for index, (title, url) in enumerate(references, 1):
        package["sources"].append({
            "id": f"DAILY{index:02}",
            "title": title,
            "url": url,
            "verifiedOn": "2026-11-14",
            "scope": "支持回应性照护、分龄互动或玩耍安全的设计方向；具体排序和话术为原创，未做专业逐条审阅或家庭试玩。",
        })
    package["sources"] += [
        {"id": "CDC12", "title": "CDC · 1 Year", "url": references[3][1], "verifiedOn": "2026-11-14", "scope": "12月龄观察参考和日常玩法，不作为每日考核"},
        {"id": "CDC15", "title": "CDC · 15 Months", "url": references[4][1], "verifiedOn": "2026-11-14", "scope": "15月龄观察参考和日常玩法，不作为每日考核"},
    ]
    days = []
    for filename, band, start, end, focus, cdc in BANDS:
        theme = ""
        rows = []
        for line in (SOURCE / f"{filename}月龄.md").read_text(encoding="utf-8").splitlines():
            if line.startswith("## "):
                theme = line.removeprefix("## ").strip()
            if not re.match(r"^\| \d+ \|", line):
                continue
            values = [value.strip() for value in line.strip("|").split("|")]
            assert len(values) == 7, values
            ordinal = int(values[0])
            title, material, play, dialogue, easier, extra = values[1:]
            assert start <= ordinal <= end
            rows.append(ordinal)
            kind = activity_kind(title)
            card_id = f"bp-daily-{ordinal:03}"
            quotes = re.match(r"^(“[^”]+”)(.*)$", dialogue)
            english = re.search(r"英语：\s*([^（]+)（([^）]+)）(.*)", extra)
            safety = SAFETY
            if "巾" in material:
                safety += "方巾始终远离口鼻和颈部，不把布盖在孩子脸上。"
            if "蜡笔" in material:
                safety += "只用适龄粗蜡笔；仍往嘴里放时改做无道具手指画。"
            if "水" in play or "洗手" in title:
                safety += "日常洗手用温水、全程扶稳；倒和舀的游戏使用空杯。"
            card = {
                "id": card_id,
                "revision": 1,
                "title": f"第 {ordinal} 天 · {title}",
                "kind": kind,
                "ageBands": [band],
                "support": f"{filename}月龄参考 · {focus}。一次先玩3～5分钟，可拆开，跟随宝宝兴趣，不用补课。具体玩法为原创，未做专业逐条审阅或家庭试玩。",
                "materials": [] if material == "无" else material.split("、"),
                "steps": [play, f"顺手加一句（可选）：{extra}"],
                "dialogue": {
                    "opening": quotes.group(1) if quotes else dialogue,
                    "engaged": quotes.group(2).strip() if quotes and quotes.group(2).strip() else dialogue,
                    "observing": easier,
                    "stopping": "“好，我们先停。”宝宝转开、推开或累了，就收起来，休息也可以。",
                },
                "english": {
                    "phrase": english.group(1).strip() if english else "Hello!",
                    "meaning": english.group(2).strip() if english else "你好！",
                    "when": ("可选：" + english.group(3).strip() + "宝宝不用跟读。") if english else "见面时自然说一次即可。今天的儿歌或数数见玩法，英语可以跳过，宝宝不用跟读。",
                },
                "easier": easier,
                "next": "宝宝主动还想玩，就按相同难度再来一轮；等他的眼神、手势或声音，不要求完成或升级。",
                "safety": safety,
                "sourceIds": [cdc, "DAILY02", "DAILY08", "DAILY09"],
                "reviewState": "draft",
                "rights": "original",
                "withdrawn": False,
            }
            package["cards"].append(card)
            days.append({
                "day": ordinal,
                "theme": theme,
                "items": [{
                    "id": f"daily-{ordinal:03}",
                    "cardId": card_id,
                    "kind": kind,
                    "block": "bedtime" if kind == "calm" else "before" if kind in ("movement", "explore") else "after",
                    "minutes": 5,
                }],
            })
        assert rows == list(range(start, end + 1)), (filename, rows)
    assert [day["day"] for day in days] == list(range(1, 366))
    package["dailyPlans"] = {"startMonths": 12, "endMonths": 24, "days": days}
    for band, age, title, cdc, ordinal in [
        ("m12_14", 12, "12～14月：一起看、听和动", "CDC12", 1),
        ("m15_17", 15, "15～17月：我也来试一下", "CDC15", 92),
    ]:
        package["stageGuides"].append({
            "ageBand": band,
            "title": title,
            "description": "跟随宝宝兴趣，回应眼神、手势和声音。月龄只作参考；具体玩法未做专业逐条审阅或家庭试玩。",
            "sourceId": cdc,
            "sourceAgeMonths": age,
            "focuses": [{
                "id": f"{band}-daily",
                "domain": "亲子互动",
                "title": "先示范一次，再等宝宝回应",
                "everyday": "在换衣、收拾、共读或地面游戏中，观察宝宝正注意什么。",
                "support": "说一句、做一次、停下来；看到宝宝看、摸、指或发声，就接上。",
                "easier": "只观察或半分钟也可以，不握着宝宝的手强做。",
                "next": "宝宝主动再来时按相同难度复玩，不要求升级。",
                "cardIds": [f"bp-daily-{ordinal:03}"],
            }],
        })
    return package


if __name__ == "__main__":
    result = build()
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"file": str(OUTPUT.relative_to(ROOT)), "cards": len(result["cards"]), "days": len(result["dailyPlans"]["days"])}, ensure_ascii=False))
