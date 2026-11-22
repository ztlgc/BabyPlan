import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:babyplan/data/api_client.dart';
import 'package:babyplan/data/family_sync_repository.dart';
import 'package:babyplan/data/local_store.dart';
import 'package:babyplan/domain/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../support/test_support.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    initializeTestTimezones();
  });

  late Directory directory;
  late String databasePath;
  late LocalStore store;
  setUp(() async {
    directory = await createTempDirectory();
    databasePath = '${directory.path}${Platform.pathSeparator}sync.db';
    store = await openStore(databasePath);
  });
  tearDown(() async {
    await store.close();
    await directory.delete(recursive: true);
  });

  BabyPlanApi api(FutureOr<http.Response> Function(http.Request) handler) {
    final client = MockClient((request) async => handler(request));
    addTearDown(client.close);
    return BabyPlanApi(
      baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
      vault: MemoryTokenVault()..session = sampleSession(),
      client: client,
    );
  }

  Future<void> pull(BabyPlanApi remote) => FamilySyncRepository(
    local: store,
    service: remote,
  ).pull(testFamilyId, isCurrent: () => true);

  test('保存一整页后才前进，下一页中途出错会整页回滚，重开继续', () async {
    final cursors = <String?>[];
    var badPage = true;
    final remote = api((request) {
      if (request.url.path.endsWith('/snapshot')) return _ok(_snapshot());
      final cursor = request.url.queryParameters['cursor'];
      cursors.add(cursor);
      if (cursor == 'initial') {
        return _ok(
          _page('first', [
            _change(11, 'memory', _memory('first-page', '已经同步')),
          ], hasMore: true),
        );
      }
      expect(cursor, 'first');
      return _ok(
        _page('second', [
          _change(12, 'memory', _memory('second-page', '这页的第一条')),
          _change(13, 'memory', {
            ..._memory('last-row', '这页的第二条'),
            if (badPage) 'localDate': '损坏的日期',
          }),
        ]),
      );
    });
    await pull(remote);
    await expectLater(pull(remote), throwsFormatException);
    await store.close();
    store = await openStore(databasePath);
    expect(await store.readCursor(testFamilyId), 'first');
    expect(
      (await store.readGrowthRecords(
        testFamilyId,
        testChildId,
      )).map((record) => record.id),
      ['first-page'],
    );
    badPage = false;
    await pull(remote);
    expect(cursors, ['initial', 'first', 'first']);
    expect(await store.readCursor(testFamilyId), 'second');
    expect(
      (await store.readGrowthRecords(
        testFamilyId,
        testChildId,
      )).map((record) => record.id),
      unorderedEquals(['first-page', 'second-page', 'last-row']),
    );
  });

  test('远端更新和删除照片保留待上传照片；过期快照保留本机文字、照片与草稿', () async {
    const localPhoto = PreparedGrowthPhoto(
      localPath: '/private/pending.jpg',
      mime: 'image/jpeg',
      byteSize: 28,
      sha256: 'pending-photo',
    );
    const syncedPhoto = PreparedGrowthPhoto(
      localPath: '/private/linked.jpg',
      mime: 'image/jpeg',
      byteSize: 28,
      sha256: 'linked-photo',
    );
    var calls = 0;
    var snapshotReads = 0;
    final remote = api((request) {
      if (request.url.path.endsWith('/snapshot')) {
        snapshotReads++;
        return _ok(
          snapshotReads == 1
              ? _snapshot(
                  memories: [
                    _memory('shared', '旧内容', mediaIds: ['remote-photo']),
                  ],
                  media: [_photo('remote-photo', 'shared')],
                )
              : _snapshot(
                  cursor: 'rebuilt',
                  memories: [_memory('shared', '重建后的正文', revision: 3)],
                ),
        );
      }
      if (++calls == 1) {
        return _ok(
          _page('first', [
            _change(
              1,
              'memory',
              _memory(
                'shared',
                '另一位家长更新了正文',
                revision: 2,
                mediaIds: ['remote-photo'],
              ),
            ),
            _deleted(2, 'media', 'remote-photo', 3),
          ]),
        );
      }
      return _response({'code': 'CURSOR_EXPIRED', 'message': '从快照重新开始'}, 410);
    });
    await pull(remote);
    await store.attachGrowthPhotos(
      familyId: testFamilyId,
      childId: testChildId,
      memoryId: 'shared',
      photos: [localPhoto, syncedPhoto],
      now: testNow,
    );
    final linked = (await store.readGrowthPhotos(
      testFamilyId,
      memoryId: 'shared',
    )).singleWhere((entry) => entry.localPath == syncedPhoto.localPath);
    await store.updateGrowthPhoto(
      linked.copyWith(serverMediaId: 'remote-photo', state: 'linked'),
    );
    await store.saveGrowthRecord(
      familyId: testFamilyId,
      childId: testChildId,
      type: GrowthRecordType.story,
      localDate: testDate,
      text: '断网时写下的原文',
      recordId: 'my-record',
      now: testNow,
    );
    await store.saveDraft(testFamilyId, testActorId, 'growth-editor', {
      'text': '未提交的另一段原话',
    });
    await pull(remote);
    final shared = (await store.readGrowthRecord(
      testFamilyId,
      testChildId,
      'shared',
    ))!;
    expect(shared.text, '另一位家长更新了正文');
    expect(shared.mediaIds, isEmpty);
    expect(await store.readRetiredGrowthFiles(), [syncedPhoto.localPath]);
    await pull(remote);
    expect(await store.readCursor(testFamilyId), 'rebuilt');
    expect(
      (await store.readGrowthRecord(testFamilyId, testChildId, 'shared'))!.text,
      '重建后的正文',
    );
    expect(
      (await store.readGrowthRecord(
        testFamilyId,
        testChildId,
        'my-record',
      ))!.text,
      '断网时写下的原文',
    );
    expect(
      (await store.readGrowthPhotos(
        testFamilyId,
        memoryId: 'shared',
      )).single.localPath,
      localPhoto.localPath,
    );
    expect(
      (await store.readDraft(
        testFamilyId,
        testActorId,
        'growth-editor',
      ))?['text'],
      '未提交的另一段原话',
    );
    expect(await store.pendingCount(testFamilyId), 1);
    expect(snapshotReads, 2);
  });

  test('按参与记录 ID 清除墓碑，同一活动可以重新记一次', () async {
    final base = testPlan();
    final item = base.items.first;
    Json participation(String id, int revision) => {
      'id': id,
      'planItemId': item.id,
      'revision': revision,
      'status': 'played',
      'participantIds': [testActorId],
      'notes': <Json>[],
      'actualMinutes': 5,
      'again': false,
      'addedBy': testActorId,
    };
    final first = participation('older-play', 3);
    final next = participation('new-play', 1);
    final withRecord = {
      ...base.json,
      'items': [
        {...item.json, 'participation': first},
        for (final other in base.items.skip(1)) other.json,
      ],
    };
    final remote = api((request) {
      if (request.url.path.endsWith('/snapshot')) {
        return _ok(_snapshot(days: [withRecord]));
      }
      final cursor = request.url.queryParameters['cursor'];
      if (cursor == 'initial') {
        return _ok(
          _page('removed', [_deleted(7, 'participation', 'older-play', 4)]),
        );
      }
      expect(cursor, 'removed');
      return _ok(
        _page('new', [
          _change(8, 'day_plan', withRecord),
          _change(9, 'participation', next),
        ]),
      );
    });
    await pull(remote);
    expect(
      (await store.readParticipations(testFamilyId))[item.id]?.payload['id'],
      'older-play',
    );
    await pull(remote);
    expect(await store.readParticipations(testFamilyId), isEmpty);
    expect(
      (await store.readPlan(
        testFamilyId,
        testChildId,
        testDate,
      ))!.items.first.json['participation'],
      isNull,
    );
    await pull(remote);
    expect(
      (await store.readParticipations(testFamilyId))[item.id]?.payload['id'],
      'new-play',
    );
    expect(
      (await store.readParticipations(testFamilyId))[item.id]?.serverRevision,
      1,
    );
  });

  test('较早的拉取响应不回退刚确认的本机写入；切换家庭不写入响应', () async {
    final started = Completer<void>();
    final resume = Completer<void>();
    var calls = 0;
    final remote = api((request) async {
      if (request.url.path.endsWith('/snapshot')) return _ok(_snapshot());
      if (++calls == 1) {
        started.complete();
        await resume.future;
        return _ok(
          _page('previous', [
            _change(1, 'family_preferences', _preferences(1, ['旧材料'])),
          ]),
        );
      }
      return _ok(
        _page('confirmed', [
          _change(2, 'family_preferences', _preferences(2, ['纸箱'])),
        ]),
      );
    });
    await pull(remote);
    final request = pull(remote);
    await started.future;
    await store.saveFamilyPreferenceEdit(
      testFamilyId,
      const FamilyPreferences(availableMaterials: ['纸箱']),
      testNow,
    );
    final operation = (await store.claimNext(testFamilyId, testNow))!;
    await store.acknowledge(
      testFamilyId,
      operation.id,
      _preferences(2, ['纸箱']),
    );
    resume.complete();
    await request;
    expect(calls, 2);
    expect(await store.readCursor(testFamilyId), 'confirmed');
    expect((await store.readPreferences(testFamilyId)).availableMaterials, [
      '纸箱',
    ]);

    var current = true;
    final obsolete = api((request) {
      current = false;
      return _ok(
        _page('other', [
          _change(3, 'memory', _memory('should-not-exist', '已经离开的家庭')),
        ]),
      );
    });
    await FamilySyncRepository(
      local: store,
      service: obsolete,
    ).pull(testFamilyId, isCurrent: () => current);
    expect(await store.readCursor(testFamilyId), 'confirmed');
    expect(await store.readGrowthRecords(testFamilyId, testChildId), isEmpty);
  });

  test('离线偏好保留本机提醒；冲突可采用家庭版本，超期操作不会重放', () async {
    final remote = api((request) => _ok(_snapshot()));
    await pull(remote);
    await store.saveFamilyPreferenceEdit(
      testFamilyId,
      const FamilyPreferences(availableMaterials: ['纸巾盒'], languageMode: 'zh'),
      testNow,
    );
    await store.saveReminderLocally(
      testFamilyId,
      const FamilyPreferences(reminderEnabled: true, reminderTime: '17:20'),
    );
    final operation = (await store.claimNext(testFamilyId, testNow))!;
    expect(operation.body['baseRevision'], 1);
    await store.failOperation(
      testFamilyId,
      operation.id,
      code: 'REVISION_CONFLICT',
      retryAfter: testNow,
      conflict: {
        'current': _preferences(2, ['水彩笔']),
      },
    );
    await store.close();
    store = await openStore(databasePath);
    expect((await store.readPreferences(testFamilyId)).availableMaterials, [
      '纸巾盒',
    ]);
    await store.resolveSyncConflict(
      familyId: testFamilyId,
      actorId: testActorId,
      operationId: operation.id,
      resolution: SyncConflictResolution.keepRemote,
      now: testNow,
    );
    final applied = await store.readPreferences(testFamilyId);
    expect(applied.availableMaterials, ['水彩笔']);
    expect(applied.reminderEnabled, isTrue);
    expect(applied.reminderTime, '17:20');

    final local = await store.saveGrowthRecord(
      familyId: testFamilyId,
      childId: testChildId,
      type: GrowthRecordType.quote,
      localDate: testDate,
      text: '超期也不能丢掉的原话',
      now: testNow,
    );
    expect(
      await store.claimNext(
        testFamilyId,
        testNow.add(const Duration(days: 90)),
      ),
      isNull,
    );
    final issue = (await store.readSyncIssues(testFamilyId)).single;
    expect(issue.code, 'OPERATION_EXPIRED');
    expect(issue.localText, local.text);
    await expectLater(
      store.retrySyncIssue(testFamilyId, issue.operationId),
      throwsStateError,
    );
  });
}

