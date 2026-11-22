import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:timezone/timezone.dart' as tz;
import 'package:uuid/uuid.dart';

import '../core/app_config.dart';
import '../core/family_date.dart';
import '../data/api_client.dart';
import '../data/family_sync_repository.dart';
import '../data/local_store.dart';
import '../data/plan_repository.dart';
import '../domain/demo_content.dart';
import '../domain/models.dart';
import '../services/growth_file_store.dart';
import '../services/reminder_notifications.dart';

enum LoadState { loading, ready, empty, error }

enum SaveOutcome { savedLocal, synced }

class GrowthSaveResult {
  const GrowthSaveResult({
    required this.record,
    required this.photoCount,
    this.photoError,
  });

  final GrowthRecord record;
  final int photoCount;
  final String? photoError;
}

class AppController extends ChangeNotifier {
  AppController({
    required this.config,
    required LocalStore local,
    required this.tokenVault,
    required String initialFamilyId,
    required String initialChildId,
    required String initialActorId,
    DateTime Function()? now,
    BabyPlanApi? api,
    ReminderScheduler? reminderScheduler,
    GrowthFileStore? growthFiles,
    ExportFileSaver? exportFiles,
  }) : _rootLocal = local,
       _activeLocal = local,
       familyId = initialFamilyId,
       childId = initialChildId,
       actorId = initialActorId,
       reminderScheduler = reminderScheduler ?? LocalReminderScheduler(),
       growthFiles = growthFiles ?? LocalGrowthFileStore(),
       exportFiles = exportFiles ?? const AndroidExportFileSaver(),
       now = now ?? DateTime.now {
    final service =
        api ??
        (config.apiBaseUrl == null
            ? null
            : BabyPlanApi(baseUri: config.apiBaseUrl!, vault: tokenVault));
    this.api = service;
    repository = _createRepository();
  }

  final AppConfig config;
  final LocalStore _rootLocal;
  LocalStore _activeLocal;
  LocalStore get local => _activeLocal;
  final _accountStores = <(Uri, String), Future<LocalStore>>{};
  final TokenVault tokenVault;
  String familyId;
  String childId;
  String actorId;
  final DateTime Function() now;
  late PlanRepository repository;
  BabyPlanApi? api;
  final ReminderScheduler reminderScheduler;
  final GrowthFileStore growthFiles;
  final ExportFileSaver exportFiles;

  LoadState loadState = LoadState.loading;
  String? loadError;
  DayPlan? plan;
  Map<String, LocalParticipation> participations = const {};
  List<GrowthRecord> growthRecords = const [];
  List<GrowthRecord> deletedGrowthRecords = const [];
  Map<String, List<GrowthPhotoUpload>> growthPhotosByRecord = const {};
  FamilyPreferences preferences = const FamilyPreferences();
  int pendingCount = 0;
  List<SyncIssue> syncIssues = const [];
  bool isPreview = true;
  bool loginBusy = false;
  String? accountLabel;
  ThemeMode themeMode = ThemeMode.system;
  AccountBootstrap? account;
  FamilySummary? activeFamily;
  ChildSummary? activeChild;
  ReminderPreference? reminderPreference;
  List<FamilyBook> books = const [];
  List<Activity> contentOptions = const [];
  Map<(String, int), String> _withdrawals = const {};
  bool checkingContentSafety = false;
  bool contentSafetyCurrent = false;
  bool familyCacheLocked = false;
  Future<void>? _safetyCheck;
  (PlanRepository, Future<int>)? _pendingSync;
  (PlanRepository, Future<String?>)? _refreshRequest;
  (int, Future<void>)? _initialization;
  (PlanRepository, Future<void>)? _photoSyncRequest;
  int _safetyGeneration = 0;
  int _scopeGeneration = 0;
  int _reminderGeneration = 0;
  Future<void> _reminderTail = Future<void>.value();
  bool _changingScope = false;
  bool _disposed = false;
  List<DayPlan> weekPlans = const [];
  String? plannerMessage;
  bool photoSyncBusy = false;
  bool exportBusy = false;
  int todayRequest = 0;

  DateTime get nowValue => now();
  FamilyDate get today {
    try {
      return FamilyDate.at(nowValue, activeFamily?.timezone ?? 'Asia/Shanghai');
    } on Object {
      return FamilyDate(nowValue.year, nowValue.month, nowValue.day);
    }
  }

  bool get canRecordToday => plan != null && plan!.date.compareTo(today) <= 0;
  bool get connected =>
      !familyCacheLocked && repository.remote != null && activeChild != null;
  bool get localCandidateMode =>
      config.demo ||
      (api == null && account == null && familyId.startsWith('demo-'));
  int get conflictCount => syncIssues.where((issue) => issue.isConflict).length;
  List<FamilyMember> get companionMembers {
    if (config.demo) {
      return const [
        FamilyMember(
          userId: 'demo-partner',
          role: 'caregiver',
          active: true,
          displayName: '另一位家长',
          familyId: 'demo-family',
          revision: 1,
        ),
      ];
    }
    return List.unmodifiable(
      (activeFamily?.members ?? const <FamilyMember>[]).where(
        (member) =>
            member.active &&
            member.userId != actorId &&
            member.familyId == familyId,
      ),
    );
  }

  String? withdrawalFor(Activity activity) =>
      _withdrawals[(activity.id, activity.revision)] ??
      (activity.withdrawn ? '这项玩法已停止推荐。' : null);

  String? blockedReason(PlanItem item) {
    if (familyCacheLocked) return '家庭资料已锁定，请重新登录并确认访问权限。';
    if (withdrawalFor(item.activity) case final String reason) return reason;
    if (item.blocked) {
      return item.json['withdrawalReason'] as String? ?? '这项玩法已停止推荐。';
    }
    return null;
  }

  List<Activity> get discoverableActivities {
    if (familyCacheLocked || checkingContentSafety) return const [];
    final source = repository.remote != null || account != null
        ? contentOptions
        : DemoContent.discoveryActivities;
    return source
        .where(
          (activity) =>
              activity.ageBands.contains(currentAgeBand) &&
              (preferences.languageMode != 'zh' ||
                  activity.kind != 'english') &&
              withdrawalFor(activity) == null,
        )
        .toList(growable: false);
  }

  String? get currentAgeBand => activeChild == null
      ? (localCandidateMode ? 'm18_23' : null)
      : activeChild!.ageBandAt(today);

  String get childAgeLabel {
    final months = activeChild?.ageAt(today);
    return months == null ? '年龄待补充' : '$months 月龄';
  }

  void _requireFamilyAccess() {
    if (familyCacheLocked) throw StateError('家庭资料已锁定，待同步记录仍保存在本机。');
    if (_changingScope || _disposed) throw StateError('登录状态正在更改，请稍后再试。');
  }

  bool _isCurrent(PlanRepository source) =>
      source == repository &&
      !familyCacheLocked &&
      !_changingScope &&
      !_disposed;

  bool _scopeIsCurrent(int generation) =>
      generation == _scopeGeneration && !_changingScope && !_disposed;

  Future<void> verifyContentSafety() => _verifyContentSafety();

  Future<void> _verifyContentSafety({bool scopeVerified = false}) {
    final service = api;
    final current = repository;
    if (service == null || current.remote == null || familyCacheLocked) {
      return Future<void>.value();
    }
    return _safetyCheck ??= Future<void>.microtask(
      () => _checkContentSafety(service, current, scopeVerified: scopeVerified),
    );
  }

  Future<void> _checkContentSafety(
    BabyPlanApi service,
    PlanRepository current, {
    required bool scopeVerified,
  }) async {
    final generation = _safetyGeneration;
    bool isCurrent() => generation == _safetyGeneration && _isCurrent(current);
    if (!isCurrent()) return;
    checkingContentSafety = true;
    notifyListeners();
    try {
      // 家庭权限比公共内容列表先确认；网络失败仍允许看已有的离线缓存。
      if (!scopeVerified) {
        final authorized = await service.readBootstrap();
        if (!isCurrent()) return;
        if (!await _refreshAuthorizedProfile(authorized, current)) {
          if (!isCurrent()) return;
          await _lockFamilyCache();
          throw const ApiException('家庭访问已取消。', statusCode: 403);
        }
      }
      if (!isCurrent()) return;
      final safety = await service.readContentSafety();
      if (!isCurrent()) return;
      await current.local.cacheContentSafety(current.familyId, safety);
      if (!isCurrent()) return;
      final withdrawals = await current.local.readWithdrawals(current.familyId);
      if (!isCurrent()) return;
      _withdrawals = withdrawals;
      contentOptions = safety.activities;
      contentSafetyCurrent = true;
    } on ApiException catch (error) {
      if (generation == _safetyGeneration) {
        contentSafetyCurrent = false;
        await _lockIfUnauthorized(error, current);
      }
      rethrow;
    } on Object {
      if (generation == _safetyGeneration) contentSafetyCurrent = false;
      rethrow;
    } finally {
      if (generation == _safetyGeneration) {
        _safetyCheck = null;
        checkingContentSafety = false;
        notifyListeners();
      }
    }
  }

