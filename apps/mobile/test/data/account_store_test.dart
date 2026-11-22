import 'dart:io';

import 'package:babyplan/data/local_store.dart';
import 'package:babyplan/domain/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../support/test_support.dart';

final _service = Uri.parse('https://family.example/v2');
final _otherService = Uri.parse('https://family.example/another/v2');
const _parentA = '00000000-0000-4000-8000-000000000011';
const _parentB = '00000000-0000-4000-8000-000000000012';
const _draftKey = 'growth-editor';
const _photo = PreparedGrowthPhoto(
  localPath: '/private-growth/sample.jpg',
  mime: 'image/jpeg',
  byteSize: 128,
  sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
);

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    initializeTestTimezones();
  });

  late Directory temporary;
  late String rootPath;
  late LocalStore root;
  late List<LocalStore> handles;

  setUp(() async {
    temporary = await createTempDirectory();
    rootPath = p.join(temporary.path, 'babyplan.db');
    root = await openStore(rootPath);
    handles = [root];
  });

  tearDown(() async {
    for (final handle in handles.reversed) {
      await handle.close();
    }
    await temporary.delete(recursive: true);
  });

  Future<void> close(LocalStore handle) async {
    handles.remove(handle);
    await handle.close();
  }

  Future<LocalStore> account(Uri service, String actor) async {
    final store = await root.openAccountStore(service, actor);
    handles.add(store);
    return store;
  }

  // 用当前工具生成旧版数据，再让 SQLite 走真实的 v6 → v7 升级。
  Future<void> openAsUpgrade({String? unknownAttemptId}) async {
    await close(root);
    final old = await databaseFactoryFfi.openDatabase(rootPath);
    try {
      await old.execute('DROP TABLE IF EXISTS account_migrations');
      await old.execute('DROP TABLE IF EXISTS legacy_scope_owners');
      if (unknownAttemptId != null) {
        await old.update(
          'outbox',
          {'created_at': 0},
          where: 'operation_id=?',
          whereArgs: [unknownAttemptId],
        );
      }
      await old.setVersion(6);
    } finally {
      await old.close();
    }
    root = await openStore(rootPath);
    handles.add(root);
  }

  test('同一服务不同账号、同一账号不同服务的草稿与游标互不相通', () async {
    var parentA = await account(_service, _parentA);
    await parentA.applyFamilySnapshot(
      familyId: testFamilyId,
      expectedCursor: null,
      expectedWriteVersion: 0,
      snapshot: FamilySnapshotData(
        cursor: 'parent-a-cursor',
        snapshotId: 'snapshot-a',
        days: [testPlan().json],
        memories: const [],
        measurements: const [],
        observations: const [],
      ),
      isCurrent: () => true,
    );
    await _saveNote(parentA, 'pending-a', photos: const [_photo]);
    await parentA.saveDraft(testFamilyId, _parentA, _draftKey, {
      'text': '只有这位家长能看见的草稿',
    });
    await parentA.savePreferences(
      testFamilyId,
      const FamilyPreferences(reminderEnabled: true, reminderTime: '17:20'),
    );
    final parentB = await account(_service, _parentB);
    final otherServer = await account(_otherService, _parentA);
    for (final store in [root, parentB, otherServer]) {
      expect(await store.readCursor(testFamilyId), isNull);
      expect(await store.readPlan(testFamilyId, testChildId, testDate), isNull);
      expect(await store.readGrowthRecords(testFamilyId, testChildId), isEmpty);
      expect(await store.readGrowthPhotos(testFamilyId), isEmpty);
      expect(await store.readDraft(testFamilyId, _parentA, _draftKey), isNull);
      expect(await store.claimNext(testFamilyId, testNow), isNull);
      expect(
        (await store.readPreferences(testFamilyId)).reminderEnabled,
        isFalse,
      );
    }

    // 同一个账号重新启动，仍能打开旧文件并继续未完成的操作。
    await close(parentA);
    await close(root);
    root = await openStore(rootPath);
    handles.add(root);
    parentA = await account(_service, _parentA);
    expect(await parentA.readCursor(testFamilyId), 'parent-a-cursor');
    expect(
      (await parentA.readPlan(testFamilyId, testChildId, testDate))?.id,
      testPlan().id,
    );
    expect(
      (await parentA.readGrowthPhotos(testFamilyId)).single.localPath,
      _photo.localPath,
    );
    expect(
      (await parentA.readDraft(testFamilyId, _parentA, _draftKey))?['text'],
      '只有这位家长能看见的草稿',
    );
    expect(
      (await parentA.claimNext(testFamilyId, testNow))?.body['id'],
      'pending-a',
    );
    expect((await parentA.readPreferences(testFamilyId)).reminderTime, '17:20');
  });

  test('旧库只由有唯一归属的原账号认领，未确认操作不会换人重放', () async {
    await _authorizeLegacy(root, _service, _parentA);
    final plan = testPlan();
    await root.cachePlan(testFamilyId, plan);
    final first = plan.items[0];
    final second = plan.items[1];
    final third = plan.items[2];

    Future<String> record(PlanItem item, String actor, String note) =>
        root.saveParticipation(
          familyId: testFamilyId,
          actorId: actor,
          itemId: item.id,
          input: ParticipationInput(
            status: ParticipationStatus.played,
            participantIds: [actor],
            note: note,
          ),
          now: testNow,
        );

    // 另一位家长的请求先进入发送队列；之后原账号又编辑了同一项。
    final otherOperation = await record(first, _parentB, '另一账号的私有备注');
    expect((await root.claimNext(testFamilyId, testNow))?.id, otherOperation);
    final originalOperation = await record(first, _parentA, '原账号的更新');
    final attempted = await record(second, _parentA, '旧版发送时间不明的备注');
    expect((await root.claimNext(testFamilyId, testNow))?.id, attempted);
    await record(third, _parentB, '另一账号的另一条备注');
    final sessionId = await root.saveExtraPlay(
      familyId: testFamilyId,
      childId: testChildId,
      actorId: _parentA,
      item: first,
      localDate: testDate,
      participantIds: [_parentA],
      note: '原账号想再玩一次',
      now: testNow,
    );
    await _saveNote(root, 'ownerless-note', photos: const [_photo]);
    await root.saveDraft(testFamilyId, _parentA, _draftKey, {'text': '升级前的原话'});
    await root.saveDraft(testFamilyId, _parentB, _draftKey, {
      'text': '另一账号的草稿',
    });
    await openAsUpgrade(unknownAttemptId: attempted);

    for (final (service, user) in [
      (_otherService, _parentA),
      (_service, _parentB),
    ]) {
      final wrong = await account(service, user);
      await wrong.adoptLegacyAccountData(
        source: root,
        service: service,
        userId: user,
        familyId: testFamilyId,
      );
      expect(await wrong.readGrowthRecords(testFamilyId, testChildId), isEmpty);
      expect(await wrong.readParticipations(testFamilyId), isEmpty);
      expect(await wrong.pendingCount(testFamilyId), 0);
    }

    final original = await account(_service, _parentA);
    Future<void> adopt() => original.adoptLegacyAccountData(
      source: root,
      service: _service,
      userId: _parentA,
      familyId: testFamilyId,
    );
    await adopt();
    final participations = await original.readParticipations(testFamilyId);
    expect(participations.keys, unorderedEquals([first.id, second.id]));
    expect(participations[first.id]?.note, '原账号的更新');
    expect(
      await original.readGrowthRecords(testFamilyId, testChildId),
      isEmpty,
    );
    expect(await original.readGrowthPhotos(testFamilyId), isEmpty);
    expect(
      (await root.readGrowthRecords(testFamilyId, testChildId)).single.id,
      'ownerless-note',
    );
    expect(
      (await root.readGrowthPhotos(testFamilyId)).single.localPath,
      _photo.localPath,
    );
    expect(
      (await original.readDraft(testFamilyId, _parentA, _draftKey))?['text'],
      '升级前的原话',
    );
    expect(await original.readDraft(testFamilyId, _parentB, _draftKey), isNull);
    await original.recoverInterrupted(testFamilyId);
    final next = (await original.claimNext(testFamilyId, testNow))!;
    expect(next.id, originalOperation);
    expect(next.body['note'], '原账号的更新');
    expect(
      (await original.readSyncIssues(testFamilyId))
          .map((entry) => (entry.operationId, entry.code)),
      [(attempted, 'OPERATION_EXPIRED')],
    );
    await original.acknowledge(testFamilyId, next.id, {
      'id': 'remote-participation',
      'planItemId': first.id,
      'revision': 1,
    });
    final session = (await original.claimNext(testFamilyId, testNow))!;
    expect(session.body['id'], sessionId);
    expect(session.body['note'], '原账号想再玩一次');
    await original.acknowledge(testFamilyId, session.id, {
      'id': sessionId,
      'revision': 1,
    });
    await adopt();
    expect(await original.pendingCount(testFamilyId), 1);
    expect(await original.claimNext(testFamilyId, testNow), isNull);
  });

  test('归属有歧义或没有旧授权时，任何新登录都不会认领旧内容', () async {
    const ambiguousFamily = 'ambiguous-family';
    await _authorizeLegacy(root, _service, _parentA, familyId: ambiguousFamily);
    await _authorizeLegacy(root, _service, _parentB, familyId: ambiguousFamily);
    await _saveNote(root, 'ambiguous', familyId: ambiguousFamily);
    await _saveNote(root, 'unowned');
    await openAsUpgrade();

    for (final (actor, familyId) in [
      (_parentA, ambiguousFamily),
      (_parentB, ambiguousFamily),
      (_parentB, testFamilyId),
    ]) {
      await _authorizeLegacy(root, _service, actor, familyId: familyId);
      final store = await account(_service, actor);
      await store.adoptLegacyAccountData(
        source: root,
        service: _service,
        userId: actor,
        familyId: familyId,
      );
      expect(await store.readGrowthRecords(familyId, testChildId), isEmpty);
      expect(await store.claimNext(familyId, testNow), isNull);
      await close(store);
    }
    expect(
      (await root.readGrowthRecords(ambiguousFamily, testChildId)).single.id,
      'ambiguous',
    );
    expect(
      (await root.readGrowthRecords(testFamilyId, testChildId)).single.id,
      'unowned',
    );
  });

  test('本机试用记录只迁入一个账号，保留原操作和照片', () async {
    const demoFamily = 'demo-family';
    const demoChild = 'demo-child';
    await _saveNote(
      root,
      'demo-note',
      familyId: demoFamily,
      childId: demoChild,
      photos: const [_photo],
    );
    final original = (await root.claimNext(demoFamily, testNow))!;
    await root.releaseClaim(demoFamily, original.id);
    final first = await account(_service, _parentA);
    Future<void> adopt(LocalStore store) => store.adoptLocalPreviewData(
      source: root,
      familyId: testFamilyId,
      childId: testChildId,
    );
    await adopt(first);
    await adopt(first);
    final next = (await first.claimNext(testFamilyId, testNow))!;
    expect(next.id, original.id);
    expect(next.path, '/children/$testChildId/memories');
    expect(next.body, original.body);
    final copied = (await first.readGrowthPhotos(testFamilyId)).single;
    expect(copied.memoryId, 'demo-note');
    expect(copied.localPath, _photo.localPath);
    expect(await root.readGrowthRecords(demoFamily, demoChild), isEmpty);
    expect(await root.readGrowthPhotos(demoFamily), isEmpty);
    expect(await root.pendingCount(demoFamily), 0);

    final second = await account(_service, _parentB);
    await adopt(second);
    expect(await second.readGrowthRecords(testFamilyId, testChildId), isEmpty);
    expect(await second.readGrowthPhotos(testFamilyId), isEmpty);
    expect(await second.claimNext(testFamilyId, testNow), isNull);
  });
}

Future<void> _authorizeLegacy(
  LocalStore store,
  Uri service,
  String actor, {
  String familyId = testFamilyId,
}) => store.saveDraft(
  'account-scope',
  actor,
  'authorized-family:$service',
  AccountBootstrap(
    userId: actor,
    families: [
      FamilySummary(
        id: familyId,
        name: '测试家庭',
        timezone: 'Asia/Shanghai',
        revision: 1,
      ),
    ],
    children: [
      ChildSummary(
        id: testChildId,
        familyId: familyId,
        ageMode: 'months',
        revision: 1,
        ageMonths: 18,
        ageAsOf: testDate,
      ),
    ],
  ).toJson(),
);

Future<GrowthRecord> _saveNote(
  LocalStore store,
  String id, {
  String familyId = testFamilyId,
  String childId = testChildId,
  List<PreparedGrowthPhoto> photos = const [],
}) => store.saveGrowthRecord(
  familyId: familyId,
  childId: childId,
  type: GrowthRecordType.story,
  localDate: testDate,
  text: '本机待同步的小记',
  recordId: id,
  photos: photos,
  now: testNow,
);
