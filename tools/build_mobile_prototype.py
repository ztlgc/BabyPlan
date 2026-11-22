"""为可离线打开的低保真原型生成本地数据脚本，不修改来源样本。"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
source = ROOT / "content/design/expanded-prototype.json"
fixture = json.loads(source.read_text(encoding="utf-8"))
target = ROOT / "prototype/mobile/fixture.js"
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text("// 由 tools/build_mobile_prototype.py 生成；仅含虚构演示数据。\nwindow.BABYPLAN_FIXTURE = " + json.dumps(fixture, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8")
print("OK: prototype/mobile/fixture.js")
