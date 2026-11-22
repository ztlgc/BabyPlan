import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:uuid/uuid.dart';

import '../../app/app_controller.dart';
import '../../core/app_theme.dart';
import '../../core/family_date.dart';
import '../../domain/models.dart';
import '../../widgets/app_widgets.dart';

class GrowthPage extends StatefulWidget {
  const GrowthPage({required this.controller, super.key});

  final AppController controller;

  @override
  State<GrowthPage> createState() => _GrowthPageState();
}

class _GrowthPageState extends State<GrowthPage> {
  FamilyDate? _filterDate;
  GrowthRecordType? _filterType;

  AppController get controller => widget.controller;

  List<GrowthRecord> get _visibleRecords => controller.growthRecords
      .where(
        (record) =>
            (_filterDate == null || record.localDate == _filterDate) &&
            (_filterType == null || record.type == _filterType),
      )
      .toList(growable: false);

  Future<void> _pickFilterDate() async {
    final selected = await showDatePicker(
      context: context,
      initialDate: DateTime(
        (_filterDate ?? controller.today).year,
        (_filterDate ?? controller.today).month,
        (_filterDate ?? controller.today).day,
      ),
      firstDate: DateTime(controller.nowValue.year - 5),
      lastDate: controller.nowValue,
      helpText: '只看这一天的成长记录',
    );
    if (selected == null || !mounted) return;
    setState(
      () =>
          _filterDate = FamilyDate(selected.year, selected.month, selected.day),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, child) {
      final records = _visibleRecords;
      final deleted = controller.deletedGrowthRecords;
      return ListView(
        padding: EdgeInsets.zero,
        children: [
          ContentWidth(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                AppHeader(
                  eyebrow: '成长时光',
                  title: '把今天的小事留住',
                  description: '原话、第一次、观察和测量都可以慢慢记。没有记录也不代表少做了什么。',
                  trailing: IconButton.filledTonal(
                    tooltip: '添加成长记录',
                    onPressed: () => _openEditor(context),
                    icon: const Icon(Icons.add_rounded),
                  ),
                ),
                const SizedBox(height: 24),
                InfoBanner(
                  message: controller.api == null
                      ? '家庭服务未连接。这里新增的内容只保存在本机，会明确显示“待同步”。'
                      : '新增和更正都先保存在本机；只有家庭服务确认后才会显示已同步。',
                  icon: Icons.cloud_off_outlined,
                  tone: StatusTone.local,
                ),
                const SizedBox(height: 20),
                _GrowthFilters(
                  selectedDate: _filterDate,
                  selectedType: _filterType,
                  onPickDate: _pickFilterDate,
                  onClearDate: () => setState(() => _filterDate = null),
                  onTypeChanged: (value) => setState(() => _filterType = value),
                ),
                const SizedBox(height: 20),
                if (records.any(
                  (record) => record.type == GrowthRecordType.measurement,
                )) ...[
                  _MeasurementTrend(records: records),
                  const SizedBox(height: 24),
                ],
                SectionTitle(
                  '成长记录',
                  trailing: Text(
                    '${records.length} 条',
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                if (records.isEmpty)
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(26),
                      child: Column(
                        children: [
                          Icon(
                            Icons.auto_stories_outlined,
                            size: 42,
                            color: Theme.of(context).colorScheme.primary,
                          ),
                          const SizedBox(height: 14),
                          Text(
                            controller.growthRecords.isEmpty
                                ? '还没有成长记录'
                                : '这个筛选下没有记录',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 6),
                          Text(
                            controller.growthRecords.isEmpty
                                ? '可以记一句宝宝刚说的话，也可以只写一次今天注意到的小变化。'
                                : '换一个日期或类型，已经保存的记录仍在这里。',
                            textAlign: TextAlign.center,
                          ),
                          const SizedBox(height: 18),
                          FilledButton.icon(
                            onPressed: () => _openEditor(context),
                            icon: const Icon(Icons.edit_outlined),
                            label: const Text('写下一条'),
                          ),
                        ],
                      ),
                    ),
                  )
                else
                  for (final record in records) ...[
                    _GrowthRecordCard(
                      controller: controller,
                      record: record,
                      photos:
                          controller.growthPhotosByRecord[record.id] ??
                          const [],
                      onEdit: () => _openEditor(context, existing: record),
                      onDelete: () => _deleteRecord(context, record),
                    ),
                    const SizedBox(height: 12),
                  ],
                if (deleted.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  _GrowthTrash(
                    records: deleted,
                    onRestore: (record) => _restoreRecord(context, record),
                  ),
                ],
              ],
            ),
          ),
        ],
      );
    },
  );

  Future<void> _openEditor(BuildContext context, {GrowthRecord? existing}) =>
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        useSafeArea: true,
        builder: (context) =>
            GrowthEditorSheet(controller: controller, existing: existing),
      );

  Future<void> _deleteRecord(BuildContext context, GrowthRecord record) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('移到回收站？'),
        content: const Text('这条记录会先从成长列表移除，30 天内可以恢复。已经上传的照片不会出现在回收站列表里。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('移到回收站'),
          ),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;
    try {
      await controller.deleteGrowth(record);
      if (context.mounted) showQuietMessage(context, '已移到回收站，30 天内可以恢复。');
    } on Object catch (error) {
      if (context.mounted) showQuietMessage(context, _friendlyError(error));
    }
  }

  Future<void> _restoreRecord(BuildContext context, GrowthRecord record) async {
    try {
      await controller.restoreGrowth(record);
      if (context.mounted) showQuietMessage(context, '记录已恢复到成长列表。');
    } on Object catch (error) {
      if (context.mounted) showQuietMessage(context, _friendlyError(error));
    }
  }
}