Json _preferences(int revision, List<String> materials) => {
  'familyId': testFamilyId,
  'revision': revision,
  'availableMaterials': materials,
  'excludedMaterials': <String>[],
  'languageMode': 'zh_with_english',
};

Json _memory(
  String id,
  String text, {
  int revision = 1,
  List<String> mediaIds = const [],
}) => {
  'id': id,
  'childId': testChildId,
  'localDate': testDate.toString(),
  'type': 'story',
  'text': text,
  'firstConfirmed': false,
  'mediaIds': mediaIds,
  'addedBy': testActorId,
  'revision': revision,
  'deletedAt': null,
};

Json _photo(String id, String memoryId) => {
  'id': id,
  'memoryId': memoryId,
  'state': 'ready',
  'mime': 'image/jpeg',
  'byteSize': 30,
  'sha256': 'ready-photo',
  'downloadUrl': null,
  'expiresAt': null,
};

Json _snapshot({
  String cursor = 'initial',
  List<Json> memories = const [],
  List<Json> days = const [],
  List<Json> media = const [],
}) => {
  'snapshotId': 'snapshot-$cursor',
  'cursor': cursor,
  'nextPageToken': null,
  'hasMore': false,
  'family': {'id': testFamilyId, 'members': <Json>[]},
  'preferences': _preferences(1, ['纸和笔']),
  'children': [
    {'id': testChildId, 'familyId': testFamilyId},
  ],
  'days': days,
  'memories': memories,
  'measurements': <Json>[],
  'observations': <Json>[],
  'sessions': <Json>[],
  'books': <Json>[],
  'media': media,
  'withdrawals': <Json>[],
};

Json _change(int sequence, String entity, Json payload) => {
  'sequence': sequence,
  'entity': entity,
  'id': payload['id'] ?? payload['familyId'],
  'revision': payload['revision'],
  'deleted': false,
  'payload': payload,
};

Json _deleted(int sequence, String entity, String id, int revision) => {
  'sequence': sequence,
  'entity': entity,
  'id': id,
  'revision': revision,
  'deleted': true,
  'payload': null,
};

Json _page(String cursor, List<Json> changes, {bool hasMore = false}) => {
  'changes': changes,
  'nextCursor': cursor,
  'hasMore': hasMore,
};

http.Response _ok(Json body) => _response(body, 200);

http.Response _response(Json body, int status) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
