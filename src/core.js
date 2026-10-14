/* SiYuan Netglimmer Publish - no-build single-file plugin
 * 右键文档 → 导出 HTML(SiYuan) 到工作空间 temp → 逐文件上传到 WebDAV。
 * 设置入口：原生插件设置面板（设置 → 已加载插件 → Netglimmer 发布）。
 * 依赖内核 API（v3.8.x 实测路由）：
 *   POST /api/export/exportHTML   {id, pdf, keepFold, merge} -> {name, folder, content}
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

const DEFAULT_SETTINGS = {
  protocol: "webdav",  // webdav | ftp | sftp | local（当前生效的传输协议）
  server: "",          // 兼容字段：等于 profiles[protocol].server
  username: "",
  password: "",
  prefix: "",
  cleanOld: true,      // 发布前清空远端旧目录
  addToc: true,        // index.html 文末注入侧边大纲（add_toc.py 等效）
  publishMerge: true,  // 一键发布时是否「含子文档」（合并导出整个子树），右键菜单只留一个按钮由此开关控制
  incremental: true,   // 增量发布：共享运行时（stage/appearance）远端已存在且大小相同则跳过重传
  knownHosts: {},      // SFTP TOFU：host:port -> SHA256 指纹
  debug: false,        // 打印每一次远端请求（一次完整发布有上千行，只在排查问题时开）
  retryTries: 3,       // 单个操作瞬时失败最多重试几次（1-6）
  concurrency: 0,      // 上传并发度：0 = 按协议自动（webdav 6 / sftp 4 / local 4 / ftp 1）
  maxFileMB: 64,       // 单个文件超过该值直接中止（0 = 不限制），避免超大资产把内存耗尽
  // 每种协议各自保存一份服务器/账号/子目录配置，切换协议互不覆盖；
  // 导出时只使用 protocol 指定的那一种。server/username/password/prefix
  // 顶层字段镜像当前生效协议，供旧记录与外部读取兼容。
  profiles: {
    webdav: { server: "", username: "", password: "", prefix: "" },
    ftp: { server: "", username: "", password: "", prefix: "" },
    sftp: { server: "", username: "", password: "", prefix: "" },
    local: { server: "", username: "", password: "", prefix: "" },
  },
};

const PROTO_KEYS = ["webdav", "ftp", "sftp", "local"];
const CRED_FIELDS = ["server", "username", "password", "prefix"];

/* 归一化单条服务器地址输入：去首尾空白；WebDAV 去尾部斜杠。 */
function normServer(v, proto) {
  let s = String(v || "").trim();
  if (proto !== "webdav") return s.replace(/\/+$/, "");
  return s;
}

/* ---------------- i18n ---------------- */

