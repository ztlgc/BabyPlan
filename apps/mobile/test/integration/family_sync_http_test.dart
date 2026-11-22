import 'dart:io';

import 'package:babyplan/core/family_date.dart';
import 'package:babyplan/data/api_client.dart';
import 'package:babyplan/data/family_sync_repository.dart';
import 'package:babyplan/data/local_store.dart';
import 'package:babyplan/data/plan_repository.dart';
import 'package:babyplan/domain/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:uuid/uuid.dart';

import '../support/test_support.dart';

const _uuid = Uuid();

class _DeviceVault extends MemoryTokenVault {
  final _deviceId = _uuid.v4();

  @override
  Future<String> deviceId() async => _deviceId;
}

class _ObservedHttp extends http.BaseClient {
  final _inner = http.Client();
  final _reads = <(String, int)>[];

  int readCount(String endpoint) =>
      _reads.where((entry) => entry.$1.endsWith('/$endpoint')).length;

  Iterable<int> readStatuses(String endpoint) => _reads
      .where((entry) => entry.$1.endsWith('/$endpoint'))
      .map((entry) => entry.$2);

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final response = await _inner.send(request);
    if (request.method == 'GET') {
      _reads.add((request.url.path, response.statusCode));
    }
    return response;
  }

  @override
  void close() => _inner.close();
}

Future<Json> _write(
  BabyPlanApi api, {
  required String familyId,
  required String method,
  required String path,
  required Json body,
}) {
  final id = _uuid.v4();
  return api.send(
    PendingOperation(
      id: id,
      familyId: familyId,
      objectKey: 'http_fixture:$id',
      method: method,
      path: path,
      body: {...body, 'operationId': id},
      localVersion: 1,
      attempts: 1,
    ),
  );
}

