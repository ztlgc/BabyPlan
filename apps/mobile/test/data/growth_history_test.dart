import 'dart:convert';
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

  late Directory temporary;
  late LocalStore store;

  setUp(() async {
    temporary = await createTempDirectory();
    store = await openStore('${temporary.path}/babyplan.db');
  });

  tearDown(() async {
    await store.close();
    await temporary.delete(recursive: true);
  });

  test('成长记录更正、回收、恢复都先写入本机 outbox，再用服务修订确认', () async {
    await store.cacheRemoteGrowthSnapshot(
      familyId: testFamilyId,
      childId: testChildId,
      memories: [_memory('memory-1', '原来的原话')],
      measurements: [_measurement('measurement-1')],
      observations: [_observation('observation-1')],
    );

    final memory = (await store.readGrowthRecord(
      testFamilyId,
      testChildId,
      'memory-1',
    ))!;
    await store.updateGrowthRecord(
      familyId: testFamilyId,
      childId: testChildId,
      recordId: memory.id,
      type: memory.type,
      localDate: memory.localDate,
      text: '更正后的原话',
      remote: true,
      firstConfirmed: false,
      now: testNow,
    );
    final update = (await store.claimNext(testFamilyId, testNow))!;
    expect(update.objectKey, 'growth-update:memory-1');
    expect(update.method, 'PATCH');
    expect(update.path, '/memories/memory-1');
    expect(update.body['baseRevision'], 1);
    await store.acknowledge(testFamilyId, update.id, {
      ..._memory('memory-1', '更正后的原话'),
      'revision': 2,
    });
    final corrected = (await store.readGrowthRecord(
      testFamilyId,
      testChildId,
      'memory-1',
    ))!;
    expect(corrected.text, '更正后的原话');
    expect(corrected.syncState, 'synced');
    expect(corrected.serverRevision, 2);

    final measurement = (await store.readGrowthRecord(
      testFamilyId,
      testChildId,
      'measurement-1',
    ))!;
    await store.deleteGrowthRecord(
      familyId: testFamilyId,
      childId: testChildId,
      record: measurement,
      remote: true,
      now: testNow,
    );
    expect(
      await store.readGrowthRecord(testFamilyId, testChildId, measurement.id),
      isNull,
    );
    expect(
      (await store.readDeletedGrowthRecords(
        testFamilyId,
        testChildId,
      )).map((record) => record.id),
      contains(measurement.id),
    );
    final deletion = (await store.claimNext(testFamilyId, testNow))!;
    expect(deletion.objectKey, 'growth-delete:measurement-1');
    expect(deletion.method, 'DELETE');
    expect(deletion.path, '/measurements/measurement-1');
    expect(deletion.body['permanent'], isNull);
    await store.acknowledge(testFamilyId, deletion.id, {
      'id': measurement.id,
      'revision': 2,
    });

    final deleted = (await store.readDeletedGrowthRecords(
      testFamilyId,
      testChildId,
    )).singleWhere((record) => record.id == measurement.id);
    expect(deleted.serverRevision, 2);
    expect(deleted.deletedAt, isNotNull);
    await store.restoreGrowthRecord(
      familyId: testFamilyId,
      childId: testChildId,
      record: deleted,
      remote: true,
      now: testNow,
    );
    final restore = (await store.claimNext(testFamilyId, testNow))!;
    expect(restore.objectKey, 'growth-restore:measurement-1');
    expect(restore.method, 'POST');
    expect(restore.path, '/measurements/measurement-1/restore');
    expect(restore.body['baseRevision'], 2);
    await store.acknowledge(testFamilyId, restore.id, {
      ..._measurement('measurement-1'),
      'revision': 3,
    });
    expect(
      (await store.readGrowthRecord(
        testFamilyId,
        testChildId,
        measurement.id,
      ))?.deletedAt,
      isNull,
    );
    expect(await store.pendingCount(testFamilyId), 0);
  });

  test('旧版墓碑没有删除时间时仍进入回收站，并在重启后保持同一时间', () async {
    await store.close();
    final path = '${temporary.path}/legacy-v6.db';
    final legacy = await databaseFactoryFfi.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: 6,
        onCreate: (db, version) async {
          await db.execute('''CREATE TABLE growth_records (
            family_id TEXT NOT NULL, child_id TEXT NOT NULL, id TEXT NOT NULL,
            local_date TEXT NOT NULL, body_json TEXT NOT NULL,
            remote_deleted INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(family_id, child_id, id))''');
          await db.execute('''CREATE TABLE drafts (
            family_id TEXT NOT NULL, owner_id TEXT NOT NULL,
            draft_key TEXT NOT NULL, body_json TEXT NOT NULL,
            PRIMARY KEY(family_id, owner_id, draft_key))''');
        },
      ),
    );
    await legacy.insert('growth_records', {
      'family_id': testFamilyId,
      'child_id': testChildId,
      'id': 'legacy-tombstone',
      'local_date': testDate.toString(),
      'remote_deleted': 1,
      'body_json': jsonEncode({
        'id': 'legacy-tombstone',
        'localDate': testDate.toString(),
        'createdAt': '${testDate}T00:00:00.000Z',
        'type': 'quote',
        'text': '升级后仍然可以找回的原话',
        'firstConfirmed': false,
        'mediaIds': <String>[],
        'syncState': 'synced',
        'serverRevision': 2,
        'deletedAt': null,
      }),
    });
    await legacy.close();

    store = await openStore(path);
    final firstRead = (await store.readDeletedGrowthRecords(
      testFamilyId,
      testChildId,
    )).single;
    expect(firstRead.id, 'legacy-tombstone');
    expect(firstRead.serverRevision, 2);
    expect(firstRead.deletedAt, isNotNull);

    await store.close();
    store = await openStore(path);
    final secondRead = (await store.readDeletedGrowthRecords(
      testFamilyId,
      testChildId,
    )).single;
    expect(secondRead.deletedAt, firstRead.deletedAt);
  });

  test('待同步草稿导出只包含当前家长且不包含会话凭证', () async {
    await store.saveDraft(testFamilyId, testActorId, 'growth-editor', {
      'text': '我的待同步文字',
    });
    await store.saveDraft(testFamilyId, 'another-parent', 'growth-editor', {
      'text': '另一位家长的私有文字',
    });
    await store.saveGrowthRecord(
      familyId: testFamilyId,
      childId: testChildId,
      type: GrowthRecordType.story,
      localDate: testDate,
      text: '尚未同步的故事',
      recordId: 'pending-growth',
      now: testNow,
    );

    final exported = await store.exportPendingDrafts(testFamilyId, testActorId);
    final drafts = (exported['drafts'] as List).cast<Map>();
    expect(drafts, hasLength(1));
    expect(drafts.single['key'], 'growth-editor');
    expect((drafts.single['body'] as Map)['text'], '我的待同步文字');
    expect(
      (exported['pendingOperations'] as List).where(
        (item) => (item as Map)['objectKey'] == 'growth:pending-growth',
      ),
      hasLength(1),
    );
    expect(exported.toString(), isNot(contains('accessToken')));
    expect(exported.toString(), isNot(contains('refreshToken')));
  });
}

Map<String, dynamic> _memory(String id, String text) => {
  'id': id,
  'childId': testChildId,
  'localDate': testDate.toString(),
  'type': 'quote',
  'text': text,
  'firstConfirmed': false,
  'mediaIds': <String>[],
  'addedBy': testActorId,
  'revision': 1,
  'deletedAt': null,
};

Map<String, dynamic> _measurement(String id) => {
  'id': id,
  'childId': testChildId,
  'localDate': testDate.toString(),
  'kind': 'height',
  'value': 82.4,
  'unit': 'cm',
  'method': 'recumbent',
  'source': 'home',
  'addedBy': testActorId,
  'revision': 1,
  'deletedAt': null,
};

Map<String, dynamic> _observation(String id) => {
  'id': id,
  'childId': testChildId,
  'localDate': testDate.toString(),
  'guideId': 'stage-18-23-language',
  'value': 'noticed',
  'note': '会主动递绘本',
  'addedBy': testActorId,
  'revision': 1,
  'deletedAt': null,
};
