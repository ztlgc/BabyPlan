import '../core/family_date.dart';

typedef Json = Map<String, dynamic>;

T? _enumByName<T extends Enum>(List<T> values, Object? value) {
  if (value is! String) return null;
  for (final item in values) {
    if (item.name == value) return item;
  }
  return null;
}

class Activity {
  Activity.fromJson(Json value) : json = Map.unmodifiable(value);
  final Json json;
  String get id => json['id'] as String;
  String get title => json['title'] as String;
  String get kind => json['kind'] as String;
  String get support => json['support'] as String;
  int get revision => json['revision'] as int;
  String get reviewState => json['reviewState'] as String;
  List<String> get ageBands =>
      List<String>.from((json['ageBands'] as List?) ?? const <String>[]);
  List<String> get sourceIds =>
      List<String>.from((json['sourceIds'] as List?) ?? const <String>[]);
  List<String> get materials => List<String>.from(json['materials'] as List);
  List<String> get steps => List<String>.from(json['steps'] as List);
  Map<String, String> get dialogue =>
      Map<String, String>.from(json['dialogue'] as Map);
  Map<String, String> get english =>
      Map<String, String>.from(json['english'] as Map);
  String get safety => json['safety'] as String;
  String get easier => json['easier'] as String;
  String get next => json['next'] as String;
  bool get withdrawn => json['withdrawn'] == true;
}

class PlanItem {
  PlanItem.fromJson(Json value)
    : json = Map.unmodifiable(value),
      activity = Activity.fromJson(
        Map<String, dynamic>.from(value['snapshot']),
      );
  final Json json;
  final Activity activity;
  String get id => json['id'] as String;
  String get dayPlanId => json['dayPlanId'] as String;
  String get block => json['block'] as String;
  int get budgetMinutes => json['budgetMinutes'] as int;
  int get revision => json['revision'] as int;
  bool get visible => json['visibility'] != 'hidden';
  bool get blocked => json['blockedByWithdrawal'] == true || activity.withdrawn;
}

class DayPlan {
  DayPlan.fromJson(Json value)
    : json = Map.unmodifiable(value),
      items = List.unmodifiable(
        (value['items'] as List).map(
          (item) => PlanItem.fromJson(Map<String, dynamic>.from(item as Map)),
        ),
      );
  final Json json;
  final List<PlanItem> items;
  Iterable<PlanItem> get visibleItems => items.where((item) => item.visible);
  String get id => json['id'] as String;
  String get familyId => json['familyId'] as String;
  String get childId => json['childId'] as String;
  String get timezone => json['timezone'] as String;
  FamilyDate get date => FamilyDate.parse(json['localDate'] as String);
  String get mode => json['mode'] as String;
  int get effectiveBudgetMinutes => json['effectiveBudgetMinutes'] as int;
  int get revision => json['revision'] as int;
}

enum ParticipationStatus { played, skipped }

class ParticipationInput {
  const ParticipationInput({
    required this.status,
    required this.participantIds,
    this.note = '',
    this.actualMinutes,
    this.again = false,
  });
  final ParticipationStatus status;
  final List<String> participantIds;
  final String note;
  final int? actualMinutes;
  final bool again;

  void validate() {
    if (status == ParticipationStatus.played && participantIds.isEmpty) {
      throw const FormatException('请选择至少一位陪伴者。');
    }
    if (participantIds.toSet().length != participantIds.length) {
      throw const FormatException('陪伴者重复。');
    }
    if (note.length > 2000) throw const FormatException('备注请控制在 2000 字以内。');
    if (actualMinutes != null &&
        (actualMinutes! < 0 || actualMinutes! > 1440)) {
      throw const FormatException('实际时长无效。');
    }
  }

  Json body(String operationId, int baseRevision) => {
    'operationId': operationId,
    'baseRevision': baseRevision,
    'status': status.name,
    'participantIds': participantIds,
    'note': note,
    'actualMinutes': actualMinutes,
    'again': again,
  };
}

