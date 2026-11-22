import 'package:flutter/material.dart';

import '../../app/app_controller.dart';
import '../../core/app_theme.dart';
import '../../core/family_date.dart';
import '../../domain/models.dart';
import '../../widgets/app_widgets.dart';
import 'activity_detail_page.dart';

class WeekPreviewPage extends StatefulWidget {
  const WeekPreviewPage({required this.controller, super.key});
  final AppController controller;

  @override
  State<WeekPreviewPage> createState() => _WeekPreviewPageState();
}

class _WeekPreviewPageState extends State<WeekPreviewPage> {
  late Future<List<DayPlan>> _future;

  @override
  void initState() {
    super.initState();
    _future = widget.controller.loadWeekPreview();
  }

  Future<void> _refresh() async {
    setState(() => _future = widget.controller.loadWeekPreview(refresh: true));
    await _future;
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) => Scaffold(
      appBar: AppBar(title: const Text('未来七天')),
      body: FutureBuilder<List<DayPlan>>(
        future: _future,
        builder: (context, snapshot) {
          if (widget.controller.familyCacheLocked) {
            return const Center(child: Text('家庭资料已锁定，请重新登录。'));
          }
          if (widget.controller.checkingContentSafety) {
            return const Center(child: Text('正在核对活动状态…'));
          }
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return EmptyOrErrorState(
              title: '七天安排暂时没有读取成功',
              message: snapshot.error.toString(),
              icon: Icons.cloud_off_outlined,
              action: FilledButton(
                onPressed: _refresh,
                child: const Text('重新读取'),
              ),
            );
          }
          final plans = snapshot.data ?? const <DayPlan>[];
          if (plans.isEmpty) {
            return EmptyOrErrorState(
              title: '还没有可预览的安排',
              message:
                  widget.controller.plannerMessage ?? '联网准备安排后，这里会显示今天起连续七天。',
              icon: Icons.event_note_outlined,
              action: OutlinedButton(
                onPressed: _refresh,
                child: const Text('联网准备'),
              ),
            );
          }
          return RefreshIndicator(
            onRefresh: _refresh,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(18, 10, 18, 32),
              children: [
                const InfoBanner(
                  message: '未来安排只用于提前看材料和心里有数；这里不能记录或换项。到了当天再按宝宝状态开始。',
                  icon: Icons.visibility_outlined,
                  tone: StatusTone.local,
                ),
                const SizedBox(height: 16),
                for (final plan in plans) ...[
                  _WeekDayCard(controller: widget.controller, plan: plan),
                  const SizedBox(height: 12),
                ],
              ],
            ),
          );
        },
      ),
    ),
  );
}

class _WeekDayCard extends StatelessWidget {
  const _WeekDayCard({required this.controller, required this.plan});
  final AppController controller;
  final DayPlan plan;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '${plan.date.month}月${plan.date.day}日 · ${_weekday(plan.date)}',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              StatusPill(
                label: plan.mode == 'lite'
                    ? '轻松一天'
                    : '${plan.effectiveBudgetMinutes} 分钟',
                tone: plan.mode == 'lite'
                    ? StatusTone.local
                    : StatusTone.neutral,
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (plan.visibleItems.isEmpty) const Text('还没有适合这个月龄和家庭偏好的玩法。'),
          for (final item in plan.visibleItems)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: CircleAvatar(
                radius: 17,
                child: Icon(_kindIcon(item.activity.kind), size: 17),
              ),
              title: Text(item.activity.title),
              subtitle: Text(
                controller.blockedReason(item) != null
                    ? '已停止推荐'
                    : '${item.block == 'before'
                          ? '白天'
                          : item.block == 'after'
                          ? '午后'
                          : item.block == 'bedtime'
                          ? '睡前'
                          : '当天'} · ${item.budgetMinutes} 分钟',
              ),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: controller.blockedReason(item) != null
                  ? null
                  : () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (context) => ActivityDetailPage(
                          controller: controller,
                          item: item,
                          showRecordActions: false,
                        ),
                      ),
                    ),
            ),
        ],
      ),
    ),
  );
}

String _weekday(FamilyDate date) =>
    const ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][date.weekday - 1];

IconData _kindIcon(String kind) => switch (kind) {
  'reading' => Icons.auto_stories_outlined,
  'movement' => Icons.directions_walk_rounded,
  'explore' => Icons.science_outlined,
  'english' => Icons.translate_rounded,
  'child-led' => Icons.child_care_rounded,
  _ => Icons.nights_stay_outlined,
};
