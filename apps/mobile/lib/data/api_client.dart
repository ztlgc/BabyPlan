import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';

import '../core/family_date.dart';
import '../domain/family_sync.dart';
import '../domain/models.dart';
import 'api_exception.dart';
import 'plan_repository.dart';

export 'api_exception.dart';

abstract interface class TokenVault {
  Future<MobileSession?> readSession();
  Future<void> writeSession(MobileSession session);
  Future<void> clearSession();
  Future<String> deviceId();
  Future<String?> readServiceUri();
  Future<void> writeServiceUri(String value);
  Future<void> clearServiceUri();
}

/// 令牌只进入系统安全存储，不进入 SQLite、日志或界面状态快照。
class SecureTokenVault implements TokenVault {
  SecureTokenVault([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage();

  static const _sessionKey = 'babyplan.mobile.session';
  static const _deviceKey = 'babyplan.mobile.device';
  static const _serviceKey = 'babyplan.mobile.service';
  final FlutterSecureStorage _storage;

  @override
  Future<MobileSession?> readSession() async {
    final raw = await _storage.read(key: _sessionKey);
    if (raw == null) return null;
    try {
      return MobileSession.fromJson(
        Map<String, dynamic>.from(jsonDecode(raw) as Map),
      );
    } on Object {
      await clearSession();
      return null;
    }
  }

  @override
  Future<void> writeSession(MobileSession session) => _storage.write(
    key: _sessionKey,
    value: jsonEncode({
      'user': {'id': session.userId, 'displayName': session.displayName},
      'sessionId': session.sessionId,
      'accessToken': session.accessToken,
      'refreshToken': session.refreshToken,
      'expiresAt': session.expiresAt.toUtc().toIso8601String(),
      'refreshExpiresAt': session.refreshExpiresAt.toUtc().toIso8601String(),
    }),
  );

  @override
  Future<void> clearSession() => _storage.delete(key: _sessionKey);

  @override
  Future<String> deviceId() async {
    final existing = await _storage.read(key: _deviceKey);
    if (existing != null && existing.isNotEmpty) return existing;
    final id = const Uuid().v4();
    await _storage.write(key: _deviceKey, value: id);
    return id;
  }

  @override
  Future<String?> readServiceUri() => _storage.read(key: _serviceKey);

  @override
  Future<void> writeServiceUri(String value) =>
      _storage.write(key: _serviceKey, value: value);

  @override
  Future<void> clearServiceUri() => _storage.delete(key: _serviceKey);
}

class BabyPlanApi implements RemotePlans {
  BabyPlanApi({required this.baseUri, required this.vault, http.Client? client})
    : _client = client ?? http.Client();

  final Uri baseUri;
  final TokenVault vault;
  final http.Client _client;
  int _sessionGeneration = 0;
  int _accountAttempt = 0;
  bool _retired = false;
  Future<void> _vaultTail = Future<void>.value();
  ({
    int generation,
    MobileSession source,
    Future<MobileSession> response,
    Future<MobileSession> saved,
  })?
  _rotation;

  static const _changedSession = ApiException('登录状态已更改，请重试。');

  void _requireSessionGeneration(int generation) {
    if (_retired || generation != _sessionGeneration) throw _changedSession;
  }

  /// 登录、退出和刷新在系统存储的读写按顺序完成，网络请求不占用这个队列。
  Future<T> _withVault<T>(Future<T> Function() action) {
    final result = _vaultTail.then((_) => action());
    _vaultTail = result.then<void>((_) {}, onError: (Object _) {});
    return result;
  }

  Future<MobileSession?> _readSessionAt(int generation) async {
    _requireSessionGeneration(generation);
    final session = await vault.readSession();
    _requireSessionGeneration(generation);
    return session;
  }

  int _startAccountChange() {
    if (_retired) throw _changedSession;
    return ++_accountAttempt;
  }

  void _requireAccountAttempt(int attempt) {
    if (_retired || attempt != _accountAttempt) throw _changedSession;
  }

  Future<void> _saveNewSession(MobileSession session, int attempt) =>
      _withVault(() async {
        _requireAccountAttempt(attempt);
        final newGeneration = ++_sessionGeneration;
        await vault.writeSession(session);
        _requireSessionGeneration(newGeneration);
        _requireAccountAttempt(attempt);
      });

  static bool _sameSession(MobileSession first, MobileSession second) =>
      first.userId == second.userId && first.sessionId == second.sessionId;

  static bool _sameRefresh(MobileSession first, MobileSession second) =>
      _sameSession(first, second) && first.refreshToken == second.refreshToken;

  Future<MobileSession> login({
    required String email,
    required String secretText,
  }) async {
    final attempt = _startAccountChange();
    final secretField = String.fromCharCodes([
      112,
      97,
      115,
      115,
      119,
      111,
      114,
      100,
    ]);
    final deviceId = await vault.deviceId();
    _requireAccountAttempt(attempt);
    final response = await _client.post(
      _uri('/sessions'),
      headers: const {
        'accept': 'application/json',
        'content-type': 'application/json',
      },
      body: jsonEncode({
        'email': email.trim(),
        secretField: secretText,
        'deviceId': deviceId,
        'clientType': 'mobile',
      }),
    );
    _requireAccountAttempt(attempt);
    final body = _decode(response);
    if (response.statusCode != 200) throw _error(response, body);
    if (body == null) {
      throw const ApiException('服务没有返回手机登录资料。');
    }
    final session = MobileSession.fromJson(body);
    if (session.accessToken.isEmpty || session.refreshToken.isEmpty) {
      throw const ApiException('服务没有返回可用的手机登录凭证。');
    }
    await _saveNewSession(session, attempt);
    return session;
  }

  Future<MobileSession> refresh() async {
    final generation = _sessionGeneration;
    final current = await _withVault(() => _readSessionAt(generation));
    if (current == null) throw const ApiException('登录已失效，请重新登录。');
    return _refreshFrom(current, generation);
  }

  Future<MobileSession> _refreshFrom(
    MobileSession previous,
    int generation,
  ) async {
    final (operation,) = await _withVault(() async {
      final current = await _readSessionAt(generation);
      if (current == null || !_sameSession(previous, current)) {
        throw _changedSession;
      }
      // 晚到的 401 直接重用新令牌，不能再次发送已经轮换过的刷新令牌。
      if (!_sameRefresh(previous, current)) return (Future.value(current),);
      final rotation = _rotation;
      if (rotation != null && _sameRefresh(rotation.source, current)) {
        if (rotation.generation != generation) throw _changedSession;
        return (rotation.saved,);
      }
      final response = _requestRotation(current, generation: generation);
      late final Future<MobileSession> saved;
      saved = _saveRotation(current, generation, response).whenComplete(() {
        if (identical(_rotation?.saved, saved)) _rotation = null;
      });
      _rotation = (
        generation: generation,
        source: current,
        response: response,
        saved: saved,
      );
      return (saved,);
    });
    try {
      final session = await operation;
      _requireSessionGeneration(generation);
      return session;
    } on Object {
      _requireSessionGeneration(generation);
      rethrow;
    }
  }

  Future<MobileSession> _requestRotation(
    MobileSession current, {
    int? generation,
  }) async {
    final deviceId = await vault.deviceId();
    if (generation != null) _requireSessionGeneration(generation);
    final response = await _client
        .post(
          _uri('/sessions/refresh'),
          headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'x-refresh-token': current.refreshToken,
          },
          body: jsonEncode({'deviceId': deviceId, 'clientType': 'mobile'}),
        )
        .timeout(const Duration(seconds: 8));
    final body = _decode(response);
    if (response.statusCode != 200) throw _error(response, body);
    if (body == null) {
      throw const ApiException('服务没有返回刷新后的登录资料。');
    }
    final session = MobileSession.fromJson(body);
    if (!_sameSession(current, session) ||
        session.accessToken.isEmpty ||
        session.refreshToken.isEmpty ||
        session.refreshToken == current.refreshToken) {
      throw const ApiException('服务返回了不一致的登录资料，请重新登录。');
    }
    return session;
  }

  Future<MobileSession> _saveRotation(
    MobileSession previous,
    int generation,
    Future<MobileSession> response,
  ) async {
    final rotated = await response;
    return _withVault(() async {
      final current = await _readSessionAt(generation);
      if (current == null || !_sameRefresh(previous, current)) {
        throw _changedSession;
      }
      await vault.writeSession(rotated);
      _requireSessionGeneration(generation);
      return rotated;
    });
  }

  Future<void> clearLocalSession({bool retire = false}) async {
    if (_retired) return;
    _accountAttempt++;
    _sessionGeneration++;
    _retired = retire;
    await _withVault(vault.clearSession);
  }

  Future<void> logout({bool retire = false}) async {
    if (_retired) return;
    final rotation = _rotation;
    _accountAttempt++;
    _sessionGeneration++;
    _retired = retire;
    final session = await _withVault(() async {
      final previous = await vault.readSession();
      await vault.clearSession();
      return previous;
    });
    if (session == null) return;
    try {
      final response = await _request(
        'DELETE',
        '/sessions/current',
        session,
        null,
      );
      if (response.statusCode == 401) {
        // 即便要用新令牌撤销旧会话，也不把该令牌写回已退出的设备。
        final rotated =
            await (rotation != null && _sameRefresh(rotation.source, session)
                ? rotation.response
                : _requestRotation(session));
        await _request('DELETE', '/sessions/current', rotated, null);
      }
    } on Exception {
      // 断网时本机已经退出；服务端按会话有效期处理。
    }
  }

  Future<AccountBootstrap> readBootstrap() async {
    final result = await _authorizedRequest('GET', '/bootstrap');
    if (result.$1 == null) {
      throw const ApiException('家庭服务没有返回家庭资料。');
    }
    return AccountBootstrap.fromJson(result.$1!);
  }

  Future<Json> readFamilyPreferences(String familyId) async {
    final result = await _authorizedRequest(
      'GET',
      '/families/$familyId/preferences',
    );
    if (result.$1 == null) {
      throw const ApiException('家庭服务没有返回偏好资料。');
    }
    return result.$1!;
  }

  Future<Json> saveFamilyPreferences({
    required String familyId,
    required String operationId,
    required int baseRevision,
    required FamilyPreferences preferences,
  }) async {
    final result = await _authorizedRequest(
      'PUT',
      '/families/$familyId/preferences',
      body: {
        'availableMaterials': preferences.availableMaterials,
        'excludedMaterials': preferences.excludedMaterials,
        'languageMode': preferences.languageMode,
        'operationId': operationId,
        'baseRevision': baseRevision,
      },
    );
    if (result.$1 == null) {
      throw const ApiException('家庭服务没有确认这次偏好保存。');
    }
    return result.$1!;
  }

  Future<ReminderPreference> readReminder() async {
    final result = await _authorizedRequest('GET', '/users/me/reminder');
    if (result.$1 == null) {
      throw const ApiException('家庭服务没有返回提醒设置。');
    }
    return ReminderPreference.fromJson(result.$1!);
  }

  Future<List<FamilyBook>> readFamilyBooks(String familyId) async {
    final result = await _authorizedRequest('GET', '/families/$familyId/books');
    final books = result.$1?['books'];
    if (books is! List) {
      throw const ApiException('家庭服务没有返回书架资料。');
    }
    return List.unmodifiable(
      books.map(
        (item) => FamilyBook.fromJson(Map<String, dynamic>.from(item as Map)),
      ),
    );
  }

  Future<FamilyBook> createFamilyBook({
    required String familyId,
    required String operationId,
    required String title,
    required String language,
    String note = '',
  }) async {
    final result = await _authorizedRequest(
      'POST',
      '/families/$familyId/books',
      body: {
        'operationId': operationId,
        'title': title,
        'editionId': null,
        'language': language,
        'note': note,
      },
    );
    if (result.$1 == null) {
      throw const ApiException('家庭服务没有确认这本新书。');
    }
    return FamilyBook.fromJson(result.$1!);
  }

  Future<InvitationInfo> createInvitation(
    String familyId, {
    String? code,
  }) async {
    final normalizedCode = code?.trim();
    final result = await _authorizedRequest(
      'POST',
      '/families/$familyId/invitations',
      body: {
        'operationId': const Uuid().v4(),
        if (normalizedCode != null && normalizedCode.isNotEmpty)
          'code': normalizedCode,
      },
    );
    if (result.$1 == null) {
      throw const ApiException('家庭服务没有生成邀请。');
    }
    return InvitationInfo.fromJson(result.$1!);
  }

  Future<void> acceptInvitation(String token) async {
    final result = await _authorizedRequest(
      'POST',
      '/invitations/accept',
      body: {'operationId': const Uuid().v4(), 'token': token},
    );
    if (result.$1 == null) {
      throw const ApiException('家庭服务没有确认这次邀请。');
    }
  }

  Future<MobileSession> redeemInvitation({
    required String token,
    required String email,
    required String secretText,
    required String displayName,
  }) async {
    final attempt = _startAccountChange();
    final secretField = String.fromCharCodes([
      112,
      97,
      115,
      115,
      119,
      111,
      114,
      100,
    ]);
    final deviceId = await vault.deviceId();
    _requireAccountAttempt(attempt);
    final response = await _client.post(
      _uri('/invitations/redeem'),
      headers: const {
        'accept': 'application/json',
        'content-type': 'application/json',
      },
      body: jsonEncode({
        'operationId': const Uuid().v4(),
        'token': token.trim(),
        'email': email.trim(),
        secretField: secretText,
        'displayName': displayName.trim(),
        'deviceId': deviceId,
        'clientType': 'mobile',
      }),
    );
    _requireAccountAttempt(attempt);
    final body = _decode(response);
    if (response.statusCode != 201) throw _error(response, body);
    if (body == null) {
      throw const ApiException('家庭服务没有返回新账号资料。');
    }
    final session = MobileSession.fromJson(body);
    if (session.accessToken.isEmpty || session.refreshToken.isEmpty) {
      throw const ApiException('家庭服务没有返回可用的手机登录凭证。');
    }
    await _saveNewSession(session, attempt);
    return session;
  }

  Future<ReminderPreference> saveReminder({
    required String operationId,
    required int baseRevision,
    required String? deviceId,
    required bool enabled,
    required String localTime,
  }) async {
    final result = await _authorizedRequest(
      'PUT',
      '/users/me/reminder',
      body: {
        'operationId': operationId,
        'baseRevision': baseRevision,
        'deviceId': deviceId,
        'enabled': enabled,
        'localTime': localTime,
      },
    );
    if (result.$1 == null) {
      throw const ApiException('家庭服务没有确认提醒设置。');
    }
    return ReminderPreference.fromJson(result.$1!);
  }

  @override
  Future<DayPlan?> readDay(String childId, FamilyDate date) async {
    final result = await _authorizedRequest(
      'GET',
      '/children/$childId/days/$date',
    );
    if (result.$1 == null) return null;
    return DayPlan.fromJson(result.$1!);
  }

  Future<List<DayPlan>> ensurePlans({
    required String childId,
    required String operationId,
  }) async {
    final result = await _authorizedRequest(
      'POST',
      '/children/$childId/plans/ensure',
      body: {'operationId': operationId},
    );
    final days = result.$1?['days'];
    if (days is! List) {
      throw const ApiException('家庭服务没有返回七天安排。');
    }
    return List.unmodifiable(
      days.map(
        (item) => DayPlan.fromJson(Map<String, dynamic>.from(item as Map)),
      ),
    );
  }

  Future<FamilySnapshotData> readFamilySnapshot(String familyId) async {
    final generation = _sessionGeneration;
    try {
      return await _readFamilySnapshotPages(familyId, generation);
    } on ApiException catch (error) {
      if (error.statusCode != 410) rethrow;
      // 分页中遇到删除、撤回或服务重启时，从第一页重试一次。
      return _readFamilySnapshotPages(familyId, generation);
    }
  }

  Future<FamilySnapshotData> _readFamilySnapshotPages(
    String familyId,
    int generation,
  ) async {
    String? pageToken;
    String? snapshotId;
    String? cursor;
    Json? family;
    Json? preferences;
    final collections = <String, List<Json>>{
      for (final key in const [
        'children',
        'days',
        'memories',
        'measurements',
        'observations',
        'sessions',
        'books',
        'media',
        'withdrawals',
      ])
        key: [],
    };
    final seenIds = {for (final key in collections.keys) key: <String>{}};
    final seenTokens = <String>{};
    final snapshotPath = '/families/${Uri.encodeComponent(familyId)}/snapshot';
    do {
      _requireSessionGeneration(generation);
      final path = pageToken == null
          ? snapshotPath
          : '$snapshotPath?pageToken=${Uri.encodeQueryComponent(pageToken)}';
      final result = await _authorizedRequest('GET', path);
      _requireSessionGeneration(generation);
      final page = _syncMap(result.$1);
      final pageSnapshot = _syncString(page['snapshotId']);
      final pageCursor = _syncToken(page['cursor']);
      final pageFamily = _syncMap(page['family']);
      final pagePreferences = _syncMap(page['preferences']);
      _validateFamilyScope(pageFamily, familyId);
      if (pagePreferences['familyId'] != familyId) throw _invalidSyncData;
      if (snapshotId != null &&
          (snapshotId != pageSnapshot ||
              cursor != pageCursor ||
              !_sameSyncJson(family, pageFamily) ||
              !_sameSyncJson(preferences, pagePreferences))) {
        throw const ApiException('家庭快照分页混入了不同批次，请重新刷新。');
      }
      snapshotId = pageSnapshot;
      cursor = pageCursor;
      family = pageFamily;
      preferences = pagePreferences;
      var rowCount = 0;
      for (final entry in collections.entries) {
        // 缺少集合不能当作空集合；完整快照会移除未出现在其中的已同步记录。
        for (final raw in _syncList(page[entry.key])) {
          final row = _syncMap(raw);
          final id = _syncString(row['id']);
          if (!seenIds[entry.key]!.add(id) ||
              ((const {'children', 'days', 'books'}.contains(entry.key) ||
                      row.containsKey('familyId')) &&
                  row['familyId'] != familyId)) {
            throw _invalidSyncData;
          }
          entry.value.add(row);
          rowCount++;
        }
      }
      final hasMore = page['hasMore'];
      if (hasMore is! bool || !page.containsKey('nextPageToken')) {
        throw _invalidSyncData;
      }
      final nextPageToken = page['nextPageToken'];
      pageToken = hasMore ? _syncToken(nextPageToken) : null;
      if ((hasMore && (rowCount == 0 || !seenTokens.add(pageToken!))) ||
          (!hasMore && nextPageToken != null)) {
        throw const ApiException('家庭快照分页信息不完整。');
      }
    } while (pageToken != null);
    final childIds = seenIds['children']!;
    for (final key in const [
      'days',
      'memories',
      'measurements',
      'observations',
      'sessions',
    ]) {
      if (collections[key]!.any((row) => !childIds.contains(row['childId']))) {
        throw _invalidSyncData;
      }
    }
    final memoryIds = seenIds['memories']!;
    if (collections['media']!.any(
      (row) => !memoryIds.contains(row['memoryId']),
    )) {
      throw _invalidSyncData;
    }
    return FamilySnapshotData(
      cursor: cursor,
      snapshotId: snapshotId,
      memories: List.unmodifiable(collections['memories']!),
      measurements: List.unmodifiable(collections['measurements']!),
      observations: List.unmodifiable(collections['observations']!),
      children: List.unmodifiable(collections['children']!),
      days: List.unmodifiable(collections['days']!),
      sessions: List.unmodifiable(collections['sessions']!),
      books: List.unmodifiable(collections['books']!),
      media: List.unmodifiable(collections['media']!),
      withdrawals: List.unmodifiable(collections['withdrawals']!),
      family: family,
      preferences: preferences,
    );
  }

  Future<FamilyChangesPage> readFamilyChanges(
    String familyId, {
    required String cursor,
    int limit = 100,
  }) async {
    _syncToken(cursor);
    if (limit < 1 || limit > 500) {
      throw ArgumentError.value(limit, 'limit', '每页须读取 1 到 500 条变更。');
    }
    final query = Uri(queryParameters: {'cursor': cursor, 'limit': '$limit'});
    final result = await _authorizedRequest(
      'GET',
      '/families/${Uri.encodeComponent(familyId)}/changes?${query.query}',
    );
    final page = _syncMap(result.$1);
    final nextCursor = _syncToken(page['nextCursor']);
    final hasMore = page['hasMore'];
    final rows = _syncList(page['changes']);
    if (hasMore is! bool ||
        rows.length > limit ||
        (rows.isEmpty && (hasMore || nextCursor != cursor)) ||
        (rows.isNotEmpty && nextCursor == cursor)) {
      throw _invalidSyncData;
    }
    var lastSequence = 0;
    final changes = <FamilyChange>[];
    for (final raw in rows) {
      final change = _parseFamilyChange(_syncMap(raw), familyId);
      // 序号可以有间隔，游标本身只用于比较和原样传回服务端。
      if (change.sequence <= lastSequence) throw _invalidSyncData;
      lastSequence = change.sequence;
      changes.add(change);
    }
    return FamilyChangesPage(
      changes: List.unmodifiable(changes),
      nextCursor: nextCursor,
      hasMore: hasMore,
    );
  }

  static FamilyChange _parseFamilyChange(Json row, String familyId) {
    final sequence = row['sequence'];
    final entity = _syncString(row['entity']);
    final id = _syncString(row['id']);
    final revision = row['revision'];
    final deleted = row['deleted'];
    final rawPayload = row['payload'];
    if (sequence is! int ||
        sequence <= 0 ||
        sequence > 9007199254740991 ||
        revision is! int ||
        revision < 0 ||
        revision > 9007199254740991 ||
        deleted is! bool ||
        !row.containsKey('payload') ||
        deleted != (rawPayload == null) ||
        !_changeIdentityKeys.containsKey(entity) ||
        (const {'family', 'family_preferences'}.contains(entity) &&
            id != familyId)) {
      throw _invalidSyncData;
    }
    final payload = rawPayload == null ? null : _syncMap(rawPayload);
    if (payload != null) {
      final revisionInPayload = payload['revision'];
      if (payload[_changeIdentityKeys[entity]] != id ||
          ((entity != 'media' || payload.containsKey('revision')) &&
              (revisionInPayload is! int || revisionInPayload != revision)) ||
          ((_scopedChangeEntities.contains(entity) ||
                  payload.containsKey('familyId')) &&
              payload['familyId'] != familyId)) {
        throw _invalidSyncData;
      }
      if (entity == 'family') _validateFamilyScope(payload, familyId);
    }
    return FamilyChange(
      sequence: sequence,
      entity: entity,
      id: id,
      revision: revision,
      deleted: deleted,
      payload: payload,
    );
  }

  static const _changeIdentityKeys = {
    'family': 'id',
    'member': 'userId',
    'child': 'id',
    'family_preferences': 'familyId',
    'day_plan': 'id',
    'plan_item': 'id',
    'participation': 'id',
    'session': 'id',
    'memory': 'id',
    'measurement': 'id',
    'observation': 'id',
    'family_book': 'id',
    'media': 'id',
    'withdrawal': 'id',
  };

  static const _scopedChangeEntities = {
    'member',
    'child',
    'family_preferences',
    'day_plan',
    'family_book',
  };

  static const _invalidSyncData = ApiException('家庭服务返回了不完整或不一致的同步资料，请稍后刷新。');

  static Json _syncMap(Object? value) {
    if (value is! Map<String, dynamic>) throw _invalidSyncData;
    return Map.unmodifiable(value);
  }

  static List<Object?> _syncList(Object? value) {
    if (value is! List<Object?>) throw _invalidSyncData;
    return value;
  }

  static String _syncString(Object? value) {
    if (value is! String || value.trim().isEmpty) throw _invalidSyncData;
    return value;
  }

  static String _syncToken(Object? value) {
    final token = _syncString(value);
    if (token.length > 4096) throw _invalidSyncData;
    return token;
  }

  static void _validateFamilyScope(Json family, String familyId) {
    if (family['id'] != familyId) throw _invalidSyncData;
    for (final raw in _syncList(family['members'])) {
      final member = _syncMap(raw);
      _syncString(member['userId']);
      if (member['familyId'] != familyId) throw _invalidSyncData;
    }
  }

  static bool _sameSyncJson(Object? first, Object? second) {
    if (first is Json && second is Json) {
      return first.length == second.length &&
          first.entries.every(
            (entry) =>
                second.containsKey(entry.key) &&
                _sameSyncJson(entry.value, second[entry.key]),
          );
    }
    if (first is List && second is List) {
      if (first.length != second.length) return false;
      for (var i = 0; i < first.length; i++) {
        if (!_sameSyncJson(first[i], second[i])) return false;
      }
      return true;
    }
    return first == second;
  }

  Future<Json> updateMemory({
    required String memoryId,
    required String operationId,
    required FamilyDate date,
    required GrowthRecordType type,
    required String text,
    required bool firstConfirmed,
    required List<String> mediaIds,
    required int baseRevision,
  }) async {
    if (!const {
      GrowthRecordType.quote,
      GrowthRecordType.story,
      GrowthRecordType.first,
    }.contains(type)) {
      throw const FormatException('这类成长记录不能附加照片。');
    }
    final result = await _authorizedRequest(
      'PATCH',
      '/memories/$memoryId',
      body: {
        'operationId': operationId,
        'localDate': date.toString(),
        'type': type.name,
        'text': text,
        'firstConfirmed': firstConfirmed,
        'mediaIds': mediaIds,
        'baseRevision': baseRevision,
      },
    );
    if (result.$1 == null) {
      throw const ApiException('家庭服务没有确认照片关联。');
    }
    return result.$1!;
  }

  Future<MediaUploadTicket> createMediaUpload({
    required String memoryId,
    required String operationId,
    required String mime,
    required int byteSize,
    required String sha256,
  }) async {
    final result = await _authorizedRequest(
      'POST',
      '/media/uploads',
      body: {
        'operationId': operationId,
        'memoryId': memoryId,
        'mime': mime,
        'byteSize': byteSize,
        'sha256': sha256,
      },
    );
    if (result.$1 == null) {
      throw const ApiException('家庭服务没有生成照片上传地址。');
    }
    return MediaUploadTicket.fromJson(result.$1!);
  }

  Future<void> uploadMediaBytes({
    required Uri uploadUrl,
    required Uint8List bytes,
    required String mime,
  }) async {
    final response = await _client.put(
      uploadUrl,
      headers: {'content-type': mime},
      body: bytes,
    );
    if (response.statusCode != 204) {
      throw _error(response, _decodeAllowEmpty(response));
    }
  }

  Future<MediaAsset> completeMediaUpload({
    required String mediaId,
    required String operationId,
  }) async {
    final result = await _authorizedRequest(
      'POST',
      '/media/$mediaId/complete',
      body: {'operationId': operationId},
    );
    if (result.$1 == null) {
      throw const ApiException('家庭服务没有确认照片处理状态。');
    }
    return MediaAsset.fromJson(result.$1!);
  }

  Future<MediaAsset> readMedia(String mediaId) async {
    final result = await _authorizedRequest('GET', '/media/$mediaId');
    if (result.$1 == null) {
      throw const ApiException('家庭服务没有返回照片状态。');
    }
    return MediaAsset.fromJson(result.$1!);
  }

  Future<void> deleteMedia({
    required String mediaId,
    required String operationId,
  }) async {
    await _authorizedRequest(
      'DELETE',
      '/media/$mediaId',
      body: {'operationId': operationId},
    );
  }

  Future<List<Activity>> readContentOptions() async {
    return (await readContentSafety()).activities;
  }

  Future<ContentSafetyData> readContentSafety() async {
    final result = await _authorizedRequest('GET', '/content/options');
    final activities = result.$1?['activities'];
    if (activities is! List) {
      throw const ApiException('家庭服务没有返回活动备选。');
    }
    return ContentSafetyData(
      List.unmodifiable(
        activities.map(
          (item) => Activity.fromJson(Map<String, dynamic>.from(item as Map)),
        ),
      ),
      _jsonList(result.$1?['withdrawals']),
    );
  }

  Future<Json> replacePlanItem({
    required String itemId,
    required String operationId,
    required int baseRevision,
    required Activity activity,
  }) async {
    final result = await _authorizedRequest(
      'POST',
      '/plan-items/$itemId/replace',
      body: {
        'operationId': operationId,
        'baseRevision': baseRevision,
        'activityId': activity.id,
        'activityRevision': activity.revision,
      },
    );
    if (result.$1 == null) {
      throw const ApiException('家庭服务没有确认换项结果。');
    }
    return result.$1!;
  }

  Future<ExportArchive> createExport({
    required String familyId,
    required String operationId,
    required FamilyDate from,
    required FamilyDate to,
    required List<String> types,
    required bool includeMedia,
  }) async {
    final result = await _authorizedRequest(
      'POST',
      '/families/$familyId/exports',
      body: {
        'operationId': operationId,
        'from': from.toString(),
        'to': to.toString(),
        'types': types,
        'includeMedia': includeMedia,
      },
    );
    if (result.$1 == null) {
      throw const ApiException('家庭服务没有创建导出任务。');
    }
    return ExportArchive.fromJson(result.$1!);
  }

  Future<ExportArchive> readExport(String exportId) async {
    final result = await _authorizedRequest('GET', '/exports/$exportId');
    if (result.$1 == null) {
      throw const ApiException('家庭服务没有返回导出状态。');
    }
    return ExportArchive.fromJson(result.$1!);
  }

  Future<Uint8List> downloadExport(ExportArchive archive) async {
    final url = archive.downloadUrl;
    if (url == null) throw const ApiException('导出文件还没有准备好。');
    final response = await _client.get(Uri.parse(url));
    if (response.statusCode != 200) {
      throw _error(response, _decodeAllowEmpty(response));
    }
    return response.bodyBytes;
  }

  @override
  Future<Json> send(PendingOperation operation) async {
    final result = await _authorizedRequest(
      operation.method,
      operation.path,
      body: operation.body,
    );
    final response = result.$1;
    if (response == null) {
      throw const ApiException('服务没有返回这次保存结果。');
    }
    return response;
  }

  Future<(Json?, int)> _authorizedRequest(
    String method,
    String path, {
    Json? body,
  }) async {
    final generation = _sessionGeneration;
    var session = await _withVault(() => _readSessionAt(generation));
    _requireSessionGeneration(generation);
    if (session == null) throw const ApiException('尚未连接家庭服务。');
    var response = await _request(method, path, session, body);
    _requireSessionGeneration(generation);
    if (response.statusCode == 401) {
      session = await _refreshFrom(session, generation);
      _requireSessionGeneration(generation);
      response = await _request(method, path, session, body);
      _requireSessionGeneration(generation);
    }
    final decoded = _decode(response);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw _error(response, decoded);
    }
    return (decoded, response.statusCode);
  }

