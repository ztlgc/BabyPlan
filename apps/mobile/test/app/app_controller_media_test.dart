import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:babyplan/app/app_controller.dart';
import 'package:babyplan/core/app_config.dart';
import 'package:babyplan/core/family_date.dart';
import 'package:babyplan/data/api_client.dart';
import 'package:babyplan/data/local_store.dart';
import 'package:babyplan/domain/models.dart';
import 'package:babyplan/services/growth_file_store.dart';
import 'package:babyplan/services/reminder_notifications.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../support/test_support.dart';

const _familyId = 'family-remote';
const _childId = 'child-remote';
const _userId = 'user-test';
const _photoId = 'media-one';
const _uploadPath = '/upload/media-one';

class _NoopReminderScheduler implements ReminderScheduler {
  @override
  Future<void> cancel() async {}

  @override
  Future<void> initialize({required void Function() onOpenToday}) async {}

  @override
  Future<bool> requestPermission() async => true;

  @override
  Future<void> scheduleDaily(String localTime) async {}
}

class _MemoryGrowthFiles implements GrowthFileStore {
  _MemoryGrowthFiles({this.failCopy = false});

  final bool failCopy;
  final Uint8List bytes = Uint8List.fromList([0xff, 0xd8, 0xff, 1, 2]);
  final List<String> deleted = [];

  @override
  Future<List<PreparedGrowthPhoto>> copyPhotos({
    required String familyId,
    required String childId,
    required String recordId,
    required List<String> sourcePaths,
  }) async {
    if (failCopy) throw const FormatException('选中的照片已经损坏。');
    return [
      for (var index = 0; index < sourcePaths.length; index++)
        PreparedGrowthPhoto(
          localPath: '/private/$recordId/$index.jpg',
          mime: 'image/jpeg',
          byteSize: bytes.length,
          sha256: List.filled(64, '${index + 1}').join(),
        ),
    ];
  }

  @override
  Future<void> deletePhoto(String path) async {
    deleted.add(path);
  }

  @override
  Future<Uint8List> readPhoto(String path) async => bytes;
}

class _MemoryExportSaver implements ExportFileSaver {
  Uint8List? bytes;
  String? name;
  Uint8List? jsonBytes;
  String? jsonName;

  @override
  Future<String?> saveZip(Uint8List bytes, String suggestedName) async {
    this.bytes = bytes;
    name = suggestedName;
    return 'content://downloads/babyplan-export';
  }

  @override
  Future<String?> saveJson(Uint8List bytes, String suggestedName) async {
    jsonBytes = bytes;
    jsonName = suggestedName;
    return 'content://downloads/$suggestedName';
  }
}