  Future<int> _syncPending({bool safetyVerified = false}) {
    final current = repository;
    final pending = _pendingSync;
    if (pending != null && pending.$1 == current) return pending.$2;
    late final Future<int> operation;
    operation =
        Future<int>.microtask(
          () => _runPendingSync(current, safetyVerified: safetyVerified),
        ).whenComplete(() {
          if (_pendingSync?.$2 == operation) _pendingSync = null;
        });
    _pendingSync = (current, operation);
    return operation;
  }

  Future<int> _runPendingSync(
    PlanRepository current, {
    required bool safetyVerified,
  }) async {
    try {
      if (!_isCurrent(current)) return 0;
      if (!safetyVerified) await verifyContentSafety();
      if (!_isCurrent(current)) return 0;
      return await current.syncPending(isCurrent: () => _isCurrent(current));
    } on ApiException catch (error) {
      await _lockIfUnauthorized(error, current);
      rethrow;
    }
  }

  Future<void> _lockIfUnauthorized(
    ApiException error,
    PlanRepository source,
  ) async {
    if (!_isCurrent(source)) return;
    if (error.statusCode == 401) {
      accountLabel = null;
      await Future.wait([
        _lockFamilyCache(),
        api?.clearLocalSession() ?? tokenVault.clearSession(),
      ]);
    } else if ((error.statusCode == 404 || error.statusCode == 403) &&
        activeFamily != null) {
      try {
        final service = api;
        if (service == null) return;
        final authorized = await service.readBootstrap();
        if (_isCurrent(source) && _scopeFor(authorized, source) == null) {
          await _lockFamilyCache();
        }
      } on ApiException catch (bootstrapError) {
        if (bootstrapError.statusCode == 401 && _isCurrent(source)) {
          accountLabel = null;
          await Future.wait([
            _lockFamilyCache(),
            api?.clearLocalSession() ?? tokenVault.clearSession(),
          ]);
        }
      } on Object {
        // 无法确认成员资格时保留离线状态；下次重新检查。
      }
    }
  }

  Future<void> initialize() {
    final generation = _scopeGeneration;
    final existing = _initialization;
    if (existing != null && existing.$1 == generation) return existing.$2;
    late final Future<void> operation;
    operation = Future<void>.microtask(() => _initialize(generation))
        .whenComplete(() {
          if (_initialization?.$2 == operation) _initialization = null;
        });
    _initialization = (generation, operation);
    return operation;
  }

  Future<void> _initialize(int generation) async {
    if (!_scopeIsCurrent(generation)) return;
    loadState = LoadState.loading;
    loadError = null;
    notifyListeners();
    var current = repository;
    var scopeVerified = false;
    try {
      if (api == null && config.apiBaseUrl == null) {
        final saved = await tokenVault.readServiceUri();
        if (!_scopeIsCurrent(generation)) return;
        if (saved != null) {
          api = BabyPlanApi(
            baseUri: _validatedServiceUri(saved),
            vault: tokenVault,
          );
        }
      }
      final session = await tokenVault.readSession();
      if (!_scopeIsCurrent(generation)) return;
      if (current.local != _rootLocal && current.actorId != session?.userId) {
        _returnToLocalScope();
        current = repository;
      }
      accountLabel = session?.displayName ?? session?.userId;
      final service = api;
      if (session != null && service != null) {
        try {
          final bootstrap = await service.readBootstrap();
          if (!_scopeIsCurrent(generation)) return;
          if (bootstrap.userId != session.userId) {
            throw const ApiException('家庭服务返回的登录身份不一致。', statusCode: 401);
          }
          await _applyBootstrap(bootstrap, generation);
          if (!_scopeIsCurrent(generation)) return;
          current = repository;
          scopeVerified = true;
        } on ApiException catch (error) {
          if (!_scopeIsCurrent(generation)) return;
          loadError = _friendly(error);
          if (error.statusCode == 401) {
            await _lockIfUnauthorized(error, current);
          } else if ((error.statusCode ?? 0) >= 500) {
            await _restoreOfflineScope(session.userId, generation);
          }
        } on Object catch (error) {
          if (!_scopeIsCurrent(generation)) return;
          loadError = _friendly(error);
          await _restoreOfflineScope(session.userId, generation);
        }
      }
      if (!_scopeIsCurrent(generation) || familyCacheLocked) return;
      current = repository;
      await current.local.recoverInterrupted(current.familyId);
      if (!_isCurrent(current)) return;
      if (loadError == null && current.remote != null) {
        loadError = await _refreshConnected(
          current,
          scopeVerified: scopeVerified,
        );
        if (!_isCurrent(current)) return;
      }
      await _loadCachedFamily(current);
      if (_isCurrent(current)) {
        _finishLoad();
        await _refreshReminderState();
      }
    } on Object catch (error) {
      if (!_isCurrent(current) || !_scopeIsCurrent(generation)) return;
      loadState = LoadState.error;
      loadError = _friendly(error);
    }
    if (_isCurrent(current) && _scopeIsCurrent(generation)) notifyListeners();
  }

  Future<void> refresh({bool announce = false}) async {
    final current = repository;
    final generation = _scopeGeneration;
    if (!_scopeIsCurrent(generation)) return;
    final existing = _refreshRequest;
    final Future<String?> operation;
    if (existing != null && existing.$1 == current) {
      operation = existing.$2;
    } else {
      late final Future<String?> request;
      request = Future<String?>.microtask(() => _refresh(current, generation))
          .whenComplete(() {
            if (_refreshRequest?.$2 == request) _refreshRequest = null;
          });
      _refreshRequest = (current, request);
      operation = request;
    }
    final error = await operation;
    if (announce && error != null) throw StateError(error);
  }

  Future<String?> _refresh(PlanRepository current, int generation) async {
    if (!_scopeIsCurrent(generation)) return null;
    // 刷新时保留已有安排；空列表才显示加载状态。
    if (plan == null) loadState = LoadState.loading;
    loadError = null;
    notifyListeners();
    try {
      var scopeVerified = false;
      final service = api;
      if (familyCacheLocked && service != null) {
        final bootstrap = await service.readBootstrap();
        if (!_scopeIsCurrent(generation)) return null;
        final session = await tokenVault.readSession();
        if (!_scopeIsCurrent(generation)) return null;
        if (session == null || bootstrap.userId != session.userId) {
          throw const ApiException('家庭服务返回的登录身份不一致。', statusCode: 401);
        }
        await _applyBootstrap(bootstrap, generation);
        _requireFamilyAccess();
        if (!_scopeIsCurrent(generation)) return null;
        current = repository;
        scopeVerified = true;
      }
      if (!_isCurrent(current)) return null;
      if (current.remote != null) {
        final error = await _refreshConnected(
          current,
          scopeVerified: scopeVerified,
        );
        if (!_isCurrent(current)) return familyCacheLocked ? loadError : null;
        loadError = error;
      }
      await _loadCachedFamily(current);
      if (!_isCurrent(current)) return null;
      _finishLoad();
      await _refreshReminderState();
    } on Object catch (error) {
      if (!_scopeIsCurrent(generation) || current != repository) return null;
      if (error is ApiException) await _lockIfUnauthorized(error, current);
      if (!_isCurrent(current)) return familyCacheLocked ? loadError : null;
      loadError = _friendly(error);
      _finishLoad();
    }
    if (!_isCurrent(current)) return null;
    notifyListeners();
    return loadError;
  }

  Future<String?> _refreshConnected(
    PlanRepository current, {
    required bool scopeVerified,
  }) async {
    final service = api;
    if (service == null || !_isCurrent(current)) return null;
    final sync = FamilySyncRepository(local: current.local, service: service);
    bool isCurrent() => _isCurrent(current);
    String? errorMessage;
    try {
      await _verifyContentSafety(scopeVerified: scopeVerified);
      if (!isCurrent()) return null;
      try {
        await _syncPending(safetyVerified: true);
      } on Object catch (error) {
        // 一条写入失败不应挡住其他家庭成员已经同步的更新。
        errorMessage = _friendly(error);
      }
      if (!isCurrent()) return null;
      await sync.pull(current.familyId, isCurrent: isCurrent);
      if (!isCurrent()) return null;
      await _loadCachedFamily(current);
      if (!isCurrent()) return null;
      if (await _ensureWeeklyPlans(current, service)) {
        if (!isCurrent()) return null;
        // 编排响应可能来自较早的幂等重放；变更流才是缓存的事实来源。
        await sync.pull(current.familyId, isCurrent: isCurrent);
        if (!isCurrent()) return null;
        await _loadCachedFamily(current);
      }
    } on ApiException catch (error) {
      await _lockIfUnauthorized(error, current);
      return _friendly(error);
    } on Object catch (error) {
      return _friendly(error);
    }

    if (!isCurrent()) return null;
    try {
      await _cleanupRetiredPhotos(current);
      if (isCurrent()) await syncGrowthPhotos();
    } on ApiException catch (error) {
      await _lockIfUnauthorized(error, current);
      // 照片队列保留每张照片的状态，下一次联网可以继续。
    } on Object {
      // 本机文件清理或照片上传失败不影响文字和今日安排。
    }
    if (!isCurrent()) return null;
    final reminderGeneration = _reminderGeneration;
    try {
      final remote = await service.readReminder();
      if (isCurrent()) {
        await _applyRemoteReminder(remote, current, reminderGeneration);
      }
    } on ApiException catch (error) {
      await _lockIfUnauthorized(error, current);
    } on Object {
      // 提醒独立于家庭偏好；读取失败保留这台手机已生效的提醒。
    }
    return errorMessage;
  }

