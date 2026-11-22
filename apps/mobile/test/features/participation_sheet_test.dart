import 'package:babyplan/app/app_controller.dart';
import 'package:babyplan/core/app_config.dart';
import 'package:babyplan/data/local_store.dart';
import 'package:babyplan/domain/models.dart';
import 'package:babyplan/features/today/participation_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../support/test_support.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    initializeTestTimezones();
  });

  testWidgets('真实家庭只显示 active 的其他成员，并选中其实际 userId', (tester) async {
    late LocalStore local;
    late AppController controller;
    await tester.runAsync(() async {
      local = await openStore(inMemoryDatabasePath);
      await local.cachePlan(testFamilyId, testPlan());
      controller = AppController(
        config: const AppConfig(demo: false, apiBaseUrl: null),
        local: local,
        tokenVault: MemoryTokenVault(),
        initialFamilyId: testFamilyId,
        initialChildId: testChildId,
        initialActorId: testActorId,
        now: () => testNow,
      );
      controller.activeFamily = const FamilySummary(
        id: testFamilyId,
        name: '我们家',
        timezone: 'Asia/Shanghai',
        revision: 3,
        members: [
          FamilyMember(
            userId: testActorId,
            role: 'owner',
            active: true,
            displayName: '当前账号',
            familyId: testFamilyId,
            revision: 1,
          ),
          FamilyMember(
            userId: 'user-partner',
            role: 'caregiver',
            active: true,
            displayName: '小林',
            familyId: testFamilyId,
            revision: 1,
          ),
          FamilyMember(
            userId: 'user-inactive',
            role: 'caregiver',
            active: false,
            displayName: '已离开成员',
            familyId: testFamilyId,
            revision: 1,
          ),
        ],
      );
    });

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => FilledButton(
              onPressed: () => showParticipationSheet(
                context,
                controller: controller,
                item: testPlan().items.first,
              ),
              child: const Text('打开陪伴记录'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开陪伴记录'));
    await tester.pumpAndSettle();

    expect(find.text('我'), findsOneWidget);
    expect(find.text('小林'), findsOneWidget);
    expect(find.text('另一位家长'), findsNothing);
    expect(find.text('当前账号'), findsNothing);
    expect(find.text('已离开成员'), findsNothing);
    expect(controller.companionMembers.single.userId, 'user-partner');

    final partnerChip = find.ancestor(
      of: find.text('小林'),
      matching: find.byType(FilterChip),
    );
    expect(tester.widget<FilterChip>(partnerChip).selected, isFalse);
    await tester.tap(find.text('小林'));
    await tester.pump();
    expect(tester.widget<FilterChip>(partnerChip).selected, isTrue);
    expect(
      controller.companionMembers.map((member) => member.userId),
      isNot(contains('demo-partner')),
    );
    await tester.runAsync(local.close);
  });

  test('演示模式仍使用显式的 demo-partner，真实账号从不使用该占位 ID', () {
    final demo = AppController(
      config: const AppConfig(demo: true),
      local: _NeverUsedStore(),
      tokenVault: MemoryTokenVault(),
      initialFamilyId: 'demo-family',
      initialChildId: 'demo-child',
      initialActorId: 'demo-caregiver',
      now: () => testNow,
    );

    expect(demo.companionMembers.single.userId, 'demo-partner');
    expect(demo.companionMembers.single.label, '另一位家长');
  });

  test('bootstrap 保留家庭成员真实显示名与 userId', () {
    final account = AccountBootstrap.fromJson({
      'user': {'id': testActorId, 'displayName': '登录家长'},
      'families': [
        {
          'id': testFamilyId,
          'name': '我们家',
          'timezone': 'Asia/Shanghai',
          'revision': 1,
          'members': [
            {
              'userId': 'user-partner',
              'role': 'caregiver',
              'active': true,
              'displayName': '小满爸爸',
              'familyId': testFamilyId,
              'revision': 2,
            },
          ],
        },
      ],
      'children': <Object>[],
    });

    expect(account.families.single.members.single.userId, 'user-partner');
    expect(account.families.single.members.single.label, '小满爸爸');
  });
}

/// 只用于验证不访问数据库的纯控制器属性。
class _NeverUsedStore implements LocalStore {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('这个测试不应访问 LocalStore。');
}
