import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/app_controller.dart';
import '../../core/app_theme.dart';
import '../../domain/models.dart';
import '../../widgets/app_widgets.dart';

Future<bool?> showParticipationSheet(
  BuildContext context, {
  required AppController controller,
  required PlanItem item,
  LocalParticipation? existing,
  ParticipationStatus initialStatus = ParticipationStatus.played,
}) => showModalBottomSheet<bool>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  builder: (context) => ParticipationSheet(
    controller: controller,
    item: item,
    existing: existing,
    initialStatus: initialStatus,
  ),
);

class ParticipationSheet extends StatefulWidget {
  const ParticipationSheet({
    required this.controller,
    required this.item,
    required this.initialStatus,
    super.key,
    this.existing,
  });

  final AppController controller;
  final PlanItem item;
  final LocalParticipation? existing;
  final ParticipationStatus initialStatus;

  @override
  State<ParticipationSheet> createState() => _ParticipationSheetState();
}

class _ParticipationSheetState extends State<ParticipationSheet> {
  late ParticipationStatus _status;
  late final TextEditingController _note;
  late final TextEditingController _minutes;
  late Set<String> _participants;
  bool _saving = false;
  bool _extraSaving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final existing = widget.existing;
    _status = existing == null
        ? widget.initialStatus
        : (existing.played
              ? ParticipationStatus.played
              : ParticipationStatus.skipped);
    _note = TextEditingController(
      text: existing?.noteFor(widget.controller.actorId) ?? '',
    );
    _minutes = TextEditingController(
      text: existing?.actualMinutes?.toString() ?? '',
    );
    _participants = {
      ...(existing?.participantIds ?? const <String>[]),
      if (existing == null &&
          widget.initialStatus == ParticipationStatus.played)
        widget.controller.actorId,
    };
  }

  @override
  void dispose() {
    _note.dispose();
    _minutes.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_saving) return;
    final minutesText = _minutes.text.trim();
    final minutes = minutesText.isEmpty ? null : int.tryParse(minutesText);
    if (minutesText.isNotEmpty && minutes == null) {
      setState(() => _error = '实际分钟请填写整数，也可以留空。');
      return;
    }
    if (_status == ParticipationStatus.played && _participants.isEmpty) {
      setState(() => _error = '请选择至少一位陪伴者。');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final outcome = await widget.controller.record(
        widget.item,
        ParticipationInput(
          status: _status,
          participantIds: _participants.toList(growable: false),
          note: _note.text.trim(),
          actualMinutes: minutes,
        ),
      );
      if (!mounted) return;
      final messenger = ScaffoldMessenger.of(context);
      Navigator.of(context).pop(true);
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            outcome == SaveOutcome.synced ? '这次记录已经同步。' : '已保存在这台设备，联网后继续同步。',
          ),
        ),
      );
    } on Object catch (error) {
      if (!mounted) return;
      setState(
        () => _error = error.toString().replaceFirst(RegExp(r'^[^:]+:\s*'), ''),
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _undo() async {
    if (_saving) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('撤销这次记录？'),
        content: const Text('会回到还没有记录的状态，已经写下的备注也一并撤销。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('保留'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('撤销记录'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _saving = true);
    try {
      await widget.controller.undo(widget.item.id);
      if (!mounted) return;
      final messenger = ScaffoldMessenger.of(context);
      Navigator.of(context).pop(true);
      messenger.showSnackBar(
        const SnackBar(content: Text('这次记录已从本机撤销，稍后会继续同步。')),
      );
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = error.toString();
      });
    }
  }

  Future<void> _extraPlay() async {
    if (_extraSaving || _saving) return;
    if (_participants.isEmpty) {
      setState(() => _error = '再玩一次时，请至少选择一位陪伴者。');
      return;
    }
    setState(() {
      _extraSaving = true;
      _error = null;
    });
    try {
      await widget.controller.addExtraPlay(
        item: widget.item,
        participantIds: _participants.toList(growable: false),
        note: _note.text.trim(),
      );
      if (!mounted) return;
      final messenger = ScaffoldMessenger.of(context);
      Navigator.of(context).pop(true);
      messenger.showSnackBar(const SnackBar(content: Text('又记了一次，已保存在本机待同步。')));
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _extraSaving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.viewInsetsOf(context).bottom;
    final busy = _saving || _extraSaving;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 12, 20, 20 + bottom),
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
              widget.existing == null ? '记下这次陪伴' : '编辑这次记录',
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 6),
            Text(
              widget.item.activity.title,
              style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 22),
            Text('这次怎么样？', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 10),
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                ChoiceChip(
                  label: const Text('一起玩了'),
                  selected: _status == ParticipationStatus.played,
                  onSelected: busy
                      ? null
                      : (_) => setState(
                          () => _status = ParticipationStatus.played,
                        ),
                ),
                ChoiceChip(
                  label: const Text('今天先跳过'),
                  selected: _status == ParticipationStatus.skipped,
                  onSelected: busy
                      ? null
                      : (_) => setState(
                          () => _status = ParticipationStatus.skipped,
                        ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            Text('谁陪着玩？', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            Wrap(
              spacing: 10,
              runSpacing: 8,
              children: [
                FilterChip(
                  label: const Text('我'),
                  selected: _participants.contains(widget.controller.actorId),
                  onSelected: busy
                      ? null
                      : (selected) => setState(() {
                          if (selected) {
                            _participants.add(widget.controller.actorId);
                          } else {
                            _participants.remove(widget.controller.actorId);
                          }
                        }),
                ),
                for (final member in widget.controller.companionMembers)
                  FilterChip(
                    label: Text(member.label),
                    selected: _participants.contains(member.userId),
                    onSelected: busy
                        ? null
                        : (selected) => setState(() {
                            if (selected) {
                              _participants.add(member.userId);
                            } else {
                              _participants.remove(member.userId);
                            }
                          }),
                  ),
              ],
            ),
            const SizedBox(height: 20),
            TextField(
              controller: _note,
              enabled: !busy,
              minLines: 2,
              maxLines: 4,
              maxLength: 2000,
              decoration: const InputDecoration(
                labelText: '一句备注（可选）',
                hintText: '例如：宝宝自己翻到了下一页',
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _minutes,
              enabled: !busy,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: const InputDecoration(
                labelText: '实际分钟（可空）',
                hintText: '不填也没关系',
                suffixText: '分钟',
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              InfoBanner(
                message: _error!,
                icon: Icons.error_outline_rounded,
                tone: StatusTone.warning,
              ),
            ],
            const SizedBox(height: 22),
            FilledButton.icon(
              onPressed: busy ? null : _save,
              icon: _saving
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.check_rounded),
              label: Text(_saving ? '正在保存…' : '保存记录'),
            ),
            if (widget.existing?.played == true) ...[
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: busy ? null : _extraPlay,
                icon: _extraSaving
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.replay_rounded),
                label: Text(_extraSaving ? '正在记录…' : '又陪宝宝玩了一次'),
              ),
              const SizedBox(height: 8),
              TextButton.icon(
                onPressed: busy ? null : _undo,
                icon: const Icon(Icons.undo_rounded),
                label: const Text('撤销这次记录'),
              ),
            ],
            const SizedBox(height: 4),
            Text(
              '记录只表示这次一起做过，不要求玩满预算，也不会生成积分。',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