class _GrowthFilters extends StatelessWidget {
  const _GrowthFilters({
    required this.selectedDate,
    required this.selectedType,
    required this.onPickDate,
    required this.onClearDate,
    required this.onTypeChanged,
  });

  final FamilyDate? selectedDate;
  final GrowthRecordType? selectedType;
  final VoidCallback onPickDate;
  final VoidCallback onClearDate;
  final ValueChanged<GrowthRecordType?> onTypeChanged;

  @override
  Widget build(BuildContext context) => Wrap(
    spacing: 8,
    runSpacing: 8,
    crossAxisAlignment: WrapCrossAlignment.center,
    children: [
      ActionChip(
        avatar: const Icon(Icons.calendar_month_outlined, size: 18),
        label: Text(
          selectedDate == null
              ? '全部日期'
              : '${selectedDate!.month}月${selectedDate!.day}日',
        ),
        onPressed: onPickDate,
      ),
      if (selectedDate != null)
        IconButton(
          tooltip: '清除日期筛选',
          onPressed: onClearDate,
          icon: const Icon(Icons.close_rounded),
        ),
      DropdownButton<String>(
        value: selectedType?.name ?? 'all',
        borderRadius: BorderRadius.circular(16),
        items: [
          const DropdownMenuItem(value: 'all', child: Text('全部类型')),
          for (final type in GrowthRecordType.values)
            DropdownMenuItem(
              value: type.name,
              child: Text(_growthTypeLabel(type)),
            ),
        ],
        onChanged: (value) => onTypeChanged(
          value == null || value == 'all'
              ? null
              : GrowthRecordType.values.byName(value),
        ),
      ),
    ],
  );
}

class _GrowthTrash extends StatelessWidget {
  const _GrowthTrash({required this.records, required this.onRestore});

  final List<GrowthRecord> records;
  final ValueChanged<GrowthRecord> onRestore;

  @override
  Widget build(BuildContext context) => Card(
    child: ExpansionTile(
      leading: const Icon(Icons.restore_from_trash_outlined),
      title: Text('回收站 · ${records.length} 条'),
      subtitle: const Text('软删除记录保留 30 天，可以在这里恢复。'),
      children: [
        for (final record in records)
          ListTile(
            contentPadding: const EdgeInsets.fromLTRB(18, 0, 10, 0),
            title: Text(_growthRecordSummary(record)),
            subtitle: Text(
              '${record.localDate.month}月${record.localDate.day}日 · ${_growthTypeLabel(record.type)}',
            ),
            trailing: TextButton.icon(
              onPressed: () => onRestore(record),
              icon: const Icon(Icons.restore_rounded),
              label: const Text('恢复'),
            ),
          ),
      ],
    ),
  );
}

String _growthTypeLabel(GrowthRecordType type) => switch (type) {
  GrowthRecordType.quote => '原话',
  GrowthRecordType.story => '小故事',
  GrowthRecordType.first => '第一次',
  GrowthRecordType.observation => '观察',
  GrowthRecordType.measurement => '测量',
};

String _growthRecordSummary(GrowthRecord record) {
  if (record.type == GrowthRecordType.measurement) {
    return '${record.value?.toStringAsFixed(1) ?? ''} ${record.unit ?? ''}';
  }
  return record.text.isEmpty ? _growthTypeLabel(record.type) : record.text;
}

String _friendlyError(Object error) =>
    error.toString().replaceFirst(RegExp(r'^[^:]+:\s*'), '');

enum _GrowthRecordAction { edit, delete }

class _MeasurementTrend extends StatelessWidget {
  const _MeasurementTrend({required this.records});
  final List<GrowthRecord> records;

  @override
  Widget build(BuildContext context) {
    final groups = <String, List<GrowthRecord>>{};
    for (final record in records.where(
      (record) => record.type == GrowthRecordType.measurement,
    )) {
      final label = switch (record.measurementMethod) {
        GrowthMeasurementMethod.recumbent => '卧位身长',
        GrowthMeasurementMethod.standing => '站立身高',
        GrowthMeasurementMethod.scale => '体重',
        null => record.unit == 'kg' ? '体重（方式未记录）' : '身高（方式未记录）',
      };
      groups.putIfAbsent(label, () => []).add(record);
    }
    if (groups.isEmpty) return const SizedBox.shrink();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('测量记录', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 5),
            Text(
              '按真实日期和测量方式分开显示；只有一次记录时只显示一个点，不推测百分位。',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            for (final entry in groups.entries) ...[
              const SizedBox(height: 16),
              _MeasurementSeries(label: entry.key, records: entry.value),
            ],
          ],
        ),
      ),
    );
  }
}

class _MeasurementSeries extends StatelessWidget {
  const _MeasurementSeries({required this.label, required this.records});
  final String label;
  final List<GrowthRecord> records;