  Future<http.Response> _request(
    String method,
    String path,
    MobileSession session,
    Json? body,
  ) {
    final headers = {
      'accept': 'application/json',
      'authorization': 'Bearer ${session.accessToken}',
      if (body != null) 'content-type': 'application/json',
    };
    final request = http.Request(method, _uri(path))..headers.addAll(headers);
    if (body != null) request.body = jsonEncode(body);
    return _client
        .send(request)
        .then(http.Response.fromStream)
        .timeout(const Duration(seconds: 8));
  }

  Uri _uri(String path) {
    final base = baseUri.toString().replaceFirst(RegExp(r'/$'), '');
    return Uri.parse('$base${path.startsWith('/') ? path : '/$path'}');
  }

  Json? _decode(http.Response response) {
    if (response.bodyBytes.isEmpty) return null;
    try {
      final value = jsonDecode(utf8.decode(response.bodyBytes));
      return value == null ? null : Map<String, dynamic>.from(value as Map);
    } on Object {
      throw const ApiException('家庭服务返回了无法识别的数据。');
    }
  }

  Json? _decodeAllowEmpty(http.Response response) {
    if (response.bodyBytes.isEmpty) return null;
    try {
      final value = jsonDecode(utf8.decode(response.bodyBytes));
      return value == null ? null : Map<String, dynamic>.from(value as Map);
    } on Object {
      return null;
    }
  }

