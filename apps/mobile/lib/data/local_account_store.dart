part of 'local_store.dart';

extension LocalAccountStore on LocalStore {
  /// 根库只用于未登录模式和权限凭证的非敏感索引。登录资料按服务和账号分库。
  Future<LocalStore> openAccountStore(Uri service, String userId) async {
    final key = _partitionKey(service, userId);
    final parent = p.dirname(_db.path);
    final name = p.basename(_db.path);
    return LocalStore.open(
      factory: _factory,
      path: _db.path == inMemoryDatabasePath
          ? inMemoryDatabasePath
          : p.join(parent, '$name.account-$key.db'),
      singleInstance: _db.path == inMemoryDatabasePath ? false : null,
    );
  }

  /// 只接受升级时已记录的唯一归属。之后的登录不会为旧资料补造归属。
  Future<void> adoptLegacyAccountData({
    required LocalStore source,
    required Uri service,
    required String userId,
    required String familyId,
    bool Function()? isCurrent,
  }) async {
    if (identical(_db, source._db) || isCurrent?.call() == false) return;
    final key = 'legacy:$familyId';
    if (await _hasAccountMigration(_db, key)) return;
    final old = await source._db.transaction((txn) async {
      final owners = await txn.query(
        'legacy_scope_owners',
        where: 'family_id=?',
        whereArgs: [familyId],
      );
      if (owners.length != 1 ||
          owners.single['scope'] != _partitionKey(service, userId)) {
        return null;
      }
      return _readLegacyFamily(txn, familyId, userId);
    });
    if (old == null || isCurrent?.call() == false) return;
    try {
      await _db.transaction((txn) async {
        if (await _hasAccountMigration(txn, key)) return;
        for (final entry in old.entries) {
          for (final row in entry.value) {
            final values = Map<String, Object?>.from(row);
            if (entry.key == 'outbox') {
              values.remove('sequence');
              if (values['state'] == 'sending') values['state'] = 'pending';
            }
            if (entry.key == 'growth_media') {
              // 链接与签发会话绑定；升级后由同一 operationId 重新签发。
              values['upload_url'] = null;
              values['upload_expires_at'] = null;
            }
            await txn.insert(
              entry.key,
              values,
              conflictAlgorithm: ConflictAlgorithm.ignore,
            );
          }
        }
        if (isCurrent?.call() == false) throw const FamilySyncCancelled();
        await _markAccountMigration(txn, key);
      });
    } on FamilySyncCancelled {
      return;
    }
  }