  @override
  Widget build(BuildContext context) {
    final ordered = [...records]
      ..sort((left, right) {
        final byDate = left.localDate.compareTo(right.localDate);
        return byDate != 0 ? byDate : left.createdAt.compareTo(right.createdAt);
      });
    final latest = ordered.last;
    return Semantics(
      label:
          '$label，共 ${ordered.length} 次，最近 ${latest.value?.toStringAsFixed(1)} ${latest.unit}',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  label,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              Text(
                '${latest.value?.toStringAsFixed(1)} ${latest.unit}',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ],
          ),
          const SizedBox(height: 2),
          Text(
            ordered.length == 1 ? '只有 1 次记录，因此不连线' : '共 ${ordered.length} 次记录',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            height: 72,
            child: CustomPaint(
              painter: _MeasurementSparklinePainter(
                values: ordered
                    .map((record) => record.value ?? 0)
                    .toList(growable: false),
                dates: ordered
                    .map((record) => record.localDate)
                    .toList(growable: false),
                color: Theme.of(context).colorScheme.primary,
                gridColor: Theme.of(context).colorScheme.outlineVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _MeasurementSparklinePainter extends CustomPainter {
  _MeasurementSparklinePainter({
    required this.values,
    required this.dates,
    required this.color,
    required this.gridColor,
  });

  final List<double> values;
  final List<FamilyDate> dates;
  final Color color;
  final Color gridColor;

  @override
  void paint(Canvas canvas, Size size) {
    if (values.isEmpty || values.length != dates.length) return;
    final graph = Rect.fromLTWH(6, 8, size.width - 12, size.height - 18);
    canvas.drawLine(
      Offset(graph.left, graph.bottom),
      Offset(graph.right, graph.bottom),
      Paint()
        ..color = gridColor
        ..strokeWidth = 1,
    );
    var minimum = values.reduce((left, right) => left < right ? left : right);
    var maximum = values.reduce((left, right) => left > right ? left : right);
    if ((maximum - minimum).abs() < 0.0001) {
      minimum -= 1;
      maximum += 1;
    } else {
      final padding = (maximum - minimum) * 0.15;
      minimum -= padding;
      maximum += padding;
    }
    final ordinals = dates.map(_dateOrdinal).toList(growable: false);
    final firstDate = ordinals.first;
    final lastDate = ordinals.last;
    final span = lastDate - firstDate;
    final points = <Offset>[
      for (var index = 0; index < values.length; index++)
        Offset(
          span == 0
              ? graph.center.dx
              : graph.left + graph.width * (ordinals[index] - firstDate) / span,
          graph.bottom -
              graph.height * (values[index] - minimum) / (maximum - minimum),
        ),
    ];
    if (points.length > 1) {
      final path = Path()..moveTo(points.first.dx, points.first.dy);
      for (final point in points.skip(1)) {
        path.lineTo(point.dx, point.dy);
      }
      canvas.drawPath(
        path,
        Paint()
          ..color = color.withValues(alpha: 0.7)
          ..strokeWidth = 2
          ..style = PaintingStyle.stroke
          ..strokeCap = StrokeCap.round,
      );
    }
    for (final point in points) {
      canvas.drawCircle(point, 4, Paint()..color = color);
    }
  }

  static int _dateOrdinal(FamilyDate date) =>
      DateTime.utc(date.year, date.month, date.day).millisecondsSinceEpoch ~/
      Duration.millisecondsPerDay;

  @override
  bool shouldRepaint(covariant _MeasurementSparklinePainter oldDelegate) =>
      oldDelegate.values != values ||
      oldDelegate.dates != dates ||
      oldDelegate.color != color ||
      oldDelegate.gridColor != gridColor;
}

class _GrowthRecordCard extends StatelessWidget {
  const _GrowthRecordCard({
    required this.controller,
    required this.record,
    required this.photos,
    required this.onEdit,
    required this.onDelete,
  });
  final AppController controller;
  final GrowthRecord record;
  final List<GrowthPhotoUpload> photos;
  final VoidCallback onEdit;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final (label, icon) = switch (record.type) {
      GrowthRecordType.quote => ('原话', Icons.format_quote_rounded),
      GrowthRecordType.story => ('小故事', Icons.auto_stories_outlined),
      GrowthRecordType.first => ('第一次', Icons.star_border_rounded),
      GrowthRecordType.observation => ('观察', Icons.visibility_outlined),
      GrowthRecordType.measurement => ('测量', Icons.straighten_rounded),
    };
    final measurementLabel = switch (record.measurementKind) {
      GrowthMeasurementKind.height => '身高',
      GrowthMeasurementKind.weight => '体重',
      null => record.unit == 'kg' ? '体重' : '身高',
    };
    final methodLabel = switch (record.measurementMethod) {
      GrowthMeasurementMethod.recumbent => '卧位身长',
      GrowthMeasurementMethod.standing => '站立身高',
      GrowthMeasurementMethod.scale => '体重秤',
      null => '测量方式未记录',
    };
    final sourceLabel = switch (record.measurementSource) {
      GrowthMeasurementSource.home => '家中测量',
      GrowthMeasurementSource.clinic => '体检机构',
      null => '来源未记录',
    };
    final visiblePhotos = photos
        .where((photo) => photo.state != 'removed')
        .toList(growable: false);
    final linkedLocalIds = {
      for (final photo in visiblePhotos)
        if (photo.state == 'linked' && photo.serverMediaId != null)
          photo.serverMediaId!,
    };
    final remoteOnly = record.mediaIds
        .where((id) => !linkedLocalIds.contains(id))
        .toList(growable: false);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 20),
                const SizedBox(width: 7),
                Text(label, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(width: 10),
                Text(
                  '${record.localDate.month}月${record.localDate.day}日',
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
                const Spacer(),
                PopupMenuButton<_GrowthRecordAction>(
                  tooltip: '记录操作',
                  onSelected: (value) {
                    if (value == _GrowthRecordAction.edit) {
                      onEdit();
                    } else {
                      onDelete();
                    }
                  },
                  itemBuilder: (context) => const [
                    PopupMenuItem(
                      value: _GrowthRecordAction.edit,
                      child: ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(Icons.edit_outlined),
                        title: Text('更正这条记录'),
                      ),
                    ),
                    PopupMenuItem(
                      value: _GrowthRecordAction.delete,
                      child: ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(Icons.delete_outline_rounded),
                        title: Text('移到回收站'),
                      ),
                    ),
                  ],
                ),
                StatusPill(
                  label: record.syncState == 'synced' ? '正文已同步' : '正文待同步',
                  icon: record.syncState == 'synced'
                      ? Icons.cloud_done_outlined
                      : Icons.cloud_upload_outlined,
                  tone: record.syncState == 'synced'
                      ? StatusTone.pending
                      : StatusTone.local,
                ),
              ],
            ),
            const SizedBox(height: 12),
            if (record.type == GrowthRecordType.measurement)
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '$measurementLabel ${record.value?.toStringAsFixed(1) ?? ''} ${record.unit ?? ''}',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '$methodLabel · $sourceLabel',
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            if (record.text.isNotEmpty) ...[
              if (record.type == GrowthRecordType.measurement)
                const SizedBox(height: 5),
              Text(record.text),
            ],
            if (visiblePhotos.isNotEmpty) ...[
              const SizedBox(height: 14),
              SizedBox(
                height: 126,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: visiblePhotos.length,
                  separatorBuilder: (context, index) =>
                      const SizedBox(width: 10),
                  itemBuilder: (context, index) => _LocalPhotoTile(
                    controller: controller,
                    photo: visiblePhotos[index],
                  ),
                ),
              ),
            ],
            if (remoteOnly.isNotEmpty) ...[
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: () => _openRemotePhoto(context, remoteOnly.first),
                icon: const Icon(Icons.photo_outlined),
                label: Text('查看家庭照片（${remoteOnly.length} 张）'),
              ),
            ],
            if (visiblePhotos.any(
              (photo) =>
                  photo.errorCode != null ||
                  photo.state == 'upload_failed' ||
                  photo.state == 'link_failed',
            )) ...[
              const SizedBox(height: 8),
              const Text('正文已经保留。照片可以单独重试或移除，失败不会改动正文。'),
            ],
          ],
        ),
      ),
    );
  }

  Future<void> _openRemotePhoto(BuildContext context, String mediaId) async {
    try {
      final url = await controller.mediaViewLink(mediaId);
      if (!context.mounted) return;
      if (url == null) {
        showQuietMessage(context, '这张照片还在处理中，暂时不能查看。');
        return;
      }
      await showDialog<void>(
        context: context,
        builder: (context) => Dialog(
          clipBehavior: Clip.antiAlias,
          child: InteractiveViewer(
            minScale: 1,
            maxScale: 4,
            child: Image.network(url, fit: BoxFit.contain),
          ),
        ),
      );
    } on Object catch (error) {
      if (context.mounted) showQuietMessage(context, '$error');
    }
  }
}

