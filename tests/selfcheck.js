/**
 * 自检脚本（开发期使用，不属于插件功能）
 *
 * 位置：tests/selfcheck.js，在项目根目录用 `node tests/selfcheck.js` 执行。
 *
 * 检查项：
 *  1) JS 语法
 *  2) manifest.json 合法性（权限、host、icons、web_accessible_resources 暴露范围）
 *  3) HTML：无内联脚本、无 on* 内联事件、锚点与导航一致、无外部资源引用
 *  4) CSS：所有 var(--x) 均在 :root 中定义
 *  5) 跨文件消息契约字符串一致
 */
'use strict';
const fs = require('fs');
const path = require('path');

// 脚本位于 tests/ 下，项目根目录是它的上一级
const ROOT = path.join(__dirname, '..');
let problems = 0;
let checks = 0;

function ok(label, detail) {
  checks += 1;
  console.log(`  [PASS] ${label}${detail ? ' -> ' + detail : ''}`);
}
function bad(label, detail) {
  checks += 1;
  problems += 1;
  console.log(`  [FAIL] ${label}${detail ? ' -> ' + detail : ''}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 去掉注释，避免把注释里的字符串当成真实代码（例如「不能用 URL.createObjectURL」这类说明） */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释（避开 http:// 这类情况）
}

/* ---------- 1. JS 语法（用 new Function 做一次解析） ---------- */
console.log('\n== 1. JS 语法 ==');
const jsFiles = ['content.js', 'background.js', 'gallery.js', 'docs/js/main.js'];
jsFiles.forEach((file) => {
  const code = read(file);
  try {
    // 只解析不执行
    new Function(code);
    ok(file);
  } catch (error) {
    bad(file, error.message);
  }
});

/* ---------- 2. manifest.json ---------- */
console.log('\n== 2. manifest.json ==');
let manifest = null;
try {
  manifest = JSON.parse(read('manifest.json'));
  ok('JSON 合法');
} catch (error) {
  bad('JSON 解析', error.message);
}
if (manifest) {
  const need = ['activeTab', 'scripting', 'downloads', 'storage'];
  const missing = need.filter((p) => !manifest.permissions.includes(p));
  missing.length === 0 ? ok('permissions 完整', need.join(',')) : bad('permissions 缺少', missing.join(','));

  const hosts = manifest.host_permissions.join(' ');
  ['taobao.com', 'tmall.com', 'jd.com', 'pinduoduo.com', 'yangkeduo.com'].forEach((d) => {
    hosts.includes(d) ? ok(`host_permissions 含 ${d}`) : bad(`host_permissions 缺少 ${d}`);
  });

  manifest.content_scripts[0].matches.length >= 5
    ? ok('content_scripts matches 数量', String(manifest.content_scripts[0].matches.length))
    : bad('content_scripts matches 过少');

  manifest.background && manifest.background.service_worker
    ? ok('service_worker 已配置', manifest.background.service_worker)
    : bad('缺少 background.service_worker');

  const war = manifest.web_accessible_resources || [];
  JSON.stringify(war).includes('content.css')
    ? ok('content.css 已声明为 web_accessible_resources')
    : bad('content.css 未声明 web_accessible_resources');

  // 暴露范围应收窄到平台域名：<all_urls> 会让任何网站都能探测到扩展指纹
  const warMatches = (war[0] && war[0].matches) || [];
  warMatches.includes('<all_urls>')
    ? bad('web_accessible_resources 暴露给 <all_urls>')
    : ok('web_accessible_resources 已收窄', warMatches.join(' '));

  // 图标：Chrome 的 icons 字段只支持 PNG（不支持 SVG），声明了就必须是真实存在、尺寸对得上的 PNG
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  /**
   * 校验一组「尺寸 -> PNG 路径」的图标声明
   * @param {object} group 图标映射，例如 manifest.icons
   * @param {string} label 出错时的提示前缀
   */
  function checkIconGroup(group, label) {
    const keys = Object.keys(group);
    keys.length >= 4 ? ok(`${label} 声明了 4 个尺寸`, keys.join(',')) : bad(`${label} 尺寸数量不足`, keys.join(','));

    keys.forEach((size) => {
      const rel = group[size];
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) {
        bad(`${label} 文件缺失 ${rel}`);
        return;
      }
      const buf = fs.readFileSync(abs);
      if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) {
        bad(`${label} 不是合法 PNG ${rel}`);
        return;
      }
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      w === Number(size) && h === Number(size)
        ? ok(`${label} 尺寸正确 ${rel}`, `${w}×${h}`)
        : bad(`${label} 尺寸与声明不符 ${rel}`, `${w}×${h} ≠ ${size}`);
    });
  }

  if (!manifest.icons) {
    bad('未声明 icons（工具栏会显示 Chrome 默认的拼图图标）');
  } else {
    checkIconGroup(manifest.icons, 'icons');
  }

  // 工具栏按钮图标：不声明 default_icon 时 Chrome 会回退到 icons，但显式声明更稳妥，
  // 尤其是「图标加载了却看不到按钮图标」这类排查。
  const actionIcons = (manifest.action && manifest.action.default_icon) || null;
  actionIcons
    ? checkIconGroup(actionIcons, 'action.default_icon')
    : bad('未声明 action.default_icon（工具栏图标依赖 icons 回退）');

  // 检查清单里引用的文件是否都存在
  const referenced = [
    manifest.background.service_worker,
    ...manifest.content_scripts[0].js,
    ...manifest.content_scripts[0].css,
    'gallery.html',
    'gallery.js',
    'gallery.css'
  ];
  referenced.forEach((file) => {
    fs.existsSync(path.join(ROOT, file)) ? ok(`文件存在 ${file}`) : bad(`清单引用的文件缺失 ${file}`);
  });
}

/* ---------- 3. HTML 检查 ---------- */
console.log('\n== 3. HTML ==');
function checkHtml(rel, expectAnchors, externalAllowed) {
  const html = read(rel);
  const label = path.basename(rel);

  // 所有 <script> 必须带 src（MV3 画廊页禁止内联脚本）
  const scriptTags = html.match(/<script[^>]*>/gi) || [];
  const inlineScript = scriptTags.filter((tag) => !/\ssrc=/i.test(tag));
  inlineScript.length === 0
    ? ok(`${label} 脚本全部外链`, `${scriptTags.length} 个`)
    : bad(`${label} 存在内联脚本`, inlineScript.join(' '));

  // 不允许 on* 内联事件属性
  const onAttrs = html.match(/\son(click|change|input|submit|load|error|mouseover|keydown|focus)\s*=/gi) || [];
  onAttrs.length === 0 ? ok(`${label} 无内联事件属性`) : bad(`${label} 含内联事件`, onAttrs.join(','));

  // 不允许内联 style 属性（画廊页内联样式由 JS 动态写入，静态 HTML 里不应出现 style="..."）
  const styleAttrs = html.match(/\sstyle\s*=\s*"/gi) || [];
  styleAttrs.length === 0 ? ok(`${label} 无静态 style 属性`) : bad(`${label} 含静态 style 属性`, styleAttrs.length + ' 处');

  // 锚点与导航一致性
  expectAnchors.forEach((anchor) => {
    const hasId = new RegExp(`id="${anchor}"`).test(html);
    hasId ? ok(`${label} 存在锚点 #${anchor}`) : bad(`${label} 缺少锚点 #${anchor}`);
  });

  // 外部资源检查
  const allUrls = html.match(/https?:\/\/[^\s"'<>]+/g) || [];
  const offending = allUrls.filter((u) => !externalAllowed.some((prefix) => u.startsWith(prefix)));
  offending.length === 0
    ? ok(`${label} 无未授权外部资源`)
    : bad(`${label} 含外部资源`, offending.join(','));

  // 标签平衡（粗略：统计成对标签）
  ['div', 'section', 'article', 'header', 'footer', 'nav', 'ul', 'ol', 'li', 'p', 'h1', 'h2', 'h3', 'span', 'button', 'label', 'aside', 'main'].forEach((tag) => {
    const open = (html.match(new RegExp(`<${tag}(?:\\s|>)`, 'gi')) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'gi')) || []).length;
    if (open !== close) bad(`${label} <${tag}> 标签不匹配`, `open=${open} close=${close}`);
  });
  ok(`${label} 标签平衡检查完成`);
}

