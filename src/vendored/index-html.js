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
/* =====================================================================
 * Vendored SiYuan 3.8.6 前端导出代码（逐字来自 stage/build/desktop/main.*.js，
 * 仅将 webpack 模块引用替换为本地 shim）。index.html 由这些函数生成，
 * 与手动「导出 HTML(SiYuan)」逐字节一致：内核 /api/export/exportBrowserHTML
 * 也只是把前端拼好的同一字符串原样写入 index.html（WriteFile([]byte(html))）。
 * ===================================================================== */
const Vendored = (function () {
  const fetchSync = (path, body) => fetchSyncPost(path, body);

  /* --- webpack module 3750：内联样式（行内颜色/高亮/卡片配色）规范化与 CSS 生成 --- */
  const InlineStyles = (function () {
    function e() { return { fetchSyncPost: fetchSync, Constants: { SIYUAN_APPID: "siyuan" } }; }
var g=Object.defineProperty,B=Object.defineProperties,x=Object.getOwnPropertyDescriptors,l=Object.getOwnPropertySymbols,a=Object.prototype.hasOwnProperty,L=Object.prototype.propertyIsEnumerable,d=(b,be,he)=>be in b?g(b,be,{enumerable:!0,configurable:!0,writable:!0,value:he}):b[be]=he,y=(b,be)=>{for(var he in be||(be={}))a.call(be,he)&&d(b,he,be[he]);if(l)for(var he of l(be))L.call(be,he)&&d(b,he,be[he]);return b},w=(b,be)=>B(b,x(be)),o=(b,be,he)=>new Promise((J,we)=>{var qe=ft=>{try{tt(he.next(ft))}catch(Ge){we(Ge)}},je=ft=>{try{tt(he.throw(ft))}catch(Ge){we(Ge)}},tt=ft=>ft.done?J(ft.value):Promise.resolve(ft.value).then(qe,je);tt((he=he.apply(b,be)).next())});const S=13,f=14,r=15,C=78,u=64,c=["error","warning","info","success"],t=Array.from({length:S},(b,be)=>(be+1).toString()),i={color:[...t],backgroundColor:[...t],style1:[...c]},_=Array.from({length:f},(b,be)=>(be+1).toString()),n={version:2,builtin:{colors:[],styles:[],hidden:{color:[],backgroundColor:[],style1:[],av:[]}},styles:[],order:{color:[...i.color],backgroundColor:[...i.backgroundColor],style1:[...i.style1]},av:{colors:[],order:[..._]}},p=64,h=64,O=["",...Array.from({length:S},(b,be)=>`var(--b3-font-color${be+1})`)],M=["",...Array.from({length:S},(b,be)=>`var(--b3-font-background${be+1})`)],G=/^[0-9]{14}-[a-z0-9]{7}$/,ee=/^#[0-9A-Fa-f]{6}$/,Z=/var\(--b3-inline-style-([A-Za-z0-9_-]+?)-(?:background-color|color)(?:\s*,|\))/,N="\u200B",W=/^var\(--b3-font-color(\d+)\)$/,ce=/^var\(--b3-font-background(\d+)\)$/;let de,ge,ue=0,fe=0;const $=b=>{if(!(typeof b!="string"||!ee.test(b)))return b.toLowerCase()},q=b=>{var be,he,J,we;if(!b||typeof b!="object")return;const qe=b;if(typeof qe.id!="string"||!G.test(qe.id)||typeof qe.name!="string"||!qe.name.trim())return;const je=$((be=qe.light)==null?void 0:be.color),tt=$((he=qe.dark)==null?void 0:he.color),ft=$((J=qe.light)==null?void 0:J.backgroundColor),Ge=$((we=qe.dark)==null?void 0:we.backgroundColor),rt={light:{},dark:{}};if(je&&tt&&(rt.light.color=je,rt.dark.color=tt),ft&&Ge&&(rt.light.backgroundColor=ft,rt.dark.backgroundColor=Ge),!(!rt.light.color&&!rt.light.backgroundColor))return y(y({id:qe.id,name:[...qe.name.trim()].slice(0,h).join("")},qe.hidden===!0?{hidden:!0}:{}),rt)},k=b=>{var be,he,J,we;if(!b||typeof b!="object")return;const qe=b,je=$((be=qe.light)==null?void 0:be.color),tt=$((he=qe.dark)==null?void 0:he.color),ft=$((J=qe.light)==null?void 0:J.backgroundColor),Ge=$((we=qe.dark)==null?void 0:we.backgroundColor),rt={light:{},dark:{}};if(je&&tt&&(rt.light.color=je,rt.dark.color=tt),ft&&Ge&&(rt.light.backgroundColor=ft,rt.dark.backgroundColor=Ge),!(!rt.light.color&&!rt.light.backgroundColor))return rt},H=b=>{const be=[],he=new Set;return Array.isArray(b)?(b.forEach(J=>{if(!J||typeof J!="object")return;const we=Number(J.index),qe=k(J);!Number.isInteger(we)||we<1||we>f||he.has(we)||!qe||(he.add(we),be.push(y({index:we},qe)))}),be.sort((J,we)=>J.index-we.index)):be},z=b=>{const be=[],he=new Set;return Array.isArray(b)?(b.forEach(J=>{if(!J||typeof J!="object")return;const we=J.id,qe=k(J);!c.includes(we)||he.has(we)||!qe||(he.add(we),be.push(y({id:we},qe)))}),be.sort((J,we)=>c.indexOf(J.id)-c.indexOf(we.id))):be},te=(b,be=S)=>Array.isArray(b)?Array.from(new Set(b.filter(he=>Number.isInteger(he)&&he>=1&&he<=be))).sort((he,J)=>he-J):[],A=b=>{if(!Array.isArray(b))return[];const be=new Set(b.filter(he=>c.includes(he)));return c.filter(he=>be.has(he))},R=b=>{const be=b&&typeof b=="object"?b:{},he=be.hidden&&typeof be.hidden=="object"?be.hidden:{};return{colors:H(be.colors),styles:z(be.styles),hidden:{color:te(he.color),backgroundColor:te(he.backgroundColor),style1:A(he.style1),av:te(he.av,f)}}},I=b=>{var be,he,J,we;if(!b||typeof b!="object")return;const qe=b,je=Number(qe.index),tt=$((be=qe.light)==null?void 0:be.color),ft=$((he=qe.light)==null?void 0:he.backgroundColor),Ge=$((J=qe.dark)==null?void 0:J.color),rt=$((we=qe.dark)==null?void 0:we.backgroundColor);if(!(!Number.isInteger(je)||je<r||je>C||!tt||!ft||!Ge||!rt))return w(y({index:je},qe.hidden===!0?{hidden:!0}:{}),{light:{color:tt,backgroundColor:ft},dark:{color:Ge,backgroundColor:rt}})},P=b=>{const be=[],he=new Set;return Array.isArray(b)?(b.forEach(J=>{if(be.length>=u)return;const we=I(J);!we||he.has(we.index)||(he.add(we.index),be.push(we))}),be.sort((J,we)=>J.index-we.index)):be},E=b=>[..._,...b.map(be=>be.index.toString())],v=(b,be)=>{const he=new Set(E(be)),J=[],we=new Set;return Array.isArray(b)&&b.forEach(qe=>{typeof qe!="string"||!he.has(qe)||we.has(qe)||(we.add(qe),J.push(qe))}),E(be).forEach(qe=>{we.has(qe)||J.push(qe)}),J},T=b=>{const be=b&&typeof b=="object"?b:{},he=P(be.colors);return{colors:he,order:v(be.order,he)}},D=b=>{const be=!!b.light.color&&!!b.dark.color,he=!!b.light.backgroundColor&&!!b.dark.backgroundColor;if(be&&he)return"style1";if(be)return"color";if(he)return"backgroundColor"},Y=b=>b==="style1"?[...c]:[...t],V=(b,be)=>Y(b).includes(be),ne=(b,be)=>be.filter(he=>D(he)===b).map(he=>he.id),K=(b,be,he)=>{const J=Y(be),we=ne(be,he),qe=new Set([...J,...we]),je=[],tt=new Set;return Array.isArray(b)&&b.forEach(ft=>{typeof ft!="string"||!qe.has(ft)||tt.has(ft)||(tt.add(ft),je.push(ft))}),[...J,...we].forEach(ft=>{tt.has(ft)||je.push(ft)}),je},ie=(b,be)=>{const he=b&&typeof b=="object"?b:{};return{color:K(he.color,"color",be),backgroundColor:K(he.backgroundColor,"backgroundColor",be),style1:K(he.style1,"style1",be)}},j=b=>{const be=[],he=new Set;return b&&typeof b=="object"&&Array.isArray(b.styles)&&b.styles.forEach(J=>{if(be.length>=p)return;const we=q(J);we&&!he.has(we.id)&&(he.add(we.id),be.push(we))}),{version:2,builtin:R(b&&typeof b=="object"?b.builtin:void 0),styles:be,order:ie(b&&typeof b=="object"?b.order:void 0,be),av:T(b&&typeof b=="object"?b.av:void 0)}},oe=b=>(de=j(b),de),pe=()=>de||n,ke=(b=!1)=>{if(!b&&de)return Promise.resolve(de);if(!b&&ge)return ge;const be=++fe;ue=be;const he=(()=>o(void 0,null,function*(){try{const{fetchSyncPost:J}=yield Promise.resolve().then(e.bind(e,9141)),we=yield J("/api/storage/getInlineStyles");return be!==fe?pe():(we==null?void 0:we.code)!==0?oe(n):oe(we.data)}catch(J){if(be!==fe)return pe();if(b&&de)throw J;return oe(n)}finally{ue===be&&(ge=void 0,ue=0)}}))();return ge=he,he},le=b=>o(void 0,null,function*(){const be=j(b),[{Constants:he},{fetchSyncPost:J}]=yield Promise.all([Promise.resolve().then(e.bind(e,1145)),Promise.resolve().then(e.bind(e,9141))]),we=yield J("/api/storage/setInlineStyles",w(y({},be),{app:he.SIYUAN_APPID}));return(we==null?void 0:we.code)!==0||(fe++,oe(we.data||be)),we}),X=(b,be)=>o(void 0,null,function*(){const[{Constants:he},{fetchSyncPost:J}]=yield Promise.all([Promise.resolve().then(e.bind(e,1145)),Promise.resolve().then(e.bind(e,9141))]),we=yield J("/api/storage/setWorkspaceAVPalette",{colors:b.colors,order:b.order,builtinColors:be,app:he.SIYUAN_APPID});return(we==null?void 0:we.code)!==0||(fe++,we.data&&oe(we.data)),we}),_e=()=>document.documentElement.getAttribute("data-theme-mode")==="dark"?"dark":"light",ae=(b,be)=>`--b3-inline-style-${b}-${be==="color"?"color":"background-color"}`,U=(b,be,he=_e())=>{const J=b[he][be];return J?`var(${ae(b.id,be)}, ${J})`:""},Q=(b="",be="")=>b+N+be,re=(b="")=>{const be=b.split(N);return{backgroundColor:be[0]||"",color:be[1]||""}},Le=(b,be=_e())=>{const he=D(b);if(!he)return;const J=U(b,"color",be),we=U(b,"backgroundColor",be);return{type:he,color:he==="style1"?Q(we,J):he==="color"?J:we}},me=(b,be=_e(),he=!0)=>({color:b[be].color?he?U(b,"color",be):b[be].color:"",backgroundColor:b[be].backgroundColor?he?U(b,"backgroundColor",be):b[be].backgroundColor:""}),Re=b=>{var be;return(be=b==null?void 0:b.match(Z))==null?void 0:be[1]},se=(b,be=pe())=>b?be.styles.find(he=>he.id===b):void 0,Ce=(b,be=pe())=>se(Re(b),be),Ae=(b,be=pe())=>be.builtin.colors.find(he=>he.index===b),De=(b,be=pe())=>be.builtin.styles.find(he=>he.id===b),et=(b,be)=>`--b3-font-${be==="color"?"color":"background"}${b}`,Ve=(b,be)=>`var(${et(b,be)})`,lt=(b,be)=>`--b3-card-${b}-${be==="color"?"color":"background"}`,vt=(b,be)=>`var(${lt(b,be)})`,pt=(b,be=_e(),he=pe())=>{var J;const we=(J=De(b,he))==null?void 0:J[be];return{color:(we==null?void 0:we.color)||vt(b,"color"),backgroundColor:(we==null?void 0:we.backgroundColor)||vt(b,"backgroundColor")}},It=b=>({type:"style1",color:Q(vt(b,"backgroundColor"),vt(b,"color"))}),nt=(b,be,he=pe())=>{if(b==="style1")return!c.includes(be)||!he.builtin.hidden.style1.includes(be);const J=Number(be),we=b==="av"?f:S;return!Number.isInteger(J)||J<1||J>we||!he.builtin.hidden[b].includes(J)},Be=(b,be=pe())=>{const he=b==="av"?f:S;return Array.from({length:he},(J,we)=>we+1).filter(J=>nt(b,J,be))},Pe=(b=pe())=>c.filter(be=>nt("style1",be,b)),ve=(b,be=pe())=>j(be).order[b],Je=(b,be=pe())=>{const he=j(be);return he.order[b].filter(J=>{if(!V(b,J)){const we=he.styles.find(qe=>qe.id===J);return!!we&&!we.hidden}return b==="style1"?nt("style1",J,he):nt(b,Number(J),he)})},Xe=b=>{var be;const he=(be=b==null?void 0:b.match(/--b3-(?:inline-builtin-|card-)(error|warning|info|success)-(?:background(?:-color)?|color)/))==null?void 0:be[1];return c.includes(he)?he:void 0},dt=(b,be=pe())=>{var he,J;const[we,qe]=b.split(N);if(we==="color"){const tt=Number((he=qe==null?void 0:qe.match(W))==null?void 0:he[1]);if(tt)return nt("color",tt,be)}else if(we==="backgroundColor"){const tt=Number((J=qe==null?void 0:qe.match(ce))==null?void 0:J[1]);if(tt)return nt("backgroundColor",tt,be)}else if(we==="style1"){const tt=Xe(b);if(tt)return nt("style1",tt,be)}const je=Ce(b,be);return!je||!je.hidden},Ie=(b,be=pe())=>b.filter(he=>dt(he,be)),Te=b=>{const be=b.startsWith("style1"+N)&&Xe(b);if(be)return"style1"+N+be;const he=Re(b);return he?b.split(N)[0]+N+he:b},Se=(b=pe())=>{const be=j(b);return["light","dark"].map(he=>{const J=[],we=[];be.builtin.colors.forEach(je=>{je[he].color&&J.push(`  ${et(je.index,"color")}: ${je[he].color};`),je[he].backgroundColor&&J.push(`  ${et(je.index,"backgroundColor")}: ${je[he].backgroundColor};`)}),be.av.colors.forEach(je=>{J.push(`  ${et(je.index,"color")}: ${je[he].color};`),J.push(`  ${et(je.index,"backgroundColor")}: ${je[he].backgroundColor};`)}),be.builtin.styles.forEach(je=>{je[he].color&&we.push(`  ${lt(je.id,"color")}: ${je[he].color};`),je[he].backgroundColor&&we.push(`  ${lt(je.id,"backgroundColor")}: ${je[he].backgroundColor};`)}),be.styles.forEach(je=>{je[he].color&&J.push(`  ${ae(je.id,"color")}: ${je[he].color};`),je[he].backgroundColor&&J.push(`  ${ae(je.id,"backgroundColor")}: ${je[he].backgroundColor};`)});const qe=[];return J.length>0&&qe.push(`:root[data-theme-mode="${he}"] {
${J.join(`
`)}
}`),we.length>0&&qe.push(`:root[data-theme-mode="${he}"] .protyle-wysiwyg,
:root[data-theme-mode="${he}"] .b3-typography {
${we.join(`
`)}
}`),qe.join(`
`)}).filter(Boolean).join(`
`)}
    return { normalize: oe, build: Se, defaults: n };
  })();

  /* --- webpack module 9950 片段：全局字体 CSS + 各 OS 表情符号 @font-face --- */
  const FontCSS = (function () {
const u=X=>{const _e=X.map(ae=>CSS.escape(ae.family)).join(", ");return _e?`
:root:root { --b3-font-family: var(--b3-font-family-emoji-reset), ${_e}, var(--b3-font-family-default, sans-serif) }
body, button, input, select, textarea { font-weight: ${X[0].weight||400} }`:""},c="appearance/fonts/Noto-COLRv1-2.051/Noto-COLRv1.woff2",t="U+200d, U+2640, U+2642, U+fe0f, U+1f3fb-1f3ff, U+1f430, U+1f468-1f469, U+1f46f, U+1f6d8, U+1f93c, U+1f9d1, U+1fa70, U+1fa8a, U+1fa8e, U+1fac8, U+1facd, U+1faea, U+1faef",i="U+25fd-25fe, U+2614-2615, U+2648-2653, U+267f, U+2693, U+26a1, U+26aa-26ab, U+1f0cf, U+1f311-1f318, U+1f42d-1f42e, U+1f431, U+1f435, U+1f600-1f64f",_=(X,_e)=>{let ae;return X==="apple"?ae=`@font-face {
  font-family: "Emojis Additional";
  src: url(${_e}${c}) format("woff2");
  unicode-range: ${t}, U+1fae9, U+1fac6, U+1fabe, U+1fadc, U+e50a, U+1fa89, U+1fadf, U+1f1e6-1f1ff, U+1fa8f;
}
@font-face {
  font-family: "Emojis Reset";
  src: local("Apple Color Emoji"),
  local("Segoe UI Emoji"),
  local("Segoe UI Symbol");
  unicode-range: U+21a9, U+21aa, U+2122, U+2194-2199, U+23cf, U+25b6, U+25c0, U+25fb, U+25fc, U+25aa, U+25ab, U+2600-2603,
  U+260e, U+2611, U+261d, U+2639, U+263a, U+2640, U+2642, U+2660, U+2663, U+2665, U+2666, U+2668, U+267b, U+26aa, U+26ab,
  U+2702, U+2708, U+2934, U+2935, U+1f170, U+1f171, U+1f17e, U+1f17f, U+1f202, U+1f21a, U+1f22f, U+1f232-1f23a, U+1f250,
  U+1f251, U+1fae4, U+2049, U+203c, U+3030, U+303d, U+24c2, U+26a0, U+26a1, U+26be, U+27a1, U+2b05-2b07, U+3297, U+3299, U+a9, U+ae,
  ${i};
  size-adjust: 115%;
}
@font-face {
  font-family: "Emojis";
  src: local("Apple Color Emoji"),
  local("Segoe UI Emoji"),
  local("Segoe UI Symbol");
  size-adjust: 115%;
}`:X==="windows11"?ae=`@font-face {
  font-family: "Emojis Additional";
  src: url(${_e}${c}) format("woff2");
  unicode-range: ${t}, U+1fae9, U+1fac6, U+1fabe, U+1fadc, U+e50a, U+1fa89, U+1fadf, U+1f1e6-1f1ff, U+1f3f4, U+e0067, U+e0062,
  U+e0065, U+e006e, U+e007f, U+e0073, U+e0063, U+e0074, U+e0077, U+e006c;
  size-adjust: 85%;
}
@font-face {
  font-family: "Emojis Reset";
  src: local("Segoe UI Emoji"),
  local("Segoe UI Symbol");
  unicode-range: U+263a, U+21a9, U+2642, U+303d, U+2197, U+2198, U+2199, U+2196, U+2195, U+2194, U+2660, U+2665, U+2666,
  U+2663, U+3030, U+21aa, U+25b6, U+25c0, U+2640, U+203c, U+a9, U+ae, U+2122, ${i};
  size-adjust: 85%;
}
@font-face {
  font-family: "Emojis";
  src: local("Segoe UI Emoji"),
  local("Segoe UI Symbol");
  size-adjust: 85%;
}`:ae=`@font-face {
  font-family: "Emojis Reset";
  src: url(${_e}${c}) format("woff2");
  unicode-range: ${t}, U+1f170-1f171, U+1f17e, U+1f17f, U+1f21a, U+1f22f, U+1f232-1f23a, U+1f250, U+1f251, U+1f32b, U+1f3bc,
  U+1f411, U+1f42d, U+1f42e, U+1f431, U+1f435, U+1f441, U+1f4a8, U+1f4ab, U+1f525, ${i},
  U+1f79, U+1f8f, U+1fa79, U+1fae4, U+1fae9, U+1fac6, U+1fabe, U+1fadf,
  U+200d, U+203c, U+2049, U+2122, U+2139, U+2194-2199, U+21a9, U+21aa, U+23cf, U+25aa, U+25ab, U+25b6, U+25c0, U+25fb-25fe,
  U+2611, U+2615, U+2618, U+261d, U+2620, U+2622, U+2623, U+2626, U+262a, U+262e, U+2638-263a, U+2640, U+2642, U+2648-2653,
  U+265f, U+2660, U+2663, U+2665, U+2666, U+267b, U+267e, U+267f, U+2692-2697, U+2699, U+269b, U+269c, U+26a0, U+26a1,
  U+26a7, U+26aa, U+26ab, U+26b0, U+26b1, U+2702, U+2708, U+2709, U+270c, U+270d, U+2712, U+2714, U+2716, U+271d, U+2733,
  U+2734, U+2744, U+2747, U+2763, U+2764, U+2934-2935, U+3030, U+303d, U+3297, U+3299, U+fe0f, U+e50a, U+a9, U+ae;
  size-adjust: 92%;
}
@font-face {
  font-family: "Emojis";
  src: url(${_e}${c}) format("woff2"),
  local("Segoe UI Emoji"),
  local("Segoe UI Symbol"),
  local("Apple Color Emoji"),
  local("Twemoji Mozilla"),
  local("Noto Color Emoji"),
  local("Android Emoji"),
  local("EmojiSymbols");
  size-adjust: 92%;
}`,ae};
    return { globalFont: u, emoji: _ };
  })();

  /* --- webpack module 9335：自定义字体（导出时以 base64 内嵌 @font-face） --- */
  const CustomFonts = (function () {
const g = { fetchSyncPost: fetchSync };
var B=Object.defineProperty,x=Object.defineProperties,l=Object.getOwnPropertyDescriptors,a=Object.getOwnPropertySymbols,L=Object.prototype.hasOwnProperty,d=Object.prototype.propertyIsEnumerable,y=(N,W,ce)=>W in N?B(N,W,{enumerable:!0,configurable:!0,writable:!0,value:ce}):N[W]=ce,w=(N,W)=>{for(var ce in W||(W={}))L.call(W,ce)&&y(N,ce,W[ce]);if(a)for(var ce of a(W))d.call(W,ce)&&y(N,ce,W[ce]);return N},o=(N,W)=>x(N,l(W)),S=(N,W,ce)=>new Promise((de,ge)=>{var ue=q=>{try{$(ce.next(q))}catch(k){ge(k)}},fe=q=>{try{$(ce.throw(q))}catch(k){ge(k)}},$=q=>q.done?de(q.value):Promise.resolve(q.value).then(ue,fe);$((ce=ce.apply(N,W)).next())});
const f="SiYuanCustomFont-";let r;const C=new Map,u=new Map,c=()=>["docker","android","ios","harmony"].includes(window.siyuan.config.system.container),t=()=>(r||(r=(0,g.fetchSyncPost)("/api/system/getCustomFonts").then(N=>Array.isArray(N.data)?N.data:[]).catch(N=>{throw r=void 0,N})),r),i=()=>{r=void 0},_=N=>{n([N])},n=N=>{window.siyuan.config.system.safeMode||N.forEach(W=>{if(!ee(W))return;const ce=o(w({},W),{family:f+W.id,url:`/custom-fonts/${W.id}`,weight:Math.max(1,Math.min(1e3,W.weight||400))}),de=C.get(W.id);(de==null?void 0:de.family)===ce.family&&de.url===ce.url&&de.weight===ce.weight||(C.set(W.id,ce),u.delete(W.id),G(ce))})},p=N=>{var W;u.delete(N),C.delete(N)&&((W=document.getElementById(`customFontStyle-${N}`))==null||W.remove())},h=(N,W)=>S(void 0,null,function*(){if(window.siyuan.config.system.safeMode||!N.startsWith(f))return;const ce=N.slice(f.length);if(Z(ce))try{const ge=(yield t()).find(fe=>fe.id===ce&&fe.family===N);if(!ge)return;_(ge);let ue=u.get(ce);ue||(ue=document.fonts.load(`${W||ge.weight||400} 16px "${N}"`).catch(fe=>{throw u.delete(ce),fe}),u.set(ce,ue)),yield ue}catch(de){console.warn("load custom font failed",de)}}),O=N=>S(void 0,null,function*(){yield Promise.all(N.map(W=>h(W.family,W.weight)))}),M=N=>S(void 0,null,function*(){const W=new Set(N.map(ge=>ge.family).filter(ge=>ge.startsWith(f)));if(window.siyuan.config.system.safeMode||W.size===0)return"";const ce=(yield t()).filter(ge=>ee(ge)&&W.has(ge.family));return(yield Promise.all(ce.map(ge=>S(void 0,null,function*(){const ue=yield fetch(`/custom-fonts/${ge.id}`);if(!ue.ok)throw new Error(`export custom font failed: ${ue.status}`);const fe=yield ue.blob(),$=yield new Promise((q,k)=>{const H=new FileReader;H.onload=()=>q(H.result),H.onerror=()=>k(H.error),H.readAsDataURL(fe)});return`@font-face { font-family: "${ge.family}"; src: url("${$}"); font-style: normal; font-weight: ${Math.max(1,Math.min(1e3,ge.weight||400))}; }`})))).join(`
`)}),G=N=>{let W=document.getElementById(`customFontStyle-${N.id}`);W||(W=document.createElement("style"),W.id=`customFontStyle-${N.id}`,document.head.append(W)),W.textContent=`@font-face {
  font-family: "${N.family}";
  src: url("${N.url}");
  font-style: normal;
  font-weight: ${N.weight};
  font-display: swap;
}`},ee=N=>N&&Z(N.id)&&N.family===f+N.id,Z=N=>/^[a-f0-9]{64}$/.test(N);
    return { embed: M };
  })();

  /* --- webpack module 9950：setInlineStyle（V），导出路径使用 X=false --- */
  const SetInlineStyle = (function () {
    const IS_REMOTE = new URLSearchParams(window.location.search).get("remote") === "1";
    const O = { vg: () => ({ customAppearance: !IS_REMOTE, importExport: !IS_REMOTE }) };
    const p = {
      WT: () => fetchSync("/api/storage/getInlineStyles")
        .then((r) => ((r == null ? void 0 : r.code) !== 0 ? InlineStyles.normalize(InlineStyles.defaults) : InlineStyles.normalize(r.data)))
        .catch(() => InlineStyles.normalize(InlineStyles.defaults)),
      RN: (...a) => InlineStyles.build(...a),
    };
    const C = { LL: async () => {}, Qb: (fonts) => CustomFonts.embed(fonts) };
    const o = {
      cX: () => navigator.platform.toUpperCase().indexOf("MAC") > -1,
      bh: () => navigator.userAgent.includes("iPad") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
      mU: () => navigator.userAgent.indexOf("iPhone") > -1,
      xx: () => Promise.resolve().then(function*() {
        if (!navigator.userAgentData || !navigator.userAgentData.getHighEntropyValues) return false;
        const pe = yield navigator.userAgentData.getHighEntropyValues(["platformVersion"]);
        return navigator.userAgentData.platform === "Windows" && parseInt(pe.platformVersion.split(".")[0]) >= 13;
      }()),
    };
    const u = FontCSS.globalFont, _ = FontCSS.emoji;
    const ue = (X,_e,ae)=>new Promise((U,Q)=>{var re=Re=>{try{me(ae.next(Re))}catch(se){Q(se)}},Le=Re=>{try{me(ae.throw(Re))}catch(se){Q(se)}},me=Re=>Re.done?U(Re.value):Promise.resolve(Re.value).then(re,Le);me((ae=ae.apply(X,_e)).next())});
    const V=(X=!0,_e="../../../")=>ue(void 0,null,function*(){var ae,U;const Q=(0,O.vg)().customAppearance,re=Q?window.siyuan.config.appearance.globalFontFamilies||[]:[],Le=Q?window.siyuan.config.editor.fontFamilies||[]:[],me=Q?window.siyuan.config.editor.codeFontFamilies||[]:[];let Re="";if(Q)try{const vt=yield(0,p.WT)();Re=(0,p.RN)(vt)}catch(vt){console.error("load inline styles error: "+vt),Re=(0,p.RN)()}X&&Q&&(yield(0,C.LL)([...re,...Le,...me]));const se=(0,o.cX)()||(0,o.bh)()||(0,o.mU)()?"apple":(yield(0,o.xx)())?"windows11":"other";let Ce=_(se,_e);Ce+=u(re),X||(Ce+=`
`+(yield(0,C.Qb)([...re,...Le,...me])));const Ae=Le.map(vt=>CSS.escape(vt.family)).join(", "),De=(ae=Le[0])==null?void 0:ae.weight,et=me.map(vt=>CSS.escape(vt.family)).join(", "),Ve=et?`var(--b3-font-family-emoji-reset), ${et}, var(--b3-font-family-code)`:"var(--b3-font-family-code)",lt=((U=me[0])==null?void 0:U.weight)||400;if(Ce+=`
:root { --b3-font-size-editor: ${window.siyuan.config.editor.fontSize}px; --b3-font-family-editor: ${Ae||"var(--b3-font-family-protyle)"}; --b3-font-family-editor-code: ${Ve}; --b3-font-weight-editor-code: ${lt} }
.b3-typography code:not(.hljs), .protyle-wysiwyg span[data-type~=code] { font-variant-ligatures: ${window.siyuan.config.editor.codeLigatures?"normal":"none"} }
.b3-typography:not(.b3-typography--default) code:not(.hljs), .protyle-wysiwyg span[data-type~=code] { font-family: var(--b3-font-family-editor-code); font-weight: var(--b3-font-weight-editor-code) }${window.siyuan.config.editor.justify?`
.protyle-wysiwyg [data-node-id] { text-align: justify }`:""}`,Ae&&(Ce+=`
.b3-typography:not(.b3-typography--default), .protyle-wysiwyg, .protyle-title {${De?`font-weight: ${De};`:""}font-family: var(--b3-font-family-emoji-reset), var(--b3-font-family-editor), var(--b3-font-family)}`),"ontouchend"in document&&(Ce+=`
.b3-menu .b3-menu__action {opacity: 0.68;}`),Ce+=Re?`
`+Re:"",X){const vt=document.getElementById("siyuanStyle");if(vt)vt.innerHTML=Ce;else{const pt=document.getElementById("pluginsStyle");pt?pt.insertAdjacentHTML("beforebegin",`<style id="siyuanStyle">${Ce}</style>`):document.head.insertAdjacentHTML("beforeend",`<style id="siyuanStyle">${Ce}</style>`)}}return Ce});
    return V;
  })();

  /* --- webpack module 9950：zS 主题模式 --- */
  const themeMode = ()=>{const X=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";return window.siyuan.config.appearance.modeOS?X:window.siyuan.config.appearance.mode===0?"light":"dark"};

  /* --- 导出对话框（webpack main 模块）中 r()/C()/c()/t()/f() 的逐字移植 --- */
  async function loadPetalCSS() {
    const frontend = document.documentElement.getAttribute("data-frontend") || "siyuan-desktop";
    const ae = await fetchSyncPost("/api/petal/loadPetals", { frontend });
    let U = "";
    ((ae.code === 0 && Array.isArray(ae.data) ? ae.data : [])).forEach((Q) => { U += Q.css || ""; });
    return U;
  }
  function iconScripts(Q) {
    return (["litheness"].includes(window.siyuan.config.appearance.icon) ? "" : `<script src="${Q}appearance/icons/litheness/icon.js?v=${VERSION()}"><\/script>`) +
      `<script src="${Q}appearance/icons/${window.siyuan.config.appearance.icon}/icon.js?v=${VERSION()}"><\/script>`;
  }
  function snippetStyles() {
    let ae = "";
    document.querySelectorAll("style").forEach((U) => { U.id.startsWith("snippetCSS") && (ae += U.outerHTML); });
    return ae;
  }
  function snippetScripts() {
    let ae = "";
    document.querySelectorAll("script").forEach((U) => { U.id.startsWith("snippetJS") && (ae += U.outerHTML); });
    return ae;
  }
  function languagesJson() {
    const ae = new Set(["copy", "mindmap", "fontSize", "bold", "italic", "colorFont", "color", "undo", "redo", "fold", "collapse", "expand", "fullscreen", "exitFullscreen", "zoomIn", "zoomOut", "delete", "close", "connect", "text", "task", "taskStatusTodo", "taskStatusInProgress", "taskStatusDone", "taskStatusCanceled", "customTaskStatus", "expandLevel", "expandAll", "foldAll"]);
    const U = Object.fromEntries(Object.entries(window.siyuan.languages).filter(([Q]) => ae.has(Q) || Q.startsWith("listMindmap")));
    return JSON.stringify(U).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }

  /* --- 导出对话框 i() 的逐字移植（type=html，pdf=false，Q=""，与手动导出一致） --- */
  let _version = "";
  function VERSION() { return _version; }

  async function buildIndexHtml(name, content, version) {
    _version = version;
    const ae = { data: { name, content } };
    const Q = "";
    const re = { type: "html" };
    const L = { Constants: { SIYUAN_VERSION: version } };
    let me = window.siyuan.config.appearance.themeLight, Re = 0;;
    ["html", "htmlmd"].includes(re.type) && window.siyuan.config.appearance.mode === 1 && (me = window.siyuan.config.appearance.themeDark, Re = 1);
    const se = window.siyuan.config.appearance.mode === 1 && window.siyuan.config.appearance.themeDark === "midnight" || window.siyuan.config.appearance.mode === 0 && window.siyuan.config.appearance.themeLight === "daylight";
    let Ce = "";
    se || (Ce = `<link rel="stylesheet" type="text/css" id="themeStyle" href="${Q}appearance/themes/${me}/theme.css?${L.Constants.SIYUAN_VERSION}"/>`);
    const De = false, et = { js: "", css: "" };   /* LA()/r5() 仅在 PDF 打印分支生效，HTML 导出恒为 false */
    const Ve = `<!DOCTYPE html>
<html lang="${window.siyuan.config.appearance.lang}" data-theme-mode="${themeMode()}" data-light-theme="${window.siyuan.config.appearance.themeLight}" data-dark-theme="${window.siyuan.config.appearance.themeDark}">
<head>
    <base href="${Q}">
    <meta charset="utf-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0"/>
    <meta name="mobile-web-app-capable" content="yes"/>
    <meta name="apple-mobile-web-app-status-bar-style" content="black">
    <link rel="stylesheet" type="text/css" id="baseStyle" href="${Q}stage/build/export/base.css?v=${L.Constants.SIYUAN_VERSION}"/>
    <link rel="stylesheet" type="text/css" id="themeDefaultStyle" href="${Q}appearance/themes/${me}/theme.css?v=${L.Constants.SIYUAN_VERSION}"/>
    <script src="${Q}stage/protyle/js/protyle-html.js?v=${L.Constants.SIYUAN_VERSION}"><\/script>
    ${Ce}
    <title>${ae.data.name}</title>
    <!-- Exported by SiYuan v${L.Constants.SIYUAN_VERSION} -->
    <style>
        body {font-family: var(--b3-font-family);background-color: var(--b3-theme-background);color: var(--b3-theme-on-background)}
        ${await SetInlineStyle(!1, Q)}
        ${await loadPetalCSS()}
        ${et.css}
    </style>
    ${snippetStyles()}
</head>
<body>
<div class="${["htmlmd", "word"].includes(re.type) ? "b3-typography" : "protyle-wysiwyg" + (window.siyuan.config.editor.displayBookmarkIcon ? " protyle-wysiwyg--attr" : "")}" 
style="max-width: 800px;margin: 0 auto;" id="preview">${ae.data.content}</div>
${iconScripts(Q)}
<script src="${Q}stage/build/export/protyle-method.js?v=${L.Constants.SIYUAN_VERSION}"><\/script>
<script src="${Q}stage/protyle/js/lute/lute.min.js?v=${L.Constants.SIYUAN_VERSION}"><\/script>  
<script>
    ${et.js}
    window.siyuan = {
      config: {
        appearance: { mode: ${Re}, codeBlockThemeDark: "${window.siyuan.config.appearance.codeBlockThemeDark}", codeBlockThemeLight: "${window.siyuan.config.appearance.codeBlockThemeLight}" },
        editor: { 
          codeLineWrap: true,
          fontSize: ${window.siyuan.config.editor.fontSize},
          codeLigatures: ${window.siyuan.config.editor.codeLigatures},
          plantUMLServePath: "${window.siyuan.config.editor.plantUMLServePath}",
          codeSyntaxHighlightLineNum: ${window.siyuan.config.editor.codeSyntaxHighlightLineNum},
          katexMacros: decodeURI(\`${encodeURI(window.siyuan.config.editor.katexMacros)}\`),
        }
      },
      languages: ${languagesJson()}
    };
    const previewElement = document.getElementById('preview');
    Protyle.highlightRender(previewElement, "stage/protyle");
    Protyle.setAutoDirection(previewElement, ${!!window.siyuan.config.editor.autoDirection});
    Protyle.mathRender(previewElement, "stage/protyle", ${re.type === "pdf"});
    Protyle.mermaidRender(previewElement, "stage/protyle");
    Protyle.flowchartRender(previewElement, "stage/protyle");
    Protyle.graphvizRender(previewElement, "stage/protyle");
    Protyle.chartRender(previewElement, "stage/protyle");
    Protyle.mindmapRender(previewElement, "stage/protyle");
    Protyle.abcRender(previewElement, "stage/protyle");
    Protyle.htmlRender(previewElement);
    if (${re.type !== "pdf"}) {
        Protyle.tabsRender(previewElement);
    }
    Protyle.plantumlRender(previewElement, "stage/protyle");
    document.querySelectorAll(".protyle-action__copy").forEach((item) => {
      item.addEventListener("click", (event) => {
            navigator.clipboard.writeText(item.parentElement.nextElementSibling.textContent.trimEnd().replace(/\xA0/g, " ").replace(/\u200D\`\`\`/g, "\`\`\`"));
            event.preventDefault();
            event.stopPropagation();
      })
    });
<\/script>
${snippetScripts()}</body></html>`;
    return Ve;
  }

  return { buildIndexHtml };
})();