  Future<void> _loadCachedFamily(PlanRepository current) async {
    if (!_isCurrent(current)) return;
    final date = today;
    final localOnly = current.remote == null && localCandidateMode;
    var cached = await current.readDay(date);
    if (!_isCurrent(current)) return;
    if (cached == null && localOnly) {
      await current.local.cachePlan(
        current.familyId,
        DemoContent.dayPlan(date),
      );
      if (!_isCurrent(current)) return;
      cached = await current.readDay(date);
    }
    if (!_isCurrent(current)) return;
    if (localOnly) {
      await current.cacheContentOptions(DemoContent.discoveryActivities);
      if (!_isCurrent(current)) return;
    }
    final week = await _readWeekPlans(current, date, localOnly: localOnly);
    if (!_isCurrent(current)) return;
    final cachedParticipations = await current.participations();
    if (!_isCurrent(current)) return;
    final cachedGrowth = await current.growthRecords();
    if (!_isCurrent(current)) return;
    final cachedDeletedGrowth = await current.deletedGrowthRecords();
    if (!_isCurrent(current)) return;
    final cachedPhotos = await current.growthPhotos();
    if (!_isCurrent(current)) return;
    final cachedBooks = await current.familyBooks();
    if (!_isCurrent(current)) return;
    final cachedOptions = await current.contentOptions();
    if (!_isCurrent(current)) return;
    final cachedWithdrawals = await current.local.readWithdrawals(
      current.familyId,
    );
    if (!_isCurrent(current)) return;
    final cachedPrefs = await current.readPreferences();
    if (!_isCurrent(current)) return;
    final pending = await current.pendingCount();
    if (!_isCurrent(current)) return;
    final issues = await current.syncIssues();
    if (!_isCurrent(current)) return;

    plan = cached;
    weekPlans = week;
    participations = cachedParticipations;
    growthRecords = cachedGrowth;
    deletedGrowthRecords = cachedDeletedGrowth;
    _applyCachedGrowthPhotos(cachedPhotos);
    books = cachedBooks;
    contentOptions = cachedOptions;
    _withdrawals = cachedWithdrawals;
    preferences = cachedPrefs;
    pendingCount = pending;
    syncIssues = issues;
    isPreview = localOnly;
  }

  void _finishLoad() {
    loadState = plan == null && loadError != null
        ? LoadState.error
        : plan?.items.isNotEmpty == true
        ? LoadState.ready
        : LoadState.empty;
  }

  Future<void> _cleanupRetiredPhotos(PlanRepository current) async {
    final paths = await current.local.readRetiredGrowthFiles();
    for (final path in paths) {
      if (!_isCurrent(current)) return;
      try {
        await growthFiles.deletePhoto(path);
        if (!_isCurrent(current)) return;
        await current.local.acknowledgeRetiredGrowthFile(path);
      } on Object {
        // 未删除的应用私有文件下次再清理。
      }
    }
  }

  Future<SaveOutcome> record(PlanItem item, ParticipationInput input) async {
    _requireFamilyAccess();
    if (checkingContentSafety || blockedReason(item) != null) {
      throw StateError('这项玩法暂不可记录。');
    }
    final source = repository;
    await source.record(item, input);
    await _reloadParticipationState(source);
    if (!_isCurrent(source) || source.remote == null) {
      return SaveOutcome.savedLocal;
    }
    try {
      await _syncPending();
    } on Object {
      // 本机先保存。后续在可用网络下重试。
    }
    await _reloadParticipationState(source);
    if (!_isCurrent(source) || participations[item.id]?.syncState != 'synced') {
      return SaveOutcome.savedLocal;
    }
    return SaveOutcome.synced;
  }

  Future<void> undo(String itemId) async {
    _requireFamilyAccess();
    final source = repository;
    await source.undoRecord(itemId);
    await _reloadParticipationState(source);
    if (!_isCurrent(source) || source.remote == null) return;
    try {
      await _syncPending();
    } on Object {
      // 撤销已保存在本机，网络恢复后继续。
    }
    await _reloadParticipationState(source);
  }

  Future<void> retrySyncIssue(String operationId) async {
    _requireFamilyAccess();
    final source = repository;
    await source.retrySyncIssue(operationId);
    await _reloadSyncState(source);
    if (!_isCurrent(source) || source.remote == null) return;
    try {
      await _syncPending();
    } on Object {
      // 仍无法联网时，操作继续留在本机等待下次刷新。
    }
    if (!_isCurrent(source)) return;
    await _loadCachedFamily(source);
    if (_isCurrent(source)) notifyListeners();
  }

  Future<void> resolveSyncConflict(
    SyncIssue issue,
    SyncConflictResolution resolution,
  ) async {
    _requireFamilyAccess();
    final source = repository;
    await source.resolveConflict(issue.operationId, resolution);
    await _loadCachedFamily(source);
    if (!_isCurrent(source)) return;
    _finishLoad();
    notifyListeners();
    if (source.remote != null) await refresh();
  }

  Future<void> _reloadParticipationState(PlanRepository source) async {
    if (!_isCurrent(source)) return;
    final cached = await source.participations();
    if (!_isCurrent(source)) return;
    participations = cached;
    await _refreshReminderState();
    await _reloadSyncState(source);
  }

  Future<void> _reloadSyncState([PlanRepository? current]) async {
    final source = current ?? repository;
    if (!_isCurrent(source)) return;
    final pending = await source.pendingCount();
    if (!_isCurrent(source)) return;
    final issues = await source.syncIssues();
    if (!_isCurrent(source)) return;
    pendingCount = pending;
    syncIssues = issues;
    notifyListeners();
  }

  Future<void> setLiteDay(bool lite) async {
    _requireFamilyAccess();
    final current = plan;
    if (current == null) return;
    final source = repository;
    final updated = await source.setMode(current, lite ? 'lite' : 'standard');
    if (!_isCurrent(source)) return;
    _replaceVisibleDay(current.date, updated);
    await _refreshReminderState();
    await _reloadSyncState(source);
    if (!_isCurrent(source) || source.remote == null) return;
    try {
      await _syncPending();
    } on Object {
      // 离线时保留本机安排和待同步选择。
    }
    if (!_isCurrent(source)) return;
    final confirmed = await source.readDay(current.date);
    if (!_isCurrent(source)) return;
    _replaceVisibleDay(current.date, confirmed);
    await _refreshReminderState();
    await _reloadSyncState(source);
  }

  void _replaceVisibleDay(FamilyDate date, DayPlan? day) {
    if (date == today) plan = day;
    weekPlans = List.unmodifiable([
      for (final cached in weekPlans)
        if (cached.date != date) cached else ?day,
    ]);
  }

  Future<GrowthSaveResult> addGrowth({
    required GrowthRecordType type,
    required FamilyDate date,
    required String text,
    List<String> photoPaths = const [],
    double? value,
    String? unit,
    GrowthMeasurementKind? measurementKind,
    GrowthMeasurementMethod? measurementMethod,
    GrowthMeasurementSource? measurementSource,
    bool firstConfirmed = false,
    String? guideId,
    String? observationValue,
  }) async {
    _requireFamilyAccess();
    if (photoPaths.length > maxGrowthPhotosPerRecord) {
      throw const FormatException('一条记录最多保存 5 张照片。');
    }
    if (photoPaths.isNotEmpty &&
        type != GrowthRecordType.quote &&
        type != GrowthRecordType.story &&
        type != GrowthRecordType.first) {
      throw const FormatException('照片只能附加到原话、小故事或第一次记录。');
    }
    final recordId = const Uuid().v4();
    final source = repository;
    final record = await source.addGrowthRecord(
      recordId: recordId,
      type: type,
      date: date,
      text: text,
      value: value,
      unit: unit,
      measurementKind: measurementKind,
      measurementMethod: measurementMethod,
      measurementSource: measurementSource,
      firstConfirmed: firstConfirmed,
      guideId: guideId,
      observationValue: observationValue,
    );
    var copiedPhotos = const <PreparedGrowthPhoto>[];
    String? photoError;
    if (photoPaths.isNotEmpty) {
      try {
        copiedPhotos = await growthFiles.copyPhotos(
          familyId: source.familyId,
          childId: source.childId,
          recordId: recordId,
          sourcePaths: photoPaths,
        );
        await source.attachGrowthPhotos(
          memoryId: recordId,
          photos: copiedPhotos,
        );
      } on Object catch (error) {
        photoError = _friendly(error);
        for (final photo in copiedPhotos) {
          try {
            await growthFiles.deletePhoto(photo.localPath);
          } on Object {
            // 清理失败不能让已经保存的正文变成失败。
          }
        }
        copiedPhotos = const [];
      }
    }
    await _reloadGrowth(source);
    if (_isCurrent(source) && source.remote != null) {
      try {
        await _syncPending();
      } on Object {
        // 记录已经完整保存在本机 outbox，网络恢复后继续。
      }
      try {
        if (_isCurrent(source)) await syncGrowthPhotos();
      } on Object {
        // 正文已保存，照片保留独立状态等待重试。
      }
      await _reloadGrowth(source);
    }
    final persistedPhotos = await source.growthPhotos(memoryId: recordId);
    return GrowthSaveResult(
      record: (await source.growthRecord(recordId)) ?? record,
      photoCount: persistedPhotos.length,
      photoError: photoError,
    );
  }

