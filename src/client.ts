/**
 * dsh-github-trending-plus — Web (client) half.
 *
 * Registers a sidebar entry plus its main panel. The panel fetches
 * /dsh-github-trending/report from the host half and renders an interactive
 * card report: period tabs, language select, category chips, search, KPI tiles
 * and paginated repository cards that show the full analysis inline.
 */

window.__ModuleLoader__.load({
  id: 'dsh-github-trending-plus',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo

    const NS = 'dsh-github-trending'
    const BASE = '/dsh-github-trending'

/**
 * A 404 here means the HTTP route never mounted (host half not loaded, or the
 * carrier activated after the plugin). Say so instead of printing a bare status.
 */
function describeFailure(status, body) {
  if (status === 404) {
    return '报告接口未挂载（HTTP 404）· 主机端插件未加载，请重启 Harness 或重新启用插件'
  }
  return (body && body.error) || 'HTTP ' + status
}
    const PAGE_SIZE = 6

    /** Filled in apply(); the slot components are rendered by the shell, not by us. */
    let LOCALE = null

    const LANGUAGES = [
      { label: '全部语言', slug: '' },
      { label: 'TypeScript', slug: 'typescript' },
      { label: 'JavaScript', slug: 'javascript' },
      { label: 'Python', slug: 'python' },
      { label: 'Rust', slug: 'rust' },
      { label: 'Go', slug: 'go' },
      { label: 'C++', slug: 'c++' },
      { label: 'C', slug: 'c' },
      { label: 'C#', slug: 'c#' },
      { label: 'Java', slug: 'java' },
      { label: 'Kotlin', slug: 'kotlin' },
      { label: 'Swift', slug: 'swift' },
      { label: 'Dart', slug: 'dart' },
      { label: 'PHP', slug: 'php' },
      { label: 'Ruby', slug: 'ruby' },
      { label: 'Zig', slug: 'zig' },
      { label: 'Lua', slug: 'lua' },
      { label: 'Shell', slug: 'shell' },
      { label: 'Jupyter Notebook', slug: 'jupyter-notebook' },
      { label: 'Vue', slug: 'vue' },
      { label: 'HTML', slug: 'html' },
      { label: 'CSS', slug: 'css' },
      { label: 'Solidity', slug: 'solidity' },
    ]

    const ZH = {
      'nav.title': 'GitHub 趋势',
      'title': 'GitHub 趋势雷达',
      'subtitle': '抓取 Trending 榜单 · 结构化分析 · 交互式卡片报告',
      'refresh': '刷新',
      'period.daily': '日榜',
      'period.weekly': '周榜',
      'period.monthly': '月榜',
      'filter.language': '语言',
      'filter.category': '分类',
      'filter.all': '全部',
      'search.placeholder': '搜索仓库名、作者名、简介、topics、编程语言…',
      'stat.repos': '收录仓库',
      'stat.delta': '周期 star 增量',
      'stat.stars': '累计 star',
      'stat.language': '最热语言',
      'section.overview': '趋势总览',
      'section.repos': '仓库卡片',
      'page.prev': '上一页',
      'page.next': '下一页',
      'page.info': '第 {page} / {total} 页 · 共 {count} 个仓库',
      'loading': '正在抓取 GitHub Trending…',
      'loading.elapsed': '已等待 {seconds} 秒',
      'loading.slow': '网络较慢，仍在尝试…',
      'deep.pending': '完整卡片信息加载中，先显示榜单快照…',
      'deep.failed': '深卡信息未更新，仍显示已有内容',
      'cancel': '取消',
      'error': '报告加载失败',
      'error.network': '网络失败：暂时连不上 GitHub',
      'error.source': '数据源失败：GitHub 返回的数据暂时无法读取，请稍后重试',
      'error.canceled': '已取消等待，可点击重试',
      'error.attempts': '已尝试 {count} 次，共 {seconds} 秒；点「重试」会重新抓一次',
      'error.tried': '已尝试 {count} 次',
      'retry': '重试',
      'risk.high': '风险偏高',
      'risk.medium': '风险中等',
      'risk.low': '风险较低',
      'metric.stars': 'star',
      'metric.forks': 'fork',
      'metric.delta': '本期新增',
      'metric.growth': '周期增长率',
      'empty': '当前筛选下没有匹配的仓库',
      'empty.custom': '当前没有仓库命中，可放宽关键词',
      'shortfall': '数据源不足，仅收录 {count} 个（{reason}）',
      'network.fallback': '本次走了回退后端',
      'network.fail': '网络请求失败',
      'banner.dismiss': '不再显示',
      'banner.hidden': '提示已隐藏',
      'banner.restore': '点此恢复',
      'install.degraded': '安装质量为降级（探针未全过）',
      'updated': '更新于',
      'cache.hit': '缓存',
      'cache.fresh': '实时',
      'risk.summary': '风险分布',
      'view.on.github': '在 GitHub 打开',
      'card.zhReadme': '中文 README',
      'card.sourcePopular': '全语言榜',
      'card.sourceFiller': '其他语言榜补位',
      'ai.entry': 'AI 辅助筛选',
      'ai.needKey': '配置 API key 后可用',
      'ai.placeholder': '给我找几个 dsh 的美观性插件',
      'ai.submit': '筛选',
      'ai.loading': '筛选中…',
      'ai.clear': '清除',
      'ai.sorted': '按匹配度排序',
      'ai.match': '匹配度',
      'ai.searchGroup': '来自搜索 · 非本期榜单',
      'ai.searchBadge': '来自搜索',
      'ai.err.412': '未配置 key',
      'ai.err.403': '跨源请求被拒',
      'ai.err.429': '请求太频繁，请稍后再试',
      'ai.err.timeout': '请求超时，请稍后重试',
      'ai.err.generic': '筛选失败，请稍后重试',
      'ai.consent.title': '发送前确认',
      'ai.consent.host': '请求将发送到',
      'ai.consent.hostFallback': '已配置的接口地址',
      'ai.consent.payload': '发送内容：你输入的这句话 + 榜单里每个仓库的名称/简介/topics',
      'ai.consent.deny': '不发送',
      'ai.consent.allow': '同意并发送',
      'firstRun.title': '要不要配置以下功能（强烈推荐）',
      'firstRun.free.title': '① 什么都不配（默认）',
      'firstRun.free.body': '能看日/周/月趋势榜、13 个固定分类；项目介绍、技术栈、需要留意全在本地算，不发给任何人。限制：每小时只能查 GitHub 60 次，靠后的卡片拿不到热门标签和 README。',
      'firstRun.token.title': '② 配 GitHub token（可选，只读）',
      'firstRun.token.body': '好处：配额 60 → 5000 次/小时，靠后的卡片信息也完整。提醒：它是一把只读钥匙，别贴进公开仓库或聊天里。',
      'firstRun.ai.title': '③ 配 AI key（可选）',
      'firstRun.ai.body': '好处：「AI 辅助筛选」能用（一句话找项目），项目介绍从拼句变成真翻译，上手门槛也能写得更具体。提醒：你输入的那句话 + 榜单里每个仓库的名称/简介/标签会发给该服务商；每次筛选不到一分钱（v4.1f）。',
      'firstRun.wait': '注：打开后要等一会儿，这是正常的。首屏先出 50 张榜单卡，快的时候 2–3 秒、刚启动最慢约 10 秒。前 10 张的完整信息（README 摘要、许可证、上手门槛）还要十几到二十几秒才补上，卡片上方会有一行提示。AI 写的项目介绍要等完整信息到了才发请求，所以比卡片更晚出现，网络差的时候可能几十秒；它只替换文字，不会让卡片变空或报错。Steam++ 会比一般梯子慢一些。',
      'firstRun.use': '先这样用',
      'firstRun.help': '去看怎么配',
      'firstRun.remember': '下次不再提示',
      'firstRun.note': '（教程在页面末尾）',
      'help.hint': '配置教程在页面最底部，向下滚动即可看到',
      'help.hint.go': '去底部',
      'help.title': '怎么配置（小白也能照着做）',
      'help.copy': '复制命令',
      'help.github.title': 'GitHub token',
      'help.github.file': '文件位置：%USERPROFILE%\\.dsh\\github-token',
      'help.github.steps': '1. 浏览器打开 https://github.com/settings/tokens\n2. 点右上角 Generate new token → Generate new token (classic)\n3. Note 填 github-trending；Expiration 选 90 days（到期后重新生成一次即可；选 No expiration 更省事，但一旦泄露永远有效，不推荐）；下面只勾 public_repo 这一项\n4. 页面底部点绿色 Generate token\n5. 复制页面上出现的 ghp_ 开头那串（只显示这一次，先粘到记事本）\n6. 选一种方式保存：\n   A. 文件方式（推荐）：打开资源管理器，在地址栏粘贴 %USERPROFILE%\\.dsh 回车；\n      如果没有 .dsh 文件夹就先新建；在里面新建文本文件，改名成 github-token（去掉 .txt）；\n      用记事本打开，把 ghp_ 那串粘进去，保存。\n   B. 环境变量方式：Win+R 输入 powershell 回车，粘贴 setx GITHUB_TOKEN "ghp_你的token" 回车；\n      然后彻底退出 DSH（托盘右键退出）再打开。\n7. 回到面板，教程区应显示「GitHub token：已配置」',
      'help.github.faq.title': '常见问题',
      'help.github.faq': '401/403 → token 过期或被吊销，重新生成\n显示未配置 → 文件名多了 .txt 或放错目录\n不想用了 → 删文件或 setx 置空\n· token 过期后：面板会显示「GitHub token：未配置」，重新生成一个换上即可，不用改任何代码',
      'help.ai.title': 'AI key',
      'help.ai.file': '文件位置：%USERPROFILE%\\.dsh\\github-trending-ai-key',
      'help.ai.steps': '第 1 步　注册 / 登录\n1. 浏览器打开 https://platform.deepseek.com\n2. 手机号或邮箱注册，已有账号直接登录。\n   注意：这里的账号和你平时登录 DSH 的账号不是一回事，API 是按用量单独计费的。\n\n第 2 步　充值（提示余额不足时再做）\n1. 左侧菜单点「充值」，选最小额度付款。\n2. 只跑翻译和筛选的话，几块钱能用很久；一次筛选不到一分钱。\n\n第 3 步　创建 key\n1. 左侧菜单点「API keys」，再点「创建 API key」。\n2. 名字随便填（例如 dsh-trending），点创建。\n3. 弹窗里出现 sk- 开头的一串字符，这是唯一一次显示的机会，点旁边的复制按钮。\n   关掉弹窗就只能重新创建，所以先粘到记事本里。\n\n第 4 步　存到本机（两种方式，选一种）\n\n方式 A：文件方式（推荐，不用重新登录）\n1. 按 Win+E 打开资源管理器，在顶部地址栏粘贴 %USERPROFILE%\\.dsh 回车。\n2. 如果提示找不到：先打开 %USERPROFILE%，点「查看」→「显示」→ 勾上「隐藏的项目」，就能看到 .dsh 文件夹。\n3. 在 .dsh 文件夹里右键 → 新建 → 文本文档。\n4. 把文件名改成 github-trending-ai-key（必须把结尾的 .txt 删掉；看不到 .txt 就先在「查看」里勾上「文件扩展名」）。\n5. 双击打开这个文件，把第 3 步复制的 sk- 那串粘进去，Ctrl+S 保存后关闭。\n\n方式 B：环境变量方式\n1. 按 Win+R，输入 powershell 回车。\n2. 粘贴这一行后回车：setx DSH_GITHUB_TRENDING_AI_KEY "sk-你的key"\n3. 看到「成功: 指定的值已保存」就说明写进去了。\n4. 在托盘图标上右键彻底退出 DSH，再重新打开（环境变量只在启动时读取一次）。\n5. 如果面板仍显示「未配置」：说明 DSH 是从旧进程启动的，重启一次电脑最稳妥。\n\n第 5 步　验证\n1. 回到面板，拉到最底部展开「怎么配置」，应显示「AI key：已配置」。\n2. 在搜索框旁点「AI 辅助筛选」，输入一句「给我找几个 dsh 的美观性插件」。\n3. 第一次会弹出「发送前确认」，点「同意并发送」，稍等几秒就能看到每个仓库的匹配度和理由。\n\n常见问题\n· 提示 401 或余额不足：回第 2 步充值即可。\n· 明明存了却显示未配置：多半是文件名多了 .txt，或放错了目录（正确位置是 C:\\Users\\你的用户名\\.dsh）。\n· 不想再用了：删掉那个文件，或把环境变量设为空。\n· 换别的服务商：在插件配置里填 aiBaseURL 与 aiModel（默认 https://api.deepseek.com 与 deepseek-flash）。',
      'ai.help.title': '如何配置 API',
      'ai.help.state': '状态',
      'ai.help.expand': '展开',
      'ai.help.collapse': '收起',
      'ai.help.keyLead': 'Key 二选一，面板只显示配置状态，不回显 key：',
      'ai.help.keyEnv': '环境变量：DSH_GITHUB_TRENDING_AI_KEY',
      'ai.help.keyFile': '或写入文件（Windows）：%USERPROFILE%\\.dsh\\github-trending-ai-key',
      'ai.help.base': '接口地址 / 模型可用 aiBaseURL / aiModel 配置，默认 https://api.deepseek.com / deepseek-flash。',
      'ai.help.note': '不配也能用，只是没有 AI 筛选与翻译。',
      'ai.status.configured': '已配置',
      'ai.status.unconfigured': '未配置',
    }

    const EN = {
      'nav.title': 'GitHub Trending',
      'title': 'GitHub Trending Radar',
      'subtitle': 'Scrape the board · structured analysis · interactive card report',
      'refresh': 'Refresh',
      'period.daily': 'Today',
      'period.weekly': 'This week',
      'period.monthly': 'This month',
      'filter.language': 'Language',
      'filter.category': 'Category',
      'filter.all': 'All',
      'search.placeholder': 'Search repository name, owner, description, topics or language…',
      'stat.repos': 'Repositories',
      'stat.delta': 'Star gain',
      'stat.stars': 'Total stars',
      'stat.language': 'Top language',
      'section.overview': 'Overview',
      'section.repos': 'Repository cards',
      'page.prev': 'Previous',
      'page.next': 'Next',
      'page.info': 'Page {page} / {total} · {count} repositories',
      'loading': 'Fetching GitHub Trending…',
      'loading.elapsed': 'Waited {seconds}s',
      'loading.slow': 'The network is slow, still trying…',
      'deep.pending': 'Loading full card details; showing the trending snapshot first…',
      'deep.failed': 'Full card details were not updated; showing what is already loaded',
      'cancel': 'Cancel',
      'error': 'Failed to load the report',
      'error.network': 'Network failure: cannot reach GitHub',
      'error.source': 'Data source failure: GitHub returned unreadable data. Please retry later.',
      'error.canceled': 'Canceled. You can retry.',
      'error.attempts': 'Tried {count} times in {seconds}s; “Retry” starts a fresh fetch',
      'error.tried': 'Tried {count} times',
      'retry': 'Retry',
      'risk.high': 'High risk',
      'risk.medium': 'Medium risk',
      'risk.low': 'Low risk',
      'metric.stars': 'stars',
      'metric.forks': 'forks',
      'metric.delta': 'gain',
      'metric.growth': 'growth',
      'empty': 'No repository matches the current filters',
      'empty.custom': 'No repository matches this board — try broader keywords',
      'shortfall': 'Source fell short: only {count} collected ({reason})',
      'network.fallback': 'This run used the fallback backend',
      'network.fail': 'Network request failed',
      'banner.dismiss': 'Hide this',
      'banner.hidden': 'Banners hidden',
      'banner.restore': 'Restore',
      'install.degraded': 'Install quality is degraded (probe did not fully pass)',
      'updated': 'Updated',
      'cache.hit': 'cached',
      'cache.fresh': 'live',
      'risk.summary': 'Risk mix',
      'view.on.github': 'Open on GitHub',
      'card.zhReadme': 'Chinese README',
      'card.sourcePopular': 'All languages',
      'card.sourceFiller': 'Other language board',
      'ai.entry': 'AI assist',
      'ai.needKey': 'Available after configuring an API key',
      'ai.placeholder': 'Find me a few good-looking dsh plugins',
      'ai.submit': 'Filter',
      'ai.loading': 'Filtering…',
      'ai.clear': 'Clear',
      'ai.sorted': 'Sorted by match score',
      'ai.match': 'Match',
      'ai.searchGroup': 'From search · not in this board',
      'ai.searchBadge': 'From search',
      'ai.err.412': 'AI key is not configured',
      'ai.err.403': 'Cross-origin request rejected',
      'ai.err.429': 'Too many requests, please try again later',
      'ai.err.timeout': 'Request timed out, please try again later',
      'ai.err.generic': 'AI filter failed, please try again later',
      'ai.consent.title': 'Confirm before sending',
      'ai.consent.host': 'Request will be sent to',
      'ai.consent.hostFallback': 'the configured API base URL',
      'ai.consent.payload': 'Payload: your sentence + each repository name/description/topics on this board',
      'ai.consent.deny': 'Do not send',
      'ai.consent.allow': 'Agree and send',
      'firstRun.title': 'Configure these features? (Strongly recommended)',
      'firstRun.free.title': '① Configure nothing (default)',
      'firstRun.free.body': 'You can browse daily/weekly/monthly trending boards and the 13 fixed categories; intros, tech stack and watch-outs are computed locally and sent nowhere. Limit: only 60 GitHub requests per hour, and cards further down miss topics and README.',
      'firstRun.token.title': '② Add a GitHub token (optional, read-only)',
      'firstRun.token.body': 'Benefit: the quota rises from 60 to 5000 requests per hour and later cards get full details. Warning: it is a read-only key; never paste it into a public repository or a chat.',
      'firstRun.ai.title': '③ Add an AI key (optional)',
      'firstRun.ai.body': 'Benefit: "AI assist" works (find projects in one sentence), intros become real translations instead of assembled sentences, and the onboarding hints get more specific. Warning: your sentence + each repository name/description/topics on the board are sent to that provider; each filter costs well under a cent (v4.1f).',
      'firstRun.wait': 'Note: the first load takes a moment, and that is expected. The 50 board cards appear first (2–3 s once warm, up to ~10 s right after start). Full details for the first 10 cards (README excerpt, licence, onboarding) need another ten to twenty-odd seconds, and a line above the list shows that. The model-written intro is only requested once the full details are in, so it lands later than the cards and can take tens of seconds on a slow link; it only swaps text and never blanks a card or shows an error. Steam++ is slower than a normal proxy.',
      'firstRun.use': 'Use as is',
      'firstRun.help': 'Show me how',
      'firstRun.remember': "Don't remind me again",
      'firstRun.note': ' (tutorial at the end of the page)',
      'help.hint': 'The setup tutorial is at the very bottom of the page — scroll down to see it',
      'help.hint.go': 'Go to bottom',
      'help.title': 'How to configure (step by step)',
      'help.copy': 'Copy command',
      'help.github.title': 'GitHub token',
      'help.github.file': 'File location: %USERPROFILE%\\.dsh\\github-token',
      'help.github.steps': '1. Open https://github.com/settings/tokens in a browser\n2. Top right: Generate new token → Generate new token (classic)\n3. Note: github-trending; Expiration: 90 days; tick only public_repo\n4. Click the green Generate token at the bottom\n5. Copy the ghp_ token shown (seen only once; paste it into Notepad first)\n6. Save it one of two ways:\n   A. File (recommended): open Explorer, paste %USERPROFILE%\\.dsh in the address bar and press Enter;\n      create the .dsh folder if missing; create a text file there and rename it to github-token (drop .txt);\n      open it in Notepad, paste the ghp_ token and save.\n   B. Environment variable: Win+R, type powershell, press Enter, then paste setx GITHUB_TOKEN "ghp_your_token";\n      fully quit DSH (tray icon → Quit) and reopen it.\n7. Back in the panel, the tutorial should show "GitHub token: Configured"',
      'help.github.faq.title': 'FAQ',
      'help.github.faq': '401/403 → the token expired or was revoked; generate a new one\nShows not configured → the file name still has .txt or is in the wrong folder\nNo longer needed → delete the file or clear it with setx',
      'help.ai.title': 'AI key',
      'help.ai.file': 'File location: %USERPROFILE%\\.dsh\\github-trending-ai-key',
      'help.ai.steps': 'Step 1: Sign up / sign in\n1. Open https://platform.deepseek.com in a browser\n2. Register with a phone number or email, or sign in.\n   Note: this account is separate from your DSH login; the API is billed by usage.\n\nStep 2: Top up (only when told the balance is low)\n1. Click "Top up" in the left menu and pay the smallest amount.\n2. A few dollars lasts a long time for translation and filtering; one filter costs under a cent.\n\nStep 3: Create a key\n1. Click "API keys" in the left menu, then "Create API key".\n2. Pick any name (e.g. dsh-trending) and create it.\n3. The dialog shows a sk- string once; click the copy button next to it.\n   Closing the dialog means creating a new one, so paste it into Notepad first.\n\nStep 4: Store it locally (pick one)\n\nOption A: File (recommended, no re-login)\n1. Press Win+E, paste %USERPROFILE%\\.dsh in the address bar and press Enter.\n2. If it is missing: open %USERPROFILE%, View → Show → Hidden items to reveal .dsh.\n3. Right-click in .dsh → New → Text Document.\n4. Rename it to github-trending-ai-key (delete the .txt suffix; enable file name extensions under View if needed).\n5. Open it, paste the sk- string from Step 3, press Ctrl+S and close.\n\nOption B: Environment variable\n1. Press Win+R, type powershell and press Enter.\n2. Paste this line and press Enter: setx DSH_GITHUB_TRENDING_AI_KEY "sk_your_key"\n3. "SUCCESS: Specified value was saved" means it worked.\n4. Fully quit DSH from the tray icon and reopen it (environment variables are read once at startup).\n5. If the panel still says "Not configured", DSH was started by an old process; a reboot is the safest fix.\n\nStep 5: Verify\n1. Back in the panel, expand "How to configure" at the bottom; it should show "AI key: Configured".\n2. Click "AI assist" next to the search box and type "Find me a few good-looking dsh plugins".\n3. The first time, "Confirm before sending" appears; click "Agree and send" and wait a few seconds for match scores and reasons.\n\nFAQ\n· 401 or low balance: top up in Step 2.\n· Saved but still shown as not configured: usually the file name still has .txt or it is in the wrong folder (the correct location is C:\\Users\\your-name\\.dsh).\n· No longer needed: delete the file or clear the environment variable.\n· Another provider: set aiBaseURL and aiModel in the plugin config (defaults: https://api.deepseek.com and deepseek-flash).',
      'ai.help.title': 'How to configure the API',
      'ai.help.state': 'Status',
      'ai.help.expand': 'Expand',
      'ai.help.collapse': 'Collapse',
      'ai.help.keyLead': 'Provide the key one of two ways; the panel shows the status only, never the key:',
      'ai.help.keyEnv': 'Environment variable: DSH_GITHUB_TRENDING_AI_KEY',
      'ai.help.keyFile': 'Or write it to a file (Windows): %USERPROFILE%\\.dsh\\github-trending-ai-key',
      'ai.help.base': 'Set aiBaseURL / aiModel to override the endpoint/model; defaults are https://api.deepseek.com / deepseek-flash.',
      'ai.help.note': 'Everything else works without a key — only AI filtering and translation are unavailable.',
      'ai.status.configured': 'Configured',
      'ai.status.unconfigured': 'Not configured',
    }

    function detectLocale(locale) {
      try {
        if (locale && typeof locale.getLocale === 'function') {
          const active = locale.getLocale()
          if (active && active.active) return String(active.active)
        }
      } catch (error) {
        /* ignore */
      }
      try {
        if (typeof navigator !== 'undefined' && navigator.language) return String(navigator.language)
      } catch (error) {
        /* ignore */
      }
      return 'zh'
    }

    function makeT(locale) {
      const active = detectLocale(locale)
      const table = active.toLowerCase().indexOf('en') === 0 ? EN : ZH
      const fallback = ZH
      return function t(key, params) {
        let text = table[key] !== undefined ? table[key] : fallback[key] !== undefined ? fallback[key] : key
        if (params) {
          for (const name of Object.keys(params)) text = text.split('{' + name + '}').join(String(params[name]))
        }
        return text
      }
    }

    /** Default translator for the exported helpers (tests call them without a locale). */
    function defaultT() {
      return makeT(null)
    }

    function boardLabel(board) {
      return String(board.label || board.zh || board.en || board.key || '')
    }

    /**
     * Chip row: "全部" first, then the fixed 13-bucket catalogue carried by the
     * report, then user-defined boards. No de-duplication from `repos`.
     */
    function buildChips(report, t) {
      const tr = typeof t === 'function' ? t : defaultT()
      const chips = [{ key: 'all', label: tr('filter.all') }]
      const catalog = (report && report.catalog) || []
      for (const rule of catalog) chips.push({ key: rule.key, label: rule.zh || rule.en || rule.key })
      const boards = (report && report.customBoards) || []
      for (const board of boards) chips.push({ key: board.key, label: boardLabel(board), custom: true })
      return chips
    }

    function repoMatchesBoard(repo, board) {
      if (!board) return false
      const blob = [repo.fullName, repo.description, repo.tldr, (repo.stack || []).join(' '), (repo.topics || []).join(' ')]
        .join(' ')
        .toLowerCase()
      return (board.keywords || []).some(function (keyword) {
        const needle = String(keyword || '').trim().toLowerCase()
        return needle !== '' && blob.indexOf(needle) >= 0
      })
    }

    /**
     * Active chip filter. `all` keeps everything (including uncategorised
     * repos); a custom board matches keywords against one merged text blob;
     * every other chip requires the key to be present in `repo.categories`.
     */
    function filterRepos(repos, active, search, customBoards) {
      const list = Array.isArray(repos) ? repos : []
      const boards = Array.isArray(customBoards) ? customBoards : []
      const board = active && active !== 'all' ? boards.find(function (item) { return item.key === active }) || null : null
      const needle = String(search || '').trim().toLowerCase()
      return list.filter(function (repo) {
        if (active && active !== 'all') {
          if (board) {
            if (!repoMatchesBoard(repo, board)) return false
          } else {
            const categories = repo.categories || []
            const hit = categories.some(function (entry) { return (entry && entry.key ? entry.key : entry) === active })
            if (!hit) return false
          }
        }
        if (!needle) return true
        const blob = [
          repo.fullName,
          repo.owner,
          repo.description,
          repo.tldr,
          (repo.stack || []).join(' '),
          (repo.topics || []).join(' '),
          repo.language,
        ]
          .join(' ')
          .toLowerCase()
        return blob.indexOf(needle) >= 0
      })
    }

    function emptyHint(t) {
      const tr = typeof t === 'function' ? t : defaultT()
      return tr('empty.custom')
    }

    function shortfallText(report, t) {
      const tr = typeof t === 'function' ? t : defaultT()
      if (!report || !(Number(report.shortfall) > 0)) return ''
      const count = Array.isArray(report.repos) ? report.repos.length : 0
      return tr('shortfall', { count: count, reason: report.shortfallReason || '' })
    }

    function networkBanner(report, t) {
      const tr = typeof t === 'function' ? t : defaultT()
      if (!report) return ''
      if (report.networkStatus === 'fallback') return tr('network.fallback')
      if (report.networkStatus === 'fail') return tr('network.fail')
      return ''
    }

    function installQualityBanner(report, t) {
      const tr = typeof t === 'function' ? t : defaultT()
      if (!report || report.installQuality !== 'degraded') return ''
      return tr('install.degraded')
    }

    /** Human-readable error headline: network / data source / user cancel. */
    function errorHeadline(error, t) {
      const tr = typeof t === 'function' ? t : defaultT()
      if (!error) return tr('error')
      if (error.class === 'canceled') return tr('error.canceled')
      if (error.class === 'network') return tr('error.network')
      return tr('error.source')
    }

    /**
     * "已尝试 2 次，共 12.4 秒；点「重试」会重新抓一次" — the subtitle of the
     * error state. Empty for payloads without per-attempt data (e.g. a failed
     * panel fetch), which keep the technical detail line instead.
     */
    function errorAttemptLine(error, t) {
      const tr = typeof t === 'function' ? t : defaultT()
      if (!error || !Array.isArray(error.attempts) || error.attempts.length === 0) return ''
      const seconds = (Math.max(0, Number(error.durationMs) || 0) / 1000).toFixed(1)
      return tr('error.attempts', { count: error.attempts.length, seconds: seconds })
    }

    /** One localStorage key holds every dismissed-banner flag for this panel. */
    const UI_MEMORY_KEY = 'dsh-github-trending:ui'

    /**
     * localStorage is unavailable in Node and can throw even in a browser
     * (private mode, disabled storage, quota). Resolve it defensively so every
     * caller degrades to "do not remember" instead of breaking the panel.
     */
    function uiStorage() {
      try {
        if (typeof localStorage === 'undefined' || !localStorage) return null
        return localStorage
      } catch (error) {
        return null
      }
    }

    /**
     * Read the dismissed-banner flags once on the first render. A missing key,
     * an unparsable value or a throwing storage all mean "nothing is hidden".
     */
    function readUiMemory() {
      const store = uiStorage()
      if (!store) return {}
      try {
        const raw = store.getItem(UI_MEMORY_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return {}
        return { fallback: parsed.fallback === true, shortfall: parsed.shortfall === true }
      } catch (error) {
        return {}
      }
    }

    /** Persist only the banners the user actually dismissed. */
    function writeUiMemory(memory) {
      const store = uiStorage()
      if (!store) return
      try {
        const value = {}
        if (memory && memory.fallback === true) value.fallback = true
        if (memory && memory.shortfall === true) value.shortfall = true
        store.setItem(UI_MEMORY_KEY, JSON.stringify(value))
      } catch (error) {
        /* storage is best-effort; the panel keeps working without memory */
      }
    }

    /** Restore entry point: forget every dismissed banner. */
    function clearUiMemory() {
      const store = uiStorage()
      if (!store) return
      try {
        store.removeItem(UI_MEMORY_KEY)
      } catch (error) {
        /* ignore */
      }
    }

    /**
     * One-time consent for the AI filter. The dialog is shown before the first
     * outbound `/ai` request; agreeing records this key. A missing, unreadable
     * or throwing storage simply means "ask again next time" — never a crash.
     */
    const AI_CONSENT_KEY = 'dsh-github-trending:ai-consent'
    const AI_TIMEOUT_MS = 30000

    function readAiConsent() {
      const store = uiStorage()
      if (!store) return false
      try {
        const raw = store.getItem(AI_CONSENT_KEY)
        return raw === '1' || raw === 'true' || raw === 'granted'
      } catch (error) {
        return false
      }
    }

    function writeAiConsent() {
      const store = uiStorage()
      if (!store) return
      try {
        store.setItem(AI_CONSENT_KEY, '1')
      } catch (error) {
        /* storage is best-effort; the next submit asks again */
      }
    }

    /**
     * First-run onboarding. Only the explicit "下次不再提示" checkbox writes the
     * memory key, so closing the dialog without ticking it keeps the reminder
     * for the next open. Missing or throwing storage simply shows it again.
     */
    const FIRST_RUN_KEY = 'dsh-github-trending:first-run'

    function readFirstRunPending() {
      const store = uiStorage()
      if (!store) return true
      try {
        return store.getItem(FIRST_RUN_KEY) !== '1'
      } catch (error) {
        return true
      }
    }

    function writeFirstRunDone() {
      const store = uiStorage()
      if (!store) return
      try {
        store.setItem(FIRST_RUN_KEY, '1')
      } catch (error) {
        /* storage is best-effort; the dialog appears again next time */
      }
    }

    /**
     * Copy only the command template in the tutorial. Credentials never reach
     * the clipboard: the copied strings are the static dictionary entries.
     */
    function copyHelpText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(String(text))
        }
      } catch (error) {
        /* clipboard can be blocked; the text stays selectable in the block */
      }
    }

    function compact(value) {
      const number = Number(value) || 0
      if (Math.abs(number) >= 1000000) return (number / 1000000).toFixed(1) + 'M'
      if (Math.abs(number) >= 10000) return (number / 1000).toFixed(1) + 'k'
      return new Intl.NumberFormat('en-US').format(Math.round(number))
    }

    function percent(value) {
      const raw = (Number(value) || 0) * 100
      if (raw >= 10) return raw.toFixed(0) + '%'
      if (raw >= 1) return raw.toFixed(1) + '%'
      return raw.toFixed(2) + '%'
    }

    /** Local wall-clock time for the report timestamp (browser time zone). */
    function localTime(iso) {
      const time = Date.parse(String(iso || ''))
      if (!Number.isFinite(time)) return ''
      const date = new Date(time)
      const pad = function (value) { return String(value).padStart(2, '0') }
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    function shortRisk(risk, t) {
      if (!risk) return ''
      return [t('risk.high') + ' ' + risk.high, t('risk.medium') + ' ' + risk.medium, t('risk.low') + ' ' + risk.low].join(' · ')
    }

    /** Owner avatar straight from GitHub so every card carries a recognisable image. */
    function avatarUrl(owner) {
      const login = String(owner || '').trim()
      if (!login) return ''
      return 'https://github.com/' + encodeURIComponent(login) + '.png?size=96'
    }

    function riskTone(level) {
      if (level === 'high') return 'error'
      if (level === 'medium') return 'warn'
      return 'success'
    }

    const CSS = [
      '.gt-root{box-sizing:border-box;height:100%;overflow:auto;padding:22px 26px 56px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif}',
      '.gt-root *{box-sizing:border-box}',
      '.gt-shell{max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:18px}',
      '.gt-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}',
      '.gt-brand{display:flex;align-items:center;gap:12px;min-width:260px}',
      '.gt-mark{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);flex:none}',
      '.gt-h1{margin:0;font-size:19px;font-weight:650;letter-spacing:.2px}',
      '.gt-sub{margin:2px 0 0;font-size:12.5px;color:var(--dsw-alias-label-secondary)}',
      '.gt-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.gt-btn{display:inline-flex;align-items:center;gap:6px;height:32px;min-width:64px;padding:0 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;text-decoration:none;white-space:nowrap;transition:border-color .15s ease,background .15s ease}',
      '.gt-btn:hover{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.gt-btn[data-primary="1"]{background:var(--dsw-alias-brand-primary,#4b6bfb);border-color:var(--dsw-alias-brand-primary,#4b6bfb);color:var(--dsw-alias-bg-base,#fff)}',
      '.gt-btn:disabled{opacity:.55;cursor:not-allowed}',
      '.gt-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}',
      '.gt-seg{display:inline-flex;padding:3px;gap:2px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}',
      '.gt-seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;padding:5px 12px;border-radius:8px;cursor:pointer}',
      '.gt-seg button[data-active="1"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.12)}',
      '.gt-select,.gt-input{height:32px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:0 10px;outline:none}',
      '.gt-select:focus,.gt-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.gt-input{flex:1 1 220px;min-width:180px}',
      '.gt-chips{display:flex;gap:6px;flex-wrap:wrap}',
      '.gt-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}',
      '.gt-chip[data-active="1"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}',
      '.gt-banners{display:flex;flex-direction:column;gap:6px}',
      '.gt-banner{padding:8px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.gt-banner.gt-shortfall{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.gt-banner.gt-install-quality{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent)}',
      '.gt-banner{display:flex;align-items:center;justify-content:space-between;gap:10px}',
      '.gt-banner-text{min-width:0}',
      '.gt-banner-dismiss{border:0;background:transparent;color:inherit;font:inherit;font-size:11.5px;cursor:pointer;opacity:.72;white-space:nowrap;text-decoration:underline;padding:0}',
      '.gt-banner-dismiss:hover{opacity:1}',
      '.gt-help-hint{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}',
      '.gt-restore-bar{display:flex;justify-content:center;margin-top:-4px}',
      '.gt-restore{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;text-decoration:underline;padding:0}',
      '.gt-restore:hover{color:var(--dsw-alias-brand-primary)}',
      '.gt-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}',
      '.gt-stat{padding:14px 15px;border-radius:13px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.gt-stat-label{font-size:11.5px;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
      '.gt-stat-value{font-size:22px;font-weight:650;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.gt-stat-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.gt-card{border:1px solid var(--dsw-alias-border-l1);border-radius:15px;background:var(--dsw-alias-bg-layer-1);padding:16px;min-width:0}',
      '.gt-section-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 10px;font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.gt-section-title small{font-weight:400;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.gt-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
      '.gt-repo{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);padding:15px;display:flex;flex-direction:column;gap:10px;min-width:0;transition:border-color .15s ease,transform .15s ease}',
      '.gt-repo:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.gt-repo-deep{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,var(--dsw-alias-border-l1))}',
      '.gt-repo-simple{padding:13px 15px;gap:8px}',
      '.gt-repo-simple .gt-desc{-webkit-line-clamp:2}',
      '.gt-badge-zh{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}',
      '.gt-model{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.gt-source{align-self:flex-start;font-size:11px;padding:2px 8px;border-radius:6px;border:1px dashed var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.gt-repo-head{display:flex;align-items:flex-start;gap:10px;min-width:0}',
      '.gt-avatar{position:relative;flex:0 0 auto;width:34px;height:34px;border-radius:10px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:12px;font-weight:700;color:var(--dsw-alias-label-secondary);text-transform:uppercase;user-select:none}',
      '.gt-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:var(--dsw-alias-bg-layer-2)}',
      '.gt-rank{flex:none;width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.gt-rank[data-top="1"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.gt-repo-name{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}',
      '.gt-repo-name:hover{color:var(--dsw-alias-brand-primary)}',
      '.gt-repo-owner{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gt-desc{font-size:12.5px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;min-height:34px}',
      '.gt-metrics{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.gt-metrics b{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.gt-tags{display:flex;gap:6px;flex-wrap:wrap}',
      '.gt-tag{font-size:11px;padding:2px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
      '.gt-tag[data-tone="brand"]{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
      '.gt-tag[data-tone="error"]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}',
      '.gt-tag[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}',
      '.gt-tag[data-tone="success"]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}',
      '.gt-block{margin-top:2px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l1);font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:6px}',
      '.gt-block b{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.gt-bullets{margin:6px 0 0;padding-left:16px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.gt-bullets li{margin:3px 0}',
      '.gt-pager{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}',
      '.gt-pager-btns{display:flex;gap:6px;align-items:center}',
      '.gt-pager-btns button{width:28px;height:28px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.gt-pager-btns button[data-active="1"]{color:#fff;background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.gt-pager-btns button:disabled{opacity:.45;cursor:not-allowed}',
      '.gt-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.gt-deep-note{margin:0;padding:9px 13px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.gt-deep-note-failed{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.gt-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);display:inline-block;flex:none}',
      '.gt-error{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border-radius:13px;padding:14px 16px;font-size:13px}',
      '.gt-error b{display:block;margin-bottom:4px}',
      '.gt-error-detail{color:var(--dsw-alias-label-secondary);font-size:12px;word-break:break-word}',
      '.gt-error-attempts{color:var(--dsw-alias-label-secondary);font-size:12.5px}',
      '.gt-error-tried{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.gt-loading{display:flex;flex-direction:column;gap:8px}',
      '.gt-slow{display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--dsw-alias-state-warn-primary)}',
      '.gt-skeleton{height:110px;border-radius:14px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-layer-1));background-size:200% 100%;animation:gt-shimmer 1.4s ease-in-out infinite}',
      '@keyframes gt-shimmer{0%{background-position:0% 0}100%{background-position:-200% 0}}',
      '.gt-empty{padding:34px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;border:1px dashed var(--dsw-alias-border-l1);border-radius:14px}',
      '.gt-ai-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.gt-ai-box{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}',
      '.gt-ai-box .gt-input{flex:1 1 320px;min-width:220px}',
      '.gt-ai-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}',
      '.gt-match{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.gt-match-reason{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gt-search-group{margin-top:0}',
      '.gt-consent{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.48)}',
      '.gt-consent-card{width:min(460px,100%);border-radius:16px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:18px 20px;display:flex;flex-direction:column;gap:10px;box-shadow:0 18px 50px rgba(0,0,0,.35)}',
      '.gt-consent-title{margin:0;font-size:15px;font-weight:650}',
      '.gt-consent-line{margin:0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.gt-consent-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}',
      '.gt-consent-actions .gt-btn{min-width:88px}',
      '.gt-ai-help{padding:0;overflow:hidden}',
      '.gt-flash{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;transition:outline-color .3s}',
      '.gt-ai-help-toggle{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:600;padding:14px 16px;cursor:pointer;text-align:left}',
      '.gt-ai-help-state{font-weight:400;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.gt-ai-help-caret{font-weight:400;font-size:11.5px;color:var(--dsw-alias-brand-primary)}',
      '.gt-ai-help-body{display:flex;flex-direction:column;gap:8px;padding:0 16px 16px;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary)}',
      '.gt-ai-help-body p{margin:0}',
      '.gt-ai-help-body h4{margin:2px 0 0;font-size:12.5px;font-weight:650;color:var(--dsw-alias-label-primary)}',
      '.gt-help-status{display:flex;flex-direction:column;gap:2px;padding:0 16px 12px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.gt-ai-help-code{margin:0;padding:7px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-all}',
      '.gt-help-code-wrap{position:relative}',
      '.gt-help-code-wrap .gt-ai-help-code{padding-right:96px}',
      '.gt-help-copy{position:absolute;top:7px;right:7px;height:24px;min-width:74px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-brand-primary);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}',
      '.gt-firstrun-card{width:min(560px,100%);max-height:calc(100vh - 48px);overflow:auto}',
      '.gt-firstrun-item b{display:block;margin-bottom:2px;color:var(--dsw-alias-label-primary)}',
      '.gt-firstrun-remember{display:flex;align-items:center;gap:6px;margin-top:2px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.gt-firstrun-note{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.gt-firstrun-wait{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:2px 0 0;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.gt-firstrun-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}',
      '.gt-repo-search{border-style:dashed}',
      '@media (max-width:1100px){.gt-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@media (max-width:900px){.gt-cards{grid-template-columns:1fr}}',
    ].join('\n')

    function TrendIcon(props) {
      const size = (props && props.size) || 20
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3 16.5 9 10l4 3.6L21 6',
          stroke: 'var(--dsw-alias-brand-primary)',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M15.5 6H21v5.5', stroke: 'var(--dsw-alias-state-success-primary)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function NavIcon() {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }, title: 'GitHub Trending' },
        h(TrendIcon, { size: 18 }),
      )
    }

    function Tag(props) {
      return h('span', { className: 'gt-tag', 'data-tone': props.tone || 'plain' }, props.children)
    }

    function Stat(props) {
      return h(
        'div',
        { className: 'gt-stat' },
        h('span', { className: 'gt-stat-label' }, props.label),
        h('span', { className: 'gt-stat-value' }, props.value),
        props.hint ? h('span', { className: 'gt-stat-hint' }, props.hint) : null,
      )
    }

    /**
     * One repository card. `mode` is decided by the panel from the global list
     * index and the report's `deepCount`: `deep` renders every deepDive block,
     * the AI model chips and the Chinese-README badge; `simple` renders only
     * name, description, metrics and language/category tags (no `gt-block`).
     * The board-source marker is rendered in both modes.
     */
    function RepoCard(props) {
      const repo = props.repo
      const t = props.t
      const mode = props.mode === 'simple' ? 'simple' : 'deep'
      const deep = mode === 'deep'
      const intros = props.intros || null
      // The AI channel replaces 项目介绍 with the model intro and 上手门槛 with the
      // model onboarding (only when non-empty; otherwise the rule sentence stays).
      // Order, labels and every other block stay exactly as the template produced them.
      const blocks = deep
        ? (repo.deepDive || []).map(function (block) {
            const entry = intros && block ? intros[repo.fullName] : null
            if (entry) {
              if (block.label === '项目介绍' && entry.intro) {
                return { label: block.label, text: entry.intro }
              }
              if (block.label === '上手门槛' && entry.onboarding) {
                return { label: block.label, text: entry.onboarding }
              }
            }
            return block
          })
        : []
      const models = deep && Array.isArray(repo.aiModels) ? repo.aiModels.slice(0, 3) : []
      const zhReadme = deep && repo.readmeZh === true
      return h(
        'article',
        { className: 'gt-repo gt-repo-' + mode },
        h(
          'div',
          { className: 'gt-repo-head' },
          h(
            'span',
            { className: 'gt-avatar', title: repo.owner },
            String(repo.owner || '?').slice(0, 2),
            avatarUrl(repo.owner)
              ? h('img', {
                  src: avatarUrl(repo.owner),
                  alt: repo.owner,
                  loading: 'lazy',
                  onError: function (event) {
                    event.currentTarget.style.display = 'none'
                  },
                })
              : null,
          ),
          h('span', { className: 'gt-rank', 'data-top': repo.rank <= 3 ? '1' : '0' }, '#' + repo.rank),
          h(
            'div',
            { style: { minWidth: 0, flex: 1 } },
            h('a', { className: 'gt-repo-name', href: repo.url, target: '_blank', rel: 'noreferrer', title: repo.fullName }, repo.name),
            h('span', { className: 'gt-repo-owner' }, repo.owner),
          ),
          h(Tag, { tone: riskTone(repo.riskLevel) }, t('risk.' + repo.riskLevel)),
        ),
        h('p', { className: 'gt-desc' }, repo.tldr || repo.description || '—'),
        h(
          'div',
          { className: 'gt-metrics' },
          h('span', null, h('b', null, compact(repo.stars)), ' ', t('metric.stars')),
          h('span', null, h('b', null, compact(repo.forks)), ' ', t('metric.forks')),
          h('span', null, h('b', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, '+' + compact(repo.delta)), ' ', t('metric.delta')),
          h('span', null, h('b', null, percent(repo.growthRatio)), ' ', t('metric.growth')),
        ),
        h(
          'div',
          { className: 'gt-tags' },
          repo.language ? h('span', { className: 'gt-tag' }, h('span', { className: 'gt-dot', style: { background: repo.languageColor || 'var(--dsw-alias-state-idle-primary)', marginRight: 5 } }), repo.language) : null,
          h(Tag, { tone: 'brand' }, repo.categoryZh),
          models.map(function (model) {
            return h('span', { className: 'gt-tag gt-model', key: 'model-' + model }, model)
          }),
          zhReadme ? h('span', { className: 'gt-tag gt-badge-zh' }, t('card.zhReadme')) : null,
          (repo.stack || []).filter(function (tech) { return tech !== repo.language }).slice(0, 3).map(function (tech) {
            return h('span', { className: 'gt-tag', key: tech }, tech)
          }),
        ),
        blocks.length
          ? h(
              'div',
              { className: 'gt-block' },
              blocks.map(function (block, index) {
                return h('div', { key: index }, h('b', null, block.label + '：'), block.text)
              }),
            )
          : null,
        repo.source === 'popular' ? h('div', { className: 'gt-source' }, t('card.sourcePopular')) : null,
        repo.source === 'filler' ? h('div', { className: 'gt-source', 'data-source': 'filler' }, t('card.sourceFiller')) : null,
        typeof repo.matchScore === 'number'
          ? h(
              'div',
              { className: 'gt-match', 'data-match-score': String(matchScoreText(repo.matchScore)) },
              h('span', { className: 'gt-tag', 'data-tone': 'brand' }, t('ai.match') + ' ' + matchScoreText(repo.matchScore)),
              repo.matchReason ? h('span', { className: 'gt-match-reason' }, String(repo.matchReason)) : null,
            )
          : null,
      )
    }

    /** 0–100 integer for the badge; anything non-numeric is simply hidden. */
    function matchScoreText(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return ''
      return String(Math.max(0, Math.min(100, Math.round(number))))
    }

    /**
     * Search-fallback card. These rows only carry the GitHub Search fields, so
     * they get a compact card of their own and an explicit origin marker.
     */
    function SearchCard(props) {
      const repo = props.repo
      const t = props.t
      return h(
        'article',
        { className: 'gt-repo gt-repo-simple gt-repo-search', 'data-origin': 'search' },
        h(
          'div',
          { className: 'gt-repo-head' },
          h('span', { className: 'gt-avatar', title: repo.owner }, String(repo.owner || '?').slice(0, 2)),
          h(
            'div',
            { style: { minWidth: 0, flex: 1 } },
            h('a', { className: 'gt-repo-name', href: repo.url, target: '_blank', rel: 'noreferrer', title: repo.fullName }, repo.name || repo.fullName),
            h('span', { className: 'gt-repo-owner' }, repo.owner),
          ),
          h(Tag, { tone: 'brand' }, t('ai.searchBadge')),
        ),
        h('p', { className: 'gt-desc' }, repo.description || '—'),
        h(
          'div',
          { className: 'gt-metrics' },
          h('span', null, h('b', null, compact(repo.stars)), ' ', t('metric.stars')),
          repo.language ? h('span', null, h('b', null, String(repo.language))) : null,
        ),
      )
    }

    function useReport(params) {
      const [state, setState] = useState(function () {
        return { status: 'loading', data: null, error: null, startedAt: Date.now() }
      })
      const [nonce, setNonce] = useState(0)
      const [elapsedSeconds, setElapsedSeconds] = useState(0)
      // Mutable ref (the shim has no useRef): cancel() needs the live controller.
      const [abortRef] = useState(function () {
        return { current: null }
      })
      // Monotonic per-effect token. Responses of either phase only apply while
      // their own effect is still the latest one; comparing query strings would
      // misfire because the two phases differ by `enrich`.
      const [requestRef] = useState(function () {
        return { current: 0 }
      })
      // `pending` while the enriched tier is in flight, `failed` when it could
      // not update the snapshot, `idle` once it landed (or was abandoned).
      const [deepState, setDeepState] = useState({ status: 'idle' })
      useEffect(
        function () {
          const controller = new AbortController()
          abortRef.current = controller
          const requestId = requestRef.current + 1
          requestRef.current = requestId
          let alive = true
          const startedAt = Date.now()
          setState(function (prev) {
            return { status: prev.data ? 'refreshing' : 'loading', data: prev.data, error: null, startedAt: startedAt }
          })
          setDeepState({ status: 'pending' })
          const query = new URLSearchParams({ since: params.since, limit: '50', focus: '3' })
          if (params.language) query.set('language', params.language)
          if (nonce > 0) query.set('refresh', '1')
          // Phase 1 asks for the cheap snapshot, phase 2 for the enriched cards.
          // Both carry the same since/language/refresh, so they describe one board.
          const snapshotQuery = new URLSearchParams(query.toString())
          snapshotQuery.set('enrich', '0')
          const fullQuery = new URLSearchParams(query.toString())
          fullQuery.set('enrich', '1')

          function isCurrent() {
            return alive && requestId === requestRef.current
          }

          function readBody(response) {
            return response.json().then(
              function (body) {
                if (!response.ok) throw new Error(describeFailure(response.status, body))
                return body
              },
              function () {
                throw new Error(describeFailure(response.status, null))
              },
            )
          }

          fetch(BASE + '/report?' + snapshotQuery.toString(), {
            signal: controller.signal,
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
            .then(readBody)
            .then(function (data) {
              if (!isCurrent()) return
              // A 200 payload may carry `error`: the host reached the route but
              // the upstream fetch failed. Render the error state, keep chips.
              if (data && data.error) {
                const attempts = Array.isArray(data.error.attempts)
                  ? data.error.attempts.map(function (entry, index) {
                      return {
                        attempt: Number(entry && entry.attempt) || index + 1,
                        ms: Number(entry && entry.ms) || 0,
                        reasons: Array.isArray(entry && entry.reasons) ? entry.reasons : [],
                      }
                    })
                  : null
                setState({
                  status: 'error',
                  data: data,
                  error: {
                    class: data.error.class === 'network' ? 'network' : 'source',
                    detail: String(data.error.detail || ''),
                    attempts: attempts,
                    durationMs: Number(data.durationMs) || 0,
                  },
                  startedAt: startedAt,
                })
                setDeepState({ status: 'idle' })
                return
              }
              // The snapshot may render at once only when no board is on screen
              // yet (first load, retry, or a since/language switch). On a
              // refresh the already displayed deep cards must stay put.
              setState(function (prev) {
                const previous = prev && prev.data
                const boardChanged =
                  !previous ||
                  String(previous.since || '') !== String(params.since || '') ||
                  String(previous.language || '') !== String(params.language || '')
                return {
                  status: 'refreshing',
                  data: boardChanged ? data : previous,
                  error: null,
                  startedAt: startedAt,
                }
              })
              fetch(BASE + '/report?' + fullQuery.toString(), {
                signal: controller.signal,
                credentials: 'same-origin',
                headers: { accept: 'application/json' },
              })
                .then(readBody)
                .then(function (full) {
                  if (!isCurrent()) return
                  // The enriched tier failed while the snapshot is already
                  // usable: keep the data, never flip into the error card, and
                  // leave one "not updated" line instead.
                  if (full && full.error) {
                    setDeepState({ status: 'failed' })
                    setState(function (prev) {
                      return {
                        status: 'ready',
                        data: prev && prev.data,
                        error: null,
                        startedAt: (prev && prev.startedAt) || startedAt,
                      }
                    })
                    return
                  }
                  setState({ status: 'ready', data: full, error: null, startedAt: startedAt })
                  setDeepState({ status: 'idle' })
                })
                .catch(function (error) {
                  if (!isCurrent()) return
                  if (error && error.name === 'AbortError') return
                  setDeepState({ status: 'failed' })
                  setState(function (prev) {
                    return {
                      status: 'ready',
                      data: prev && prev.data,
                      error: null,
                      startedAt: (prev && prev.startedAt) || startedAt,
                    }
                  })
                })
            })
            .catch(function (error) {
              if (!isCurrent()) return
              if (error && error.name === 'AbortError') return
              setDeepState({ status: 'idle' })
              setState({
                status: 'error',
                data: null,
                error: {
                  class: 'network',
                  detail: (error && error.message) || String(error),
                },
                startedAt: startedAt,
              })
            })
          return function () {
            alive = false
            controller.abort()
            if (abortRef.current === controller) abortRef.current = null
          }
        },
        [params.since, params.language, nonce],
      )
      // Tick once a second while a request is in flight, so the panel shows how
      // long it has been waiting instead of an apparently frozen skeleton.
      useEffect(
        function () {
          if (state.status !== 'loading' && state.status !== 'refreshing') {
            setElapsedSeconds(0)
            return undefined
          }
          const startedAt = Number(state.startedAt) || Date.now()
          const tick = function () {
            setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
          }
          tick()
          const timer = setInterval(tick, 1000)
          // Node tests must not be kept alive by the panel's ticker.
          if (timer && typeof timer.unref === 'function') timer.unref()
          return function () {
            clearInterval(timer)
          }
        },
        [state.status, state.startedAt],
      )
      function cancel() {
        const controller = abortRef.current
        if (controller) controller.abort()
        abortRef.current = null
        setDeepState({ status: 'idle' })
        setState(function (prev) {
          return {
            status: 'error',
            data: prev.data,
            error: { class: 'canceled', detail: '请求已取消' },
            startedAt: prev.startedAt,
          }
        })
      }
      return [
        state,
        function () {
          // Retry from the error state must visibly enter the loading state at
          // once; waiting for the effect would leave the old error card up.
          setState(function (prev) {
            if (prev && prev.status === 'error') {
              return { status: 'loading', data: null, error: null, startedAt: Date.now() }
            }
            return prev
          })
          setNonce(function (value) {
            return value + 1
          })
        },
        cancel,
        elapsedSeconds,
        deepState,
      ]
    }

    /**
     * AI Chinese intro channel. The template text is already on screen, so this
     * hook only swaps the 项目介绍 and 上手门槛 blocks once a translation arrives
     * (the onboarding half only when the model returned a non-empty value).
     * Requests are deduped per parameter set at module scope; the resolved map
     * lives in component state. Every failure path (412, 5xx, abort, network)
     * returns an empty map and leaves the template untouched.
     */
    const TRANSLATE_CACHE = new Map()
    const TRANSLATE_TIMEOUT_MS = 20000

    function useTranslatedIntros(data, since, language) {
      const [intros, setIntros] = useState(null)

      useEffect(
        function () {
          if (!data) return
          // The snapshot tier renders first and carries no README excerpt; the
          // translate route only ever sees full reports. Asking for a model
          // intro while the snapshot is on screen would cache an empty answer
          // and the deep cards would never get one.
          if (Number(data.enrichedCount) === 0) return
          // useReport always requests limit=50; the translate route keys its
          // recent-report cache by that same normalized request.
          const limit = 50
          const key = since + '|' + (language || '') + '|' + String(limit)
          let entry = TRANSLATE_CACHE.get(key)
          let cancelled = false

          function deliver(map) {
            if (!cancelled && map && typeof map === 'object' && Object.keys(map).length > 0) setIntros(map)
          }

          if (!entry) {
            entry = { intros: null, promise: null }
            TRANSLATE_CACHE.set(key, entry)
            const controller = new AbortController()
            const timer = setTimeout(function () {
              controller.abort()
            }, TRANSLATE_TIMEOUT_MS)
            entry.promise = (async function () {
              try {
                const statusResponse = await fetch(BASE + '/status', {
                  signal: controller.signal,
                  credentials: 'same-origin',
                  headers: { accept: 'application/json' },
                })
                if (!statusResponse.ok) return {}
                const status = await statusResponse.json()
                if (!status || status.configured !== true) return {}
                const response = await fetch(BASE + '/translate', {
                  method: 'POST',
                  signal: controller.signal,
                  credentials: 'same-origin',
                  headers: { accept: 'application/json', 'content-type': 'application/json' },
                  body: JSON.stringify({ since: since, language: language, limit: limit }),
                })
                if (!response.ok) return {}
                const payload = await response.json()
                const map = {}
                const items = payload && Array.isArray(payload.items) ? payload.items : []
                for (const item of items) {
                  if (!item || !item.fullName) continue
                  let intro = ''
                  let onboarding = ''
                  if (typeof item === 'string') {
                    // Backward compatibility: a bare string was the intro.
                    intro = item
                  } else {
                    intro = typeof item.intro === 'string' ? item.intro : ''
                    if (typeof item.onboarding === 'string') {
                      onboarding = item.onboarding
                      // A time estimate must never reach the panel; the rule
                      // sentence is better than a guessed duration.
                      if (/小时|半天|分钟|天/.test(onboarding)) onboarding = ''
                    }
                  }
                  if (intro || onboarding) map[item.fullName] = { intro: intro, onboarding: onboarding }
                }
                return map
              } catch (error) {
                return {}
              } finally {
                clearTimeout(timer)
              }
            })()
            entry.promise = entry.promise.then(function (map) {
              entry.intros = map
              // An empty answer (no cached report on the host, no key, a 4xx)
              // must not be remembered: the full tier may arrive later and ask
              // again. Only a real translation is worth caching.
              if (!map || Object.keys(map).length === 0) TRANSLATE_CACHE.delete(key)
              return map
            })
          }

          if (entry.intros) {
            deliver(entry.intros)
            return function () {
              cancelled = true
            }
          }
          if (entry.promise) {
            entry.promise.then(deliver)
            return function () {
              cancelled = true
            }
          }
        },
        [data, since, language],
      )

      return intros
    }

    function Panel(props) {
      const t = useMemo(function () { return makeT(LOCALE) }, [])
      const [since, setSince] = useState('daily')
      const [language, setLanguage] = useState('')
      const [category, setCategory] = useState((props && props.initialCategory) || 'all')
      const [search, setSearch] = useState('')
      const [page, setPage] = useState((props && Number(props.initialPage)) || 1)
      const [firstRender, setFirstRender] = useState(true)
      // Dismissed banners are read from localStorage exactly once, on the first
      // render; useState keeps later clicks immediate without another read.
      const [hiddenBanners, setHiddenBanners] = useState(readUiMemory)
      // AI filter: null status means "not probed yet" (the button stays enabled
      // and the host answers 412 if it really has no key). `aiHost` comes from
      // GET /ai/info and is only used to describe the consent dialog.
      const [aiConfigured, setAiConfigured] = useState(null)
      const [githubConfigured, setGithubConfigured] = useState(null)
      const [aiHost, setAiHost] = useState('')
      const [aiOpen, setAiOpen] = useState(false)
      const [aiPrompt, setAiPrompt] = useState('')
      const [aiConsentOpen, setAiConsentOpen] = useState(false)
      const [aiLoading, setAiLoading] = useState(false)
      const [aiError, setAiError] = useState(null)
      const [aiResult, setAiResult] = useState(null)
      const [helpOpen, setHelpOpen] = useState(false)
      // First-run onboarding: shown until the user ticks "下次不再提示" and
      // closes it. The initial value is read lazily from localStorage once.
      const [firstRunOpen, setFirstRunOpen] = useState(readFirstRunPending)
      const [firstRunRemember, setFirstRunRemember] = useState(false)
      // Fallback hint shown at the top of the panel when the bottom tutorial
      // cannot be located (no DOM, or the tutorial card is not mounted).
      const [helpHint, setHelpHint] = useState(false)
      const [state, refresh, cancelLoad, elapsedSeconds, deepState] = useReport({ since: since, language: language })
      const data = state.data
      const intros = useTranslatedIntros(data, since, language)

      // Probe the AI status once; only a configured host needs the public
      // /ai/info metadata (host/model), fetched before the first consent dialog
      // so a cancelled dialog never issues a request of its own.
      useEffect(function () {
        let alive = true
        const run = async function () {
          try {
            const response = await fetch(BASE + '/status', {
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            })
            if (!alive) return
            let body = null
            try {
              body = response && response.ok ? await response.json() : null
            } catch (error) {
              body = null
            }
            if (!alive) return
            const configured = Boolean(body && (body.aiConfigured === true || body.configured === true))
            setAiConfigured(configured)
            setGithubConfigured(Boolean(body && body.githubTokenConfigured === true))
            if (!configured) return
            try {
              const infoResponse = await fetch(BASE + '/ai/info', {
                credentials: 'same-origin',
                headers: { accept: 'application/json' },
              })
              if (!alive) return
              const info = infoResponse && infoResponse.ok ? await infoResponse.json() : null
              if (alive && info && info.host) setAiHost(String(info.host))
            } catch (error) {
              /* keep the generic host label in the consent dialog */
            }
          } catch (error) {
            if (alive) setAiConfigured(null)
          }
        }
        run()
        return function () {
          alive = false
        }
      }, [])

      function toggleAi() {
        // A configured:false status disables the entry, and even a synthetic
        // click on the disabled node must not reach the network.
        if (aiConfigured === false) return
        setAiOpen(function (value) { return !value })
      }

      /** Close the onboarding dialog; only the ticked checkbox writes memory. */
      function closeFirstRun() {
        if (firstRunRemember) writeFirstRunDone()
        setFirstRunOpen(false)
      }

      /**
       * Scroll the bottom tutorial into view and flash it. Returns false when
       * there is no DOM or no `[data-ai-help]` node yet; never throws, so even
       * an exotic host cannot turn the click into a dead key.
       */
      function revealTutorial() {
        try {
          if (typeof document === 'undefined' || !document || typeof document.querySelector !== 'function') return false
          const node = document.querySelector('[data-ai-help]')
          if (!node) return false
          try {
            if (typeof node.scrollIntoView === 'function') {
              node.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          } catch (error) {
            /* scrollIntoView is best-effort; the flash below still marks the spot */
          }
          try {
            if (node.classList && typeof node.classList.add === 'function') node.classList.add('gt-flash')
            else if (typeof node.className === 'string') node.className = node.className + ' gt-flash'
            setTimeout(function () {
              try {
                if (node.classList && typeof node.classList.remove === 'function') node.classList.remove('gt-flash')
                else if (typeof node.className === 'string') node.className = node.className.replace(/\s*gt-flash\b/g, '')
              } catch (error) {
                /* ignore */
              }
            }, 2500)
          } catch (error) {
            /* ignore */
          }
          return true
        } catch (error) {
          return false
        }
      }

      /** "去看怎么配" closes the dialog, opens the tutorial, then reveals it. */
      function firstRunToTutorial() {
        try {
          if (firstRunRemember) writeFirstRunDone()
          setFirstRunOpen(false)
          setHelpOpen(true)
          setHelpHint(false)
        } catch (error) {
          /* never a dead key */
        }
        try {
          // Wait one tick so the tutorial card has been committed/painted
          // before we scroll to it.
          setTimeout(function () {
            try {
              if (!revealTutorial()) setHelpHint(true)
            } catch (error) {
              try {
                setHelpHint(true)
              } catch (inner) {
                /* ignore */
              }
            }
          }, 60)
        } catch (error) {
          /* ignore */
        }
      }

      /** The fallback hint's "去底部" button retries the same reveal. */
      function hintToTutorial() {
        try {
          if (revealTutorial()) setHelpHint(false)
        } catch (error) {
          /* ignore */
        }
      }

      function aiErrorText(status) {
        if (status === 412) return t('ai.err.412')
        if (status === 403) return t('ai.err.403')
        if (status === 429) return t('ai.err.429')
        return t('ai.err.generic')
      }

      async function sendAi(text) {
        setAiLoading(true)
        setAiError(null)
        const controller = new AbortController()
        const timer = setTimeout(function () { controller.abort() }, AI_TIMEOUT_MS)
        try {
          const response = await fetch(BASE + '/ai', {
            method: 'POST',
            signal: controller.signal,
            credentials: 'same-origin',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: text, since: since, language: language, limit: 50 }),
          })
          if (!response.ok) {
            setAiError(aiErrorText(response.status))
            return
          }
          const payload = await response.json()
          const items = payload && Array.isArray(payload.items) ? payload.items : []
          const board = []
          const search = []
          // Keep the payload order exactly: the host decides ranking, the panel
          // only splits trending rows from search-fallback rows.
          for (const item of items) {
            if (!item || typeof item !== 'object') continue
            if (item.origin === 'search') search.push(item)
            else board.push(item)
          }
          setAiResult({ board: board, search: search })
          setPage(1)
        } catch (error) {
          const name = error && error.name
          setAiError(name === 'AbortError' || name === 'TimeoutError' ? t('ai.err.timeout') : t('ai.err.generic'))
        } finally {
          clearTimeout(timer)
          setAiLoading(false)
        }
      }

      function submitAi() {
        const text = aiPrompt.trim()
        if (!text) return
        if (!readAiConsent()) {
          setAiConsentOpen(true)
          return
        }
        sendAi(text)
      }

      function allowAiConsent() {
        writeAiConsent()
        setAiConsentOpen(false)
        const text = aiPrompt.trim()
        if (text) sendAi(text)
      }

      function denyAiConsent() {
        setAiConsentOpen(false)
      }

      function clearAi() {
        setAiResult(null)
        setAiPrompt('')
        setAiError(null)
        setPage(1)
      }

      function dismissBanner(kind) {
        const next = { fallback: hiddenBanners.fallback === true, shortfall: hiddenBanners.shortfall === true }
        next[kind] = true
        writeUiMemory(next)
        setHiddenBanners(next)
      }

      function restoreBanners() {
        clearUiMemory()
        setHiddenBanners({})
      }

      // Reset to page 1 when a filter changes, but keep an explicit initial page
      // on the first render so offline tests can mount page 2 / page 3 directly.
      useEffect(function () {
        if (firstRender) {
          setFirstRender(false)
          return
        }
        setPage(1)
      }, [since, language, category, search])

      const repos = (data && data.repos) || []
      const customBoards = (data && data.customBoards) || []
      const chips = useMemo(function () { return buildChips(data || {}, t) }, [data, t])
      const customActive = customBoards.some(function (board) { return board.key === category })

      const filtered = useMemo(
        function () {
          return filterRepos(repos, category, search, customBoards)
        },
        [repos, category, search, customBoards],
      )

      // When an AI result is active the board is rendered from the response, in
      // the response's own order. Chip/search filters still narrow it, but the
      // panel never sorts: no score comparison happens on the client.
      const aiActive = Boolean(aiResult)
      const displayRepos = useMemo(
        function () {
          if (!aiResult) return filtered
          return filterRepos(aiResult.board, category, search, customBoards)
        },
        [aiResult, filtered, category, search, customBoards],
      )
      const aiSearchItems = aiActive ? aiResult.search : []

      // An `error` payload already renders its own error card; a shortfall or
      // network banner on top of it would duplicate the same failure.
      const reportFailed = Boolean(data && data.error)
      const shortfall = reportFailed ? '' : shortfallText(data, t)
      const networkNote = reportFailed ? '' : networkBanner(data, t)
      const qualityNote = installQualityBanner(data, t)
      const fallbackActive = Boolean(data && data.networkStatus === 'fallback')
      const showShortfall = Boolean(shortfall) && hiddenBanners.shortfall !== true
      const showNetwork = Boolean(networkNote) && !(fallbackActive && hiddenBanners.fallback === true)
      const anyBannerHidden = hiddenBanners.fallback === true || hiddenBanners.shortfall === true

      const totalPages = Math.max(1, Math.ceil(displayRepos.length / PAGE_SIZE))
      const currentPage = Math.min(page, totalPages)
      const pageRepos = displayRepos.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
      // Layering is decided by the GLOBAL list index, never by the page-local one:
      // with deepCount=10, page 2 shows 4 deep + 2 simple instead of 6 deep cards.
      const deepCount = Math.max(1, Number(data && data.deepCount != null ? data.deepCount : 10) || 10)
      const summary = (data && data.summary) || null
      const children = []

      children.push(
        h(
          'header',
          { className: 'gt-head', key: 'head' },
          h(
            'div',
            { className: 'gt-brand' },
            h('div', { className: 'gt-mark' }, h(TrendIcon, { size: 22 })),
            h(
              'div',
              null,
              h('h1', { className: 'gt-h1' }, t('title')),
              h('p', { className: 'gt-sub' }, t('subtitle')),
            ),
          ),
          h(
            'div',
            { className: 'gt-actions' },
            data ? h('span', { className: 'gt-note' }, t('updated') + ' ' + localTime(data.generatedAt) + ' · ' + (data.cache === 'hit' ? t('cache.hit') : t('cache.fresh'))) : null,
            h('button', { type: 'button', className: 'gt-btn', onClick: refresh, disabled: state.status === 'loading' || state.status === 'refreshing' }, t('refresh')),
          ),
        ),
      )

      // Fallback for hosts without a reachable tutorial node: say where the
      // tutorial is and offer a button that retries the scroll.
      if (helpHint) {
        children.push(
          h(
            'div',
            { className: 'gt-banner gt-help-hint', key: 'help-hint', 'data-help-hint': '1' },
            h('span', { className: 'gt-banner-text' }, t('help.hint')),
            h(
              'button',
              { type: 'button', className: 'gt-banner-dismiss', 'data-help-hint-go': '1', onClick: hintToTutorial },
              t('help.hint.go'),
            ),
          ),
        )
      }

      children.push(
        h(
          'div',
          { className: 'gt-toolbar', key: 'toolbar' },
          h(
            'div',
            { className: 'gt-seg' },
            ['daily', 'weekly', 'monthly'].map(function (value) {
              return h(
                'button',
                { key: value, type: 'button', 'data-active': since === value ? '1' : '0', onClick: function () { setSince(value) } },
                t('period.' + value),
              )
            }),
          ),
          h(
            'select',
            { className: 'gt-select', value: language, onChange: function (event) { setLanguage(event.target.value) }, 'aria-label': t('filter.language') },
            LANGUAGES.map(function (item) {
              return h('option', { key: item.slug || 'all', value: item.slug }, item.label)
            }),
          ),
          h('input', {
            className: 'gt-input',
            placeholder: t('search.placeholder'),
            value: search,
            onChange: function (event) { setSearch(event.target.value) },
            'aria-label': t('search.placeholder'),
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'gt-btn gt-ai-toggle',
              'data-ai-toggle': '1',
              disabled: aiConfigured === false,
              title: aiConfigured === false ? t('ai.needKey') : t('ai.entry'),
              'aria-expanded': aiOpen ? 'true' : 'false',
              onClick: toggleAi,
            },
            t('ai.entry'),
          ),
          aiConfigured === false ? h('span', { className: 'gt-ai-hint', 'data-ai-hint': '1' }, t('ai.needKey')) : null,
        ),
      )

      if (aiOpen && aiConfigured !== false) {
        children.push(
          h(
            'div',
            { className: 'gt-ai-box', key: 'aibox' },
            h('input', {
              className: 'gt-input gt-ai-input',
              'data-ai-input': '1',
              placeholder: t('ai.placeholder'),
              value: aiPrompt,
              'aria-label': t('ai.entry'),
              onChange: function (event) { setAiPrompt(event.target.value) },
              onKeyDown: function (event) {
                if (event && event.key === 'Enter') submitAi()
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'gt-btn',
                'data-primary': '1',
                'data-ai-submit': '1',
                disabled: aiLoading || aiPrompt.trim() === '',
                onClick: submitAi,
              },
              aiLoading ? t('ai.loading') : t('ai.submit'),
            ),
            h(
              'button',
              { type: 'button', className: 'gt-btn', 'data-ai-clear': '1', disabled: aiLoading, onClick: clearAi },
              t('ai.clear'),
            ),
          ),
        )
      }

      children.push(
        h(
          'div',
          { className: 'gt-chips', key: 'chips' },
          chips.map(function (item) {
            return h(
              'button',
              { key: item.key, type: 'button', className: 'gt-chip', 'data-active': category === item.key ? '1' : '0', onClick: function () { setCategory(item.key) } },
              item.label,
            )
          }),
        ),
      )

      if (showShortfall || showNetwork || qualityNote) {
        children.push(
          h(
            'div',
            { className: 'gt-banners', key: 'banners' },
            showShortfall
              ? h(
                  'div',
                  { className: 'gt-banner gt-shortfall', key: 'shortfall' },
                  h('span', { className: 'gt-banner-text' }, shortfall),
                  h('button', { type: 'button', className: 'gt-banner-dismiss', 'data-dismiss': 'shortfall', onClick: function () { dismissBanner('shortfall') } }, t('banner.dismiss')),
                )
              : null,
            showNetwork
              ? h(
                  'div',
                  { className: 'gt-banner gt-network', key: 'network' },
                  h('span', { className: 'gt-banner-text' }, networkNote),
                  fallbackActive
                    ? h('button', { type: 'button', className: 'gt-banner-dismiss', 'data-dismiss': 'fallback', onClick: function () { dismissBanner('fallback') } }, t('banner.dismiss'))
                    : null,
                )
              : null,
            qualityNote ? h('div', { className: 'gt-banner gt-install-quality', key: 'quality' }, qualityNote) : null,
          ),
        )
      }

      if ((state.status === 'loading' || state.status === 'refreshing') && !data) {
        children.push(h('div', { className: 'gt-skeleton', key: 'sk1' }))
        children.push(h('div', { className: 'gt-skeleton', key: 'sk2', style: { height: 180 } }))
        children.push(
          h(
            'div',
            { className: 'gt-loading', key: 'note' },
            h('p', { className: 'gt-note' }, t('loading')),
            h('p', { className: 'gt-note', 'data-elapsed': '1' }, t('loading.elapsed', { seconds: elapsedSeconds })),
            elapsedSeconds >= 12
              ? h(
                  'div',
                  { className: 'gt-slow', 'data-slow': '1' },
                  h('span', null, t('loading.slow')),
                  h(
                    'button',
                    { type: 'button', className: 'gt-btn', 'data-cancel-load': '1', onClick: cancelLoad },
                    t('cancel'),
                  ),
                )
              : null,
          ),
        )
      } else if (state.status === 'error') {
        const attemptLine = errorAttemptLine(state.error, t)
        const attemptCount = state.error && Array.isArray(state.error.attempts) ? state.error.attempts.length : 0
        children.push(
          h(
            'div',
            { className: 'gt-error', key: 'error', 'data-error-state': '1' },
            h('b', null, errorHeadline(state.error, t)),
            attemptLine
              ? h('div', { className: 'gt-error-attempts', 'data-attempts': String(attemptCount) }, attemptLine)
              : state.error && state.error.detail
                ? h('div', { className: 'gt-error-detail' }, state.error.detail)
                : null,
            h(
              'div',
              { className: 'gt-error-actions', style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 } },
              h(
                'button',
                {
                  type: 'button',
                  className: 'gt-btn',
                  'data-retry': '1',
                  onClick: refresh,
                },
                t('retry'),
              ),
              attemptCount > 0
                ? h('span', { className: 'gt-error-tried', 'data-tried': String(attemptCount) }, t('error.tried', { count: attemptCount }))
                : null,
            ),
          ),
        )
      } else if (data) {
        if (aiError) {
          children.push(h('div', { className: 'gt-banner gt-ai-error', key: 'ai-error', 'data-ai-error': '1' }, aiError))
        }

        // One static line above the list: the snapshot is usable, the enriched
        // tier is either still loading or could not refresh it.
        if (deepState && deepState.status === 'pending') {
          children.push(h('div', { className: 'gt-deep-note', key: 'deep-note', 'data-deep-state': 'pending' }, t('deep.pending')))
        } else if (deepState && deepState.status === 'failed') {
          children.push(h('div', { className: 'gt-deep-note gt-deep-note-failed', key: 'deep-note', 'data-deep-state': 'failed' }, t('deep.failed')))
        }

        children.push(
          h(
            'div',
            { className: 'gt-grid', key: 'stats' },
            h(Stat, { label: t('stat.repos'), value: compact(summary ? summary.repoCount : repos.length), hint: (data.language || t('filter.all')) + ' · ' + t('period.' + data.since) }),
            h(Stat, { label: t('stat.delta'), value: '+' + compact(summary ? summary.totalDelta : 0), hint: summary && summary.topMover ? summary.topMover.fullName : '' }),
            h(Stat, { label: t('stat.stars'), value: compact(summary ? summary.totalStars : 0), hint: summary ? shortRisk(summary.riskCount, t) : '' }),
            h(Stat, { label: t('stat.language'), value: (summary && summary.topLanguage) || '—', hint: percent(summary ? summary.avgGrowth : 0) + ' ' + t('metric.growth') }),
          ),
        )

        children.push(
          h(
            'section',
            { className: 'gt-card', key: 'repos' },
            h(
              'h2',
              { className: 'gt-section-title' },
              t('section.repos'),
              h(
                'small',
                null,
                aiActive
                  ? t('ai.sorted') + ' · ' + String(displayRepos.length) + ' / ' + String(repos.length)
                  : String(displayRepos.length) + ' / ' + String(repos.length),
              ),
            ),
            displayRepos.length === 0
              ? h('div', { className: 'gt-empty' }, customActive ? emptyHint(t) : t('empty'))
              : h('div', { className: 'gt-cards' }, pageRepos.map(function (repo, index) {
                  const globalIndex = (currentPage - 1) * PAGE_SIZE + index
                  return h(RepoCard, { key: repo.fullName, repo: repo, t: t, intros: intros, mode: globalIndex < deepCount ? 'deep' : 'simple' })
                })),
            displayRepos.length > PAGE_SIZE
              ? h(
                  'div',
                  { className: 'gt-pager', style: { marginTop: 12 } },
                  h('span', null, t('page.info', { page: currentPage, total: totalPages, count: displayRepos.length })),
                  h(
                    'div',
                    { className: 'gt-pager-btns' },
                    h('button', { type: 'button', disabled: currentPage <= 1, onClick: function () { setPage(currentPage - 1) }, 'aria-label': t('page.prev') }, '‹'),
                    Array.from({ length: totalPages }, function (_item, index) {
                      const number = index + 1
                      if (totalPages > 7 && Math.abs(number - currentPage) > 2 && number !== 1 && number !== totalPages) return null
                      return h(
                        'button',
                        { key: number, type: 'button', 'data-active': number === currentPage ? '1' : '0', onClick: function () { setPage(number) } },
                        String(number),
                      )
                    }).filter(Boolean),
                    h('button', { type: 'button', disabled: currentPage >= totalPages, onClick: function () { setPage(currentPage + 1) }, 'aria-label': t('page.next') }, '›'),
                  ),
                )
              : null,
          ),
        )

        if (aiSearchItems.length > 0) {
          children.push(
            h(
              'section',
              { className: 'gt-card gt-search-group', key: 'ai-search' },
              h('h2', { className: 'gt-section-title' }, t('ai.searchGroup'), h('small', null, String(aiSearchItems.length))),
              h(
                'div',
                { className: 'gt-cards' },
                aiSearchItems.map(function (repo) {
                  return h(SearchCard, { key: 'search-' + repo.fullName, repo: repo, t: t })
                }),
              ),
            ),
          )
        }

        // Restore entry point, directly below the pager: only rendered while at
        // least one banner is remembered as hidden.
        if (anyBannerHidden) {
          children.push(
            h(
              'div',
              { className: 'gt-restore-bar', key: 'restore' },
              h(
                'button',
                { type: 'button', className: 'gt-restore', 'data-action': 'restore', onClick: restoreBanners },
                t('banner.hidden') + ' · ' + t('banner.restore'),
              ),
            ),
          )
        }

        // Configuration tutorial, collapsed by default and shown at the very
        // bottom of the panel. It never echoes any credential — only status.
        const tutorialState = function (value) {
          return value === true ? t('ai.status.configured') : t('ai.status.unconfigured')
        }
        children.push(
          h(
            'section',
            { className: 'gt-card gt-ai-help', key: 'ai-help', 'data-ai-help': '1' },
            h(
              'button',
              {
                type: 'button',
                className: 'gt-ai-help-toggle',
                'data-ai-help-toggle': '1',
                'aria-expanded': helpOpen ? 'true' : 'false',
                onClick: function () { setHelpOpen(function (value) { return !value }) },
              },
              h('span', null, t('help.title')),
              h('span', { className: 'gt-ai-help-caret' }, helpOpen ? t('ai.help.collapse') : t('ai.help.expand')),
            ),
            h(
              'div',
              { className: 'gt-ai-help-state gt-help-status', 'data-help-status': '1' },
              h('span', { 'data-help-token-status': '1' }, t('help.github.title') + '：' + tutorialState(githubConfigured)),
              h('span', { 'data-help-ai-status': '1' }, t('help.ai.title') + '：' + tutorialState(aiConfigured)),
            ),
            helpOpen
              ? h(
                  'div',
                  { className: 'gt-ai-help-body', 'data-ai-help-body': '1' },
                  h('h4', { className: 'gt-ai-help-title' }, t('help.github.title')),
                  h('p', { className: 'gt-help-path', 'data-help-path': 'github' }, t('help.github.file')),
                  h(
                    'div',
                    { className: 'gt-help-code-wrap' },
                    h('pre', { className: 'gt-ai-help-code', 'data-help-code': 'github' }, t('help.github.steps')),
                    h(
                      'button',
                      { type: 'button', className: 'gt-help-copy', 'data-help-copy': 'github', onClick: function () { copyHelpText(t('help.github.steps')) } },
                      t('help.copy'),
                    ),
                  ),
                  h('h4', { className: 'gt-ai-help-title' }, t('help.github.faq.title')),
                  h('pre', { className: 'gt-ai-help-code', 'data-help-faq': 'github' }, t('help.github.faq')),
                  h('h4', { className: 'gt-ai-help-title' }, t('help.ai.title')),
                  h('p', { className: 'gt-help-path', 'data-help-path': 'ai' }, t('help.ai.file')),
                  h(
                    'div',
                    { className: 'gt-help-code-wrap' },
                    h('pre', { className: 'gt-ai-help-code', 'data-help-code': 'ai' }, t('help.ai.steps')),
                    h(
                      'button',
                      { type: 'button', className: 'gt-help-copy', 'data-help-copy': 'ai', onClick: function () { copyHelpText(t('help.ai.steps')) } },
                      t('help.copy'),
                    ),
                  ),
                )
              : null,
          ),
        )
      }

      // First-run onboarding: a single non-blocking dialog above the panel.
      // "去看怎么配" closes it and opens the tutorial at the bottom.
      if (firstRunOpen) {
        children.push(
          h(
            'div',
            { className: 'gt-consent', key: 'first-run', 'data-first-run': '1', role: 'dialog', 'aria-modal': 'true' },
            h(
              'div',
              { className: 'gt-consent-card gt-firstrun-card' },
              h('h3', { className: 'gt-consent-title' }, t('firstRun.title')),
              h('p', { className: 'gt-consent-line gt-firstrun-item' }, h('b', null, t('firstRun.free.title')), t('firstRun.free.body')),
              h('p', { className: 'gt-consent-line gt-firstrun-item' }, h('b', null, t('firstRun.token.title')), t('firstRun.token.body')),
              h('p', { className: 'gt-consent-line gt-firstrun-item' }, h('b', null, t('firstRun.ai.title')), t('firstRun.ai.body')),
              h('p', { className: 'gt-consent-line gt-firstrun-wait', 'data-first-run-wait': '1' }, t('firstRun.wait')),
              h(
                'label',
                { className: 'gt-firstrun-remember' },
                h('input', {
                  type: 'checkbox',
                  'data-first-run-remember': '1',
                  checked: firstRunRemember,
                  onChange: function (event) { setFirstRunRemember(Boolean(event && event.target && event.target.checked)) },
                }),
                t('firstRun.remember'),
                h('span', { className: 'gt-firstrun-note', 'data-first-run-note': '1' }, t('firstRun.note')),
              ),
              h(
                'div',
                { className: 'gt-firstrun-actions' },
                h('button', { type: 'button', className: 'gt-btn', 'data-first-run-use': '1', onClick: closeFirstRun }, t('firstRun.use')),
                h('button', { type: 'button', className: 'gt-btn', 'data-primary': '1', 'data-first-run-help': '1', onClick: firstRunToTutorial }, t('firstRun.help')),
              ),
            ),
          ),
        )
      }

      // First-run privacy consent for the AI filter. It is layered above the
      // panel and blocks nothing else; "不发送" simply closes it (zero requests).
      if (aiConsentOpen) {
        children.push(
          h(
            'div',
            { className: 'gt-consent', key: 'consent', 'data-consent': '1', role: 'dialog', 'aria-modal': 'true' },
            h(
              'div',
              { className: 'gt-consent-card' },
              h('h3', { className: 'gt-consent-title' }, t('ai.consent.title')),
              h('p', { className: 'gt-consent-line', 'data-consent-host': '1' }, t('ai.consent.host') + '：' + (aiHost || t('ai.consent.hostFallback'))),
              h('p', { className: 'gt-consent-line' }, t('ai.consent.payload')),
              h(
                'div',
                { className: 'gt-consent-actions' },
                h('button', { type: 'button', className: 'gt-btn', 'data-consent-deny': '1', onClick: denyAiConsent }, t('ai.consent.deny')),
                h('button', { type: 'button', className: 'gt-btn', 'data-primary': '1', 'data-consent-allow': '1', onClick: allowAiConsent }, t('ai.consent.allow')),
              ),
            ),
          ),
        )
      }
      return h('div', { className: 'gt-root' }, h('style', null, CSS), h('div', { className: 'gt-shell' }, children))
    }

    return {
      inject: ['slots'],
      /** Exposed for the bundle smoke test: lets it assert every label exists in both languages. */
      dictionaries: { zh: ZH, en: EN },
      /** Offline-test surface for the Task-4 chip/search/banner logic. */
      __test: { buildChips, filterRepos, emptyHint, shortfallText, networkBanner, installQualityBanner, errorHeadline },
      apply(ctx) {
        let locale = null
        try {
          locale = typeof ctx.get === 'function' ? ctx.get('locale') : null
        } catch (error) {
          locale = null
        }
        if (locale && typeof locale.register === 'function') {
          try {
            locale.register(NS, 'zh', ZH)
            locale.register(NS, 'en', EN)
          } catch (error) {
            /* translations are optional; the built-in dictionary is the fallback */
          }
        }
        LOCALE = locale

        const t = makeT(locale)

        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({ name: 'sidebar.panellist', id: 'github-trending', order: 30, label: t('nav.title') }, NavIcon)
        })

        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: 'github-trending' }, Panel)
        })
      },
    }
  },
})