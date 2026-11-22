import 'package:flutter/material.dart';

import '../../app/app_controller.dart';
import '../../core/app_theme.dart';
import '../../core/family_date.dart';
import '../../domain/models.dart';
import '../../widgets/app_widgets.dart';

Future<void> showExportSheet(BuildContext context, AppController controller) =>
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (context) => ExportSheet(controller: controller),
    );

class ExportSheet extends StatefulWidget {
  const ExportSheet({required this.controller, super.key});
  final AppController controller;

  @override
  State<ExportSheet> createState() => _ExportSheetState();
}

class _ExportSheetState extends State<ExportSheet> {
  late FamilyDate _from;
  late FamilyDate _to;
  final Set<String> _types = {'memories', 'measurements', 'sessions', 'plans'};
  bool _includeMedia = true;
  bool _busy = false;
  String? _error;
  ExportArchive? _archive;

  @override
  void initState() {
    super.initState();
    _to = widget.controller.today;
    _from = _to.addDays(-29);
  }

  Future<void> _pickDate(bool start) async {
    final selected = await showDatePicker(
      context: context,
      initialDate: DateTime(
        (start ? _from : _to).year,
        (start ? _from : _to).month,
        (start ? _from : _to).day,
      ),
      firstDate: DateTime(2020),
      lastDate: widget.controller.nowValue,
      helpText: start ? '导出开始日期' : '导出结束日期',
    );
    if (selected == null) return;
    setState(() {
      final value = FamilyDate(selected.year, selected.month, selected.day);
      if (start) {
        _from = value;
      } else {
        _to = value;
      }
    });
  }

  Future<void> _prepare() async {
    setState(() {
      _busy = true;
      _error = null;
      _archive = null;
    });
    try {
      final archive = await widget.controller.prepareExport(
        from: _from,
        to: _to,
        types: _types.toList(growable: false),
        includeMedia: _includeMedia,
      );
      if (!mounted) return;
      setState(() => _archive = archive);
    } on Object catch (error) {
      if (!mounted) return;
      setState(
        () => _error = error.toString().replaceFirst(RegExp(r'^[^:]+:\s*'), ''),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _download() async {
    final archive = _archive;
    if (archive == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final location = await widget.controller.downloadExport(archive);
      if (!mounted) return;
      if (location == null) {
        showQuietMessage(context, '已取消保存，导出文件没有写到设备。');
      } else {
        showQuietMessage(context, '导出已保存到你选择的位置。');
      }
    } on Object catch (error) {
      if (!mounted) return;
      setState(
        () => _error = error.toString().replaceFirst(RegExp(r'^[^:]+:\s*'), ''),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(
      20,
      4,
      20,
      20 + MediaQuery.viewInsetsOf(context).bottom,
    ),
    child: SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('导出家庭资料', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 8),
          const Text('导出由家庭管理员创建。ZIP 内包含清单、CSV、JSON 和已上传照片；未就绪照片会逐条列入遗漏清单。'),
          const SizedBox(height: 18),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              ActionChip(
                avatar: const Icon(Icons.event_available_outlined, size: 18),
                label: Text('从 $_from'),
                onPressed: _busy ? null : () => _pickDate(true),
              ),
              ActionChip(
                avatar: const Icon(Icons.event_outlined, size: 18),
                label: Text('到 $_to'),
                onPressed: _busy ? null : () => _pickDate(false),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Text('资料范围', style: Theme.of(context).textTheme.titleMedium),
          for (final entry in const {
            'memories': '成长小记',
            'measurements': '测量',
            'sessions': '陪伴记录',
            'plans': '每日安排',
          }.entries)
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              value: _types.contains(entry.key),
              onChanged: _busy
                  ? null
                  : (selected) {
                      setState(() {
                        if (selected == true) {
                          _types.add(entry.key);
                        } else {
                          _types.remove(entry.key);
                        }
                      });
                    },
              title: Text(entry.value),
            ),
          SwitchListTile.adaptive(
            contentPadding: EdgeInsets.zero,
            value: _includeMedia,
            onChanged: _busy
                ? null
                : (selected) => setState(() => _includeMedia = selected),
            title: const Text('包含已经上传的照片'),
            subtitle: const Text('未上传或处理失败的照片不会静默省略。'),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            InfoBanner(
              message: _error!,
              tone: StatusTone.warning,
              icon: Icons.error_outline_rounded,
            ),
          ],
          if (_archive != null) ...[
            const SizedBox(height: 10),
            InfoBanner(
              message: _archive!.missingMedia.isEmpty
                  ? '导出文件已经准备好，没有遗漏照片。'
                  : '导出已准备好，但有 ${_archive!.missingMedia.length} 张照片未包含。',
              icon: Icons.inventory_2_outlined,
              tone: _archive!.missingMedia.isEmpty
                  ? StatusTone.pending
                  : StatusTone.warning,
            ),
            if (_archive!.missingMedia.isNotEmpty)
              Card(
                margin: const EdgeInsets.only(top: 10),
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final item in _archive!.missingMedia)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 6),
                          child: Text(
                            '${item['mediaId'] ?? '照片'}：${item['reason'] ?? '未包含'}',
                          ),
                        ),
                    ],
                  ),
                ),
              ),
          ],
          const SizedBox(height: 18),
          FilledButton.icon(
            onPressed: _busy || _types.isEmpty ? null : _prepare,
            icon: _busy
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.inventory_2_outlined),
            label: Text(_busy ? '正在处理…' : '创建导出'),
          ),
          if (_archive != null) ...[
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: _busy ? null : _download,
              icon: const Icon(Icons.download_outlined),
              label: const Text('选择位置并保存 ZIP'),
            ),
          ],
        ],
      ),
    ),
  );
}