class _LocalPhotoTile extends StatelessWidget {
  const _LocalPhotoTile({required this.controller, required this.photo});
  final AppController controller;
  final GrowthPhotoUpload photo;

  @override
  Widget build(BuildContext context) {
    final file = File(photo.localPath);
    final status = switch (photo.state) {
      'linked' => '已同步',
      'ready' => '等待关联',
      'processing' => '处理中',
      'upload_failed' => '待重试',
      'link_failed' => '关联待重试',
      'failed' => '未上传',
      _ => '保存在本机',
    };
    return SizedBox(
      width: 108,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: file.existsSync()
                  ? Image.file(file, fit: BoxFit.cover)
                  : ColoredBox(
                      color: Theme.of(context)
                          .colorScheme
                          .surfaceContainerHighest,
                      child: const Icon(Icons.broken_image_outlined),
                    ),
            ),
          ),
          const SizedBox(height: 5),
          Text(
            status,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.labelSmall,
          ),
          if (photo.state == 'upload_failed' ||
              photo.state == 'link_failed' ||
              photo.state == 'failed')
            TextButton(
              onPressed: controller.photoSyncBusy
                  ? null
                  : () async {
                      try {
                        await controller.retryGrowthPhoto(photo.id);
                      } on Object catch (error) {
                        if (context.mounted) {
                          showQuietMessage(context, '$error');
                        }
                      }
                    },
              child: const Text('重试'),
            )
          else if (photo.state != 'linked' && photo.state != 'removed')
            TextButton(
              onPressed: () async {
                try {
                  await controller.removeGrowthPhoto(photo.id);
                } on Object catch (error) {
                  if (context.mounted) showQuietMessage(context, '$error');
                }
              },
              child: const Text('移除'),
            ),
        ],
      ),
    );
  }
}

class GrowthEditorSheet extends StatefulWidget {
  const GrowthEditorSheet({required this.controller, this.existing, super.key});
  final AppController controller;
  final GrowthRecord? existing;

  @override
  State<GrowthEditorSheet> createState() => _GrowthEditorSheetState();
}

class _GrowthEditorSheetState extends State<GrowthEditorSheet> {
  static const _observationGuides = {
    'stage-18-23-movement': '身体与行动',
    'stage-18-23-language': '语言与互动',
    'stage-18-23-explore': '动手与探索',
  };
  static const _observationValues = {
    'noticed': '已经留意到了',
    'not_yet_observed': '还没留意到',
    'discuss': '想以后再聊聊',
  };
  GrowthRecordType _type = GrowthRecordType.quote;
  late FamilyDate _date;
  final _text = TextEditingController();
  final _value = TextEditingController();
  String _unit = 'cm';
  GrowthMeasurementKind _measurementKind = GrowthMeasurementKind.height;
  GrowthMeasurementMethod _measurementMethod =
      GrowthMeasurementMethod.recumbent;
  GrowthMeasurementSource _measurementSource = GrowthMeasurementSource.home;
  String _guideId = _observationGuides.keys.first;
  String _observationValue = 'discuss';
  bool _firstConfirmed = false;
  bool _saving = false;
  bool _saved = false;
  bool _restoringDraft = true;
  late String _draftId = const Uuid().v4();
  final _photos = <PreparedGrowthPhoto>[];
  final _imagePicker = ImagePicker();
  Timer? _draftTimer;
  Future<void> _draftWrite = Future<void>.value();
  String? _error;
  bool get _editing => widget.existing != null;

