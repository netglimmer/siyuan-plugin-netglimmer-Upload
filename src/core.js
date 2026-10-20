/* SiYuan Netglimmer Publish - no-build single-file plugin
 * 右键文档 → 导出 HTML(SiYuan) 到工作空间 temp → 逐文件上传到 WebDAV。
 * 设置入口：原生插件设置面板（设置 → 已加载插件 → Netglimmer 发布）。
 * 依赖内核 API（v3.8.x 实测路由）：
 *   POST /api/export/exportHTML   {id, pdf, keepFold, merge} -> {name, folder, content}
 *   POST /api/export/exportMdContent {id} -> {hPath, content}   （Markdown 正文，含前置元数据）
 *        （3.8.6 起内核不再写 index.html，前端拼好后经 exportBrowserHTML 原样落盘；
 *          本插件用逐字移植的前端拼装代码自行生成同一字符串，见 Vendored.buildIndexHtml）
 *   POST /api/file/readDir        {path} -> [{name, isDir}]
 *   POST /api/file/getFile        {path} -> 原始字节（200）/ JSON（202）
 *   POST /api/file/removeFile     {path}
 *   POST /api/network/forwardProxy {url, method, headers, payload, contentType, ...}
 *        -> {code, data:{status, body, headers}}，method 支持 PROPFIND/MKCOL 等任意动词
 * （不要用 /api/network/proxy：3.8.3 里它经 gin Any() 注册，只路由 GET/HEAD/POST/PUT/
 *   PATCH/OPTIONS/DELETE 七个标准动词，PROPFIND/MKCOL 会被内核兜底路由吞掉并返回假 200。）
 */
/* eslint-disable no-console */

const { Plugin, fetchSyncPost, showMessage, Setting, importDialog, Dialog, openTab } = require("siyuan");

const SETTINGS_KEY = "settings";
const HISTORY_KEY = "history";

/* 版本号只写这一处：加载日志、设置页底部展示都从这里取。
 * 必须与 plugin.json 的 version 一致——run-settings.js 有断言，漏改会在回归里红。 */
const PLUGIN_VERSION = "0.9.32";
/* 导出格式档位（三档，全部实测过内核 3.8.6 的接口）：
 *   html = 思源自己那套静态页整包（index.html + stage/appearance 运行时 + 引用的资源）
 *   md   = 内核「导出 → Markdown」的正文（<文档名>.md）+ 它引用到的资源
 *   docx = 内核「导出 → Word」的单个自包含 Word 文件（图片已在 word/media/ 里）
 * 落盘、下拉框、生效配置三处都过 normFormat，脏值一律退回 html，避免各写一份三元。
 * PDF 不在档位里：内核没有导出 PDF 的接口（只有事后加工 PDF 的 processPDF），
 * PDF 字节只能由桌面端 Electron 的私有打印 IPC 产生——见 README「限制」。 */
const EXPORT_FORMATS = ["html", "md", "docx"];
function normFormat(v) { return EXPORT_FORMATS.indexOf(v) >= 0 ? v : "html"; }
const DEFAULT_SETTINGS = {
  protocol: "webdav",  // webdav | ftp | sftp | local（当前生效的传输协议）
  exportFormat: "html", // html | md | docx，见 EXPORT_FORMATS
  cleanOld: true,      // 发布前清空远端旧目录
  addToc: true,        // index.html 文末注入侧边大纲（零依赖，随页面一起上传）
  publishMerge: true,  // 一键发布时是否「含子文档」（合并导出整个子树），右键菜单只留一个按钮由此开关控制
  incremental: true,   // 增量发布：共享运行时（stage/appearance）远端已存在且大小相同则跳过重传
  safeNames: true,     // WebDAV：把服务器存不下的资产名换成同形安全名（详见 unsafeSegReason）
  knownHosts: {},      // SFTP TOFU：host:port -> SHA256 指纹
  debug: false,        // 打印每一次远端请求（一次完整发布有上千行，只在排查问题时开）
  retryTries: 3,       // 单个操作瞬时失败最多重试几次（1-6）
  concurrency: 0,      // 上传并发度：0 = 按协议自动（webdav 6 / sftp 4 / local 4 / ftp 1）
  maxFileMB: 64,       // 单个文件超过该值直接中止（0 = 不限制），避免超大资产把内存耗尽
  // 「上传成功后自动复制地址」这件事不存在了：插件只负责把文件送到远端，
  // 那个地址是不是用户真正的站点地址它并不知道，替人写剪贴板更是没被要求过的事。
  // 配置里残留的这个键由 onload() 显式删掉（读到即忽略，也不再写回）。
  // 每种协议各自保存一份服务器/端口/账号/子目录配置，切换协议互不覆盖；
  // 上传与连接测试只使用 protocol 指定的那一槽（见 profileFor / effective）。
  profiles: {
    webdav: { server: "", port: "", username: "", password: "", prefix: "" },
    ftp: { server: "", port: "", username: "", password: "", prefix: "" },
    sftp: { server: "", port: "", username: "", password: "", prefix: "" },
    local: { server: "", port: "", username: "", password: "", prefix: "" },
  },
};

const PROTO_KEYS = ["webdav", "ftp", "sftp", "local"];
const CRED_FIELDS = ["server", "port", "username", "password", "prefix"];

/* 各协议的默认端口：端口框留空时用这个，写进地址里的那个优先于它。 */
const DEFAULT_PORTS = { ftp: 21, sftp: 22 };

/* 归一化单条服务器地址输入：去首尾空白，再去尾部斜杠。
 * 四协议同一条规则：joinUrl / 路径拼接本来就会削掉基址的尾斜杠，留着它只会让
 * 「同一个服务器」在配置里存出两种形态（改一次协议切换又变回来），设置页与
 * 报错文本看起来像换了台机器。
 * 地址是用户原话的一部分（host、host:2121、[::1]、ftp://…），这里只做形状清理，
 * 不解析、不补协议头——解析交给 hostPortOf / localBaseOf。 */
function normServer(v) {
  return String(v || "").trim().replace(/\/+$/, "");
}

/* 前缀（远端子目录 / 本地基础目录）的归一：去首尾空白与首尾斜杠。
 * 存成「不带边界斜杠」的规范形态，拼接处一律 `base + "/" + prefix`，
 * 于是 "/a/" 与 "a" 与 "a//" 是同一个前缀——三处入口（表单读取、协议切换回写、
 * 载入 profile 到表单）必须用同一个函数，否则用户改一下协议就看见前缀变形。 */
function normPrefix(v) {
  return String(v || "").trim().replace(/^\/+|\/+$/g, "");
}

/* 端口输入的归一："" = 留空（用默认端口）；"bad" = 不是合法端口；
 * 其余返回规范数字串（去前导零，例如 "021" -> "21"）。
 * 只做形状检查，不猜语义——是否冲突由 hostPortOf 判断。 */
function normPort(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  if (!/^\d{1,5}$/.test(s)) return "bad";
  const n = Number(s);
  if (n < 1 || n > 65535) return "bad";
  return String(n);
}

/* 存进配置时保留用户原话：非法端口不静默清空——清空意味着「改用默认端口」，
 * 那是另一件事。留着原值，红字提示和设置里的旧值才会一起等到用户看见。
 * （会话侧 hostPortOf 会把非法值当作没填，不会连到奇怪的端口去。） */
function keepPort(v) {
  const p = normPort(v);
  return p === "bad" ? String(v == null ? "" : v).trim() : p;
}

/* 从「服务器地址」串里读 host 与（可能写在那儿的）端口。
 * 支持四种写法：host、host:2121、[::1]、[::1]:2121，另外容忍 ftp:// 前缀与尾部斜杠。
 * 裸 IPv6（多段冒号、没方括号）一律**不猜端口**——"::1:2121" 的 2121 既可能是端口
 * 也可能是地址尾段，猜错就连到别的机器上去了；这种串整串按主机名交给系统解析，
 * 并把 ambiguous 置真，让设置页提示「请加方括号」。 */
function readAddrHostPort(raw) {
  let v = String(raw || "").trim();
  const scheme = v.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (scheme) v = v.slice(scheme[0].length);
  v = v.replace(/\/+$/, "");
  const out = { host: v, port: "", ipv6: false, bracketed: false, ambiguous: false };
  if (!v) return out;
  if (v[0] === "[") {
    const i = v.indexOf("]");
    if (i > 0) {
      out.ipv6 = true; out.bracketed = true;
      out.host = v.slice(1, i);
      const rest = v.slice(i + 1);
      if (!rest) return out;
      if (rest[0] === ":" && normPort(rest.slice(1)) !== "bad") {
        out.port = normPort(rest.slice(1));
        return out;
      }
      out.ambiguous = true;          // [::1]xxx / [::1]:abc：读不出端口，整串留着报错用
      out.host = v;
      return out;
    }
    // 只有左括号：当普通（残缺）地址处理
  }
  const cols = (v.match(/:/g) || []).length;
  if (cols === 0) return out;
  if (cols === 1) {
    const i = v.indexOf(":");
    const tail = v.slice(i + 1);
    if (!tail) return out;                      // 结尾光一个冒号：不猜，交给服务器报错
    const p = normPort(tail);
    if (p === "bad") return out;                 // host:abc —— 冒号后不像端口，整串当主机名
    out.host = v.slice(0, i); out.port = p;
    return out;
  }
  out.ipv6 = true; out.ambiguous = true;         // 裸 IPv6：整串按主机名，端口请用端口框
  return out;
}

/* 地址 + 端口框 -> 会话真正要用的 {host, port}。**唯一口径**：
 * FtpSession / SshSession / knownHosts 键 / rootDisplay 全部从这里取值，
 * 免得某一处忘了端口、连上了 21、历史里却记成 2121。
 * 优先级：端口框 > 地址里写的 > 协议默认；端口框与地址端口都填且不同 = conflict。 */
function hostPortOf(rawAddr, rawPort, proto) {
  const ap = readAddrHostPort(rawAddr);
  const def = DEFAULT_PORTS[proto] || 0;
  const fp = normPort(rawPort);
  const field = fp === "bad" ? "" : fp;
  let port, from;
  if (field) { port = Number(field); from = "field"; }
  else if (ap.port) { port = Number(ap.port); from = "addr"; }
  else { port = def; from = "default"; }
  return {
    host: ap.host, port, from,
    addrPort: ap.port,
    fieldPort: field,
    conflict: !!(field && ap.port && field !== ap.port),
    badPort: fp === "bad",
    ipv6: ap.ipv6,
    ambiguous: ap.ambiguous,
    // 展示/指纹用的 host：**像 IPv6**（只有十六进制、冒号、点、%）且带冒号时才补方括号，
    // [::1]:22 这种形状 ssh、浏览器、sftp:// URL 都认；不带括号的裸 IPv6 拼进 URL 会被当成端口。
    // （写成 /^[^\s]+$/ 那种宽松判断会把 "nas:" 这类残缺输入也括起来，展示成一串没用的东西。）
    displayHost: (ap.host.indexOf(":") >= 0 && /^[0-9a-f:.%]+$/i.test(ap.host) ? "[" + ap.host + "]" : ap.host),
  };
}

/* ---------------- i18n ---------------- */

const I18N = {
  zh_CN: {
    publish: "Netglimmer 一键上传",
    publishMergeSetting: "一键上传时包含子文档",
    publishMergeDesc: "开启后，右键「Netglimmer 一键上传」会把所选文档连同其子文档合并为一篇导出再上传（等同手动导出的「含子文档」）；关闭则只上传当前文档本身。",
    incremental: "增量上传（跳过重复运行时）",
    incrementalDesc: "开启后，重新上传同一文档时，思源运行时（stage/ 与 appearance/ 内约 570 个所有文档共用的文件）若已在服务器上且大小相同则跳过重传，只上传本文自有内容与有变化的文件，大幅加快二次上传。关闭则每次全量上传。",
    dashReusedTip: "其中 {n} 个运行时文件已在服务器、本次跳过重传",
    dashUnverifiedTip: "另有 {n} 个文件本次未能逐个确认（服务器不答文件大小，或逐个确认达到上限）",
    checkingRemote: "正在检查服务器上已有的文件…",
    settingsTitle: "Netglimmer 上传设置",
    server: "服务器地址",
    serverDescAny: "WebDAV 填根 URL（如 https://example.com/dav）；FTP/SFTP 填主机地址（如 192.168.1.10，IPv6 写成 [::1]），端口在右边的框里填；本地填导出目录的绝对路径（如 D:\\www\\upload 或 /var/www/html）",
    username: "用户名",
    password: "密码",
    passwordHint: "明文保存在本机插件配置（工作空间 data/storage/petal/…/settings.json）里；请勿把工作空间或该文件原样分享/同步出去，分享配置前先删掉 password 字段。",
    prefix: "远端子目录",
    prefixDesc: "可选，例如 uploads；所有文章上传到该目录下",
    cleanOld: "上传前清空远端旧目录",
    addToc: "上传的页面注入侧边大纲",
    addTocDesc: "（仅 HTML (SiYuan) 格式）在 index.html 末尾追加可交互大纲（默认靠左，可在页面里切左/右、拖内边缘调宽度、"
      + "长标题自动换行完整显示；目录按层级折叠展开，标题栏有折叠/全部展开按钮，滚动定位会自动展开被折起来的祖先；"
      + "正文在剩余空间里居中，页面与大纲的滚动条都做了可见化处理，把手让开滚动条；"
      + "正文里的图片可以点击放大，滚轮或 ＋/− 缩放、拖拽平移、Esc 关闭；"
      + "位置与宽度记在浏览器 localStorage，滚动高亮、明暗主题自适应）",
    save: "保存设置",
    saved: "设置已保存",
    saveFail: "保存失败（思源数据文件写不进去？）",
    test: "测试连接",
    testing: "正在测试…",
    testNeedFields: "请先填写服务器地址和用户名",
    testReachable: "服务可达（HTTP {s}）",
    testAuthFail: "认证失败（HTTP {s}），请检查用户名/密码",
    testNotFound: "目录不存在（HTTP {s}），上传时将自动创建",
    testUnreachable: "无法连接：{e}",
    testWriteOk: "，目录创建与上传正常",
    testWriteFail: "，但无法写入：{e}（IIS 请检查 WebDAV 请求筛选与写入规则）",
    testNotWebdav: "该地址返回的是普通网页而非 WebDAV 应答，这不是 WebDAV 端点——请核对 WebDAV 服务的路径与端口",
    testVerifyFail: "，但 PUT 后读回校验失败（服务器可能并未真正保存文件，不是真实 WebDAV 服务）",
    needServer: "请先在插件设置中配置 WebDAV 服务器",
    protocol: "传输协议",
    recTitle: "推荐组合：WebDAV + HTML (SiYuan)",
    recBody: "HTML (SiYuan) 是三档里唯一「一整页」的格式：明暗主题、代码高亮、侧边大纲、图片点击放大、双链与块嵌入都在，"
      + "离线打开也是完整一页，还原度与风格完整性最高。WebDAV 走的是普通 HTTP（PUT/DELETE/MKCOL/PROPFIND），"
      + "浏览器、代理、防火墙都不额外挑，插件的端到端回归也在它上面跑得最足（真实 IIS 与 nginx 各一遍，逐字节读回校验）。"
      + "另两档各有取舍：Markdown 只有正文加引用到的图，不带运行时、不注入大纲，能不能被浏览器直接打开取决于服务器 MIME；"
      + "Word 只有一个自包含 .docx，适合拿去 Word/WPS 继续编辑，但依赖内核自带的 pandoc、每次全量上传、页面上没有大纲与主题。"
      + "FTP / SFTP / 本地目录都能配任一格式照常上传，只是 FTP 恒为单路串行、列表方言多，SFTP 仅支持密码认证。",
    protocolDesc: "WebDAV / FTP / SFTP / 本地（FTP、SFTP、本地需桌面版思源）；每种协议各自保存服务器/账号/子目录配置，切换时互不覆盖，上传只使用当前选中的协议",
    exportFormat: "导出格式",
    fmtHtml: "HTML (SiYuan)",
    fmtMd: "Markdown",
    fmtDocx: "Word (.docx)",
    exportFormatDesc: "HTML (SiYuan)：思源自己的一整套静态页面（index.html + stage/appearance 运行时 + 引用的资源文件），"
      + "离线打开、明暗主题、代码高亮、大纲都在，还原度最高，代价是每篇都要带上那套运行时。"
      + "Markdown：只上传内核「导出 → Markdown」得到的那份正文（<文档名>.md，含前置元数据）加它真正引用到的资源文件，"
      + "不带运行时、不注入侧边大纲，产物小一到两个数量级；适合喂给静态站点生成器或任何 Markdown 阅读器。"
      + "另：内核的 Markdown 导出接口不接受「含子文档」，所以选 Markdown 时那一档自动不生效，"
      + "记录里写的也是不含子文档。"
      + "Word (.docx)：内核「导出 → Word」的产物，走思源自带的 pandoc，单个自包含文件（图片嵌在 word/media/ 里），"
      + "既不上传运行时也不上传 assets/，所以这一档只有一个入口文件；「含子文档」对它有效（pandoc 真会把子文档并进同一个文件）。"
      + "它依赖内核找得到 pandoc：内核回「导出失败：…」时，后半句就是内核给的原始原因（这个环境没有可用的 pandoc 是其中一种），换 HTML 或 Markdown 即可。"
      + "三档落在同一个远端文档目录里，切换格式后重新上传会把上一个入口文件当作孤立文件清掉。"
      + "（没有 PDF 档：思源内核本身不产出 PDF，桌面端的 PDF 是编辑器窗口打印生成的，插件拿不到那条私有通道。）",
    generatingDocx: "正在生成 Word (.docx)…",
    needWorkspaceDir: "内核没有报告工作区绝对路径，Word 档无法落盘临时文件；请改用 HTML 或 Markdown，或确认思源是本地内核",
    docxNoOutput: "内核没有产出 .docx 文件（Word 导出依赖思源自带的 pandoc）",
    localProto: "本地目录",
    needLocalPath: "请先在插件设置中填写本地导出路径",
    testLocalOk: "本地路径可用：{p}",
    testLoggedIn: "连接并登录成功",
    testFp: "，主机密钥指纹 {fp}（首次连接已记录，指纹变化会拒绝连接）",
    needServerCommon: "请先在插件设置中配置服务器地址",
    exporting: "正在导出…",
    generating: "正在生成 index.html…",
    generatingMd: "正在生成 Markdown…",
    cleaning: "正在清理远端旧目录…",
    makingDirs: "正在创建远端目录…",
    uploading: "正在上传",
    probing: "正在做传输自检…",
    verifying: "正在读回校验…",
    staleCleaning: "正在清理远端孤立文件…",
    verifyFail: "读回校验失败",
    verifyMismatch: "远端文件大小与本地不一致",
    verifyMissing: "远端缺失",
    verifyUnreadable: "远端读取失败",
    verifyListUntrusted: "远端目录列举不可信",
    verifyNoRead: "该服务器读不回内容，可能禁止下载",
    verifyBudget: "逐个确认已达数量上限",
    verifySkipSome: "远端有 {n} 个文件未能逐个校验（{w}），本次上传未做完整校验",
    dashSelAll: "全选（筛选结果 {n} 条）",
    dashSelNone: "取消勾选",
    dashSelFilteredTip: "作用范围是整个筛选结果——包括翻页翻不到的那几页。远端还挂着的行进不了这个清单：先「删除远端文件」，才谈得上删它的记录",
    dashSelPageTip: "勾上 / 取消当前这一页里可删的行。远端还挂着的行不给勾（要先「删除远端文件」）；要一次勾满整个筛选结果（含其它页），用上方工具条的「全选」",
    dashPageInfo: "第 {a}–{b} 条 / 共 {N} 条",
    dashPageOf: "第 {p} / {n} 页",
    dashPagePrev: "上一页",
    dashPageNext: "下一页",
    dashPageSizeLabel: "每页",
    dashPageAll: "全部",
    dashPageTip: "翻页只决定这一屏画多少行：筛选、排序、勾选与批量操作的作用范围都是整个筛选结果，不是当前这一页",
    dashPageSizeTip: "每页条数记在这台浏览器里（与列宽、排序同一套记忆口径），不随笔记同步",
    dashDelSel: "删除所选 {n} 条",
    dashDelSelZero: "删除所选记录",
    dashDelOne: "删除记录",
    dashDelSelTip: "只把勾掉的这几条从清单上摘下来：作用范围是当前筛选结果，服务器上的内容一个字节都不动",
    dashDelOneTip: "把这条记录从清单上摘下来：服务器上已上传的内容不会被改动",
    dashSelLiveTip: "这篇文档远端还挂着，记录暂不能删——先「删除远端文件」（那一步才会删掉远端目录，之后这条记录就能删了）",
    confirmDelOne: "确定删除这条上传记录？服务器上的内容不受影响，但记录删掉之后，看板就再也找不到这篇文档的远端目录、无法删除远端文件或按原协议重传了。继续？",
    confirmDelSel: "确定删除勾选的 {n} 条上传记录？服务器上的内容不做任何改动；远端还挂着的会被跳过。记录删掉后，看板对剩下的这些文档就无从删除远端文件或重传了。继续？",
    delDone: "已从清单删除 {n} 条记录（远端内容未改动）",
    histSaveFail: "上传记录没写进去（本地数据文件保存失败）——本次操作结果以远端实际为准，重启后看板可能看不到这一条",
    delBlocked: "其中 {n} 条远端还在，已跳过（请先删除远端文件再删记录）",
    delNothing: "一条都没删：勾选的记录远端都还挂着，请先删除远端文件",
    verifyHintUpload: "——远端为 0 字节而本地非 0：上传通道异常，请重启思源后重试",
    verifyHintLocal: "——本地导出文件本身为 0 字节：请先手动「导出 HTML(SiYuan)」确认导出是否正常",
    failed: "上传失败",
    busyNow: "正在上传中，请等待当前任务完成",
    dashboard: "上传看板",
    settingsTab: "上传设置",
    dashUnavailable: "当前版本不支持看板弹窗",
    dashTitle: "上传记录",
    dashEmpty: "暂无上传记录",
    colTime: "时间",
    colDoc: "文档",
    colProto: "协议",
    colStatus: "结果",
    colDetail: "详情",
    colAction: "操作",
    stOk: "成功",
    stFail: "失败",
    files: "文件",
    /* 「详情」这一格写的是**本文自有**的文件数与体积（正文 + 正文用到的资产），
     * 不含每次导出都顺带带去的思源运行时；看板上方那句「实际传输」才是这一次真正
     * 写进服务器的总量。两个口径一直并存，用户看到的却是两个不同的数——所以格子
     * 前面钉一个「本文」，表头再补一条 tooltip 把口径说破，而不是让人以为是 bug。 */
    dashOwnPrefix: "本文",
    colDetailTip: "「详情」里的数字只算本文自己的文件（正文 + 正文用到的资产），不含每次上传都顺带带去的思源运行时（stage/、appearance/）。看板上方的「实际传输 N 个文件 / 体积」才是这一次真正写进服务器的总量：两个口径不同，不是数字对不上。",
    dashDocFilesTip: "含思源运行时（stage/appearance）共上传 {n} 个文件 · {b}",
    rePublish: "重新上传",
    /* 看板不给「打开 / 复制」按钮——本插件只负责把文件传到远端，
     * 那个地址能不能在浏览器里打开、是不是用户真正的站点地址，它并不知道。
     * 只有一个「查看上传路径」：点开在这行下面显示远端路径原文（可全选复制）。 */
    viewPath: "查看上传路径",
    hidePath: "收起路径",
    pathNone: "该记录没有远端路径信息",
    clearHistory: "清空记录",
    dashRefresh: "刷新",
    confirmClear: "确定清空全部上传记录？",
    confirmClearLive: "注意：其中 {n} 条对应的文档远端还挂着。清空只删本地这份清单，远端内容不会被动，但看板从此找不回它们，也就无法再「删除远端文件」或按原协议重传。",
    changed: "内容有改动",
    unchanged: "无改动",
    changedUnknown: "未比对",
    checkChanged: "检测",
    checking: "比对中…",
    changedTipOn: "自该次上传后源文档有更新，建议重新上传",
    changedTipOff: "源文档自该次上传后无改动",
    changedTipUnknown: "该记录缺少改动指纹，无法比对",
    colChanged: "改动",
    resetCols: "重置列宽",
    colsReset: "已恢复默认列宽",
    colResizeTip: "拖动调整列宽 · 双击恢复该列默认",
    /* ---- 入口 / 取消 / 结果卡片 / 看板筛选 / 设置安全提示 ---- */
    cmdPublishCurrent: "Netglimmer：上传当前文档",
    publishCurrentShort: "上传当前文档",
    cmdOpenDashboard: "Netglimmer：打开上传看板",
    cmdRepublishAll: "Netglimmer：重新上传全部有改动的文档",
    noCurrentDoc: "找不到当前打开的文档——请先在编辑器里打开一篇文档再触发",
    notADoc: "这不是文档节点（目录或笔记本根）：上传只支持单篇文档",
    cancel: "取消",
    cancelTip: "取消本次上传（正在传的那个文件会传完再停；已上传的文件保留在服务器上）",
    canceling: "正在取消…",
    canceledErr: "已取消（{d}）",
    publishCanceled: "上传已取消：{d}",
    publishCanceledPartial: "上传已取消（{d}），远端此刻是不完整的——可重新上传补齐，或「删除远端文件」清空该目录",
    publishCanceledComplete: "上传已取消（{d}）：文件其实已全部传完，远端目录是完整的，只是没做完读回校验",
    cardOk: "上传成功",
    cardFail: "上传失败",
    dashFilterPh: "筛选：文档名 / 远端路径 / 错误信息",
    dashAllProto: "全部协议",
    dashAllStatus: "全部结果",
    dashStDeleted: "已删除 · 远端仍在",
    dashChangedOnly: "只看有改动",
    dashNoMatch: "没有符合筛选条件的记录（共 {N} 条）",
    dashShown: "显示 {n} / {N} 条",
    dashSortTip: "点击表头排序",
    dashCountTip: "这篇文档在该协议下共上传 {n} 次（首次 {t}）",
    deletedBadge: "文档已删除",
    deletedBadgeTip: "本地已经找不到这篇文档（或所属笔记本已关闭／加密），但服务器上的远端目录还在——点「删除远端文件」可以把它清掉",
    bulkRepublish: "重新上传全部有改动",
    bulkRepublishConfirm: "将依次重新上传 {n} 篇有改动的文档（{l}），继续？",
    bulkRepublishDone: "批量重传完成：成功 {ok} 篇，失败 {fail} 篇",
    bulkRepublishNone: "没有检测到「上传后又有改动」的文档",
    bulkCleanupDeleted: "清理已删除文档的远端",
    bulkCleanupConfirm: "将删除 {n} 篇「本地已删除、远端仍在」文档的远端目录（{l}）。本地文档不受影响，远端内容不可恢复。继续？",
    bulkCleanupNone: "没有「本地已删除、远端仍在」的记录可清理",
    bulkCleanupDone: "远端清理完成：清掉 {ok} 个，失败 {fail} 个",
    bulkCleanupCancelTip: "取消剩下的清理（正在删的那一篇会删完再停）",
    bulkStoppedNote: "已取消，剩下 {n} 篇没做",
    bulkCleaning: "正在清理 {i}/{n}：{d}",
    usernameDesc: "{p} 的登录账号（本地目录协议不用填）",
    usernameDescShort: "登录服务器用的账号；换成「本地目录」协议时这项留空即可。",
    cleanOldDesc: "上传时删除远端「孤立文件」（本次产物清单里没有的旧资产），并清理文档改名／移动留下的旧目录。关掉＝只追加、不删任何东西。",
    prefixEmptyWarn: "⚠ 子目录留空＝每个文档的远端目录直接建在服务器那侧的根上：跟站点自己的路径同名就会撞上（比如一篇叫 assets 的文档），而且「删除远端文件」删的是根下面那一层。除非这个位置专门用来放上传内容，否则至少填一层子目录。",
    serverBadHint: "地址格式可能不对：{p} 建议形如 {e}（当前填的是「{v}」）",
    port: "端口",
    portPhShort: "留空＝{n}",
    portDesc: "FTP 默认 21，SFTP 默认 22；服务器改了端口就填在这里（地址里写 host:2121 的旧办法照样有效，两处都填时以本框为准）。WebDAV 和本地目录没有这一项：WebDAV 的端口写在上面那串 URL 里。",
    portDefaultNote: "留空＝用默认端口 {n}。",
    portBad: "端口得是 1-65535 的整数（当前填的是「{v}」），留空表示用默认端口。",
    portConflict: "地址里写的是 {a}，端口框里是 {f}——两个不一样，连接会用 {f}。留空其中一个，免得下次自己骗自己。",
    portFromAddr: "端口取自地址里的 {a}（端口框留空）；也可以把 {a} 填到右边那个框里。",
    portIpv6Ambiguous: "IPv6 地址建议写成 [::1]:2121：不加方括号时整串按主机名处理，无法从地址里读端口，请把端口填在右边的框。",
    portUsing: "连接时使用端口 {n}。",
    dashClose: "关闭",
    dashMergeTag: " · 含子文档",
    publishedBadgeTip: "该文档已通过 Netglimmer 上传（点击尝试打开记录里的远端地址；能不能打开取决于服务器有没有把这个目录当站点提供）",
    changedBadgeTip: "已上传过，但上传后正文又有改动（点击尝试打开远端地址；右键可重新上传）",
    publishChangedMenu: "检测到改动，重新上传",
    publishSummaryOk: "已上传：{url}｜本次传输 {sent} 个文件 / {sentB}，复用服务器上 {reused} 个运行时文件，共 {dur} 秒",
    uploadFailAt: "部分文件上传失败（已重试仍不行）",
    uploadFailMore: "另有 {n} 个文件未成功",
    uploadFailItem: "首个失败文件：{n}（{b}）",
    uploadFailBigHint: "该文件较大：IIS/nginx 这类服务端自己有请求体上限"
      + "（IIS 的 maxAllowedContentLength、uploadReadAheadSize，nginx 的 client_max_body_size），"
      + "超过就会被直接拒掉，思源插件侧的单文件上限管不到它。"
      + "可以调大服务器限制，或把这一个附件换成更小的文件/外链。",
    retryFailed: "重试上传",
    republishTip: "按该记录当初使用的协议 {p} 重新上传（用它在设置里保存的服务器配置）",
    currentProto: "当前协议",
    dashSummary: "成功上传 {n} 次｜最近一次（{t}）实际传输 {sent} 个文件 / {b}，复用服务器上已有的运行时文件 {reused} 个",
    queuedNow: "已有上传任务在进行，本次已排队，完成后自动开始",
    dryRun: "试算",
    dryRunTip: "只统计「会传哪些文件、共多少字节、能复用多少」，不建目录、不删除、不上传（远端零写入）",
    dryRunResult: "试算「{d}」：待上传 {n} 个文件 / {b}，可复用服务器上 {re} 个运行时文件。本次未对远端做任何修改。",
    fileTooBig: "文件 {n} 大小为 {b}，超过单文件上限 {m}（可在设置里调大或设为 0 不限制）",
    ownerRelocated: "检测到同名文档已占用原目录，本次已上传到独立目录 {d}，避免互相覆盖",
    ownerWriteWarn: "归属标记没能写到远端（{e}）：本次上传内容本身完整，但同名文档的覆盖保护会弱化",
    safeNames: "自动改用服务器存得下的文件名",
    safeNamesDesc: "附件/图片的文件名是原样上传的，而 WebDAV（尤其 IIS/Windows，背后是 NTFS）"
      + "存不下 < > : \" | ? * + \\，也拒绝结尾是点或空格的名字、以及 CON/NUL/COM1 这类保留设备名"
      + "——只要子树里有一个这种附件，整次上传就会在最后报「HTTP 400/404」。"
      + "开启后，这类名字会被换成同形全角字符（: → ：、+ → ＋，结尾点 → -），"
      + "并同步改写入口文件（index.html 或 <文档名>.md）里的引用；本来就合法的文件名一个字节都不动。"
      + "关闭后遇到这种名字会在建立远端连接之前直接报错并列出问题文件。",
    unsafeNamesFound: "{n} 个文件名服务器存不下，已改用安全名：{l}",
    unsafeNamesBlocked: "{n} 个文件名无法被 WebDAV 服务器保存：{l}。请在思源里重命名这些附件/图片，或在设置中开启「自动改用服务器存得下的文件名」。",
    unsafeNamesDry: "试算发现 {n} 个文件名服务器存不下（{l}）；当前设置会{a}。",
    unsafeDryRename: "自动改用安全名并同步改写页面引用",
    unsafeDryBlock: "在上传前直接中止",
    oldRootCleaned: "已清理 {n} 个改名/迁移遗留的旧远端目录",
    remotePartialWarn: "远端目录可能不完整（已建目录或部分上传后才失败）：{d}。可在看板「试算」后重新上传，或「删除远端文件」清空该目录。",
    stUnpub: "已删除远端",
    unpublish: "删除远端文件",
    unpublishTip: "删除远端上这篇文档的目录（本地文档与历史保留，记录标记为已删除远端）",
    unpublishConfirm: "确定删除远端目录 {d}（协议 {p}）？该目录下的内容会全部移除，本地文档不受影响。",
    unpublishing: "正在删除远端目录…",
    unpublished: "已删除远端：{d}",
    unpublishFail: "删除远端文件失败",
    unpublishForeign: "目录 {d} 现在属于另一篇同名文档（检测到别人的归属标记），已取消删除，避免误删对方的内容",
    cannotLocateRemote: "该记录缺少远端目录信息，无法自动清理，请手动删除远端目录",
    needServerForProto: "请先在插件设置中配置 {p} 的服务器地址/账号",
    retryTries: "单文件重试次数",
    retryTriesDesc: "上传/删除遇到连接中断、超时等瞬时错误时的重试上限（1–6，默认 3）。设为 1 即不重试。",
    concurrency: "并发上传数",
    concurrencyDesc: "0 = 按协议自动选择（WebDAV 6、SFTP/本地 4、FTP 1）；手动设为 1–16 可覆盖。服务器较弱或带宽较小时调低更快。",
    maxFileMB: "单文件大小上限 (MB)",
    maxFileMBDesc: "超过该大小的文件跳过并报错，避免整文件读入内存导致卡顿（默认 64，0 = 不限制）。",
    debug: "输出调试日志",
    debugDesc: "在浏览器控制台输出每次请求/上传的详细信息，用于排查上传失败；日常使用建议关闭。",
    knownHosts: "已知主机密钥 (SFTP)",
    knownHostsDesc: "首次连接的 SSH 服务器指纹会被记住，指纹变化（换服务器/中间人）时会拒绝连接。换机后可在这里清除记录重新接受。",
    knownHostsCount: "已记录 {n} 个主机密钥",
    knownHostsNone: "暂无已记录的主机密钥",
    clearHosts: "清除全部",
    clearHostsConfirm: "确定清除全部已知主机密钥？下次连接各 SFTP 服务器时会重新记录指纹。",
    clearHostsDone: "已知主机密钥已清除，下次连接将重新记录",
    hostKeySaveFail: "SFTP 主机密钥没能写进本地设置（保存失败）：下次连接会重新记录指纹，中途服务器换密钥不会被发现",
  },
  en_US: {
    publish: "Netglimmer One-Click Upload",
    publishMergeSetting: "Include sub-docs when uploading",
    publishMergeDesc: "When on, the right-click “Netglimmer One-Click Upload” merges the selected document together with its sub-documents into a single export (same as the manual “with sub-docs” export). When off, only the document itself is uploaded.",
    incremental: "Incremental upload (skip duplicate runtime)",
    incrementalDesc: "When on, re-uploading a document skips re-sending the SiYuan runtime (the ~570 files shared by every document under stage/ and appearance/) if they already exist on the server with the same size — only this document's own content and any changed files are uploaded, making repeat uploads much faster. When off, every upload sends all files.",
    dashReusedTip: "{n} runtime files already on the server were skipped this time",
    dashUnverifiedTip: "{n} more files could not be confirmed one by one (server withholds sizes, or the per-file check hit its cap)",
    checkingRemote: "Checking files already on the server…",
    settingsTitle: "Netglimmer Upload Settings",
    server: "Server URL",
    serverDescAny: "WebDAV: root URL (e.g. https://example.com/dav); FTP/SFTP: host only (e.g. 192.168.1.10, IPv6 as [::1]) — put the port in the box on the right; Local: absolute export dir (e.g. D:\\www\\upload or /var/www/html)",
    username: "Username",
    password: "Password",
    passwordHint: "Stored in plain text in this machine's plugin config (workspace data/storage/petal/…/settings.json). Never share or sync the workspace as-is; delete the password field before sharing the config.",
    prefix: "Remote subdirectory",
    prefixDesc: "Optional, e.g. uploads; every document is uploaded under it",
    cleanOld: "Clean remote folder before upload",
    addToc: "Inject sidebar outline into uploaded pages",
    addTocDesc: "HTML (SiYuan) format only: append an interactive outline to index.html (docks left by default; readers can switch it to left or right, "
      + "drag the inner edge to change its width, long titles wrap to show fully; each level folds open and shut, with a collapse/expand-all button in the "
      + "header and ancestors auto-expanded when the scroll lands inside a folded branch; the article centers itself in the remaining space, "
      + "page and outline scrollbars are made visible, and the resize handle stays clear of the scrollbar; "
      + "article images open click to zoom, with wheel or plus/minus zoom, drag to pan and Esc to close; "
      + "position and size persist in browser localStorage; scroll-spy and light/dark adaptive)",
    save: "Save Settings",
    saved: "Settings saved",
    saveFail: "Saving failed (the SiYuan data file could not be written)",
    test: "Test Connection",
    testing: "Testing...",
    testNeedFields: "Please fill in server URL and username first",
    testReachable: "Server reachable (HTTP {s})",
    testAuthFail: "Authentication failed (HTTP {s})",
    testNotFound: "Folder not found (HTTP {s}), will be created on upload",
    testUnreachable: "Cannot connect: {e}",
    testWriteOk: ", create & upload OK",
    testWriteFail: ", but write failed: {e}",
    testNotWebdav: "The URL returned a normal web page instead of a WebDAV response - not a WebDAV endpoint, check path/port",
    testVerifyFail: ", but read-back verification failed (server did not actually store the file)",
    needServer: "Please configure the WebDAV server in plugin settings first",
    protocol: "Protocol",
    recTitle: "Recommended: WebDAV + HTML (SiYuan)",
    recBody: "HTML (SiYuan) is the only format of the three that ships a whole page: light/dark themes, code highlighting, "
      + "the side outline, click-to-zoom images, backlinks and block embeds — it stays a complete page offline, and its fidelity and styling are the most complete. "
      + "WebDAV is plain HTTP (PUT/DELETE/MKCOL/PROPFIND), so no browser, proxy or firewall picks at it, and it is the transport with the deepest end-to-end coverage "
      + "in this plugin's regression suite (a real IIS and a local nginx, each read back byte for byte). "
      + "The other two formats each trade something away: Markdown is just the body plus the images it references — no runtime, no injected outline, and whether a "
      + "browser can open it depends on the server's MIME map; Word is a single self-contained .docx, ideal for continuing in Word/WPS, but it needs the kernel's bundled "
      + "pandoc, uploads in full every time, and has no outline or theme. "
      + "FTP / SFTP / Local still upload any format normally — only note that FTP is always single-threaded with several listing dialects, and SFTP supports passwords only.",
    protocolDesc: "WebDAV / FTP / SFTP / Local (FTP, SFTP and Local require the desktop app). Each protocol keeps its own server / account / subfolder config and switching never overwrites them; uploading always uses the selected protocol only",
    exportFormat: "Export format",
    fmtHtml: "HTML (SiYuan)",
    fmtMd: "Markdown",
    fmtDocx: "Word (.docx)",
    exportFormatDesc: "HTML (SiYuan): SiYuan's own static page bundle (index.html + the stage/appearance runtime + the assets the document actually references). "
      + "Opens offline with themes, code highlighting and the sidebar outline — highest fidelity, but every document carries that runtime with it. "
      + "Markdown: uploads only what the kernel's own Export → Markdown produces (<document name>.md, front matter included) plus the assets that document "
      + "actually references — no runtime, no outline injection, one to two orders of magnitude smaller; meant for static site generators or any Markdown reader. "
      + "Note also that the kernel's Markdown export does not accept “with sub-documents”: with Markdown selected that option simply does not apply, and the history record says so too. "
      + "Word (.docx): the kernel's own Export → Word, produced by the pandoc that ships with SiYuan. A single self-contained file (images live in word/media/), "
      + "so this format uploads neither the runtime nor an assets/ folder — just the one entry file. “With sub-documents” does apply here: pandoc really merges "
      + "the subtree into the same file. It needs the kernel to find pandoc: when the kernel answers “export failed: …”, the text after the colon is the kernel's own "
      + "reason (a missing/unusable pandoc being one of them) — pick HTML or Markdown in that case. "
      + "All three formats land in the same remote document folder, so switching format and re-uploading removes the previous entry file as a stale one. "
      + "(There is no PDF option: the kernel cannot produce PDFs at all — the desktop app's PDF comes from printing the editor window, a private channel a plugin cannot reach.)",
    generatingDocx: "Generating Word (.docx)…",
    needWorkspaceDir: "The kernel did not report an absolute workspace path, so the Word format cannot write its temporary file; use HTML or Markdown, or check that this is a local kernel",
    docxNoOutput: "The kernel produced no .docx file (Word export relies on the pandoc bundled with SiYuan)",
    localProto: "Local folder",
    needLocalPath: "Please set a local export path in plugin settings first",
    testLocalOk: "Local path is writable: {p}",
    testLoggedIn: "Connected and logged in",
    testFp: ", host key fingerprint {fp} (recorded on first contact; changes are refused)",
    needServerCommon: "Please configure the server in plugin settings first",
    exporting: "Exporting...",
    generating: "Generating index.html...",
    generatingMd: "Generating Markdown...",
    cleaning: "Cleaning remote folder...",
    makingDirs: "Creating remote folders...",
    uploading: "Uploading",
    probing: "Running transport self-check...",
    verifying: "Verifying...",
    staleCleaning: "Removing orphan files on the server...",
    verifyFail: "Read-back verification failed",
    verifyMismatch: "Remote file sizes do not match local",
    verifyMissing: "missing remotely",
    verifyUnreadable: "remote read failed",
    verifyListUntrusted: "remote directory listing is not trustworthy",
    verifyNoRead: "the server will not read content back, downloads may be blocked",
    verifyBudget: "per-file confirmation hit its cap",
    verifySkipSome: "{n} remote files could not be confirmed one by one ({w}); this upload was not fully verified",
    dashSelAll: "Select all ({n} filtered)",
    dashSelNone: "Clear selection",
    dashSelFilteredTip: "Scope is the whole filtered result — including rows the current page does not show. Records whose files are still on the server never enter this list: delete the remote files first, then their record.",
    dashSelPageTip: "Tick / untick every deletable row on this page. Rows still live on the server cannot be ticked (delete their remote files first); to tick the whole filtered result across pages, use \"Select all\" in the toolbar above.",
    dashPageInfo: "Items {a}–{b} of {N}",
    dashPageOf: "Page {p} / {n}",
    dashPagePrev: "Previous",
    dashPageNext: "Next",
    dashPageSizeLabel: "Per page",
    dashPageAll: "All",
    dashPageTip: "Paging only decides how many rows this screen draws: filtering, sorting, ticks and the bulk actions all apply to the whole filtered result, not just this page.",
    dashPageSizeTip: "The page size is remembered in this browser (same mechanism as column widths and sorting); it does not sync with the notebook.",
    dashDelSel: "Delete {n} selected",
    dashDelSelZero: "Delete selected",
    dashDelOne: "Delete record",
    dashDelSelTip: "Remove the ticked records from this list. Only what you can see in the current filter is affected; nothing on the server is touched.",
    dashDelOneTip: "Remove this record from the list. The content already uploaded on the server stays where it is.",
    dashSelLiveTip: "This document is still on the server, so its record cannot be deleted — use \"Delete remote files\" first (that removes the remote folder and frees the record).",
    confirmDelOne: "Delete this upload record? Nothing on the server is changed, but once the record is gone the dashboard can no longer find that document's remote folder, so it cannot delete it or re-upload it over its own protocol. Continue?",
    confirmDelSel: "Delete the {n} selected upload records? Nothing on the server is changed; records whose document is still on the server are skipped. Once a record is gone the dashboard loses its handle on that document. Continue?",
    delDone: "Removed {n} record(s) from the list (remote content untouched)",
    histSaveFail: "The upload record could not be written (saving the local data file failed) — this run's real result is whatever is on the server; the dashboard may not show this row after a restart",
    delBlocked: "Skipped {n} record(s) still present on the server — delete their remote files first",
    delNothing: "Nothing was deleted — every ticked record is still on the server, delete their remote files first",
    verifyHintUpload: " - remote is 0 byte while local is not: upload channel broken, restart SiYuan and retry",
    verifyHintLocal: " - local export files themselves are 0 bytes: try manual Export HTML(SiYuan) first to confirm export works",
    failed: "Upload failed",
    busyNow: "An upload is already running, please wait",
    dashboard: "Upload Dashboard",
    settingsTab: "Upload Settings",
    dashUnavailable: "Dialog API unavailable in this version",
    dashTitle: "Upload History",
    dashEmpty: "No upload records yet",
    colTime: "Time",
    colDoc: "Document",
    colProto: "Protocol",
    colStatus: "Result",
    colDetail: "Details",
    colAction: "Actions",
    stOk: "OK",
    stFail: "Failed",
    files: "files",
    dashOwnPrefix: "Doc only:",
    colDetailTip: "The number in Details counts only this document's own files (its body plus the assets it uses), not the SiYuan runtime (stage/, appearance/) that every upload sends along as well. The \"actually transferred N files / size\" line above the table is what really reached the server this run: the two figures use different bases.",
    dashDocFilesTip: "{n} files · {b} uploaded in total, including the SiYuan runtime (stage/appearance)",
    rePublish: "Re-upload",
    /* the dashboard offers no "Open / Copy" buttons — this plugin only sends files to
     * the remote side, it has no idea whether that address is openable in a browser or whether
     * it is the site address the user actually serves. There is one "Show upload path" toggle
     * that expands the raw remote path under the row (selectable, so the user can copy it). */
    viewPath: "Show path",
    hidePath: "Hide path",
    pathNone: "This record has no remote path",
    clearHistory: "Clear records",
    dashRefresh: "Refresh",
    confirmClear: "Clear all upload records?",
    confirmClearLive: "Note: {n} of them belong to documents that are still on the server. Clearing removes this local list only — nothing on the server changes, but the dashboard can no longer find those documents, so \"Delete remote\" and re-uploading over their own protocol become impossible from here.",
    changed: "Changed",
    unchanged: "No change",
    changedUnknown: "Not compared",
    checkChanged: "Check",
    checking: "Comparing...",
    changedTipOn: "The source document changed since this upload; consider re-uploading",
    changedTipOff: "Source unchanged since this upload",
    changedTipUnknown: "This record has no fingerprint; cannot compare",
    colChanged: "Change",
    resetCols: "Reset column widths",
    colsReset: "Default column widths restored",
    colResizeTip: "Drag to resize this column · double-click restores its default",
    cmdPublishCurrent: "Netglimmer: Upload the current document",
    publishCurrentShort: "Upload this document",
    cmdOpenDashboard: "Netglimmer: Open the upload dashboard",
    cmdRepublishAll: "Netglimmer: Re-upload every changed document",
    noCurrentDoc: "Cannot tell which document is open — open one in the editor first",
    notADoc: "That is not a document node (a folder or notebook root) — uploading works on a single document",
    cancel: "Cancel",
    cancelTip: "Cancel this upload (the file in flight finishes; anything already sent stays on the server)",
    canceling: "Cancelling…",
    canceledErr: "Cancelled ({d})",
    publishCanceled: "Upload cancelled at “{d}”",
    publishCanceledPartial: "Upload cancelled at “{d}” and the remote folder is now incomplete — re-upload to finish it, or use \"Delete remote files\" to clear the folder",
    publishCanceledComplete: "Upload cancelled at “{d}”: every file had already been sent, so the remote folder is complete — only the read-back check was skipped",
    cardOk: "Uploaded",
    cardFail: "Upload failed",
    dashFilterPh: "Filter: document, remote path, error text",
    dashAllProto: "All protocols",
    dashAllStatus: "All results",
    dashStDeleted: "Deleted locally · still on the server",
    dashChangedOnly: "Changed only",
    dashNoMatch: "No records match the filter ({N} in total)",
    dashShown: "Showing {n} of {N}",
    dashSortTip: "Click a header to sort",
    dashCountTip: "This document was uploaded {n} time(s) over {t} (first upload)",
    deletedBadge: "Document deleted",
    deletedBadgeTip: "This document no longer exists locally (or its notebook is closed／encrypted), but its remote folder is still on the server — press \"Delete remote files\" to remove it",
    bulkRepublish: "Re-upload all changed",
    bulkRepublishConfirm: "Re-upload {n} changed document(s) in sequence ({l}). Continue?",
    bulkRepublishDone: "Bulk re-upload finished: {ok} succeeded, {fail} failed",
    bulkRepublishNone: "No document changed since its last upload",
    bulkCleanupDeleted: "Clean up deleted documents",
    bulkCleanupConfirm: "Delete the remote folders of {n} document(s) that were deleted locally but are still on the server ({l}). Local documents are untouched; remote content cannot be recovered. Continue?",
    bulkCleanupNone: "Nothing to clean: no record is both deleted locally and still on the server",
    bulkCleanupDone: "Cleanup finished: {ok} folder(s) removed, {fail} failed",
    bulkCleanupCancelTip: "Stop the rest of this cleanup (the folder being deleted now finishes first)",
    bulkStoppedNote: "Canceled — {n} document(s) left undone",
    bulkCleaning: "Cleaning {i}/{n}: {d}",
    usernameDesc: "Login account for {p} (leave empty for a local folder)",
    usernameDescShort: "The account used to log in to the server; leave it empty when the protocol is a local folder.",
    cleanOldDesc: "On upload, delete remote orphan files (assets not in this build) and folders left behind by renames／moves. Off means append-only — nothing is ever deleted.",
    prefixEmptyWarn: "⚠ An empty sub-directory puts every document folder straight in the root of the remote location, where it can collide with paths that folder already uses (a document named “assets”, say), and \"Delete remote files\" then deletes a top-level folder. Give it at least one sub-directory unless that whole location exists only for these uploads.",
    serverBadHint: "The address looks malformed: for {p} use {e} (you entered “{v}”)",
    port: "Port",
    portPhShort: "empty = {n}",
    portDesc: "FTP defaults to 21, SFTP to 22. If your server listens elsewhere, set it here (the old host:2121 spelling in the address still works; when both are filled, this box wins). WebDAV and local folders have no port box — WebDAV carries its port inside the URL above.",
    portDefaultNote: "Empty = use the default port {n}.",
    portBad: "A port must be a whole number from 1 to 65535 (you entered “{v}”). Leave it empty for the default.",
    portConflict: "The address says {a} but this box says {f} — connections will use {f}. Clear one of the two so the setting cannot surprise you later.",
    portFromAddr: "The port comes from {a} in the address (the port box is empty). You can also move {a} into the box on the right.",
    portIpv6Ambiguous: "Write IPv6 as [::1]:2121: without the brackets the whole string is treated as the host, so no port can be read from it — put the port in the box on the right.",
    portUsing: "Connections will use port {n}.",
    dashClose: "Close",
    dashMergeTag: " · with sub-docs",
    publishedBadgeTip: "This document has been uploaded via Netglimmer (click to try opening the remote address in its record; whether that works depends on the server actually serving the folder as a site)",
    changedBadgeTip: "Uploaded, but the document changed afterwards (click to try opening the remote address; right-click to re-upload)",
    publishChangedMenu: "Changes detected — re-upload",
    publishSummaryOk: "Uploaded: {url} | sent {sent} files / {sentB}, reused {reused} runtime files already on the server, {dur}s total",
    uploadFailAt: "Some files failed to upload (retried)",
    uploadFailMore: "{n} more files also failed",
    uploadFailItem: "First failed file: {n} ({b})",
    uploadFailBigHint: "That file is large: the server itself caps the request body "
      + "(IIS maxAllowedContentLength / uploadReadAheadSize, nginx client_max_body_size) "
      + "and rejects anything over it — the plugin's per-file limit cannot override that. "
      + "Raise the server limit, or replace this attachment with a smaller file or an external link.",
    retryFailed: "Retry upload",
    republishTip: "Re-upload over the protocol this record used ({p}), with the server settings saved for it",
    currentProto: "current protocol",
    dashSummary: "{n} successful uploads | latest ({t}) sent {sent} files / {b}, reused {reused} runtime files already on the server",
    queuedNow: "An upload is already running; this one was queued and will start automatically",
    dryRun: "Dry run",
    dryRunTip: "Only counts which files would be uploaded, how many bytes and how many can be reused — no mkdir, no delete, no upload (remote untouched)",
    dryRunResult: "Dry run for \"{d}\": {n} files / {b} to upload, {re} runtime files reusable on the server. Nothing was modified remotely.",
    fileTooBig: "File {n} is {b}, above the {m} per-file limit (raise it in settings, or set 0 for no limit)",
    ownerRelocated: "Another document with the same name already owns the original folder; this upload went to its own folder {d} so nothing was overwritten",
    ownerWriteWarn: "The ownership marker could not be written to the server ({e}); the uploaded content itself is complete, but same-name overwrite protection is weakened this round",
    safeNames: "Use server-safe file names automatically",
    safeNamesDesc: "Attachment/image file names are uploaded verbatim, and WebDAV "
      + "(IIS/Windows in particular, which sits on NTFS) cannot store < > : \" | ? * + \\, "
      + "names ending in a dot or space, or reserved device names such as CON/NUL/COM1 "
      + "— a single such attachment makes the whole upload fail at the very end with HTTP 400/404. "
      + "When on, those names are mapped to their full-width look-alikes (: → ：, + → ＋, trailing dot → -) "
      + "and the references inside the entry file (index.html or <document name>.md) are rewritten to match; already-legal names are never touched. "
      + "When off, the upload aborts with a list of the offending files before any connection is made.",
    unsafeNamesFound: "{n} file name(s) the server cannot store were given safe names: {l}",
    unsafeNamesBlocked: "{n} file name(s) cannot be stored by the WebDAV server: {l}. Rename those attachments/images in SiYuan, or turn on “Use server-safe file names automatically” in settings.",
    unsafeNamesDry: "Dry run found {n} file name(s) the server cannot store ({l}); current settings would {a}.",
    unsafeDryRename: "rename them automatically and rewrite the page references",
    unsafeDryBlock: "abort before anything is sent",
    oldRootCleaned: "Cleaned up {n} leftover folder(s) from renamed or moved documents",
    remotePartialWarn: "The remote folder may be incomplete (directories were created or partially sent before the failure): {d}. Run \"Dry run\" then re-upload from the dashboard, or use \"Delete remote\" to clear it.",
    stUnpub: "Remote deleted",
    unpublish: "Delete remote",
    unpublishTip: "Delete this document's remote folder on the server (the local document and the history record are kept)",
    unpublishConfirm: "Delete the remote folder {d} (protocol {p})? Everything uploaded inside it will be removed; the local document is untouched.",
    unpublishing: "Removing the remote folder…",
    unpublished: "Remote files deleted: {d}",
    unpublishFail: "Deleting the remote files failed",
    unpublishForeign: "Folder {d} now belongs to another document with the same name (a foreign ownership marker was found); the delete was aborted so nothing of theirs was lost",
    cannotLocateRemote: "This record has no remote folder information, so it cannot be cleaned automatically — please delete it manually",
    needServerForProto: "Please configure the server/address for {p} in the plugin settings first",
    retryTries: "Per-file retry limit",
    retryTriesDesc: "How many times a file upload/delete is retried on transient errors such as dropped connections or timeouts (1–6, default 3). Set 1 to disable retries.",
    concurrency: "Upload concurrency",
    concurrencyDesc: "0 = automatic per protocol (WebDAV 6, SFTP/local 4, FTP 1); set 1–16 to override. Lower it for weak servers or slow links.",
    maxFileMB: "Max file size (MB)",
    maxFileMBDesc: "Files larger than this are skipped with an error, so huge files are never loaded into memory (default 64, 0 = no limit).",
    debug: "Verbose debug logging",
    debugDesc: "Log every request/upload to the browser console to diagnose failed uploads; keep it off for daily use.",
    knownHosts: "Known host keys (SFTP)",
    knownHostsDesc: "The SSH fingerprint of a server is remembered on first connect; a changed fingerprint (new server / man-in-the-middle) refuses to connect. Clear it here after moving the server.",
    knownHostsCount: "{n} host key(s) remembered",
    knownHostsNone: "No host keys remembered yet",
    clearHosts: "Clear all",
    clearHostsConfirm: "Forget all known host keys? The fingerprint of each SFTP server will be recorded again on the next connection.",
    clearHostsDone: "Known host keys cleared; they will be recorded again on next connect",
    hostKeySaveFail: "The SFTP host key could not be written to local settings (save failed): the fingerprint will be recorded again on the next connection, so a key change on the server would go unnoticed",
  },
};

/* ---------------- helpers ---------------- */

function conf() {
  return window.siyuan.config;
}

/* 逐请求日志开关：一次 549 文件的发布会产生上千行控制台输出，
 * 默认关掉，设置里勾「调试日志」或在回归里显式打开。 */
let DEBUG = false;
function setDebug(v) { DEBUG = !!v; }
function dbg(...args) { if (DEBUG) console.log(...args); }

/* 单例进度面板：替代刷屏的 toast，右下角显示阶段文字 + 进度条 */
/* 上传进度浮层带一个「取消」按钮：首次全量发布是 550 个文件、几十 MB，
 * 地址填错的时候除了去插件设置里停用插件、没有别的逃生口——那是最坏的补救。
 * 按钮只在调用方 enableCancel 之后出现（试算、批量重发这些不需要），
 * 元素全部用 JS 引用持有（而不是 querySelector 找类名），既省一次 DOM 查询，
 * 也让回归脚本能在 stub 里真的点到它。 */
const Progress = {
  el: null, textEl: null, barEl: null, footEl: null, cancelBtn: null,
  onCancel: null, cancelText: "", cancelTip: "",
  ensure() {
    if (this.el) return;
    const el = document.createElement("div");
    el.style.cssText = [
      "position:fixed", "right:12px", "bottom:64px", "z-index:9999",
      "min-width:240px", "max-width:340px", "padding:10px 14px",
      "border-radius:6px", "box-shadow:0 2px 10px rgba(0,0,0,.25)",
      "background:var(--b3-theme-surface)", "color:var(--b3-theme-on-surface)",
      "font-size:13px", "line-height:1.5", "word-break:break-all",
    ].join(";");
    const text = document.createElement("div");
    text.className = "wdav-prog-text";
    const track = document.createElement("div");
    track.style.cssText = "height:4px;margin-top:8px;border-radius:2px;background:var(--b3-theme-surface-lighter);";
    const bar = document.createElement("div");
    bar.className = "wdav-prog-bar";
    bar.style.cssText = "height:100%;width:0;border-radius:2px;background:var(--b3-theme-primary);transition:width .2s;";
    track.append(bar);
    const foot = document.createElement("div");
    foot.className = "wdav-prog-foot";
    foot.style.cssText = "display:none;margin-top:8px;text-align:right;";
    const btn = document.createElement("button");
    btn.className = "b3-button b3-button--outline";
    btn.style.cssText = "padding:2px 10px;font-size:12px;cursor:pointer;";
    btn.addEventListener("click", () => {
      if (typeof this.onCancel === "function") this.onCancel();
    });
    foot.append(btn);
    el.append(text, track, foot);
    document.body.appendChild(el);
    this.el = el; this.textEl = text; this.barEl = bar; this.footEl = foot; this.cancelBtn = btn;
  },
  show(text, ratio) {
    this.ensure();
    this.textEl.textContent = String(text);
    this.barEl.style.width = ratio == null ? "100%" : `${Math.min(100, Math.round(ratio * 100))}%`;
    /* 底栏的可见性每次都跟着 onCancel 走，不靠创建时那句 inline cssText 兜着：
     * 调用方可以不 enableCancel（试算），也可以 enableCancel(.., null) 收回按钮，
     * 两条路都得保证浮层里不会出现一个死按钮。 */
    this.footEl.style.display = this.onCancel ? "" : "none";
    if (this.onCancel) {
      this.cancelBtn.textContent = this.cancelText;
      /* title 用 enableCancel 传进来的提示，不能退回按钮文字：show() 每次上传都会跑，
       * 拿 cancelText 覆盖就等于把「取消后会怎样」的说明抹掉了。 */
      this.cancelBtn.title = this.cancelTip || this.cancelText;
    }
  },
  /* label/tip 由调用方传（Progress 是模块级单例，拿不到 this.t）；
   * fn 传 null 表示这一段没有可取消的动作，按钮收回。 */
  enableCancel(label, tip, fn) {
    this.ensure();
    this.cancelText = label || "";
    this.cancelTip = tip || this.cancelText;
    this.onCancel = typeof fn === "function" ? fn : null;
    this.footEl.style.display = this.onCancel ? "" : "none";
    if (this.onCancel) {
      this.cancelBtn.textContent = this.cancelText;
      this.cancelBtn.title = this.cancelTip;
      this.cancelBtn.disabled = false;
    }
  },
  /* 取消已按下：按钮变灰变字，避免用户连点，也让他知道请求收到了。
   * 注意这里**不** ensure()：requestCancel() 也可能被快捷键/命令在空闲时触发，
   * 那一刻凭空浮出一个只有按钮的面板比没有反馈更怪。 */
  markCanceling(text) {
    if (!this.el) return;
    if (this.cancelBtn) { this.cancelBtn.textContent = text; this.cancelBtn.disabled = true; }
  },
  hide() {
    if (this.el) { this.el.remove(); this.el = null; }
    this.textEl = this.barEl = this.footEl = this.cancelBtn = null;
    this.onCancel = null;
    this.cancelTip = "";
  },
};

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function bytesToB64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function basicAuth(user, pass) {
  return "Basic " + bytesToB64(utf8Bytes(`${user}:${pass}`));
}

/* 日志与错误文本里的地址必须先去掉凭据。服务器地址允许写成
 * http://user:pass@host/dav（浏览器、curl、WebDAV 客户端都吃这种形式），
 * 插件本身也照样把它拼进 URL。凭据正常只走 Basic 头，可一旦这种写法进了
 * console.warn / 抛错的 message，密码就顺着「历史记录 err 字段 + 结果卡片 +
 * 共享的 DevTools 控制台」漏了出去——思源插件的控制台是所有插件共用的。
 *
 * 匹配的是「scheme:// 与第一个 @ 之间、不含空格与斜杠的那一段」，两处刻意：
 *   · 带 g，整条串里每一处都打——抛错文本常常是「GET "http://u:p@h/": dial tcp…」
 *     这种把 URL 嵌在中间的句子，只处理行首等于没处理；
 *   · 中间不许有 /，所以 http://host/dav/me@you.txt 这种把 @ 写在文件名里的地址
 *     不会被误伤（那里面根本没有 userinfo）。 */
const USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi;
function redactUrl(u) {
  return String(u || "").replace(USERINFO_RE, "$1***@");
}

/* 比较用的形态：把 userinfo 整段摘掉（不是打码）。
 * 与 redactUrl 的分工是「给人看的」和「拿来对齐的」：PROPFIND 的 <d:href> 由服务器
 * 按「源」回写，永远不带 userinfo，而 joinUrl 生成的请求地址带着它——两侧都要归到
 * 同一个键上才比得中（见 normalizeKey）。 */
function stripUserInfo(u) {
  return String(u || "").replace(USERINFO_RE, "$1");
}

/* 给人看、要写进历史记录的地址：凭据只属于「配置项」，不该顺着「查看上传路径」、
 * 成功卡片、角标 title 漏到界面与历史文件里——日志那侧早就 scrub 过了，界面不能是
 * 同一个秘密的另一条出口。认证始终走 Basic 头（见 forward），地址里没有凭据不影响上传。 */
function displayUrl(u) { return stripUserInfo(String(u || "")); }

/* 错误对象进日志/进 toast 的统一文本形态。console 里直接丢一个 Error，运行时会把
 * message 与 stack 整段写进「所有插件共用」的 DevTools 控制台；传输层错误里最常带的
 * 就是那条完整请求地址，所以必须整体过一遍 redactUrl 再打。 */
function errForLog(e) {
  if (!e) return "";
  return redactUrl(String((e && e.stack) || (e && e.message) || e));
}

/* base64 正文实际有多少字节：解码一次即可（atob 出来的串每个字符就是一个字节）。
 * 核对尺寸必须走这里，不能拿「按文本读回来的字符串长度」当字节数——随机字节里的
 * 非法 UTF-8 序列会被替换字符改写，长度直接虚高（nginx 探针实测 8192B → 16220B）。 */
function b64ByteLen(b64) {
  const s = String(b64 || "").replace(/\s+/g, "");
  if (!s) return 0;
  try { return atob(s).length; } catch (e) { /* 非法 base64：退回按公式估算 */ }
  return Math.floor(s.replace(/=+$/, "").length * 3 / 4);
}

function joinUrl(base, ...segs) {
  let url = base.replace(/\/+$/, "");
  for (const s of segs) {
    const part = String(s || "").replace(/^\/+|\/+$/g, "");
    if (!part) continue;
    url += "/" + part.split("/").map(encodeURIComponent).join("/");
  }
  return url;
}

function sanitizeName(name) {
  const cleaned = String(name || "")
    .replace(/[\\/:*?"<>|#%&+]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "untitled";
}

/* ---------------- WebDAV 服务器存不下的文件名 ----------------
 * 文档标题在 sanitizeName 里已经洗过，但导出目录里的 assets/ 文件名是**原样上传**的。
 * IIS WebDAV 背后是 NTFS，实测（172.16.100.132 / IIS 10）：
 *   · `< > : " | ? * \` —— 文件系统非法字符 → PUT 直接 400/404；
 *   · `+`（即使已编码成 %2B）→ 404；
 *   · 结尾的点或空格 → 400（Win32 会把它们剥掉）；
 *   · CON/PRN/AUX/NUL/COM1-9/LPT1-9 是保留设备名 → 存不下；
 *   · `%`、`&`、`#`、`..`（非独立段）、全角括号、emoji、130 个汉字标题都能存（201）。
 * 一篇文档的子树里只要有一个这种附件，整次发布就会以「HTTP 400」的形式失败——
 * 而且失败发生在几百个文件传完之后，用户看到的只有一串 URL。
 * 下面这对函数负责「能不能存」的判定和「改成能存」的映射：替换成同形全角字符，
 * 名字仍然可读、可反推，页面上的引用也能一起改过来（见 rewriteAssetRefs）。
 * 只有确实需要改名时才改；本来就是合法名字的资产一个字节都不动。 */
const HTTP_BAD_MAP = {
  "<": "＜", ">": "＞", ":": "：", "\"": "＂", "|": "｜",
  "?": "？", "*": "＊", "+": "＋", "\\": "＼",
};
const WIN_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/* 返回该段名里“服务器存不下”的字符/问题（去重后的字符串）；合法返回 ""。
 * 判定按整段来（结尾的点、设备名都是整段性质）。 */
function unsafeSegReason(seg) {
  const s = String(seg == null ? "" : seg);
  if (!s) return "∅";
  const bad = [];
  let ctrl = false;
  for (const ch of s) {
    if (HTTP_BAD_MAP[ch]) bad.push(ch);
    else if (ch < "\u0020" || ch === "\u007f") ctrl = true;
  }
  if (ctrl) bad.push("␀");
  if (/[. ]$/.test(s)) bad.push(s.endsWith(".") ? "结尾." : "结尾␣");
  if (/^\.+$/.test(s)) bad.push("..");
  else if (WIN_DEVICE_RE.test(s)) bad.push(s.slice(0, 4));
  return [...new Set(bad)].join(" ");
}

/* 把一个段名改成服务器上存得下的样子：全角同形字替换、结尾点/空格换成 -。 */
function safeHttpName(seg) {
  let s = String(seg == null ? "" : seg).replace(/[\u0000-\u001f\u007f]/g, "-");
  s = s.replace(/[<>:"|?*+\\]/g, (c) => HTTP_BAD_MAP[c]);
  s = s.replace(/[. ]+$/, "-");
  if (/^\.+$/.test(s) || !s) s = "-" + s.replace(/[.]/g, "-");
  if (WIN_DEVICE_RE.test(s)) s = "_" + s;
  return s || "unnamed";
}

/* 整条相对路径逐段安全化；合法路径原样返回（不做任何改动）。 */
function safeHttpRel(rel) {
  return String(rel == null ? "" : rel)
    .split("/")
    .map((seg) => (unsafeSegReason(seg) ? safeHttpName(seg) : seg))
    .join("/");
}

/* 给定导出目录里的全部 rel 路径，算出「哪些存不下」以及「换成什么名」。
 * 单独成函数是为了能在回归里直接断言（含改名后的引用改写），不必真发一次布。
 * 碰撞保护：两个不同原名可能洗成同一个安全名（a+b.png 与 a＋b.png），也可能
 * 直接撞上另一个本来就合法的同名文件——这时在扩展名前追加 -2/-3，
 * 宁可名字难看一点，也不能让两个文件覆盖成同一个。
 * 返回 { unsafe: [{rel, why}], renames: Map<原 rel, 新 rel> }。 */
function planSafeRenames(rels) {
  const list = [...new Set(rels || [])].sort();
  const taken = new Set(list);
  const unsafe = [];
  for (const rel of list) {
    const why = rel.split("/").map(unsafeSegReason).find((x) => x);
    if (why) unsafe.push({ rel, why });
  }
  const renames = new Map();
  const used = new Set();
  for (const u of unsafe) {
    let to = safeHttpRel(u.rel);
    if (to !== u.rel && (taken.has(to) || used.has(to))) {
      const dot = to.lastIndexOf(".");
      const slash = to.lastIndexOf("/");
      // 只有点落在最后一段里才算扩展名（assets/x.png 算；目录段里的点不算）
      const extAt = dot > slash ? dot : to.length;
      let n = 2;
      while (taken.has(to) || used.has(to)) to = `${to.slice(0, extAt)}-${n++}${to.slice(extAt)}`;
    }
    used.add(to);
    if (to !== u.rel) renames.set(u.rel, to);
  }
  return { unsafe, renames };
}

/* 属性值里出现的原始路径可能有两种写法：原样、HTML 转义后（& < > " 会被内核转义）。
 * 两种都换成新名字；url(...) 这种不带引号的写法也一并覆盖。 */
function htmlAttrEsc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ---- 发布页里「我们插进去的字符串」的三种上下文 ----
 * 正文 content 来自内核导出，本就该按原样落地（它是 HTML，转义反而破坏版面）；
 * 需要管的只有另外两类：标题文本，以及从配置里读出来、拼进模板的几个短字符串。
 * 它们看着人畜无害，实际全是可控输入——文档标题是用户随手敲的，主题/图标目录名
 * 来自下载的花瓣，plantUML 地址是设置项。一行 `</title><script>` 的标题就能在
 * 每个访问发布页的人的浏览器里执行代码，所以这三个函数是发布链路的地板，不是装饰。
 *
 * 与官方导出的有意差异：官方模板原样插入这些值，我们按上下文转义。差别只在
 * 「值里真的含特殊字符」时才显现，正常标题（不含 < > &）逐字节不变；
 * 安全性换一点点的字节一致，这笔账值得。见 src/vendored/index-html.js 顶部约定。
 */
/* HTML 文本上下文（<title>…</title>）：& < > 三个足够。 */
function htmlTextEsc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
/* JS 字符串字面量（写在 <script> 里、双引号包裹）：
 * 先转反斜杠再转引号，顺序反了会把 \" 二次转义成 \\"。
 * 行分隔符 U+2028/2029 在 JS 里是换行（字符串字面量内非法），HTML 里却是普通字符，
 * 必须显式转义。`</` 写成 `<\/`：JS 里 \/ 就等于 /，但 HTML 解析器再也读不到
 * </script 这个提前闭合序列——脚本内嵌字符串的经典出口。 */
function jsStrEsc(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\").replace(/"/g, "\\\"")
    .replace(/\r/g, "\\r").replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
    .replace(/<\//g, "<\\/");
}

/* 数字/布尔型插值：官方模板把 editor.fontSize、codeLigatures、codeSyntaxHighlightLineNum
 * 与三处 font-weight 原样拼进 <style> 和内联 <script>，可这些值并不保证是数字——
 * weight 跟着下载来的自定义字体走（/api/system/getCustomFonts 的返回值直接进模板），
 * fontSize 来自 conf.json（手改、旧版本写坏、别的软件同步都可能留下字符串）。
 * 于是 "400;}*{x:y}</style><script>window.__pwned=1</script><style>" 这样的 weight
 * 能闭合 <style> 并在每个读这个页面的人的浏览器里执行；拼进 <script> 的那几处同理。
 * 只收有限数字，认不出来就回默认值；布尔位只允许出 true/false 两个字面量。
 * 正常输入恒等（16 → 16、400 → 400、15.5 → 15.5、false → false），与官方导出的字节一致。 */
function numVal(v, def, lo, hi) {
  if (typeof v !== "number" && typeof v !== "string") return def;
  if (v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}
function rewriteAssetRefs(text, pairs) {
  let out = String(text || "");
  for (const p of pairs || []) {
    const to = String(p && p.to || "");
    if (!p || !p.from || p.from === to) continue;
    /* 同一次改名要按两种写法各替换一遍：
     *   · HTML 页面里的引用是字面量（src="assets/名 字.png"）；
     *   · Markdown 正文里的空格是转义过的——实测内核导出把「名 字.png」写成
     *     「名%20字.png」，而 : + # % ( ) 都保持字面量。
     * 只按字面量替换的话，带空格又要改名的资产在 .md 里会指向一个不存在的文件；
     * 两边各用各的写法替换，换完仍然是合法链接（目标里的空格继续写着 %20）。 */
    const variants = [];
    for (const [f, t] of [[String(p.from), to],
      [String(p.from).replace(/ /g, "%20"), to.replace(/ /g, "%20")]]) {
      if (variants.some((v) => v[0] === f)) continue;
      variants.push([f, t]);
    }
    for (const [f, t] of variants) {
      for (const from of [...new Set([f, htmlAttrEsc(f)])]) {
        out = out.split('"' + from + '"').join('"' + t + '"');
        out = out.split("'" + from + "'").join("'" + t + "'");
        out = out.split("(" + from + ")").join("(" + t + ")");
      }
    }
  }
  return out;
}

/* ---------------- 远端路径安全 ----------------
 * 远端目录段只由「标题」决定，因此两篇同名文档会落进同一个目录；而目录名又是
 * 用户可控的 prefix 拼出来的。这里统一做三件事：
 *   1) 拒绝 . / .. 段——否则本地协议的 deleteTree（fs.rm recursive）会删到基础目录外面；
 *   2) 按 UTF-8 字节截断——内核给的标题上限 100 字符，全中文约 300 字节，
 *      超过 ext4 之类文件系统单段 255 字节时 mkdir 直接失败且原因完全看不出来；
 *   3) 保留码点边界，末尾补 "-" 让“被截断过”在名字上可见，也避免两个长标题截成同名。 */
function clampSeg(str, max) {
  const s = String(str || "");
  if (utf8Bytes(s).length <= max) return s;
  let out = "";
  let n = 0;
  for (const ch of s) {            // for..of 按码点迭代，不会切出半个字符
    const b = utf8Bytes(ch).length;
    if (n + b >= max) break;       // 预留至少 1 字节给结尾的 "-"
    out += ch;
    n += b;
  }
  return out + "-";
}

/* 合法返回处理好的段；空段返回 ""（跳过）；含 . / .. 返回 null（调用方拒绝） */
function safeSeg(v, max) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  if (s === "." || s === ".." || s.split("/").some((x) => x === "." || x === "..")) return null;
  return clampSeg(s, max || 120);
}

/* 前缀（子目录）逐级安全化：拒绝 . / ..，空段跳过 */
function prefixSegsOf(prefix) {
  const out = [];
  for (const raw of String(prefix || "").split("/")) {
    const seg = safeSeg(raw, 120);
    if (seg === null) throw new Error(`「子目录（前缀）」不能包含 . 或 .. 段：${raw.trim()}`);
    if (seg) out.push(seg);
  }
  return out;
}

/* <prefix 逐级>/<文档目录名>：任何一段非法就抛错，别把 .. 带进任何协议的路径拼接 */
function rootSegsOf(prefix, docName) {
  const out = prefixSegsOf(prefix);
  const dn = safeSeg(docName, 120);
  if (dn === null) throw new Error(`文档目录名不合法：${docName}`);
  out.push(dn || "untitled");
  return out;
}

/* 归属标记：目录里留一个只含本文 ID 的文件，用来判断“这个目录是谁的”。
 * 用文件名而不是文件内容承载身份，四种协议都能靠一次浅列举拿到，无需读远端正文。
 * 名字**不带前导点**：vsftpd 默认 hide_dotfiles=yes，点开头的标记在 FTP LIST/MLSD 里
 * 根本列不出来，同名冲突检测会在 FTP 上静默失效；非点文件在四种协议（PROPFIND /
 * LIST / SFTP readdir / fs.readdir）里都能稳定枚举。识别也只认这一个形态——
 * 匹配得更宽只会把别人的文件误认成簿记文件，既不清理也不告警。 */
const OWNER_PREFIX = "netglimmer-owner-";
const OWNER_RE = /^netglimmer-owner-([0-9a-zA-Z]{1,20})\.json$/;
function ownerName(docId) {
  const tail = String(docId || "").split("-").pop() || String(docId || "");
  const safe = tail.replace(/[^0-9a-zA-Z]/g, "").slice(0, 12) || "unknown";
  return `${OWNER_PREFIX}${safe}.json`;
}
/* 发布成功的浮层卡片。为什么不用 showMessage：思源前端 API 里它的第四个参数是
 * toast 的 id（siyuan 包类型定义 showMessage(text, timeout, type, id)），不是按钮，
 * 所以「点一下就把链接复制了/打开了」这种事只能自己搭一层。
 * 卡片里放摘要 + 打开 / 复制 / 看板 三个动作，鼠标悬停时不自动收（可能要慢慢点）。
 * 位置比 Progress 高一档：刚发布完时进度面板正好在同一个角落淡出。 */
const ResultCard = {
  el: null, timer: null,
  close() {
    if (this.el) { try { this.el.remove(); } catch (e) { /* noop */ } this.el = null; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  },
  show(o) {
    this.close();
    const el = document.createElement("div");
    el.className = "netglimmer-result-card";
    el.style.cssText = "position:fixed;right:12px;bottom:118px;z-index:9998;"
      + "min-width:260px;max-width:400px;padding:10px 12px;border-radius:6px;"
      + "box-shadow:0 2px 10px rgba(0,0,0,.28);background:var(--b3-theme-surface);"
      + "color:var(--b3-theme-on-surface);font-size:13px;line-height:1.5;word-break:break-all;";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:flex-start;gap:8px;";
    const title = document.createElement("div");
    /* 标题颜色跟着结论走：失败卡片顶着一行绿字是误导（曾经两种都写死 success）。
     * tone 缺省按成功算——调用方新加的卡片不会因为漏传参数变成红的。 */
    title.style.cssText = "font-weight:600;flex:1 1 auto;color:var(--b3-theme-"
      + (o.tone === "fail" ? "error" : "success") + ");";
    title.textContent = o.title;
    const x = document.createElement("button");
    x.className = "b3-button b3-button--outline";
    x.style.cssText = "padding:0 7px;font-size:12px;line-height:18px;cursor:pointer;";
    x.textContent = "✕";
    x.title = o.closeText;
    x.addEventListener("click", () => this.close());
    head.append(title, x);
    const body = document.createElement("div");
    body.textContent = o.body || "";
    /* 地址行按需创建：没有地址（本地发布失败、试算）就不该造一个空白链接节点，
     * 挂上去是一行可点的全选空白，看着像坏了的链接。 */
    let link = null;
    if (o.url) {
      link = document.createElement("div");
      link.textContent = o.url;
      link.style.cssText = "margin-top:4px;color:var(--b3-theme-primary);font-size:12px;user-select:all;";
    }
    const row = document.createElement("div");
    row.style.cssText = "margin-top:8px;text-align:right;";
    const mk = (a) => {
      const btn = document.createElement("button");
      btn.className = "b3-button b3-button--outline";
      btn.style.cssText = "padding:2px 10px;margin-left:6px;font-size:12px;cursor:pointer;";
      btn.textContent = a.text;
      if (a.title) btn.title = a.title;
      btn.addEventListener("click", () => {
        try { const r = a.onClick && a.onClick(); if (r && typeof r.then === "function") r.then(() => {}); }
        catch (e) { /* 单个按钮失败不影响其它入口 */ }
      });
      return btn;
    };
    for (const a of o.actions || []) row.append(mk(a));
    el.append(head, body);
    if (o.url) el.append(link);
    el.append(row);
    document.body.appendChild(el);
    this.el = el;
    el.addEventListener("mouseenter", () => {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    });
    el.addEventListener("mouseleave", () => {
      if (!this.timer) this.timer = setTimeout(() => this.close(), 3000);
    });
    if (o.ttl) this.timer = setTimeout(() => this.close(), o.ttl);
  },
};

/* 整数设置项夹到合法区间；空值/非数字回落到默认值 */
function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/* ---------- 看板列宽（可拖动 + 记忆） ---------- */

/* 七列的默认宽与可拖范围，顺序与表头一致。
 * 口径不是「看着顺眼」而是**量出来的**：默认宽合计 928px
 * （156+176+74+82+130+94+216），必须小于最小的真实弹窗内容宽（1200px 视口下看板网格
 * 实测 998px），否则最后一列「操作」会被弹窗右缘裁掉、并凭空多出一条横向滚动条——
 * 现场截图撞过的就是这一条：详情列给了 360px，可那一列实际只有「N 文件 · 大小」加一个
 * 「查看上传路径」，那 360px 是为两个根本不存在的按钮留的。
 * 结果列 110px 那条教训仍然有效（60px 时「已取消发布」被内边距顶成两行），所以它的
 * 默认值只降到 90 且 min 仍是 80。
 * 但这一表的 min/def 再准也只是**照着一种语言**量的：`nowrap: true` 的那四列（时间 /
 * 协议 / 结果 / 操作）内容不许折行，渲染时 dashColNeeds 会量出"这一列排成一行到底要多宽"
 * 并把 min 抬到那个数——英文字典下结果列因此从 80 抬到 175、操作列从 200 抬到 294，
 * 中文下几乎不动（时间列实测 155px，常数地板原本给的是 154：差的那 1px 正是用户截图里
 * 「2025-10-09 17:…」那道省略号，现在把常数钉成 156，量不到时也不再塌）。
 * 会折行的列（文档 / 详情 / 改动）不抬：它们放不下就该换行，而不是把表撑宽。 */
const DASH_COLS = [
  { key: "time", def: 156, min: 156, max: 320, nowrap: true },
  { key: "doc", def: 176, min: 110, max: 640 },
  { key: "proto", def: 74, min: 73, max: 160, nowrap: true },
  { key: "status", def: 82, min: 80, max: 240, nowrap: true },
  { key: "detail", def: 130, min: 120, max: 1400 },
  { key: "changed", def: 94, min: 90, max: 280 },
  { key: "action", def: 216, min: 200, max: 460, nowrap: true },
];
const DASH_COLS_KEY = "netglimmer-dash-cols";
const DASH_FLEX_COL = 4;   // 唯一会吃掉剩余空间的那列

/* 看板排序：只有这五列有比得出来的口径（详情是错误原文、操作是按钮，排序没意义）。 */
const DASH_SORT_KEYS = ["time", "doc", "proto", "status", "changed"];
const DASH_VIEW_KEY = "netglimmer-dash-view";
/* 看板翻页：每页条数是「习惯」而不是临时意图，所以和排序一样记在 localStorage 里。
 * 0 ＝ 全部（不分页），给记录不多、或者就是想把一屏看全的人留一条路。 */
const DASH_PAGE_SIZES = [10, 20, 50, 100, 0];
const DASH_PAGE_SIZE_DEFAULT = 20;
const DASH_PAGE_KEY = "netglimmer-dash-page";

/* 只认档位表里的数：没存过（null / 空串）、存坏了一律退回默认。
 * 这里必须先挡住 null——Number(null) 是 0，而 0 恰好是「全部」那一档，
 * 顺手 Number 一下会把「这台浏览器还没选过」读成「每页无限条」。
 * 纯空白同理：Number(" ") 也是 0，所以先 trim，空串按没存过处理。 */
function parseDashPageSize(raw) {
  if (raw === null || raw === undefined) return DASH_PAGE_SIZE_DEFAULT;
  const s = String(raw).trim();
  if (!s) return DASH_PAGE_SIZE_DEFAULT;
  const n = Number(s);
  return Number.isFinite(n) && DASH_PAGE_SIZES.indexOf(n) >= 0 ? n : DASH_PAGE_SIZE_DEFAULT;
}

function dashPageCount(total, size) {
  if (!size || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / size));
}

/* 从「已筛选已排序」的清单里切出这一页。页码越界一律夹回来（删到最后一条、
 * 或者换了筛选条件之后停在第 7 页，都不该是空白一屏）；size=0 时整份原样返回。 */
function dashPageSlice(items, page, size) {
  const list = items || [];
  const pages = dashPageCount(list.length, size);
  const p = Math.min(Math.max(1, Number(page) || 1), pages);
  if (!size) {
    return { rows: list, page: 1, pages: 1, from: list.length ? 1 : 0, to: list.length };
  }
  const start = (p - 1) * size;
  const rows = list.slice(start, start + size);
  return { rows, page: p, pages, from: rows.length ? start + 1 : 0, to: start + rows.length };
}
/* 「结果」列的次序按来找问题的人的直觉排：已删除（线上还挂着孤儿目录）→ 失败 →
 * 已取消发布 → 成功。用字符串比 would 把 deleted 排到 fail 后面（字母序）。 */
const DASH_STATUS_ORDER = { deleted: 0, fail: 1, unpub: 2, ok: 3 };
const DASH_CHANGED_ORDER = { yes: 0, unknown: 1, no: 2 };

/* 把一个行项目折成「可比较的单个值」；dir 交给调用方乘。纯函数，回归可直接断言。 */
function dashSortValue(it, key) {
  const rec = (it && it.rec) || {};
  switch (key) {
    case "doc": return String(rec.docName || rec.docId || "").toLowerCase();
    case "proto": return String(rec.protocol || "webdav");
    case "status": {
      const n = DASH_STATUS_ORDER[it.status];
      return n == null ? 9 : n;
    }
    case "changed": {
      const n = DASH_CHANGED_ORDER[it.changed === true ? "yes" : (it.changed === false ? "no" : "unknown")];
      return n == null ? 9 : n;
    }
    case "time":
    default: return Number(rec.time) || 0;
  }
}

/* dir：1 升序 / -1 降序；相等时一律按时间倒序收口，保证同一排序键下的顺序稳定可预期。 */
function dashCompare(a, b, sort) {
  const dir = Number(sort && sort.dir) === 1 ? 1 : -1;
  const key = (sort && DASH_SORT_KEYS.indexOf(sort.key) >= 0) ? sort.key : "time";
  const va = dashSortValue(a, key);
  const vb = dashSortValue(b, key);
  if (va < vb) return -dir;
  if (va > vb) return dir;
  return (Number(b.rec && b.rec.time) || 0) - (Number(a.rec && a.rec.time) || 0);
}

/* ── 看板删除记录的两个口径（纯函数，回归可不渲染就断言到） ──────────────
 * rowKeyOf：一行在 UI 里的身份。前三段就是 addHistory 的去重键
 *   （docId|协议|是否含子文档），第四段 time 是把「同一条记录」钉死的必需项——
 *   勾选状态要跨过整表重绘活下来，靠的正是这个键，所以字段取值必须与
 *   statusOf/addHistory 完全一致（协议缺省按 webdav 计）。 */
function rowKeyOf(rec) {
  const r = rec || {};
  return [String(r.docId || ""), String(r.protocol || "webdav"),
    r.merge ? 1 : 0, String(Number(r.time) || 0)].join("|");
}

/* isLiveRec：这篇文档「线上还挂着」吗？删掉这种记录等于把唯一能收拾远端目录的
 * 线索扔掉（看板再也找不到 docId→目录的对应，删除远端文件/按原协议重发都无从点起），
 * 所以勾选与删除一律先挡住它，除非先「删除远端文件」。
 * 判定只看 pub：每次发布（成功与失败）都会写下这个布尔标记，失败记录只有在
 * 「本次没把上一次那个远端根目录整树删过」时才继承此前成功的 pub=true（继承守卫与
 * 理由见 addHistory / oldRootDestroyed）——旧内容被本次清掉之后，那一行就不算活着了，
 * 由 canUnpubRec 给它的「删除远端文件」按钮负责收尾。unpub 是终态，不在保护范围。 */
function isLiveRec(rec) {
  if (!rec || rec.unpub) return false;
  return !!rec.pub;
}

/* 历史清单的封顶裁剪（纯函数，addHistory 每写一条都过它）。
 * 「300 条」只是别让它无限涨，不该顺手剪掉远端目录的线索：记录按
 * 文档+协议+是否含子文档 去重，一条 pub 行就是那一篇在那份远端上唯一的定位信息
 * （rootSegs 只存在记录里，展示地址反推不可靠）。所以裁剪分两层：
 *   ① 够得到软上限就只丢最旧的非活行（失败行、已下线行）；
 *   ② 全是活行时允许暂时越过软上限，直到硬上限才回头丢最旧的活行——
 *      即「宁可清单长一点，也不留下线上有页面、看板查无此条的死角」。
 * 清单按新→旧排，所以「最旧」就是数组尾部。 */
const HISTORY_SOFT_CAP = 300;
const HISTORY_HARD_CAP = 1000;

function trimHistory(list, soft = HISTORY_SOFT_CAP, hard = HISTORY_HARD_CAP) {
  const arr = Array.isArray(list) ? list.slice() : [];
  let over = arr.length - soft;
  if (over <= 0) return arr;
  const drop = new Set();
  for (let i = arr.length - 1; i >= 0 && over > 0; i--) {
    if (isLiveRec(arr[i])) continue;   // 活行先不动（isLiveRec(null) 为假，空位一并可丢）
    drop.add(i); over--;
  }
  // 还超着就继续丢最旧的活行，但只在硬上限之上才动手
  if (arr.length - drop.size > hard) {
    let still = arr.length - drop.size - hard;
    for (let i = arr.length - 1; i >= 0 && still > 0; i--) {
      if (drop.has(i)) continue;
      drop.add(i); still--;
    }
  }
  return arr.filter((_, i) => !drop.has(i));
}

/* 「这一行能不能按记录里的分段去删远端目录」（纯函数，看板与回归共用一个口径）。
 * 两个条件缺一不可：拿得到 rootSegs（删除只认发布时存下的分段，不从展示地址反推），
 * 并且这行仍然代表线上的一份内容——成功行当然算；半途失败的行（partial）更要算，
 * 服务器上留的是半棵目录，除了「删除远端文件」没有别的入口能收拾它。
 * 为什么现在必须放宽：失败行不再盲目继承上一次成功的「线上还挂着」（见 addHistory
 * 的继承守卫），那种行过去靠 pub=true 挡住删除，如今可能 pub=false 成了可删行——
 * 若再不给清理按钮，用户删掉记录就等于把半棵远端目录永久遗留在服务器上。
 * unpub 是终态：已经下线过的行不需要再删一次。 */
function canUnpubRec(rec) {
  if (!rec || rec.unpub || !rec.docId) return false;
  if (!Array.isArray(rec.rootSegs) || !rec.rootSegs.length) return false;
  return !!(rec.ok || rec.partial);
}

/* 取消后的提示该说哪一句（纯函数，回归可以不跑一次真发布就把三种口径都断言到）：
 *   没动过远端      → 一句「已取消」，服务器原样；
 *   动了一半        → 明确残缺 + 给补救路径（重发补齐 / 取消发布清空）；
 *   index.html 传完了 → 线上其实是完整页面，只是没做读回校验，这时候再喊
 *     「远端不完整」就是把人支去删一套好端端的文件。
 * 返回 i18n 键 + toast 类型 + 停留毫秒。 */
function cancelToast(partial, remoteAllUp) {
  if (!partial) return { key: "publishCanceled", type: "info", ttl: 6000 };
  if (remoteAllUp) return { key: "publishCanceledComplete", type: "info", ttl: 9000 };
  return { key: "publishCanceledPartial", type: "warn", ttl: 10000 };
}

/* ── 设置页的格式提示（只提示，不拦保存） ────────────────────────────────
 * 为什么不硬校验：思源常挂在子路径反向代理后面（https://blog.example.com/dav），
 * 内网也常用不带点的主机名（nas），本地目录还可能是 Windows 盘符外的挂载点。
 * 拦下来只会把人关在门外，而这些形状错基本上都会在「测试连接」那步以真实错误现形。
 * 空值一律放过：还没填完，红字只会碍眼。 */
function serverFormatRule(proto) {
  if (proto === "ftp" || proto === "sftp") {
    // 这两个协议插件里存的就是 host[:port]，带 scheme 反而连不上。
    // 放行 IPv6：[::1]、[::1]:2121、以及裸写（::1、2001:db8::1）三种形状。
    // 裸写法能连（整串按主机名解析），只是无法从里面读端口——端口的提示由 fieldHintFor("port") 负责。
    return {
      re: /^(?:\[[0-9a-f:.%]+\](?::\d{1,5})?|(?:[0-9a-f]{1,4})?(?::[0-9a-f]*){2,}(?:%[0-9a-z]+)?|[^\s:/\\]+(?::\d{1,5})?)$/i,
      ex: proto === "ftp" ? "192.168.1.10 或 [::1]:21" : "192.168.1.10 或 [::1]:22",
    };
  }
  if (proto === "local") {
    return {
      re: /^(\/[^\s]*|[A-Za-z]:[\\/][^\s]*|\\\\[^\s]*)$/,
      ex: "/var/www/html 或 D:\\www\\upload",
    };
  }
  /* WebDAV：只要求「有 scheme、整串没有空白」，路径随便写。
   * 曾经写成 /^https?:\/\/[^\s/]*$/（不许带 /），结果示例串自己就不过自己的规则——
   * 思源挂在子路径反代后面（https://blog.example.com/dav）是完全合法的配置，
   * 把人家标红是纯粹的误报。真正的错法是漏 scheme 和手滑带空格。 */
  return { re: /^https?:\/\/[^\s]+$/i, ex: "https://example.com/dav" };
}

function serverFormatOk(proto, raw) {
  const v = String(raw || "").trim();
  if (!v) return true;
  if (!serverFormatRule(proto).re.test(v)) return false;
  /* 本地路径再多一道：含 . / .. 段就判格式错。发布与「取消发布」在本地协议里是
   * fs.rm(recursive)，这类写法会被解析到别处——open() 用的 localBaseOf 拒绝的是同一件事，
   * 设置页此刻标红，好过让用户在发布失败时才看到。两处规则必须一致。 */
  if (proto === "local" && v.split(/[/\\]+/).some((x) => x === "." || x === "..")) return false;
  return true;
}

/* 一条提示的「算文案」部分：kind = username / server / prefix / port。
 * 纯函数（t 由调用方注入），回归可以不碰 DOM 直接断言。warn=true 用警示色。
 * ctx 是可选的第 5 个参数（{ addr, port }）：有了端口框之后，「地址该长什么样」和
 * 「端口填得对不对」互为上下文——地址里写了端口，端口框空着就该说清用的是哪一个。
 * 不传 ctx 时少掉的就是这几条联动说明，其余文案不变。 */
function fieldHintFor(kind, proto, value, t, ctx) {
  const p = proto || "webdav";
  const c = ctx || {};
  const isFs = p === "ftp" || p === "sftp";
  if (kind === "username") {
    return { text: t("usernameDesc").replace("{p}", p.toUpperCase()), warn: false };
  }
  if (kind === "prefix") {
    return String(value || "").trim()
      ? { text: "", warn: false }
      : { text: t("prefixEmptyWarn"), warn: true };
  }
  if (kind === "port") {
    if (!isFs) return { text: "", warn: false };
    const raw = String(value == null ? "" : value).trim();
    if (normPort(raw) === "bad") {
      return { text: t("portBad").replace("{v}", raw), warn: true };
    }
    const hp = hostPortOf(c.addr != null ? c.addr : "", raw, p);
    if (hp.conflict) {
      return {
        text: t("portConflict")
          .replace("{a}", String(hp.addrPort))
          .replace("{f}", String(hp.fieldPort))
          .replace("{n}", String(hp.port)),
        warn: true,
      };
    }
    if (hp.ambiguous) return { text: t("portIpv6Ambiguous"), warn: false };
    if (!raw) return { text: t("portDefaultNote").replace("{n}", String(DEFAULT_PORTS[p])), warn: false };
    return { text: t("portUsing").replace("{n}", String(hp.port)), warn: false };
  }
  if (kind === "server") {
    const v = String(value || "").trim();
    if (!v || !serverFormatOk(p, v)) {
      if (!v) return { text: "", warn: false };
      return {
        text: t("serverBadHint")
          .replace("{p}", p.toUpperCase())
          .replace("{e}", serverFormatRule(p).ex)
          .replace("{v}", v),
        warn: true,
      };
    }
    /* 地址形状合法之后，再补两句和端口有关的实话（都是灰字，不拦保存）：
     * 裸 IPv6 读不出端口 / 地址里写了端口而端口框空着。 */
    if (isFs) {
      const ap = readAddrHostPort(v);
      const field = normPort(c.port);
      if (ap.ambiguous) return { text: t("portIpv6Ambiguous"), warn: false };
      if (ap.port && !field) {
        return { text: t("portFromAddr").replace("{a}", ap.port).replace("{n}", String(DEFAULT_PORTS[p])), warn: false };
      }
    }
    return { text: "", warn: false };
  }
  return { text: "", warn: false };
}

/* 存储内容一律不可信：非 JSON、长度不对、非数字、超范围——逐列退回默认值，
 * 而不是整体作废（读者拖坏一列不该让另外六列的记忆也丢掉）。 */
function parseDashColWidths(raw) {
  const out = DASH_COLS.map((c) => c.def);
  let a = null;
  try { a = typeof raw === "string" && raw ? JSON.parse(raw) : null; } catch (e) { a = null; }
  if (!Array.isArray(a)) return out;
  return DASH_COLS.map((c, i) => clampInt(a[i], c.min, c.max, c.def));
}

/* 网格模板：详情列写成 minmax(存储值, 1fr)——窗口宽就跟着变宽（错误原文值得更多空间），
 * 但永远不小于读者设的那个数；其余列固定，拖动所见即所得。
 * 为什么不是 minmax(auto, Wpx)：试过，实测不成立。CSS 的「maximize tracks」只在还有
 * 剩余空间时才把列撑到 Wpx——窄窗口里剩余空间是负的，于是每一列都退回自己的 min-content：
 * 800px 视口下「文档」列被压到 33px（一个字一竖排），min 里写的 110 形同不存在。
 * 「内容太宽就不许裁」这件事改由下面 dashColNeeds 在渲染时量出来、当地板交给 fitDashWidths。 */
function dashColTemplate(widths) {
  return widths.map((w, i) => (i === DASH_FLEX_COL ? `minmax(${w}px,1fr)` : `${w}px`)).join(" ");
}

/* 一次看板渲染里最多量几行的内容宽。列宽地板要的是"这一列最宽的内容"，
 * 而 500 条记录全量一遍就是三千多次 Range 测量；可见区只有十几行，
 * 量前 60 行既盖住滚得回去的那部分，也把这一步的成本钉成常数。 */
const DASH_MEASURE_ROWS = 60;

/* 量「每一列排成一行要多宽」，作为那一列真正的地板。
 * 为什么必须有这一步：DASH_COLS 的 min 是**照着一种语言**量出来的常数，而看板里
 * 到处是字典文案——地板若只按中文配平（结果列 80、操作列 200），换英文字典就露底了：「Remote files deleted」那枚徽标要 175px，四个按钮
 * （Re-upload / Dry run / Delete remote files / Delete record）要 294px，
 * 于是结果列被截成「Remote files de…」、操作列挤成三行。连中文自己都差 1px
 * （时间戳要 155，地板给了 154）。
 * 只量 nowrap 那些列（cols[i].nowrap）：会折行的列（文档、详情、改动）Range 量到的是
 * "已经折完之后最宽的那一行"，它只会随当前列宽往上贴，拿它当地板等于把列宽锁死在现值。
 * 量不出来（宿主没有 Range、node 桩件、格子还没进文档）时返回全 0，地板退回 DASH_COLS.min——
 * 少一次测量只会让列窄一点，不会让看板打不开。 */
function dashColNeeds(grid, cols) {
  const c = cols || DASH_COLS;
  const need = c.map(() => 0);
  try {
    if (!grid || typeof document.createRange !== "function") return need;
    const kids = grid.children || [];
    const cells = [];
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      if (!el.classList || el.classList.contains("vd-dash-th") || el.classList.contains("vd-dash-path")) continue;
      cells.push(el);
    }
    const n = c.length;
    const rows = Math.min(Math.ceil(cells.length / n), DASH_MEASURE_ROWS);
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < n; i++) {
        if (!c[i].nowrap) continue;
        const el = cells[r * n + i];
        if (!el) continue;
        const rg = document.createRange();
        rg.selectNodeContents(el);
        const cs = (typeof getComputedStyle === "function" && getComputedStyle(el)) || {};
        /* Range 只框到最后一个子节点的**盒子**，它右边的 margin 不在里面。操作列那种
         * 「按钮 按钮 按钮」的格子，最后一个按钮的 3px 右边距就这么丢了——实测正好差出
         * 2px，把最后一个按钮挤成省略号。只在它真是末尾节点时补：时间列的勾选框后面还跟着
         * 文字，那 8px 已经算在文字的落点里，再补就是重复计一次。 */
        let extra = 0;
        const last = el.lastElementChild;
        if (last && !last.nextSibling && typeof getComputedStyle === "function") {
          extra = parseFloat(getComputedStyle(last).marginRight) || 0;
        }
        const w = rg.getBoundingClientRect().width + extra
          + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        if (w > need[i]) need[i] = Math.ceil(w);
      }
    }
    /* 表头也要量一次。列名是静态文案，但它是这一列里唯一"排不下就压到邻列去"的东西：
     * th 只有 white-space:nowrap、没有 overflow:hidden，英文字排不下不会变省略号，而是
     * 直接盖到隔壁那一列的表头上（实测英文「Protocol」在 73px 的协议列上越过右内边距 9px，
     * 压住「Result」）。全选主框也长在时间表头里，它加出来的那十几像素同理得算。
     * 量法与格子不一样：列宽把手是**故意** position:absolute; right:-4px 压在两列边界上的
     * （不压边界就抓不住），把它算进来等于每列地板抬成"当前列宽 + 4"、越量越宽，
     * 所以只认非绝对定位的子节点和文字本身。 */
    const ths = [];
    for (let i = 0; i < kids.length && ths.length < n; i++) {
      const el = kids[i];
      if (el.classList && el.classList.contains("vd-dash-th")) ths.push(el);
    }
    for (let i = 0; i < ths.length && i < n; i++) {
      if (!c[i].nowrap) continue;
      const th = ths[i];
      const cs = (typeof getComputedStyle === "function" && getComputedStyle(th)) || {};
      let left = Infinity;
      let right = -Infinity;
      for (let k = 0; k < th.childNodes.length; k++) {
        const nd = th.childNodes[k];
        if (nd.nodeType === 3) {
          if (!nd.textContent || !nd.textContent.trim()) continue;
          const rg = document.createRange();
          rg.selectNodeContents(nd);
          const rc = rg.getBoundingClientRect();
          if (rc.width <= 0) continue;
          left = Math.min(left, rc.left); right = Math.max(right, rc.right);
        } else if (nd.nodeType === 1) {
          const st = (typeof getComputedStyle === "function" && getComputedStyle(nd)) || {};
          if (st.position === "absolute" || st.position === "fixed") continue;
          const rc = nd.getBoundingClientRect();
          if (rc.width <= 0) continue;
          left = Math.min(left, rc.left); right = Math.max(right, rc.right);
        }
      }
      if (left === Infinity) continue;
      const w = right - left + (parseFloat(cs.paddingLeft) || 0)
        + (parseFloat(cs.paddingRight) || 0);
      if (w > need[i]) need[i] = Math.ceil(w);
    }
  } catch (e) { /* 量不到就当没有：地板退回 DASH_COLS 里那个按语言量的常数 */ }
  return need;
}

/* 把 DASH_COLS 换成「地板已被实测内容抬起」的那一份：min 取 max(常数, 量到的需求)。 */
function dashFitCols(cols, needs) {
  const c = cols || DASH_COLS;
  return c.map((col, i) => ({
    key: col.key, def: col.def, max: col.max, nowrap: col.nowrap,
    min: Math.max(col.min, (needs && needs[i]) || 0),
  }));
}

/* 把「读者要的宽度」折成「弹窗放得下的宽度」。
 * 为什么必须有这一步：minmax(a,1fr) 里的 a 是**地板**，不是天花板——七列的地板加起来
 * 只要超过内容宽，网格就照旧溢出，1fr 一点忙都帮不上（截图里详情列明明写着
 * 有剩余空间，实际一格也没多给，因为 1322px 的地板已经把 1142px 的内容宽吃光了）。
 * 于是这里按「谁最该让」的顺序砍：先砍详情（它有 1fr，砍了还能靠换行活），再按宽度从大到小
 * 砍其余列，每列都不低于自己的 min；全砍到 min 还放不下就随它去（那时横向滚动是对的，
 * 硬把字压成一团才是错的）。
 * avail<=0（还没挂进文档、或宿主量不出宽度，比如 node 桩）时原样返回——保持纯函数、
 * 也让结构回归的口径不变。 */
function fitDashWidths(widths, avail, cols, flexIdx) {
  const c = cols || DASH_COLS;
  const out = (widths || []).slice();
  if (!(avail > 0) || out.length !== c.length) return out;
  const floors = out.map((w, i) => ((c[i] && typeof c[i].min === "number") ? c[i].min : 0));
  /* 先按地板抬，再谈往下砍：读者拖出来的（或默认表里写的）值可能比这一列内容的下限还窄，
     * 那时砍无可砍也得让它先站稳——dashColNeeds 量到的就是"这一列排成一行要多宽"，
     * 照它抬上去最多是多出一条横向滚动，不抬则是把字裁掉。 */
  out.forEach((w, i) => { if (w < floors[i]) out[i] = floors[i]; });
  let over = out.reduce((a, w) => a + w, 0) - avail;
  if (over <= 0) return out;
  const fi = typeof flexIdx === "number" ? flexIdx : DASH_FLEX_COL;
  const order = out.map((w, i) => i)
    // 详情先让，其余谁宽谁先让（同一档按列序稳定）
    .sort((a, b) => (a === fi ? -1 : 0) - (b === fi ? -1 : 0) || out[b] - out[a] || a - b);
  for (const i of order) {
    if (over <= 0) break;
    const give = Math.min(over, out[i] - floors[i]);
    if (give > 0) { out[i] -= give; over -= give; }
  }
  return out;
}

/* localStorage 在隐私模式/配额满时读写会抛异常——列宽是锦上添花，绝不能把看板带崩。 */
function lsRead(key) {
  try { return (typeof localStorage === "undefined" || !localStorage) ? null : localStorage.getItem(key); }
  catch (e) { return null; }
}
function lsWrite(key, val) {
  try { if (typeof localStorage !== "undefined" && localStorage) localStorage.setItem(key, val); }
  catch (e) { /* 记不住下次回到默认，不影响任何功能 */ }
}
function lsRemove(key) {
  try { if (typeof localStorage !== "undefined" && localStorage) localStorage.removeItem(key); }
  catch (e) { /* 同上 */ }
}

/* 展示地址（取消发布/失败记录用）：任何协议拼路径失败都不该再抛异常盖掉原始错误 */
function safeRootDisplay(up, segs) {
  try { return up && segs ? displayUrl(up.rootDisplay(segs)) : ""; } catch (e) { return ""; }
}

/* 列举结果里是否存在“别人的”归属标记 */
function hasForeignOwner(names, mine) {
  for (const n of names || []) {
    const m = OWNER_RE.exec(String(n));
    if (m && `${OWNER_PREFIX}${m[1]}.json` !== mine) return true;
  }
  return false;
}

/* 插件里没有剪贴板相关的 copyText()：看板与结果卡片都是「展开一行可全选的路径文本」，
 * 插件既不主动写用户的剪贴板，也不替他「打开」一个自己无法验证的地址。 */

const MIME = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css", js: "text/javascript", json: "application/json",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", ico: "image/x-icon", bmp: "image/bmp",
  avif: "image/avif", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg",
  wav: "audio/wav", ogg: "audio/ogg", pdf: "application/pdf", txt: "text/plain",
  md: "text/markdown", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
};

function mimeOf(path) {
  const ext = path.split(".").pop().toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

/* 「等对方」的时间上限集中在这一处，便于按真实网络调，也便于回归把上限压到秒级去验证
 * 卡死路径真的会放手。选值口径：宁长勿短——传整站时慢服务器很常见；但**必须有上限**，
 * 因为一个没有上限的 await 卡住＝整次上传既不成功也不失败地悬在那里，用户只能重启思源。
 * 单位毫秒。 */
const IO_TIMEOUT = {
  kernelFileRead: 60000,  // /api/file/getFile：内核读本地盘，60 秒不返回就是这条路死了
  ftpData: 120000,        // 数据连接的两端：写入 flush 完成、服务器关掉连接
  ftpList: 60000,         // LIST / MLSD 的载荷收完
};

/* 读取内核文件字节。
 * 用户机器实测：fetch(`${conf().api}/api/file/getFile`) 全部返回 200 + 0 字节，
 * 而同源的 fetchSyncPost（相对 URL + XHR）一切正常——说明该环境下绝对地址 fetch
 * 的响应被截走/改写了。所以读取按可靠性排序依次尝试，取第一个非空结果：
 *   1) XHR 相对 URL（与 fetchSyncPost 同一传输路径，实测在用户机器上必然可用）
 *   2) fetch 相对 URL
 *   3) fetch 绝对 conf().api（旧行为，兜底）
 * expectedSize 取自内核 readDir 报告的文件大小（与读取路径无关，可作为独立证据）：
 * 全部方法都拿到 0 而内核说文件非 0 时，抛出包含各方法结果的诊断错误。 */
async function xhrGetFileBytes(wsPath) {
  return await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/file/getFile", true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("token", conf().token);
    xhr.responseType = "arraybuffer";
    /* 必须真的把 timeout 设出去：ontimeout 只在 xhr.timeout 到点时才触发，
     * 之前只挂了处理器没设时限＝这条兜底从来不会响，内核不回包就永远悬着。 */
    xhr.timeout = IO_TIMEOUT.kernelFileRead;
    xhr.onload = () => {
      if (xhr.status === 200) {
        resolve(new Uint8Array(xhr.response || new ArrayBuffer(0)));
      } else {
        let msg = "";
        try { msg = JSON.parse(xhr.responseText || "{}").msg; } catch (e) { /* noop */ }
        reject(new Error(`HTTP ${xhr.status}${msg ? " " + msg : ""}`));
      }
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.ontimeout = () => reject(new Error(`读取超时 ${IO_TIMEOUT.kernelFileRead / 1000}s`));
    xhr.onabort = () => reject(new Error("读取被中止"));
    xhr.send(JSON.stringify({ path: wsPath }));
  });
}

async function fetchGetFileBytes(wsPath, base) {
  /* fetch 没有超时这回事：连接建立后对方不回包，Promise 可以永远 pending。
   * 用 AbortController 掐表（Electron/Node 18+ 都有），拿到响应/失败都要撤表，
   * 否则每个文件留一个待触发的定时器。 */
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), IO_TIMEOUT.kernelFileRead);
  let resp;
  try {
    resp = await fetch(`${base}/api/file/getFile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: conf().token },
      body: JSON.stringify({ path: wsPath }),
      signal: ctl.signal,
    });
    if (resp.status !== 200) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(`HTTP ${j.code || resp.status}${j.msg ? " " + j.msg : ""}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
  } catch (e) {
    /* 到点被 abort 的那一路，翻成看得懂的超时（浏览器/SIYuan 给的 AbortError 不算信息） */
    const why = String((e && e.name) || "") + " " + String((e && e.message) || "");
    if (/abort/i.test(why)) throw new Error(`读取超时 ${IO_TIMEOUT.kernelFileRead / 1000}s`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function proxyGetFileBytes(wsPath) {
  const ret = await fetchSyncPost("/api/network/forwardProxy", {
    url: `${conf().api}/api/file/getFile`,
    method: "POST",
    headers: [{ token: conf().token }],
    payload: bytesToB64(utf8Bytes(JSON.stringify({ path: wsPath }))),
    payloadEncoding: "base64",
    contentType: "application/json",
    responseEncoding: "base64",
    timeout: 60000,
  });
  if (ret.code !== 0 || !ret.data) throw new Error(ret.msg || `forwardProxy code ${ret.code}`);
  const d = ret.data;
  if (d.status !== 200) throw new Error(`HTTP ${d.status}`);
  const bin = atob(String(d.body || ""));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function readExportFile(wsPath, expectedSize) {
  const tried = [];
  const methods = [
    ["xhr-rel", () => xhrGetFileBytes(wsPath)],
    ["fetch-rel", () => fetchGetFileBytes(wsPath, "")],
    ["fetch-api", () => fetchGetFileBytes(wsPath, conf().api)],
    ["proxy", () => proxyGetFileBytes(wsPath)],
  ];
  for (const [name, fn] of methods) {
    try {
      const u8 = await fn();
      tried.push(`${name}=${u8.length}B`);
      if (u8.length > 0) {
        if (expectedSize > 0 && u8.length !== expectedSize) {
          console.warn(`[netglimmer-upload] ${wsPath}: 读取 ${u8.length}B ≠ 内核报告 ${expectedSize}B（${name}）`);
        }
        return u8;
      }
      console.warn(`[netglimmer-upload] ${name} 读取 ${wsPath} 返回空`);
    } catch (e) {
      tried.push(`${name}=err(${e.message})`);
    }
  }
  if (expectedSize > 0) {
    throw new Error(`${wsPath}: 内核报告文件 ${expectedSize}B，但所有读取方式都拿到 0B [${tried.join(", ")}]`);
  }
  return new Uint8Array(0);
}

async function listDir(wsPath) {
  const r = await fetchSyncPost("/api/file/readDir", { path: wsPath });
  if (r.code !== 0) throw new Error(r.msg || `readDir ${wsPath}`);
  return r.data || [];
}

async function listAllFiles(wsDir, out = { files: [], dirs: [] }) {
  const entries = await listDir(wsDir);
  for (const e of entries) {
    const p = `${wsDir}/${e.name}`;
    if (e.isDir) {
      out.dirs.push(p);
      await listAllFiles(p, out);
    } else {
      // length 来自内核 readDir——后续用于「本地读取」「远端存储」两侧独立校验
      out.files.push({ path: p, size: Number(e.length) || 0 });
    }
  }
  return out;
}

function relOf(absWsPath, baseWsDir) {
  return absWsPath.startsWith(baseWsDir + "/") ? absWsPath.slice(baseWsDir.length + 1) : absWsPath;
}

/* WebDAV 统一走内核 /api/network/forwardProxy：
 * - method 参数可传任意动词（PROPFIND/MKCOL/PUT/DELETE/GET，3.8.3 源码实测）；
 * - 目标服务器真实状态码在 data.status，HTTP 层永远 200；
 * - 无 body 的动词（MKCOL/GET/DELETE）显式传空 contentType，
 *   否则内核默认 application/json——已用 curl 在你的 IIS 上验证：
 *   MKCOL 空/无 Content-Type→201，application/json 空 body→201，Range GET→206。
 * 不要用 /api/network/proxy：那里 gin 的 Any() 只注册了七个标准动词，
 * PROPFIND/MKCOL 根本进不了代理处理器，返回的是内核兜底的假 200——
 * 表现出来就是「插件报成功，但服务器上根本没有文件」。 */

async function forward(s, opts) {
  const arg = {
    url: opts.url,
    method: opts.method,
    timeout: opts.timeout || 90000,
    headers: [{ Authorization: basicAuth(s.username, s.password) }],
  };
  for (const [k, v] of Object.entries(opts.headers || {})) arg.headers.push({ [k]: String(v) });
  if (opts.body != null) {
    // v3.8.6 forwardProxy 的 payloadEncoding:"text" 分支是空实现（body 被静默丢弃，
    // 3.8.3 才有 SetBody 调用），base64 分支正常——所有请求体统一走 base64。
    arg.payload = opts.encoding === "base64"
      ? opts.body
      : bytesToB64(utf8Bytes(String(opts.body)));
    arg.payloadEncoding = "base64";
  }
  arg.contentType = opts.contentType || "";
  if (opts.responseEncoding) arg.responseEncoding = opts.responseEncoding;
  const ret = await fetchSyncPost("/api/network/forwardProxy", arg);
  if (ret.code !== 0 || !ret.data) {
    // 内核转发层失败（连不上/超时/DNS）——属于链路问题，重试有意义
    throw Object.assign(new Error(`${opts.method} ${redactUrl(opts.url)}: ${ret.msg || `forwardProxy code ${ret.code}`}`),
      { retryable: true });
  }
  const d = ret.data;
  // 逐请求的流水日志受设置里的「调试日志」开关控制（一次完整发布有上千行），
  // 但服务端返回 4xx/5xx 一律留痕，不受开关影响（地址先去凭据再打）。
  if (d.status >= 400) {
    console.warn(`[netglimmer-upload] ${opts.method} ${redactUrl(opts.url)} -> ${d.status}`,
      String(d.body || "").slice(0, 200));
  } else {
    dbg(`[netglimmer-upload] ${opts.method} ${redactUrl(opts.url)} -> ${d.status}`,
      String(d.body || "").slice(0, 200));
  }
  return {
    status: d.status, body: d.body || "", headers: d.headers, bodyEncoding: d.bodyEncoding || "",
    retryAfterMs: retryAfterMsOf(d.status, d.headers),
  };
}

/* 服务端明确要求「什么时候再来」（RFC 9110 的 Retry-After：秒数或 HTTP-date）。
 * 只在 429/503/504 上采信：这三家（Alist、群晖 WebDAV、IIS 的限流模块）确实会带这个头，
 * 而我们自己的指数退避最久 8 秒——服务端说「请等 60 秒」时，8 秒后重试只是把限流
 * 踩得更响。值再大也夹到 RETRY_AFTER_MAX：一次发布不能因为一句限流提示挂十分钟，
 * 夹掉的部分由「重试次数用尽」如实报成失败，而不是假装还在努力。
 * forwardProxy 的 headers 是 { "Retry-After": ["120"] } 这种形态（实测 3.8.6），
 * 大小写按 Go 的规范化走，但仍按不区分大小写取，免得换个实现就取不到。 */
const RETRY_AFTER_MAX = 120000;
function retryAfterMsOf(status, headers) {
  const st = Number(status) || 0;
  if (st !== 429 && st !== 503 && st !== 504) return 0;
  if (!headers || typeof headers !== "object") return 0;
  let raw = null;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() !== "retry-after") continue;
    const v = headers[k];
    raw = Array.isArray(v) ? v[0] : v;
    break;
  }
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return 0;
  let ms = -1;
  if (/^\d+$/.test(s)) ms = Number(s) * 1000;
  else {
    const at = Date.parse(s);
    if (!Number.isNaN(at)) ms = at - Date.now();
  }
  if (!(ms > 0)) return 0;
  return Math.min(ms, RETRY_AFTER_MAX);
}

function okStatus(status, allowed) {
  return allowed.includes(status);
}

async function davRequest(settings, method, url, headers = {}, body = null, contentType = null) {
  return await forward(settings, {
    method, url, headers,
    body,
    contentType: contentType || "",
  });
}

async function davPut(settings, url, data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const d = await forward(settings, {
    method: "PUT", url,
    body: bytesToB64(u8),
    encoding: "base64",
    contentType: mimeOf(url),
  });
  if (!okStatus(d.status, [200, 201, 204])) {
    throw Object.assign(new Error(`PUT ${redactUrl(url)}: HTTP ${d.status}`),
      { httpStatus: d.status, retryAfterMs: d.retryAfterMs || 0 });
  }
  // 每个成功 PUT 一行：一次 549 文件的发布就是 549 行，必须吃「调试日志」开关，
  // 否则设置里那个开关名不副实（失败行仍由 forward 的 4xx 分支无条件留痕）。
  dbg(`[netglimmer-upload] PUT ${redactUrl(url)} -> ${d.status} (${u8.length} bytes)`);
  return d.status;
}

/* nginx 的 dav 模块要求 MKCOL 的 URL 以 / 结尾（本机 1.26.3 + dav_ext 实测：
   MKCOL /t1 → 409 且目录不创建，MKCOL /t2/ → 201）；IIS 两种写法都收
   （实测 /a 与 /b/ 均 201，重复建回 405）。统一补尾斜杠，一家都不惯着。 */
function mkcolUrl(url) { return String(url || "").replace(/\/+$/, "") + "/"; }

async function davMkcol(settings, url) {
  const target = mkcolUrl(url);   // 尾斜杠差异与理由见 mkcolUrl 上方注释
  const d = await davRequest(settings, "MKCOL", target);
  // 严格实现回 201；部分服务器（含 IIS 某些配置）回 200/204；405=已存在。
  if (okStatus(d.status, [200, 201, 204, 405])) return;
  if (d.status === 409) {
    /* 409 有两种截然不同的含义：目录其实已经在（某些服务器的「已存在」写法），
       或者上一级没建好（nginx 明确拒绝在缺失的父集合下建子目录）。用 Depth 0 复核一下：
       存在就放过，404 就报出真正原因，PROPFIND 本身不可用（没装 dav_ext、被 ACL 挡）
       则维持旧语义——能不能写自有后面的 PUT 说话。 */
    const pf = await davPropfind(settings, target, "0");
    if (pf.status === 207) return;
    if (pf.status !== 404) return;
    throw Object.assign(new Error(
      `MKCOL ${target}: 409，且 PROPFIND 确认该目录不存在（父目录缺失；nginx 需要逐级建好父目录，或在站点配置里打开 create_full_put_path on）`
    ), { httpStatus: 409, retryAfterMs: d.retryAfterMs || 0 });
  }
  throw Object.assign(new Error(`MKCOL ${target}: ${d.status}`),
    { httpStatus: d.status, retryAfterMs: d.retryAfterMs || 0 });
}

/* MultiStatus 解析：不用 DOMParser——IIS 返回 <D:href>（大写前缀），
 * getElementsByTagName("href") 对带命名空间前缀的元素不可靠，直接正则逐块解析。 */
const NS = "(?:[A-Za-z_][\\w.-]*:)?";

/* <d:href> 是 XML 文本，服务器写文件名里的 & 时按 XML 规则转义（本机实测两台形态不同）：
 *   nginx 1.26 + dav_ext → 名字 "amp&x" 回 "/priv128/amp&amp;x/"（XML 实体）
 *   IIS 10               → 同一个名字回 ".../ent%26test.png"（URL 百分号编码）
 * 正则取的是标签之间的原始字符，所以 nginx 那种实体会原样留在 href 里。后果不是
 * 「少一个文件」而是「认错一个文件」：这张清单一边按 normalizeKey 解百分号、一边
 * 带着 &amp; 去和 keyOf(segs) 比，永远比不中——于是刚上传的文件被判成「远端缺失」，
 * 而它同时出现在孤立文件清单里，被 deleteReal 当成上一次的残留删掉（读者的图说没就没）。
 * 拿这个 URL 去 PROPFIND 那个子目录也是 404：整棵子树从此看不见。
 * 所以解析阶段就把实体还原（&amp; 最后一步，避免 &amp;lt; 被解两次成 <）。 */
function xmlUnescape(s) {
  const s0 = String(s == null ? "" : s);
  if (s0.indexOf("&") < 0) return s0;
  return s0
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
      const c = parseInt(h, 16);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m;
    })
    .replace(/&#(\d+);/g, (m, d) => {
      const c = parseInt(d, 10);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m;
    })
    .replace(/&amp;/g, "&");
}

function parseMultistatus(body) {
  const text = String(body || "");
  const blocks = text.split(new RegExp(`<${NS}response\\b`, "i")).slice(1);
  const entries = [];
  for (const b of blocks) {
    const hm = b.match(new RegExp(`<${NS}href[^>]*>([^<]*)</${NS}href>`, "i"))
      || b.match(new RegExp(`<${NS}href[^>]*>([^<]*)`, "i"));
    if (!hm) continue;
    entries.push({
      href: xmlUnescape((hm[1] || "").trim()),
      isDir: new RegExp(`<${NS}collection\\b`, "i").test(b),
      size: new RegExp(`<${NS}getcontentlength\\b`, "i").test(b)
        ? parseInt((b.match(new RegExp(`<${NS}getcontentlength[^>]*>(\\d+)<`, "i")) || [])[1] || "0", 10)
        : -1,
    });
  }
  return entries;
}

async function davPropfind(settings, url, depth = "1") {
  const d = await forward(settings, {
    method: "PROPFIND", url,
    headers: { Depth: depth },
    body: '<?xml version="1.0"?>' +
      `<d:propfind xmlns:d="DAV:"><d:prop><d:href/><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>`,
    contentType: "application/xml",
  });
  if (![207, 200].includes(d.status)) return { status: d.status, entries: [], body: d.body || "" };
  return { status: d.status, entries: parseMultistatus(d.body), body: d.body || "" };
}

async function davGet(settings, url, opts = {}) {
  return await forward(settings, Object.assign({ method: "GET", url, contentType: "" }, opts));
}

async function davDelete(settings, absoluteUrl) {
  const d = await davRequest(settings, "DELETE", absoluteUrl);
  return okStatus(d.status, [204, 200, 404]);
}

/* ---------------- Node 能力（桌面端 Electron nodeIntegration=true 实测可用） ---------------- */

function nodeRequire(mod) {
  try {
    const req = (typeof require === "function" ? require : window.require);
    return req ? req(mod) : null;
  } catch (e) { return null; }
}

function needNode(mod, proto) {
  const m = nodeRequire(mod);
  if (!m) throw new Error(`${proto} 需要桌面端 Node 环境（找不到模块 ${mod}），WebDAV 模式不受影响`);
  return m;
}

/* =====================================================================
 * FTP 客户端（纯 JS，控制连接 + PASV 数据连接）
 * 只用标准动词：USER/PASS/SYST/TYPE/PASV/PWD/CWD/MKD/STOR/RETR/SIZE/
 * DELE/RMD/MLSD(回退 LIST)/QUIT——vsftpd、IIS FTP、ProFTPD 通用。
 * ===================================================================== */

/* @@VENDOR:gbk-table@@ GBK 码表数据（逐字固定，见 src/vendored/gbk-table.js，由 build.js 拼回） */

/* PASV 回包里的 IP 能不能直接用：只有一种情况必须换掉——服务器报的是它在内网看到
 * 的那个地址（RFC 1918 / 环回 / 链路本地 / 运营商级 NAT 的 100.64/10），而我们是
 * 从别处（公网地址或域名）连上它的。这时按它连数据端口必然连不上。
 * 公网地址一律照原样返回：多网卡、负载均衡的服务器故意报另一个地址，那是它的选择。
 * 私网地址一律换成控制连接那一个——即便两边同网段（192.168.1.7 连、服务器报 .9），
 * 控制地址也是刚被证明可达的那个，而报出来的那张网卡未必路由得到。
 * 控制地址与报出的地址相同（本机测试环境 vsftpd 都报 127.0.0.1）时，换不换是同一个值。 */
function isSiteLocalV4(ip) {
  const p = String(ip || "").split(".").map((x) => parseInt(x, 10));
  if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return false;
  return p[0] === 10 || p[0] === 127 || p[0] === 0
    || (p[0] === 169 && p[1] === 254)
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168)
    || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}
function pasvHostFor(controlHost, advHost) {
  const adv = String(advHost || "");
  const ctl = String(controlHost || "");
  if (!adv) return ctl;
  if (!isSiteLocalV4(adv)) return adv;
  if (!ctl || ctl === adv) return adv;
  return ctl;
}

class FtpSession {
  constructor(s) {
    const net = needNode("net", "FTP");
    this.net = net;
    // 端口口径统一走 hostPortOf：端口框 > 地址里的 host:port > 21
    const hp = hostPortOf(s.server, s.port, "ftp");
    this.host = hp.host; this.port = hp.port; this.displayHost = hp.displayHost;
    this.user = s.username; this.pass = s.password;
    this.sock = null; this.buf = ""; this.expectQueue = []; this.pending = [];
    this._dead = null;       // 会话死因（连接错误/被服务器关闭），一旦记下就不再让新的等待挂上去
    this.hasMLSD = false; this.hasUTF8 = true; this.listArgBroken = false; this._capture = null;
    this.listSample = "";   // 最近一次 LIST 原文片段（报错时带上，便于识别服务器方言）
  }

  connect() {
    return new Promise((resolve, reject) => {
      /* 重连的会话要把上一次的死因与残留应答清掉，否则新 socket 一挂上 _expect 就被当成已作废。 */
      this._resetDeadState();
      const sock = this.net.connect({ host: this.host, port: this.port });
      sock.setTimeout(30000);
      sock.once("error", reject);
      this.sock = sock;
      sock.setEncoding("utf8");
      sock.on("data", (d) => this._onData(d));
      /* 握手成功后不能再让 error/close 无人认领：
       *   · Node 对没有监听者的 'error' 是直接抛异常——在思源的渲染进程里就是整窗崩；
       *   · 服务器中途掉线时，所有还挂在 _expect 上的调用得立刻知道「这条连接废了」，
       *     而不是各自再干等 30 秒超时（几百个文件的上传队列会一起卡在那儿）。
       * 监听在 connect 时就挂上，不靠 _expect(220) 之后补——补不上（220 之前掉线更常见）。 */
      sock.on("error", (e) => this._kill(e));
      sock.on("close", () => this._kill(new Error("FTP 控制连接被服务器关闭")));
      sock.on("end", () => this._kill(new Error("FTP 控制连接被服务器关闭")));
      this._expect(220).then(() => { sock.removeListener("error", reject); resolve(); },
        (e) => { sock.removeListener("error", reject); reject(e); });
    });
  }

  /* 重连前的清理：上一次会话的死因、排队中的应答、半行缓冲都不能带到新 socket 上。 */
  _resetDeadState() {
    this._dead = null;
    this.expectQueue = [];
    this.pending = [];
    this.buf = "";
  }

  /* 会话作废：记下第一条死因（后到的 close/error 不覆盖真正的原因），
   * 把所有还在等的应答一次性判死——带 connLost，上层按「先重连再重试」处理。 */
  _kill(err) {
    const e = Object.assign(err instanceof Error ? err : new Error(String(err || "FTP 连接已断开")), { connLost: true });
    if (!this._dead) this._dead = e;
    for (const item of this.expectQueue.splice(0)) {
      clearTimeout(item.timer);
      item.reject(this._dead);
    }
    try { this.sock && this.sock.destroy(); } catch (e2) { /* noop */ }
  }

  _onData(d) {
    this.buf += d;
    // 逐行消费：终结行 ^NNN<sp>，其余（^NNN- 开头或缩进续行）只丢弃
    while (true) {
      const nl = this.buf.indexOf("\n");
      if (nl < 0) return;
      const line = this.buf.slice(0, nl + 1);
      this.buf = this.buf.slice(nl + 1);
      if (this._capture) this._capture.push(line); // FEAT 全文捕获（多行应答主体不进常规队列）
      const m = line.match(/^(\d{3}) /);
      if (!m) continue;
      const reply = { code: parseInt(m[1], 10), text: line };
      const q = this.expectQueue.shift();
      if (q) q.resolve(reply);
      else this.pending.push(reply); // 无人认领的应答（竞态）缓存，供下一个等待者优先消费
    }
  }

  _expect(codeOrCodes, timeout = 30000) {
    const codes = Array.isArray(codeOrCodes) ? codeOrCodes : [codeOrCodes];
    return new Promise((resolve, reject) => {
      /* 连接已经废了就别再挂队：等下去只会等到超时，中间还占着一个队列位。 */
      if (this._dead) { reject(this._dead); return; }
      const fail = (r) => reject(Object.assign(
        new Error(`FTP 期望 ${codes.join("/")}，收到 ${r.code} ${r.text.trim()}`), { ftpCode: r.code }));
      if (this.pending.length) {
        const r = this.pending.shift();
        if (codes.includes(r.code)) resolve(r); else fail(r);
        return;
      }
      const t = setTimeout(() => {
        const i = this.expectQueue.indexOf(item);
        if (i >= 0) this.expectQueue.splice(i, 1);
        // 控制通道无应答：多半是连接本身出问题，重试前应先重连
        reject(Object.assign(new Error(`FTP 等待 ${codes.join("/")} 超时`), { connLost: true }));
      }, timeout);
      /* item 带上 reject 与 timer：_kill() 掉线时要能把还挂在这里的等待者一次性叫醒，
       * 而不是让它们各自空等到超时（服务器直接 RST 时，等 30 秒和等 3 秒是同一件事）。 */
      const item = {
        timer: t,
        reject: (e) => { clearTimeout(t); reject(e); },
        resolve: (r) => {
          clearTimeout(t);
          if (!codes.includes(r.code)) {
            reject(Object.assign(
              new Error(`FTP 期望 ${codes.join("/")}，收到 ${r.code} ${r.text.trim()}`), { ftpCode: r.code }));
          } else resolve(r);
        },
      };
      this.expectQueue.push(item);
    });
  }

  /* 控制连接是「一行一命令」的文本协议：文件名里带 CR/LF 就能把一条 STOR 变成两条命令
   * （Linux 允许文件名含换行，思源里 Such-a-name\n.png 这种附件名会原样进导出目录，
   * FTP 服务器上已有同名文件时它还会作为 it.name 从 LIST 里回到这里）。
   * 与其给命令注入开门，不如在出口硬失败：宁缺毋滥，错误里点名是哪条命令。
   *
   * 闸门只有 _wire 一个出口才算数：cmd() 之外还有 STOR/RETR/MLSD/LIST 四条为了配
   * 数据连接直接写 socket 的路（本轮回归实测到——带换行的文件名走 put 时，
   * 后面那条 DELE 真的被执行了，受害者文件说没就没了）。cmd() 里那道也留着：
   * 它必须在 _expect 之前拦，否则应答队列里挂着一个永远没人回答的等待。
   *
   * 报错只报命令词，不带参数——参数可能是 PASS 的密码，也可能整段就是用户起的文件名。 */
  _assertOneLine(line) {
    const body = String(line).replace(/\r\n$/, "");
    if (!/[\r\n]/.test(body)) return;
    const verb = (body.match(/^[A-Za-z]{3,4}/) || ["?"])[0].toUpperCase();
    throw new Error(`FTP 命令串含换行，已拒绝发送：${verb}（参数里的换行会变成第二条命令，已拦截）`);
  }

  async cmd(line, codes) {
    this._assertOneLine(line);
    const p = this._expect(codes || [200, 202, 205, 211, 213, 214, 215, 220, 221, 226, 227, 229, 230, 235, 250, 257, 331, 332, 335, 350, 421, 450, 451, 452, 500, 501, 502, 503, 504, 530, 550], 30000);
    this._capture = [];
    this._wire(line + "\r\n");
    const r = await p;
    r.lines = this._capture || [];
    this._capture = null;
    return r;
  }

  /* GBK 模式：把「latin1 字节串」原样写成字节；普通模式直接字符串（UTF-8） */
  _wire(s) {
    this._assertOneLine(s);
    try { this.sock.write(this.gbkMode ? Buffer.from(s, "latin1") : s); }
    catch (e) { /* 连接已断由等待者超时处理 */ }
  }

  async login() {
    await this.cmd("USER " + this.user, [230, 331]);
    await this.cmd("PASS " + this.pass, [230]);
    await this.cmd("TYPE I", [200]);
    try { await this.cmd("PBSZ 0", [200]); } catch (e) { /* noop */ }
    try { await this.cmd("PROT C", [200]); } catch (e) { /* noop */ }
    const f = await this.cmd("FEAT", [211]);
    const featAll = (f.lines || []).join(" ");
    /* RFC 3659：MLSD 能力必须在 FEAT 声明。IIS 只实现 MLST——对 MLSD 会回「目录自身」一条，
     * 若不门控，walk 会得到「只有目录本身」的伪列表而漏掉全部文件。 */
    this.hasMLSD = /(^|[\s;])MLSD($|[\s;])/im.test(featAll);
    /* RFC 2640：UTF8 能力需在 FEAT 声明或 OPTS UTF8 ON 被接受；否则服务器按本地代码页
     * 解释控制通道字节（IIS/FileZilla 中文版=GBK），UTF-8 中文路径会落成乱码名，
     * 导致浏览器按 UTF-8 URL 访问 404。此时上传器自动把非 ASCII 路径段转为百分号字面名。 */
    this.hasUTF8 = /(^|[\s;])UTF8($|[\s;])/im.test(featAll);
    this.gbkMode = false; // 在下方最终确定
    if (!this.hasUTF8) {
      try { await this.cmd("OPTS UTF8 ON", [200]); this.hasUTF8 = true; } catch (e) { /* 不支持 */ }
    }
    this.gbkMode = this.hasUTF8 === false;
  }

  async pasv() {
    const r = await this.cmd("PASV", [227]);
    const m = r.text.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
    if (!m) throw new Error("PASV 解析失败: " + r.text.trim());
    return {
      /* 服务器报的是它自己看到的那张网卡的地址，NAT/云主机/容器后面那个地址
       * 客户端根本到不了——症状是「上传卡在某个文件上超时」，谁都猜不到是这里。
       * 改写规则与理由见 pasvHostFor。 */
      host: pasvHostFor(this.host, `${m[1]}.${m[2]}.${m[3]}.${m[4]}`),
      advertised: `${m[1]}.${m[2]}.${m[3]}.${m[4]}`,
      port: parseInt(m[5], 10) * 256 + parseInt(m[6], 10),
    };
  }

  _dataConn(ep) {
    return new Promise((resolve, reject) => {
      const d = this.net.connect({ host: ep.host, port: ep.port, family: 4 });
      d.setTimeout(120000);
      d.once("error", reject);
      d.once("connect", () => { d.setTimeout(0); resolve(d); });
    });
  }

  /* 数据连接的状态跟踪：一次注册、多处查询。
   * 必须在拿到连接的当下就挂——'finish'/'close'/'end' 很可能在我们第二次 await 之前就来过
   * （小文件 + 服务器立刻关连接），那种情况下再挂监听就永远等不到了。
   * 之所以不用 Node 的 socket.setTimeout：那是「静置超时」，只发 'timeout' 事件不断线，
   * 而 _dataConn 建连后第一件事就是 setTimeout(0) 把它关掉——唯一的兜底也被自己关了，
   * 于是服务器收了 PASV 却一个字节都不回时（防火墙中间态、backlog 满），
   * 下面的 await 既不成功也不失败，整次上传悬在那里，用户只能重启思源。 */
  _track(d) {
    const st = { finished: false, gone: false, err: null, cbs: [] };
    d.__vd = st;
    const fire = () => { for (const fn of st.cbs.splice(0)) { try { fn(); } catch (e) { /* noop */ } } };
    d.on("finish", () => { st.finished = true; fire(); });
    d.on("close", () => { st.gone = true; fire(); });
    d.on("end", () => { st.gone = true; fire(); });
    d.on("error", (e) => { st.err = e; fire(); });
    return d;
  }

  /* want: "finish"（写入已全部交给内核 socket）| "gone"（连接已关，服务器该发 226 了）。
   * 到点没动静就 destroy 连接并抛 connLost——让上层按「这条连接废了」重试或报错。 */
  _dataWait(d, want, ms, what) {
    const st = d.__vd;
    return new Promise((resolve, reject) => {
      const settle = () => {
        if (st.err) { reject(st.err); return true; }
        if (want === "finish" && st.finished) { resolve(); return true; }
        if (want === "gone" && st.gone) { resolve(); return true; }
        return false;
      };
      if (settle()) return;
      const t = setTimeout(() => {
        const i = st.cbs.indexOf(check);
        if (i >= 0) st.cbs.splice(i, 1);
        try { d.destroy(); } catch (e) { /* noop */ }
        reject(Object.assign(
          new Error(`${what}：FTP 数据连接 ${Math.round(ms / 1000)} 秒没有动静`), { connLost: true }));
      }, ms);
      const check = () => { if (settle()) clearTimeout(t); };
      st.cbs.push(check);
    });
  }

  /* 数据连接必须有一条「无论如何都关」的路：PASV 已经开出一个端口、 socket 已经建好，
   * 之后任何一步抛错（125/150 没等到、服务器回了 550、写入超时）都会把这条连接留在
   * 会话里——一次 580 文件的发布里若有几十个失败，攒的是几十个 fd 和几十个服务器端
   * 半开数据连接，症状是「传到后面越来越慢，最后连控制连接都被踢」。 */
  async put(relPath, u8) {
    const ep = await this.pasv();
    const d = this._track(await this._dataConn(ep));
    try {
      this._wire(`STOR ${relPath}\r\n`);
      const r = await this._expect([125, 150, 126]);
      /* 写入端：服务器不读（接收窗满/半开连接）时 end 的回调永远不会来，
       * 所以「写完了」也当成一次要等对方配合的事件来看。 */
      d.end(Buffer.from(u8.buffer, u8.byteOffset, u8.length));
      await this._dataWait(d, "finish", IO_TIMEOUT.ftpData, "STOR 写入");
      await this._dataWait(d, "gone", IO_TIMEOUT.ftpData, "STOR 收尾");
      await this._expect([226, 250]);
      return r;
    } finally {
      try { d.destroy(); } catch (e) { /* noop */ }
    }
  }

  /* RETR 的收尾码只认 226/250。425「数据连接打不开」与 426「传输中断」都是没传完：
   * 以前把它们一起算成功，读回校验就拿着一个空/半截的 buffer 判「文件在、能读」——
   * 而这条 readBack 正是服务器不答 SIZE 时唯一的确认手段。 */
  async get(relPath) {
    const ep = await this.pasv();
    const d = this._track(await this._dataConn(ep));
    const chunks = [];
    try {
      d.on("data", (c) => chunks.push(c));
      this._wire(`RETR ${relPath}\r\n`);
      await this._expect([125, 150]);
      await this._dataWait(d, "gone", IO_TIMEOUT.ftpData, "RETR 接收");
      await this._expect([226, 250]);
      return Buffer.concat(chunks);
    } finally {
      try { d.destroy(); } catch (e) { /* noop */ }
    }
  }

  async size(relPath) {
    const r = await this.cmd("SIZE " + relPath, [213, 550]);
    return r.code === 213 ? parseInt(r.text.trim().split(/\s+/)[1] || "-1", 10) : -1;
  }

  async mkd(relPath) {
    const r = await this.cmd("MKD " + relPath, [257, 550, 521]);
    return r.code === 257;
  }

  async dele(relPath) { await this.cmd("DELE " + relPath, [250, 257, 550]); }
  async rmd(relPath) { await this.cmd("RMD " + relPath, [250, 257, 550]); }

  /* 目录列表：FEAT 声明 MLSD 时优先 MLSD（机器可读），否则/失败退回 LIST（解析 UNIX 与 Windows/IIS 格式）。
   * 两种应答都只可能给出「空清单」，而空清单在下一层会被读成「远端没有文件」——
   * 所以凡是「有应答却一条都没解析出来」都必须抛错，让上层把整树遍历判成不可信，
   * 改走逐文件确认（整站 580/580 判成「缺失」就是这么来的）。 */
  async list(relPath) {
    const clean = String(relPath || "").replace(/\/+$/, "");
    const wantName = normalizeKey(clean.split("/").pop() || "");
    /* 「这条目就是被查询的目录本身」：IIS 的 MLSD 只回它（写成完整路径），
     * FileZilla 的 LIST 也只回它（写成最后一段名字）。两种都要认，
     * 否则遍历会把目录自身当成子目录钻下去，交出一张空清单。 */
    const norm = (v) => normalizeKey(String(v || ""));
    const isSelfPath = (it) => !!(it && it.isDir) && !!clean && norm(it.name) === norm(clean);
    const isSelfName = (it) => !!(it && it.isDir) && !!wantName && norm(it.name) === wantName;
    if (this.hasMLSD) {
      let dMlsd = null;
      try {
        const ep = await this.pasv();
        dMlsd = this._track(await this._dataConn(ep));
        const d = dMlsd;
        this._wire(`MLSD ${relPath}\r\n`);
        await this._expect([125, 150]);
        let text = "";
        let ok = true;
        d.setEncoding(this.gbkMode ? "latin1" : "utf8");
        d.on("data", (c) => { text += c; });
        /* 列表这条路允许「拿不到就退回 LIST」，所以超时/出错都吞掉，只把 ok 置真假的；
         * 但没有上限的 await 一样会永久悬着——这里照样要设表。 */
        await this._dataWait(d, "gone", IO_TIMEOUT.ftpList, "MLSD 接收").catch(() => { ok = false; });
        const fin = await this._expect([226, 250, 550]);
        if (ok && fin.code === 226 && text.trim()) {
          const items = [];
          for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            /* RFC 3659 只规定 facts 与路径之间至少一个空格，各家实现不一致：
             * IIS/FileZilla 常见「…Size=12; 名称」（事实串收尾的 ; 后仅一个空格），
             * 老实现按「空格+可选空格+空白」解析，这类应答会被整段判成解析失败。 */
            const m = line.match(/^(.*;)\s+(\S.*)$/) || line.match(/^(.*?)\s{2,}(\S.*)$/);
            if (!m) continue;
            const facts = {};
            m[1].split(";").forEach((kv) => { const p = kv.split("="); if (p.length === 2) facts[p[0].trim().toLowerCase()] = p[1].trim(); });
            const name = m[2].trim();
            if (!name || name === "." || name === "..") continue;
            items.push({ name, isDir: (facts.type || "") === "dir", size: facts.size != null ? parseInt(facts.size, 10) : -1 });
          }
          /* 只按「完整路径等于被查询目录」剔除自身行：MLSD 的自身行就是这个写法（IIS）。
           * 不按末段名剔除——那会把真的叫同名子目录的条目也误删。 */
          const content = items.filter((it) => !isSelfPath(it));
          if (content.length) return content;
          // 解析不出内容（只有目录自身 / 一行都没解析出来）→ 不用 MLSD，继续往下走 LIST
        }
      } catch (e) { /* MLSD 不可用 → LIST */ }
      try { dMlsd && dMlsd.destroy(); } catch (e) { /* noop */ }
    }
    // LIST 回退
    const text2 = await this._listData(this.listArgBroken && relPath ? (await this.cwdThen(relPath)) : relPath);
    this.listSample = String(text2 || "").slice(0, 400);
    const items = parseList(text2);
    /* FileZilla Server 等：LIST <目录> 返回「目录自身」一条而非内容。
     * 检测到后切换为 CWD + 裸 LIST 模式（本会话内缓存该判定，避免逐目录重复试探）。 */
    if (relPath && items.length === 1 && (isSelfPath(items[0]) || isSelfName(items[0]))) {
      this.listArgBroken = true;
      const raw2 = await this._listData(await this.cwdThen(relPath));
      const again = parseList(raw2);
      if (!again.length && String(raw2 || "").trim()) throw this._unparsable(raw2);
      return again;
    }
    /* 应答里有文本却一行都解析不出来：这不是「空目录」（空目录的 LIST 载荷是 0 字节），
     * 而是这台服务器的日期/权限列写法我们不认。抛错让 walk 把整棵树判成不可信。 */
    if (!items.length && String(text2 || "").trim()) throw this._unparsable(text2);
    // 多条目清单里混进「自身」行（有的服务器 LIST 带 . 之外的写法）：按完整路径剔除，
    // 否则遍历会把自己当子目录钻下去，白跑一趟还漏掉真实内容。
    return items.some(isSelfPath) ? items.filter((it) => !isSelfPath(it)) : items;
  }

  _unparsable(text) {
    const sample = String(text || "").replace(/[\r\n]+/g, " ⏎ ").slice(0, 120);
    return Object.assign(new Error(`LIST 应答无法解析：${sample}`), { listUnparsed: true, sample });
  }

  /* 切到目录并返回空参数（裸 LIST 用当前目录）；CWD 失败会抛（550=不存在） */
  async cwdThen(relPath) {
    await this.cmd("CWD " + relPath, [250]);
    return "";
  }

  _listData(arg) {
    return (async () => {
      const ep = await this.pasv();
      const d = this._track(await this._dataConn(ep));
      try {
        this._wire(`LIST ${arg}\r\n`);
        await this._expect([125, 150]);
        let text = "";
        d.setEncoding(this.gbkMode ? "latin1" : "utf8");
        d.on("data", (c) => { text += c; });
        /* LIST 卡住＝「远端到底有什么」永远读不出来。这里必须放手，
         * 让上层把整次遍历判成不可信（宁可报「无法确认」也不要按空清单去删文件）。
         * 出错/超时都按原口径吞掉：把已经收到的部分交给后面的 226/550 判定，
         * 报错文案与改动前保持一致（run-ftpverify 的十种方言各钉各的错误）。 */
        await this._dataWait(d, "gone", IO_TIMEOUT.ftpList, "LIST 接收").catch(() => { /* 部分应答 */ });
        await this._expect([226, 250, 550]);
        return text;
      } finally {
        try { d.destroy(); } catch (e) { /* noop */ }
      }
    })();
  }

  async pwd() {
    const r = await this.cmd("PWD", [257]);
    const m = r.text.match(/"([^"]*)"/);
    return m ? m[1] : "/";
  }

  async quit() {
    try { await this.cmd("QUIT", [221]); } catch (e) { /* noop */ }
    try { this.sock.destroy(); } catch (e) { /* noop */ }
  }
}

/* LIST 文本解析：UNIX ls -l（vsftpd/ProFTPD：日期为 3 个 token）与 Windows/IIS 风格
 * （MM-DD-YY[YY] hh:mm[SS][AM/PM]  <DIR>|字节数  名称）。
 * 认不出的行只能当看不见——但整段都解析不出时必须让调用方知道（见 list()），
 * 否则「空清单」会被当成「远端没有文件」，把整站 580 个文件误报成缺失。 */
function parseList(text) {
  const items = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m = line.match(/^([dl-])(?:\S*)\s+(\d+)\s+\S+\s+\S+\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (m) {
      const name = m[7].trim();
      if (name === "." || name === "..") continue;
      items.push({ name, isDir: m[1] === "d", size: parseInt(m[3], 10) });
      continue;
    }
    m = line.match(/^(\d{2}-\d{2}-\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]M)?)\s+(<DIR>|\d+)\s+(\S.*)$/i);
    if (m) {
      const name = m[3].trim();
      if (name === "." || name === "..") continue;
      items.push({ name, isDir: /^<dir>$/i.test(m[2]), size: /^\d+$/.test(m[2]) ? parseInt(m[2], 10) : -1 });
    }
  }
  return items;
}

/* =====================================================================
 * SFTP 客户端：纯 JS SSH-2 传输层
 *   KEX: curve25519-sha256 / ecdh-sha2-nistp256
 *   主机密钥: ssh-ed25519 / rsa-sha2-512/256 / ssh-rsa / ecdsa-sha2-nistp256（TOFU 指纹记忆）
 *   加密: aes128/192/256-ctr；MAC: hmac-sha2-256/512（含 -etm 变体）
 *   认证: password；子系统: sftp v3
 * 全部通过桌面端 Node 的 net/crypto 模块实现，无第三方依赖。
 * ===================================================================== */

const SSH_MSG = {
  DISCONNECT: 1, IGNORE: 2, SERVICE_REQUEST: 5, SERVICE_ACCEPT: 6, EXT_INFO: 7,
  KEXINIT: 20, NEWKEYS: 21, KEX_ECDH_INIT: 30, KEX_ECDH_REPLY: 31,
  KEXDH_INIT: 34, KEXDH_REPLY: 33,
  USERAUTH_REQUEST: 50, USERAUTH_FAILURE: 51, USERAUTH_SUCCESS: 52, USERAUTH_BANNER: 53,
  GLOBAL_REQUEST: 80, REQUEST_SUCCESS: 81, REQUEST_FAILURE: 82,
  CHANNEL_OPEN: 90, CHANNEL_OPEN_CONF: 91, CHANNEL_OPEN_FAIL: 92,
  CHANNEL_WINDOW_ADJUST: 93, CHANNEL_DATA: 94, CHANNEL_EOF: 96, CHANNEL_CLOSE: 97,
  CHANNEL_REQUEST: 98, CHANNEL_SUCCESS: 99, CHANNEL_FAILURE: 100,
};
const FXP = {
  INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6, LSTAT: 7, FSTAT: 8,
  OPENDIR: 11, READDIR: 12, REMOVE: 13, MKDIR: 14, RMDIR: 15, REALPATH: 16, STAT: 17,
  STATUS: 101, HANDLE: 102, DATA: 103, NAME: 104, ATTRS: 105,
};
const FXP_STATUS_OK = 0, FXP_STATUS_EOF = 1;

/* SSH 算法名 → Node/OpenSSL 算法名 */
const SSH_CIPHER_TO_NODE = { "aes128-ctr": "aes-128-ctr", "aes192-ctr": "aes-192-ctr", "aes256-ctr": "aes-256-ctr" };
const SSH_MAC_TO_NODE = { "hmac-sha2-256": "sha256", "hmac-sha2-512": "sha512" };
/* 本客户端只提案 AES-*-CTR，块长恒为 16。非 EtM 时 4 字节包长也在密文里，
 * 收包必须先解出一个整块才知道整包多长（RFC 4253 6.1），所以这个数是分帧的门槛。 */
const SSH_BLOCK = 16;

/* NEWKEYS 之后这个方向的报文序号取什么值：协商了严格 KEX 就归零，否则继续数。
 * RFC 4253 6.4 写的是「never reset, even if keys/algorithms are renegotiated」，
 * OpenSSH 7.8 起的 kex-strict 把这条改成了归零——两种服务器都真实存在，选错边
 * 就是第一颗加密报文 "mac incorrect"。抽成纯函数是因为本机造不出非严格的
 * OpenSSH（回归只能钉住这条分岔本身，见 run-sshframing.js）。 */
function seqAfterNewKeys(strict, seq) { return strict ? 0 : seq >>> 0; }

/* ---- 报文构造/读取 ---- */
class BufW {
  constructor() { this.parts = []; }
  byte(b) { this.parts.push(Buffer.from([b & 0xff])); return this; }
  bool(b) { return this.byte(b ? 1 : 0); }
  u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); this.parts.push(b); return this; }
  u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n), 0); this.parts.push(b); return this; }
  raw(buf) { this.parts.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); return this; }
  str(s) { const b = Buffer.from(String(s), "utf8"); return this.u32(b.length).raw(b); }
  bytes(buf) { return this.u32(buf.length).raw(buf); }
  mpint(buf) {
    let b = Buffer.from(buf);
    let i = 0; while (i < b.length && b[i] === 0) i++;
    b = b.subarray(i);
    if (b.length && b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return this.bytes(b.length ? b : Buffer.from([0]));
  }
  names(list) { return this.str(list.join(",")); }
  done() { return Buffer.concat(this.parts); }
}

class BufR {
  constructor(buf, off = 0) { this.b = buf; this.o = off; }
  byte() { return this.b[this.o++]; }
  u32() { const v = this.b.readUInt32BE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64BE(this.o); this.o += 8; return Number(v); }
  raw(n) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  bytes() { return this.raw(this.u32()); }
  str() { return this.bytes().toString("utf8"); }
}

/* ---- DER 小工具（RSA/ed25519 公钥包装） ---- */
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
}
function derSeq(...parts) { const c = Buffer.concat(parts); return Buffer.concat([Buffer.from([0x30]), derLen(c.length), c]); }
function derInt(b) {
  if (b.length && b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return Buffer.concat([Buffer.from([0x02]), derLen(b.length), b]);
}
function rsaSpkiDer(n, e) {
  const inner = derSeq(derInt(n), derInt(e));
  const alg = Buffer.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const bitstr = Buffer.concat([Buffer.from([0x03]), derLen(inner.length + 1), Buffer.from([0]), inner]);
  return derSeq(alg, bitstr);
}
const ED25519_SPKI_PREFIX = Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
const X25519_SPKI_PREFIX = Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00]);

class SshSession {
  constructor(s) {
    this.net = needNode("net", "SFTP");
    this.crypto = needNode("crypto", "SFTP");
    // 与 FTP 同一套端口口径：端口框 > 地址里的 host:port > 22（不这么解析时 [::1] 会被当成主机名，DNS 必挂）
    const hp = hostPortOf(s.server, s.port, "sftp");
    this.host = hp.host; this.port = hp.port; this.displayHost = hp.displayHost;
    this.user = s.username; this.pass = s.password;
    this.hostKeys = null; // TOFU 存储（由插件注入 {get, set}）
    this.seqIn = 0; this.seqOut = 0;
    this.kexStrict = false;  // 服务器是否带 kex-strict-s 标记（handshake 里判定）
    this.encIn = false; this.encOut = false;
    this.pendingIn = false; this.pendingOut = false;   // NEWKEYS 已发/已收，等待切换密钥
    this.buf = Buffer.alloc(0);
    this._inPlain = null;    // 非 EtM 分帧时「已解出但整包还没收齐」的首块明文
    this.vClient = "SSH-2.0-siyuan-netglimmer-upload_1.0";
    this.vServer = "";
    this.handlers = {};      // 握手阶段包处理器
    this._early = {};        // 早于 _wait 注册到达的报文缓存
    this.chIn = null; this.chOut = 0;
    this.peerWin = 0; this.peerMax = 32768; this.winWaiters = [];
    this.ourWin = 1 << 21; this.ourMax = 32768;
    this.sftpBuf = Buffer.alloc(0); this.sftpReq = new Map(); this.reqId = 1;
    this.sftpVersion = 0;
    this.closed = null;      // Promise：连接断开时 resolve，用于唤醒等待者
    this._closeResolve = null;
  }

  /* ---------- 传输层 ---------- */

  connect() {
    return new Promise((resolve, reject) => {
      const sock = this.net.connect({ host: this.host, port: this.port });
      sock.setTimeout(30000);
      sock.once("error", (e) => { this.fail(e); reject(e); });
      this.sock = sock;
      this.closed = new Promise((r) => { this._closeResolve = r; });
      let bannerDone = false;
      const onBanner = (d) => {
        if (bannerDone) { this._onData(d); return; }
        this.buf = Buffer.concat([this.buf, d]);
        let off = 0;
        let found = false;
        while (true) {
          const j = this.buf.indexOf(0x0a, off);
          if (j < 0) break;
          const line = this.buf.subarray(off, j).toString("utf8").replace(/\r$/, "");
          off = j + 1;
          if (line.startsWith("SSH-")) { this.vServer = line; found = true; break; }
        }
        if (!found) return;
        bannerDone = true;
        this.buf = this.buf.subarray(off);
        sock.write(this.vClient + "\r\n");
        sock.setTimeout(0);
        sock.removeListener("error", reject);
        if (this.buf.length) this._onData(Buffer.alloc(0));
        resolve();
      };
      sock.on("data", onBanner);
      sock.on("close", () => { this.fail(new Error("SSH 连接被关闭")); });
      sock.on("end", () => { this.fail(new Error("SSH 连接被关闭")); });
    });
  }

  fail(err) {
    if (this._failed) return;
    // 会话级失败：后续所有请求都会带上这个错误，标记 connLost 让上层重试前先重连
    try { err.connLost = true; } catch (e) { /* 冻结对象 */ }
    this._failed = err;
    /* 在途请求一律叫醒，并且把它们各自挂着的 120 秒计时器一起拆掉。
     * 只 reject 不拆表的话，连接断了以后那些计时器还挂在事件循环上：一次发布里
     * 并发 8 路、每路几个在途请求，断开后就是几十个「没人再认领」的定时任务，
     * 每条还带着 id 与 promise 的引用不放——思源的渲染进程要等它们各自走完 120 秒
     * 才安静下来，表现出来就是「断线以后界面卡一会儿」。 */
    for (const [, w] of this.sftpReq) {
      try { clearTimeout(w.timer); } catch (e) { /* noop */ }
      w.reject(err);
    }
    this.sftpReq.clear();
    if (this._versionWaiter) {
      const w = this._versionWaiter;
      this._versionWaiter = null;
      w.reject(err);
    }
    for (const k of Object.keys(this.handlers)) {
      if (this.handlers[k] && this.handlers[k].reject) { this.handlers[k].reject(err); }
    }
    while (this.winWaiters.length) this.winWaiters.shift().reject(err);
    if (this._closeResolve) this._closeResolve();
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    // 逐包解析（循环直到缓冲区不足以构成一个完整包）
    while (true) {
      const macLen = this.macIn ? this.macInLen : 0;
      // 非 EtM 时包长本身也在密文里，必须先解出一个整块才能知道整包多长。
      // CTR 是流密码，喂进 cipher 的字节不能重喂，所以这一块的明文跨次调用
      // 暂存在 _inPlain（TCP 段可能在块中间就断掉）。
      const nonEtm = this.encIn && !this.etmIn;
      if (nonEtm) {
        if (this.buf.length < SSH_BLOCK) return;
        if (!this._inPlain) this._inPlain = this.decipher.update(this.buf.subarray(0, SSH_BLOCK));
      } else if (this.buf.length < 4) return;
      const len = nonEtm ? this._inPlain.readUInt32BE(0) : this.buf.readUInt32BE(0);
      if (len > 256 * 1024) { try { this.sock.destroy(); } catch (e) {} this.fail(new Error("SSH 包长异常 " + len)); return; }
      const total = 4 + len + macLen;
      if (this.buf.length < total) return;
      const packet = this.buf.subarray(0, total);
      this.buf = this.buf.subarray(total);
      const held = this._inPlain; this._inPlain = null;
      let payload;
      try {
        if (!this.encIn) {
          const padLen = packet[4];
          payload = packet.subarray(5, 4 + len - padLen);
        } else if (this.etmIn) {
          const body = packet.subarray(4, 4 + len);
          const mac = packet.subarray(4 + len);
          const h = this.crypto.createHmac(this.macIn, this.kIn);
          const sb = Buffer.alloc(4); sb.writeUInt32BE(this.seqIn >>> 0, 0);
          h.update(sb); h.update(packet.subarray(0, 4)); h.update(body);
          if (!this.crypto.timingSafeEqual(h.digest(), mac)) throw new Error("SSH MAC 校验失败(etm)");
          const dec = this.decipher.update(body);
          payload = dec.subarray(1, len - dec[0]);
        } else {
          // 非 EtM：长度域参与加密，MAC 覆盖的是「序号 + 明文包」（RFC 4253 6.1），
          // 所以先把整包解完再对明文算 MAC——顺序与 EtM 分支正好相反。
          const mac = packet.subarray(4 + len);
          if ((4 + len) % SSH_BLOCK !== 0) throw new Error("SSH 包长未按块对齐（非 EtM）");
          const plain = Buffer.concat([held, this.decipher.update(packet.subarray(SSH_BLOCK, 4 + len))]);
          const h = this.crypto.createHmac(this.macIn, this.kIn);
          const sb = Buffer.alloc(4); sb.writeUInt32BE(this.seqIn >>> 0, 0);
          h.update(sb); h.update(plain);
          if (!this.crypto.timingSafeEqual(h.digest(), mac)) throw new Error("SSH MAC 校验失败");
          payload = plain.subarray(5, 4 + len - plain[4]);
        }
      } catch (e) { this.fail(e); try { this.sock.destroy(); } catch (e2) {} return; }
      this.seqIn = (this.seqIn + 1) >>> 0;
      const type = payload[0];
      // 收到对端明文 NEWKEYS 后，同一 TCP 段里紧随的报文已是加密的：
      // 必须在分发当前包之后、处理下一包之前立刻切换接收密钥。
      if (this.pendingIn && type === SSH_MSG.NEWKEYS) this._switchIn();
      this._dispatch(type, payload.subarray(1));
      // NEWKEYS 已到达但 _finishKex 尚未武装好切换函数：暂停解析，避免把
      // 同一 TCP 段里紧随其后的加密报文当成明文解析。
      if (type === SSH_MSG.NEWKEYS && !this.encIn && !this._switchIn) this.pausedForArmed = true;
      if (this.pausedForArmed) return;
    }
  }

  _send(type, payloadBuf) {
    if (this._failed) throw this._failed;
    const pl = Buffer.concat([Buffer.from([type]), payloadBuf || Buffer.alloc(0)]);
    // OpenSSH 收端强制对齐校验（need % block === 0），与 OpenSSH 发端算法一致：
    // block：未加密=8，AES-CTR=16；EtM/AEAD 时 4 字节长度域不计入需对齐部分。
    const block = this.encOut ? 16 : 8;
    const aad = (this.encOut && this.etmOut) ? 4 : 0;
    const base = 4 + 1 + pl.length - aad;
    let pad = block - (base % block);
    if (pad < 4) pad += block;
    const padding = this.crypto ? this.crypto.randomBytes(pad) : Buffer.alloc(pad);
    const len = 1 + pl.length + pad;
    const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(len, 0);
    let body = Buffer.concat([Buffer.from([pad]), pl, padding]);
    let packet;
    if (!this.encOut) {
      packet = Buffer.concat([lenBuf, body]);
    } else if (this.etmOut) {
      // EtM：长度字段明文，其余加密
      packet = Buffer.concat([lenBuf, this.cipher.update(body)]);
    } else {
      // 非 EtM：长度字段一并加密
      packet = this.cipher.update(Buffer.concat([lenBuf, body]));
    }
    let mac = Buffer.alloc(0);
    if (this.macOut) {
      const h = this.crypto.createHmac(this.macOut, this.kOut);
      const sb = Buffer.alloc(4); sb.writeUInt32BE(this.seqOut >>> 0, 0);
      h.update(sb);
      // EtM 覆盖「明文本 + 密文本」；非 EtM 按 RFC 4253 6.4「computed before
      // encryption」覆盖整个明文包（len 字段 + padding_length + payload + padding），
      // 收端解完密再比对——两侧口径必须一致，否则第一颗加密报文就 mac incorrect。
      if (this.etmOut) { h.update(lenBuf); h.update(packet.subarray(4)); }
      else { h.update(lenBuf); h.update(body); }
      mac = h.digest();
    }
    this.seqOut = (this.seqOut + 1) >>> 0;
    this.sock.write(Buffer.concat([packet, mac]));
    // NEWKEYS 用旧参数发出后，本方向立即切换到新密钥
    if (this.pendingOut && type === SSH_MSG.NEWKEYS) this._switchOut();
  }

  _dispatch(type, payload) {
    if (type === SSH_MSG.IGNORE || type === SSH_MSG.DEBUG || type === SSH_MSG.EXT_INFO || type === SSH_MSG.USERAUTH_BANNER) return;
    if (type === SSH_MSG.DISCONNECT) {
      const r = new BufR(payload); const code = r.u32(); const desc = r.str();
      this.fail(new Error(`SSH 断开(${code}): ${desc}`));
      return;
    }
    if (type === SSH_MSG.GLOBAL_REQUEST) {
      const r = new BufR(payload); r.str(); const want = r.byte();
      if (want) this._send(SSH_MSG.REQUEST_FAILURE, Buffer.alloc(0));
      return;
    }
    if (type === SSH_MSG.CHANNEL_WINDOW_ADJUST) {
      const r = new BufR(payload); r.u32(); this.peerWin += r.u32();
      while (this.winWaiters.length && this.peerWin > 0) this.winWaiters.shift().resolve();
      return;
    }
    if (type === SSH_MSG.CHANNEL_DATA) {
      const r = new BufR(payload); r.u32(); const data = r.bytes();
      this._consumeWin(data.length);
      this.sftpBuf = Buffer.concat([this.sftpBuf, data]);
      this._pumpSftp();
      return;
    }
    if (type === SSH_MSG.CHANNEL_EOF || type === SSH_MSG.CHANNEL_CLOSE) {
      this.fail(new Error(type === SSH_MSG.CHANNEL_EOF ? "SSH 通道 EOF" : "SSH 通道关闭"));
      return;
    }
    if (type === SSH_MSG.CHANNEL_OPEN_FAIL) {
      const r = new BufR(payload); r.u32(); r.u32(); const desc = r.str();
      this.fail(new Error("SSH 通道打开失败: " + desc));
      return;
    }
    const h = this.handlers[type];
    if (h && h.resolve) { this.handlers[type] = null; h.resolve(payload); }
    else { (this._early[type] || (this._early[type] = [])).push(payload); }
  }

  _wait(type, timeout = 20000) {
    if (this._early[type] && this._early[type].length) {
      const p = this._early[type].shift();
      return Promise.resolve(p);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (this.handlers[type] && this.handlers[type].reject) { this.handlers[type] = null; reject(new Error(`SSH 等待报文 ${type} 超时`)); }
      }, timeout);
      this.handlers[type] = {
        resolve: (p) => { clearTimeout(t); resolve(p); },
        reject: (e) => { clearTimeout(t); reject(e); },
      };
      this.closed.then(() => {
        if (this.handlers[type] && this.handlers[type].reject) { const hh = this.handlers[type]; this.handlers[type] = null; hh.reject(this._failed || new Error("连接关闭")); }
      });
    });
  }

  /* ---------- KEX ---------- */

  async handshake() {
    // KEXINIT
    this.kex = {
      curve: null, hostKeyAlg: null, cipher: null, mac: null, etm: false,
    };
    const serverInit = this._wait(SSH_MSG.KEXINIT, 15000);
    this._send(SSH_MSG.KEXINIT, this._clientKexInit());
    const siPayload = await serverInit;
    this.iClient = this._clientKexInitDone;
    this.iServer = siPayload;
    const si = new BufR(siPayload);
    si.raw(16);
    const readNames = () => si.str().split(",");
    const sKex = readNames(), sHost = readNames(), sC2s = readNames(), sS2c = readNames(),
      sMacC2s = readNames(), sMacS2c = readNames();
    const pick = (mine, theirs) => mine.find((m) => theirs.includes(m)) || null;
    // 严格 KEX 是双向承诺：只有服务器也带 kex-strict-s 标记，双方才在 NEWKEYS 后
    // 把序号归零。不支持的老服务器（OpenSSH < 7.8、部分 NAS 里的 libssh/Dropbear）
    // 自己不会归零，我们若单方面归零，第一颗加密报文就 "mac incorrect"——
    // 这正是原来硬编码归零的兼容性缺陷。
    this.kexStrict = sKex.includes("kex-strict-s-v00@openssh.com");
    this.kex.curve = pick(["curve25519-sha256", "curve25519-sha256@libssh.org", "ecdh-sha2-nistp256"], sKex);
    this.kex.hostKeyAlg = pick(["ssh-ed25519", "rsa-sha2-512", "rsa-sha2-256", "ssh-rsa", "ecdsa-sha2-nistp256"], sHost);
    if (!this.kex.hostKeyAlg) throw new Error("SSH 算法协商失败：无共同主机密钥算法（服务器 " + sHost.join("/") + "）");
    this.kex.cipher = pick(["aes128-ctr", "aes256-ctr", "aes192-ctr"], sC2s) && pick(["aes128-ctr", "aes256-ctr", "aes192-ctr"], sS2c);
    const cipherSame = pick(["aes128-ctr", "aes256-ctr", "aes192-ctr"], sC2s) === pick(["aes128-ctr", "aes256-ctr", "aes192-ctr"], sS2c) ? this.kex.cipher : null;
    if (!this.kex.cipher || !cipherSame) throw new Error("SSH 算法协商失败：无共同 CTR 加密算法（服务器 " + sS2c.join("/") + "）");
    const macPick = pick(["hmac-sha2-256-etm@openssh.com", "hmac-sha2-512-etm@openssh.com", "hmac-sha2-256", "hmac-sha2-512"], sMacC2s);
    const macPick2 = pick(["hmac-sha2-256-etm@openssh.com", "hmac-sha2-512-etm@openssh.com", "hmac-sha2-256", "hmac-sha2-512"], sMacS2c);
    if (!macPick || !macPick2 || macPick !== macPick2) throw new Error("SSH 算法协商失败：无共同 HMAC 算法");
    this.kex.mac = macPick;
    this.kex.etm = macPick.includes("-etm");
    if (!this.kex.curve) throw new Error("SSH 算法协商失败：无共同 KEX 算法");

    // ECDH 交换（curve25519 与 nistp256 用 KEX_ECDH_INIT/REPLY=30/31；
    // 传统 KEX_DH（diffie-hellman-group*）用 KEXDH_INIT/REPLY=34/33。
    // 本客户端只提案 ECDH 类算法，故 reply 类型跟 curve 走。）
    const isEcdh = this.kex.curve.startsWith("curve25519") || this.kex.curve.startsWith("ecdh-sha2");
    const initType = isEcdh ? SSH_MSG.KEX_ECDH_INIT : SSH_MSG.KEXDH_INIT;
    const replyType = isEcdh ? SSH_MSG.KEX_ECDH_REPLY : SSH_MSG.KEXDH_REPLY;
    const reply = this._wait(replyType, 15000);
    let qClient, shared, priv;
    if (this.kex.curve.startsWith("curve25519")) {
      const kp = this.crypto.generateKeyPairSync("x25519");
      priv = kp.privateKey;
      qClient = Buffer.from(kp.publicKey.export({ format: "jwk" }).x, "base64url");
      this._send(initType, new BufW().bytes(qClient).done());
      const r = new BufR(await reply);
      const k_s = r.bytes(); const q_s = r.bytes(); const sigBlob = r.bytes();
      shared = this.crypto.diffieHellman({
        privateKey: priv,
        publicKey: this.crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, q_s]), format: "der", type: "spki" }),
      });
      await this._finishKex(k_s, qClient, q_s, shared, sigBlob);
    } else {
      const ecdh = this.crypto.createECDH("prime256v1");
      ecdh.generateKeys();
      qClient = ecdh.getPublicKey(); // 0x04||X||Y
      this._send(initType, new BufW().bytes(qClient).done());
      const r = new BufR(await reply);
      const k_s = r.bytes(); const q_s = r.bytes(); const sigBlob = r.bytes();
      shared = ecdh.computeSecret(q_s);
      await this._finishKex(k_s, qClient, q_s, shared, sigBlob);
    }
  }

  _clientKexInit() {
    const w = new BufW();
    w.raw(this.crypto.randomBytes(16));
    w.names(["curve25519-sha256", "curve25519-sha256@libssh.org", "ecdh-sha2-nistp256",
      // OpenSSH 严格 KEX 与 ext-info 协商标记：服务端据此在 NEWKEYS 后把收发
      // 序号归零（MAC 输入含序号，不归零会导致 "mac incorrect"）
      "kex-strict-c-v00@openssh.com", "ext-info-c"]);
    w.names(["ssh-ed25519", "rsa-sha2-512", "rsa-sha2-256", "ssh-rsa", "ecdsa-sha2-nistp256"]);
    w.names(["aes128-ctr", "aes256-ctr", "aes192-ctr"]);
    w.names(["aes128-ctr", "aes256-ctr", "aes192-ctr"]);
    w.names(["hmac-sha2-256-etm@openssh.com", "hmac-sha2-512-etm@openssh.com", "hmac-sha2-256", "hmac-sha2-512"]);
    w.names(["hmac-sha2-256-etm@openssh.com", "hmac-sha2-512-etm@openssh.com", "hmac-sha2-256", "hmac-sha2-512"]);
    w.names(["none"]); w.names(["none"]);
    w.names([]); w.names([]);
    w.bool(false); w.u32(0);
    this._clientKexInitDone = w.done();
    return this._clientKexInitDone;
  }

  async _finishKex(kS, qC, qS, shared, sigBlob) {
    const hash = this.crypto.createHash("sha256");
    const strB = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length, 0); return Buffer.concat([l, b]); };
    hash.update(strB(Buffer.from(this.vClient)));
    hash.update(strB(Buffer.from(this.vServer)));
    // KEXINIT 报文按「len+1 与 type 字节 + 其余载荷」参与哈希（OpenSSH 的 fake header 规则）
    const kexinitBlob = (p) => Buffer.concat([Buffer.from([SSH_MSG.KEXINIT]), p]);
    hash.update(strB(kexinitBlob(this.iClient)));
    hash.update(strB(kexinitBlob(this.iServer)));
    hash.update(strB(kS));
    hash.update(strB(qC));
    hash.update(strB(qS));
    hash.update(strB(this._mpint(shared)));
    const H = hash.digest();
    this.sessionId = H;
    // 验证主机密钥签名
    await this._verifyHostKey(kS, sigBlob, H);
    // 派生密钥（必须在发送 NEWKEYS 之前就位：对端可能在收到我们 NEWKEYS 后
    // 立刻发出加密报文，若此时尚未切换加密会解析失败）
    const cipherLen = { "aes128-ctr": 16, "aes256-ctr": 32, "aes192-ctr": 24 }[this.kex.cipher];
    const macName = this.kex.mac;
    const macLen = /sha2-256/.test(macName) ? 32 : 64;
    this.macInLen = macLen;
    const derive = (ch, len) => {
      let out = Buffer.alloc(0);
      let prev = Buffer.alloc(0);
      while (out.length < len) {
        const h = this.crypto.createHash("sha256");
        // K 以 mpint（含 4 字节长度前缀）参与派生，与 kex_hash 中的编码一致
        const kb = this._mpint(shared);
        h.update(strB(kb)); h.update(H); h.update(Buffer.from([ch])); h.update(this.sessionId);
        if (prev.length) h.update(prev);
        prev = h.digest();
        out = Buffer.concat([out, prev]);
      }
      return out.subarray(0, len);
    };
    // RFC 4253 7.1：A/B=IV c2s/s2c，C/D=密钥 c2s/s2c，E/F=MAC 密钥 c2s/s2c
    const ivC = derive(65, 16), ivS = derive(66, 16), kC = derive(67, cipherLen), kS2 = derive(68, cipherLen),
      mC = derive(69, macLen), mS = derive(70, macLen);
    const nodeCipher = SSH_CIPHER_TO_NODE[this.kex.cipher];
    if (!nodeCipher) throw new Error("不支持的 SSH 加密算法: " + this.kex.cipher);
    const macSsh = this.kex.mac.replace("-etm@openssh.com", "");
    const nodeMac = SSH_MAC_TO_NODE[macSsh];
    if (!nodeMac) throw new Error("不支持的 SSH MAC 算法: " + this.kex.mac);
    const cipher = this.crypto.createCipheriv(nodeCipher, kC, ivC);
    const decipher = this.crypto.createDecipheriv(nodeCipher, kS2, ivS);
    const etm = this.kex.etm;
    // NEWKEYS 报文本身仍用旧（明文）参数收发；各自的新密钥在对应方向的
    // NEWKEYS 跨过之后才生效（_send / _onData 中调用）。
    this._switchOut = () => {
      this.cipher = cipher; this.macOut = nodeMac; this.kOut = mC;
      this.etmOut = etm; this.encOut = true;
      // 序号只在协商了严格 KEX 时归零（见 handshake 里的 kexStrict）
      this.seqOut = seqAfterNewKeys(this.kexStrict, this.seqOut);
      this.pendingOut = false;
    };
    this._switchIn = () => {
      this.decipher = decipher; this.macIn = nodeMac; this.kIn = mS;
      this.etmIn = etm; this.encIn = true; this._inPlain = null;
      this.seqIn = seqAfterNewKeys(this.kexStrict, this.seqIn);
      this.pendingIn = false;
    };
    this.pendingOut = true; this.pendingIn = true;
    if (this.pausedForArmed) {
      // 对端的 NEWKEYS 比我们的切换逻辑到得早（同一 TCP 段），立即生效
      this.pausedForArmed = false; this.pendingIn = false; this._switchIn();
    }
    const nk = this._wait(SSH_MSG.NEWKEYS, 15000);
    this._send(SSH_MSG.NEWKEYS, Buffer.alloc(0));
    await nk;
    if (this.pausedForArmed) this.pausedForArmed = false;
    if (this.buf.length) this._onData(Buffer.alloc(0));   // 继续解析暂停期间积压的报文
  }

  _mpint(buf) {
    let b = Buffer.from(buf);
    let i = 0; while (i < b.length && b[i] === 0) i++;
    b = b.subarray(i);
    if (b.length && b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return b.length ? b : Buffer.from([0]);
  }

  async _verifyHostKey(kS, sigBlob, H) {
    const r = new BufR(kS);
    const alg = r.str();
    const sr = new BufR(sigBlob);
    const sigAlg = sr.str(); const sig = sr.bytes();
    /* 密钥类型与签名算法必须三者一致（协商值 = 密钥 blob 里的 = 签名 blob 里的）。
     * 少了这道校验，服务器就能在协商 rsa-sha2-512 之后回一份 SHA-1 的 ssh-rsa 签名：
     * 我们照样验得过（下面按 sigAlg 选摘要），等于把 KEX 的完整性悄悄降级到已被
     * 碰撞攻击打穿的 SHA-1——OpenSSH 8.8 正是因为这个才默认关掉 ssh-rsa。
     * 落在我们提案列表里的算法名都自洽：ssh-ed25519 / rsa-sha2-* / ecdsa-sha2-nistp256
     * 三者同名；只有老服务器的 ssh-rsa 用 SHA-1，那也是协商出来的明牌降级。 */
    if (alg !== this.kex.hostKeyAlg || sigAlg !== this.kex.hostKeyAlg) {
      throw new Error(`SSH 主机密钥算法不一致：协商 ${this.kex.hostKeyAlg}，密钥 ${alg}，签名 ${sigAlg}（可能是中间人或服务器实现有误）`);
    }
    let pub = null;
    if (alg === "ssh-ed25519") {
      pub = this.crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, r.bytes()]), format: "der", type: "spki" });
    } else if (alg === "ssh-rsa" || alg === "rsa-sha2-256" || alg === "rsa-sha2-512") {
      const e = r.bytes(); const n = r.bytes();
      pub = this.crypto.createPublicKey({ key: rsaSpkiDer(n, e), format: "der", type: "spki" });
    } else if (alg === "ecdsa-sha2-nistp256") {
      r.str(); // curve 名
      const q = r.bytes(); // 0x04||X||Y
      pub = this.crypto.createPublicKey({
        key: { kty: "EC", crv: "P-256", x: q.subarray(1, 33).toString("base64url"), y: q.subarray(33, 65).toString("base64url") },
        format: "jwk",
      });
    } else {
      throw new Error("不支持的主机密钥算法: " + alg);
    }
    let ok = false;
    try {
      if (sigAlg === "ssh-ed25519") ok = this.crypto.verify(null, H, pub, sig);
      else if (sigAlg === "rsa-sha2-512") ok = this.crypto.verify("sha512", H, { key: pub, padding: this.crypto.constants ? 1 : 1 }, sig);
      else if (sigAlg === "rsa-sha2-256" || sigAlg === "ssh-rsa") ok = this.crypto.verify(sigAlg === "ssh-rsa" ? "sha1" : "sha256", H, pub, sig);
      else if (sigAlg === "ecdsa-sha2-nistp256") ok = this.crypto.verify("sha256", H, pub, sig);
    } catch (e) { ok = false; }
    if (!ok) throw new Error("SSH 主机密钥签名验证失败（中间人风险或算法不匹配）");
    // TOFU：记录/比对指纹
    const fp = this.crypto.createHash("sha256").update(kS).digest("base64").slice(0, 43);
    this.hostFingerprint = "SHA256:" + fp;
    if (this.hostKeys) {
      const key = (this.displayHost || this.host) + ":" + this.port;
      const saved = this.hostKeys.get(key);
      if (saved && saved !== this.hostFingerprint) {
        throw new Error(`服务器指纹变化！保存 ${saved}，本次 ${this.hostFingerprint}——若服务器确已重装请清除插件设置中的 known_hosts`);
      }
      if (!saved) this.hostKeys.set(key, this.hostFingerprint);
    }
  }

  /* ---------- 认证与会话 ---------- */

  async authPassword() {
    const acc = this._wait(SSH_MSG.SERVICE_ACCEPT, 15000);
    this._send(SSH_MSG.SERVICE_REQUEST, new BufW().str("ssh-userauth").done());
    await acc;
    const authed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handlers[SSH_MSG.USERAUTH_SUCCESS] = null;
        this.handlers[SSH_MSG.USERAUTH_FAILURE] = null;
        reject(new Error("SSH 认证超时"));
      }, 20000);
      this.handlers[SSH_MSG.USERAUTH_SUCCESS] = {
        reject,
        resolve: () => { clearTimeout(timer); this.handlers[SSH_MSG.USERAUTH_FAILURE] = null; resolve(true); },
      };
      this.handlers[SSH_MSG.USERAUTH_FAILURE] = {
        reject,
        resolve: (p) => {
          clearTimeout(timer); this.handlers[SSH_MSG.USERAUTH_SUCCESS] = null;
          const r = new BufR(p); r.str(); const partial = r.byte();
          reject(new Error(partial ? "SSH 认证需要额外步骤（键盘交互等），本插件仅支持密码认证" : "SSH 认证失败：用户名或密码错误"));
        },
      };
    });
    this._send(SSH_MSG.USERAUTH_REQUEST,
      new BufW().str(this.user).str("ssh-connection").str("password").bool(false).str(this.pass).done());
    await authed;
  }

  async openSftp() {
    const conf = this._wait(SSH_MSG.CHANNEL_OPEN_CONF, 15000);
    this._send(SSH_MSG.CHANNEL_OPEN, new BufW().str("session").u32(this.chOut).u32(this.ourWin).u32(this.ourMax).done());
    const p = new BufR(await conf);
    p.u32(); this.chIn = p.u32();
    this.peerWin = p.u32(); this.peerMax = p.u32();
    const reqOk = this._wait(SSH_MSG.CHANNEL_SUCCESS, 15000);
    this._send(SSH_MSG.CHANNEL_REQUEST,
      new BufW().u32(this.chIn).str("subsystem").bool(true).str("sftp").done());
    await reqOk;
    const got = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SFTP INIT 等待超时")), 15000);
      /* reject 也负责拆表：连接断开时 fail() 走的是这里，不拆的话 15 秒那条计时器
       * 还在，而 awaiting 方已经拿到 rejection 了——白等一场还占着引用。 */
      this._versionWaiter = {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
    const initPkt = Buffer.concat([Buffer.from([FXP.INIT]), u32(3)]);
    await this._sendChannelData(Buffer.concat([u32(initPkt.length), initPkt]));
    this.sftpVersion = await got;
    if (this.sftpVersion < 3) throw new Error("服务器 SFTP 版本过低: " + this.sftpVersion);
  }

  /* ---------- 通道数据 ---------- */

  _consumeWin(n) {
    this.ourWin -= n;
    if (this.ourWin < (1 << 19)) {
      const add = (1 << 21) - this.ourWin;
      this.ourWin += add;
      this._send(SSH_MSG.CHANNEL_WINDOW_ADJUST, new BufW().u32(this.chIn).u32(add).done());
    }
  }

  async _sendChannelData(payload) {
    let off = 0;
    while (off < payload.length) {
      while (this.peerWin <= 0) {
        await new Promise((resolve, reject) => {
          this.winWaiters.push({ resolve, reject });
          this.closed.then(() => reject(this._failed || new Error("连接关闭")));
        });
      }
      const n = Math.min(payload.length - off, this.peerWin, this.peerMax, 16384);
      const chunk = payload.subarray(off, off + n);
      this.peerWin -= chunk.length;
      this._send(SSH_MSG.CHANNEL_DATA, new BufW().u32(this.chIn).bytes(chunk).done());
      off += n;
    }
  }

  _pumpSftp() {
    while (this.sftpBuf.length >= 4) {
      const len = this.sftpBuf.readUInt32BE(0);
      if (len > 8 * 1024 * 1024) { this.fail(new Error("SFTP 包长异常")); return; }
      if (this.sftpBuf.length < 4 + len) return;
      const pkt = this.sftpBuf.subarray(4, 4 + len);
      this.sftpBuf = this.sftpBuf.subarray(4 + len);
      const type = pkt[0];
      if (type === FXP.VERSION) {
        if (this._versionWaiter) {
          const w = this._versionWaiter; this._versionWaiter = null;
          w.resolve(new BufR(pkt, 1).u32());
        }
        continue;
      }
      const id = new BufR(pkt, 1).u32();
      const w = this.sftpReq.get(id);
      if (w) {
        this.sftpReq.delete(id);
        clearTimeout(w.timer);
        w.resolve({ type, body: pkt.subarray(5) }); // body = STATUS/NAME 等字段（去掉 type+id）
      }
    }
  }

  /* 发送 SFTP 请求并等待响应；返回 {type, r} 或 STATUS 的 {code, r, err} */
  async _request(type, w) {
    if (this._failed) throw this._failed;
    const id = this.reqId++;
    const pkt = Buffer.concat([Buffer.from([type]), u32(id), w.done()]);
    const data = Buffer.concat([u32(pkt.length), pkt]);
    let timer = null;
    const p = new Promise((resolve, reject) => {
      timer = setTimeout(() => { this.sftpReq.delete(id); reject(new Error(`SFTP 请求超时 (type ${type})`)); }, 120000);
      this.sftpReq.set(id, { resolve, reject, timer });
    });
    /* 发不出去（窗口耗尽后连接断了、_send 抛错）时这条请求永远不会有人应答：
     * 当场把计时器和登记一起撤掉，别留一个 120 秒后对着不存在的 id 空转的定时器。 */
    try {
      await this._sendChannelData(data);
    } catch (e) {
      this.sftpReq.delete(id);
      clearTimeout(timer);
      throw e;
    }
    const resp = await p;
    const r = new BufR(resp.body);
    if (resp.type === FXP.STATUS) {
      const code = r.u32(); const msg = r.str();
      const err = (code === FXP_STATUS_OK || code === FXP_STATUS_EOF)
        ? null : Object.assign(new Error(`SFTP 错误 ${code}: ${msg}`), { sftpCode: code });
      return { type: FXP.STATUS, code, r, err };
    }
    return { type: resp.type, r };
  }

  /* ---------- SFTP v3 高层操作 ---------- */

  static _attrs(w, opts = {}) {
    // SFTP v3 ATTRS 标志：SIZE=0x1 UIDGID=0x2 PERMISSIONS=0x4 ACMODTIME=0x8 EXTENDED=0x80000000
    let flags = 0;
    if (opts.size != null) flags |= 0x1;
    if (opts.mode != null) flags |= 0x4;
    w.u32(flags);
    if (opts.size != null) w.u64(opts.size);
    if (opts.mode != null) w.u32(opts.mode);
    return w;
  }

  static _readAttrs(r) {
    const flags = r.u32();
    const a = { size: -1, mode: 0 };
    if (flags & 0x1) a.size = r.u64();
    if (flags & 0x2) { r.u32(); r.u32(); } // uid, gid
    if (flags & 0x4) a.mode = r.u32();
    if (flags & 0x8) { r.u32(); r.u32(); } // atime, mtime
    return a;
  }

  async realpath(p) {
    const res = await this._request(FXP.REALPATH, new BufW().str(p));
    if (res.err) throw res.err;
    if (res.type !== FXP.NAME) throw new Error("REALPATH 应答异常");
    res.r.u32(); // count
    return res.r.str();
  }

  async stat(path) {
    const res = await this._request(FXP.STAT, new BufW().str(path));
    if (res.err) { if (res.code === 2) return null; throw res.err; } // 2 = NO_SUCH_FILE
    if (res.type !== FXP.ATTRS) throw new Error("STAT 应答异常");
    const a = SshSession._readAttrs(res.r);
    return { size: a.size, isDir: (a.mode & 0x4000) !== 0 };
  }

  async mkdir(path) {
    // RFC draft-ietf-secsh-filexfer-02 §6.3：FXP_MKDIR = path + ATTRS，
    // 缺 path 会让 sftp-server 以协议错误退出。
    const res = await this._request(FXP.MKDIR, SshSession._attrs(new BufW().str(path), { mode: 0x41ED }));
    if (res.err && res.code !== 11 /* ALREADY_EXISTS */) throw res.err;
  }

  async remove(path) {
    const res = await this._request(FXP.REMOVE, new BufW().str(path));
    if (res.err && res.code !== 2) throw res.err;
  }

  async rmdir(path) {
    const res = await this._request(FXP.RMDIR, new BufW().str(path));
    if (res.err && res.code !== 2 && res.code !== 39 /* NOT_EMPTY */) throw res.err;
  }

  async opendir(path) {
    const res = await this._request(FXP.OPENDIR, new BufW().str(path));
    if (res.err) throw res.err;
    if (res.type !== FXP.HANDLE) throw new Error("OPENDIR 应答异常");
    return res.r.bytes();
  }

  /* 一次 READDIR；EOF 返回 null */
  async readdir(handle) {
    const res = await this._request(FXP.READDIR, new BufW().bytes(handle));
    if (res.type === FXP.STATUS) {
      if (res.code === FXP_STATUS_EOF) return null;
      throw res.err || new Error("READDIR 状态 " + res.code);
    }
    if (res.type !== FXP.NAME) throw new Error("READDIR 应答异常");
    const count = res.r.u32();
    const items = [];
    for (let i = 0; i < count; i++) {
      const name = res.r.str(); res.r.str(); // longname
      const a = SshSession._readAttrs(res.r);
      if (name !== "." && name !== "..") items.push({ name, size: a.size, isDir: (a.mode & 0x4000) !== 0 });
    }
    return items;
  }

  async closeHandle(handle) {
    try { await this._request(FXP.CLOSE, new BufW().bytes(handle)); } catch (e) { /* noop */ }
  }

  /* 写文件：WRITE|CREAT|TRUNC（0x2|0x8|0x10），分块 ≤ 24KB。
   * WRITE 请求按窗口流水化（默认 8 个在途）——SFTP 每个 WRITE 都要等应答，
   * 单文件几 MB 就是上百个往返，串行在高延迟链路上极慢；流水化后往返数约降一个数量级。 */
  async putFile(path, u8, opts = {}) {
    const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.length);
    // pflags：WRITE(0x2)|CREAT(0x8)|TRUNC(0x10)，覆盖式写入，支持重新发布。
    // 注意 0x4 是 APPEND（追加）不是 TRUNC——必须用 0x10 才能真正截断旧内容。
    const res = await this._request(FXP.OPEN,
      SshSession._attrs(new BufW().str(path).u32(0x2 | 0x8 | 0x10), { mode: 0o100644 }));
    if (res.err) throw res.err;
    if (res.type !== FXP.HANDLE) throw new Error("OPEN 应答异常");
    const handle = res.r.bytes();
    const window = Math.max(1, Math.min(32, opts.window || 8));
    const CH = 24576;
    let off = 0;
    let firstErr = null;
    const inflight = [];
    const drain = async (all) => {
      while (inflight.length && (all || inflight.length >= window)) {
        const w = await inflight.shift();
        if (w.err && !firstErr) { firstErr = w.err; return; }
      }
    };
    try {
      while (off < buf.length && !firstErr) {
        const chunk = buf.subarray(off, off + CH);
        // _request 的两种失败：STATUS 应答带 err（正常返回）/ 连接级异常（reject）。
        // 统一转成 {err} 收进窗口，既能在首个失败时退出，也不会留下未处理的 rejection。
        inflight.push(this._request(FXP.WRITE, new BufW().bytes(handle).u64(off).bytes(chunk))
          .then((w) => w, (e) => ({ err: e })));
        off += chunk.length;
        if (inflight.length >= window) await drain(false);
      }
      await drain(true);
    } finally {
      // 出错提前退出时，把仍在途的请求摘掉，避免未处理的 Promise rejection
      for (const p of inflight) p.catch(() => {});
      inflight.length = 0;
      await this.closeHandle(handle);
    }
    if (firstErr) throw firstErr;
  }

  async disconnect() {
    try { this._send(SSH_MSG.DISCONNECT, new BufW().u32(11).str("bye").str("").done()); } catch (e) { /* noop */ }
    try { this.sock.end(); } catch (e) { /* noop */ }
    try { this.sock.destroy(); } catch (e) { /* noop */ }
    if (!this._failed) this.fail(new Error("连接已关闭"));
  }
}

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }

/* 递归 Depth:1 遍历远端目录，收集 文件URL -> getcontentlength。
 * IIS 的 href 大小写/百分号编码可能与 joinUrl 生成串不同，统一 normalizeKey 比对。 */
function normalizeKey(u) {
  let s = String(u || "").replace(/\/+$/, "");
  /* 服务器地址写成 http://user:pass@host 时（见 redactUrl 那段），请求侧的 URL 带 userinfo，
   * 而 PROPFIND 的 <d:href> 是服务器按「源」回写的、不带 userinfo（davOrigin 用的
   * new URL().origin 同样会丢掉它）。比较键里不摘掉这一段，同一份文件两侧就对不上：
   * 尺寸核对会整排报「远端缺失」，增量发布把每个文件都当新文件重传。本机 nginx 实测。 */
  s = stripUserInfo(s);
  try { s = decodeURIComponent(s); } catch (e) { /* 保留原串 */ }
  return s.toLowerCase();
}

/* 文件系统类路径（FTP / SFTP / 本地目录）的比较键：只削尾斜杠，别的都不动。
 * 与 normalizeKey 的两点差别都是要命的：
 *   · 不折叠大小写——Linux 服务器上 README.md 与 readme.md 是两个文件，折叠成同一个
 *     键之后，增量发布会把「另一个」当成已存在同尺寸而永久跳过，读者看到旧内容；
 *     孤立清理同理，可能删掉对方那一个。
 *   · 不按 URL 解码——这里的串是服务器返回的原始路径，不是百分号编码的 URL。
 *     文件名里真的可以出现 "%20"（"a%20b.png" 与 "a b.png" 是两个名字），
 *     decode 一次就把它们并成一个键了。
 * WebDAV 走 normalizeKey：PROPFIND 的 href 是编码过的 URL，而 IIS 会把大小写换成
 * 它自己那一份（实测），不折叠就比不中。 */
function fsKey(u) { return String(u || "").replace(/\/+$/, ""); }

/* PROPFIND 返回的 <d:href> 有两种写法，两家服务器各用一种（本机实测）：
 *   IIS 10  → 绝对 URL：http://172.16.100.132/wdav-v07-test/.wdav-probe.bin
 *   nginx   → 根相对路径：/nginx-test/WebDAV%E5%8F%91%E5%B8%83%E6%B5%8B%E8%AF%95/f.bin（dav_ext）
 * 任何「把 href 和请求 URL 对齐」的地方都必须先归一到同一形态，
 * 否则在 nginx 上永远匹配不到——探针就会退回去按文本读正文，随机字节被 UTF-8
 * 替换字符撑大（实测 8192B → 16220B），当场误判成「远端尺寸不符」。 */
function davOrigin(server) {
  try { return new URL(server).origin; } catch (e) { return ""; }
}
function absHref(href, server) {
  const h = String(href || "");
  if (!h) return "";
  if (h.startsWith("/")) { const o = davOrigin(server); return o ? o + h : h; }
  return h;
}

async function walkRemoteFiles(settings, url, depth, out) {
  /* 深度上限不是「正常收尾」：第 11 层往下我们没看过，清单是残缺的。
   * 残缺清单里的「没有」会被读回校验与增量预检当成「远端缺失」，
   * 所以必须把 partial 立起来让调用方知道这份结果不可信。 */
  if (depth > 10) { out.partial = true; return out; }
  const r = await davPropfind(settings, url, "1");
  if (r.status !== 207) {
    if (depth === 0) out.status = r.status;
    /* 子目录 PROPFIND 失败——不管什么状态码，这一棵子树我们一个字节都没看见。
     * 只把 5xx/408 算残缺是不够的：403（ACL 挡住/正在被删）与 404（父清单里还挂着、
     * 递归时已经没了）同样是「看不见」，而漏掉的这批文件会同时被判成两处不存在——
     * 校验念成「远端缺失」，孤立文件清单里别的那一份又可能被当成残留删掉。
     * FTP/SFTP/本地三条链路本来就是「子目录列失败一律 partial」，这里口径对齐。 */
    else out.partial = true;
    return out;
  }
  const origin = davOrigin(settings.server);
  const self = url.replace(/\/+$/, "");
  for (const e of r.entries) {
    if (!e.href) continue;
    let child = absHref(e.href, settings.server);
    if (!child.startsWith(origin)) continue;
    const norm = child.replace(/\/+$/, "");
    if (norm === self) continue;
    if (e.isDir) {
      if (!child.endsWith("/")) child += "/";
      await walkRemoteFiles(settings, child, depth + 1, out);
    } else {
      out.files.set(normalizeKey(child), e.size);
      if (out.paths) out.paths.set(normalizeKey(child), child);
    }
  }
  return out;
}

/* 传输探针：PUT 已知大小的随机内容 → PROPFIND 查尺寸 → DELETE。
 * 若本机 forwardProxy/base64 通道有问题（例如 body 被丢弃），第一步就失败，
 * 避免整棵 0 字节目录传上去后还报“发布成功”。 */
async function transportProbe(settings, rootUrl) {
  const N = 8192;
  const buf = new Uint8Array(N);
  for (let i = 0; i < N; i++) buf[i] = (i * 31 + 7) % 251;
  const url = `${rootUrl.replace(/\/+$/, "")}/.wdav-probe-${Date.now()}.bin`;
  await davPut(settings, url, buf);
  let remoteSize = null;
  const pf = await davPropfind(settings, url, "0");
  /* href 形态两家不同（IIS 绝对 URL / nginx 根相对），必须归一后再比，见 absHref 注释 */
  const want = normalizeKey(url);
  const ent = (pf.entries || []).find((e) => normalizeKey(absHref(e.href, settings.server)) === want);
  if (pf.status === 207 && ent && ent.size >= 0) remoteSize = ent.size;
  if (remoteSize === null) {
    /* 退路是真读一遍字节：必须要求服务端/内核按 base64 回传。
       按文本读随机字节会被 UTF-8 替换字符撑大（nginx 实测 8192B → 16220B），
       那是测量方式的假失败，不是链路失败——拿不到可信字节数就当没测到。 */
    const back = await davGet(settings, url, { responseEncoding: "base64" });
    if (back.status === 200 && String(back.bodyEncoding || "").toLowerCase() === "base64") {
      remoteSize = b64ByteLen(String(back.body || ""));
    }
  }
  await davDelete(settings, url);
  if (remoteSize !== null && remoteSize !== N) {
    throw new Error(`probe: 远端 ${remoteSize}B ≠ 本地 ${N}B`);
  }
  return remoteSize;
}

/* =====================================================================
 * 多协议上传器：把远端统一抽象成「路径分段数组」的键值存储。
 * 接口：open / mkdir(segs) / put(segs,u8) / sizeOf / walk / listNames(浅列举一层) /
 * deleteTree /
 *       probe / readBack / keyOf / rootDisplay / close
 * WebDAV 走 forwardProxy；FTP/SFTP 走桌面端 Node 直连（net 模块）。
 * ===================================================================== */

/* IIS 与 nginx 都对 Depth:infinity 的 PROPFIND 直接 403（本机 nginx 1.26.3 + dav_ext 实测），
 * 清理旧目录只能用 Depth:1 递归，先删子项再删目录（最深优先）。
 * nginx 的 DELETE 其实会递归删掉整个非空目录（实测 204 且子项一起消失），
 * 但 IIS 不会，所以这套「先子后父」的顺序对两家都成立，照旧走。 */
async function davDeleteChildren(s, url, depth) {
  if (depth > 10) return;
  let r;
  try {
    r = await davPropfind(s, url, "1");
  } catch (e) {
    return;
  }
  if (r.status !== 207) return;
  const origin = davOrigin(s.server);
  const self = url.replace(/\/+$/, "");
  for (const e of r.entries) {
    if (!e.href) continue;
    let child = absHref(e.href, s.server);
    if (!child.startsWith(origin)) continue; // 只删本站点前缀下的内容
    const norm = child.replace(/\/+$/, "");
    if (norm === self) continue;
    if (e.isDir) {
      if (!child.endsWith("/")) child += "/";
      await davDeleteChildren(s, child, depth + 1);
      await davDelete(s, child);
    } else {
      await davDelete(s, child);
    }
  }
}

/* ---------------- 传输容错：瞬时失败重试 + 断线重连 + 有界并发 ---------------- */

/* 可重试的 HTTP 状态：限流/超时/网关抖动/服务器内部错误。
 * 401/403/404/405 等语义性失败（凭据、权限、方法不支持）重试无意义，直接失败。 */
const RETRY_HTTP_STATUS = [408, 425, 429, 500, 502, 503, 504, 507, 509];
const TRANSIENT_MSG_RE = /(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|EMFILE|socket hang up|write after end|network|tls|ssl|临时|超时|timed out|timeout)/i;
const CONNLOST_MSG_RE = /(SSH 断开|SSH 通道|SFTP 请求超时|FTP 等待|连接已关闭|socket|ECONN|EPIPE|EOF|断开|closed|hang up)/i;

/* 判断一次失败是否是“重试可能成功”的瞬时失败。
 * 优先看结构化字段（httpStatus / ftpCode / sftpCode / connLost），
 * 只有拿不到字段时才退回消息匹配，避免把权限错误当网络抖动。 */
function isTransientError(e) {
  if (!e) return false;
  const st = Number(e.httpStatus || 0);
  if (st) return RETRY_HTTP_STATUS.includes(st);
  const fc = Number(e.ftpCode || 0);
  if (fc) return fc >= 400 && fc < 500; // 4xx = 临时否定应答（421 服务不可用 / 425 / 450 / 451 / 452）
  const sc = Number(e.sftpCode || 0);
  if (sc) return sc === 6 || sc === 7 || sc === 8; // BAD_MSG / NO_CONNECTION / CONNECTION_LOST
  if (e.connLost === true || e.retryable === true) return true;
  const nodeCode = typeof e.code === "string" ? e.code : "";
  if (/^E(CONN|PIPE|TIMED|HOST|NET|AI)/.test(nodeCode)) return true;
  return TRANSIENT_MSG_RE.test(String((e && e.message) || e));
}

/* 失败是否像是“连接本身没了”——此时重试前先重建立会话（FTP/SFTP 长连接） */
function isConnLostError(e) {
  if (!e) return false;
  if (e.connLost === true) return true;
  const nodeCode = typeof e.code === "string" ? e.code : "";
  if (/^E(CONN|PIPE|HOST|NET)/.test(nodeCode)) return true;
  return CONNLOST_MSG_RE.test(String((e && e.message) || e));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 指数退避重试：tries 次尝试，只在瞬时失败时重试；
 * onRetry(第几次, 错误) 可用于「连接断了先重连」这类补救。 */
async function withRetry(fn, opts = {}) {
  const tries = Math.max(1, Math.min(6, opts.tries || 3));
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (i >= tries || !isTransientError(e)) throw e;
      /* 服务端点名要等多久就等多久（上限见 retryAfterMsOf）：限流场景下我们自己的
       * 400ms~8s 退避等于「你说不，我偏要」，只会把窗口拖得更长。没给提示才走退避。 */
      const hinted = Number(e && e.retryAfterMs) || 0;
      const wait = hinted > 0
        ? hinted + Math.floor(Math.random() * 250)
        : Math.min(8000, (opts.base || 400) * Math.pow(2, i - 1)) + Math.floor(Math.random() * 250);
      console.warn(`[netglimmer-upload] ${opts.label || "操作"} 第 ${i}/${tries} 次失败：`
        + `${errForLog(e)}；${wait}ms 后重试${hinted > 0 ? "（服务端 Retry-After 指定）" : ""}`);
      try { if (opts.onRetry) await opts.onRetry(i, e); } catch (re) { /* 补救失败不掩盖原始错误 */ }
      await sleep(wait);
    }
  }
  throw lastErr;
}

/* 有界并发池：limit 个 worker 轮流取任务。
 * 任一任务最终失败即“熔断”——不再取新任务（避免整晚对着坏链路重复尝试），
 * 错误收集后由调用方汇总；已完成的部分保留（增量模式下下次可复用）。 */
async function runPool(tasks, worker, limit) {
  const errs = [];
  let cursor = 0;
  let aborted = false;
  const n = Math.max(1, Math.min(limit || 1, tasks.length));
  const runners = [];
  for (let k = 0; k < n; k++) {
    runners.push((async () => {
      while (!aborted) {
        const idx = cursor++;
        if (idx >= tasks.length) return;
        try { await worker(tasks[idx], idx); }
        catch (e) { errs.push(e); aborted = true; return; }
      }
    })());
  }
  await Promise.all(runners);
  return errs;
}

/* 各协议的安全并发度：
 *  - FTP 只有一条控制连接，STOR/150/226 必须严格串行（多路会打乱应答），并发 1；
 *  - SFTP 在一条连接上用多请求并发（按 id 匹配应答），可并行；
 *  - WebDAV 每个文件是独立 HTTP 请求，收益最大；
 *  - 本地是文件系统写，适度并行即可。
 * override>0 时用作 WebDAV/SFTP/本地 的并发度；FTP 恒定 1，不受设置影响。 */
function concurrencyFor(proto, override) {
  if (proto === "ftp") return 1;
  const auto = proto === "local" || proto === "sftp" ? 4 : 6;
  const n = Number(override) || 0;
  return n > 0 ? Math.min(16, Math.max(1, Math.round(n))) : auto;
}

/* 重连：关闭旧会话再 open()（WebDAV/本地是空操作，恒成功） */
async function reconnectUploader(up) {
  try { await up.close(); } catch (e) { /* 已断开 */ }
  await up.open();
}

class WebdavUploader {
  constructor(s) { this.s = s; this.protocol = "webdav"; }
  async open() {}
  url(segs) { return joinUrl(this.s.server, ...segs); }
  keyOf(segs) { return normalizeKey(this.url(segs)); }
  rootDisplay(segs) { return this.url(segs).replace(/\/+$/, "") + "/"; }
  async mkdir(segs) { await davMkcol(this.s, this.url(segs)); }
  async put(segs, u8) { await davPut(this.s, this.url(segs), u8); }
  async sizeOf(segs) {
    const url = this.url(segs);
    const pf = await davPropfind(this.s, url, "0");
    /* href 形态 IIS 是绝对 URL、nginx 是根相对路径，归一后再比（见 absHref） */
    const want = normalizeKey(url);
    const ent = (pf.entries || []).find((e) => normalizeKey(absHref(e.href, this.s.server)) === want);
    return pf.status === 207 && ent ? ent.size : -1;
  }
  async walk(segs) {
    const url = this.rootDisplay(segs);
    const w = await walkRemoteFiles(this.s, url, 0,
      { files: new Map(), paths: new Map(), status: 207, partial: false });
    return { supported: w.status === 207, files: w.files, paths: w.paths, partial: !!w.partial };
  }
  async deleteTree(segs) {
    const url = this.rootDisplay(segs);
    await davDeleteChildren(this.s, url, 0);
    /* davDeleteChildren 只删子项（PROPFIND 返回里跳过自身），顶层目录要单独删一次，
     * 否则「取消发布 / 改名残留清理」会在服务器上留一个空目录。IIS 需要结尾斜杠。 */
    if (segs.length) { try { await davDelete(this.s, url); } catch (e) { /* 非空/无权限 */ } }
  }
  async deleteReal(loc) { await davDelete(this.s, String(loc).replace(/\/+$/, "")); }
  async probe(segs) { await transportProbe(this.s, this.url(segs)); }
  async readBack(segs) {
    const back = await davGet(this.s, this.url(segs), { headers: { Range: "bytes=0-1024" } });
    return okStatus(back.status, [200, 206]) && !!back.body;
  }
  /* 浅列举（只一层，不递归）：只为查“归属标记”，代价远小于 walk。
   * 目录不存在或服务器不支持 PROPFIND → 空数组（调用方按“无人占用”处理）。 */
  async listNames(segs) {
    const r = await davPropfind(this.s, this.rootDisplay(segs), "1");
    if (r.status !== 207) return [];
    const out = [];
    for (const e of r.entries || []) {
      if (!e.href || e.isDir) continue;
      let name = String(e.href).replace(/\/+$/, "").split("/").pop() || "";
      try { name = decodeURIComponent(name); } catch (er) { /* 编码异常就按原样比对 */ }
      if (name) out.push(name);
    }
    return out;
  }
  async close() {}
}

class FtpUploader {
  constructor(s) { this.s = s; this.protocol = "ftp"; this.sess = null; this.base = ""; }
  async open() {
    const sess = new FtpSession(this.s);
    await sess.connect();
    await sess.login();
    this.sess = sess;
    this.base = (await sess.pwd()).replace(/\/+$/, "");
  }
  p(segs) { return this.base + "/" + segs.map((s) => this.encSeg(s)).join("/"); }
  /* 非 UTF8 会话：路径段按 GBK 编码成字节串（中文版 Windows FTP 的 ANSI 代码页），
   * ASCII 段原样；服务器返回的列表名已是字节串，gbkEncode 对 ≤0xFF 恒等，可安全回拼。 */
  encSeg(sg) {
    if (!this.sess || this.sess.hasUTF8 !== false) return sg;
    return String(sg).split("/").map((x) => gbkEncode(x)).join("/");
  }
  /* 比较键走 fsKey 而不是 normalizeKey：FTP 服务器多是大小写敏感的文件系统，
   * 把 README.md 与 readme.md 折成同一个键，增量发布就会「跳过另一个」，
   * 孤立清理也会删错那一个（详见 fsKey 的注释）。 */
  keyOf(segs) { this._gbkGuard(segs); return fsKey(this.p(segs)); }
  /* GBK 会话的最后一道闸：码表外的字符 gbkEncode 只能写成 "?"，于是「🎈.png」和
   * 「🎉.png」在远端是同一个文件——后一个被前一个覆盖，读者 404，而本地清单以为
   * 两个都在。与其静默合并，不如在碰远端之前点名拒绝，并告诉用户改哪个名字。
   * keyOf 也走这里：增量预检的比较键同样会被 "?" 撞车，那才是「跳过另一个文件」
   * 的真正来源（还没开始上传就会跳，put 的闸门根本轮不到）。 */
  _gbkGuard(segs) {
    if (!this.sess || this.sess.hasUTF8 !== false) return;
    const bad = [];
    for (const sg of segs || []) {
      for (const ch of gbkUnmappable(String(sg))) if (!bad.includes(ch)) bad.push(ch);
    }
    if (!bad.length) return;
    throw new Error(`FTP 服务器只接受 GBK 文件名，而这些字符 GBK 码表里没有：${bad.join(" ")}。`
      + `这类名字上传会在服务器上变成同一个 "?"，不同文件互相覆盖；`
      + `请在思源里把相关文档/资产改名（换成中文、常用符号或 ASCII），或让服务器开启 UTF-8。`);
  }
  rootDisplay(segs) {
    let pth = this.p(segs);
    if (this.sess && this.sess.hasUTF8 === false) {
      try { pth = new TextDecoder("gbk").decode(Buffer.from(pth, "latin1")); } catch (e) { /* 保留字节串 */ }
    }
    // 端口不是 21 时必须带上，否则记进历史/点击打开的链接连不上；IPv6 还要带方括号
    const hp = this.sess
      ? `${this.sess.displayHost || this.sess.host}${Number(this.sess.port) === 21 ? "" : ":" + this.sess.port}`
      : this.s.server;
    return `ftp://${hp}${pth}/`;
  }
  async mkdir(segs) {
    if (!segs.length) return;
    this._gbkGuard(segs);
    const created = await this.sess.mkd(this.p(segs));
    if (created) return;
    // MKD 550 可能是「已存在」也可能是无权限：查父目录列表甄别
    const parentSegs = segs.slice(0, -1);
    let items = [];
    try { items = await this.sess.list(this.p(parentSegs)); } catch (e) { /* 列不了就当不存在 */ }
    const name = segs[segs.length - 1];
    if (items.some((i) => i.isDir && fsKey(i.name) === fsKey(this.encSeg(name)))) return;
    throw new Error(`MKD 失败：${this.p(segs)}`);
  }
  async put(segs, u8) { this._gbkGuard(segs); await this.sess.put(this.p(segs), u8); }
  async sizeOf(segs) { this._gbkGuard(segs); return await this.sess.size(this.p(segs)); }
  async walk(segs) {
    const files = new Map();
    const paths = new Map();
    const meta = { partial: false, diag: "" };
    let supported = true;
    try {
      await this.sess.list(this.p(segs));
    } catch (e) { supported = false; meta.diag = (e && e.message) || String(e); }
    if (supported) await this._walk(segs, files, 0, paths, meta);
    /* 遍历「没抛错」不等于「列出了东西」：一台对根目录回空文本、对子目录回乱码的服务器
     * 会一路 quietly 交出空清单。带上现场样本，让上层能区分「远端真的没有」与「我们看不见」。 */
    if (supported && files.size === 0 && !meta.diag) {
      meta.diag = "LIST 应答为空或不含文件条目"
        + (this.sess.listSample ? `（原文前 120 字符：${String(this.sess.listSample).replace(/[\r\n]+/g, " ⏎ ").slice(0, 120)}）` : "");
    }
    return { supported, files, paths, partial: meta.partial, diag: meta.diag };
  }
  async _walk(segs, files, depth, paths, meta) {
    // 深度到顶 = 清单残缺，与下面「列举失败」同一个口径处理（理由见 walkRemoteFiles）
    if (depth > 12) {
      if (meta) { meta.partial = true; if (!meta.diag) meta.diag = "depth>12"; }
      return;
    }
    let items;
    try { items = await this.sess.list(this.p(segs)); }
    catch (e) {
      /* 子目录列举失败一律标记不完整：链路抖动、550 无权限、方言解析不出都算。
       * 以前只把「瞬时错误」当不完整，其余静默跳过该子树——结果是一张残缺清单，
       * 残缺清单里的「没有」会被校验读成「远端缺失」。 */
      if (meta) {
        meta.partial = true;
        if (!meta.diag) meta.diag = (e && e.message) || String(e);
      }
      return;
    }
    for (const it of items) {
      const child = segs.concat([it.name]);
      if (it.isDir) await this._walk(child, files, depth + 1, paths, meta);
      else { const key = fsKey(this.p(child)); files.set(key, it.size); if (paths) paths.set(key, this.p(child)); }
    }
  }
  async deleteTree(segs) {
    await this._del(segs, 0);
    /* 顶层目录也一并删除（空了才能成功，失败无碍），保证清理彻底 */
    if (segs.length) { try { await this.sess.rmd(this.p(segs)); } catch (e) { /* 非空/不存在 */ } }
  }
  async deleteReal(loc) { await this.sess.dele(String(loc)); }
  async _del(segs, depth) {
    if (depth > 12) return;
    let items;
    try { items = await this.sess.list(this.p(segs)); } catch (e) { return; }
    for (const it of items) {
      const child = segs.concat([it.name]);
      try {
        if (it.isDir) {
          await this._del(child, depth + 1);
          await this.sess.rmd(this.p(child));
        } else {
          await this.sess.dele(this.p(child));
        }
      } catch (e) { /* 尽力而为 */ }
    }
  }
  async probe(segs) {
    const N = 8192;
    const buf = new Uint8Array(N);
    for (let i = 0; i < N; i++) buf[i] = (i * 31 + 7) % 251;
    const sess = this.sess;
    /* 无删除权限的服务器（FileZilla 权限未勾 Delete）：改用固定名覆盖式探针，全程只可能残留一个文件 */
    const name = sess.noDelete ? ".wdav-probe.bin" : `.wdav-probe-${Date.now()}.bin`;
    const child = segs.concat([name]);
    await sess.put(this.p(child), buf);
    let remoteSize = -1;
    try { remoteSize = await sess.size(this.p(child)); } catch (e) { /* noop */ }
    if (remoteSize !== -1 && remoteSize !== N) throw new Error(`probe: 远端 ${remoteSize}B ≠ 本地 ${N}B`);
    try { await sess.dele(this.p(child)); } catch (e) { /* noop */ }
    let after = -1;
    try { after = await sess.size(this.p(child)); } catch (e) { /* noop */ }
    if (after === N) sess.noDelete = true; // 删不掉：下次复用固定名
  }
  async readBack(segs) {
    try { const b = await this.sess.get(this.p(segs)); return b.length > 0; } catch (e) { return false; }
  }
  /* 浅列举一层（MLSx/LIST 已是单层），目录不存在时返回空数组 */
  async listNames(segs) {
    let items = [];
    try { items = await this.sess.list(this.p(segs)); } catch (e) { return []; }
    return items.filter((i) => !i.isDir).map((i) => i.name);
  }
  async close() { if (this.sess) await this.sess.quit(); }
}

class SftpUploader {
  constructor(s, ctx) { this.s = s; this.protocol = "sftp"; this.ctx = ctx || {}; this.ssh = null; this.base = ""; }
  async open() {
    const ssh = new SshSession(this.s);
    if (this.ctx.hostKeys) ssh.hostKeys = this.ctx.hostKeys;
    await ssh.connect();
    await ssh.handshake();
    await ssh.authPassword();
    await ssh.openSftp();
    this.ssh = ssh;
    this.fingerprint = ssh.hostFingerprint;
    this.base = (await ssh.realpath(".")).replace(/\/+$/, "");
  }
  p(segs) { return this.base + "/" + segs.join("/"); }
  keyOf(segs) { return fsKey(this.p(segs)); }   // 与 FTP 同理：路径键不折叠大小写、不解码
  rootDisplay(segs) {
    const hp = this.ssh
      ? `${this.ssh.displayHost || this.ssh.host}${Number(this.ssh.port) === 22 ? "" : ":" + this.ssh.port}`
      : this.s.server;
    return `sftp://${hp}${this.p(segs)}/`;
  }
  async mkdir(segs) {
    if (!segs.length) return;
    const path = this.p(segs);
    const st = await this.ssh.stat(path);
    if (st && st.isDir) return;
    try {
      await this.ssh.mkdir(path);
    } catch (e) {
      const st2 = await this.ssh.stat(path);
      if (!st2 || !st2.isDir) throw new Error(`MKDIR 失败：${path}（${e.message}）`);
    }
  }
  async put(segs, u8) { await this.ssh.putFile(this.p(segs), u8); }
  async sizeOf(segs) { const st = await this.ssh.stat(this.p(segs)); return st ? st.size : -1; }
  async walk(segs) {
    const files = new Map();
    const paths = new Map();
    const meta = { partial: false };
    let supported = true;
    try {
      const h = await this.ssh.opendir(this.p(segs));
      await this.ssh.closeHandle(h);
    } catch (e) { supported = false; }
    if (supported) await this._walk(segs, files, 0, paths, meta);
    return { supported, files, paths, partial: meta.partial };
  }
  async _walk(segs, files, depth, paths, meta) {
    if (depth > 12) {
      if (meta) { meta.partial = true; if (!meta.diag) meta.diag = "depth>12"; }
      return;
    }
    let h;
    try { h = await this.ssh.opendir(this.p(segs)); }
    catch (e) {
      /* 与 FTP 那条对齐：任何一次 opendir 失败都算清单不完整，不只是链路抖动。
       * 权限拒绝、服务器不支持该目录这类「永久失败」同样会让这一子树在清单里缺席，
       * 而缺席会被读回校验念成「远端缺失」——那是把一次好发布判成失败。
       * 代价是预检不可信时退回全量重传，这比误判缺失便宜得多。 */
      if (meta) {
        meta.partial = true;
        if (!meta.diag) meta.diag = errForLog(e);
      }
      return;
    }
    try {
      let page;
      while ((page = await this.ssh.readdir(h))) {
        for (const it of page) {
          const child = segs.concat([it.name]);
          if (it.isDir) await this._walk(child, files, depth + 1, paths, meta);
          else { const key = fsKey(this.p(child)); files.set(key, it.size); if (paths) paths.set(key, this.p(child)); }
        }
      }
    } catch (e) {
      /* READDIR 失败（服务器中途断、句柄被回收、这一页读不动）与 opendir 失败同一口径：
       * 标 partial 后收摊。让它抛出去的话，整次 walk 变成一个异常——校验层只能整体
       * 重来，连已经列到的那一半都用不上；权限类的永久失败还会把一次好上传判成失败。 */
      if (meta) {
        meta.partial = true;
        if (!meta.diag) meta.diag = errForLog(e);
      }
    } finally { await this.ssh.closeHandle(h); }
  }
  async deleteTree(segs) {
    await this._del(segs, 0);
    /* _del 只删子项（子目录由父层负责 rmdir），顶层要自己删一次，
     * 否则取消发布/改名清理会在服务器上留下一个空目录。 */
    if (segs.length) { try { await this.ssh.rmdir(this.p(segs)); } catch (e) { /* 非空/不存在 */ } }
  }
  async deleteReal(loc) { await this.ssh.remove(String(loc)); }
  async _del(segs, depth) {
    if (depth > 12) return;
    let h;
    try { h = await this.ssh.opendir(this.p(segs)); } catch (e) { return; }
    try {
      let page;
      while ((page = await this.ssh.readdir(h))) {
        for (const it of page) {
          const child = segs.concat([it.name]);
          try {
            if (it.isDir) {
              await this._del(child, depth + 1);
              await this.ssh.rmdir(this.p(child));
            } else {
              await this.ssh.remove(this.p(child));
            }
          } catch (e) { /* 尽力而为 */ }
        }
      }
    } finally { await this.ssh.closeHandle(h); }
  }
  async probe(segs) {
    const N = 8192;
    const buf = new Uint8Array(N);
    for (let i = 0; i < N; i++) buf[i] = (i * 31 + 7) % 251;
    const child = segs.concat([`.wdav-probe-${Date.now()}.bin`]);
    await this.ssh.putFile(this.p(child), buf);
    let remoteSize = -1;
    try { const st = await this.ssh.stat(this.p(child)); if (st) remoteSize = st.size; } catch (e) { /* noop */ }
    try { await this.ssh.remove(this.p(child)); } catch (e) { /* noop */ }
    if (remoteSize !== -1 && remoteSize !== N) throw new Error(`probe: 远端 ${remoteSize}B ≠ 本地 ${N}B`);
  }
  async readBack(segs) {
    try { const st = await this.ssh.stat(this.p(segs)); return !!st && st.size > 0; } catch (e) { return false; }
  }
  /* 浅列举一层（opendir/readdir，不递归），目录不存在 → 空数组 */
  async listNames(segs) {
    let h;
    try { h = await this.ssh.opendir(this.p(segs)); } catch (e) { return []; }
    const out = [];
    try {
      let page;
      while ((page = await this.ssh.readdir(h))) {
        for (const it of page) if (!it.isDir) out.push(it.name);
      }
    } catch (e) { /* 已取到的部分够用 */ } finally {
      try { await this.ssh.closeHandle(h); } catch (e) { /* noop */ }
    }
    return out;
  }
  async close() { if (this.ssh) await this.ssh.disconnect(); }
}

/* 本地协议的基础目录检查（纯函数，回归可以直接喂字符串测它，不用跑一次发布）。
 * 为什么要在 open 之前单独拦一道：p(segs) 那道防线只保证「不越出 base」，可 base 本身
 * 是用户手填的字符串。回归实测过一次：写成 "/数据/发布/../.." 这种路径时 path.resolve
 * 会把它静默折叠成 "/"，于是 550 个文件、三十几 MB 落到文件系统根，而「取消发布 / 清理
 * 旧目录」用的是 fs.rm(recursive)——填错一个路径等于拿整块盘当发布目录。所以：
 *   1) 原始串里出现 . / .. 段一律拒绝（不做「聪明的」折叠，折叠本身就是这次事故的成因）；
 *   2) 解析结果若是某个盘/分区的根（dirname(x) === x）也拒绝，整盘根没有一次是有意为之。
 * 抛的是给用户看的中文短句，与上传器其它错误一致。 */
function localBaseOf(raw, pathMod) {
  let s = String(raw == null ? "" : raw).trim();
  /* file:// 前缀按用户实际粘贴的两种写法分别还原：file:///var/www 是 Unix 绝对路径
   * （曾经一律砍掉三个斜杠，结果变成相对路径、按当前工作目录解析——又是一次神不知鬼不觉的跑偏），
   * file:///D:/www 是 Windows 盘符写法（正斜杠版），要还原成 D:/www。 */
  s = s.replace(/^file:\/\/\/([A-Za-z]:)/i, "$1")
    .replace(/^file:\/\/\//i, "/")
    .replace(/^file:\/\//i, "")
    .replace(/\|/, ":");
  if (!s) throw new Error("未填写本地导出路径");
  if (s.split(/[/\\]+/).some((x) => x === "." || x === "..")) {
    throw new Error(`本地导出路径不能包含 . 或 .. 段：${s}（它会被解析到别处，而上传与清理是递归删除）`);
  }
  const base = pathMod.resolve(s);
  if (pathMod.dirname(base) === base) {
    throw new Error(`本地导出路径不能是整个磁盘根目录：${base}`);
  }
  return base;
}

/* 本地目录上传器：把发布产物直接写到本机磁盘的某个目录（Linux / Windows）。
 * 复用桌面端 Node 的 fs/promises + path，无需任何网络服务。
 * s.server 存的是本地基础路径，例如 D:\www\publish 或 /var/www/html；
 * 最终落盘 <base>/<prefix>/<docName>/...，与网络协议同一套目录结构。 */
class LocalUploader {
  constructor(s) {
    this.s = s; this.protocol = "local";
    this.fs = null; this.fsp = null; this.path = null; this.base = "";
  }
  async open() {
    const fs = needNode("fs", "本地");
    const path = needNode("path", "本地");
    this.fs = fs; this.fsp = fs.promises || fs; this.path = path;
    const raw = String(this.s.server || "").trim();
    /* 基础目录交给 localBaseOf 判定（含 . / .. 段与整盘根一律拒绝），
     * 不存在则尝试创建，顺带验证可写 */
    this.base = localBaseOf(raw, path);
    await this.fsp.mkdir(this.base, { recursive: true });
    await this.fsp.access(this.base, (fs.constants || {}).W_OK ?? 2);
  }
  /* 拼本地绝对路径。这里是第二道防线：任何一段把结果带出基础目录
   * （deleteTree 是 fs.rm(recursive)，越界就是删库）直接抛错。 */
  p(segs) {
    const abs = this.path.join(this.base, ...(segs || []).map((x) => String(x)));
    const rel = this.path.relative(this.base, abs);
    if (rel && (rel.startsWith("..") || this.path.isAbsolute(rel))) {
      throw new Error(`路径越界：${abs} 不在基础目录 ${this.base} 内`);
    }
    return abs;
  }
  keyOf(segs) { return fsKey(this.p(segs)); }   // 本地文件系统同样大小写敏感（Linux/macOS 区分大小写的卷）
  toFileUrl(abs) {
    let a = String(abs).replace(/\\/g, "/");
    if (!a.startsWith("/")) a = "/" + a; // Windows: D:/... → /D:/...
    return "file://" + a.replace(/[!$&'()+,;=?#\[\]%]/g, (c) => "%" + c.charCodeAt(0).toString(16));
  }
  rootDisplay(segs) { return this.toFileUrl(this.p(segs)); }
  async mkdir(segs) { if (!segs.length) return; await this.fsp.mkdir(this.p(segs), { recursive: true }); }
  async put(segs, u8) { await this.fsp.writeFile(this.p(segs), Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)); }
  async sizeOf(segs) { try { const st = await this.fsp.stat(this.p(segs)); return st.isFile() ? st.size : -1; } catch (e) { return -1; } }
  async walk(segs) {
    const files = new Map();
    const paths = new Map();
    const meta = { partial: false };
    await this._walk(segs, files, 0, paths, meta);
    return { supported: true, files, paths, partial: meta.partial };
  }
  async _walk(segs, files, depth, paths, meta) {
    if (depth > 12) { if (meta) meta.partial = true; return; }
    let entries;
    /* 本地目录也可能读不动（权限、正在被删、符号链接成环被 ELOOP 挡下）。
     * 以前静默跳过这一子树，清单就少一截，校验把「少」读成「远端缺失」。 */
    try { entries = await this.fsp.readdir(this.p(segs), { withFileTypes: true }); }
    catch (e) { if (meta) meta.partial = true; return; }
    for (const ent of entries) {
      const child = segs.concat([ent.name]);
      if (ent.isDirectory()) await this._walk(child, files, depth + 1, paths, meta);
      else {
        try {
          const st = await this.fsp.stat(this.p(child));
          const key = this.keyOf(child);
          files.set(key, st.size);
          if (paths) paths.set(key, this.p(child));
        } catch (e) { /* noop */ }
      }
    }
  }
  async deleteTree(segs) {
    if (!segs.length) return; // 绝不删基础目录本身
    try { await this.fsp.rm(this.p(segs), { recursive: true, force: true }); }
    catch (e) { // 旧 Node 无 fs.rm
      try { await this._del(this.p(segs)); } catch (e2) { /* 尽力而为 */ }
    }
  }
  async deleteReal(loc) { try { await this.fsp.unlink(String(loc)); } catch (e) { /* 尽力而为 */ } }
  async _del(dir) {
    let entries;
    try { entries = await this.fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const full = this.path.join(dir, ent.name);
      if (ent.isDirectory()) { await this._del(full); await this.fsp.rmdir(full); }
      else await this.fsp.unlink(full);
    }
  }
  async probe(segs) {
    const N = 8192;
    const buf = Buffer.alloc(N);
    for (let i = 0; i < N; i++) buf[i] = (i * 31 + 7) % 251;
    const child = segs.concat([`.wdav-probe-${Date.now()}.bin`]);
    const abs = this.p(child);
    await this.fsp.writeFile(abs, buf);
    let size = -1;
    try { size = (await this.fsp.stat(abs)).size; } catch (e) { /* noop */ }
    try { await this.fsp.unlink(abs); } catch (e) { /* noop */ }
    if (size !== -1 && size !== N) throw new Error(`probe: 本地 ${size}B ≠ 预期 ${N}B`);
  }
  async readBack(segs) { const sz = await this.sizeOf(segs); return sz > 0; }
  /* 浅列举一层，目录不存在 → 空数组 */
  async listNames(segs) {
    let entries;
    try { entries = await this.fsp.readdir(this.p(segs), { withFileTypes: true }); } catch (e) { return []; }
    return entries.filter((e) => e.isFile()).map((e) => String(e.name));
  }
  async close() {}
}

function makeUploader(s, ctx) {
  const proto = s.protocol || "webdav";
  if (proto === "ftp") return new FtpUploader(s, ctx);
  if (proto === "sftp") return new SftpUploader(s, ctx);
  if (proto === "local") return new LocalUploader(s, ctx);
  return new WebdavUploader(s, ctx);
}


/* @@VENDOR:index-html@@ 思源 3.8.6 前端 index.html 拼装代码（逐字移植，见 src/vendored/index-html.js，由 build.js 拼回） */

/* @@VENDOR:toc@@ 侧边大纲注入 payload 与 injectToc（见 src/vendored/toc.js，由 build.js 拼回） */

/* ---------------- plugin ---------------- */

class WebDAVPublishPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData(SETTINGS_KEY)) || {});
    /* 「上传成功后自动复制地址」这件事已经不存在了（看板与卡片都改成只显示路径、由用户
     * 自己全选），但配置里可能还留着 `copyOnPublish: true`。在这里显式扔掉：留着不读是一
     * 回事，下次保存又原样写回去、让以后翻配置的人以为这个开关还存在，是另一回事。 */
    let stripLegacyKey = false;
    if (Object.prototype.hasOwnProperty.call(this.settings, "copyOnPublish")) {
      delete this.settings.copyOnPublish;
      stripLegacyKey = true;
    }
    const profilesBefore = JSON.stringify(this.settings.profiles || null);
    this.normalizeProfiles();
    /* 规范化后的 profiles 要落盘，否则磁盘上留的还是缺槽、带 null、或者 port 写成数字的
     * 那份旧形状，下次加载又要再规范化一遍——而「再规范化一次」正好是设置读取里最容易
     * 出错的那一步（浅拷贝别名到 DEFAULT_SETTINGS.profiles 时，一个实例会污染全部实例）。 */
    if (stripLegacyKey || JSON.stringify(this.settings.profiles) !== profilesBefore) {
      try { await this.saveData(SETTINGS_KEY, this.settings); }
      catch (e) {
        console.warn("[netglimmer-upload] 保存规范化后的设置失败（本次仍按规范化结果运行）：", errForLog(e));
      }
    }
    this.busy = false;
    this.els = {};

    // 3.8.x 源码实测：emitOpenMenu 派发 detail = { menu: subMenu, elements: [li...], type, items }
    // 文档树条目 ID 在 elements[0] 的 data-node-id 属性上；插件项会归入右键菜单的「插件」子菜单
    const addTreeMenuItems = (d) => {
      const menu = d.menu;
      if (!menu || typeof menu.addItem !== "function") return;
      const els = d.elements || [];
      const id = els[0]?.getAttribute?.("data-node-id")
        || d.blockId || d.data?.rootID || d.data?.id;
      if (!id) return;
      // 目录节点不是文档：思源把文件夹条目的 data-node-id 存成路径（带 /），文档是块 ID。
      // 以前对文件夹也给出「发布」入口，点了只在导出那步报一句内核的 not found，
      // 现在直接不给入口——菜单里少一项比给一项注定失败的按钮有用。
      if (String(id).indexOf("/") >= 0) return;
      // 「一键上传」常驻；上传后又有改动的，多给一条按原记录重传的入口（见 publishMenuItems）
      this.publishMenuItems(menu, id);
    };

    this.eventBus.on("open-menu-doctree", (event) => {
      try {
        addTreeMenuItems(event.detail || event);
      } catch (e) {
        console.error("[netglimmer-upload] open-menu-doctree", e);
      }
    });

    // 编辑区文档标题图标菜单（部分版本存在该事件，取不到 ID 时自动跳过）
    this.eventBus.on("click-editortitleicon", (event) => {
      try {
        const d = event.detail || event;
        const id = d.data?.rootID || d.data?.id || d.blockId || d.protyle?.block?.rootId;
        if (!id || !d.menu) return;
        this.publishMenuItems(d.menu, id);
      } catch (e) {
        console.error("[netglimmer-upload] click-editortitleicon", e);
      }
    });

    console.log("[netglimmer-upload] loaded v" + PLUGIN_VERSION);

    // 注册「发布看板」独立页签（openTab/addTab 可用时点击入口直接开页面）
    this.registerDashTab();

    // 状态栏入口：①发布当前文档 ②发布看板
    try {
      if (typeof this.addStatusBar === "function") {
        this.addStatusBar({
          position: "right",
          template: `<span class="vd-publish-entry" style="cursor:pointer;display:flex;align-items:center;" title="${this.t("cmdPublishCurrent")}">${this.t("publishCurrentShort")}</span>`,
        });
        this.addStatusBar({
          position: "right",
          template: `<span class="vd-dash-entry" style="cursor:pointer;display:flex;align-items:center;" title="${this.t("dashboard")}">${this.t("dashboard")}</span>`,
        });
        // 状态栏模板是异步插入的，轮询几次再绑定（两个入口各自绑上就退场，
        // 少绑一个也照样重试，避免一个入口缺失把另一个也永久不绑）。
        const bound = { pub: false, dash: false };
        const bind = () => {
          if (!bound.pub) {
            const entry = document.querySelector(".vd-publish-entry");
            if (entry) {
              entry.addEventListener("click", () => this.publishCurrent());
              bound.pub = true;
            }
          }
          if (!bound.dash) {
            const entry = document.querySelector(".vd-dash-entry");
            if (entry) {
              entry.addEventListener("click", () => this.showDashboard());
              bound.dash = true;
            }
          }
          if ((!bound.pub || !bound.dash) && ++tries < 10) setTimeout(bind, 200);
        };
        let tries = 0;
        setTimeout(bind, 200);
      }
    } catch (e) { /* 状态栏不可用不影响发布 */ }

    // 记住「当前打开的是哪篇文档」+ 注册命令面板入口（快捷键在 设置→快捷键 里自行绑定）
    this.trackCurrentDoc();
    this.registerCommands();

    // 设置面板构建失败不应影响发布功能：单独兜底，openSetting 时还会惰性重建
    try {
      this.buildSettingTab();
    } catch (e) {
      console.error("[netglimmer-upload] buildSettingTab", e);
      this.setting = null;
    }

    // 文档树「已发布」角标：加载历史里发布成功的文档 ID，标注对应树节点
    try {
      await this.refreshPublishedSet();
      this.startTreeBadge();
      // 角标状态需要“发布后是否又改了”的判断：启动时算一次，之后定期重算
      this.refreshChangedState(true);
      this.startChangedWatch();
    } catch (e) {
      console.error("[netglimmer-upload] tree badge init", e);
    }
  }

  /* 定期重算改动状态（60s）。不依赖 eventBus 事件名——不同思源版本的事件名不一致，
   * 而这里只是「一条批量 SQL + 一次树重绘」，代价可以忽略，也不会漏掉外部编辑。 */
  startChangedWatch() {
    if (this._changedTimer || typeof setInterval !== "function") return;
    this._changedTimer = setInterval(() => {
      try { this.refreshChangedState(false); } catch (e) { /* 忽略单次失败 */ }
    }, 60000);
  }

  /* ---------- 文档树「已发布」角标 ---------- */

  /* 右键菜单的上传入口（文档树与编辑区标题图标共用这一份）。
   * 第一项永远在：按当前设置上传。「检测到改动，重新上传」只在 changedSet 认这篇
   * 上传之后正文又改过时才出现，并且照那条记录当初的协议与「含子文档」口径重传——
   * 用户右键的是这篇文档，不是顺手把今天的上传参数也改了。
   * 判不准（没指纹、SQL 查询失败、已取消上传）不给第二项：一个点下去只会把远端
   * 原样再盖一遍的按钮，在这里只是噪音。 */
  publishMenuItems(menu, id) {
    menu.addItem({
      icon: "iconUpload",
      label: this.t("publish"),
      click: () => this.publish(id, this.settings.publishMerge !== false),
    });
    if (!this.changedSet || !this.changedSet.has(id)) return;
    const rec = this.latestOkRec(id);
    if (!rec) return;
    menu.addItem({
      icon: "iconUpload",
      label: this.t("publishChangedMenu"),
      click: () => this.publish(id, !!rec.merge, { proto: rec.protocol }),
    });
  }

  /* 「这篇文档最近一次成功、且还挂在远端上的上传记录」：直接读 historyCache——
   * 看板画的就是这一份，另存一张 docId→记录 的映射只会多一处会漂移的状态。
   * 历史是新→旧，第一条匹配即最新。已取消上传（unpub）的记录不能算：它指向的
   * 远端目录已经被用户删掉，照它的协议「重新上传」只会在一个空的旧口径上再开一次。 */
  latestOkRec(id) {
    const list = this.historyCache || [];
    for (const r of list) {
      if (r && r.ok && isLiveRec(r) && String(r.docId) === String(id)) return r;
    }
    return null;
  }

  // 从发布历史收集「发布成功」的文档：docId → url，另存 docId → 发布时的改动指纹
  async refreshPublishedSet() {
    const map = new Map();
    const stamps = new Map();
    try {
      const list = await this.getHistory();
      for (const rec of list) {
        // pub 标记表示“该文档至少成功发布过一次且未被清除”，用于树角标；
        // 每次发布都会写这个字段，失败的继承此前成功的 true（远端仍是旧内容）。
        if (!rec || !rec.pub || !rec.docId) continue;
        if (!map.has(rec.docId)) map.set(rec.docId, displayUrl(rec.url || ""));
        // 指纹只认“发布成功且带 stamp”的最新一条（历史是新→旧）
        if (rec.ok && rec.stamp && !stamps.has(rec.docId)) stamps.set(rec.docId, rec.stamp);
      }
    } catch (e) { /* noop */ }
    this.publishedMap = map;
    this.publishedStamp = stamps;
    return map;
  }

  /* 批量取多篇文档的改动指纹：一条 SQL 拿回 root_id → {u,c}，
   * 避免每篇文档一次查询（发布过的文档可能有几十上百篇）。 */
  async stampsFor(ids) {
    const valid = (ids || []).filter((id) => /^[\w-]{1,32}$/.test(String(id || "")));
    const out = new Map();
    for (let i = 0; i < valid.length; i += 200) {
      const chunk = valid.slice(i, i + 200);
      try {
        const ret = await fetchSyncPost("/api/query/sql", {
          stmt: "SELECT root_id, max(updated) AS u, count(*) AS c FROM blocks WHERE root_id IN ("
            + chunk.map((x) => `'${x}'`).join(",") + ") GROUP BY root_id",
        });
        for (const row of ret.data || []) {
          if (!row || row.u == null || !row.root_id) continue;
          out.set(String(row.root_id), { u: String(row.u), c: Number(row.c || 0) });
        }
      } catch (e) { /* 查询失败：这些文档保持“未知” */ }
    }
    return out;
  }

  /* 刷新「发布后又有改动」的文档集合，驱动文档树角标的第二种状态。
   * force=true（刚发布完、手动刷新）忽略节流；否则最短 8 秒一次，编辑频繁时不打扰内核。 */
  async refreshChangedState(force) {
    if (!this.publishedStamp) this.publishedStamp = new Map();
    if (!this.changedSet) this.changedSet = new Set();
    const ids = [...this.publishedStamp.keys()];
    if (!ids.length) {
      if (this.changedSet.size) { this.changedSet = new Set(); this.scheduleTreeDecorate(); }
      return;
    }
    const now = Date.now();
    if (!force && this._changedAt && now - this._changedAt < 8000) return;
    if (this._changedBusy) return;
    this._changedBusy = true;
    this._changedAt = now;
    try {
      const cur = await this.stampsFor(ids);
      const next = new Set();
      for (const [id, stamp] of this.publishedStamp) {
        const s = cur.get(id);
        if (s && !this.constructor.stampEqual(stamp, s)) next.add(id);
      }
      const differs = next.size !== this.changedSet.size
        || [...next].some((x) => !this.changedSet.has(x));
      this.changedSet = next;
      if (differs) this.scheduleTreeDecorate();
    } catch (e) { /* 忽略：状态未知比报错更合适 */ } finally {
      this._changedBusy = false;
    }
  }

  startTreeBadge() {
    if (this._badgeObserver) return; // 幂等
    const attach = () => {
      // MutationObserver 用于跟随树的重绘补角标；个别环境缺失时退化为一次性标注。
      // 监听范围只圈文件树容器：整页 body 监听会让每一次无关重绘都排一次装饰任务。
      if (typeof MutationObserver !== "undefined" && !this._badgeObserver) {
        try {
          this._badgeObserver = new MutationObserver(() => {
            if (this._badgeScoped) this.scheduleTreeDecorate();
          });
          this.observeBadgeTargets();
        } catch (e) { this._badgeObserver = null; }
      }
      this.scheduleTreeDecorate();
    };
    if (document.body) attach();
    else document.addEventListener("DOMContentLoaded", attach, { once: true });
  }

  /* 现在的树容器节点（观察目标）。文档树面板被换掉时这里跟着换。 */
  badgeTargetNodes() {
    const targets = [];
    for (const sel of [".file-tree__items", ".protyle-file-tree"]) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
      for (const n of nodes) targets.push(n);
    }
    return targets;
  }

  /* 把观察目标挂到文件树容器上；容器还没出现时暂时挂 body，
   * 下一次装饰发现容器已就绪会自动改挂（observeBadgeTargets 幂等）。 */
  observeBadgeTargets() {
    const ob = this._badgeObserver;
    if (!ob) return;
    const targets = this.badgeTargetNodes();
    try { ob.disconnect(); } catch (e) { /* noop */ }
    this._badgeScoped = targets.length > 0;
    this._badgeTargets = targets.slice();
    const opts = { childList: true, subtree: true };
    if (this._badgeScoped) for (const t of targets) { try { ob.observe(t, opts); } catch (e) {} }
    else if (document.body) { try { ob.observe(document.body, opts); } catch (e) {} }
  }

  /* 观察目标还作数吗：思源切面板/重建文档树时换掉的是容器节点本身，
   * 旧目标被摘出文档后我们挂在一个不再有人往里面写东西的节点上——
   * 之后每一次重绘都收不到，角标从此不更新，而 _badgeScoped 还是 true
   * （只看这个标志位判断"要不要重挂"就会永远停在坏状态）。 */
  badgeTargetsStale() {
    const now = this.badgeTargetNodes();
    const was = this._badgeTargets || [];
    if (now.length !== was.length) return true;
    return now.some((n) => was.indexOf(n) < 0);
  }

  stopTreeBadge() {
    if (this._badgeObserver) { try { this._badgeObserver.disconnect(); } catch (e) {} this._badgeObserver = null; }
    if (this._badgeTimer) { clearTimeout(this._badgeTimer); this._badgeTimer = null; }
    this._badgeTargets = [];
  }

  // 思源树节点会随展开/滚动/搜索频繁重绘，合并到一个短延时里统一补角标
  scheduleTreeDecorate() {
    if (this._badgeTimer) return;
    this._badgeTimer = setTimeout(() => {
      this._badgeTimer = null;
      try { this.decorateTreeBadges(); } catch (e) { /* 频繁重绘时忽略单次异常 */ }
    }, 250);
  }

  decorateTreeBadges() {
    if (!this.publishedMap) this.publishedMap = new Map();
    if (!this.changedSet) this.changedSet = new Set();
    // 思源「文档」树（文件树面板）的条目是 li.b3-list-item[data-node-id]，
    // 容器类名是 .file-tree__items（旧版为 .protyle-file-tree）。
    // 注意：.protyle-tree 是编辑器内的大纲树，不是文件树——此前误用它导致
    // 选择器一个都匹配不到，角标从未插入。这里同时兼容两种容器并去重。
    const seen = new Set();
    const items = [];
    for (const sel of [
      ".file-tree__items li.b3-list-item[data-node-id]",
      ".protyle-file-tree li.b3-list-item[data-node-id]",
    ]) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
      for (const li of nodes) { if (!seen.has(li)) { seen.add(li); items.push(li); } }
    }
    // 树容器是懒挂载的（首次打开文档面板才有）：出现了就把观察从 body 收窄到容器；
    // 容器被换掉（面板重建）时同样重新认一遍，见 badgeTargetsStale。
    if (items.length && (!this._badgeScoped || this.badgeTargetsStale())) {
      this.observeBadgeTargets();
    }
    const ICONS = {
      // 简洁「地球/已上网」= 已发布且内容一致
      p: '<svg viewBox="0 0 16 16" width="12.5" height="12.5" fill="none" '
        + 'stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true">'
        + '<circle cx="8" cy="8" r="6.3"/><path d="M1.7 8h12.6"/>'
        + '<path d="M8 1.7c2.3 2.1 2.3 10.5 0 12.6M8 1.7c-2.3 2.1-2.3 10.5 0 12.6"/></svg>',
      // 上箭头 = 已发布过，但发布后正文又改了，提醒重新发布
      c: '<svg viewBox="0 0 16 16" width="12.5" height="12.5" fill="none" '
        + 'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M8 12.6V3.4"/><path d="M4.3 7.1 8 3.4l3.7 3.7"/>'
        + '<path d="M2.6 13.6h10.8"/></svg>',
    };
    for (const li of items) {
      const id = li.getAttribute("data-node-id");
      const has = li.querySelector(".vd-pub-badge");
      if (!this.publishedMap.has(id)) {
        if (has) { try { has.remove(); } catch (e) {} }
        continue;
      }
      const changed = this.changedSet.has(id);
      const state = changed ? "c" : "p";
      const url = typeof this.publishedMap.get(id) === "string"
        ? this.publishedMap.get(id) : (this.publishedMap.get(id) || {}).url || "";
      /* 幂等：状态和地址都没变就不动 DOM（否则 MutationObserver 会被自己触发成死循环）。
       * 地址必须一起比：角标的点击行为是建它那一刻把 url 关进闭包的，重传到新目录/改名后
       * 状态仍是 p，只比状态就会留着旧角标——用户点开的还是那个已经作废的旧地址。
       * 记在元素自己的属性上（不进 markup）：思源重画行时它会跟着消失，
       * 那时按「变了」处理、重建一个，方向是安全的。 */
      if (has && has.getAttribute("data-st") === state && has._pubUrl === url) continue;
      if (has) { try { has.remove(); } catch (e) {} }
      const badge = document.createElement("span");
      badge.className = "vd-pub-badge";
      badge.setAttribute("data-st", state);
      badge.setAttribute("title", changed ? this.t("changedBadgeTip") : this.t("publishedBadgeTip"));
      badge._pubUrl = url;   // 幂等比较用（见上面那条注释），不写进 markup
      // 角标紧跟标题：作为 .b3-list-item__text 内的行内元素插到标题文字之后，
      // 而不是整行末尾（标题文本是 flex:1，作为行兄弟会被推到行尾）。
      badge.style.cssText = "display:inline-flex;align-items:center;vertical-align:middle;"
        + "margin-left:5px;height:1em;line-height:0;opacity:.85;"
        + "cursor:pointer;pointer-events:auto;flex:0 0 auto;"
        // 思源主题没有 --b3-theme-warning；卡片警示色在明暗两套主题里都可读，
        // 缺失时退回主题错误色，保证不会出现“图标跟正文同色”的情况。
        + `color:${changed ? "var(--b3-card-warning-color, var(--b3-theme-error))" : "var(--b3-theme-primary)"};`;
      badge.innerHTML = ICONS[state];
      if (url) {
        badge.addEventListener("click", (e) => {
          e.stopPropagation();
          /* noopener：新窗口拿不到 window.opener。思源内置浏览器里打开的远端页面
           * 与我们自己的界面同源可达，被反向控制过一次（钓鱼站把 opener 导航回你的
           * 站点填表）就不只是理论问题；Electron 的 shell.openExternal 那条路也照样生效。 */
          try { window.open(url, "_blank", "noopener,noreferrer"); } catch (err) { /* noop */ }
        });
      }
      const textEl = li.querySelector(".b3-list-item__text");
      (textEl || li).appendChild(badge);
    }
  }

  onunload() {
    try { this.stopTreeBadge(); } catch (e) { /* noop */ }
    if (this._changedTimer) { try { clearInterval(this._changedTimer); } catch (e) {} this._changedTimer = null; }
    // 插件被卸载/禁用时收尾：进度条不能留在界面上，FTP/SFTP 的 socket 也不能留活连接。
    // （发布任务本身仍在自己的 finally 里关闭，这里只兜“半路被卸载”的情况。）
    try { Progress.hide(); } catch (e) { /* noop */ }
    if (this.activeUploader) {
      const up = this.activeUploader;
      this.activeUploader = null;
      try { Promise.resolve(up.close()).catch(() => {}); } catch (e) { /* noop */ }
    }
  }

  t(key) {
    // 语言码归一：内核可能给 "zh-CN" / "en" / "zh_CN"，内置只带 zh_CN / en_US。
    // 认不出的语言回落中文（思源主体中文用户为主），再落英文，最后原样返回 key。
    const raw = String(conf()?.lang || "zh_CN").replace(/-/g, "_");
    const lang = I18N[raw] ? raw : (I18N[raw.split("_")[0] + "_US"] ? raw.split("_")[0] + "_US" : "zh_CN");
    const dict = I18N[lang];
    return dict[key] || I18N.en_US[key] || key;
  }

  /* ---------- 原生插件设置面板 ---------- */

  /**
   * 重写打开设置：在设置弹窗头部加「发布设置 / 发布看板」两个页签，
   * 看板直接在同一个弹窗内切换显示，不再依赖独立弹窗或页签 API。
   */
  openSetting() {
    // this.setting 可能因前端版本差异在 onload 时构建失败——这里惰性重建一次
    if (!this.setting || typeof this.setting.open !== "function") {
      try { this.buildSettingTab(); } catch (e) { console.error("[netglimmer-upload] buildSettingTab(retry)", e); }
    }
    if (!this.setting || typeof this.setting.open !== "function") return;
    this.vdSwitch = null;
    /* 重开设置弹窗 = 一次新的进入：把上一回的看板筛选与勾选清掉（上次停在看板页签上关掉
     * 弹窗的话，状态会留到下次），同时把「上一帧在不在看板」的标记归零。 */
    this._dashVisible = false;
    this.resetDashFilter();
    try {
      this.setting.open(this.displayName || this.t("settingsTitle"));
    } catch (e) {
      console.error("[netglimmer-upload] setting.open", e);
      return;
    }
    try {
      this.decorateSettingDialog();
    } catch (e) {
      console.error("[netglimmer-upload] decorateSettingDialog", e);
    }
  }

  decorateSettingDialog() {
    const dlg = this.setting && this.setting.dialog;
    const root = dlg && dlg.element;
    if (!root || typeof root.querySelector !== "function") return;
    const content = root.querySelector(".b3-dialog__content");
    if (!content) return;
    const self = this;

    // 把现有设置项整体包进「设置视图」，再并排挂一个「看板视图」
    let settingsView = null;
    let dashView = null;
    for (const ch of Array.prototype.slice.call(content.children || [])) {
      if (ch.classList && ch.classList.contains("vd-settings-view")) settingsView = ch;
      else if (ch.classList && ch.classList.contains("vd-dash-view")) dashView = ch;
    }
    if (!settingsView) {
      settingsView = document.createElement("div");
      settingsView.className = "vd-settings-view";
      while (content.firstChild) settingsView.appendChild(content.firstChild);
      content.appendChild(settingsView);
    }
    if (!dashView) {
      dashView = document.createElement("div");
      dashView.className = "vd-dash-view";
      dashView.style.cssText = "display:none;padding:2px 4px;";
      content.appendChild(dashView);
    }

    /* 推荐组合钉在「上传设置」视图最上面（第一条设置项之前）。
     * 也挂在这里而不是做成一条 setting 项：addItem 那一行的控件列被宿主强加
     * fn__size200（200px 固定宽），长文案塞进去必然把弹窗撑出横向滚动——
     * 「设置项都溢出了」就是那样来的。整块自己画，宽度跟着内容区走，
     * 文字用 word-break 兜住长串（英文字典下 "self-contained" 这类词很长）。 */
    for (const old of Array.prototype.slice.call(
      settingsView.querySelectorAll(".netglimmer-upload-rec") || [])) {
      if (old && old.remove) old.remove();
    }
    const rec = document.createElement("div");
    rec.className = "netglimmer-upload-rec";
    rec.style.cssText = "box-sizing:border-box;width:100%;margin:0 0 12px;padding:10px 12px;"
      + "border-left:3px solid var(--b3-theme-primary);border-radius:4px;"
      + "background:var(--b3-theme-surface-lighter);color:var(--b3-theme-on-surface);"
      + "font-size:13px;line-height:1.65;word-break:break-word;";
    const recHead = document.createElement("div");
    recHead.textContent = "★ " + this.t("recTitle");
    recHead.style.cssText = "font-weight:700;margin-bottom:4px;color:var(--b3-theme-primary);";
    const recBody = document.createElement("div");
    recBody.textContent = this.t("recBody");
    recBody.style.cssText = "color:var(--b3-theme-on-surface);";
    rec.append(recHead, recBody);
    settingsView.prepend(rec);

    /* 版本号钉在「上传设置」视图最底部居中。
     * 挂在这里而不是做成一条 setting 项——addItem 那一行是 flex（左边的标题块即使为空
     * 也占位），居中会整体偏右半格。重画前先摘掉旧的，避免反复开弹窗叠出好几行。
     * 版本取自 PLUGIN_VERSION（与加载日志同一个常量，run-settings.js 断言它等于
     * plugin.json 的 version），所以界面上不会出现过时的号。 */
    for (const old of Array.prototype.slice.call(
      settingsView.querySelectorAll(".netglimmer-upload-version") || [])) {
      if (old && old.remove) old.remove();
    }
    const ver = document.createElement("div");
    ver.className = "netglimmer-upload-version";
    ver.textContent = "v" + PLUGIN_VERSION;
    ver.title = "siyuan-plugin-netglimmer-Upload";
    ver.style.cssText = "width:100%;text-align:center;padding:12px 0 4px;"
      + "color:var(--b3-theme-on-surface-light);font-size:12px;user-select:all;";
    settingsView.appendChild(ver);

    const ui = {
      showClose: false,
      refresh: () => self.renderDash(dashView, ui),
      close: () => {},
      closeOnPublish: false,
    };

    const switchView = (name) => {
      const dash = name === "dash";
      /* 从看板切回设置页时复位筛选与勾选：筛选是这次的临时意图（见 dashView() 上面的注释），
       * 不该跟着下一次「打开看板」复活——否则上次筛剩一条，下次进来一张空表，看着像记录丢了。
       * _dashVisible 只记「上一帧在不在看板上」，第一次进设置弹窗时是 undefined，不误触发。 */
      if (!dash && this._dashVisible) this.resetDashFilter();
      this._dashVisible = dash;
      settingsView.style.display = dash ? "none" : "";
      dashView.style.display = dash ? "" : "none";
      for (const [key, el] of tabBtns) {
        el.style.fontWeight = key === name ? "700" : "400";
        el.style.borderBottom = key === name ? "2px solid var(--b3-theme-primary)" : "2px solid transparent";
        el.style.color = key === name ? "var(--b3-theme-primary)" : "var(--b3-theme-on-surface)";
      }
      /* 切到看板时把渲染的 promise 返回出去：renderDash 里现在要先等一次指纹批量查询
       * 才建行，调用方（含回归）await 它才能确定界面画完了。以前是浮空 promise，
       * 谁也别想知道自己是不是抢在了渲染前面。 */
      if (dash) return ui.refresh();
      return undefined;
    };

    // 头部页签按钮
    const mkTab = (key, label) => {
      const el = document.createElement("button");
      el.type = "button";
      el.textContent = label;
      el.style.cssText = "background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;font-size:14px;padding:5px 12px;color:var(--b3-theme-on-surface);white-space:nowrap;";
      el.addEventListener("click", () => switchView(key));
      return el;
    };
    const tabBtns = [
      ["settings", mkTab("settings", this.t("settingsTab"))],
      ["dash", mkTab("dash", this.t("dashboard"))],
    ];
    const header = root.querySelector(".b3-dialog__header");
    const mount = header || content;
    let bar = null;
    for (const ch of Array.prototype.slice.call(mount.children || [])) {
      if (ch.classList && ch.classList.contains("vd-view-tabs")) bar = ch;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "vd-view-tabs";
      bar.style.cssText = "display:inline-flex;align-items:center;gap:2px;margin-left:14px;vertical-align:middle;";
      for (const [, el] of tabBtns) bar.appendChild(el);
      if (header && header.lastElementChild) header.insertBefore(bar, header.lastElementChild);
      else if (header) header.appendChild(bar);
      else content.insertBefore(bar, content.firstChild);
    }
    this.vdSwitch = switchView;
    switchView("settings");
  }

  /* ---------- 每协议独立配置（profiles） ---------- */

  /* 把 profiles 规范化成「四个协议槽都在、每个槽五个字段都是字符串」的那一份私有副本。
   * 注意：Object.assign 是浅拷贝，settings.profiles 会别名到模块级 DEFAULT_SETTINGS.profiles，
   * 直接改它会污染所有后续实例的默认值。这里总是重建一份私有副本再落回。 */
  normalizeProfiles() {
    const s = this.settings || {};
    const src = (s.profiles && typeof s.profiles === "object") ? s.profiles : {};
    const fresh = {};
    for (const p of PROTO_KEYS) {
      const base = (src[p] && typeof src[p] === "object") ? src[p] : {};
      fresh[p] = {
        server: base.server || "", port: String(base.port || ""),
        username: base.username || "",
        password: base.password || "", prefix: base.prefix || "",
      };
    }
    s.profiles = fresh;
    this.settings = s;
  }

  /* 返回某协议保存的凭据（缺字段回退空串）。 */
  profileFor(proto) {
    const s = this.settings || {};
    const p = (s.profiles && s.profiles[proto]) || {};
    const out = { server: "", port: "", username: "", password: "", prefix: "" };
    for (const k of CRED_FIELDS) if (p[k] != null) out[k] = p[k];
    return out;
  }

  /* 发布 / 连接测试使用的“生效配置”：公共开关 + 当前生效协议的凭据。
   * protoOverride 用于「按历史记录重试」——同一篇文档可能要重发到它当初用的那个协议。 */
  effective(protoOverride) {
    const s = this.settings || {};
    const known = ["webdav", "ftp", "sftp", "local"];
    const want = String(protoOverride || "").toLowerCase();
    const proto = known.includes(want) ? want : (s.protocol || "webdav");
    const p = this.profileFor(proto);
    return {
      protocol: proto,
      server: p.server, port: p.port, username: p.username, password: p.password, prefix: p.prefix,
      cleanOld: s.cleanOld !== false, addToc: s.addToc !== false,
      exportFormat: normFormat(s.exportFormat),
      publishMerge: s.publishMerge !== false,
      incremental: s.incremental !== false,
      safeNames: s.safeNames !== false,
      knownHosts: s.knownHosts || {}, profiles: s.profiles,
      // 全局调优项（与协议无关，发布/取消发布都要用）
      debug: !!s.debug,
      retryTries: clampInt(s.retryTries, 1, 6, 3),
      concurrency: clampInt(s.concurrency, 0, 16, 0),
      maxFileMB: clampInt(s.maxFileMB, 0, 4096, 64),
    };
  }

  /* 把当前表单里的 server/port/username/password/prefix 收进「本次对话框的草稿」。
   * 刻意不写 this.settings.profiles：settings 会被别的路径整份落盘（清除已知主机密钥
   * 就是 saveData(SETTINGS_KEY, this.settings)），也会被真实上传读到（effective()）。
   * 用户在下拉框里切一下协议本意只是「去看看另一套配置」，此刻表单里可能是改了一半的
   * 密码——它既不该下次打开设置页时当成已保存的值显示出来，更不该直接生效到线上传输上。
   * 唯一真正的提交入口是「保存设置」按钮 → applyFormToSettings。 */
  commitFormToProfile(proto) {
    const e = this.els || {};
    if (!this._formDraft) this._formDraft = {};
    this._formDraft[proto] = {
      server: normServer(e.server && e.server.value),
      // 端口按协议存："" = 留空（用默认端口）；非法值原样留着（见 keepPort）
      port: keepPort(e.port && e.port.value),
      username: String((e.username && e.username.value) || "").trim(),
      password: (e.password && e.password.value) || "",
      prefix: normPrefix(e.prefix && e.prefix.value),
    };
  }

  /* 把某协议的配置载入表单输入框：本次草稿优先于已保存的 profile
   * （来回切协议要看得见自己刚填的那一份，但那一份在按保存之前只活在这里）。 */
  loadProfileToForm(proto) {
    const p = (this._formDraft && this._formDraft[proto]) || this.profileFor(proto);
    const e = this.els || {};
    if (e.server) e.server.value = p.server;
    if (e.port) e.port.value = p.port;
    if (e.username) e.username.value = p.username;
    if (e.password) e.password.value = p.password;
    if (e.prefix) e.prefix.value = p.prefix;
  }

  buildSettingTab() {
    // 注意：字段工厂在每次打开对话框时才执行，必须实时读取当前生效协议的 profile，
    // 不能在此处快照——否则保存后重开仍显示旧值（空值）。
    // 生效协议以持久化的 settings.protocol 为准（未保存的切换不改变重开后的显示）。
    const activeProto = () => this.settings.protocol || "webdav";
    const credVal = (k) => this.profileFor(activeProto())[k];
    const live = () => this.settings || {};
    // 本次打开对话框时生效的协议；切换下拉框会改 this.draftProto 并即时刷新表单
    this.draftProto = activeProto();
    const mkInput = (key, type, value, placeholder) => {
      const el = document.createElement("input");
      el.className = "b3-text-field";
      el.type = type;
      el.value = value ?? "";
      el.placeholder = placeholder || "";
      /* 交给浏览器/密码管理器时按字段给正确的语义：
       *   · 密码写 new-password——这里存的是远端服务器的访问密码，默认的 "on" 会让
       *     浏览器把「个人账号」那套密码填进来，填错比不填更难查（它是密文回显的，
       *     用户看不见自己填进去的是什么）；
       *   · 用户名给 username，地址给 url，前缀这类路径明确 off。
       * name 带插件前缀：同一页面上思源自己的表单也在收 autofill，撞名就会填错字段。 */
      el.name = "netglimmer-upload-" + key;
      el.autocomplete = type === "password" ? "new-password"
        : key === "username" ? "username"
          : key === "server" ? "url" : "off";
      el.style.width = "280px";
      // 容器被压窄时输入框跟着缩，不许从容器里溢出去（见 fitAction）
      el.style.maxWidth = "100%";
      el.style.boxSizing = "border-box";
      // 思源在 document 级全局拦截 paste（转发给编辑器），会在对话框里吞掉 Ctrl+V；
      // 在 input 自身截停冒泡，浏览器默认粘贴即可正常插入剪贴板文本
      el.addEventListener("paste", (e) => e.stopPropagation());
      this.els[key] = el;
      return el;
    };
    const mkCheck = (key, checked) => {
      const el = document.createElement("input");
      el.type = "checkbox";
      el.className = "b3-form__create-icon";
      el.checked = !!checked;
      el.style.cssText = "width:16px;height:16px;cursor:pointer;";
      this.els[key] = el;
      return el;
    };
    const mkNum = (key, value, min, max, step) => {
      const el = document.createElement("input");
      el.type = "number";
      el.className = "b3-text-field";
      el.value = String(value ?? "");
      el.min = String(min);
      el.max = String(max);
      el.step = String(step || 1);
      /* 数字框也要表态：端口/并发这类格子被浏览器「好心」填上一个存过的数字，
       * 比留空更难查——连接会报一个跟真实原因无关的错。name 同 mkInput 带插件前缀。 */
      el.name = "netglimmer-upload-" + key;
      el.autocomplete = "off";
      el.style.width = "110px";
      el.style.maxWidth = "100%";
      el.style.boxSizing = "border-box";
      el.addEventListener("paste", (e) => e.stopPropagation());
      this.els[key] = el;
      return el;
    };
    /* saplay 的 Setting.addItem 在 open() 里会给**每一个**非开关控件强行加 fn__size200，
     * 而它的 CSS 是 `width:200px;flex-shrink:0`——自绘容器只要比 200px 宽，内容就整块溢出到
     * 标签列右侧的弹窗边缘外，把 .b3-dialog__content（overflow:auto）顶出横向滚动条；
     * 而 saplay 打开弹窗后还会 focus 第一个输入框，于是内容被滚到左边、**所有标题被裁掉左半边**。
     * 类名是它加的、改不掉，但它不碰内联样式：这里用内联把「钉死 200px、不许缩」覆盖回
     * 「按内容宽、可缩到容器允许为止」。真浏览器量出来的结论，见 harness/run-layout.js。 */
    const fitAction = (el) => {
      el.style.width = "auto";
      el.style.maxWidth = "100%";
      el.style.minWidth = "0";
      el.style.flexShrink = "1";
      el.style.boxSizing = "border-box";
      return el;
    };

    const protoPlaceholder = (v) => v === "ftp" ? "192.168.1.10"
      : v === "sftp" ? "192.168.1.10"
      : v === "local" ? (global.navigator && /Win/i.test(global.navigator.platform || "") ? "D:\\www\\upload" : "/var/www/html")
      : "https://example.com/dav";
    /* 控件下面挂一行联动小字。Setting 的 description 是建好就定死的字符串，
     * 而这几条提示要跟着输入内容和当前协议变（协议一切，「地址该长什么样」就换了），
     * 所以自己做一层 hint：只提示、不拦保存。
     * 地址与端口互为上下文（地址里写了端口、端口框空着 → 灰字说清用哪个），
     * 所以两条提示一起算，任何一格变化都同步刷新。 */
    const hintOf = (kind) => {
      const hint = this.els[kind + "Hint"];
      const inp = this.els[kind];
      if (!hint || !inp) return;
      const proto = (this.els.protocol && this.els.protocol.value) || activeProto();
      const r = fieldHintFor(kind, proto, inp.value, (k) => this.t(k), {
        addr: this.els.server ? this.els.server.value : "",
        port: this.els.port ? this.els.port.value : "",
      });
      hint.textContent = r.text;
      hint.style.color = r.warn
        ? "var(--b3-card-error-color, var(--b3-theme-error))"
        : "var(--b3-theme-on-surface-light)";
    };
    const syncCredHints = () => {
      for (const k of ["server", "port", "username", "prefix"]) hintOf(k);
      // 端口只对 FTP/SFTP 有意义：WebDAV 写在 URL 里，本地目录根本没有端口
      const proto = (this.els.protocol && this.els.protocol.value) || activeProto();
      const show = proto === "ftp" || proto === "sftp";
      if (this.els.portCol) this.els.portCol.style.display = show ? "" : "none";
      if (this.els.port) this.els.port.placeholder = show ? this.t("portPhShort").replace("{n}", String(DEFAULT_PORTS[proto])) : "";
      // 地址与端口的提示同排一行：两截都有话要说时才放分隔符，否则留个空洞
      if (this.els.addrHintSep) {
        const both = this.els.serverHint && this.els.portHint
          && this.els.serverHint.textContent && this.els.portHint.textContent;
        this.els.addrHintSep.style.display = both ? "" : "none";
      }
    };
    const mkField = (key, el) => {
      const wrap = document.createElement("div");
      wrap.className = "vd-field";
      wrap.style.cssText = "display:flex;flex-direction:column;gap:3px;";
      fitAction(wrap);
      wrap.append(el);
      const hint = document.createElement("div");
      hint.className = "vd-field-hint";
      hint.style.cssText = "font-size:12px;max-width:460px;color:var(--b3-theme-on-surface-light);overflow-wrap:anywhere;";
      wrap.append(hint);
      this.els[key + "Hint"] = hint;
      el.addEventListener("input", () => hintOf(key));
      hintOf(key);
      return wrap;
    };
    /* 地址和端口并排（FTP/SFTP）：端口就在地址右边，配「服务器不在默认端口」时不用来回找。
     * 端口列只对 FTP/SFTP 显示——WebDAV 的端口写在 URL 里，本地目录压根没有端口这回事。
     * 两格的提示互看对方（地址里写了 2121、端口框空着 → 灰字说清用的是哪一个）。
     * 提示**只有一行、挂在两格下面**：曾经做成「左列一行 + 右列一行」，两列各带一条
     * 460/240px 宽的提示，容器被撑到 710px——那正是把设置弹窗顶出横向滚动、
     * 标题被裁掉一半的直接原因（现场报告过一次）。整块的设计宽度因此是 460px。 */
    const mkAddrRow = () => {
      const p0 = activeProto();
      const box = document.createElement("div");
      box.className = "vd-addr-box";
      box.style.cssText = "display:flex;flex-direction:column;gap:3px;";
      fitAction(box);
      const row = document.createElement("div");
      row.className = "vd-addr-row";
      row.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;";
      const addr = mkInput("server", "text", credVal("server"), protoPlaceholder(p0));
      addr.style.width = "300px";
      addr.style.flex = "1 1 240px";
      addr.style.minWidth = "0";
      const col = document.createElement("div");
      col.className = "vd-port-col";
      col.style.cssText = "display:flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0;";
      const lab = document.createElement("span");
      lab.className = "vd-port-label";
      lab.textContent = this.t("port");
      lab.style.cssText = "font-size:12px;color:var(--b3-theme-on-surface-light);white-space:nowrap;";
      const pin = mkNum("port", credVal("port"), 1, 65535);
      pin.style.width = "96px";
      pin.style.flex = "0 0 auto";
      pin.title = this.t("portDesc");
      col.append(lab, pin);
      row.append(addr, col);
      const line = document.createElement("div");
      line.className = "vd-field-hint vd-addr-hint";
      line.style.cssText = "font-size:12px;max-width:460px;color:var(--b3-theme-on-surface-light);overflow-wrap:anywhere;";
      const sh = document.createElement("span");
      sh.className = "vd-hint-part vd-server-hint";
      const sep = document.createElement("span");
      sep.className = "vd-hint-sep";
      sep.textContent = " ｜ ";
      sep.style.display = "none";
      const ph = document.createElement("span");
      ph.className = "vd-hint-part vd-port-hint";
      line.append(sh, sep, ph);
      this.els.serverHint = sh;
      this.els.portHint = ph;
      this.els.addrHintSep = sep;
      this.els.portCol = col;
      addr.addEventListener("input", () => syncCredHints());
      pin.addEventListener("input", () => syncCredHints());
      box.append(row, line);
      syncCredHints();
      return box;
    };
    const mkProto = () => {
      /* 这个工厂每次打开设置对话框都会重跑一次（字段值要实时读，见 buildSettingTab 开头），
       * 草稿在这里作废：上次没按「保存设置」就关掉的半截输入，不该在这次里冒出来。 */
      this._formDraft = {};
      const el = document.createElement("select");
      el.className = "b3-select";
      el.style.cssText = "padding:4px 8px;";
      for (const [v, l] of [["webdav", "WebDAV"], ["ftp", "FTP"], ["sftp", "SFTP"], ["local", this.t("localProto")]]) {
        const o = document.createElement("option");
        o.value = v; o.textContent = l;
        el.append(o);
      }
      el.value = activeProto();
      el.addEventListener("change", () => {
        const oldProto = this.draftProto || activeProto();
        const newProto = el.value;
        // 切换协议：先把当前表单里的凭据写回旧协议，再把新协议的配置载入表单
        this.commitFormToProfile(oldProto);
        this.draftProto = newProto;
        this.loadProfileToForm(newProto);
        const inp = this.els.server;
        if (inp) inp.placeholder = protoPlaceholder(newProto);
        // 换了协议，「地址该长什么样」「用户名要不要填」「端口留空等于几」三条提示的
        // 口径跟着换，端口列本身也要在 WebDAV/本地 下藏起来
        syncCredHints();
      });
      this.els.protocol = el;
      return el;
    };

    /* 导出格式下拉框。它是全局的（与协议无关）：换协议不换格式，换格式不换协议。
     * 值与 mkProto 一样只写进 this.els，落盘统一由「保存设置」按钮走 readForm。 */
    const mkFormat = () => {
      const el = document.createElement("select");
      el.className = "b3-select";
      el.style.cssText = "padding:4px 8px;";
      for (const [v, l] of [["html", this.t("fmtHtml")], ["md", this.t("fmtMd")], ["docx", this.t("fmtDocx")]]) {
        const o = document.createElement("option");
        o.value = v; o.textContent = l;
        el.append(o);
      }
      el.value = normFormat(live().exportFormat);
      el.addEventListener("change", () => { this.els.exportFormat = el; });
      this.els.exportFormat = el;
      return el;
    };

    this.setting = new Setting({ width: "min(1200px, 94vw)", height: "86vh" });

    this.setting.addItem({
      title: this.t("protocol"),
      description: this.t("protocolDesc"),
      createActionElement: () => mkProto(),
    });
    this.setting.addItem({
      title: this.t("exportFormat"),
      description: this.t("exportFormatDesc"),
      createActionElement: () => mkFormat(),
    });
    this.setting.addItem({
      title: this.t("server"),
      description: this.t("serverDescAny"),
      createActionElement: () => mkAddrRow(),
    });
    this.setting.addItem({
      title: this.t("username"),
      // 之前这里是空串：用户名到底是干什么的、本地协议为什么可以不填，全靠读者猜
      description: this.t("usernameDescShort"),
      createActionElement: () => mkField("username",
        mkInput("username", "text", credVal("username"), "")),
    });
    this.setting.addItem({
      title: this.t("password"),
      description: this.t("passwordHint"),
      createActionElement: () => mkInput("password", "password", credVal("password"), ""),
    });
    this.setting.addItem({
      title: this.t("prefix"),
      description: this.t("prefixDesc"),
      createActionElement: () => mkField("prefix",
        mkInput("prefix", "text", credVal("prefix"), "publish")),
    });
    this.setting.addItem({
      title: this.t("cleanOld"),
      description: this.t("cleanOldDesc"),
      createActionElement: () => mkCheck("cleanOld", live().cleanOld),
    });
    this.setting.addItem({
      title: this.t("addToc"),
      description: this.t("addTocDesc"),
      createActionElement: () => mkCheck("addToc", live().addToc !== false),
    });
    this.setting.addItem({
      title: this.t("publishMergeSetting"),
      description: this.t("publishMergeDesc"),
      createActionElement: () => mkCheck("publishMerge", live().publishMerge !== false),
    });
    this.setting.addItem({
      title: this.t("incremental"),
      description: this.t("incrementalDesc"),
      createActionElement: () => mkCheck("incremental", live().incremental !== false),
    });
    this.setting.addItem({
      title: this.t("safeNames"),
      description: this.t("safeNamesDesc"),
      createActionElement: () => mkCheck("safeNames", live().safeNames !== false),
    });
    this.setting.addItem({
      title: this.t("retryTries"),
      description: this.t("retryTriesDesc"),
      createActionElement: () => mkNum("retryTries", clampInt(live().retryTries, 1, 6, 3), 1, 6),
    });
    this.setting.addItem({
      title: this.t("concurrency"),
      description: this.t("concurrencyDesc"),
      createActionElement: () => mkNum("concurrency", clampInt(live().concurrency, 0, 16, 0), 0, 16),
    });
    this.setting.addItem({
      title: this.t("maxFileMB"),
      description: this.t("maxFileMBDesc"),
      createActionElement: () => mkNum("maxFileMB", clampInt(live().maxFileMB, 0, 4096, 64), 0, 4096),
    });
    this.setting.addItem({
      title: this.t("debug"),
      description: this.t("debugDesc"),
      createActionElement: () => mkCheck("debug", !!live().debug),
    });
    // SFTP 换过主机密钥后指纹校验会拒绝连接，README 让用户“清空已知主机密钥”——
    // 之前就根本没有这个入口，只能手改 settings.json。
    this.setting.addItem({
      title: this.t("knownHosts"),
      description: this.t("knownHostsDesc"),
      createActionElement: () => {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
        fitAction(wrap);
        const info = document.createElement("span");
        const cnt = Object.keys((live().knownHosts) || {}).length;
        info.textContent = cnt
          ? this.t("knownHostsCount").replace("{n}", String(cnt))
          : this.t("knownHostsNone");
        info.style.cssText = "font-size:12px;color:var(--b3-theme-on-surface-light);";
        const clr = document.createElement("button");
        clr.className = "b3-button b3-button--outline";
        clr.style.cssText = "padding:4px 12px;font-size:12px;";
        clr.textContent = this.t("clearHosts");
        clr.disabled = !cnt;
        clr.addEventListener("click", async () => {
          if (!window.confirm(this.t("clearHostsConfirm"))) return;
          /* 清空已知主机密钥是「下次连接重新 TOFU」这件事的唯一记录：写不进去时
           * 内存里清了、磁盘上没清，重开思源又全回来了——所以这一句也必须让人看见。
           * 成功后才改那行计数文案，否则界面说「没有」、配置里还躺着旧指纹。 */
          const keep = this.settings.knownHosts;
          this.settings.knownHosts = {};
          let ok = true;
          try { await this.saveData(SETTINGS_KEY, this.settings); }
          catch (e) {
            ok = false;
            this.settings.knownHosts = keep;
            console.error("[netglimmer-upload] clear knownHosts", errForLog(e));
            showMessage(`${this.t("saveFail")}: ${redactUrl(String(e.message || e))}`, 7000, "error");
          }
          if (!ok) return;
          if (this.els.knownHostsInfo) this.els.knownHostsInfo.textContent = this.t("knownHostsNone");
          showMessage(this.t("clearHostsDone"), 3000, "ok");
        });
        this.els.knownHostsInfo = info;
        wrap.append(info, clr);
        return wrap;
      },
    });

    // 操作行：测试连接 + 保存 + 结果显示
    const actionWrap = document.createElement("div");
    actionWrap.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;";
    const testBtn = document.createElement("button");
    testBtn.className = "b3-button b3-button--outline";
    testBtn.style.cssText = "padding:5px 16px;";
    testBtn.textContent = this.t("test");
    const saveBtn = document.createElement("button");
    saveBtn.className = "b3-button";
    saveBtn.style.cssText = "padding:5px 16px;";
    saveBtn.textContent = this.t("save");
    const result = document.createElement("span");
    result.style.cssText = "color:var(--b3-theme-on-surface);word-break:break-all;max-width:360px;";
    actionWrap.append(testBtn, saveBtn, result);
    this.els.testBtn = testBtn;
    this.els.saveBtn = saveBtn;
    this.els.result = result;

    testBtn.addEventListener("click", async () => {
      const draft = this.readForm();
      const needAuth = draft.protocol !== "local";
      if (!draft.server || (needAuth && !draft.username)) {
        result.textContent = draft.protocol === "local"
          ? this.t("needLocalPath") : this.t("testNeedFields");
        result.style.color = "var(--b3-theme-error)";
        return;
      }
      testBtn.disabled = true;
      result.textContent = this.t("testing");
      result.style.color = "var(--b3-theme-on-surface)";
      try {
        const msg = await this.testConnection(draft);
        const ok = !msg.fail;
        result.textContent = msg.text;
        result.style.color = ok ? "var(--b3-theme-primary)" : "var(--b3-theme-error)";
      } catch (e) {
        result.textContent = e.message;
        result.style.color = "var(--b3-theme-error)";
      } finally {
        testBtn.disabled = false;
      }
    });

    /* 落盘这件事必须让人看见：写不进去时「已经填好的表单」和「下次生效的配置」
     * 就分家了，而用户看到的只有静默——下次打开设置页发现值又变回去，
     * 只会以为插件没保存功能。按钮期间禁用，防连点写出两份。 */
    saveBtn.addEventListener("click", async () => {
      // 就地合并，保持 this.settings 对象引用不变（避免其它地方持有的快照失效）
      const draft = this.readForm();
      try { prefixSegsOf(draft.prefix); } catch (e) {
        result.textContent = e.message;
        result.style.color = "var(--b3-theme-error)";
        showMessage(e.message, 5000, "error");
        return;
      }
      this.applyFormToSettings(draft);
      saveBtn.disabled = true;
      let okSave = true;
      try {
        await this.saveData(SETTINGS_KEY, this.settings);
        setDebug(this.settings.debug);
      } catch (e) {
        okSave = false;
        console.error("[netglimmer-upload] save settings", errForLog(e));
        const msg = `${this.t("saveFail")}: ${redactUrl(String(e.message || e))}`;
        result.textContent = msg;
        result.style.color = "var(--b3-theme-error)";
        showMessage(msg, 7000, "error");
      } finally {
        saveBtn.disabled = false;
      }
      if (okSave) showMessage(this.t("saved"), 2000, "ok");
    });

    this.setting.addItem({
      title: "",
      description: "",
      createActionElement: () => actionWrap,
    });
  }

  readForm() {
    const e = this.els;
    return {
      protocol: e.protocol?.value || "webdav",
      exportFormat: normFormat(e.exportFormat?.value),
      server: normServer(e.server?.value),
      port: keepPort(e.port?.value),
      username: (e.username?.value || "").trim(),
      password: e.password?.value || "",
      prefix: normPrefix(e.prefix?.value),
      cleanOld: !!e.cleanOld?.checked,
      addToc: !!e.addToc?.checked,
      publishMerge: !!e.publishMerge?.checked,
      incremental: !!e.incremental?.checked,
      safeNames: !!e.safeNames?.checked,
      knownHosts: this.settings.knownHosts || {},
      debug: !!e.debug?.checked,
      retryTries: clampInt(e.retryTries?.value, 1, 6, 3),
      concurrency: clampInt(e.concurrency?.value, 0, 16, 0),
      maxFileMB: clampInt(e.maxFileMB?.value, 0, 4096, 64),
    };
  }

  /* 把 readForm 的结果落到 profiles：当前表单凭据只写进它所属协议的那一格，
   * 顶层不再镜像一套（配置里只有一种形状）。就地合并。 */
  applyFormToSettings(form) {
    this.settings.profiles = this.settings.profiles || {};
    /* 切过协议的那几格草稿一并提交（用户按保存就是要存这一屏改过的所有格子），
     * 当前表单最后写——它才是 form.protocol 那一格的权威值。 */
    for (const k of Object.keys(this._formDraft || {})) {
      this.settings.profiles[k] = this._formDraft[k];
    }
    this._formDraft = {};
    this.settings.profiles[form.protocol] = {
      server: form.server, port: form.port, username: form.username,
      password: form.password, prefix: form.prefix,
    };
    this.draftProto = form.protocol;
    Object.assign(this.settings, {
      protocol: form.protocol,
      exportFormat: form.exportFormat,
      cleanOld: form.cleanOld, addToc: form.addToc, publishMerge: form.publishMerge,
      incremental: form.incremental, knownHosts: form.knownHosts,
      safeNames: form.safeNames,
      // 这四个新旋钮必须也写在这里，否则界面上改了、保存后失效
      debug: form.debug, retryTries: form.retryTries,
      concurrency: form.concurrency, maxFileMB: form.maxFileMB,
      profiles: this.settings.profiles,
    });
    return this.settings;
  }

  /* ---------- 连接测试：可达性 + 读写探针 ---------- */

  async testConnection(s) {
    // 前缀里出现 . / .. 会让任何协议的路径拼接跑出基础目录，直接拒绝
    try { prefixSegsOf(s.prefix); } catch (e) { return { fail: true, text: e.message }; }
    if (s.protocol === "local") return this.testConnectionLocal(s);
    if (s.protocol === "ftp" || s.protocol === "sftp") return this.testConnectionFs(s);
    const rootUrl = joinUrl(s.server, s.prefix) + "/";
    // 1. PROPFIND Depth 0 探测可达性与认证
    let probe;
    try {
      probe = await davPropfind(s, rootUrl, "0");
    } catch (e) {
      return { fail: true, text: this.t("testUnreachable").replace("{e}", e.message) };
    }
    if (probe.status === 401 || probe.status === 403) {
      return { fail: true, text: this.t("testAuthFail").replace("{s}", probe.status) };
    }
    // 真伪检测：PROPFIND 正常应答必须含 WebDAV XML；返回 HTML 说明这不是 WebDAV 端点
    const body = probe.body || "";
    const isDavXml = /multistatus|<propfind|<d:|<dav:/i.test(body);
    const isHtml = /<html|<!doctype html/i.test(body);
    if (isHtml && !isDavXml) {
      return { fail: true, text: this.t("testNotWebdav") };
    }
    let text;
    if (probe.status === 404) {
      text = this.t("testNotFound").replace("{s}", probe.status);
    } else if (probe.status === 207 || probe.status === 200) {
      text = this.t("testReachable").replace("{s}", probe.status);
    } else {
      return { fail: true, text: this.t("testUnreachable").replace("{e}", `HTTP ${probe.status}`) };
    }

    // 2. 读写探针：MKCOL 临时目录 → PUT 小文件 → GET 读回校验 → DELETE 清理
    const stamp = Date.now();
    const probeUrl = joinUrl(s.server, s.prefix, `.wdav-probe-${stamp}`);
    try {
      const mk = await davRequest(s, "MKCOL", probeUrl);
      if (!okStatus(mk.status, [200, 201, 204, 405])) {
        return { fail: true, text: text + this.t("testWriteFail").replace("{e}", `MKCOL HTTP ${mk.status}`) };
      }
      const fileUrl = probeUrl + "/probe.txt";
      await davPut(s, fileUrl, utf8Bytes("wdav-publish-probe"));
      const back = await davGet(s, fileUrl);
      if (back.status !== 200 || !String(back.body).includes("wdav-publish-probe")) {
        return { fail: true, text: text + this.t("testVerifyFail") };
      }
      await davDelete(s, fileUrl);
      await davDelete(s, probeUrl + "/");
      return { fail: false, text: text + this.t("testWriteOk") };
    } catch (e) {
      return { fail: true, text: text + this.t("testWriteFail").replace("{e}", e.message) };
    }
  }

  /* ---------- publish ---------- */

  /* FTP/SFTP 连接测试：登录 → 建 prefix → 8KB 探针（尺寸核验+删除） */
  async testConnectionFs(s) {
    const segs = prefixSegsOf(s.prefix);
    const up = makeUploader(s, { hostKeys: this.hostKeyStore() });
    try {
      await up.open();
    } catch (e) {
      return { fail: true, text: this.t("testUnreachable").replace("{e}", e.message) };
    }
    try {
      await up.mkdir(segs);
      await up.probe(segs);
      let text = this.t("testLoggedIn") + this.t("testWriteOk");
      if (up.fingerprint) text += this.t("testFp").replace("{fp}", up.fingerprint);
      return { fail: false, text };
    } catch (e) {
      return { fail: true, text: this.t("testLoggedIn") + this.t("testWriteFail").replace("{e}", e.message) };
    } finally {
      try { await up.close(); } catch (e) { /* noop */ }
    }
  }

  /* 本地目录测试：解析路径 → 建 prefix → 8KB 探针（尺寸核验+删除） */
  async testConnectionLocal(s) {
    if (!String(s.server || "").trim()) {
      return { fail: true, text: this.t("needLocalPath") };
    }
    const segs = prefixSegsOf(s.prefix);
    const up = makeUploader(s, {});
    try {
      await up.open();
    } catch (e) {
      return { fail: true, text: this.t("testUnreachable").replace("{e}", e.message) };
    }
    try {
      await up.mkdir(segs);
      await up.probe(segs);
      return { fail: false, text: this.t("testLocalOk").replace("{p}", up.base) + this.t("testWriteOk") };
    } catch (e) {
      return { fail: true, text: this.t("testLocalOk").replace("{p}", up.base) + this.t("testWriteFail").replace("{e}", e.message) };
    } finally {
      try { await up.close(); } catch (e) { /* noop */ }
    }
  }

  /* SFTP TOFU：hostKeys 适配器，持久化到 settings.knownHosts */
  /* SFTP TOFU：hostKeys 适配器，持久化到 settings.knownHosts。
   * 写盘失败必须说出来（原来是彻底静默）：指纹没落地，下次连接就是「重新第一次见」，
   * 服务器密钥真变了也不会有任何人被提醒——TOFU 只剩半个 T。 */
  hostKeyStore() {
    const self = this;
    const persist = () => {
      try {
        Promise.resolve(self.saveData(SETTINGS_KEY, self.settings)).catch((e) => {
          console.error("[netglimmer-upload] knownHosts save", errForLog(e));
          showMessage(self.t("hostKeySaveFail"), 8000, "warn");
        });
      } catch (e) {
        console.error("[netglimmer-upload] knownHosts save", errForLog(e));
        showMessage(self.t("hostKeySaveFail"), 8000, "warn");
      }
    };
    return {
      get: (k) => (self.settings.knownHosts || {})[k],
      set: (k, v) => {
        self.settings.knownHosts = self.settings.knownHosts || {};
        self.settings.knownHosts[k] = v;
        persist();
      },
    };
  }

  /* ── 当前文档与命令面板入口 ───────────────────────────────────────────
   * 「发布当前文档」得先知道当前是哪篇。可靠来源只有两个：思源在切页/加载预览时
   * 派发的事件（detail = {protyle}），以及命令执行上下文里的 protyle。两者都拿不到
   * 就明确报「找不到当前打开的文档」——绝不用 DOM 猜测去发一篇错的文档，发错是要
   * 覆盖线上内容的。 */
  docIdFromProtyle(p) {
    if (!p || typeof p !== "object") return "";
    const b = p.block || {};
    const id = p.rootID || b.rootID || b.rootId || "";
    return typeof id === "string" ? id : "";
  }

  trackCurrentDoc() {
    this.currentDocId = "";
    const remember = (detail) => {
      try {
        const id = this.docIdFromProtyle(detail && detail.protyle);
        if (id) this.currentDocId = id;   // 取不到就留着上一次的，别把已有值清成空
      } catch (e) { /* 事件结构随版本变，静默降级到「无当前文档」 */ }
    };
    for (const ev of ["switch-protyle", "loaded-protyle-static", "loaded-protyle-dynamic"]) {
      try { this.eventBus.on(ev, (e) => remember(e && e.detail)); }
      catch (err) { console.warn("[netglimmer-upload] eventBus.on", ev, (err && err.message) || err); }
    }
  }

  /* 命令面板 / 快捷键入口。优先调用宿主的 addCommand（面板可见性由它决定），
   * 没有该 API 的老版本回落到直接维护 this.commands；思源把 this.commands 当数组读（ICommand[]），个别版本还可能
   * 从 plugin.json 预填，所以这里不整块覆盖：按 langKey「有则补回调、无则追加」，
   * 用户自己绑过的快捷键不会被抹掉。
   * 默认不带快捷键：符号格式（⌥⇧⌘ 顺序）与既有绑定是否冲突，本机无从验证——
   * 抢注别人的键比少一个键更糟。请在 设置→快捷键 里自行绑定。
   * execute / callback / editorCallback 三个都填：后两者存在时会被优先选中，
   * 焦点在编辑器还是别处都能触发。 */
  registerCommands() {
    const defs = [
      { langKey: "cmdPublishCurrent", run: (ctx) => this.publishCurrent(ctx) },
      { langKey: "cmdOpenDashboard", run: () => this.showDashboard() },
      { langKey: "cmdRepublishAll", run: () => this.bulkRepublishChanged() },
    ];
    try {
      if (!Array.isArray(this.commands)) this.commands = [];
      for (const d of defs) {
        const fire = (ctx) => {
          try { return d.run(ctx); }
          catch (e) { console.error("[netglimmer-upload] command", d.langKey, e); }
        };
        const editorFire = (protyle, ctx) => fire(Object.assign({}, ctx || {}, { protyle }));
        let item = this.commands.find((c) => c && c.langKey === d.langKey);
        /* 宿主有 addCommand 就走它，别只往数组里塞：面板/快捷键的注册各版本实现不同，
         * 「数组里有条目」和「用户在命令面板里看得见」不是一回事，本机没有前端无法验证，
         * 所以两条路都走一遍（已存在同 langKey 时不再调，免得面板里出现两条）。 */
        if (!item && typeof this.addCommand === "function") {
          try {
            this.addCommand({
              langKey: d.langKey, langText: this.t(d.langKey),
              execute: fire, callback: fire, editorCallback: editorFire,
            });
          } catch (e) {
            console.error("[netglimmer-upload] addCommand", d.langKey, e);
          }
          item = this.commands.find((c) => c && c.langKey === d.langKey);
        }
        if (!item) { item = { langKey: d.langKey }; this.commands.push(item); }
        item.execute = fire;
        item.callback = fire;
        item.editorCallback = editorFire;
        if (!item.langText) item.langText = this.t(d.langKey);
      }
      /* 同 langKey 只留一条（addCommand 追加 + plugin.json 预填可能撞上）。
       * 优先留「带回调的那条」：面板取哪一条不由我们决定，留错等于点了没反应。 */
      const keep = new Map();
      const hasCb = (c) => typeof c.execute === "function" || typeof c.callback === "function";
      for (const c of this.commands) {
        if (!c || typeof c.langKey !== "string") continue;
        const prev = keep.get(c.langKey);
        if (!prev || (hasCb(c) && !hasCb(prev))) keep.set(c.langKey, c);
      }
      this.commands = this.commands.filter((c) => c && typeof c.langKey === "string"
        && keep.get(c.langKey) === c);
    } catch (e) {
      console.error("[netglimmer-upload] registerCommands", e);
    }
  }

  publishCurrent(ctx) {
    const id = (ctx && this.docIdFromProtyle(ctx.protyle)) || this.currentDocId || "";
    if (!id) {
      showMessage(this.t("noCurrentDoc"), 5000, "warn");
      return;
    }
    return this.publish(id, this.settings.publishMerge !== false);
  }

  /* 打开发布看板：优先设置弹窗里的看板视图（与状态栏入口一致），
   * 不可用再回退独立页签/弹窗。
   * 每次从外部入口进来都先复位筛选——上一次找「失败」的那一屏不该在原处等着人。 */
  showDashboard() {
    this.resetDashFilter();
    try { this.openSetting(); } catch (e) { /* noop */ }
    if (this.vdSwitch) {
      try { this.vdSwitch("dash"); return; } catch (e) { /* 回退到下面的独立入口 */ }
    }
    try { this.openDashboard(); } catch (e) { console.error("[netglimmer-upload] showDashboard", e); }
  }

  /* ── 协作式取消 ───────────────────────────────────────────────────────────
   * 一次发布要传五百多个文件、三十多 MB；点错文档时只能干等它跑完。
   * 这里不做真 abort——半途掐断连接池 / SFTP 通道留下的残局比等完更难收拾——
   * 只置一个 flag：阶段边界和每个文件上传前 checkCancel() 抛错，走既有的
   * catch/finally 收尾（临时目录照删、会话照关、记录照写）。于是「取消」是一次
   * 普通失败，只是原因是用户自己按的，提示与历史都据 e.canceled 区别对待。
   * 正在传的那一个文件会传完（这是唯一不能安全打断的地方），所以下一句是
   * 「正在传的那个文件会传完再停」。 */
  requestCancel() {
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    Progress.markCanceling(this.t("canceling"));
    console.warn("[netglimmer-upload] 用户请求取消，将在下一个检查点停下");
  }

  /* step 为检查点名字，出现在错误文案里：取消发生在「校验阶段」和发生在
   * 「上传第 3 个文件」，用户该怎么补救完全不同（前者远端已完整，后者不完整）。 */
  checkCancel(step) {
    if (!this.cancelRequested) return;
    const e = new Error(this.t("canceledErr").replace("{d}", step || ""));
    e.canceled = true;
    e.step = step || "";   // 提示语按阶段选：取消在「建目录」和取消在「校验」，远端残缺程度完全不同
    throw e;
  }

  /* 发布入口：串行队列。同一时刻只允许一个发布在跑（远端会话与目录清理都不能并发），
   * 但连续右键发多篇不再被拒绝，而是排队；返回的 Promise 在“本篇结束”时 resolve，
   * 看板与回归都可以 await 单条发布。 */
  publish(docId, merge, opts) {
    if (this.busy) showMessage(this.t("queuedNow"), 2500, "warn");
    const job = () => this._publish(docId, merge, opts)
      .catch((e) => { console.error("[netglimmer-upload] queued publish", errForLog(e)); });
    const run = (this._chain ? this._chain.then(job, job) : job());
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  /* 内核自己报告的绝对工作区路径。桌面端 this.app.config.system.workspaceDir 一定有值，
   * window.siyuan 那条只是给「app 句柄还没挂上」的极端情况留的退路；两处都没有就返回空串，
   * 由调用方决定怎么报错——绝不能用相对路径兜底：实测相对 savePath 会按内核进程的 cwd
   * 解析，文件会莫名其妙落到思源安装目录里去。 */
  workspaceDirOf() {
    const cands = [
      this.app && this.app.config && this.app.config.system,
      typeof window !== "undefined" && window.siyuan && window.siyuan.config && window.siyuan.config.system,
    ].filter(Boolean);
    for (const c of cands) {
      const w = String(c.workspaceDir || "").replace(/[\\/]+$/, "");
      if (w) return w;
    }
    return "";
  }

  /* Word 档的导出：内核 /api/export/exportDocx 走思源自带的 pandoc，产物是一个自包含
   * .docx（图片嵌在 word/media/ 里），所以这一档既不上传运行时、也不上传 assets/。
   * 三个实测结论决定了这里怎么写：
   *   · id / savePath / removeAssets 三个字段都是必填，少一个内核直接退回
   *     「Field [xxx] is required」；
   *   · savePath 必须是内核自己看得见的绝对目录——相对路径按内核进程的 cwd 解析，
   *     而 "/temp/x" 就是文件系统根下的 /temp/x（都实测过），所以只能用内核报告的
   *     workspaceDir 拼绝对路径，落点仍留在工作区 temp/ 里，收尾按相对路径删；
   *   · 内核按文档标题命名产物，同一目录重名时自动加 " (1)"，因此不猜文件名，
   *     直接列举临时目录取那一个 .docx，远端入口名由插件自己定（<文档名>.docx）。
   * 返回 {tempDir, bytes, title}；tempDir 是工作区相对路径，交给发布收尾统一清理。 */
  async exportDocxToTemp(docId, merge) {
    const wsDir = this.workspaceDirOf();
    if (!wsDir) throw new Error(this.t("needWorkspaceDir"));
    const tempRel = `/temp/export-docx/${docId}-${Date.now()}`;
    const info = await fetchSyncPost("/api/block/getDocInfo", { id: docId });
    const title = (info && info.code === 0 && info.data && info.data.name) || "";
    const er = await fetchSyncPost("/api/export/exportDocx", {
      id: docId,
      savePath: `${wsDir}${tempRel}`,
      // removeAssets:true：关掉它内核还会在 savePath 里另拷一份 assets/（实测），
      // 而 Word 正文引用的图片已经嵌在同一个文件里，那份拷贝对读者是纯冗余
      removeAssets: true,
      merge: !!merge,   // 与 Markdown 不同，pandoc 真的会把子文档并进同一个文件（实测）
    });
    if (er.code !== 0) throw new Error(er.msg || this.t("docxNoOutput"));
    const listed = await listAllFiles(tempRel);
    const hits = listed.files.filter((f) => /\.docx$/i.test(f.path));
    if (!hits.length) throw new Error(this.t("docxNoOutput"));
    hits.sort((a, b) => b.size - a.size);
    const src = hits[0];
    if (er.data && er.data.path) {
      const want = String(er.data.path).replace(/\\/g, "/").split("/").pop();
      if (want !== src.path.split("/").pop()) {
        console.warn(`[netglimmer-upload] exportDocx 回报 ${want}，临时目录里实际是 ${src.path.split("/").pop()}，按实际文件上传`);
      }
    }
    // 走既有的多回退读取链（xhr/fetch/代理），并拿内核 readDir 报的大小做交叉核对
    const bytes = await readExportFile(src.path, src.size);
    if (!bytes || !bytes.length) throw new Error(this.t("docxNoOutput"));
    return {
      tempDir: tempRel,
      bytes,
      // 标题取内核文档信息；拿不到时退回产物文件名（去掉扩展名与可能的 " (n)"）
      title: title || src.path.split("/").pop().replace(/\.docx$/i, "").replace(/ \(\d+\)$/, ""),
    };
  }

  async _publish(docId, merge, opts) {
    if (this.busy) {
      showMessage(this.t("busyNow"), 3000, "warn");
      return;
    }
    const dryRun = !!(opts && opts.dryRun);
    const s = this.effective(opts && opts.proto);
    const proto = s.protocol || "webdav";
    const needAuth = proto !== "local";
    if (!s.server || (needAuth && !s.username)) {
      const msg = proto === "local" ? this.t("needLocalPath")
        : this.t(proto === "ftp" || proto === "sftp" ? "needServerCommon" : "needServer");
      showMessage(msg, 5000, "error");
      this.openSetting();
      return;
    }
    this.busy = true;
    this.cancelRequested = false;   // 上一条的取消请求不能蔓延到这一条（批量循环自己会在篇间检查）
    Progress.show(this.t("exporting"));
    Progress.enableCancel(this.t("cancel"), this.t("cancelTip"), () => this.requestCancel());
    let tempDir = null;
    let up = null;
    // 导出格式与「含子文档」的实际生效值：成功与失败两条记录必须用同一个口径写，
    // 否则看板按「文档+协议+是否含子文档」去重会把一次失败留成第二行。
    let isMd = false;
    let isDocx = false;
    let docxBytes = null;    // Word 档的入口文件字节（二进制，不走 utf8）
    let effMerge = !!merge;
    let docName = "untitled";
    // 记录里保留内核给的原样标题（不洗名），与看板展示一致；三档都必有值，
    // 不能再写死 exportHTML 的响应对象——Word 档压根不走那条接口。
    let rawDocName = "untitled";
    let remoteSegs = null;   // 本次的远端根目录段：catch 里也要用（记进历史供「取消发布」定位）
    let relocated = false;   // 是否因同名冲突改用了带 ID 的目录
    let touchedRemote = false; // 是否已经动过远端（失败时据此提示“远端可能不完整”）
    let remoteAllUp = false;   // 入口文件也传完了：此刻取消 ≠ 远端残缺
    /* 本次动过哪些远端根目录（整树删除一动手就记，不等删干净）：
     * 失败记录要靠它决定「上一次成功的地址还算不算数」，理由见 addHistory 里的继承守卫。 */
    const destroyedRoots = [];
    const markDestroyed = (segs) => {
      const k = (segs || []).join("/");
      if (k && !destroyedRoots.includes(k)) destroyedRoots.push(k);
    };
    const t0 = Date.now();
    try {
      // 1. 导出 HTML(SiYuan) 到内核临时目录 temp/export/<folder>/。
      //    两种格式都要这一步，但要的东西不一样：HTML 模式要它返回的正文，
      //    Markdown 模式只要它落盘的 assets/ ——那批文件是内核按「这篇文档真正引用到
      //    哪些资源」解析出来的，工作空间级 assets、符号链接、改名过的文件名它都替我们
      //    算好了；自己去拼 assets 路径必然漏，所以复用同一份解析结果。
      //    参数与手动「导出 → HTML(SiYuan)」一致：不传 exportTitleOptions，
      //    addTitle 跟随 设置→导出 的全局配置，避免内容与手动导出不同。
      const fmt = normFormat(s.exportFormat);
      isMd = fmt === "md";
      isDocx = fmt === "docx";
      // Markdown 的「含子文档」没有对应档位：内核的 Markdown 导出接口只接受 id，
      // 不接受 merge。与其悄悄传上去一篇不含子文档的正文却在记录里写「含子文档」，
      // 不如把 merge 压成 false——看板、批量候选、旧目录清理看到的都是真实产物。
      // HTML 与 Word 两档相反：merge 都真生效（Word 走 pandoc，实测子文档被并进
      // 同一个 document.xml），所以照用户勾选的原样传、原样记。
      effMerge = isMd ? false : !!merge;
      let entryText = "";
      let entryName = "";
      if (isDocx) {
        // Word 档完全不碰 exportHTML：内核的 pandoc 导出给的是单个自包含 .docx，
        // 图片已经嵌在同一个文件里，那套 30+MB 运行时和 assets/ 解析结果都用不上。
        Progress.show(this.t("generatingDocx"));
        this.checkCancel(this.t("exporting"));
        const dx = await this.exportDocxToTemp(docId, effMerge);
        docxBytes = dx.bytes;
        tempDir = dx.tempDir;   // 临时目录里就只有这一个 .docx，收尾照样删
        docName = sanitizeName(dx.title || "untitled");
        rawDocName = dx.title || "untitled";
        entryName = `${docName}.docx`;
      } else {
        // 1. 导出 HTML(SiYuan) 到内核临时目录 temp/export/<folder>/。
        //    HTML 与 Markdown 这两档都要这一步，但要的东西不一样：HTML 模式要它返回的
        //    正文，Markdown 模式只要它落盘的 assets/ ——那批文件是内核按「这篇文档真正
        //    引用到哪些资源」解析出来的，工作空间级 assets、符号链接、改名过的文件名它
        //    都替我们算好了；自己去拼 assets 路径必然漏，所以复用同一份解析结果。
        //    参数与手动「导出 → HTML(SiYuan)」一致：不传 exportTitleOptions，
        //    addTitle 跟随 设置→导出 的全局配置，避免内容与手动导出不同。
        const r = await fetchSyncPost("/api/export/exportHTML", {
          id: docId,
          pdf: false,
          keepFold: false,
          merge: effMerge,
          savePath: "",
        });
        if (r.code !== 0 || !r.data?.folder) throw new Error(r.msg || "export failed");
        docName = sanitizeName(r.data.name || "untitled");
        rawDocName = r.data.name || "untitled";
        tempDir = `/temp/export/${r.data.folder}`;
        // 入口文件名：HTML 模式固定 index.html（服务器指到目录就能直接打开）；
        // Markdown 模式与目录同名（<文档名>.md），读者按同一个名字找正文，不必猜扩展名。
        entryName = isMd ? `${docName}.md` : "index.html";

        // 1.5 生成入口文件正文
        this.checkCancel(this.t("exporting"));
        if (isMd) {
          // Markdown 正文直接取内核 /api/export/exportMdContent——手动「导出 → Markdown」
          // 得到的就是这一份（含 title/date/lastmod 前置元数据）。插件不做任何加工：
          // 不拼前端运行时、不注入侧边大纲，与手动导出逐字节一致。
          Progress.show(this.t("generatingMd"));
          const mr = await fetchSyncPost("/api/export/exportMdContent", { id: docId });
          if (mr.code !== 0 || typeof mr.data?.content !== "string") {
            throw new Error(mr.msg || "exportMdContent 未返回 content（内核版本不匹配？）");
          }
          entryText = mr.data.content;
        } else {
          // HTML(SiYuan) —— 3.8.6 起内核 exportHTML 不再写 index.html，
          // 改由前端拼接后经 /api/export/exportBrowserHTML 原样写入。
          // 这里用逐字移植的前端拼装代码（Vendored.buildIndexHtml）生成同一字符串，
          // 与手动导出的 index.html 逐字节一致。
          Progress.show(this.t("generating"));
          const verRet = await fetchSyncPost("/api/system/version", {});
          const version = verRet?.data || "";
          if (typeof r.data.content !== "string") {
            throw new Error("exportHTML 未返回 content（内核版本不匹配？）");
          }
          entryText = await Vendored.buildIndexHtml(
            r.data.name || "untitled", r.data.content, version);
          // 文末追加侧边大纲载荷（只改产物末尾，不动正文），可在设置中关闭
          if (s.addToc !== false) entryText = injectToc(entryText);
        }
      }

      // 2. 枚举导出产物。Markdown 档把上传集合收窄到 assets/：stage/ 与 appearance/
      //    是 HTML 页面自带的运行时（高亮、图表、字体、主题、图标），Markdown 正文一个
      //    都用不到；本地的临时目录仍按完整清单清理（见第 7 步），不会漏下那 30+MB。
      //    Word 档则是「只有入口文件」：pandoc 把图片嵌进了 .docx 本身，所以除了那一个
      //    文件什么都上传——清单仍然要拿，收尾清理靠它。
      const allRet = await listAllFiles(tempDir);
      const inAssets = (x) => {
        const rel = relOf(x.path || x, tempDir);
        return rel === "assets" || rel.startsWith("assets/");
      };
      const onlyAssets = (arr) => arr.filter(inAssets);
      const files = isDocx ? [] : (isMd ? onlyAssets(allRet.files) : allRet.files);
      const dirs = isDocx ? [] : (isMd ? onlyAssets(allRet.dirs) : allRet.dirs);
      // 纯文字文档在 Markdown 模式下本来就没有资产，files 为空是正常状态；
      // Word 档本来就只有一个入口文件，side 集合为空同样是正常状态；
      // HTML 模式下为空则说明导出没成功，必须当场失败。
      if (!files.length && !isMd && !isDocx) throw new Error("empty export");

      // 2.5 资产名可存性预检（只对 WebDAV 生效，见 unsafeSegReason 的实测记录）。
      //     导出目录里的 assets/ 是用户自己的文件名，原样上传；标题洗过但文件名没洗。
      //     这一步在任何远端写入之前完成：
      //       · 开关开着 → 算出「原名 → 安全名」映射，稍后按新名上传并改写入口文件里的引用；
      //       · 开关关掉 → 直接报错并列出问题文件，绝不留下半棵远端目录。
      let renames = new Map();        // 原 rel -> 上传用的 rel
      let unsafeList = [];            // [{rel, why}] 供报错/提示
      if (proto === "webdav") {
        const plan = planSafeRenames(files.map((f) => relOf(f.path, tempDir)));
        unsafeList = plan.unsafe;
        if (unsafeList.length && s.safeNames === false && !dryRun) {
          // 试运行只报告不落错误：它本来就不写远端，改名与否都值得先看清楚
          const list = unsafeList.slice(0, 5)
            .map((u) => `${u.rel}（${u.why}）`).join("、")
            + (unsafeList.length > 5 ? ` …共 ${unsafeList.length} 个` : "");
          throw new Error(this.t("unsafeNamesBlocked")
            .replace("{n}", String(unsafeList.length)).replace("{l}", list));
        }
        // 开关关掉时不做映射：要么按原名继续（试运行），要么上面已经中止
        if (s.safeNames !== false) renames = plan.renames;
      }
      const mapRel = (rel) => renames.get(rel) || rel;
      // 引用改写一次做完，字节数在这里定稿：planBytes、PUT、校验用的都是改写后的 HTML
      if (renames.size) {
        // 三种包裹形态里 Markdown 用的是括号那一种：![标题](assets/x.png)
        entryText = rewriteAssetRefs(entryText,
          [...renames].map(([from, to]) => ({ from, to })));
      }
      const entryBytes = isDocx ? docxBytes : utf8Bytes(entryText);

      // 3. 远端目标：<prefix 逐级>/<docName>/...
      //    目录名只由标题决定，所以两篇同名文档会落进同一个目录——增量清理会把
      //    对方的 index.html 当“孤立文件”删掉。建连后先看目录里的归属标记，
      //    发现是别人的就自动改用「标题-文档ID」目录（详见 3.4）。
      remoteSegs = rootSegsOf(s.prefix, docName);

      // 3.5 建立上传器连接（WebDAV 为空操作；FTP/SFTP 登录并进入会话）
      up = makeUploader(s, { hostKeys: this.hostKeyStore() });
      this.activeUploader = up;
      await up.open();

      // 3.4 归属确认：一次浅列举（不递归），代价远小于一次 walk。
      //     标记文件名自带文档 ID，因此四种协议都只需要“看得见目录里有什么”，
      //     不必读远端正文（SFTP/FTP 并没有通用的读文件能力）。
      //     探测本身是尽力而为：失败就按原目录继续，不阻断发布。
      const owner = ownerName(docId);
      const shortId = owner.slice(OWNER_PREFIX.length, -5);
      try {
        const mine = await up.sizeOf(remoteSegs.concat([owner]));
        if (mine < 0) {
          const names = await up.listNames(remoteSegs);
          if (hasForeignOwner(names, owner)) {
            docName = clampSeg(`${docName}-${shortId}`, 120);
            remoteSegs = rootSegsOf(s.prefix, docName);
            relocated = true;
            console.warn(`[netglimmer-upload] 同名文档已占用远端目录，本次发布到 ${remoteSegs[remoteSegs.length - 1]}`);
          }
        }
      } catch (e) {
        console.warn("[netglimmer-upload] 归属探测失败，按原目录继续：", errForLog(e));
      }

      // 3.6 增量发布：预遍历远端，拿到「已存在文件 key→字节大小」映射。
      //     之后共享运行时（stage/appearance）若远端大小与本地一致就跳过重传。
      //     cleanOld 与 incremental 互斥地处理：增量时绝不做整树 deleteTree
      //     （那会把运行时一起删掉，等于没增量），改为发布后仅删“孤立文件”。
      //     这份预检结果同时用于「孤立文件清单」和「低成本校验」，避免为同一次
      //     发布把整棵树遍历两遍（每次都是按目录递归的几十~上百个往返）。
      const SHARED_PREFIXES = ["stage/", "appearance/"];
      const isShared = (rel) => SHARED_PREFIXES.some((p) => rel.startsWith(p));
      // 并发 worker 可能同时发现连接断了：共享同一次重连，避免互相抢着重建会话
      let reconnecting = null;
      const retryOpts = (label) => ({
        label,
        // 重试次数由设置控制（1-6），默认 3；试运行/回归里也可显式收紧
        tries: clampInt(s.retryTries, 1, 6, 3),
        // 链路级失败（SSH/FTP 长连接断开、socket 错误）重试前先重建会话
        onRetry: (n, e) => {
          if (!isConnLostError(e)) return;
          if (!reconnecting) {
            reconnecting = Promise.resolve()
              .then(() => reconnectUploader(up))
              .finally(() => { reconnecting = null; });
          }
          return reconnecting;
        },
      });
      let existing = null;   // key -> 远端字节大小（仅 incremental 且预检成功时填充）
      let prePaths = null;   // key -> 远端真实定位符（用于删除孤立文件）
      let preOk = false;
      if (s.incremental) {
        this.checkCancel(this.t("checkingRemote"));
        Progress.show(this.t("checkingRemote"));
        try {
          const pre = await withRetry(async () => {
            const w = await up.walk(remoteSegs);
            // 子目录遍历中途因链路抖动失败 → 结果不完整，整棵重来
            if (w && w.partial) throw Object.assign(new Error("远端遍历不完整"), { retryable: true });
            return w;
          }, retryOpts(this.t("checkingRemote")));
          if (pre && pre.supported && !pre.partial && pre.files.size > 0) {
            existing = pre.files; prePaths = pre.paths; preOk = true;
          } else if (pre && pre.supported) {
            /* 遍历没报错、却一个文件都没列出来（或中途某个子目录列失败）：
             * 这张清单不可信，既不能拿它判断「哪些能复用」，也不能拿它删孤立文件。
             * 按预检失败处理：全量重传 + 校验时改用逐点确认。 */
            console.warn("[netglimmer-upload] 远端预检清单不可信（0 条 / 不完整）：",
              pre.diag || `files=${pre.files.size} partial=${!!pre.partial}`);
          }
        } catch (e) {
          // 预检彻底失败不影响发布，只是退化为“全部重传 + 全树校验”
          console.warn("[netglimmer-upload] 远端预检失败，按全量发布继续：", errForLog(e));
          existing = null; prePaths = null; preOk = false;
        }
      }

      const total = files.length + 1;
      let bytes = 0;        // 服务器端该文档总字节（含复用）
      let docFiles = 0;     // 本文自有文件（不含共享运行时）
      let docBytes = 0;     // 本文自有字节
      let sentFiles = 0;    // 本次实际上传的文件数（含 index.html）
      let sentBytes = 0;    // 本次实际上传字节
      let reused = 0;       // 本次跳过的共享运行时文件数
      const expected = new Map(); // keyOf(远端路径) -> 远端应有的字节数
      const exempt = new Set();   // 插件簿记文件（归属标记）：不参与校验、也不算孤立文件
      const uploaded = [];       // 本次真正上传的条目 {key, segs, rel}（点校验用）
      // key -> {segs, rel}：清单不可信时要按 key 逐点确认，得能从 key 找回路径
      const locOfKey = new Map();
      // 先决定“哪些要传”，再据此算并发度、总字节与校验方式
      const pending = [];
      for (const f of files) {
        const rel = mapRel(relOf(f.path, tempDir));
        const segs = remoteSegs.concat(rel.split("/"));
        const key = up.keyOf(segs);
        locOfKey.set(key, { segs, rel });
        // 增量：共享运行时文件若远端已存在则跳过重传。
        // 内核 readDir 对 stage/appearance 常返回 length=0，本地大小不可靠，
        // 因此：本地大小已知(>0)时要求与远端精确相等；本地大小未知(=0)时
        // 只要远端已有一份非空文件（同一思源版本下运行时逐字节相同）即视为可复用。
        const rSize = existing ? existing.get(key) : undefined;
        const canReuse = existing && isShared(rel) && rSize !== undefined
          && (f.size > 0 ? rSize === f.size : rSize > 0);
        if (canReuse) {
          expected.set(key, rSize);
          bytes += rSize;
          reused++;
          continue;
        }
        pending.push({ f, rel, segs, key });
      }
      // 进度分母：本地大小已知就用已知值；readDir 报 0 的运行时文件按经验值估
      // 一个权重，保证百分比仍然单调递增、不会卡在某个文件上。
      const UNKNOWN_W = 64 * 1024;
      const planBytes = pending.reduce((a, t) => a + (t.f.size > 0 ? t.f.size : UNKNOWN_W), 0)
        + entryBytes.length;
      const limit = concurrencyFor(proto, s.concurrency);

      // 4.5 试运行：到这里“要传哪些、共多少字节、能复用多少”已经全部算出，
      //     但建目录、探针、删除一个都还没发生——直接汇总返回，远端零写入。
      if (dryRun) {
        showMessage(this.t("dryRunResult")
          .replace("{n}", String(pending.length))
          .replace("{b}", this.fmtBytes(planBytes))
          .replace("{re}", String(reused))
          .replace("{d}", remoteSegs[remoteSegs.length - 1]), 9000, "info");
        // 试算不写远端，但内核 temp 里那份导出目录是这次调用刚生成的：不删就是白占
        // 几十 MB（失败路径由 catch 兜底清理，早退路径只有这里管）。
        await this.removeTree(allRet.files, allRet.dirs, tempDir);
        tempDir = null;
        if (unsafeList.length) {
          // 试运行要把「改名会不会动我的文件名」说清楚，否则用户看不到即将发生的替换
          showMessage(this.t("unsafeNamesDry")
            .replace("{n}", String(unsafeList.length))
            .replace("{l}", unsafeList.slice(0, 3).map((u) => `${u.rel}（${u.why}）`).join("、")
              + (unsafeList.length > 3 ? ` …共 ${unsafeList.length} 个` : ""))
            .replace("{a}", this.t(s.safeNames === false ? "unsafeDryBlock" : "unsafeDryRename")),
          9000, "warn");
        }
        return;
      }

      // 改名不是失败，但一定要让用户知道页面上的文件名和思源里不一样了
      if (renames.size) {
        showMessage(this.t("unsafeNamesFound")
          .replace("{n}", String(renames.size))
          .replace("{l}", [...renames].slice(0, 3)
            .map(([from, to]) => `${from} → ${to}`).join("、")
            + (renames.size > 3 ? ` …共 ${renames.size} 个` : "")), 9000, "warn");
      }

      // 4.6 非增量 + 清理：发布前清空整棵文档目录（试运行不会走到这里）。
      //     这一步之后远端就处于“半新半旧”状态，失败时必须明确告诉用户。
      if (!s.incremental && s.cleanOld) {
        this.checkCancel(this.t("cleaning"));
        Progress.show(this.t("cleaning"));
        // 删除一动手就记下这个根：下面任何一步失败，上一次成功记录的地址都不再作数
        markDestroyed(remoteSegs);
        await withRetry(() => up.deleteTree(remoteSegs), retryOpts(this.t("cleaning")));
        touchedRemote = true;
      }

      // 5. 建目录：先逐级建 prefix 与文档根目录，再建导出产物的子目录（浅到深）
      this.checkCancel(this.t("makingDirs"));
      Progress.show(this.t("makingDirs"));
      let chain = [];
      for (const seg of remoteSegs) {
        chain = chain.concat([seg]);
        await withRetry(() => up.mkdir(chain), retryOpts(`MKCOL ${seg}`));
      }
      touchedRemote = true;
      const dirSet = dirs
        .map((d) => mapRel(relOf(d, tempDir)))
        .sort((a, b) => a.split("/").length - b.split("/").length);
      for (const rel of dirSet) {
        await withRetry(() => up.mkdir(remoteSegs.concat(rel.split("/"))), retryOpts(`MKDIR ${rel}`));
      }

      // 5.5 传输探针：先传一个已知大小的文件并核对远端尺寸，
      //     通道异常（body 被丢弃/截断）时立即失败，不产生整棵 0 字节目录。
      this.checkCancel(this.t("probing"));
      Progress.show(this.t("probing"));
      await withRetry(() => up.probe(remoteSegs), retryOpts(this.t("probing")));

      // 5.6 写归属标记（见 3.4）：目录名只由标题决定，标记是“这个目录属于哪篇文档”
      //     的唯一凭据。它记进 exempt（而非 expected）：部分 FTP 服务器的 LIST 不返回
      //     隐藏文件，把它纳入逐文件校验会造成假“远端缺失”；同时增量清理也不会把它当孤立文件删掉。
      //     不参与文件数/字节数统计——它是插件的簿记，不是文档内容。
      const ownerSegs = remoteSegs.concat([owner]);
      const ownerBytes = utf8Bytes(JSON.stringify({ docId, owner: shortId, ts: Date.now() }));
      try {
        await withRetry(() => up.put(ownerSegs, ownerBytes), retryOpts(`PUT ${owner}`));
        exempt.add(up.keyOf(ownerSegs));
      } catch (e) {
        // 簿记文件写不动，不该让一次「内容已上传并逐字节校验通过」的发布变成失败：
        // 页面是完整的，只是这篇目录少了一张身份凭据，下次同名冲突时保护会弱化。
        // 降级为告警，并继续走后面的上传/校验（孤立文件清理有 OWNER_RE 兜底，不会误删旧标记）。
        console.warn("[netglimmer-upload] 归属标记写入失败（发布继续）：", errForLog(e));
        showMessage(this.t("ownerWriteWarn").replace("{e}", errForLog(e)), 6000, "warn");
      }

      // 6. 上传文件：并发池 + 瞬时失败重试，最后上传入口文件（index.html 或 <文档名>.md）
      //    注意：思源「HTML(SiYuan)」导出每次都会附带一整份 stage/ + appearance/
      //    运行时（highlight.js/echarts/fonts/主题/图标，约 570 个文件、30+MB），
      //    这部分对所有文档都一样，不反映本篇小说明内容。看板里显示的「文件数」
      //    改为统计“本文自有文件”（index.html + 文档引用的图片等资产），
      //    总上传数（含共享运行时）放在悬浮提示里，既真实又有区分度。
      //    增量模式：共享运行时文件若远端大小与本地一致，跳过读取与重传。
      //    并发度按协议取（FTP 单控制连接必须串行，WebDAV/SFTP 可并行多文件），
      //    进度按“已传字节/预计字节”计算并节流刷新，避免 570 次重绘。
      let doneUnits = 0;
      let lastPaint = 0;
      const paint = (label) => {
        const now = Date.now();
        // 节流：最多每 150ms 刷一次；结尾/异常由调用方强制刷新
        if (now - lastPaint < 150 && doneUnits < planBytes) return;
        lastPaint = now;
        const ratio = planBytes > 0 ? Math.min(0.999, doneUnits / planBytes) : 0;
        Progress.show(`${this.t("uploading")} ${sentFiles + reused + 1}/${total} · ${label}`, ratio);
      };
      // 单文件上限：readExportFile 会把整个文件读进内存，WebDAV 还要 base64 + JSON
      // 包一层（约 3 倍开销）。默认 64MB，设置里可调（0 = 不限制）。
      const capMB = Number(s.maxFileMB) > 0 ? Number(s.maxFileMB) : 0;
      const capBytes = capMB * 1048576;
      const overCap = (name, n) => new Error(this.t("fileTooBig")
        .replace("{n}", name).replace("{b}", this.fmtBytes(n)).replace("{m}", `${capMB} MB`));
      const upErrs = await runPool(pending, async (t) => {
        this.checkCancel(t.rel);   // 每个文件动手前一次：取消最多少传几个文件，不会打断在途请求
        paint(t.rel);
        // 先用 readDir 报的大小挡一道：已知超标就别把整个文件读进内存
        if (capBytes && t.f.size > capBytes) throw overCap(t.rel, t.f.size);
        const u8 = await readExportFile(t.f.path, t.f.size);
        // readDir 报 0 的文件（部分运行时文件）以实际读到的字节为准
        if (capBytes && u8.length > capBytes) throw overCap(t.rel, u8.length);
        // 失败时把“是哪个文件、多大”挂在错误对象上：光一句 HTTP 404 没法判断
        // 是文件名存不下、太大被拦，还是服务器直接把这一类请求拒了。
        try {
          await withRetry(() => up.put(t.segs, u8), retryOpts(`PUT ${t.rel}`));
        } catch (e) {
          e.item = t.rel; e.itemSize = u8.length; throw e;
        }
        expected.set(t.key, u8.length);
        uploaded.push({ key: t.key, segs: t.segs, rel: t.rel });
        bytes += u8.length;
        sentFiles++; sentBytes += u8.length;
        doneUnits += t.f.size > 0 ? u8.length : UNKNOWN_W;
        if (!isShared(t.rel)) { docFiles++; docBytes += u8.length; }
      }, limit);
      if (upErrs.length) {
        const first = upErrs[0];
        // 取消不是「上传失败」：别让下面那段「哪个文件、多大、413 提示」把它包成传输错误，
        // 用户按的是取消按钮，看到的就该是「已取消」，而不是一句 PUT 失败。
        if (first && first.canceled) throw first;
        const more = upErrs.length > 1
          ? `（${this.t("uploadFailMore").replace("{n}", String(upErrs.length))}）` : "";
        let msg = `${this.t("uploadFailAt")}: ${first.message || first}${more}`;
        // 光一句 HTTP 403/404 判断不出原因，把「哪个文件、多大」带上：
        // 文件名不合法（已由 safeNames 处理）、体积被服务器策略拦下，还是整类请求被拒。
        if (first.item) {
          msg += ` ${this.t("uploadFailItem")
            .replace("{n}", first.item).replace("{b}", this.fmtBytes(first.itemSize || 0))}`;
          // 大文件失败多半撞上 Web 服务侧的请求体上限（思源设置里的单文件上限管不到那里）。
          // 413 是服务端已经明确说「装不下」，跟文件绝对大小无关——nginx 出厂默认
          // client_max_body_size 只有 1m（本机实测 3MB 直接 413），所以只要状态码是 413
          // 就必须把这条提示带上，不能等到 4MB 才说。
          const st = Number(first.httpStatus || 0);
          if (proto === "webdav" && (st === 413 || first.itemSize >= 4 * 1048576)) {
            msg += ` ${this.t("uploadFailBigHint")}`;
          }
        }
        throw new Error(msg);
      }

      const entrySegs = remoteSegs.concat([entryName]);
      this.checkCancel(entryName);
      Progress.show(`${this.t("uploading")} ${total}/${total} · ${entryName}`, 0.999);
      await withRetry(() => up.put(entrySegs, entryBytes), retryOpts(`PUT ${entryName}`));
      expected.set(up.keyOf(entrySegs), entryBytes.length);
      locOfKey.set(up.keyOf(entrySegs), { segs: entrySegs, rel: entryName });
      uploaded.push({ key: up.keyOf(entrySegs), segs: entrySegs, rel: entryName });
      bytes += entryBytes.length;
      sentFiles++; sentBytes += entryBytes.length;
      docFiles += 1; docBytes += entryBytes.length; // 入口文件（index.html / <文档名>.md / <文档名>.docx）属本文自有
      remoteAllUp = true;   // 到这里线上目录已经是一套完整产物，取消只是跳过校验与清理

      // 6.5 读回校验。三种做法，取往返次数更少、结论又可信的一种：
      //   ① 点校验：只对本次真正上传的文件逐个 sizeOf（复用没动过的运行时——
      //      它们刚在预检里确认过存在且尺寸一致，本次未写入，不可能变）。
      //      增量重发时通常只有几个文件，往返数远小于整树遍历。
      //   ② 全树遍历：上传文件很多（首次发布）时，一次递归 PROPFIND/LIST 反而更便宜。
      //   ③ 逐点确认（兜底）：清单里查无此文件只当线索、不当结论——
      //      一台 LIST/MLSD 方言我们不认的服务器会交出「空清单」，直接照它报错就会
      //      把服务器上明明都在的整站文件说成「远端缺失」（实测 580/580 误报）。
      this.checkCancel(this.t("verifying"));
      Progress.show(this.t("verifying"), 1);
      const dirCount = dirs.length + 1;          // 整树遍历的往返次数下界
      // FTP 的 sizeOf 走 SIZE 命令，部分服务器不支持（应答 500/502），
      // 逐点确认容易误判——FTP 继续用整树 LIST 遍历一次搞定（查不到的条目走 ③）。
      const usePoint = preOk && proto !== "ftp"
        && uploaded.length > 0 && uploaded.length <= dirCount;
      const bad = [];
      let zeroRemote = 0, zeroLocal = 0;
      let w = null;
      let listDoubt = "";     // 清单不可信的原因（附进报错，用户能直接把服务器形态报回来）
      const unverifiable = { n: 0, why: "" };
      const noteBad = (key, localSize, remoteSize) => {
        const name = String(key).split("/").slice(-2).join("/");
        if (remoteSize === undefined) {
          bad.push(`${name}: ${this.t("verifyMissing")}（本地 ${localSize}B）`);
          return;
        }
        if (remoteSize === 0) zeroRemote++;
        if (localSize === 0) zeroLocal++;
        bad.push(`${name}：本地 ${localSize}B ≠ 远端 ${remoteSize}B`);
      };
      /* 单个文件的大小问询：-1 = 服务器不答（不代表没有）；null = 已记入 bad。
       * 链路抖动/中断不能算「远端缺失」，那是我们没读到，不是它不在。 */
      const sizeOne = async (t) => {
        try {
          return await withRetry(() => up.sizeOf(t.segs), retryOpts(`SIZE ${t.rel}`));
        } catch (e) {
          if (e && e.canceled) throw e;
          if (isConnLostError(e) || isTransientError(e)) {
            bad.push(`${t.rel}: ${this.t("verifyUnreadable")}（${e.message || e}）`);
            return null;
          }
          bad.push(`${t.rel}: ${this.t("verifyMissing")}（${e.message || e}）`);
          return null;
        }
      };
      const verifyByPoints = async (targets) => {
        if (!targets.length) return;
        const noSize = [];
        const errs = await runPool(targets, async (t) => {
          this.checkCancel(this.t("verifying"));
          const sz = await sizeOne(t);
          if (sz === null) return;
          if (sz < 0) { noSize.push(t); return; }
          if (sz !== t.localSize) noteBad(t.key, t.localSize, sz);
        }, limit);
        if (errs.length) {
          // 校验池里的取消要原样抛出去：包成 new Error 会丢掉 e.canceled，
          // 界面就会把「用户按了取消」报成一句莫名的校验失败。
          const ce = errs[0];
          if (ce && ce.canceled) throw ce;
          throw new Error(String(ce.message || ce));
        }
        if (!noSize.length) return;
        /* 问不出大小的那批：用「能不能读回内容」区分「服务器不答 SIZE」与「文件真没了」。
         * 读回等于重新下载，所以只确认有限个（READBACK_CAP），其余如实报告「未校验」，
         * 既不把整站报成缺失，也不假装全查过了。 */
        const READBACK_CAP = 24;
        const readCache = new Map();
        const fetchOne = async (t) => {
          if (readCache.has(t.key)) return readCache.get(t.key);
          let got = false;
          try {
            got = await withRetry(() => up.readBack(t.segs), retryOpts(`GET ${t.rel}`));
          } catch (e) {
            if (e && e.canceled) throw e;
          }
          readCache.set(t.key, got);
          return got;
        };
        const probe = noSize.slice(0, 3);
        let anyReadable = false;
        for (const t of probe) {
          this.checkCancel(this.t("verifying"));
          if (await fetchOne(t)) anyReadable = true;
        }
        const idxOk = await fetchOne({ key: up.keyOf(entrySegs), segs: entrySegs, rel: entryName });
        if (!anyReadable && !idxOk) {
          // 连入口文件都读不回：读通道整体不通，逐个确认没有意义，也不该说「文件缺失」
          unverifiable.n = noSize.length;
          unverifiable.why = this.t("verifyNoRead");
          return;
        }
        const check = noSize.slice(0, READBACK_CAP);
        let missing = 0;
        for (const t of check) {
          this.checkCancel(this.t("verifying"));
          const got = await fetchOne(t);
          // 本地 0 字节的文件读回也是空，判不出「没有」，不因此误报
          if (!got && t.localSize > 0) { noteBad(t.key, t.localSize, undefined); missing++; }
        }
        if (noSize.length > check.length) {
          /* 确认过的这批「一个都不在」：剩下的属于同一种故障（同一台服务器、同一次写入），
           * 照实一起报，别让报错数字停在预算上限上。
           * 只要有一个读得回来，就说明是「读通道/SIZE 不给力」而不是「文件没了」，
           * 剩下的就只报「未能逐个校验」，不报缺失。 */
          if (missing === check.length && check.length > 0) {
            for (const t of noSize.slice(check.length)) {
              if (t.localSize > 0) { noteBad(t.key, t.localSize, undefined); missing++; }
            }
          } else {
            unverifiable.n = noSize.length - check.length;
            unverifiable.why = this.t("verifyBudget");
          }
        }
      };
      if (usePoint) {
        await verifyByPoints(uploaded.map((it) => (
          { key: it.key, segs: it.segs, rel: it.rel, localSize: expected.get(it.key) })));
      } else {
        w = await withRetry(() => up.walk(remoteSegs), retryOpts(this.t("verifying")));
        listDoubt = (!w.supported || w.partial || w.files.size === 0)
          ? `${this.t("verifyListUntrusted")}：${w.diag || `files=${w.files.size} partial=${!!w.partial} supported=${w.supported}`}`
          : "";
        if (!w.supported) {
          // 服务器不支持目录遍历（如 PROPFIND 受限）时退回入口文件单点校验
          const ok = await withRetry(() => up.readBack(entrySegs), retryOpts(this.t("verifying")));
          if (!ok) throw new Error(`${this.t("verifyFail")}（${w.diag || this.t("verifyListUntrusted")}）`);
        } else {
          const doubt = [];
          for (const [key, localSize] of expected) {
            if (!w.files.has(key)) {
              const loc = locOfKey.get(key) || { segs: null, rel: String(key).split("/").slice(-1)[0] };
              doubt.push({ key, segs: loc.segs, rel: loc.rel || String(key), localSize });
              continue;
            }
            const remoteSize = w.files.get(key);
            if (remoteSize >= 0 && remoteSize !== localSize) noteBad(key, localSize, remoteSize);
          }
          // 清单说「没有」的那些：逐个确认后才落到 bad
          await verifyByPoints(doubt.filter((d) => d.segs));
          if (doubt.some((d) => !d.segs)) unverifiable.n += doubt.filter((d) => !d.segs).length;
        }
      }
      if (unverifiable.n && !bad.length) {
        showMessage(this.t("verifySkipSome")
          .replace("{n}", String(unverifiable.n))
          .replace("{w}", unverifiable.why || this.t("verifyListUntrusted")), 9000, "warn");
      }
      if (bad.length) {
        let hint = "";
        if (zeroRemote > 0 && zeroLocal === 0) {
          hint = this.t("verifyHintUpload");
        } else if (zeroLocal > 0) {
          hint = this.t("verifyHintLocal");
        }
        if (listDoubt) hint += `（${listDoubt}）`;
        throw new Error(
          `${this.t("verifyMismatch")}（${bad.length}/${expected.size}）：` +
          bad.slice(0, 5).join("；") + (bad.length > 5 ? ` …共 ${bad.length} 个` : "") + hint);
      }

      // 6.6 增量 + 清理：不做整树删除（会连运行时一起删），改为只删“孤立文件”——
      //     远端存在但不在本次目标集合 expected 里的文件。这样文档改名/删除的旧资产
      //     被清掉，而共享运行时原样保留，下次发布继续复用。
      //     孤立清单优先取预检遍历的结果（省一次全树遍历）；预检不可用时取刚做的校验遍历。
      let deletedStale = 0;
      const staleFrom = (preOk ? prePaths : (w && w.paths)) || null;
      if (s.incremental && s.cleanOld && staleFrom) {
        const stale = [];
        for (const [key, loc] of staleFrom) {
          // 簿记文件（归属标记）永远保留：exempt 里是本次写的，OWNER_RE 兜住
          // 别人的/历史遗留的标记，避免把同名共存关系的信息擦掉后误判成“无人占用”。
          const base = String(key).split("/").pop() || "";
          if (!expected.has(key) && !exempt.has(key) && !OWNER_RE.test(base)) stale.push({ key, loc });
        }
        Progress.show(this.t("staleCleaning"));
        await runPool(stale, async (it) => {
          // 删除比上传更需要「说停就停」：每个删除任务前都检查一次取消
          this.checkCancel(this.t("staleCleaning"));
          try {
            await withRetry(() => up.deleteReal(it.loc), retryOpts(`DEL ${it.key}`));
            deletedStale++;
          } catch (e) { /* 尽力而为 */ }
        }, limit);
        // 上面那圈是「尽力而为」，错误被吞掉；取消必须在这里重新抛出去，
        // 否则用户按了取消却看到「发布成功」。
        this.checkCancel(this.t("staleCleaning"));
      }

      // 6.9 改名/换目录残留清理：同一篇文档（同协议、同 merge）上一次成功发布的分段
      //     和本次不同，说明文档改名了、或本次因同名冲突改用了新目录——旧目录若不处理
      //     就永远孤立在服务器上（读者仍能访问到过期内容）。删除前先看旧目录的归属标记，
      //     确认它确实属于本文档才动手，避免误删别人的同名目录。
      let cleanedOld = 0;
      try {
        cleanedOld = await this.cleanupOldRemote(up, proto, docId, effMerge, remoteSegs,
          !!s.cleanOld, markDestroyed);
      } catch (e) {
        console.warn("[netglimmer-upload] 旧目录清理失败（不影响本次发布）：", errForLog(e));
      }

      // 7. 清理本地临时目录（尽力而为）。必须按**完整**清单清理：Markdown 模式下
      //    files/dirs 是被收窄过的（只剩 assets/），拿它清理会把 stage/appearance
      //    那 30+MB 留在内核 temp 里。
      await this.removeTree(allRet.files, allRet.dirs, tempDir);

      // 展示的路径直接指到入口文件：目录 + index.html 或目录 + <文档名>.md。
      // 「查看上传路径」与成功卡片都读这个字段，指向一个确实存在的文件比指向目录有用，
      // 而且远端目录本身仍由 rootSegs 定位（取消上传/清理远端都不反推这个字符串）。
      const url = displayUrl(up.rootDisplay(remoteSegs) + entryName);
      const stamp = await this.sourceStampSettled(docId);
      const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
      // 摘要里直接说明「本次真正传了多少、复用了多少」，
      // 免得看板上的总数（含每次导出都附带的运行时）让人误判上传量。
      const summary = this.t("publishSummaryOk")
        .replace("{url}", url)
        .replace("{sent}", String(sentFiles))
        .replace("{sentB}", this.fmtBytes(sentBytes))
        .replace("{reused}", String(reused))
        .replace("{dur}", String(secs));
      /* 卡片里那行地址本来就是 user-select:all（点一下即全选），所以没有
       * 「打开 / 复制」两个按钮：插件不知道那个地址能不能打开，也不该在用户
       * 没要求的时候写他的剪贴板。要地址的人自己全选、自己 Ctrl+C。
       * siyuan.d.ts 实测 showMessage(text, timeout, type, id)——第 4 个参数是 toast
       * 去重 id，不是操作按钮，所以剩下的「看板」入口仍只能由插件自绘的 ResultCard 承载
       * （悬停不消失、离开后再等 3 秒，给伸手点按钮留时间）。 */
      const cardActions = [
        { text: this.t("dashboard"), onClick: () => this.showDashboard() },
      ];
      ResultCard.show({
        title: this.t("cardOk"), body: summary, url, actions: cardActions, ttl: 12000, tone: "ok",
      });
      if (relocated) {
        showMessage(this.t("ownerRelocated")
          .replace("{d}", remoteSegs[remoteSegs.length - 1]), 9000, "warn");
      }
      if (cleanedOld) {
        showMessage(this.t("oldRootCleaned").replace("{n}", String(cleanedOld)), 6000, "info");
      }
      if (!this.publishedMap) this.publishedMap = new Map();
      this.publishedMap.set(docId, url);
      if (!this.publishedStamp) this.publishedStamp = new Map();
      // 指纹拿不到就不参与改动比对，避免把“未知”渲染成“有改动未发布”
      if (stamp) this.publishedStamp.set(docId, stamp);
      else this.publishedStamp.delete(docId);
      if (this.changedSet) this.changedSet.delete(docId); // 刚发布完 = 内容一致
      this.scheduleTreeDecorate();
      await this.addHistory({
        time: t0, docId, docName: rawDocName || docName, url, protocol: proto, merge: effMerge,
        files: expected.size, bytes, ok: true, pub: true,
        docFiles, docBytes, sentFiles, sentBytes, reused, deletedStale,
        /* 「有几个文件没能逐个确认」必须落到记录里：校验预算用尽时那句警告只是一条
         * 九秒就消失的 toast，等用户第二天打开看板，这一行看起来和「全部校验通过」
         * 一模一样。数字不进记录，诚实就只维持九秒。 */
        unverified: unverifiable.n || 0,
        // rootSegs：「删除远端文件」要靠它定位远端目录（展示地址反推不可靠：FTP/SFTP 的段
        // 是相对登录目录、本地是相对基础目录）。dirName 冗余存一份，供批量清理直接展示。
        rootSegs: remoteSegs.slice(), dirName: remoteSegs[remoteSegs.length - 1],
        stamp,
      });
    } catch (e) {
      const canceled = !!(e && e.canceled);
      if (canceled) console.warn("[netglimmer-upload] 用户取消：", (e.step || "?"), "|", errForLog(e));
      else console.error("[netglimmer-upload]", errForLog(e));
      // 已经动过远端（建过目录/清过整树/传过文件）→ 站点此刻是“半新半旧”的，
      // 只报“失败”不够：必须明确告诉用户远端不完整，并给出补救路径。
      // touchedRemote 在建目录成功时置位，因此“传过任何文件”必然包含在内
      const partial = touchedRemote;
      if (canceled) {
        /* 取消不是故障，提示要按阶段诚实三分（口径见 cancelToast，那段逻辑在这里
         * 只负责把 step 填进文案，不再自己判「远端到底缺不缺」。 */
        const ct = cancelToast(partial, remoteAllUp);
        showMessage(this.t(ct.key).replace("{d}", e.step || ""), ct.ttl, ct.type);
      } else {
        showMessage(`${this.t("failed")}: ${e.message}`, 7000, "error");
        if (partial) {
          showMessage(this.t("remotePartialWarn").replace("{d}", e.message), 9000, "warn");
        }
        /* 失败也走卡片：错误原文常常很长（PUT xxx: HTTP 413 + 一叠提示），
         * toast 几秒就消失，等人找到鼠标去点早就没了；卡片悬停不消失，还能一键重发。 */
        ResultCard.show({
          title: this.t("cardFail"),
          tone: "fail",
          body: redactUrl(String(e.message || e)),
          url: partial ? safeRootDisplay(up, remoteSegs) : "",
          actions: [
            {
              text: this.t("retryFailed"),
              onClick: () => {
                if (this.busy) { showMessage(this.t("busyNow"), 3000, "warn"); return; }
                this.publish(docId, merge, { proto });
              },
            },
            { text: this.t("dashboard"), onClick: () => this.showDashboard() },
          ],
          ttl: 20000,
        });
      }
      await this.addHistory({
        time: t0, docId,
        docName: docName || "",
        url: partial ? safeRootDisplay(up, remoteSegs) : "",
        protocol: proto, merge: effMerge, files: 0, bytes: 0, ok: false, pub: false,
        docFiles: 0, docBytes: 0, err: redactUrl(String(e.message || e)),
        // 取消的记录不算“残缺站点”：index.html 已传完时线上是完整页面
        partial: canceled ? (partial && !remoteAllUp) : partial,
        canceled: !!canceled,
        // 本次删过的远端根（整树清理 / 改名残留清理）：addHistory 靠它决定
        // 能不能继承上一次成功记录的地址与「线上还挂着」标记
        destroyed: destroyedRoots.slice(),
        rootSegs: remoteSegs ? remoteSegs.slice() : undefined,
        dirName: remoteSegs ? remoteSegs[remoteSegs.length - 1] : "",
      });
      if (tempDir) {
        try {
          const { dirs, files } = await listAllFiles(tempDir);
          await this.removeTree(files, dirs, tempDir);
        } catch (e2) { /* noop */ }
      }
    } finally {
      Progress.hide();
      if (up) { try { await up.close(); } catch (e) { /* noop */ } }
      this.activeUploader = null;
      this.busy = false;
    }
  }

  /* 文档改名（或本次因同名冲突换了目录）后，旧目录仍留在服务器上，读者还能访问到
   * 过期内容——README 承诺的「改名残留照样清理」靠这一步兑现。只在本次发布已成功
   * 之后动手，规则保守：
   *   - 只看同一 docId + 同协议 + 同 merge 的上一次成功记录（历史里就是同一条去重键）；
   *   - 分段与本次不同才处理；清理开关关闭，或那条记录没有 rootSegs（拿不到定位信息）就跳过；
   *   - 动手前先浅列举旧目录：只要出现别人的归属标记就不删，宁可留残留也不误删同名目录。
   * onDestroy（可选）：deleteTree 一动手就回调，哪怕它半路抛错。旧目录被清掉之后，
   * 那条成功记录里的地址已经指向一个不存在（或只剩半棵）的目录，失败记录绝不能再
   * 把那个地址当「线上还挂着」继承下去（见 addHistory 的继承守卫）。
   * 返回清掉的旧目录数（0 或 1）。 */
  async cleanupOldRemote(up, proto, docId, merge, curSegs, cleanOld, onDestroy) {
    if (!cleanOld) return 0;
    const list = await this.getHistory();
    const keyOf = (r) => (r.rootSegs || []).join("/");
    const cur = curSegs.join("/");
    const prev = (list || []).find((r) => r && r.ok && r.docId === docId
      && (r.protocol || "webdav") === proto && !!r.merge === !!merge
      && Array.isArray(r.rootSegs) && keyOf(r) !== cur);
    if (!prev) return 0;
    const oldSegs = prev.rootSegs;
    // 旧目录是本次目录的祖先时绝不能整树删除（那会把刚发布好的内容一起删掉）
    if (cur.startsWith(oldSegs.join("/") + "/")) return 0;
    let names = [];
    try { names = await up.listNames(oldSegs); } catch (e) { return 0; }
    if (hasForeignOwner(names, ownerName(docId))) {
      console.warn("[netglimmer-upload] 旧目录归属不明（存在他人的归属标记），跳过自动清理：", keyOf(prev));
      return 0;
    }
    if (onDestroy) { try { onDestroy(oldSegs); } catch (e) { /* 记账失败不该拦住清理 */ } }
    await up.deleteTree(oldSegs);
    return 1;
  }

  /* 取消发布：删掉这篇文档在远端的整个目录，并把记录标成「已下线」。
   * 半途失败的残局（partial）也用它收拾——先清理再重发比在坏状态上增量安全。
   * 与发布共用同一条串行链，避免删除和上传同时动同一个目录。 */
  unpublish(rec, opts) {
    const run = () => this._unpublish(rec, opts);
    const res = this._chain ? this._chain.then(run, run) : run();
    this._chain = res.then(() => {}, () => {});
    return res;
  }

  async _unpublish(rec, opts) {
    if (!rec || !rec.docId) return { fail: true, msg: this.t("cannotLocateRemote") };
    const proto = (rec.protocol || "").trim() || this.settings.protocol || "webdav";
    const segs = await this.rootSegsForRecord(rec);
    if (!segs) return { fail: true, msg: this.t("cannotLocateRemote") };
    const s = this.effective(proto);
    if (!s.server || (proto !== "local" && !s.username)) {
      showMessage(this.t("needServerForProto").replace("{p}", proto.toUpperCase()), 5000, "error");
      return { fail: true, msg: "config" };
    }
    const dirName = segs[segs.length - 1];
    if (!opts || opts.confirmed !== true) {
      const tip = this.t("unpublishConfirm")
        .replace("{d}", dirName).replace("{p}", proto.toUpperCase());
      if (!window.confirm(tip)) return { fail: true, msg: "cancelled" };
    }
    if (this.busy) { showMessage(this.t("busyNow"), 3000, "warn"); return { fail: true, msg: "busy" }; }
    this.busy = true;
    /* 这里刻意不接「取消」按钮：删除半途停下会留下一个既不是完整发布、也没清干净的目录，
     * 比让它跑完更难判断；发布可以半途停（多传几个文件无害），删不行。
     * 想中止只能等它跑完，或先确认——确认框本身就是那道闸。 */
    Progress.show(this.t("unpublishing"));
    let up = null;
    try {
      up = makeUploader(s, { hostKeys: this.hostKeyStore() });
      this.activeUploader = up;
      await up.open();
      // 目录名是标题的函数：如果这个目录现在挂着“别人的”归属标记，说明它已经被
      // 另一篇同名文档接管，删它就是误删。探测失败（服务器不支持列举）时按原计划继续。
      try {
        const owner = ownerName(rec.docId);
        const names = await up.listNames(segs);
        if (hasForeignOwner(names, owner)) {
          await up.close();
          up = null;                       // finally 里不再重复关闭
          showMessage(this.t("unpublishForeign").replace("{d}", dirName), 8000, "warn");
          return { fail: true, msg: "foreign" };
        }
      } catch (e) { console.warn("[netglimmer-upload] 取消发布前的归属探测失败，按原计划继续：", errForLog(e)); }
      await withRetry(() => up.deleteTree(segs), { label: "UNPUB", tries: clampInt(s.retryTries, 1, 6, 3) });
      await this.markUnpublished(rec);
      showMessage(this.t("unpublished").replace("{d}", dirName), 5000, "ok");
      return { fail: false, segs };
    } catch (e) {
      console.error("[netglimmer-upload] unpublish", errForLog(e));
      showMessage(`${this.t("unpublishFail")}: ${errForLog(e)}`, 7000, "error");
      return { fail: true, msg: redactUrl(String(e.message || e)) };
    } finally {
      Progress.hide();
      if (up) { try { await up.close(); } catch (e) { /* noop */ } }
      this.activeUploader = null;
      this.busy = false;
    }
  }

  /* ── 批量：改动检测的「一组记录」 ----------
   * 两个入口共用一次批量指纹查询（stampsFor 内部已按 200 个一组分块），不按行发 SQL。
   * 共同的前提：只判「成功发布过、没下架、当初记到了指纹」的记录；整批一条都没查到时
   * 一律返回空集——判不出来宁可不做事，返回空集比拿猜测去删线上内容安全。 */

  /* 发布后本地又有改动的记录 */
  async changedRecords() {
    const list = await this.getHistory();
    const cands = (list || []).filter((r) => r && r.ok && !r.unpub && r.docId && r.stamp);
    if (!cands.length) return [];
    let cur = null;
    try { cur = await this.stampsFor(cands.map((r) => String(r.docId))); }
    catch (e) { return []; }
    if (!cur || !cur.size) return [];
    return cands.filter((r) => {
      const s = cur.get(String(r.docId));
      return !!s && !this.constructor.stampEqual(r.stamp, s);
    });
  }

  /* 本地已经找不到、线上目录还在的记录（取消发布没做，或文档是在别处/别的设备上删的） */
  async deletedRecords() {
    const list = await this.getHistory();
    const cands = (list || []).filter((r) => r && r.ok && !r.unpub && r.docId && r.stamp);
    if (!cands.length) return [];
    let cur = null;
    try { cur = await this.stampsFor(cands.map((r) => String(r.docId))); }
    catch (e) { return []; }
    if (!cur || !cur.size) return [];
    return cands.filter((r) => !cur.get(String(r.docId)));
  }

  /* 批量重新发布。看板按钮传「当前筛选出来的这批」，命令面板不传参数、自己从历史算。
   * 串行执行：_publish 本来就一次只跑一篇，这里自己排队是为了「用户按了取消，
   * 后面的篇就别再发」——发布内部的检查点只管本篇，篇与篇之间得由这里把关。 */
  async bulkRepublishChanged(recs) {
    if (this._bulkRunning) { showMessage(this.t("busyNow"), 3000, "warn"); return; }
    let targets = Array.isArray(recs) ? recs.slice() : await this.changedRecords();
    targets = targets.filter((r) => r && r.docId && r.ok);
    if (!targets.length) { showMessage(this.t("bulkRepublishNone"), 4000, "info"); return; }
    const names = targets.map((r) => r.docName || r.docId);
    const tip = this.t("bulkRepublishConfirm")
      .replace("{n}", String(targets.length))
      .replace("{l}", names.slice(0, 6).join("、")
        + (names.length > 6 ? ` …共 ${names.length} 篇` : ""));
    if (!window.confirm(tip)) return;
    this._bulkRunning = true;
    this.cancelRequested = false;
    let okN = 0, failN = 0, stopped = 0;
    try {
      const keyOf = (r) => `${r.docId}|${r.protocol || "webdav"}|${r.merge ? 1 : 0}`;
      for (let i = 0; i < targets.length; i++) {
        const rec = targets[i];
        if (this.cancelRequested) { stopped = targets.length - i; break; }
        const before = (await this.getHistory()).find((r) => r && keyOf(r) === keyOf(rec));
        const beforeTime = before ? Number(before.time) || 0 : -1;
        /* 单篇异常不该带走整批：publish() 自己把 _publish 的 reject 吃掉了，这里防的是
         * 被换掉/子类化之后的意外，以及 getHistory 这类辅助调用出错。真炸了就记一笔失败继续跑，
         * 让最后的汇总仍然说得出「几篇成、几篇没成」。 */
        try {
          await this.publish(rec.docId, !!rec.merge,
            rec.protocol ? { proto: rec.protocol } : undefined);
        } catch (e) {
          failN++;
          console.error("[netglimmer-upload] 批量重发单篇异常：" + (rec.docName || rec.docId), errForLog(e));
          continue;
        }
        const after = (await this.getHistory()).find((r) => r && keyOf(r) === keyOf(rec));
        // 时间没往前走 = 这篇根本没跑起来（被别的任务挡住/配置不全直接返回），算失败
        if (after && Number(after.time) > beforeTime && after.ok) okN++; else failN++;
      }
    } finally {
      this._bulkRunning = false;
    }
    let doneMsg = this.t("bulkRepublishDone")
      .replace("{ok}", String(okN)).replace("{fail}", String(failN));
    /* 中途取消的剩下的篇数不该被说成「失败」——那是用户自己叫停的，
     * 和远端报错是两回事，混在一起会让人以为批量重发把线上弄坏了。 */
    if (stopped) doneMsg += " · " + this.t("bulkStoppedNote").replace("{n}", String(stopped));
    showMessage(doneMsg, 8000, (failN + stopped) ? "warn" : "ok");
    return { ok: okN, fail: failN, stopped };
  }

  /* 批量清理「本地已删除、线上仍在」的远端目录。这是本插件唯一会成批删线上数据的动作，
   * 所以四道闸：
   *   ① 确认框逐篇列出目录名（不是「确定要删除吗」这种废话）；
   *   ② 只吃被判成 deleted 的行——整批指纹查不到时那一行根本不会出现（宁缺毋滥）；
   *   ③ 每篇仍走单篇「取消发布」的保护：先看归属标记，挂着别人标记的同名目录不碰；
   *   ④ 篇与篇之间可以取消（正在删的那一篇不能中断，理由见 _unpublish）。
   * opts.confirmed=true 是因为上面已经问过一遍了，不再逐篇弹窗。 */
  async bulkCleanupDeleted(recs) {
    if (this._bulkRunning) { showMessage(this.t("busyNow"), 3000, "warn"); return; }
    let targets = Array.isArray(recs) ? recs.slice() : await this.deletedRecords();
    targets = targets.filter((r) => r && r.docId && r.ok && !r.unpub);
    if (!targets.length) { showMessage(this.t("bulkCleanupNone"), 4000, "info"); return; }
    const dirs = targets.map((r) => r.dirName || r.docName || r.docId);
    const tip = this.t("bulkCleanupConfirm")
      .replace("{n}", String(targets.length))
      .replace("{l}", dirs.slice(0, 6).join("、")
        + (dirs.length > 6 ? ` …共 ${dirs.length} 个` : ""));
    if (!window.confirm(tip)) return;
    this._bulkRunning = true;
    this.cancelRequested = false;
    let done = 0, fail = 0, stopped = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        if (this.cancelRequested) { stopped = targets.length - i; break; }
        Progress.show(this.t("bulkCleaning")
          .replace("{i}", String(i + 1)).replace("{n}", String(targets.length))
          .replace("{d}", dirs[i]), 1);
        // _unpublish 每篇结束都会 Progress.hide()，所以取消按钮要每篇重新挂上
        Progress.enableCancel(this.t("cancel"), this.t("bulkCleanupCancelTip"), () => this.requestCancel());
        // 单篇异常不带走整批，理由同批量重发：这是删线上内容的动作，跑完的每一篇都要有账
        let r = null;
        try {
          r = await this.unpublish(targets[i], { confirmed: true });
        } catch (e) {
          fail++;
          console.error("[netglimmer-upload] 批量清理单篇异常：" + dirs[i], errForLog(e));
          continue;
        }
        if (r && r.fail) fail++; else done++;
      }
    } finally {
      Progress.hide();
      this._bulkRunning = false;
      this.cancelRequested = false;
    }
    let msg = this.t("bulkCleanupDone")
      .replace("{ok}", String(done)).replace("{fail}", String(fail));
    if (stopped) msg += " · " + this.t("bulkStoppedNote").replace("{n}", String(stopped));
    showMessage(msg, 8000, fail + stopped ? "warn" : "ok");
    return { done, fail, stopped };
  }

  /* 记录 → 远端分段：只认发布时存下的 rootSegs，不从展示地址反推。
   * FTP/SFTP 的分段是相对登录目录、本地是相对基础目录，地址里的绝对路径推不回分段；
   * 拿猜出来的路径去删线上内容，删错一次就是一次不可恢复的事故。
   * 缺分段一律返回 null，由调用方提示「手动删除远端目录」。 */
  async rootSegsForRecord(rec) {
    return (rec && Array.isArray(rec.rootSegs) && rec.rootSegs.length) ? rec.rootSegs : null;
  }

  /* 标成「已下线」：记录留在看板上（时间/文档/协议仍可查），但 pub=false，
   * 文档树角标与「有改动未发布」判定都不再把它算作已发布。
   * 同一篇文档若还有别的成功记录（另一协议或另一 merge），角标继续亮。 */
  async markUnpublished(rec) {
    const list = await this.getHistory();
    for (const r of list || []) {
      if (r && r.docId === rec.docId && (r.protocol || "webdav") === (rec.protocol || "webdav")
        && !!r.merge === !!rec.merge && r.time === rec.time) {
        r.pub = false;
        r.unpub = true;
      }
    }
    const stillOn = (list || []).some((r) => r && r.docId === rec.docId && !!r.pub);
    if (!stillOn) {
      if (this.publishedMap) this.publishedMap.delete(rec.docId);
      if (this.publishedStamp) this.publishedStamp.delete(rec.docId);
      if (this.changedSet) this.changedSet.delete(rec.docId);
    }
    await this.persistHistory(list);
    this.scheduleTreeDecorate();
    this.refreshChangedState(true).catch(() => {});
  }

  /* 把勾选的几条从发布记录清单里摘掉：只改本地历史（saveData(HISTORY_KEY)），
   * 一个远端请求都不发——这是「让这条历史不再占地方」，不是「取消发布」。
   * 线上还挂着的行由 UI 挡住（复选框 disabled），这里再兜一层：即便调用方传进来
   * 一个活着记录的键，也只统计进 blocked、绝不删。
   * 真删掉至少一条后要重算已发布集合：被删的这篇若没有其他成功记录，
   * 文档树角标就该灭（否则树上还亮着、看板上却已经查无此条）。 */
  async deleteHistoryRows(keys) {
    const want = keys instanceof Set ? keys : new Set(keys || []);
    if (!want.size) return { removed: 0, blocked: 0 };
    const list = (await this.getHistory()) || [];
    const keep = [];
    let blocked = 0;
    let removed = 0;
    for (const r of list) {
      if (!r || !want.has(rowKeyOf(r))) { keep.push(r); continue; }
      /* 认不出的键（记录被 addHistory 覆盖过、time 变了）不可能在这里出现：
       * 键是渲染时从同一份历史算出来的。真出现就是没勾中，按原样留下。 */
      if (isLiveRec(r)) { blocked++; keep.push(r); continue; }
      removed++;
    }
    if (!removed) return { removed: 0, blocked };
    await this.persistHistory(keep);
    await this.refreshPublishedSet();
    this.scheduleTreeDecorate();
    this.refreshChangedState(true).catch(() => {});
    return { removed, blocked };
  }

  async removeTree(files, dirs, root) {
    for (const f of files) {
      try { await fetchSyncPost("/api/file/removeFile", { path: f.path || f }); } catch (e) { /* noop */ }
    }
    const deepFirst = [...dirs].sort((a, b) => b.split("/").length - a.split("/").length);
    for (const d of deepFirst) {
      try { await fetchSyncPost("/api/file/removeFile", { path: d }); } catch (e) { /* noop */ }
    }
    if (root) {
      try { await fetchSyncPost("/api/file/removeFile", { path: root }); } catch (e) { /* noop */ }
    }
  }

  /* ---------- 发布历史与看板 ---------- */

  /* 写一条上传记录。三个不显眼的口径都在这道门口：
   *   ① 去重键 = 文档 + 协议 + 是否含子文档，重复上传刷新同一行；
   *   ② 失败行的「线上还挂着」继承——只有本次没把上一次那个远端根目录删过才成立；
   *   ③ 清单封顶裁剪绝不丢掉某篇文档唯一的已发布记录（理由见 trimHistory）。
   * 存不进去必须让人看见：这份清单是看板找回远端目录的唯一线索，静默失败等于
   * 用户以为记下了、看板上却查无此条。 */
  async addHistory(rec) {
    let list;
    try {
      list = (await this.loadData(HISTORY_KEY)) || [];
      // 同一「文档 + 协议 + 是否含子文档」只保留一条记录：重复发布刷新时间/结果，
      // 不再堆积多条。不同协议（WebDAV vs FTP…）视为不同发布，各自一条。
      const keyOf = (r) => `${r.docId}|${r.protocol || "webdav"}|${r.merge ? 1 : 0}`;
      const k = keyOf(rec);
      let idx = -1;
      for (let i = 0; i < list.length; i++) {
        if (list[i] && keyOf(list[i]) === k) { idx = i; break; }
      }
      if (idx >= 0) {
        const old = list[idx];
        /* 本次失败但此前成功：保留已发布地址，避免角标/打开链接丢失（远端仍是旧的已发布内容）。
         * 前提是真的还挂着——本次这一跑如果已经把上一次那个根目录整树删过
         * （发布前的非增量清理、改名后的残留清理），旧地址就是 404，pub 也不能再继承，
         * 否则看板上是一行「已发布 + 一个打不开的路径」，而远端只剩半棵目录。 */
        if (!rec.ok && old.ok && !this.oldRootDestroyed(old, rec)) {
          if (!rec.docName && old.docName) rec.docName = old.docName;
          /* 旧记录已经被用户亲手删掉远端（unpub）：那个地址与「线上还挂着」都不存在了。
           * 继承的话角标会亮、看板给一条打不开的路径，还递上一把「删除远端文件」。 */
          if (!old.unpub) {
            if (!rec.url && old.url) rec.url = old.url;
            rec.pub = true; // 仍视为“已发布过”
          }
        }
        /* 发布次数：一行会被重复发布覆盖，「这篇到底发过几次、第一次是啥时候」原本看不出来。
         * 只数成功的那几次（失败的覆盖在同一行上，不该算一次发布），首次时间一并留下。 */
        const prevCount = Number(old.count) || (old.ok ? 1 : 0);
        const n = prevCount + (rec.ok ? 1 : 0);
        if (n > 0) rec.count = n;
        rec.firstTime = Number(old.firstTime) || Number(old.time) || Number(rec.time) || 0;
        list.splice(idx, 1); // 去掉旧记录，随后 unshift 新记录到顶部
      }
      list.unshift(rec);
      list = trimHistory(list);
      // 落盘（失败由 persistHistory 报告，不再往上抛：这一跑的实际结果已经发生在远端）
      await this.persistHistory(list);
    } catch (e) {
      console.error("[netglimmer-upload] history add", errForLog(e));
      showMessage(`${this.t("histSaveFail")}: ${redactUrl(String(e.message || e))}`, 7000, "error");
    }
  }

  /* 「上一次成功记录指向的远端根目录，本次删过没有」——只看事实，不猜：
   * rec.destroyed 由 publish 在每一次整树删除动手之前写下（见 markDestroyed），
   * old.rootSegs 是那次成功发布存下的定位信息。认不出旧根目录（记录没有 rootSegs）
   * 时按原样继承：宁可保守地把行留在「活着」那一侧，也不把一份可能还在线上好好
   * 挂着的内容判成可以随手删记录。 */
  oldRootDestroyed(old, rec) {
    const dead = rec && Array.isArray(rec.destroyed) ? rec.destroyed : [];
    if (!dead.length) return false;
    const root = old && Array.isArray(old.rootSegs) ? old.rootSegs.join("/") : "";
    return !!root && dead.includes(root);
  }

  /* 历史清单落盘（markUnpublished / deleteHistoryRows 用）。
   * 与 addHistory 的区别：这里的调用方已经动过远端（删完目录、删完记录），
   * 写盘失败只报告、不再往上抛——否则「远端已经删掉了」会被一句本地 IO 错误
   * 盖成「操作失败」，用户再去重试就是对着已经不存在的目录动手。
   * 但必须报告：内存清单已经改了，重启后以磁盘为准，看板与线上就会各说各话。 */
  async persistHistory(list) {
    this.historyCache = list;
    try {
      await this.saveData(HISTORY_KEY, list);
      return true;
    } catch (e) {
      console.error("[netglimmer-upload] history save", errForLog(e));
      showMessage(`${this.t("histSaveFail")}: ${redactUrl(String(e.message || e))}`, 7000, "error");
      return false;
    }
  }

  async getHistory() {
    if (this.historyCache) return this.historyCache;
    let list = [];
    try { list = (await this.loadData(HISTORY_KEY)) || []; } catch (e) { /* noop */ }
    this.historyCache = list;
    return list;
  }

  /* 改动指纹：该文档全部块的 max(updated) + count。发布成功后记录，
   * 看板里与当前值比对即可判断「源自发布后是否有改动」。
   * docId 走白名单正则校验，防止拼 SQL 注入。 */
  async sourceStamp(docId) {
    if (!/^[\w-]{1,32}$/.test(String(docId || ""))) return null;
    try {
      const ret = await fetchSyncPost("/api/query/sql", {
        stmt: `SELECT max(updated) AS u, count(*) AS c FROM blocks WHERE root_id = '${docId}'`,
      });
      const row = (ret.data || [])[0];
      if (!row || row.u == null) return null;
      return { u: String(row.u), c: Number(row.c || 0) };
    } catch (e) { return null; }
  }

  static stampEqual(a, b) {
    return !!a && !!b && String(a.u) === String(b.u) && Number(a.c) === Number(b.c);
  }

  /* 内核块索引有几百毫秒到几秒的落盘延迟：刚 createDocWithMd / 大段改完就发布时，
   * 指纹可能查不到。查不到就别记（宁可角标少亮，也不要记成 null 被误判为“有改动”），
   * 但先短暂重试两次，把常见的一次性延迟吸收掉。 */
  async sourceStampSettled(docId, tries) {
    const n = Math.max(1, tries || 3);
    let stamp = null;
    for (let i = 0; i < n; i++) {
      stamp = await this.sourceStamp(docId);
      if (stamp) break;
      if (i < n - 1) await sleep(700);
    }
    return stamp;
  }

  fmtTime(t) {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  fmtBytes(n) {
    if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
  }

  /* ---------- 发布看板：优先注册为独立页签（addTab API），弹窗仅作回退 ---------- */

  registerDashTab() {
    if (typeof this.addTab !== "function") { this.dashTabOk = false; return; }
    const plugin = this;
    try {
      this.addTab({
        type: "PublishDashboard",
        init() {
          plugin.dashModel = this;
          if (this.element) {
            this.element.style.cssText = "height:100%;overflow:auto;padding:14px 16px;box-sizing:border-box;";
            plugin.renderDashTab(this.element);
          }
        },
        update() {
          plugin.dashModel = this;
          if (this.element) plugin.renderDashTab(this.element);
        },
        destroy() {
          if (plugin.dashModel === this) plugin.dashModel = null;
          /* 页签关掉 == 这次「看板上找什么」结束了。筛选与勾选复位，下次开页签从全部记录
           * 开始（renderDashTab 用的是新元素，骨架跟着重建，控件也会跟着对齐）。 */
          plugin.resetDashFilter();
        },
      });
      this.dashTabOk = true;
    } catch (e) {
      this.dashTabOk = false;
    }
  }

  renderDashTab(el) {
    const ui = {
      showClose: false,
      refresh: () => this.renderDash(el, ui),
      close: () => {},
      closeOnPublish: false,
    };
    ui.refresh();
  }

  async openDashboard() {
    this.resetDashFilter();
    // 首选：作为独立页签打开（3.4+ 的 addTab / openTab API）
    if (this.dashTabOk && typeof openTab === "function" && this.app) {
      try {
        await openTab({
          app: this.app,
          custom: {
            id: this.name + "PublishDashboard", // 约定：插件名称 + 页签类型
            icon: "iconPreview",
            title: this.t("dashboard"),
            data: {},
          },
          position: "right",
          keepCursor: true,
        });
        // 页签已存在时 openTab 只会聚焦，这里手动刷新一次数据
        if (this.dashModel && this.dashModel.element) this.renderDashTab(this.dashModel.element);
        return;
      } catch (e) { /* 回退弹窗 */ }
    }
    // 回退 1：importDialog（较新版本）
    /* min-width 用 min(760px, 96vw) 而不是裸 760px：七列的地板合计就那么多，窄窗口里
     * 出横向滚动条是对的（run-layout 的 1000/800 两档按这条判），但弹窗自己不该比窗口还宽
     * ——写死 760px 时 790px 以下的思源窗口会被弹窗本身顶出横向滚动。 */
    const content = '<div class="vd-dash" style="padding:14px 16px;min-width:min(760px,96vw);max-width:92vw;box-sizing:border-box;"></div>';
    let dialog = null;
    let box = null;
    if (typeof importDialog === "function") {
      try {
        const d = importDialog(this, { title: this.t("dashTitle"), content });
        box = d && d.element && d.element.querySelector(".vd-dash");
        if (box) dialog = d;
      } catch (e) { /* 继续回退 */ }
    }
    // 回退 2：通用 Dialog（3.8.x 签名为 {title, content}，更早为 {label, html, show}）
    if (!dialog && typeof Dialog === "function") {
      const variants = [
        { title: this.t("dashTitle"), content, width: "92vw", height: "80vh" },
        { label: this.t("dashTitle"), html: content, show: true, mask: true },
      ];
      for (const opts of variants) {
        try {
          const d = new Dialog(opts);
          const b = d && d.element && d.element.querySelector(".vd-dash");
          if (b) { dialog = d; box = b; break; }
        } catch (e) { /* 继续回退 */ }
      }
    }
    if (!dialog || !box) {
      showMessage(this.t("dashUnavailable"), 3000, "error");
      return;
    }
    const ui = {
      showClose: true,
      refresh: () => this.renderDash(box, ui),
      close: () => { try { dialog.destroy(); } catch (e) {} },
      closeOnPublish: true,
    };
    ui.refresh();
  }

  /* 表头右缘的列宽把手：9px 宽、整列高的热区，中间一条极淡的竖线提示「这里能拖」，
   * 悬上去变 col-resize。touch-action:none 让手机上也能动把手而不是滚页面。
   * pointermove/up 注册在 window 上（指针滑出表头也不脱手），松手时成对注销；
   * this.dashColCleanup 始终指向当前这次拖拽，看板在拖动途中被重绘也不留野监听。
   * edge=true（最后一列）时把手整体收进单元格内（right:0 而不是 right:-4px）：
   * 负偏移会让把手探出网格内容盒，浏览器据此算出一条 4px 的**假**横向滚动条
   * ——真 Chromium 量出来就是 scrollWidth 1146 / clientWidth 1142，明明七列刚好放满
   * 却冒出一条拖不动的滚动条（截图里那条）。 */
  colGrip(idx, widths, applyCols, saveCols, edge) {
    const grip = document.createElement("div");
    grip.className = "vd-col-grip";
    grip.title = this.t("colResizeTip");
    grip.style.cssText = "position:absolute;top:0;right:" + (edge ? "0" : "-4px") + ";width:9px;height:100%;cursor:col-resize;"
      + "touch-action:none;z-index:3;user-select:none;"
      + "background:linear-gradient(to right,transparent 4px,var(--b3-theme-surface-lighter) 4px,"
      + "var(--b3-theme-surface-lighter) 5px,transparent 5px);";
    /* 拖完/双击完那一下也会冒出一个 click：表头现在是排序把手，不挡住就会「拖个列宽顺手把
     * 排序翻了」。click 在把手上就地拦掉。 */
    grip.addEventListener("click", (e) => { if (e && typeof e.stopPropagation === "function") e.stopPropagation(); });
    grip.addEventListener("dblclick", () => {
      widths[idx] = DASH_COLS[idx].def;
      applyCols();
      saveCols();
    });
    grip.addEventListener("pointerdown", (e) => {
      if (e && e.button != null && e.button !== 0) return;
      if (e && typeof e.preventDefault === "function") e.preventDefault();
      const col = DASH_COLS[idx];
      const x0 = Number(e && e.clientX) || 0;
      const w0 = widths[idx];
      /* 先收尾上一次还没松手的拖拽（正常不会发生，重绘/多把手时才可能），
       * 再取 userSelect 快照——顺序反了会把上一次存的值当成这次的基线。 */
      if (typeof this.dashColCleanup === "function") { try { this.dashColCleanup(); } catch (err) {} }
      const keep = document.body.style.userSelect;
      let moved = false;
      document.body.style.userSelect = "none";
      const move = (ev) => {
        const dx = (Number(ev && ev.clientX) || 0) - x0;
        if (dx !== 0) moved = true;
        widths[idx] = clampInt(w0 + dx, col.min, col.max, col.def);
        applyCols();
      };
      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        if (this.dashColCleanup === end) this.dashColCleanup = null;
        document.body.style.userSelect = keep || "";
        if (moved) saveCols();
      };
      this.dashColCleanup = end;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    });
    return grip;
  }

  /* 看板「结果」列的徽标：文字外面套一层同色系胶囊，三态一眼可分——
   * 成功=绿、失败=红、已取消发布=灰（灰是「这条记录已经不代表线上状态」，
   * 不该跟失败抢注意力）。前景色全部取主题变量，深浅色自动跟随；
   * 底色用 color-mix 从同一个前景色派生，老浏览器不认时整条 background 声明被
   * 丢弃（IACVT），退化成「只有文字色 + 圆角内边距」，不会出现白底白字这种最坏情况。
   * white-space:nowrap 是关键：之前 60px 列宽 + break-all 把「已取消发布」折成两行。 */
  statusPill(rec) {
    const unpub = !!(rec && rec.ok && rec.unpub);
    const ok = !unpub && !!(rec && rec.ok);
    const fg = unpub ? "var(--b3-theme-on-surface-light)"
      : ok ? "var(--b3-theme-success)" : "var(--b3-theme-error)";
    const el = document.createElement("span");
    el.textContent = unpub ? this.t("stUnpub") : ok ? this.t("stOk") : this.t("stFail");
    el.style.cssText = "display:inline-block;padding:1px 9px;border-radius:10px;font-size:12px;"
      + "font-weight:600;line-height:18px;white-space:nowrap;color:" + fg
      + ";background:" + (unpub ? "var(--b3-theme-surface-lighter)"
        : "color-mix(in srgb, " + fg + " 14%, transparent)") + ";";
    if (!ok && !unpub && rec && rec.err) el.title = rec.err;
    else if (unpub) el.title = this.t("unpublishTip");
    return el;
  }

  /* 看板的筛选/排序/勾选状态。q / 协议 / 结果 / 只看有改动 / 勾了哪几条 只在本次打开里有效——
   * 关掉看板就该回到「全部、一个都没勾」，否则下次进来看到一张空表、
   * 或按钮上挂着「删除所选 3 条」，都会让人以为是记录丢了。
   * 只有排序方式写进 localStorage：排序是习惯，筛选和勾选是临时意图。
   * （顺带说，这个 key 存的是 {key,dir}，与列宽那个 key 各管各的，坏数据各自降级。） */
  dashView() {
    if (!this._dashView) {
      this._dashView = {
        q: "", proto: "", status: "", changedOnly: false, sort: null,
        sel: new Set(),
        /* 页码是「这次翻到哪儿了」，跟筛选一样是临时意图，不记；
         * 每页条数是习惯，记在 localStorage（口径同排序方式）。 */
        page: 1,
        pageSize: parseDashPageSize(lsRead(DASH_PAGE_KEY)),
      };
      try {
        const raw = lsRead(DASH_VIEW_KEY);
        if (raw) {
          const o = JSON.parse(raw);
          if (o && DASH_SORT_KEYS.indexOf(o.key) >= 0) {
            this._dashView.sort = { key: o.key, dir: Number(o.dir) === 1 ? 1 : -1 };
          }
        }
      } catch (e) { /* 坏数据 → 默认排序（时间倒序） */ }
    }
    return this._dashView;
  }

  /* 打开发布看板 / 切走看板时的复位。
   *
   * 筛选（搜索词、协议、结果、只看有改动）与勾选是「这一次要在看板上找什么」的临时
   * 意图，不是习惯——习惯（排序方式）记在 localStorage，这些不该记。以前这句话只写在
   * dashView() 的注释里，没有任何地方实现：于是搜过一次「失败」之后，重开看板还是
   * 那一屏，勾着「只看有改动」，用户看到的就是「我的记录怎么只剩一条 / 筛选坏了」。
   * 复位只改 view 里的字段；控件由下一次 paint 开头的 syncFilterUI 统一对齐。 */
  resetDashFilter() {
    const v = this._dashView;
    if (!v) return;
    v.q = "";
    v.proto = "";
    v.status = "";
    v.changedOnly = false;
    v.page = 1;
    if (v.sel instanceof Set) v.sel.clear();
  }

  /* 看板：两层渲染。
   *   骨架 = 工具条 + 筛选条——一块看板界面只建一次；
   *   表体 = 摘要 + 表格（或空态提示）——每次刷新重画。
   * 以前每次刷新都整块重画，代价比看上去大得多：
   *   ① 搜索框那个节点被换成新的。中文输入法正在拼的时候换节点＝组合被浏览器取消，
   *      用户在框里打不进汉字（现场说的「筛选用不了」正是这条）；焦点要事后还、
   *      滚动位置与拖出来的列宽也跟着重来。
   *   ② 骨架上那两个批量按钮原本捕获的是「这一帧的 items」，所以不整块重画就没法把
   *      作用范围挪到新的一屏——现在它们读活的 st，点的那一刻才取当前筛选结果。
   *   ③ 每次筛选改动都要重跑一遍改动指纹的批量 SQL（几百篇就是几百行查询）。
   * 骨架认 box 不认 ui：同一块 box 再来一次（切页签、发布完刷新、弹窗重挂）只重画表体，
   * 并把 ui 换成最新的——行按钮上的「发布前关掉这个弹窗」得跟着当前那份 ui 走。 */
  async renderDash(box, ui) {
    const skel = box.__vdSkel;
    if (skel) { skel.useUi(ui); await skel.paint(); return; }
    box.textContent = "";
    /* view 是「读当前那份」而不是「建骨架时那一份」：回归与外部复位会直接把
     * _dashView 换成新对象（等价于重开看板），骨架要是咬住旧对象不放，
     * 控件显示的和筛选用的就是两个状态了。 */
    let view = this.dashView();
    const sel = () => {
      if (!(view.sel instanceof Set)) view.sel = new Set();
      return view.sel;
    };
    /* 活的看板状态：表体每次重画都写回这里，骨架上的按钮与计数只读它。 */
    const st = {
      ui, list: [], items: [], delItems: [], boxes: [], grid: null, colNeeds: null,
      masterBox: null,
      pageInfo: { rows: [], page: 1, pages: 1, from: 0, to: 0 },
    };

    /* 列宽：默认值之上覆盖「这个浏览器里上次拖出来的结果」（localStorage 按设备/浏览器记，
     * 不随笔记同步）。拖动只改内存里的数组 + 重排网格，松手才落盘。存的是默认值之上那一层，
     * 筛选/重画都不会把读者拖出来的宽度冲掉（以前整块重画时它也是这么活的，口径不变）。
     * 把手挂每列表头右缘，pointermove/up 注册在 window 上——指针滑出表头也不会脱手。 */
    const widths = parseDashColWidths(lsRead(DASH_COLS_KEY));
    const saveCols = () => lsWrite(DASH_COLS_KEY, JSON.stringify(widths));
    /* 量内容宽要留 10px 余量：竖向滚动条本身也吃宽度，而「要不要出竖向滚动条」又取决于
     * 行高、行高又取决于列宽——不留余量时这一步会永远差出一条 5px 的横向滚动条
     * （实测 1000px 视口：822 可用 / 折出来 827）。宁可让列早十像素开始换行，
     * 也不要凭空多一条拖不动的横滚。 */
    const dashAvail = () => {
      const w = (st.grid && st.grid.clientWidth) || (box && box.clientWidth) || 0;
      return w > 0 ? w - 10 : 0;
    };
    /* 内容下限只在「这一批格子排好之后」量一次，结果记在 st.colNeeds；
     * null ＝还没量（或宿主量不出来），dashFitCols 收到 null 就退回 DASH_COLS 的常数地板。
     * 为什么不在每次 applyCols 里重量：拖把手时 pointermove 一路调 applyCols，
     * 60 行 × 四列就是两百多次 Range + getComputedStyle，每帧重做一遍纯属烧 CPU，
     * 而它量的是**文案**的单行宽——nowrap 列的文案不会因为列宽变了就变。 */
    const applyCols = () => {
      if (!st.grid) return;
      st.grid.style.cssText = "display:grid;grid-template-columns:"
        + dashColTemplate(fitDashWidths(widths, dashAvail(),
          dashFitCols(DASH_COLS, st.colNeeds), DASH_FLEX_COL))
        + ";overflow:auto;max-height:calc(100vh - 220px);";
    };
    /* 表头同时是排序把手（可排的五列）与列宽把手（全部七列）。点表头切排序并落盘；
     * 把手自己在 click 里 stopPropagation，拖完那一下不会顺带把排序也翻了。 */
    const th = (label, col, tip) => {
      const sortable = typeof col === "number" && DASH_COLS[col]
        && DASH_SORT_KEYS.indexOf(DASH_COLS[col].key) >= 0;
      const el = document.createElement("div");
      el.className = "vd-dash-th";
      el.textContent = label;
      /* 表头那一行的折不折行跟着**这一列**的口径走：不许折行的四列（时间/协议/结果/操作）
       * 表头也 nowrap，于是列名 + 排序箭头 + 全选主框排不下时，dashColNeeds 量的是表头
       * 的内容、地板跟着抬；会折行的三列（文档/详情/改动）表头允许换行——那一列本来就在
       * 换行，把表头钉成 nowrap 只会让它压到邻列的表头上面去（th 没有 overflow:hidden，
       * 压下去是真重叠，不是省略号）。
       * cursor 写在 cssText 里而不是 el.style.cursor =：浏览器里两者等价，但回归桩件的
       * style 是个普通对象，属性式赋值不会进 cssText——写成一串才有唯一断言口径。 */
      const colDef = typeof col === "number" ? DASH_COLS[col] : null;
      el.style.cssText = "font-weight:600;color:var(--b3-theme-on-surface);padding:6px 8px;"
        + "border-bottom:1px solid var(--b3-theme-surface-lighter);position:relative;"
        + (colDef && colDef.nowrap ? "white-space:nowrap;" : "white-space:normal;")
        + (sortable ? "cursor:pointer;" : "");
      const key = typeof col === "number" && DASH_COLS[col] ? DASH_COLS[col].key : "";
      const curSort = view.sort || { key: "time", dir: -1 };
      if (sortable) {
        el.title = this.t("dashSortTip");
        el.addEventListener("click", () => {
          view.sort = curSort.key === key
            ? { key, dir: curSort.dir === 1 ? -1 : 1 }
            // 第一次点某列：时间看最新的，其余把「有问题的」顶上来
            : { key, dir: key === "time" ? -1 : 1 };
          lsWrite(DASH_VIEW_KEY, JSON.stringify(view.sort));
          paint();
        });
        if (curSort.key === key) {
          const arrow = document.createElement("span");
          arrow.className = "vd-dash-sort";
          arrow.textContent = curSort.dir === 1 ? "↑" : "↓";
          arrow.style.cssText = "margin-left:4px;color:var(--b3-theme-primary);font-size:11px;";
          el.append(arrow);
        }
      }
      if (typeof col === "number") el.append(this.colGrip(col, widths, applyCols, saveCols,
        col === DASH_COLS.length - 1));
      /* 不可排序的列也能带一句说明（详情列的「两个口径」就走这条路）。可排序的列上面
       * 已经把 dashSortTip 写进 title 了，这里接在后面而不是盖掉它：一句关于数字的说明
       * 不该把人家的排序提示吃掉。 */
      if (tip) el.title = el.title ? `${el.title}\n${tip}` : tip;
      return el;
    };
    const td = () => {
      const el = document.createElement("div");
      el.style.cssText = "padding:6px 8px;border-bottom:1px solid var(--b3-theme-surface-lighter);color:var(--b3-theme-on-surface);font-size:13px;word-break:break-all;";
      return el;
    };
    /* 不折行的单元格（时间 / 协议 / 结果 / 操作）：nowrap 让内容成为一个不可拆的整体，
     * dashColNeeds 才量得出"这一列排成一行要多宽"，量到的那个数就是这一列的地板。
     * overflow:hidden + text-overflow:ellipsis 留着当最后一道网：地板只量前
     * DASH_MEASURE_ROWS 行，更下面万一有一行更宽，宁可它省略号收口，也不能让字压到邻列去。 */
    const tdNowrap = () => {
      const el = td();
      el.style.cssText += "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      return el;
    };
    const btn = (label, cls, fn) => {
      const el = document.createElement("button");
      el.className = cls || "b3-button b3-button--outline";
      /* 看板里的按钮比默认的 10px 左右内边距窄一点（8px），四个按钮（重新上传 /
       * 试算 / 删除远端文件 / 删除记录）才塞得进 232px 的操作列、且不换行；
       * white-space:nowrap 是给按钮自己的——按钮被挤到只剩两个字时，saplay 的默认样式
       * 会让「重新上/传」折成两行，那比整列换行难看得多。 */
      el.style.cssText = "padding:2px 8px;margin:2px 3px 2px 0;font-size:12px;white-space:nowrap;";
      el.textContent = label;
      el.addEventListener("click", fn);
      return el;
    };

    /* 勾选态（rowKeyOf → Set）挂在 view 上：表体每次重画都会重建行，靠 DOM 的 checked
     * 记勾选会在下一帧全丢。每次重画先按「还在当前筛选结果里」把 Set 修剪一遍——
     * 被筛掉的行不算勾选，也就不会被「删除所选」偷偷删掉（筛完才发现勾了早就不匹配的行，
     * 是最吓人的误删口径）。跨页保留是「全选（筛选结果 N 条）」的题中之义：它的按钮文字
     * 和「删除所选 N 条」的确认语都如实报条数，勾着第 3 页的行、在第 1 页点删除，删的就是
     * 那 N 条——N 里已经把它们算进去了。
     * 线上还挂着的行（isLiveRec）压根不给勾：删它的记录等于扔掉远端目录的线索。
     * 两个批量把手的文案/禁用态就地更新（syncSel），勾一下不重画整张表。 */
    let selAllBtn = null;
    let delBtn = null;
    const allSelected = () => st.delItems.length > 0
      && st.delItems.every((it) => sel().has(rowKeyOf(it.rec)));
    /* 表头那个主复选框只管「当前这一页」——它长在表头里，管的自然是被表头压住的那些行。
     * 跨页的全选交给工具条那个按钮，两者的作用范围各自写在 tooltip 上，不靠猜。 */
    const pageDelItems = () => st.pageInfo.rows.filter((it) => !isLiveRec(it.rec));
    st.masterBox = document.createElement("input");
    st.masterBox.type = "checkbox";
    st.masterBox.className = "vd-dash-sel-master";
    st.masterBox.style.cssText = "margin:0 8px 0 0;vertical-align:middle;cursor:pointer;";
    st.masterBox.title = this.t("dashSelPageTip");
    /* 它长在表头里，而表头整块是排序把手：不拦住冒泡，勾一下顺带把排序翻了，
     * 排序一翻行就重排，「刚勾的那页」立刻变成另一批行（列宽把手也照样 stopPropagation）。 */
    st.masterBox.addEventListener("click", (e) => { if (e && e.stopPropagation) e.stopPropagation(); });
    st.masterBox.addEventListener("change", () => {
      const on = !!st.masterBox.checked;
      for (const it of pageDelItems()) {
        const k = rowKeyOf(it.rec);
        if (on) sel().add(k); else sel().delete(k);
      }
      syncSel();
    });
    const syncSel = () => {
      if (delBtn) {
        delBtn.disabled = sel().size === 0;
        delBtn.textContent = sel().size
          ? this.t("dashDelSel").replace("{n}", String(sel().size))
          : this.t("dashDelSelZero");
      }
      if (selAllBtn) {
        selAllBtn.disabled = st.delItems.length === 0;
        selAllBtn.textContent = this.t(allSelected() ? "dashSelNone" : "dashSelAll")
          .replace("{n}", String(st.delItems.length));
      }
      if (st.masterBox) {
        const page = pageDelItems();
        const n = page.filter((it) => sel().has(rowKeyOf(it.rec))).length;
        st.masterBox.disabled = page.length === 0;
        st.masterBox.checked = page.length > 0 && n === page.length;
        /* 半选（这一页勾了一部分）必须让框自己说出来：一个显示成「没勾」的全选框，
         * 点下去会把已勾的悄悄取消掉，谁都不会预期这个结果。 */
        st.masterBox.indeterminate = n > 0 && n < page.length;
        st.masterBox.style.cssText = "margin:0 8px 0 0;vertical-align:middle;cursor:"
          + (page.length ? "pointer;" : "not-allowed;");
      }
      for (const b of st.boxes) if (!b.disabled) b.checked = sel().has(b.vdKey);
    };

    /* 「全选（筛选结果 N 条）/ 取消勾选 / 删除所选 N 条」：只动这份本地清单，一个远端请求都不发。
     * 全选的作用范围是整个筛选结果（跨页），而线上还挂着的那几行压根进不了 Set——
     * 它们的复选框是 disabled 的，deleteHistoryRows 里再兜一层，
     * 万一被谁绕过 UI 直接调用也删不掉活着的记录。 */
    selAllBtn = btn(this.t("dashSelAll").replace("{n}", "0"), "b3-button b3-button--outline vd-dash-sel-all", () => {
      const flip = allSelected();
      for (const it of st.delItems) {
        const k = rowKeyOf(it.rec);
        if (flip) sel().delete(k); else sel().add(k);
      }
      syncSel();
    });
    selAllBtn.title = this.t("dashSelFilteredTip");
    delBtn = btn(this.t("dashDelSelZero"), "b3-button b3-button--outline vd-dash-del-sel", async () => {
      if (!sel().size) return;
      const keys = new Set(sel());
      if (!window.confirm(this.t("confirmDelSel").replace("{n}", String(keys.size)))) return;
      const res = await this.deleteHistoryRows(keys);
      sel().clear();
      if (!res.removed) {
        showMessage(this.t("delNothing"), 5000, "warn");
      } else {
        showMessage(this.t("delDone").replace("{n}", String(res.removed))
          + (res.blocked ? "｜" + this.t("delBlocked").replace("{n}", String(res.blocked)) : ""),
        4000, "info");
      }
      paint();
    });
    delBtn.title = this.t("dashDelSelTip");

    // 顶部工具条（骨架：只建一次）
    /* 批量操作是 async 的：跑完（或炸了）都要把这一屏重画一次——状态、改动标记、
     * 「文档已删除」那几行全被它改了，看板停在上一帧上就是骗人。
     * 失败不在这儿额外提示，批量自己会报汇总（行内按钮那三处也是这个写法）。 */
    const repaintAfter = (p) => {
      if (p && typeof p.then === "function") {
        p.then(() => { try { paint(); } catch (e) {} }).catch(() => {});
      }
      return p;
    };
    const bar = document.createElement("div");
    bar.className = "vd-dash-bar";
    bar.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;";
    bar.append(
      btn(this.t("dashRefresh"), "b3-button b3-button--outline", () => paint()),
      /* 批量按钮的作用范围 = 当前筛选出来的这批（不是全部历史）：
       * 先用「只看有改动」或按协议筛一遍，再点批量，才是「只重发这一类」的意思。
       * 读的是 st.items（点的那一刻才取），所以筛选变了也不用重建这两个按钮。
       * 「有改动」是这个按钮的语义本身：没筛选时 st.items 里也有一字未改的记录，
       * 全塞进去会把它们一并重传；指纹查不到（changed=null）的更不碰——判不准不猜。
       * 跑完必须重绘：批量改的是记录与状态，看板停在上一次的行上等于骗人
       *（单条删除那条路就老老实实 paint() 了）。 */
      btn(this.t("bulkRepublish"), "b3-button b3-button--outline", () => {
        repaintAfter(this.bulkRepublishChanged(
          st.items.filter((it) => it.changed === true).map((it) => it.rec)));
      }),
      btn(this.t("bulkCleanupDeleted"), "b3-button b3-button--outline", () => {
        repaintAfter(this.bulkCleanupDeleted(
          st.items.filter((it) => it.status === "deleted").map((it) => it.rec)));
      }),
      selAllBtn, delBtn,
      btn(this.t("clearHistory"), "b3-button b3-button--outline", async () => {
        /* 清空是全量操作（不受筛选影响），它也会把「线上还挂着」那些记录的线索一并扔掉。
         * 单条 / 批量删除有守卫，这条老按钮不该假装一样安全——所以确认语里如实写出条数。 */
        const liveN = st.list.filter((r) => r && isLiveRec(r)).length;
        const ask = this.t("confirmClear") + (liveN
          ? "\n" + this.t("confirmClearLive").replace("{n}", String(liveN)) : "");
        if (!window.confirm(ask)) return;
        await this.persistHistory([]);
        this.publishedMap = new Map();
        this.scheduleTreeDecorate();
        paint();
      }),
      btn(this.t("resetCols"), "b3-button b3-button--outline", () => {
        for (let i = 0; i < DASH_COLS.length; i++) widths[i] = DASH_COLS[i].def;
        lsRemove(DASH_COLS_KEY);
        applyCols();
        showMessage(this.t("colsReset"), 1500, "info");
      }),
    );
    /* 列宽能拖这点不给提示没人会发现，所以工具条右侧放一句灰色小字（窄窗口挤不下就换行） */
    const hint = document.createElement("div");
    hint.className = "vd-dash-col-hint";
    hint.textContent = this.t("colResizeTip");
    hint.style.cssText = "margin-left:auto;color:var(--b3-theme-on-surface-light);font-size:12px;";
    bar.append(hint);
    /* 「关闭」常驻骨架、按当前那份 ui 决定显不显示（syncFilterUI 里同步）：
     * 骨架认 box 不认 ui，同一块 box 可能先被设置弹窗（没有关闭按钮）建起来，
     * 之后被回退弹窗（有关闭按钮）复用——建的时候才决定就少了这个按钮。 */
    const closeBtn = btn(this.t("dashClose"), "b3-button b3-button--outline vd-dash-close",
      () => st.ui.close());
    closeBtn.style.display = ui.showClose ? "" : "none";
    bar.append(closeBtn);
    box.append(bar);

    /* 筛选条（骨架：只建一次，控件节点从此不换）
     * 输入框是即时筛选（260ms 去抖）。这里的重点是「不重画自己」：
     * 以前每次去抖到点都把整块看板重画一遍，搜索框连同它正在进行的输入法一起被换掉，
     * 中文用户在那儿敲拼音会一个字也落不进框里。 */
    const fbar = document.createElement("div");
    fbar.className = "vd-dash-filter";
    fbar.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;";
    const qEl = document.createElement("input");
    qEl.className = "b3-text-field vd-dash-q";
    qEl.type = "text";
    qEl.placeholder = this.t("dashFilterPh");
    qEl.value = view.q || "";
    qEl.style.cssText = "min-width:200px;font-size:12px;padding:2px 8px;";
    let qTimer = null;
    qEl.addEventListener("input", () => {
      view.q = qEl.value || "";
      /* 换了筛选条件却停在第 7 页，看到的就是「一条都没匹配上」的空白表——
       * 筛选结果一变短，页码必须回到第一页（越界夹取只是兜底，不等于可以留着）。 */
      view.page = 1;
      if (qTimer) clearTimeout(qTimer);
      qTimer = setTimeout(() => { paint(); }, 260);
    });
    const mkSel = (cls, opts, onPick) => {
      const s = document.createElement("select");
      s.className = cls;
      s.style.cssText = "font-size:12px;padding:2px 6px;";
      for (const o of opts) {
        const op = document.createElement("option");
        op.value = o.v;
        op.textContent = o.t;
        s.append(op);
      }
      // value 要在 option 之后赋，否则 select 认不出这个值（真 DOM 的规则）
      s.value = "";
      s.addEventListener("change", () => { onPick(s.value || ""); paint(); });
      return s;
    };
    const fproto = mkSel("vd-dash-fproto", [{ v: "", t: this.t("dashAllProto") }],
      (v) => { view.proto = v; view.page = 1; });
    const fstatus = mkSel("vd-dash-fstatus", [
      { v: "", t: this.t("dashAllStatus") },
      { v: "ok", t: this.t("stOk") },
      { v: "fail", t: this.t("stFail") },
      { v: "unpub", t: this.t("stUnpub") },
      { v: "deleted", t: this.t("dashStDeleted") },
    ], (v) => { view.status = v; view.page = 1; });
    /* 协议下拉的选项跟着记录走（只列出这次真用过的协议），但**节点不换**：
     * 每次重画都重建一遍 option 就够了，换掉 select 会让正打开的下拉盒子凭空消失。 */
    const fillProto = (protos) => {
      // 清空旧 option 再逐个挂：textContent="" 是真 DOM 里最省事、也最不会漏的清空法
      fproto.textContent = "";
      const head = document.createElement("option");
      head.value = "";
      head.textContent = this.t("dashAllProto");
      fproto.append(head);
      for (const x of protos) {
        const op = document.createElement("option");
        op.value = x;
        op.textContent = x.toUpperCase();
        fproto.append(op);
      }
    };
    const chg = document.createElement("label");
    chg.className = "vd-dash-fchanged";
    chg.style.cssText = "display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;";
    const chgBox = document.createElement("input");
    chgBox.type = "checkbox";
    /* 这个框自己也要有类名：行首也有复选框（勾选待删记录），
     * 再靠 type==="checkbox" 从一帧里捞「最后一个」就会捞进行勾选框上。 */
    chgBox.className = "vd-dash-fchanged-box";
    chgBox.checked = !!view.changedOnly;
    chgBox.addEventListener("change", () => { view.changedOnly = !!chgBox.checked; view.page = 1; paint(); });
    chg.append(chgBox, document.createTextNode(this.t("dashChangedOnly")));
    const counter = document.createElement("div");
    counter.className = "vd-dash-count";
    counter.style.cssText = "margin-left:auto;color:var(--b3-theme-on-surface-light);font-size:12px;";
    fbar.append(qEl, fproto, fstatus, chg, counter);
    box.append(fbar);

    /* 表体容器：摘要 + 表格 + 空态提示都画在这里面，每次刷新只清这一层。 */
    const body = document.createElement("div");
    body.className = "vd-dash-body";
    box.append(body);

    /* 控件永远跟 view 对齐（复位、外部改过 view、批量删除之后都靠这一步）。
     * 三处「值没变就不写」是给输入法与下拉盒子留的：正在拼汉字时把同一个串再赋一遍
     * input.value，Chromium 一样会取消组合；正打开着的 select 被赋 value 会关掉它。 */
    let protoKey = null;
    const syncFilterUI = (list, items) => {
      const want = String(view.q || "");
      if (qEl.value !== want) qEl.value = want;
      const protos = Array.from(new Set(list.filter((r) => r).map((r) => r.protocol || "webdav")));
      const key = protos.join("|");
      if (key !== protoKey) { protoKey = key; fillProto(protos); }
      const pval = view.proto || "";
      if (fproto.value !== pval) fproto.value = pval;
      const sval = view.status || "";
      if (fstatus.value !== sval) fstatus.value = sval;
      if (chgBox.checked !== !!view.changedOnly) chgBox.checked = !!view.changedOnly;
      counter.textContent = this.t("dashShown")
        .replace("{n}", String(items.length)).replace("{N}", String(list.length));
      if (closeBtn) closeBtn.style.display = st.ui.showClose ? "" : "none";
    };

    /* 重入保护：paint 是 async，清空 body 之后还要等 getHistory 与那次批量 SQL。
     * 期间任何第二次触发（搜索去抖到点、手动刷新、行内操作回调里那句 paint）都会再清一次
     * 再等一次，两帧各自把行 append 上去——同一张表出现两份，勾选与列宽节点也各来一套。
     * 用序号认「最新的一帧」：旧帧在任何一个 await 之后发现自己被超过了就直接收工，
     * 谁最后起跑由谁画完。 */
    let paintSeq = 0;
    const paint = async () => {
      const seq = ++paintSeq;
      view = this.dashView();     // 每帧重新认一次：外部复位/换新 view 都跟得上
      body.textContent = "";
      st.boxes = [];
      const list = await this.getHistory();
      if (seq !== paintSeq) return;
      st.list = list;

      /* 改动指纹必须在建行之前拿到：筛选「只看有改动」、按改动排序、以及
       * 「本地已删除、线上仍在」的标记都要读它——渲染完再回填，这三件事都无从判断。
       * 一次批量 SQL（stampsFor 内部已按 200 个一组分块），不按行发查询。
       * stampKnown：查询是否真的拿到了东西。一条都没查到时宁可全部判「未知」，
       * 也不能把每一篇都标成「已删除」——那个标记连着批量清理远端的按钮，
       * 判错是要删用户线上内容的。 */
      const stampCur = new Map();
      let stampKnown = false;
      const okIds = Array.from(new Set(
        list.filter((r) => r && r.ok && r.docId).map((r) => String(r.docId))));
      if (okIds.length) {
        try {
          const m = await this.stampsFor(okIds);
          for (const [k, v] of m) stampCur.set(k, v);
          stampKnown = stampCur.size > 0;
        } catch (e) { /* 保持未知，看板照常渲染 */ }
      }
      /* 建行之前再认一次：批量 SQL 是这里最慢的一段，两帧同时走到这一步就会真的画出两张表 */
      if (seq !== paintSeq) return;
      // 取消发布过的记录线上已经没有目录，不该再被算成「文档已删除」
      const isDeleted = (rec) => !!(rec.ok && !rec.unpub && rec.docId
        && stampKnown && !stampCur.has(String(rec.docId)));
      const statusOf = (rec) => (rec.ok && rec.unpub) ? "unpub"
        : rec.ok ? (isDeleted(rec) ? "deleted" : "ok") : "fail";
      /* true=发布后又有改动 / false=无改动 / null=未知（没指纹、查询失败、已下架、失败记录） */
      const changedOf = (rec) => {
        if (!rec || !rec.ok || rec.unpub || !rec.stamp || !rec.docId) return null;
        if (!stampKnown) return null;
        const cur = stampCur.get(String(rec.docId));
        if (!cur) return null;
        return !this.constructor.stampEqual(rec.stamp, cur);
      };
      /* 先算出「这一屏要显示哪些行」，再刷工具条与计数——批量按钮的作用范围就是当前
       * 筛选结果，顺序反了它拿的就是上一屏的清单。筛选是纯内存匹配（记录最多 300 条，
       * 不必虚拟列表）。 */
      const q = String(view.q || "").trim().toLowerCase();
      const matches = (rec) => {
        if (view.proto && (rec.protocol || "webdav") !== view.proto) return false;
        if (view.status && statusOf(rec) !== view.status) return false;
        if (view.changedOnly && changedOf(rec) !== true) return false;
        if (q) {
          const hay = [rec.docName, rec.docId, rec.url, rec.err, rec.protocol]
            .filter(Boolean).join(" ").toLowerCase();
          if (hay.indexOf(q) < 0) return false;
        }
        return true;
      };
      st.items = list.filter((r) => r && matches(r))
        .map((rec) => ({ rec, status: statusOf(rec), changed: changedOf(rec) }));
      st.items.sort((a, b) => dashCompare(a, b, view.sort));
      {
        const visible = new Set(st.items.map((it) => rowKeyOf(it.rec)));
        for (const k of Array.from(sel())) if (!visible.has(k)) sel().delete(k);
      }
      st.delItems = st.items.filter((it) => !isLiveRec(it.rec));
      /* 页码夹回这一屏真实存在的页数（筛选变短、每页条数改大都靠这一步兜底），
       * 再把当前这一页要画的行交给建行循环与表头主复选框。 */
      st.pageInfo = dashPageSlice(st.items, view.page, view.pageSize);
      view.page = st.pageInfo.page;
      syncFilterUI(list, st.items);
      syncSel();

      if (!list.length) {
        const empty = document.createElement("div");
        empty.textContent = this.t("dashEmpty");
        empty.style.cssText = "padding:24px 0;color:var(--b3-theme-on-surface-light);text-align:center;";
        body.append(empty);
        return;
      }
      if (!st.items.length) {
        /* 有记录但全被筛掉了：留一句「没有符合筛选条件的记录（共 N 条）」，
         * 而不是突然一张只剩表头的空表——那看起来像记录被清空了。 */
        const none = document.createElement("div");
        none.className = "vd-dash-nomatch";
        none.textContent = this.t("dashNoMatch").replace("{N}", String(list.length));
        none.style.cssText = "padding:24px 0;color:var(--b3-theme-on-surface-light);text-align:center;";
        body.append(none);
        return;
      }

      const lastOk = list.find((x) => x && x.ok);
      if (lastOk) {
        const sum = document.createElement("div");
        sum.style.cssText = "padding:6px 8px 10px;color:var(--b3-theme-on-surface-light);font-size:12px;";
        sum.textContent = this.t("dashSummary")
          .replace("{n}", String(list.filter((x) => x && x.ok).length))
          .replace("{sent}", String(lastOk.sentFiles == null ? (lastOk.files || 0) : lastOk.sentFiles))
          .replace("{b}", this.fmtBytes(lastOk.sentBytes == null ? (lastOk.bytes || 0) : lastOk.sentBytes))
          .replace("{reused}", String(lastOk.reused || 0))
          .replace("{t}", this.fmtTime(lastOk.time));
        body.append(sum);
      }

      const grid = document.createElement("div");
      /* 七列宽全部来自 DASH_COLS（默认值 + 读者拖出来的记忆），只有详情列吃剩余空间：
       * 失败记录那一列放的是错误原文，窗口越宽越该给它。写成 minmax(记忆值,1fr)——
       * 窗口变宽它会跟着变宽，但永远不小于读者设的那个数。
       * 重排时整条 cssText 重写：属性顺序固定，回归里解析 grid-template-columns 才有唯一口径。
       * 模板里的宽度是 fitDashWidths 折出来的「放得下的宽度」，不是记忆值本身——
       * 记忆值（widths）永远保持读者拖出来的那个数，量到 0（还没挂进文档、或宿主没有排版引擎）
       * 时原样返回，所以 node 侧的结构断言口径不变。挂进 body 之后再补一次 applyCols：
       * 那时才量得到内容宽。 */
      st.grid = grid;
      applyCols();
      /* 表头主复选框挂在「时间」列表头最前面：那一格是整行里唯一天生空着的头部，
       * 而勾选框本来就长在时间列（见下面 c1），表头与行对得上，一眼知道它管的是勾选。
       * 它管的是当前这一页（tooltip 写清），跨页全选交给工具条。 */
      const thTime = th(this.t("colTime"), 0);
      thTime.prepend(st.masterBox);
      grid.append(
        thTime, th(this.t("colDoc"), 1), th(this.t("colProto"), 2),
        th(this.t("colStatus"), 3), th(this.t("colDetail"), 4, this.t("colDetailTip")), th(this.t("colChanged"), 5),
        th(this.t("colAction"), 6),
      );

      for (const it of st.pageInfo.rows) {
        const rec = it.rec;
        /* 勾选框挂时间列最前面：那是一行里最不挤的地方，而且七列宽度表（DASH_COLS）
         * 不必为它多开一列——拖宽、排序、记忆全是按七列算的，多一列就多一处要改的口径。
         * 线上还挂着的那行的框是 disabled 的（tooltip 说清为什么要先「取消发布」）：
         * 记录是看板找回那个远端目录的唯一线索，先把线索剪掉再去删线上内容，
         * 才是真的回不来。 */
        const rowKey = rowKeyOf(rec);
        const live = isLiveRec(rec);
        const selBox = document.createElement("input");
        selBox.type = "checkbox";
        selBox.className = "vd-dash-sel";
        selBox.vdKey = rowKey;   // syncSel 重画勾选态时靠它认行（桩件没有 dataset，属性够用）
        selBox.checked = sel().has(rowKey);
        /* cursor 写进 cssText 而不是 style.cursor：桩件的 style 是普通对象，属性式赋值
         * 不会进 cssText，断言就没了口径（表头把手那边同理）。 */
        selBox.style.cssText = "margin:0 8px 0 0;vertical-align:middle;cursor:"
          + (live ? "not-allowed;" : "pointer;");
        if (live) {
          selBox.disabled = true;
          selBox.title = this.t("dashSelLiveTip");
        } else {
          selBox.addEventListener("change", () => {
            if (selBox.checked) sel().add(rowKey); else sel().delete(rowKey);
            syncSel();
          });
        }
        st.boxes.push(selBox);
        const c1 = tdNowrap();
        c1.append(selBox, document.createTextNode(this.fmtTime(rec.time)));
        const c2 = td(); c2.textContent = rec.docName || rec.docId || "";
        if (rec.merge) {
          const tag = document.createElement("span");
          tag.textContent = this.t("dashMergeTag");
          tag.style.cssText = "color:var(--b3-theme-on-surface-light);font-size:11px;";
          c2.append(tag);
        }
        /* 发布次数：一行会被后续发布覆盖，「这篇是第一次发、还是第 20 次发」原来看不出来。
         * 只在发过两次以上时才挂角标——首次发布不该有噪音。 */
        if (Number(rec.count) > 1) {
          const cnt = document.createElement("span");
          cnt.className = "vd-dash-count-x";
          cnt.textContent = `×${rec.count}`;
          cnt.style.cssText = "margin-left:5px;color:var(--b3-theme-on-surface-light);font-size:11px;";
          cnt.title = this.t("dashCountTip")
            .replace("{n}", String(rec.count))
            .replace("{t}", this.fmtTime(Number(rec.firstTime) || rec.time));
          c2.append(cnt);
        }
        /* 「本地已删除、线上仍在」：文档在思源里已经找不到（或笔记本被关掉/加密），
         * 服务器上的目录却还挂着——这是取消发布没做、或文档是在别处删的留下的孤儿。
         * 用醒目的警示色标出来，并在操作列只留「取消发布」（重发一篇不存在的文档只会失败）。 */
        if (it.status === "deleted") {
          const goneEl = document.createElement("span");
          goneEl.className = "vd-dash-deleted";
          goneEl.textContent = this.t("deletedBadge");
          /* 用琥珀而不是红：这一行「发布本身是成功的」，红会跟失败徽标抢注意力。
           * 主题里没有 --b3-theme-warning（实测），沿用文档树角标的写法——
           * 优先卡片警示色，缺失时退回主题错误色，不会出现「图标跟正文同色」。 */
          goneEl.style.cssText = "margin-left:6px;padding:1px 7px;border-radius:9px;font-size:11px;"
            + "white-space:nowrap;font-weight:600;"
            + `color:var(--b3-card-warning-color, var(--b3-theme-error));`
            + "background:color-mix(in srgb, var(--b3-card-warning-color, var(--b3-theme-error)) 16%, transparent);";
          goneEl.title = this.t("deletedBadgeTip");
          c2.append(goneEl);
        }
        const c3 = tdNowrap(); c3.textContent = (rec.protocol || "webdav").toUpperCase();
        const c4 = tdNowrap();
        c4.append(this.statusPill(rec));
        const c5 = td();
        /* 详情列只有「查看上传路径」，没有「打开 / 复制」。本插件只负责把文件送到远端，
         * 那个地址能不能在浏览器里打开、是不是用户真正的站点地址，它并不知道——
         * 给一个「打开」按钮是在替服务器做它没答应过的承诺。换成一个「查看上传路径」：
         * 点一下在这条记录下面展开一整行路径原文（跨七列，user-select:all，
         * 点一次就全选上，Ctrl+C 即可），再点收起。不弹窗、不写别人的剪贴板。
         * 表体重画（筛选、排序、重发完）会重建这些行，展开状态随之收起——
         * 路径不是需要长期盯着的东西，为它开一份状态机不值得。
         * pathRow 是 grid 的直接子元素（grid-column:1/-1 横跨七列），所以它跟在
         * c1..c7 之后 append，视觉上就是这一行下面多出来的一行。 */
        let pathRow = null;
        if (rec.ok) {
          pathRow = document.createElement("div");
          pathRow.className = "vd-dash-path";
          /* 上面那七个单元格各自带 border-bottom，所以这条横跨整行的路径天然被那条线
           * 「压在下面」——不加底边的话，线和路径之间没有收口，看上去像路径属于下一行。
           * 补一条淡底 + 底边，把它闭合成一条明确属于上一行的带子。 */
          pathRow.style.cssText = "grid-column:1/-1;padding:6px 8px 8px 8px;font-size:12px;"
            + "color:var(--b3-theme-on-surface);word-break:break-all;line-height:1.5;"
            + "user-select:all;-webkit-user-select:all;"
            + "background:color-mix(in srgb, var(--b3-theme-on-surface) 5%, transparent);"
            + "border-bottom:1px solid var(--b3-theme-surface-lighter);";
          pathRow.textContent = (rec.url && displayUrl(rec.url)) || this.t("pathNone");
          pathRow.style.display = "none";
        }
        if (rec.ok) {
          // 主数字：本文自有文件（不含每次导出都附带的 stage/appearance 运行时），
          // 两个字段由每次发布写入。悬浮显示含运行时的完整上传数。
          // 前缀「本文」是写给用户的：这一格和看板上方的「实际传输」是两个口径，
          // 不写出来，用户只会认为数字对不上（用户截图里问的就是这个）。
          c5.textContent = `${this.t("dashOwnPrefix")} ${rec.docFiles || 0} ${this.t("files")}`
            + ` · ${this.fmtBytes(rec.docBytes || 0)}`;
          /* 加了前缀后这串更容易折行。word-break:break-all 会把「107.7 KB」从数字中间
           * 劈开（107.7 K / B），太难看；改成按词折、但保留 overflow-wrap:anywhere，
           * 真遇到超长 token 照样能断，不会横着溢出压到邻列去。 */
          c5.style.wordBreak = "normal";
          c5.style.overflowWrap = "anywhere";
          if (rec.files) {
            let tip = this.t("dashDocFilesTip")
              .replace("{n}", String(rec.files)).replace("{b}", this.fmtBytes(rec.bytes || 0));
            if (rec.reused) {
              tip += "\n" + this.t("dashReusedTip").replace("{n}", String(rec.reused));
            }
            /* 校验预算用尽的那几个文件：这一行是「成功」，但成功里有一部分没逐个确认过。
             * 只在悬浮说明里补一句，不改徽标颜色——状态列说的还是「传完了没有」。 */
            if (rec.unverified) {
              tip += "\n" + this.t("dashUnverifiedTip").replace("{n}", String(rec.unverified));
            }
            c5.title = tip;
          }
          let pathShown = false;
          const vb = btn(this.t("viewPath"), "b3-button b3-button--outline vd-dash-viewpath", () => {
            pathShown = !pathShown;
            pathRow.style.display = pathShown ? "block" : "none";
            vb.textContent = pathShown ? this.t("hidePath") : this.t("viewPath");
          });
          vb.title = (rec.url && displayUrl(rec.url)) || this.t("pathNone");
          c5.append(document.createTextNode(" "), vb);
        } else {
          c5.textContent = rec.err || "";
          c5.style.color = "var(--b3-theme-error)";
        }
        // 改动列：徽章 + 检测按钮
        const c6 = td();
        const badge = document.createElement("span");
        /* 不给徽标加 white-space:nowrap：这一列是会折行的列（不量内容地板），
         * 徽标一旦不许折行就会横着溢出格子、压到「操作」列上去（英文 "Content changed"
         * 在 94px 的列里实测溢出 17px）。让它自己在这列里折成两行，比溢出好。 */
        badge.style.cssText = "font-size:12px;";
        const setBadge = (text, color, tip) => {
          badge.textContent = text;
          badge.style.color = color || "var(--b3-theme-on-surface-light)";
          if (tip) badge.title = tip;
        };
        if (!rec.ok) setBadge("—");
        else if (it.changed === true) setBadge(this.t("changed"), "var(--b3-theme-error)", this.t("changedTipOn"));
        else if (it.changed === false) setBadge(this.t("unchanged"), "var(--b3-theme-primary)", this.t("changedTipOff"));
        else if (!rec.stamp) setBadge(this.t("changedUnknown"), "var(--b3-theme-on-surface-light)", this.t("changedTipUnknown"));
        else setBadge(this.t("changedUnknown"), "var(--b3-theme-on-surface-light)");
        c6.append(badge);
        if (rec.ok && rec.stamp) {
          c6.append(btn(this.t("checkChanged"), "b3-button b3-button--outline", async () => {
            setBadge(this.t("checking"));
            const cur = await this.sourceStamp(rec.docId);
            if (this.constructor.stampEqual(rec.stamp, cur)) {
              setBadge(this.t("unchanged"), "var(--b3-theme-primary)", this.t("changedTipOff"));
            } else if (!cur) {
              setBadge(this.t("changedUnknown"), "var(--b3-theme-on-surface-light)");
            } else {
              setBadge(this.t("changed"), "var(--b3-theme-error)", this.t("changedTipOn"));
            }
          }));
        }
        // 操作列：按这条记录当初用的协议重发（失败记录就是「重试上次失败」）
        /* 这一列用不折行的格子：按钮是 inline-block，允许折行的话英文字典那四个
         * （Re-upload / Dry run / Delete remote files / Delete record）会排成三行，
         * 行高一撑高，整张表就开始上下滚——现场截图里「操作列挤成两行」就是它。
         * nowrap 之后这一格的 min-content ＝「四个按钮一行排完」的宽度，
         * minmax(auto,…) 会替它把列撑开；再放不下就是整表横向滚动，不是把按钮压回列里。 */
        const c7 = tdNowrap();
        if (rec.docId) {
          const targetProto = (rec.protocol || "").trim();
          // 本地已经没有这篇文档了：重发只会以内核「文档不存在」收场，只留「取消发布」收拾远端
          if (it.status !== "deleted") {
            const b = btn(rec.ok ? this.t("rePublish") : this.t("retryFailed"), "b3-button", () => {
              if (st.ui.closeOnPublish) st.ui.close();
              const p = this.publish(rec.docId, !!rec.merge,
                targetProto ? { proto: targetProto } : undefined);
              if (p && typeof p.then === "function") p.then(() => { try { paint(); } catch (e) {} }).catch(() => {});
            });
            b.title = this.t("republishTip").replace("{p}", (targetProto || this.t("currentProto")).toUpperCase());
            c7.append(b);
            if (rec.ok) {
              const d = btn(this.t("dryRun"), "b3-button b3-button--outline", () => {
                const p = this.publish(rec.docId, !!rec.merge,
                  Object.assign({ dryRun: true }, targetProto ? { proto: targetProto } : {}));
                if (p && typeof p.then === "function") p.then(() => { try { paint(); } catch (e) {} }).catch(() => {});
              });
              d.title = this.t("dryRunTip");
              c7.append(d);
            }
          }
          if (canUnpubRec(rec)) {
            const u = btn(this.t("unpublish"), "b3-button b3-button--outline", () => {
              const p = this.unpublish(rec);
              if (p && typeof p.then === "function") p.then(() => { try { paint(); } catch (e) {} }).catch(() => {});
            });
            u.title = this.t("unpublishTip");
            c7.append(u);
          }
        }
        /* 「删除记录」只给非活着的行（含没有 docId 的失败记录：那种行既不能重发也不能
         * 取消发布，不给删除按钮就永远留在看板上）。线上还挂着的那行不放按钮——
         * 要删它得先「取消发布」，而那正是这一列紧挨着的上一个按钮；挡在勾选框的
         * tooltip 里已经说清了缘由，再堆一个点不动的灰按钮只会把操作列挤成三行。 */
        if (!live) {
          const x = btn(this.t("dashDelOne"), "b3-button b3-button--outline", async () => {
            if (!window.confirm(this.t("confirmDelOne"))) return;
            const res = await this.deleteHistoryRows([rowKey]);
            sel().delete(rowKey);
            showMessage(res.removed
              ? this.t("delDone").replace("{n}", String(res.removed))
              : this.t("delNothing"), 4000, res.removed ? "info" : "warn");
            paint();
          });
          x.title = this.t("dashDelOneTip");
          c7.append(x);
        }
        grid.append(c1, c2, c3, c4, c5, c6, c7);
        if (pathRow) grid.append(pathRow);
      }
      body.append(grid);
      /* 翻页条（右下角）：它只决定「这一屏画多少行」。筛选、排序、勾选与三个批量按钮
       * 的作用范围仍是整个筛选结果（工具条「全选」的 tooltip 同口径），所以翻到第 3 页
       * 不会把前两页的勾选洗掉，也不会让「删除所选 N 条」偷偷少删 N 里的谁。
       * 每页条数是习惯，落盘（跟列宽、排序记在同一个浏览器里，不随笔记同步）；
       * 页码是这一次浏览的临时意图，不落盘。
       * 只有一页时 prev/next 照常画出来、置灰：文案位置不随内容条数跳动，
       * 比「翻到最后一页按钮突然消失」好读，也不会让这一行的高度变来变去。 */
      const pager = document.createElement("div");
      pager.className = "vd-dash-pager";
      pager.style.cssText = "display:flex;gap:8px;align-items:center;justify-content:flex-end;"
        + "flex-wrap:wrap;padding:10px 2px 2px;color:var(--b3-theme-on-surface-light);font-size:12px;";
      const pInfo = document.createElement("span");
      pInfo.className = "vd-dash-page-info";
      pInfo.textContent = this.t("dashPageInfo").replace("{a}", String(st.pageInfo.from))
        .replace("{b}", String(st.pageInfo.to)).replace("{N}", String(st.items.length));
      const goPage = (p) => {
        const pages = dashPageCount(st.items.length, view.pageSize);
        const next = Math.min(Math.max(1, p), pages);
        if (next === view.page) return;
        view.page = next;
        paint();
      };
      const pPrev = btn(this.t("dashPagePrev"), "b3-button b3-button--outline vd-dash-page-prev",
        () => goPage(view.page - 1));
      pPrev.disabled = st.pageInfo.page <= 1;
      const pNum = document.createElement("span");
      pNum.className = "vd-dash-page-num";
      pNum.textContent = this.t("dashPageOf").replace("{p}", String(st.pageInfo.page))
        .replace("{n}", String(st.pageInfo.pages));
      const pNext = btn(this.t("dashPageNext"), "b3-button b3-button--outline vd-dash-page-next",
        () => goPage(view.page + 1));
      pNext.disabled = st.pageInfo.page >= st.pageInfo.pages;
      const pSizeLab = document.createElement("span");
      pSizeLab.className = "vd-dash-page-size-label";
      pSizeLab.textContent = this.t("dashPageSizeLabel");
      const pSize = mkSel("vd-dash-page-size", DASH_PAGE_SIZES.map((n) => ({
        v: String(n), t: n ? String(n) : this.t("dashPageAll"),
      })), (v) => {
        view.pageSize = parseDashPageSize(v);
        /* 每页变多也可能让当前页码越界（第 5 页 / 每页 10 → 每页 100 只剩 1 页）：
         * 回到第 1 页比让 dashPageSlice 悄悄夹一下更好读——读者刚动的就是这个下拉。 */
        view.page = 1;
        lsWrite(DASH_PAGE_KEY, String(view.pageSize));
      });
      /* option 建完才认值（真 DOM 的规则，mkSel 里那句 s.value="" 是它自己的初始口径），
       * 所以这里必须显式对一次表。 */
      pSize.value = String(view.pageSize);
      pSize.title = this.t("dashPageSizeTip");
      pager.title = this.t("dashPageTip");
      pager.append(pInfo, pPrev, pNum, pNext, pSizeLab, pSize);
      body.append(pager);
      /* 挂进文档以后才有内容宽：这一步把「默认值 / 记忆值」折成「这一屏放得下的宽度」，
       * 操作列因此不会再被弹窗右缘裁掉（现场截图的头号故障）。
       * 先量一次内容下限（六档视口 × 两种字典都是在 Chromium 里验的）再排：
       * 这一次重画里后续每次 applyCols（拖把手、双击复位）都复用这个结果。 */
      st.colNeeds = dashColNeeds(grid);
      applyCols();
    };

    /* 骨架挂在 box 上：认 box 不认 ui。发布完的刷新、切页签回来、外部再调一次
     * renderDash（换了新的 ui 对象）都走「换 ui + 重画表体」这条路，
     * 筛选控件那几个节点自始至终是同一批。 */
    box.__vdSkel = {
      paint,
      // 传了才换：骨架上那一份 ui 是行按钮「发布前关掉弹窗」的依据，宁可用旧的也不能没有
      useUi(next) { if (next) st.ui = next; },
    };
    await paint();
  }
}

module.exports = WebDAVPublishPlugin;
module.exports.default = WebDAVPublishPlugin;
/* 供 node 端回归测试直接引用内部实现（运行时不产生任何副作用） */
module.exports._internals = {
  FtpSession, SshSession, parseList, normalizeKey, walkRemoteFiles,
  /* SSH 记录协议的两个内部口径：分帧块长与「NEWKEYS 后序号取什么值」。
   * 导出来是因为本机造不出一台不支持严格 KEX 的 OpenSSH，非严格那条分岔
   * 只能在纯函数上钉（run-sshframing.js）。 */
  SSH_BLOCK, seqAfterNewKeys,
  makeUploader, WebdavUploader, FtpUploader, SftpUploader, LocalUploader,
  injectToc, TOC_PAYLOAD, TOC_MARKER,
  // 传输容错内部实现（重试/并发），供 node 端回归直接断言
  runPool, withRetry, isTransientError, isConnLostError, concurrencyFor,
  /* 路径比较键与 FTP 的两条链路口径：
   *   · fsKey —— FTP/SFTP/本地目录的「不折叠大小写、不解码」比较键（与 normalizeKey
   *     的分工是有意为之，回归要把两边的差别钉住，不然哪天顺手统一就静默出错了）；
   *   · pasvHostFor / isSiteLocalV4 —— NAT 后面那台 FTP 报的内网地址能不能照用；
   *   · retryAfterMsOf / RETRY_AFTER_MAX —— 服务端限流提示采信到多少毫秒。
   * gbkUnmappable：GBK 会话下会被写成 "?" 的字符（不同名字撞成一个远端文件的根因）。 */
  fsKey, pasvHostFor, isSiteLocalV4, retryAfterMsOf, RETRY_AFTER_MAX, gbkUnmappable,
  /* 各处等待上限（对象本身导出：回归把它压到毫秒级，才能真正验证「卡死路径会放手」
   * 而不是等 sixty 秒再断言。改完之后回归负责把它调回默认值。） */
  IO_TIMEOUT,
  /* 内核读文件的四条路：回归用「永不回包的 XHR / 永不 resolve 的 fetch」把超时这一环
   * 变成可断言的事实（挂上没有 timeout 的 ontimeout 从来不算防护）。 */
  xhrGetFileBytes, fetchGetFileBytes, readExportFile,
  // 路径加固与同名归属内部实现，供 node 端回归直接断言
  sanitizeName, clampSeg, safeSeg, prefixSegsOf, rootSegsOf, localBaseOf,
  // 资产名可存性（WebDAV/IIS）内部实现，供 node 端回归直接断言
  unsafeSegReason, safeHttpName, safeHttpRel, planSafeRenames, rewriteAssetRefs, HTTP_BAD_MAP,
  OWNER_PREFIX, OWNER_RE, ownerName, hasForeignOwner, clampInt, safeRootDisplay,
  // 发布页插值转义（文本 / 属性 / JS 字符串），供 node 端回归直接断言
  htmlAttrEsc, htmlTextEsc, jsStrEsc, numVal,
  /* 入口页拼装：_internals 里开这一个口子，回归才能拿一个「带 </title><script> 的
   * 标题」直接跑真模板。它内部只读 window.siyuan.config 与 DOM，不碰任何凭据，
   * 也不写盘——node 桩里跑出来的字符串和真机上生成的完全一样。 */
  buildIndexHtml: (name, content, version) => Vendored.buildIndexHtml(name, content, version),
  // nginx / IIS 的 WebDAV 差异相关纯函数，供 node 端回归直接断言
  parseMultistatus, absHref, davOrigin, b64ByteLen, mkcolUrl,
  // 版本号：run-settings.js 断言它等于 plugin.json 的 version（漏改会红）
  PLUGIN_VERSION,
  // 看板列宽（默认/范围/记忆解析），供 node 端回归直接断言
  DASH_COLS, DASH_COLS_KEY, DASH_FLEX_COL, DASH_MEASURE_ROWS,
  parseDashColWidths, dashColTemplate, dashColNeeds, dashFitCols,
  fitDashWidths,
  // 看板排序与筛选（纯函数），供 node 端回归直接断言
  DASH_SORT_KEYS, DASH_STATUS_ORDER, DASH_CHANGED_ORDER, DASH_VIEW_KEY,
  dashSortValue, dashCompare,
  /* 看板翻页（纯函数 + 记忆口径）：每页条数是「习惯」要落盘，页码是「这次翻到哪儿」
   * 不落盘；越界夹取（筛选变短、每页变大）必须回到真实存在的页数。 */
  DASH_PAGE_SIZES, DASH_PAGE_SIZE_DEFAULT, DASH_PAGE_KEY,
  parseDashPageSize, dashPageCount, dashPageSlice,
  // 看板删除记录的两个口径（行标识 / 「线上还挂着」），供 node 端回归直接断言
  rowKeyOf, isLiveRec,
  /* 记录清单与操作按钮的三个纯函数口径：封顶裁剪、能不能「删除远端文件」、
   * 日志地址去凭据。都导出给回归钉住——它们各自管着「线索会不会被剪掉」
   * 「残局还有没有人能收拾」「密码会不会跟着日志漏出去」。 */
  trimHistory, HISTORY_SOFT_CAP, HISTORY_HARD_CAP, canUnpubRec, redactUrl, normServer, normPrefix,
  errForLog, stripUserInfo, displayUrl, safeRootDisplay,
  /* MultiStatus 的 XML 实体还原（run-pathnorm 用它钉住「&amp; 必须还原成 &」：
   * 不还原的话这张清单里的名字和 keyOf(segs) 永远比不中，文件会被当成缺失并被清掉）。
   * parseMultistatus 本身在上面 nginx/IIS 那一组已经导出过，这里不重复列。 */
  xmlUnescape,
  /* 逐请求日志开关：回归要能把 DEBUG 显式打开，验证「成功 PUT 那行确实受它管」
   * 而不是只断言默认关的时候没输出（打开后必须有，才算证明开关名副其实）。 */
  setDebug,
  // 设置页格式提示（纯函数），供 node 端回归直接断言
  serverFormatRule, serverFormatOk, fieldHintFor,
  // 地址 + 端口 -> host/port 的唯一口径（FTP/SFTP，含 IPv6），供 node 端回归直接断言
  DEFAULT_PORTS, normPort, keepPort, readAddrHostPort, hostPortOf, CRED_FIELDS,
  // 进度条（含取消按钮）与发布结果卡片：单例，回归可直接断言其状态机
  Progress, ResultCard,
  // 取消后的提示口径（纯函数：远端残缺程度 × 文件是否已传完）
  cancelToast,
};
