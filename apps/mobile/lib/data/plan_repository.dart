import '../core/family_date.dart';
import '../domain/models.dart';
import 'api_exception.dart';
import 'local_store.dart';

abstract interface class RemotePlans {
  Future<DayPlan?> readDay(String childId, FamilyDate date);
  Future<Json> send(PendingOperation operation);
}

/// 本地数据库是界面的读取来源；远端成功后才推进 outbox。
class PlanRepository {
  PlanRepository({
    required this.local,
    required this.familyId,
    required this.childId,
    required this.actorId,
    this.remote,
    DateTime Function()? now,
  }) : now = now ?? DateTime.now;
  final LocalStore local;
  final String familyId;
  final String childId;
  final String actorId;
  final RemotePlans? remote;
  final DateTime Function() now;

  Future<DayPlan?> readDay(FamilyDate date) =>
      local.readPlan(familyId, childId, date);
  Future<void> refreshDay(FamilyDate date) async {
    final source = remote;
    if (source == null) throw StateError('家庭服务尚未连接，本机资料仍可查看。');
    final plan = await source.readDay(childId, date);
    if (plan != null) {
      if (plan.childId != childId) throw StateError('服务返回的孩子资料不一致。');
      await local.cachePlan(familyId, plan);
    }
  }

  Future<Map<String, LocalParticipation>> participations() =>
      local.readParticipations(familyId);
  Future<String> record(PlanItem item, ParticipationInput input) =>
      local.saveParticipation(
        familyId: familyId,
        actorId: actorId,
        itemId: item.id,
        input: input,
        now: now(),
      );
  Future<void> undoRecord(String itemId) =>
      local.undoParticipation(familyId: familyId, itemId: itemId, now: now());
  Future<DayPlan> setMode(DayPlan plan, String mode) => local.updatePlanMode(
    familyId: familyId,
    planId: plan.id,
    mode: mode,
    now: now(),
  );
  Future<PlanItem> replaceItem({
    required DayPlan plan,
    required PlanItem item,
    required Activity activity,
  }) => local.replacePlanItem(
    familyId: familyId,
    childId: childId,
    planId: plan.id,
    itemId: item.id,
    activity: activity,
    now: now(),
  );
  Future<List<GrowthRecord>> growthRecords() =>
      local.readGrowthRecords(familyId, childId);
  Future<List<GrowthRecord>> deletedGrowthRecords() =>
      local.readDeletedGrowthRecords(familyId, childId);
  Future<GrowthRecord> addGrowthRecord({
    required GrowthRecordType type,
    required FamilyDate date,
    required String text,
    String? recordId,
    double? value,
    String? unit,
    GrowthMeasurementKind? measurementKind,
    GrowthMeasurementMethod? measurementMethod,
    GrowthMeasurementSource? measurementSource,
    bool firstConfirmed = false,
    String? guideId,
    String? observationValue,
    List<PreparedGrowthPhoto> photos = const [],
  }) => local.saveGrowthRecord(
    familyId: familyId,
    childId: childId,
    type: type,
    localDate: date,
    text: text,
    recordId: recordId,
    value: value,
    unit: unit,
    measurementKind: measurementKind,
    measurementMethod: measurementMethod,
    measurementSource: measurementSource,
    firstConfirmed: firstConfirmed,
    guideId: guideId,
    observationValue: observationValue,
    photos: photos,
    now: now(),
  );
  Future<GrowthRecord?> growthRecord(String recordId) =>
      local.readGrowthRecord(familyId, childId, recordId);
  Future<GrowthRecord> updateGrowthRecord({
    required String recordId,
    required GrowthRecordType type,
    required FamilyDate date,
    required String text,
    double? value,
    String? unit,
    GrowthMeasurementKind? measurementKind,
    GrowthMeasurementMethod? measurementMethod,
    GrowthMeasurementSource? measurementSource,
    bool firstConfirmed = false,
    String? guideId,
    String? observationValue,
  }) => local.updateGrowthRecord(
    familyId: familyId,
    childId: childId,
    recordId: recordId,
    type: type,
    localDate: date,
    text: text,
    remote: remote != null,
    value: value,
    unit: unit,
    measurementKind: measurementKind,
    measurementMethod: measurementMethod,
    measurementSource: measurementSource,
    firstConfirmed: firstConfirmed,
    guideId: guideId,
    observationValue: observationValue,
    now: now(),
  );
  Future<void> deleteGrowthRecord(GrowthRecord record) =>
      local.deleteGrowthRecord(
        familyId: familyId,
        childId: childId,
        record: record,
        remote: remote != null,
        now: now(),
      );
  Future<void> restoreGrowthRecord(GrowthRecord record) =>
      local.restoreGrowthRecord(
        familyId: familyId,
        childId: childId,
        record: record,
        remote: remote != null,
        now: now(),
      );
  Future<List<GrowthPhotoUpload>> growthPhotos({String? memoryId}) =>
      local.readGrowthPhotos(familyId, memoryId: memoryId);
  Future<void> saveGrowthRecordBody(GrowthRecord record) =>
      local.saveGrowthRecordBody(familyId, childId, record);
  Future<void> saveGrowthPhoto(GrowthPhotoUpload photo) =>
      local.updateGrowthPhoto(photo);
  Future<void> attachGrowthPhotos({
    required String memoryId,
    required List<PreparedGrowthPhoto> photos,
  }) => local.attachGrowthPhotos(
    familyId: familyId,
    childId: childId,
    memoryId: memoryId,
    photos: photos,
    now: now(),
  );
  Future<void> markGrowthPhotoRemoved(String photoId) =>
      local.markGrowthPhotoRemoved(familyId, photoId);
  Future<void> resetGrowthPhotoForRetry(String photoId) =>
      local.resetGrowthPhotoForRetry(familyId, photoId, now());
  Future<List<Activity>> contentOptions() => local.readContentOptions();
  Future<void> cacheContentOptions(List<Activity> activities) =>
      local.cacheContentOptions(activities);
  Future<List<FamilyBook>> familyBooks() => local.readFamilyBooks(familyId);
  Future<FamilyBook> addFamilyBook({
    required String title,
    required String language,
    required String note,
  }) => local.saveFamilyBook(
    familyId: familyId,
    title: title,
    language: language,
    note: note,
    now: now(),
  );
  Future<void> refreshFamilyBooks(List<FamilyBook> books) =>
      local.cacheFamilyBooks(familyId, books);
  Future<FamilyPreferences> readPreferences() =>
      local.readPreferences(familyId);
  Future<void> savePreferences(FamilyPreferences preferences) =>
      local.savePreferences(familyId, preferences);
  Future<String> extraPlay({
    required PlanItem item,
    required FamilyDate date,
    required List<String> participantIds,
    required String note,
  }) => local.saveExtraPlay(
    familyId: familyId,
    childId: childId,
    actorId: actorId,
    item: item,
    localDate: date,
    participantIds: participantIds,
    note: note,
    now: now(),
  );
  Future<int> pendingCount() => local.pendingCount(familyId);
  Future<List<SyncIssue>> syncIssues() => local.readSyncIssues(familyId);
  Future<void> retrySyncIssue(String operationId) =>
      local.retrySyncIssue(familyId, operationId);
  Future<void> resolveConflict(
    String operationId,
    SyncConflictResolution resolution,
  ) => local.resolveSyncConflict(
    familyId: familyId,
    actorId: actorId,
    operationId: operationId,
    resolution: resolution,
    now: now(),
  );
  Future<String?> withdrawalReason(Activity activity) =>
      local.withdrawalReason(familyId, activity);
  Future<void> saveDraft(String key, Json body) =>
      local.saveDraft(familyId, actorId, key, body);
  Future<Json?> readDraft(String key) =>
      local.readDraft(familyId, actorId, key);
  Future<void> deleteDraft(String key) =>
      local.deleteDraft(familyId, actorId, key);

