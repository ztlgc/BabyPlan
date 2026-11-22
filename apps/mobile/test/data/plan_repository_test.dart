import 'package:babyplan/core/family_date.dart';
import 'package:babyplan/data/api_exception.dart';
import 'package:babyplan/data/plan_repository.dart';
import 'package:babyplan/domain/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../support/test_support.dart';

class _ConflictContinuingRemote implements RemotePlans {
  final sentNotes = <String>[];

  @override
  Future<DayPlan?> readDay(String childId, FamilyDate date) async => null;

  @override
  Future<Json> send(PendingOperation operation) async {
    final note = operation.body['note'] as String? ?? '';
    sentNotes.add(note);
    if (note == '这条冲突') {
      throw ApiException(
        '另一位家长刚更新了记录',
        statusCode: 409,
        code: 'REVISION_CONFLICT',
        details: {
          'current': {
            'revision': 2,
            'status': 'played',
            'participantIds': ['partner-test'],
            'notes': [
              {'authorId': 'partner-test', 'text': '远端备注'},
            ],
          },
          'submitted': 1,
        },
      );
    }
    final itemId = operation.objectKey.substring('participation:'.length);
    return {
      'id': 'participation-$itemId',
      'planItemId': itemId,
      'status': operation.body['status'],
      'participantIds': operation.body['participantIds'],
      'notes': <Object>[],
      'actualMinutes': operation.body['actualMinutes'],
      'again': operation.body['again'],
      'addedBy': testActorId,
      'revision': 1,
    };
  }
}

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    initializeTestTimezones();
  });

  test('一个参与冲突不会阻断其他对象的串行同步', () async {
    final local = await openStore(inMemoryDatabasePath);
    await local.cachePlan(testFamilyId, testPlan());
    final items = testPlan().items.take(2).toList(growable: false);
    final remote = _ConflictContinuingRemote();
    final repository = PlanRepository(
      local: local,
      familyId: testFamilyId,
      childId: testChildId,
      actorId: testActorId,
      remote: remote,
      now: () => testNow,
    );
    await local.saveParticipation(
      familyId: testFamilyId,
      actorId: testActorId,
      itemId: items[0].id,
      input: const ParticipationInput(
        status: ParticipationStatus.played,
        participantIds: [testActorId],
        note: '这条冲突',
      ),
      now: testNow,
    );
    await local.saveParticipation(
      familyId: testFamilyId,
      actorId: testActorId,
      itemId: items[1].id,
      input: const ParticipationInput(
        status: ParticipationStatus.played,
        participantIds: [testActorId],
        note: '这条正常完成',
      ),
      now: testNow,
    );

    final synced = await repository.syncPending();

    expect(synced, 1);
    expect(remote.sentNotes, ['这条冲突', '这条正常完成']);
    expect(await repository.syncIssues(), hasLength(1));
    final participations = await repository.participations();
    expect(participations[items.first.id]!.syncState, 'local_pending');
    expect(participations[items.last.id]!.syncState, 'synced');
    await local.close();
  });
}
