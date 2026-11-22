import 'package:flutter/widgets.dart';
import 'package:path/path.dart' as path;
import 'package:sqflite/sqflite.dart';
import 'package:timezone/data/latest.dart' as tz_data;
import 'package:timezone/timezone.dart' as tz;

import 'app/app_controller.dart';
import 'app/babyplan_app.dart';
import 'core/app_config.dart';
import 'data/api_client.dart';
import 'data/local_store.dart';
import 'services/reminder_notifications.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  tz_data.initializeTimeZones();
  try {
    tz.setLocalLocation(tz.getLocation('Asia/Shanghai'));
  } on Object {
    // 设备缺少该时区数据时仍可启动，日期计算会使用已初始化的首个时区。
  }
  final config = AppConfig.fromEnvironment();
  final local = await LocalStore.open(
    factory: databaseFactory,
    path: path.join(await getDatabasesPath(), config.databaseName),
  );
  final vault = SecureTokenVault();
  final reminders = LocalReminderScheduler();
  final controller = AppController(
    config: config,
    local: local,
    tokenVault: vault,
    initialFamilyId: 'demo-family',
    initialChildId: 'demo-child',
    initialActorId: config.demo || config.apiBaseUrl == null
        ? 'demo-caregiver'
        : 'local-caregiver',
    reminderScheduler: reminders,
  );
  try {
    await reminders.initialize(onOpenToday: controller.requestToday);
  } on Object {
    // 通知初始化失败不阻止今天、发现和成长等核心功能。
  }
  await controller.initialize();
  runApp(BabyPlanApp(controller: controller));
}