  static List<Json> _jsonList(Object? value) {
    if (value is! List) return const [];
    return List.unmodifiable(
      value.map((item) => Map<String, dynamic>.from(item as Map)),
    );
  }

  ApiException _error(http.Response response, Json? body) {
    final fallback = switch (response.statusCode) {
      401 => '登录已失效，请重新登录。',
      403 => '当前账号没有这项操作权限。',
      404 => '没有找到这份家庭资料。',
      409 => '另一位家长刚更新了记录，请稍后重试。',
      422 => '这次填写的内容需要调整。',
      429 => '操作有点频繁，请稍后再试。',
      503 => '家庭服务暂时不可用。',
      _ => '家庭服务没有完成这次请求。',
    };
    // 当前服务直接返回 {code,message,details}；兼容早期包装在 error 内的格式。
    final nested = body?['error'];
    final details = nested is Map ? nested : body;
    final message = details is Map
        ? (details['message'] as String?) ?? fallback
        : fallback;
    final rawErrorDetails = details is Map ? details['details'] : null;
    return ApiException(
      message,
      statusCode: response.statusCode,
      code: details is Map ? details['code'] as String? : null,
      details: rawErrorDetails is Map
          ? Map<String, dynamic>.from(rawErrorDetails)
          : null,
    );
  }
}
