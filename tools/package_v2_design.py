"""生成给家长阅读的活动手册、界面画板，以及不含私人配置的设计交付包。"""
import hashlib
import html
import json
from pathlib import Path
import zipfile

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'deliverables/v2'
OUT.mkdir(parents=True,exist_ok=True)
pack=json.loads((ROOT/'content/candidate/babyplan-18-23-v2.json').read_text(encoding='utf-8'))
e=html.escape
cards={c['id']:c for c in pack['cards']}
kinds={'movement':'亲子运动','explore':'动手探索','reading':'中文共读','english':'英语互动','child-led':'孩子主导','calm':'安静收尾'}
css='''body{font-family:"Microsoft YaHei",system-ui,sans-serif;margin:0;color:#28392e;background:#f7f5ef;line-height:1.75}main{max-width:1000px;margin:auto;padding:45px 30px}h1{font-size:36px;line-height:1.4}h2{font-size:25px;margin-top:30px}h3{margin:18px 0 8px;font-size:18px}p{margin:8px 0}a{color:#435b43}.muted{color:#606b60;font-size:14px}.card{background:#fffefa;padding:30px;border-radius:20px;margin:28px 0;break-inside:avoid}.eyebrow{color:#9b4b32;letter-spacing:2px;font-size:12px}.steps{padding-left:24px}.steps li{padding:5px}.quote{background:#f2e5d5;padding:20px;border-radius:15px;margin:20px 0}.responses{display:grid;grid-template-columns:1fr 1fr;gap:12px 25px}.responses strong{display:block;color:#435b43}table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:12px;border-bottom:1px solid #dedfd4;vertical-align:top}th{background:#e9eddf}.table-wrap{overflow:auto}.safety{border-left:3px solid #9b4b32;padding-left:15px;margin-top:20px}.links{display:flex;gap:12px 22px;flex-wrap:wrap}@media(max-width:650px){main{padding:28px 18px}.card{padding:22px}.responses{grid-template-columns:1fr}h1{font-size:29px}}@media print{body{background:white;font-size:12px}main{padding:0;max-width:none}.card{padding:20px 0;border-radius:0;border-bottom:1px solid #ccc}a{color:black}header .links{display:none}@page{size:A4;margin:16mm}}'''
body=['<header><div class="eyebrow">BABYPLAN / FAMILY PLAY HANDBOOK</div><h1>每天一点，一起长大。</h1><p>18～23月龄陪伴活动手册 · 24张原创候选 · 2026-11-13</p><p class="muted">给家长看的提示，在线下与宝宝一起玩。预算可拆分，宝宝想停时就停。候选内容尚未完成专业审阅与家庭试玩；来源不等于每张卡的官方认证。</p><div class="links"><a href="../../打开设计.html">回到设计总览</a><a href="../../prototype/v2/index.html">打开手机体验</a><a href="#week">先看一周安排</a></div></header>']
body.append('<section id="week"><h2>一周不用自己备课</h2><p class="muted">晚饭前25分钟，晚饭后25分钟，睡前10分钟；每段都可以提前结束。忙碌时选运动、探索、共读、英语各5分钟。</p><div class="table-wrap"><table><thead><tr><th>天</th><th>主题</th><th>这一天的六项灵感</th></tr></thead><tbody>')
for day in pack['week']['days']:
    links='、'.join(f'<a href="#{i["cardId"]}">{e(cards[i["cardId"]]["title"])}</a>' for i in day['items'])
    body.append(f'<tr><td>{day["day"]}</td><td>{e(day["theme"])}</td><td>{links}</td></tr>')
body.append('</tbody></table></div></section><h2>24张可以拿起来就读的活动卡</h2>')
for i,c in enumerate(pack['cards'],1):
    steps=''.join(f'<li>{e(s)}</li>' for s in c['steps'])
    responses=''.join(f'<div><strong>{label}</strong>{e(c["dialogue"][key])}</div>' for key,label in [('engaged','宝宝跟着玩'),('observing','宝宝只是看'),('stopping','宝宝想停')])
    refs=' / '.join(f'<a href="{s["url"]}">{e(s["title"])}</a>' for s in pack['sources'] if s['id'] in c['sourceIds'])
    body.append(f'''<article class="card" id="{c['id']}"><span class="eyebrow">{i:02} / {kinds[c['kind']]} / 18～23月</span><h2>{e(c['title'])}</h2><p class="muted">{e(c['support'])}</p><h3>拿好这些</h3><p>{e(' · '.join(c['materials']) or '不用道具。')}</p><h3>三个动作，慢慢来</h3><ol class="steps">{steps}</ol><div class="quote"><strong>开场可以这样说</strong><p>“{e(c['dialogue']['opening'])}”</p></div><div class="responses">{responses}</div><h3>顺口说一句英语</h3><p><strong lang="en">{e(c['english']['phrase'])}</strong> — {e(c['english']['meaning'])}</p><p class="muted">{e(c['english']['when'])}</p><p><strong>更容易一点：</strong>{e(c['easier'])}</p><p><strong>愿意时下一步：</strong>{e(c['next'])}</p><div class="safety"><strong>陪玩时留意</strong><p>{e(c['safety'])}</p></div><p class="muted">原创候选 · 方向依据：{refs}</p></article>''')