void main() {
  final env = Platform.environment;
  final fixtureUrl = env['BABYPLAN_MOBILE_SYNC_FIXTURE_URL'];

  test(
    '两份独立手机库经真实 HTTP 同步并在游标过期后保住草稿',
    () async {
      final baseUri = Uri.parse(fixtureUrl!);
      expect(baseUri.host, '127.0.0.1');
      expect(baseUri.path, '/v2');
      sqfliteFfiInit();
      initializeTestTimezones();
      final root = await createTempDirectory();
      addTearDown(() => root.delete(recursive: true));
      final clientA = _ObservedHttp();
      final clientB = _ObservedHttp();
      addTearDown(clientA.close);
      addTearDown(clientB.close);
      final vaultA = _DeviceVault();
      final vaultB = _DeviceVault();
      expect(await vaultA.deviceId(), isNot(await vaultB.deviceId()));
      final apiA = BabyPlanApi(
        baseUri: baseUri,
        vault: vaultA,
        client: clientA,
      );
      final apiB = BabyPlanApi(
        baseUri: baseUri,
        vault: vaultB,
        client: clientB,
      );
      final secretText = env['BABYPLAN_MOBILE_SYNC_FIXTURE_SECRET']!;
      final sessionA = await apiA.login(
        email: env['BABYPLAN_MOBILE_SYNC_OWNER']!,
        secretText: secretText,
      );
      final sessionB = await apiB.login(
        email: env['BABYPLAN_MOBILE_SYNC_CAREGIVER']!,
        secretText: secretText,
      );
      expect(sessionB.userId, isNot(sessionA.userId));
      expect(sessionB.sessionId, isNot(sessionA.sessionId));

      final family = await _write(
        apiA,
        familyId: '',
        method: 'POST',
        path: '/families',
        body: {
          'name': '手机同步验收家庭',
          'timezone': 'Asia/Shanghai',
          'child': {
            'ageMode': 'months',
            'ageMonths': 18,
            'ageAsOf': FamilyDate.at(
              DateTime.now(),
              'Asia/Shanghai',
            ).toString(),
            'birthDate': null,
            'displayName': '测试宝宝',
          },
        },
      );
      final familyId = family['id'] as String;
      final invitation = await apiA.createInvitation(familyId);
      await apiB.acceptInvitation(invitation.token);
      final bootstrap = await apiB.readBootstrap();
      expect(bootstrap.families.single.id, familyId);
      final childId = bootstrap.children.single.id;

      final localA = await openStore('${root.path}/first.sqlite');
      addTearDown(localA.close);
      final pathB = '${root.path}/second.sqlite';
      var localB = await openStore(pathB);
      addTearDown(() => localB.close());
      final repoA = PlanRepository(
        local: localA,
        familyId: familyId,
        childId: childId,
        actorId: sessionA.userId,
        remote: apiA,
      );
      PlanRepository repoB() => PlanRepository(
        local: localB,
        familyId: familyId,
        childId: childId,
        actorId: sessionB.userId,
        remote: apiB,
      );
      final syncA = FamilySyncRepository(local: localA, service: apiA);
      Future<void> pullA() => syncA.pull(familyId, isCurrent: () => true);
      Future<void> pullB() => FamilySyncRepository(
        local: localB,
        service: apiB,
      ).pull(familyId, isCurrent: () => true);

      // 两个设备都先从完整快照起步，后续生成的计划只能通过变更进入本机。
      await pullA();
      await pullB();
      final firstCursorB = await localB.readCursor(familyId);
      expect(firstCursorB, isNotNull);
      final days = await apiA.ensurePlans(
        childId: childId,
        operationId: _uuid.v4(),
      );
      expect(days, hasLength(7));
      final day = days.first.date;
      expect(await repoB().readDay(day), isNull);
      await pullA();
      await pullB();
      expect((await repoB().readDay(day))?.id, days.first.id);
      expect(await localB.readCursor(familyId), isNot(firstCursorB));
      expect(clientB.readCount('snapshot'), 1);
      final item = (await repoA.readDay(day))!.visibleItems.first;

      await repoA.record(
        item,
        ParticipationInput(
          status: ParticipationStatus.played,
          participantIds: [sessionA.userId],
          note: '甲记录了第一次一起玩',
        ),
      );
      final soft = await repoA.addGrowthRecord(
        type: GrowthRecordType.story,
        date: day,
        text: '之后会撤销的小记',
      );
      final permanent = await repoA.addGrowthRecord(
        type: GrowthRecordType.quote,
        date: day,
        text: '之后会永久删除的原话',
      );
      await repoA.addFamilyBook(title: '测试书架登记', language: 'zh', note: '放在家里');
      await localA.saveFamilyPreferenceEdit(
        familyId,
        const FamilyPreferences(
          availableMaterials: ['纸和笔'],
          languageMode: 'zh',
        ),
        DateTime.now(),
      );
      expect(await repoA.syncPending(), 5);

      // 模拟应用进程重启，确保第二台设备从 SQLite 游标继续。
      final cursorBeforeRestart = await localB.readCursor(familyId);
      await localB.close();
      localB = await openStore(pathB);
      expect(await localB.readCursor(familyId), cursorBeforeRestart);
      await localB.saveReminderLocally(
        familyId,
        const FamilyPreferences(reminderEnabled: true, reminderTime: '18:35'),
      );
      await pullB();
      expect((await repoB().participations())[item.id]?.historyNotes, [
        '甲记录了第一次一起玩',
      ]);
      expect(
        (await repoB().growthRecords()).map((row) => row.id),
        containsAll([soft.id, permanent.id]),
      );
      expect((await repoB().familyBooks()).single.title, '测试书架登记');
      final preferences = await repoB().readPreferences();
      expect(preferences.languageMode, 'zh');
      expect(preferences.availableMaterials, ['纸和笔']);
      expect(preferences.reminderTime, '18:35');
      expect(preferences.reminderEnabled, isTrue);
      expect(clientB.readCount('snapshot'), 1);

      // 测量与阶段观察也走独立的更正、墓碑和恢复链路。
      final measurement = await repoA.addGrowthRecord(
        type: GrowthRecordType.measurement,
        date: day,
        text: '甲第一次记录',
        value: 80.2,
        unit: 'cm',
        measurementKind: GrowthMeasurementKind.height,
        measurementMethod: GrowthMeasurementMethod.recumbent,
        measurementSource: GrowthMeasurementSource.home,
      );
      final observation = await repoA.addGrowthRecord(
        type: GrowthRecordType.observation,
        date: day,
        text: '会主动把绘本递给大人',
        guideId: 'stage-18-23-language',
        observationValue: 'noticed',
      );
      expect(await repoA.syncPending(), 2);
      await pullB();
      expect((await repoB().growthRecord(measurement.id))?.value, 80.2);
      expect(
        (await repoB().growthRecord(observation.id))?.observationValue,
        'noticed',
      );

      await repoB().updateGrowthRecord(
        recordId: measurement.id,
        type: measurement.type,
        date: measurement.localDate,
        text: '乙按同一卧位复测',
        value: 80.8,
        unit: 'cm',
        measurementKind: GrowthMeasurementKind.height,
        measurementMethod: GrowthMeasurementMethod.recumbent,
        measurementSource: GrowthMeasurementSource.home,
      );
      await repoB().updateGrowthRecord(
        recordId: observation.id,
        type: observation.type,
        date: observation.localDate,
        text: '会连续翻两页并指图',
        guideId: 'stage-18-23-language',
        observationValue: 'noticed',
      );
      expect(await repoB().syncPending(), 2);
      await pullA();
      expect((await repoA.growthRecord(measurement.id))?.value, 80.8);
      expect((await repoA.growthRecord(observation.id))?.text, '会连续翻两页并指图');

      await repoA.deleteGrowthRecord(
        (await repoA.growthRecord(measurement.id))!,
      );
      expect(await repoA.syncPending(), 1);
      await pullB();
      expect(await repoB().growthRecord(measurement.id), isNull);
      final deletedMeasurement = (await repoB().deletedGrowthRecords())
          .singleWhere((record) => record.id == measurement.id);
      expect(deletedMeasurement.serverRevision, 3);
      expect(deletedMeasurement.deletedAt, isNotNull);
      await repoB().restoreGrowthRecord(deletedMeasurement);
      expect(await repoB().syncPending(), 1);
      await pullA();
      expect((await repoA.growthRecord(measurement.id))?.value, 80.8);
      expect(
        (await repoA.deletedGrowthRecords()).where(
          (record) => record.id == measurement.id,
        ),
        isEmpty,
      );

      await repoA.deleteGrowthRecord(
        (await repoA.growthRecord(observation.id))!,
      );
      expect(await repoA.syncPending(), 1);
      await pullB();
      expect(await repoB().growthRecord(observation.id), isNull);
      final deletedObservation = (await repoB().deletedGrowthRecords())
          .singleWhere((record) => record.id == observation.id);
      expect(deletedObservation.serverRevision, 3);
      expect(deletedObservation.deletedAt, isNotNull);
      await repoB().restoreGrowthRecord(deletedObservation);
      expect(await repoB().syncPending(), 1);
      await pullA();
      expect((await repoA.growthRecord(observation.id))?.text, '会连续翻两页并指图');
      expect(clientB.readCount('snapshot'), 1);

      // 两台手机从同一版本分别编辑。较晚的写入保留本机原文和家庭版。
      await repoB().record(
        item,
        ParticipationInput(
          status: ParticipationStatus.played,
          participantIds: [sessionB.userId],
          note: '乙离线写的备注',
        ),
      );
      await repoA.record(
        item,
        ParticipationInput(
          status: ParticipationStatus.played,
          participantIds: [sessionA.userId],
          note: '甲先同步的新版',
        ),
      );
      expect(await repoA.syncPending(), 1);
      expect(await repoB().syncPending(), 0);
      final conflict = (await repoB().syncIssues()).single;
      expect(conflict.isConflict, isTrue);
      expect(conflict.localText, '乙离线写的备注');
      expect(conflict.remoteText, '甲先同步的新版');
      await repoB().resolveConflict(
        conflict.operationId,
        SyncConflictResolution.keepRemote,
      );
      await pullB();
      expect((await repoB().participations())[item.id]?.historyNotes, [
        '甲先同步的新版',
      ]);

      await repoA.undoRecord(item.id);
      expect(await repoA.syncPending(), 1);
      await _write(
        apiA,
        familyId: familyId,
        method: 'DELETE',
        path: '/memories/${soft.id}',
        body: {'baseRevision': 1, 'permanent': false},
      );
      await pullB();
      expect((await repoB().participations())[item.id], isNull);
      expect(
        (await repoB().readDay(day))!.items
            .firstWhere((it) => it.id == item.id)
            .json['participation'],
        isNull,
      );
      expect(await repoB().growthRecord(soft.id), isNull);
      expect(clientB.readCount('snapshot'), 1);

      final draft = await repoB().addGrowthRecord(
        type: GrowthRecordType.story,
        date: day,
        text: '乙尚未提交的原文',
        photos: const [
          PreparedGrowthPhoto(
            localPath: '/app-private/unsent.jpg',
            mime: 'image/jpeg',
            byteSize: 32,
            sha256: 'fixture-photo-digest',
          ),
        ],
      );
      await repoB().saveDraft('growth-editor', {'text': '尚未按保存的另一份草稿'});
      final stale = await localB.readCursor(familyId);
      final current = await repoA.addGrowthRecord(
        type: GrowthRecordType.story,
        date: day,
        text: '快照里仍应保留的新记录',
      );
      expect(await repoA.syncPending(), 1);
      await _write(
        apiA,
        familyId: familyId,
        method: 'DELETE',
        path: '/memories/${permanent.id}',
        body: {'baseRevision': 1, 'permanent': true},
      );
      await pullB();
      expect(clientB.readStatuses('changes'), contains(410));
      expect(clientB.readCount('snapshot'), 2);
      expect(await localB.readCursor(familyId), isNot(stale));
      expect(await repoB().growthRecord(permanent.id), isNull);
      expect((await repoB().growthRecord(current.id))?.text, current.text);
      expect((await repoB().growthRecord(draft.id))?.text, draft.text);
      expect(
        (await repoB().growthPhotos(memoryId: draft.id)).single.state,
        'pending',
      );
      expect(await repoB().pendingCount(), 1);
      expect(await repoB().readDraft('growth-editor'), {'text': '尚未按保存的另一份草稿'});
      expect((await repoB().readPreferences()).reminderTime, '18:35');
      expect(await repoB().syncPending(), 1);
      await pullA();
      expect((await repoA.growthRecord(draft.id))?.text, draft.text);

      // 成员被移除后，后续请求无权读取变化，也不推进本机水位。
      await _write(
        apiA,
        familyId: familyId,
        method: 'DELETE',
        path: '/families/$familyId/members/${sessionB.userId}',
        body: {},
      );
      final lastAuthorizedCursor = await localB.readCursor(familyId);
      await expectLater(
        pullB(),
        throwsA(isA<ApiException>().having((e) => e.statusCode, 'status', 404)),
      );
      expect(await localB.readCursor(familyId), lastAuthorizedCursor);
    },
    skip: fixtureUrl == null ? '由服务端隔离 HTTP 用例启动' : false,
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