  @override
  void initState() {
    super.initState();
    _date = widget.controller.today;
    final existing = widget.existing;
    if (existing != null) {
      _type = existing.type;
      _date = existing.localDate;
      _text.text = existing.text;
      _value.text = existing.value?.toString() ?? '';
      _unit = existing.unit ?? _unit;
      _measurementKind = existing.measurementKind ?? _measurementKind;
      _measurementMethod = existing.measurementMethod ?? _measurementMethod;
      _measurementSource = existing.measurementSource ?? _measurementSource;
      _guideId = existing.guideId ?? _guideId;
      _observationValue = existing.observationValue ?? _observationValue;
      _firstConfirmed = existing.firstConfirmed;
      _restoringDraft = false;
    }
    _text.addListener(_scheduleDraftSave);
    _value.addListener(_scheduleDraftSave);
    if (existing == null) {
      unawaited(_restoreDraft().then((_) => _recoverLostPhotoSelection()));
    }
  }

  @override
  void dispose() {
    _draftTimer?.cancel();
    if (!_editing && !_saved && !_restoringDraft) {
      unawaited(_enqueueDraftWrite());
    }
    _text.removeListener(_scheduleDraftSave);
    _value.removeListener(_scheduleDraftSave);
    _text.dispose();
    _value.dispose();
    super.dispose();
  }

  Future<void> _restoreDraft() async {
    try {
      final draft = await widget.controller.readGrowthDraft();
      if (!mounted) return;
      if (draft != null) {
        final storedId = draft['draftId'];
        if (storedId is String && storedId.isNotEmpty) _draftId = storedId;
        final type = _growthEnumByName(GrowthRecordType.values, draft['type']);
        final kind = _growthEnumByName(
          GrowthMeasurementKind.values,
          draft['measurementKind'],
        );
        final method = _growthEnumByName(
          GrowthMeasurementMethod.values,
          draft['measurementMethod'],
        );
        final source = _growthEnumByName(
          GrowthMeasurementSource.values,
          draft['measurementSource'],
        );
        final restoredPhotos = <PreparedGrowthPhoto>[];
        final photos = draft['photos'];
        if (photos is List) {
          for (final item in photos) {
            if (item is! Map) continue;
            final path = item['localPath'];
            final mime = item['mime'];
            final byteSize = item['byteSize'];
            final sha256 = item['sha256'];
            if (path is! String ||
                mime is! String ||
                byteSize is! int ||
                sha256 is! String ||
                !File(path).existsSync()) {
              continue;
            }
            restoredPhotos.add(
              PreparedGrowthPhoto(
                localPath: path,
                mime: mime,
                byteSize: byteSize,
                sha256: sha256,
              ),
            );
          }
        }
        setState(() {
          if (type != null) _type = type;
          final localDate = draft['localDate'];
          if (localDate is String) {
            _date = FamilyDate.parse(localDate);
          }
          _text.text = draft['text'] as String? ?? '';
          _value.text = draft['value'] as String? ?? '';
          _unit = draft['unit'] as String? ?? _unit;
          _measurementKind = kind ?? _measurementKind;
          _measurementMethod = method ?? _measurementMethod;
          _measurementSource = source ?? _measurementSource;
          _guideId = draft['guideId'] as String? ?? _guideId;
          _observationValue =
              draft['observationValue'] as String? ?? _observationValue;
          _firstConfirmed = draft['firstConfirmed'] == true;
          _photos
            ..clear()
            ..addAll(restoredPhotos);
          _error = null;
        });
      }
    } on Object {
      // 草稿损坏时仍允许重新填写，不阻断新增成长记录。
    } finally {
      if (mounted) setState(() => _restoringDraft = false);
    }
  }

  void _scheduleDraftSave() {
    if (_editing || _restoringDraft || _saved) return;
    _draftTimer?.cancel();
    _draftTimer = Timer(const Duration(milliseconds: 350), () {
      unawaited(_enqueueDraftWrite());
    });
  }

  bool get _hasDraftContent =>
      _text.text.trim().isNotEmpty ||
      _value.text.trim().isNotEmpty ||
      _photos.isNotEmpty ||
      _firstConfirmed ||
      _type != GrowthRecordType.quote ||
      _guideId != _observationGuides.keys.first ||
      _observationValue != 'discuss' ||
      _measurementSource != GrowthMeasurementSource.home;

  Future<void> _enqueueDraftWrite() {
    if (_editing || _saved || _restoringDraft) return Future<void>.value();
    final body = _hasDraftContent
        ? <String, dynamic>{
            'draftId': _draftId,
            'type': _type.name,
            'localDate': _date.toString(),
            'text': _text.text,
            'value': _value.text,
            'unit': _unit,
            'measurementKind': _measurementKind.name,
            'measurementMethod': _measurementMethod.name,
            'measurementSource': _measurementSource.name,
            'guideId': _guideId,
            'observationValue': _observationValue,
            'firstConfirmed': _firstConfirmed,
            'photos': _photos
                .map(
                  (photo) => {
                    'localPath': photo.localPath,
                    'mime': photo.mime,
                    'byteSize': photo.byteSize,
                    'sha256': photo.sha256,
                  },
                )
                .toList(growable: false),
          }
        : null;
    _draftWrite = _draftWrite
        .catchError((Object _) {
          // 前一次草稿写入失败不阻断下一次，也不覆盖正文编辑。
        })
        .then((_) async {
          if (_saved) return;
          if (body == null) {
            await widget.controller.deleteGrowthDraft();
          } else {
            await widget.controller.saveGrowthDraft(body);
          }
        });
    return _draftWrite;
  }

