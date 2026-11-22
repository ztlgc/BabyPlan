import 'models.dart';

/// 家庭变更中的完整对象或删除墓碑。
class FamilyChange {
  const FamilyChange({
    required this.sequence,
    required this.entity,
    required this.id,
    required this.revision,
    required this.deleted,
    required this.payload,
  });

  final int sequence;
  final String entity;
  final String id;
  final int revision;
  final bool deleted;
  final Json? payload;
}

class FamilyChangesPage {
  const FamilyChangesPage({
    required this.changes,
    required this.nextCursor,
    required this.hasMore,
  });

  final List<FamilyChange> changes;
  final String nextCursor;
  final bool hasMore;
}
