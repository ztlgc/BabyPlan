import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/app_controller.dart';
import '../discover/discover_page.dart';
import '../family/family_page.dart';
import '../growth/growth_page.dart';
import '../today/today_page.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({required this.controller, super.key});

  final AppController controller;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> with WidgetsBindingObserver {
  int _index = 0;
  late int _seenTodayRequest;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _seenTodayRequest = widget.controller.todayRequest;
    widget.controller.addListener(_handleController);
  }

  @override
  void didUpdateWidget(HomeShell oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_handleController);
      _seenTodayRequest = widget.controller.todayRequest;
      widget.controller.addListener(_handleController);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(_handleController);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed &&
        (widget.controller.connected ||
            widget.controller.plan?.date != widget.controller.today)) {
      unawaited(widget.controller.refresh());
    }
  }

  void _handleController() {
    if (_seenTodayRequest == widget.controller.todayRequest) return;
    _seenTodayRequest = widget.controller.todayRequest;
    if (mounted && _index != 0) setState(() => _index = 0);
  }

  static const _destinations = [
    NavigationDestination(
      icon: Icon(Icons.wb_sunny_outlined),
      selectedIcon: Icon(Icons.wb_sunny_rounded),
      label: '今天',
    ),
    NavigationDestination(
      icon: Icon(Icons.explore_outlined),
      selectedIcon: Icon(Icons.explore_rounded),
      label: '发现',
    ),
    NavigationDestination(
      icon: Icon(Icons.auto_stories_outlined),
      selectedIcon: Icon(Icons.auto_stories_rounded),
      label: '成长',
    ),
    NavigationDestination(
      icon: Icon(Icons.family_restroom_outlined),
      selectedIcon: Icon(Icons.family_restroom_rounded),
      label: '家庭',
    ),
  ];

  Widget _page(int index) => switch (index) {
    0 => TodayPage(controller: widget.controller),
    1 => DiscoverPage(controller: widget.controller),
    2 => GrowthPage(controller: widget.controller),
    _ => FamilyPage(controller: widget.controller),
  };

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= 840;
    if (wide) {
      return Scaffold(
        body: SafeArea(
          child: Row(
            children: [
              NavigationRail(
                extended: MediaQuery.sizeOf(context).width >= 1180,
                selectedIndex: _index,
                onDestinationSelected: (value) =>
                    setState(() => _index = value),
                leading: Padding(
                  padding: const EdgeInsets.fromLTRB(12, 12, 12, 28),
                  child: Column(
                    children: [
                      const CircleAvatar(
                        radius: 24,
                        child: Icon(Icons.spa_rounded),
                      ),
                      if (MediaQuery.sizeOf(context).width >= 1180) ...[
                        const SizedBox(height: 10),
                        Text(
                          '小芽 BabyPlan',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                      ],
                    ],
                  ),
                ),
                destinations: _destinations
                    .map(
                      (item) => NavigationRailDestination(
                        icon: item.icon,
                        selectedIcon: item.selectedIcon,
                        label: Text(item.label),
                      ),
                    )
                    .toList(growable: false),
              ),
              const VerticalDivider(),
              Expanded(child: _page(_index)),
            ],
          ),
        ),
      );
    }
    return Scaffold(
      body: SafeArea(child: _page(_index)),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (value) => setState(() => _index = value),
        destinations: _destinations,
      ),
    );
  }
}