  Future<void> _discardDraftPhoto(PreparedGrowthPhoto photo) async {
    try {
      await widget.controller.growthFiles.deletePhoto(photo.localPath);
    } on Object {
      // 私有草稿清理失败不能覆盖家长正文。
    }
  }

  Future<void> _clearDraftPhotos() async {
    final old = List<PreparedGrowthPhoto>.from(_photos);
    setState(_photos.clear);
    _scheduleDraftSave();
    for (final photo in old) {
      await _discardDraftPhoto(photo);
    }
  }

  Future<void> _removeDraftPhoto(int index) async {
    if (index < 0 || index >= _photos.length) return;
    final photo = _photos[index];
    setState(() => _photos.removeAt(index));
    _scheduleDraftSave();
    await _discardDraftPhoto(photo);
  }

  Future<void> _pickDate() async {
    final selected = await showDatePicker(
      context: context,
      initialDate: DateTime(_date.year, _date.month, _date.day),
      firstDate: DateTime(_date.year - 3),
      lastDate: widget.controller.nowValue,
      helpText: '选择记录日期',
    );
    if (selected != null) {
      setState(
        () => _date = FamilyDate(selected.year, selected.month, selected.day),
      );
      _scheduleDraftSave();
    }
  }

  Future<void> _pickPhotos() async {
    final remaining = 5 - _photos.length;
    if (remaining <= 0) {
      setState(() => _error = '一条记录最多保存 5 张照片。');
      return;
    }
    try {
      final selected = await _imagePicker.pickMultiImage(
        limit: remaining,
        requestFullMetadata: false,
      );
      await _importSelectedPhotos(selected);
    } on Object {
      if (mounted) {
        setState(() => _error = '没有打开系统照片选择器，请检查系统权限后重试。');
      }
    }
  }

  Future<void> _recoverLostPhotoSelection() async {
    if (!Platform.isAndroid || !mounted) return;
    try {
      final lost = await _imagePicker.retrieveLostData();
      if (lost.isEmpty || !mounted) return;
      if (lost.exception != null) {
        setState(
          () => _error = (lost.exception!.message ?? '').isEmpty
              ? '系统没能恢复刚才选择的照片。正文仍保留，可以重新选择。'
              : '系统没能恢复刚才选择的照片：${lost.exception!.message}',
        );
        return;
      }
      await _importSelectedPhotos(
        lost.files ?? [if (lost.file != null) lost.file!],
      );
    } on Object {
      if (mounted) {
        setState(() => _error = '系统照片选择结果没有恢复成功；正文仍保留，可以重新选择。');
      }
    }
  }

  Future<void> _importSelectedPhotos(List<XFile> selected) async {
    if (selected.isEmpty || !mounted) return;
    final remaining = 5 - _photos.length;
    if (remaining <= 0) return;
    try {
      final copied = await widget.controller.growthFiles.copyPhotos(
        familyId: widget.controller.familyId,
        childId: widget.controller.childId,
        recordId: 'draft-$_draftId',
        sourcePaths: selected
            .take(remaining)
            .map((photo) => photo.path)
            .toList(growable: false),
      );
      if (!mounted) {
        for (final photo in copied) {
          await _discardDraftPhoto(photo);
        }
        return;
      }
      setState(() {
        _photos.addAll(copied.take(remaining));
        _error = null;
      });
      _scheduleDraftSave();
    } on Object {
      if (mounted) {
        setState(() => _error = '选择的照片保存到本机失败，正文没有被改动。可以重新选择。');
      }
    }
  }

