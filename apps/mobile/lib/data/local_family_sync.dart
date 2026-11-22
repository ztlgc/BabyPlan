part of 'local_store.dart';

/// 同步页的事实和游标一起提交；本机编辑和网络读响应有独立的进度。
extension LocalFamilySync on LocalStore {
  Future<int> readFamilyWriteVersion(String familyId) =>
      _readFamilyWriteVersion(_db, familyId);

  Future<bool> applyFamilySnapshot({
    required String familyId,
    required String? expectedCursor,
    required int expectedWriteVersion,
    required FamilySnapshotData snapshot,
    required bool Function() isCurrent,
  }) => _db.transaction((txn) async {
    if (!await _syncWriteAllowed(
      txn,
      familyId,
      expectedCursor,
      expectedWriteVersion,
      isCurrent,
    )) {
      return false;
    }

    final dayIds = <String>{};
    for (final body in snapshot.days) {
      final day = DayPlan.fromJson(body);
      if (!dayIds.add(day.id)) throw const FormatException('快照含重复的日期安排。');
    }
    final oldDays = await txn.query(
      'day_plans',
      where: 'family_id=?',
      whereArgs: [familyId],
    );
    for (final row in oldDays) {
      final id = row['id'] as String;
      if (dayIds.contains(id)) continue;
      await _hideMissingDay(txn, familyId, id);
    }
    await txn.delete(
      'participation_tombstones',
      where: 'family_id=?',
      whereArgs: [familyId],
    );
    for (final body in snapshot.days) {
      await _applyRemoteDay(
        txn,
        familyId,
        DayPlan.fromJson(body),
        authoritative: true,
      );
    }

    await _replaceGrowth(
      txn,
      familyId,
      snapshot.memories,
      snapshot.measurements,
      snapshot.observations,
    );
    await _replaceBooks(txn, familyId, snapshot.books.map(FamilyBook.fromJson));
    final sessionIds = <String>{};
    for (final body in snapshot.sessions) {
      final id = body['id'] as String;
      if (!sessionIds.add(id)) throw const FormatException('快照含重复的再玩记录。');
      await _applyRemoteSession(txn, familyId, body, authoritative: true);
    }
    for (final row in await txn.query(
      'play_sessions',
      where: 'family_id=?',
      whereArgs: [familyId],
    )) {
      if (!sessionIds.contains(row['id']) &&
          _syncJson(row['body_json'])['syncState'] == 'synced') {
        await txn.delete(
          'play_sessions',
          where: 'family_id=? AND id=?',
          whereArgs: [familyId, row['id']],
        );
      }
    }

    await txn.delete(
      'remote_media',
      where: 'family_id=?',
      whereArgs: [familyId],
    );
    final mediaIds = <String>{};
    for (final body in snapshot.media) {
      final id = body['id'] as String;
      if (!mediaIds.add(id)) throw const FormatException('快照含重复的照片。');
      await _applyRemoteMedia(txn, familyId, id, 0, body);
    }
    // 完整快照中找不到的已同步照片不能继续显示。待上传的原件仍保留。
    final localPhotos = await txn.query(
      'growth_media',
      where: "family_id=? AND state IN ('linked','removed')",
      whereArgs: [familyId],
    );
    for (final row in localPhotos) {
      if (!mediaIds.contains(row['server_media_id'])) {
        await _retireGrowthPhoto(txn, familyId, row);
      }
    }
    for (final body in snapshot.withdrawals) {
      await _applyWithdrawal(txn, familyId, body);
    }
    if (snapshot.preferences case final Json body) {
      await _applyRemotePreferences(txn, familyId, body, authoritative: true);
    }
    if (!isCurrent()) throw const FamilySyncCancelled();
    await _writeCursor(txn, familyId, snapshot.cursor);
    return true;
  });

  Future<bool> applyFamilyChanges({
    required String familyId,
    required String expectedCursor,
    required int expectedWriteVersion,
    required FamilyChangesPage page,
    required bool Function() isCurrent,
  }) => _db.transaction((txn) async {
    if (!await _syncWriteAllowed(
      txn,
      familyId,
      expectedCursor,
      expectedWriteVersion,
      isCurrent,
    )) {
      return false;
    }
    for (final change in page.changes) {
      await _applyFamilyChange(txn, familyId, change);
    }
    if (!isCurrent()) throw const FamilySyncCancelled();
    await _writeCursor(txn, familyId, page.nextCursor);
    return true;
  });

  Future<List<String>> readRetiredGrowthFiles() async => [
    for (final row in await _db.query(
      'retired_growth_files',
      columns: ['path'],
    ))
      row['path'] as String,
  ];

  Future<void> acknowledgeRetiredGrowthFile(String path) =>
      _db.delete('retired_growth_files', where: 'path=?', whereArgs: [path]);

  Future<bool> hasPendingFamilyPreferenceEdit(String familyId) =>
      _hasPending(_db, familyId, 'preferences:$familyId');

