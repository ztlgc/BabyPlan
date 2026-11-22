import 'package:flutter/material.dart';

import '../../app/app_controller.dart';
import '../../core/app_theme.dart';
import '../../domain/models.dart';
import '../../widgets/app_widgets.dart';

Future<bool> showReplaceActivitySheet(
  BuildContext context, {
  required AppController controller,
  required PlanItem item,
}) async {
  final changed = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (context) =>
        _ReplaceActivitySheet(controller: controller, item: item),
  );
  return changed == true;
}

class _ReplaceActivitySheet extends StatefulWidget {
  const _ReplaceActivitySheet({required this.controller, required this.item});
  final AppController controller;
  final PlanItem item;

  @override
  State<_ReplaceActivitySheet> createState() => _ReplaceActivitySheetState();
}

class _ReplaceActivitySheetState extends State<_ReplaceActivitySheet> {
  bool _busy = false;
  String? _error;

  @override
  Widget build(BuildContext context) {
    final candidates = widget.controller.replacementOptionsFor(widget.item);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('换一个活动', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 8),
          const Text('只替换这一项，其他安排和已经记录的陪伴不会改变。联网时由服务再次核对适龄、材料和发布状态。'),
          if (_error != null) ...[
            const SizedBox(height: 12),
            InfoBanner(
              message: _error!,
              tone: StatusTone.warning,
              icon: Icons.error_outline_rounded,
            ),
          ],
          const SizedBox(height: 16),
          if (candidates.isEmpty)
            const InfoBanner(
              message: '这台设备目前没有完整缓存的适龄备选。连接家庭服务刷新后再试。',
              tone: StatusTone.local,
              icon: Icons.inventory_2_outlined,
            )
          else
            Flexible(
              child: ListView.separated(
                padding: EdgeInsets.zero,
                itemCount: candidates.length,
                separatorBuilder: (context, index) =>
                    const SizedBox(height: 10),
                itemBuilder: (context, index) {
                  final activity = candidates[index];
                  return Card(
                    child: Padding(
                      padding: const EdgeInsets.all(15),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(
                                  activity.title,
                                  style: Theme.of(context)
                                      .textTheme
                                      .titleMedium,
                                ),
                              ),
                              if (activity.reviewState != 'reviewed')
                                const StatusPill(
                                  label: '候选内容',
                                  tone: StatusTone.warning,
                                ),
                            ],
                          ),
                          const SizedBox(height: 5),
                          Text(activity.support),
                          const SizedBox(height: 8),
                          Text(
                            activity.materials.isEmpty
                                ? '不用准备材料'
                                : '材料：${activity.materials.join('、')}',
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                          const SizedBox(height: 10),
                          FilledButton.tonal(
                            onPressed: _busy ? null : () => _replace(activity),
                            child: const Text('替换这一项'),
                          ),
                        ],
                      ),
                    ),
                  );
                },
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _replace(Activity activity) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.controller.replaceActivity(widget.item, activity);
      if (mounted) Navigator.of(context).pop(true);
    } on Object catch (error) {
      if (!mounted) return;
      setState(
        () => _error = error.toString().replaceFirst(RegExp(r'^[^:]+:\s*'), ''),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}
