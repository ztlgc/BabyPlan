import 'dart:convert';
import 'dart:io';

import 'package:babyplan/app/app_controller.dart';
import 'package:babyplan/core/app_config.dart';
import 'package:babyplan/data/api_client.dart';
import 'package:babyplan/data/local_store.dart';
import 'package:babyplan/domain/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:path/path.dart' as path;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../support/test_support.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    initializeTestTimezones();
  });

  test('重开离线时仍读到自己的家庭；恢复连接先撤回玩法，再锁定已失权家庭且保留草稿', () async {
    final temporary = await createTempDirectory();
    final databasePath = path.join(temporary.path, 'mobile.db');
    addTearDown(() async => temporary.delete(recursive: true));
    final serverUri = Uri.parse('http://127.0.0.1:4318/v2');
    final vault = MemoryTokenVault()..session = sampleSession();
    final plan = testPlan();
    final activity = plan.items.first.activity;
    final other = plan.items[1];
    var online = true;
    var withdrawn = false;
    var authorized = true;
    final requests = <String>[];
    final remotePlan = {
      ...plan.json,
      'items': [
        plan.items.first.json,
        {
          ...other.json,
          'participation': {
            'id': 'remote-id',
            'planItemId': other.id,
            'status': 'played',
            'participantIds': ['other-parent'],
            'notes': [
              {'authorId': 'other-parent', 'text': '另一位家长已经记下。'},
            ],
            'actualMinutes': 3,
            'again': false,
            'addedBy': 'other-parent',
            'revision': 1,
          },
        },
        for (final item in plan.items.skip(2)) item.json,
      ],
    };
    const family = {
      'id': testFamilyId,
      'name': '测试家庭',
      'timezone': 'Asia/Shanghai',
      'revision': 1,
      'members': <Object>[],
    };
    final child = {
      'id': testChildId,
      'familyId': testFamilyId,
      'ageMode': 'months',
      'ageMonths': 18,
      'ageAsOf': '$testDate',
      'revision': 1,
    };
    final client = MockClient((request) async {
      if (!online) throw const SocketException('离线测试');
      requests.add('${request.method} ${request.url.path}');
      Object body;
      var status = 200;
      final route = request.url.path;
      if (route == '/v2/bootstrap') {
        body = {
          'user': {'id': vault.session!.userId, 'displayName': '测试家长'},
          'families': [if (authorized) family],
          'children': [if (authorized) child],
        };
      } else if (route == '/v2/content/options') {
        body = {
          'activities': [if (!withdrawn) activity.json],
          'withdrawals': [
            if (withdrawn)
              {
                'activityId': activity.id,
                'revision': activity.revision,
                'reason': '材料需复核',
              },
          ],
        };
      } else if (route.endsWith('/plans/ensure')) {
        body = {
          'days': [remotePlan],
        };
      } else if (route.endsWith('/snapshot')) {
        body = {
          'cursor': '1',
          'snapshotId': 'snapshot-1',
          'hasMore': false,
          'nextPageToken': null,
          'family': family,
          'preferences': {
            'familyId': testFamilyId,
            'availableMaterials': <String>[],
            'excludedMaterials': <String>[],
            'languageMode': 'zh_with_english',
            'revision': 1,
          },
          'children': [child],
          'days': [remotePlan],
          'books': [],
          'sessions': [],
          'media': [],
          'withdrawals': [],
          'memories': [],
          'measurements': [],
          'observations': [],
        };
      } else if (route.endsWith('/changes')) {
        body = {
          'changes': [],
          'hasMore': false,
          'nextCursor': request.url.queryParameters['cursor'],
        };
      } else if (route.contains('/plan-items/')) {
        status = 409;
        body = {'code': 'CONTENT_WITHDRAWN', 'message': '已停止推荐'};
      } else {
        status = 404;
        body = {'code': 'NOT_FOUND'};
      }
      return http.Response(
        jsonEncode(body),
        status,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });
    addTearDown(client.close);

    AppController controllerFor(LocalStore store) => AppController(
      config: const AppConfig(demo: false),
      local: store,
      tokenVault: vault,
      api: BabyPlanApi(baseUri: serverUri, vault: vault, client: client),
      initialFamilyId: 'demo-family',
      initialChildId: 'demo-child',
      initialActorId: 'demo-caregiver',
      now: () => testNow,
    );
    final firstStore = await openStore(databasePath);
    final first = controllerFor(firstStore);
    await first.initialize();
    expect(first.participations[other.id]?.historyNotes, ['另一位家长已经记下。']);
    expect(
      first.discoverableActivities.map((entry) => entry.id),
      contains(activity.id),
    );
    await first.closeStoresForTesting();

    online = false;
    final reopenedStore = await openStore(databasePath);
    final reopened = controllerFor(reopenedStore);
    addTearDown(reopened.closeStoresForTesting);
    await reopened.initialize();
    expect(reopened.familyId, testFamilyId);
    expect(reopened.plan?.id, plan.id);
    expect(reopened.participations[other.id]?.played, isTrue);
    expect(reopened.contentSafetyCurrent, isFalse);
    await reopened.record(
      plan.items.first,
      const ParticipationInput(
        status: ParticipationStatus.played,
        participantIds: ['user-test'],
        note: '断网时写下的备注',
      ),
    );
    await reopened.saveGrowthDraft({'text': '未发送的草稿'});

    online = true;
    withdrawn = true;
    requests.clear();
    await reopened.refresh();
    final safety = requests.indexOf('GET /v2/content/options');
    final upload = requests.indexOf(
      'PUT /v2/plan-items/${plan.items.first.id}/participation',
    );
    expect(safety, greaterThanOrEqualTo(0));
    expect(upload, greaterThan(safety));
    expect(reopened.blockedReason(plan.items.first), '材料需复核');
    expect(reopened.discoverableActivities, isEmpty);
    await expectLater(
      reopened.record(
        plan.items.first,
        const ParticipationInput(
          status: ParticipationStatus.played,
          participantIds: ['user-test'],
        ),
      ),
      throwsStateError,
    );

    authorized = false;
    requests.clear();
    await reopened.refresh();
    expect(reopened.familyCacheLocked, isTrue);
    expect(reopened.plan, isNull);
    expect(reopened.participations, isEmpty);
    expect(reopened.growthRecords, isEmpty);
    expect(requests.where((request) => request.startsWith('PUT ')), isEmpty);
    expect(
      await reopened.local.readDraft(
        testFamilyId,
        'user-test',
        'growth-editor',
      ),
      {'text': '未发送的草稿'},
    );
    expect(await reopened.local.pendingCount(testFamilyId), 1);
  });
}
