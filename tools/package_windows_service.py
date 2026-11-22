"""只打包重新安装 Windows 家庭服务所需的文件，不读取任何运行目录。"""

import argparse
import hashlib
import json
import re
from pathlib import Path
from stat import FILE_ATTRIBUTE_REPARSE_POINT
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
VERSION = re.search(r'^version:\s*(\d+\.\d+\.\d+)\+\d+',
                    (ROOT / 'apps/mobile/pubspec.yaml').read_text(encoding='utf-8'), re.M)[1]
NAME = f'BabyPlan-{VERSION}-windows-service'

FILES = (
    'services/api/package.json', 'services/api/package-lock.json',
    'services/api/tsconfig.json', 'services/api/tsconfig.build.json',
    'apps/web/package.json', 'apps/web/server.mjs',
    'ops/Caddyfile.example',
    'contracts/v2/content-package.schema.json', 'contracts/v2/review-evidence.schema.json',
    'content/candidate/babyplan-18-23-v2.json',
    'docs/家长使用与交付说明.md', 'docs/ops/私有部署与备份恢复.md',
    'docs/content/逐卡审读台账.md',
    'docs/qa/删除恢复与撤回验收-2026-11-13.md',
    'tools/validate_v2_content.py',
)
TREES = (
    ('services/api/src', '*.ts'), ('services/api/migrations', '*.sql'),
    ('apps/web/public', '*.js'), ('apps/web/public', '*.html'),
    ('apps/web/public', '*.css'), ('apps/web/public', '*.png'),
    ('scripts/ops', '*.ps1'), ('scripts/ops', '*.psm1'),
)
FORBIDDEN = re.compile(r'(^|/)(private|node_modules|dist|\.work|media-data|backups)(/|$)'
                       r'|\.(pem|p12|jks|keystore|env|db|dump)$', re.I)


def safe_file(path: Path) -> Path:
    for entry in (path, *path.parents):
        if entry == ROOT:
            break
        if entry.is_symlink() or getattr(entry.lstat(), 'st_file_attributes', 0) & FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError(f'不打包链接路径：{path.relative_to(ROOT)}')
    name = path.relative_to(ROOT).as_posix()
    if FORBIDDEN.search(name) or not path.is_file():
        raise ValueError(f'不打包此文件：{name}')
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--replace', action='store_true', help='校验新产物成功后替换同版本部署包')
    args = parser.parse_args()
    destination = ROOT / 'releases' / f'v{VERSION}' / f'{NAME}.zip'
    if destination.exists() and not args.replace:
        raise FileExistsError(f'{destination} 已存在；校验后替换需要 --replace')
    partial = destination.with_suffix('.zip.partial')
    paths = {ROOT / name for name in FILES}
    for directory, pattern in TREES:
        paths.update((ROOT / directory).rglob(pattern))
    with ZipFile(partial, 'x', compression=ZIP_DEFLATED) as output:
        manifest = {}
        for path in sorted(paths):
            name = path.relative_to(ROOT).as_posix()
            if name in {'scripts/ops/New-ReleaseBundle.ps1', 'scripts/ops/Stage-AndroidRelease.ps1'}:
                continue  # 制作 Android 交付物的脚本不属于部署包。
            data = safe_file(path).read_bytes()
            output.writestr(f'{NAME}/{name}', data)
            manifest[name] = hashlib.sha256(data).hexdigest()
        output.writestr(f'{NAME}/FILES.json', json.dumps(manifest, indent=2, ensure_ascii=False))
        output.writestr(f'{NAME}/先看这里.txt', '''BabyPlan Windows 家庭服务

解压整个文件夹。只想在手机上看当天活动时，直接安装 Android APK，无需本服务。
需要两位家长共享记录时，在 Windows 电脑准备 PowerShell 7、Node.js 24 和 PostgreSQL。
打开解压目录中的 PowerShell 7，运行：
  .\\scripts\\ops\\Install-BabyPlan.ps1 -LanAccess
详细步骤见 docs/家长使用与交付说明.md。局域网向导使用尚未人工审读的开发活动。
长期私人使用请按 docs/ops/私有部署与备份恢复.md 配置 HTTPS、已审读内容与备份。
本包不包含任何账号、私人资料或签名私钥；依赖由 npm 按锁定版本安装。
''')
    with ZipFile(partial) as output:
        if output.testzip() or len(output.namelist()) != len(manifest) + 2:
            raise RuntimeError('部署包回读校验失败')
        for name, sha256 in manifest.items():
            if hashlib.sha256(output.read(f'{NAME}/{name}')).hexdigest() != sha256:
                raise RuntimeError(f'部署包文件与来源不一致：{name}')
    partial.replace(destination)
    print(f'{destination} | files={len(manifest) + 2} | SHA-256 {hashlib.sha256(destination.read_bytes()).hexdigest()}')


if __name__ == '__main__':
    main()