  Future<void> saveFamilyPreferenceEdit(
    String familyId,
    FamilyPreferences preferences,
    DateTime now,
  ) => _db.transaction((txn) async {
    final saved = await _readPreferenceBody(txn, familyId);
    final objectKey = 'preferences:$familyId';
    final last = (await txn.query(
      'outbox',
      where: "family_id=? AND object_key=? AND state<>'acked'",
      whereArgs: [familyId, objectKey],
      orderBy: 'sequence DESC',
      limit: 1,
    )).firstOrNull;
    final unsent =
        last != null &&
        last['state'] == 'pending' &&
        last['attempts'] == 0 &&
        (last['created_at'] as int) >
            now.toUtc().subtract(_operationLifetime).millisecondsSinceEpoch;
    final operationId = unsent
        ? last['operation_id'] as String
        : const Uuid().v4();
    final version = ((saved['_localVersion'] as int?) ?? 0) + 1;
    final request = {
      'operationId': operationId,
      'baseRevision': unsent
          ? _syncJson(last['body_json'])['baseRevision']
          : (saved['_serverRevision'] as int?) ?? 0,
      'availableMaterials': preferences.availableMaterials,
      'excludedMaterials': preferences.excludedMaterials,
      'languageMode': preferences.languageMode,
    };
    await _writePreferenceBody(txn, familyId, {
      ...saved,
      'availableMaterials': preferences.availableMaterials,
      'excludedMaterials': preferences.excludedMaterials,
      'languageMode': preferences.languageMode,
      '_localVersion': version,
    });
    final values = {
      'body_json': jsonEncode(request),
      'local_version': version,
      'retry_after': now.toUtc().millisecondsSinceEpoch,
    };
    if (unsent) {
      await txn.update(
        'outbox',
        values,
        where: 'operation_id=?',
        whereArgs: [operationId],
      );
    } else {
      await txn.insert('outbox', {
        ...values,
        'created_at': now.toUtc().millisecondsSinceEpoch,
        'operation_id': operationId,
        'family_id': familyId,
        'object_key': objectKey,
        'method': 'PUT',
        'path': '/families/$familyId/preferences',
        'state': 'pending',
      });
    }
  });

  /// 提醒是账号和设备状态，不能覆盖刚下载或排队中的家庭偏好。
  Future<void> saveReminderLocally(String familyId, FamilyPreferences value) =>
      _db.transaction((txn) async {
        final saved = await _readPreferenceBody(txn, familyId);
        await _writePreferenceBody(txn, familyId, {
          ...saved,
          'reminderEnabled': value.reminderEnabled,
          'reminderTime': value.reminderTime,
        });
      });
}

class FamilySyncCancelled implements Exception {
  const FamilySyncCancelled();
}

Json _syncJson(Object? body) => LocalStore._json(body);

Future<int> _readFamilyWriteVersion(
  DatabaseExecutor db,
  String familyId,
) async =>
    (await db.query(
          'sync_local_writes',
          where: 'family_id=?',
          whereArgs: [familyId],
        )).firstOrNull?['version']
        as int? ??
    0;

Future<void> _bumpFamilyWriteVersion(
  DatabaseExecutor txn,
  String familyId,
) async {
  await txn.insert('sync_local_writes', {
    'family_id': familyId,
    'version': (await _readFamilyWriteVersion(txn, familyId)) + 1,
  }, conflictAlgorithm: ConflictAlgorithm.replace);
}

Future<String?> _readSyncCursor(DatabaseExecutor db, String familyId) async =>
    (await db.query(
          'sync_cursors',
          where: 'family_id=?',
          whereArgs: [familyId],
        )).firstOrNull?['cursor']
        as String?;

Future<void> _writeCursor(
  DatabaseExecutor txn,
  String familyId,
  String cursor,
) => txn.insert('sync_cursors', {
  'family_id': familyId,
  'cursor': cursor,
}, conflictAlgorithm: ConflictAlgorithm.replace);

Future<bool> _syncWriteAllowed(
  DatabaseExecutor txn,
  String familyId,
  String? cursor,
  int writeVersion,
  bool Function() isCurrent,
) async =>
    isCurrent() &&
    await _readSyncCursor(txn, familyId) == cursor &&
    await _readFamilyWriteVersion(txn, familyId) == writeVersion;

Future<bool> _hasPending(
  DatabaseExecutor db,
  String familyId,
  String key,
) async => (await db.query(
  'outbox',
  columns: ['sequence'],
  where: "family_id=? AND object_key=? AND state<>'acked'",
  whereArgs: [familyId, key],
  limit: 1,
)).isNotEmpty;

