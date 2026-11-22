import 'package:flutter/material.dart';

import '../../app/app_controller.dart';
import '../../core/app_theme.dart';
import '../../domain/demo_content.dart';
import '../../domain/models.dart';
import '../../widgets/app_widgets.dart';
import '../today/activity_detail_page.dart';

class DiscoverPage extends StatefulWidget {
  const DiscoverPage({required this.controller, super.key});

  final AppController controller;

  @override
  State<DiscoverPage> createState() => _DiscoverPageState();
}

class _DiscoverPageState extends State<DiscoverPage> {
  int _section = 0;
  String _category = '全部';
  String _query = '';

  static const _categories = ['全部', '共读', '运动', '探索', '英语', '孩子主导', '安静'];

  @override
  Widget build(BuildContext context) => ListView(
    padding: EdgeInsets.zero,
    children: [
      ContentWidth(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const AppHeader(
              eyebrow: '发现更多陪伴方式',
              title: '慢慢看，随时玩',
              description: '先挑宝宝现在有兴趣的，不需要先塞进今天的安排。',
            ),
            const SizedBox(height: 18),
            InfoBanner(
              message: widget.controller.connected
                  ? (widget.controller.contentSafetyCurrent
                        ? '这里只展示当前家庭服务可用的活动。'
                        : '当前查看本机缓存，可能尚未收到最新撤回信息。')
                  : '这里内置 24 张候选活动卡，均标注为“待人工审读”；不会冒充已经发布的内容。',
              icon: Icons.science_outlined,
              tone: StatusTone.warning,
            ),
            const SizedBox(height: 18),
            SegmentedButton<int>(
              segments: const [
                ButtonSegment(
                  value: 0,
                  icon: Icon(Icons.grid_view_rounded),
                  label: Text('活动'),
                ),
                ButtonSegment(
                  value: 1,
                  icon: Icon(Icons.menu_book_outlined),
                  label: Text('书架'),
                ),
                ButtonSegment(
                  value: 2,
                  icon: Icon(Icons.route_outlined),
                  label: Text('阶段'),
                ),
              ],
              selected: {_section},
              onSelectionChanged: (value) =>
                  setState(() => _section = value.first),
            ),
            const SizedBox(height: 22),
            if (_section == 0) ..._activityContent(),
            if (_section == 1) ..._shelfContent(),
            if (_section == 2) ..._stageContent(),
          ],
        ),
      ),
    ],
  );

  List<Widget> _activityContent() {
    final filtered = widget.controller.discoverableActivities
        .where((activity) {
          final category = _categoryLabel(activity.kind);
          final categoryMatch = _category == '全部' || category == _category;
          final query = _query.trim().toLowerCase();
          final queryMatch =
              query.isEmpty ||
              activity.title.toLowerCase().contains(query) ||
              activity.support.toLowerCase().contains(query);
          return categoryMatch && queryMatch;
        })
        .toList(growable: false);
    return [
      TextField(
        onChanged: (value) => setState(() => _query = value),
        decoration: const InputDecoration(
          prefixIcon: Icon(Icons.search_rounded),
          labelText: '找活动',
          hintText: '试试“书”“走动”或“英语”',
        ),
      ),
      const SizedBox(height: 14),
      SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            for (final category in _categories) ...[
              ChoiceChip(
                label: Text(category),
                selected: _category == category,
                onSelected: (_) => setState(() => _category = category),
              ),
              const SizedBox(width: 8),
            ],
          ],
        ),
      ),
      const SizedBox(height: 20),
      SectionTitle('${filtered.length} 项适合现在的活动'),
      const SizedBox(height: 12),
      if (filtered.isEmpty)
        const Card(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Text('当前没有匹配的玩法。可以清空搜索，查看这个月龄还有没有合适的活动。'),
          ),
        )
      else
        for (final activity in filtered) ...[
          _DiscoveryActivityCard(
            activity: activity,
            onTap: () => _openActivity(activity),
          ),
          const SizedBox(height: 12),
        ],
    ];
  }

  List<Widget> _shelfContent() => [
    const SectionTitle('家中书架'),
    const SizedBox(height: 8),
    Text(
      '未核对版本的绘本只显示书名，不承诺具体页码或点读功能。',
      style: Theme.of(context).textTheme.bodyMedium
          ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
    ),
    const SizedBox(height: 14),
    if (widget.controller.books.isNotEmpty)
      for (final book in widget.controller.books) ...[
        _FamilyBookCard(book: book),
        const SizedBox(height: 12),
      ]
    else if (widget.controller.connected)
      const Card(
        child: Padding(
          padding: EdgeInsets.all(22),
          child: Text('书架还是空的。家里有什么常读绘本，可以先登记一本。'),
        ),
      )
    else ...[
      const _BookCard(
        title: '小熊宝宝绘本',
        series: '系列 · 中文',
        status: '版本待核对',
        color: Color(0xFF8F6C52),
      ),
      const SizedBox(height: 12),
      const _BookCard(
        title: 'Dear Zoo',
        series: '英文纸板书',
        status: '演示占位',
        color: Color(0xFF4E6C5B),
      ),
    ],
    const SizedBox(height: 16),
    OutlinedButton.icon(
      onPressed: _openAddBookSheet,
      icon: const Icon(Icons.add_rounded),
      label: const Text('登记一本家里的书'),
    ),
  ];

  List<Widget> _stageContent() {
    final guide = DemoContent.stageGuideFor(widget.controller.currentAgeBand);
    if (guide == null) {
      return [const InfoBanner(message: '暂时没有这个月龄的阶段指引。依然可以随时记录宝宝喜欢做的事。')];
    }
    final focuses = (guide['focuses'] as List).cast<Map<String, dynamic>>();
    return [
      SectionTitle('${guide['title']}'),
      const SizedBox(height: 8),
      Text(
        '${guide['description']}',
        style: Theme.of(context).textTheme.bodyLarge,
      ),
      const SizedBox(height: 16),
      for (var index = 0; index < focuses.length; index++) ...[
        _StageFocus(
          icon: switch (index) {
            0 => Icons.record_voice_over_outlined,
            1 => Icons.directions_walk_rounded,
            _ => Icons.handyman_outlined,
          },
          title: '${focuses[index]['title']}',
          domain: '${focuses[index]['domain']}',
          sourceId: '${guide['sourceId']}',
          everyday: '${focuses[index]['everyday']}',
          support: '${focuses[index]['support']}',
          easier: '${focuses[index]['easier']}',
          next: '${focuses[index]['next']}',
          onObserve: () => _openStageObservation(focuses[index]),
        ),
        if (index != focuses.length - 1) const SizedBox(height: 12),
      ],
      const SizedBox(height: 20),
      const InfoBanner(
        message: '阶段说明帮助家长观察，不自动生成发育成就，也不用于比较宝宝。',
        icon: Icons.visibility_outlined,
      ),
    ];
  }

  void _openActivity(Activity activity) {
    final planItem = PlanItem.fromJson({
      'id': 'discovery-${activity.id}',
      'dayPlanId': 'discovery',
      'kind': activity.kind,
      'block': 'before',
      'position': 0,
      'budgetMinutes': 8,
      'snapshot': activity.json,
      'lockedByParent': false,
      'startedAt': null,
      'revision': 0,
      'reasonCodes': ['AGE_MATCH'],
      'blockedByWithdrawal': false,
      'participation': null,
      'visibility': 'active',
    });
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (context) => ActivityDetailPage(
          controller: widget.controller,
          item: planItem,
          showRecordActions: false,
        ),
      ),
    );
  }

  Future<void> _openAddBookSheet() => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => _AddBookSheet(controller: widget.controller),
  );

  Future<void> _openStageObservation(Map<String, dynamic> focus) =>
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (context) => _StageObservationSheet(
          controller: widget.controller,
          guideId: '${focus['id']}',
          title: '${focus['title']}',
        ),
      );
}

