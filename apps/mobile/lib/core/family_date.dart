import 'package:timezone/timezone.dart' as tz;

/// 业务日期不携带设备时区；不使用 DateTime 本地构造来推进日历日。
class FamilyDate implements Comparable<FamilyDate> {
  FamilyDate(this.year, this.month, this.day) {
    final normalized = DateTime.utc(year, month, day);
    if (normalized.year != year ||
        normalized.month != month ||
        normalized.day != day) {
      throw const FormatException('日期无效。');
    }
  }

  factory FamilyDate.parse(String value) {
    if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(value)) {
      throw const FormatException('日期必须是 YYYY-MM-DD。');
    }
    final values = value.split('-').map(int.parse).toList();
    return FamilyDate(values[0], values[1], values[2]);
  }

  factory FamilyDate.at(DateTime instant, String timezone) {
    final location = timezone == 'UTC' ? tz.UTC : tz.getLocation(timezone);
    final local = tz.TZDateTime.from(instant, location);
    return FamilyDate(local.year, local.month, local.day);
  }

  final int year;
  final int month;
  final int day;
  DateTime get _utcDate => DateTime.utc(year, month, day);
  int get weekday => _utcDate.weekday;
  FamilyDate addDays(int days) {
    final date = _utcDate.add(Duration(days: days));
    return FamilyDate(date.year, date.month, date.day);
  }

  /// 日历整月：月底出生者以目标月最后一天作为该月周年日。
  int completedMonthsSince(FamilyDate start) {
    if (compareTo(start) < 0) {
      throw const FormatException('年龄基准日不能晚于当前日期。');
    }
    var months = (year - start.year) * 12 + month - start.month;
    final lastDay = DateTime.utc(year, month + 1, 0).day;
    final anniversary = start.day > lastDay ? lastDay : start.day;
    if (day < anniversary) months--;
    return months;
  }

  int estimatedAgeMonths({required int months, required FamilyDate asOf}) {
    if (months < 0) throw const FormatException('月龄不能为负数。');
    return months + completedMonthsSince(asOf);
  }

  @override
  int compareTo(FamilyDate other) => _utcDate.compareTo(other._utcDate);
  @override
  bool operator ==(Object other) =>
      other is FamilyDate && compareTo(other) == 0;
  @override
  int get hashCode => Object.hash(year, month, day);
  @override
  String toString() =>
      '${year.toString().padLeft(4, '0')}-${month.toString().padLeft(2, '0')}-${day.toString().padLeft(2, '0')}';
}