  Future<void> _reloadGrowth(PlanRepository source) async {
    if (!_isCurrent(source)) return;
    final saved = await source.growthRecords();
    final deleted = await source.deletedGrowthRecords();
    if (!_isCurrent(source)) return;
    growthRecords = saved;
    deletedGrowthRecords = deleted;
    await _reloadGrowthPhotos(source);
    await _reloadSyncState(source);
  }

  Future<GrowthRecord> updateGrowth({
    required GrowthRecord record,
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
  }) async {
    _requireFamilyAccess();
    final source = repository;
    final updated = await source.updateGrowthRecord(
      recordId: record.id,
      type: record.type,
      date: date,
      text: text,
      value: value,
      unit: unit,
      measurementKind: measurementKind,
      measurementMethod: measurementMethod,
      measurementSource: measurementSource,
      firstConfirmed: firstConfirmed,
      guideId: guideId,
      observationValue: observationValue,
    );
    if (!_isCurrent(source)) return updated;
    await _reloadGrowth(source);
    if (source.remote != null) {
      try {
        await _syncPending();
      } on Object {
        // 更正已完整保存在本机 outbox，联网后继续。
      }
      if (_isCurrent(source)) await _reloadGrowth(source);
    }
    return updated;
  }

  Future<void> deleteGrowth(GrowthRecord record) async {
    _requireFamilyAccess();
    final source = repository;
    await source.deleteGrowthRecord(record);
    if (!_isCurrent(source)) return;
    await _reloadGrowth(source);
    if (source.remote != null) {
      try {
        await _syncPending();
      } on Object {
        // 回收操作已保存在本机 outbox，界面仍显示这条移除请求。
      }
      if (_isCurrent(source)) await _reloadGrowth(source);
    }
  }

  Future<void> restoreGrowth(GrowthRecord record) async {
    _requireFamilyAccess();
    final source = repository;
    await source.restoreGrowthRecord(record);
    if (!_isCurrent(source)) return;
    await _reloadGrowth(source);
    if (source.remote != null) {
      try {
        await _syncPending();
      } on Object {
        // 恢复请求已保存在本机 outbox，恢复按钮可以等待下次同步。
      }
      if (_isCurrent(source)) await _reloadGrowth(source);
    }
  }

  Future<void> saveGrowthDraft(Json body) =>
      repository.saveDraft('growth-editor', body);

  Future<Json?> readGrowthDraft() async {
    _requireFamilyAccess();
    return repository.readDraft('growth-editor');
  }

  Future<void> deleteGrowthDraft() => repository.deleteDraft('growth-editor');

  Future<void> syncGrowthPhotos() {
    final source = repository;
    final service = api;
    if (!_isCurrent(source) || service == null || source.remote == null) {
      return Future<void>.value();
    }
    final existing = _photoSyncRequest;
    if (existing != null && existing.$1 == source) return existing.$2;
    late final Future<void> request;
    request = Future<void>.microtask(() => _syncGrowthPhotos(source, service))
        .whenComplete(() {
          if (_photoSyncRequest?.$2 == request) _photoSyncRequest = null;
        });
    _photoSyncRequest = (source, request);
    return request;
  }

  Future<void> _syncGrowthPhotos(
    PlanRepository source,
    BabyPlanApi service,
  ) async {
    if (!_isCurrent(source)) return;
    photoSyncBusy = true;
    notifyListeners();
    try {
      final photos = await source.growthPhotos();
      final recordIds = <String>{};
      for (final photo in photos) {
        if (!_isCurrent(source)) return;
        if (photo.state == 'removed' ||
            photo.state == 'linked' ||
            photo.state == 'failed' ||
            photo.state == 'link_failed') {
          continue;
        }
        final record = await source.growthRecord(photo.memoryId);
        if (!_isCurrent(source)) return;
        if (record == null ||
            record.syncState != 'synced' ||
            record.serverRevision < 1) {
          continue;
        }
        await _uploadGrowthPhoto(source, service, photo);
        recordIds.add(photo.memoryId);
      }
      for (final recordId in recordIds) {
        if (!_isCurrent(source)) return;
        await _linkReadyGrowthPhotos(source, service, recordId);
      }
      final updated = await source.growthRecords();
      if (!_isCurrent(source)) return;
      growthRecords = updated;
      await _reloadGrowthPhotos(source);
    } finally {
      if (_isCurrent(source)) {
        photoSyncBusy = false;
        notifyListeners();
      }
    }
  }

  Future<void> retryGrowthPhoto(String photoId) async {
    _requireFamilyAccess();
    final source = repository;
    final service = api;
    final photos = await source.growthPhotos();
    if (!_isCurrent(source)) return;
    GrowthPhotoUpload? photo;
    for (final item in photos) {
      if (item.id == photoId) {
        photo = item;
        break;
      }
    }
    if (photo == null) throw StateError('没有找到这张待同步照片。');
    if (photo.state == 'link_failed' || photo.state == 'upload_failed') {
      await source.saveGrowthPhoto(
        photo.copyWith(
          state: photo.state == 'link_failed' ? 'ready' : 'pending',
          clearError: true,
          updatedAt: nowValue,
        ),
      );
    } else {
      final serverId = photo.serverMediaId;
      if (serverId != null && service != null) {
        try {
          await service.deleteMedia(
            mediaId: serverId,
            operationId: const Uuid().v4(),
          );
        } on ApiException catch (error) {
          if (error.statusCode != 404) rethrow;
        }
      }
      if (!_isCurrent(source)) return;
      await source.resetGrowthPhotoForRetry(photoId);
    }
    if (!_isCurrent(source)) return;
    await syncGrowthPhotos();
    await _reloadGrowth(source);
  }

  Future<void> removeGrowthPhoto(String photoId) async {
    _requireFamilyAccess();
    final source = repository;
    final service = api;
    final photos = await source.growthPhotos();
    if (!_isCurrent(source)) return;
    GrowthPhotoUpload? photo;
    for (final item in photos) {
      if (item.id == photoId) {
        photo = item;
        break;
      }
    }
    if (photo == null) return;
    final serverId = photo.serverMediaId;
    if (serverId != null && service != null) {
      await service.deleteMedia(
        mediaId: serverId,
        operationId: const Uuid().v4(),
      );
    }
    if (!_isCurrent(source)) return;
    await source.markGrowthPhotoRemoved(photoId);
    final record = await source.growthRecord(photo.memoryId);
    if (record != null && serverId != null) {
      await source.saveGrowthRecordBody(
        record.copyWith(
          mediaIds: record.mediaIds
              .where((id) => id != serverId)
              .toList(growable: false),
        ),
      );
    }
    await growthFiles.deletePhoto(photo.localPath);
    await _reloadGrowth(source);
  }

  Future<String?> mediaViewLink(String mediaId) async {
    _requireFamilyAccess();
    final source = repository;
    final service = api;
    if (service == null) return null;
    final media = await service.readMedia(mediaId);
    return _isCurrent(source) ? media.downloadUrl : null;
  }

