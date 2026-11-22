"""从候选内容包生成逐卡人工审读台账；所有结论保持待审，不代替真人签字。"""

from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / 'content/candidate/babyplan-18-23-v2.json'
OUTPUT = ROOT / 'docs/content/逐卡审读台账.md'


def digest(value: object) -> str:
    body = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
    ).encode('utf-8')
    return sha256(body).hexdigest()


def cell(value: object) -> str:
    text = str(value).replace('\r', ' ').replace('\n', '<br>').replace('|', '\\|')
    return text


def list_cell(values: list[str]) -> str:
    return '<br>'.join(cell(value) for value in values)


def main() -> None:
    content = json.loads(CONTENT.read_text(encoding='utf-8'))
    cards = content['cards']
    guides = content['stageGuides']
    focus_count = sum(len(guide['focuses']) for guide in guides)
    if len(cards) != 24 or focus_count != 12:
        raise ValueError(
            f'候选包数量异常：预期 24 卡与 12 条阶段支持，实际 {len(cards)} 与 {focus_count}'
        )

    sources = {source['id']: source for source in content['sources']}
    age_bands = {age['id']: age for age in content['ageBands']}
    lines = [
        '# BabyPlan 逐卡审读台账',
        '',
        f"内容包：`{content['packageId']}` · 正文版本 `{content['contentVersion']}`",
        '',
        '本台账由 `tools/render_content_review_ledger.py` 从候选 JSON 生成。它是**人工审读工作表和证据模板**，不表示任何条目已经实际通过编辑审读、专业审核或家庭试玩。',
        '',
        f"- 候选包当前状态：编辑 `{content['review']['editorial']}`；专业审核 `{content['review']['expert']}`；家庭试玩 `{content['review']['familyTrial']}`。",
        f'- 活动卡：{len(cards)} 张；阶段支持：{focus_count} 条。',
        '- 正文 hash 绑定本台账生成时的修订；修改正文后必须重新生成并重审。',
        '- 只有真实执行人填写意见、日期和结论后，才能把对应条目标为私人试用已审；专业审阅与家庭试玩必须保持真实状态。',
        '',
        '## 1. 24 张活动卡',
        '',
        '| ID / revision | 标题与类型 | 年龄档 | 来源 | 材料 | 停止出口与安全说明 | 正文 hash | 人工审读结论 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ]

    for card in cards:
        bands = '<br>'.join(
            f"`{band_id}` {age_bands[band_id]['label']}" for band_id in card['ageBands']
        )
        source_ids = '<br>'.join(f'`{source_id}`' for source_id in card['sourceIds'])
        lines.append(
            '| '
            + ' | '.join(
                [
                    f"`{cell(card['id'])}` / r{card['revision']}",
                    f"**{cell(card['title'])}**<br>{cell(card['kind'])}",
                    bands,
                    source_ids,
                    list_cell(card['materials']),
                    f"{cell(card['dialogue']['stopping'])}<br>{cell(card['safety'])}",
                    f"`{digest(card)[:16]}…`",
                    '☐ 待人工审读<br>意见：<br>日期：',
                ]
            )
            + ' |'
        )

    lines.extend(
        [
            '',
            '## 2. 12 条阶段支持',
            '',
            '| 焦点 ID / 年龄 | 标题与范围 | 来源 | 日常观察与支持 | 停止/边界 | 正文 hash | 人工审读结论 |',
            '| --- | --- | --- | --- | --- | --- | --- |',
        ]
    )
    for guide in guides:
        source = sources[guide['sourceId']]
        for focus in guide['focuses']:
            body = {
                'guide': {
                    key: guide[key]
                    for key in (
                        'ageBand',
                        'title',
                        'description',
                        'sourceId',
                        'sourceAgeMonths',
                    )
                },
                'focus': focus,
            }
            lines.append(
                '| '
                + ' | '.join(
                    [
                        f"`{cell(focus['id'])}`<br>{cell(age_bands[guide['ageBand']]['label'])}",
                        f"**{cell(focus['title'])}**<br>{cell(focus['domain'])}",
                        f"`{cell(source['id'])}`<br>{cell(source['scope'])}",
                        f"观察：{cell(focus['everyday'])}<br>支持：{cell(focus['support'])}<br>下一步：{cell(focus['next'])}",
                        f"更容易：{cell(focus['easier'])}<br>只作观察线索，不作达标评分或筛查。",
                        f"`{digest(body)[:16]}…`",
                        '☐ 待人工审读<br>意见：<br>日期：',
                    ]
                )
                + ' |'
            )

    lines.extend(
        [
            '',
            '## 3. 来源复核队列',
            '',
            '| 来源 | 当前核验日期 | 本项目允许支持的范围 | 仍待处理 |',
            '| --- | --- | --- | --- |',
        ]
    )
    for source in content['sources']:
        caveat = (
            '官方页面只能支持方向，不替代逐卡编辑审读；使用前再次确认链接与适用年龄。'
        )
        if source['id'] == 'ASHA-ML':
            caveat = '只采用多语言回应与自然接触方向；不把全年龄屏幕建议套用于一岁半。'
        lines.append(
            f"| `{cell(source['id'])}`<br>[{cell(source['title'])}]({source['url']}) "
            f"| {cell(source['verifiedOn'])} | {cell(source['scope'])} | {cell(caveat)} |"
        )
    lines.append(
        '| `NHC-PLAY` | 未完成 | 仅可提示后续核对卫健委亲子交流材料；不得声称已完整复核具体页码。 | '
        '重新取得可读原文、确认发布日期与适用范围后再引用。 |'
    )

    lines.extend(
        [
            '',
            '## 4. 私人试用放行签署',
            '',
            '完成下列字段前，候选包保持 `draft / not_reviewed / not_started`。允许同一家长承担多个角色，但必须如实标记为自审。',
            '',
            '- 审读人：________________',
            '- 审读日期：________________',
            '- 已逐项检查中文步骤、材料、安全、停止出口、英语含义、来源范围与权属：☐',
            '- 有疑虑并已停用的条目：________________',
            '- 需要外部专业核验的问题：________________',
            '- 私人试用范围与开始日期：________________',
            '- 发布内容版本及 24 张卡 hash 清单：________________',
            '',
            '本台账不代表公开发布所需的独立审阅。每次正文修订都必须生成新 hash，并重新完成受影响条目的审读。',
            '',
        ]
    )
    OUTPUT.write_text('\n'.join(lines), encoding='utf-8')
    print(
        json.dumps(
            {
                'cards': len(cards),
                'stageSupports': focus_count,
                'sources': len(sources),
                'output': str(OUTPUT.relative_to(ROOT)),
                'humanReviewCompleted': False,
            },
            ensure_ascii=True,
        )
    )


if __name__ == '__main__':
    main()