  /// 只发送能确认的请求；网络错误保留 failed，记录本身始终留在本机。
  Future<int> syncPending({bool Function()? isCurrent}) async {
    final source = remote;
    if (source == null) return 0;
    var synced = 0;
    while (isCurrent?.call() ?? true) {
      final operation = await local.claimNext(
        familyId,
        now(),
        objectPrefixes: const {
          'participation:',
          'day_mode:',
          'play_session:',
          'growth:',
          'growth-update:',
          'growth-delete:',
          'growth-restore:',
          'book:',
          'replace:',
          'preferences:',
        },
      );
      if (operation == null) break;
      if (isCurrent?.call() == false) {
        await local.releaseClaim(familyId, operation.id);
        break;
      }
      try {
        final response = await source.send(operation);
        await local.acknowledge(familyId, operation.id, response);
        synced++;
      } on ApiException catch (error) {
        final conflict =
            error.statusCode == 409 && error.code == 'REVISION_CONFLICT';
        await local.failOperation(
          familyId,
          operation.id,
          code: error.code ?? 'API_ERROR',
          retryAfter: now().add(
            conflict ? const Duration(days: 3650) : const Duration(minutes: 2),
          ),
          conflict: conflict
              ? {
                  'message': error.message,
                  if (error.details != null) ...error.details!,
                }
              : null,
        );
        if (conflict || const {409, 410, 422}.contains(error.statusCode)) {
          continue;
        }
        rethrow;
      } catch (error) {
        await local.failOperation(
          familyId,
          operation.id,
          code: error.runtimeType.toString(),
          retryAfter: now().add(const Duration(minutes: 2)),
        );
        rethrow;
      }
    }
    return synced;
  }
}
