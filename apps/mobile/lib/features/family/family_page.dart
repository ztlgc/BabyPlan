import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/app_controller.dart';
import '../../core/app_theme.dart';
import '../../domain/models.dart';
import '../../widgets/app_widgets.dart';
import 'export_sheet.dart';

class FamilyPage extends StatefulWidget {
  const FamilyPage({required this.controller, super.key});

  final AppController controller;

  @override
  State<FamilyPage> createState() => _FamilyPageState();
}

class _FamilyPageState extends State<FamilyPage> {
  final _email = TextEditingController();
  final _passphrase = TextEditingController();
  final _serviceAddress = TextEditingController();
  bool _showLogin = false;
  String? _loginError;
  bool _reminderBusy = false;
  bool _serviceBusy = false;
  bool _inviteBusy = false;
  bool _draftExportBusy = false;

  @override
  void dispose() {
    _email.dispose();
    _passphrase.dispose();
    _serviceAddress.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, child) {
      final prefs = widget.controller.preferences;
      return ListView(
        padding: EdgeInsets.zero,
        children: [
          ContentWidth(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const AppHeader(
                  eyebrow: '家庭与设置',
                  title: '一起照顾，一起调整',
                  description: '这里管理孩子的年龄、家中偏好、提醒和设备资料。',
                ),
                const SizedBox(height: 22),
                _FamilySummaryCard(controller: widget.controller),
                const SizedBox(height: 14),
                _SettingsCard(
                  icon: Icons.inventory_2_outlined,
                  title: '家中可用材料',
                  subtitle: '只影响后续安排，不会改动已经记录的活动。',
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final material in const [
                        '积木',
                        '纸和笔',
                        '家中绘本',
                        '软垫',
                        '浅盆',
                      ])
                        FilterChip(
                          label: Text(material),
                          selected: prefs.availableMaterials.contains(material),
                          onSelected: (selected) {
                            final values = {...prefs.availableMaterials};
                            if (selected) {
                              values.add(material);
                            } else {
                              values.remove(material);
                            }
                            widget.controller.updatePreferences(
                              FamilyPreferences(
                                availableMaterials: values.toList(),
                                excludedMaterials: prefs.excludedMaterials,
                                languageMode: prefs.languageMode,
                                reminderEnabled: prefs.reminderEnabled,
                                reminderTime: prefs.reminderTime,
                              ),
                            );
                          },
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                _SettingsCard(
                  icon: Icons.notifications_none_rounded,
                  title: '提醒',
                  subtitle: '按家庭时间提醒。当天安排都记完了，或已经过了 20:00，就不再提醒。',
                  trailing: Switch.adaptive(
                    value: prefs.reminderEnabled,
                    onChanged: _reminderBusy
                        ? null
                        : (value) => _setReminderEnabled(prefs, value),
                  ),
                  child: ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.schedule_rounded),
                    title: const Text('提醒时段'),
                    subtitle: Text(prefs.reminderTime),
                    trailing: const Icon(Icons.chevron_right_rounded),
                    onTap: () => _pickReminderTime(prefs),
                  ),
                ),
                const SizedBox(height: 14),
                _SettingsCard(
                  icon: Icons.cloud_outlined,
                  title: '数据状态',
                  subtitle: _serviceDescription(),
                  child: Column(
                    children: [
                      _StatusRow(
                        label: '内容来源',
                        value: widget.controller.isPreview
                            ? '本机演示 / 缓存'
                            : '家庭服务',
                      ),
                      _StatusRow(
                        label: '待同步记录',
                        value: '${widget.controller.pendingCount} 条',
                      ),
                      _StatusRow(
                        label: '登录账号',
                        value: widget.controller.accountLabel ?? '未登录',
                      ),
                      const SizedBox(height: 8),
                      OutlinedButton.icon(
                        onPressed: _draftExportBusy
                            ? null
                            : _exportPendingDrafts,
                        icon: _draftExportBusy
                            ? const SizedBox.square(
                                dimension: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.download_outlined),
                        label: Text(_draftExportBusy ? '正在准备…' : '只导出我的待同步草稿'),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                _SettingsCard(
                  icon: Icons.inventory_2_outlined,
                  title: '导出家庭资料',
                  subtitle: '家庭管理员可以按日期和类型导出清单、CSV 与已上传照片，并查看遗漏项。',
                  child: FilledButton.icon(
                    onPressed: widget.controller.connected
                        ? () => showExportSheet(context, widget.controller)
                        : null,
                    icon: const Icon(Icons.download_outlined),
                    label: const Text('选择导出范围'),
                  ),
                ),
                const SizedBox(height: 14),
                _SettingsCard(
                  icon: Icons.link_rounded,
                  title: '家庭服务',
                  subtitle: widget.controller.api == null
                      ? '可选：连接自己部署的私有家庭服务，让两位家长同步记录。只用本机也可以。'
                      : '登录后会从家庭服务刷新今天，并继续同步待传记录。',
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (widget.controller.api == null) ...[
                        TextField(
                          controller: _serviceAddress,
                          enabled: !_serviceBusy,
                          keyboardType: TextInputType.url,
                          autocorrect: false,
                          decoration: const InputDecoration(
                            labelText: '服务地址',
                            hintText: 'http://192.168.1.20:4318/v2',
                            helperText: '支持 http:// 局域网地址或 https:// 地址；离开可信网络时请使用 HTTPS。',
                          ),
                        ),
                        const SizedBox(height: 12),
                        FilledButton(
                          onPressed: _serviceBusy ? null : _connectService,
                          child: Text(_serviceBusy ? '正在检查地址…' : '使用这个家庭服务'),
                        ),
                        if (_loginError != null) ...[
                          const SizedBox(height: 10),
                          InfoBanner(
                            message: _loginError!,
                            tone: StatusTone.warning,
                            icon: Icons.error_outline_rounded,
                          ),
                        ],
                      ] else if (_showLogin &&
                          widget.controller.accountLabel == null) ...[
                        TextField(
                          controller: _email,
                          enabled: !widget.controller.loginBusy,
                          keyboardType: TextInputType.emailAddress,
                          autofillHints: const [AutofillHints.email],
                          decoration: const InputDecoration(labelText: '邮箱'),
                        ),
                        const SizedBox(height: 10),
                        TextField(
                          controller: _passphrase,
                          enabled: !widget.controller.loginBusy,
                          obscureText: true,
                          decoration: const InputDecoration(labelText: '账户口令'),
                        ),
                        if (_loginError != null) ...[
                          const SizedBox(height: 10),
                          InfoBanner(
                            message: _loginError!,
                            tone: StatusTone.warning,
                            icon: Icons.error_outline_rounded,
                          ),
                        ],
                        const SizedBox(height: 12),
                        FilledButton(
                          onPressed: widget.controller.loginBusy
                              ? null
                              : _login,
                          child: Text(
                            widget.controller.loginBusy ? '正在连接…' : '连接家庭服务',
                          ),
                        ),
                      ] else if (widget.controller.accountLabel == null)
                        OutlinedButton.icon(
                          onPressed: () => setState(() => _showLogin = true),
                          icon: const Icon(Icons.login_rounded),
                          label: const Text('登录家庭服务'),
                        )
                      else
                        OutlinedButton.icon(
                          onPressed: _logout,
                          icon: const Icon(Icons.logout_rounded),
                          label: const Text('退出这台设备'),
                        ),
                      if (widget.controller.config.apiBaseUrl == null &&
                          widget.controller.api != null)
                        TextButton(
                          onPressed: _serviceBusy ? null : _disconnectService,
                          child: const Text('更换家庭服务地址'),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                _SettingsCard(
                  icon: Icons.family_restroom_outlined,
                  title: '邀请另一位家长',
                  subtitle: '邀请 24 小时内有效且只能使用一次；不会显示假邀请码。',
                  child: Wrap(
                    spacing: 10,
                    runSpacing: 10,
                    children: [
                      if (widget.controller.connected)
                        FilledButton.icon(
                          onPressed: _inviteBusy ? null : _createInvitation,
                          icon: const Icon(Icons.person_add_alt_1_outlined),
                          label: const Text('创建邀请'),
                        ),
                      if (widget.controller.accountLabel != null)
                        OutlinedButton.icon(
                          onPressed: _inviteBusy ? null : _acceptInvitation,
                          icon: const Icon(Icons.group_add_outlined),
                          label: const Text('用邀请加入家庭'),
                        )
                      else if (widget.controller.api != null)
                        OutlinedButton.icon(
                          onPressed: _inviteBusy ? null : _redeemInvitation,
                          icon: const Icon(Icons.login_rounded),
                          label: const Text('用邀请创建账号'),
                        )
                      else
                        const Text('连接私有家庭服务后，可以邀请另一位家长。'),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                _SettingsCard(
                  icon: Icons.palette_outlined,
                  title: '显示方式',
                  subtitle: '跟随系统时会自动适配浅色和深色。',
                  child: DropdownButtonFormField<ThemeMode>(
                    initialValue: widget.controller.themeMode,
                    decoration: const InputDecoration(labelText: '主题'),
                    items: const [
                      DropdownMenuItem(
                        value: ThemeMode.system,
                        child: Text('跟随系统'),
                      ),
                      DropdownMenuItem(
                        value: ThemeMode.light,
                        child: Text('浅色'),
                      ),
                      DropdownMenuItem(
                        value: ThemeMode.dark,
                        child: Text('深色'),
                      ),
                    ],
                    onChanged: (value) {
                      if (value != null) {
                        widget.controller.setThemeMode(value);
                      }
                    },
                  ),
                ),
              ],
            ),
          ),
        ],
      );
    },
  );

  String _serviceDescription() {
    if (widget.controller.api == null) {
      return '家庭服务未连接；本机记录会留在 outbox，不会被静默丢弃。';
    }
    if (widget.controller.accountLabel == null) {
      return '服务地址已配置，但尚未登录。';
    }
    return '手机登录已建立；同步结果会以服务确认和待传数量为准。';
  }

  Future<void> _connectService() async {
    setState(() {
      _serviceBusy = true;
      _loginError = null;
    });
    try {
      await widget.controller.connectService(_serviceAddress.text);
      _serviceAddress.clear();
      setState(() => _showLogin = true);
      if (mounted) showQuietMessage(context, '服务地址已保存，请登录家庭账号。');
    } on Object catch (error) {
      if (mounted) {
        setState(
          () => _loginError = error.toString().replaceFirst(
            RegExp(r'^[^:]+:\s*'),
            '',
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _serviceBusy = false);
    }
  }

  Future<void> _login() async {
    setState(() => _loginError = null);
    try {
      await widget.controller.login(
        email: _email.text,
        passphrase: _passphrase.text,
      );
      _passphrase.clear();
      if (mounted) showQuietMessage(context, '登录成功，登录凭证只保存在系统安全存储。');
    } on Object catch (error) {
      if (mounted) {
        setState(
          () => _loginError = error.toString().replaceFirst(
            RegExp(r'^[^:]+:\s*'),
            '',
          ),
        );
      }
    }
  }

  Future<void> _logout() async {
    if (!await _canLeave('退出账号')) return;
    await widget.controller.logout();
    if (mounted) showQuietMessage(context, '这台设备已经退出家庭服务。');
  }

  Future<void> _disconnectService() async {
    if (!await _canLeave('更换家庭服务')) return;
    setState(() => _serviceBusy = true);
    try {
      await widget.controller.disconnectService();
      if (mounted) {
        setState(() {
          _showLogin = false;
          _loginError = null;
        });
      }
    } finally {
      if (mounted) setState(() => _serviceBusy = false);
    }
  }

  Future<bool> _canLeave(String action) async {
    final pending = widget.controller.pendingCount;
    final choice = await showDialog<_LeaveChoice>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('$action前确认'),
        content: Text(
          pending == 0
              ? '连接凭证会从这台设备移除。已经同步的家庭资料不会因此被删除。'
              : '还有 $pending 条待同步操作。你可以先只导出自己的草稿副本，再决定是否离开。导出文件不包含登录令牌或另一位家长的私有草稿。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('取消'),
          ),
          if (pending > 0)
            TextButton(
              onPressed: () =>
                  Navigator.of(context).pop(_LeaveChoice.exportDrafts),
              child: const Text('先导出草稿'),
            ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(_LeaveChoice.leave),
            child: Text(action),
          ),
        ],
      ),
    );
    if (choice == _LeaveChoice.exportDrafts) {
      await _exportPendingDrafts();
      return false;
    }
    return choice == _LeaveChoice.leave;
  }

  Future<void> _exportPendingDrafts() async {
    if (_draftExportBusy) return;
    setState(() => _draftExportBusy = true);
    try {
      final location = await widget.controller.exportPendingDrafts();
      if (!mounted) return;
      showQuietMessage(
        context,
        location == null ? '已取消保存，本机草稿仍然保留。' : '我的待同步草稿已保存到所选位置。',
      );
    } on Object catch (error) {
      if (mounted) {
        showQuietMessage(
          context,
          error.toString().replaceFirst(RegExp(r'^[^:]+:\s*'), ''),
        );
      }
    } finally {
      if (mounted) setState(() => _draftExportBusy = false);
    }
  }

  Future<void> _pickReminderTime(FamilyPreferences prefs) async {
    final values = prefs.reminderTime.split(':');
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(
        hour: int.tryParse(values.first) ?? 19,
        minute: int.tryParse(values.last) ?? 30,
      ),
      helpText: '选择提醒时段',
    );
    if (time == null) return;
    if (time.hour >= 20) {
      if (mounted) showQuietMessage(context, '请选择 20:00 之前的提醒时段。');
      return;
    }
    final value =
        '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}';
    await widget.controller.updatePreferences(
      FamilyPreferences(
        availableMaterials: prefs.availableMaterials,
        excludedMaterials: prefs.excludedMaterials,
        languageMode: prefs.languageMode,
        reminderEnabled: prefs.reminderEnabled,
        reminderTime: value,
      ),
    );
    if (mounted) {
      showQuietMessage(
        context,
        prefs.reminderEnabled ? '提醒时间已更新为 $value。' : '提醒时间已保存。',
      );
    }
  }

  Future<void> _createInvitation() async {
    final input = TextEditingController();
    String? validationError;
    final code = await showDialog<String>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('创建家庭邀请码'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('请设置一个家人容易记住的邀请码，24 小时内有效且只能使用一次。'),
              const SizedBox(height: 12),
              TextField(
                controller: input,
                autofocus: true,
                maxLength: 32,
                decoration: InputDecoration(
                  labelText: '邀请码',
                  helperText: '4～32 个字符，可使用中文、字母、数字、下划线或短横线。',
                  errorText: validationError,
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () {
                final value = input.text.trim();
                if (value.length < 4 ||
                    value.length > 32 ||
                    RegExp(r'\s').hasMatch(value)) {
                  setDialogState(() {
                    validationError = '请输入 4～32 个字符且不含空白';
                  });
                  return;
                }
                Navigator.of(dialogContext).pop(value);
              },
              child: const Text('创建'),
            ),
          ],
        ),
      ),
    );
    input.dispose();
    if (code == null || code.isEmpty || !mounted) return;
    setState(() => _inviteBusy = true);
    try {
      final invitation = await widget.controller.createInvitation(code: code);
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('一次性家庭邀请'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('请只发给要共同照顾宝宝的人。邀请码只显示这一次。'),
              const SizedBox(height: 14),
              SelectableText(
                invitation.token,
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 12),
              Text(
                '有效期至 ${invitation.expiresAt.toLocal()}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: invitation.token));
                if (context.mounted) Navigator.of(context).pop();
              },
              child: const Text('复制邀请码'),
            ),
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('关闭'),
            ),
          ],
        ),
      );
    } on Object catch (error) {
      if (mounted) {
        showQuietMessage(
          context,
          error.toString().replaceFirst(RegExp(r'^[^:]+:\s*'), ''),
        );
      }
    } finally {
      if (mounted) setState(() => _inviteBusy = false);
    }
  }

  Future<void> _acceptInvitation() async {
    final input = TextEditingController();
    final token = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('用邀请加入家庭'),
        content: TextField(
          controller: input,
          autofocus: true,
          minLines: 2,
          maxLines: 4,
          decoration: const InputDecoration(labelText: '邀请码'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(input.text.trim()),
            child: const Text('加入'),
          ),
        ],
      ),
    );
    input.dispose();
    if (token == null || token.isEmpty || !mounted) return;
    setState(() => _inviteBusy = true);
    try {
      await widget.controller.acceptInvitation(token);
      if (mounted) showQuietMessage(context, '邀请已接受，家庭资料已刷新。');
    } on Object catch (error) {
      if (mounted) {
        showQuietMessage(
          context,
          error.toString().replaceFirst(RegExp(r'^[^:]+:\s*'), ''),
        );
      }
    } finally {
      if (mounted) setState(() => _inviteBusy = false);
    }
  }

  Future<void> _redeemInvitation() async {
    final values = await showModalBottomSheet<_RedeemValues>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => const _RedeemInvitationSheet(),
    );
    if (values == null || !mounted) return;
    setState(() => _inviteBusy = true);
    try {
      await widget.controller.redeemInvitation(
        token: values.token,
        email: values.email,
        secretText: values.secretText,
        displayName: values.displayName,
      );
      if (mounted) showQuietMessage(context, '账号已创建并加入家庭。');
    } on Object catch (error) {
      if (mounted) {
        showQuietMessage(
          context,
          error.toString().replaceFirst(RegExp(r'^[^:]+:\s*'), ''),
        );
      }
    } finally {
      if (mounted) setState(() => _inviteBusy = false);
    }
  }

  Future<void> _setReminderEnabled(
    FamilyPreferences prefs,
    bool enabled,
  ) async {
    setState(() => _reminderBusy = true);
    try {
      await widget.controller.updatePreferences(
        FamilyPreferences(
          availableMaterials: prefs.availableMaterials,
          excludedMaterials: prefs.excludedMaterials,
          languageMode: prefs.languageMode,
          reminderEnabled: enabled,
          reminderTime: prefs.reminderTime,
        ),
      );
      if (mounted) {
        showQuietMessage(
          context,
          enabled ? '每天 ${prefs.reminderTime} 的系统提醒已开启。' : '系统提醒已关闭。',
        );
      }
    } on Object catch (error) {
      if (mounted) {
        showQuietMessage(
          context,
          error.toString().replaceFirst(RegExp(r'^[^:]+:\s*'), ''),
        );
      }
    } finally {
      if (mounted) setState(() => _reminderBusy = false);
    }
  }
}