  Future<void> _save() async {
    if (_saving) return;
    if (_type == GrowthRecordType.first && !_firstConfirmed) {
      setState(() => _error = '请确认这确实是宝宝第一次做到，再保存。');
      return;
    }
    final measurement = _type == GrowthRecordType.measurement;
    final value = measurement ? double.tryParse(_value.text.trim()) : null;
    if (measurement && (value == null || value <= 0)) {
      setState(() => _error = '请填写大于 0 的测量数值。');
      return;
    }
    if (!measurement && _text.text.trim().isEmpty) {
      setState(() => _error = '请先写下一句话。');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final existing = widget.existing;
      final GrowthSaveResult? result;
      if (existing == null) {
        result = await widget.controller.addGrowth(
          type: _type,
          date: _date,
          text: _text.text.trim(),
          photoPaths: _photos
              .map((photo) => photo.localPath)
              .toList(growable: false),
          value: value,
          unit: measurement ? _unit : null,
          measurementKind: measurement ? _measurementKind : null,
          measurementMethod: measurement ? _measurementMethod : null,
          measurementSource: measurement ? _measurementSource : null,
          firstConfirmed: _firstConfirmed,
          guideId: _type == GrowthRecordType.observation ? _guideId : null,
          observationValue: _type == GrowthRecordType.observation
              ? _observationValue
              : null,
        );
      } else {
        await widget.controller.updateGrowth(
          record: existing,
          date: _date,
          text: _text.text.trim(),
          value: value,
          unit: measurement ? _unit : null,
          measurementKind: measurement ? _measurementKind : null,
          measurementMethod: measurement ? _measurementMethod : null,
          measurementSource: measurement ? _measurementSource : null,
          firstConfirmed: _firstConfirmed,
          guideId: _type == GrowthRecordType.observation ? _guideId : null,
          observationValue: _type == GrowthRecordType.observation
              ? _observationValue
              : null,
        );
        result = null;
      }
      if (!mounted) return;
      _saved = true;
      _draftTimer?.cancel();
      if (existing == null) {
        await _draftWrite.catchError((Object _) {
          // 正式内容已经写入，草稿清理失败不影响保存结果。
        });
        try {
          await widget.controller.deleteGrowthDraft();
        } on Object {
          // 正式记录已经保存；遗留草稿不会覆盖或回滚它。
        }
        for (final photo in _photos) {
          await _discardDraftPhoto(photo);
        }
      }
      if (!mounted) return;
      final messenger = ScaffoldMessenger.of(context);
      Navigator.of(context).pop();
      final message = existing != null
          ? '更正已保存在本机；家庭服务确认后会更新其他设备。'
          : result!.photoError != null
          ? '正文已保存在本机。照片没有保存成功：${result.photoError}'
          : result.photoCount > 0
          ? '正文和照片副本已保存在本机；照片会独立上传。'
          : '正文已保存在本机，并显示为待同步。';
      messenger.showSnackBar(SnackBar(content: Text(message)));
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = error.toString().replaceFirst(RegExp(r'^[^:]+:\s*'), '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final measurement = _type == GrowthRecordType.measurement;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        20,
        12,
        20,
        20 + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 42,
                height: 4,
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.outline,
                  borderRadius: BorderRadius.circular(99),
                ),
              ),
            ),
            const SizedBox(height: 20),
            Text(
              _editing ? '更正成长记录' : '添加成长记录',
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            if (_editing) ...[
              const SizedBox(height: 5),
              Text(
                '记录类型保持不变；修改会先保存在本机，再同步给其他设备。',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ],
            const SizedBox(height: 18),
            DropdownButtonFormField<GrowthRecordType>(
              initialValue: _type,
              decoration: const InputDecoration(labelText: '记录什么'),
              items: const [
                DropdownMenuItem(
                  value: GrowthRecordType.quote,
                  child: Text('原话'),
                ),
                DropdownMenuItem(
                  value: GrowthRecordType.story,
                  child: Text('小故事'),
                ),
                DropdownMenuItem(
                  value: GrowthRecordType.first,
                  child: Text('第一次'),
                ),
                DropdownMenuItem(
                  value: GrowthRecordType.observation,
                  child: Text('日常观察'),
                ),
                DropdownMenuItem(
                  value: GrowthRecordType.measurement,
                  child: Text('身高 / 体重'),
                ),
              ],
              onChanged: _saving || _editing
                  ? null
                  : (value) {
                      if (value != null) {
                        setState(() {
                          _type = value;
                        });
                        if (value == GrowthRecordType.measurement ||
                            value == GrowthRecordType.observation) {
                          unawaited(_clearDraftPhotos());
                        } else {
                          _scheduleDraftSave();
                        }
                      }
                    },
            ),
            const SizedBox(height: 14),
            if (_type == GrowthRecordType.observation) ...[
              DropdownButtonFormField<String>(
                initialValue: _guideId,
                decoration: const InputDecoration(labelText: '看哪一类成长线索'),
                items: [
                  for (final entry in _observationGuides.entries)
                    DropdownMenuItem(
                      value: entry.key,
                      child: Text(entry.value),
                    ),
                ],
                onChanged: _saving
                    ? null
                    : (value) {
                        if (value != null) {
                          setState(() => _guideId = value);
                          _scheduleDraftSave();
                        }
                      },
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                initialValue: _observationValue,
                decoration: const InputDecoration(labelText: '这次观察'),
                items: [
                  for (final entry in _observationValues.entries)
                    DropdownMenuItem(
                      value: entry.key,
                      child: Text(entry.value),
                    ),
                ],
                onChanged: _saving
                    ? null
                    : (value) {
                        if (value != null) {
                          setState(() => _observationValue = value);
                          _scheduleDraftSave();
                        }
                      },
              ),
              const SizedBox(height: 14),
            ],
            OutlinedButton.icon(
              onPressed: _saving ? null : _pickDate,
              icon: const Icon(Icons.calendar_today_outlined),
              label: Text('${_date.year}年${_date.month}月${_date.day}日'),
            ),
            if (measurement) ...[
              const SizedBox(height: 14),
              DropdownButtonFormField<GrowthMeasurementKind>(
                initialValue: _measurementKind,
                decoration: const InputDecoration(labelText: '测量项目'),
                items: const [
                  DropdownMenuItem(
                    value: GrowthMeasurementKind.height,
                    child: Text('身长 / 身高'),
                  ),
                  DropdownMenuItem(
                    value: GrowthMeasurementKind.weight,
                    child: Text('体重'),
                  ),
                ],
                onChanged: _saving
                    ? null
                    : (value) {
                        if (value == null) return;
                        setState(() {
                          _measurementKind = value;
                          _measurementMethod =
                              value == GrowthMeasurementKind.height
                              ? GrowthMeasurementMethod.recumbent
                              : GrowthMeasurementMethod.scale;
                          _unit = value == GrowthMeasurementKind.height
                              ? 'cm'
                              : 'kg';
                        });
                        _scheduleDraftSave();
                      },
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<GrowthMeasurementMethod>(
                key: ValueKey(_measurementKind),
                initialValue: _measurementMethod,
                decoration: const InputDecoration(labelText: '测量方式'),
                items: _measurementKind == GrowthMeasurementKind.height
                    ? const [
                        DropdownMenuItem(
                          value: GrowthMeasurementMethod.recumbent,
                          child: Text('卧位身长'),
                        ),
                        DropdownMenuItem(
                          value: GrowthMeasurementMethod.standing,
                          child: Text('站立身高'),
                        ),
                      ]
                    : const [
                        DropdownMenuItem(
                          value: GrowthMeasurementMethod.scale,
                          child: Text('体重秤'),
                        ),
                      ],
                onChanged: _saving
                    ? null
                    : (value) {
                        if (value != null) {
                          setState(() => _measurementMethod = value);
                          _scheduleDraftSave();
                        }
                      },
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<GrowthMeasurementSource>(
                initialValue: _measurementSource,
                decoration: const InputDecoration(labelText: '在哪里测量'),
                items: const [
                  DropdownMenuItem(
                    value: GrowthMeasurementSource.home,
                    child: Text('家中测量'),
                  ),
                  DropdownMenuItem(
                    value: GrowthMeasurementSource.clinic,
                    child: Text('体检机构'),
                  ),
                ],
                onChanged: _saving
                    ? null
                    : (value) {
                        if (value != null) {
                          setState(() => _measurementSource = value);
                          _scheduleDraftSave();
                        }
                      },
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _value,
                enabled: !_saving,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                inputFormatters: [
                  FilteringTextInputFormatter.allow(
                    RegExp(r'^\d{0,3}(\.\d{0,2})?'),
                  ),
                ],
                decoration: InputDecoration(
                  labelText: '数值',
                  hintText:
                      '例如 ${_measurementKind == GrowthMeasurementKind.height ? '82.5' : '10.4'}',
                  suffixText: _unit == 'cm' ? '厘米' : '公斤',
                  helperText: '原始单位和测量方式都会保存，不会被自动转换。',
                ),
              ),
            ],
            const SizedBox(height: 14),
            TextField(
              controller: _text,
              enabled: !_saving,
              minLines: measurement ? 1 : 3,
              maxLines: measurement ? 3 : 6,
              maxLength: 2000,
              decoration: InputDecoration(
                labelText: measurement ? '备注（可选）' : '写下来',
                hintText: switch (_type) {
                  GrowthRecordType.quote => '宝宝说了什么？',
                  GrowthRecordType.first => '第一次发生了什么？',
                  GrowthRecordType.observation => '你看到了什么？',
                  GrowthRecordType.measurement => '测量方式或其他说明',
                  _ => '今天发生的一件小事',
                },
              ),
            ),
            if (_editing &&
                (_type == GrowthRecordType.quote ||
                    _type == GrowthRecordType.story ||
                    _type == GrowthRecordType.first)) ...[
              const SizedBox(height: 8),
              const Text('更正文字不会覆盖已经上传的照片；照片可在成长记录卡片中单独处理。'),
            ],
            if (!_editing &&
                (_type == GrowthRecordType.quote ||
                    _type == GrowthRecordType.story ||
                    _type == GrowthRecordType.first)) ...[
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: _saving ? null : _pickPhotos,
                icon: const Icon(Icons.add_photo_alternate_outlined),
                label: Text(
                  _photos.isEmpty
                      ? '从系统相册添加照片（可选）'
                      : '再选照片（${_photos.length}/5）',
                ),
              ),
              if (_photos.isNotEmpty) ...[
                const SizedBox(height: 10),
                SizedBox(
                  height: 96,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: _photos.length,
                    separatorBuilder: (context, index) =>
                        const SizedBox(width: 8),
                    itemBuilder: (context, index) {
                      final photo = _photos[index];
                      return Stack(
                        children: [
                          ClipRRect(
                            borderRadius: BorderRadius.circular(12),
                            child: Image.file(
                              File(photo.localPath),
                              width: 96,
                              height: 96,
                              fit: BoxFit.cover,
                            ),
                          ),
                          Positioned(
                            right: 2,
                            top: 2,
                            child: IconButton.filledTonal(
                              visualDensity: VisualDensity.compact,
                              tooltip: '移除这张照片',
                              onPressed: _saving
                                  ? null
                                  : () => unawaited(_removeDraftPhoto(index)),
                              icon: const Icon(Icons.close_rounded, size: 16),
                            ),
                          ),
                        ],
                      );
                    },
                  ),
                ),
                const Text('系统只读取你主动选择的照片。正文先保存；照片未就绪时会单独显示状态。'),
              ],
            ],
            if (_type == GrowthRecordType.first) ...[
              const SizedBox(height: 8),
              CheckboxListTile(
                value: _firstConfirmed,
                onChanged: _saving
                    ? null
                    : (value) => setState(() {
                        _firstConfirmed = value ?? false;
                        _scheduleDraftSave();
                      }),
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                title: const Text('我确认这是宝宝第一次做到'),
                subtitle: const Text('成长记录不会从其他活动自动生成。'),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 10),
              InfoBanner(
                message: _error!,
                tone: StatusTone.warning,
                icon: Icons.error_outline_rounded,
              ),
            ],
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: _saving ? null : _save,
              icon: _saving
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.save_outlined),
              label: Text(
                _saving
                    ? '正在保存…'
                    : _editing
                    ? '保存更正'
                    : '保存在本机',
              ),
            ),
          ],
        ),
      ),
    );
  }
}

T? _growthEnumByName<T extends Enum>(List<T> values, Object? value) {
  if (value is! String) return null;
  for (final item in values) {
    if (item.name == value) return item;
  }
  return null;
}