class LocalParticipation {
  const LocalParticipation({
    required this.payload,
    required this.localVersion,
    required this.serverRevision,
    required this.syncState,
  });
  final Json payload;
  final int localVersion;
  final int serverRevision;
  final String syncState;
  bool get played => payload['status'] == 'played';
  String get status => payload['status'] as String;
  List<String> get participantIds =>
      List<String>.from(payload['participantIds'] as List);
  String get note => (payload['note'] as String?) ?? '';
  String noteFor(String actorId) {
    final notes = payload['notes'];
    if (notes is List) {
      for (final value in notes) {
        if (value is Map && value['authorId'] == actorId) {
          return value['text'] as String? ?? '';
        }
      }
    }
    return payload['addedBy'] == actorId ? note : '';
  }

  List<String> get historyNotes {
    final notes = payload['notes'];
    if (notes is List) {
      return [
        for (final value in notes)
          if (value is Map && value['text'] is String) value['text'] as String,
      ];
    }
    return note.isEmpty ? const [] : [note];
  }

  int? get actualMinutes => payload['actualMinutes'] as int?;
  bool get again => payload['again'] == true;
}

enum GrowthRecordType { quote, story, first, observation, measurement }

enum GrowthMeasurementKind { height, weight }

enum GrowthMeasurementMethod { recumbent, standing, scale }

enum GrowthMeasurementSource { home, clinic }

class GrowthRecord {
  const GrowthRecord({
    required this.id,
    required this.type,
    required this.localDate,
    required this.text,
    required this.createdAt,
    required this.syncState,
    this.value,
    this.unit,
    this.firstConfirmed = false,
    this.guideId,
    this.observationValue,
    this.measurementKind,
    this.measurementMethod,
    this.measurementSource,
    this.serverRevision = 0,
    this.mediaIds = const [],
    this.deletedAt,
  });

  factory GrowthRecord.fromJson(Json json) => GrowthRecord(
    id: json['id'] as String,
    type: GrowthRecordType.values.byName(json['type'] as String),
    localDate: FamilyDate.parse(json['localDate'] as String),
    text: (json['text'] as String?) ?? '',
    createdAt: DateTime.parse(json['createdAt'] as String),
    syncState: (json['syncState'] as String?) ?? 'local_pending',
    value: (json['value'] as num?)?.toDouble(),
    unit: json['unit'] as String?,
    firstConfirmed: json['firstConfirmed'] == true,
    guideId: json['guideId'] as String?,
    observationValue: json['observationValue'] as String?,
    measurementKind: _enumByName(
      GrowthMeasurementKind.values,
      json['measurementKind'],
    ),
    measurementMethod: _enumByName(
      GrowthMeasurementMethod.values,
      json['measurementMethod'],
    ),
    measurementSource: _enumByName(
      GrowthMeasurementSource.values,
      json['measurementSource'],
    ),
    serverRevision: (json['serverRevision'] as int?) ?? 0,
    mediaIds: List<String>.from(
      (json['mediaIds'] as List?) ?? const <String>[],
    ),
    deletedAt: json['deletedAt'] is String
        ? DateTime.parse(json['deletedAt'] as String)
        : null,
  );

  final String id;
  final GrowthRecordType type;
  final FamilyDate localDate;
  final String text;
  final DateTime createdAt;
  final String syncState;
  final double? value;
  final String? unit;
  final bool firstConfirmed;
  final String? guideId;
  final String? observationValue;
  final GrowthMeasurementKind? measurementKind;
  final GrowthMeasurementMethod? measurementMethod;
  final GrowthMeasurementSource? measurementSource;
  final int serverRevision;
  final List<String> mediaIds;
  final DateTime? deletedAt;

