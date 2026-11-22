import 'package:babyplan/core/family_date.dart';
import 'package:babyplan/domain/demo_content.dart';
import 'package:babyplan/domain/models.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/test_support.dart';

void main() {
  setUpAll(initializeTestTimezones);

  test('服务端允许的 UTC 在设备进入次日时仍使用家庭日期', () {
    final instant = DateTime.parse('2026-11-12T16:20:00Z');
    expect(FamilyDate.at(instant, 'UTC'), FamilyDate(2026, 11, 12));
    expect(FamilyDate.at(instant, 'Asia/Shanghai'), FamilyDate(2026, 11, 13));
  });

  test('估算月龄按基准日推进，阶段切换而且不跨档给旧活动', () {
    final child = ChildSummary.fromJson({
      'id': testChildId,
      'familyId': testFamilyId,
      'ageMode': 'months',
      'ageMonths': 23,
      'ageAsOf': '2026-10-14',
      'revision': 1,
    });
    expect(child.ageAt(testDate), 23);
    expect(child.ageBandAt(testDate), 'm18_23');
    final after = child.ageBandAt(testDate.addDays(1));
    expect(after, 'm24_29');
    expect(DemoContent.stageGuideFor(after)?['ageBand'], after);
    expect(
      DemoContent.discoveryActivities.any(
        (card) => card.ageBands.contains(after),
      ),
      isFalse,
    );
  });

  test('离线包包含 24 张候选卡且不会伪装成已审核内容', () {
    final activities = DemoContent.discoveryActivities;
    expect(activities, hasLength(24));
    expect(activities.map((item) => item.id).toSet(), hasLength(24));
    expect(activities.every((item) => item.reviewState != 'reviewed'), isTrue);
  });

  test('离线七天安排每天六项且引用内容卡', () {
    for (var offset = 0; offset < 7; offset++) {
      final plan = DemoContent.dayPlan(testDate.addDays(offset));
      expect(plan.items, hasLength(6));
      expect(plan.effectiveBudgetMinutes, 60);
      expect(
        plan.items.fold<int>(0, (total, item) => total + item.budgetMinutes),
        60,
      );
      expect(plan.items.every((item) => !item.blocked), isTrue);
    }
  });
}