class _CapturedRequest {
  const _CapturedRequest(this.method, this.path, this.body);
  final String method;
  final String path;
  final Object? body;
}

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    initializeTestTimezones();
  });

  test('正文先落本机，照片副本失败也不会丢正文', () async {
    final local = await openStore(inMemoryDatabasePath);
    final controller = AppController(
      config: const AppConfig(demo: true),
      local: local,
      tokenVault: MemoryTokenVault(),
      initialFamilyId: 'demo-family',
      initialChildId: 'demo-child',
      initialActorId: testActorId,
      growthFiles: _MemoryGrowthFiles(failCopy: true),
      reminderScheduler: _NoopReminderScheduler(),
      now: () => testNow,
    );
    await controller.initialize();

    final result = await controller.addGrowth(
      type: GrowthRecordType.story,
      date: testDate,
      text: '照片坏了，正文也必须保留',
      photoPaths: ['/picked/damaged.jpg'],
    );

    expect(result.record.text, '照片坏了，正文也必须保留');
    expect(result.photoCount, 0);
    expect(result.photoError, contains('照片已经损坏'));
    expect(controller.growthRecords.single.text, '照片坏了，正文也必须保留');
    expect(controller.pendingCount, 1);
    await controller.closeStoresForTesting();
  });

  test('待同步草稿可以保存为不含登录令牌的 JSON 文件', () async {
    final local = await openStore(inMemoryDatabasePath);
    final saver = _MemoryExportSaver();
    final controller = AppController(
      config: const AppConfig(demo: true),
      local: local,
      tokenVault: MemoryTokenVault(),
      initialFamilyId: 'demo-family',
      initialChildId: 'demo-child',
      initialActorId: testActorId,
      exportFiles: saver,
      reminderScheduler: _NoopReminderScheduler(),
      now: () => testNow,
    );
    await controller.initialize();
    await controller.saveGrowthDraft({'text': '还没有正式保存的文字'});
    await controller.addGrowth(
      type: GrowthRecordType.story,
      date: testDate,
      text: '离线故事',
    );

    final location = await controller.exportPendingDrafts();
    expect(location, contains('.json'));
    expect(saver.jsonName, endsWith('.json'));
    final payload = jsonDecode(utf8.decode(saver.jsonBytes!)) as Map;
    expect(payload['format'], 'babyplan-pending-drafts');
    expect((payload['drafts'] as List), hasLength(1));
    expect(payload.toString(), isNot(contains('accessToken')));
    expect(payload.toString(), isNot(contains('refreshToken')));
    await controller.closeStoresForTesting();
  });

  test('照片严格按创建上传票据、PUT、完成、ready 后 PATCH 关联的顺序执行', () async {
    final local = await openStore(inMemoryDatabasePath);
    final requests = <_CapturedRequest>[];
    late Map<String, dynamic> createdMemory;
    final client = MockClient((request) async {
      final body = _captureBody(request);
      requests.add(_CapturedRequest(request.method, request.url.path, body));
      return _remoteResponse(request, body, () {
        createdMemory = Map<String, dynamic>.from(body as Map);
        return _memoryJson(
          id: createdMemory['id'] as String,
          text: createdMemory['text'] as String,
          mediaIds: const [],
          revision: 1,
        );
      }, memoryIdProvider: () => createdMemory['id'] as String);
    });
    final vault = MemoryTokenVault()..session = sampleSession();
    final api = BabyPlanApi(
      baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
      vault: vault,
      client: client,
    );
    final controller = _remoteController(
      local: local,
      api: api,
      vault: vault,
      growthFiles: _MemoryGrowthFiles(),
    );
    await controller.initialize();
    requests.clear();

    final result = await controller.addGrowth(
      type: GrowthRecordType.quote,
      date: testDate,
      text: '“我自己来”',
      photoPaths: ['/picked/photo.jpg'],
    );

    expect(result.photoCount, 1);
    expect(result.photoError, isNull);
    expect(requests.map((request) => '${request.method} ${request.path}'), [
      'GET /v2/bootstrap',
      'GET /v2/content/options',
      'POST /v2/children/$_childId/memories',
      'POST /v2/media/uploads',
      'PUT $_uploadPath',
      'POST /v2/media/$_photoId/complete',
      'PATCH /v2/memories/${result.record.id}',
    ]);
    final createBody = requests[3].body! as Map<String, dynamic>;
    final completeBody = requests[5].body! as Map<String, dynamic>;
    final patchBody = requests[6].body! as Map<String, dynamic>;
    final photo = (await controller.repository.growthPhotos(
      memoryId: result.record.id,
    )).single;
    expect(createBody['operationId'], photo.createOperationId);
    expect(completeBody['operationId'], photo.completeOperationId);
    expect(patchBody['operationId'], photo.linkOperationId);
    expect(patchBody['baseRevision'], 1);
    expect(patchBody['mediaIds'], [_photoId]);
    expect(photo.state, 'linked');
    expect(result.record.mediaIds, [_photoId]);
    expect(result.record.syncState, 'synced');
    await controller.closeStoresForTesting();
  });

  test('上传中断后 ticket、服务照片状态和 operationId 重启后仍保留', () async {
    final temporary = await createTempDirectory();
    final databasePath =
        '${temporary.path}${Platform.pathSeparator}babyplan.db';
    final local = await openStore(databasePath);
    late Map<String, dynamic> createdMemory;
    final client = MockClient((request) async {
      final body = _captureBody(request);
      if (request.method == 'PUT' && request.url.path == _uploadPath) {
        throw http.ClientException('网络在 PUT 时中断');
      }
      return _remoteResponse(request, body, () {
        createdMemory = Map<String, dynamic>.from(body as Map);
        return _memoryJson(
          id: createdMemory['id'] as String,
          text: createdMemory['text'] as String,
          mediaIds: const [],
          revision: 1,
        );
      }, memoryIdProvider: () => createdMemory['id'] as String);
    });
    final vault = MemoryTokenVault()..session = sampleSession();
    final api = BabyPlanApi(
      baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
      vault: vault,
      client: client,
    );
    final controller = _remoteController(
      local: local,
      api: api,
      vault: vault,
      growthFiles: _MemoryGrowthFiles(),
    );
    await controller.initialize();
    final result = await controller.addGrowth(
      type: GrowthRecordType.story,
      date: testDate,
      text: '断网也能继续',
      photoPaths: ['/picked/photo.jpg'],
    );
    final failed = (await controller.repository.growthPhotos(
      memoryId: result.record.id,
    )).single;

    expect(failed.state, 'upload_failed');
    expect(failed.serverMediaId, _photoId);
    expect(
      failed.uploadUrl,
      'http://127.0.0.1:4318$_uploadPath?token=temporary',
    );
    expect(failed.uploadExpiresAt, isNotNull);
    expect(failed.createOperationId, isNotEmpty);
    expect(failed.completeOperationId, isNotEmpty);
    expect(failed.linkOperationId, isNotEmpty);

    await controller.closeStoresForTesting();
    final root = await openStore(databasePath);
    final reopened = await root.openAccountStore(
      api.baseUri,
      vault.session!.userId,
    );
    final restored = (await reopened.readGrowthPhotos(
      _familyId,
      memoryId: result.record.id,
    )).single;
    expect(restored.state, 'upload_failed');
    expect(restored.serverMediaId, _photoId);
    expect(restored.createOperationId, failed.createOperationId);
    expect(restored.completeOperationId, failed.completeOperationId);
    await reopened.close();
    await root.close();
    await temporary.delete(recursive: true);
  });

  test('旧上传链接被拒时用原操作标识续签，照片不重复创建', () async {
    final local = await openStore(inMemoryDatabasePath);
    final createIds = <String>[];
    final uploadTokens = <String?>[];
    late Map<String, dynamic> createdMemory;
    final client = MockClient((request) async {
      final body = _captureBody(request);
      if (request.method == 'POST' && request.url.path == '/v2/media/uploads') {
        createIds.add((body as Map)['operationId'] as String);
        final response = await _remoteResponse(
          request,
          body,
          () => <String, dynamic>{},
          memoryIdProvider: () => createdMemory['id'] as String,
        );
        final ticket = jsonDecode(response.body) as Map<String, dynamic>;
        ticket['uploadUrl'] =
            'http://127.0.0.1:4318$_uploadPath?token=${createIds.length}';
        return _jsonResponse(ticket, statusCode: 201);
      }
      if (request.method == 'PUT' && request.url.path == _uploadPath) {
        final token = request.url.queryParameters['token'];
        uploadTokens.add(token);
        if (token == '1') {
          return _jsonResponse({'code': 'NOT_FOUND'}, statusCode: 404);
        }
      }
      return _remoteResponse(request, body, () {
        createdMemory = Map<String, dynamic>.from(body as Map);
        return _memoryJson(
          id: createdMemory['id'] as String,
          text: createdMemory['text'] as String,
          mediaIds: const [],
          revision: 1,
        );
      }, memoryIdProvider: () => createdMemory['id'] as String);
    });
    addTearDown(client.close);
    final vault = MemoryTokenVault()..session = sampleSession();
    final controller = _remoteController(
      local: local,
      vault: vault,
      growthFiles: _MemoryGrowthFiles(),
      api: BabyPlanApi(
        baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
        vault: vault,
        client: client,
      ),
    );
    addTearDown(controller.closeStoresForTesting);
    await controller.initialize();
    final result = await controller.addGrowth(
      type: GrowthRecordType.story,
      date: testDate,
      text: '这张照片继续上传',
      photoPaths: ['/picked/photo.jpg'],
    );
    final photo = (await controller.local.readGrowthPhotos(
      _familyId,
      memoryId: result.record.id,
    )).single;
    expect(createIds, [photo.createOperationId, photo.createOperationId]);
    expect(uploadTokens, ['1', '2']);
    expect(photo.serverMediaId, _photoId);
    expect(photo.state, 'linked');
  });

  test('七天请求中断后沿用操作标识；同条件跳过，偏好变化后再编排', () async {
    final local = await openStore(inMemoryDatabasePath);
    final operationIds = <String>[];
    var changedPreferences = false;
    final client = MockClient((request) async {
      final body = _captureBody(request);
      if (request.method == 'POST' &&
          request.url.path == '/v2/children/$_childId/plans/ensure') {
        operationIds.add(
          (body! as Map<String, dynamic>)['operationId'] as String,
        );
        if (operationIds.length == 1) throw const SocketException('连接中断');
        return _jsonResponse({'days': _sevenPlans()});
      }
      if (changedPreferences &&
          request.url.path.endsWith('/changes') &&
          request.url.queryParameters['cursor'] == 'cursor-1') {
        return _jsonResponse({
          'nextCursor': 'cursor-2',
          'hasMore': false,
          'changes': [
            {
              'sequence': 2,
              'entity': 'family_preferences',
              'id': _familyId,
              'revision': 2,
              'deleted': false,
              'payload': {
                ..._preferencesJson(),
                'languageMode': 'zh',
                'revision': 2,
              },
            },
          ],
        });
      }
      return _remoteResponse(request, body, () => <String, Object?>{});
    });
    final vault = MemoryTokenVault()..session = sampleSession();
    final api = BabyPlanApi(
      baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
      vault: vault,
      client: client,
    );
    final controller = _remoteController(local: local, api: api, vault: vault);

    await controller.initialize();
    final draft = await controller.local.readDraft(
      _familyId,
      _userId,
      'operation:ensure-plans:$_childId',
    );
    expect(draft?['operationId'], operationIds.single);
    await controller.refresh();
    await controller.refresh();
    expect(operationIds, hasLength(2));
    changedPreferences = true;
    await controller.refresh();

    expect(operationIds, hasLength(3));
    expect(operationIds[0], operationIds[1]);
    expect(operationIds[2], isNot(operationIds[1]));
    expect(controller.weekPlans, hasLength(7));
    expect(controller.plan?.date, testDate);
    final confirmedDraft = await controller.local.readDraft(
      _familyId,
      _userId,
      'operation:ensure-plans:$_childId',
    );
    expect(confirmedDraft?['completed'], isTrue);
    await controller.closeStoresForTesting();
  });

  test('导出轮询完成后保留遗漏清单，下载前刷新短时链接并写入用户选择位置', () async {
    final local = await openStore(inMemoryDatabasePath);
    final requests = <_CapturedRequest>[];
    var exportReads = 0;
    final client = MockClient((request) async {
      final body = _captureBody(request);
      requests.add(_CapturedRequest(request.method, request.url.path, body));
      if (request.method == 'POST' &&
          request.url.path == '/v2/families/$_familyId/exports') {
        return _jsonResponse(
          _exportJson(status: 'processing', downloadUrl: null),
          statusCode: 202,
        );
      }
      if (request.method == 'GET' &&
          request.url.path == '/v2/exports/export-123') {
        exportReads++;
        return _jsonResponse(
          _exportJson(
            status: 'ready',
            downloadUrl:
                'http://127.0.0.1:4318/download/export-$exportReads.zip',
          ),
        );
      }
      if (request.method == 'GET' &&
          request.url.path == '/download/export-2.zip') {
        return http.Response.bytes([80, 75, 3, 4], 200);
      }
      return _remoteResponse(request, body, () => <String, Object?>{});
    });
    final vault = MemoryTokenVault()..session = sampleSession();
    final api = BabyPlanApi(
      baseUri: Uri.parse('http://127.0.0.1:4318/v2'),
      vault: vault,
      client: client,
    );
    final saver = _MemoryExportSaver();
    final controller = _remoteController(
      local: local,
      api: api,
      vault: vault,
      exportFiles: saver,
    );
    await controller.initialize();

    final archive = await controller.prepareExport(
      from: testDate.addDays(-7),
      to: testDate,
      types: const ['memories', 'plans'],
      includeMedia: true,
    );
    final location = await controller.downloadExport(archive);

    expect(archive.status, 'ready');
    expect(archive.missingMedia.single['reason'], 'processing');
    expect(location, 'content://downloads/babyplan-export');
    expect(exportReads, 2);
    expect(saver.bytes, [80, 75, 3, 4]);
    expect(saver.name, startsWith('BabyPlan-$testDate-'));
    expect(
      requests.any((request) => request.path == '/download/export-2.zip'),
      isTrue,
    );
    expect(
      requests.any((request) => request.path == '/download/export-1.zip'),
      isFalse,
    );
    await controller.closeStoresForTesting();
  });

  test('换项候选仅保留适龄、材料满足、未撤回且未使用的完整缓存', () async {
    final local = await openStore(inMemoryDatabasePath);
    final controller = AppController(
      config: const AppConfig(demo: true),
      local: local,
      tokenVault: MemoryTokenVault(),
      initialFamilyId: 'demo-family',
      initialChildId: 'demo-child',
      initialActorId: testActorId,
      reminderScheduler: _NoopReminderScheduler(),
      now: () => testNow,
    );
    await controller.initialize();
    controller.activeChild = const ChildSummary(
      id: testChildId,
      familyId: testFamilyId,
      ageMode: 'months',
      ageMonths: 19,
      revision: 1,
    );
    controller.contentOptions = [
      Activity.fromJson({
        ..._replacementActivity('eligible').json,
        'kind': controller.plan!.items.first.activity.kind,
      }),
      _replacementActivity('wrong-age', ageBands: ['m24_29']),
      _replacementActivity('missing-material', materials: ['户外滑梯']),
      _replacementActivity('withdrawn', withdrawn: true),
    ];

    final candidates = controller.replacementOptionsFor(
      controller.plan!.items.first,
    );

    expect(candidates.map((activity) => activity.id), ['eligible']);
    await controller.closeStoresForTesting();
  });
}

