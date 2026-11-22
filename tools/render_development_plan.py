"""校验开发任务依赖并生成可阅读的计划，不执行产品开发或修改任务状态。"""
from collections import Counter
from html import escape
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'docs/development/开发任务清单.json'
OUTPUT = ROOT / 'deliverables/v2'


def validate(plan):
    tasks = plan['tasks']
    task_ids = [task['id'] for task in tasks]
    assert len(set(task_ids)) == len(task_ids), '任务 ID 重复'
    by_id = {task['id']: task for task in tasks}
    phases = {phase['id']: phase for phase in plan['phases']}
    listed = [item for phase in plan['phases'] for item in phase['taskIds']]
    assert Counter(listed) == Counter(task_ids), '阶段任务清单不完整或重复'
    for task in tasks:
        assert task['owner'] in plan['roles'], task['id']
        assert task['phase'] in phases and task['id'] in phases[task['phase']]['taskIds'], task['id']
        assert task['size'] in plan['sizeMeaning'], task['id']
        assert task['status'] in plan['statusValues'], task['id']
        assert task['deliverable'] and task['acceptance'], task['id']
        assert len(set(task['dependsOn'])) == len(task['dependsOn']), task['id']
        assert all(dep in by_id and dep != task['id'] for dep in task['dependsOn']), task['id']
        assert all(code in {f'V{n}' for n in range(201, 219)} for code in task['checks']), task['id']
        if task['status'] == 'done':
            assert task['evidence'], f"{task['id']} 缺实际完成证据"
        for proof in task['evidence']:
            assert (ROOT / proof).is_file(), f"证据不存在：{proof}"
    visiting, visited, order = set(), set(), []

    def visit(task_id):
        assert task_id not in visiting, f'循环依赖：{task_id}'
        if task_id in visited:
            return
        visiting.add(task_id)
        for dep in by_id[task_id]['dependsOn']:
            visit(dep)
        visiting.remove(task_id)
        visited.add(task_id)
        order.append(task_id)

    for task_id in task_ids:
        visit(task_id)
    return by_id, order