  Future<void> _uploadGrowthPhoto(
    PlanRepository source,
    BabyPlanApi service,
    GrowthPhotoUpload original,
  ) async {
    var photo = original.copyWith(
      attempts: original.attempts + 1,
      updatedAt: nowValue,
      clearError: true,
    );
    await source.saveGrowthPhoto(photo);
    bool current() => _isCurrent(source);
    Future<bool> obtainTicket() async {
      if (!current()) return false;
      final ticket = await service.createMediaUpload(
        memoryId: photo.memoryId,
        operationId: photo.createOperationId,
        mime: photo.mime,
        byteSize: photo.byteSize,
        sha256: photo.sha256,
      );
      if (!current()) return false;
      if (photo.serverMediaId != null &&
          ticket.media.id != photo.serverMediaId) {
        throw const FormatException('服务返回了不同的照片，已保留本机文件。');
      }
      photo = photo.copyWith(
        serverMediaId: ticket.media.id,
        uploadUrl: ticket.uploadUrl.toString(),
        uploadExpiresAt: ticket.expiresAt,
        state: 'uploading',
        updatedAt: nowValue,
      );
      await source.saveGrowthPhoto(photo);
      return current();
    }

    try {
      if (!current()) return;
      var media = photo.serverMediaId == null
          ? null
          : await service.readMedia(photo.serverMediaId!);
      if (!current()) return;
      if (media?.ready == true) {
        await _markPhotoState(source, photo, 'ready');
        return;
      }
      if (media?.failed == true) {
        await _markPhotoState(
          source,
          photo,
          'failed',
          errorCode: 'MEDIA_PROCESSING_FAILED',
        );
        return;
      }
      if (media?.state != 'processing') {
        if (photo.serverMediaId == null ||
            photo.uploadUrl == null ||
            photo.uploadExpiresAt == null ||
            !photo.uploadExpiresAt!.isAfter(nowValue.toUtc())) {
          if (!await obtainTicket()) return;
        }
        final bytes = await growthFiles.readPhoto(photo.localPath);
        if (!current()) return;
        Future<void> upload() => service.uploadMediaBytes(
          uploadUrl: Uri.parse(photo.uploadUrl!),
          bytes: bytes,
          mime: photo.mime,
        );
        try {
          await upload();
        } on ApiException catch (error) {
          if (!current()) return;
          if (error.statusCode != 404 && error.statusCode != 403) rethrow;
          // 会话更新使旧票据失效；用原操作标识为同一张照片续签一次。
          if (!await obtainTicket()) return;
          await upload();
        }
        if (!current()) return;
        photo = photo.copyWith(state: 'uploaded', updatedAt: nowValue);
        await source.saveGrowthPhoto(photo);
        if (!current()) return;
        try {
          media = await service.completeMediaUpload(
            mediaId: photo.serverMediaId!,
            operationId: photo.completeOperationId,
          );
        } on ApiException catch (error) {
          if (!current()) return;
          if (error.statusCode != 409) rethrow;
          media = await service.readMedia(photo.serverMediaId!);
        }
        if (!current()) return;
        photo = photo.copyWith(
          state: media.state,
          clearTicket: true,
          updatedAt: nowValue,
        );
        await source.saveGrowthPhoto(photo);
      }
      if (media?.state == 'processing') {
        for (var attempt = 0; attempt < 6; attempt++) {
          await Future<void>.delayed(
            Duration(milliseconds: 400 + attempt * 200),
          );
          if (!current()) return;
          media = await service.readMedia(photo.serverMediaId!);
          if (!current()) return;
          if (media.ready || media.failed) break;
        }
        photo = photo.copyWith(
          state: media?.state ?? 'processing',
          updatedAt: nowValue,
        );
        await source.saveGrowthPhoto(photo);
      }
      if (!current()) return;
      if (media?.ready == true) {
        await _markPhotoState(source, photo, 'ready');
      } else if (media?.failed == true) {
        await _markPhotoState(
          source,
          photo,
          'failed',
          errorCode: 'MEDIA_PROCESSING_FAILED',
        );
      }
    } on Object catch (error) {
      if (!current()) return;
      await _markPhotoState(
        source,
        photo,
        'upload_failed',
        errorCode: error is ApiException
            ? error.code
            : error.runtimeType.toString(),
      );
      rethrow;
    }
  }

  Future<void> _linkReadyGrowthPhotos(
    PlanRepository source,
    BabyPlanApi service,
    String memoryId,
  ) async {
    final record = await source.growthRecord(memoryId);
    if (!_isCurrent(source) || record == null) return;
    final photos = await source.growthPhotos(memoryId: memoryId);
    if (!_isCurrent(source)) return;
    final ready = photos.where(
      (photo) =>
          photo.state == 'ready' &&
          photo.serverMediaId != null &&
          photo.errorCode == null,
    );
    final mediaIds = <String>{
      ...record.mediaIds,
      for (final photo in ready) photo.serverMediaId!,
    }.toList(growable: false);
    if (mediaIds.length == record.mediaIds.length) {
      for (final photo in ready) {
        if (!_isCurrent(source)) return;
        await _markPhotoState(source, photo, 'linked');
      }
      return;
    }
    try {
      final response = await service.updateMemory(
        memoryId: memoryId,
        operationId: ready.first.linkOperationId,
        date: record.localDate,
        type: record.type,
        text: record.text,
        firstConfirmed: record.firstConfirmed,
        mediaIds: mediaIds,
        baseRevision: record.serverRevision,
      );
      if (!_isCurrent(source)) return;
      final linkedIds = List<String>.from(
        (response['mediaIds'] as List?) ?? mediaIds,
      );
      await source.saveGrowthRecordBody(
        record.copyWith(
          serverRevision: response['revision'] as int,
          mediaIds: linkedIds,
        ),
      );
      for (final photo in ready) {
        if (!_isCurrent(source)) return;
        if (photo.serverMediaId != null &&
            linkedIds.contains(photo.serverMediaId)) {
          await _markPhotoState(source, photo, 'linked');
        }
      }
    } on ApiException catch (error) {
      if (!_isCurrent(source)) return;
      if (error.statusCode != 409) rethrow;
      for (final photo in ready) {
        if (!_isCurrent(source)) return;
        await _markPhotoState(
          source,
          photo,
          'link_failed',
          errorCode: 'MEMORY_REVISION_CONFLICT',
        );
      }
    }
  }

  Future<void> _markPhotoState(
    PlanRepository source,
    GrowthPhotoUpload photo,
    String state, {
    String? errorCode,
  }) => source.saveGrowthPhoto(
    photo.copyWith(
      state: state,
      errorCode: errorCode,
      clearError: errorCode == null,
      updatedAt: nowValue,
    ),
  );

  Future<void> _reloadGrowthPhotos([PlanRepository? source]) async {
    final current = source ?? repository;
    if (!_isCurrent(current)) return;
    final photos = await current.growthPhotos();
    if (_isCurrent(current)) _applyCachedGrowthPhotos(photos);
  }

  void _applyCachedGrowthPhotos(List<GrowthPhotoUpload> photos) {
    growthPhotosByRecord = {
      for (final record in growthRecords)
        record.id: List.unmodifiable(
          photos.where((photo) => photo.memoryId == record.id),
        ),
    };
  }

  Future<void> addExtraPlay({
    required PlanItem item,
    required List<String> participantIds,
    required String note,
  }) async {
    _requireFamilyAccess();
    if (checkingContentSafety || blockedReason(item) != null) {
      throw StateError('这项玩法暂不可再玩。');
    }
    final source = repository;
    await source.extraPlay(
      item: item,
      date: plan?.date ?? today,
      participantIds: participantIds,
      note: note,
    );
    await _reloadSyncState(source);
  }

  Future<ExportArchive> prepareExport({
    required FamilyDate from,
    required FamilyDate to,
    required List<String> types,
    required bool includeMedia,
  }) async {
    _requireFamilyAccess();
    final service = api;
    if (service == null || !connected) {
      throw StateError('连接家庭服务并登录后，才能导出家庭资料。');
    }
    if (from.compareTo(to) > 0) {
      throw const FormatException('开始日期不能晚于结束日期。');
    }
    if (types.isEmpty) throw const FormatException('请至少选择一种资料。');
    exportBusy = true;
    notifyListeners();
    try {
      var export = await service.createExport(
        familyId: familyId,
        operationId: const Uuid().v4(),
        from: from,
        to: to,
        types: types,
        includeMedia: includeMedia,
      );
      for (var attempt = 0; attempt < 30; attempt++) {
        if (export.status == 'ready') return export;
        if (export.status == 'failed' || export.status == 'expired') {
          throw StateError(
            export.status == 'expired' ? '导出文件已过期，请重新创建。' : '导出没有完成，请稍后重试。',
          );
        }
        await Future<void>.delayed(Duration(milliseconds: 300 + attempt * 50));
        export = await service.readExport(export.id);
      }
      throw StateError('导出仍在处理中，请稍后再打开。');
    } finally {
      exportBusy = false;
      notifyListeners();
    }
  }

  Future<String?> downloadExport(ExportArchive archive) async {
    _requireFamilyAccess();
    final service = api;
    if (service == null) throw StateError('家庭服务未连接。');
    final refreshed = await service.readExport(archive.id);
    if (refreshed.status == 'expired') {
      throw StateError('导出文件已过期，请重新创建。');
    }
    if (refreshed.status != 'ready' || refreshed.downloadUrl == null) {
      throw StateError('导出文件还没有准备好。');
    }
    final bytes = await service.downloadExport(refreshed);
    final safeDate = today.toString();
    return exportFiles.saveZip(
      bytes,
      'BabyPlan-$safeDate-${archive.id.substring(0, 8)}.zip',
    );
  }

  Future<String?> exportPendingDrafts() async {
    _requireFamilyAccess();
    final source = repository;
    final payload =
        await source.local.exportPendingDrafts(source.familyId, source.actorId)
          ..['exportedAt'] = nowValue.toUtc().toIso8601String()
          ..['displayName'] = accountLabel;
    final bytes = Uint8List.fromList(
      utf8.encode(const JsonEncoder.withIndent('  ').convert(payload)),
    );
    return exportFiles.saveJson(
      bytes,
      'BabyPlan-${today.toString()}-待同步草稿.json',
    );
  }