String _categoryLabel(String kind) => switch (kind) {
  'reading' => '共读',
  'movement' => '运动',
  'explore' => '探索',
  'english' => '英语',
  'child-led' => '孩子主导',
  _ => '安静',
};

class _DiscoveryActivityCard extends StatelessWidget {
  const _DiscoveryActivityCard({required this.activity, required this.onTap});

  final Activity activity;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Card(
    clipBehavior: Clip.antiAlias,
    child: InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 46,
              height: 46,
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.primaryContainer,
                borderRadius: BorderRadius.circular(14),
              ),
              child: Icon(_kindIcon(activity.kind)),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          activity.title,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                      ),
                      const StatusPill(label: '候选', tone: StatusTone.warning),
                    ],
                  ),
                  const SizedBox(height: 5),
                  Text(activity.support, maxLines: 2),
                  const SizedBox(height: 8),
                  Text(
                    '${_categoryLabel(activity.kind)} · ${activity.materials.isEmpty ? '无需材料' : activity.materials.join('、')}',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            const Icon(Icons.chevron_right_rounded),
          ],
        ),
      ),
    ),
  );
}

IconData _kindIcon(String kind) => switch (kind) {
  'reading' => Icons.auto_stories_outlined,
  'movement' => Icons.directions_walk_rounded,
  'explore' => Icons.science_outlined,
  'english' => Icons.translate_rounded,
  'child-led' => Icons.child_care_rounded,
  _ => Icons.nights_stay_outlined,
};

