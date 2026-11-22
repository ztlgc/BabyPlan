import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:babyplan/app/app_controller.dart';
import 'package:babyplan/core/app_config.dart';
import 'package:babyplan/data/api_client.dart';
import 'package:babyplan/domain/models.dart';
import 'package:babyplan/services/reminder_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../support/test_support.dart';

class _FakeReminderScheduler implements ReminderScheduler {
  bool permissionAllowed = true;
  int permissionRequests = 0;
  String? scheduledTime;
  int cancels = 0;

  @override
  Future<void> cancel() async {
    cancels++;
    scheduledTime = null;
  }

  @override
  Future<void> initialize({required void Function() onOpenToday}) async {}

  @override
  Future<bool> requestPermission() async {
    permissionRequests++;
    return permissionAllowed;
  }

  @override
  Future<void> scheduleDaily(String localTime) async {
    scheduledTime = localTime;
  }
}

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    initializeTestTimezones();
  });

  test('提醒开关只在家长启用时申请权限并安排每日提醒', () async {
    final local = await openStore(inMemoryDatabasePath);
    final scheduler = _FakeReminderScheduler();
    final controller = AppController(
      config: const AppConfig(demo: true),
      local: local,
      tokenVault: MemoryTokenVault(),
      initialFamilyId: testFamilyId,
      initialChildId: testChildId,
      initialActorId: testActorId,
      reminderScheduler: scheduler,
      now: () => testNow,
    );
    await controller.initialize();

    await controller.updatePreferences(
      const FamilyPreferences(reminderEnabled: true, reminderTime: '18:45'),
    );
    expect(scheduler.permissionRequests, 1);
    expect(scheduler.scheduledTime, '18:45');

    await controller.updatePreferences(
      const FamilyPreferences(reminderEnabled: false, reminderTime: '18:45'),
    );
    expect(scheduler.cancels, 1);
    await controller.closeStoresForTesting();
  });

  test('拒绝通知权限时不会把提醒显示为已开启', () async {
    final local = await openStore(inMemoryDatabasePath);
    final scheduler = _FakeReminderScheduler()..permissionAllowed = false;
    final controller = AppController(
      config: const AppConfig(demo: true),
      local: local,
      tokenVault: MemoryTokenVault(),
      initialFamilyId: testFamilyId,
      initialChildId: testChildId,
      initialActorId: testActorId,
      reminderScheduler: scheduler,
      now: () => testNow,
    );
    await controller.initialize();

    await expectLater(
      controller.updatePreferences(
        const FamilyPreferences(reminderEnabled: true, reminderTime: '19:30'),
      ),
      throwsA(isA<StateError>()),
    );
    expect(controller.preferences.reminderEnabled, isFalse);
    expect(scheduler.scheduledTime, isNull);
    await controller.closeStoresForTesting();
  });

  test('退出账号会立即撤销本机提醒并清除提醒开关状态', () async {
    final local = await openStore(inMemoryDatabasePath);
    final scheduler = _FakeReminderScheduler();
    final controller = AppController(
      config: const AppConfig(demo: true),
      local: local,
      tokenVault: MemoryTokenVault(),
      initialFamilyId: testFamilyId,
      initialChildId: testChildId,
      initialActorId: testActorId,
      reminderScheduler: scheduler,
      now: () => testNow,
    );
    await controller.initialize();
    await controller.updatePreferences(
      const FamilyPreferences(reminderEnabled: true, reminderTime: '18:30'),
    );
    final cancelsBeforeLogout = scheduler.cancels;

    await controller.logout();

    expect(scheduler.cancels, greaterThan(cancelsBeforeLogout));
    expect(scheduler.scheduledTime, isNull);
    expect(controller.preferences.reminderEnabled, isFalse);
    await controller.closeStoresForTesting();
  });

  test('会话失效会撤销提醒且不保留失效安全存储会话', () async {
    final local = await openStore(inMemoryDatabasePath);
    final scheduler = _FakeReminderScheduler();
    final vault = MemoryTokenVault()..session = sampleSession();
    final client = MockClient((request) async {
      if (request.url.path == '/v2/sessions/refresh') {
        return http.Response(
          jsonEncode({'code': 'SESSION_EXPIRED', 'message': 'session expired'}),
          401,
          headers: {'content-type': 'application/json'},
        );
      }
      return http.Response(
        jsonEncode({'code': 'SESSION_EXPIRED', 'message': 'session expired'}),
        401,
        headers: {'content-type': 'application/json'},
      );
    });
    final api = BabyPlanApi(
      baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
      vault: vault,
      client: client,
    );
    final controller = AppController(
      config: const AppConfig(demo: false, apiBaseUrl: null),
      local: local,
      tokenVault: vault,
      initialFamilyId: 'placeholder-family',
      initialChildId: 'placeholder-child',
      initialActorId: 'placeholder-user',
      api: api,
      reminderScheduler: scheduler,
      now: () => testNow,
    );

    await controller.initialize();

    expect(scheduler.cancels, greaterThanOrEqualTo(1));
    expect(vault.session, isNull);
    expect(controller.accountLabel, isNull);
    await controller.closeStoresForTesting();
  });

  test('远端提醒切到另一台设备时，本机撤销提醒且不显示为已开启', () async {
    final local = await openStore(inMemoryDatabasePath);
    final scheduler = _FakeReminderScheduler();
    final vault = MemoryTokenVault()..session = sampleSession();
    final client = MockClient((request) async {
      final body = switch (request.url.path) {
        '/v2/bootstrap' => _bootstrap(vault.session!.userId),
        '/v2/families/family-dynamic/snapshot' => _snapshot(
          vault.session!.userId,
        ),
        '/v2/families/family-dynamic/changes' => {
          'nextCursor': request.url.queryParameters['cursor'],
          'hasMore': false,
          'changes': <Object>[],
        },
        '/v2/children/child-dynamic/plans/ensure' => {'days': _week()},
        '/v2/content/options' => {'activities': [], 'withdrawals': []},
        '/v2/users/me/reminder' => {
          'userId': testActorId,
          'deviceId': 'another-device',
          'enabled': true,
          'localTime': '18:00',
          'revision': 2,
        },
        _ => null,
      };
      if (body == null) {
        return http.Response(
          jsonEncode({'code': 'NOT_FOUND', 'message': 'not found'}),
          404,
        );
      }
      return http.Response(
        jsonEncode(body),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
    final api = BabyPlanApi(
      baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
      vault: vault,
      client: client,
    );
    final controller = AppController(
      config: const AppConfig(demo: false, apiBaseUrl: null),
      local: local,
      tokenVault: vault,
      initialFamilyId: 'placeholder-family',
      initialChildId: 'placeholder-child',
      initialActorId: 'placeholder-user',
      api: api,
      reminderScheduler: scheduler,
      now: () => testNow,
    );

    await controller.initialize();

    expect(scheduler.cancels, greaterThanOrEqualTo(1));
    expect(scheduler.scheduledTime, isNull);
    expect(controller.preferences.reminderEnabled, isFalse);
    expect(controller.preferences.reminderTime, '18:00');
    await controller.closeStoresForTesting();
  });

  test('登录会话启动时自动选定服务返回的孩子并刷新今天', () async {
    final local = await openStore(inMemoryDatabasePath);
    final vault = MemoryTokenVault()..session = sampleSession();
    final client = MockClient((request) async {
      expect(
        request.headers['authorization'],
        'Bearer ${vault.session!.accessToken}',
      );
      final body = switch (request.url.path) {
        '/v2/bootstrap' => _bootstrap(vault.session!.userId),
        '/v2/families/family-dynamic/snapshot' => _snapshot(
          vault.session!.userId,
        ),
        '/v2/families/family-dynamic/changes' => {
          'nextCursor': request.url.queryParameters['cursor'],
          'hasMore': false,
          'changes': <Object>[],
        },
        '/v2/children/child-dynamic/plans/ensure' => {'days': _week()},
        '/v2/content/options' => {'activities': [], 'withdrawals': []},
        '/v2/users/me/reminder' => {
          'userId': testActorId,
          'deviceId': null,
          'enabled': false,
          'localTime': '19:30',
          'revision': 0,
        },
        _ => null,
      };
      if (body == null) {
        return http.Response(jsonEncode({'error': 'not found'}), 404);
      }
      return http.Response(
        jsonEncode(body),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
    final api = BabyPlanApi(
      baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
      vault: vault,
      client: client,
    );
    final controller = AppController(
      config: const AppConfig(demo: false, apiBaseUrl: null),
      local: local,
      tokenVault: vault,
      initialFamilyId: 'placeholder-family',
      initialChildId: 'placeholder-child',
      initialActorId: 'placeholder-user',
      api: api,
      reminderScheduler: _FakeReminderScheduler(),
      now: () => testNow,
    );
    // 测试显式注入 ApiClient 时使用同一服务地址语义。
    controller.api = api;
    await controller.initialize();

    expect(controller.loadError, isNull);
    expect(controller.activeChild?.id, 'child-dynamic');
    expect(controller.activeChild?.label, '小满');
    expect(controller.familyId, 'family-dynamic');
    expect(controller.childId, 'child-dynamic');
    expect(controller.connected, isTrue);
    expect(controller.plan?.childId, 'child-dynamic');
    expect(controller.isPreview, isFalse);
    await controller.closeStoresForTesting();
  });

  test('运行时填写服务器根地址会补齐 v2 并保存，不把旧账号凭据带到新服务', () async {
    final local = await openStore(inMemoryDatabasePath);
    final vault = MemoryTokenVault()..session = sampleSession();
    final controller = AppController(
      config: const AppConfig(demo: true),
      local: local,
      tokenVault: vault,
      initialFamilyId: testFamilyId,
      initialChildId: testChildId,
      initialActorId: testActorId,
      reminderScheduler: _FakeReminderScheduler(),
      now: () => testNow,
    );
    await controller.initialize();
    await controller.connectService('http://192.168.1.20:4318');

    expect(controller.api?.baseUri.toString(), 'http://192.168.1.20:4318/v2');
    expect(vault.serviceUri, 'http://192.168.1.20:4318/v2');
    expect(vault.session, isNull);
    await expectLater(
      controller.connectService('javascript:alert(1)'),
      throwsA(isA<FormatException>()),
    );
    await controller.closeStoresForTesting();
  });

  test('第二台手机从持久游标读到家长变更；游标过期整批恢复且保留离线草稿和偏好', () async {
    final directory = await createTempDirectory();
    final store = await openStore('${directory.path}/caregiver-b.db');
    addTearDown(() => directory.delete(recursive: true));
    final vault = MemoryTokenVault()..session = sampleSession();
    final user = vault.session!.userId;
    final requests = <String>[];
    var mode = 'first';
    final client = MockClient((request) async {
      final path = request.url.path;
      final cursor = request.url.queryParameters['cursor'];
      requests.add('${request.method} $path');
      final initial = _snapshot(user);
      switch (path) {
        case '/v2/bootstrap':
          final profile = _bootstrap(user);
          return _response(
            mode == 'revoked'
                ? {...profile, 'families': [], 'children': []}
                : profile,
          );
        case '/v2/content/options':
          if (mode == 'offline') throw const SocketException('离线');
          return _response({'activities': [], 'withdrawals': []});
        case '/v2/children/child-dynamic/plans/ensure':
          return _response({'days': _week()});
        case '/v2/families/family-dynamic/snapshot':
          return _response(
            mode == 'expired'
                ? {
                    ...initial,
                    'snapshotId': 'snapshot-recovered',
                    'cursor': 'cursor-recovered',
                  }
                : initial,
          );
        case '/v2/families/family-dynamic/changes':
          if (mode == 'expired' && cursor == 'cursor-other-parent') {
            return _response({'code': 'CURSOR_EXPIRED', 'message': '已过期'}, 410);
          }
          if (mode == 'shared' && cursor == 'cursor-first') {
            return _response({
              'nextCursor': 'cursor-other-parent',
              'hasMore': false,
              'changes': [
                {
                  'sequence': 2,
                  'entity': 'family_book',
                  'id': 'book-other-parent',
                  'revision': 1,
                  'deleted': false,
                  'payload': {
                    'id': 'book-other-parent',
                    'familyId': 'family-dynamic',
                    'title': '另一位家长登记的书',
                    'language': 'zh',
                    'editionId': null,
                    'editionStatus': 'unverified',
                    'note': '',
                    'revision': 1,
                  },
                },
              ],
            });
          }
          return _response({
            'nextCursor': cursor,
            'hasMore': false,
            'changes': [],
          });
        case '/v2/families/family-dynamic/preferences':
          // 写请求失败不应阻断读取已经由另一位家长提交的变化。
          expect(request.method, 'PUT');
          expect((jsonDecode(request.body) as Map)['availableMaterials'], [
            '纸盒',
          ]);
          return _response({'code': 'UNAVAILABLE', 'message': '稍后再试'}, 503);
        case '/v2/users/me/reminder':
          return _response({
            'userId': user,
            'enabled': false,
            'deviceId': null,
            'localTime': '18:00',
            'revision': 1,
          });
      }
      return _response({'code': 'NOT_FOUND', 'message': '未知路由'}, 404);
    });
    addTearDown(client.close);
    final controller = AppController(
      config: const AppConfig(demo: false),
      local: store,
      tokenVault: vault,
      initialFamilyId: 'demo-family',
      initialChildId: 'demo-child',
      initialActorId: 'demo-caregiver',
      api: BabyPlanApi(
        baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
        vault: vault,
        client: client,
      ),
      reminderScheduler: _FakeReminderScheduler(),
      now: () => testNow,
    );
    addTearDown(controller.closeStoresForTesting);
    await controller.initialize();
    expect(await controller.local.readCursor('family-dynamic'), 'cursor-first');
    expect(controller.plan, isNotNull);

    mode = 'shared';
    requests.clear();
    await Future.wait([controller.refresh(), controller.refresh()]);
    expect(requests.where((value) => value.endsWith('/changes')), hasLength(1));
    expect(
      requests.where(
        (value) =>
            value.endsWith('/snapshot') || value.endsWith('/plans/ensure'),
      ),
      isEmpty,
    );
    expect(controller.books.single.title, '另一位家长登记的书');
    expect(
      await controller.local.readCursor('family-dynamic'),
      'cursor-other-parent',
    );

    mode = 'offline';
    await controller.saveGrowthDraft({'text': '本机还没发出的文字'});
    await controller.updatePreferences(
      const FamilyPreferences(
        availableMaterials: ['纸盒'],
        reminderTime: '18:00',
      ),
    );
    expect(controller.pendingCount, 1);

    mode = 'expired';
    requests.clear();
    await controller.refresh();
    expect(
      await controller.local.readCursor('family-dynamic'),
      'cursor-recovered',
    );
    expect(
      requests.where((value) => value.endsWith('/snapshot')),
      hasLength(1),
    );
    expect(controller.books, isEmpty);
    expect(controller.pendingCount, 1);
    expect(controller.preferences.availableMaterials, ['纸盒']);
    expect(await controller.readGrowthDraft(), {'text': '本机还没发出的文字'});

    mode = 'revoked';
    requests.clear();
    await controller.refresh();
    expect(controller.familyCacheLocked, isTrue);
    expect(controller.plan, isNull);
    expect(requests, ['GET /v2/bootstrap']);
    expect(
      await controller.local.readDraft('family-dynamic', user, 'growth-editor'),
      {'text': '本机还没发出的文字'},
    );
    expect(await controller.local.pendingCount('family-dynamic'), 1);
  });

  test('退出期间晚到的增量页不能恢复刚关闭的家庭', () async {
    final store = await openStore(inMemoryDatabasePath);

    final vault = MemoryTokenVault()..session = sampleSession();
    final user = vault.session!.userId;
    final issued = Completer<void>();
    final release = Completer<void>();
    var block = false;
    final client = MockClient((request) async {
      final path = request.url.path;
      final cursor = request.url.queryParameters['cursor'];
      if (path.endsWith('/changes') && block) {
        issued.complete();
        await release.future;
      }
      return switch (path) {
        '/v2/bootstrap' => _response(_bootstrap(user)),
        '/v2/content/options' => _response({
          'activities': [],
          'withdrawals': [],
        }),
        '/v2/families/family-dynamic/snapshot' => _response(_snapshot(user)),
        '/v2/families/family-dynamic/changes' => _response({
          'changes': [],
          'hasMore': false,
          'nextCursor': cursor,
        }),
        '/v2/children/child-dynamic/plans/ensure' => _response({
          'days': _week(),
        }),
        '/v2/users/me/reminder' => _response({
          'userId': user,
          'enabled': true,
          'deviceId': await vault.deviceId(),
          'localTime': '16:30',
          'revision': 1,
        }),
        '/v2/sessions/current' => http.Response('', 204),
        _ => _response({'code': 'NOT_FOUND', 'message': '未知路由'}, 404),
      };
    });
    addTearDown(client.close);
    final scheduler = _FakeReminderScheduler();
    final controller = AppController(
      config: const AppConfig(demo: false),
      local: store,
      tokenVault: vault,
      initialFamilyId: 'demo-family',
      initialChildId: 'demo-child',
      initialActorId: 'demo-caregiver',
      api: BabyPlanApi(
        baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
        vault: vault,
        client: client,
      ),
      reminderScheduler: scheduler,
      now: () => testNow,
    );
    addTearDown(controller.closeStoresForTesting);
    await controller.initialize();
    expect(scheduler.scheduledTime, '16:30');
    block = true;
    final refresh = controller.refresh();
    await issued.future.timeout(const Duration(seconds: 3));
    await controller.logout();
    release.complete();
    await refresh;
    expect(controller.plan, isNull);
    expect(controller.activeFamily, isNull);
    expect(controller.accountLabel, isNull);
    expect(controller.preferences.reminderEnabled, isFalse);
    expect(scheduler.scheduledTime, isNull);
  });

  test('同设备换账号后，另一位家长既看不到也不会代发我的离线内容', () async {
    final directory = await createTempDirectory();
    addTearDown(() => directory.delete(recursive: true));
    final root = await openStore('${directory.path}/shared-root.db');
    final vault = MemoryTokenVault();
    const first = 'caregiver-first';
    const second = 'caregiver-second';
    final requests = <(String, Json)>[];
    var offline = false;
    var holdFirstWrites = false;
    final client = MockClient((request) async {
      if (offline) throw const SocketException('离线');
      final uri = request.url;
      final path = uri.path;
      if (path == '/v2/sessions') {
        final email = (jsonDecode(request.body) as Map)['email'] as String;
        final id = email.startsWith('a@') ? first : second;
        return _response({
          'user': {'id': id, 'displayName': id == first ? '家长甲' : '家长乙'},
          'sessionId': 'fixture-session-$id',
          'accessToken': 'fixture-access-$id',
          'refreshToken': 'fixture-refresh-$id',
          'expiresAt': '2026-11-13T04:30:00Z',
          'refreshExpiresAt': '2026-12-13T04:00:00Z',
        });
      }
      if (path == '/v2/sessions/current') return http.Response('', 204);
      final user =
          request.headers['authorization'] == 'Bearer fixture-access-$first'
          ? first
          : second;
      if (path.endsWith('/memories') && request.method == 'POST') {
        final body = jsonDecode(request.body) as Json;
        requests.add((user, body));
        if (user == first && holdFirstWrites) {
          return _response({'code': 'UNAVAILABLE', 'message': '暂不可写'}, 503);
        }
        return _response({
          'id': body['id'],
          'childId': 'child-dynamic',
          'type': body['type'],
          'localDate': body['localDate'],
          'text': body['text'],
          'firstConfirmed': false,
          'mediaIds': <String>[],
          'addedBy': user,
          'revision': 1,
          'deletedAt': null,
        }, 201);
      }
      return switch (path) {
        '/v2/bootstrap' => _response(_bootstrap(user)),
        '/v2/content/options' => _response({
          'activities': [],
          'withdrawals': [],
        }),
        '/v2/families/family-dynamic/snapshot' => _response(_snapshot(user)),
        '/v2/families/family-dynamic/changes' => _response({
          'nextCursor': uri.queryParameters['cursor'],
          'hasMore': false,
          'changes': [],
        }),
        '/v2/children/child-dynamic/plans/ensure' => _response({
          'days': _week(),
        }),
        '/v2/users/me/reminder' => _response({
          'userId': user,
          'enabled': false,
          'deviceId': null,
          'localTime': '16:00',
          'revision': 1,
        }),
        _ => _response({'code': 'NOT_FOUND', 'message': '未知路由'}, 404),
      };
    });
    addTearDown(client.close);
    var currentTime = testNow;
    final controller = AppController(
      config: const AppConfig(demo: false),
      local: root,
      tokenVault: vault,
      initialFamilyId: 'demo-family',
      initialChildId: 'demo-child',
      initialActorId: 'demo-caregiver',
      api: BabyPlanApi(
        baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
        vault: vault,
        client: client,
      ),
      reminderScheduler: _FakeReminderScheduler(),
      now: () => currentTime,
    );
    addTearDown(controller.closeStoresForTesting);

    await controller.login(email: 'a@example.test', passphrase: 'fixture');
    expect(controller.actorId, first);
    final firstStore = controller.local;
    offline = true;
    await controller.saveGrowthDraft({'text': '甲独有草稿'});
    final saved = await controller.addGrowth(
      type: GrowthRecordType.quote,
      date: testDate,
      text: '甲的断网记录',
    );
    expect(controller.pendingCount, 1);
    expect(requests, isEmpty);

    offline = false;
    await controller.logout();
    expect(controller.local, same(root));
    await controller.login(email: 'b@example.test', passphrase: 'fixture');
    expect(controller.actorId, second);
    expect(controller.local, isNot(same(firstStore)));
    expect(controller.growthRecords, isEmpty);
    expect(await controller.readGrowthDraft(), isNull);
    expect(controller.pendingCount, 0);
    await controller.refresh();
    expect(requests, isEmpty);

    await controller.logout();
    holdFirstWrites = true;
    await controller.login(email: 'a@example.test', passphrase: 'fixture');
    expect(controller.local, same(firstStore));
    expect(controller.growthRecords.single.id, saved.record.id);
    expect(controller.growthRecords.single.text, '甲的断网记录');
    expect(await controller.readGrowthDraft(), {'text': '甲独有草稿'});
    expect(controller.pendingCount, 1);
    holdFirstWrites = false;
    currentTime = currentTime.add(const Duration(minutes: 3));
    await controller.refresh();
    expect(controller.pendingCount, 0);
    expect(controller.growthRecords.single.syncState, 'synced');
    expect(requests, hasLength(2));
    expect(requests.map((request) => request.$1), [first, first]);
    expect(requests[0].$2, requests[1].$2);
  });
}

http.Response _response(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

Map<String, dynamic> _bootstrap(String userId) => {
  'user': {'id': userId, 'displayName': '真实家长'},
  'families': [
    {
      'id': 'family-dynamic',
      'name': '我们家',
      'timezone': 'Asia/Shanghai',
      'members': <Object>[],
      'revision': 1,
    },
  ],
  'children': [
    {
      'id': 'child-dynamic',
      'familyId': 'family-dynamic',
      'displayName': '小满',
      'ageMode': 'months',
      'ageMonths': 19,
      'ageAsOf': '$testDate',
      'birthDate': null,
      'revision': 1,
    },
  ],
  'contentRoles': <String>[],
};

List<Json> _week() => [
  for (var index = 0; index < 7; index++)
    (() {
      final date = testDate.addDays(index);
      final plan = testPlan(
        date: date,
        familyId: 'family-dynamic',
        childId: 'child-dynamic',
      );
      final id = 'plan-$date';
      return {
        ...plan.json,
        'id': id,
        'items': [
          for (final item in plan.items)
            {...item.json, 'id': '$id:${item.id}', 'dayPlanId': id},
        ],
      };
    })(),
];

Map<String, dynamic> _snapshot(String userId) => {
  'snapshotId': 'snapshot-first',
  'cursor': 'cursor-first',
  'nextPageToken': null,
  'hasMore': false,
  'expiresAt': '2026-11-13T04:30:00Z',
  'family': (_bootstrap(userId)['families'] as List).single,
  'children': _bootstrap(userId)['children'],
  'days': _week(),
  'memories': <Object>[],
  'measurements': <Object>[],
  'observations': <Object>[],
  'sessions': <Object>[],
  'books': <Object>[],
  'media': <Object>[],
  'withdrawals': <Object>[],
  'preferences': {
    'familyId': 'family-dynamic',
    'availableMaterials': ['积木'],
    'excludedMaterials': <String>[],
    'languageMode': 'zh_with_english',
    'revision': 1,
  },
};
