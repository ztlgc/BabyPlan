import 'package:flutter/material.dart';

import '../../app/app_controller.dart';
import '../../core/app_theme.dart';
import '../../domain/models.dart';
import '../../widgets/app_widgets.dart';
import 'participation_sheet.dart';
import 'replace_activity_sheet.dart';

class ActivityDetailPage extends StatefulWidget {
  const ActivityDetailPage({
    required this.controller,
    required this.item,
    super.key,
    this.showRecordActions = true,
  });

  final AppController controller;
  final PlanItem item;
  final bool showRecordActions;

  @override
  State<ActivityDetailPage> createState() => _ActivityDetailPageState();
}

class _ActivityDetailPageState extends State<ActivityDetailPage> {
  AppController get controller => widget.controller;
  PlanItem get item => widget.item;
  bool get showRecordActions => widget.showRecordActions;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      try {
        await controller.verifyContentSafety();
      } on Object {
        // 已知撤回照常阻断；离线时标注当前不能取得最新状态。
      }
    });
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, child) {
      if (controller.familyCacheLocked || controller.checkingContentSafety) {
        return Scaffold(
          appBar: AppBar(title: const Text('活动详情')),
          body: Center(
            child: Padding(
              padding: const EdgeInsets.all(22),
              child: Text(
                controller.familyCacheLocked
                    ? '家庭资料已锁定，请重新登录并确认访问权限。'
                    : '正在核对活动是否仍可使用…',
              ),
            ),
          ),
        );
      }
      final activity = item.activity;
      final participation = controller.participations[item.id];
      final blockedReason = controller.blockedReason(item);
      if (blockedReason != null) {
        return Scaffold(
          appBar: AppBar(title: const Text('活动详情')),
          body: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              Text(
                activity.title,
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(height: 14),
              InfoBanner(
                message: '这个玩法已停止推荐。$blockedReason',
                tone: StatusTone.warning,
              ),
              if (participation != null) ...[
                const SizedBox(height: 14),
                Text(participation.played ? '这次陪伴记录仍保留。' : '这次跳过记录仍保留。'),
                for (final note in participation.historyNotes) Text(note),
              ],
              if (showRecordActions && controller.canReplace(item)) ...[
                const SizedBox(height: 14),
                FilledButton(
                  onPressed: () async {
                    final changed = await showReplaceActivitySheet(
                      context,
                      controller: controller,
                      item: item,
                    );
                    if (changed && context.mounted) Navigator.of(context).pop();
                  },
                  child: const Text('换一个活动'),
                ),
              ],
            ],
          ),
        );
      }
      return Scaffold(
        appBar: AppBar(title: const Text('活动详情')),
        body: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
          children: [
            Align(
              alignment: Alignment.center,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 760),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      '${_blockName(item.block)} · ${item.budgetMinutes} 分钟',
                      style: Theme.of(context).textTheme.labelLarge?.copyWith(
                        color: Theme.of(context).colorScheme.primary,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      activity.title,
                      style: Theme.of(context).textTheme.displaySmall,
                    ),
                    const SizedBox(height: 10),
                    Text(activity.support),
                    if (controller.connected &&
                        !controller.contentSafetyCurrent) ...[
                      const SizedBox(height: 14),
                      const InfoBanner(
                        message: '当前查看本机缓存，可能尚未收到最新撤回信息。',
                        tone: StatusTone.warning,
                      ),
                    ],
                    if (activity.reviewState != 'reviewed') ...[
                      const SizedBox(height: 14),
                      const InfoBanner(
                        message: '这项内容尚未完成审核，请以家长判断为准。',
                        tone: StatusTone.warning,
                      ),
                    ],
                    const SizedBox(height: 24),
                    _DetailSection(
                      icon: Icons.inventory_2_outlined,
                      title: '先准备',
                      child: activity.materials.isEmpty
                          ? const Text('不需要准备材料')
                          : Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: activity.materials
                                  .map(
                                    (material) => Padding(
                                      padding: const EdgeInsets.only(bottom: 6),
                                      child: Text('• $material'),
                                    ),
                                  )
                                  .toList(growable: false),
                            ),
                    ),
                    const SizedBox(height: 14),
                    _DetailSection(
                      icon: Icons.format_list_numbered_rounded,
                      title: '怎么做',
                      child: Column(
                        children: [
                          for (var i = 0; i < activity.steps.length; i++)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 14),
                              child: Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  CircleAvatar(
                                    radius: 14,
                                    child: Text(
                                      '${i + 1}',
                                      style: Theme.of(context)
                                          .textTheme
                                          .labelMedium,
                                    ),
                                  ),
                                  const SizedBox(width: 12),
                                  Expanded(child: Text(activity.steps[i])),
                                ],
                              ),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 14),
                    _DetailSection(
                      icon: Icons.chat_bubble_outline_rounded,
                      title: '可以这样说',
                      child: Column(
                        children: [
                          _DialogueRow(
                            label: '开始',
                            text: activity.dialogue['opening'] ?? '',
                          ),
                          _DialogueRow(
                            label: '互动',
                            text: activity.dialogue['engaged'] ?? '',
                          ),
                          _DialogueRow(
                            label: '观察',
                            text: activity.dialogue['observing'] ?? '',
                          ),
                          _DialogueRow(
                            label: '收尾',
                            text: activity.dialogue['stopping'] ?? '',
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 14),
                    _DetailSection(
                      icon: Icons.translate_rounded,
                      title: '英语一句',
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            activity.english['phrase'] ?? '',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 4),
                          Text(activity.english['meaning'] ?? ''),
                          const SizedBox(height: 6),
                          Text(
                            activity.english['when'] ?? '',
                            style: Theme.of(context).textTheme.bodyMedium
                                ?.copyWith(
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurfaceVariant,
                                ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 14),
                    _DetailSection(
                      icon: Icons.health_and_safety_outlined,
                      title: '安全提示',
                      child: Text(activity.safety),
                    ),
                    const SizedBox(height: 14),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: _DetailSection(
                            icon: Icons.remove_circle_outline_rounded,
                            title: '更简单一点',
                            child: Text(activity.easier),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: _DetailSection(
                            icon: Icons.arrow_forward_rounded,
                            title: '下一次',
                            child: Text(activity.next),
                          ),
                        ),
                      ],
                    ),
                    if (participation != null) ...[
                      const SizedBox(height: 18),
                      InfoBanner(
                        message: participation.played
                            ? '已记录一起玩了${participation.actualMinutes == null ? '' : ' ${participation.actualMinutes} 分钟'}。'
                            : '已记录今天先跳过。',
                        icon: Icons.check_circle_outline_rounded,
                        tone: StatusTone.pending,
                      ),
                    ],
                    if (showRecordActions) ...[
                      const SizedBox(height: 24),
                      if (controller.canReplace(item)) ...[
                        OutlinedButton.icon(
                          onPressed: () async {
                            final changed = await showReplaceActivitySheet(
                              context,
                              controller: controller,
                              item: item,
                            );
                            if (changed && context.mounted) {
                              Navigator.of(context).pop();
                            }
                          },
                          icon: const Icon(Icons.swap_horiz_rounded),
                          label: const Text('换一个活动'),
                        ),
                        const SizedBox(height: 8),
                      ],
                      FilledButton.icon(
                        onPressed: item.blocked || !controller.canRecordToday
                            ? null
                            : () => showParticipationSheet(
                                context,
                                controller: controller,
                                item: item,
                                existing: participation,
                              ),
                        icon: const Icon(Icons.favorite_outline_rounded),
                        label: Text(participation == null ? '一起玩了' : '编辑这次记录'),
                      ),
                      const SizedBox(height: 8),
                      OutlinedButton(
                        onPressed:
                            item.blocked ||
                                participation != null ||
                                !controller.canRecordToday
                            ? null
                            : () => showParticipationSheet(
                                context,
                                controller: controller,
                                item: item,
                                initialStatus: ParticipationStatus.skipped,
                              ),
                        child: const Text('今天先跳过'),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      );
    },
  );
}

String _blockName(String block) => switch (block) {
  'before' => '白天',
  'after' => '午后',
  'bedtime' => '睡前',
  _ => '今天',
};

class _DetailSection extends StatelessWidget {
  const _DetailSection({
    required this.icon,
    required this.title,
    required this.child,
  });

  final IconData icon;
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 21),
              const SizedBox(width: 8),
              Text(title, style: Theme.of(context).textTheme.titleMedium),
            ],
          ),
          const SizedBox(height: 12),
          child,
        ],
      ),
    ),
  );
}

class _DialogueRow extends StatelessWidget {
  const _DialogueRow({required this.label, required this.text});
  final String label;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 11),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 48,
          child: Text(
            label,
            style: Theme.of(context).textTheme.labelLarge
                ?.copyWith(color: Theme.of(context).colorScheme.primary),
          ),
        ),
        Expanded(child: Text(text)),
      ],
    ),
  );
}