  /// 第一次连接时接收匿名模式下的成长和绘本。重复运行不会重新登记。
  Future<void> adoptLocalPreviewData({
    required LocalStore source,
    required String familyId,
    required String childId,
    String sourceFamilyId = 'demo-family',
    String sourceChildId = 'demo-child',
    bool Function()? isCurrent,
  }) async {
    if (identical(_db, source._db) ||
        !sourceFamilyId.startsWith('demo-') ||
        isCurrent?.call() == false) {
      return;
    }
    final originKey = 'demo-origin:$sourceFamilyId:$sourceChildId';
    final targetKey = 'demo-import:$sourceFamilyId:$sourceChildId';
    final claim = await _accountStoreId(_db);
    if (isCurrent?.call() == false) return;
    final old = await source._db.transaction((txn) async {
      final origin = await _readAccountMigration(txn, originKey);
      if (origin != null && origin != claim) return null;
      final records = await txn.query(
        'growth_records',
        where: 'family_id=? AND child_id=?',
        whereArgs: [sourceFamilyId, sourceChildId],
      );
      final ids = {for (final row in records) row['id'] as String};
      final photos = await txn.query(
        'growth_media',
        where: 'family_id=? AND child_id=?',
        whereArgs: [sourceFamilyId, sourceChildId],
      );
      final books = await txn.query(
        'family_books',
        where: "family_id=? AND sync_state='local_pending'",
        whereArgs: [sourceFamilyId],
      );
      final objectKeys = {
        for (final id in ids) 'growth:$id',
        for (final book in books) "book:${book['id']}",
      };
      if (objectKeys.isEmpty) return null;
      final operations = (await txn.query(
        'outbox',
        where: "family_id=? AND state<>'acked'",
        whereArgs: [sourceFamilyId],
        orderBy: 'sequence',
      )).where((row) => objectKeys.contains(row['object_key'])).toList();
      if (isCurrent?.call() == false) return null;
      await _markAccountMigration(txn, originKey, claim);
      return <String, List<Map<String, Object?>>>{
        'growth_records': records,
        'growth_media': photos,
        'family_books': books,
        'outbox': operations,
      };
    });
    if (old == null || isCurrent?.call() == false) return;

    final manifest = sha256.convert(utf8.encode(jsonEncode(old))).toString();
    final copied = await _db
        .transaction((txn) async {
          final imported = await _readAccountMigration(txn, targetKey);
          // 上一次写到目标库后可能还没来得及清理根库，只清理完全相同的批次。
          if (imported != null) return imported == manifest;
          for (final entry in old.entries) {
            for (final row in entry.value) {
              final values = <String, Object?>{...row, 'family_id': familyId};
              if (values['child_id'] == sourceChildId) {
                values['child_id'] = childId;
              }
              if (entry.key == 'family_books') {
                final book = _syncJson(row['body_json'])
                  ..['familyId'] = familyId;
                values['body_json'] = jsonEncode(book);
              }
              if (entry.key == 'outbox') {
                values.remove('sequence');
                values['path'] = (values['path'] as String)
                    .replaceFirst(
                      '/children/$sourceChildId/',
                      '/children/$childId/',
                    )
                    .replaceFirst(
                      '/families/$sourceFamilyId/',
                      '/families/$familyId/',
                    );
                if (values['state'] == 'sending') values['state'] = 'pending';
              }
              // 若碰到同 ID，整批回滚；仍可从本机资料找回原件。
              await txn.insert(entry.key, values);
            }
          }
          if (isCurrent?.call() == false) throw const FamilySyncCancelled();
          await _markAccountMigration(txn, targetKey, manifest);
          return true;
        })
        .onError<FamilySyncCancelled>((_, _) => false);
    if (!copied) return;

    // 目标入库后才移走原行；若恰好有新编辑，只保留原件，不清理新内容。
    await source._db.transaction((txn) async {
      for (final row in old['outbox']!) {
        await txn.delete(
          'outbox',
          where: 'family_id=? AND operation_id=? AND body_json=?',
          whereArgs: [sourceFamilyId, row['operation_id'], row['body_json']],
        );
      }
      for (final row in old['family_books']!) {
        await txn.delete(
          'family_books',
          where: 'family_id=? AND id=? AND body_json=?',
          whereArgs: [sourceFamilyId, row['id'], row['body_json']],
        );
      }
      final photoIds = {for (final photo in old['growth_media']!) photo['id']};
      for (final row in old['growth_records']!) {
        final stillThere = await txn.query(
          'growth_media',
          columns: ['id'],
          where: 'family_id=? AND child_id=? AND memory_id=?',
          whereArgs: [sourceFamilyId, sourceChildId, row['id']],
        );
        if (stillThere.any((photo) => !photoIds.contains(photo['id']))) {
          continue;
        }
        await txn.delete(
          'growth_records',
          where: 'family_id=? AND child_id=? AND id=? AND body_json=?',
          whereArgs: [
            sourceFamilyId,
            sourceChildId,
            row['id'],
            row['body_json'],
          ],
        );
      }
    });
  }
}

String _partitionKey(Uri service, String userId) {
  final normalized = service.normalizePath().replace(
    path: service.normalizePath().path.replaceFirst(RegExp(r'/+$'), ''),
  );
  return sha256
      .convert(utf8.encode(jsonEncode([normalized.toString(), userId])))
      .toString();
}