  GrowthRecord copyWith({
    FamilyDate? localDate,
    String? text,
    String? syncState,
    double? value,
    String? unit,
    bool? firstConfirmed,
    String? guideId,
    String? observationValue,
    GrowthMeasurementKind? measurementKind,
    GrowthMeasurementMethod? measurementMethod,
    GrowthMeasurementSource? measurementSource,
    int? serverRevision,
    List<String>? mediaIds,
    DateTime? deletedAt,
  }) => GrowthRecord(
    id: id,
    type: type,
    localDate: localDate ?? this.localDate,
    text: text ?? this.text,
    createdAt: createdAt,
    syncState: syncState ?? this.syncState,
    value: value ?? this.value,
    unit: unit ?? this.unit,
    firstConfirmed: firstConfirmed ?? this.firstConfirmed,
    guideId: guideId ?? this.guideId,
    observationValue: observationValue ?? this.observationValue,
    measurementKind: measurementKind ?? this.measurementKind,
    measurementMethod: measurementMethod ?? this.measurementMethod,
    measurementSource: measurementSource ?? this.measurementSource,
    serverRevision: serverRevision ?? this.serverRevision,
    mediaIds: mediaIds ?? this.mediaIds,
    deletedAt: deletedAt ?? this.deletedAt,
  );

  Json toJson() => {
    'id': id,
    'type': type.name,
    'localDate': localDate.toString(),
    'text': text,
    'createdAt': createdAt.toIso8601String(),
    'syncState': syncState,
    'value': value,
    'unit': unit,
    'firstConfirmed': firstConfirmed,
    'guideId': guideId,
    'observationValue': observationValue,
    'measurementKind': measurementKind?.name,
    'measurementMethod': measurementMethod?.name,
    'measurementSource': measurementSource?.name,
    'serverRevision': serverRevision,
    'mediaIds': mediaIds,
    'deletedAt': deletedAt?.toUtc().toIso8601String(),
  };
}

/// 本机照片上传队列的一项。正文与照片各自持久化，照片失败不会回滚正文。
class GrowthPhotoUpload {
  const GrowthPhotoUpload({
    required this.id,
    required this.memoryId,
    required this.localPath,
    required this.mime,
    required this.byteSize,
    required this.sha256,
    required this.createOperationId,
    required this.completeOperationId,
    required this.linkOperationId,
    required this.state,
    required this.attempts,
    required this.createdAt,
    required this.updatedAt,
    this.serverMediaId,
    this.uploadUrl,
    this.uploadExpiresAt,
    this.errorCode,
  });

  factory GrowthPhotoUpload.fromJson(Json json) => GrowthPhotoUpload(
    id: json['id'] as String,
    memoryId: json['memoryId'] as String,
    localPath: json['localPath'] as String,
    mime: json['mime'] as String,
    byteSize: json['byteSize'] as int,
    sha256: json['sha256'] as String,
    createOperationId: json['createOperationId'] as String,
    completeOperationId: json['completeOperationId'] as String,
    linkOperationId: json['linkOperationId'] as String,
    serverMediaId: json['serverMediaId'] as String?,
    uploadUrl: json['uploadUrl'] as String?,
    uploadExpiresAt: json['uploadExpiresAt'] == null
        ? null
        : DateTime.parse(json['uploadExpiresAt'] as String),
    state: json['state'] as String,
    attempts: json['attempts'] as int,
    errorCode: json['errorCode'] as String?,
    createdAt: DateTime.parse(json['createdAt'] as String),
    updatedAt: DateTime.parse(json['updatedAt'] as String),
  );

  final String id;
  final String memoryId;
  final String localPath;
  final String mime;
  final int byteSize;
  final String sha256;
  final String createOperationId;
  final String completeOperationId;
  final String linkOperationId;
  final String? serverMediaId;
  final String? uploadUrl;
  final DateTime? uploadExpiresAt;
  final String state;
  final int attempts;
  final String? errorCode;
  final DateTime createdAt;
  final DateTime updatedAt;

  bool get completed =>
      state == 'linked' || state == 'removed' || state == 'failed';

