"""构建版本化的设计/实施合同；不生成或部署服务。"""
import json
from pathlib import Path
import sys
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_contracts_v2 import extend_package, extend_api, evidence_schema

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'contracts/v2'
OUT.mkdir(parents=True,exist_ok=True)
def obj(properties,required=None):
    return {'type':'object','additionalProperties':False,'properties':properties,'required':list(properties) if required is None else required}
def string(maximum=200):return {'type':'string','minLength':1,'maxLength':maximum}
def enum(*values):return {'type':'string','enum':list(values)}
def arr(item,minimum=0,maximum=100):return {'type':'array','items':item,'minItems':minimum,'maxItems':maximum}
def ref(name):return {'$ref':f'#/components/schemas/{name}'}
def nullable(schema):return {'anyOf':[schema,{'type':'null'}]}
ID={'type':'string','format':'uuid'}
DATE={'type':'string','format':'date'}
STAMP={'type':'string','format':'date-time'}
REV={'type':'integer','minimum':0}
TEXT={'type':'string','maxLength':2000}
BAND=enum('m18_23','m24_29','m30_35','m36')
KIND=enum('movement','explore','reading','english','child-led','calm')
source=obj({'id':string(60),'title':string(200),'url':{'type':'string','format':'uri'},'verifiedOn':DATE,'scope':string(500)})
activity=obj({'id':string(60),'revision':{'type':'integer','minimum':1},'title':string(60),'kind':KIND,'ageBands':arr(BAND,1,4),'support':string(300),'materials':arr(string(150),0,12),'steps':arr(string(400),1,5),'dialogue':obj({k:string(300) for k in ['opening','engaged','observing','stopping']}),'english':obj({'phrase':string(200),'meaning':string(200),'when':string(300)}),'easier':string(300),'next':string(300),'safety':string(700),'sourceIds':arr(string(60),1,10),'reviewState':enum('draft','reviewed'),'rights':enum('original','licensed'),'withdrawn':{'type':'boolean'}})
focus=obj({'id':string(60),'domain':string(60),'title':string(100),'everyday':string(400),'support':string(400),'easier':string(300),'next':string(300),'cardIds':arr(string(60),0,10)})
guide=obj({'ageBand':BAND,'title':string(100),'description':string(500),'sourceId':string(60),'sourceAgeMonths':{'type':'integer','enum':[18,24,30,36]},'focuses':arr(focus,1,10)})
weekItem=obj({'id':string(60),'cardId':string(60),'block':enum('before','after','bedtime'),'kind':KIND,'minutes':{'type':'integer','minimum':1,'maximum':30}})
weekDay=obj({'day':{'type':'integer','minimum':1,'maximum':7},'theme':string(100),'items':arr(weekItem,6,6)})
book=obj({'id':string(60),'title':string(100),'editionStatus':enum('unverified','verified'),'note':string(500),'language':string(60)})
package=obj({'schemaVersion':{'const':2},'packageId':string(80),'contentVersion':{'type':'integer','minimum':1},'channel':enum('candidate','release'),'createdOn':DATE,'review':obj({'editorial':enum('draft','approved'),'expert':enum('not_reviewed','reviewed'),'familyTrial':enum('not_started','completed')}),'ageBands':arr(obj({'id':BAND,'label':string(60),'minMonths':{'type':'integer','minimum':0,'maximum':36},'maxMonths':{'type':'integer','minimum':0,'maximum':36}}),1,4),'sources':arr(source,1,100),'cards':arr(activity,1,500),'week':obj({'ageBand':BAND,'mode':{'const':'standard'},'budgetMinutes':{'const':60},'days':arr(weekDay,7,7)}),'stageGuides':arr(guide,1,20),'books':arr(book,0,100)})
package.update({'$schema':'https://json-schema.org/draft/2020-12/schema','$id':'urn:babyplan:content-package:2','title':'BabyPlan v2 内容候选与正式包'})
package['allOf']=[{'if':{'properties':{'channel':{'const':'release'}}},'then':{'properties':{'review':{'properties':{'editorial':{'const':'approved'},'expert':{'const':'reviewed'},'familyTrial':{'const':'completed'}}},'cards':{'items':{'properties':{'reviewState':{'const':'reviewed'}}}}}}}]
extend_package(package)
(OUT/'content-package.schema.json').write_text(json.dumps(package,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
(OUT/'review-evidence.schema.json').write_text(json.dumps(evidence_schema(),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

schemas={}
schemas['Error']=obj({'code':string(80),'message':string(500),'requestId':ID,'details':{'type':'object','additionalProperties':True}},['code','message','requestId'])
schemas['WriteMeta']=obj({'operationId':ID,'baseRevision':REV})
schemas['Ack']=obj({'id':ID,'revision':REV,'changeSeq':{'type':'integer','minimum':0}})
schemas['User']=obj({'id':ID,'displayName':nullable(string(60))})
schemas['Member']=obj({'userId':ID,'role':enum('owner','caregiver'),'active':{'type':'boolean'}})
schemas['Family']=obj({'id':ID,'name':string(80),'timezone':string(100),'members':arr(ref('Member'),1,20)})
schemas['Child']=obj({'id':ID,'familyId':ID,'displayName':nullable(string(60)),'ageMode':enum('months','birthDate'),'ageMonths':nullable({'type':'integer','minimum':0,'maximum':36}),'ageAsOf':nullable(DATE),'birthDate':nullable(DATE),'revision':REV})
schemas['AgeInput']=obj({'ageMode':enum('months','birthDate'),'ageMonths':nullable({'type':'integer','minimum':0,'maximum':36}),'ageAsOf':nullable(DATE),'birthDate':nullable(DATE),'displayName':nullable(string(60))})
schemas['Activity']=activity
schemas['StageGuide']=guide
schemas['FamilyBook']=obj({'id':ID,'familyId':ID,'title':string(100),'editionId':nullable(ID),'editionStatus':enum('unverified','verified'),'language':string(60),'note':TEXT,'revision':REV})
schemas['PlanItem']=obj({'id':ID,'dayPlanId':ID,'kind':KIND,'block':enum('before','after','bedtime'),'position':{'type':'integer','minimum':0},'budgetMinutes':{'type':'integer','minimum':1,'maximum':60},'snapshot':ref('Activity'),'lockedByParent':{'type':'boolean'},'startedAt':nullable(STAMP),'revision':REV,'reasonCodes':arr(enum('AVAILABLE_AT_HOME','FAMILIAR_FAVORITE','WEEK_VARIETY','AGE_MATCH'),1,4),'blockedByWithdrawal':{'type':'boolean'},'participation':nullable(ref('Participation'))})
schemas['DayPlan']=obj({'id':ID,'familyId':ID,'childId':ID,'localDate':DATE,'timezone':string(100),'mode':enum('standard','lite'),'generationVersion':string(60),'revision':REV,'items':arr(ref('PlanItem'),0,12),'missingSlots':arr(KIND,0,6)})
schemas['Participation']=obj({'id':ID,'planItemId':ID,'status':enum('played','skipped'),'participantIds':arr(ID,0,20),'notes':arr(obj({'authorId':ID,'text':TEXT}),0,20),'actualMinutes':nullable({'type':'integer','minimum':0,'maximum':1440}),'again':{'type':'boolean'},'addedBy':ID,'revision':REV})
schemas['ParticipationWrite']=obj({'operationId':ID,'baseRevision':REV,'status':enum('played','skipped'),'participantIds':arr(ID,0,20),'note':TEXT,'actualMinutes':nullable({'type':'integer','minimum':0,'maximum':1440}),'again':{'type':'boolean'}})
schemas['Memory']=obj({'id':ID,'childId':ID,'localDate':DATE,'type':enum('quote','story','first'),'text':string(2000),'firstConfirmed':{'type':'boolean'},'mediaIds':arr(ID,0,20),'addedBy':ID,'revision':REV,'deletedAt':nullable(STAMP)})
schemas['MemoryWrite']=obj({'operationId':ID,'id':ID,'localDate':DATE,'type':enum('quote','story','first'),'text':string(2000),'firstConfirmed':{'type':'boolean'},'mediaIds':arr(ID,0,20)})
schemas['Measurement']=obj({'id':ID,'childId':ID,'localDate':DATE,'kind':enum('height','weight'),'value':{'type':'number','exclusiveMinimum':0,'maximum':300},'unit':enum('cm','kg'),'method':enum('recumbent','standing','scale'),'source':enum('home','clinic'),'revision':REV,'deletedAt':nullable(STAMP)})
schemas['Observation']=obj({'id':ID,'guideId':string(60),'childId':ID,'localDate':DATE,'value':enum('noticed','not_yet_observed','discuss'),'note':TEXT,'revision':REV,'deletedAt':nullable(STAMP)})
schemas['PlaySession']=obj({'id':ID,'childId':ID,'planItemId':nullable(ID),'localDate':DATE,'activityId':string(60),'activityRevision':{'type':'integer','minimum':1},'participantIds':arr(ID,1,20),'note':TEXT,'addedBy':ID,'revision':REV})
schemas['Media']=obj({'id':ID,'memoryId':ID,'state':enum('pending','processing','ready','failed','deleted'),'mime':enum('image/jpeg','image/png','image/webp'),'byteSize':{'type':'integer','minimum':1,'maximum':20971520},'sha256':{'type':'string','pattern':'^[a-f0-9]{64}$'},'downloadUrl':nullable({'type':'string','format':'uri'}),'expiresAt':nullable(STAMP)})
schemas['Export']=obj({'id':ID,'status':enum('queued','running','ready','failed','expired'),'downloadUrl':nullable({'type':'string','format':'uri'}),'expiresAt':nullable(STAMP),'missingMedia':arr(obj({'mediaId':ID,'reason':string(150)}),0,10000)})
schemas['Change']=obj({'sequence':{'type':'integer','minimum':1},'entity':enum('day_plan','participation','session','memory','measurement','observation','family_book','media','withdrawal'),'id':ID,'revision':REV,'deleted':{'type':'boolean'},'payload':nullable({'oneOf':[ref(n) for n in ['DayPlan','Participation','PlaySession','Memory','Measurement','Observation','FamilyBook','Media','Withdrawal']]})})
schemas['Withdrawal']=obj({'id':ID,'activityId':string(60),'revision':{'type':'integer','minimum':1},'reason':string(1000),'kind':enum('editorial','safety'),'effectiveAt':STAMP})
schemas['ContentRevision']=obj({'id':ID,'activity':ref('Activity'),'status':enum('draft','in_review','approved','published','withdrawn'),'revision':REV,'changeNote':TEXT})
schemas['Release']=obj({'id':ID,'version':{'type':'integer','minimum':1},'revisionIds':arr(ID,1,500),'state':enum('published','withdrawn'),'selfReviewed':{'type':'boolean'},'publishedAt':STAMP})

paths={}
security=[{'bearerSession':[]},{'cookieSession':[]}]
errors={str(n):{'description':desc,'content':{'application/json':{'schema':ref('Error')}}} for n,desc in [(400,'参数、日期或单位不合法'),(401,'会话无效'),(403,'角色不足'),(404,'对象不存在或不可见'),(409,'修订、幂等或业务冲突；details含current/submitted'),(429,'请求过于频繁'),(503,'暂时不可用')]}
def endpoint(path,method,operation,summary,body=None,response=None,status=200,anonymous=False,description='',query=None):
    parameters=[]
    import re
    for p in re.findall(r'\{(\w+)\}',path):parameters.append({'name':p,'in':'path','required':True,'schema':DATE if p=='date' else string(60) if p=='activityId' else ID})
    for p,s in (query or {}).items():parameters.append({'name':p,'in':'query','schema':s,'required':False})
    item={'operationId':operation,'summary':summary,'description':description or summary,'security':[] if anonymous else security,'responses':{str(status):{'description':'成功','content':{'application/json':{'schema':response or ref('Ack')}}},**errors}}
    if parameters:item['parameters']=parameters
    if body:item['requestBody']={'required':True,'content':{'application/json':{'schema':body}}}
    paths.setdefault(path,{})[method]=item

endpoint('/sessions','post','createSession','登录',obj({'email':{'type':'string','format':'email'},'password':{'type':'string','minLength':1,'maxLength':256},'deviceId':ID}),obj({'user':ref('User'),'accessToken':nullable(string(4096)),'expiresAt':STAMP}),anonymous=True,description='手机返回短期访问令牌，Web通过HttpOnly Cookie；刷新令牌安全交付，禁止写日志。登录限速。')
endpoint('/sessions/refresh','post','refreshSession','旋转刷新会话',obj({'deviceId':ID}),obj({'accessToken':nullable(string(4096)),'expiresAt':STAMP}),anonymous=True,description='必须提供有效刷新Cookie或X-Refresh-Token；每次旋转，旧令牌复用撤销令牌家族。CSRF保护Web请求。')
endpoint('/sessions/current','delete','deleteSession','退出当前设备')
endpoint('/accounts/recovery','post','requestRecovery','请求账号恢复',obj({'email':{'type':'string','format':'email'}}),obj({'accepted':{'const':True}}),202,True,'不泄露账号是否存在；一次性重置令牌24小时有效，管理员安全交付或邮件发送。')
endpoint('/accounts/reset','post','resetPassword','用一次性令牌重置密码',obj({'token':string(4096),'newPassword':{'type':'string','minLength':12,'maxLength':256}}),obj({'accepted':{'const':True}}),200,True,'令牌单次使用，仅存摘要；重置后撤销既有会话。')
endpoint('/bootstrap','get','getBootstrap','读取本人家庭与孩子',response=obj({'user':ref('User'),'families':arr(ref('Family'),0,10),'children':arr(ref('Child'),0,20),'contentRoles':arr(enum('editor','reviewer','publisher'),0,3)}))
endpoint('/families','post','createFamily','创建私人家庭',obj({'operationId':ID,'name':string(80),'timezone':string(100),'child':ref('AgeInput')}),ref('Family'),201,description='仅获部署引导授权的用户可创建；IANA时区校验，一次事务创建owner与首个孩子。')
endpoint('/families/{familyId}/invitations','post','createInvitation','邀请照护者',obj({'operationId':ID,'code':{'type':'string','minLength':4,'maxLength':32,'description':'可选自定义邀请码；支持中文、字母、数字、下划线或短横线，不能包含空白。'}},['operationId']),obj({'id':ID,'invitationToken':{'type':'string','minLength':4,'maxLength':4096},'expiresAt':STAMP}),201,description='仅owner；可由管理员设置4～32位邀请码，也可省略code生成高熵单次令牌。邀请码24小时失效且只能使用一次，服务端仅存摘要。邀请码应避开生日、手机号等易猜内容。')
endpoint('/invitations/accept','post','acceptInvitation','接受家庭邀请',obj({'operationId':ID,'token':string(4096)}),ref('Family'),description='先登录；锁定邀请并事务检查未使用/未过期，新增成员，不能提权成owner。')
endpoint('/invitations/redeem','post','redeemInvitation','凭邀请创建账号并加入家庭',obj({'operationId':ID,'token':string(4096),'email':{'type':'string','format':'email'},'password':{'type':'string','minLength':12,'maxLength':256},'displayName':string(60),'deviceId':ID}),obj({'user':ref('User'),'family':ref('Family'),'accessToken':nullable(string(4096)),'expiresAt':STAMP}),201,True,'无公开注册；只有有效一次性邀请可创建账号。锁定令牌并事务创建账号/成员；已有邮箱不覆盖密码，提示走登录接受邀请。限速、防重复、令牌仅存摘要。')
endpoint('/families/{familyId}/members/{userId}','delete','removeMember','移除家庭成员',obj({'operationId':ID}),description='仅owner；禁止移除最后一位owner，撤销该成员家庭访问与后续下载授权。')
endpoint('/children/{childId}','patch','updateChild','更新孩子年龄精度',obj({'operationId':ID,'baseRevision':REV,'age':ref('AgeInput')}),ref('Child'),description='months必须有ageMonths/ageAsOf且birthDate为空；birthDate模式相反。家庭成员可编辑，保留审计。')
endpoint('/children/{childId}/plans/ensure','post','ensurePlans','补足未来七天安排',obj({'operationId':ID}),obj({'days':arr(ref('DayPlan'),0,7)}),description='日期由服务端家庭时区计算；唯一约束、锁与确定性编排，保护已有修改，不接受任意儿童familyId。')
endpoint('/children/{childId}/days/{date}','get','getDayPlan','读取一天',response=nullable(ref('DayPlan')),description='无计划返回null；已撤回内容加阻断，响应包括完整快照与参与摘要。')
endpoint('/days/{dayId}/mode','put','setDayMode','切换当天预算模式',obj({'operationId':ID,'baseRevision':REV,'mode':enum('standard','lite')}),ref('DayPlan'),description='只重排未开始未记录项；保留家长锁定项。保留项导致总预算超过20时返回真实预算，不伪称20。')
endpoint('/plan-items/{itemId}/replace','post','replacePlanItem','替换一个未开始项目',obj({'operationId':ID,'baseRevision':REV,'activityId':string(60),'activityRevision':{'type':'integer','minimum':1}}),ref('PlanItem'),description='事务校验适龄、材料、发布、撤回、未开始且无记录；成功锁定家长修改。')
endpoint('/plan-items/{itemId}/start','post','startPlanItem','标记活动开始',obj({'operationId':ID,'baseRevision':REV}),ref('PlanItem'),description='不是必需打卡；拒绝未来和撤回项目，保护后台重排。')
endpoint('/plan-items/{itemId}/participation','put','putParticipation','保存共享参与摘要',ref('ParticipationWrite'),ref('Participation'),description='played需至少一名本家庭陪伴者。baseRevision=0表示首次；相同首次played可合并陪伴者和按作者备注，其余冲突409；未来不能记录。')
endpoint('/children/{childId}/sessions','post','createPlaySession','记录临时或额外一次活动',obj({'operationId':ID,'id':ID,'planItemId':nullable(ID),'localDate':DATE,'activityId':string(60),'activityRevision':{'type':'integer','minimum':1},'participantIds':arr(ID,1,20),'note':TEXT}),ref('PlaySession'),201,description='独立session不按活动ID去重；id防重复，addedBy从登录身份推导，不接受客户端伪造。')
endpoint('/families/{familyId}/changes','get','listChanges','增量同步含删除和撤回',response=obj({'changes':arr(ref('Change'),0,500),'nextCursor':string(4096),'hasMore':{'type':'boolean'}}),query={'cursor':string(4096),'limit':{'type':'integer','minimum':1,'maximum':500}},description='游标绑定家庭，过期410；包含删除墓碑与撤回；客户端完成本地事务后才推进游标。')
paths['/families/{familyId}/changes']['get']['responses']['410']={'description':'游标过期，须重新读取snapshot','content':{'application/json':{'schema':ref('Error')}}}
snapshot_fields={'cursor':string(4096),'children':arr(ref('Child'),0,20),'days':arr(ref('DayPlan'),0,1000),'memories':arr(ref('Memory'),0,10000),'measurements':arr(ref('Measurement'),0,10000),'observations':arr(ref('Observation'),0,10000),'sessions':arr(ref('PlaySession'),0,10000),'books':arr(ref('FamilyBook'),0,10000),'media':arr(ref('Media'),0,10000),'withdrawals':arr(ref('Withdrawal'),0,10000)}
endpoint('/families/{familyId}/snapshot','get','getFamilySnapshot','读取家庭一致性快照',response=obj(snapshot_fields),description='初版家庭规模快照；cursor与内容来自同一一致性读取，超过上限明确报错不得截断冒充完整快照。')
endpoint('/children/{childId}/memories','post','createMemory','添加成长小记',ref('MemoryWrite'),ref('Memory'),201,description='first须firstConfirmed=true；日期不在未来；媒体只能引用当前家庭且归属该记录。')
memoryPatch=dict(schemas['MemoryWrite']['properties']);memoryPatch.pop('id');memoryPatch['baseRevision']=REV
endpoint('/memories/{memoryId}','patch','updateMemory','修改成长小记',obj(memoryPatch),ref('Memory'))
endpoint('/memories/{memoryId}','delete','deleteMemory','删除成长小记',obj({'operationId':ID,'baseRevision':REV,'permanent':{'type':'boolean'}}),description='soft删除30天，可恢复；permanent须明确确认，异步清理媒体与导出并记录墓碑。')
measureWrite={k:v for k,v in schemas['Measurement']['properties'].items() if k not in ['childId','revision']};measureWrite['operationId']=ID
endpoint('/children/{childId}/measurements','post','createMeasurement','添加测量事实',obj(measureWrite),ref('Measurement'),201,description='height单位cm且method recumbent/standing；weight单位kg且method scale。只做结构校验，无诊断或百分位。')
measurePatch={k:v for k,v in measureWrite.items() if k!='id'};measurePatch['baseRevision']=REV
endpoint('/measurements/{measurementId}','patch','updateMeasurement','更正测量事实',obj(measurePatch),ref('Measurement'),description='保留更正审计；同样校验单位/方法/日期，图表按测量方法分别显示，不将卧位和站立数据静默连成同一曲线。')
endpoint('/measurements/{measurementId}','delete','deleteMeasurement','删除误记的测量',obj({'operationId':ID,'baseRevision':REV}),description='产生删除墓碑；同步后各设备移除该点，不改变其他日期事实。')
obsWrite={k:v for k,v in schemas['Observation']['properties'].items() if k not in ['childId','revision']};obsWrite['operationId']=ID
endpoint('/children/{childId}/observations','post','createObservation','添加阶段观察',obj(obsWrite),ref('Observation'),201,description='不计算评分，不把not_yet_observed解释为能力缺失。')
endpoint('/families/{familyId}/books','get','listFamilyBooks','读取家庭书架',response=obj({'books':arr(ref('FamilyBook'),0,1000)}))
endpoint('/families/{familyId}/books','post','createFamilyBook','登记家中书籍',obj({'operationId':ID,'title':string(100),'editionId':nullable(ID),'language':string(60),'note':TEXT}),ref('FamilyBook'),201,description='未知版本可登记；verified只能引用已核验全局版本，家长备注不能自动授予核验。')
endpoint('/family-books/{bookId}','patch','updateFamilyBook','更新家庭书架备注',obj({'operationId':ID,'baseRevision':REV,'note':TEXT}),ref('FamilyBook'))
endpoint('/content/options','get','getContentOptions','可用内容与阶段',response=obj({'activities':arr(ref('Activity'),0,500),'stageGuides':arr(ref('StageGuide'),0,30),'sources':arr(source,0,100)}),description='正式环境只返回已审核发布内容；草稿只在admin可读。来源年龄与推荐档各自明确。')
endpoint('/media/uploads','post','createMediaUpload','申请私有照片上传',obj({'operationId':ID,'memoryId':ID,'mime':enum('image/jpeg','image/png','image/webp'),'byteSize':{'type':'integer','minimum':1,'maximum':20971520},'sha256':{'type':'string','pattern':'^[a-f0-9]{64}$'}}),obj({'media':ref('Media'),'uploadUrl':{'type':'string','format':'uri'},'expiresAt':STAMP}),201,description='当前家庭记录归属、配额、真实类型均校验；签名URL只允许指定对象和大小，返回pending不是ready。')
endpoint('/media/{mediaId}/complete','post','completeMediaUpload','校验已传照片并异步处理',obj({'operationId':ID}),ref('Media'),202,description='服务端检查大小/摘要/MIME/解码，再去EXIF并生成缩略图；成功前state=processing，失败不丢正文。')
endpoint('/media/{mediaId}','get','getMedia','读取媒体状态与限时查看链接',response=ref('Media'),description='每次按当前家庭成员关系验证；ready才提供短时下载链接，不公开对象路径。')
endpoint('/families/{familyId}/exports','post','createExport','申请导出家庭数据',obj({'operationId':ID,'from':DATE,'to':DATE,'types':arr(enum('memories','measurements','sessions','plans'),1,4),'includeMedia':{'type':'boolean'}}),ref('Export'),202,description='仅owner，起止日期校验，下载15分钟有效；包含遗漏媒体清单，不静默省略。')
endpoint('/exports/{exportId}','get','getExport','查看导出并获取短期下载',response=ref('Export'),description='每次重新校验当前家庭owner权限，不能复用离开家庭前的导出授权。')
endpoint('/families/{familyId}','delete','deleteFamily','申请永久删除家庭',obj({'operationId':ID,'confirmFamilyName':string(80),'reauthToken':string(4096)}),obj({'jobId':ID,'state':{'const':'queued'}}),202,description='仅owner且近期重新验证身份。立即冻结访问与新签名，异步删除数据库/媒体/导出；保留去标识删除墓碑。备份最多30天，恢复重放删除。')
endpoint('/admin/activities/{activityId}/revisions','post','createContentRevision','保存新活动修订草稿',obj({'operationId':ID,'baseRevision':REV,'activity':ref('Activity'),'changeNote':TEXT}),ref('ContentRevision'),201,description='仅editor；修改已通过内容必须生成新草稿并清审核，不能修改不可变已发布正文。')
endpoint('/admin/revisions/{revisionId}/submit','post','submitRevision','送审固定草稿',obj({'operationId':ID,'baseRevision':REV}),ref('ContentRevision'),description='仅editor；先验证schema、跨引用、材料/来源必填，状态进入in_review。')
endpoint('/admin/revisions/{revisionId}/review','post','reviewRevision','通过或退回审核',obj({'operationId':ID,'baseRevision':REV,'decision':enum('approve','reject'),'checks':arr(enum('sources','age_safety','language','rights'),0,4),'note':TEXT,'selfReviewed':{'type':'boolean'}}),ref('ContentRevision'),description='仅reviewer；通过须四项均完成，退回须原因；自审记录明确标记，公开发布要求独立审阅。')
endpoint('/admin/releases','post','publishRelease','发布已通过的不可变修订集合',obj({'operationId':ID,'revisionIds':arr(ID,1,500),'environment':enum('private_trial','public')}),ref('Release'),201,description='仅publisher；事务检查所有修订仍通过；失败不切活跃版本。public禁止自审。家庭试用仍要求内容审读和试玩证据。')
endpoint('/admin/releases/{releaseId}/withdraw','post','withdrawRelease','撤回版本并记录影响',obj({'operationId':ID,'kind':enum('editorial','safety'),'reason':string(1000)}),ref('Release'),description='仅publisher；安全撤回优先于家长锁定，发布撤回change事件；保留历史和审计。离线设备无法即时获知，联网先同步撤回。')
api={'openapi':'3.1.0','info':{'title':'BabyPlan v2 多成员陪伴设计合同','version':'2.0.0-design','description':'仅设计，未实现/部署。此合同替代新开发的一日一卡/v1行为。家庭数据与内容管理权限隔离。'},'servers':[{'url':'https://example.invalid/v2','description':'占位地址，不可调用'}],'security':security,'paths':paths,'components':{'securitySchemes':{'bearerSession':{'type':'http','scheme':'bearer'},'cookieSession':{'type':'apiKey','in':'cookie','name':'bp_session'}},'schemas':schemas}}
api['components']['securitySchemes'].update({'refreshCookie':{'type':'apiKey','in':'cookie','name':'bp_refresh'},'refreshHeader':{'type':'apiKey','in':'header','name':'X-Refresh-Token'}})
paths['/sessions/refresh']['post']['security']=[{'refreshCookie':[]},{'refreshHeader':[]}]
endpoint('/sessions/reauth','post','reauthenticateSession','为删除等敏感操作重新验证身份',obj({'password':{'type':'string','minLength':1,'maxLength':256}}),obj({'reauthToken':string(4096),'expiresAt':STAMP}),description='限速；短期凭据绑定本人、设备与敏感操作范围，5分钟有效，成功后单次消费。')
extend_api(api)
(OUT/'openapi.yaml').write_text(yaml.safe_dump(api,allow_unicode=True,sort_keys=False,width=110),encoding='utf-8')
(OUT/'openapi.json').write_text(json.dumps(api,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
tokens={'version':'2.0.0-design','status':'design_decision_not_brand_approval','colors':{'light':{'background':'#F7F5EF','surface':'#FFFEFA','text':'#28392E','textSecondary':'#606B60','primary':'#435B43','onPrimary':'#FFFFFF','accent':'#9B4B32','outline':'#7D8779'},'dark':{'background':'#181E19','surface':'#242D26','text':'#F1F3EB','textSecondary':'#B9C4B6','primary':'#C0D3AF','onPrimary':'#203321','accent':'#F0B599','outline':'#8E9E87'}},'typography':{'body':{'size':16,'lineHeight':1.65},'secondary':{'size':14,'lineHeight':1.6},'title':{'size':30,'lineHeight':1.4}},'spacing':[4,8,12,16,24,32,48],'radius':{'card':20,'button':14,'dialog':24},'minimumTouchTarget':48,'motionMs':150,'reducedMotionMs':0}
(ROOT/'docs/v2/design-tokens.json').write_text(json.dumps(tokens,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(f'Wrote content schema, {len(schemas)} API schemas, {sum(len(v) for v in paths.values())} operations, and tokens.')