checkHtml('gallery.html', [], []);
checkHtml('docs/index.html', ['about', 'features', 'install', 'download'], ['https://github.com/']);

/* ---------- 4. CSS 变量 ---------- */
console.log('\n== 4. CSS 变量 ==');
function checkCssVars(rel) {
  const css = read(rel);
  const label = path.basename(rel);

  // Shadow DOM 场景下变量定义在 :host 上，所以 :root 与 :host 都算声明作用域
  const rootBlocks = css.match(/(?::root|:host)\s*\{[\s\S]*?\}/gi) || [];
  const declared = new Set();
  rootBlocks.forEach((block) => {
    (block.match(/--[\w-]+\s*:/g) || []).forEach((name) => declared.add(name.replace(/\s*:$/, '')));
  });

  const used = new Set((css.match(/var\(\s*(--[\w-]+)/g) || []).map((s) => s.replace(/var\(\s*/, '')));
  const missing = [...used].filter((name) => !declared.has(name));

  missing.length === 0
    ? ok(`${label} 变量齐全`, `${declared.size} 个已定义 / ${used.size} 个被使用`)
    : bad(`${label} 未定义变量`, missing.join(','));
}

checkCssVars('gallery.css');
checkCssVars('content.css');
checkCssVars('docs/css/style.css');

/* ---------- 5. 跨文件消息契约 ---------- */
console.log('\n== 5. 消息契约 ==');
const contract = [
  'IMAGE_GRAB_EXTRACTED',
  'IMAGE_GRAB_GET_LATEST',
  'IMAGE_GRAB_DOWNLOAD',
  'IMAGE_GRAB_PROGRESS',
  'IMAGE_GRAB_LATEST_UPDATED',
  'IMAGE_GRAB_TRIGGER_EXTRACT',
  'IMAGE_GRAB_PING'
];
const contentJs = read('content.js');
const backgroundJs = read('background.js');
const galleryJs = read('gallery.js');
const allSources = contentJs + backgroundJs + galleryJs;

contract.forEach((type) => {
  const inAll = allSources.includes(type);
  inAll ? ok(`消息类型 ${type} 出现在源码中`) : bad(`消息类型 ${type} 未找到`);
});

// 存储键一致性
['imageGrab.latest', 'imageGrab.settings'].forEach((key) => {
  backgroundJs.includes(key) && galleryJs.includes(key)
    ? ok(`存储键 ${key} 三处一致`)
    : bad(`存储键 ${key} 不一致`, `background=${backgroundJs.includes(key)} gallery=${galleryJs.includes(key)}`);
});

// 未定义常量引用检查（简单的拼写核对）
['MSG_EXTRACTED', 'MSG_TRIGGER_EXTRACT', 'MSG_PING'].forEach((name) => {
  contentJs.includes(`const ${name} =`) ? ok(`content.js 定义 ${name}`) : bad(`content.js 缺少 ${name}`);
});
['MSG_EXTRACTED', 'MSG_GET_LATEST', 'MSG_DOWNLOAD', 'MSG_PROGRESS', 'MSG_LATEST_UPDATED', 'MSG_TRIGGER_EXTRACT', 'MSG_PING'].forEach((name) => {
  backgroundJs.includes(`const ${name} =`) ? ok(`background.js 定义 ${name}`) : bad(`background.js 缺少 ${name}`);
});
['MSG_GET_LATEST', 'MSG_DOWNLOAD', 'MSG_PROGRESS', 'MSG_LATEST_UPDATED'].forEach((name) => {
  galleryJs.includes(`const ${name} =`) ? ok(`gallery.js 定义 ${name}`) : bad(`gallery.js 缺少 ${name}`);
});

// 关键陷阱：Service Worker 里不能出现 URL.createObjectURL（注释里的说明不算）
const backgroundCode = stripComments(backgroundJs);
/URL\.createObjectURL\s*\(/.test(backgroundCode)
  ? bad('background.js 使用了 URL.createObjectURL（MV3 SW 不支持）')
  : ok('background.js 未调用 URL.createObjectURL（仅注释说明）');

// file:// 直开检查：main.js 不能使用 ES module 语法
/\b(import|export)\s/.test(stripComments(read('docs/js/main.js')))
  ? bad('docs/js/main.js 使用了 ES module 语法（file:// 下会失败）')
  : ok('docs/js/main.js 为普通脚本，file:// 可直接运行');

// gallery.js 也不能依赖 ES module
/\bimport\s|\bexport\s/.test(stripComments(galleryJs))
  ? bad('gallery.js 使用了 ES module 语法')
  : ok('gallery.js 为普通脚本');

// 文件清单
console.log('\n== 6. 文件清单 ==');
const required = [
  'manifest.json', 'content.js', 'content.css', 'background.js',
  'gallery.html', 'gallery.js', 'gallery.css', 'README.md',
  'docs/index.html', 'docs/css/style.css', 'docs/js/main.js', 'docs/assets/logo.svg'
];
required.forEach((file) => {
  if (fs.existsSync(path.join(ROOT, file))) {
    const size = fs.statSync(path.join(ROOT, file)).size;
    ok(`${file}`, `${size} 字节`);
  } else {
    bad(`缺少文件 ${file}`);
  }
});

// 根目录不应再残留已经迁移到 tests/ 的开发脚本（否则用户会把它们一起当成扩展加载）
['.selfcheck.js', '.test-background.js', '.test-content.js', '.test-gallery.js'].forEach((legacy) => {
  fs.existsSync(path.join(ROOT, legacy))
    ? bad(`根目录残留旧脚本 ${legacy}（已迁移到 tests/）`)
    : ok(`根目录无旧脚本 ${legacy}`);
});

/* ---------- 7. 文件编码 ---------- */

console.log('\n== 7. 文件编码 ==');

// 为什么单列一节：docs/assets/logo.svg 曾被有损写坏过（每个汉字丢掉高字节，
// 中文变成一串非法 UTF-8 字节），而语法检查、DOM 检查、CSS 检查都发现不了这件事，
// 只有直接比对字节才能拦住。
const textFiles = [
  'manifest.json',
  'content.js', 'content.css', 'background.js',
  'gallery.html', 'gallery.js', 'gallery.css',
  'README.md',
  'docs/index.html', 'docs/css/style.css', 'docs/js/main.js', 'docs/assets/logo.svg',
  'tests/selfcheck.js', 'tests/test-content.js', 'tests/test-background.js', 'tests/test-gallery.js',
  'tests/make-icons.js'
];

textFiles.forEach((rel) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    bad(`编码检查缺少文件 ${rel}`);
    return;
  }
  const bytes = fs.readFileSync(abs);
  const text = bytes.toString('utf8');
  const validUtf8 = Buffer.from(text, 'utf8').equals(bytes);
  const replacement = (text.match(/\uFFFD/g) || []).length;
  const nonAscii = bytes.filter((b) => b > 127).length;

  validUtf8 && replacement === 0
    ? ok(`${rel} 是合法 UTF-8`, `非 ASCII 字节 ${nonAscii}`)
    : bad(`${rel} 编码异常`, `合法UTF8=${validUtf8} U+FFFD=${replacement}`);
});

// 中文文案是最容易被写坏的部分：确认字面量还在，而不是被替换成 '?' 或截断字节
const MUST_KEEP_CHINESE = [
  ['docs/assets/logo.svg', '图提取 ImageGrab'],
  ['docs/index.html', '一键提取电商详情页所有图片'],
  ['README.md', '文件结构'],
  ['content.js', '获取图片'],
  ['gallery.html', '图提取 ImageGrab']
];
MUST_KEEP_CHINESE.forEach(([file, literal]) => {
  read(file).includes(literal)
    ? ok(`${file} 保留中文`, literal)
    : bad(`${file} 中文丢失`, literal);
});

console.log(`\n===== 共 ${checks} 项检查，失败 ${problems} 项 =====`);
process.exit(problems === 0 ? 0 : 1);
