import 'api_client.dart';
import 'local_store.dart';

/// 游标对客户端不透明。网络读取与本机写入并发时，从最新进度重取一页。
class FamilySyncRepository {
  const FamilySyncRepository({required this.local, required this.service});

  final LocalStore local;
  final BabyPlanApi service;

  Future<void> pull(
    String familyId, {
    required bool Function() isCurrent,
  }) async {
    var cursor = await local.readCursor(familyId);
    var forceSnapshot = cursor == null;
    var restarts = 0;
    var contention = 0;
    var lastSequence = 0;
    final visited = <String>{?cursor};
    while (isCurrent()) {
      final writeVersion = await local.readFamilyWriteVersion(familyId);
      try {
        if (forceSnapshot || cursor == null) {
          final snapshot = await service.readFamilySnapshot(familyId);
          if (!isCurrent()) return;
          if (await local.applyFamilySnapshot(
            familyId: familyId,
            expectedCursor: cursor,
            expectedWriteVersion: writeVersion,
            snapshot: snapshot,
            isCurrent: isCurrent,
          )) {
            return;
          }
        } else {
          final page = await service.readFamilyChanges(
            familyId,
            cursor: cursor,
          );
          if (!isCurrent()) return;
          if (page.changes.isNotEmpty &&
              (page.changes.first.sequence <= lastSequence ||
                  visited.contains(page.nextCursor))) {
            throw const FormatException('同步分页顺序不正确，请重新刷新。');
          }
          if (await local.applyFamilyChanges(
            familyId: familyId,
            expectedCursor: cursor,
            expectedWriteVersion: writeVersion,
            page: page,
            isCurrent: isCurrent,
          )) {
            if (!page.hasMore) return;
            lastSequence = page.changes.last.sequence;
            cursor = page.nextCursor;
            visited.add(cursor);
            contention = 0;
            continue;
          }
        }
      } on FamilySyncCancelled {
        return;
      } on ApiException catch (error) {
        if (!isCurrent()) return;
        if (forceSnapshot ||
            error.statusCode != 410 ||
            error.code != 'CURSOR_EXPIRED' ||
            restarts++ > 0) {
          rethrow;
        }
        forceSnapshot = true;
        continue;
      }
      if (!isCurrent()) return;
      if (++contention >= 4) throw StateError('本机仍在保存内容，稍后会重新同步。');
      final latest = await local.readCursor(familyId);
      if (latest != cursor) {
        cursor = latest;
        forceSnapshot = cursor == null;
        lastSequence = 0;
        visited.clear();
        if (cursor != null) visited.add(cursor);
      }
    }
  }
}
