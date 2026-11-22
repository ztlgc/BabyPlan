"""v2.1 实施合同：由唯一生成入口调用，不向真实服务写数据。"""
from copy import deepcopy


def obj(properties, required=None):
    return {'type': 'object', 'additionalProperties': False, 'properties': properties,
            'required': list(properties) if required is None else required}


def string(max_length=200):
    return {'type': 'string', 'minLength': 1, 'maxLength': max_length}


def enum(*values):
    return {'type': 'string', 'enum': list(values)}


def array(items, minimum=0, maximum=100, unique=False):
    result = {'type': 'array', 'items': items, 'minItems': minimum, 'maxItems': maximum}
    if unique:
        result['uniqueItems'] = True
    return result


def ref(name):
    return {'$ref': f'#/components/schemas/{name}'}


def nullable(schema):
    return {'anyOf': [schema, {'type': 'null'}]}


ID = {'type': 'string', 'format': 'uuid'}
STAMP = {'type': 'string', 'format': 'date-time'}
DATE = {'type': 'string', 'format': 'date'}
REV = {'type': 'integer', 'minimum': 0}
HASH = {'type': 'string', 'pattern': '^[a-f0-9]{64}$'}
TEXT = {'type': 'string', 'maxLength': 2000}
CHECKS = array(enum('sources', 'age_safety', 'language', 'rights'), 4, 4, True)


def extend_package(package):
    package['title'] = 'BabyPlan v2 内容包：候选、私人试用与公开发布'
    package['properties'].update({
        'publicationEnvironment': enum('private_trial', 'public'),
        'evidenceRefs': array(string(100), 1, 3000, True),
    })
    release_properties = {
        'review': {'properties': {'editorial': {'const': 'approved'}}},
        'cards': {'items': {'properties': {'reviewState': {'const': 'reviewed'}}}},
    }
    package['allOf'] = [
        {'if': {'properties': {'channel': {'const': 'release'}}, 'required': ['channel']},
         'then': {'required': ['publicationEnvironment', 'evidenceRefs'], 'properties': release_properties}},
        {'if': {'properties': {'channel': {'const': 'release'}, 'publicationEnvironment': {'const': 'public'}},
                'required': ['channel', 'publicationEnvironment']},
         'then': {'properties': {'review': {'properties': {'familyTrial': {'const': 'completed'}}}}}},
    ]
    package['description'] = ('Schema只验证结构；发布端必须核对可信证据注册表、具体正文hash和真实审读者。'
                              '私人试用允许如实自审，不要求开始试玩前已经完成试玩。声明专业审阅或试玩完成必须有证据。')
    for key in ['ageBands', 'sources', 'cards', 'stageGuides', 'books']:
        package['properties'][key]['uniqueItems'] = True
    return package


def evidence_schema():
    base = {
        'id': string(100), 'kind': enum('editorial_review', 'expert_review', 'family_trial', 'rights_license'),
        'cardId': string(60), 'revision': {'type': 'integer', 'minimum': 1}, 'contentHash': HASH,
        'actorId': string(100), 'actorKind': {'const': 'human'}, 'createdAt': STAMP,
        'decision': enum('approved', 'rejected'), 'evidenceRef': string(1000),
        'authorId': string(100), 'selfReviewed': {'type': 'boolean'}, 'checks': CHECKS,
        'qualificationRef': string(1000), 'completedAt': STAMP,
        'authorizationRef': string(1000), 'scope': string(1000),
        'allowedEnvironments': array(enum('private_trial', 'public'), 1, 2, True),
    }
    record = obj(base, ['id', 'kind', 'cardId', 'revision', 'contentHash', 'actorId', 'actorKind',
                        'createdAt', 'decision', 'evidenceRef'])
    record['allOf'] = [
        {'if': {'properties': {'kind': {'const': kind}}}, 'then': {'required': fields}}
        for kind, fields in [
            ('editorial_review', ['authorId', 'selfReviewed', 'checks']),
            ('expert_review', ['authorId', 'selfReviewed', 'qualificationRef']),
            ('family_trial', ['completedAt']),
            ('rights_license', ['authorizationRef', 'scope', 'allowedEnvironments']),
        ]
    ]
    result = obj({'schemaVersion': {'const': 1}, 'records': array(record, 0, 10000)})
    result.update({'$schema': 'https://json-schema.org/draft/2020-12/schema',
                   '$id': 'urn:babyplan:review-evidence:1', 'title': 'BabyPlan 内容审读证据注册表',
                   'description': '只能由可信审核流程提供。JSON结构无法证明真人身份或实际审读；服务端必须核对身份、权限和原始证据。'})
    return result


