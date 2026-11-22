import 'dart:async';
import 'dart:convert';

import 'package:babyplan/data/api_client.dart';
import 'package:babyplan/domain/demo_content.dart';
import 'package:babyplan/domain/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import '../support/test_support.dart';

void main() {
  setUpAll(initializeTestTimezones);

  test('旧快照中途失效时完整重读，不混入已删除内容', () async {
    final snapshots = [
      {
        ..._snapshotPage(),
        'snapshotId': 'before',
        'cursor': '1',
        'memories': [
          {'id': 'old'},
        ],
        'books': [
          {'id': 'old-book', 'familyId': testFamilyId},
        ],
        'hasMore': true,
        'nextPageToken': 'expired-page',
      },
      {'code': 'SNAPSHOT_EXPIRED'},
      {
        ..._snapshotPage(),
        'snapshotId': 'after',
        'cursor': '2',
        'memories': [
          {'id': 'keep', 'childId': testChildId},
        ],
        'children': [
          {'id': testChildId, 'familyId': testFamilyId},
        ],
        'days': [testPlan().json],
        'sessions': [
          {'id': 'play-session', 'childId': testChildId},
        ],
        'hasMore': true,
        'nextPageToken': 'new-page',
      },
      {
        ..._snapshotPage(),
        'snapshotId': 'after',
        'cursor': '2',
        'measurements': [
          {'id': 'value', 'childId': testChildId},
        ],
        'books': [
          {'id': 'new-book', 'familyId': testFamilyId},
        ],
        'media': [
          {'id': 'photo', 'memoryId': 'keep'},
        ],
        'withdrawals': [
          {'id': 'withdrawn-activity', 'activityId': 'activity-test'},
        ],
        'hasMore': false,
        'nextPageToken': null,
      },
    ];
    final requestedPages = <String?>[];
    final client = MockClient((request) async {
      expect(request.url.path, '/v2/families/$testFamilyId/snapshot');
      requestedPages.add(request.url.queryParameters['pageToken']);
      return _response(
        snapshots[requestedPages.length - 1],
        requestedPages.length == 2 ? 410 : 200,
      );
    });
    addTearDown(client.close);
    final api = BabyPlanApi(
      baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
      vault: MemoryTokenVault()..session = sampleSession(),
      client: client,
    );
    final snapshot = await api.readFamilySnapshot(testFamilyId);
    expect(requestedPages, [null, 'expired-page', null, 'new-page']);
    expect(snapshot.cursor, '2');
    expect(snapshot.memories.map((row) => row['id']), ['keep']);
    expect(snapshot.measurements.map((row) => row['id']), ['value']);
    expect(snapshot.children.single['id'], testChildId);
    expect(snapshot.days.single['id'], testPlan().id);
    expect(snapshot.sessions.single['id'], 'play-session');
    expect(snapshot.books.single['id'], 'new-book');
    expect(snapshot.media.single['id'], 'photo');
    expect(snapshot.withdrawals.single['id'], 'withdrawn-activity');
    expect(snapshot.family?['id'], testFamilyId);
    expect(snapshot.preferences?['familyId'], testFamilyId);
  });

  test('快照中途混入其他水位时整份拒绝，不按已完成处理', () async {
    var requests = 0;
    final api = _syncApi((request) async {
      requests++;
      if (requests == 1) {
        return _response({
          ..._snapshotPage(),
          'memories': [
            {'id': 'first-page-memory', 'childId': testChildId},
          ],
          'hasMore': true,
          'nextPageToken': 'page-2',
        });
      }
      expect(request.url.queryParameters['pageToken'], 'page-2');
      return _response({..._snapshotPage(), 'cursor': 'other-cursor'});
    });
    await expectLater(
      api.readFamilySnapshot(testFamilyId),
      throwsA(isA<ApiException>()),
    );
    expect(requests, 2);
  });

  test('快照缺少书架集合时拒绝读取，避免误删本机已有书籍', () async {
    final api = _syncApi(
      (_) async => _response(_snapshotPage()..remove('books')),
    );
    await expectLater(
      api.readFamilySnapshot(testFamilyId),
      throwsA(isA<ApiException>()),
    );
  });

  test('快照拒绝不属于已读取孩子的记录以及孤立照片', () async {
    final responses = [
      {
        ..._snapshotPage(),
        'measurements': [
          {'id': 'measurement', 'childId': 'other-child'},
        ],
      },
      {
        ..._snapshotPage(),
        'media': [
          {'id': 'photo', 'memoryId': 'missing-memory'},
        ],
      },
    ];
    final api = _syncApi((_) async => _response(responses.removeAt(0)));
    for (var index = 0; index < 2; index++) {
      await expectLater(
        api.readFamilySnapshot(testFamilyId),
        throwsA(isA<ApiException>()),
      );
    }
  });

  test('完整快照重试一次仍返回过期时保留服务端错误', () async {
    var requests = 0;
    final api = _syncApi((request) async {
      expect(request.url.queryParameters['pageToken'], isNull);
      requests++;
      return _response({'code': 'SNAPSHOT_EXPIRED'}, 410);
    });
    await expectLater(
      api.readFamilySnapshot(testFamilyId),
      throwsA(
        isA<ApiException>()
            .having((error) => error.statusCode, 'statusCode', 410)
            .having((error) => error.code, 'code', 'SNAPSHOT_EXPIRED'),
      ),
    );
    expect(requests, 2);
  });

  test('变更分页保留原游标、非连续序号与独立参与墓碑', () async {
    const cursor = 'last+/=游标';
    const nextCursor = 'next&cursor';
    var requests = 0;
    final api = _syncApi((request) async {
      expect(request.method, 'GET');
      expect(request.url.path, '/v2/families/$testFamilyId/changes');
      expect(request.headers['authorization'], 'Bearer access-test-token');
      if (requests++ == 0) {
        expect(request.url.queryParameters, {'cursor': cursor, 'limit': '7'});
        return _response({
          'changes': [
            _change(12, 'memory', 'memory-12', {
              'id': 'memory-12',
              'childId': testChildId,
              'revision': 2,
            }),
            _change(15, 'participation', 'participation-15', null),
            _change(17, 'media', 'photo-17', {
              'id': 'photo-17',
              'memoryId': 'memory-12',
              'state': 'failed',
              'errorCode': 'MEDIA_INVALID',
            }),
            _change(22, 'family_preferences', testFamilyId, {
              'familyId': testFamilyId,
              'revision': 2,
            }),
          ],
          'nextCursor': nextCursor,
          'hasMore': true,
        });
      }
      expect(request.url.queryParameters, {
        'cursor': nextCursor,
        'limit': '100',
      });
      return _response({
        'changes': <Json>[],
        'nextCursor': nextCursor,
        'hasMore': false,
      });
    });

    final page = await api.readFamilyChanges(
      testFamilyId,
      cursor: cursor,
      limit: 7,
    );
    expect(page.changes.map((change) => change.sequence), [12, 15, 17, 22]);
    expect(page.changes[1].entity, 'participation');
    expect(page.changes[1].id, 'participation-15');
    expect(page.changes[1].deleted, isTrue);
    expect(page.changes[1].payload, isNull);
    expect(page.changes[2].payload?['errorCode'], 'MEDIA_INVALID');
    expect(page.nextCursor, nextCursor);
    expect(page.hasMore, isTrue);

    final end = await api.readFamilyChanges(
      testFamilyId,
      cursor: page.nextCursor,
    );
    expect(end.changes, isEmpty);
    expect(end.nextCursor, page.nextCursor);
    expect(end.hasMore, isFalse);
  });

  for (final (description, page) in <(String, Json)>[
    (
      '空页声称还有更多',
      {'changes': <Json>[], 'nextCursor': 'cursor', 'hasMore': true},
    ),
    ('空页推进了游标', {'changes': <Json>[], 'nextCursor': 'next', 'hasMore': false}),
    (
      '有变更却未推进游标',
      {
        'changes': [_change(2, 'memory', 'memory-2', null)],
        'nextCursor': 'cursor',
        'hasMore': false,
      },
    ),
    (
      '变更序号回退',
      {
        'changes': [
          _change(3, 'memory', 'memory-3', null),
          _change(2, 'memory', 'memory-2', null),
        ],
        'nextCursor': 'next',
        'hasMore': false,
      },
    ),
    (
      '删除墓碑缺少显式空值',
      {
        'changes': [_change(2, 'memory', 'memory-2', null)..remove('payload')],
        'nextCursor': 'next',
        'hasMore': false,
      },
    ),
    (
      '外层对象与正文不一致',
      {
        'changes': [
          _change(2, 'memory', 'memory-2', {'id': 'memory-3', 'revision': 2}),
        ],
        'nextCursor': 'next',
        'hasMore': false,
      },
    ),
    (
      '孩子属于别的家庭',
      {
        'changes': [
          _change(2, 'child', testChildId, {
            'id': testChildId,
            'familyId': 'other-family',
            'revision': 2,
          }),
        ],
        'nextCursor': 'next',
        'hasMore': false,
      },
    ),
  ]) {
    test('拒绝不一致的变更页：$description', () async {
      final api = _syncApi((_) async => _response(page));
      await expectLater(
        api.readFamilyChanges(testFamilyId, cursor: 'cursor'),
        throwsA(isA<ApiException>()),
      );
    });
  }

  test('变更游标过期保留 410，供同步流程重建快照', () async {
    final api = _syncApi((request) async {
      expect(request.url.path, '/v2/families/$testFamilyId/changes');
      return _response({'code': 'CURSOR_EXPIRED'}, 410);
    });
    await expectLater(
      api.readFamilyChanges(testFamilyId, cursor: 'old'),
      throwsA(
        isA<ApiException>()
            .having((error) => error.statusCode, 'statusCode', 410)
            .having((error) => error.code, 'code', 'CURSOR_EXPIRED'),
      ),
    );
  });

  test('并发和晚到的 401 都只刷新一次，不重用已经轮换的令牌', () async {
    final current = sampleSession();
    final vault = MemoryTokenVault()..session = current;
    final refreshSent = Completer<void>();
    final refreshResponse = Completer<http.Response>();
    final secondRejected = Completer<void>();
    final lateRequest = Completer<void>();
    final lateRejection = Completer<http.Response>();
    var oldRequests = 0;
    var rotations = 0;
    var replays = 0;
    final api = _syncApi((request) async {
      if (request.url.path.endsWith('/sessions/refresh')) {
        rotations++;
        expect(request.headers['x-refresh-token'], current.refreshToken);
        expect(rotations, 1);
        refreshSent.complete();
        return refreshResponse.future;
      }
      if (request.headers['authorization'] == 'Bearer ${current.accessToken}') {
        oldRequests++;
        if (oldRequests == 2) secondRejected.complete();
        if (oldRequests == 3) {
          lateRequest.complete();
          return lateRejection.future;
        }
        return _response({'code': 'INVALID_SESSION'}, 401);
      }
      expect(request.headers['authorization'], 'Bearer new-access-fixture');
      replays++;
      return _response(testPlan().json);
    }, vault: vault);

    final first = api.readDay(testChildId, testDate);
    await refreshSent.future;
    final second = api.readDay(testChildId, testDate);
    await secondRejected.future;
    final last = api.readDay(testChildId, testDate);
    await lateRequest.future;
    refreshResponse.complete(_response(_rotatedSession(current)));
    await Future.wait([first, second]);
    lateRejection.complete(_response({'code': 'INVALID_SESSION'}, 401));
    expect(await last, isNotNull);
    expect(rotations, 1);
    expect(replays, 3);
    expect(vault.session?.refreshToken, 'new-refresh-fixture');
  });

  test('退出时清掉本机登录，晚到的刷新不写回且仍撤销旧服务会话', () async {
    final current = sampleSession();
    final vault = MemoryTokenVault()..session = current;
    final refreshSent = Completer<void>();
    final refreshResponse = Completer<http.Response>();
    final attemptedRevoke = Completer<void>();
    final revokedTokens = <String?>[];
    var rotations = 0;
    final api = _syncApi((request) async {
      if (request.url.path.endsWith('/sessions/refresh')) {
        rotations++;
        expect(rotations, 1);
        refreshSent.complete();
        return refreshResponse.future;
      }
      if (request.method == 'DELETE') {
        final authorization = request.headers['authorization'];
        revokedTokens.add(authorization);
        if (authorization == 'Bearer ${current.accessToken}') {
          attemptedRevoke.complete();
          return _response({'code': 'INVALID_SESSION'}, 401);
        }
        return _response({'accepted': true});
      }
      return _response({'code': 'INVALID_SESSION'}, 401);
    }, vault: vault);

    final expiredRead = expectLater(
      api.readDay(testChildId, testDate),
      throwsA(isA<ApiException>()),
    );
    await refreshSent.future;
    final logout = api.logout();
    await attemptedRevoke.future;
    expect(vault.session, isNull);
    refreshResponse.complete(_response(_rotatedSession(current)));
    await Future.wait([expiredRead, logout]);
    expect(vault.session, isNull);
    expect(rotations, 1);
    expect(revokedTokens, [
      'Bearer ${current.accessToken}',
      'Bearer new-access-fixture',
    ]);
  });

  test('换账号成功后旧刷新不能写回或借用新账号令牌', () async {
    final current = sampleSession();
    final vault = MemoryTokenVault()..session = current;
    final refreshSent = Completer<void>();
    final refreshResponse = Completer<http.Response>();
    final requestedReads = <String?>[];
    final api = _syncApi((request) async {
      if (request.url.path.endsWith('/sessions/refresh')) {
        refreshSent.complete();
        return refreshResponse.future;
      }
      if (request.url.path.endsWith('/sessions')) {
        return _response({
          ..._rotatedSession(current),
          'user': {'id': 'another-parent', 'displayName': '另一个家长'},
          'sessionId': 'another-session',
          'accessToken': 'another-access-fixture',
          'refreshToken': 'another-refresh-fixture',
        });
      }
      requestedReads.add(request.headers['authorization']);
      return _response({'code': 'INVALID_SESSION'}, 401);
    }, vault: vault);

    final expiredRead = expectLater(
      api.readDay(testChildId, testDate),
      throwsA(
        isA<ApiException>().having((error) => error.statusCode, '状态', isNull),
      ),
    );
    await refreshSent.future;
    await api.login(email: 'other@example.test', secretText: 'test-only');
    refreshResponse.complete(_response(_rotatedSession(current)));
    await expiredRead;
    expect(vault.session?.userId, 'another-parent');
    expect(vault.session?.refreshToken, 'another-refresh-fixture');
    expect(requestedReads, ['Bearer ${current.accessToken}']);
  });

  test('更换服务地址时旧客户端不会向旧地址发送新服务的凭证', () async {
    final current = sampleSession();
    final vault = MemoryTokenVault()..session = current;
    final refreshSent = Completer<void>();
    final refreshResponse = Completer<http.Response>();
    var oldCalls = 0;
    final oldApi = _syncApi((request) async {
      oldCalls++;
      if (request.url.path.endsWith('/sessions/refresh')) {
        refreshSent.complete();
        return refreshResponse.future;
      }
      return _response({'code': 'INVALID_SESSION'}, 401);
    }, vault: vault);

    final staleRead = expectLater(
      oldApi.readDay(testChildId, testDate),
      throwsA(isA<ApiException>()),
    );
    await refreshSent.future;
    await oldApi.clearLocalSession(retire: true);
    vault.session = MobileSession.fromJson({
      ..._rotatedSession(current),
      'sessionId': 'new-service-session',
    });
    refreshResponse.complete(_response(_rotatedSession(current)));
    await staleRead;
    await expectLater(
      oldApi.readDay(testChildId, testDate),
      throwsA(isA<ApiException>()),
    );
    expect(vault.session?.sessionId, 'new-service-session');
    expect(oldCalls, 2);
  });

  test('真实 HTTP 适配发送移动登录，读取今日并要求 Bearer 鉴权', () async {
    final requests = <http.Request>[];
    final client = MockClient((request) async {
      requests.add(request);
      if (request.url.path == '/v2/sessions') {
        expect(request.method, 'POST');
        final body = Map<String, dynamic>.from(jsonDecode(request.body) as Map);
        expect(body['clientType'], 'mobile');
        expect(body['email'], 'parent@example.test');
        expect(body['deviceId'], isNotEmpty);
        return http.Response(
          jsonEncode({
            'user': {'id': 'user-test', 'displayName': '测试家长'},
            'sessionId': '10000000-0000-4000-8000-000000000001',
            'accessToken': 'access-test-token',
            'refreshToken': 'refresh-test-token',
            'expiresAt': '2026-11-13T04:15:00Z',
            'refreshExpiresAt': '2026-12-13T04:00:00Z',
            'csrfToken': null,
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }
      expect(request.url.path, '/v2/children/$testChildId/days/$testDate');
      expect(request.headers['authorization'], 'Bearer access-test-token');
      return http.Response(
        jsonEncode(testPlan().json),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
    final vault = MemoryTokenVault();
    final api = BabyPlanApi(
      baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
      vault: vault,
      client: client,
    );

    final session = await api.login(
      email: 'parent@example.test',
      secretText: 'not-logged',
    );
    expect(session.userId, 'user-test');
    expect(vault.session?.accessToken, 'access-test-token');

    final plan = await api.readDay(testChildId, testDate);
    expect(plan, isNotNull);
    expect(plan!.items.length, DemoContent.dayPlan(testDate).items.length);
    expect(requests, hasLength(2));
  });

  test('参与 outbox 请求使用原操作 body 和合同路径', () async {
    late http.Request captured;
    final client = MockClient((request) async {
      captured = request;
      return http.Response(
        jsonEncode({
          'id': 'participation-test',
          'planItemId': testPlan().items.first.id,
          'status': 'skipped',
          'participantIds': <String>[],
          'notes': <Object>[],
          'actualMinutes': null,
          'again': false,
          'addedBy': testActorId,
          'revision': 1,
          'changeSeq': 2,
        }),
        200,
      );
    });
    final vault = MemoryTokenVault()..session = sampleSession();
    final api = BabyPlanApi(
      baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
      vault: vault,
      client: client,
    );
    final item = testPlan().items.first;
    final operation = PendingOperation(
      id: 'operation-test',
      familyId: testFamilyId,
      objectKey: 'participation:${item.id}',
      method: 'PUT',
      path: '/plan-items/${item.id}/participation',
      body: {
        'operationId': 'operation-test',
        'baseRevision': 0,
        'status': 'skipped',
        'participantIds': <String>[],
        'note': '',
        'actualMinutes': null,
        'again': false,
      },
      localVersion: 1,
      attempts: 1,
    );

    final response = await api.send(operation);

    expect(captured.method, 'PUT');
    expect(captured.url.path, '/v2/plan-items/${item.id}/participation');
    expect(captured.headers['authorization'], 'Bearer access-test-token');
    expect(jsonDecode(captured.body)['status'], 'skipped');
    expect(response['revision'], 1);
  });

  test('409 响应保留 REVISION_CONFLICT 的双方版本详情', () async {
    final client = MockClient(
      (request) async => http.Response(
        jsonEncode({
          'code': 'REVISION_CONFLICT',
          'message': '另一位家长刚刚更新了记录',
          'details': {
            'current': {
              'revision': 4,
              'notes': [
                {'authorId': 'partner-test', 'text': '家庭版本'},
              ],
            },
            'submitted': 3,
          },
          'requestId': 'request-conflict',
        }),
        409,
        headers: {'content-type': 'application/json'},
      ),
    );
    final vault = MemoryTokenVault()..session = sampleSession();
    final api = BabyPlanApi(
      baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
      vault: vault,
      client: client,
    );
    final item = testPlan().items.first;
    final operation = PendingOperation(
      id: 'operation-conflict',
      familyId: testFamilyId,
      objectKey: 'participation:${item.id}',
      method: 'PUT',
      path: '/plan-items/${item.id}/participation',
      body: {
        'operationId': 'operation-conflict',
        'baseRevision': 3,
        'status': 'played',
        'participantIds': [testActorId],
        'note': '本机版本',
        'actualMinutes': 5,
        'again': false,
      },
      localVersion: 1,
      attempts: 1,
    );

    try {
      await api.send(operation);
      fail('应当抛出冲突异常');
    } on ApiException catch (error) {
      expect(error.statusCode, 409);
      expect(error.code, 'REVISION_CONFLICT');
      expect(error.message, '另一位家长刚刚更新了记录');
      expect(error.details?['current'], isA<Map>());
      expect(error.details?['submitted'], 3);
    }
  });
}

BabyPlanApi _syncApi(
  Future<http.Response> Function(http.Request) handler, {
  MemoryTokenVault? vault,
}) {
  final client = MockClient(handler);
  addTearDown(client.close);
  return BabyPlanApi(
    baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
    vault: vault ?? (MemoryTokenVault()..session = sampleSession()),
    client: client,
  );
}

http.Response _response(Json body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

Json _snapshotPage() => {
  'snapshotId': 'stable-snapshot',
  'cursor': 'stable-cursor',
  'family': {
    'id': testFamilyId,
    'members': [
      {'userId': testActorId, 'familyId': testFamilyId},
    ],
  },
  'preferences': {'familyId': testFamilyId},
  for (final key in [
    'children',
    'days',
    'memories',
    'measurements',
    'observations',
    'sessions',
    'books',
    'media',
    'withdrawals',
  ])
    key: <Json>[],
  'hasMore': false,
  'nextPageToken': null,
  'expiresAt': '2026-11-13T04:30:00Z',
};

Json _change(int sequence, String entity, String id, Json? payload) => {
  'sequence': sequence,
  'entity': entity,
  'id': id,
  'revision': 2,
  'deleted': payload == null,
  'payload': payload,
};

Json _rotatedSession(MobileSession current) => {
  'user': {'id': current.userId, 'displayName': current.displayName},
  'sessionId': current.sessionId,
  'accessToken': 'new-access-fixture',
  'refreshToken': 'new-refresh-fixture',
  'expiresAt': '2026-11-13T04:30:00Z',
  'refreshExpiresAt': '2026-12-13T04:15:00Z',
};
