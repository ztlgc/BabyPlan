import 'dart:io';

import 'package:babyplan/core/family_date.dart';
import 'package:babyplan/data/api_client.dart';
import 'package:babyplan/data/local_store.dart';
import 'package:babyplan/domain/demo_content.dart';
import 'package:babyplan/domain/models.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:timezone/data/latest.dart' as tz_data;
import 'package:timezone/timezone.dart' as tz;

const testFamilyId = 'family-test';
const testChildId = 'child-test';
const testActorId = 'actor-test';
final testDate = FamilyDate(2026, 11, 13);
final testNow = DateTime.parse('2026-11-13T04:00:00Z');

Future<Directory> createTempDirectory() =>
    Directory.systemTemp.createTemp('babyplan_mobile_test_');

Future<LocalStore> openStore(String path) =>
    LocalStore.open(factory: databaseFactoryFfi, path: path);

DayPlan testPlan({
  FamilyDate? date,
  String familyId = testFamilyId,
  String childId = testChildId,
}) {
  final source = DemoContent.dayPlan(date ?? testDate).json;
  return DayPlan.fromJson({
    ...source,
    'familyId': familyId,
    'childId': childId,
    'id': 'plan-test',
    'items': (source['items'] as List)
        .map(
          (item) => {
            ...Map<String, dynamic>.from(item as Map),
            'dayPlanId': 'plan-test',
          },
        )
        .toList(growable: false),
  });
}

void initializeTestTimezones() {
  tz_data.initializeTimeZones();
  tz.setLocalLocation(tz.getLocation('Asia/Shanghai'));
}

class MemoryTokenVault implements TokenVault {
  MobileSession? session;
  String? serviceUri;
  final String _device = '00000000-0000-4000-8000-000000000001';

  @override
  Future<void> clearSession() async {
    session = null;
  }

  @override
  Future<void> clearServiceUri() async {
    serviceUri = null;
  }

  @override
  Future<String> deviceId() async => _device;

  @override
  Future<MobileSession?> readSession() async => session;

  @override
  Future<String?> readServiceUri() async => serviceUri;

  @override
  Future<void> writeSession(MobileSession value) async {
    session = value;
  }

  @override
  Future<void> writeServiceUri(String value) async {
    serviceUri = value;
  }
}

MobileSession sampleSession() => MobileSession.fromJson({
  'user': {'id': 'user-test', 'displayName': '测试家长'},
  'sessionId': '10000000-0000-4000-8000-000000000001',
  'accessToken': 'access-test-token',
  'refreshToken': 'refresh-test-token',
  'expiresAt': '2026-11-13T04:15:00Z',
  'refreshExpiresAt': '2026-12-13T04:00:00Z',
});
