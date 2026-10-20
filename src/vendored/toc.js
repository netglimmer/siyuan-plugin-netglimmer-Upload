/* 本文件由 build.js 拼回 index.js —— 发布产物依然是单个 index.js，运行时不做任何 import。
 * 抽离理由：这一段是「逐字移植的思源前端代码 / 固定注入数据」，放在主文件里会把每次
 * grep 和代码审阅都污染掉（index-html 段里还有若干 10 万字符级的超长行）。
 * 维护约定：
 *  1) 把它当第三方 vendored 代码对待，不要顺手“顺手优化格式”。
 *  2) 若要同步官方实现，先在思源里手动导出一次「HTML (SiYuan)」做对照，
 *     改完必须让 build.js --verify 与 run-multi/run.js 的全量字节校验都通过。
 *  3) 分隔行（SEGMENT-BEGIN）之后到文件末尾的内容会被原样拼回，
 *     行首行尾不要增删空行——build.js --verify 依赖字节级还原。
 */
/* @@SEGMENT-BEGIN@@ */
/* ---------------- 侧边大纲注入（随导出页一起上传的零依赖载荷） ----------------
 * 发布出去的页面在原「右侧固定悬浮大纲」上有这几件事：
 *   ① 可拖拽调宽度：拖面板靠正文那一侧的内边缘改宽度；长标题可换行，
 *      配合拖宽就能完整看到，不再被省略号截断。
 *   ② 停靠左右两侧可切，默认靠左；body 外边距随停靠边与宽度实时联动。
 *      （只有左/右两种：一条横带的目录读起来不适用，所以位置按钮就是 ◧/◨ 两个。）
 *   ③ 目录折叠展开：条目左侧三角折/展它自己的整棵子树（用栈按层级求父，跳级的 h4 也归到
 *      最近的浅层标题下）；标题栏的 ⊟/⊞ 一键折叠全部/展开全部；滚动定位时先展开命中项的
 *      祖先链，保证当前标题永远在目录里看得见。
 * 位置与宽度写进 localStorage（键 netglimmer-toc-*，同源共享），读者设一次全站生效。
 * 另有四处按读者反馈做的修正（都只改注入出去的页面）：
 *   ④ 正文居中：让位从「正文 margin」改成「body padding」——导出页正文是
 *      <div id="preview" style="max-width:800px;margin:0 auto">，用 !important 的 margin-left
 *      顶掉 auto 会让正文紧贴大纲、另一侧大片空白；让位放在 body 上，正文的 margin:0 auto
 *      才真的在剩余空间里居中。
 *   ⑤ 滚动条可见：视口与大纲内部各给一套宽度与实色滑块（含深色主题）。
 *   ⑥ 把手不再抢滚动条：.toc-scroll 按停靠方向让开把手那一条，并把把手做成常驻可见的小胶囊。
 *   ⑦ 折叠三角放大到 13px、加深、hover 有底色；拖动期间关掉 margin/padding 过渡（跟手）。
 * 再补一件导出页本来没有的事：
 *   ⑧ 图片点击放大：思源导出的静态 index.html 只绑了渲染函数（高亮/公式/mermaid…）和代码块复制按钮，
 *      没有任何看图遮罩，所以正文图片点了本来就没反应。注入层里补一个零依赖的 #toc-img-viewer：
 *      点图打开、滚轮或 −/1:1/＋ 缩放（夹在 1~6 倍：导出页的图本来就已按视口宽度缩过，不让你缩成邮票）、拖拽平移、✕ / 点图外空白 / Esc 关闭。
 *      图片自己包着 <a> 时不抢手势（让链接照常跳转）。
 * 移动端适配（读者用手机看发布出去的页面）：
 *   ⑨ 大纲在窄视口（≤760px）变抽屉：桌面端那套「让位 = body 左内边距 300+40px」在 390px 宽的
 *      手机上会把正文挤没，还顶出横向滚动条。手机上正文满幅，大纲从停靠那侧滑出盖上去，
 *      遮罩/悬浮按钮/再点一次都能关；抽屉开合不落盘（手机每次进来先看到正文），
 *      桌面端的 netglimmer-toc-hidden 偏好不会被手机上的一次点击改写。
 *   ⑩ 触摸：灯箱双指缩放、单指平移、双击在 1:1 与 2.5 倍之间切换，条目/三角/工具按钮放大到
 *      够按；把手在手机上收掉（宽度已由视口决定，10px 的把手只会跟滚动手势打架）。
 *   ⑪ 防横向溢出：导出页正文 max-width:800px 本身不溢出，溢出的是让位内边距与超长词，
 *      前者由 ⑨ 收回 12px，后者 overflow-wrap 断词，兜底那条 overflow-x 只能写在 html 上。
 * 仍保留 alex_add_toc 标记（run-multi 断言它存在）、滚动高亮、明暗主题、显示/隐藏按钮。
 * 注意：整段在一个反引号模板字符串里，脚本内一律用字符串拼接，不出现反引号与 ${，
 *      否则会把外层模板字面量截断（build 拼回后就是语法错误）。
 * 注意：隐藏条目用 .toc-hidden-row 类而不是 li.style.display="none"——
 *      .toc-item{display:flex!important} 是作者样式表的 !important，会压过普通内联样式，
 *      真浏览器里内联 display:none 折叠不上（run-toc 的 DOM 桩也不会暴露这一点）。
 */