  Future<List<DayPlan>> loadWeekPreview({bool refresh = false}) async {
    _requireFamilyAccess();
    if (refresh && repository.remote != null) {
      await this.refresh();
      _requireFamilyAccess();
      if (weekPlans.isEmpty) {
        throw StateError(loadError ?? plannerMessage ?? '服务暂时没有返回七天安排。');
      }
      return weekPlans;
    }
    final current = repository;
    if (current.remote != null) {
      try {
        await verifyContentSafety();
      } on Object {
        _requireFamilyAccess();
      }
    }
    if (!_isCurrent(current)) return const [];
    if (weekPlans.isNotEmpty) return weekPlans;
    return _readWeekPlans(
      current,
      today,
      localOnly: current.remote == null && localCandidateMode,
    );
  }

  bool canReplace(PlanItem item) {
    final current = plan;
    if (familyCacheLocked ||
        checkingContentSafety ||
        current == null ||
        current.date.compareTo(today) != 0 ||
        item.dayPlanId != current.id ||
        item.json['startedAt'] != null ||
        (item.json['lockedByParent'] == true && blockedReason(item) == null) ||
        participations.containsKey(item.id)) {
      return false;
    }
    return true;
  }

  List<Activity> replacementOptionsFor(PlanItem item) {
    final ageBand = currentAgeBand;
    if (ageBand == null ||
        (preferences.languageMode == 'zh' && item.activity.kind == 'english')) {
      return const [];
    }
    final used = {
      for (final current in plan?.items ?? const <PlanItem>[])
        current.activity.id,
    };
    final materials = preferences.availableMaterials.toSet();
    final excluded = preferences.excludedMaterials.toSet();
    return contentOptions
        .where((activity) {
          if (activity.id == item.activity.id ||
              used.contains(activity.id) ||
              withdrawalFor(activity) != null ||
              activity.kind != item.activity.kind ||
              !activity.ageBands.contains(ageBand)) {
            return false;
          }
          if (!localCandidateMode && activity.reviewState != 'reviewed') {
            return false;
          }
          if (activity.materials.any(excluded.contains)) return false;
          return activity.materials.every(materials.contains);
        })
        .toList(growable: false);
  }

  Future<void> replaceActivity(PlanItem item, Activity activity) async {
    _requireFamilyAccess();
    final current = plan;
    if (current == null || !canReplace(item)) {
      throw StateError('这项活动已经开始或有记录，不能再替换。');
    }
    final source = repository;
    await source.replaceItem(plan: current, item: item, activity: activity);
    if (!_isCurrent(source)) return;
    final localDay = await source.readDay(current.date);
    if (!_isCurrent(source)) return;
    _replaceVisibleDay(current.date, localDay);
    await _reloadSyncState(source);
    if (!_isCurrent(source) || source.remote == null) return;
    try {
      await _syncPending();
    } on Object {
      // 替换内容已经保存到本机 outbox，联网后继续确认。
    }
    if (!_isCurrent(source)) return;
    final confirmed = await source.readDay(current.date);
    if (!_isCurrent(source)) return;
    _replaceVisibleDay(current.date, confirmed);
    await _reloadSyncState(source);
  }

  Future<bool> _ensureWeeklyPlans(
    PlanRepository current,
    BabyPlanApi service,
  ) async {
    final child = activeChild;
    if (!_isCurrent(current) || child == null) return false;
    // 先等待服务确认偏好，避免用过期条件生成下一周。
    if (await current.local.hasPendingFamilyPreferenceEdit(current.familyId) ||
        !_isCurrent(current)) {
      return false;
    }
    final date = today;
    final options = [
      for (final activity in contentOptions)
        '${activity.id}:${activity.revision}',
    ]..sort();
    final withdrawals = [
      for (final key in _withdrawals.keys) '${key.$1}:${key.$2}',
    ]..sort();
    final fingerprint = sha256
        .convert(
          utf8.encode(
            jsonEncode([
              date.toString(),
              activeFamily?.timezone,
              [
                for (var index = 0; index < 7; index++)
                  child.ageBandAt(date.addDays(index)),
              ],
              preferences.languageMode,
              preferences.availableMaterials.toSet().toList()..sort(),
              preferences.excludedMaterials.toSet().toList()..sort(),
              options,
              withdrawals,
            ]),
          ),
        )
        .toString();
    final operationKey = 'operation:ensure-plans:${current.childId}';
    final draft = await current.readDraft(operationKey);
    if (!_isCurrent(current)) return false;
    final matched = draft?['fingerprint'] == fingerprint;
    if (matched && draft?['completed'] == true && weekPlans.length == 7) {
      plannerMessage = weekPlans.every((day) => day.items.isEmpty)
          ? '暂时没有适合当前月龄和家庭偏好的活动。'
          : null;
      return false;
    }
    final stored = matched && draft?['completed'] != true
        ? (draft?['operationId'])
        : null;
    // 旧版按日期保存的未确认请求也可继续重放。
    final legacyKey = 'operation:ensure-plans:${current.childId}:$date';
    final legacy = draft == null ? await current.readDraft(legacyKey) : null;
    if (!_isCurrent(current)) return false;
    final original = stored ?? legacy?['operationId'];
    final operationId = original is String && original.isNotEmpty
        ? original
        : const Uuid().v4();
    await current.saveDraft(operationKey, {
      'operationId': operationId,
      'fingerprint': fingerprint,
      'completed': false,
    });
    if (!_isCurrent(current)) return false;
    if (legacy != null) await current.deleteDraft(legacyKey);
    if (!_isCurrent(current)) return false;
    try {
      final days = await service.ensurePlans(
        childId: current.childId,
        operationId: operationId,
      );
      if (!_isCurrent(current)) return false;
      if (days.any(
        (day) =>
            day.familyId != current.familyId || day.childId != current.childId,
      )) {
        throw const FormatException('服务返回的安排与当前家庭不一致。');
      }
      plannerMessage = days.every((day) => day.items.isEmpty)
          ? '暂时没有适合当前月龄和家庭偏好的活动。'
          : null;
      await current.saveDraft(operationKey, {
        'fingerprint': fingerprint,
        'completed': true,
      });
      return _isCurrent(current);
    } on ApiException catch (error) {
      if (_isCurrent(current)) plannerMessage = error.message;
      if (_isCurrent(current) && error.code == 'OPERATION_EXPIRED') {
        // 编排服务本身按日去重，过期后可用新标识重新检查。
        await current.deleteDraft(operationKey);
      }
      if (error.statusCode == 401 ||
          error.statusCode == 403 ||
          error.statusCode == 404) {
        rethrow;
      }
    } on Object {
      if (_isCurrent(current)) plannerMessage = '家庭安排暂时没有同步，当前显示已经下载的内容。';
    }
    return false;
  }

  Future<List<DayPlan>> _readWeekPlans(
    PlanRepository current,
    FamilyDate date, {
    required bool localOnly,
  }) async {
    final plans = <DayPlan>[];
    for (var index = 0; index < 7; index++) {
      final day = date.addDays(index);
      final cached = await current.readDay(day);
      if (!_isCurrent(current)) return const [];
      if (cached != null) {
        plans.add(cached);
      } else if (localOnly) {
        plans.add(DemoContent.dayPlan(day));
      }
    }
    return List.unmodifiable(plans);
  }

  Future<void> updatePreferences(FamilyPreferences value) async {
    _requireFamilyAccess();
    if (!validReminderTime(value.reminderTime)) {
      throw const FormatException('请选择 20:00 之前的提醒时段。');
    }
    final current = repository;
    final previous = preferences;
    final reminderChanged =
        value.reminderEnabled != previous.reminderEnabled ||
        value.reminderTime != previous.reminderTime;
    final familySettingsChanged =
        !listEquals(previous.availableMaterials, value.availableMaterials) ||
        !listEquals(previous.excludedMaterials, value.excludedMaterials) ||
        previous.languageMode != value.languageMode;
    if (!reminderChanged && !familySettingsChanged) return;
    final reminderGeneration = reminderChanged
        ? ++_reminderGeneration
        : _reminderGeneration;
    if (reminderChanged) {
      if (value.reminderEnabled && !previous.reminderEnabled) {
        final allowed = await reminderScheduler.requestPermission();
        if (!_isCurrent(current) || reminderGeneration != _reminderGeneration) {
          return;
        }
        if (!allowed) throw StateError('没有获得系统通知权限，提醒还没有开启。');
      }
      await _runReminderAction(() async {
        if (!_isCurrent(current) || reminderGeneration != _reminderGeneration) {
          return;
        }
        if (value.reminderEnabled) {
          await _setNativeReminderContext();
          if (!_isCurrent(current) ||
              reminderGeneration != _reminderGeneration) {
            return;
          }
          await reminderScheduler.scheduleDaily(value.reminderTime);
        } else {
          await reminderScheduler.cancel();
        }
      });
    }
    if (!_isCurrent(current) ||
        (reminderChanged && reminderGeneration != _reminderGeneration)) {
      return;
    }
    if (current.remote == null) {
      await current.savePreferences(value);
    } else {
      if (familySettingsChanged) {
        final localValue = _withReminder(
          value,
          preferences.reminderEnabled,
          preferences.reminderTime,
        );
        await current.local.saveFamilyPreferenceEdit(
          current.familyId,
          localValue,
          nowValue,
        );
      }
      if (!_isCurrent(current)) return;
      if (reminderChanged && reminderGeneration == _reminderGeneration) {
        await current.local.saveReminderLocally(current.familyId, value);
      }
    }
    if (!_isCurrent(current)) return;
    final saved = await current.readPreferences();
    if (!_isCurrent(current)) return;
    preferences = saved;
    await _reloadSyncState();
    if (!_isCurrent(current) || current.remote == null) return;
    if (reminderChanged && reminderGeneration == _reminderGeneration) {
      await _saveRemoteReminder(value, current, reminderGeneration);
    }
    if (!_isCurrent(current) || !familySettingsChanged) return;
    try {
      await _syncPending();
    } on Object {
      // 偏好和待传操作已一起保存；网络恢复后继续。
    }
    if (!_isCurrent(current)) return;
    final confirmed = await current.readPreferences();
    if (!_isCurrent(current)) return;
    preferences = confirmed;
    await _reloadSyncState();
  }