  GrowthPhotoUpload copyWith({
    String? serverMediaId,
    String? uploadUrl,
    DateTime? uploadExpiresAt,
    bool clearTicket = false,
    String? state,
    int? attempts,
    String? errorCode,
    bool clearError = false,
    DateTime? updatedAt,
  }) => GrowthPhotoUpload(
    id: id,
    memoryId: memoryId,
    localPath: localPath,
    mime: mime,
    byteSize: byteSize,
    sha256: sha256,
    createOperationId: createOperationId,
    completeOperationId: completeOperationId,
    linkOperationId: linkOperationId,
    serverMediaId: serverMediaId ?? this.serverMediaId,
    uploadUrl: clearTicket ? null : uploadUrl ?? this.uploadUrl,
    uploadExpiresAt: clearTicket
        ? null
        : uploadExpiresAt ?? this.uploadExpiresAt,
    state: state ?? this.state,
    attempts: attempts ?? this.attempts,
    errorCode: clearError ? null : errorCode ?? this.errorCode,
    createdAt: createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
  );

  Json toJson() => {
    'id': id,
    'memoryId': memoryId,
    'localPath': localPath,
    'mime': mime,
    'byteSize': byteSize,
    'sha256': sha256,
    'createOperationId': createOperationId,
    'completeOperationId': completeOperationId,
    'linkOperationId': linkOperationId,
    'serverMediaId': serverMediaId,
    'uploadUrl': uploadUrl,
    'uploadExpiresAt': uploadExpiresAt?.toUtc().toIso8601String(),
    'state': state,
    'attempts': attempts,
    'errorCode': errorCode,
    'createdAt': createdAt.toUtc().toIso8601String(),
    'updatedAt': updatedAt.toUtc().toIso8601String(),
  };
}

class PreparedGrowthPhoto {
  const PreparedGrowthPhoto({
    required this.localPath,
    required this.mime,
    required this.byteSize,
    required this.sha256,
  });

  final String localPath;
  final String mime;
  final int byteSize;
  final String sha256;
}

class FamilyPreferences {
  const FamilyPreferences({
    this.availableMaterials = const ['积木', '纸和笔', '家中绘本'],
    this.excludedMaterials = const [],
    this.languageMode = 'zh_with_english',
    this.reminderEnabled = false,
    this.reminderTime = '16:00',
  });

  factory FamilyPreferences.fromJson(Json json) => FamilyPreferences(
    availableMaterials: List<String>.from(
      (json['availableMaterials'] as List?) ?? const [],
    ),
    excludedMaterials: List<String>.from(
      (json['excludedMaterials'] as List?) ?? const [],
    ),
    languageMode: (json['languageMode'] as String?) ?? 'zh_with_english',
    reminderEnabled: json['reminderEnabled'] == true,
    reminderTime: (json['reminderTime'] as String?) ?? '16:00',
  );

  final List<String> availableMaterials;
  final List<String> excludedMaterials;
  final String languageMode;
  final bool reminderEnabled;
  final String reminderTime;

  Json toJson() => {
    'availableMaterials': availableMaterials,
    'excludedMaterials': excludedMaterials,
    'languageMode': languageMode,
    'reminderEnabled': reminderEnabled,
    'reminderTime': reminderTime,
  };
}

class FamilyMember {
  const FamilyMember({
    required this.userId,
    required this.role,
    required this.active,
    required this.familyId,
    required this.revision,
    this.displayName,
  });

  factory FamilyMember.fromJson(Json json) => FamilyMember(
    userId: json['userId'] as String,
    role: json['role'] as String,
    active: json['active'] == true,
    displayName: json['displayName'] as String?,
    familyId: json['familyId'] as String,
    revision: json['revision'] as int,
  );

  final String userId;
  final String role;
  final bool active;
  final String? displayName;
  final String familyId;
  final int revision;

  String get label => displayName?.trim().isNotEmpty == true
      ? displayName!
      : role == 'owner'
      ? '家庭管理员'
      : '家庭成员';
}

class FamilySummary {
  const FamilySummary({
    required this.id,
    required this.name,
    required this.timezone,
    required this.revision,
    this.members = const [],
  });

  factory FamilySummary.fromJson(Json json) => FamilySummary(
    id: json['id'] as String,
    name: json['name'] as String,
    timezone: json['timezone'] as String,
    revision: json['revision'] as int,
    members: List.unmodifiable(
      ((json['members'] as List?) ?? const []).map(
        (item) => FamilyMember.fromJson(Map<String, dynamic>.from(item as Map)),
      ),
    ),
  );