enum _LeaveChoice { exportDrafts, leave }

class _RedeemValues {
  const _RedeemValues({
    required this.token,
    required this.email,
    required this.secretText,
    required this.displayName,
  });

  final String token;
  final String email;
  final String secretText;
  final String displayName;
}

class _RedeemInvitationSheet extends StatefulWidget {
  const _RedeemInvitationSheet();

  @override
  State<_RedeemInvitationSheet> createState() => _RedeemInvitationSheetState();
}

class _RedeemInvitationSheetState extends State<_RedeemInvitationSheet> {
  final _token = TextEditingController();
  final _email = TextEditingController();
  final _secret = TextEditingController();
  final _name = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _token.dispose();
    _email.dispose();
    _secret.dispose();
    _name.dispose();
    super.dispose();
  }

  void _submit() {
    final token = _token.text.trim();
    final email = _email.text.trim();
    final secret = _secret.text;
    final name = _name.text.trim();
    if (token.isEmpty || email.isEmpty || secret.length < 12 || name.isEmpty) {
      setState(() => _error = '请填写邀请码、邮箱、称呼，并使用至少 12 位口令。');
      return;
    }
    Navigator.of(context).pop(
      _RedeemValues(
        token: token,
        email: email,
        secretText: secret,
        displayName: name,
      ),
    );
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
          Text('用邀请创建账号', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 8),
          const Text('邀请码只能使用一次。账号信息只用于这个私有家庭服务。'),
          const SizedBox(height: 18),
          TextField(
            controller: _token,
            minLines: 2,
            maxLines: 4,
            decoration: const InputDecoration(labelText: '邀请码'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _email,
            keyboardType: TextInputType.emailAddress,
            autofillHints: const [AutofillHints.email],
            decoration: const InputDecoration(labelText: '邮箱'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _secret,
            obscureText: true,
            autofillHints: const [AutofillHints.newPassword],
            decoration: const InputDecoration(
              labelText: '账户口令',
              helperText: '至少 12 位，不会写入业务数据库。',
            ),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _name,
            maxLength: 60,
            decoration: const InputDecoration(labelText: '家里怎么称呼你'),
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
          FilledButton(onPressed: _submit, child: const Text('创建账号并加入')),
        ],
      ),
    ),
  );
}

