import 'dart:convert';

import '../core/family_date.dart';
import 'generated_content.dart';
import 'models.dart';

/// 离线内容来自唯一 v2 候选包的构建产物。
/// 候选卡保持 draft 状态，界面必须明确显示“待人工审读”，不能冒充已发布内容。
class DemoContent {
  const DemoContent._();

  static final Map<String, dynamic> package = Map<String, dynamic>.from(
    jsonDecode(babyplanCandidatePackageJson) as Map,
  );

  static final Map<String, Map<String, dynamic>> _cardsById = {
    for (final item in package['cards'] as List)
      (item as Map)['id'] as String: Map<String, dynamic>.from(item),
  };

  static final List<Activity> discoveryActivities = List.unmodifiable(
    (package['cards'] as List).map(
      (item) => Activity.fromJson(Map<String, dynamic>.from(item as Map)),
    ),
  );

  static Map<String, dynamic>? stageGuideFor(String? ageBand) {
    final guides = package['stageGuides'] as List;
    for (final guide in guides) {
      if ((guide as Map)['ageBand'] == ageBand) {
        return Map<String, dynamic>.from(guide);
      }
    }
    return null;
  }

  static Map<String, dynamic> get currentStageGuide => stageGuideFor('m18_23')!;

  static List<Map<String, dynamic>> get currentStageFocuses =>
      List.unmodifiable(
        (currentStageGuide['focuses'] as List).map(
          (item) => Map<String, dynamic>.from(item as Map),
        ),
      );

  static DayPlan dayPlan(FamilyDate date) {
    final week = Map<String, dynamic>.from(package['week'] as Map);
    final days = week['days'] as List;
    final sourceDay = Map<String, dynamic>.from(
      days.firstWhere(
        (item) => (item as Map)['day'] == date.weekday,
        orElse: () => days.first,
      ) as Map,
    );
    final sourceItems = sourceDay['items'] as List;
    final dayId = 'demo-day-${date.toString()}';
    return DayPlan.fromJson({
      'id': dayId,
      'familyId': 'demo-family',
      'childId': 'demo-child',
      'localDate': date.toString(),
      'timezone': 'Asia/Shanghai',
      'mode': 'standard',
      'generationVersion': package['contentVersion'],
      'revision': 0,
      'missingSlots': <String>[],
      'effectiveBudgetMinutes': week['budgetMinutes'],
      'items': [
        for (var index = 0; index < sourceItems.length; index++)
          _planItem(
            source: Map<String, dynamic>.from(sourceItems[index] as Map),
            dayId: dayId,
            date: date,
            position: index,
          ),
      ],
    });
  }

  static Map<String, dynamic> _planItem({
    required Map<String, dynamic> source,
    required String dayId,
    required FamilyDate date,
    required int position,
  }) {
    final card = _cardsById[source['cardId']];
    if (card == null) {
      throw StateError('内容包引用了不存在的活动卡 ${source['cardId']}');
    }
    return {
      'id': 'demo-item-${date.toString()}-${source['id']}',
      'dayPlanId': dayId,
      'kind': source['kind'],
      'block': source['block'],
      'position': position,
      'budgetMinutes': source['minutes'],
      'snapshot': card,
      'lockedByParent': false,
      'startedAt': null,
      'revision': 0,
      'reasonCodes': const ['AGE_MATCH', 'AVAILABLE_AT_HOME'],
      'blockedByWithdrawal': false,
      'participation': null,
      'visibility': 'active',
    };
  }
}
