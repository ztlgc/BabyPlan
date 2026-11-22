import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Debug、Profile 与 Release 均允许连接 HTTP 或 HTTPS 家庭服务', () {
    final mainManifest = File('android/app/src/main/AndroidManifest.xml')
        .readAsStringSync();
    final debugManifest = File('android/app/src/debug/AndroidManifest.xml')
        .readAsStringSync();
    final profileManifest = File('android/app/src/profile/AndroidManifest.xml')
        .readAsStringSync();

    expect(mainManifest, contains('android:usesCleartextTraffic="true"'));
    expect(debugManifest, contains('android:usesCleartextTraffic="true"'));
    expect(profileManifest, contains('android:usesCleartextTraffic="true"'));
    expect(mainManifest, isNot(contains('READ_MEDIA_IMAGES')));
    expect(debugManifest, isNot(contains('READ_MEDIA_IMAGES')));
    expect(profileManifest, isNot(contains('READ_MEDIA_IMAGES')));
  });
}
