import 'package:flutter/foundation.dart';

/// 只有显式开发构建才可启用虚构内容；默认构建不会播种演示家庭。
class AppConfig {
  const AppConfig({
    required this.demo,
    this.apiBaseUrl,
    this.familyId,
    this.childId,
  });

  factory AppConfig.fromEnvironment() {
    const demo = bool.fromEnvironment('BABYPLAN_DEMO');
    const raw = String.fromEnvironment('BABYPLAN_API_BASE_URL');
    const familyId = String.fromEnvironment('BABYPLAN_FAMILY_ID');
    const childId = String.fromEnvironment('BABYPLAN_CHILD_ID');
    if (demo && kReleaseMode) {
      throw StateError('演示数据仅允许在开发构建中使用。');
    }
    final uri = raw.isEmpty ? null : Uri.tryParse(raw);
    if (raw.isNotEmpty &&
        (uri == null ||
            !uri.hasAuthority ||
            uri.userInfo.isNotEmpty ||
            uri.hasQuery ||
            uri.hasFragment ||
            !['http', 'https'].contains(uri.scheme))) {
      throw const FormatException('服务地址格式不正确。');
    }
    return AppConfig(
      demo: demo,
      apiBaseUrl: uri,
      familyId: familyId.isEmpty ? null : familyId,
      childId: childId.isEmpty ? null : childId,
    );
  }

  final bool demo;
  final Uri? apiBaseUrl;
  final String? familyId;
  final String? childId;
  bool get isLocalPreview => demo || apiBaseUrl == null;
  String get databaseName =>
      isLocalPreview ? 'babyplan_demo_v2.db' : 'babyplan_v2.db';
}
