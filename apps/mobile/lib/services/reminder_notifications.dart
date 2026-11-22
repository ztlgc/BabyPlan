import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

abstract interface class ReminderScheduler {
  Future<void> initialize({required VoidCallback onOpenToday});
  Future<bool> requestPermission();
  Future<void> scheduleDaily(String localTime);
  Future<void> cancel();
}

bool validReminderTime(String value) =>
    RegExp(r'^([01]\d):[0-5]\d$').hasMatch(value);

String reminderTimeBeforeQuietHours(String value) {
  return validReminderTime(value) ? value : '16:00';
}

/// Android 原生接收器在收到闹钟时核对日期和静默时段，无需启动 Flutter。
class LocalReminderScheduler implements ReminderScheduler {
  LocalReminderScheduler([
    MethodChannel channel = const MethodChannel('app.babyplan/reminders'),
  ]) : _channel = channel;
  final MethodChannel _channel;
  String timezone = 'Asia/Shanghai';
  bool get _android =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  @override
  Future<void> initialize({required VoidCallback onOpenToday}) async {
    if (!_android) return;
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'openToday') onOpenToday();
    });
  }

  @override
  Future<bool> requestPermission() async {
    return _android &&
        (await _channel.invokeMethod<bool>('permission') ?? false);
  }

  @override
  Future<void> scheduleDaily(String localTime) async {
    if (!_android) return;
    await _channel.invokeMethod<void>('schedule', {
      'time': reminderTimeBeforeQuietHours(localTime),
      'zone': timezone,
    });
  }

  @override
  Future<void> cancel() async {
    if (_android) await _channel.invokeMethod<void>('cancel');
  }

  Future<void> setHandledDate(String? date) async {
    if (_android) await _channel.invokeMethod<void>('handled', {'date': date});
  }
}
