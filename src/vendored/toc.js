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
/* ---------------- 侧边大纲注入（与用户 add_toc.py 的 payload 逐字一致） ---------------- */

const TOC_MARKER = "<!--alex_add_toc-->";
const TOC_PAYLOAD = `
<!--alex_add_toc-->
<style>
    /* 开启全局平滑滚动效果 */
    html {
        scroll-behavior: smooth;
    }

    /* 优化跳转后的顶部留空，防止标题紧贴浏览器最顶端 */
    #preview .h1, #preview .h2, #preview .h3, #preview .h4, #preview .h5, #preview .h6 {
        scroll-margin-top: 40px !important;
    }

    /* 强行缩窄主内容区，给右侧大纲腾地方 */
    #preview, .protyle-wysiwyg {
        margin-right: 340px !important;
        margin-left: 40px !important;
        max-width: calc(100% - 380px) !important;
        transition: margin-right 0.3s ease, max-width 0.3s ease;
    }
    /* 当大纲隐藏时，正文恢复全宽 */
    .toc-hidden #preview, .toc-hidden .protyle-wysiwyg {
        margin-right: 40px !important;
        max-width: calc(100% - 80px) !important;
    }

    /* 右侧悬浮大纲主体 */
    #custom-toc {
        position: fixed !important;
        right: 25px !important;
        top: 40px !important;
        width: 270px !important;
        max-height: 85vh !important;
        overflow-y: auto !important;
        background-color: #ffffff !important;
        border: 1px solid #e0e0e0 !important;
        border-radius: 8px !important;
        padding: 16px !important;
        box-shadow: 0 4px 12px rgba(0,0,0,0.08) !important;
        z-index: 999999 !important;
        font-family: sans-serif !important;
        transition: transform 0.3s ease, opacity 0.3s ease;
    }
    
    /* 隐藏状态下的样式（向右滑出屏幕并隐藏） */
    #custom-toc.hidden {
        transform: translateX(320px) !important;
        opacity: 0 !important;
        pointer-events: none !important;
    }

    /* 唯一的悬浮控制图标（右下角） */
    #toc-toggle-btn {
        position: fixed !important;
        right: 25px !important;
        bottom: 40px !important;
        width: 48px !important;
        height: 48px !important;
        background-color: #0078d4 !important;
        color: #ffffff !important;
        border-radius: 50% !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        cursor: pointer !important;
        box-shadow: 0 4px 10px rgba(0,0,0,0.2) !important;
        z-index: 9999999 !important;
        font-size: 20px !important;
        transition: all 0.3s ease;
        user-select: none !important;
    }
    #toc-toggle-btn:hover { background-color: #005a9e !important; transform: scale(1.05); }
    
    /* 当大纲处于隐藏状态时，图标改变颜色给予视觉反馈 */
    #toc-toggle-btn.active {
        background-color: #717171 !important;
    }

    /* 大纲顶部的控制栏 */
    .toc-header {
        margin-bottom: 12px !important;
        border-bottom: 1px solid #e0e0e0 !important;
        padding-bottom: 8px !important;
    }
    .toc-title {
        font-size: 14px !important;
        font-weight: 600 !important;
        color: #888 !important;
    }

    /* 列表与文字适配 */
    .toc-list { list-style: none !important; padding-left: 0 !important; margin: 0 !important; }
    .toc-item { margin: 6px 0 !important; line-height: 1.4 !important; }
    .toc-item a {
        color: #444 !important;
        text-decoration: none !important;
        font-size: 13px !important;
        display: block !important;
        padding: 4px 6px 4px 10px !important;
        border-radius: 4px !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        border-left: 2px solid transparent !important;
        transition: all 0.2s ease;
    }
    .toc-item a:hover { background-color: #f0f0f0 !important; color: #0078d4 !important; }
    
    /* ==================== 明亮模式下的滚动高亮样式 ==================== */
    .toc-item a.active {
        color: #0078d4 !important;
        font-weight: bold !important;
        background-color: #f0f7ff !important;
        border-left-color: #0078d4 !important;
    }
    
    /* 层级缩进 */
    .toc-h1 { padding-left: 0px !important; font-weight: bold !important; }
    .toc-h2 { padding-left: 10px !important; font-weight: bold !important; }
    .toc-h3 { padding-left: 20px !important; }
    .toc-h4 { padding-left: 30px !important; }
    .toc-h5 { padding-left: 40px !important; }
    .toc-h6 { padding-left: 50px !important; }

    /* ==================== 暗黑模式自适应 ==================== */
    [data-theme-mode="dark"] #custom-toc {
        background-color: #1e1e22 !important;
        border-color: #2a2a2e !important;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5) !important;
    }
    [data-theme-mode="dark"] .toc-header { border-bottom-color: #2a2a2e !important; }
    [data-theme-mode="dark"] .toc-title { color: #b0b0b5 !important; }
    [data-theme-mode="dark"] .toc-item a { color: #d0d0d5 !important; }
    [data-theme-mode="dark"] .toc-item a:hover { background-color: #2a2a2e !important; color: #4ec9b0 !important; }
    
    /* ==================== 暗黑模式下的滚动高亮样式 ==================== */
    [data-theme-mode="dark"] .toc-item a.active {
        color: #4ec9b0 !important;
        font-weight: bold !important;
        background-color: #1d2d2a !important;
        border-left-color: #4ec9b0 !important;
    }
    
    /* 暗黑模式下的图标颜色 */
    [data-theme-mode="dark"] #toc-toggle-btn { background-color: #4ec9b0 !important; color: #1e1e22 !important; }
    [data-theme-mode="dark"] #toc-toggle-btn.active { background-color: #3a3a3e !important; color: #aaaaaa !important; }
</style>

<div id="custom-toc">
    <div class="toc-header">
        <span class="toc-title">📋 文章大纲</span>
    </div>
    <ul id="toc-list-container" class="toc-list"></ul>
</div>

<div id="toc-toggle-btn" title="显示/隐藏大纲">📋</div>

<script>
    (function() {
        const tocPanel = document.getElementById("custom-toc");
        const toggleBtn = document.getElementById("toc-toggle-btn");
        const body = document.body;

        toggleBtn.addEventListener("click", () => {
            const isHidden = tocPanel.classList.toggle("hidden");
            toggleBtn.classList.toggle("active", isHidden);
            body.classList.toggle("toc-hidden", isHidden);
        });

        const createToc = () => {
            const tocContainer = document.getElementById("toc-list-container");
            const preview = document.getElementById("preview") || document.querySelector(".protyle-wysiwyg");
            if (!preview || !tocContainer) return;
            
            const headings = preview.querySelectorAll(".h1, .h2, .h3, .h4, .h5, .h6, [data-type='NodeHeading']");
            tocContainer.innerHTML = ""; 
            
            const headingElements = [];
            
            headings.forEach((heading) => {
                const textBlock = heading.querySelector("[contenteditable]");
                const text = textBlock ? textBlock.textContent.trim() : heading.textContent.trim();
                const id = heading.getAttribute("id") || heading.getAttribute("data-node-id");
                
                if (text && id) {
                    headingElements.push(heading);
                    
                    const li = document.createElement("li");
                    let level = "h1";
                    if (heading.classList.contains("h2") || heading.getAttribute("data-subtype") === "h2") level = "h2";
                    else if (heading.classList.contains("h3") || heading.getAttribute("data-subtype") === "h3") level = "h3";
                    else if (heading.classList.contains("h4") || heading.getAttribute("data-subtype") === "h4") level = "h4";
                    else if (heading.classList.contains("h5") || heading.getAttribute("data-subtype") === "h5") level = "h5";
                    else if (heading.classList.contains("h6") || heading.getAttribute("data-subtype") === "h6") level = "h6";
                    
                    li.className = \`toc-item toc-\${level}\`;
                    const a = document.createElement("a");
                    a.href = "#" + id;
                    a.title = text;
                    a.textContent = text;
                    a.setAttribute("data-toc-id", id);
                    
                    li.appendChild(a);
                    tocContainer.appendChild(li);
                }
            });
            
            if (tocContainer.children.length === 0) {
                tocContainer.innerHTML = '<li class="toc-item" style="color:#aaa;font-size:12px;">未检测到大纲标题</li>';
                return;
            }

            // ==================== 高性能滚动高亮监听 (Scrollspy) ====================
            const tocLinks = tocContainer.querySelectorAll("a");
            const observerOptions = {
                root: null,
                rootMargin: "0px 0px -70% 0px", // 划定视口上方 30% 区域为高亮触发黄金带
                threshold: 0
            };

            let activeHeadingId = null;

            const observerCallback = (entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const id = entry.target.getAttribute("id") || entry.target.getAttribute("data-node-id");
                        activeHeadingId = id;
                        
                        tocLinks.forEach(link => {
                            if (link.getAttribute("data-toc-id") === activeHeadingId) {
                                link.classList.add("active");
                                // 大纲面板智能自适应随动
                                link.scrollIntoView({ block: "nearest", behavior: "smooth" });
                            } else {
                                link.classList.remove("active");
                            }
                        });
                    }
                });
            };

            const observer = new IntersectionObserver(observerCallback, observerOptions);
            headingElements.forEach(heading => observer.observe(heading));
        };

        if (document.readyState === "complete" || document.readyState === "interactive") {
            setTimeout(createToc, 300);
        } else {
            window.addEventListener("DOMContentLoaded", () => setTimeout(createToc, 300));
        }
    })();
</script>
<!--alex_add_toc-->
`;

/* 与 add_toc.py 相同的语义：无标记则在文末追加；已有标记则截掉旧 payload 后重新注入最新版 */
function injectToc(html) {
  if (html.indexOf(TOC_MARKER) !== -1) {
    return html.split(TOC_MARKER)[0] + TOC_PAYLOAD;
  }
  return html + TOC_PAYLOAD;
}
