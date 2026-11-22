import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';
import 'package:uuid/uuid.dart';

import '../core/family_date.dart';
import '../domain/family_sync.dart';
import '../domain/models.dart';

part 'local_family_sync.dart';
part 'local_account_store.dart';

const _maxGrowthPhotosPerRecord = 5;
const _operationLifetime = Duration(days: 90);

/// 每次业务编辑与待传操作共用一个 SQLite 事务。
/// 仅保存家庭业务数据；任何会话令牌均不得传入本存储。
class LocalStore {
  LocalStore._(this._db, this._factory);
  final Database _db;
  final DatabaseFactory _factory;

  static Future<LocalStore> open({
    required DatabaseFactory factory,
    required String path,
    bool? singleInstance,
  }) async {
    final database = await factory.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: 7,
        singleInstance: singleInstance,
        onConfigure: (db) async {
          await db.execute('PRAGMA foreign_keys = ON');
        },
        onCreate: (db, version) async {
          await db.execute(
            '''CREATE TABLE day_plans (
            family_id TEXT NOT NULL, id TEXT NOT NULL, child_id TEXT NOT NULL,
            local_date TEXT NOT NULL, timezone TEXT NOT NULL,
            revision INTEGER NOT NULL, body_json TEXT NOT NULL,
            PRIMARY KEY(family_id, id), UNIQUE(family_id, child_id, local_date))''',
          );
          await db.execute(
            '''CREATE TABLE plan_items (
            family_id TEXT NOT NULL, id TEXT NOT NULL, day_id TEXT NOT NULL,
            revision INTEGER NOT NULL, body_json TEXT NOT NULL,
            PRIMARY KEY(family_id, id),
            FOREIGN KEY(family_id, day_id) REFERENCES day_plans(family_id, id))''',
          );
          await db.execute(
            '''CREATE TABLE participations (
            family_id TEXT NOT NULL, item_id TEXT NOT NULL,
            body_json TEXT NOT NULL, server_revision INTEGER NOT NULL DEFAULT 0,
            local_version INTEGER NOT NULL, sync_state TEXT NOT NULL,
            PRIMARY KEY(family_id, item_id),
            FOREIGN KEY(family_id, item_id) REFERENCES plan_items(family_id, id))''',
          );
          await db.execute('''CREATE TABLE outbox (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            operation_id TEXT NOT NULL UNIQUE, family_id TEXT NOT NULL,
            object_key TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
            body_json TEXT NOT NULL, local_version INTEGER NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('pending','sending','failed','conflict','acked')),
            attempts INTEGER NOT NULL DEFAULT 0, result_json TEXT,
            error_code TEXT, retry_after INTEGER NOT NULL DEFAULT 0)''');
          await db.execute(
            'CREATE INDEX outbox_object ON outbox(family_id, object_key, sequence)',
          );
          await db.execute(
            '''CREATE TABLE drafts (
            family_id TEXT NOT NULL, owner_id TEXT NOT NULL, draft_key TEXT NOT NULL,
            body_json TEXT NOT NULL, PRIMARY KEY(family_id, owner_id, draft_key))''',
          );
          await db.execute('''CREATE TABLE sync_cursors (
            family_id TEXT PRIMARY KEY, cursor TEXT NOT NULL)''');
          await db.execute('''CREATE TABLE withdrawals (
            family_id TEXT NOT NULL, activity_id TEXT NOT NULL,
            activity_revision INTEGER NOT NULL, reason TEXT NOT NULL,
            PRIMARY KEY(family_id, activity_id, activity_revision))''');
          await _createV2Tables(db);
          await _createV3Tables(db);
          await _createV4Tables(db);
          await _createV6Tables(db);
          await _createV7Tables(db);
        },
        onUpgrade: (db, oldVersion, newVersion) async {
          if (oldVersion < 2) await _createV2Tables(db);
          if (oldVersion < 3) await _createV3Tables(db);
          if (oldVersion < 4) {
            await _createV4Tables(db);
          } else if (oldVersion < 5) {
            await _createV5LinkOperation(db);
          }
          if (oldVersion < 6) await _createV6Tables(db);
          if (oldVersion < 7) {
            await _createV7Tables(db, retainLegacyOwners: true);
          }
        },
        onDowngrade: (db, oldVersion, newVersion) =>
            throw StateError('本机数据来自更新的应用版本，请先更新应用。'),
      ),
    );
    return LocalStore._(database, factory);
  }

  Future<void> close() => _db.close();

  static Future<void> _createV2Tables(Database db) async {
    await db.execute('''CREATE TABLE growth_records (
      family_id TEXT NOT NULL, child_id TEXT NOT NULL, id TEXT NOT NULL,
      local_date TEXT NOT NULL, body_json TEXT NOT NULL,
      PRIMARY KEY(family_id, child_id, id))''');
    await db.execute('''CREATE INDEX growth_records_date
      ON growth_records(family_id, child_id, local_date DESC)''');
    await db.execute('''CREATE TABLE family_preferences (
      family_id TEXT PRIMARY KEY, body_json TEXT NOT NULL)''');
    await db.execute('''CREATE TABLE play_sessions (
      family_id TEXT NOT NULL, child_id TEXT NOT NULL, id TEXT NOT NULL,
      local_date TEXT NOT NULL, body_json TEXT NOT NULL,
      PRIMARY KEY(family_id, id))''');
  }

  static Future<void> _createV3Tables(Database db) async {
    await db.execute('''CREATE TABLE family_books (
      family_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
      sync_state TEXT NOT NULL, title TEXT NOT NULL, body_json TEXT NOT NULL,
      PRIMARY KEY(family_id, id))''');
    await db.execute('''CREATE INDEX family_books_title
      ON family_books(family_id, title)''');
  }

  static Future<void> _createV4Tables(Database db) async {
    await db.execute('''CREATE TABLE growth_media (
      family_id TEXT NOT NULL, child_id TEXT NOT NULL, memory_id TEXT NOT NULL,
      id TEXT NOT NULL, local_path TEXT NOT NULL, mime TEXT NOT NULL,
      byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL,
      create_operation_id TEXT NOT NULL, complete_operation_id TEXT NOT NULL,
      link_operation_id TEXT NOT NULL,
      server_media_id TEXT, upload_url TEXT, upload_expires_at INTEGER,
      state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(family_id, id),
      FOREIGN KEY(family_id, child_id, memory_id)
        REFERENCES growth_records(family_id, child_id, id)
        ON UPDATE CASCADE ON DELETE CASCADE)''');
    await db.execute('''CREATE INDEX growth_media_memory
      ON growth_media(family_id, memory_id, created_at, id)''');
    await db.execute('''CREATE UNIQUE INDEX growth_media_server_id
      ON growth_media(family_id, server_media_id)
      WHERE server_media_id IS NOT NULL''');
    await db.execute('''CREATE TABLE content_options (
      id TEXT NOT NULL PRIMARY KEY, revision INTEGER NOT NULL,
      body_json TEXT NOT NULL, cached_at INTEGER NOT NULL)''');
  }

  static Future<void> _createV5LinkOperation(Database db) async {
    await db.execute(
      "ALTER TABLE growth_media ADD COLUMN link_operation_id TEXT NOT NULL DEFAULT ''",
    );
    await db.execute(
      "UPDATE growth_media SET link_operation_id = id WHERE link_operation_id = ''",
    );
  }

  static Future<void> _createV6Tables(Database db) async {
    await db.execute(
      'ALTER TABLE growth_records ADD COLUMN remote_deleted INTEGER NOT NULL DEFAULT 0',
    );
    await db.execute(
      'ALTER TABLE day_plans ADD COLUMN remote_deleted INTEGER NOT NULL DEFAULT 0',
    );
    await db.execute('''CREATE TABLE remote_media (
      family_id TEXT NOT NULL, id TEXT NOT NULL, memory_id TEXT,
      revision INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(family_id, id))''');
    await db.execute('''CREATE TABLE participation_tombstones (
      family_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(family_id, id))''');
    await db.execute(
      'CREATE TABLE retired_growth_files (path TEXT PRIMARY KEY)',
    );
    await db.execute('''CREATE TABLE sync_local_writes (
      family_id TEXT PRIMARY KEY, version INTEGER NOT NULL)''');
    await db.execute(
      'ALTER TABLE outbox ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0',
    );
    // 旧版没存创建时间。只把确认未曾发送的操作交给新版自动提交。
    await db.update('outbox', {
      'created_at': DateTime.now().toUtc().millisecondsSinceEpoch,
    }, where: "attempts=0 AND state='pending'");
  }

  Future<void> cachePlan(String familyId, DayPlan plan) =>
      _db.transaction((txn) => _applyRemoteDay(txn, familyId, plan));

  Future<DayPlan?> readPlan(
    String familyId,
    String childId,
    FamilyDate date,
  ) async {
    final rows = await _db.query(
      'day_plans',
      where: 'family_id = ? AND child_id = ? AND local_date = ? AND remote_deleted=0',
      whereArgs: [familyId, childId, date.toString()],
    );
    return rows.isEmpty
        ? null
        : DayPlan.fromJson(_json(rows.first['body_json']));
  }

  Future<Map<String, LocalParticipation>> readParticipations(
    String familyId,
  ) async {
    final rows = await _db.query(
      'participations',
      where: 'family_id = ?',
      whereArgs: [familyId],
    );
    return {
      for (final row in rows) row['item_id'] as String: _participation(row),
    };
  }

  Future<String> saveParticipation({
    required String familyId,
    required String actorId,
    required String itemId,
    required ParticipationInput input,
    required DateTime now,
  }) async {
    input.validate();
    return _db.transaction((txn) async {
      final items = await txn.rawQuery(
        '''SELECT i.body_json, p.local_date, p.timezone
        FROM plan_items i JOIN day_plans p ON p.family_id=i.family_id AND p.id=i.day_id
        WHERE i.family_id=? AND i.id=?''',
        [familyId, itemId],
      );
      if (items.isEmpty) throw StateError('这个安排尚未下载到本机。');
      final item = PlanItem.fromJson(_json(items.first['body_json']));
      final date = FamilyDate.parse(items.first['local_date'] as String);
      final today = FamilyDate.at(now, items.first['timezone'] as String);
      if (date.compareTo(today) > 0) throw StateError('未来的安排只能预览。');
      final withdrawal = await txn.query(
        'withdrawals',
        where: 'family_id=? AND activity_id=? AND activity_revision=?',
        whereArgs: [familyId, item.activity.id, item.activity.revision],
      );
      if (item.blocked || withdrawal.isNotEmpty) {
        throw StateError('这个玩法已停止推荐，请换一个。');
      }
      final old = await txn.query(
        'participations',
        where: 'family_id=? AND item_id=?',
        whereArgs: [familyId, itemId],
      );
      final serverRevision = old.isEmpty
          ? 0
          : old.first['server_revision'] as int;
      final localVersion = old.isEmpty
          ? 1
          : (old.first['local_version'] as int) + 1;
      final objectKey = 'participation:$itemId';
      // 只有从未发送的操作可以合并编辑；一旦尝试发送，请求体和 ID 必须保持不变。
      final unsent = await txn.query(
        'outbox',
        where:
            "family_id=? AND object_key=? AND state='pending' AND attempts=0",
        whereArgs: [familyId, objectKey],
        orderBy: 'sequence DESC',
        limit: 1,
      );
      final operationId = unsent.isEmpty
          ? const Uuid().v4()
          : unsent.first['operation_id'] as String;
      final request = input.body(operationId, serverRevision);
      final payload = {
        ...request,
        'planItemId': itemId,
        'addedBy': actorId,
        'localDate': date.toString(),
      };
      final local = {
        'family_id': familyId,
        'item_id': itemId,
        'body_json': jsonEncode(payload),
        'server_revision': serverRevision,
        'local_version': localVersion,
        'sync_state': 'local_pending',
      };
      if (old.isEmpty) {
        await txn.insert('participations', local);
      } else {
        await txn.update(
          'participations',
          local,
          where: 'family_id=? AND item_id=?',
          whereArgs: [familyId, itemId],
        );
      }
      if (unsent.isEmpty) {
        await txn.insert('outbox', {
          'created_at': now.toUtc().millisecondsSinceEpoch,
          'operation_id': operationId,
          'family_id': familyId,
          'object_key': objectKey,
          'method': 'PUT',
          'path': '/plan-items/$itemId/participation',
          'body_json': jsonEncode(request),
          'local_version': localVersion,
          'state': 'pending',
        });
      } else {
        await txn.update(
          'outbox',
          {'body_json': jsonEncode(request), 'local_version': localVersion},
          where: 'operation_id=?',
          whereArgs: [operationId],
        );
      }
      await txn.delete(
        'drafts',
        where: 'family_id=? AND owner_id=? AND draft_key=?',
        whereArgs: [familyId, actorId, 'participation:$itemId'],
      );
      return operationId;
    });
  }

  /// 撤销只作用于共享参与摘要；已经发出的请求用 DELETE 排在原请求之后。
  Future<void> undoParticipation({
    required String familyId,
    required String itemId,
    required DateTime now,
  }) async {
    await _db.transaction((txn) async {
      final rows = await txn.rawQuery(
        '''SELECT i.body_json, p.local_date, p.timezone
        FROM plan_items i JOIN day_plans p ON p.family_id=i.family_id AND p.id=i.day_id
        WHERE i.family_id=? AND i.id=?''',
        [familyId, itemId],
      );
      if (rows.isEmpty) throw StateError('这个安排尚未下载到本机。');
      final date = FamilyDate.parse(rows.first['local_date'] as String);
      final today = FamilyDate.at(now, rows.first['timezone'] as String);
      if (date.compareTo(today) > 0) throw StateError('未来的安排只能预览。');
      final local = await txn.query(
        'participations',
        where: 'family_id=? AND item_id=?',
        whereArgs: [familyId, itemId],
      );
      if (local.isEmpty) return;
      final objectKey = 'participation:$itemId';
      final unsent = await txn.query(
        'outbox',
        where:
            "family_id=? AND object_key=? AND state='pending' AND attempts=0",
        whereArgs: [familyId, objectKey],
        orderBy: 'sequence DESC',
      );
      final serverRevision = local.single['server_revision'] as int;
      if (unsent.isNotEmpty && serverRevision == 0) {
        await txn.delete(
          'outbox',
          where:
              "family_id=? AND object_key=? AND state='pending' AND attempts=0",
          whereArgs: [familyId, objectKey],
        );
        await txn.delete(
          'participations',
          where: 'family_id=? AND item_id=?',
          whereArgs: [familyId, itemId],
        );
        return;
      }
      if (unsent.isNotEmpty) {
        await txn.delete(
          'outbox',
          where:
              "family_id=? AND object_key=? AND state='pending' AND attempts=0",
          whereArgs: [familyId, objectKey],
        );
      }
      final operationId = const Uuid().v4();
      await txn.insert('outbox', {
        'created_at': now.toUtc().millisecondsSinceEpoch,
        'operation_id': operationId,
        'family_id': familyId,
        'object_key': objectKey,
        'method': 'DELETE',
        'path': '/plan-items/$itemId/participation',
        'body_json': jsonEncode({
          'operationId': operationId,
          'baseRevision': serverRevision,
        }),
        'local_version': (local.single['local_version'] as int) + 1,
        'state': 'pending',
      });
      await txn.delete(
        'participations',
        where: 'family_id=? AND item_id=?',
        whereArgs: [familyId, itemId],
      );
    });
  }

  Future<DayPlan> updatePlanMode({
    required String familyId,
    required String planId,
    required String mode,
    required DateTime now,
  }) async {
    if (mode != 'standard' && mode != 'lite') {
      throw const FormatException('轻松一天选项无效。');
    }
    return _db.transaction((txn) async {
      final rows = await txn.query(
        'day_plans',
        where: 'family_id=? AND id=?',
        whereArgs: [familyId, planId],
      );
      if (rows.isEmpty) throw StateError('今天的安排还没有保存到本机。');
      final oldBody = _json(rows.single['body_json']);
      final revision = oldBody['revision'] as int;
      final newRevision = revision + 1;
      final items = (oldBody['items'] as List)
          .map((item) => Map<String, dynamic>.from(item as Map))
          .toList(growable: false);
      const standardMinutes = {
        'movement': 15,
        'explore': 10,
        'reading': 10,
        'english': 10,
        'child-led': 5,
        'calm': 10,
      };
      const liteKinds = {'movement', 'explore', 'reading', 'english'};
      final history = await txn.rawQuery(
        '''
        SELECT p.item_id FROM participations p
          JOIN plan_items i ON i.family_id=p.family_id AND i.id=p.item_id
          WHERE i.family_id=? AND i.day_id=?
      ''',
        [familyId, planId],
      );
      final sessions = await txn.query(
        'play_sessions',
        columns: ['body_json'],
        where: 'family_id=? AND local_date=?',
        whereArgs: [familyId, oldBody['localDate']],
      );
      final recorded = {
        for (final row in history) row['item_id'],
        for (final row in sessions) _json(row['body_json'])['planItemId'],
      };
      for (final item in items) {
        if (item['startedAt'] != null ||
            item['lockedByParent'] == true ||
            recorded.contains(item['id']) ||
            item['participation'] != null) {
          continue;
        }
        final kind = item['kind'] as String;
        final base =
            (item['_localStandardMinutes'] as int?) ??
            (oldBody['mode'] == 'standard'
                ? item['budgetMinutes'] as int
                : standardMinutes[kind] ?? 5);
        final show = mode != 'lite' || liteKinds.contains(kind);
        item['_localStandardMinutes'] = base;
        item['visibility'] = show ? 'active' : 'hidden';
        item['budgetMinutes'] = mode == 'lite' && show ? 5 : base;
      }
      final visible = items.where((item) => item['visibility'] != 'hidden');
      final visibleKinds = visible.map((item) => item['kind']).toSet();
      final updated = Map<String, dynamic>.from(oldBody)
        ..['mode'] = mode
        ..['revision'] = newRevision
        ..['items'] = items
        ..['missingSlots'] = standardMinutes.keys
            .where((kind) => !visibleKinds.contains(kind))
            .toList()
        ..['effectiveBudgetMinutes'] = visible.fold<int>(
          0,
          (sum, item) => sum + (item['budgetMinutes'] as int),
        );
      await txn.update(
        'day_plans',
        {'revision': newRevision, 'body_json': jsonEncode(updated)},
        where: 'family_id=? AND id=?',
        whereArgs: [familyId, planId],
      );
      for (final item in items) {
        await txn.update(
          'plan_items',
          {'body_json': jsonEncode(item)},
          where: 'family_id=? AND day_id=? AND id=?',
          whereArgs: [familyId, planId, item['id']],
        );
      }
      final objectKey = 'day_mode:$planId';
      final unsent = await txn.query(
        'outbox',
        where:
            "family_id=? AND object_key=? AND state='pending' AND attempts=0",
        whereArgs: [familyId, objectKey],
        limit: 1,
      );
      final operationId = unsent.isEmpty
          ? const Uuid().v4()
          : unsent.single['operation_id'] as String;
      final baseRevision = unsent.isEmpty
          ? revision
          : (_json(unsent.single['body_json'])['baseRevision'] as int);
      final body = {
        'operationId': operationId,
        'baseRevision': baseRevision,
        'mode': mode,
      };
      if (unsent.isEmpty) {
        await txn.insert('outbox', {
          'created_at': now.toUtc().millisecondsSinceEpoch,
          'operation_id': operationId,
          'family_id': familyId,
          'object_key': objectKey,
          'method': 'PUT',
          'path': '/days/$planId/mode',
          'body_json': jsonEncode(body),
          'local_version': newRevision,
          'state': 'pending',
        });
      } else {
        await txn.update(
          'outbox',
          {
            'body_json': jsonEncode(body),
            'local_version': newRevision,
            'retry_after': now.toUtc().millisecondsSinceEpoch,
          },
          where: 'operation_id=?',
          whereArgs: [operationId],
        );
      }
      return DayPlan.fromJson(updated);
    });
  }

  Future<PlanItem> replacePlanItem({
    required String familyId,
    required String childId,
    required String planId,
    required String itemId,
    required Activity activity,
    required DateTime now,
  }) async {
    return _db.transaction((txn) async {
      final plans = await txn.query(
        'day_plans',
        where: 'family_id=? AND child_id=? AND id=?',
        whereArgs: [familyId, childId, planId],
      );
      if (plans.isEmpty) throw StateError('这天的安排还没有下载到本机。');
      final planBody = _json(plans.single['body_json']);
      final localDate = FamilyDate.parse(planBody['localDate'] as String);
      final today = FamilyDate.at(now, planBody['timezone'] as String);
      if (localDate.compareTo(today) > 0) {
        throw StateError('未来安排仅可预览，不能换项。');
      }
      final cached = await txn.query(
        'content_options',
        where: 'id=? AND revision=?',
        whereArgs: [activity.id, activity.revision],
      );
      final withdrawal = await txn.query(
        'withdrawals',
        where: 'family_id=? AND activity_id=? AND activity_revision=?',
        whereArgs: [familyId, activity.id, activity.revision],
      );
      if (cached.isEmpty || activity.withdrawn || withdrawal.isNotEmpty) {
        throw StateError('这个备选活动没有完整缓存，暂不能在当前离线换项。');
      }
      final items = (planBody['items'] as List)
          .map((item) => Map<String, dynamic>.from(item as Map))
          .toList(growable: false);
      final index = items.indexWhere((item) => item['id'] == itemId);
      if (index < 0) throw StateError('这项安排已经变化，请刷新后再试。');
      final old = items[index];
      if (old['startedAt'] != null) {
        throw StateError('这项活动已经开始，不能再替换。');
      }
      final oldItem = PlanItem.fromJson(old);
      final oldWithdrawal = await txn.query(
        'withdrawals',
        where: 'family_id=? AND activity_id=? AND activity_revision=?',
        whereArgs: [familyId, oldItem.activity.id, oldItem.activity.revision],
      );
      if (old['lockedByParent'] == true &&
          !oldItem.blocked &&
          oldWithdrawal.isEmpty) {
        throw StateError('这项活动已保留，不能再替换。');
      }
      final recorded = await txn.query(
        'participations',
        where: 'family_id=? AND item_id=?',
        whereArgs: [familyId, itemId],
      );
      if (recorded.isNotEmpty) {
        throw StateError('这项活动已经有记录，不能再替换。');
      }
      final revision = (old['revision'] as int?) ?? 1;
      final replacement = {
        ...old,
        'snapshot': activity.json,
        'revision': revision + 1,
        'blockedByWithdrawal': activity.withdrawn,
        '_localSyncState': 'local_pending',
      };
      items[index] = replacement;
      final nextPlan = Map<String, dynamic>.from(planBody)..['items'] = items;
      await txn.update(
        'day_plans',
        {'body_json': jsonEncode(nextPlan)},
        where: 'family_id=? AND id=?',
        whereArgs: [familyId, planId],
      );
      await txn.update(
        'plan_items',
        {'revision': revision + 1, 'body_json': jsonEncode(replacement)},
        where: 'family_id=? AND id=?',
        whereArgs: [familyId, itemId],
      );
      final operationId = const Uuid().v4();
      await txn.insert('outbox', {
        'created_at': now.toUtc().millisecondsSinceEpoch,
        'operation_id': operationId,
        'family_id': familyId,
        'object_key': 'replace:$itemId',
        'method': 'POST',
        'path': '/plan-items/$itemId/replace',
        'body_json': jsonEncode({
          'operationId': operationId,
          'baseRevision': revision,
          'activityId': activity.id,
          'activityRevision': activity.revision,
        }),
        'local_version': revision + 1,
        'state': 'pending',
      });
      return PlanItem.fromJson(replacement);
    });
  }

  Future<GrowthRecord> saveGrowthRecord({
    required String familyId,
    required String childId,
    required GrowthRecordType type,
    required FamilyDate localDate,
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
    required DateTime now,
  }) async {
    _validateGrowthRecord(
      type: type,
      text: text,
      value: value,
      unit: unit,
      measurementKind: measurementKind,
      measurementMethod: measurementMethod,
      measurementSource: measurementSource,
      firstConfirmed: firstConfirmed,
      guideId: guideId,
    );
    final record = GrowthRecord(
      id: recordId ?? const Uuid().v4(),
      type: type,
      localDate: localDate,
      text: text.trim(),
      createdAt: now.toUtc(),
      syncState: 'local_pending',
      value: value,
      unit: unit,
      firstConfirmed: firstConfirmed,
      guideId: guideId,
      observationValue: observationValue,
      measurementKind: measurementKind,
      measurementMethod: measurementMethod,
      measurementSource: measurementSource,
    );
    final path = _growthCollectionPath(childId, type);
    final operationId = const Uuid().v4();
    final request = _growthWriteBody(
      operationId: operationId,
      id: record.id,
      type: type,
      localDate: localDate,
      text: text,
      value: value,
      unit: unit,
      measurementKind: measurementKind,
      measurementMethod: measurementMethod,
      measurementSource: measurementSource,
      firstConfirmed: firstConfirmed,
      guideId: guideId,
      observationValue: observationValue,
      mediaIds: const [],
    );
    await _db.transaction((txn) async {
      await txn.insert('growth_records', {
        'family_id': familyId,
        'child_id': childId,
        'id': record.id,
        'local_date': localDate.toString(),
        'body_json': jsonEncode(record.toJson()),
      });
      final linkOperationId = const Uuid().v4();
      for (final photo in photos) {
        final photoId = const Uuid().v4();
        await txn.insert('growth_media', {
          'family_id': familyId,
          'child_id': childId,
          'memory_id': record.id,
          'id': photoId,
          'local_path': photo.localPath,
          'mime': photo.mime,
          'byte_size': photo.byteSize,
          'sha256': photo.sha256,
          'create_operation_id': const Uuid().v4(),
          'complete_operation_id': const Uuid().v4(),
          'link_operation_id': linkOperationId,
          'state': 'pending',
          'attempts': 0,
          'created_at': now.toUtc().millisecondsSinceEpoch,
          'updated_at': now.toUtc().millisecondsSinceEpoch,
        });
      }
      await txn.insert('outbox', {
        'created_at': now.toUtc().millisecondsSinceEpoch,
        'operation_id': operationId,
        'family_id': familyId,
        'object_key': 'growth:${record.id}',
        'method': 'POST',
        'path': path,
        'body_json': jsonEncode(request),
        'local_version': 1,
        'state': 'pending',
      });
    });
    return record;
  }

  /// 正文先入库；照片复制完成后单独登记，避免照片失败连带丢失正文。
  Future<void> attachGrowthPhotos({
    required String familyId,
    required String childId,
    required String memoryId,
    required List<PreparedGrowthPhoto> photos,
    required DateTime now,
  }) async {
    if (photos.length > _maxGrowthPhotosPerRecord) {
      throw const FormatException('一条记录最多保存 5 张照片。');
    }
    if (photos.isEmpty) return;
    await _db.transaction((txn) async {
      final records = await txn.query(
        'growth_records',
        where: 'family_id=? AND child_id=? AND id=?',
        whereArgs: [familyId, childId, memoryId],
      );
      if (records.isEmpty) throw StateError('正文还没有保存在本机。');
      final existing = await txn.query(
        'growth_media',
        where: 'family_id=? AND memory_id=?',
        whereArgs: [familyId, memoryId],
      );
      if (existing.length + photos.length > _maxGrowthPhotosPerRecord) {
        throw const FormatException('一条记录最多保存 5 张照片。');
      }
      final seen = {
        for (final row in existing) '${row['sha256']}:${row['byte_size']}',
      };
      final linkOperationId = const Uuid().v4();
      for (final photo in photos) {
        if (!seen.add('${photo.sha256}:${photo.byteSize}')) continue;
        await txn.insert('growth_media', {
          'family_id': familyId,
          'child_id': childId,
          'memory_id': memoryId,
          'id': const Uuid().v4(),
          'local_path': photo.localPath,
          'mime': photo.mime,
          'byte_size': photo.byteSize,
          'sha256': photo.sha256,
          'create_operation_id': const Uuid().v4(),
          'complete_operation_id': const Uuid().v4(),
          'link_operation_id': linkOperationId,
          'state': 'pending',
          'attempts': 0,
          'created_at': now.toUtc().millisecondsSinceEpoch,
          'updated_at': now.toUtc().millisecondsSinceEpoch,
        });
      }
    });
  }

  Future<List<GrowthRecord>> readGrowthRecords(
    String familyId,
    String childId,
  ) async {
    final rows = await _db.query(
      'growth_records',
      where: 'family_id=? AND child_id=? AND remote_deleted=0',
      whereArgs: [familyId, childId],
      orderBy: 'local_date DESC',
    );
    return rows
        .map((row) => GrowthRecord.fromJson(_json(row['body_json'])))
        .toList(growable: false);
  }

  Future<List<GrowthRecord>> readDeletedGrowthRecords(
    String familyId,
    String childId,
  ) => _db.transaction((txn) async {
    final rows = await txn.query(
      'growth_records',
      where: 'family_id=? AND child_id=? AND remote_deleted=1',
      whereArgs: [familyId, childId],
      orderBy: 'local_date DESC',
    );
    final deleted = <GrowthRecord>[];
    for (final row in rows) {
      final body = _json(row['body_json']);
      if (body['deletedAt'] == null) {
        // v6 只记录了墓碑标记。旧库升级后补一个稳定时间，
        // 让家长仍能在回收站看到并尝试恢复，而不是静默丢失整行。
        body['deletedAt'] = DateTime.now().toUtc().toIso8601String();
        await txn.update(
          'growth_records',
          {'body_json': jsonEncode(body)},
          where: 'family_id=? AND child_id=? AND id=?',
          whereArgs: [familyId, childId, row['id']],
        );
      }
      deleted.add(GrowthRecord.fromJson(body));
    }
    return List<GrowthRecord>.unmodifiable(deleted);
  });

  Future<GrowthRecord?> readGrowthRecord(
    String familyId,
    String childId,
    String recordId,
  ) async {
    final rows = await _db.query(
      'growth_records',
      where: 'family_id=? AND child_id=? AND id=? AND remote_deleted=0',
      whereArgs: [familyId, childId, recordId],
    );
    return rows.isEmpty
        ? null
        : GrowthRecord.fromJson(_json(rows.single['body_json']));
  }

  Future<GrowthRecord> updateGrowthRecord({
    required String familyId,
    required String childId,
    required String recordId,
    required GrowthRecordType type,
    required FamilyDate localDate,
    required String text,
    required bool remote,
    double? value,
    String? unit,
    GrowthMeasurementKind? measurementKind,
    GrowthMeasurementMethod? measurementMethod,
    GrowthMeasurementSource? measurementSource,
    bool firstConfirmed = false,
    String? guideId,
    String? observationValue,
    required DateTime now,
  }) async {
    _validateGrowthRecord(
      type: type,
      text: text,
      value: value,
      unit: unit,
      measurementKind: measurementKind,
      measurementMethod: measurementMethod,
      measurementSource: measurementSource,
      firstConfirmed: firstConfirmed,
      guideId: guideId,
    );
    final current = await readGrowthRecord(familyId, childId, recordId);
    if (current == null) throw StateError('这条成长记录已经不在当前列表。');
    if (current.type != type) {
      throw const FormatException('更正时不能改变记录所属的成长类型。');
    }
    final next = GrowthRecord(
      id: current.id,
      type: type,
      localDate: localDate,
      text: text.trim(),
      createdAt: current.createdAt,
      syncState: current.serverRevision > 0 && remote
          ? 'update_pending'
          : 'local_pending',
      value: value,
      unit: unit,
      firstConfirmed: firstConfirmed,
      guideId: guideId,
      observationValue: observationValue,
      measurementKind: measurementKind,
      measurementMethod: measurementMethod,
      measurementSource: measurementSource,
      serverRevision: current.serverRevision,
      mediaIds: current.mediaIds,
    );
    final operationId = const Uuid().v4();
    final request = _growthWriteBody(
      operationId: operationId,
      type: type,
      localDate: localDate,
      text: text,
      value: value,
      unit: unit,
      measurementKind: measurementKind,
      measurementMethod: measurementMethod,
      measurementSource: measurementSource,
      firstConfirmed: firstConfirmed,
      guideId: guideId,
      observationValue: observationValue,
      mediaIds: current.mediaIds,
    );
    await _db.transaction((txn) async {
      await txn.update(
        'growth_records',
        {
          'local_date': localDate.toString(),
          'body_json': jsonEncode(next.toJson()),
          'remote_deleted': 0,
        },
        where: 'family_id=? AND child_id=? AND id=?',
        whereArgs: [familyId, childId, recordId],
      );
      await _bumpFamilyWriteVersion(txn, familyId);
      if (!remote) return;
      if (current.serverRevision > 0) {
        await txn.insert('outbox', {
          'created_at': now.toUtc().millisecondsSinceEpoch,
          'operation_id': operationId,
          'family_id': familyId,
          'object_key': 'growth-update:$recordId',
          'method': 'PATCH',
          'path': _growthItemPath(type, recordId),
          'body_json': jsonEncode({
            ...request,
            'baseRevision': current.serverRevision,
          }),
          'local_version': current.serverRevision + 1,
          'state': 'pending',
        });
        return;
      }
      final pending = await txn.query(
        'outbox',
        where: "family_id=? AND object_key=? AND state<>'acked'",
        whereArgs: [familyId, 'growth:${current.id}'],
        orderBy: 'sequence',
      );
      if (pending.length == 1) {
        if (pending.single['state'] != 'pending' ||
            (pending.single['attempts'] as int) > 0) {
          throw StateError('这条记录正在同步。请稍后再更正。');
        }
        await txn.update(
          'outbox',
          {
            'path': _growthCollectionPath(childId, type),
            'body_json': jsonEncode(request),
          },
          where: 'operation_id=?',
          whereArgs: [pending.single['operation_id']],
        );
      } else if (pending.isEmpty) {
        await txn.insert('outbox', {
          'created_at': now.toUtc().millisecondsSinceEpoch,
          'operation_id': operationId,
          'family_id': familyId,
          'object_key': 'growth:${current.id}',
          'method': 'POST',
          'path': _growthCollectionPath(childId, type),
          'body_json': jsonEncode({...request, 'id': current.id}),
          'local_version': 1,
          'state': 'pending',
        });
      } else {
        throw StateError('这条记录有多条未确认操作，请先处理同步问题。');
      }
    });
    return next;
  }

  Future<void> deleteGrowthRecord({
    required String familyId,
    required String childId,
    required GrowthRecord record,
    required bool remote,
    required DateTime now,
  }) async {
    final deletedAt = now.toUtc();
    final operationId = const Uuid().v4();
    await _db.transaction((txn) async {
      if (remote && record.serverRevision == 0) {
        final pending = await txn.query(
          'outbox',
          where:
              "family_id=? AND object_key=? AND state<>'acked' AND attempts=0",
          whereArgs: [familyId, 'growth:${record.id}'],
        );
        if (pending.isEmpty) {
          throw StateError('这条记录正在确认保存。请同步完成后再移到回收站。');
        }
        await txn.delete(
          'outbox',
          where: 'operation_id=?',
          whereArgs: [pending.single['operation_id']],
        );
      }
      await txn.update(
        'growth_records',
        {
          'remote_deleted': 1,
          'body_json': jsonEncode({
            ...record.toJson(),
            'deletedAt': deletedAt.toIso8601String(),
          }),
        },
        where: 'family_id=? AND child_id=? AND id=?',
        whereArgs: [familyId, childId, record.id],
      );
      if (remote && record.serverRevision > 0) {
        await txn.insert('outbox', {
          'created_at': now.toUtc().millisecondsSinceEpoch,
          'operation_id': operationId,
          'family_id': familyId,
          'object_key': 'growth-delete:${record.id}',
          'method': 'DELETE',
          'path': _growthItemPath(record.type, record.id),
          'body_json': jsonEncode({
            'operationId': operationId,
            'baseRevision': record.serverRevision,
            if (record.type != GrowthRecordType.measurement &&
                record.type != GrowthRecordType.observation)
              'permanent': false,
          }),
          'local_version': record.serverRevision + 1,
          'state': 'pending',
        });
      }
      await _bumpFamilyWriteVersion(txn, familyId);
    });
  }

  Future<void> restoreGrowthRecord({
    required String familyId,
    required String childId,
    required GrowthRecord record,
    required bool remote,
    required DateTime now,
  }) async {
    final operationId = const Uuid().v4();
    await _db.transaction((txn) async {
      await txn.update(
        'growth_records',
        {
          'remote_deleted': 0,
          'body_json': jsonEncode({
            ...record.toJson(),
            'deletedAt': null,
            'syncState': remote && record.serverRevision > 0
                ? 'restore_pending'
                : 'local_pending',
          }),
        },
        where: 'family_id=? AND child_id=? AND id=?',
        whereArgs: [familyId, childId, record.id],
      );
      if (remote && record.serverRevision > 0) {
        await txn.insert('outbox', {
          'created_at': now.toUtc().millisecondsSinceEpoch,
          'operation_id': operationId,
          'family_id': familyId,
          'object_key': 'growth-restore:${record.id}',
          'method': 'POST',
          'path': '${_growthItemPath(record.type, record.id)}/restore',
          'body_json': jsonEncode({
            'operationId': operationId,
            'baseRevision': record.serverRevision,
          }),
          'local_version': record.serverRevision + 1,
          'state': 'pending',
        });
      } else if (remote) {
        await txn.insert('outbox', {
          'created_at': now.toUtc().millisecondsSinceEpoch,
          'operation_id': operationId,
          'family_id': familyId,
          'object_key': 'growth:${record.id}',
          'method': 'POST',
          'path': _growthCollectionPath(childId, record.type),
          'body_json': jsonEncode(
            _growthWriteBody(
              operationId: operationId,
              id: record.id,
              type: record.type,
              localDate: record.localDate,
              text: record.text,
              value: record.value,
              unit: record.unit,
              measurementKind: record.measurementKind,
              measurementMethod: record.measurementMethod,
              measurementSource: record.measurementSource,
              firstConfirmed: record.firstConfirmed,
              guideId: record.guideId,
              observationValue: record.observationValue,
              mediaIds: record.mediaIds,
            ),
          ),
          'local_version': 1,
          'state': 'pending',
        });
      }
      await _bumpFamilyWriteVersion(txn, familyId);
    });
  }

  Future<void> saveGrowthRecordBody(
    String familyId,
    String childId,
    GrowthRecord record,
  ) => _db.transaction((txn) async {
    final args = [familyId, childId, record.id];
    final previous = (await txn.query(
      'growth_records',
      where: 'family_id=? AND child_id=? AND id=? AND remote_deleted=0',
      whereArgs: args,
    )).firstOrNull;
    if (previous == null) return;
    final current = GrowthRecord.fromJson(_json(previous['body_json']));
    if (current.serverRevision > record.serverRevision ||
        current.syncState != 'synced') {
      return;
    }
    final next = record.toJson();
    final mediaTombstones = await txn.query(
      'remote_media',
      columns: ['id'],
      where: 'family_id=? AND deleted=1',
      whereArgs: [familyId],
    );
    final removed = {for (final row in mediaTombstones) row['id']};
    next['mediaIds'] = record.mediaIds
        .where((id) => !removed.contains(id))
        .toList();
    await txn.update(
      'growth_records',
      {
        'local_date': record.localDate.toString(),
        'body_json': jsonEncode(next),
      },
      where: 'family_id=? AND child_id=? AND id=?',
      whereArgs: args,
    );
    await _bumpFamilyWriteVersion(txn, familyId);
  });

  Future<List<GrowthPhotoUpload>> readGrowthPhotos(
    String familyId, {
    String? memoryId,
  }) async {
    final rows = await _db.query(
      'growth_media',
      where: memoryId == null ? 'family_id=?' : 'family_id=? AND memory_id=?',
      whereArgs: memoryId == null ? [familyId] : [familyId, memoryId],
      orderBy: 'created_at, id',
    );
    return rows.map(_growthPhoto).toList(growable: false);
  }

  Future<void> updateGrowthPhoto(GrowthPhotoUpload photo) => _db.update(
    'growth_media',
    {
      'server_media_id': photo.serverMediaId,
      'upload_url': photo.uploadUrl,
      'upload_expires_at': photo.uploadExpiresAt
          ?.toUtc()
          .millisecondsSinceEpoch,
      'state': photo.state,
      'attempts': photo.attempts,
      'error_code': photo.errorCode,
      'updated_at': photo.updatedAt.toUtc().millisecondsSinceEpoch,
    },
    where: 'id=?',
    whereArgs: [photo.id],
  );

  Future<void> markGrowthPhotoRemoved(String familyId, String photoId) =>
      _db.update(
        'growth_media',
        {
          'state': 'removed',
          'error_code': null,
          'updated_at': DateTime.now().toUtc().millisecondsSinceEpoch,
        },
        where: 'family_id=? AND id=?',
        whereArgs: [familyId, photoId],
      );

  Future<void> resetGrowthPhotoForRetry(
    String familyId,
    String photoId,
    DateTime now,
  ) async {
    final rows = await _db.query(
      'growth_media',
      where: 'family_id=? AND id=?',
      whereArgs: [familyId, photoId],
    );
    if (rows.isEmpty || rows.single['state'] == 'linked') {
      throw StateError('这张照片当前不能重新上传。');
    }
    await _db.update(
      'growth_media',
      {
        'create_operation_id': const Uuid().v4(),
        'complete_operation_id': const Uuid().v4(),
        'link_operation_id': const Uuid().v4(),
        'server_media_id': null,
        'upload_url': null,
        'upload_expires_at': null,
        'state': 'pending',
        'attempts': 0,
        'error_code': null,
        'updated_at': now.toUtc().millisecondsSinceEpoch,
      },
      where: 'family_id=? AND id=?',
      whereArgs: [familyId, photoId],
    );
  }

  Future<void> cacheRemoteGrowthSnapshot({
    required String familyId,
    required String childId,
    required List<Json> memories,
    required List<Json> measurements,
    required List<Json> observations,
  }) => _db.transaction(
    (txn) => _replaceGrowth(
      txn,
      familyId,
      memories,
      measurements,
      observations,
      childId: childId,
    ),
  );

  Future<void> cacheContentOptions(List<Activity> activities) async {
    await _db.transaction((txn) async {
      await txn.delete('content_options');
      for (final activity in activities) {
        await txn.insert('content_options', {
          'id': activity.id,
          'revision': activity.revision,
          'body_json': jsonEncode(activity.json),
          'cached_at': DateTime.now().toUtc().millisecondsSinceEpoch,
        });
      }
    });
  }

  Future<void> cacheContentSafety(
    String familyId,
    ContentSafetyData data,
  ) async {
    await _db.transaction((txn) async {
      for (final entry in data.withdrawals) {
        await txn.insert('withdrawals', {
          'family_id': familyId,
          'activity_id': entry['activityId'] as String,
          'activity_revision': entry['revision'] as int,
          'reason': entry['reason'] as String,
        }, conflictAlgorithm: ConflictAlgorithm.replace);
      }
      await txn.delete('content_options');
      for (final activity in data.activities) {
        await txn.insert('content_options', {
          'id': activity.id,
          'revision': activity.revision,
          'body_json': jsonEncode(activity.json),
          'cached_at': DateTime.now().toUtc().millisecondsSinceEpoch,
        });
      }
    });
  }

  Future<Map<(String, int), String>> readWithdrawals(String familyId) async {
    final rows = await _db.query(
      'withdrawals',
      where: 'family_id=?',
      whereArgs: [familyId],
    );
    return {
      for (final row in rows)
        (row['activity_id'] as String, row['activity_revision'] as int):
            row['reason'] as String,
    };
  }

  Future<List<Activity>> readContentOptions() async {
    final rows = await _db.query('content_options', orderBy: 'id');
    return rows
        .map((row) => Activity.fromJson(_json(row['body_json'])))
        .toList(growable: false);
  }

  Future<FamilyBook> saveFamilyBook({
    required String familyId,
    required String title,
    required String language,
    required String note,
    DateTime? now,
  }) async {
    final cleanTitle = title.trim();
    if (cleanTitle.isEmpty) throw const FormatException('请先填写书名。');
    final id = const Uuid().v4();
    final operationId = const Uuid().v4();
    final book = FamilyBook(
      id: id,
      familyId: familyId,
      title: cleanTitle,
      editionStatus: 'unverified',
      language: language,
      note: note.trim(),
      revision: 0,
      syncState: 'local_pending',
    );
    await _db.transaction((txn) async {
      await txn.insert('family_books', {
        'family_id': familyId,
        'id': id,
        'revision': 0,
        'sync_state': 'local_pending',
        'title': cleanTitle,
        'body_json': jsonEncode(book.toJson()),
      });
      await txn.insert('outbox', {
        'created_at': (now ?? DateTime.now()).toUtc().millisecondsSinceEpoch,
        'operation_id': operationId,
        'family_id': familyId,
        'object_key': 'book:$id',
        'method': 'POST',
        'path': '/families/$familyId/books',
        'body_json': jsonEncode({
          'operationId': operationId,
          'title': cleanTitle,
          'editionId': null,
          'language': language,
          'note': note.trim(),
        }),
        'local_version': 1,
        'state': 'pending',
      });
    });
    return book;
  }

  Future<List<FamilyBook>> readFamilyBooks(String familyId) async {
    final rows = await _db.query(
      'family_books',
      where: 'family_id=?',
      whereArgs: [familyId],
      orderBy: 'title COLLATE NOCASE, id',
    );
    return rows
        .map((row) => FamilyBook.fromJson(_json(row['body_json'])))
        .toList(growable: false);
  }

  Future<void> cacheFamilyBooks(String familyId, List<FamilyBook> books) =>
      _db.transaction((txn) => _replaceBooks(txn, familyId, books));

  /// 首次登录真实家庭时，把仍在“本机家庭”里的成长小记和书架登记
  /// 连同原始 operationId 一起迁移，避免网络响应丢失后重试出重复记录。
  /// 演示计划的参与记录不会迁移，因为它们并不属于服务端真实计划。
  Future<int> migrateLocalPreviewData({
    required String fromFamilyId,
    required String fromChildId,
    required String toFamilyId,
    required String toChildId,
  }) async {
    if (!fromFamilyId.startsWith('demo-') || fromFamilyId == toFamilyId) {
      return 0;
    }
    return _db.transaction((txn) async {
      final growthRows = await txn.query(
        'growth_records',
        where: 'family_id=? AND child_id=?',
        whereArgs: [fromFamilyId, fromChildId],
      );
      for (final row in growthRows) {
        final id = row['id'] as String;
        final existing = await txn.query(
          'growth_records',
          where: 'family_id=? AND child_id=? AND id=?',
          whereArgs: [toFamilyId, toChildId, id],
        );
        if (existing.isEmpty) {
          await txn.update(
            'growth_records',
            {'family_id': toFamilyId, 'child_id': toChildId},
            where: 'family_id=? AND child_id=? AND id=?',
            whereArgs: [fromFamilyId, fromChildId, id],
          );
        } else {
          await txn.delete(
            'growth_records',
            where: 'family_id=? AND child_id=? AND id=?',
            whereArgs: [fromFamilyId, fromChildId, id],
          );
        }
      }

      final bookRows = await txn.query(
        'family_books',
        where: 'family_id=?',
        whereArgs: [fromFamilyId],
      );
      for (final row in bookRows) {
        if (row['sync_state'] != 'local_pending') continue;
        final body = _json(row['body_json'])
          ..['familyId'] = toFamilyId
          ..['syncState'] = 'local_pending';
        await txn.insert('family_books', {
          ...row,
          'family_id': toFamilyId,
          'body_json': jsonEncode(body),
        }, conflictAlgorithm: ConflictAlgorithm.replace);
        await txn.delete(
          'family_books',
          where: 'family_id=? AND id=? AND sync_state=?',
          whereArgs: [fromFamilyId, row['id'], 'local_pending'],
        );
      }

      final operations = await txn.query(
        'outbox',
        where: "family_id=? AND (object_key LIKE 'growth:%' OR object_key LIKE 'book:%')",
        whereArgs: [fromFamilyId],
      );
      for (final row in operations) {
        final oldPath = row['path'] as String;
        final nextPath = oldPath
            .replaceFirst('/children/$fromChildId/', '/children/$toChildId/')
            .replaceFirst('/families/$fromFamilyId/', '/families/$toFamilyId/');
        await txn.update(
          'outbox',
          {
            'family_id': toFamilyId,
            'path': nextPath,
            'state': row['state'] == 'sending' ? 'failed' : row['state'],
            'retry_after': 0,
          },
          where: 'operation_id=?',
          whereArgs: [row['operation_id']],
        );
      }

      final preferences = await txn.query(
        'family_preferences',
        where: 'family_id=?',
        whereArgs: [fromFamilyId],
      );
      if (preferences.isNotEmpty) {
        final target = await txn.query(
          'family_preferences',
          where: 'family_id=?',
          whereArgs: [toFamilyId],
        );
        if (target.isEmpty) {
          await txn.update(
            'family_preferences',
            {'family_id': toFamilyId},
            where: 'family_id=?',
            whereArgs: [fromFamilyId],
          );
        }
      }
      return operations.length;
    });
  }

  Future<void> savePreferences(
    String familyId,
    FamilyPreferences preferences,
  ) => _db.insert('family_preferences', {
    'family_id': familyId,
    'body_json': jsonEncode(preferences.toJson()),
  }, conflictAlgorithm: ConflictAlgorithm.replace);

  Future<FamilyPreferences> readPreferences(String familyId) async {
    final rows = await _db.query(
      'family_preferences',
      where: 'family_id=?',
      whereArgs: [familyId],
    );
    return rows.isEmpty
        ? const FamilyPreferences()
        : FamilyPreferences.fromJson(_json(rows.single['body_json']));
  }

  /// 独立“再玩一次”按合同创建 session，并使用 outbox 保留待同步状态。
  Future<String> saveExtraPlay({
    required String familyId,
    required String childId,
    required String actorId,
    required PlanItem item,
    required FamilyDate localDate,
    required List<String> participantIds,
    required String note,
    required DateTime now,
  }) async {
    if (participantIds.isEmpty) {
      throw const FormatException('请选择至少一位陪伴者。');
    }
    final id = const Uuid().v4();
    final operationId = const Uuid().v4();
    final request = {
      'operationId': operationId,
      'id': id,
      'planItemId': item.id,
      'localDate': localDate.toString(),
      'activityId': item.activity.id,
      'activityRevision': item.activity.revision,
      'participantIds': participantIds,
      'note': note,
    };
    final payload = {
      ...request,
      'addedBy': actorId,
      'syncState': 'local_pending',
    };
    await _db.transaction((txn) async {
      await txn.insert('play_sessions', {
        'family_id': familyId,
        'child_id': childId,
        'id': id,
        'local_date': localDate.toString(),
        'body_json': jsonEncode(payload),
      });
      await txn.insert('outbox', {
        'created_at': now.toUtc().millisecondsSinceEpoch,
        'operation_id': operationId,
        'family_id': familyId,
        'object_key': 'play_session:$id',
        'method': 'POST',
        'path': '/children/$childId/sessions',
        'body_json': jsonEncode(request),
        'local_version': 1,
        'state': 'pending',
      });
    });
    return id;
  }

  Future<PendingOperation?> claimNext(
    String familyId,
    DateTime now, {
    Set<String> objectPrefixes = const {},
  }) => _db.transaction((txn) async {
    await txn.rawUpdate(
      '''UPDATE outbox SET state='failed',error_code='OPERATION_EXPIRED'
      WHERE family_id=? AND state IN ('pending','failed') AND (created_at=0 OR created_at<=?)''',
      [
        familyId,
        now.toUtc().subtract(_operationLifetime).millisecondsSinceEpoch,
      ],
    );
    final prefixSql = objectPrefixes.isEmpty
        ? ''
        : ' AND (${objectPrefixes.map((_) => 'o.object_key LIKE ?').join(' OR ')})';
    final arguments = <Object?>[
      familyId,
      now.toUtc().millisecondsSinceEpoch,
      for (final prefix in objectPrefixes) '$prefix%',
    ];
    final rows = await txn.rawQuery('''SELECT o.* FROM outbox o
          WHERE o.family_id=? AND o.state IN ('pending','failed') AND o.retry_after<=?
          AND (o.error_code IS NULL OR o.error_code<>'OPERATION_EXPIRED')
          $prefixSql
          AND NOT EXISTS (SELECT 1 FROM outbox earlier
            WHERE earlier.family_id=o.family_id AND earlier.object_key=o.object_key
              AND earlier.sequence<o.sequence AND earlier.state!='acked')
          ORDER BY o.sequence LIMIT 1''', arguments);
    if (rows.isEmpty) return null;
    final row = rows.first;
    final attempts = (row['attempts'] as int) + 1;
    await txn.update(
      'outbox',
      {'state': 'sending', 'attempts': attempts},
      where: 'operation_id=?',
      whereArgs: [row['operation_id']],
    );
    return PendingOperation(
      id: row['operation_id'] as String,
      familyId: familyId,
      objectKey: row['object_key'] as String,
      method: row['method'] as String,
      path: row['path'] as String,
      body: _json(row['body_json']),
      localVersion: row['local_version'] as int,
      attempts: attempts,
    );
  });

  Future<void> acknowledge(
    String familyId,
    String operationId,
    Json response,
  ) => _db.transaction((txn) async {
    final ops = await txn.query(
      'outbox',
      where: 'family_id=? AND operation_id=?',
      whereArgs: [familyId, operationId],
    );
    if (ops.isEmpty) throw StateError('待同步操作不存在。');
    final operation = ops.first;
    if (operation['state'] == 'acked') return;
    if (operation['state'] != 'sending') throw StateError('操作尚未发送。');
    final objectKey = operation['object_key'] as String;
    if (objectKey == 'preferences:$familyId') {
      final revision = response['revision'] as int;
      if (response['familyId'] != familyId) {
        throw const FormatException('服务返回的偏好不属于当前家庭。');
      }
      final current = await _readPreferenceBody(txn, familyId);
      if (revision >= (current['_serverRevision'] as int? ?? 0)) {
        final next = current['_localVersion'] == operation['local_version']
            ? _preferenceWithRemote(current, response, revision)
            : {...current, '_serverRevision': revision};
        await _writePreferenceBody(txn, familyId, next);
      }
    }
    if (objectKey.startsWith('participation:') &&
        operation['method'] == 'DELETE' &&
        response['id'] is String &&
        response['revision'] is int) {
      await _applyParticipationTombstone(
        txn,
        familyId,
        response['id'] as String,
        response['revision'] as int,
      );
    }
    if (objectKey.startsWith('participation:') &&
        operation['method'] != 'DELETE') {
      final itemId = objectKey.substring('participation:'.length);
      if (response['planItemId'] != itemId || response['revision'] is! int) {
        throw const FormatException('服务返回的记录归属或修订无效。');
      }
      final revision = response['revision'] as int;
      final localRows = await txn.query(
        'participations',
        where: 'family_id=? AND item_id=?',
        whereArgs: [familyId, itemId],
      );
      if (localRows.isNotEmpty) {
        final local = localRows.single;
        if (revision < (local['server_revision'] as int)) {
          throw StateError('服务修订倒退，保留本机记录。');
        }
        final values = <String, Object?>{'server_revision': revision};
        if (local['local_version'] == operation['local_version']) {
          final current = _json(local['body_json']);
          values['body_json'] = jsonEncode({
            ...current,
            ...response,
            'note': current['note'] ?? '',
            'localDate': current['localDate'],
          });
          values['sync_state'] = 'synced';
        }
        await txn.update(
          'participations',
          values,
          where: 'family_id=? AND item_id=?',
          whereArgs: [familyId, itemId],
        );
      }
    }
    if (objectKey.startsWith('day_mode:') &&
        response['id'] == objectKey.substring('day_mode:'.length)) {
      final current = await txn.query(
        'day_plans',
        where: 'family_id=? AND id=?',
        whereArgs: [familyId, response['id']],
      );
      if (current.isNotEmpty &&
          (current.single['revision'] as int) == operation['local_version']) {
        final revision = response['revision'] as int;
        await txn.update(
          'day_plans',
          {'body_json': jsonEncode(response), 'revision': revision},
          where: 'family_id=? AND id=?',
          whereArgs: [familyId, response['id']],
        );
        for (final item in (response['items'] as List).cast<Map>()) {
          final pending = await txn.query(
            'outbox',
            where: "family_id=? AND object_key=? AND state<>'acked'",
            whereArgs: [familyId, "replace:${item['id']}"],
            limit: 1,
          );
          if (pending.isNotEmpty) continue;
          await txn.update(
            'plan_items',
            {'body_json': jsonEncode(item), 'revision': item['revision']},
            where: 'family_id=? AND id=? AND day_id=?',
            whereArgs: [familyId, item['id'], response['id']],
          );
        }
      }
    }
    if (objectKey.startsWith('replace:') && response['id'] is String) {
      final itemId = objectKey.substring('replace:'.length);
      final current = await txn.query(
        'plan_items',
        where: 'family_id=? AND id=?',
        whereArgs: [familyId, itemId],
      );
      if (current.isNotEmpty) {
        final body = Map<String, dynamic>.from(response)
          ..['_localSyncState'] = 'synced';
        await txn.update(
          'plan_items',
          {'revision': response['revision'], 'body_json': jsonEncode(body)},
          where: 'family_id=? AND id=?',
          whereArgs: [familyId, itemId],
        );
        final dayId = current.single['day_id'] as String;
        final days = await txn.query(
          'day_plans',
          where: 'family_id=? AND id=?',
          whereArgs: [familyId, dayId],
        );
        if (days.isNotEmpty) {
          final plan = _json(days.single['body_json']);
          final items = (plan['items'] as List)
              .map((item) => Map<String, dynamic>.from(item as Map))
              .toList(growable: false);
          final index = items.indexWhere((item) => item['id'] == itemId);
          if (index >= 0) {
            items[index] = body;
            plan['items'] = items;
            await txn.update(
              'day_plans',
              {'body_json': jsonEncode(plan)},
              where: 'family_id=? AND id=?',
              whereArgs: [familyId, dayId],
            );
          }
        }
      }
    }
    if (objectKey.startsWith('book:') && response['id'] is String) {
      final localId = objectKey.substring('book:'.length);
      final book = FamilyBook.fromJson({...response, 'syncState': 'synced'});
      if (book.familyId != familyId) {
        throw const FormatException('服务返回的书架归属不一致。');
      }
      await txn.delete(
        'family_books',
        where: 'family_id=? AND id=?',
        whereArgs: [familyId, localId],
      );
      await txn.insert('family_books', {
        'family_id': familyId,
        'id': book.id,
        'revision': book.revision,
        'sync_state': 'synced',
        'title': book.title,
        'body_json': jsonEncode(book.toJson()),
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    }
    if ((objectKey.startsWith('growth-update:') ||
            objectKey.startsWith('growth-restore:')) &&
        response['id'] is String &&
        response['childId'] is String &&
        response['localDate'] is String &&
        response['revision'] is int) {
      final entity = _growthEntityFromRemote(response);
      await _applyAcknowledgedGrowth(txn, familyId, entity, response);
    }
    if (objectKey.startsWith('growth-delete:') &&
        response['id'] is String &&
        response['revision'] is int) {
      final recordId = objectKey.substring('growth-delete:'.length);
      final rows = await txn.query(
        'growth_records',
        where: 'family_id=? AND id=?',
        whereArgs: [familyId, recordId],
      );
      if (rows.isNotEmpty) {
        final body = _json(rows.single['body_json'])
          ..['serverRevision'] = response['revision']
          ..['deletedAt'] =
              (response['deletedAt'] as String?) ??
              DateTime.now().toUtc().toIso8601String();
        await txn.update(
          'growth_records',
          {'remote_deleted': 1, 'body_json': jsonEncode(body)},
          where: 'family_id=? AND id=?',
          whereArgs: [familyId, recordId],
        );
      }
    }
    if (objectKey.startsWith('growth:') && response['id'] is String) {
      final recordId = objectKey.substring('growth:'.length);
      final rows = await txn.query(
        'growth_records',
        where: 'family_id=? AND id=?',
        whereArgs: [familyId, recordId],
      );
      if (rows.isNotEmpty) {
        final previous = _json(rows.single['body_json']);
        final body = previous
          ..['syncState'] = 'synced'
          ..['serverRevision'] = response['revision']
          ..['mediaIds'] = List<String>.from(
            (response['mediaIds'] as List?) ??
                ((previous['mediaIds'] as List?) ?? const <String>[]),
          );
        await txn.update(
          'growth_records',
          {'body_json': jsonEncode(body)},
          where: 'family_id=? AND id=?',
          whereArgs: [familyId, recordId],
        );
      }
    }
    if (objectKey.startsWith('play_session:')) {
      final sessionId = objectKey.substring('play_session:'.length);
      final rows = await txn.query(
        'play_sessions',
        where: 'family_id=? AND id=?',
        whereArgs: [familyId, sessionId],
      );
      if (rows.isNotEmpty) {
        final body = _json(rows.single['body_json'])..['syncState'] = 'synced';
        await txn.update(
          'play_sessions',
          {'body_json': jsonEncode(body)},
          where: 'family_id=? AND id=?',
          whereArgs: [familyId, sessionId],
        );
      }
    }
    await txn.update(
      'outbox',
      {'state': 'acked', 'result_json': jsonEncode(response)},
      where: 'operation_id=?',
      whereArgs: [operationId],
    );
    await _bumpFamilyWriteVersion(txn, familyId);
    // 后续未发送操作继承刚确认的服务修订；已发送请求绝不改写。
    if (response['revision'] is int) {
      final queued = await txn.query(
        'outbox',
        where:
            "family_id=? AND object_key=? AND attempts=0 AND state='pending'",
        whereArgs: [familyId, objectKey],
      );
      for (final row in queued) {
        final body = _json(row['body_json'])
          ..['baseRevision'] = response['revision'];
        await txn.update(
          'outbox',
          {'body_json': jsonEncode(body)},
          where: 'operation_id=?',
          whereArgs: [row['operation_id']],
        );
      }
    }
  });

  Future<void> failOperation(
    String familyId,
    String operationId, {
    required String code,
    required DateTime retryAfter,
    Json? conflict,
  }) => _db.transaction((txn) async {
    final ops = await txn.query(
      'outbox',
      where: "family_id=? AND operation_id=? AND state='sending'",
      whereArgs: [familyId, operationId],
    );
    if (ops.isEmpty) return;
    await txn.update(
      'outbox',
      {
        'state': conflict == null ? 'failed' : 'conflict',
        'error_code': code,
        'result_json': conflict == null ? null : jsonEncode(conflict),
        'retry_after': retryAfter.toUtc().millisecondsSinceEpoch,
      },
      where: 'operation_id=?',
      whereArgs: [operationId],
    );
  });

  Future<void> recoverInterrupted(String familyId) => _db.update(
    'outbox',
    {'state': 'pending'},
    where: "family_id=? AND state='sending'",
    whereArgs: [familyId],
  );

  Future<void> releaseClaim(String familyId, String operationId) =>
      _db.rawUpdate(
        "UPDATE outbox SET state='pending',attempts=MAX(0, attempts-1) WHERE family_id=? AND operation_id=? AND state='sending'",
        [familyId, operationId],
      );

  Future<int> pendingCount(String familyId) async =>
      Sqflite.firstIntValue(
        await _db.rawQuery(
          "SELECT COUNT(*) FROM outbox WHERE family_id=? AND state!='acked'",
          [familyId],
        ),
      ) ??
      0;

  Future<List<SyncIssue>> readSyncIssues(String familyId) async {
    final rows = await _db.query(
      'outbox',
      columns: const [
        'operation_id',
        'object_key',
        'body_json',
        'state',
        'error_code',
        'result_json',
      ],
      where: "family_id=? AND state IN ('failed','conflict')",
      whereArgs: [familyId],
      orderBy: 'sequence',
    );
    return List.unmodifiable(
      rows.map((row) {
        final result = row['result_json'];
        return SyncIssue(
          operationId: row['operation_id'] as String,
          objectKey: row['object_key'] as String,
          state: row['state'] as String,
          code: row['error_code'] as String?,
          body: _json(row['body_json']),
          conflict: result is String ? _json(result) : null,
        );
      }),
    );
  }

  Future<void> retrySyncIssue(String familyId, String operationId) async {
    final count = await _db.update(
      'outbox',
      {
        'state': 'pending',
        'retry_after': 0,
        'error_code': null,
        'result_json': null,
      },
      where: "family_id=? AND operation_id=? AND state='failed' AND (error_code IS NULL OR error_code<>'OPERATION_EXPIRED')",
      whereArgs: [familyId, operationId],
    );
    if (count == 0) throw StateError('这条待同步内容已经处理或状态已变化。');
  }

  /// 冲突决定与原 operationId 分开保存；重试我的版本会生成新请求，
  /// 避免服务端把同一 operationId 的不同请求判成二次冲突。
  Future<void> resolveSyncConflict({
    required String familyId,
    required String actorId,
    required String operationId,
    required SyncConflictResolution resolution,
    required DateTime now,
  }) => _db.transaction((txn) async {
    final rows = await txn.query(
      'outbox',
      where: "family_id=? AND operation_id=? AND state='conflict'",
      whereArgs: [familyId, operationId],
    );
    if (rows.isEmpty) throw StateError('这次冲突已经处理或记录已变化。');
    final operation = rows.single;
    final conflictValue = operation['result_json'];
    if (conflictValue is! String) throw StateError('冲突详情没有保存完整。');
    final conflict = _json(conflictValue);
    final currentValue = conflict['current'];
    final objectKey = operation['object_key'] as String;
    final removedParticipation =
        objectKey.startsWith('participation:') &&
        conflict.containsKey('current') &&
        currentValue == null;
    if (removedParticipation) {
      final itemId = objectKey.substring('participation:'.length);
      final localRow = (await txn.query(
        'participations',
        where: 'family_id=? AND item_id=?',
        whereArgs: [familyId, itemId],
      )).firstOrNull;
      if (resolution == SyncConflictResolution.keepBoth && localRow != null) {
        await _insertPlaySessionCopy(
          txn,
          familyId: familyId,
          actorId: actorId,
          itemId: itemId,
          localPayload: _json(localRow['body_json']),
          now: now,
        );
      }
      if (resolution == SyncConflictResolution.keepLocal &&
          operation['method'] != 'DELETE') {
        final newId = const Uuid().v4();
        final body = _json(operation['body_json'])
          ..['operationId'] = newId
          ..['baseRevision'] = 0;
        final version =
            (localRow?['local_version'] as int? ??
                operation['local_version'] as int) +
            1;
        if (localRow != null) {
          await txn.update(
            'participations',
            {
              'body_json': jsonEncode(
                {
                  ..._json(localRow['body_json']),
                  'operationId': newId,
                  'baseRevision': 0,
                }..remove('id'),
              ),
              'server_revision': 0,
              'local_version': version,
              'sync_state': 'local_pending',
            },
            where: 'family_id=? AND item_id=?',
            whereArgs: [familyId, itemId],
          );
        }
        await _reopenOutboxWithNewOperation(
          txn,
          operation: operation,
          newOperationId: newId,
          body: body,
          localVersion: version,
          now: now,
        );
      } else {
        await txn.delete(
          'participations',
          where: 'family_id=? AND item_id=?',
          whereArgs: [familyId, itemId],
        );
        await txn.update(
          'outbox',
          {
            'state': 'acked',
            'result_json': jsonEncode(conflict),
            'retry_after': 0,
          },
          where: 'operation_id=?',
          whereArgs: [operationId],
        );
      }
      await _bumpFamilyWriteVersion(txn, familyId);
      return;
    }
    if (currentValue is! Map) throw StateError('服务没有返回家庭中的当前版本。');
    final current = Map<String, dynamic>.from(currentValue);
    final remoteRevision = _conflictRevision(conflict, current);
    final participationItemId = objectKey.startsWith('participation:')
        ? objectKey.substring('participation:'.length)
        : null;

    if (participationItemId != null) {
      final localRows = await txn.query(
        'participations',
        where: 'family_id=? AND item_id=?',
        whereArgs: [familyId, participationItemId],
      );
      final localPayload = localRows.isEmpty
          ? <String, dynamic>{}
          : _json(localRows.single['body_json']);
      final localDate =
          localPayload['localDate'] as String? ??
          await _planItemDate(txn, familyId, participationItemId);

      if (resolution == SyncConflictResolution.keepBoth) {
        await _insertPlaySessionCopy(
          txn,
          familyId: familyId,
          actorId: actorId,
          itemId: participationItemId,
          localPayload: localPayload,
          now: now,
        );
      }

      if (resolution != SyncConflictResolution.keepLocal && localDate != null) {
        if (current['planItemId'] != participationItemId) {
          throw const FormatException('服务返回的参与记录不属于当前计划项。');
        }
        final remotePayload = <String, dynamic>{
          ...localPayload,
          ...current,
          'note': _participationNote(current),
          'operationId': current['operationId'] ?? '',
          'localDate': localDate,
        };
        await txn.insert('participations', {
          'family_id': familyId,
          'item_id': participationItemId,
          'body_json': jsonEncode(remotePayload),
          'server_revision': remoteRevision,
          'local_version': localRows.firstOrNull?['local_version'] ?? 0,
          'sync_state': 'synced',
        }, conflictAlgorithm: ConflictAlgorithm.replace);
      }

      if (resolution == SyncConflictResolution.keepLocal) {
        final newOperationId = const Uuid().v4();
        final body = _json(operation['body_json'])
          ..['operationId'] = newOperationId
          ..['baseRevision'] = remoteRevision;
        final localVersion = localRows.isEmpty
            ? (operation['local_version'] as int) + 1
            : (localRows.single['local_version'] as int) + 1;
        if (localRows.isNotEmpty) {
          await txn.update(
            'participations',
            {
              'body_json': jsonEncode({
                ...localPayload,
                'operationId': newOperationId,
                'baseRevision': remoteRevision,
              }),
              'server_revision': remoteRevision,
              'local_version': localVersion,
              'sync_state': 'local_pending',
            },
            where: 'family_id=? AND item_id=?',
            whereArgs: [familyId, participationItemId],
          );
        }
        await _reopenOutboxWithNewOperation(
          txn,
          operation: operation,
          newOperationId: newOperationId,
          body: body,
          localVersion: localVersion,
          now: now,
        );
      } else {
        await txn.update(
          'outbox',
          {
            'state': 'acked',
            'result_json': jsonEncode(current),
            'retry_after': 0,
          },
          where: 'operation_id=?',
          whereArgs: [operationId],
        );
      }
      await _bumpFamilyWriteVersion(txn, familyId);
      return;
    }

    if (resolution == SyncConflictResolution.keepBoth) {
      throw StateError('这类冲突不能另存为一条参与记录。');
    }
    if (objectKey == 'preferences:$familyId') {
      if (current['familyId'] != familyId) {
        throw const FormatException('服务返回的偏好不属于当前家庭。');
      }
      final saved = await _readPreferenceBody(txn, familyId);
      final version = (saved['_localVersion'] as int? ?? 0) + 1;
      final latest = await txn.query(
        'outbox',
        where: "family_id=? AND object_key=? AND state<>'acked' AND sequence>?",
        whereArgs: [familyId, objectKey, operation['sequence']],
        limit: 1,
      );
      final keepCurrent =
          latest.isNotEmpty || resolution == SyncConflictResolution.keepLocal;
      await _writePreferenceBody(
        txn,
        familyId,
        keepCurrent
            ? {
                ...saved,
                '_serverRevision': remoteRevision,
                if (latest.isEmpty) '_localVersion': version,
              }
            : _preferenceWithRemote(saved, current, remoteRevision),
      );
      if (latest.isNotEmpty) {
        final later = latest.single;
        if (later['state'] == 'pending' && later['attempts'] == 0) {
          final next = _json(later['body_json'])
            ..['baseRevision'] = remoteRevision;
          await txn.update(
            'outbox',
            {'body_json': jsonEncode(next)},
            where: 'operation_id=?',
            whereArgs: [later['operation_id']],
          );
        }
      } else if (resolution == SyncConflictResolution.keepLocal) {
        final newId = const Uuid().v4();
        final body = _json(operation['body_json'])
          ..['operationId'] = newId
          ..['baseRevision'] = remoteRevision;
        await _reopenOutboxWithNewOperation(
          txn,
          operation: operation,
          newOperationId: newId,
          body: body,
          localVersion: version,
          now: now,
        );
        await _bumpFamilyWriteVersion(txn, familyId);
        return;
      }
      await _bumpFamilyWriteVersion(txn, familyId);
    } else if (resolution == SyncConflictResolution.keepLocal) {
      final newOperationId = const Uuid().v4();
      final body = _json(operation['body_json'])
        ..['operationId'] = newOperationId
        ..['baseRevision'] = remoteRevision;
      await _reopenOutboxWithNewOperation(
        txn,
        operation: operation,
        newOperationId: newOperationId,
        body: body,
        localVersion: (operation['local_version'] as int) + 1,
        now: now,
      );
      return;
    }
    await txn.update(
      'outbox',
      {'state': 'acked', 'result_json': jsonEncode(current), 'retry_after': 0},
      where: 'operation_id=?',
      whereArgs: [operationId],
    );
    if (resolution == SyncConflictResolution.keepRemote &&
        objectKey.startsWith('day_mode:')) {
      final day = DayPlan.fromJson(current);
      if (objectKey != 'day_mode:${day.id}') {
        throw const FormatException('服务返回的计划不属于当前日期。');
      }
      await _applyRemoteDay(txn, familyId, day, authoritative: true);
      await _bumpFamilyWriteVersion(txn, familyId);
    } else if (resolution == SyncConflictResolution.keepRemote &&
        objectKey.startsWith('replace:')) {
      if (objectKey != 'replace:${current['id']}') {
        throw const FormatException('服务返回的替换项目不一致。');
      }
      await _applyRemoteItemEvent(txn, familyId, current, authoritative: true);
      await _bumpFamilyWriteVersion(txn, familyId);
    }
  });

  Future<void> saveDraft(
    String familyId,
    String actorId,
    String key,
    Json body,
  ) => _db.insert('drafts', {
    'family_id': familyId,
    'owner_id': actorId,
    'draft_key': key,
    'body_json': jsonEncode(body),
  }, conflictAlgorithm: ConflictAlgorithm.replace);

  Future<Json?> readDraft(String familyId, String actorId, String key) async {
    final rows = await _db.query(
      'drafts',
      where: 'family_id=? AND owner_id=? AND draft_key=?',
      whereArgs: [familyId, actorId, key],
    );
    return rows.isEmpty ? null : _json(rows.first['body_json']);
  }

  Future<Json> exportPendingDrafts(String familyId, String ownerId) async {
    final drafts = await _db.query(
      'drafts',
      where: 'family_id=? AND owner_id=?',
      whereArgs: [familyId, ownerId],
      orderBy: 'draft_key',
    );
    final operations = await _db.query(
      'outbox',
      where: "family_id=? AND state<>'acked'",
      whereArgs: [familyId],
      orderBy: 'sequence',
    );
    final growth = await _db.query(
      'growth_records',
      where: 'family_id=? AND remote_deleted=0',
      whereArgs: [familyId],
      orderBy: 'local_date, id',
    );
    final photos = await _db.query(
      'growth_media',
      where: "family_id=? AND state NOT IN ('linked','removed')",
      whereArgs: [familyId],
      orderBy: 'created_at, id',
    );
    return {
      'format': 'babyplan-pending-drafts',
      'formatVersion': 1,
      'familyId': familyId,
      'ownerId': ownerId,
      'drafts': [
        for (final row in drafts)
          {'key': row['draft_key'], 'body': _json(row['body_json'])},
      ],
      'pendingOperations': [
        for (final row in operations)
          {
            'operationId': row['operation_id'],
            'objectKey': row['object_key'],
            'method': row['method'],
            'path': row['path'],
            'state': row['state'],
            'attempts': row['attempts'],
            'body': _json(row['body_json']),
          },
      ],
      'unsyncedGrowth': [
        for (final row in growth)
          if (_json(row['body_json'])['syncState'] != 'synced')
            _json(row['body_json']),
      ],
      'unsyncedPhotos': [
        for (final row in photos)
          {
            'id': row['id'],
            'memoryId': row['memory_id'],
            'localPath': row['local_path'],
            'mime': row['mime'],
            'byteSize': row['byte_size'],
            'sha256': row['sha256'],
            'state': row['state'],
            'errorCode': row['error_code'],
          },
      ],
    };
  }

  Future<void> deleteDraft(String familyId, String actorId, String key) =>
      _db.delete(
        'drafts',
        where: 'family_id=? AND owner_id=? AND draft_key=?',
        whereArgs: [familyId, actorId, key],
      );

  Future<String?> readCursor(String familyId) => _readSyncCursor(_db, familyId);

  Future<void> cacheWithdrawal(
    String familyId,
    String activityId,
    int revision,
    String reason,
  ) => _db.insert('withdrawals', {
    'family_id': familyId,
    'activity_id': activityId,
    'activity_revision': revision,
    'reason': reason,
  }, conflictAlgorithm: ConflictAlgorithm.replace);
  Future<String?> withdrawalReason(String familyId, Activity activity) async {
    final rows = await _db.query(
      'withdrawals',
      where: 'family_id=? AND activity_id=? AND activity_revision=?',
      whereArgs: [familyId, activity.id, activity.revision],
    );
    return rows.isEmpty ? null : rows.single['reason'] as String;
  }

  static int _conflictRevision(Json conflict, Json current) {
    final revision = current['revision'] ?? conflict['currentRevision'];
    if (revision is! int || revision < 1) {
      throw StateError('冲突详情缺少可用的服务修订。');
    }
    return revision;
  }

  static String _participationNote(Json value) {
    final notes = value['notes'];
    if (notes is List && notes.isNotEmpty) {
      final last = notes.last;
      if (last is Map && last['text'] is String) {
        return (last['text'] as String).trim();
      }
    }
    final note = value['note'];
    return note is String ? note.trim() : '';
  }

  static Future<void> _insertPlaySessionCopy(
    Transaction txn, {
    required String familyId,
    required String actorId,
    required String itemId,
    required Json localPayload,
    required DateTime now,
  }) async {
    final rows = await txn.rawQuery(
      '''SELECT i.body_json, p.child_id
      FROM plan_items i JOIN day_plans p
        ON p.family_id=i.family_id AND p.id=i.day_id
      WHERE i.family_id=? AND i.id=?''',
      [familyId, itemId],
    );
    if (rows.isEmpty) throw StateError('这条冲突关联的安排已不在本机。');
    final item = PlanItem.fromJson(_json(rows.single['body_json']));
    final id = const Uuid().v4();
    final operationId = const Uuid().v4();
    final participants = List<String>.from(
      (localPayload['participantIds'] as List?) ?? const <String>[],
    );
    if (participants.isEmpty) {
      throw StateError('这次记录没有陪伴者，不能另存为再玩记录。');
    }
    final request = {
      'operationId': operationId,
      'id': id,
      'planItemId': item.id,
      'localDate': localPayload['localDate'] as String? ?? '',
      'activityId': item.activity.id,
      'activityRevision': item.activity.revision,
      'participantIds': participants,
      'note': localPayload['note'] as String? ?? '',
      'syncState': 'local_pending',
      'addedBy': actorId,
      'createdAt': now.toUtc().toIso8601String(),
    };
    await txn.insert('play_sessions', {
      'family_id': familyId,
      'child_id': rows.single['child_id'] as String,
      'id': id,
      'local_date': localPayload['localDate'] as String? ?? '',
      'body_json': jsonEncode(request),
    });
    await txn.insert('outbox', {
      'created_at': now.toUtc().millisecondsSinceEpoch,
      'operation_id': operationId,
      'family_id': familyId,
      'object_key': 'play_session:$id',
      'method': 'POST',
      'path': '/children/${rows.single['child_id']}/sessions',
      'body_json': jsonEncode(
        Map<String, dynamic>.from(request)
          ..remove('syncState')
          ..remove('addedBy')
          ..remove('createdAt'),
      ),
      'local_version': 1,
      'state': 'pending',
    });
  }

  static Future<void> _reopenOutboxWithNewOperation(
    Transaction txn, {
    required Map<String, Object?> operation,
    required String newOperationId,
    required Json body,
    required int localVersion,
    required DateTime now,
  }) => txn.update(
    'outbox',
    {
      'operation_id': newOperationId,
      'body_json': jsonEncode(body),
      'local_version': localVersion,
      'created_at': now.toUtc().millisecondsSinceEpoch,
      'state': 'pending',
      'attempts': 0,
      'retry_after': 0,
      'error_code': null,
      'result_json': null,
    },
    where: 'operation_id=?',
    whereArgs: [operation['operation_id']],
  );

  static Json _json(Object? value) =>
      Map<String, dynamic>.from(jsonDecode(value as String) as Map);
  static LocalParticipation _participation(Map<String, Object?> row) =>
      LocalParticipation(
        payload: _json(row['body_json']),
        localVersion: row['local_version'] as int,
        serverRevision: row['server_revision'] as int,
        syncState: row['sync_state'] as String,
      );

  static GrowthPhotoUpload _growthPhoto(Map<String, Object?> row) =>
      GrowthPhotoUpload.fromJson({
        'id': row['id'],
        'memoryId': row['memory_id'],
        'localPath': row['local_path'],
        'mime': row['mime'],
        'byteSize': row['byte_size'],
        'sha256': row['sha256'],
        'createOperationId': row['create_operation_id'],
        'completeOperationId': row['complete_operation_id'],
        'linkOperationId': row['link_operation_id'],
        'serverMediaId': row['server_media_id'],
        'uploadUrl': row['upload_url'],
        'uploadExpiresAt': row['upload_expires_at'] == null
            ? null
            : DateTime.fromMillisecondsSinceEpoch(
                row['upload_expires_at'] as int,
                isUtc: true,
              ).toIso8601String(),
        'state': row['state'],
        'attempts': row['attempts'],
        'errorCode': row['error_code'],
        'createdAt': DateTime.fromMillisecondsSinceEpoch(
          row['created_at'] as int,
          isUtc: true,
        ).toIso8601String(),
        'updatedAt': DateTime.fromMillisecondsSinceEpoch(
          row['updated_at'] as int,
          isUtc: true,
        ).toIso8601String(),
      });
}

void _validateGrowthRecord({
  required GrowthRecordType type,
  required String text,
  required double? value,
  required String? unit,
  required GrowthMeasurementKind? measurementKind,
  required GrowthMeasurementMethod? measurementMethod,
  required GrowthMeasurementSource? measurementSource,
  required bool firstConfirmed,
  required String? guideId,
}) {
  if (type != GrowthRecordType.measurement && text.trim().isEmpty) {
    throw const FormatException('请写下这次观察。');
  }
  if (type == GrowthRecordType.measurement) {
    if (value == null ||
        value <= 0 ||
        value > 300 ||
        unit == null ||
        measurementKind == null ||
        measurementMethod == null ||
        measurementSource == null) {
      throw const FormatException('请填写完整的测量数值、方式和来源。');
    }
    final (expectedUnit, validMethod) = switch (measurementKind) {
      GrowthMeasurementKind.height => (
        'cm',
        measurementMethod == GrowthMeasurementMethod.recumbent ||
            measurementMethod == GrowthMeasurementMethod.standing,
      ),
      GrowthMeasurementKind.weight => (
        'kg',
        measurementMethod == GrowthMeasurementMethod.scale,
      ),
    };
    if (unit != expectedUnit || !validMethod) {
      throw const FormatException('测量类型、单位和方式不一致。');
    }
  } else if (value != null ||
      unit != null ||
      measurementKind != null ||
      measurementMethod != null ||
      measurementSource != null) {
    throw const FormatException('只有测量记录可以填写测量资料。');
  }
  if (type == GrowthRecordType.first && !firstConfirmed) {
    throw const FormatException('请确认这确实是宝宝第一次做到。');
  }
  if (type == GrowthRecordType.observation &&
      (guideId == null || guideId.trim().isEmpty)) {
    throw const FormatException('请选择一条阶段观察线索。');
  }
}

String _growthCollectionPath(String childId, GrowthRecordType type) =>
    switch (type) {
      GrowthRecordType.measurement => '/children/$childId/measurements',
      GrowthRecordType.observation => '/children/$childId/observations',
      _ => '/children/$childId/memories',
    };

String _growthItemPath(GrowthRecordType type, String recordId) =>
    switch (type) {
      GrowthRecordType.measurement => '/measurements/$recordId',
      GrowthRecordType.observation => '/observations/$recordId',
      _ => '/memories/$recordId',
    };

String _growthEntityFromRemote(Json remote) {
  if (remote.containsKey('kind') && remote.containsKey('method')) {
    return 'measurement';
  }
  if (remote.containsKey('guideId') && remote.containsKey('note')) {
    return 'observation';
  }
  return 'memory';
}

Json _growthWriteBody({
  required String operationId,
  String? id,
  required GrowthRecordType type,
  required FamilyDate localDate,
  required String text,
  required double? value,
  required String? unit,
  required GrowthMeasurementKind? measurementKind,
  required GrowthMeasurementMethod? measurementMethod,
  required GrowthMeasurementSource? measurementSource,
  required bool firstConfirmed,
  required String? guideId,
  required String? observationValue,
  required List<String> mediaIds,
}) => {
  'operationId': operationId,
  'id': ?id,
  ...switch (type) {
    GrowthRecordType.measurement => {
      'localDate': localDate.toString(),
      'kind': measurementKind!.name,
      'value': value,
      'unit': unit,
      'method': measurementMethod!.name,
      'source': measurementSource!.name,
    },
    GrowthRecordType.observation => {
      'guideId': guideId,
      'localDate': localDate.toString(),
      'value': observationValue ?? 'discuss',
      'note': text.trim(),
    },
    _ => {
      'localDate': localDate.toString(),
      'type': type.name,
      'text': text.trim(),
      'firstConfirmed': type == GrowthRecordType.first && firstConfirmed,
      'mediaIds': mediaIds,
    },
  },
};