class _BookCard extends StatelessWidget {
  const _BookCard({
    required this.title,
    required this.series,
    required this.status,
    required this.color,
  });

  final String title;
  final String series;
  final String status;
  final Color color;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Row(
        children: [
          Container(
            width: 54,
            height: 70,
            decoration: BoxDecoration(
              color: color,
              borderRadius: BorderRadius.circular(8),
            ),
            alignment: Alignment.center,
            padding: const EdgeInsets.all(6),
            child: Text(
              title,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.labelMedium
                  ?.copyWith(color: Colors.white, fontWeight: FontWeight.w700),
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 3),
                Text(
                  series,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 8),
                StatusPill(
                  label: status,
                  icon: Icons.help_outline,
                  tone: StatusTone.warning,
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

class _FamilyBookCard extends StatelessWidget {
  const _FamilyBookCard({required this.book});

  final FamilyBook book;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Row(
        children: [
          Container(
            width: 54,
            height: 70,
            decoration: BoxDecoration(
              color: book.verified
                  ? const Color(0xFF4E6C5B)
                  : const Color(0xFF8F6C52),
              borderRadius: BorderRadius.circular(8),
            ),
            alignment: Alignment.center,
            padding: const EdgeInsets.all(6),
            child: Text(
              book.title,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.labelMedium
                  ?.copyWith(color: Colors.white, fontWeight: FontWeight.w700),
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  book.title,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 3),
                Text(
                  '${book.language}${book.note.isEmpty ? '' : ' · ${book.note}'}',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    StatusPill(
                      label: book.verified ? '版本已核对' : '版本待核对',
                      icon: book.verified
                          ? Icons.verified_outlined
                          : Icons.help_outline,
                      tone: book.verified
                          ? StatusTone.pending
                          : StatusTone.warning,
                    ),
                    if (book.syncState != 'synced')
                      const StatusPill(
                        label: '待同步',
                        icon: Icons.cloud_upload_outlined,
                        tone: StatusTone.local,
                      ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

class _AddBookSheet extends StatefulWidget {
  const _AddBookSheet({required this.controller});

  final AppController controller;

  @override
  State<_AddBookSheet> createState() => _AddBookSheetState();
}

class _AddBookSheetState extends State<_AddBookSheet> {
  final _title = TextEditingController();
  final _note = TextEditingController();
  String _language = '中文';
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _title.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_title.text.trim().isEmpty) {
      setState(() => _error = '请先填写书名。');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await widget.controller.addFamilyBook(
        title: _title.text.trim(),
        language: _language,
        note: _note.text.trim(),
      );
      if (mounted) Navigator.of(context).pop();
    } on Object catch (error) {
      if (mounted) {
        setState(() {
          _error = error.toString().replaceFirst(RegExp(r'^[^:]+:\s*'), '');
          _saving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(
      20,
      8,
      20,
      20 + MediaQuery.viewInsetsOf(context).bottom,
    ),
    child: SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('登记家里的书', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 8),
          const Text('先记录书名就够了；未知版本会明确标注，不会冒充已核对。'),
          const SizedBox(height: 18),
          TextField(
            controller: _title,
            enabled: !_saving,
            maxLength: 100,
            decoration: const InputDecoration(labelText: '书名'),
          ),
          const SizedBox(height: 10),
          DropdownButtonFormField<String>(
            initialValue: _language,
            decoration: const InputDecoration(labelText: '语言'),
            items: const [
              DropdownMenuItem(value: '中文', child: Text('中文')),
              DropdownMenuItem(value: '英文', child: Text('英文')),
              DropdownMenuItem(value: '中英双语', child: Text('中英双语')),
              DropdownMenuItem(value: '其他', child: Text('其他')),
            ],
            onChanged: _saving
                ? null
                : (value) {
                    if (value != null) setState(() => _language = value);
                  },
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _note,
            enabled: !_saving,
            maxLength: 500,
            decoration: const InputDecoration(labelText: '放在哪里或想提醒什么（可选）'),
          ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            InfoBanner(
              message: _error!,
              tone: StatusTone.warning,
              icon: Icons.error_outline_rounded,
            ),
          ],
          const SizedBox(height: 14),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: Text(_saving ? '正在登记…' : '保存到家庭书架'),
          ),
        ],
      ),
    ),
  );
}

class _StageFocus extends StatelessWidget {
  const _StageFocus({
    required this.icon,
    required this.title,
    required this.domain,
    required this.sourceId,
    required this.everyday,
    required this.support,
    required this.easier,
    required this.next,
    required this.onObserve,
  });

  final IconData icon;
  final String title;
  final String domain;
  final String sourceId;
  final String everyday;
  final String support;
  final String easier;
  final String next;
  final VoidCallback onObserve;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon),
              const SizedBox(width: 9),
              Expanded(
                child: Text(
                  title,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              Text(
                sourceId,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            domain,
            style: Theme.of(context).textTheme.labelMedium
                ?.copyWith(color: Theme.of(context).colorScheme.primary),
          ),
          const SizedBox(height: 10),
          Text('生活里：$everyday'),
          const SizedBox(height: 6),
          Text('可以这样陪：$support'),
          const SizedBox(height: 10),
          Text(
            '更容易：$easier\n下一步：$next',
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: onObserve,
            icon: const Icon(Icons.edit_note_rounded),
            label: const Text('记录一次观察'),
          ),
        ],
      ),
    ),
  );
}

class _StageObservationSheet extends StatefulWidget {
  const _StageObservationSheet({
    required this.controller,
    required this.guideId,
    required this.title,
  });

  final AppController controller;
  final String guideId;
  final String title;

  @override
  State<_StageObservationSheet> createState() => _StageObservationSheetState();
}

class _StageObservationSheetState extends State<_StageObservationSheet> {
  final _note = TextEditingController();
  String _value = 'noticed';
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final fallback = switch (_value) {
        'noticed' => '今天留意到了这个表现',
        'not_yet_observed' => '今天还没有留意到这个表现',
        _ => '想以后再聊聊这个表现',
      };
      await widget.controller.addGrowth(
        type: GrowthRecordType.observation,
        date: widget.controller.today,
        text: _note.text.trim().isEmpty ? fallback : _note.text.trim(),
        guideId: widget.guideId,
        observationValue: _value,
      );
      if (mounted) Navigator.of(context).pop();
    } on Object catch (error) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = error.toString().replaceFirst(RegExp(r'^[^:]+:\s*'), '');
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(
      20,
      8,
      20,
      20 + MediaQuery.viewInsetsOf(context).bottom,
    ),
    child: SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('记录一次观察', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 6),
          Text(widget.title),
          const SizedBox(height: 18),
          DropdownButtonFormField<String>(
            initialValue: _value,
            decoration: const InputDecoration(labelText: '这次看到什么'),
            items: const [
              DropdownMenuItem(value: 'noticed', child: Text('已经留意到了')),
              DropdownMenuItem(value: 'not_yet_observed', child: Text('还没留意到')),
              DropdownMenuItem(value: 'discuss', child: Text('想以后再聊聊')),
            ],
            onChanged: _saving
                ? null
                : (value) {
                    if (value != null) setState(() => _value = value);
                  },
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _note,
            enabled: !_saving,
            maxLength: 2000,
            minLines: 3,
            maxLines: 6,
            decoration: const InputDecoration(labelText: '具体发生了什么（可选）'),
          ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            InfoBanner(
              message: _error!,
              tone: StatusTone.warning,
              icon: Icons.error_outline_rounded,
            ),
          ],
          const SizedBox(height: 12),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: Text(_saving ? '正在保存…' : '保存观察'),
          ),
        ],
      ),
    ),
  );
}