def extend_api(api):
    schemas, paths = api['components']['schemas'], api['paths']
    api['info'].update({'title': 'BabyPlan v2 多成员陪伴实施合同', 'version': '2.2.0',
                        'description': '实施合同。各端以此为准；接口列入合同不表示已经实现。家庭与内容权限隔离。'})
    api['servers'] = [{'url': 'http://127.0.0.1:4318/v2', 'description': '本地开发目标；服务运行状态另验收'}]
    default_errors = deepcopy(paths['/sessions']['post']['responses'])
    default_errors.pop('200', None)
    for status, message in [(410, '游标或快照过期'), (413, '媒体或请求过大'), (422, '业务或内容校验失败')]:
        default_errors[str(status)] = {'description': message, 'content': {'application/json': {'schema': ref('Error')}}}

    def response(schema, description='成功'):
        return {'description': description, 'content': {'application/json': {'schema': schema}}}

    def add(path, method, operation_id, summary, body=None, result=None, status=200, query=None, description=None):
        import re
        params = [{'name': name, 'in': 'path', 'required': True,
                   'schema': string(60) if name == 'activityId' else ID}
                  for name in re.findall(r'\{(\w+)\}', path)]
        params += [{'name': name, 'in': 'query', 'required': False, 'schema': value}
                   for name, value in (query or {}).items()]
        item = {'operationId': operation_id, 'summary': summary, 'description': description or summary,
                'security': deepcopy(api['security']),
                'responses': {str(status): response(result or ref('Ack')), **deepcopy(default_errors)}}
        if params:
            item['parameters'] = params
        if body is not None:
            item['requestBody'] = {'required': True, 'content': {'application/json': {'schema': body}}}
        paths.setdefault(path, {})[method] = item
        return item

    schemas['SessionResponse'] = obj({
        'user': ref('User'), 'sessionId': ID, 'accessToken': nullable(string(4096)),
        'refreshToken': nullable(string(4096)), 'expiresAt': STAMP, 'refreshExpiresAt': STAMP,
        'csrfToken': nullable(string(256)),
    })
    schemas['SessionResponse']['description'] = (
        'mobile返回两种令牌且csrfToken=null；web令牌字段均null，令牌只通过HttpOnly Cookie交付。'
        '访问15分钟、刷新30天。刷新每次轮转，旧令牌复用撤销同一会话令牌家族。')
    for path, method, code in [('/sessions', 'post', '200'), ('/sessions/refresh', 'post', '200'),
                               ('/invitations/redeem', 'post', '201')]:
        endpoint = paths[path][method]
        schema = endpoint['requestBody']['content']['application/json']['schema']
        schema['properties']['clientType'] = enum('mobile', 'web')
        schema['required'].append('clientType')
        result = deepcopy(schemas['SessionResponse'])
        if path == '/invitations/redeem':
            result['properties']['family'] = ref('Family')
            result['required'].append('family')
        endpoint['responses'][code] = response(result if path == '/invitations/redeem' else ref('SessionResponse'))
    paths['/sessions']['post']['description'] = ('客户端显式选择mobile/web；密码使用Argon2id散列。mobile不设置Cookie。'
        'web检查同源Origin，设置bp_session/bp_refresh，Path=/v2、HttpOnly、SameSite=Strict；Secure属性跟随PUBLIC_BASE_URL使用的HTTP或HTTPS协议。'
        'HTTP仅限可信局域网。限速且不记录密码/令牌。')
    paths['/sessions/refresh']['post']['description'] = ('mobile须X-Refresh-Token，web须刷新Cookie且Origin与X-CSRF-Token正确。'
        '绑定deviceId和clientType；同一会话串行轮转。响应交付新令牌，旧令牌复用撤销整条会话家族。')
    paths['/sessions/current']['delete']['responses']['200'] = response(obj({'accepted': {'const': True}}))
    add('/sessions/csrf', 'get', 'getSessionCsrf', '读取当前Web会话CSRF令牌', result=obj({'csrfToken': string(256)}),
        description='仅同源Web会话读取；令牌绑定会话，写请求用X-CSRF-Token；CORS不允许任意带凭证来源。')

    schemas['Member']['properties'].update({'displayName': nullable(string(60)), 'familyId': ID, 'revision': REV})
    schemas['Member']['required'] += ['displayName', 'familyId', 'revision']
    schemas['Family']['properties']['revision'] = REV
    schemas['Family']['required'].append('revision')
    schemas['FamilyPreferences'] = obj({'familyId': ID, 'availableMaterials': array(string(150), 0, 200, True),
        'excludedMaterials': array(string(150), 0, 200, True), 'languageMode': enum('zh', 'zh_with_english'),
        'revision': REV})
    schemas['ReminderPreference'] = obj({'userId': ID, 'deviceId': nullable(ID), 'enabled': {'type': 'boolean'},
        'localTime': {'type': 'string', 'pattern': '^([01][0-9]|2[0-3]):[0-5][0-9]$'}, 'revision': REV})
    schemas['ConflictDetails'] = obj({'entity': string(60), 'id': ID, 'currentRevision': REV,
        'current': {'type': ['object', 'null'], 'additionalProperties': True},
        'submitted': {'type': ['object', 'null'], 'additionalProperties': True},
        'allowedActions': array(enum('reload', 'merge', 'keep_local', 'keep_remote', 'save_copy'), 1, 5, True)})
    schemas['Error']['properties']['details'] = {'oneOf': [ref('ConflictDetails'), {'type': 'object', 'not': {'required': ['currentRevision']}, 'additionalProperties': True}]}
    schemas['PlanItem']['properties']['visibility'] = enum('active', 'hidden')
    schemas['PlanItem']['properties']['withdrawalReason'] = string(1000)
    schemas['PlanItem']['required'].append('visibility')
    schemas['DayPlan']['properties']['effectiveBudgetMinutes'] = {'type': 'integer', 'minimum': 0, 'maximum': 720}
    schemas['DayPlan']['required'].append('effectiveBudgetMinutes')
    extra_changes = ['family', 'member', 'child', 'family_preferences', 'plan_item']
    schemas['Change']['properties']['entity']['enum'] += extra_changes
    schemas['Change']['properties']['payload']['anyOf'][0]['oneOf'] += [ref(n) for n in ['Family', 'Member', 'Child', 'FamilyPreferences', 'PlanItem']]
    # Family clocks are transactionally allocated; cursors are opaque and family scoped.
    paths['/families/{familyId}/changes']['get']['description'] = (
        '每家庭写事务锁定family_clocks后分配序号，提交前不允许后续家庭写越过；禁止裸sequence造成提交乱序漏事件。'
        '游标绑定家庭；空游标从当前可读取的最早水位开始；失效410；含成员/年龄/删除。'
        '已撤回的计划正文会遮挡，最新撤回清单随内容选项和快照返回，客户端在显示或上传前先核对。')
    snapshot = paths['/families/{familyId}/snapshot']['get']['responses']['200']['content']['application/json']['schema']
    snapshot['properties'].update({'family': ref('Family'), 'preferences': ref('FamilyPreferences'),
        'snapshotId': ID, 'nextPageToken': nullable(string(4096)), 'hasMore': {'type': 'boolean'}, 'expiresAt': STAMP})
    snapshot['required'] += ['family', 'preferences', 'snapshotId', 'nextPageToken', 'hasMore', 'expiresAt']
    paths['/families/{familyId}/snapshot']['get']['parameters'] += [
        {'name': 'pageToken', 'in': 'query', 'required': False, 'schema': string(4096)},
        {'name': 'limit', 'in': 'query', 'required': False, 'schema': {'type': 'integer', 'minimum': 1, 'maximum': 500}},
    ]
    paths['/families/{familyId}/snapshot']['get']['description'] = (
        '首次在一致性事务中建立家庭快照并绑定cursor，服务端保留不可变快照页30分钟；后续页使用不透明pageToken。'
        '过期、容量回收或内容撤回/数据删除后返回410 SNAPSHOT_EXPIRED，从第一页重来。'
        'limit（默认100）限制每页列表记录总数；每页重复family/preferences及同一cursor；'
        '只有所有页在客户端暂存完成后才原子替换已同步事实并推进cursor，待传/冲突草稿保留。权限每页重验。')
    add('/families/{familyId}/preferences', 'get', 'getFamilyPreferences', '读取家庭资源与语言偏好', result=ref('FamilyPreferences'))
    prefs = deepcopy(schemas['FamilyPreferences']['properties']); prefs.pop('familyId'); prefs.pop('revision')
    prefs.update({'operationId': ID, 'baseRevision': REV})
    add('/families/{familyId}/preferences', 'put', 'putFamilyPreferences', '更新家庭资源与语言偏好', obj(prefs), ref('FamilyPreferences'),
        description='默认材料列表为空（未知，不代表已拥有），languageMode=zh_with_english；偏好变更不覆盖已开展或锁定项目。')
    add('/users/me/reminder', 'get', 'getReminderPreference', '读取本人指定提醒设备', result=ref('ReminderPreference'))
    add('/users/me/reminder', 'put', 'putReminderPreference', '选择本人提醒设备与时刻',
        obj({'operationId': ID, 'baseRevision': REV, 'deviceId': nullable(ID), 'enabled': {'type': 'boolean'},
             'localTime': {'type': 'string', 'pattern': '^[01][0-9]:[0-5][0-9]$'}}), ref('ReminderPreference'),
        description='deviceId必须属于本人活跃会话；默认关闭，建议16:00；禁用时可清空设备。客户端恢复前台先刷新资格，旧设备离线不能即时获知切换；权限由Android系统决定。')
    add('/plan-items/{itemId}/participation', 'delete', 'deleteParticipation', '撤销共享参与摘要',
        obj({'operationId': ID, 'baseRevision': REV}), description='修订必须匹配；产生participation墓碑，不撤销独立session，不吞另一家长更新；保留计划开始状态。')
    add('/plan-items/{itemId}/protection', 'put', 'setPlanItemProtection', '调整项目开始与保留状态',
        obj({'operationId': ID, 'baseRevision': REV, 'lockedByParent': {'type': 'boolean'}, 'clearStarted': {'type': 'boolean'}}), ref('PlanItem'),
        description='浏览详情不标记开始；明确开始动作才保护。已有参与或独立session时不得清started；安全撤回优先于保留。')

    paging = {'cursor': string(4096), 'limit': {'type': 'integer', 'minimum': 1, 'maximum': 100}, 'from': DATE, 'to': DATE}
    add('/children/{childId}/memories', 'get', 'listMemories', '分页查询成长历史', result=obj({'items': array(ref('Memory'), 0, 100), 'nextCursor': nullable(string(4096))}), query={**paging, 'type': enum('quote', 'story', 'first'), 'deleted': {'type': 'boolean'}})
    add('/memories/{memoryId}/restore', 'post', 'restoreMemory', '恢复回收期内成长记录', obj({'operationId': ID, 'baseRevision': REV}), ref('Memory'), description='仅软删30天内可恢复；重新验证家庭范围和修订；永久删除不可恢复。')
    recycle_query = {**paging, 'deleted': {'type': 'boolean'}}
    add('/children/{childId}/measurements', 'get', 'listMeasurements', '分页读取测量事实', result=obj({'items': array(ref('Measurement'), 0, 100), 'nextCursor': nullable(string(4096))}), query=recycle_query)
    add('/measurements/{measurementId}/restore', 'post', 'restoreMeasurement', '恢复回收期内测量事实', obj({'operationId': ID, 'baseRevision': REV}), ref('Measurement'), description='仅软删30天内可恢复；重新验证家庭范围和修订；跨家庭返回404。')
    add('/children/{childId}/observations', 'get', 'listObservations', '分页读取阶段观察', result=obj({'items': array(ref('Observation'), 0, 100), 'nextCursor': nullable(string(4096))}), query=recycle_query)
    observation_patch = deepcopy(schemas['Observation']['properties']); observation_patch.pop('id'); observation_patch.pop('childId'); observation_patch.pop('revision'); observation_patch.update({'operationId': ID, 'baseRevision': REV})
    add('/observations/{observationId}', 'patch', 'updateObservation', '更正阶段观察', obj(observation_patch), ref('Observation'))
    add('/observations/{observationId}', 'delete', 'deleteObservation', '删除误记的阶段观察', obj({'operationId': ID, 'baseRevision': REV}))
    add('/observations/{observationId}/restore', 'post', 'restoreObservation', '恢复回收期内阶段观察', obj({'operationId': ID, 'baseRevision': REV}), ref('Observation'), description='仅软删30天内可恢复；重新验证家庭范围和修订；跨家庭返回404。')
    add('/family-books/{bookId}', 'delete', 'deleteFamilyBook', '移除家庭书架条目', obj({'operationId': ID, 'baseRevision': REV}))
    add('/media/{mediaId}', 'delete', 'deleteMedia', '移除照片并排入私有对象清理', obj({'operationId': ID}))
    schemas['Job'] = obj({'id': ID, 'type': enum('family_delete', 'media_delete', 'export'), 'state': enum('queued', 'running', 'ready', 'failed'), 'errorCode': nullable(string(80))})
    add('/jobs/{jobId}', 'get', 'getJob', '查询本人发起的后台任务状态', result=ref('Job'), description='校验任务发起者和适用家庭权限；家庭冻结后仅删除任务发起者可读取该删除任务，不开放家庭资料。')
    admin_query = {'cursor': string(4096), 'limit': {'type': 'integer', 'minimum': 1, 'maximum': 100}, 'status': enum('draft', 'in_review', 'approved', 'published', 'withdrawn')}
    add('/admin/revisions', 'get', 'listContentRevisions', '查询内容修订与审核队列', result=obj({'items': array(ref('ContentRevision'), 0, 100), 'nextCursor': nullable(string(4096))}), query=admin_query)
    add('/admin/revisions/{revisionId}', 'get', 'getContentRevision', '读取固定内容修订', result=ref('ContentRevision'))
    schemas['ContentRevision']['properties'].update({'contentHash': HASH, 'authorId': ID, 'evidenceRefs': array(string(100), 0, 100, True)})
    schemas['ContentRevision']['required'] += ['contentHash', 'authorId', 'evidenceRefs']
    options = paths['/content/options']['get']['responses']['200']['content']['application/json']['schema']
    options['properties']['withdrawals'] = array(ref('Withdrawal'), 0, 10000)
    options['required'].append('withdrawals')
    add('/admin/sources', 'get', 'listContentSources', '读取审读来源', result=obj({'sources': deepcopy(options['properties']['sources'])}))
    add('/admin/releases', 'get', 'listContentReleases', '读取发布历史', result=obj({'items': array(ref('Release'), 0, 100), 'nextCursor': nullable(string(4096))}), query={'cursor': string(4096), 'limit': {'type': 'integer', 'minimum': 1, 'maximum': 100}})
    add('/admin/releases/{releaseId}', 'get', 'getContentRelease', '读取固定发布版本', result=ref('Release'))
    schemas['Release']['properties'].update({'environment': enum('private_trial', 'public'), 'active': {'type': 'boolean'}, 'evidenceRefs': array(string(100), 1, 3000, True)})
    schemas['Release']['required'] += ['environment', 'active', 'evidenceRefs']
    review_body = paths['/admin/revisions/{revisionId}/review']['post']['requestBody']['content']['application/json']['schema']
    review_body['properties']['checks']['uniqueItems'] = True
    review_body['properties']['evidenceRefs'] = array(string(100), 0, 100, True)
    review_body['required'].append('evidenceRefs')
    paths['/admin/revisions/{revisionId}/review']['post']['description'] = ('服务端根据实际审核者与作者计算selfReviewed；客户端值只能作一致性断言。批准须四项不同检查齐全与可信证据绑定正文hash；修改正文使证据失效。')
    publish = paths['/admin/releases']['post']
    publish['requestBody']['content']['application/json']['schema']['properties']['evidenceRefs'] = array(string(100), 1, 3000, True)
    publish['requestBody']['content']['application/json']['schema']['required'].append('evidenceRefs')
    publish['description'] = ('事务核对固定修订、真实审读身份和证据；private_trial允许自审且不要求事先完成试玩；public需独立审阅与试玩完成。专业审阅状态如实。失败不切换活跃版本。')
    schemas['ReviewEvidence'] = evidence_schema()['properties']['records']['items']
    add('/admin/evidence', 'post', 'createReviewEvidence', '登记真实内容审读证据', obj({'operationId': ID, 'record': ref('ReviewEvidence')}), ref('ReviewEvidence'), 201,
        description='仅reviewer；actorId必须是当前实际审读身份，服务端绑定作者/hash并核对原始证据引用，不接受伪造他人或AI自称human的自动批准。')
    add('/admin/evidence/{evidenceId}', 'get', 'getReviewEvidence', '读取固定审读证据', result=ref('ReviewEvidence'))
    # 证据ID允许有意义的非UUID标识，和包级evidenceRefs保持一致。
    paths['/admin/evidence/{evidenceId}']['get']['parameters'][0]['schema'] = string(100)
    for path, methods in paths.items():
        for method, endpoint in methods.items():
            if method in ['post', 'put', 'patch', 'delete'] and endpoint.get('security'):
                endpoint.setdefault('parameters', []).append({'name': 'X-CSRF-Token', 'in': 'header', 'required': False,
                    'schema': string(256), 'description': '使用Web Cookie时必填且须同源；Bearer手机请求不需要。'})
            endpoint.setdefault('responses', {}).update({k: deepcopy(v) for k, v in default_errors.items() if k not in endpoint['responses']})
    return api
