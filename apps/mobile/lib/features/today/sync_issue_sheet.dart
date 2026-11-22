import 'package:flutter/material.dart';

import '../../app/app_controller.dart';
import '../../domain/models.dart';
import '../../widgets/app_widgets.dart';

Future<void> showSyncIssueSheet({
  required BuildContext context,
  required AppController controller,
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  showDragHandle: true,
  builder: (context) => FractionallySizedBox(
    heightFactor: 0.9,
    child: _SyncIssueSheet(controller: controller),
  ),
);

class _SyncIssueSheet extends StatefulWidget {
  const _SyncIssueSheet({required this.controller});
  final AppController controller;

  @override
  State<_SyncIssueSheet> createState() => _SyncIssueSheetState();
}

class _SyncIssueSheetState extends State<_SyncIssueSheet> {
  String? _busyOperationId;

  Future<void> _retry(SyncIssue issue) async {
    setState(() => _busyOperationId = issue.operationId);
    try {
      await widget.controller.retrySyncIssue(issue.operationId);
      if (mounted) showQuietMessage(context, '已经重新尝试保存。');
    } on Object catch (error) {
      if (mounted) showQuietMessage(context, _friendly(error));
    } finally {
      if (mounted) setState(() => _busyOperationId = null);
    }
  }

  Future<void> _resolve(
    SyncIssue issue,
    SyncConflictResolution resolution,
  ) async {
    setState(() => _busyOperationId = issue.operationId);
    try {
      await widget.controller.resolveSyncConflict(issue, resolution);
      if (!mounted) return;
      final message = switch (resolution) {
        SyncConflictResolution.keepRemote => '已保留家庭中较新的版本。',
        SyncConflictResolution.keepLocal => '已把本机版本重新加入同步队列。',
        SyncConflictResolution.keepBoth => '已保留家庭版本，并把本机备注另存了一次。',
      };
      showQuietMessage(context, message);
    } on Object catch (error) {
      if (mounted) showQuietMessage(context, _friendly(error));
    } finally {
      if (mounted) setState(() => _busyOperationId = null);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, child) {
      final issues = widget.controller.syncIssues;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '待处理的内容',
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(height: 6),
                const Text('两位家长同时更新时，两条备注都会留在这里，等你决定怎样继续。'),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: issues.isEmpty
                ? const Center(
                    child: Padding(
                      padding: EdgeInsets.all(24),
                      child: Text('需要处理的内容已经完成。'),
                    ),
                  )
                : ListView.separated(
                    padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
                    itemCount: issues.length,
                    separatorBuilder: (context, index) =>
                        const SizedBox(height: 12),
                    itemBuilder: (context, index) {
                      final issue = issues[index];
                      return _SyncIssueCard(
                        issue: issue,
                        busy: _busyOperationId == issue.operationId,
                        onRetry: () => _retry(issue),
                        onResolve: (resolution) => _resolve(issue, resolution),
                      );
                    },
                  ),
          ),
        ],
      );
    },
  );
}

class _SyncIssueCard extends StatelessWidget {
  const _SyncIssueCard({
    required this.issue,
    required this.busy,
    required this.onRetry,
    required this.onResolve,
  });

  final SyncIssue issue;
  final bool busy;
  final VoidCallback onRetry;
  final ValueChanged<SyncConflictResolution> onResolve;

  @override
  Widget build(BuildContext context) {
    final participation = issue.objectKey.startsWith('participation:');
    final familyPreferences = issue.objectKey.startsWith('preferences:');
    final expired = issue.code == 'OPERATION_EXPIRED';
    final removedParticipation =
        participation &&
        issue.isConflict &&
        issue.conflict?.containsKey('current') == true &&
        issue.conflict?['current'] == null;
    final canKeepBoth =
        participation &&
        issue.body['status'] == 'played' &&
        ((issue.body['participantIds'] as List?)?.isNotEmpty ?? false);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  issue.isConflict
                      ? Icons.people_alt_outlined
                      : Icons.sync_problem_rounded,
                  color: Theme.of(context).colorScheme.error,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    expired
                        ? '这条待同步内容已过期'
                        : removedParticipation
                        ? '另一位家长已撤销这条记录'
                        : issue.isConflict
                        ? (familyPreferences ? '另一位家长更新了家庭偏好' : '另一位家长更新了这条记录')
                        : '这条内容还没有保存到家庭服务',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
              ],
            ),
            if (issue.isConflict) ...[
              const SizedBox(height: 14),
              _TextVersion(
                label: familyPreferences ? '本机偏好' : '这台设备写下的备注',
                text: familyPreferences
                    ? _preferenceSummary(issue.body)
                    : issue.localText,
              ),
              const SizedBox(height: 10),
              _TextVersion(
                label: familyPreferences ? '家庭偏好' : '家庭中的较新备注',
                text: familyPreferences
                    ? _preferenceSummary(issue.conflict?['current'])
                    : removedParticipation
                    ? '家庭里已经没有这条参与记录。'
                    : issue.remoteText,
              ),
              const SizedBox(height: 16),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                children: [
                  FilledButton(
                    onPressed: busy
                        ? null
                        : () => onResolve(SyncConflictResolution.keepRemote),
                    child: const Text('保留家庭版本'),
                  ),
                  OutlinedButton(
                    onPressed: busy
                        ? null
                        : () => onResolve(SyncConflictResolution.keepLocal),
                    child: const Text('保留我的版本'),
                  ),
                  if (canKeepBoth)
                    TextButton(
                      onPressed: busy
                          ? null
                          : () => onResolve(SyncConflictResolution.keepBoth),
                      child: const Text('两边都保留'),
                    ),
                ],
              ),
            ] else if (expired) ...[
              const SizedBox(height: 10),
              const Text('请先查看家庭中是否已有这条内容。原文仍留在本机，核对后再决定是否重新登记。'),
              if (issue.localText.isNotEmpty) ...[
                const SizedBox(height: 10),
                SelectableText(issue.localText),
              ],
            ] else ...[
              const SizedBox(height: 10),
              const Text('记录仍在应用私有数据库中，不会因为这次失败而消失。'),
              const SizedBox(height: 14),
              Align(
                alignment: Alignment.centerLeft,
                child: OutlinedButton.icon(
                  onPressed: busy ? null : onRetry,
                  icon: const Icon(Icons.refresh_rounded),
                  label: Text(busy ? '正在重试…' : '再试一次'),
                ),
              ),
            ],
            if (busy && issue.isConflict) ...[
              const SizedBox(height: 12),
              const LinearProgressIndicator(),
            ],
          ],
        ),
      ),
    );
  }
}

String _preferenceSummary(Object? value) {
  if (value is! Map) return '暂无可比较的偏好。';
  String names(String key) {
    final entries = value[key];
    return entries is List && entries.isNotEmpty ? entries.join('、') : '未填写';
  }

  final language = value['languageMode'] == 'zh' ? '中文' : '中文和少量英语';
  return '常用材料：${names('availableMaterials')}\n排除材料：${names('excludedMaterials')}\n陪伴语言：$language';
}

class _TextVersion extends StatelessWidget {
  const _TextVersion({required this.label, required this.text});
  final String label;
  final String text;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(12),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.labelLarge),
        const SizedBox(height: 4),
        Text(
          text.isEmpty ? '没有文字备注，状态和陪伴者仍以这一版本为准。' : text,
          style: Theme.of(context).textTheme.bodyMedium,
        ),
      ],
    ),
  );
}

String _friendly(Object error) =>
    error.toString().replaceFirst(RegExp(r'^[^:]+:\s*'), '');