  final String id;
  final String name;
  final String timezone;
  final int revision;
  final List<FamilyMember> members;
}

class ChildSummary {
  const ChildSummary({
    required this.id,
    required this.familyId,
    required this.ageMode,
    required this.revision,
    this.displayName,
    this.ageMonths,
    this.ageAsOf,
    this.birthDate,
  });

  factory ChildSummary.fromJson(Json json) => ChildSummary(
    id: json['id'] as String,
    familyId: json['familyId'] as String,
    displayName: json['displayName'] as String?,
    ageMode: json['ageMode'] as String,
    ageMonths: json['ageMonths'] as int?,
    ageAsOf: json['ageAsOf'] == null
        ? null
        : FamilyDate.parse(json['ageAsOf'] as String),
    birthDate: json['birthDate'] == null
        ? null
        : FamilyDate.parse(json['birthDate'] as String),
    revision: json['revision'] as int,
  );

  final String id;
  final String familyId;
  final String? displayName;
  final String ageMode;
  final int? ageMonths;
  final FamilyDate? ageAsOf;
  final FamilyDate? birthDate;
  final int revision;

  String get label =>
      displayName?.trim().isNotEmpty == true ? displayName! : '宝宝';

  int? ageAt(FamilyDate date) {
    try {
      if (ageMode == 'birthDate') {
        return birthDate == null ? null : date.completedMonthsSince(birthDate!);
      }
      if (ageMonths == null) return null;
      return ageAsOf == null
          ? ageMonths
          : date.estimatedAgeMonths(months: ageMonths!, asOf: ageAsOf!);
    } on FormatException {
      return null;
    }
  }

  String? ageBandAt(FamilyDate date) {
    final months = ageAt(date);
    if (months == null) return null;
    return switch (months) {
      >= 18 && < 24 => 'm18_23',
      >= 24 && < 30 => 'm24_29',
      >= 30 && < 36 => 'm30_35',
      36 => 'm36',
      _ => null,
    };
  }
}

class FamilyBook {
  const FamilyBook({
    required this.id,
    required this.familyId,
    required this.title,
    required this.editionStatus,
    required this.language,
    required this.revision,
    this.syncState = 'synced',
    this.editionId,
    this.note = '',
  });

  factory FamilyBook.fromJson(Json json) => FamilyBook(
    id: json['id'] as String,
    familyId: json['familyId'] as String,
    title: json['title'] as String,
    editionId: json['editionId'] as String?,
    editionStatus: json['editionStatus'] as String,
    language: json['language'] as String,
    note: (json['note'] as String?) ?? '',
    revision: json['revision'] as int,
    syncState: (json['syncState'] as String?) ?? 'synced',
  );

  final String id;
  final String familyId;
  final String title;
  final String? editionId;
  final String editionStatus;
  final String language;
  final String note;
  final int revision;
  final String syncState;

  bool get verified => editionStatus == 'verified';
  Json toJson() => {
    'id': id,
    'familyId': familyId,
    'title': title,
    'editionId': editionId,
    'editionStatus': editionStatus,
    'language': language,
    'note': note,
    'revision': revision,
    'syncState': syncState,
  };
}

class AccountBootstrap {
  const AccountBootstrap({
    required this.userId,
    required this.families,
    required this.children,
    this.displayName,
  });

  factory AccountBootstrap.fromJson(Json json) {
    final user = Map<String, dynamic>.from(json['user'] as Map);
    return AccountBootstrap(
      userId: user['id'] as String,
      displayName: user['displayName'] as String?,
      families: List.unmodifiable(
        (json['families'] as List).map(
          (item) =>
              FamilySummary.fromJson(Map<String, dynamic>.from(item as Map)),
        ),
      ),
      children: List.unmodifiable(
        (json['children'] as List).map(
          (item) =>
              ChildSummary.fromJson(Map<String, dynamic>.from(item as Map)),
        ),
      ),
    );
  }