const I18N = {
  zh_CN: {
    publish: "Netglimmer 一键发布",
    publishMerge: "发布（含子文档）",
    publishMergeSetting: "一键发布时包含子文档",
    publishMergeDesc: "开启后，右键「Netglimmer 一键发布」会把所选文档连同其子文档合并为一篇导出发布（等同手动导出的「含子文档」）；关闭则只发布当前文档本身。",
    incremental: "增量发布（跳过重复运行时）",
    incrementalDesc: "开启后，重新发布同一文档时，思源运行时（stage/ 与 appearance/ 内约 570 个所有文档共用的文件）若已在服务器上且大小相同则跳过重传，只上传本文自有内容与有变化的文件，大幅加快二次发布。关闭则每次全量上传。",
    dashReusedTip: "其中 {n} 个运行时文件已在服务器、本次跳过重传",
    checkingRemote: "正在检查服务器上已有的文件…",
    settingsTitle: "Netglimmer 发布设置",
    server: "服务器地址",
    serverDescAny: "WebDAV 填根 URL（如 https://example.com/dav）；FTP/SFTP 填主机地址（可带端口，如 192.168.1.10:21）；本地填导出目录的绝对路径（如 D:\\www\\publish 或 /var/www/html）",
    username: "用户名",
    password: "密码",
    passwordHint: "明文保存在本机插件配置（工作空间 data/storage/petal/…/settings.json）里；请勿把工作空间或该文件原样分享/同步出去，分享配置前先删掉 password 字段。",
    prefix: "远端子目录",
    prefixDesc: "可选，例如 publish；所有文章发布到该目录下",
    cleanOld: "发布前清空远端旧目录",
    addToc: "发布页面注入侧边大纲",
    addTocDesc: "在 index.html 末尾追加右侧悬浮大纲（滚动高亮、明暗主题自适应），等效于手动运行 add_toc.py",
    save: "保存设置",
    saved: "设置已保存",
    test: "测试连接",
    testing: "正在测试…",
    testNeedFields: "请先填写服务器地址和用户名",
    testReachable: "服务可达（HTTP {s}）",
    testAuthFail: "认证失败（HTTP {s}），请检查用户名/密码",
    testNotFound: "目录不存在（HTTP {s}），发布时将自动创建",
    testUnreachable: "无法连接：{e}",
    testWriteOk: "，目录创建与上传正常",
    testWriteFail: "，但无法写入：{e}（IIS 请检查 WebDAV 请求筛选与写入规则）",
    testNotWebdav: "该地址返回的是普通网页而非 WebDAV 应答，这不是 WebDAV 端点——请核对 WebDAV 服务的路径与端口",
    testVerifyFail: "，但 PUT 后读回校验失败（服务器可能并未真正保存文件，不是真实 WebDAV 服务）",
    needServer: "请先在插件设置中配置 WebDAV 服务器",
    protocol: "传输协议",
    protocolDesc: "WebDAV / FTP / SFTP / 本地（FTP、SFTP、本地需桌面版思源）；每种协议各自保存服务器/账号/子目录配置，切换时互不覆盖，发布只使用当前选中的协议",
    localProto: "本地目录",
    needLocalPath: "请先在插件设置中填写本地导出路径",
    testLocalOk: "本地路径可用：{p}",
    testLoggedIn: "连接并登录成功",
    testFp: "，主机密钥指纹 {fp}（首次连接已记录，指纹变化会拒绝连接）",
    needServerCommon: "请先在插件设置中配置服务器地址",
    exporting: "正在导出…",
    generating: "正在生成 index.html…",
    cleaning: "正在清理远端旧目录…",
    makingDirs: "正在创建远端目录…",
    uploading: "正在上传",
    probing: "正在做传输自检…",
    verifying: "正在读回校验…",
    verifyFail: "读回校验失败",
    verifyMismatch: "远端文件大小与本地不一致",
    verifyMissing: "远端缺失",
    verifyHintUpload: "——远端为 0 字节而本地非 0：上传通道异常，请重启思源后重试",
    verifyHintLocal: "——本地导出文件本身为 0 字节：请先手动「导出 HTML(SiYuan)」确认导出是否正常",
    failed: "发布失败",
    busyNow: "正在发布中，请等待当前任务完成",
    dashboard: "发布看板",
    settingsTab: "发布设置",
    dashUnavailable: "当前版本不支持看板弹窗",
    dashTitle: "发布记录",
    dashEmpty: "暂无发布记录",
    colTime: "时间",
    colDoc: "文档",
    colProto: "协议",
    colStatus: "结果",
    colDetail: "详情",
    colAction: "操作",
    stOk: "成功",
    stFail: "失败",
    files: "文件",
    dashDocFilesTip: "含思源运行时（stage/appearance）共上传 {n} 个文件 · {b}",
    rePublish: "重新发布",
    openLink: "打开",
    clearHistory: "清空记录",
    dashRefresh: "刷新",
    confirmClear: "确定清空全部发布记录？",
    changed: "内容有改动",
    unchanged: "无改动",
    changedUnknown: "未比对",
    checkChanged: "检测",
    checking: "比对中…",
    changedTipOn: "自该次发布后源文档有更新，建议重新发布",
    changedTipOff: "源文档自该次发布后无改动",
    changedTipUnknown: "该记录缺少改动指纹（旧记录），无法比对",
    colChanged: "改动",
    dashClose: "关闭",
    dashMergeTag: " · 含子文档",
    publishedBadgeTip: "该文档已通过 Netglimmer 发布（点击打开已发布页面）",
    changedBadgeTip: "已发布过，但发布后正文又有改动（点击打开线上版本；右键可重新发布）",
    publishChanged: "Netglimmer 一键发布（检测到改动，建议重新发布）",
    publishSummaryOk: "已发布：{url}｜本次上传 {sent} 个文件 / {sentB}，复用服务器上 {reused} 个运行时文件，共 {dur} 秒",
    uploadFailAt: "部分文件上传失败（已重试仍不行）",
    uploadFailMore: "另有 {n} 个文件未成功",
    retryFailed: "重试发布",
    republishTip: "按该记录当初使用的协议 {p} 重新发布（用它在设置里保存的服务器配置）",
    currentProto: "当前协议",
    dashSummary: "成功发布 {n} 次｜最近一次（{t}）实际上传 {sent} 个文件 / {b}，复用服务器上已有的运行时文件 {reused} 个",
    queuedNow: "已有发布任务在进行，本次已排队，完成后自动开始",
    dryRun: "试算",
    dryRunTip: "只统计「会传哪些文件、共多少字节、能复用多少」，不建目录、不删除、不上传（远端零写入）",
    dryRunResult: "试算「{d}」：待上传 {n} 个文件 / {b}，可复用服务器上 {re} 个运行时文件。本次未对远端做任何修改。",
    fileTooBig: "文件 {n} 大小为 {b}，超过单文件上限 {m}（可在设置里调大或设为 0 不限制）",
    ownerRelocated: "检测到同名文档已占用原目录，本次已发布到独立目录 {d}，避免互相覆盖",
    oldRootCleaned: "已清理 {n} 个改名/迁移遗留的旧发布目录",
    remotePartialWarn: "远端目录可能不完整（已建目录或部分上传后才失败）：{d}。可在看板「试算」后重新发布，或「取消发布」清空该目录。",
    stUnpub: "已取消发布",
    unpublish: "取消发布",
    unpublishTip: "删除远端上这篇文档的发布目录（本地文档与历史保留，记录标记为已取消发布）",
    unpublishConfirm: "确定删除远端目录 {d}（协议 {p}）？该目录下的已发布内容会全部移除，本地文档不受影响。",
    unpublishing: "正在删除远端发布目录…",
    unpublished: "已取消发布：{d}",
    unpublishFail: "取消发布失败",
    cannotLocateRemote: "该记录缺少远端目录信息（旧版本产生），无法自动清理，请手动删除远端目录",
    needServerForProto: "请先在插件设置中配置 {p} 的服务器地址/账号",
    copyLink: "复制",
    copied: "地址已复制",
    copyFail: "复制失败，请手动选中地址复制",
    retryTries: "单文件重试次数",
    retryTriesDesc: "上传/删除遇到连接中断、超时等瞬时错误时的重试上限（1–6，默认 3）。设为 1 即不重试。",
    concurrency: "并发上传数",
    concurrencyDesc: "0 = 按协议自动选择（WebDAV 6、SFTP/本地 4、FTP 1）；手动设为 1–16 可覆盖。服务器较弱或带宽较小时调低更快。",
    maxFileMB: "单文件大小上限 (MB)",
    maxFileMBDesc: "超过该大小的文件跳过并报错，避免整文件读入内存导致卡顿（默认 64，0 = 不限制）。",
    debug: "输出调试日志",
    debugDesc: "在浏览器控制台输出每次请求/上传的详细信息，用于排查发布失败；日常使用建议关闭。",
    knownHosts: "已知主机密钥 (SFTP)",
    knownHostsDesc: "首次连接的 SSH 服务器指纹会被记住，指纹变化（换服务器/中间人）时会拒绝连接。换机后可在这里清除记录重新接受。",
    knownHostsCount: "已记录 {n} 个主机密钥",
    knownHostsNone: "暂无已记录的主机密钥",
    clearHosts: "清除全部",
    clearHostsConfirm: "确定清除全部已知主机密钥？下次连接各 SFTP 服务器时会重新记录指纹。",
    clearHostsDone: "已知主机密钥已清除，下次连接将重新记录",
  },
  en_US: {
    publish: "Netglimmer One-Click Publish",
    publishMerge: "Publish (with sub-docs)",
    publishMergeSetting: "Include sub-docs when publishing",
    publishMergeDesc: "When on, the right-click “Netglimmer One-Click Publish” merges the selected document together with its sub-documents into a single export (same as the manual “with sub-docs” export). When off, only the document itself is published.",
    incremental: "Incremental publish (skip duplicate runtime)",
    incrementalDesc: "When on, re-publishing a document skips re-uploading the SiYuan runtime (the ~570 files shared by every document under stage/ and appearance/) if they already exist on the server with the same size — only this document's own content and any changed files are uploaded, making repeat publishes much faster. When off, every publish uploads all files.",
    dashReusedTip: "{n} runtime files already on the server were skipped this time",
    checkingRemote: "Checking files already on the server…",
    settingsTitle: "Netglimmer Publish Settings",
    server: "Server URL",
    serverDescAny: "WebDAV: root URL (e.g. https://example.com/dav); FTP/SFTP: host, optionally with port (e.g. 192.168.1.10:21); Local: absolute export dir (e.g. D:\\www\\publish or /var/www/html)",
    username: "Username",
    password: "Password",
    passwordHint: "Stored in plain text in this machine's plugin config (workspace data/storage/petal/…/settings.json). Never share or sync the workspace as-is; delete the password field before sharing the config.",
    prefix: "Remote subdirectory",
    prefixDesc: "Optional, e.g. publish",
    cleanOld: "Clean remote folder before publish",
    addToc: "Inject sidebar outline into published pages",
    addTocDesc: "Append the floating right-side outline (scroll-spy, light/dark adaptive) to index.html — same as running add_toc.py manually",
    save: "Save Settings",
    saved: "Settings saved",
    test: "Test Connection",
    testing: "Testing...",
    testNeedFields: "Please fill in server URL and username first",
    testReachable: "Server reachable (HTTP {s})",
    testAuthFail: "Authentication failed (HTTP {s})",
    testNotFound: "Folder not found (HTTP {s}), will be created on publish",
    testUnreachable: "Cannot connect: {e}",
    testWriteOk: ", create & upload OK",
    testWriteFail: ", but write failed: {e}",
    testNotWebdav: "The URL returned a normal web page instead of a WebDAV response - not a WebDAV endpoint, check path/port",
    testVerifyFail: ", but read-back verification failed (server did not actually store the file)",
    needServer: "Please configure the WebDAV server in plugin settings first",
    protocol: "Protocol",
    protocolDesc: "WebDAV / FTP / SFTP / Local (FTP, SFTP and Local require the desktop app). Each protocol keeps its own server / account / subfolder config and switching never overwrites them; publishing always uses the selected protocol only",
    localProto: "Local folder",
    needLocalPath: "Please set a local export path in plugin settings first",
    testLocalOk: "Local path is writable: {p}",
    testLoggedIn: "Connected and logged in",
    testFp: ", host key fingerprint {fp} (recorded on first contact; changes are refused)",
    needServerCommon: "Please configure the server in plugin settings first",
    exporting: "Exporting...",
    generating: "Generating index.html...",
    cleaning: "Cleaning remote folder...",
    makingDirs: "Creating remote folders...",
    uploading: "Uploading",
    probing: "Running transport self-check...",
    verifying: "Verifying...",
    verifyFail: "Read-back verification failed",
    verifyMismatch: "Remote file sizes do not match local",
    verifyMissing: "missing remotely",
    verifyHintUpload: " - remote is 0 byte while local is not: upload channel broken, restart SiYuan and retry",
    verifyHintLocal: " - local export files themselves are 0 bytes: try manual Export HTML(SiYuan) first to confirm export works",
    failed: "Publish failed",
    busyNow: "A publish is already running, please wait",
    dashboard: "Publish Dashboard",
    settingsTab: "Settings",
    dashUnavailable: "Dialog API unavailable in this version",
    dashTitle: "Publish History",
    dashEmpty: "No publish records yet",
    colTime: "Time",
    colDoc: "Document",
    colProto: "Protocol",
    colStatus: "Result",
    colDetail: "Details",
    colAction: "Actions",
    stOk: "OK",
    stFail: "Failed",
    files: "files",
    dashDocFilesTip: "{n} files · {b} uploaded in total, including the SiYuan runtime (stage/appearance)",
    rePublish: "Republish",
    openLink: "Open",
    clearHistory: "Clear records",
    dashRefresh: "Refresh",
    confirmClear: "Clear all publish records?",
    changed: "Content changed",
    unchanged: "No change",
    changedUnknown: "Not compared",
    checkChanged: "Check",
    checking: "Comparing...",
    changedTipOn: "The source document changed since this publish; consider republishing",
    changedTipOff: "Source unchanged since this publish",
    changedTipUnknown: "This record has no fingerprint (older record); cannot compare",
    colChanged: "Change",
    dashClose: "Close",
    dashMergeTag: " · with sub-docs",
    publishedBadgeTip: "This document has been published via Netglimmer (click to open the published page)",
    changedBadgeTip: "Published, but the document changed afterwards (click to open the live version; right-click to republish)",
    publishChanged: "Netglimmer One-Click Publish (changes detected — republish)",
    publishSummaryOk: "Published: {url} | uploaded {sent} files / {sentB}, reused {reused} runtime files already on the server, {dur}s total",
    uploadFailAt: "Some files failed to upload (retried)",
    uploadFailMore: "{n} more files also failed",
    retryFailed: "Retry publish",
    republishTip: "Republish over the protocol this record used ({p}), with the server settings saved for it",
    currentProto: "current protocol",
    dashSummary: "{n} successful publishes | latest ({t}) uploaded {sent} files / {b}, reused {reused} runtime files already on the server",
    queuedNow: "A publish is already running; this one was queued and will start automatically",
    dryRun: "Dry run",
    dryRunTip: "Only counts which files would be uploaded, how many bytes and how many can be reused — no mkdir, no delete, no upload (remote untouched)",
    dryRunResult: "Dry run for \"{d}\": {n} files / {b} to upload, {re} runtime files reusable on the server. Nothing was modified remotely.",
    fileTooBig: "File {n} is {b}, above the {m} per-file limit (raise it in settings, or set 0 for no limit)",
    ownerRelocated: "Another document with the same name already owns the original folder; this publish went to its own folder {d} so nothing was overwritten",
    oldRootCleaned: "Cleaned up {n} leftover folder(s) from renamed or moved documents",
    remotePartialWarn: "The remote folder may be incomplete (directories were created or partially uploaded before the failure): {d}. Run \"Dry run\" then republish from the dashboard, or use \"Unpublish\" to clear it.",
    stUnpub: "Unpublished",
    unpublish: "Unpublish",
    unpublishTip: "Delete this document's published folder on the server (the local document and the history record are kept)",
    unpublishConfirm: "Delete the remote folder {d} (protocol {p})? All published content inside it will be removed; the local document is untouched.",
    unpublishing: "Removing the remote published folder…",
    unpublished: "Unpublished: {d}",
    unpublishFail: "Unpublish failed",
    cannotLocateRemote: "This record has no remote folder information (created by an older version), so it cannot be cleaned automatically — please delete it manually",
    needServerForProto: "Please configure the server/address for {p} in the plugin settings first",
    copyLink: "Copy",
    copied: "Link copied",
    copyFail: "Copy failed — please copy the address manually",
    retryTries: "Per-file retry limit",
    retryTriesDesc: "How many times a file upload/delete is retried on transient errors such as dropped connections or timeouts (1–6, default 3). Set 1 to disable retries.",
    concurrency: "Upload concurrency",
    concurrencyDesc: "0 = automatic per protocol (WebDAV 6, SFTP/local 4, FTP 1); set 1–16 to override. Lower it for weak servers or slow links.",
    maxFileMB: "Max file size (MB)",
    maxFileMBDesc: "Files larger than this are skipped with an error, so huge files are never loaded into memory (default 64, 0 = no limit).",
    debug: "Verbose debug logging",
    debugDesc: "Log every request/upload to the browser console to diagnose failed publishes; keep it off for daily use.",
    knownHosts: "Known host keys (SFTP)",
    knownHostsDesc: "The SSH fingerprint of a server is remembered on first connect; a changed fingerprint (new server / man-in-the-middle) refuses to connect. Clear it here after moving the server.",
    knownHostsCount: "{n} host key(s) remembered",
    knownHostsNone: "No host keys remembered yet",
    clearHosts: "Clear all",
    clearHostsConfirm: "Forget all known host keys? The fingerprint of each SFTP server will be recorded again on the next connection.",
    clearHostsDone: "Known host keys cleared; they will be recorded again on next connect",
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
const Progress = {
  el: null,
  show(text, ratio) {
    if (!this.el) {
      const el = document.createElement("div");
      el.style.cssText = [
        "position:fixed", "right:12px", "bottom:64px", "z-index:9999",
        "min-width:240px", "max-width:340px", "padding:10px 14px",
        "border-radius:6px", "box-shadow:0 2px 10px rgba(0,0,0,.25)",
        "background:var(--b3-theme-surface)", "color:var(--b3-theme-on-surface)",
        "font-size:13px", "line-height:1.5", "word-break:break-all",
      ].join(";");
      el.innerHTML = '<div class="wdav-prog-text"></div>' +
        '<div style="height:4px;margin-top:8px;border-radius:2px;background:var(--b3-theme-surface-lighter)">' +
        '<div class="wdav-prog-bar" style="height:100%;width:0;border-radius:2px;background:var(--b3-theme-primary);transition:width .2s"></div></div>';
      document.body.appendChild(el);
      this.el = el;
    }
    this.el.querySelector(".wdav-prog-text").textContent = text;
    this.el.querySelector(".wdav-prog-bar").style.width =
      ratio == null ? "100%" : `${Math.min(100, Math.round(ratio * 100))}%`;
  },
  hide() {
    if (this.el) { this.el.remove(); this.el = null; }
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

/* 归属标记：目录里留一个只含本文 ID 的空后缀文件，用来判断“这个目录是谁的”。
 * 用文件名而不是文件内容承载身份，四种协议都能靠一次浅列举拿到，无需读远端正文。 */
const OWNER_PREFIX = ".netglimmer-owner-";
const OWNER_RE = /^\.netglimmer-owner-([0-9a-zA-Z]{1,20})\.json$/;
function ownerName(docId) {
  const tail = String(docId || "").split("-").pop() || String(docId || "");
  const safe = tail.replace(/[^0-9a-zA-Z]/g, "").slice(0, 12) || "unknown";
  return `${OWNER_PREFIX}${safe}.json`;
}
/* 整数设置项夹到合法区间；空值/非数字回落到默认值 */
function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/* 展示地址（取消发布/失败记录用）：任何协议拼路径失败都不该再抛异常盖掉原始错误 */
function safeRootDisplay(up, segs) {
  try { return up && segs ? up.rootDisplay(segs) : ""; } catch (e) { return ""; }
}

/* 列举结果里是否存在“别人的”归属标记 */
function hasForeignOwner(names, mine) {
  for (const n of names || []) {
    const m = OWNER_RE.exec(String(n));
    if (m && `${OWNER_PREFIX}${m[1]}.json` !== mine) return true;
  }
  return false;
}

/* 复制到剪贴板：优先 Clipboard API，失败回退 execCommand（思源 webview 下 Clipboard API 可能不可用） */
async function copyText(text) {
  const str = String(text == null ? "" : text);
  if (!str) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(str);
      return true;
    }
  } catch (e) { /* 落到下方回退 */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = str;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand ? document.execCommand("copy") : false;
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) { return false; }
}

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

/* 读取内核文件字节。
 * 用户机器实测：fetch(`${conf().api}/api/file/getFile`) 全部返回 200 + 0 字节，
 * 而同源的 fetchSyncPost（相对 URL + XHR）一切正常——说明该环境下绝对地址 fetch
 * 的响应被截走/改写了。v0.7.0 起按可靠性排序依次尝试，取第一个非空结果：
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
    xhr.ontimeout = () => reject(new Error("timeout"));
    xhr.send(JSON.stringify({ path: wsPath }));
  });
}

async function fetchGetFileBytes(wsPath, base) {
  const resp = await fetch(`${base}/api/file/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token: conf().token },
    body: JSON.stringify({ path: wsPath }),
  });
  if (resp.status !== 200) {
    const j = await resp.json().catch(() => ({}));
    throw new Error(`HTTP ${j.code || resp.status}${j.msg ? " " + j.msg : ""}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
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
          console.warn(`[netglimmer-publish] ${wsPath}: 读取 ${u8.length}B ≠ 内核报告 ${expectedSize}B（${name}）`);
        }
        return u8;
      }
      console.warn(`[netglimmer-publish] ${name} 读取 ${wsPath} 返回空`);
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
 * 旧版 ≤0.2.7 走 /api/network/proxy，但 gin 的 Any() 只注册七个标准动词，
 * PROPFIND/MKCOL 根本没进代理处理器，收到的是内核兜底的假 200——
 * 这就是“插件报成功但 IIS 没有文件”的根因。 */

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
    throw Object.assign(new Error(`${opts.method} ${opts.url}: ${ret.msg || `forwardProxy code ${ret.code}`}`),
      { retryable: true });
  }
  const d = ret.data;
  // 逐请求的流水日志受设置里的「调试日志」开关控制（一次完整发布有上千行），
  // 但服务端返回 4xx/5xx 一律留痕，不受开关影响。
  if (d.status >= 400) {
    console.warn(`[netglimmer-publish] ${opts.method} ${opts.url} -> ${d.status}`,
      String(d.body || "").slice(0, 200));
  } else if (DEBUG) {
    dbg(`[netglimmer-publish] ${opts.method} ${opts.url} -> ${d.status}`,
      String(d.body || "").slice(0, 200));
  }
  return { status: d.status, body: d.body || "", headers: d.headers };
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
    throw Object.assign(new Error(`PUT ${url}: HTTP ${d.status}`), { httpStatus: d.status });
  }
  console.log(`[netglimmer-publish] PUT ${url} -> ${d.status} (${u8.length} bytes)`);
  return d.status;
}

