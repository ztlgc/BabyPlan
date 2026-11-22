import 'dart:io';

import 'package:babyplan/data/local_store.dart';
import 'package:babyplan/domain/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../support/test_support.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    initializeTestTimezones();
  });

  group('LocalStore 事务与 outbox', () {
    late Directory temporary;
    late String databasePath;
    LocalStore? store;

    setUp(() async {
      temporary = await createTempDirectory();
      databasePath = '${temporary.path}${Platform.pathSeparator}babyplan.db';
      store = await openStore(databasePath);
    });

    tearDown(() async {
      await store?.close();
      await temporary.delete(recursive: true);
    });

    test('参与记录、outbox 与计划重启后都仍然存在', () async {
      final current = store!;
      await current.cachePlan(testFamilyId, testPlan());
      final item = testPlan().items.first;
      final operationId = await current.saveParticipation(
        familyId: testFamilyId,
        actorId: testActorId,
        itemId: item.id,
        input: const ParticipationInput(
          status: ParticipationStatus.played,
          participantIds: [testActorId],
          note: '一起翻了页',
          actualMinutes: 4,
        ),
        now: testNow,
      );
      expect(operationId, isNotEmpty);
      expect(await current.pendingCount(testFamilyId), 1);

      await current.close();
      store = await openStore(databasePath);

      expect(
        await store!.readPlan(testFamilyId, testChildId, testDate),
        isNotNull,
      );
      final participation = (await store!.readParticipations(
        testFamilyId,
      ))[item.id];
      expect(participation, isNotNull);
      expect(participation!.note, '一起翻了页');
      expect(participation.actualMinutes, 4);
      expect(await store!.pendingCount(testFamilyId), 1);
    });

    test('未来安排拒绝写入，事务不会留下本地记录或待传操作', () async {
      final current = store!;
      final futureDate = testDate.addDays(1);
      await current.cachePlan(testFamilyId, testPlan(date: futureDate));
      final item = testPlan(date: futureDate).items.first;

      await expectLater(
        current.saveParticipation(
          familyId: testFamilyId,
          actorId: testActorId,
          itemId: item.id,
          input: const ParticipationInput(
            status: ParticipationStatus.skipped,
            participantIds: [],
          ),
          now: testNow,
        ),
        throwsA(isA<StateError>()),
      );
      expect(await current.readParticipations(testFamilyId), isEmpty);
      expect(await current.pendingCount(testFamilyId), 0);
    });

    test('未发送的重复编辑复用 operationId，只保留一条 outbox', () async {
      final current = store!;
      await current.cachePlan(testFamilyId, testPlan());
      final item = testPlan().items.first;
      ParticipationInput input(String note) => ParticipationInput(
        status: ParticipationStatus.played,
        participantIds: const [testActorId],
        note: note,
      );

      final first = await current.saveParticipation(
        familyId: testFamilyId,
        actorId: testActorId,
        itemId: item.id,
        input: input('第一次点击'),
        now: testNow,
      );
      final second = await current.saveParticipation(
        familyId: testFamilyId,
        actorId: testActorId,
        itemId: item.id,
        input: input('重复点击后的备注'),
        now: testNow,
      );

      expect(second, first);
      expect(await current.pendingCount(testFamilyId), 1);
      expect(
        (await current.readParticipations(testFamilyId))[item.id]!.note,
        '重复点击后的备注',
      );
      final claimed = await current.claimNext(testFamilyId, testNow);
      expect(claimed!.id, first);
      expect(claimed.body['note'], '重复点击后的备注');
      expect(claimed.body['baseRevision'], 0);
    });

    test('确认参与结果后重启仍保留已同步状态', () async {
      final current = store!;
      await current.cachePlan(testFamilyId, testPlan());
      final item = testPlan().items.first;
      final operation = await current.saveParticipation(
        familyId: testFamilyId,
        actorId: testActorId,
        itemId: item.id,
        input: const ParticipationInput(
          status: ParticipationStatus.played,
          participantIds: [testActorId],
        ),
        now: testNow,
      );
      final claimed = await current.claimNext(testFamilyId, testNow);
      expect(claimed!.id, operation);
      await current.acknowledge(testFamilyId, operation, {
        'id': 'participation-test',
        'planItemId': item.id,
        'status': 'played',
        'participantIds': [testActorId],
        'notes': <Object>[],
        'actualMinutes': null,
        'again': false,
        'addedBy': testActorId,
        'revision': 1,
        'changeSeq': 7,
      });
      expect(await current.pendingCount(testFamilyId), 0);

      await current.close();
      store = await openStore(databasePath);
      final participation = (await store!.readParticipations(
        testFamilyId,
      ))[item.id];
      expect(participation!.syncState, 'synced');
      expect(participation.serverRevision, 1);
    });

    test('轻松一天缩短四项，保留已记录的睡前项目，再恢复完整安排', () async {
      final current = store!;
      final before = testPlan();
      await current.cachePlan(testFamilyId, before);
      final calm = before.items.firstWhere(
        (item) => item.activity.kind == 'calm',
      );
      await current.saveParticipation(
        familyId: testFamilyId,
        actorId: testActorId,
        itemId: calm.id,
        input: const ParticipationInput(
          status: ParticipationStatus.played,
          participantIds: [testActorId],
          note: '今天已经共读',
        ),
        now: testNow,
      );

      final lite = await current.updatePlanMode(
        familyId: testFamilyId,
        planId: 'plan-test',
        mode: 'lite',
        now: testNow,
      );
      expect(lite.visibleItems, hasLength(5));
      expect(lite.effectiveBudgetMinutes, 30);
      expect(
        lite.visibleItems
            .singleWhere((item) => item.id == calm.id)
            .budgetMinutes,
        calm.budgetMinutes,
      );
      expect(
        lite.items
            .firstWhere((item) => item.activity.kind == 'child-led')
            .visible,
        isFalse,
      );
      final standard = await current.updatePlanMode(
        familyId: testFamilyId,
        planId: 'plan-test',
        mode: 'standard',
        now: testNow,
      );
      expect(standard.mode, 'standard');
      expect(standard.visibleItems, hasLength(6));
      expect(standard.effectiveBudgetMinutes, before.effectiveBudgetMinutes);

      final modeOperation = await current.claimNext(
        testFamilyId,
        testNow,
        objectPrefixes: const {'day_mode:'},
      );
      expect(modeOperation!.body['baseRevision'], 0);
      expect(modeOperation.body['mode'], 'standard');
      final record = await current.claimNext(
        testFamilyId,
        testNow,
        objectPrefixes: const {'participation:'},
      );
      expect(record?.body['note'], '今天已经共读');

      await current.saveGrowthRecord(
        familyId: testFamilyId,
        childId: testChildId,
        type: GrowthRecordType.quote,
        localDate: testDate,
        text: '“还要”',
        now: testNow,
      );
      expect(
        await current.claimNext(
          testFamilyId,
          testNow,
          objectPrefixes: const {'participation:'},
        ),
        isNull,
      );
      expect(await current.pendingCount(testFamilyId), 3);
    });

    test('成长记录按服务合同生成可重试 outbox，并确认同步状态', () async {
      final current = store!;
      final record = await current.saveGrowthRecord(
        familyId: testFamilyId,
        childId: testChildId,
        type: GrowthRecordType.measurement,
        localDate: testDate,
        text: '家中测量',
        value: 10.4,
        unit: 'kg',
        measurementKind: GrowthMeasurementKind.weight,
        measurementMethod: GrowthMeasurementMethod.scale,
        measurementSource: GrowthMeasurementSource.home,
        now: testNow,
      );
      final operation = await current.claimNext(
        testFamilyId,
        testNow,
        objectPrefixes: const {'growth:'},
      );
      expect(operation!.method, 'POST');
      expect(operation.path, '/children/$testChildId/measurements');
      expect(operation.body['id'], record.id);
      expect(operation.body['kind'], 'weight');
      expect(operation.body['method'], 'scale');
      expect(operation.body['source'], 'home');
      expect(operation.body['operationId'], operation.id);

      await current.acknowledge(testFamilyId, operation.id, {
        'id': record.id,
        'childId': testChildId,
        'localDate': '$testDate',
        'kind': 'weight',
        'value': 10.4,
        'unit': 'kg',
        'method': 'scale',
        'source': 'home',
        'revision': 1,
      });
      final reloaded = (await current.readGrowthRecords(
        testFamilyId,
        testChildId,
      )).single;
      expect(reloaded.syncState, 'synced');
      expect(await current.pendingCount(testFamilyId), 0);
    });

    test('测量保留卧位身长、站立身高、体重、单位和来源', () async {
      final current = store!;
      final recumbent = await current.saveGrowthRecord(
        familyId: testFamilyId,
        childId: testChildId,
        type: GrowthRecordType.measurement,
        localDate: testDate,
        text: '体检时量的',
        value: 82.5,
        unit: 'cm',
        measurementKind: GrowthMeasurementKind.height,
        measurementMethod: GrowthMeasurementMethod.recumbent,
        measurementSource: GrowthMeasurementSource.clinic,
        now: testNow,
      );
      final operation = await current.claimNext(
        testFamilyId,
        testNow,
        objectPrefixes: const {'growth:'},
      );
      expect(operation!.body['kind'], 'height');
      expect(operation.body['unit'], 'cm');
      expect(operation.body['method'], 'recumbent');
      expect(operation.body['source'], 'clinic');
      await current.acknowledge(testFamilyId, operation.id, {
        'id': recumbent.id,
        'childId': testChildId,
        'localDate': '$testDate',
        'kind': 'height',
        'value': 82.5,
        'unit': 'cm',
        'method': 'recumbent',
        'source': 'clinic',
        'revision': 1,
      });

      await current.cacheRemoteGrowthSnapshot(
        familyId: testFamilyId,
        childId: testChildId,
        memories: const [],
        measurements: [
          {
            'id': recumbent.id,
            'childId': testChildId,
            'localDate': testDate.toString(),
            'kind': 'height',
            'value': 82.5,
            'unit': 'cm',
            'method': 'recumbent',
            'source': 'clinic',
            'revision': 1,
          },
          {
            'id': 'standing-height',
            'childId': testChildId,
            'localDate': testDate.addDays(30).toString(),
            'kind': 'height',
            'value': 84.0,
            'unit': 'cm',
            'method': 'standing',
            'source': 'home',
            'revision': 2,
          },
        ],
        observations: const [],
      );

      final records = await current.readGrowthRecords(
        testFamilyId,
        testChildId,
      );
      final restoredRecumbent = records.singleWhere(
        (record) => record.id == recumbent.id,
      );
      final standing = records.singleWhere(
        (record) => record.id == 'standing-height',
      );
      expect(
        restoredRecumbent.measurementMethod,
        GrowthMeasurementMethod.recumbent,
      );
      expect(
        restoredRecumbent.measurementSource,
        GrowthMeasurementSource.clinic,
      );
      expect(standing.measurementKind, GrowthMeasurementKind.height);
      expect(standing.measurementMethod, GrowthMeasurementMethod.standing);
      expect(standing.measurementSource, GrowthMeasurementSource.home);

      await expectLater(
        current.saveGrowthRecord(
          familyId: testFamilyId,
          childId: testChildId,
          type: GrowthRecordType.measurement,
          localDate: testDate,
          text: '',
          value: 82.5,
          unit: 'cm',
          measurementKind: GrowthMeasurementKind.height,
          measurementMethod: GrowthMeasurementMethod.scale,
          measurementSource: GrowthMeasurementSource.home,
          now: testNow,
        ),
        throwsA(isA<FormatException>()),
      );
    });

    test('冲突详情重启后可恢复，保留我的版本会生成新 operationId 和远端修订', () async {
      final current = store!;
      await current.cachePlan(testFamilyId, testPlan());
      final item = testPlan().items.first;
      final operationId = await current.saveParticipation(
        familyId: testFamilyId,
        actorId: testActorId,
        itemId: item.id,
        input: ParticipationInput(
          status: ParticipationStatus.played,
          participantIds: const [testActorId],
          note: '本机：一起搭好了桥',
        ),
        now: testNow,
      );
      final claimed = await current.claimNext(testFamilyId, testNow);
      expect(claimed!.id, operationId);
      await current.failOperation(
        testFamilyId,
        operationId,
        code: 'REVISION_CONFLICT',
        retryAfter: testNow.add(const Duration(days: 1)),
        conflict: {
          'current': {
            'id': 'participation-remote',
            'planItemId': item.id,
            'status': 'played',
            'participantIds': ['partner-test'],
            'notes': [
              {'authorId': 'partner-test', 'text': '家庭：另一位家长写下的版本'},
            ],
            'actualMinutes': 6,
            'again': false,
            'addedBy': 'partner-test',
            'revision': 2,
          },
          'submitted': 1,
        },
      );

      await current.close();
      store = await openStore(databasePath);
      final restoredStore = store!;
      final issue = (await restoredStore.readSyncIssues(testFamilyId)).single;
      expect(issue.isConflict, isTrue);
      expect(issue.localText, '本机：一起搭好了桥');
      expect(issue.remoteText, '家庭：另一位家长写下的版本');
      expect(issue.remoteRevision, 2);

      await restoredStore.resolveSyncConflict(
        familyId: testFamilyId,
        actorId: testActorId,
        operationId: issue.operationId,
        resolution: SyncConflictResolution.keepLocal,
        now: testNow.add(const Duration(minutes: 1)),
      );
      final localParticipation = (await restoredStore.readParticipations(
        testFamilyId,
      ))[item.id]!;
      expect(localParticipation.note, '本机：一起搭好了桥');
      expect(localParticipation.serverRevision, 2);
      expect(localParticipation.syncState, 'local_pending');
      final retried = await restoredStore.claimNext(
        testFamilyId,
        testNow.add(const Duration(minutes: 1)),
        objectPrefixes: const {'participation:'},
      );
      expect(retried!.id, isNot(operationId));
      expect(retried.body['baseRevision'], 2);
      expect(retried.body['note'], '本机：一起搭好了桥');
    });

    test('双方都保留时采用家庭版本，并把本机备注作为独立再玩记录排队', () async {
      final current = store!;
      await current.cachePlan(testFamilyId, testPlan());
      final item = testPlan().items.first;
      final operationId = await current.saveParticipation(
        familyId: testFamilyId,
        actorId: testActorId,
        itemId: item.id,
        input: ParticipationInput(
          status: ParticipationStatus.played,
          participantIds: const [testActorId],
          note: '本机备注不丢',
          actualMinutes: 4,
        ),
        now: testNow,
      );
      await current.claimNext(testFamilyId, testNow);
      await current.failOperation(
        testFamilyId,
        operationId,
        code: 'REVISION_CONFLICT',
        retryAfter: testNow.add(const Duration(days: 1)),
        conflict: {
          'current': {
            'id': 'participation-remote',
            'planItemId': item.id,
            'status': 'played',
            'participantIds': ['partner-test'],
            'notes': [
              {'authorId': 'partner-test', 'text': '家庭备注保留'},
            ],
            'actualMinutes': 6,
            'again': false,
            'addedBy': 'partner-test',
            'revision': 3,
          },
        },
      );
      final issue = (await current.readSyncIssues(testFamilyId)).single;

      await current.resolveSyncConflict(
        familyId: testFamilyId,
        actorId: testActorId,
        operationId: issue.operationId,
        resolution: SyncConflictResolution.keepBoth,
        now: testNow.add(const Duration(minutes: 1)),
      );

      final participation = (await current.readParticipations(
        testFamilyId,
      ))[item.id]!;
      expect(participation.note, '家庭备注保留');
      expect(participation.serverRevision, 3);
      expect(participation.syncState, 'synced');
      final extra = await current.claimNext(
        testFamilyId,
        testNow.add(const Duration(minutes: 1)),
        objectPrefixes: const {'play_session:'},
      );
      expect(extra!.body['note'], '本机备注不丢');
      expect(extra.body['activityId'], item.activity.id);
      expect(extra.body['participantIds'], [testActorId]);
    });

    test('首次登录家庭会把本机成长与书架操作连同 operationId 迁入真实范围', () async {
      final current = store!;
      const localFamily = 'demo-family';
      const localChild = 'demo-child';
      final growth = await current.saveGrowthRecord(
        familyId: localFamily,
        childId: localChild,
        type: GrowthRecordType.quote,
        localDate: testDate,
        text: '“还要”',
        now: testNow,
      );
      await current.saveFamilyBook(
        familyId: localFamily,
        title: '家里的小书',
        language: '中文',
        note: '',
      );
      final growthOperation = await current.claimNext(
        localFamily,
        testNow,
        objectPrefixes: const {'growth:'},
      );
      expect(growthOperation!.id, isNotEmpty);

      final migrated = await current.migrateLocalPreviewData(
        fromFamilyId: localFamily,
        fromChildId: localChild,
        toFamilyId: testFamilyId,
        toChildId: testChildId,
      );
      expect(migrated, 2);
      expect(await current.pendingCount(localFamily), 0);
      expect(await current.pendingCount(testFamilyId), 2);
      expect(
        (await current.readGrowthRecords(testFamilyId, testChildId)).single.id,
        growth.id,
      );
      final retriedGrowth = await current.claimNext(
        testFamilyId,
        testNow,
        objectPrefixes: const {'growth:'},
      );
      expect(retriedGrowth!.id, growthOperation.id);
      expect(retriedGrowth.path, '/children/$testChildId/memories');
      final book = await current.claimNext(
        testFamilyId,
        testNow,
        objectPrefixes: const {'book:'},
      );
      expect(book!.path, '/families/$testFamilyId/books');
    });

    test('已同步记录编辑后撤销，会保留远端记录的 DELETE outbox', () async {
      final current = store!;
      await current.cachePlan(testFamilyId, testPlan());
      final item = testPlan().items.first;
      ParticipationInput input(String note) => ParticipationInput(
        status: ParticipationStatus.played,
        participantIds: const [testActorId],
        note: note,
      );
      final firstOperation = await current.saveParticipation(
        familyId: testFamilyId,
        actorId: testActorId,
        itemId: item.id,
        input: input('第一次'),
        now: testNow,
      );
      await current.claimNext(testFamilyId, testNow);
      await current.acknowledge(testFamilyId, firstOperation, {
        'id': 'participation-test',
        'planItemId': item.id,
        'status': 'played',
        'participantIds': [testActorId],
        'notes': <Object>[],
        'actualMinutes': null,
        'again': false,
        'addedBy': testActorId,
        'revision': 1,
      });

      await current.saveParticipation(
        familyId: testFamilyId,
        actorId: testActorId,
        itemId: item.id,
        input: input('编辑后撤销'),
        now: testNow,
      );
      await current.undoParticipation(
        familyId: testFamilyId,
        itemId: item.id,
        now: testNow,
      );

      expect(await current.readParticipations(testFamilyId), isEmpty);
      final deletion = await current.claimNext(
        testFamilyId,
        testNow,
        objectPrefixes: const {'participation:'},
      );
      expect(deletion!.method, 'DELETE');
      expect(deletion.body['baseRevision'], 1);
    });
  });
}