Future<void> _createV7Tables(
  Database db, {
  bool retainLegacyOwners = false,
}) async {
  await db.execute(
    'CREATE TABLE account_migrations (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  );
  await db.execute(
    '''CREATE TABLE legacy_scope_owners (
    family_id TEXT NOT NULL, scope TEXT NOT NULL, PRIMARY KEY(family_id, scope))''',
  );
  if (!retainLegacyOwners) return;
  final drafts = await db.query(
    'drafts',
    where: "family_id='account-scope' AND draft_key LIKE 'authorized-family:%'",
  );
  for (final draft in drafts) {
    try {
      const prefix = 'authorized-family:';
      final service = Uri.parse(
        (draft['draft_key'] as String).substring(prefix.length),
      );
      if (!service.hasAuthority ||
          !const {'https', 'http'}.contains(service.scheme) ||
          service.userInfo.isNotEmpty ||
          service.hasQuery ||
          service.hasFragment) {
        continue;
      }
      final profile = AccountBootstrap.fromJson(_syncJson(draft['body_json']));
      if (draft['owner_id'] != profile.userId) continue;
      for (final family in profile.families) {
        await db.insert('legacy_scope_owners', {
          'family_id': family.id,
          'scope': _partitionKey(service, profile.userId),
        }, conflictAlgorithm: ConflictAlgorithm.ignore);
      }
    } on FormatException {
      // 无法证明归属的旧缓存保留在原库，不分配给之后登录的人。
    } on TypeError {
      // 忽略缺少必要档案字段的旧凭证。
    }
  }
}

Future<Map<String, List<Map<String, Object?>>>> _readLegacyFamily(
  DatabaseExecutor txn,
  String familyId,
  String ownerId,
) async {
  final result = <String, List<Map<String, Object?>>>{};
  for (final table in const [
    'day_plans',
    'plan_items',
    'participations',
    'growth_records',
    'growth_media',
    'family_books',
    'play_sessions',
    'family_preferences',
    'withdrawals',
    'drafts',
    'outbox',
  ]) {
    result[table] = (await txn.query(
      table,
      where: switch (table) {
        'drafts' => 'family_id=? AND owner_id=?',
        'outbox' => "family_id=? AND state<>'acked'",
        _ => 'family_id=?',
      },
      whereArgs: [familyId, if (table == 'drafts') ownerId],
      orderBy: table == 'outbox' ? 'sequence' : null,
    )).toList();
  }
  final planIds = <Object?>{};
  final itemIds = <Object?>{};
  final editable = <String>{};
  final pending = {for (final row in result['outbox']!) row['object_key']};
  final editedDayIds = {
    for (final row in result['outbox']!)
      if ((row['object_key'] as String).startsWith('day_mode:'))
        (row['object_key'] as String).substring('day_mode:'.length),
    for (final item in result['plan_items']!)
      if (pending.contains("replace:${item['id']}")) item['day_id'],
  };
  result['day_plans']!.removeWhere((row) => editedDayIds.contains(row['id']));
  planIds.addAll(result['day_plans']!.map((row) => row['id']));
  result['plan_items']!.removeWhere((row) => !planIds.contains(row['day_id']));
  itemIds.addAll(result['plan_items']!.map((row) => row['id']));
  result['participations']!.removeWhere((row) {
    final itemId = row['item_id'];
    if (!itemIds.contains(itemId)) return true;
    if (row['sync_state'] == 'synced') return false;
    // 旧队列没有账号列。须有具体编辑作者，不能只靠家长当前还在同一家庭。
    if (_syncJson(row['body_json'])['addedBy'] != ownerId) return true;
    editable.add('participation:$itemId');
    return false;
  });
  result['play_sessions']!.removeWhere((row) {
    final body = _syncJson(row['body_json']);
    if (body['syncState'] == 'synced') return false;
    if (body['addedBy'] != ownerId) return true;
    editable.add("play_session:${row['id']}");
    return false;
  });
  final ownedGrowth = <Object?>{};
  result['growth_records']!.removeWhere((row) {
    final body = _syncJson(row['body_json']);
    if (body['_localOwnerId'] == ownerId) {
      ownedGrowth.add(row['id']);
      editable.add("growth:${row['id']}");
      return false;
    }
    return body['syncState'] != 'synced';
  });
  final growthIds = {for (final row in result['growth_records']!) row['id']};
  result['growth_media']!.removeWhere(
    (row) =>
        !growthIds.contains(row['memory_id']) ||
        (row['state'] != 'linked' && !ownedGrowth.contains(row['memory_id'])),
  );
  result['family_books']!.removeWhere((row) {
    if (row['sync_state'] == 'synced') return false;
    if (_syncJson(row['body_json'])['_localOwnerId'] != ownerId) return true;
    editable.add("book:${row['id']}");
    return false;
  });
  result['outbox']!.removeWhere((row) {
    if (!editable.contains(row['object_key'])) return true;
    if ((row['object_key'] as String).startsWith('participation:')) {
      final itemId = (row['object_key'] as String).substring(
        'participation:'.length,
      );
      final latest = result['participations']!.firstWhere(
        (value) => value['item_id'] == itemId,
      );
      // 同对象更早的离线操作可能来自另一账号；仅迁移能逐条对上的这一版。
      return _syncJson(latest['body_json'])['operationId'] !=
          row['operation_id'];
    }
    return false;
  });
  // 旧偏好和设备提醒未区分账号，登录后分别从服务同步。
  result.remove('family_preferences');
  return result;
}

Future<String> _accountStoreId(Database db) => db.transaction((txn) async {
  const key = 'account-store-id';
  final saved = await _readAccountMigration(txn, key);
  if (saved != null) return saved;
  final next = const Uuid().v4();
  await _markAccountMigration(txn, key, next);
  return next;
});

Future<String?> _readAccountMigration(DatabaseExecutor db, String key) async =>
    (await db.query(
          'account_migrations',
          where: 'key=?',
          whereArgs: [key],
        )).firstOrNull?['value']
        as String?;

Future<bool> _hasAccountMigration(DatabaseExecutor db, String key) async =>
    await _readAccountMigration(db, key) != null;

Future<void> _markAccountMigration(
  DatabaseExecutor txn,
  String key, [
  String value = 'done',
]) => txn.insert('account_migrations', {
  'key': key,
  'value': value,
}, conflictAlgorithm: ConflictAlgorithm.ignore);