async function davMkcol(settings, url) {
  const d = await davRequest(settings, "MKCOL", url);
  // 严格实现回 201；部分服务器（含 IIS 某些配置）回 200/204；405=已存在。
  // 真正的可写性由后续 PUT 验证，这里只拒绝明确的失败码。
  if (!okStatus(d.status, [200, 201, 204, 405])) {
    throw Object.assign(new Error(`MKCOL ${url}: ${d.status}`), { httpStatus: d.status });
  }
}

/* MultiStatus 解析：不用 DOMParser——IIS 返回 <D:href>（大写前缀），
 * getElementsByTagName("href") 对带命名空间前缀的元素不可靠，直接正则逐块解析。 */
const NS = "(?:[A-Za-z_][\\w.-]*:)?";
function parseMultistatus(body) {
  const text = String(body || "");
  const blocks = text.split(new RegExp(`<${NS}response\\b`, "i")).slice(1);
  const entries = [];
  for (const b of blocks) {
    const hm = b.match(new RegExp(`<${NS}href[^>]*>([^<]*)</${NS}href>`, "i"))
      || b.match(new RegExp(`<${NS}href[^>]*>([^<]*)`, "i"));
    if (!hm) continue;
    entries.push({
      href: (hm[1] || "").trim(),
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

class FtpSession {
  constructor(s) {
    const net = needNode("net", "FTP");
    this.net = net;
    let host = s.server || "", port = Number(s.port) || 21;
    if (host.includes(":") && !host.includes("]")) {
      const i = host.lastIndexOf(":");
      if (/^\d+$/.test(host.slice(i + 1))) { port = Number(host.slice(i + 1)); host = host.slice(0, i); }
    }
    host = host.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
    this.host = host; this.port = port;
    this.user = s.username; this.pass = s.password;
    this.sock = null; this.buf = ""; this.expectQueue = []; this.pending = [];
    this.hasMLSD = false; this.hasUTF8 = true; this.listArgBroken = false; this._capture = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = this.net.connect({ host: this.host, port: this.port });
      sock.setTimeout(30000);
      sock.once("error", reject);
      this.sock = sock;
      sock.setEncoding("utf8");
      sock.on("data", (d) => this._onData(d));
      this._expect(220).then(() => { sock.removeListener("error", reject); resolve(); }, reject);
    });
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
      const item = {
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

  async cmd(line, codes) {
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
      host: `${m[1]}.${m[2]}.${m[3]}.${m[4]}`,
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

  async put(relPath, u8) {
    const ep = await this.pasv();
    const d = await this._dataConn(ep);
    this._wire(`STOR ${relPath}\r\n`);
    const r = await this._expect([125, 150, 126]);
    await new Promise((resolve, reject) => {
      d.on("error", reject);
      d.end(Buffer.from(u8.buffer, u8.byteOffset, u8.length), () => resolve());
    });
    await new Promise((resolve, reject) => {
      d.on("error", reject); d.on("close", resolve); d.on("end", resolve);
    });
    await this._expect([226, 250]);
    return r;
  }

  async get(relPath) {
    const ep = await this.pasv();
    const d = await this._dataConn(ep);
    this._wire(`RETR ${relPath}\r\n`);
    await this._expect([125, 150]);
    const chunks = [];
    await new Promise((resolve, reject) => {
      d.on("data", (c) => chunks.push(c));
      d.on("error", reject); d.on("close", resolve); d.on("end", resolve);
    });
    await this._expect([226, 250, 425, 426]);
    return Buffer.concat(chunks);
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

  /* 目录列表：FEAT 声明 MLSD 时优先 MLSD（机器可读），否则/失败退回 LIST（解析 UNIX 与 Windows/IIS 格式）。 */
  async list(relPath) {
    if (this.hasMLSD) {
      let dMlsd = null;
      try {
        const ep = await this.pasv();
        dMlsd = await this._dataConn(ep);
        const d = dMlsd;
        this._wire(`MLSD ${relPath}\r\n`);
        await this._expect([125, 150]);
        let text = "";
        let ok = true;
        await new Promise((resolve) => {
          d.setEncoding(this.gbkMode ? "latin1" : "utf8");
          d.on("data", (c) => { text += c; });
          d.on("close", resolve); d.on("end", resolve); d.on("error", () => { ok = false; resolve(); });
        });
        const fin = await this._expect([226, 250, 550]);
        if (ok && fin.code === 226 && text.trim()) {
          const items = [];
          for (const line of text.split("\r\n")) {
            const m = line.match(/^(.*) ;?\s+(.*)$/);
            if (!m) continue;
            const facts = {};
            m[1].split(";").forEach((kv) => { const p = kv.split("="); if (p.length === 2) facts[p[0].toLowerCase()] = p[1]; });
            const name = m[2].trim();
            if (!name || name === "." || name === "..") continue;
            items.push({ name, isDir: (facts.type || "") === "dir", size: facts.size != null ? parseInt(facts.size, 10) : -1 });
          }
          if (items.length) return items;
        }
      } catch (e) { /* MLSD 不可用 → LIST */ }
      try { dMlsd && dMlsd.destroy(); } catch (e) { /* noop */ }
    }
    // LIST 回退
    const text2 = await this._listData(this.listArgBroken && relPath ? (await this.cwdThen(relPath)) : relPath);
    const items = parseList(text2);
    /* FileZilla Server 等：LIST <目录> 返回「目录自身」一条而非内容。
     * 检测到后切换为 CWD + 裸 LIST 模式（本会话内缓存该判定，避免逐目录重复试探）。 */
    if (relPath && items.length === 1 && items[0].isDir && normalizeKey(items[0].name) === normalizeKey(relPath.replace(/\/+$/, "").split("/").pop())) {
      this.listArgBroken = true;
      return parseList(await this._listData(await this.cwdThen(relPath)));
    }
    return items;
  }

  /* 切到目录并返回空参数（裸 LIST 用当前目录）；CWD 失败会抛（550=不存在） */
  async cwdThen(relPath) {
    await this.cmd("CWD " + relPath, [250]);
    return "";
  }

  _listData(arg) {
    return (async () => {
      const ep = await this.pasv();
      const d = await this._dataConn(ep);
      this._wire(`LIST ${arg}\r\n`);
      await this._expect([125, 150]);
      let text = "";
      await new Promise((resolve) => {
        d.setEncoding(this.gbkMode ? "latin1" : "utf8");
        d.on("data", (c) => { text += c; });
        d.on("close", resolve); d.on("end", resolve); d.on("error", resolve);
      });
      await this._expect([226, 250, 550]);
      return text;
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

/* LIST 文本解析：UNIX ls -l（vsftpd/ProFTPD：日期为 3 个 token）与 IIS/Windows 格式 */
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
    m = line.match(/^(\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s*[AP]M?)\s+(<DIR>|\d+)\s+(\S.*)$/i);
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
    let host = s.server || "", port = Number(s.port) || 22;
    if (host.includes(":")) {
      const i = host.lastIndexOf(":");
      if (/^\d+$/.test(host.slice(i + 1))) { port = Number(host.slice(i + 1)); host = host.slice(0, i); }
    }
    host = host.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
    this.host = host; this.port = port; this.user = s.username; this.pass = s.password;
    this.hostKeys = null; // TOFU 存储（由插件注入 {get, set}）
    this.seqIn = 0; this.seqOut = 0;
    this.encIn = false; this.encOut = false;
    this.pendingIn = false; this.pendingOut = false;   // NEWKEYS 已发/已收，等待切换密钥
    this.buf = Buffer.alloc(0);
    this.vClient = "SSH-2.0-siyuan-netglimmer-publish_1.0";
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
    for (const [, w] of this.sftpReq) w.reject(err);
    this.sftpReq.clear();
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
      if (this.buf.length < 4) return;
      const len = this.buf.readUInt32BE(0);
      if (len > 256 * 1024) { try { this.sock.destroy(); } catch (e) {} this.fail(new Error("SSH 包长异常 " + len)); return; }
      const macLen = this.macIn ? this.macInLen : 0;
      const total = 4 + len + macLen;
      if (this.buf.length < total) return;
      const packet = this.buf.subarray(0, total);
      this.buf = this.buf.subarray(total);
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
          const body = packet.subarray(4, 4 + len);
          const mac = packet.subarray(4 + len);
          const h = this.crypto.createHmac(this.macIn, this.kIn);
          const sb = Buffer.alloc(4); sb.writeUInt32BE(this.seqIn >>> 0, 0);
          h.update(sb); h.update(packet.subarray(0, 4 + len));
          if (!this.crypto.timingSafeEqual(h.digest(), mac)) throw new Error("SSH MAC 校验失败");
          payload = this.decipher.update(body);
          const padLen = payload[0];
          payload = payload.subarray(1, len - padLen);
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
      if (this.etmOut) { h.update(lenBuf); h.update(packet.subarray(4)); }
      else h.update(packet);
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
    this.kex.curve = pick(["curve25519-sha256", "curve25519-sha256@libssh.org", "ecdh-sha2-nistp256"], sKex);
    this.kex.hostKeyAlg = pick(["ssh-ed25519", "rsa-sha2-512", "rsa-sha2-256", "ssh-rsa", "ecdsa-sha2-nistp256"], sHost);
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
      this.etmOut = etm; this.encOut = true; this.seqOut = 0;   // OpenSSH 严格 KEX：NEWKEYS 后序号归零
      this.pendingOut = false;
    };
    this._switchIn = () => {
      this.decipher = decipher; this.macIn = nodeMac; this.kIn = mS;
      this.etmIn = etm; this.encIn = true; this.seqIn = 0;     // 严格 KEX：序号归零
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
      const saved = this.hostKeys.get(this.host + ":" + this.port);
      if (saved && saved !== this.hostFingerprint) {
        throw new Error(`服务器指纹变化！保存 ${saved}，本次 ${this.hostFingerprint}——若服务器确已重装请清除插件设置中的 known_hosts`);
      }
      if (!saved) this.hostKeys.set(this.host + ":" + this.port, this.hostFingerprint);
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
      this._versionWaiter = { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject };
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
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.sftpReq.delete(id); reject(new Error(`SFTP 请求超时 (type ${type})`)); }, 120000);
      this.sftpReq.set(id, { resolve, reject, timer });
    });
    await this._sendChannelData(data);
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
  try { s = decodeURIComponent(s); } catch (e) { /* 保留原串 */ }
  return s.toLowerCase();
}

async function walkRemoteFiles(settings, url, depth, out) {
  if (depth > 10) return out;
  const r = await davPropfind(settings, url, "1");
  if (r.status !== 207) {
    if (depth === 0) out.status = r.status;
    // 子目录 PROPFIND 失败若是链路/服务器抖动（5xx/408），整棵遍历结果不完整，
    // 标记 partial 让调用方重试——否则漏掉的文件会被误判成「远端缺失」。
    else if (RETRY_HTTP_STATUS.includes(r.status)) out.partial = true;
    return out;
  }
  const origin = new URL(settings.server).origin;
  const self = url.replace(/\/+$/, "");
  for (const e of r.entries) {
    if (!e.href) continue;
    let child = e.href.startsWith("/") ? origin + e.href : e.href;
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
  const ent = (pf.entries || []).find((e) => normalizeKey(e.href) === normalizeKey(url));
  if (pf.status === 207 && ent && ent.size >= 0) remoteSize = ent.size;
  if (remoteSize === null) {
    const back = await davGet(settings, url);
    if (back.status === 200) remoteSize = utf8Bytes(String(back.body || "")).length;
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

/* IIS WebDAV 对 Depth:infinity 的 PROPFIND 直接 403，清理旧目录用
 * Depth:1 递归，先删子项再删目录（最深优先）。 */
async function davDeleteChildren(s, url, depth) {
  if (depth > 10) return;
  let r;
  try {
    r = await davPropfind(s, url, "1");
  } catch (e) {
    return;
  }
  if (r.status !== 207) return;
  const origin = new URL(s.server).origin;
  const self = url.replace(/\/+$/, "");
  for (const e of r.entries) {
    if (!e.href) continue;
    let child = e.href.startsWith("/") ? origin + e.href : e.href;
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
      const wait = Math.min(8000, (opts.base || 400) * Math.pow(2, i - 1)) + Math.floor(Math.random() * 250);
      console.warn(`[netglimmer-publish] ${opts.label || "操作"} 第 ${i}/${tries} 次失败：`
        + `${(e && e.message) || e}；${wait}ms 后重试`);
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
    const ent = (pf.entries || []).find((e) => normalizeKey(e.href) === normalizeKey(url));
    return pf.status === 207 && ent ? ent.size : -1;
  }
  async walk(segs) {
    const url = this.rootDisplay(segs);
    const w = await walkRemoteFiles(this.s, url, 0,
      { files: new Map(), paths: new Map(), status: 207, partial: false });
    return { supported: w.status === 207, files: w.files, paths: w.paths, partial: !!w.partial };
  }
  async deleteTree(segs) { await davDeleteChildren(this.s, this.rootDisplay(segs), 0); }
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
  keyOf(segs) { return normalizeKey(this.p(segs)); }
  rootDisplay(segs) {
    let pth = this.p(segs);
    if (this.sess && this.sess.hasUTF8 === false) {
      try { pth = new TextDecoder("gbk").decode(Buffer.from(pth, "latin1")); } catch (e) { /* 保留字节串 */ }
    }
    // 端口不是 21 时必须带上，否则记进历史/点击打开的链接连不上
    const hp = this.sess ? `${this.sess.host}${Number(this.sess.port) === 21 ? "" : ":" + this.sess.port}`
      : this.s.server;
    return `ftp://${hp}${pth}/`;
  }
  async mkdir(segs) {
    if (!segs.length) return;
    const created = await this.sess.mkd(this.p(segs));
    if (created) return;
    // MKD 550 可能是「已存在」也可能是无权限：查父目录列表甄别
    const parentSegs = segs.slice(0, -1);
    let items = [];
    try { items = await this.sess.list(this.p(parentSegs)); } catch (e) { /* 列不了就当不存在 */ }
    const name = segs[segs.length - 1];
    if (items.some((i) => i.isDir && normalizeKey(i.name) === normalizeKey(this.encSeg(name)))) return;
    throw new Error(`MKD 失败：${this.p(segs)}`);
  }
  async put(segs, u8) { await this.sess.put(this.p(segs), u8); }
  async sizeOf(segs) { return await this.sess.size(this.p(segs)); }
  async walk(segs) {
    const files = new Map();
    const paths = new Map();
    const meta = { partial: false };
    let supported = true;
    try {
      await this.sess.list(this.p(segs));
    } catch (e) { supported = false; }
    if (supported) await this._walk(segs, files, 0, paths, meta);
    return { supported, files, paths, partial: meta.partial };
  }
  async _walk(segs, files, depth, paths, meta) {
    if (depth > 12) return;
    let items;
    try { items = await this.sess.list(this.p(segs)); }
    catch (e) {
      // 列目录失败若是链路抖动/连接中断，结果不完整：标记 partial 让上层重试整棵遍历
      if (meta && (isTransientError(e) || isConnLostError(e))) meta.partial = true;
      return;
    }
    for (const it of items) {
      const child = segs.concat([it.name]);
      if (it.isDir) await this._walk(child, files, depth + 1, paths, meta);
      else { const key = normalizeKey(this.p(child)); files.set(key, it.size); if (paths) paths.set(key, this.p(child)); }
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
  keyOf(segs) { return normalizeKey(this.p(segs)); }
  rootDisplay(segs) {
    const hp = this.ssh
      ? `${this.ssh.host}${Number(this.ssh.port) === 22 ? "" : ":" + this.ssh.port}`
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
    if (depth > 12) return;
    let h;
    try { h = await this.ssh.opendir(this.p(segs)); }
    catch (e) {
      if (meta && (isTransientError(e) || isConnLostError(e))) meta.partial = true;
      return;
    }
    try {
      let page;
      while ((page = await this.ssh.readdir(h))) {
        for (const it of page) {
          const child = segs.concat([it.name]);
          if (it.isDir) await this._walk(child, files, depth + 1, paths, meta);
          else { const key = normalizeKey(this.p(child)); files.set(key, it.size); if (paths) paths.set(key, this.p(child)); }
        }
      }
    } finally { await this.ssh.closeHandle(h); }
  }
  async deleteTree(segs) { await this._del(segs, 0); }
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
    if (!raw) throw new Error("未填写本地导出路径");
    // 去掉可能误填的 file:// 前缀；相对路径按当前工作目录解析（建议用绝对路径）
    const cleaned = raw.replace(/^file:\/\/\/?/i, "").replace(/\|/, ":");
    this.base = path.resolve(cleaned);
    // 基础目录不存在则尝试创建，顺带验证可写
    await this.fsp.mkdir(this.base, { recursive: true });
    await this.fsp.access(this.base, (fs.constants || {}).W_OK ?? 2);
  }
  /* 拼本地绝对路径。rootSegsOf 已经拒绝过 . / .. 段，这里是第二道防线：
   * 任何一段把结果带出基础目录（deleteTree 是 fs.rm(recursive)，越界就是删库）直接抛错。 */
  p(segs) {
    const abs = this.path.join(this.base, ...(segs || []).map((x) => String(x)));
    const rel = this.path.relative(this.base, abs);
    if (rel && (rel.startsWith("..") || this.path.isAbsolute(rel))) {
      throw new Error(`路径越界：${abs} 不在基础目录 ${this.base} 内`);
    }
    return abs;
  }
  keyOf(segs) { return normalizeKey(this.p(segs)); }
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
    await this._walk(segs, files, 0, paths);
    return { supported: true, files, paths };
  }
  async _walk(segs, files, depth, paths) {
    if (depth > 12) return;
    let entries;
    try { entries = await this.fsp.readdir(this.p(segs), { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const child = segs.concat([ent.name]);
      if (ent.isDirectory()) await this._walk(child, files, depth + 1, paths);
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
  async migrateLegacyData() {
    const LEGACY = "siyuan-plugin-webdav-publish";
    for (const key of [SETTINGS_KEY, HISTORY_KEY]) {
      try {
        const cur = await this.loadData(key);
        if (cur !== null && cur !== undefined) continue;
        // 用发布主链路同款 4 级回退读法（readExportFile）读旧 petal 文件：
        // 用户机器上绝对 fetch /api/file/getFile 常被截成 0 字节，而内核并无 /api/file/readFile 路由
        const wsPath = `data/storage/petal/${LEGACY}/${key}.json`;
        const u8 = await readExportFile(wsPath, 0);
        if (!u8 || u8.length === 0) continue;
        const obj = JSON.parse(new TextDecoder("utf-8").decode(u8));
        if (obj === null || obj === undefined) continue;
        await this.saveData(key, obj);
        console.log(`[netglimmer-publish] 已迁移旧数据 ${key}.json`);
      } catch (e) { /* 无旧数据或读取失败：跳过 */ }
    }
  }

  async onload() {
    // 插件标识更名（siyuan-plugin-webdav-publish → siyuan-plugin-netglimmer-Publish）后，
    // 新存储为空时自动从旧目录迁移设置与发布历史
    await this.migrateLegacyData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData(SETTINGS_KEY)) || {});
    this.migrateToProfiles();
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
      // 只保留一个入口按钮；是否「含子文档」由设置里的开关决定（默认开启）
      menu.addItem({
        icon: "iconUpload",
        label: this.changedSet && this.changedSet.has(id) ? this.t("publishChanged") : this.t("publish"),
        click: () => this.publish(id, this.settings.publishMerge !== false),
      });
    };

    this.eventBus.on("open-menu-doctree", (event) => {
      try {
        addTreeMenuItems(event.detail || event);
      } catch (e) {
        console.error("[netglimmer-publish] open-menu-doctree", e);
      }
    });

    // 编辑区文档标题图标菜单（部分版本存在该事件，取不到 ID 时自动跳过）
    this.eventBus.on("click-editortitleicon", (event) => {
      try {
        const d = event.detail || event;
        const id = d.data?.rootID || d.data?.id || d.blockId || d.protyle?.block?.rootId;
        if (!id || !d.menu) return;
        d.menu.addItem({
          icon: "iconUpload",
          label: this.changedSet && this.changedSet.has(id) ? this.t("publishChanged") : this.t("publish"),
          click: () => this.publish(id, this.settings.publishMerge !== false),
        });
      } catch (e) {
        console.error("[netglimmer-publish] click-editortitleicon", e);
      }
    });

    console.log("[netglimmer-publish] loaded v0.9.11");

    // 注册「发布看板」独立页签（openTab/addTab 可用时点击入口直接开页面）
    this.registerDashTab();

    // 状态栏入口：发布看板
    try {
      if (typeof this.addStatusBar === "function") {
        this.addStatusBar({
          position: "right",
          template: `<span class="vd-dash-entry" style="cursor:pointer;display:flex;align-items:center;" title="${this.t("dashboard")}">${this.t("dashboard")}</span>`,
        });
        // 状态栏模板是异步插入的，轮询几次再绑定
        let tries = 0;
        const bind = () => {
          const entry = document.querySelector(".vd-dash-entry");
          if (entry) {
            entry.addEventListener("click", () => {
              // 直接打开设置弹窗并切换到看板视图；不可用时回退独立页签/弹窗
              this.openSetting();
              if (!this.vdSwitch) this.openDashboard();
            });
            return;
          }
          if (++tries < 10) setTimeout(bind, 200);
        };
        setTimeout(bind, 200);
      }
    } catch (e) { /* 状态栏不可用不影响发布 */ }

    // 设置面板构建失败不应影响发布功能：单独兜底，openSetting 时还会惰性重建
    try {
      this.buildSettingTab();
    } catch (e) {
      console.error("[netglimmer-publish] buildSettingTab", e);
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
      console.error("[netglimmer-publish] tree badge init", e);
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

  // 从发布历史收集「发布成功」的文档：docId → url，另存 docId → 发布时的改动指纹
  async refreshPublishedSet() {
    const map = new Map();
    const stamps = new Map();
    try {
      const list = await this.getHistory();
      for (const rec of list) {
        // pub 标记表示“该文档至少成功发布过一次且未被清除”，用于树角标；
        // 兼容旧记录：无 pub 字段时回退到 ok 判定。
        const published = rec.pub != null ? rec.pub : rec.ok;
        if (!rec || !published || !rec.docId) continue;
        if (!map.has(rec.docId)) map.set(rec.docId, rec.url || "");
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
      // MutationObserver 用于跟随树的重绘补角标；个别环境缺失时退化为一次性标注
      if (typeof MutationObserver !== "undefined" && !this._badgeObserver) {
        try {
          this._badgeObserver = new MutationObserver(() => this.scheduleTreeDecorate());
          this._badgeObserver.observe(document.body, { childList: true, subtree: true });
        } catch (e) { this._badgeObserver = null; }
      }
      this.scheduleTreeDecorate();
    };
    if (document.body) attach();
    else document.addEventListener("DOMContentLoaded", attach, { once: true });
  }

  stopTreeBadge() {
    if (this._badgeObserver) { try { this._badgeObserver.disconnect(); } catch (e) {} this._badgeObserver = null; }
    if (this._badgeTimer) { clearTimeout(this._badgeTimer); this._badgeTimer = null; }
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
      // 幂等：状态没变就不动 DOM（否则 MutationObserver 会被自己触发成死循环）
      if (has && has.getAttribute("data-st") === state) continue;
      if (has) { try { has.remove(); } catch (e) {} }
      const url = typeof this.publishedMap.get(id) === "string"
        ? this.publishedMap.get(id) : (this.publishedMap.get(id) || {}).url || "";
      const badge = document.createElement("span");
      badge.className = "vd-pub-badge";
      badge.setAttribute("data-st", state);
      badge.setAttribute("title", changed ? this.t("changedBadgeTip") : this.t("publishedBadgeTip"));
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
          try { window.open(url, "_blank"); } catch (err) { /* noop */ }
        });
      }
      const textEl = li.querySelector(".b3-list-item__text");
      (textEl || li).appendChild(badge);
    }
  }

  onunload() {
    try { this.stopTreeBadge(); } catch (e) { /* noop */ }
    if (this._changedTimer) { try { clearInterval(this._changedTimer); } catch (e) {} this._changedTimer = null; }
  }

  t(key) {
    const lang = conf()?.lang || "zh_CN";
    const dict = I18N[lang] || I18N.zh_CN;
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
      try { this.buildSettingTab(); } catch (e) { console.error("[netglimmer-publish] buildSettingTab(retry)", e); }
    }
    if (!this.setting || typeof this.setting.open !== "function") return;
    this.vdSwitch = null;
    try {
      this.setting.open(this.displayName || this.t("settingsTitle"));
    } catch (e) {
      console.error("[netglimmer-publish] setting.open", e);
      return;
    }
    try {
      this.decorateSettingDialog();
    } catch (e) {
      console.error("[netglimmer-publish] decorateSettingDialog", e);
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

    const ui = {
      showClose: false,
      refresh: () => self.renderDash(dashView, ui),
      close: () => {},
      closeOnPublish: false,
    };

    const switchView = (name) => {
      const dash = name === "dash";
      settingsView.style.display = dash ? "none" : "";
      dashView.style.display = dash ? "" : "none";
      for (const [key, el] of tabBtns) {
        el.style.fontWeight = key === name ? "700" : "400";
        el.style.borderBottom = key === name ? "2px solid var(--b3-theme-primary)" : "2px solid transparent";
        el.style.color = key === name ? "var(--b3-theme-primary)" : "var(--b3-theme-on-surface)";
      }
      if (dash) ui.refresh();
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

  /* 老版本把 server/username/password/prefix 平铺在顶层。首次加载时把当前
   * 生效协议的这套值播种进 profiles[protocol]，其余协议留空，互不干扰。
   * 注意：Object.assign 是浅拷贝，settings.profiles 会别名到模块级 DEFAULT_SETTINGS.profiles，
   * 直接改它会污染所有后续实例的默认值。这里总是重建一份私有副本再落回。 */
  migrateToProfiles() {
    const s = this.settings || {};
    const src = (s.profiles && typeof s.profiles === "object") ? s.profiles : {};
    const fresh = {};
    for (const p of PROTO_KEYS) {
      const base = (src[p] && typeof src[p] === "object") ? src[p] : {};
      fresh[p] = {
        server: base.server || "", username: base.username || "",
        password: base.password || "", prefix: base.prefix || "",
      };
    }
    // 顶层有旧值但没有任何 profile 被填过 → 迁移到当前协议
    const anyFilled = PROTO_KEYS.some((p) => CRED_FIELDS.some((k) => fresh[p][k]));
    if (!anyFilled && (s.server || s.username || s.password || s.prefix)) {
      const active = s.protocol || "webdav";
      fresh[active] = {
        server: s.server || "", username: s.username || "",
        password: s.password || "", prefix: s.prefix || "",
      };
    }
    s.profiles = fresh;
    this.settings = s;
  }

  /* 返回某协议保存的凭据（缺字段回退空串）。 */
  profileFor(proto) {
    const s = this.settings || {};
    const p = (s.profiles && s.profiles[proto]) || {};
    const out = { server: "", username: "", password: "", prefix: "" };
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
      server: p.server, username: p.username, password: p.password, prefix: p.prefix,
      cleanOld: s.cleanOld !== false, addToc: s.addToc !== false,
      publishMerge: s.publishMerge !== false,
      incremental: s.incremental !== false,
      knownHosts: s.knownHosts || {}, profiles: s.profiles,
      // 全局调优项（与协议无关，发布/取消发布都要用）
      debug: !!s.debug,
      retryTries: clampInt(s.retryTries, 1, 6, 3),
      concurrency: clampInt(s.concurrency, 0, 16, 0),
      maxFileMB: clampInt(s.maxFileMB, 0, 4096, 64),
    };
  }

  /* 把当前表单里的 server/username/password/prefix 写回指定协议的 profile（不落盘）。 */
  commitFormToProfile(proto) {
    const e = this.els || {};
    if (!this.settings.profiles || typeof this.settings.profiles !== "object") this.settings.profiles = {};
    this.settings.profiles[proto] = {
      server: normServer(e.server && e.server.value, proto),
      username: String((e.username && e.username.value) || "").trim(),
      password: (e.password && e.password.value) || "",
      prefix: String((e.prefix && e.prefix.value) || "").trim().replace(/^\/+|\/+$/g, ""),
    };
  }

  /* 把某协议的 profile 载入表单输入框。 */
  loadProfileToForm(proto) {
    const p = this.profileFor(proto);
    const e = this.els || {};
    if (e.server) e.server.value = p.server;
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
      el.style.width = "280px";
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
      el.style.width = "110px";
      el.addEventListener("paste", (e) => e.stopPropagation());
      this.els[key] = el;
      return el;
    };

    const protoPlaceholder = (v) => v === "ftp" ? "192.168.1.10:21"
      : v === "sftp" ? "192.168.1.10:22"
      : v === "local" ? (global.navigator && /Win/i.test(global.navigator.platform || "") ? "D:\\www\\publish" : "/var/www/html")
      : "https://example.com/dav";
    const mkProto = () => {
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
      });
      this.els.protocol = el;
      return el;
    };

    this.setting = new Setting({ width: "min(1200px, 94vw)", height: "86vh" });

    this.setting.addItem({
      title: this.t("protocol"),
      description: this.t("protocolDesc"),
      createActionElement: () => mkProto(),
    });
    this.setting.addItem({
      title: this.t("server"),
      description: this.t("serverDescAny"),
      createActionElement: () => mkInput("server", "text", credVal("server"), protoPlaceholder(activeProto())),
    });
    this.setting.addItem({
      title: this.t("username"),
      description: "",
      createActionElement: () => mkInput("username", "text", credVal("username"), ""),
    });
    this.setting.addItem({
      title: this.t("password"),
      description: this.t("passwordHint"),
      createActionElement: () => mkInput("password", "password", credVal("password"), ""),
    });
    this.setting.addItem({
      title: this.t("prefix"),
      description: this.t("prefixDesc"),
      createActionElement: () => mkInput("prefix", "text", credVal("prefix"), "publish"),
    });
    this.setting.addItem({
      title: this.t("cleanOld"),
      description: "",
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
          this.settings.knownHosts = {};
          if (this.els.knownHostsInfo) this.els.knownHostsInfo.textContent = this.t("knownHostsNone");
          await this.saveData(SETTINGS_KEY, this.settings);
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
      await this.saveData(SETTINGS_KEY, this.settings);
      setDebug(this.settings.debug);
      showMessage(this.t("saved"), 2000, "ok");
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
      server: (e.server?.value || "").trim().replace(/\/+$/, ""),
      username: (e.username?.value || "").trim(),
      password: e.password?.value || "",
      prefix: (e.prefix?.value || "").trim().replace(/^\/+|\/+$/g, ""),
      cleanOld: !!e.cleanOld?.checked,
      addToc: !!e.addToc?.checked,
      publishMerge: !!e.publishMerge?.checked,
      incremental: !!e.incremental?.checked,
      knownHosts: this.settings.knownHosts || {},
      debug: !!e.debug?.checked,
      retryTries: clampInt(e.retryTries?.value, 1, 6, 3),
      concurrency: clampInt(e.concurrency?.value, 0, 16, 0),
      maxFileMB: clampInt(e.maxFileMB?.value, 0, 4096, 64),
    };
  }

  /* 把 readForm 的结果落到 profiles：当前表单凭据写回其所属协议的 profile，
   * 顶层平铺字段镜像为当前生效协议（供外部/旧逻辑读取与发布使用）。就地合并。 */
  applyFormToSettings(form) {
    this.settings.profiles = this.settings.profiles || {};
    this.settings.profiles[form.protocol] = {
      server: form.server, username: form.username, password: form.password, prefix: form.prefix,
    };
    this.draftProto = form.protocol;
    Object.assign(this.settings, {
      protocol: form.protocol,
      server: form.server, username: form.username, password: form.password, prefix: form.prefix,
      cleanOld: form.cleanOld, addToc: form.addToc, publishMerge: form.publishMerge,
      incremental: form.incremental, knownHosts: form.knownHosts,
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
  hostKeyStore() {
    const self = this;
    return {
      get: (k) => (self.settings.knownHosts || {})[k],
      set: (k, v) => {
        self.settings.knownHosts = self.settings.knownHosts || {};
        self.settings.knownHosts[k] = v;
        try { Promise.resolve(self.saveData(SETTINGS_KEY, self.settings)).catch(() => {}); } catch (e) { /* noop */ }
      },
    };
  }

  /* 发布入口：串行队列。同一时刻只允许一个发布在跑（远端会话与目录清理都不能并发），
   * 但连续右键发多篇不再被拒绝，而是排队；返回的 Promise 在“本篇结束”时 resolve，
   * 看板与回归都可以 await 单条发布。 */
  publish(docId, merge, opts) {
    if (this.busy) showMessage(this.t("queuedNow"), 2500, "warn");
    const job = () => this._publish(docId, merge, opts)
      .catch((e) => { console.error("[netglimmer-publish] queued publish", e); });
    const run = (this._chain ? this._chain.then(job, job) : job());
    this._chain = run.then(() => {}, () => {});
    return run;
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
    Progress.show(this.t("exporting"));
    let tempDir = null;
    let up = null;
    let docName = "untitled";
    let remoteSegs = null;   // 本次的远端根目录段：catch 里也要用（记进历史供「取消发布」定位）
    let relocated = false;   // 是否因同名冲突改用了带 ID 的目录
    let touchedRemote = false; // 是否已经动过远端（失败时据此提示“远端可能不完整”）
    const t0 = Date.now();
    try {
      // 1. 导出 HTML(SiYuan) 到内核临时目录 temp/export/<folder>/。
      //    参数与手动「导出 → HTML(SiYuan)」一致：不传 exportTitleOptions，
      //    addTitle 跟随 设置→导出 的全局配置，避免内容与手动导出不同。
      const r = await fetchSyncPost("/api/export/exportHTML", {
        id: docId,
        pdf: false,
        keepFold: false,
        merge,
        savePath: "",
      });
      if (r.code !== 0 || !r.data?.folder) throw new Error(r.msg || "export failed");
      docName = sanitizeName(r.data.name || "untitled");
      tempDir = `/temp/export/${r.data.folder}`;

      // 1.5 生成 index.html —— 3.8.6 起内核 exportHTML 不再写 index.html，
      //     改由前端拼接后经 /api/export/exportBrowserHTML 原样写入。
      //     这里用逐字移植的前端拼装代码（Vendored.buildIndexHtml）生成同一字符串，
      //     与手动导出的 index.html 逐字节一致。
      Progress.show(this.t("generating"));
      const verRet = await fetchSyncPost("/api/system/version", {});
      const version = verRet?.data || "";
      if (typeof r.data.content !== "string") {
        throw new Error("exportHTML 未返回 content（内核版本不匹配？）");
      }
      let indexHtml = await Vendored.buildIndexHtml(
        r.data.name || "untitled", r.data.content, version);
      // 文末追加侧边大纲（与手动运行 add_toc.py 的产物一致），可在设置中关闭
      if (s.addToc !== false) indexHtml = injectToc(indexHtml);
      const indexBytes = utf8Bytes(indexHtml);

      // 2. 枚举导出产物
      const { files, dirs } = await listAllFiles(tempDir);
      if (!files.length) throw new Error("empty export");

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
            console.warn(`[netglimmer-publish] 同名文档已占用远端目录，本次发布到 ${remoteSegs[remoteSegs.length - 1]}`);
          }
        }
      } catch (e) {
        console.warn("[netglimmer-publish] 归属探测失败，按原目录继续：", e.message || e);
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
        Progress.show(this.t("checkingRemote"));
        try {
          const pre = await withRetry(async () => {
            const w = await up.walk(remoteSegs);
            // 子目录遍历中途因链路抖动失败 → 结果不完整，整棵重来
            if (w && w.partial) throw Object.assign(new Error("远端遍历不完整"), { retryable: true });
            return w;
          }, retryOpts(this.t("checkingRemote")));
          if (pre && pre.supported) { existing = pre.files; prePaths = pre.paths; preOk = true; }
        } catch (e) {
          // 预检彻底失败不影响发布，只是退化为“全部重传 + 全树校验”
          console.warn("[netglimmer-publish] 远端预检失败，按全量发布继续：", e.message || e);
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
      // 先决定“哪些要传”，再据此算并发度、总字节与校验方式
      const pending = [];
      for (const f of files) {
        const rel = relOf(f.path, tempDir);
        const segs = remoteSegs.concat(rel.split("/"));
        const key = up.keyOf(segs);
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
        + indexBytes.length;
      const limit = concurrencyFor(proto, s.concurrency);

      // 4.5 试运行：到这里“要传哪些、共多少字节、能复用多少”已经全部算出，
      //     但建目录、探针、删除一个都还没发生——直接汇总返回，远端零写入。
      if (dryRun) {
        showMessage(this.t("dryRunResult")
          .replace("{n}", String(pending.length))
          .replace("{b}", this.fmtBytes(planBytes))
          .replace("{re}", String(reused))
          .replace("{d}", remoteSegs[remoteSegs.length - 1]), 9000, "info");
        return;
      }

      // 4.6 非增量 + 清理：发布前清空整棵文档目录（试运行不会走到这里）。
      //     这一步之后远端就处于“半新半旧”状态，失败时必须明确告诉用户。
      if (!s.incremental && s.cleanOld) {
        Progress.show(this.t("cleaning"));
        await withRetry(() => up.deleteTree(remoteSegs), retryOpts(this.t("cleaning")));
        touchedRemote = true;
      }

      // 5. 建目录：先逐级建 prefix 与文档根目录，再建导出产物的子目录（浅到深）
      Progress.show(this.t("makingDirs"));
      let chain = [];
      for (const seg of remoteSegs) {
        chain = chain.concat([seg]);
        await withRetry(() => up.mkdir(chain), retryOpts(`MKCOL ${seg}`));
      }
      touchedRemote = true;
      const dirSet = dirs
        .map((d) => relOf(d, tempDir))
        .sort((a, b) => a.split("/").length - b.split("/").length);
      for (const rel of dirSet) {
        await withRetry(() => up.mkdir(remoteSegs.concat(rel.split("/"))), retryOpts(`MKDIR ${rel}`));
      }

      // 5.5 传输探针：先传一个已知大小的文件并核对远端尺寸，
      //     通道异常（body 被丢弃/截断）时立即失败，不产生整棵 0 字节目录。
      Progress.show(this.t("probing"));
      await withRetry(() => up.probe(remoteSegs), retryOpts(this.t("probing")));

      // 5.6 写归属标记（见 3.4）：目录名只由标题决定，标记是“这个目录属于哪篇文档”
      //     的唯一凭据。它记进 exempt（而非 expected）：部分 FTP 服务器的 LIST 不返回
      //     隐藏文件，把它纳入逐文件校验会造成假“远端缺失”；同时增量清理也不会把它当孤立文件删掉。
      //     不参与文件数/字节数统计——它是插件的簿记，不是文档内容。
      const ownerSegs = remoteSegs.concat([owner]);
      const ownerBytes = utf8Bytes(JSON.stringify({ docId, owner: shortId, ts: Date.now() }));
      await withRetry(() => up.put(ownerSegs, ownerBytes), retryOpts(`PUT ${owner}`));
      exempt.add(up.keyOf(ownerSegs));

      // 6. 上传文件：并发池 + 瞬时失败重试，最后上传 index.html
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
        paint(t.rel);
        // 先用 readDir 报的大小挡一道：已知超标就别把整个文件读进内存
        if (capBytes && t.f.size > capBytes) throw overCap(t.rel, t.f.size);
        const u8 = await readExportFile(t.f.path, t.f.size);
        // readDir 报 0 的文件（部分运行时文件）以实际读到的字节为准
        if (capBytes && u8.length > capBytes) throw overCap(t.rel, u8.length);
        await withRetry(() => up.put(t.segs, u8), retryOpts(`PUT ${t.rel}`));
        expected.set(t.key, u8.length);
        uploaded.push({ key: t.key, segs: t.segs, rel: t.rel });
        bytes += u8.length;
        sentFiles++; sentBytes += u8.length;
        doneUnits += t.f.size > 0 ? u8.length : UNKNOWN_W;
        if (!isShared(t.rel)) { docFiles++; docBytes += u8.length; }
      }, limit);
      if (upErrs.length) {
        const first = upErrs[0];
        const more = upErrs.length > 1
          ? `（${this.t("uploadFailMore").replace("{n}", String(upErrs.length))}）` : "";
        throw new Error(`${this.t("uploadFailAt")}: ${first.message || first}${more}`);
      }

      const idxSegs = remoteSegs.concat(["index.html"]);
      Progress.show(`${this.t("uploading")} ${total}/${total} · index.html`, 0.999);
      await withRetry(() => up.put(idxSegs, indexBytes), retryOpts("PUT index.html"));
      expected.set(up.keyOf(idxSegs), indexBytes.length);
      uploaded.push({ key: up.keyOf(idxSegs), segs: idxSegs, rel: "index.html" });
      bytes += indexBytes.length;
      sentFiles++; sentBytes += indexBytes.length;
      docFiles += 1; docBytes += indexBytes.length; // index.html 属本文自有

      // 6.5 读回校验。两种做法，取往返次数更少的一种：
      //   ① 点校验：只对本次真正上传的文件逐个 sizeOf（复用没动过的运行时——
      //      它们刚在预检里确认过存在且尺寸一致，本次未写入，不可能变）。
      //      增量重发时通常只有几个文件，往返数远小于整树遍历。
      //   ② 全树遍历：上传文件很多（首次发布）时，一次递归 PROPFIND/LIST 反而更便宜。
      Progress.show(this.t("verifying"), 1);
      const dirCount = dirs.length + 1;          // 整树遍历的往返次数下界
      // FTP 的 sizeOf 走 SIZE 命令，部分服务器不支持（应答 500/502），
      // 逐点确认容易误判——FTP 继续用整树 LIST 遍历一次搞定。
      const usePoint = preOk && proto !== "ftp"
        && uploaded.length > 0 && uploaded.length <= dirCount;
      const bad = [];
      let zeroRemote = 0, zeroLocal = 0;
      let w = null;
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
      if (usePoint) {
        const chkErrs = await runPool(uploaded, async (it) => {
          const localSize = expected.get(it.key);
          let sz = -1;
          try {
            sz = await withRetry(() => up.sizeOf(it.segs), retryOpts(`SIZE ${it.rel}`));
          } catch (e) {
            bad.push(`${it.rel}: ${this.t("verifyMissing")}（${e.message || e}）`);
            return;
          }
          if (sz < 0) {
            // 服务器不报长度：退回“能读到内容”的存在性确认
            const ok = await withRetry(() => up.readBack(it.segs), retryOpts(`GET ${it.rel}`));
            if (!ok) bad.push(`${it.rel}: ${this.t("verifyMissing")}（本地 ${localSize}B）`);
          } else if (sz !== localSize) noteBad(it.key, localSize, sz);
        }, limit);
        if (chkErrs.length) throw new Error(String(chkErrs[0].message || chkErrs[0]));
      } else {
        w = await withRetry(() => up.walk(remoteSegs), retryOpts(this.t("verifying")));
        if (!w.supported) {
          // 服务器不支持目录遍历（如 PROPFIND 受限）时退回 index.html 单点校验
          const ok = await withRetry(() => up.readBack(idxSegs), retryOpts(this.t("verifying")));
          if (!ok) throw new Error(`${this.t("verifyFail")}`);
        } else {
          for (const [key, localSize] of expected) {
            const remoteSize = w.files.get(key);
            if (remoteSize === undefined) noteBad(key, localSize, undefined);
            else if (remoteSize >= 0 && remoteSize !== localSize) noteBad(key, localSize, remoteSize);
          }
        }
      }
      if (bad.length) {
        let hint = "";
        if (zeroRemote > 0 && zeroLocal === 0) {
          hint = this.t("verifyHintUpload");
        } else if (zeroLocal > 0) {
          hint = this.t("verifyHintLocal");
        }
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
        await runPool(stale, async (it) => {
          try {
            await withRetry(() => up.deleteReal(it.loc), retryOpts(`DEL ${it.key}`));
            deletedStale++;
          } catch (e) { /* 尽力而为 */ }
        }, limit);
      }

      // 6.9 改名/换目录残留清理：同一篇文档（同协议、同 merge）上一次成功发布的分段
      //     和本次不同，说明文档改名了、或本次因同名冲突改用了新目录——旧目录若不处理
      //     就永远孤立在服务器上（读者仍能访问到过期内容）。删除前先看旧目录的归属标记，
      //     确认它确实属于本文档才动手，避免误删别人的同名目录。
      let cleanedOld = 0;
      try {
        cleanedOld = await this.cleanupOldRemote(up, proto, docId, merge, remoteSegs, !!s.cleanOld);
      } catch (e) {
        console.warn("[netglimmer-publish] 旧目录清理失败（不影响本次发布）：", e.message || e);
      }

      // 7. 清理本地临时目录（尽力而为）
      await this.removeTree(files, dirs, tempDir);

      const url = up.rootDisplay(remoteSegs);
      const stamp = await this.sourceStampSettled(docId);
      const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
      // 摘要里直接说明「本次真正传了多少、复用了多少」，
      // 免得看板上的总数（含每次导出都附带的运行时）让人误判上传量。
      showMessage(this.t("publishSummaryOk")
        .replace("{url}", url)
        .replace("{sent}", String(sentFiles))
        .replace("{sentB}", this.fmtBytes(sentBytes))
        .replace("{reused}", String(reused))
        .replace("{dur}", String(secs)), 8000, "ok");
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
        time: t0, docId, docName: r.data.name || docName, url, protocol: proto, merge,
        files: expected.size, bytes, ok: true, pub: true,
        docFiles, docBytes, sentFiles, sentBytes, reused, deletedStale,
        // rootSegs：「取消发布」要靠它定位远端目录（展示地址反推不可靠：FTP/SFTP 的段
        // 是相对登录目录、本地是相对基础目录）。dirName 单独存一份供旧记录兜底。
        rootSegs: remoteSegs.slice(), dirName: remoteSegs[remoteSegs.length - 1],
        stamp,
      });
    } catch (e) {
      console.error("[netglimmer-publish]", e);
      showMessage(`${this.t("failed")}: ${e.message}`, 7000, "error");
      // 已经动过远端（建过目录/清过整树/传过文件）→ 站点此刻是“半新半旧”的，
      // 只报“失败”不够：必须明确告诉用户远端不完整，并给出补救路径。
      // touchedRemote 在建目录成功时置位，因此“传过任何文件”必然包含在内
      const partial = touchedRemote;
      if (partial) {
        showMessage(this.t("remotePartialWarn").replace("{d}", e.message), 9000, "warn");
      }
      await this.addHistory({
        time: t0, docId,
        docName: docName || "",
        url: partial ? safeRootDisplay(up, remoteSegs) : "",
        protocol: proto, merge, files: 0, bytes: 0, ok: false, pub: false,
        docFiles: 0, docBytes: 0, err: String(e.message || e),
        partial,
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
   *   - 分段与本次不同才处理；清理开关关闭或旧记录没有 rootSegs（v0.9.12 之前）就跳过；
   *   - 动手前先浅列举旧目录：只要出现别人的归属标记就不删，宁可留残留也不误删同名目录。
   * 返回清掉的旧目录数（0 或 1）。 */
  async cleanupOldRemote(up, proto, docId, merge, curSegs, cleanOld) {
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
      console.warn("[netglimmer-publish] 旧目录归属不明（存在他人的归属标记），跳过自动清理：", keyOf(prev));
      return 0;
    }
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
    Progress.show(this.t("unpublishing"));
    let up = null;
    try {
      up = makeUploader(s, { hostKeys: this.hostKeyStore() });
      this.activeUploader = up;
      await up.open();
      await withRetry(() => up.deleteTree(segs), { label: "UNPUB", tries: clampInt(s.retryTries, 1, 6, 3) });
      await this.markUnpublished(rec);
      showMessage(this.t("unpublished").replace("{d}", dirName), 5000, "ok");
      return { fail: false, segs };
    } catch (e) {
      console.error("[netglimmer-publish] unpublish", e);
      showMessage(`${this.t("unpublishFail")}: ${e.message || e}`, 7000, "error");
      return { fail: true, msg: String(e.message || e) };
    } finally {
      Progress.hide();
      if (up) { try { await up.close(); } catch (e) { /* noop */ } }
      this.activeUploader = null;
      this.busy = false;
    }
  }

  /* 记录 → 远端分段：优先用发布时存下的 rootSegs。v0.9.12 之前的旧记录没有这个字段，
   * 而只有 WebDAV 能从展示地址反推（FTP/SFTP 的分段是相对登录目录、本地是相对基础目录，
   * 地址里的绝对路径推不回分段）——推不出就提示先重新发布一次（会补上分段）。 */
  async rootSegsForRecord(rec) {
    if (Array.isArray(rec.rootSegs) && rec.rootSegs.length) return rec.rootSegs;
    const proto = rec.protocol || "webdav";
    if (proto !== "webdav" || !rec.url) return null;
    try {
      const base = new URL(this.profileFor("webdav").server);
      const u = new URL(rec.url);
      if (u.origin !== base.origin) return null; // 换过服务器，旧地址推不出正确分段
      let pth = decodeURIComponent(u.pathname.replace(/\/+$/, ""));
      const bp = base.pathname.replace(/\/+$/, "");
      if (bp && pth.startsWith(bp)) pth = pth.slice(bp.length);
      const segs = pth.split("/").filter(Boolean);
      for (const sg of segs) if (safeSeg(sg, 200) === null) return null;
      return segs.length ? segs : null;
    } catch (e) { return null; }
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
    const stillOn = (list || []).some((r) => r && r.docId === rec.docId
      && (r.pub != null ? r.pub : r.ok));
    if (!stillOn) {
      if (this.publishedMap) this.publishedMap.delete(rec.docId);
      if (this.publishedStamp) this.publishedStamp.delete(rec.docId);
      if (this.changedSet) this.changedSet.delete(rec.docId);
    }
    this.historyCache = list;
    await this.saveData(HISTORY_KEY, list);
    this.scheduleTreeDecorate();
    this.refreshChangedState(true).catch(() => {});
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

  async addHistory(rec) {
    try {
      const list = (await this.loadData(HISTORY_KEY)) || [];
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
        // 本次失败但此前成功：保留已发布地址，避免角标/打开链接丢失（远端仍是旧的已发布内容）
        if (!rec.ok && old.ok) {
          if (!rec.url && old.url) rec.url = old.url;
          if (!rec.docName && old.docName) rec.docName = old.docName;
          rec.pub = true; // 仍视为“已发布过”
        }
        list.splice(idx, 1); // 去掉旧记录，随后 unshift 新记录到顶部
      }
      list.unshift(rec);
      if (list.length > 300) list.length = 300;
      await this.saveData(HISTORY_KEY, list);
      this.historyCache = list;
    } catch (e) { console.error("[netglimmer-publish] history save", e); }
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
    const content = '<div class="vd-dash" style="padding:14px 16px;min-width:760px;max-width:92vw;"></div>';
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

  async renderDash(box, ui) {
    box.textContent = "";
    const list = await this.getHistory();
    const th = (label) => {
      const el = document.createElement("div");
      el.className = "vd-dash-th";
      el.textContent = label;
      el.style.cssText = "font-weight:600;color:var(--b3-theme-on-surface);padding:6px 8px;border-bottom:1px solid var(--b3-theme-surface-lighter);white-space:nowrap;";
      return el;
    };
    const td = () => {
      const el = document.createElement("div");
      el.style.cssText = "padding:6px 8px;border-bottom:1px solid var(--b3-theme-surface-lighter);color:var(--b3-theme-on-surface);font-size:13px;word-break:break-all;";
      return el;
    };
    const btn = (label, cls, fn) => {
      const el = document.createElement("button");
      el.className = cls || "b3-button b3-button--outline";
      el.style.cssText = "padding:2px 10px;margin:2px 4px 2px 0;font-size:12px;";
      el.textContent = label;
      el.addEventListener("click", fn);
      return el;
    };

    // 顶部工具条
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:10px;";
    bar.append(
      btn(this.t("dashRefresh"), "b3-button b3-button--outline", () => ui.refresh()),
      btn(this.t("clearHistory"), "b3-button b3-button--outline", async () => {
        if (!window.confirm(this.t("confirmClear"))) return;
        this.historyCache = [];
        await this.saveData(HISTORY_KEY, []);
        this.publishedMap = new Map();
        this.scheduleTreeDecorate();
        ui.refresh();
      }),
    );
    if (ui.showClose) bar.append(btn(this.t("dashClose"), "b3-button b3-button--outline", () => ui.close()));
    box.append(bar);

    if (!list.length) {
      const empty = document.createElement("div");
      empty.textContent = this.t("dashEmpty");
      empty.style.cssText = "padding:24px 0;color:var(--b3-theme-on-surface-light);text-align:center;";
      box.append(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:118px minmax(150px,1.3fr) 74px 60px minmax(190px,1.7fr) 150px 260px;overflow:auto;max-height:calc(100vh - 220px);";
    grid.append(
      th(this.t("colTime")), th(this.t("colDoc")), th(this.t("colProto")),
      th(this.t("colStatus")), th(this.t("colDetail")), th(this.t("colChanged")), th(this.t("colAction")),
    );

    const checks = []; // 打开看板后批量自动比对改动的行
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
      box.append(sum);
    }

    for (const rec of list) {
      const c1 = td(); c1.textContent = this.fmtTime(rec.time); c1.style.whiteSpace = "nowrap";
      const c2 = td(); c2.textContent = rec.docName || rec.docId || "";
      if (rec.merge) {
        const tag = document.createElement("span");
        tag.textContent = this.t("dashMergeTag");
        tag.style.cssText = "color:var(--b3-theme-on-surface-light);font-size:11px;";
        c2.append(tag);
      }
      const c3 = td(); c3.textContent = (rec.protocol || "webdav").toUpperCase(); c3.style.whiteSpace = "nowrap";
      const c4 = td();
      if (rec.ok && rec.unpub) {
        c4.textContent = this.t("stUnpub");
        c4.style.color = "var(--b3-theme-on-surface-light)";
        c4.style.fontWeight = "600";
      } else {
        c4.textContent = rec.ok ? this.t("stOk") : this.t("stFail");
        c4.style.color = rec.ok ? "var(--b3-theme-primary)" : "var(--b3-theme-error)";
        c4.style.fontWeight = "600";
      }
      const c5 = td();
      if (rec.ok) {
        // 主数字：本文自有文件（不含每次导出都附带的 stage/appearance 运行时），
        // 旧记录没有 docFiles 字段时回退到总数。悬浮显示含运行时的完整上传数。
        const shown = rec.docFiles != null ? rec.docFiles : (rec.files || 0);
        const shownBytes = rec.docBytes != null ? rec.docBytes : (rec.bytes || 0);
        c5.textContent = `${shown} ${this.t("files")} · ${this.fmtBytes(shownBytes)}`;
        if (rec.docFiles != null && rec.files) {
          let tip = this.t("dashDocFilesTip")
            .replace("{n}", String(rec.files)).replace("{b}", this.fmtBytes(rec.bytes || 0));
          if (rec.reused) {
            tip += "\n" + this.t("dashReusedTip").replace("{n}", String(rec.reused));
          }
          c5.title = tip;
        }
        if (rec.url) {
          c5.append(document.createTextNode(" "));
          if (/^https?:/i.test(rec.url)) {
            c5.append(btn(this.t("openLink"), "b3-button b3-button--outline", () => window.open(rec.url)));
          }
          c5.append(btn(this.t("copyLink"), "b3-button b3-button--outline", async () => {
            const okCopy = await copyText(rec.url);
            showMessage(okCopy ? this.t("copied") : this.t("copyFail"), 2000, okCopy ? "info" : "error");
          }));
        }
      } else {
        c5.textContent = rec.err || "";
        c5.style.color = "var(--b3-theme-error)";
      }
      // 改动列：徽章 + 检测按钮
      const c6 = td();
      const badge = document.createElement("span");
      badge.style.cssText = "font-size:12px;";
      const setBadge = (text, color, tip) => {
        badge.textContent = text;
        badge.style.color = color || "var(--b3-theme-on-surface-light)";
        if (tip) badge.title = tip;
      };
      if (!rec.ok) setBadge("—");
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
      const c7 = td();
      if (rec.docId) {
        const targetProto = (rec.protocol || "").trim();
        const b = btn(rec.ok ? this.t("rePublish") : this.t("retryFailed"), "b3-button", () => {
          if (ui.closeOnPublish) ui.close();
          const p = this.publish(rec.docId, !!rec.merge,
            targetProto ? { proto: targetProto } : undefined);
          if (p && typeof p.then === "function") p.then(() => { try { ui.refresh(); } catch (e) {} }).catch(() => {});
        });
        b.title = this.t("republishTip").replace("{p}", (targetProto || this.t("currentProto")).toUpperCase());
        c7.append(b);
        if (rec.ok) {
          const d = btn(this.t("dryRun"), "b3-button b3-button--outline", () => {
            const p = this.publish(rec.docId, !!rec.merge,
              Object.assign({ dryRun: true }, targetProto ? { proto: targetProto } : {}));
            if (p && typeof p.then === "function") p.then(() => { try { ui.refresh(); } catch (e) {} }).catch(() => {});
          });
          d.title = this.t("dryRunTip");
          c7.append(d);
        }
        if (rec.ok && !rec.unpub) {
          const u = btn(this.t("unpublish"), "b3-button b3-button--outline", () => {
            const p = this.unpublish(rec);
            if (p && typeof p.then === "function") p.then(() => { try { ui.refresh(); } catch (e) {} }).catch(() => {});
          });
          u.title = this.t("unpublishTip");
          c7.append(u);
        }
      }
      grid.append(c1, c2, c3, c4, c5, c6, c7);
      if (rec.ok && rec.docId) checks.push({ rec, setBadge });
    }
    box.append(grid);

    // 打开看板即批量比对「发布后是否有改动」：一条 SQL 拿全部指纹，
    // 用户不必逐行点「检测」。行内的手动按钮仍保留（强制重算单行）。
    if (checks.length) {
      try {
        const cur = await this.stampsFor(checks.map((c) => c.rec.docId));
        for (const c of checks) {
          const s = cur.get(String(c.rec.docId));
          if (!s) c.setBadge(this.t("changedUnknown"), "var(--b3-theme-on-surface-light)");
          else if (this.constructor.stampEqual(c.rec.stamp, s)) {
            c.setBadge(this.t("unchanged"), "var(--b3-theme-primary)", this.t("changedTipOff"));
          } else {
            c.setBadge(this.t("changed"), "var(--b3-theme-error)", this.t("changedTipOn"));
          }
        }
      } catch (e) { /* 比对失败保持“未检测”，不影响看板主体 */ }
    }
  }
}

module.exports = WebDAVPublishPlugin;
module.exports.default = WebDAVPublishPlugin;
/* 供 node 端回归测试直接引用内部实现（运行时不产生任何副作用） */
module.exports._internals = {
  FtpSession, SshSession, parseList, normalizeKey, walkRemoteFiles,
  makeUploader, WebdavUploader, FtpUploader, SftpUploader, LocalUploader,
  injectToc, TOC_PAYLOAD, TOC_MARKER,
  // 传输容错内部实现（重试/并发），供 node 端回归直接断言
  runPool, withRetry, isTransientError, isConnLostError, concurrencyFor,
};