def render(plan, by_id):
    status_names = {'planned': '待开始', 'in_progress': '进行中', 'review': '待复核', 'done': '已完成', 'blocked': '受阻'}
    status_counts = Counter(task['status'] for task in by_id.values())
    status_summary = ' · '.join(
        f"{status_names[key]} {status_counts.get(key, 0)}"
        for key in ('done', 'review', 'in_progress', 'planned', 'blocked')
    )
    md = ['# BabyPlan 开发任务明细', '',
          f"计划 {plan['planVersion']} · {plan['updatedOn']} · {len(by_id)} 项主任务", '',
          '本文件由 `tools/render_development_plan.py` 从 [开发任务清单.json](开发任务清单.json) 生成。状态以 JSON 和其中记录的完成证据为准。', '',
          f'当前状态：{status_summary}。', '',
          '[详细开发计划](../v2/08-详细开发计划.md) · [并行分工](并行协作说明.md)', '',
          '牵头角色不改变目录所有权。涉及共享合同或其他端代码的任务，由主代理协调对应文件所有者处理。', '']
    cards, overview = [], []
    for phase in plan['phases']:
        pid, title = phase['id'], phase['title']
        overview.append(f'<a href="#phase-{pid}"><span>{pid}</span><strong>{escape(title)}</strong><small>{escape(phase["outcome"])}</small></a>')
        cards.append(f'<section class="phase" id="phase-{pid}"><div class="section-label">{pid}</div><h2>{escape(title)}</h2><p>{escape(phase["outcome"])}</p><p class="gate"><strong>放行条件：</strong>{escape(phase["gate"])}</p>')
        md.extend([f'## {pid} {title}', '', phase['outcome'], '', f"放行条件：{phase['gate']}", ''])
        for task_id in phase['taskIds']:
            task = by_id[task_id]
            owner = plan['roles'][task['owner']]
            status = status_names[task['status']]
            deps = '、'.join(task['dependsOn']) or '无，可独立开始'
            checks = '、'.join(task['checks']) or '环境、合同与结构检查'
            md.extend([f"### {task_id} {task['title']}", '',
                       f"- 状态：{status}；牵头：{owner}；复杂度：{task['size']}。",
                       f'- 前置：{deps}。', f"- 交付：{task['deliverable']}。",
                       f"- 验收：{task['acceptance']}。", f'- 对应检查：{checks}。', ''])
            dep_html = '、'.join(f'<a href="#{d}">{d}</a>' for d in task['dependsOn']) or '无，可独立开始'
            opened = ' open' if pid == 'P0' else ''
            cards.append(f'''<details id="{task_id}"{opened}><summary><span class="task-id">{task_id}</span><span>{escape(task['title'])}</span><small>{escape(status)}</small></summary><div class="task-body"><p class="meta">牵头：{escape(owner)} · 复杂度 {task['size']}</p><dl><dt>前置任务</dt><dd>{dep_html}</dd><dt>交付物</dt><dd>{escape(task['deliverable'])}</dd><dt>验收条件</dt><dd>{escape(task['acceptance'])}</dd><dt>对应检查</dt><dd>{escape(checks)}</dd></dl></div></details>''')
        cards.append('</section>')
    (ROOT / 'docs/development/开发任务明细.md').write_text('\n'.join(md), encoding='utf-8')
    page = '''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BabyPlan｜详细开发计划</title><style>
:root{font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:#28392e;background:#f7f5ef;font-size:16px;line-height:1.75}*{box-sizing:border-box}body{margin:0}a{color:#435b43;text-underline-offset:4px}a:focus-visible,summary:focus-visible{outline:3px solid #9b4b32;outline-offset:4px}header,main,footer{max-width:1120px;margin:auto;padding:25px 32px}header{display:flex;justify-content:space-between;gap:18px;border-bottom:1px solid #d6dacf}header a{text-decoration:none}main{padding-top:48px;padding-bottom:60px}h1{font-family:SimSun,serif;font-size:clamp(32px,5vw,52px);font-weight:500;line-height:1.4;margin:10px 0 20px}h2{font-size:25px;margin:0 0 10px}p{margin:10px 0}.eyebrow,.section-label{font-size:13px;letter-spacing:2px;color:#9b4b32}.intro{max-width:800px;font-size:18px;color:#606b60}.status{background:#e9eddf;padding:20px 24px;border-radius:16px;margin:26px 0}.status p{margin:0}.roadmap{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:30px 0}.roadmap a{padding:20px;background:#fffefa;border-radius:16px;text-decoration:none}.roadmap span{display:block;color:#9b4b32;font-size:13px;margin-bottom:6px}.roadmap strong{display:block;font-size:18px}.roadmap small{display:block;color:#606b60;font-size:14px;margin-top:8px}.notes{display:grid;grid-template-columns:1fr 1fr;gap:25px;margin-top:35px}.notes h2{font-size:20px}.notes p{font-size:15px;color:#606b60}.phase{border-top:1px solid #d6dacf;padding-top:30px;margin-top:46px;scroll-margin-top:20px}.gate{color:#606b60;font-size:15px;margin:14px 0 22px}.phase>p{max-width:900px}details{border-bottom:1px solid #d6dacf;scroll-margin-top:20px}summary{cursor:pointer;display:flex;align-items:center;flex-wrap:wrap;gap:10px 16px;padding:18px 0;min-height:52px;font-weight:600}summary:before{content:"＋";color:#435b43;font-weight:400}details[open]>summary:before{content:"−"}.task-id{color:#9b4b32;font-size:13px;min-width:46px}summary small{margin-left:auto;font-size:13px;color:#606b60;font-weight:400}.task-body{padding:0 24px 22px 38px}.meta{font-size:14px;color:#606b60}dl{display:grid;grid-template-columns:76px 1fr;gap:10px 18px;margin:15px 0 0}dt{color:#606b60;font-size:14px}dd{margin:0;overflow-wrap:anywhere}.links{display:flex;flex-wrap:wrap;gap:14px 24px;margin:22px 0}.final-note{margin-top:35px;padding:20px 24px;background:#f2e5d5;border-radius:16px;color:#70402f}footer{border-top:1px solid #d6dacf;color:#606b60;font-size:13px;padding-bottom:35px}@media(max-width:700px){header,main,footer{padding-left:20px;padding-right:20px}.roadmap{grid-template-columns:1fr 1fr}.notes{grid-template-columns:1fr}.task-body{padding-left:0;padding-right:0}dl{grid-template-columns:1fr;gap:3px}dd{margin-bottom:10px}summary{gap:8px}summary small{width:100%;margin-left:30px}.status{padding:18px}}@media(max-width:420px){.roadmap{grid-template-columns:1fr}}@media print{body{background:white;color:black;font-size:11pt}header,main,footer{max-width:none;padding:0}.roadmap{grid-template-columns:repeat(3,1fr)}details{break-inside:avoid}details::details-content{content-visibility:visible!important;height:auto!important}details>.task-body{display:block!important}summary{font-size:12pt}h1{font-size:26pt}.phase{margin-top:25px}.links{display:none}@page{size:A4;margin:16mm}}
</style></head><body><header><a href="../../打开设计.html">小芽 · BabyPlan</a><span>开发计划 PLAN_VERSION · PLAN_UPDATED_ON</span></header><main><div class="eyebrow">FROM DESIGN TO DAILY PLAY</div><h1>先做成能用的 App，<br>再一步步长完整。</h1><p class="intro">先安装、看玩法、记一次；再接通爸爸妈妈、离线和提醒。成长照片、家长网页和内容工作台随后交付。</p><div class="status"><p><strong>当前状态：STATUS_SUMMARY。</strong><br>完成状态只按代码、测试、构建和真实使用证据更新；自动化通过不替代真机、人工审读或生产部署。</p></div><nav class="roadmap" aria-label="开发阶段">OVERVIEW</nav><div class="notes"><div><h2>怎样并行</h2><p>主代理负责合同、集成与验收，子代理分别承担安卓、后端、网页或运维工作。角色按阶段轮换，同一文件只由一人修改。</p></div><div><h2>何时算完成</h2><p>交付物能运行，相关检查有证据，真机与自动化分开记录。没有新实测速度前按批次推进，不把代理数量直接换算成工期。</p></div></div><div class="links"><a href="../../docs/v2/08-详细开发计划.md">完整开发方案</a><a href="../../docs/development/并行协作说明.md">子代理分工</a><a href="../../docs/development/接口补齐清单.md">接口补齐清单</a><a href="../../docs/development/客户端交付与验收.md">客户端实施附件</a><a href="../../docs/development/内容审读与发布验收.md">内容与验收附件</a></div><p>点击任务展开交付和验收。复杂度 S / M / L 表示相对工作量，L 项在实施时继续拆分；它们不是天数。原验收编号 V201～V218 保持不变。</p>CARDS<div class="final-note"><strong>内容也从第一批开始。</strong><p>24 张活动卡先留真实审读证据，再开展私人家庭试玩。允许如实记录自审；AI 检查不代替人工或专业审核，也不以宝宝“学会多少”作为验收。</p></div><div class="links"><a href="../../docs/development/开发任务清单.json">任务数据与状态</a><a href="../../docs/development/开发任务明细.md">任务文字版</a><a href="../BabyPlan-v2-设计交付包.zip">下载完整交付包</a></div></main><footer>状态与证据以任务清单为准。签名与自动化各有记录；真机、人工内容审读与生产部署仍须另验。<br>阅读版从任务清单生成；更新任务后运行 tools/render_development_plan.py。</footer></body></html>'''
    page = (page.replace('STATUS_SUMMARY', status_summary)
            .replace('PLAN_VERSION', escape(plan['planVersion']))
            .replace('PLAN_UPDATED_ON', escape(plan['updatedOn'])))
    page = page.replace('OVERVIEW', ''.join(overview)).replace('CARDS', ''.join(cards))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / '开发计划.html').write_text(page, encoding='utf-8')


if __name__ == '__main__':
    data = json.loads(SOURCE.read_text(encoding='utf-8'))
    mapping, topological = validate(data)
    render(data, mapping)
    print(json.dumps({'tasks': len(mapping), 'phases': len(data['phases']), 'acyclic': True,
                      'statusCounts': dict(Counter(t['status'] for t in data['tasks'])),
                      'dependencyOrderValid': len(topological) == len(mapping)}, ensure_ascii=True))