  Future<void> addFamilyBook({
    required String title,
    required String language,
    String note = '',
  }) async {
    _requireFamilyAccess();
    final source = repository;
    await source.addFamilyBook(title: title, language: language, note: note);
    if (!_isCurrent(source)) return;
    final saved = await source.familyBooks();
    if (!_isCurrent(source)) return;
    books = saved;
    await _reloadSyncState(source);
    if (!_isCurrent(source) || source.remote == null) return;
    try {
      await _syncPending();
    } on Object {
      // 登记已保存在本机 outbox，联网后继续。
    }
    if (!_isCurrent(source)) return;
    final confirmed = await source.familyBooks();
    if (!_isCurrent(source)) return;
    books = confirmed;
    await _reloadSyncState(source);
  }

  Future<void> login({required String email, required String passphrase}) =>
      _signIn((service) => service.login(email: email, secretText: passphrase));

  Future<void> _signIn(
    Future<MobileSession> Function(BabyPlanApi service) send,
  ) async {
    final service = api;
    if (service == null) throw StateError('请先填写家庭服务地址。');
    if (loginBusy || _changingScope) return;
    final previous = repository;
    final generation = _beginScopeChange();
    loginBusy = true;
    notifyListeners();
    try {
      final session = await send(service);
      if (!_ownsScopeChange(generation)) return;
      if (previous.actorId != session.userId && previous.local != _rootLocal) {
        await _cancelReminderForSessionEnd(previous);
        if (!_ownsScopeChange(generation)) return;
      }
      // 即使重新登录同一个账号，也给旧会话在途的操作建立新的范围边界。
      _returnToLocalScope();
      _changingScope = false;
      await initialize();
    } finally {
      if (_ownsScopeChange(generation)) {
        loginBusy = false;
        _changingScope = false;
        notifyListeners();
      }
    }
  }

  Future<InvitationInfo> createInvitation({String? code}) async {
    final service = api;
    if (service == null || !connected) {
      throw StateError('连接并登录家庭后，才能邀请另一位家长。');
    }
    return service.createInvitation(familyId, code: code);
  }

  Future<void> acceptInvitation(String token) async {
    final service = api;
    if (service == null) throw StateError('请先连接家庭服务并登录。');
    final generation = _scopeGeneration;
    if (!_scopeIsCurrent(generation)) return;
    await service.acceptInvitation(token.trim());
    if (!_scopeIsCurrent(generation)) return;
    await initialize();
  }

  Future<void> redeemInvitation({
    required String token,
    required String email,
    required String secretText,
    required String displayName,
  }) => _signIn(
    (service) => service.redeemInvitation(
      token: token,
      email: email,
      secretText: secretText,
      displayName: displayName,
    ),
  );

  int _beginScopeChange() {
    _changingScope = true;
    _resetSafety();
    return ++_scopeGeneration;
  }

  bool _ownsScopeChange(int generation) =>
      generation == _scopeGeneration && !_disposed;

  Future<void> connectService(String rawUri) async {
    final uri = _validatedServiceUri(rawUri);
    await _leaveScope(replacement: uri);
  }

  Future<void> disconnectService() => _leaveScope(disconnect: true);

  Future<void> logout() => _leaveScope();

  Future<void> _leaveScope({Uri? replacement, bool disconnect = false}) async {
    final previous = repository;
    final service = api;
    final generation = _beginScopeChange();
    loginBusy = false;
    _clearFamilyView();
    accountLabel = null;
    notifyListeners();
    try {
      final cancel = _cancelReminderForSessionEnd(previous);
      try {
        if (service == null) {
          await tokenVault.clearSession();
        } else if (replacement != null) {
          await service.clearLocalSession(retire: true);
        } else {
          await service.logout(retire: disconnect);
        }
      } finally {
        await cancel;
      }
      if (!_ownsScopeChange(generation)) return;
      if (replacement != null) {
        await tokenVault.writeServiceUri(replacement.toString());
        if (!_ownsScopeChange(generation)) return;
        api = BabyPlanApi(baseUri: replacement, vault: tokenVault);
      } else if (disconnect) {
        await tokenVault.clearServiceUri();
        if (!_ownsScopeChange(generation)) return;
        api = null;
      }
      _returnToLocalScope();
    } finally {
      if (_ownsScopeChange(generation)) _changingScope = false;
    }
    if (_ownsScopeChange(generation)) await initialize();
  }

  void _resetSafety() {
    _safetyGeneration++;
    _safetyCheck = null;
    checkingContentSafety = false;
    contentSafetyCurrent = false;
    _withdrawals = const {};
  }

  void _returnToLocalScope() {
    _resetSafety();
    _clearFamilyView();
    familyCacheLocked = false;
    accountLabel = null;
    account = null;
    activeFamily = null;
    activeChild = null;
    books = const [];
    familyId = 'demo-family';
    childId = 'demo-child';
    actorId = config.demo || config.apiBaseUrl == null
        ? 'demo-caregiver'
        : 'local-caregiver';
    _activeLocal = _rootLocal;
    repository = _createRepository();
  }

  PlanRepository _createRepository() => PlanRepository(
    local: _activeLocal,
    familyId: familyId,
    childId: childId,
    actorId: actorId,
    remote: activeChild == null || _activeLocal == _rootLocal ? null : api,
    now: now,
  );

  String? _cachedScopeKey() =>
      api == null ? null : 'authorized-family:${api!.baseUri}';

  Future<void> _restoreOfflineScope(String userId, int generation) async {
    final key = _cachedScopeKey();
    if (key == null) return;
    final cached = await _rootLocal.readDraft('account-scope', userId, key);
    if (!_scopeIsCurrent(generation) || cached == null || familyCacheLocked) {
      return;
    }
    final value = AccountBootstrap.fromJson(cached);
    if (value.userId == userId) {
      await _applyBootstrap(value, generation, cache: false);
    }
  }

  (FamilySummary, ChildSummary)? _scopeFor(
    AccountBootstrap value,
    PlanRepository current,
  ) {
    if (value.userId != current.actorId) return null;
    final family = value.families
        .where((entry) => entry.id == current.familyId)
        .firstOrNull;
    final child = value.children
        .where(
          (entry) =>
              entry.id == current.childId && entry.familyId == current.familyId,
        )
        .firstOrNull;
    return family == null || child == null ? null : (family, child);
  }

  Future<bool> _refreshAuthorizedProfile(
    AccountBootstrap value,
    PlanRepository current,
  ) async {
    final scope = _scopeFor(value, current);
    if (scope == null || !_isCurrent(current)) return false;
    account = value;
    accountLabel = value.displayName ?? value.userId;
    activeFamily = scope.$1;
    activeChild = scope.$2;
    final key = _cachedScopeKey();
    if (key != null) {
      await _rootLocal.saveDraft(
        'account-scope',
        value.userId,
        key,
        value.toJson(),
      );
    }
    return _isCurrent(current);
  }