AppController _remoteController({
  required LocalStore local,
  required BabyPlanApi api,
  required MemoryTokenVault vault,
  GrowthFileStore? growthFiles,
  ExportFileSaver? exportFiles,
}) => AppController(
  config: const AppConfig(demo: false, apiBaseUrl: null),
  local: local,
  tokenVault: vault,
  initialFamilyId: 'placeholder-family',
  initialChildId: 'placeholder-child',
  initialActorId: 'placeholder-user',
  api: api,
  growthFiles: growthFiles ?? _MemoryGrowthFiles(),
  exportFiles: exportFiles ?? _MemoryExportSaver(),
  reminderScheduler: _NoopReminderScheduler(),
  now: () => testNow,
);

Object? _captureBody(http.Request request) {
  if (request.bodyBytes.isEmpty) return null;
  final contentType = request.headers['content-type'] ?? '';
  if (contentType.contains('application/json')) {
    return jsonDecode(request.body);
  }
  return request.bodyBytes;
}

Future<http.Response> _remoteResponse(
  http.Request request,
  Object? body,
  Object Function() memoryResponse, {
  String Function()? memoryIdProvider,
}) async {
  final path = request.url.path;
  if (request.method == 'GET' && path == '/v2/bootstrap') {
    return _jsonResponse(_bootstrapJson());
  }
  if (request.method == 'POST' &&
      path == '/v2/children/$_childId/plans/ensure') {
    return _jsonResponse({'days': _sevenPlans()});
  }
  if (request.method == 'GET' && path == '/v2/families/$_familyId/snapshot') {
    return _jsonResponse(_snapshotJson());
  }
  if (request.method == 'GET' && path == '/v2/content/options') {
    return _jsonResponse({'activities': <Object>[], 'withdrawals': <Object>[]});
  }
  if (request.method == 'GET' && path == '/v2/families/$_familyId/changes') {
    return _jsonResponse({
      'changes': <Object>[],
      'hasMore': false,
      'nextCursor': request.url.queryParameters['cursor'],
    });
  }
  if (request.method == 'GET' && path == '/v2/users/me/reminder') {
    return _jsonResponse({
      'userId': _userId,
      'deviceId': null,
      'enabled': false,
      'localTime': '19:30',
      'revision': 0,
    });
  }
  if (request.method == 'POST' && path == '/v2/children/$_childId/memories') {
    return _jsonResponse(memoryResponse(), statusCode: 201);
  }
  if (request.method == 'POST' && path == '/v2/media/uploads') {
    final memoryId = memoryIdProvider?.call() ?? 'missing-memory';
    final requestBody = body! as Map<String, dynamic>;
    return _jsonResponse({
      'media': {
        'id': _photoId,
        'memoryId': memoryId,
        'state': 'pending',
        'mime': requestBody['mime'],
        'byteSize': requestBody['byteSize'],
        'sha256': requestBody['sha256'],
        'downloadUrl': null,
        'expiresAt': null,
      },
      'uploadUrl': 'http://127.0.0.1:4318$_uploadPath?token=temporary',
      'expiresAt': '2026-11-13T04:10:00Z',
    }, statusCode: 201);
  }
  if (request.method == 'PUT' && path == _uploadPath) {
    return http.Response('', 204);
  }
  if (request.method == 'POST' && path == '/v2/media/$_photoId/complete') {
    final memoryId = memoryIdProvider?.call() ?? 'missing-memory';
    return _jsonResponse({
      'id': _photoId,
      'memoryId': memoryId,
      'state': 'ready',
      'mime': 'image/jpeg',
      'byteSize': 5,
      'sha256': List.filled(64, '1').join(),
      'downloadUrl': 'http://127.0.0.1:4318/media/view.jpg',
      'expiresAt': '2026-11-13T04:10:00Z',
    }, statusCode: 202);
  }
  if (request.method == 'GET' && path == '/v2/media/$_photoId') {
    final memoryId = memoryIdProvider?.call() ?? 'missing-memory';
    return _jsonResponse({
      'id': _photoId,
      'memoryId': memoryId,
      'state': 'ready',
      'mime': 'image/jpeg',
      'byteSize': 5,
      'sha256': List.filled(64, '1').join(),
      'downloadUrl': 'http://127.0.0.1:4318/media/view.jpg',
      'expiresAt': '2026-11-13T04:10:00Z',
    });
  }
  if (request.method == 'PATCH' && path.startsWith('/v2/memories/')) {
    final patch = body! as Map<String, dynamic>;
    final id = path.substring('/v2/memories/'.length);
    return _jsonResponse(
      _memoryJson(
        id: id,
        text: patch['text'] as String,
        mediaIds: List<String>.from(patch['mediaIds'] as List),
        revision: (patch['baseRevision'] as int) + 1,
      ),
    );
  }
  return http.Response(
    jsonEncode({'code': 'NOT_FOUND', 'message': 'not found', 'requestId': 'r'}),
    404,
    headers: {'content-type': 'application/json'},
  );
}

