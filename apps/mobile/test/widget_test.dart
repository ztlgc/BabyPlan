import 'package:babyplan/app/app_controller.dart';
import 'package:babyplan/app/babyplan_app.dart';
import 'package:babyplan/core/app_config.dart';
import 'package:babyplan/data/local_store.dart';
import 'package:babyplan/domain/demo_content.dart';
import 'package:babyplan/domain/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'support/test_support.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    initializeTestTimezones();
  });

  Future<AppController> buildController(LocalStore local) async {
    final controller = AppController(
      config: const AppConfig(demo: true),
      local: local,
      tokenVault: MemoryTokenVault(),
      initialFamilyId: 'demo-family',
      initialChildId: 'demo-child',
      initialActorId: 'demo-caregiver',
      now: () => testNow,
    );
    await controller.initialize();
    return controller;
  }

  Future<void> waitForController(
    WidgetTester tester,
    bool Function() condition,
  ) async {
    for (var attempt = 0; attempt < 60; attempt++) {
      if (condition()) return;
      await tester.pump(const Duration(milliseconds: 50));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 25)),
      );
    }
    fail('等待控制器状态更新超时');
  }

  testWidgets('应用启动后显示今天、四个入口和明确本机模式', (tester) async {
    late AppController controller;
    await tester.runAsync(() async {
      final local = await openStore(inMemoryDatabasePath);
      controller = await buildController(local);
    });
    expect(controller.loadState, LoadState.ready, reason: controller.loadError);

    await tester.pumpWidget(BabyPlanApp(controller: controller));
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('今天，一起玩点什么？'), findsOneWidget);
    expect(
      find.text('本机候选内容包：活动的审读状态会逐项显示；连接家庭服务后会刷新为已发布的真实安排。'),
      findsOneWidget,
    );
    expect(find.text('今天'), findsWidgets);
    expect(find.text('发现'), findsOneWidget);
    expect(find.text('成长'), findsOneWidget);
    expect(find.text('家庭'), findsOneWidget);
    expect(
      find.text(DemoContent.dayPlan(testDate).items.first.activity.title),
      findsOneWidget,
    );
  });

  testWidgets('四个入口可以打开并展示发现、成长和家庭内容', (tester) async {
    late AppController controller;
    await tester.runAsync(() async {
      final local = await openStore(inMemoryDatabasePath);
      controller = await buildController(local);
    });
    await tester.pumpWidget(BabyPlanApp(controller: controller));
    await tester.pump(const Duration(milliseconds: 400));

    await tester.tap(find.text('发现'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('慢慢看，随时玩'), findsOneWidget);
    expect(
      find.text('这里内置 24 张候选活动卡，均标注为“待人工审读”；不会冒充已经发布的内容。'),
      findsOneWidget,
    );

    await tester.tap(find.text('成长'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('把今天的小事留住'), findsOneWidget);
    expect(find.text('还没有成长记录'), findsOneWidget);

    await tester.tap(find.text('家庭'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('一起照顾，一起调整'), findsOneWidget);
    expect(find.text('家庭服务未连接。这里新增的内容只保存在本机，会明确显示“待同步”。'), findsNothing);
    expect(find.text('本机演示 / 缓存'), findsOneWidget);
    expect(find.text('只导出我的待同步草稿'), findsOneWidget);
  });

  testWidgets('活动卡进入详情并展示材料、步骤、亲子对话与安全提示', (tester) async {
    late AppController controller;
    await tester.runAsync(() async {
      final local = await openStore(inMemoryDatabasePath);
      controller = await buildController(local);
    });
    await tester.pumpWidget(BabyPlanApp(controller: controller));
    await tester.pump(const Duration(milliseconds: 400));

    final firstTitle = DemoContent.dayPlan(testDate).items.first.activity.title;
    await tester.ensureVisible(find.text(firstTitle));
    await tester.pump(const Duration(milliseconds: 200));
    await tester.tap(find.text(firstTitle));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.text('活动详情'), findsOneWidget);
    expect(find.text('先准备'), findsOneWidget);
    expect(find.text('怎么做'), findsOneWidget);
    expect(find.text('可以这样说'), findsOneWidget);
    expect(find.text('英语一句'), findsOneWidget);
    expect(find.text('安全提示'), findsOneWidget);
  });

  testWidgets('未来七天可以预览，但未来详情不能记录或换项', (tester) async {
    late AppController controller;
    await tester.runAsync(() async {
      final local = await openStore(inMemoryDatabasePath);
      controller = await buildController(local);
    });
    await tester.pumpWidget(BabyPlanApp(controller: controller));
    await tester.pump(const Duration(milliseconds: 400));

    await tester.tap(find.text('看未来七天'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(
      find.text('未来安排只用于提前看材料和心里有数；这里不能记录或换项。到了当天再按宝宝状态开始。'),
      findsOneWidget,
    );

    final tomorrowTitle = DemoContent.dayPlan(testDate.addDays(1))
        .items
        .first
        .activity
        .title;
    await tester.drag(find.byType(ListView).last, const Offset(0, -700));
    await tester.pumpAndSettle();
    final futureTitle = find.text(tomorrowTitle);
    expect(futureTitle, findsOneWidget);
    await tester.ensureVisible(futureTitle);
    await tester.pumpAndSettle();
    await tester.tap(
      find.ancestor(of: futureTitle, matching: find.byType(ListTile)).first,
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('活动详情'), findsOneWidget);
    expect(find.text('一起玩了'), findsNothing);
    expect(find.text('今天先跳过'), findsNothing);
    expect(find.text('换一个活动'), findsNothing);
  });

  testWidgets('空状态与错误状态用家长能理解的中文显示', (tester) async {
    late final LocalStore local;
    await tester.runAsync(() async {
      local = await openStore(inMemoryDatabasePath);
    });
    final controller = AppController(
      config: const AppConfig(demo: true),
      local: local,
      tokenVault: MemoryTokenVault(),
      initialFamilyId: 'demo-family',
      initialChildId: 'demo-child',
      initialActorId: 'demo-caregiver',
      now: () => testNow,
    );
    controller.loadState = LoadState.empty;

    await tester.pumpWidget(BabyPlanApp(controller: controller));
    await tester.pump();
    expect(find.text('今天的安排还没准备好'), findsOneWidget);

    controller.loadState = LoadState.error;
    controller.loadError = '本机资料暂时没有读取成功。';
    await tester.pumpWidget(BabyPlanApp(controller: controller));
    await tester.pump();
    expect(find.text('今天的安排暂时没有打开'), findsOneWidget);
    expect(find.text('本机资料暂时没有读取成功。'), findsOneWidget);
  });

  testWidgets('成长编辑器区分卧位身长、站立身高和体重', (tester) async {
    late AppController controller;
    await tester.runAsync(() async {
      final local = await openStore(inMemoryDatabasePath);
      controller = await buildController(local);
    });
    await tester.pumpWidget(BabyPlanApp(controller: controller));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('成长'));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.byTooltip('添加成长记录'));
    await tester.pump();
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pumpAndSettle();

    await tester.tap(find.text('原话'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('身高 / 体重').last);
    await tester.pumpAndSettle();
    expect(find.text('测量项目'), findsOneWidget);
    expect(find.text('测量方式'), findsOneWidget);
    expect(find.text('卧位身长'), findsOneWidget);
    expect(find.text('在哪里测量'), findsOneWidget);

    expect(find.text('身长 / 身高', skipOffstage: false), findsWidgets);
    expect(find.text('站立身高', skipOffstage: false), findsWidgets);
    expect(find.text('体重', skipOffstage: false), findsWidgets);

    expect(controller.growthRecords, isEmpty);
    Navigator.of(tester.element(find.text('添加成长记录'))).pop();
    await tester.pumpAndSettle();
  });

  testWidgets('成长记录可以从界面更正、移到回收站并恢复', (tester) async {
    late AppController controller;
    await tester.runAsync(() async {
      final local = await openStore(inMemoryDatabasePath);
      controller = await buildController(local);
      await controller.addGrowth(
        type: GrowthRecordType.story,
        date: testDate,
        text: '会自己翻书',
      );
    });
    await tester.pumpWidget(BabyPlanApp(controller: controller));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('成长'));
    await tester.pumpAndSettle();
    expect(find.text('会自己翻书'), findsOneWidget);

    await tester.tap(find.byTooltip('记录操作'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('更正这条记录'));
    await tester.pumpAndSettle();
    expect(find.text('更正成长记录'), findsOneWidget);
    await tester.enterText(find.byType(TextField).first, '会自己翻书并指着小兔');
    await tester.tap(find.text('保存更正'));
    await tester.pump();
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await tester.pumpAndSettle();
    expect(controller.growthRecords.single.text, '会自己翻书并指着小兔');
    expect(find.text('会自己翻书并指着小兔'), findsOneWidget);

    await tester.tap(find.byTooltip('记录操作'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('移到回收站'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '移到回收站'));
    await tester.pump();
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await tester.pumpAndSettle();
    expect(controller.growthRecords, isEmpty);
    expect(controller.deletedGrowthRecords, hasLength(1));
    final trash = find.text('回收站 · 1 条');
    expect(trash, findsOneWidget);

    await tester.ensureVisible(trash);
    await tester.pumpAndSettle();
    await tester.tap(trash);
    await tester.pumpAndSettle();
    final restore = find.text('恢复');
    await tester.ensureVisible(restore);
    await tester.pumpAndSettle();
    await tester.tap(restore);
    await waitForController(
      tester,
      () =>
          controller.deletedGrowthRecords.isEmpty &&
          controller.growthRecords.isNotEmpty,
    );
    await tester.pumpAndSettle();
    expect(controller.deletedGrowthRecords, isEmpty);
    expect(find.text('会自己翻书并指着小兔'), findsOneWidget);
  });

  testWidgets('360 宽和双倍字号下冲突双方文字可读且可处理', (tester) async {
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
      tester.platformDispatcher.clearTextScaleFactorTestValue();
    });
    late AppController controller;
    await tester.runAsync(() async {
      final local = await openStore(inMemoryDatabasePath);
      controller = await buildController(local);
      final item = controller.plan!.items.first;
      final operationId = await controller.repository.record(
        item,
        ParticipationInput(
          status: ParticipationStatus.played,
          participantIds: const ['demo-caregiver'],
          note: '本机备注：一起数了积木',
        ),
      );
      await controller.local.claimNext(
        controller.familyId,
        testNow,
        objectPrefixes: const {'participation:'},
      );
      await controller.local.failOperation(
        controller.familyId,
        operationId,
        code: 'REVISION_CONFLICT',
        retryAfter: testNow.add(const Duration(days: 1)),
        conflict: {
          'current': {
            'id': 'remote',
            'planItemId': item.id,
            'status': 'played',
            'participantIds': ['demo-partner'],
            'notes': [
              {'authorId': 'demo-partner', 'text': '家庭备注：另一位家长也数了积木'},
            ],
            'actualMinutes': 5,
            'again': false,
            'addedBy': 'demo-partner',
            'revision': 2,
          },
          'submitted': 1,
        },
      );
      controller.syncIssues = await controller.repository.syncIssues();
      controller.notifyListeners();
    });

    await tester.pumpWidget(BabyPlanApp(controller: controller));
    await tester.pump(const Duration(milliseconds: 400));
    expect(tester.takeException(), isNull);
    final entry = find.text('有 1 条记录需要选一下');
    await tester.ensureVisible(entry);
    await tester.pumpAndSettle();
    await tester.tap(entry);
    await tester.pumpAndSettle();

    expect(find.text('本机备注：一起数了积木'), findsOneWidget);
    expect(find.text('家庭备注：另一位家长也数了积木'), findsOneWidget);
    expect(tester.takeException(), isNull);
    final keepMine = find.text('保留我的版本');
    await tester.ensureVisible(keepMine);
    await tester.pumpAndSettle();
    await tester.tap(keepMine);
    await tester.pump();
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await tester.pump(const Duration(milliseconds: 400));
    expect(controller.syncIssues, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('360 宽和双倍字号下提醒设置与深浅色主入口无横向溢出', (tester) async {
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
      tester.platformDispatcher.clearTextScaleFactorTestValue();
    });
    late AppController controller;
    await tester.runAsync(() async {
      final local = await openStore(inMemoryDatabasePath);
      controller = await buildController(local);
    });

    await tester.pumpWidget(BabyPlanApp(controller: controller));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('家庭'));
    await tester.pumpAndSettle();
    expect(find.text('提醒'), findsOneWidget);
    expect(tester.takeException(), isNull);

    controller.setThemeMode(ThemeMode.dark);
    await tester.pumpAndSettle();
    expect(
      Theme.of(tester.element(find.text('一起照顾，一起调整'))).brightness,
      Brightness.dark,
    );
    expect(tester.takeException(), isNull);
  });
}