const TOC_MARKER = "<!--alex_add_toc-->";
const TOC_PAYLOAD = `
<!--alex_add_toc-->
<style>
    html { scroll-behavior: smooth; }
    #preview .h1, #preview .h2, #preview .h3, #preview .h4, #preview .h5, #preview .h6 {
        scroll-margin-top: 40px !important;
    }

    /* 正文与大纲面板：尺寸只读 --toc-w（JS 里拖内边缘改宽度），
       带 var(...,默认) 兜底，脚本尚未跑起来时也不会塌版。
       让位用 body 的 padding 而不是正文的 margin：导出页正文是
       <div id="preview" style="max-width:800px;margin:0 auto">，margin:0 auto 才是「在剩余
       空间里居中」；一旦像以前那样给它 margin-left: 大纲宽 + margin-right: 40px，两个 !important
       会把 auto 顶掉，正文就贴着大纲一侧、另一侧大片空白。 */
    body { transition: padding .18s ease; }
    #preview, .protyle-wysiwyg { margin-left: auto !important; margin-right: auto !important; }
    body.toc-left   { padding-left: calc(var(--toc-w, 300px) + 40px) !important; padding-right: 24px !important; }
    body.toc-right  { padding-right: calc(var(--toc-w, 300px) + 40px) !important; padding-left: 24px !important; }
    body.toc-hidden { padding-left: 24px !important; padding-right: 24px !important; }
    /* 拖拽进行中不要跟过渡动画较劲，否则把手明显不跟手 */
    body.toc-dragging, body.toc-dragging #preview, body.toc-dragging .protyle-wysiwyg { transition: none !important; }

    #custom-toc {
        position: fixed !important;
        display: flex !important;
        flex-direction: column !important;
        background-color: #ffffff !important;
        border: 1px solid #e0e0e0 !important;
        border-radius: 8px !important;
        box-shadow: 0 4px 12px rgba(0,0,0,0.08) !important;
        z-index: 999999 !important;
        font-family: sans-serif !important;
        overflow: hidden !important;
        padding: 0 !important;
        transition: opacity .25s ease, transform .25s ease;
    }
    body.toc-left   #custom-toc { top: 20px; bottom: 20px; left: 20px;  width: var(--toc-w, 300px); }
    body.toc-right  #custom-toc { top: 20px; bottom: 20px; right: 20px; width: var(--toc-w, 300px); }

    /* 隐藏：沿停靠方向滑出屏幕并淡出（transform 方向随左右切换而不同） */
    #custom-toc.hidden { opacity: 0 !important; pointer-events: none !important; }
    body.toc-left   #custom-toc.hidden { transform: translateX(calc(-1 * (var(--toc-w, 300px) + 40px))) !important; }
    body.toc-right  #custom-toc.hidden { transform: translateX(calc(var(--toc-w, 300px) + 40px)) !important; }

    /* 拖拽调尺寸的把手：贴在面板靠正文那一侧的内边缘。
       中间那条小竖胶囊是常驻可见的「可拖」提示（原来整条透明，没人知道能拖）。 */
    .toc-resizer { position: absolute !important; z-index: 3 !important; background: transparent !important; }
    .toc-resizer::after {
        content: "" !important; position: absolute !important; left: 50% !important; top: 50% !important;
        transform: translate(-50%, -50%) !important; width: 3px !important; height: 30px !important;
        border-radius: 2px !important; background: #cfcfcf !important; transition: background .15s ease;
    }
    .toc-resizer:hover, .toc-resizer.dragging { background: rgba(0,120,212,0.22) !important; }
    .toc-resizer:hover::after, .toc-resizer.dragging::after { background: #0078d4 !important; }
    body.toc-left   .toc-resizer { top: 0; right: 0;  bottom: 0;  width: 10px; cursor: ew-resize !important; touch-action: none !important; }
    body.toc-right  .toc-resizer { top: 0; left: 0;   bottom: 0;  width: 10px; cursor: ew-resize !important; touch-action: none !important; }
    /* 滚动区让开把手那一条：不然靠左时大纲自己的竖向滚动条正好落在把手下面，
       想滚目录结果按住了把手（把手 z-index 更高，会把滚动条的拖动手势抢走）。 */
    body.toc-left   .toc-scroll { margin-right: 14px !important; }
    body.toc-right  .toc-scroll { margin-left: 14px !important; }

    .toc-header {
        flex: 0 0 auto !important;
        display: flex !important; align-items: center !important; justify-content: space-between !important; gap: 8px !important;
        padding: 8px 10px !important; border-bottom: 1px solid #e0e0e0 !important;
    }
    .toc-title { font-size: 14px !important; font-weight: 600 !important; color: #888 !important; white-space: nowrap !important; }
    .toc-pos { display: flex !important; gap: 3px !important; }
    .toc-pos button {
        all: unset !important; cursor: pointer !important; font-size: 13px !important; line-height: 1 !important;
        width: 22px !important; height: 22px !important; border-radius: 4px !important; text-align: center !important;
        color: #666 !important; background: #f2f2f2 !important;
    }
    .toc-pos button:hover { background: #e2ecf7 !important; color: #0078d4 !important; }
    .toc-pos button.on { background: #0078d4 !important; color: #fff !important; }
    .toc-foldall {
        all: unset !important; cursor: pointer !important; font-size: 14px !important; line-height: 1 !important;
        width: 22px !important; height: 22px !important; border-radius: 4px !important; text-align: center !important;
        color: #666 !important; background: #f2f2f2 !important; flex: 0 0 auto !important;
    }
    .toc-foldall:hover { background: #e2ecf7 !important; color: #0078d4 !important; }
    .toc-head-l { display: flex !important; align-items: center !important; gap: 6px !important; }

    .toc-scroll { flex: 1 1 auto !important; overflow: auto !important; padding: 10px 12px !important; }
    .toc-list { list-style: none !important; padding: 0 !important; margin: 0 !important; }
    /* 每个条目 = [折叠三角][标题链接]，横向 flex；缩进放在条目本身，三角与文字才对齐 */
    .toc-item { display: flex !important; align-items: flex-start !important; margin: 4px 0 !important; line-height: 1.4 !important; }
    /* 折叠时被隐藏的条目。必须是类而不是 li.style.display="none"：
       上面那条 display:flex 带 !important，作者样式表的 !important 会压过普通内联样式，
       真浏览器里内联 display:none 会被它覆盖掉（桩测不出这个坑）。 */
    .toc-item.toc-hidden-row { display: none !important; }
    /* 折叠三角：13px、够深的灰、hover 有底色小块——10px 浅灰的 ▾ 在页面上几乎看不见 */
    .toc-caret {
        flex: 0 0 18px !important; width: 18px !important; height: 22px !important; line-height: 22px !important;
        text-align: center !important; font-size: 13px !important; color: #5f6368 !important;
        cursor: pointer !important; user-select: none !important; transform: rotate(0deg) !important;
        border-radius: 4px !important; transition: transform .15s ease, background .15s ease, color .15s ease;
    }
    .toc-caret:hover { color: #0078d4 !important; background: #e8f1fb !important; }
    .toc-caret.leaf { visibility: hidden !important; cursor: default !important; }  /* 无子项也占位，标题左对齐 */
    .toc-item.collapsed > .toc-caret { transform: rotate(-90deg) !important; }
    .toc-item a {
        flex: 1 1 auto !important; min-width: 0 !important;
        color: #444 !important; text-decoration: none !important; font-size: 13px !important;
        display: block !important; padding: 4px 6px 4px 4px !important; border-radius: 4px !important;
        white-space: normal !important; word-break: break-word !important;
        border-left: 2px solid transparent !important; transition: all .2s ease;
    }
    .toc-item a:hover { background-color: #f0f0f0 !important; color: #0078d4 !important; }
    .toc-item a.active { color: #0078d4 !important; font-weight: bold !important; background-color: #f0f7ff !important; border-left-color: #0078d4 !important; }
    .toc-h1 { padding-left: 0px !important; }
    .toc-h1 > a { font-weight: bold !important; }
    .toc-h2 { padding-left: 12px !important; }
    .toc-h2 > a { font-weight: bold !important; }
    .toc-h3 { padding-left: 24px !important; }
    .toc-h4 { padding-left: 36px !important; }
    .toc-h5 { padding-left: 48px !important; }
    .toc-h6 { padding-left: 60px !important; }

    #toc-toggle-btn {
        position: fixed !important; right: 25px !important; bottom: 40px !important;
        width: 48px !important; height: 48px !important; background-color: #0078d4 !important; color: #ffffff !important;
        border-radius: 50% !important; display: flex !important; align-items: center !important; justify-content: center !important;
        cursor: pointer !important; box-shadow: 0 4px 10px rgba(0,0,0,0.2) !important; z-index: 9999999 !important;
        font-size: 20px !important; transition: all 0.3s ease; user-select: none !important;
    }
    #toc-toggle-btn:hover { background-color: #005a9e !important; transform: scale(1.05); }
    #toc-toggle-btn.active { background-color: #717171 !important; }

    /* ---------------- 移动端（窄视口 ≤ 760px，由脚本挂 body.toc-mobile / html.toc-mobile） ----------------
       ⑨ 大纲变抽屉：桌面端「让位」= body 左内边距 大纲宽 + 40px，在 390px 宽的手机上会把正文挤成
          一条缝并顶出横向滚动条。窄视口下正文满幅（让位收回 12px），大纲从停靠那侧滑出、盖在正文上，
          遮罩（#toc-scrim）/再点悬浮按钮/◧◨ 都能关。
       选择器一律写成 body.toc-mobile.toc-left 这种双类形式：与 body.toc-left 同为 !important 时
       「谁写在后面谁赢」太脆，特异性 (0,2,1) 压 (0,1,1) 才不依赖顺序。
       toc-mobile 同时挂在 html 上：横向溢出的兜底 overflow-x 只能写在 html——视口的横向滚动归 html，
       写在 body 上会把 body 变成第二个滚动容器（滚动位置、sticky 都跟着错位）。 */
    body.toc-mobile.toc-left, body.toc-mobile.toc-right, body.toc-mobile.toc-hidden {
        padding-left: 12px !important; padding-right: 12px !important;
        padding-bottom: 78px !important;   /* 最后几行别压在悬浮那颗 📋 底下（拇指正好落在那儿） */
    }
    html.toc-mobile { overflow-x: hidden !important; }
    body.toc-mobile #custom-toc {
        top: 0 !important; bottom: 0 !important; border: 0 !important; border-radius: 0 !important;
        /* 尊重读者在桌面上拖出来的宽度，但不超过视口的 86%：手机上大纲不该吃掉整屏 */
        width: min(var(--toc-w, 300px), 86vw) !important;
        box-shadow: 0 0 34px rgba(0,0,0,0.34) !important;
    }
    body.toc-mobile.toc-left  #custom-toc { left: 0 !important; right: auto !important; }
    body.toc-mobile.toc-right #custom-toc { right: 0 !important; left: auto !important; }
    /* 关闭 = 整扇滑出本边（用百分比，宽度是 min() 算出来的，不能再拿 --toc-w 去减） */
    body.toc-mobile.toc-left  #custom-toc.hidden { transform: translateX(-101%) !important; }
    body.toc-mobile.toc-right #custom-toc.hidden { transform: translateX(101%) !important; }

    /* 抽屉背后的遮罩：常驻一个透明、不吃点击的全屏层，只有窄视口且抽屉开着才显形并接点击。
       不用 display 切换——display:none → block 之间过渡跑不起来，遮罩会硬闪一下。
       层级夹在正文（<999999）与大纲面板（999999）之间，悬浮按钮（9999999）仍在遮罩之上，
       所以抽屉开着时点 📋 也能关。 */
    #toc-scrim {
        position: fixed !important; top: 0 !important; right: 0 !important; bottom: 0 !important; left: 0 !important;
        background: rgba(0, 0, 0, 0.38) !important; z-index: 999998 !important;
        opacity: 0 !important; pointer-events: none !important; transition: opacity .2s ease;
    }
    body.toc-mobile #toc-scrim.on { opacity: 1 !important; pointer-events: auto !important; }

    /* 够按：手指的落点半径远大于鼠标，22px 的三角和位置按钮在手机上基本按不中 */
    body.toc-mobile .toc-pos button, body.toc-mobile .toc-foldall {
        width: 30px !important; height: 30px !important; font-size: 16px !important;
    }
    body.toc-mobile .toc-header { padding: 10px 12px !important; }
    body.toc-mobile .toc-caret {
        flex: 0 0 26px !important; width: 26px !important; height: 32px !important;
        line-height: 32px !important; font-size: 15px !important;
    }
    body.toc-mobile .toc-item a { padding: 8px 6px 8px 4px !important; font-size: 14px !important; }
    /* 把手收掉：抽屉宽度已由视口决定，10px 的把手横在大纲内边缘只会抢滚动手势 */
    body.toc-mobile .toc-resizer { display: none !important; }
    body.toc-mobile .toc-scroll {
        margin-left: 0 !important; margin-right: 0 !important; padding-bottom: 18px !important;
        overscroll-behavior: contain !important;   /* 目录滚到头不带动正文 */
    }
    body.toc-mobile #toc-toggle-btn {
        right: 14px !important; bottom: 18px !important; width: 46px !important; height: 46px !important;
    }
    /* 长词（长 URL、无空格的拼音串）断行：导出页正文 max-width:800px 不会自己溢出，
       顶出横向滚动条的通常是这种不肯断的整词 */
    body.toc-mobile #preview, body.toc-mobile .protyle-wysiwyg { overflow-wrap: break-word !important; }
    body.toc-mobile #preview img, body.toc-mobile .protyle-wysiwyg img { max-width: 100% !important; }

    /* 滚动条：导出页什么都不写，Windows/Chrome 下就是那条细到找不着的默认滚动条，
       读者既看不出页面能滚、也找不到大纲内部的滚动条。统一加粗并给出可见滑块。
       视口滚动条挂在 html 上（要 html[...]::-webkit-…，带空格只能命中后代滚动区），
       所以深色那组两个选择器都要写。 */
    html { scrollbar-color: #b8bdc4 #f2f3f5; scrollbar-width: auto; }
    ::-webkit-scrollbar { width: 14px !important; height: 14px !important; }
    ::-webkit-scrollbar-track { background: #f2f3f5 !important; }
    ::-webkit-scrollbar-thumb {
        background: #b8bdc4 !important; border: 3px solid transparent !important;
        background-clip: content-box !important; border-radius: 8px !important;
    }
    /* background 简写会把 background-clip 打回 border-box，所以每条改 background 的规则都要重带 clip */
    ::-webkit-scrollbar-thumb:hover { background: #8f959c !important; background-clip: content-box !important; }
    ::-webkit-scrollbar-corner { background: #f2f3f5 !important; }
    .toc-scroll::-webkit-scrollbar { width: 10px !important; height: 10px !important; }
    .toc-scroll::-webkit-scrollbar-thumb { border-width: 2px !important; }
    html[data-theme-mode="dark"] { scrollbar-color: #4b4b55 #17171a; }
    [data-theme-mode="dark"] ::-webkit-scrollbar-track,
    html[data-theme-mode="dark"]::-webkit-scrollbar-track { background: #17171a !important; }
    [data-theme-mode="dark"] ::-webkit-scrollbar-thumb,
    html[data-theme-mode="dark"]::-webkit-scrollbar-thumb { background: #4b4b55 !important; background-clip: content-box !important; }
    [data-theme-mode="dark"] ::-webkit-scrollbar-thumb:hover,
    html[data-theme-mode="dark"]::-webkit-scrollbar-thumb:hover { background: #6d6d78 !important; background-clip: content-box !important; }
    [data-theme-mode="dark"] ::-webkit-scrollbar-corner,
    html[data-theme-mode="dark"]::-webkit-scrollbar-corner { background: #17171a !important; }

    [data-theme-mode="dark"] #custom-toc { background-color: #1e1e22 !important; border-color: #2a2a2e !important; box-shadow: 0 4px 12px rgba(0,0,0,0.5) !important; }
    [data-theme-mode="dark"] .toc-header { border-bottom-color: #2a2a2e !important; }
    [data-theme-mode="dark"] .toc-title { color: #b0b0b5 !important; }
    [data-theme-mode="dark"] .toc-item a { color: #d0d0d5 !important; }
    [data-theme-mode="dark"] .toc-item a:hover { background-color: #2a2a2e !important; color: #4ec9b0 !important; }
    [data-theme-mode="dark"] .toc-item a.active { color: #4ec9b0 !important; background-color: #1d2d2a !important; border-left-color: #4ec9b0 !important; }
    [data-theme-mode="dark"] .toc-pos button { background: #2a2a2e !important; color: #cfcfcf !important; }
    [data-theme-mode="dark"] .toc-pos button.on { background: #4ec9b0 !important; color: #1e1e22 !important; }
    [data-theme-mode="dark"] .toc-foldall { background: #2a2a2e !important; color: #cfcfcf !important; }
    [data-theme-mode="dark"] .toc-foldall:hover { background: #1d2d2a !important; color: #4ec9b0 !important; }
    [data-theme-mode="dark"] .toc-caret { color: #b6b6bd !important; }
    [data-theme-mode="dark"] .toc-caret:hover { color: #4ec9b0 !important; background: #23302e !important; }
    [data-theme-mode="dark"] .toc-resizer::after { background: #4a4a52 !important; }
    [data-theme-mode="dark"] .toc-resizer:hover::after, [data-theme-mode="dark"] .toc-resizer.dragging::after { background: #4ec9b0 !important; }
    [data-theme-mode="dark"] .toc-caret:hover { color: #4ec9b0 !important; }
    [data-theme-mode="dark"] .toc-resizer:hover, [data-theme-mode="dark"] .toc-resizer.dragging { background: rgba(78,201,176,0.28) !important; }
    [data-theme-mode="dark"] #toc-toggle-btn { background-color: #4ec9b0 !important; color: #1e1e22 !important; }
    [data-theme-mode="dark"] #toc-toggle-btn.active { background-color: #3a3a3e !important; color: #aaaaaa !important; }

    /* 图片点击放大：思源导出的静态页只挂了渲染函数（高亮/公式/图表…）和代码块复制按钮，
       没有任何看图遮罩，所以正文里的图片点了没反应——这是导出页本身的缺省，不是发布链路的 bug。
       这里补一个零依赖的查看器：点图片放大、滚轮或按钮缩放、放大后可拖动平移、✕ / 点空白 / Esc 关闭。
       遮罩必须压过大纲（999999）与悬浮按钮（9999999），所以 z-index 再往上一档。 */
    /* 光标这条同时挂 #preview 与 .protyle-wysiwyg：导出页两个容器是同一个元素，
       但正文绑定时脚本走的是「先 #preview，找不到再退到 .protyle-wysiwyg」，CSS 也跟这个顺序覆盖全。 */
    #preview img, .protyle-wysiwyg img { cursor: zoom-in !important; }
    #toc-img-viewer {
        position: fixed !important; top: 0 !important; right: 0 !important; bottom: 0 !important; left: 0 !important;
        z-index: 10000000 !important; display: none !important;
        align-items: center !important; justify-content: center !important;
        background: rgba(0, 0, 0, 0.82) !important; overflow: hidden !important;
    }
    #toc-img-viewer.open { display: flex !important; }
    /* 打开时才给阴影与白底（关掉时 display:none，本来也不占地方）。
       注意这里**不能**给 transform 写 !important：缩放平移是脚本用内联 style.transform 落的，
       而作者样式表的 !important 压得过普通内联声明（本文件上面折叠条目那条坑就是它），
       一旦在这里带 !important，图就永远停在 scale(1)。transform-origin 没有冲突，留着。 */
    #toc-img-viewer img {
        max-width: 92vw !important; max-height: 86vh !important; background: #fff !important;
        box-shadow: 0 8px 40px rgba(0,0,0,0.45) !important; cursor: grab !important;
        transform-origin: center center !important;
        /* 手机上单指拖动默认被浏览器当成页面滚动，pointermove 直接取消给 pointercancel，
           平移与双指缩放就都收不到事件——touch-action: none 只作用在遮罩里这张放大的图上，
           正文里的图片照常跟随页面滚动。 */
        touch-action: none !important;
    }
    #toc-img-viewer img.toc-lb-grabbing { cursor: grabbing !important; }
    /* 窄视口下灯箱：图让开顶部那排按钮（按钮压在图上就按不到），按钮放大到够按，
       提示语挪到底部——顶部右上角挤着四颗按钮，再放一行字就没地方放了。
       提示文字内容由脚本按视口宽度换成「双指缩放 · 拖动平移 · 点空白关闭」。 */
    body.toc-mobile #toc-img-viewer img { max-width: 100vw !important; max-height: 72vh !important; }
    body.toc-mobile .toc-img-bar { top: 10px !important; right: 12px !important; gap: 4px !important; }
    body.toc-mobile .toc-img-bar button {
        min-width: 42px !important; height: 42px !important; line-height: 42px !important; font-size: 17px !important;
    }
    body.toc-mobile .toc-img-tip {
        top: auto !important; bottom: 16px !important; left: 50% !important;
        transform: translateX(-50%) !important; font-size: 11px !important; white-space: nowrap !important;
    }
    .toc-img-bar {
        position: absolute !important; top: 16px !important; right: 20px !important;
        display: flex !important; gap: 6px !important; z-index: 1 !important;
    }
    .toc-img-bar button {
        all: unset !important; cursor: pointer !important; font-size: 14px !important; line-height: 30px !important;
        min-width: 32px !important; height: 30px !important; padding: 0 8px !important; box-sizing: border-box !important;
        text-align: center !important; border-radius: 6px !important;
        color: #eee !important; background: rgba(255,255,255,0.14) !important;
    }
    .toc-img-bar button:hover { background: rgba(255,255,255,0.3) !important; }
    .toc-img-tip {
        position: absolute !important; left: 20px !important; top: 22px !important;
        font-size: 12px !important; color: #cfcfcf !important; user-select: none !important;
    }
</style>

<div id="custom-toc">
    <div class="toc-header">
        <span class="toc-head-l">
            <span class="toc-foldall" id="toc-foldall-btn" title="折叠 / 展开全部"
                  role="button" tabindex="0" aria-label="折叠 / 展开全部大纲">⊟</span>
            <span class="toc-title">📋 文章大纲</span>
        </span>
        <span class="toc-pos" role="group" title="大纲位置（默认靠左）">
            <button data-set="left"   title="靠左">◧</button>
            <button data-set="right"  title="靠右">◨</button>
        </span>
    </div>
    <div class="toc-scroll"><ul id="toc-list-container" class="toc-list"></ul></div>
    <div class="toc-resizer" title="拖拽调整大纲宽度"></div>
</div>

<div id="toc-scrim"></div>
<div id="toc-toggle-btn" title="显示/隐藏大纲" role="button" tabindex="0"
     aria-controls="custom-toc" aria-expanded="true" aria-label="显示 / 隐藏文章大纲">📋</div>

<div id="toc-img-viewer" role="dialog" aria-modal="true" aria-label="图片预览">
    <div class="toc-img-tip" id="toc-img-tip">滚轮缩放 · 拖拽平移 · Esc 关闭</div>
    <div class="toc-img-bar">
        <button data-vact="out" title="缩小">−</button>
        <button data-vact="fit" title="实际大小">1:1</button>
        <button data-vact="in" title="放大">＋</button>
        <button data-vact="close" title="关闭">✕</button>
    </div>
    <img id="toc-img-box" alt="" />
</div>

<script>
    (function() {
        /* 正文里可能自己就有一个叫 custom-toc 的元素——有人把导出页源码当样例贴进笔记，
           撞 id 完全可能。getElementById 返回文档顺序第一个，于是脚本会绑到读者那段正文上：
           .toc-resizer 取不到 → 下面第一句就抛 TypeError，大纲 0 行、body 让位 0px、
           灯箱也没绑，页面还多出一个没定位的白盒子（比整块不注入更难看）。
           载荷是整页拼完之后追加在文末的，所以「我们那几个节点」必然在正文容器之外：
           命中的那个若落在 #preview 里面，就换成正文之外的那一个。 */
        function pick(id) {
            var el = document.getElementById(id);
            if (!el) return null;
            var art = document.getElementById("preview") || document.querySelector(".protyle-wysiwyg");
            if (!art || !art.contains || !art.contains(el)) return el;
            var all = document.querySelectorAll("#" + id);
            for (var i = 0; i < all.length; i++) if (!art.contains(all[i])) return all[i];
            return el;
        }
        var panel = pick("custom-toc");
        var toggleBtn = pick("toc-toggle-btn");
        var scrim = pick("toc-scrim");
        if (!panel) return;
        var resizer = panel.querySelector(".toc-resizer");
        if (!resizer) return;   // 面板不是我们那一个：整体退出，不留下半套绑定的界面
        var posBtns = panel.querySelectorAll(".toc-pos button");
        var body = document.body;
        var html = document.documentElement || body;   /* 溢出兜底那条写在 html 上，类得两边都挂 */
        var LS = { pos: "netglimmer-toc-pos", w: "netglimmer-toc-w", hidden: "netglimmer-toc-hidden" };

        /* 窄视口的判据用 window.innerWidth，不用 matchMedia：一是发布出去的页面里 matchMedia
           在老 WebView 上不保证，二是这套逻辑本来就得跟着 resize 重算宽度，同一个入口最省事。
           拿不到宽度（0）时按桌面处理——让位那套是读者熟悉的样子，抽屉是窄屏才需要的补救。 */
        var NARROW = 760;
        function isNarrow() {
            var vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
            return vw > 0 && vw <= NARROW;
        }
        /* 抽屉开合不落盘：手机上「进来先看到正文」是唯一合理的默认，
           而 netglimmer-toc-hidden 存的是桌面端偏好，被手机上的一次点击改写后，
           读者回到电脑上就会发现大纲莫名其妙不见了。 */
        var mopen = false;

        function num(v, d, lo, hi) {
            v = parseInt(v, 10);
            if (isNaN(v)) v = d;
            return Math.max(lo, Math.min(hi, v));
        }
        function maxW() { return Math.max(220, Math.floor(window.innerWidth * 0.6)); }

        /* 只认左/右：localStorage 是读者可改的任意文本，无效值一律退回默认靠左，
           绝不让 body 上出现「没有位置类」的中间态（那样面板会悬在没人让开的位置上）。 */
        var pos = "left";
        try {
            var p = localStorage.getItem(LS.pos);
            if (p === "left" || p === "right") pos = p;
        } catch (e) {}
        var w = num(safeGet(LS.w), 300, 220, maxW());
        function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

        var hidden = false;
        try { hidden = localStorage.getItem(LS.hidden) === "1"; } catch (e) {}

        function apply() {
            var narrow = isNarrow();
            var closed = narrow ? !mopen : hidden;
            body.classList.remove("toc-left", "toc-right", "toc-hidden");
            body.classList.add("toc-" + pos);
            if (closed) body.classList.add("toc-hidden");
            body.classList.toggle("toc-mobile", narrow);
            html.classList.toggle("toc-mobile", narrow);
            panel.classList.toggle("hidden", closed);
            /* 藏起来的那套还是能 Tab 到的：opacity:0 + transform 滑出屏幕并不移出 Tab 顺序，
               读屏与纯键盘读者会一路撞进 11 个看不见的控件。inert 把它整棵移出可交互
               （含 Tab 与点击），且不碰 opacity/transform 那条动画；aria-hidden 同步写，
               读屏软件不必猜 inert 的支持情况。 */
            try { panel.inert = closed; } catch (e) {}
            panel.setAttribute("aria-hidden", closed ? "true" : "false");
            toggleBtn.classList.toggle("active", closed);
            /* aria-expanded 跟着真实状态走：这个按钮是 <div> 画的，读屏软件只能靠
               它来判断「现在大纲是展开的还是收起来的」，写死一次就等于骗人。 */
            toggleBtn.setAttribute("aria-expanded", closed ? "false" : "true");
            if (scrim) scrim.classList.toggle("on", narrow && !closed);
            panel.style.setProperty("--toc-w", w + "px");
            body.style.setProperty("--toc-w", w + "px");
            Array.prototype.forEach.call(posBtns, function(b) {
                b.classList.toggle("on", b.getAttribute("data-set") === pos);
            });
        }
        function save() {
            try {
                localStorage.setItem(LS.pos, pos);
                localStorage.setItem(LS.w, String(w));
                localStorage.setItem(LS.hidden, hidden ? "1" : "0");
            } catch (e) {}
        }

        Array.prototype.forEach.call(posBtns, function(b) {
            b.addEventListener("click", function() {
                pos = b.getAttribute("data-set");
                if (isNarrow()) mopen = true;   /* 手机上点「靠左/靠右」就是要看目录：切边的同时把抽屉拉开 */
                apply(); save();
            });
        });
        function toggleToc() {
            if (isNarrow()) { mopen = !mopen; apply(); return; }   /* 抽屉开合不落盘，见上面 mopen 那段 */
            hidden = !hidden; apply(); save();
        }
        toggleBtn.addEventListener("click", toggleToc);
        /* 键盘也能按：#toc-toggle-btn 与折叠按钮都是 <div>/<span> 画的，不是 <button>，
           不给它们补 Enter/Space 就等于「这个开关只有鼠标能用」。
           Space 要挡默认行为——那是「翻一页正文」，不该和开关节奏混在一起。 */
        function keyActivate(el, fn) {
            if (!el) return;
            el.addEventListener("keydown", function(e) {
                var k = e && e.key;
                if (k === "Enter" || k === " " || k === "Spacebar") {
                    if (e.preventDefault) e.preventDefault();
                    fn(e);
                }
            });
        }
        keyActivate(toggleBtn, toggleToc);
        /* 点遮罩关抽屉：正文那一侧被遮罩盖住，读者直觉就是「点外面收起来」 */
        if (scrim) scrim.addEventListener("click", function() { mopen = false; apply(); });

        // 拖内边缘调宽度：靠左拖右边缘、靠右拖左边缘；拖动中实时改 CSS 变量，松手才落盘
        //（窄视口下把手被上面那条 CSS 收掉了，这里绑的事件根本收不到 pointer，不用特判）
        var dragging = false;
        resizer.addEventListener("pointerdown", function(e) {
            dragging = true; resizer.classList.add("dragging");
            body.classList.add("toc-dragging");   // 拖动期间关掉 margin/padding 过渡，否则把手不跟手
            try { resizer.setPointerCapture(e.pointerId); } catch (err) {}
            body.style.userSelect = "none"; e.preventDefault();
        });
        /* 收尾不能只接 pointerup：系统手势、触摸被别的元素抢走、浏览器丢事件都会走
           pointercancel / lostpointercapture，松手事件压根不来。实测漏掉它们的结果是
           toc-dragging 与 userSelect:none 一直留着（整页选不了字），而且之后一次普通悬停
           的 pointermove 还会把面板接着拖走。三条都接上，再加「按键已经抬起」的兜底。 */
        function endDrag() {
            if (!dragging) return;
            dragging = false; resizer.classList.remove("dragging");
            body.classList.remove("toc-dragging");
            body.style.userSelect = ""; save();
        }
        window.addEventListener("pointermove", function(e) {
            if (!dragging) return;
            /* 只对鼠标兜这一手：触摸与笔的 buttons 语义不同（笔悬停时是 0），
               拿它当「松了」会把真拖拽掐掉。这里要防的是松手事件根本没来、指针还跟着光标跑。 */
            if (e.pointerType === "mouse" && e.buttons === 0) { endDrag(); return; }
            if (pos === "left") w = num(e.clientX - 20, w, 220, maxW());
            else w = num(window.innerWidth - e.clientX - 20, w, 220, maxW());
            apply();
        });
        window.addEventListener("pointerup", endDrag);
        window.addEventListener("pointercancel", endDrag);
        resizer.addEventListener("pointercancel", endDrag);
        resizer.addEventListener("lostpointercapture", endDrag);
        window.addEventListener("resize", function() {
            w = num(w, 300, 220, maxW());
            /* 回到宽视口时抽屉那套状态作废，交回桌面端存着的 hidden 偏好；
               转到窄视口时 mopen 仍是 false（默认关着），不会一进来就盖住正文 */
            if (!isNarrow()) mopen = false;
            apply();
        });

        /* 图片点击放大（鼠标与触摸都管）：思源导出的静态页只绑了渲染函数和代码块复制按钮，
           没有任何看图遮罩，所以正文里的图片点了本来就没反应。这里补一个零依赖的灯箱：
           点图片放大、滚轮/＋−/双指/双击缩放、拖拽或单指平移、✕ / 点空白 / Esc 关闭、1:1 复位。
           缩放平移落在 <img> 的内联 style.transform 上——上面那条 CSS 规则刻意不带 transform，
           否则作者样式表的 !important 会把内联声明压掉（本文件开头那条折叠坑就是同一个道理）。
           触摸走 pointer 事件而不是 touch 事件：一套代码同时管鼠标、触摸、手写笔，
           代价是要用 pointerId 记住每根手指——单指平移、双指缩放，第二根手指落下时立刻退出平移。 */
        var viewer = pick("toc-img-viewer");
        var vImg = pick("toc-img-box");
        var vTip = pick("toc-img-tip");
        var artRoot = document.getElementById("preview") || document.querySelector(".protyle-wysiwyg");
        if (viewer && vImg && artRoot) {
            var vzoom = 1, vox = 0, voy = 0, vdrag = false, vx0 = 0, vy0 = 0;
            var pts = {}, pinchBase = 0, pinchZoom = 1, downX = 0, downY = 0, downT = 0, moved = 0, lastTap = 0;
            var vLast = null;   // 打开对话框时的焦点所在元素，关掉时还回去
            function pid(e) { return (e && e.pointerId !== undefined) ? e.pointerId : "anon"; }
            function pcount() { return Object.keys(pts).length; }
            function pdist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
            function vapply() {
                vImg.style.transform = "translate(" + vox + "px, " + voy + "px) scale(" + vzoom + ")";
            }
            function vfit() { vzoom = 1; vox = 0; voy = 0; vapply(); }
            function vopen(src) {
                vImg.setAttribute("src", src);
                vfit();
                /* 提示语按视口宽度给：手机上没有滚轮也没有 Esc，写着「滚轮缩放」等于骗人 */
                if (vTip) vTip.textContent = isNarrow()
                    ? "双指缩放 · 拖动平移 · 点空白关闭"
                    : "滚轮缩放 · 拖拽平移 · Esc 关闭";
                viewer.classList.add("open");
                /* 焦点跟着对话框走：不送进去的话，键盘用户按 Tab 还在底下的正文里绕，
                   看得见对话框却摸不着那排按钮；关掉时再还回原来那张图片的位置。 */
                vLast = document.activeElement;
                var cb = viewer.querySelector('[data-vact="close"]');
                if (cb && cb.focus) { try { cb.focus(); } catch (e) {} }
            }
            function vclose() {
                viewer.classList.remove("open");
                vImg.removeAttribute("src");   // 关掉就把 src 摘掉，免得后台一直占着那张图
                pts = {}; pinchBase = 0; vdrag = false;   // 松手时遮罩已经没了，指头状态别留到下次
                vImg.classList.remove("toc-lb-grabbing");
                if (vLast && vLast.focus) { try { vLast.focus(); } catch (e) {} }
                vLast = null;
            }
            artRoot.addEventListener("click", function(e) {
                var t = e && e.target;
                if (!t || String(t.tagName).toUpperCase() !== "IMG") return;
                if (t.closest && t.closest("a")) return;   // 图片本身是链接时别抢跳转
                var src = t.getAttribute("src") || t.getAttribute("data-src");
                if (!src) return;
                if (e.preventDefault) e.preventDefault();
                vopen(src);
            });
            Array.prototype.forEach.call(viewer.querySelectorAll("[data-vact]"), function(b) {
                b.addEventListener("click", function(ev) {
                    if (ev && ev.stopPropagation) ev.stopPropagation();
                    var act = b.getAttribute("data-vact");
                    if (act === "close") return vclose();
                    if (act === "fit") return vfit();
                    if (act === "in") vzoom = Math.min(6, vzoom * 1.25);
                    if (act === "out") vzoom = Math.max(1, vzoom / 1.25);
                    vapply();
                });
            });
            viewer.addEventListener("click", function(e) {
                if (e && e.target === viewer) vclose();   // 点图片以外的空白区
            });
            vImg.addEventListener("pointerdown", function(e) {
                pts[pid(e)] = { x: e.clientX, y: e.clientY };
                if (pcount() >= 2) {
                    /* 第二根手指落下：从平移切到双指缩放，记住初始间距与当前倍数。
                       平移立刻停掉——否则两指间距一变动就被当成拖动，图会乱飞 */
                    var ks = Object.keys(pts);
                    pinchBase = pdist(pts[ks[0]], pts[ks[1]]);
                    pinchZoom = vzoom;
                    vdrag = false; vImg.classList.remove("toc-lb-grabbing");
                } else {
                    vdrag = true; vx0 = e.clientX - vox; vy0 = e.clientY - voy;
                    downX = e.clientX; downY = e.clientY; downT = Date.now(); moved = 0;
                    vImg.classList.add("toc-lb-grabbing");
                }
                try { vImg.setPointerCapture(e.pointerId); } catch (err) {}
                if (e.preventDefault) e.preventDefault();
            });
            window.addEventListener("pointermove", function(e) {
                var id = pid(e);
                /* 只认已经按下的那几根手指：窗口上飘来的陌生 pointerId 不能凭空多出一根，
                   不然单指平移会被误判成双指缩放 */
                if (pts[id]) pts[id] = { x: e.clientX, y: e.clientY };
                var ks = Object.keys(pts);
                if (ks.length >= 2 && pinchBase > 0) {
                    vzoom = Math.max(1, Math.min(6, pinchZoom * (pdist(pts[ks[0]], pts[ks[1]]) / pinchBase)));
                    vapply();
                    return;
                }
                if (!vdrag) return;
                moved = Math.max(moved, Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY));
                vox = e.clientX - vx0; voy = e.clientY - vy0; vapply();
            });
            window.addEventListener("pointerup", function(e) {
                var id = pid(e);
                if (!pts[id]) return;          // 在别的元素上抬起的、对不上号的：不动灯箱状态
                delete pts[id];
                if (pcount() < 2) pinchBase = 0;
                if (pcount() === 1) {          // 双指抬起一根：剩下那根接着平移，起点按它现在的位置重算，图不跳
                    var k = Object.keys(pts)[0];
                    vdrag = true; vx0 = pts[k].x - vox; vy0 = pts[k].y - voy;
                    moved = 999;               // 这一路是缩放，不该再被判成一次「点击」
                    return;
                }
                vdrag = false; vImg.classList.remove("toc-lb-grabbing");
                /* 双击（触摸/手写笔）在 1:1 与 2.5 倍之间切换：手指够不到右上角那颗 ＋，
                   也不必一直举着两根手指。按下没挪窝、两下间隔小于 350ms 才算双击；
                   鼠标不算——桌面上双击落在图上是选中文本，不该抢成缩放。 */
                if (!(moved < 24 && (Date.now() - downT) < 350) || e.pointerType === "mouse") { lastTap = 0; return; }
                if (lastTap && (Date.now() - lastTap) < 350) {
                    vzoom = vzoom > 1.4 ? 1 : 2.5; vox = 0; voy = 0; vapply(); lastTap = 0;
                } else lastTap = Date.now();
            });
            window.addEventListener("pointercancel", function(e) {
                var id = pid(e);
                if (pts[id]) delete pts[id];
                if (pcount() < 2) pinchBase = 0;
                if (pcount() === 0) { vdrag = false; vImg.classList.remove("toc-lb-grabbing"); }
            });
            // 缩放只在灯箱开着时接管滚轮，并且挂在不透明的遮罩上——正文里滚轮还是正常滚页面
            viewer.addEventListener("wheel", function(e) {
                if (!viewer.classList.contains("open")) return;
                if (e && e.preventDefault) e.preventDefault();
                var dy = e && e.deltaY;
                if (dy === undefined) return;
                vzoom = Math.max(1, Math.min(6, vzoom * (dy < 0 ? 1.15 : 1 / 1.15)));
                vapply();
            });
            window.addEventListener("keydown", function(e) {
                if (!viewer.classList.contains("open")) return;
                var k = e && e.key;
                if (k === "Escape") vclose();
                else if (k === "+" || k === "=") { vzoom = Math.min(6, vzoom * 1.25); vapply(); }
                else if (k === "-" || k === "_") { vzoom = Math.max(1, vzoom / 1.25); vapply(); }
                else if (k === "0") vfit();
            });
        }

        var createToc = function() {
            var tocContainer = pick("toc-list-container");
            var preview = document.getElementById("preview") || document.querySelector(".protyle-wysiwyg");
            if (!preview || !tocContainer) return;
            var headings = preview.querySelectorAll(".h1, .h2, .h3, .h4, .h5, .h6, [data-type='NodeHeading']");
            tocContainer.innerHTML = "";

            // 先按出现顺序收集有效标题及其层级
            var rows = [];
            headings.forEach(function(heading) {
                var textBlock = heading.querySelector("[contenteditable]");
                var text = textBlock ? textBlock.textContent.trim() : heading.textContent.trim();
                var id = heading.getAttribute("id") || heading.getAttribute("data-node-id");
                if (!text || !id) return;
                var lvl = 1;
                for (var n = 2; n <= 6; n++) {
                    if (heading.classList.contains("h" + n) || heading.getAttribute("data-subtype") === "h" + n) { lvl = n; break; }
                }
                rows.push({ heading: heading, text: text, id: id, lvl: lvl });
            });
            if (rows.length === 0) {
                tocContainer.innerHTML = '<li class="toc-item" style="color:#aaa;font-size:12px;">未检测到大纲标题</li>';
                return;
            }

            // 用栈按层级求父节点：弹出所有 >= 当前层级的，栈顶即父
            var stack = [];
            var items = [];
            var hasKids = {};
            rows.forEach(function(r, i) {
                while (stack.length && rows[stack[stack.length - 1]].lvl >= r.lvl) stack.pop();
                var parent = stack.length ? stack[stack.length - 1] : -1;
                if (parent !== -1) hasKids[parent] = true;
                stack.push(i);

                var li = document.createElement("li");
                li.className = "toc-item toc-h" + r.lvl;
                var caret = document.createElement("span");
                caret.className = "toc-caret leaf";   // 先按叶子画，下面按 hasKids 补正（子项一定排在父项之后）
                caret.textContent = "▾";
                var a = document.createElement("a");
                a.href = "#" + r.id; a.title = r.text; a.textContent = r.text;
                a.setAttribute("data-toc-id", r.id);
                a.addEventListener("click", function() {
                    /* 手机上点目录就是要去看那一段：抽屉不关的话，跳完还是被自己盖住 */
                    if (isNarrow()) { mopen = false; apply(); }
                });
                li.appendChild(caret); li.appendChild(a);
                tocContainer.appendChild(li);
                items.push({ li: li, a: a, caret: caret, lvl: r.lvl, parent: parent, id: r.id, collapsed: false });
            });
            // 补正三角可见性：有子项的显示，叶子隐藏
            items.forEach(function(it, i) {
                if (hasKids[i]) it.caret.classList.remove("leaf");
            });

            function isVisible(i) {
                var p = items[i].parent;
                while (p !== -1) { if (items[p].collapsed) return false; p = items[p].parent; }
                return true;
            }
            function render() {
                items.forEach(function(it, i) {
                    it.li.classList.toggle("toc-hidden-row", !isVisible(i));
                    it.li.classList.toggle("collapsed", !!it.collapsed);
                });
                updateFoldAllBtn();
            }
            items.forEach(function(it, i) {
                if (!hasKids[i]) return;
                it.caret.addEventListener("click", function(ev) {
                    if (ev && ev.stopPropagation) ev.stopPropagation();
                    it.collapsed = !it.collapsed; render();
                });
            });

            // 折叠/展开全部
            var foldAllBtn = pick("toc-foldall-btn");
            var allCollapsed = false;
            function updateFoldAllBtn() {
                if (!foldAllBtn) return;
                foldAllBtn.textContent = allCollapsed ? "⊞" : "⊟";
                foldAllBtn.setAttribute("title", allCollapsed ? "展开全部" : "折叠全部");
            }
            function foldAll() {
                allCollapsed = !allCollapsed;
                items.forEach(function(it, i) { it.collapsed = hasKids[i] ? allCollapsed : false; });
                render();
            }
            if (foldAllBtn) {
                foldAllBtn.addEventListener("click", foldAll);
                /* 同上：这是个 <span> 画的图标按钮，键盘也要按得动（keyActivate 在文件前面定义） */
                keyActivate(foldAllBtn, foldAll);
            }

            // 滚动高亮：命中某标题时，先展开它的祖先链，保证它在目录里可见
            var idToIndex = {};
            items.forEach(function(it, i) { idToIndex[it.id] = i; });
            function expandAncestors(i) {
                var p = items[i].parent, changed = false;
                while (p !== -1) { if (items[p].collapsed) { items[p].collapsed = false; changed = true; } p = items[p].parent; }
                return changed;
            }
            var observerOptions = { root: null, rootMargin: "0px 0px -70% 0px", threshold: 0 };
            var observerCallback = function(entries) {
                entries.forEach(function(entry) {
                    if (!entry.isIntersecting) return;
                    var id = entry.target.getAttribute("id") || entry.target.getAttribute("data-node-id");
                    var idx = idToIndex[id];
                    if (idx === undefined) return;
                    if (expandAncestors(idx)) render();
                    items.forEach(function(it, i) { it.a.classList.toggle("active", i === idx); });
                    items[idx].a.scrollIntoView({ block: "nearest", behavior: "smooth" });
                });
            };
            var observer = new IntersectionObserver(observerCallback, observerOptions);
            rows.forEach(function(r) { observer.observe(r.heading); });
            render();
        };

        apply();
        if (document.readyState === "complete" || document.readyState === "interactive") {
            setTimeout(createToc, 300);
        } else {
            window.addEventListener("DOMContentLoaded", function() { setTimeout(createToc, 300); });
        }
    })();
</script>
<!--alex_add_toc-->
`;

/* 语义：文末追加 payload；页尾正好是我们那份 payload 时先原样摘掉再重新注入（幂等）。
 * 但「正文里有标记」绝不能当成「这里有旧 payload」：正文是内核刚导出来的，
 * 一篇讲这个插件的笔记，代码块或 HTML 块里就会出现 <!--alex_add_toc-->，甚至可能整段
 * 嵌着上一次导出的页面源码。按「第一个标记后面紧跟 <style>」切下去，那之后的正文整个
 * 被丢掉——页面照样能打开、大纲照样在，读者却少看半篇文章，谁也不会发现。
 * 注入只会往最末尾追加，所以真正的旧载荷必然逐字躺在结尾：判据取「整串以 payload 结尾」，
 * 摘掉它等于回到首次注入的那个正文，接缝既不攒换行也不会吃掉任何内容。 */
function injectToc(html) {
  var h = String(html == null ? "" : html);
  if (h.length >= TOC_PAYLOAD.length && h.slice(-TOC_PAYLOAD.length) === TOC_PAYLOAD) {
    h = h.slice(0, h.length - TOC_PAYLOAD.length);
  }
  return h + TOC_PAYLOAD;
}