Future<void> _applyFamilyChange(
  DatabaseExecutor txn,
  String familyId,
  FamilyChange change,
) async {
  final body = change.payload;
  if ((body == null) != change.deleted ||
      (body?['familyId'] != null && body!['familyId'] != familyId)) {
    throw const FormatException('同步变化不属于当前家庭或删除标记无效。');
  }
  switch (change.entity) {
    case 'family':
    case 'member':
    case 'child':
      // 每轮先重新验证 bootstrap；成员和孩子档案由该权限入口更新。
      if (body == null) throw const FormatException('家庭档案缺失。');
    case 'day_plan':
      await _applyRemoteDay(txn, familyId, DayPlan.fromJson(body!));
    case 'plan_item':
      await _applyRemoteItemEvent(txn, familyId, body!);
    case 'participation':
      if (change.deleted) {
        await _applyParticipationTombstone(
          txn,
          familyId,
          change.id,
          change.revision,
        );
      } else {
        final itemId = body!['planItemId'] as String;
        final date = await _planItemDate(txn, familyId, itemId);
        if (date != null) {
          await _applyRemoteParticipation(txn, familyId, itemId, date, body);
        }
      }
    case 'session':
      await _applyRemoteSession(txn, familyId, body!);
    case 'memory':
    case 'measurement':
    case 'observation':
      if (body == null) {
        final row = (await txn.query(
          'growth_records',
          where: 'family_id=? AND id=?',
          whereArgs: [familyId, change.id],
        )).firstOrNull;
        if (row != null &&
            ((_syncJson(row['body_json'])['serverRevision'] as int?) ?? 0) <=
                change.revision) {
          await _hideGrowth(
            txn,
            familyId,
            row,
            serverRevision: change.revision,
          );
        }
      } else {
        await _applyRemoteGrowth(txn, familyId, change.entity, body);
      }
    case 'family_book':
      if (body == null) {
        await txn.delete(
          'family_books',
          where: "family_id=? AND id=? AND sync_state='synced' AND revision<=?",
          whereArgs: [familyId, change.id, change.revision],
        );
      } else {
        await _applyRemoteBook(txn, familyId, FamilyBook.fromJson(body));
      }
    case 'media':
      await _applyRemoteMedia(txn, familyId, change.id, change.revision, body);
    case 'family_preferences':
      await _applyRemotePreferences(txn, familyId, body!);
    case 'withdrawal':
      await _applyWithdrawal(txn, familyId, body!);
    default:
      throw const FormatException('有当前版本不支持的同步内容，请更新应用。');
  }
}

Future<void> _applyWithdrawal(
  DatabaseExecutor txn,
  String familyId,
  Json entry,
) => txn.insert('withdrawals', {
  'family_id': familyId,
  'activity_id': entry['activityId'] as String,
  'activity_revision': entry['revision'] as int,
  'reason': entry['reason'] as String,
}, conflictAlgorithm: ConflictAlgorithm.replace);

Future<void> _applyRemoteDay(
  DatabaseExecutor txn,
  String familyId,
  DayPlan plan, {
  bool authoritative = false,
}) async {
  if (plan.familyId != familyId) throw const FormatException('计划不属于当前家庭。');
  final id = plan.id;
  final old = (await txn.query(
    'day_plans',
    where: 'family_id=? AND id=?',
    whereArgs: [familyId, id],
  )).firstOrNull;
  final localDay = old == null ? null : _syncJson(old['body_json']);
  final modePending =
      old != null && await _hasPending(txn, familyId, 'day_mode:$id');
  if (!authoritative &&
      !modePending &&
      old != null &&
      (old['revision'] as int) > plan.revision) {
    return;
  }
  if (!authoritative &&
      modePending &&
      (localDay!['_remoteDayRevision'] as int? ?? 0) > plan.revision) {
    return;
  }
  if (old == null) {
    await txn.insert('day_plans', {
      'family_id': familyId,
      'id': id,
      'child_id': plan.childId,
      'local_date': plan.date.toString(),
      'timezone': plan.timezone,
      'revision': plan.revision,
      'body_json': jsonEncode(plan.json),
    });
  } else if (old['child_id'] != plan.childId ||
      old['local_date'] != plan.date.toString()) {
    throw const FormatException('日计划的孩子或日期不一致。');
  }

  final items = <Json>[];
  final itemIds = <String>{};
  for (final item in plan.items) {
    if (item.dayPlanId != id || !itemIds.add(item.id)) {
      throw const FormatException('计划项归属不一致或重复。');
    }
    items.add(
      await _mergeRemoteItem(
        txn,
        familyId,
        id,
        plan.date.toString(),
        item.json,
        modePending: modePending,
        authoritative: authoritative,
        allowMissingParticipation: true,
      ),
    );
  }
  final oldItems = await txn.query(
    'plan_items',
    columns: ['id'],
    where: 'family_id=? AND day_id=?',
    whereArgs: [familyId, id],
  );
  for (final row in oldItems) {
    final itemId = row['id'] as String;
    if (!itemIds.contains(itemId)) {
      await _removeUnreferencedItem(txn, familyId, itemId);
    }
  }
  final merged = <String, dynamic>{...plan.json, 'items': items};
  if (modePending) {
    merged['mode'] = localDay!['mode'];
    merged['revision'] = localDay['revision'];
    merged['_remoteDayRevision'] = plan.revision;
    final visible = items.where((item) => item['visibility'] != 'hidden');
    merged['effectiveBudgetMinutes'] = visible.fold<int>(
      0,
      (sum, item) => sum + (item['budgetMinutes'] as int),
    );
    const kinds = [
      'movement',
      'explore',
      'reading',
      'english',
      'child-led',
      'calm',
    ];
    final visibleKinds = visible.map((item) => item['kind']).toSet();
    merged['missingSlots'] = kinds
        .where((kind) => !visibleKinds.contains(kind))
        .toList();
  }
  await txn.update(
    'day_plans',
    {
      'timezone': plan.timezone,
      'revision': merged['revision'],
      'body_json': jsonEncode(merged),
      'remote_deleted': 0,
    },
    where: 'family_id=? AND id=?',
    whereArgs: [familyId, id],
  );
}

