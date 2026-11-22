"""验证内容结构、业务引用、候选发布门禁、API内部引用和设计颜色。"""
import copy
import json
from pathlib import Path
import yaml
from jsonschema import Draft202012Validator, FormatChecker

ROOT=Path(__file__).resolve().parents[1]
pack=json.loads((ROOT/'content/candidate/babyplan-18-23-v2.json').read_text(encoding='utf-8'))
schema=json.loads((ROOT/'contracts/v2/content-package.schema.json').read_text(encoding='utf-8'))
Draft202012Validator.check_schema(schema)
validator=Draft202012Validator(schema,format_checker=FormatChecker())

def validate_content(data):
    failures=[f"schema: {'/'.join(map(str,e.path))}: {e.message}" for e in validator.iter_errors(data)]
    cards=data['cards'];ids=[c['id'] for c in cards];by_id={c['id']:c for c in cards}
    sources={s['id'] for s in data['sources']};bands={b['id'] for b in data['ageBands']}
    if len(ids)!=len(set(ids)):failures.append('duplicate_card')
    if len(sources)!=len(data['sources']):failures.append('duplicate_source')
    if [d['day'] for d in data['week']['days']]!=list(range(1,8)):failures.append('day_order')
    all_items=[]
    for c in cards:
        if not set(c['sourceIds'])<=sources:failures.append('missing_source')
        if not set(c['ageBands'])<=bands:failures.append('missing_band')
    for day in data['week']['days']:
        if sum(i['minutes'] for i in day['items'])!=60:failures.append('daily_budget')
        for block,expected in [('before',25),('after',25),('bedtime',10)]:
            if sum(i['minutes'] for i in day['items'] if i['block']==block)!=expected:failures.append('block_budget')
        if set(i['kind'] for i in day['items'])!={'movement','explore','reading','english','child-led','calm'}:failures.append('slot_coverage')
        for item in day['items']:
            all_items.append(item['id']);c=by_id.get(item['cardId'])
            if c is None:failures.append('missing_card');continue
            if c['kind']!=item['kind']:failures.append('slot_mismatch')
            if data['week']['ageBand'] not in c['ageBands']:failures.append('age_mismatch')
            if c['withdrawn']:failures.append('withdrawn_selected')
    if len(all_items)!=len(set(all_items)):failures.append('duplicate_item')
    for g in data['stageGuides']:
        if g['sourceId'] not in sources:failures.append('missing_guide_source')
        for f in g['focuses']:
            if not set(f['cardIds'])<=set(ids):failures.append('missing_guide_card')
            for c in f['cardIds']:
                if c in by_id and g['ageBand'] not in by_id[c]['ageBands']:failures.append('guide_age_mismatch')
    return failures

failures=validate_content(pack)
assert not failures, '\n'.join(failures)
negative=[]
for name,mutation in [
    ('missing_safety',lambda d:d['cards'][0].pop('safety')),
    ('duplicate_card',lambda d:d['cards'].append(copy.deepcopy(d['cards'][0]))),
    ('missing_source',lambda d:d['cards'][0]['sourceIds'].append('NO_SOURCE')),
    ('bad_budget',lambda d:d['week']['days'][0]['items'][0].update(minutes=14)),
    ('wrong_age',lambda d:d['cards'][0].update(ageBands=['m24_29'])),
    ('withdrawn_card',lambda d:d['cards'][0].update(withdrawn=True)),
    ('premature_release',lambda d:d.update(channel='release')),
    ('future_guide_reuses_wrong_age',lambda d:d['stageGuides'][1]['focuses'][0]['cardIds'].append('roll')),
]:
    bad=copy.deepcopy(pack);mutation(bad);errors=validate_content(bad);assert errors,f'Negative case accepted: {name}';negative.append(name)

api=yaml.safe_load((ROOT/'contracts/v2/openapi.yaml').read_text(encoding='utf-8'))
refs=[]
def walk(value):
    if isinstance(value,dict):
        if '$ref' in value:refs.append(value['$ref'])
        for v in value.values():walk(v)
    elif isinstance(value,list):
        for v in value:walk(v)
walk(api)
for r in refs:
    assert r.startswith('#/'),r
    target=api
    for key in r[2:].split('/'):target=target[key.replace('~1','/').replace('~0','~')]
operations=[op for path in api['paths'].values() for op in path.values()]
assert len({op['operationId'] for op in operations})==len(operations)
for name,s in api['components']['schemas'].items():Draft202012Validator.check_schema(s)

def luminance(hex_value):
    rgb=[int(hex_value[i:i+2],16)/255 for i in (1,3,5)]
    return sum(w*(v/12.92 if v<=0.04045 else ((v+.055)/1.055)**2.4) for w,v in zip([.2126,.7152,.0722],rgb))
def contrast(a,b):
    aa,bb=sorted([luminance(a),luminance(b)]);return (bb+.05)/(aa+.05)
tokens=json.loads((ROOT/'docs/v2/design-tokens.json').read_text(encoding='utf-8'))
contrasts=[]
for theme,colors in tokens['colors'].items():
    for foreground,background,minimum in [('text','background',4.5),('textSecondary','background',4.5),('textSecondary','surface',4.5),('onPrimary','primary',4.5),('accent','surface',4.5),('outline','surface',3)]:
        ratio=contrast(colors[foreground],colors[background]);assert ratio>=minimum,(theme,foreground,ratio)
        contrasts.append({'theme':theme,'foreground':foreground,'background':background,'ratio':round(ratio,2),'minimum':minimum})
prototype=(ROOT/'prototype/v2/content.js').read_text(encoding='utf-8')
assert json.loads(prototype.removeprefix('window.BABYPLAN_CONTENT = ').strip().removesuffix(';'))==pack
report={'contentCards':len(pack['cards']),'days':len(pack['week']['days']),'scheduledItems':sum(len(d['items']) for d in pack['week']['days']),'stageSupports':sum(len(g['focuses']) for g in pack['stageGuides']),'apiOperations':len(operations),'apiSchemas':len(api['components']['schemas']),'resolvedRefs':len(refs),'negativeCasesRejected':negative,'contrast':contrasts,'limits':['No medical/content expert review','No native/device or deployed API validation','API reference/schema checks are not an OpenAPI conformance certification']}
out=ROOT/'deliverables/v2';out.mkdir(parents=True,exist_ok=True)
(out/'structure-check.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k not in ['contrast','limits']},ensure_ascii=True))
