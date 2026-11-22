/// 家庭服务返回的可识别错误。
///
/// `details` 保留修订冲突等服务端结构化信息，界面只通过用户可理解的摘要展示，
/// 不直接显示 operationId、HTTP 状态码或原始 token。
class ApiException implements Exception {
  const ApiException(this.message, {this.statusCode, this.code, this.details});

  final String message;
  final int? statusCode;
  final String? code;
  final Map<String, dynamic>? details;

  @override
  String toString() => message;
}
