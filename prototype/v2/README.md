# BabyPlan v2 交互设计原型

直接双击 `index.html`；通过顶部选择手机、家长网页、内容工作台。项目总入口是根目录 `打开设计.html`。原型不依赖网络字体、API或CDN。

手机路径：`#today`、`#activity/roll/d1-1`、`#discover`、`#stage`、`#growth`、`#measurements`、`#settings`、`#week`、`#start`。桌面入口用 `?surface=parent` 或 `?surface=admin`；`embed=1` 隐藏评审外框，供截图。

演示日固定2026-11-13，随后七天采用相同内容包中的完整安排。所有成员、记录和初始故事均虚构；浏览器storage key为 `babyplan-design-v2.0`。清除演示必须经原型内确认，旧版原型的数据不受影响。

可操作：记录/跳过、陪伴者和备注、换项、轻松模式与恢复、搜索、书架备注、阶段观察、成长记录和家长确认的第一次、身长/身高/体重分方法趋势、提醒偏好、模拟离线与冲突、演示数据JSON导出、打印、内容编辑/审核/发布/撤回。

边界：邀请、账号恢复、完整编辑器、照片选择/上传、服务器通知、真实双设备同步、正式内容审核、回收站与永久删除是规格设计，原型不实现。图片只有原创CSS装饰、文字书封和明确占位，不能当成真实书封与家庭照片。

图标为Lucide 0.468.0，本地文件`lucide.min.js`，许可`LUCIDE-LICENSE`。其余页面与插画由本次设计编写。`content.js`从候选JSON生成；更改内容应运行 `tools/build_v2_content.py`，不能单改显示层。

检查使用项目`.work/design-tooling`下的Playwright Core 1.51.1和本机Chromium。交接包不含依赖缓存；维护者可在项目根目录执行 `npm install --prefix .work/design-tooling --no-audit --no-fund playwright-core@1.51.1`，设置 `BABYPLAN_CHROMIUM` 为自己的浏览器可执行文件后运行 `node tools/check_v2_prototype.cjs`。普通查看无需这些步骤。
