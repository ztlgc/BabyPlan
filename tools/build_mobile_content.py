#!/usr/bin/env python3
"""Generate the Flutter offline content constant from the v2 candidate package."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "content" / "candidate" / "babyplan-18-23-v2.json"
OUTPUT = ROOT / "apps" / "mobile" / "lib" / "domain" / "generated_content.dart"


def main() -> None:
    raw = SOURCE.read_bytes()
    package = json.loads(raw.decode("utf-8"))
    if len(package.get("cards", [])) != 24:
        raise SystemExit("候选内容包应包含 24 张活动卡")
    if any(card.get("reviewState") == "reviewed" for card in package["cards"]):
        raise SystemExit("候选内容不得在生成时被标记为已审核")
    pretty = json.dumps(package, ensure_ascii=False, indent=2)
    if "'''" in pretty:
        raise SystemExit("内容包包含与 Dart 原始字符串冲突的三引号")
    digest = hashlib.sha256(raw).hexdigest()
    source_rel = SOURCE.relative_to(ROOT).as_posix()
    OUTPUT.write_text(
        "// GENERATED FILE. DO NOT EDIT.\n"
        f"// source: {source_rel}\n"
        f"// sha256: {digest}\n"
        "\n"
        "const String babyplanCandidatePackageJson = r'''\n"
        f"{pretty}\n"
        "''';\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"generated {OUTPUT.relative_to(ROOT)} ({len(package['cards'])} cards)")


if __name__ == "__main__":
    main()