class _FamilySummaryCard extends StatelessWidget {
  const _FamilySummaryCard({required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(20),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CircleAvatar(
            radius: 31,
            backgroundColor: Theme.of(context).colorScheme.primaryContainer,
            child: const Icon(Icons.child_care_rounded, size: 32),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  controller.activeChild?.label ?? '宝宝',
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(height: 4),
                Text(
                  controller.activeChild == null
                      ? '18～23 月龄 · 本机体验'
                      : controller.childAgeLabel,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    StatusPill(
                      label: controller.isPreview ? '本机模式' : '家庭服务',
                      tone: controller.isPreview
                          ? StatusTone.local
                          : StatusTone.pending,
                      icon: controller.isPreview
                          ? Icons.phone_android_rounded
                          : Icons.cloud_done_outlined,
                    ),
                    StatusPill(
                      label: '${controller.pendingCount} 条待同步',
                      tone: StatusTone.neutral,
                      icon: Icons.outbox_outlined,
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

class _SettingsCard extends StatelessWidget {
  const _SettingsCard({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.child,
    this.trailing,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
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
              ?trailing,
            ],
          ),
          const SizedBox(height: 6),
          Text(
            subtitle,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 14),
          child,
        ],
      ),
    ),
  );
}

class _StatusRow extends StatelessWidget {
  const _StatusRow({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Row(
      children: [
        Expanded(child: Text(label)),
        Text(
          value,
          style: Theme.of(context).textTheme.bodyMedium
              ?.copyWith(fontWeight: FontWeight.w700),
        ),
      ],
    ),
  );
}
