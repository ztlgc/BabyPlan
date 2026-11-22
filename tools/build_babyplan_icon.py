"""生成 BabyPlan 的原创“小芽”Android 启动图标，不依赖外部素材。"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT / 'apps/mobile/android/app/src/main/res'
SOURCE_OUTPUT = ROOT / 'apps/mobile/assets/branding/babyplan-icon-1024.png'

CREAM = '#F7F5EF'
SAGE = '#E3EADF'
GREEN = '#435B43'
LEAF_LIGHT = '#6F8B65'
CLAY = '#9B4B32'


def quadratic(start: tuple[float, float], control: tuple[float, float], end: tuple[float, float]):
    points = []
    for step in range(41):
        t = step / 40
        one_minus = 1 - t
        points.append(
            (
                one_minus * one_minus * start[0]
                + 2 * one_minus * t * control[0]
                + t * t * end[0],
                one_minus * one_minus * start[1]
                + 2 * one_minus * t * control[1]
                + t * t * end[1],
            )
        )
    return points


def leaf(start, upper_control, end, lower_control):
    return (
        quadratic(start, upper_control, end)
        + quadratic(end, lower_control, start)
    )


def build_master() -> Image.Image:
    size = 1024
    image = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((32, 32, 992, 992), radius=224, fill=CREAM)
    draw.ellipse((180, 188, 844, 852), fill=SAGE)
    draw.ellipse((676, 235, 802, 361), fill=CLAY)

    stem_points = quadratic((512, 760), (470, 620), (508, 492))
    draw.line(stem_points, fill=GREEN, width=42, joint='curve')

    left = leaf((508, 575), (414, 372), (274, 472), (352, 612))
    right = leaf((512, 498), (604, 295), (756, 389), (674, 535))
    draw.polygon(left, fill=LEAF_LIGHT)
    draw.polygon(right, fill=GREEN)

    draw.line(quadratic((508, 566), (418, 488), (318, 485)), fill=CREAM, width=15)
    draw.line(quadratic((512, 498), (616, 406), (711, 400)), fill=CREAM, width=15)

    draw.arc((370, 682, 654, 864), start=197, end=343, fill=GREEN, width=34)
    draw.ellipse((493, 742, 531, 780), fill=CLAY)
    draw.ellipse((417, 198, 464, 245), fill=CREAM)
    draw.ellipse((443, 172, 474, 203), fill=CREAM)
    draw.ellipse((382, 177, 410, 205), fill=CREAM)
    return image


def main() -> None:
    master = build_master()
    SOURCE_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    master.save(SOURCE_OUTPUT, optimize=True)
    sizes = {
        'mipmap-mdpi': 48,
        'mipmap-hdpi': 72,
        'mipmap-xhdpi': 96,
        'mipmap-xxhdpi': 144,
        'mipmap-xxxhdpi': 192,
    }
    outputs = []
    for folder, size in sizes.items():
        target = ANDROID / folder / 'ic_launcher.png'
        target.parent.mkdir(parents=True, exist_ok=True)
        master.resize((size, size), Image.Resampling.LANCZOS).save(target, optimize=True)
        outputs.append(str(target.relative_to(ROOT)))
    web_icon = ROOT / 'apps/web/public/babyplan-icon.png'
    web_icon.parent.mkdir(parents=True, exist_ok=True)
    master.resize((192, 192), Image.Resampling.LANCZOS).save(web_icon, optimize=True)
    outputs.append(str(web_icon.relative_to(ROOT)))
    launch_mark = ANDROID / 'drawable-nodpi/launch_mark.png'
    launch_mark.parent.mkdir(parents=True, exist_ok=True)
    master.resize((192, 192), Image.Resampling.LANCZOS).save(
        launch_mark,
        optimize=True,
    )
    outputs.append(str(launch_mark.relative_to(ROOT)))

    print(
        json.dumps(
            {
                'master': str(SOURCE_OUTPUT.relative_to(ROOT)),
                'generated': outputs,
                'palette': {
                    'background': CREAM,
                    'sprout': GREEN,
                    'leaf': LEAF_LIGHT,
                    'accent': CLAY,
                },
            },
            ensure_ascii=True,
        )
    )


if __name__ == '__main__':
    main()