  final String userId;
  final String? displayName;
  final List<FamilySummary> families;
  final List<ChildSummary> children;

  Json toJson() => {
    'user': {'id': userId, 'displayName': displayName},
    'families': [
      for (final family in families)
        {
          'id': family.id,
          'name': family.name,
          'timezone': family.timezone,
          'revision': family.revision,
          'members': [
            for (final member in family.members)
              {
                'userId': member.userId,
                'role': member.role,
                'active': member.active,
                'displayName': member.displayName,
                'familyId': member.familyId,
                'revision': member.revision,
              },
          ],
        },
    ],
    'children': [
      for (final child in children)
        {
          'id': child.id,
          'familyId': child.familyId,
          'displayName': child.displayName,
          'ageMode': child.ageMode,
          'ageMonths': child.ageMonths,
          'ageAsOf': child.ageAsOf?.toString(),
          'birthDate': child.birthDate?.toString(),
          'revision': child.revision,
        },
    ],
  };

  ChildSummary? get activeChild {
    if (children.isEmpty) return null;
    for (final child in children) {
      if (families.any((family) => family.id == child.familyId)) return child;
    }
    return children.first;
  }
}

class ReminderPreference {
  const ReminderPreference({
    required this.userId,
    required this.deviceId,
    required this.enabled,
    required this.localTime,
    required this.revision,
  });

  factory ReminderPreference.fromJson(Json json) => ReminderPreference(
    userId: json['userId'] as String,
    deviceId: json['deviceId'] as String?,
    enabled: json['enabled'] as bool,
    localTime: json['localTime'] as String,
    revision: json['revision'] as int,
  );

  final String userId;
  final String? deviceId;
  final bool enabled;
  final String localTime;
  final int revision;
}

class InvitationInfo {
  const InvitationInfo({
    required this.id,
    required this.token,
    required this.expiresAt,
  });

  factory InvitationInfo.fromJson(Json json) => InvitationInfo(
    id: json['id'] as String,
    token: json['invitationToken'] as String,
    expiresAt: DateTime.parse(json['expiresAt'] as String),
  );

  final String id;
  final String token;
  final DateTime expiresAt;
}

class MediaAsset {
  const MediaAsset({
    required this.id,
    required this.memoryId,
    required this.state,
    required this.mime,
    required this.byteSize,
    required this.sha256,
    this.downloadUrl,
    this.expiresAt,
  });

  factory MediaAsset.fromJson(Json json) => MediaAsset(
    id: json['id'] as String,
    memoryId: json['memoryId'] as String,
    state: json['state'] as String,
    mime: json['mime'] as String,
    byteSize: json['byteSize'] as int,
    sha256: json['sha256'] as String,
    downloadUrl: json['downloadUrl'] as String?,
    expiresAt: json['expiresAt'] == null
        ? null
        : DateTime.parse(json['expiresAt'] as String),
  );

  final String id;
  final String memoryId;
  final String state;
  final String mime;
  final int byteSize;
  final String sha256;
  final String? downloadUrl;
  final DateTime? expiresAt;

  bool get ready => state == 'ready';
  bool get failed => state == 'failed' || state == 'deleted';
}

class MediaUploadTicket {
  const MediaUploadTicket({
    required this.media,
    required this.uploadUrl,
    required this.expiresAt,
  });

  factory MediaUploadTicket.fromJson(Json json) => MediaUploadTicket(
    media: MediaAsset.fromJson(Map<String, dynamic>.from(json['media'] as Map)),
    uploadUrl: Uri.parse(json['uploadUrl'] as String),
    expiresAt: DateTime.parse(json['expiresAt'] as String),
  );

  final MediaAsset media;
  final Uri uploadUrl;
  final DateTime expiresAt;
}

class ExportArchive {
  const ExportArchive({
    required this.id,
    required this.status,
    required this.missingMedia,
    this.downloadUrl,
    this.expiresAt,
  });

