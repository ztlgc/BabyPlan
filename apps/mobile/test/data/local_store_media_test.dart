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

  group('成长照片持久化', () {
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

    test('旧版升级保留正文、照片和未确认操作，并补齐关联 operationId', () async {
      await store!.close();
      await databaseFactoryFfi.deleteDatabase(databasePath);
      final old = await databaseFactoryFfi.openDatabase(
        databasePath,
        options: OpenDatabaseOptions(
          version: 4,
          onCreate: (db, version) async {
            await db.execute(
              '''CREATE TABLE day_plans (
              family_id TEXT NOT NULL, id TEXT NOT NULL, child_id TEXT NOT NULL,
              local_date TEXT NOT NULL, timezone TEXT NOT NULL, revision INTEGER NOT NULL,
              body_json TEXT NOT NULL, PRIMARY KEY(family_id,id), UNIQUE(family_id,child_id,local_date))''',
            );
            await db.execute('''CREATE TABLE outbox (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
              family_id TEXT NOT NULL, object_key TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
              body_json TEXT NOT NULL, local_version INTEGER NOT NULL, state TEXT NOT NULL,
              attempts INTEGER NOT NULL DEFAULT 0, result_json TEXT, error_code TEXT,
              retry_after INTEGER NOT NULL DEFAULT 0)''');
            await db.execute(
              '''CREATE TABLE drafts (
              family_id TEXT NOT NULL, owner_id TEXT NOT NULL, draft_key TEXT NOT NULL,
              body_json TEXT NOT NULL, PRIMARY KEY(family_id,owner_id,draft_key))''',
            );
            await db.execute('''CREATE TABLE growth_records (
              family_id TEXT NOT NULL, child_id TEXT NOT NULL, id TEXT NOT NULL,
              local_date TEXT NOT NULL, body_json TEXT NOT NULL,
              PRIMARY KEY(family_id, child_id, id))''');
            await db.execute('''CREATE TABLE growth_media (
              family_id TEXT NOT NULL, child_id TEXT NOT NULL, memory_id TEXT NOT NULL,
              id TEXT NOT NULL, local_path TEXT NOT NULL, mime TEXT NOT NULL,
              byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL,
              create_operation_id TEXT NOT NULL, complete_operation_id TEXT NOT NULL,
              server_media_id TEXT, upload_url TEXT, upload_expires_at INTEGER,
              state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              PRIMARY KEY(family_id, id))''');
          },
        ),
      );
      final record = GrowthRecord(
        id: 'memory-v4',
        type: GrowthRecordType.quote,
        localDate: testDate,
        text: '升级前已经写下的原话',
        createdAt: testNow.toUtc(),
        syncState: 'local_pending',
      );
      await old.insert('growth_records', {
        'family_id': testFamilyId,
        'child_id': testChildId,
        'id': record.id,
        'local_date': testDate.toString(),
        'body_json': jsonEncode(record.toJson()),
      });
      await old.insert('growth_media', {
        'family_id': testFamilyId,
        'child_id': testChildId,
        'memory_id': record.id,
        'id': 'photo-v4',
        'local_path': '/private/photo.jpg',
        'mime': 'image/jpeg',
        'byte_size': 128,
        'sha256': List.filled(64, 'a').join(),
        'create_operation_id': 'create-before-upgrade',
        'complete_operation_id': 'complete-before-upgrade',
        'state': 'upload_failed',
        'attempts': 2,
        'created_at': testNow.millisecondsSinceEpoch,
        'updated_at': testNow.millisecondsSinceEpoch,
      });
      for (final (id, attempts) in [
        ('never-sent', 0),
        ('already-attempted', 1),
      ]) {
        await old.insert('outbox', {
          'operation_id': id,
          'family_id': testFamilyId,
          'object_key': 'growth:$id',
          'method': 'POST',
          'path': '/children/$testChildId/memories',
          'body_json': jsonEncode({'operationId': id, 'text': '升级前未确认的内容'}),
          'local_version': 1,
          'state': attempts == 0 ? 'pending' : 'sending',
          'attempts': attempts,
        });
      }
      await old.close();

      store = await openStore(databasePath);
      final restoredRecord = await store!.readGrowthRecord(
        testFamilyId,
        testChildId,
        record.id,
      );
      final restoredPhoto = (await store!.readGrowthPhotos(
        testFamilyId,
        memoryId: record.id,
      )).single;

      expect(restoredRecord?.text, '升级前已经写下的原话');
      expect(restoredPhoto.state, 'upload_failed');
      expect(restoredPhoto.createOperationId, 'create-before-upgrade');
      expect(restoredPhoto.completeOperationId, 'complete-before-upgrade');
      expect(restoredPhoto.linkOperationId, 'photo-v4');
      await store!.recoverInterrupted(testFamilyId);
      final claim = await store!.claimNext(testFamilyId, DateTime.now());
      expect(claim?.id, 'never-sent');
      expect(claim?.body['text'], '升级前未确认的内容');
      expect(
        (await store!.readSyncIssues(testFamilyId)).single.code,
        'OPERATION_EXPIRED',
      );
      expect(await store!.pendingCount(testFamilyId), 2);
    });

    test('正文与照片分开保存，重复摘要只登记一次且重启后仍可恢复', () async {
      final record = await store!.saveGrowthRecord(
        familyId: testFamilyId,
        childId: testChildId,
        type: GrowthRecordType.story,
        localDate: testDate,
        text: '正文先保存',
        now: testNow,
      );
      final photo = PreparedGrowthPhoto(
        localPath: '/private/photo.jpg',
        mime: 'image/jpeg',
        byteSize: 321,
        sha256: List.filled(64, 'b').join(),
      );
      await store!.attachGrowthPhotos(
        familyId: testFamilyId,
        childId: testChildId,
        memoryId: record.id,
        photos: [photo, photo],
        now: testNow,
      );

      await store!.close();
      store = await openStore(databasePath);

      expect(
        (await store!.readGrowthRecord(
          testFamilyId,
          testChildId,
          record.id,
        ))?.text,
        '正文先保存',
      );
      final photos = await store!.readGrowthPhotos(
        testFamilyId,
        memoryId: record.id,
      );
      expect(photos, hasLength(1));
      expect(photos.single.localPath, '/private/photo.jpg');
      expect(photos.single.linkOperationId, isNotEmpty);
      expect(photos.single.createOperationId, isNotEmpty);
      expect(photos.single.completeOperationId, isNotEmpty);
    });

    test('远端成长历史整批合并，待同步本机记录不被覆盖', () async {
      final pending = await store!.saveGrowthRecord(
        familyId: testFamilyId,
        childId: testChildId,
        type: GrowthRecordType.quote,
        localDate: testDate,
        text: '本机还没同步',
        recordId: 'same-id',
        now: testNow,
      );
      expect(pending.syncState, 'local_pending');

      await store!.cacheRemoteGrowthSnapshot(
        familyId: testFamilyId,
        childId: testChildId,
        memories: [
          {
            'id': 'remote-memory',
            'childId': testChildId,
            'type': 'story',
            'localDate': testDate.toString(),
            'text': '第二台手机看到的历史',
            'firstConfirmed': false,
            'revision': 3,
            'mediaIds': ['media-ready'],
          },
          {
            'id': 'same-id',
            'childId': testChildId,
            'type': 'quote',
            'localDate': testDate.toString(),
            'text': '不应覆盖本机',
            'firstConfirmed': false,
            'revision': 5,
            'mediaIds': <String>[],
          },
        ],
        measurements: [
          {
            'id': 'measurement-1',
            'childId': testChildId,
            'localDate': testDate.toString(),
            'value': 10.2,
            'unit': 'kg',
            'revision': 1,
          },
          {
            'id': 'sibling-measurement',
            'childId': 'sibling-child',
            'localDate': testDate.toString(),
            'value': 12.0,
            'unit': 'kg',
            'revision': 1,
          },
        ],
        observations: const [],
      );

      final records = await store!.readGrowthRecords(testFamilyId, testChildId);
      expect(records, hasLength(3));
      expect(
        records.singleWhere((record) => record.id == 'same-id').text,
        '本机还没同步',
      );
      expect(
        records.singleWhere((record) => record.id == 'remote-memory').text,
        '第二台手机看到的历史',
      );
      expect(
        records.singleWhere((record) => record.id == 'measurement-1').type,
        GrowthRecordType.measurement,
      );
    });

    test('离线换项只接受完整缓存且未撤回的候选，并持久化 outbox', () async {
      await store!.cachePlan(testFamilyId, testPlan());
      final item = testPlan().items.first;
      final candidate = _replacementActivity();

      await expectLater(
        store!.replacePlanItem(
          familyId: testFamilyId,
          childId: testChildId,
          planId: 'plan-test',
          itemId: item.id,
          activity: candidate,
          now: testNow,
        ),
        throwsA(isA<StateError>()),
      );

      await store!.cacheContentOptions([candidate]);
      final replaced = await store!.replacePlanItem(
        familyId: testFamilyId,
        childId: testChildId,
        planId: 'plan-test',
        itemId: item.id,
        activity: candidate,
        now: testNow,
      );
      final operation = await store!.claimNext(
        testFamilyId,
        testNow,
        objectPrefixes: const {'replace:'},
      );

      expect(replaced.activity.id, candidate.id);
      expect(operation?.path, '/plan-items/${item.id}/replace');
      expect(operation?.body['activityRevision'], candidate.revision);
      expect(operation?.body['baseRevision'], item.revision);
    });
  });
}

Activity _replacementActivity() => Activity.fromJson({
  'id': 'replacement-card',
  'title': '纸盒藏一藏',
  'kind': 'explore',
  'support': '把熟悉的小物藏进纸盒，再一起找出来。',
  'revision': 2,
  'reviewState': 'reviewed',
  'ageBands': ['m18_23'],
  'sourceIds': ['test-source'],
  'materials': ['积木'],
  'steps': ['把积木放进纸盒', '请宝宝打开'],
  'dialogue': {
    'opening': '藏好啦',
    'engaged': '在哪里呢',
    'observing': '你在找',
    'stopping': '找到了',
  },
  'english': {'phrase': 'Where is it?', 'meaning': '在哪里？', 'when': '寻找时'},
  'safety': '纸盒要透气，并由家长陪在旁边。',
  'easier': '只藏一个。',
  'next': '换成两个纸盒。',
  'withdrawn': false,
});
