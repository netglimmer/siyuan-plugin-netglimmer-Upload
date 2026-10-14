/* 零依赖打包脚本（只用 node 自带的 fs）：src/core.js + src/vendored/*.js → index.js
 *
 *   node build.js          组装并写出 index.js
 *   node build.js --verify 只在内存里组装，与磁盘上的 index.js 逐字节比对，不写文件
 *   node build.js --check  校验 src/ 内部一致性（标记齐全、无孤立段文件），不写文件
 *
 * 思源插件在前端是「整个 index.js 一次执行」，运行时没有 import 机制，
 * 所以这里的组装只是文本拼接：发布产物仍然是一个单文件 index.js，
 * 与拆分前的行为逐字节等价（--verify 就是用来证明这一点的）。
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const CORE = path.join(ROOT, "src", "core.js");
const VDIR = path.join(ROOT, "src", "vendored");
const OUT = path.join(ROOT, "index.js");
const BEGIN = "/* @@SEGMENT-BEGIN@@ */";
const MARK_RE = /^\/\* @@VENDOR:([a-z0-9-]+)@@[^*]*\*\/$/;

function readSegment(name) {
  const file = path.join(VDIR, name + ".js");
  if (!fs.existsSync(file)) throw new Error("missing vendored segment file: src/vendored/" + name + ".js");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const at = lines.indexOf(BEGIN);
  if (at < 0) throw new Error(file + " 缺少 " + BEGIN + " 分隔行");
  const body = lines.slice(at + 1);
  // 文件末尾换行产生的那一个空元素不算内容；段内的真实空行仍然保留
  while (body.length && body[body.length - 1] === "") body.pop();
  return body.join("\n");
}

function assemble() {
  const core = fs.readFileSync(CORE, "utf8").split("\n");
  const seen = new Set();
  const out = [];
  for (const line of core) {
    const m = MARK_RE.exec(line);
    if (!m) { out.push(line); continue; }
    const name = m[1];
    if (seen.has(name)) throw new Error("重复的段标记: " + name);
    seen.add(name);
    out.push(readSegment(name));
  }
  // 有标记没有对应文件会在 readSegment 里抛错；反过来（有文件没标记）也要发现
  const files = fs.existsSync(VDIR)
    ? fs.readdirSync(VDIR).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, ""))
    : [];
  const orphan = files.filter((f) => !seen.has(f));
  if (orphan.length) throw new Error("vendored 文件没有被 core.js 引用（拼不进去）: " + orphan.join(", "));
  return out.join("\n");
}

const built = assemble();
const args = process.argv.slice(2);
if (args.includes("--check")) {
  console.log("src/ 结构一致：core.js + " + fs.readdirSync(VDIR).join(", "));
  process.exit(0);
}
if (args.includes("--verify")) {
  const cur = fs.readFileSync(OUT, "utf8");
  if (cur === built) { console.log("VERIFY OK: index.js 与 src/ 拼装结果逐字节一致"); process.exit(0); }
  const a = cur.split("\n"), b = built.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  console.error("VERIFY FAIL: 第 " + (i + 1) + " 行开始不一致");
  console.error("  index.js : " + JSON.stringify((a[i] || "").slice(0, 160)));
  console.error("  built    : " + JSON.stringify((b[i] || "").slice(0, 160)));
  console.error(`  行数 ${a.length} vs ${b.length}，字节 ${Buffer.byteLength(cur)} vs ${Buffer.byteLength(built)}`);
  process.exit(1);
}
const before = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
fs.writeFileSync(OUT, built, "utf8");
console.log((before === built ? "index.js 无变化" : "index.js 已生成")
  + "：" + built.split("\n").length + " 行 / " + Buffer.byteLength(built) + " 字节");
