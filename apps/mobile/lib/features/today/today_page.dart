import 'package:flutter/material.dart';

import '../../app/app_controller.dart';
import '../../core/app_theme.dart';
import '../../domain/models.dart';
import '../../widgets/app_widgets.dart';
import 'activity_detail_page.dart';
import 'sync_issue_sheet.dart';
import 'week_preview_page.dart';

class TodayPage extends StatelessWidget {
  const TodayPage({required this.controller, super.key});

  final AppController controller;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, child) {
      if (controller.loadState == LoadState.loading) {
        return const Center(child: CircularProgressIndicator());
      }
      if (controller.loadState == LoadState.error) {
        return EmptyOrErrorState(
          title: '今天的安排暂时没有打开',
          message: controller.loadError ?? '本机资料还可以继续尝试读取。',
          icon: Icons.cloud_off_outlined,
          action: FilledButton(
            onPressed: controller.initialize,
            child: const Text('再试一次'),
          ),
        );
      }
      final plan = controller.plan;
      if (controller.loadState == LoadState.empty ||
          plan == null ||
          plan.items.isEmpty) {
        return EmptyOrErrorState(
          title: '今天的安排还没准备好',
          message:
              controller.plannerMessage ?? '联网后会先补足今天起连续七天的安排；已经有安排时会在这里出现。',
          action: FilledButton(
            onPressed: () async {
              try {
                await controller.refresh(announce: true);
              } on Object catch (error) {
                if (context.mounted) showQuietMessage(context, '$error');
              }
            },
            child: const Text('准备今天'),
          ),
        );
      }
      final visibleItems = plan.visibleItems.toList(growable: false);
      return RefreshIndicator(
        onRefresh: () async {
          try {
            await controller.refresh(announce: true);
          } on Object catch (error) {
            if (context.mounted) showQuietMessage(context, '$error');
          }
        },
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: EdgeInsets.zero,
          children: [
            ContentWidth(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  AppHeader(
                    eyebrow: formatChineseDate(controller.nowValue),
                    title: '今天，一起玩点什么？',
                    description:
                        '给${controller.activeChild?.label ?? '小小探索者'}留一点轻松陪伴的时间，随时可以减成一个。',
                    trailing: CircleAvatar(
                      radius: 24,
                      child: const Icon(Icons.child_care_rounded),
                    ),
                  ),
                  const SizedBox(height: 24),
                  Align(
                    alignment: Alignment.centerRight,
                    child: OutlinedButton.icon(
                      onPressed: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (context) =>
                              WeekPreviewPage(controller: controller),
                        ),
                      ),
                      icon: const Icon(Icons.calendar_view_week_outlined),
                      label: const Text('看未来七天'),
                    ),
                  ),
                  const SizedBox(height: 16),
                  if (controller.isPreview) ...[
                    const InfoBanner(
                      message: '本机候选内容包：活动的审读状态会逐项显示；连接家庭服务后会刷新为已发布的真实安排。',
                      icon: Icons.phone_android_rounded,
                      tone: StatusTone.local,
                    ),
                    const SizedBox(height: 12),
                  ],
                  if (controller.pendingCount > 0) ...[
                    InfoBanner(
                      message:
                          '这台设备有 ${controller.pendingCount} 条记录待同步，内容没有丢失。',
                      icon: Icons.upload_file_rounded,
                      tone: StatusTone.pending,
                    ),
                    const SizedBox(height: 12),
                  ],
                  if (controller.syncIssues.isNotEmpty) ...[
                    Card(
                      child: ListTile(
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 18,
                          vertical: 8,
                        ),
                        leading: Icon(
                          controller.conflictCount > 0
                              ? Icons.people_alt_outlined
                              : Icons.sync_problem_rounded,
                          color: Theme.of(context).colorScheme.error,
                        ),
                        title: Text(
                          controller.conflictCount > 0
                              ? '有 ${controller.conflictCount} 条记录需要选一下'
                              : '有 ${controller.syncIssues.length} 条记录需要重试',
                        ),
                        subtitle: const Text('双方文字都已保留。可以查看后再处理，不需要重新填写。'),
                        trailing: const Icon(Icons.chevron_right_rounded),
                        onTap: () => showSyncIssueSheet(
                          context: context,
                          controller: controller,
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                  ],
                  _BudgetCard(
                    parent: context,
                    minutes: visibleItems.fold(
                      0,
                      (total, item) => total + item.budgetMinutes,
                    ),
                    lite: plan.mode == 'lite',
                    onChanged: (value) => _changeLiteMode(context, value),
                  ),
                  const SizedBox(height: 28),
                  SectionTitle(
                    '今天的${visibleItems.length}个小安排',
                    trailing: Text(
                      plan.mode == 'lite' ? '轻松一天' : '按宝宝状态来',
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  for (final item in visibleItems) ...[
                    _ActivityCard(
                      item: item,
                      withdrawn: controller.blockedReason(item) != null,
                      participation: controller.participations[item.id],
                      onTap: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (context) => ActivityDetailPage(
                            controller: controller,
                            item: item,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                  ],
                  if (plan.mode == 'lite') ...[
                    const SizedBox(height: 4),
                    Text(
                      '优先保留几个短活动。已开始、已记录或特意保留的项目不会消失。',
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      );
    },
  );

  Future<void> _changeLiteMode(BuildContext context, bool lite) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(lite ? '换成轻松一天？' : '恢复完整安排？'),
        content: Text(
          lite
              ? '优先安排四类短活动，每项约 5 分钟。已开始或保留的内容不变，所以也可能超过 20 分钟。'
              : '会重新展示今天的全部安排，已经记下的内容仍然保留。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('保持现在'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(lite ? '换轻松一天' : '恢复完整安排'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await controller.setLiteDay(lite);
    } on Object catch (error) {
      if (context.mounted) showQuietMessage(context, '$error');
    }
  }
}

class _BudgetCard extends StatelessWidget {
  const _BudgetCard({
    required this.parent,
    required this.minutes,
    required this.lite,
    required this.onChanged,
  });

  final BuildContext parent;
  final int minutes;
  final bool lite;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(20),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 54,
            height: 54,
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.primaryContainer,
              borderRadius: BorderRadius.circular(18),
            ),
            child: const Icon(Icons.timer_outlined),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '今天大约 $minutes 分钟',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 5),
                Text(
                  '分散在一天里，不要求一次做完。',
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 12),
                TextButton.icon(
                  onPressed: () => onChanged(!lite),
                  icon: Icon(
                    lite ? Icons.wb_sunny_outlined : Icons.bedtime_outlined,
                  ),
                  label: Text(lite ? '恢复完整安排' : '换成轻松一天'),
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

class _ActivityCard extends StatelessWidget {
  const _ActivityCard({
    required this.item,
    required this.withdrawn,
    required this.participation,
    required this.onTap,
  });

  final PlanItem item;
  final bool withdrawn;
  final LocalParticipation? participation;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final kind = _kindInfo(item.activity.kind);
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Wrap(
                alignment: WrapAlignment.spaceBetween,
                crossAxisAlignment: WrapCrossAlignment.center,
                spacing: 12,
                runSpacing: 8,
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 9,
                      vertical: 5,
                    ),
                    decoration: BoxDecoration(
                      color: kind.color.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(99),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(kind.icon, size: 16, color: kind.color),
                        const SizedBox(width: 5),
                        Text(
                          '${_blockName(item.block)} · ${kind.label}',
                          style: Theme.of(context).textTheme.labelMedium
                              ?.copyWith(
                                color: kind.color,
                                fontWeight: FontWeight.w700,
                              ),
                        ),
                      ],
                    ),
                  ),
                  Text(
                    '${item.budgetMinutes} 分钟',
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Text(
                item.activity.title,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 7),
              Text(
                item.activity.support,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Icon(
                    Icons.inventory_2_outlined,
                    size: 18,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      item.activity.materials.isEmpty
                          ? '不用准备材料'
                          : item.activity.materials.join('、'),
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                  if (participation != null)
                    StatusPill(
                      label: participation!.played ? '已记录' : '已跳过',
                      icon: participation!.played
                          ? Icons.check_rounded
                          : Icons.skip_next_rounded,
                      tone: StatusTone.pending,
                    )
                  else if (withdrawn)
                    const StatusPill(label: '请换一个', tone: StatusTone.warning)
                  else
                    Icon(
                      Icons.chevron_right_rounded,
                      color: Theme.of(context).colorScheme.primary,
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

String _blockName(String block) => switch (block) {
  'before' => '上午',
  'after' => '午后',
  'bedtime' => '睡前',
  _ => '今天',
};

({String label, IconData icon, Color color}) _kindInfo(String kind) =>
    switch (kind) {
      'reading' => (
        label: '共读',
        icon: Icons.auto_stories_outlined,
        color: const Color(0xFF6D5D46),
      ),
      'movement' => (
        label: '运动',
        icon: Icons.directions_walk_rounded,
        color: const Color(0xFF3F6D59),
      ),
      'explore' => (
        label: '探索',
        icon: Icons.science_outlined,
        color: const Color(0xFF4D6580),
      ),
      'english' => (
        label: '英语',
        icon: Icons.translate_rounded,
        color: const Color(0xFF7A5265),
      ),
      'child-led' => (
        label: '孩子主导',
        icon: Icons.child_care_rounded,
        color: AppColors.clay,
      ),
      _ => (
        label: '安静时光',
        icon: Icons.nights_stay_outlined,
        color: const Color(0xFF596677),
      ),
    };