  Future<void> _applyBootstrap(
    AccountBootstrap value,
    int generation, {
    bool cache = true,
  }) async {
    if (!_scopeIsCurrent(generation)) return;
    final source = repository;
    final service = api;
    if (service == null) return;
    bool isCurrent() => _scopeIsCurrent(generation) && api == service;
    final authorized = _scopeFor(value, source);
    if (activeFamily != null &&
        activeChild != null &&
        value.userId == source.actorId &&
        authorized == null) {
      await _lockFamilyCache();
      return;
    }
    final configuredChild = value.children
        .where(
          (entry) =>
              entry.id == config.childId &&
              entry.familyId == config.familyId &&
              value.families.any((family) => family.id == entry.familyId),
        )
        .firstOrNull;
    final child = authorized?.$2 ?? configuredChild ?? value.activeChild;
    final family =
        authorized?.$1 ??
        (child == null
            ? value.families.firstOrNull
            : value.families
                  .where((item) => item.id == child.familyId)
                  .firstOrNull);
    final nextFamily = family?.id ?? 'unassigned:${value.userId}';
    final nextChild = child?.id ?? 'no-child';
    if (familyCacheLocked && child == null) return;
    final accountStore = await _openAccountLocal(service.baseUri, value.userId);
    if (!isCurrent()) return;
    final scopeChanged =
        source.familyId != nextFamily ||
        source.childId != nextChild ||
        source.actorId != value.userId ||
        source.local != accountStore ||
        source.remote != (child == null ? null : service) ||
        familyCacheLocked;
    if (scopeChanged) {
      _resetSafety();
      _clearFamilyView();
      if (child != null && family != null) {
        await accountStore.adoptLegacyAccountData(
          source: _rootLocal,
          service: service.baseUri,
          userId: value.userId,
          familyId: family.id,
          isCurrent: isCurrent,
        );
        if (!isCurrent()) return;
        if (cache) {
          await accountStore.adoptLocalPreviewData(
            source: _rootLocal,
            familyId: family.id,
            childId: child.id,
            isCurrent: isCurrent,
          );
          if (!isCurrent()) return;
        }
      }
    }
    account = value;
    accountLabel = value.displayName ?? value.userId;
    activeChild = child;
    activeFamily = family;
    familyCacheLocked = false;
    familyId = nextFamily;
    childId = nextChild;
    actorId = value.userId;
    if (scopeChanged) {
      _activeLocal = accountStore;
      repository = _createRepository();
    }
    final key = _cachedScopeKey();
    if (cache && key != null) {
      await _rootLocal.saveDraft(
        'account-scope',
        value.userId,
        key,
        value.toJson(),
      );
    }
  }

  Future<LocalStore> _openAccountLocal(Uri service, String userId) async {
    final key = (service, userId);
    final opening = _accountStores.putIfAbsent(
      key,
      () => _rootLocal.openAccountStore(service, userId),
    );
    try {
      return await opening;
    } on Object {
      if (identical(_accountStores[key], opening)) _accountStores.remove(key);
      rethrow;
    }
  }

  void _clearFamilyView() {
    plan = null;
    weekPlans = const [];
    participations = const {};
    growthRecords = const [];
    deletedGrowthRecords = const [];
    growthPhotosByRecord = const {};
    books = const [];
    contentOptions = const [];
    syncIssues = const [];
    pendingCount = 0;
    preferences = const FamilyPreferences();
    reminderPreference = null;
    plannerMessage = null;
    photoSyncBusy = false;
    exportBusy = false;
    loadState = LoadState.loading;
  }

  Future<void> _lockFamilyCache() async {
    if (familyCacheLocked || _changingScope) return;
    familyCacheLocked = true;
    _scopeGeneration++;
    loginBusy = false;
    final source = repository;
    final key = _cachedScopeKey();
    _resetSafety();
    _clearFamilyView();
    loadState = LoadState.error;
    loadError = '家庭资料已锁定，待同步记录仍保存在本机。';
    activeChild = null;
    activeFamily = null;
    account = null;
    notifyListeners();
    final cancel = _cancelReminderForSessionEnd(source);
    if (key != null) {
      await _rootLocal.deleteDraft('account-scope', source.actorId, key);
    }
    await cancel;
  }

  void setThemeMode(ThemeMode mode) {
    themeMode = mode;
    notifyListeners();
  }

  void requestToday() {
    todayRequest++;
    notifyListeners();
  }

  Future<void> _applyRemoteReminder(
    ReminderPreference remote,
    PlanRepository source,
    int generation,
  ) async {
    final deviceId = await tokenVault.deviceId();
    bool current() => _isCurrent(source) && generation == _reminderGeneration;
    if (!current()) return;
    final enabled = remote.enabled && remote.deviceId == deviceId;
    final time = reminderTimeBeforeQuietHours(remote.localTime);
    await _runReminderAction(() async {
      if (!current()) return;
      if (enabled) {
        await _setNativeReminderContext();
        if (!current()) return;
        await reminderScheduler.scheduleDaily(time);
      } else {
        await reminderScheduler.cancel();
      }
      if (!current()) return;
      final value = _withReminder(preferences, enabled, time);
      await source.local.saveReminderLocally(source.familyId, value);
      if (!current()) return;
      reminderPreference = remote;
      preferences = _withReminder(preferences, enabled, time);
    });
  }

  FamilyPreferences _withReminder(
    FamilyPreferences source,
    bool enabled,
    String time,
  ) => FamilyPreferences(
    availableMaterials: source.availableMaterials,
    excludedMaterials: source.excludedMaterials,
    languageMode: source.languageMode,
    reminderEnabled: enabled,
    reminderTime: time,
  );

  Future<void> _runReminderAction(Future<void> Function() action) {
    final operation = _reminderTail.then((_) => action());
    _reminderTail = operation.then<void>((_) {}, onError: (Object _) {});
    return operation;
  }

  Future<void> _setNativeReminderContext() async {
    final scheduler = reminderScheduler;
    if (scheduler is! LocalReminderScheduler) return;
    scheduler.timezone = activeFamily?.timezone ?? 'Asia/Shanghai';
    final current = plan;
    final visible = current?.visibleItems.where(
      (item) => blockedReason(item) == null,
    );
    final date = today;
    final handled =
        current?.date == date &&
        visible != null &&
        visible.isNotEmpty &&
        visible.every((item) => participations.containsKey(item.id));
    await scheduler.setHandledDate(handled ? date.toString() : null);
  }

  Future<void> _refreshReminderState() async {
    if (reminderScheduler is! LocalReminderScheduler) return;
    final source = repository;
    final generation = _reminderGeneration;
    bool current() => _isCurrent(source) && generation == _reminderGeneration;
    try {
      await _runReminderAction(() async {
        if (!current()) return;
        await _setNativeReminderContext();
        if (current() && preferences.reminderEnabled) {
          await reminderScheduler.scheduleDaily(preferences.reminderTime);
        }
      });
    } on Object {
      // 通知初始化或厂商限制不影响已经保存的陪伴记录。
    }
  }

  Future<void> _cancelReminderForSessionEnd(PlanRepository previous) async {
    _reminderGeneration++;
    try {
      await _runReminderAction(reminderScheduler.cancel);
    } on Object {
      // 即使系统暂时不可用，也要保存停用状态。
    }
    final prior = await previous.readPreferences();
    await previous.local.saveReminderLocally(
      previous.familyId,
      _withReminder(prior, false, prior.reminderTime),
    );
  }

  Future<void> _saveRemoteReminder(
    FamilyPreferences value,
    PlanRepository source,
    int generation,
  ) async {
    final service = api;
    if (service == null) return;
    bool current() => _isCurrent(source) && generation == _reminderGeneration;
    try {
      final previous = reminderPreference ?? await service.readReminder();
      if (!current()) return;
      final device = value.reminderEnabled ? await tokenVault.deviceId() : null;
      if (!current()) return;
      final saved = await service.saveReminder(
        operationId: const Uuid().v4(),
        baseRevision: previous.revision,
        deviceId: device,
        enabled: value.reminderEnabled,
        localTime: value.reminderTime,
      );
      if (current()) reminderPreference = saved;
    } on ApiException catch (error) {
      if (current()) await _lockIfUnauthorized(error, source);
    } on Object {
      // 本机通知已经生效，账号级设备选择会在下次联网时重新读取。
    }
  }

  Uri _validatedServiceUri(String raw) {
    final parsed = Uri.tryParse(raw.trim());
    if (parsed == null ||
        !parsed.hasAuthority ||
        parsed.userInfo.isNotEmpty ||
        parsed.hasQuery ||
        parsed.hasFragment ||
        !['http', 'https'].contains(parsed.scheme)) {
      throw const FormatException('请输入完整的家庭服务地址。');
    }
    var path = parsed.path.replaceFirst(RegExp(r'/+$'), '');
    if (path.isEmpty) path = '/v2';
    return parsed.replace(path: path);
  }

  String _friendly(Object error) {
    final text = error.toString().replaceFirst(RegExp(r'^[^:]+:\s*'), '');
    return text.isEmpty ? '本机资料暂时没有读取成功。' : text;
  }

  @override
  void dispose() {
    _disposed = true;
    _scopeGeneration++;
    _resetSafety();
    unawaited(_closeStores());
    super.dispose();
  }

  @visibleForTesting
  Future<void> closeStoresForTesting() => _closeStores();

  Future<void> _closeStores() async {
    final stores = _accountStores.values.toList(growable: false);
    _accountStores.clear();
    for (final opening in stores) {
      try {
        await (await opening).close();
      } on Object {
        // 打开失败没有数据库需要关闭；其余账号仍要清理。
      }
    }
    await _rootLocal.close();
  }
}

String timezoneForDisplay(String timezone) {
  try {
    return tz.getLocation(timezone).name;
  } on Object {
    return timezone;
  }
}