Future<void> _hideMissingDay(
  DatabaseExecutor txn,
  String familyId,
  String dayId,
) async {
  final items = await txn.query(
    'plan_items',
    columns: ['id'],
    where: 'family_id=? AND day_id=?',
    whereArgs: [familyId, dayId],
  );
  var pinned = await _hasPending(txn, familyId, 'day_mode:$dayId');
  for (final row in items) {
    if (!await _removeUnreferencedItem(txn, familyId, row['id'] as String)) {
      pinned = true;
    }
  }
  if (pinned) {
    await txn.update(
      'day_plans',
      {'remote_deleted': 1},
      where: 'family_id=? AND id=?',
      whereArgs: [familyId, dayId],
    );
  } else {
    await txn.delete(
      'day_plans',
      where: 'family_id=? AND id=?',
      whereArgs: [familyId, dayId],
    );
  }
}

Future<bool> _removeUnreferencedItem(
  DatabaseExecutor txn,
  String familyId,
  String itemId,
) async {
  final args = [familyId, itemId];
  final participation = (await txn.query(
    'participations',
    where: 'family_id=? AND item_id=?',
    whereArgs: args,
  )).firstOrNull;
  if ((participation != null && participation['sync_state'] != 'synced') ||
      await _hasPending(txn, familyId, 'participation:$itemId') ||
      await _hasPending(txn, familyId, 'replace:$itemId')) {
    return false;
  }
  await txn.delete(
    'participations',
    where: 'family_id=? AND item_id=?',
    whereArgs: args,
  );
  await txn.delete(
    'plan_items',
    where: 'family_id=? AND id=?',
    whereArgs: args,
  );
  return true;
}

Future<String?> _planItemDate(
  DatabaseExecutor db,
  String familyId,
  String itemId,
) async =>
    (await db.rawQuery(
          '''SELECT d.local_date FROM plan_items i
      JOIN day_plans d ON i.day_id=d.id AND i.family_id=d.family_id
      WHERE i.family_id=? AND i.id=? AND d.remote_deleted=0''',
          [familyId, itemId],
        )).firstOrNull?['local_date']
        as String?;

Future<void> _applyRemoteItemEvent(
  DatabaseExecutor txn,
  String familyId,
  Json body, {
  bool authoritative = false,
}) async {
  final dayId = body['dayPlanId'] as String;
  final row = (await txn.query(
    'day_plans',
    where: 'family_id=? AND id=? AND remote_deleted=0',
    whereArgs: [familyId, dayId],
  )).firstOrNull;
  if (row == null) return;
  final day = _syncJson(row['body_json']);
  final items = (day['items'] as List)
      .map((value) => Map<String, dynamic>.from(value as Map))
      .toList();
  final index = items.indexWhere((entry) => entry['id'] == body['id']);
  // 重排后的旧计划项可能还在待传队列中，不能加回已更新的日期。
  if (index < 0) return;
  items[index] = await _mergeRemoteItem(
    txn,
    familyId,
    dayId,
    row['local_date'] as String,
    body,
    modePending: await _hasPending(txn, familyId, 'day_mode:$dayId'),
    authoritative: authoritative,
  );
  day['items'] = items;
  await txn.update(
    'day_plans',
    {'body_json': jsonEncode(day)},
    where: 'family_id=? AND id=?',
    whereArgs: [familyId, dayId],
  );
}

