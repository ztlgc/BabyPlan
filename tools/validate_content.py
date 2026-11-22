"""Validate a local family-play content package. No network calls or writes."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker


SCHEMA_PATH = Path(__file__).resolve().parents[1] / "contracts" / "content-package.schema.json"
RELEASE_PACKAGE_ID = "family-play-zh-cn"
CONTENT_FIELDS = {
    "song": "song-rhythm",
    "keywordsZh": "zh-words",
    "english": "daily-english",
    "numberPlay": "quantity",
}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError(f"Invalid JSON constant: {value}")


def load_json(path):
    with path.open(encoding="utf-8-sig") as file:
        return json.load(
            file, object_pairs_hook=unique_object, parse_constant=reject_constant
        )


def index_by_id(items, collection, errors):
    result = {}
    for item in items:
        item_id = item["id"]
        if item_id in result:
            errors.append(f"{collection}: duplicate id {item_id}")
        else:
            result[item_id] = item
    return result


def validate_content(package, require_release=False):
    schema = load_json(SCHEMA_PATH)
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = []
    for error in validator.iter_errors(package):
        path = "/" + "/".join(map(str, error.absolute_path))
        errors.append(f"{path}: {error.message}")
    if errors:
        return errors

    if require_release and package["channel"] != "release":
        errors.append("channel: a demo package cannot be used for release")
    if package["channel"] == "release" and package["packageId"] != RELEASE_PACKAGE_ID:
        errors.append(f"packageId: release packages must use {RELEASE_PACKAGE_ID}")

    bands = index_by_id(package["ageBands"], "ageBands", errors)
    cards = index_by_id(package["cards"], "cards", errors)
    weeks = index_by_id(package["weekTemplates"], "weekTemplates", errors)

    next_month = 0
    for band in sorted(bands.values(), key=lambda band: band["minMonths"]):
        start, end = band["minMonths"], band["maxMonths"]
        if start > end:
            errors.append(f"ageBands/{band['id']}: minMonths exceeds maxMonths")
            continue
        if start != next_month:
            issue = "overlaps an earlier band" if start < next_month else "leaves a gap"
            errors.append(f"ageBands/{band['id']}: {issue}; expected month {next_month}")
        next_month = max(next_month, end + 1)

    for card_id, card in cards.items():
        for band_id in card["ageBands"]:
            if band_id not in bands:
                errors.append(f"cards/{card_id}: unknown age band {band_id}")
        for field, domain in CONTENT_FIELDS.items():
            if (field in card) != (domain in card["domains"]):
                errors.append(f"cards/{card_id}: {field} and {domain} must be used together")

    for week_id, week in weeks.items():
        band_id = week["ageBand"]
        if band_id not in bands:
            errors.append(f"weekTemplates/{week_id}: unknown age band {band_id}")
        for day, card_id in enumerate(week["cardIds"], start=1):
            card = cards.get(card_id)
            if card is None:
                errors.append(f"weekTemplates/{week_id}/day-{day}: missing card {card_id}")
            elif band_id not in card["ageBands"]:
                errors.append(f"weekTemplates/{week_id}/day-{day}: {card_id} does not fit {band_id}")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path, help="UTF-8 content package file")
    parser.add_argument("--release", action="store_true", help="Reject demo packages")
    args = parser.parse_args()
    try:
        package = load_json(args.package)
        errors = validate_content(package, require_release=args.release)
    except (OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(
        f"OK: {package['packageId']} v{package['contentVersion']} ({package['channel']}), "
        f"{len(package['cards'])} cards, {len(package['weekTemplates'])} week templates"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
