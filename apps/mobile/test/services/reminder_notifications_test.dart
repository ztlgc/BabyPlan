import 'package:babyplan/services/reminder_notifications.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('通知设置传给 Android 接收器，恢复旧的晚间设置仍在静默时段之前', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    const channel = MethodChannel('app.babyplan/reminder_test');
    final calls = <MethodCall>[];
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      if (call.method == 'permission') return true;
      return null;
    });
    addTearDown(() {
      debugDefaultTargetPlatformOverride = null;
      messenger.setMockMethodCallHandler(channel, null);
    });
    final scheduler = LocalReminderScheduler(channel)
      ..timezone = 'Asia/Shanghai';
    expect(await scheduler.requestPermission(), isTrue);
    await scheduler.setHandledDate('2026-11-13');
    await scheduler.scheduleDaily('21:30');
    await scheduler.cancel();
    expect(calls.map((call) => call.method), [
      'permission',
      'handled',
      'schedule',
      'cancel',
    ]);
    expect(calls[1].arguments, {'date': '2026-11-13'});
    expect(calls[2].arguments, {'time': '16:00', 'zone': 'Asia/Shanghai'});
    expect(validReminderTime('20:00'), isFalse);
  });
}