Future<Json> _mergeRemoteItem(
  DatabaseExecutor txn,
  String familyId,
  String dayId,
  String date,
  Json remote, {
  required bool modePending,
  bool authoritative = false,
  bool allowMissingParticipation = false,
}) async {
  final id = remote['id'] as String;
  final revision = remote['revision'] as int;
  final old = (await txn.query(
    'plan_items',
    where: 'family_id=? AND id=?',
    whereArgs: [familyId, id],
  )).firstOrNull;
  if (old != null && old['day_id'] != dayId) {
    throw const FormatException('计划项归属不一致。');
  }
  final local = old == null ? null : _syncJson(old['body_json']);
  final pending =
      local != null && await _hasPending(txn, familyId, 'replace:$id');
  if (!authoritative &&
      !pending &&
      old != null &&
      (old['revision'] as int) > revision) {
    return local!;
  }
  if (!authoritative &&
      pending &&
      (local['_remoteItemRevision'] as int? ?? 0) > revision) {
    return local;
  }
  final merged = <String, dynamic>{...remote};
  if (pending) {
    merged['snapshot'] = local['snapshot'];
    merged['revision'] = local['revision'];
    merged['_localSyncState'] = 'local_pending';
    merged['_remoteItemRevision'] = revision;
  }
  if (modePending && local != null) {
    merged['visibility'] = local['visibility'];
    merged['budgetMinutes'] = local['budgetMinutes'];
    if (local.containsKey('_localStandardMinutes')) {
      merged['_localStandardMinutes'] = local['_localStandardMinutes'];
    }
  }
  final row = {
    'family_id': familyId,
    'id': id,
    'day_id': dayId,
    'revision': merged['revision'],
    'body_json': jsonEncode(merged),
  };
  if (old == null) {
    await txn.insert('plan_items', row);
  } else {
    await txn.update(
      'plan_items',
      row,
      where: 'family_id=? AND id=?',
      whereArgs: [familyId, id],
    );
  }
  final value = remote['participation'];
  if (value != null || allowMissingParticipation) {
    await _applyRemoteParticipation(
      txn,
      familyId,
      id,
      date,
      value == null ? null : Map<String, dynamic>.from(value as Map),
      authoritative: authoritative,
    );
  }
  final actual = (await txn.query(
    'participations',
    where: 'family_id=? AND item_id=?',
    whereArgs: [familyId, id],
  )).firstOrNull;
  merged['participation'] = actual != null && actual['sync_state'] == 'synced'
      ? _syncJson(actual['body_json'])
      : null;
  await txn.update(
    'plan_items',
    {'body_json': jsonEncode(merged)},
    where: 'family_id=? AND id=?',
    whereArgs: [familyId, id],
  );
  return merged;
}

Future<void> _applyRemoteParticipation(
  DatabaseExecutor txn,
  String familyId,
  String itemId,
  String date,
  Json? remote, {
  bool authoritative = false,
}) async {
  final args = [familyId, itemId];
  final old = (await txn.query(
    'participations',
    where: 'family_id=? AND item_id=?',
    whereArgs: args,
  )).firstOrNull;
  if ((old != null && old['sync_state'] != 'synced') ||
      await _hasPending(txn, familyId, 'participation:$itemId')) {
    return;
  }
  if (remote == null) {
    // 没有参与记录的旧计划包不能撤销一条后来确认的记录。
    if (authoritative && old != null) {
      await txn.delete(
        'participations',
        where: 'family_id=? AND item_id=?',
        whereArgs: args,
      );
    }
    return;
  }
  if (remote['planItemId'] != itemId) {
    throw const FormatException('参与记录的计划项不一致。');
  }
  final revision = remote['revision'] as int;
  final remoteId = remote['id'] as String;
  final marker = (await txn.query(
    'participation_tombstones',
    where: 'family_id=? AND id=?',
    whereArgs: [familyId, remoteId],
  )).firstOrNull;
  if (marker != null && (marker['revision'] as int) >= revision) return;
  if (!authoritative &&
      old != null &&
      _syncJson(old['body_json'])['id'] == remoteId &&
      (old['server_revision'] as int) > revision) {
    return;
  }
  await txn.insert('participations', {
    'family_id': familyId,
    'item_id': itemId,
    'body_json': jsonEncode({...remote, 'localDate': date}),
    'server_revision': revision,
    'local_version': old?['local_version'] ?? 0,
    'sync_state': 'synced',
  }, conflictAlgorithm: ConflictAlgorithm.replace);
}