http.Response _jsonResponse(Object body, {int statusCode = 200}) =>
    http.Response(
      jsonEncode(body),
      statusCode,
      headers: {'content-type': 'application/json'},
    );

Map<String, dynamic> _bootstrapJson() => {
  'user': {'id': _userId, 'displayName': '真实家长'},
  'families': [
    {
      'id': _familyId,
      'name': '我们家',
      'timezone': 'Asia/Shanghai',
      'members': <Object>[],
      'revision': 1,
    },
  ],
  'children': [
    {
      'id': _childId,
      'familyId': _familyId,
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

Map<String, dynamic> _snapshotJson() => {
  'cursor': 'cursor-1',
  'children': _bootstrapJson()['children'],
  'days': _sevenPlans(),
  'memories': <Object>[],
  'measurements': <Object>[],
  'observations': <Object>[],
  'sessions': <Object>[],
  'books': <Object>[],
  'media': <Object>[],
  'withdrawals': <Object>[],
  'family': (_bootstrapJson()['families'] as List).single,
  'preferences': _preferencesJson(),
  'snapshotId': 'snapshot-1',
  'nextPageToken': null,
  'hasMore': false,
  'expiresAt': '2026-11-13T04:30:00Z',
};

Map<String, dynamic> _preferencesJson() => {
  'familyId': _familyId,
  'availableMaterials': ['积木'],
  'excludedMaterials': <String>[],
  'languageMode': 'zh_with_english',
  'revision': 1,
};

List<Map<String, dynamic>> _sevenPlans() => [
  for (var index = 0; index < 7; index++) _planJson(testDate.addDays(index)),
];

Map<String, dynamic> _planJson(FamilyDate date) {
  final source = testPlan(
    date: date,
    familyId: _familyId,
    childId: _childId,
  ).json;
  final planId = 'plan-$date';
  return {
    ...source,
    'id': planId,
    'items': (source['items'] as List)
        .map(
          (item) => {
            ...Map<String, dynamic>.from(item as Map),
            'id': '$planId:${item['id']}',
            'dayPlanId': planId,
          },
        )
        .toList(growable: false),
  };
}

Map<String, dynamic> _memoryJson({
  required String id,
  required String text,
  required List<String> mediaIds,
  required int revision,
}) => {
  'id': id,
  'childId': _childId,
  'localDate': testDate.toString(),
  'type': 'quote',
  'text': text,
  'firstConfirmed': false,
  'mediaIds': mediaIds,
  'authorId': _userId,
  'revision': revision,
  'createdAt': '2026-11-13T04:00:00Z',
  'updatedAt': '2026-11-13T04:00:00Z',
};

Map<String, dynamic> _exportJson({
  required String status,
  required String? downloadUrl,
}) => {
  'id': 'export-123',
  'familyId': _familyId,
  'status': status,
  'formats': ['json', 'csv', 'zip'],
  'from': testDate.addDays(-7).toString(),
  'to': testDate.toString(),
  'types': ['memories', 'plans'],
  'includeMedia': true,
  'missingMedia': [
    {'mediaId': 'media-pending', 'reason': 'processing'},
  ],
  'downloadUrl': downloadUrl,
  'expiresAt': downloadUrl == null ? null : '2026-11-13T04:15:00Z',
  'createdAt': '2026-11-13T04:00:00Z',
};

Activity _replacementActivity(
  String id, {
  List<String> ageBands = const ['m18_23'],
  List<String> materials = const ['积木'],
  bool withdrawn = false,
}) => Activity.fromJson({
  'id': id,
  'title': '纸盒藏一藏 $id',
  'kind': 'explore',
  'support': '把熟悉的小物藏进纸盒，再一起找出来。',
  'revision': 1,
  'reviewState': 'reviewed',
  'ageBands': ageBands,
  'sourceIds': ['test-source'],
  'materials': materials,
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
  'withdrawn': withdrawn,
});