body.append('<h2>从现在到三岁的阶段支持</h2><p class="muted">以下是产品支持建议，不是发育清单。后续阶段专门活动包尚未制作，不能把18月卡直接替代。</p>')
for g in pack['stageGuides']:
    body.append(f'<section class="card"><div class="eyebrow">{e(g["ageBand"])} / 来源节点{g["sourceAgeMonths"]}月</div><h2>{e(g["title"])}</h2><p>{e(g["description"])}</p>')
    for f in g['focuses']:body.append(f'<h3>{e(f["title"])}</h3><p>{e(f["everyday"])}</p><p><strong>支持：</strong>{e(f["support"])}</p><p><strong>更容易：</strong>{e(f["easier"])}</p><p><strong>下一步：</strong>{e(f["next"])}</p>')
    body.append('</section>')
body.append('<footer class="muted">所有活动脚本为本项目原创候选；没有绘本内页、完整歌词或受保护音频。发展疑虑请与儿保/儿科专业人员交流，不用增加打卡次数替代咨询。</footer>')
(OUT/'活动手册.html').write_text('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BabyPlan｜24张陪伴活动手册</title><style>'+css+'</style></head><body><main>'+''.join(body)+'</main></body></html>',encoding='utf-8')
board='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>BabyPlan 界面总览</title><style>body{margin:0;background:#eeeee5;color:#28392e;font-family:"Microsoft YaHei",system-ui,sans-serif}main{padding:48px 55px}header{display:flex;justify-content:space-between;align-items:end;margin-bottom:30px}h1{font-family:SimSun,serif;font-size:34px;font-weight:500;margin:5px 0}p{font-size:14px;color:#606b60}small{font-size:11px;letter-spacing:2px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:25px}figure{margin:0}img{width:100%;display:block;border-radius:24px;box-shadow:0 15px 40px #28392e12}figcaption{font-size:15px;margin:17px 5px 0}figcaption span{color:#9b4b32;font-size:12px;margin-right:12px}footer{margin-top:30px;border-top:1px solid #cdd2c2;padding-top:15px;font-size:12px;color:#606b60}@media(max-width:800px){.grid{grid-template-columns:repeat(2,1fr)}main{padding:25px}}</style></head><body><main><header><div><small>BABYPLAN / DESIGN 02</small><h1>把今天的陪伴，准备好。</h1><p>小芽 · 面向家长的亲子游戏与共读助手</p></div><p>18～23月 / 手机体验</p></header><div class="grid">'''
for i,(name,title) in enumerate([('today','今天 · 先从一项开始'),('detail','玩法 · 知道怎么回应'),('stage','阶段 · 给一点支持'),('growth','成长 · 记住小小瞬间')],1):board+=f'<figure><img src="screens/mobile-{name}.png" alt="{title}"><figcaption><span>0{i}</span>{title}</figcaption></figure>'
board+='</div><footer>高保真交互设计 / 虚构数据 / 2026-11-13　　原型与完整说明：打开项目根目录「打开设计.html」</footer></main></body></html>'
(OUT/'界面总览.html').write_text(board,encoding='utf-8')

if __name__=='__main__':
    # 明确白名单；不打包.claude、.work、凭证、诊断脚本或依赖缓存。
    files=[ROOT/'README.md',ROOT/'打开设计.html']
    for directory in ['docs','contracts','content','prototype']:
        files.extend(p for p in (ROOT/directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    files.extend(p for p in (ROOT/'tools').glob('*') if p.suffix in ['.py','.cjs'])
    files.extend(p for p in (ROOT/'deliverables').rglob('*') if p.is_file() and p.suffix.lower() not in ['.zip'] and p!=OUT/'manifest.json')
    files=sorted(set(files))
    manifest=[{'path':p.relative_to(ROOT).as_posix(),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]
    (OUT/'manifest.json').write_text(json.dumps({'version':'2.0-design','createdOn':'2026-11-13','files':manifest},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    bundle=ROOT/'deliverables/BabyPlan-v2-设计交付包.zip'
    with zipfile.ZipFile(bundle,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for p in files:z.write(p,p.relative_to(ROOT).as_posix())
        z.write(OUT/'manifest.json','deliverables/v2/manifest.json')
    with zipfile.ZipFile(bundle) as z:assert z.testzip() is None
    print(json.dumps({'files':len(files)+1,'bytes':bundle.stat().st_size,'zip':'deliverables/BabyPlan-v2-design-handoff.zip (Chinese filename on disk)'},ensure_ascii=True))