Future<void> _applyParticipationTombstone(
  DatabaseExecutor txn,
  String familyId,
  String id,
  int revision,
) async {
  final old = (await txn.query(
    'participation_tombstones',
    where: 'family_id=? AND id=?',
    whereArgs: [familyId, id],
  )).firstOrNull;
  if (old == null || (old['revision'] as int) < revision) {
    await txn.insert('participation_tombstones', {
      'family_id': familyId,
      'id': id,
      'revision': revision,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }
  // 服务端的墓碑 ID 是参与记录 ID，不是计划项 ID。
  for (final row in await txn.query(
    'participations',
    where: "family_id=? AND sync_state='synced' AND server_revision<=?",
    whereArgs: [familyId, revision],
  )) {
    if (_syncJson(row['body_json'])['id'] != id) continue;
    final itemId = row['item_id'] as String;
    if (await _hasPending(txn, familyId, 'participation:$itemId')) continue;
    await txn.delete(
      'participations',
      where: 'family_id=? AND item_id=?',
      whereArgs: [familyId, itemId],
    );
    final item = (await txn.query(
      'plan_items',
      where: 'family_id=? AND id=?',
      whereArgs: [familyId, itemId],
    )).firstOrNull;
    if (item == null) continue;
    final clean = _syncJson(item['body_json'])..['participation'] = null;
    await txn.update(
      'plan_items',
      {'body_json': jsonEncode(clean)},
      where: 'family_id=? AND id=?',
      whereArgs: [familyId, itemId],
    );
    final dayId = item['day_id'] as String;
    final day = (await txn.query(
      'day_plans',
      where: 'family_id=? AND id=?',
      whereArgs: [familyId, dayId],
    )).firstOrNull;
    if (day == null) continue;
    final body = _syncJson(day['body_json']);
    body['items'] = [
      for (final entry in body['items'] as List)
        if (entry['id'] == itemId) clean else entry,
    ];
    await txn.update(
      'day_plans',
      {'body_json': jsonEncode(body)},
      where: 'family_id=? AND id=?',
      whereArgs: [familyId, dayId],
    );
  }
}

Future<void> _applyRemoteSession(
  DatabaseExecutor txn,
  String familyId,
  Json remote, {
  bool authoritative = false,
}) async {
  final id = remote['id'] as String;
  final childId = remote['childId'] as String;
  final date = FamilyDate.parse(remote['localDate'] as String).toString();
  final revision = remote['revision'] as int;
  final old = (await txn.query(
    'play_sessions',
    where: 'family_id=? AND id=?',
    whereArgs: [familyId, id],
  )).firstOrNull;
  if (old != null) {
    if (old['child_id'] != childId) throw const FormatException('再玩记录的孩子不一致。');
    final saved = _syncJson(old['body_json']);
    if (saved['syncState'] != 'synced' ||
        (!authoritative && (saved['revision'] as int? ?? 0) > revision)) {
      return;
    }
  }
  await txn.insert('play_sessions', {
    'family_id': familyId,
    'child_id': childId,
    'id': id,
    'local_date': date,
    'body_json': jsonEncode({...remote, 'syncState': 'synced'}),
  }, conflictAlgorithm: ConflictAlgorithm.replace);
}

Future<void> _replaceGrowth(
  DatabaseExecutor txn,
  String familyId,
  List<Json> memories,
  List<Json> measurements,
  List<Json> observations, {
  String? childId,
}) async {
  final received = <(String, String)>{};
  final byEntity = {
    'memory': memories,
    'measurement': measurements,
    'observation': observations,
  };
  for (final entry in byEntity.entries) {
    for (final body in entry.value) {
      if (childId != null && body['childId'] != childId) continue;
      if (!received.add((body['childId'] as String, body['id'] as String))) {
        throw const FormatException('快照含重复的成长记录。');
      }
      await _applyRemoteGrowth(
        txn,
        familyId,
        entry.key,
        body,
        authoritative: true,
      );
    }
  }
  for (final row in await txn.query(
    'growth_records',
    where: childId == null ? 'family_id=?' : 'family_id=? AND child_id=?',
    whereArgs: [familyId, ?childId],
  )) {
    if (received.contains((row['child_id'], row['id']))) continue;
    final body = _syncJson(row['body_json']);
    if (body['syncState'] == 'synced' ||
        ((body['serverRevision'] as int?) ?? 0) > 0) {
      await _hideGrowth(txn, familyId, row);
    }
  }
}

Future<void> _applyRemoteGrowth(
  DatabaseExecutor txn,
  String familyId,
  String entity,
  Json remote, {
  bool authoritative = false,
}) async {
  final id = remote['id'] as String;
  final childId = remote['childId'] as String;
  final date = FamilyDate.parse(remote['localDate'] as String).toString();
  final old = (await txn.query(
    'growth_records',
    where: 'family_id=? AND id=?',
    whereArgs: [familyId, id],
  )).firstOrNull;
  if (old != null && old['child_id'] != childId) {
    throw const FormatException('成长记录的孩子不一致。');
  }
  final revision = remote['revision'] as int;
  final saved = old == null ? null : _syncJson(old['body_json']);
  if (!authoritative &&
      saved != null &&
      ((saved['serverRevision'] as int?) ?? 0) > revision) {
    return;
  }
  if (remote['deletedAt'] != null) {
    if (old != null) {
      await _hideGrowth(
        txn,
        familyId,
        old,
        serverRevision: revision,
        deletedAt: remote['deletedAt'] as String?,
      );
    }
    return;
  }
  if (saved != null && saved['syncState'] != 'synced') {
    // 保留家长写下的原文。远端恢复仅解除已删除遮罩，不改写待传版本。
    await txn.update(
      'growth_records',
      {'remote_deleted': 0},
      where: 'family_id=? AND child_id=? AND id=?',
      whereArgs: [familyId, childId, id],
    );
    return;
  }
  final record = _remoteGrowthRecord(entity, remote, saved);
  // 旧快照或编辑响应携带的照片 ID 不能覆盖已收到的永久删除。
  if (!authoritative && entity == 'memory') {
    final deleted = await txn.query(
      'remote_media',
      columns: ['id'],
      where: 'family_id=? AND deleted=1',
      whereArgs: [familyId],
    );
    final deletedIds = {for (final row in deleted) row['id']};
    (record['mediaIds'] as List).removeWhere(deletedIds.contains);
  }
  GrowthRecord.fromJson(record);
  final values = {
    'family_id': familyId,
    'child_id': childId,
    'id': id,
    'local_date': date,
    'body_json': jsonEncode(record),
    'remote_deleted': 0,
  };
  if (old == null) {
    await txn.insert('growth_records', values);
  } else {
    // SQLite REPLACE 先删除旧行，会触发外键级联，丢掉本机待上传照片。
    await txn.update(
      'growth_records',
      values,
      where: 'family_id=? AND child_id=? AND id=?',
      whereArgs: [familyId, childId, id],
    );
  }
}

Future<void> _applyAcknowledgedGrowth(
  DatabaseExecutor txn,
  String familyId,
  String entity,
  Json remote,
) async {
  final id = remote['id'] as String;
  final childId = remote['childId'] as String;
  final old = (await txn.query(
    'growth_records',
    where: 'family_id=? AND id=?',
    whereArgs: [familyId, id],
  )).firstOrNull;
  if (old != null && old['child_id'] != childId) {
    throw const FormatException('成长记录的孩子不一致。');
  }
  final saved = old == null ? null : _syncJson(old['body_json']);
  final record = _remoteGrowthRecord(entity, remote, saved);
  final values = {
    'family_id': familyId,
    'child_id': childId,
    'id': id,
    'local_date': FamilyDate.parse(remote['localDate'] as String).toString(),
    'body_json': jsonEncode(record),
    'remote_deleted': 0,
  };
  if (old == null) {
    await txn.insert('growth_records', values);
  } else {
    await txn.update(
      'growth_records',
      values,
      where: 'family_id=? AND child_id=? AND id=?',
      whereArgs: [familyId, childId, id],
    );
  }
}

Json _remoteGrowthRecord(String entity, Json remote, Json? saved) {
  final date = FamilyDate.parse(remote['localDate'] as String);
  return <String, dynamic>{
    'id': remote['id'],
    'localDate': date.toString(),
    'createdAt': saved?['createdAt'] ?? '${date}T00:00:00.000Z',
    'syncState': 'synced',
    'serverRevision': remote['revision'],
    'mediaIds': <String>[],
    'deletedAt': remote['deletedAt'],
    ...switch (entity) {
      'measurement' => {
        'type': 'measurement',
        'text': '',
        'value': remote['value'],
        'unit': remote['unit'],
        'measurementKind': remote['kind'],
        'measurementMethod': remote['method'],
        'measurementSource': remote['source'],
      },
      'observation' => {
        'type': 'observation',
        'text': remote['note'],
        'guideId': remote['guideId'],
        'observationValue': remote['value'],
      },
      _ => {
        'type': remote['type'],
        'text': remote['text'],
        'firstConfirmed': remote['firstConfirmed'] == true,
        'mediaIds': List<String>.from(remote['mediaIds'] as List? ?? const []),
      },
    },
  };
}

Future<void> _hideGrowth(
  DatabaseExecutor txn,
  String familyId,
  Map<String, Object?> row, {
  int? serverRevision,
  String? deletedAt,
}) async {
  final id = row['id'] as String;
  final childId = row['child_id'] as String;
  final body = _syncJson(row['body_json']);
  if (serverRevision != null) {
    body['serverRevision'] = serverRevision;
  }
  final photos = await txn.query(
    'growth_media',
    where: 'family_id=? AND memory_id=?',
    whereArgs: [familyId, id],
  );
  final pendingPhoto = photos.any(
    (row) => row['state'] != 'linked' && row['state'] != 'removed',
  );
  final pendingText = body['syncState'] != 'synced';
  for (final photo in photos) {
    if (photo['state'] == 'linked' || photo['state'] == 'removed') {
      await _retireGrowthPhoto(txn, familyId, photo);
    }
  }
  if (pendingText || pendingPhoto) {
    if (!pendingText) {
      // 清掉已删除的同步正文；只留待上传照片所需的外键和本机占位。
      body['text'] = '';
      body['mediaIds'] = <String>[];
    }
    await txn.update(
      'growth_records',
      {
        'remote_deleted': 1,
        'body_json': jsonEncode({
          ...body,
          'deletedAt':
              deletedAt ??
              body['deletedAt'] ??
              DateTime.now().toUtc().toIso8601String(),
        }),
      },
      where: 'family_id=? AND child_id=? AND id=?',
      whereArgs: [familyId, childId, id],
    );
  } else {
    await txn.update(
      'growth_records',
      {
        'remote_deleted': 1,
        'body_json': jsonEncode({
          ...body,
          'deletedAt':
              deletedAt ??
              body['deletedAt'] ??
              DateTime.now().toUtc().toIso8601String(),
        }),
      },
      where: 'family_id=? AND child_id=? AND id=?',
      whereArgs: [familyId, childId, id],
    );
  }
}

Future<void> _retireGrowthPhoto(
  DatabaseExecutor txn,
  String familyId,
  Map<String, Object?> row,
) async {
  final path = row['local_path'] as String;
  if (path.isNotEmpty) {
    await txn.insert('retired_growth_files', {
      'path': path,
    }, conflictAlgorithm: ConflictAlgorithm.ignore);
  }
  await txn.delete(
    'growth_media',
    where: 'family_id=? AND id=?',
    whereArgs: [familyId, row['id']],
  );
}

Future<void> _applyRemoteMedia(
  DatabaseExecutor txn,
  String familyId,
  String id,
  int revision,
  Json? body,
) async {
  final old = (await txn.query(
    'remote_media',
    where: 'family_id=? AND id=?',
    whereArgs: [familyId, id],
  )).firstOrNull;
  if (old != null &&
      ((old['revision'] as int) > revision ||
          (old['deleted'] == 1 && (old['revision'] as int) >= revision))) {
    return;
  }
  final memoryId = body?['memoryId'] as String? ?? old?['memory_id'] as String?;
  if (body != null && (memoryId == null || body['id'] != id)) {
    throw const FormatException('照片归属不完整。');
  }
  final gone = body == null || body['state'] == 'deleted';
  await txn.insert('remote_media', {
    'family_id': familyId,
    'id': id,
    'memory_id': memoryId,
    'revision': revision,
    'deleted': gone ? 1 : 0,
  }, conflictAlgorithm: ConflictAlgorithm.replace);

  if (gone) {
    final localPhotos = await txn.query(
      'growth_media',
      where: 'family_id=? AND server_media_id=?',
      whereArgs: [familyId, id],
    );
    for (final photo in localPhotos) {
      // 这是这张照片的服务端永久删除墓碑，不能重传相同文件。
      await _retireGrowthPhoto(txn, familyId, photo);
    }
  }
  // media 事件并不增加小记修订；墓碑也未必知道父条目 ID。
  final affected = await txn.query(
    'growth_records',
    where: memoryId == null
        ? 'family_id=? AND remote_deleted=0'
        : 'family_id=? AND id=? AND remote_deleted=0',
    whereArgs: [familyId, ?memoryId],
  );
  for (final row in affected) {
    final record = _syncJson(row['body_json']);
    final ids = Set<String>.from(record['mediaIds'] as List? ?? const []);
    final changed = gone
        ? ids.remove(id)
        : body['state'] == 'ready' && ids.add(id);
    if (!changed) continue;
    record['mediaIds'] = ids.toList();
    await txn.update(
      'growth_records',
      {'body_json': jsonEncode(record)},
      where: 'family_id=? AND child_id=? AND id=?',
      whereArgs: [familyId, row['child_id'], row['id']],
    );
  }
}

Future<void> _replaceBooks(
  DatabaseExecutor txn,
  String familyId,
  Iterable<FamilyBook> books,
) async {
  final ids = <String>{};
  for (final book in books) {
    if (!ids.add(book.id)) throw const FormatException('快照含重复的绘本。');
    await _applyRemoteBook(txn, familyId, book, authoritative: true);
  }
  final previous = await txn.query(
    'family_books',
    columns: ['id'],
    where: "family_id=? AND sync_state='synced'",
    whereArgs: [familyId],
  );
  for (final row in previous) {
    if (!ids.contains(row['id'])) {
      await txn.delete(
        'family_books',
        where: 'family_id=? AND id=?',
        whereArgs: [familyId, row['id']],
      );
    }
  }
}

Future<void> _applyRemoteBook(
  DatabaseExecutor txn,
  String familyId,
  FamilyBook book, {
  bool authoritative = false,
}) async {
  if (book.familyId != familyId) throw const FormatException('绘本不属于当前家庭。');
  final old = (await txn.query(
    'family_books',
    where: 'family_id=? AND id=?',
    whereArgs: [familyId, book.id],
  )).firstOrNull;
  if (old != null &&
      (old['sync_state'] != 'synced' ||
          (!authoritative && (old['revision'] as int) > book.revision))) {
    return;
  }
  await txn.insert('family_books', {
    'family_id': familyId,
    'id': book.id,
    'revision': book.revision,
    'sync_state': 'synced',
    'title': book.title,
    'body_json': jsonEncode({...book.toJson(), 'syncState': 'synced'}),
  }, conflictAlgorithm: ConflictAlgorithm.replace);
}

Future<Json> _readPreferenceBody(DatabaseExecutor db, String familyId) async {
  final row = (await db.query(
    'family_preferences',
    where: 'family_id=?',
    whereArgs: [familyId],
  )).firstOrNull;
  return row == null
      ? const FamilyPreferences().toJson()
      : _syncJson(row['body_json']);
}

Future<void> _writePreferenceBody(
  DatabaseExecutor db,
  String familyId,
  Json body,
) => db.insert('family_preferences', {
  'family_id': familyId,
  'body_json': jsonEncode(body),
}, conflictAlgorithm: ConflictAlgorithm.replace);

Future<void> _applyRemotePreferences(
  DatabaseExecutor txn,
  String familyId,
  Json remote, {
  bool authoritative = false,
}) async {
  final previous = await _readPreferenceBody(txn, familyId);
  final revision = remote['revision'] as int;
  if (remote['familyId'] != familyId) throw const FormatException('偏好不属于当前家庭。');
  if (!authoritative && (previous['_serverRevision'] as int? ?? 0) > revision) {
    return;
  }
  if (await _hasPending(txn, familyId, 'preferences:$familyId')) return;
  final body = _preferenceWithRemote(previous, remote, revision);
  await _writePreferenceBody(txn, familyId, body);
}

Json _preferenceWithRemote(Json current, Json remote, int revision) => {
  ...current,
  '_serverRevision': revision,
  'availableMaterials': List<String>.from(remote['availableMaterials'] as List),
  'excludedMaterials': List<String>.from(remote['excludedMaterials'] as List),
  'languageMode': remote['languageMode'] as String,
};