  factory ExportArchive.fromJson(Json json) => ExportArchive(
    id: json['id'] as String,
    status: json['status'] as String,
    downloadUrl: json['downloadUrl'] as String?,
    expiresAt: json['expiresAt'] == null
        ? null
        : DateTime.parse(json['expiresAt'] as String),
    missingMedia: List.unmodifiable(
      (json['missingMedia'] as List? ?? const []).map(
        (item) => Map<String, dynamic>.from(item as Map),
      ),
    ),
  );

  final String id;
  final String status;
  final String? downloadUrl;
  final DateTime? expiresAt;
  final List<Json> missingMedia;
}

class FamilySnapshotData {
  const FamilySnapshotData({
    required this.cursor,
    required this.snapshotId,
    required this.memories,
    required this.measurements,
    required this.observations,
    this.children = const [],
    this.days = const [],
    this.sessions = const [],
    this.books = const [],
    this.media = const [],
    this.withdrawals = const [],
    this.family,
    this.preferences,
  });

  final String cursor;
  final String snapshotId;
  final List<Json> memories;
  final List<Json> measurements;
  final List<Json> observations;
  final List<Json> children;
  final List<Json> days;
  final List<Json> sessions;
  final List<Json> books;
  final List<Json> media;
  final List<Json> withdrawals;
  final Json? family;
  final Json? preferences;
}

class ContentSafetyData {
  const ContentSafetyData(this.activities, this.withdrawals);
  final List<Activity> activities;
  final List<Json> withdrawals;
}

class PendingOperation {
  const PendingOperation({
    required this.id,
    required this.familyId,
    required this.objectKey,
    required this.method,
    required this.path,
    required this.body,
    required this.localVersion,
    required this.attempts,
  });
  final String id;
  final String familyId;
  final String objectKey;
  final String method;
  final String path;
  final Json body;
  final int localVersion;
  final int attempts;
}

/// 本机尚未完成或需要家长选择的同步事项。
class SyncIssue {
  const SyncIssue({
    required this.operationId,
    required this.objectKey,
    required this.state,
    required this.code,
    required this.body,
    required this.conflict,
  });

  final String operationId;
  final String objectKey;
  final String state;
  final String? code;
  final Json body;
  final Json? conflict;

  bool get isConflict => state == 'conflict';
  String get localText {
    final note = body['note'] ?? body['text'] ?? body['mode'];
    return note is String ? note.trim() : '';
  }

  String get remoteText {
    final current = conflict?['current'];
    if (current is! Map) return '';
    final notes = current['notes'];
    if (notes is List && notes.isNotEmpty) {
      final last = notes.last;
      if (last is Map && last['text'] is String) {
        return (last['text'] as String).trim();
      }
    }
    final text = current['text'] ?? current['note'];
    return text is String ? text.trim() : '';
  }

  int? get remoteRevision {
    final details = conflict;
    if (details == null) return null;
    final currentRevision = details['currentRevision'];
    if (currentRevision is int) return currentRevision;
    final current = details['current'];
    if (current is int) return current;
    if (current is Map) {
      final revision = current['revision'];
      if (revision is int) return revision;
    }
    return null;
  }
}

enum SyncConflictResolution { keepRemote, keepLocal, keepBoth }

/// 合同 2026-11-13 的手机会话响应；令牌只交给安全存储适配器，禁止写本地业务库。
class MobileSession {
  MobileSession.fromJson(Json json)
    : userId = (json['user'] as Json)['id'] as String,
      displayName = (json['user'] as Json)['displayName'] as String?,
      sessionId = json['sessionId'] as String,
      accessToken = json['accessToken'] as String,
      refreshToken = json['refreshToken'] as String,
      expiresAt = DateTime.parse(json['expiresAt'] as String),
      refreshExpiresAt = DateTime.parse(json['refreshExpiresAt'] as String);
  final String userId;
  final String? displayName;
  final String sessionId;
  final String accessToken;
  final String refreshToken;
  final DateTime expiresAt;
  final DateTime refreshExpiresAt;
  @override
  String toString() => 'MobileSession(<redacted>)';
}
