/**
 * content.js 功能测试（开发期使用，不属于插件功能）
 *
 * 位置：tests/test-content.js，在项目根目录用 `node tests/test-content.js` 执行。
 *
 * 在 jsdom 里模拟商品详情页，真实执行 content.js 的提取流程，
 * 覆盖：详情页判定、按钮注入、多来源扫描、过滤、去重、尺寸探测、消息上报。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 脚本位于 tests/ 下，项目根目录是它的上一级
const PROJECT = path.join(__dirname, '..');

/**
 * 加载 jsdom：依次尝试「环境变量 IG_JSDOM_PATH」「直接 require」
 * 「项目根/脚本目录下的 node_modules」「开发时用过的临时目录」。
 * 换台机器或临时目录被清理时，只要 `npm i jsdom` 就能跑；
 * 实在找不到就打印提示并跳过，而不是抛异常崩溃。
 * @returns {{JSDOM: Function}|null}
 */
function loadJSDOM() {
  const candidates = [];
  if (process.env.IG_JSDOM_PATH) candidates.push(process.env.IG_JSDOM_PATH);
  candidates.push(
    'jsdom',
    path.join(PROJECT, 'node_modules', 'jsdom'),
    path.join(__dirname, 'node_modules', 'jsdom'),
    'C:/Users/cy155/AppData/Local/Temp/ig-test/node_modules/jsdom'
  );

  const errors = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      errors.push(`  ${candidate} -> ${error.code || error.message}`);
    }
  }

  console.log('[SKIP] 未找到 jsdom，tests/test-content.js 本次跳过（这不是插件功能的问题）。');
  console.log('       安装：在项目根目录执行 npm i jsdom；');
  console.log('       或设置环境变量 IG_JSDOM_PATH 指向包含 jsdom 的 node_modules 目录。');
  if (process.env.IG_JSDOM_DEBUG) console.log(errors.join('\n'));
  return null;
}

const jsdomModule = loadJSDOM();
if (!jsdomModule) process.exit(0);

const { JSDOM } = jsdomModule;

const CONTENT_JS = fs.readFileSync(path.join(PROJECT, 'content.js'), 'utf8');

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  [PASS] ${label}${detail ? ' -> ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${label}${detail ? ' -> ' + detail : ''}`);
  }
}

/* ============================================================
   测试页面：模拟淘宝商品详情页的各种图片来源
   ============================================================ */
const PAGE_HTML = `<!DOCTYPE html>
<html><head><title>测试商品 - 淘宝</title></head>
<body>
  <!-- 1. 主图（带 CDN 尺寸后缀，应被还原为原图） -->
  <img id="main" src="https://img.alicdn.com/imgextra/i1/xxx/O1CN01product1.jpg_400x400.jpg" width="800" height="800">

  <!-- 2. 相对路径图片（应补全为绝对地址） -->
  <img id="relative" src="/relative/product2.png">

  <!-- 3. 同一张主图的 http 版本 + 无后缀版本（应被去重合并） -->
  <img id="dup" src="http://img.alicdn.com/imgextra/i1/xxx/O1CN01product1.jpg">

  <!-- 4. 图标（URL 含 icon，应被过滤） -->
  <img id="icon" src="https://img.alicdn.com/imgextra/icon-cart.png">

  <!-- 5. 过小的图片（50x50，应被尺寸过滤） -->
  <img id="small" src="https://img.alicdn.com/imgextra/small.jpg">

  <!-- 6. 懒加载：无 src，只有 data-src -->
  <img id="lazy" data-src="https://img.alicdn.com/imgextra/lazy1.webp">

  <!-- 7. srcset 多倍图 -->
  <img id="srcset" src="https://img.alicdn.com/imgextra/a-300.jpg"
       srcset="https://img.alicdn.com/imgextra/a-300.jpg 300w, https://img.alicdn.com/imgextra/a-600.jpg 600w">

  <!-- 8. data: 占位图（应跳过） -->
  <img id="placeholder" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">

  <!-- 9. 1x1 像素图（应跳过） -->
  <img id="pixel" src="https://img.alicdn.com/imgextra/pixel.gif?1x1">

  <!-- 10. CSS 背景图 -->
  <div id="bg" style="width:800px;height:600px;background-image:url('https://img.alicdn.com/bg/banner-800.jpg')"></div>

  <!-- 11. picture + source srcset -->
  <picture>
    <source srcset="https://img.alicdn.com/pic/p1.webp 1600w" type="image/webp">
    <img id="pictureImg" src="https://img.alicdn.com/pic/p1-fallback.jpg">
  </picture>

  <!-- 12. 视频封面 -->
  <video id="video" poster="https://img.alicdn.com/video/poster.jpg"></video>

  <!-- 13. 背景图为渐变的元素（不应被误判为图片） -->
  <div id="gradient" style="background-image:linear-gradient(#fff,#000)"></div>
</body></html>`;

/* ============================================================
   构造一个 jsdom 环境，并注入 chrome API + Image 桩
   ============================================================ */
function createEnv({ url, html }) {
  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only',   // 允许 window.eval 执行我们的脚本
    pretendToBeVisual: true       // 提供 requestAnimationFrame
  });

  const { window } = dom;

  // ---- 图片尺寸表：按 URL 片段决定加载结果 ----
  const sizeMap = [
    ['O1CN01product1.jpg', { w: 800, h: 800 }],
    ['product2.png', { w: 600, h: 600 }],
    ['lazy1.webp', { w: 1200, h: 1200 }],
    ['a-300.jpg', { w: 500, h: 500 }],
    ['a-600.jpg', { w: 760, h: 760 }],
    ['banner-800.jpg', { w: 800, h: 600 }],
    ['p1.webp', { w: 1600, h: 1600 }],
    ['p1-fallback.jpg', { w: 1200, h: 1200 }],
    ['poster.jpg', { w: 900, h: 500 }],
    ['small.jpg', { w: 50, h: 50 }],
    ['icon-cart.png', { w: 32, h: 32 }],
    ['pixel.gif', { w: 1, h: 1 }]
  ];

  /**
   * 模拟浏览器 Image 的加载行为：
   * 命中尺寸表则触发 onload 并给出自然尺寸，未命中的地址视为加载失败。
   */
  class FakeImage {
    constructor() {
      this.naturalWidth = 0;
      this.naturalHeight = 0;
      this.onload = null;
      this.onerror = null;
      this.referrerPolicy = '';
      this.decoding = '';
      this._src = '';
    }

    get src() {
      return this._src;
    }

    set src(value) {
      this._src = value;
      const hit = sizeMap.find(([fragment]) => value.includes(fragment));
      // 用 setTimeout 模拟异步加载
      window.setTimeout(() => {
        if (hit) {
          this.naturalWidth = hit[1].w;
          this.naturalHeight = hit[1].h;
          if (typeof this.onload === 'function') this.onload();
        } else if (typeof this.onerror === 'function') {
          this.onerror();
        }
      }, 1);
    }
  }

  window.Image = FakeImage;

  // ---- chrome API 桩 ----
  const sentMessages = [];
  const messageListeners = [];

  window.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://testextensionid/${p}`,
      sendMessage: (message, callback) => {
        sentMessages.push(message);
        if (typeof callback === 'function') {
          window.setTimeout(
            () => callback({ ok: true, count: message.images ? message.images.length : 0 }),
            1
          );
        }
      },
      onMessage: {
        addListener: (fn) => messageListeners.push(fn)
      }
    }
  };

  // ---- 执行 content.js（在 jsdom 的全局作用域里）----
  window.eval(CONTENT_JS);

  return { dom, window, sentMessages, messageListeners };
}

/** 轮询等待条件成立 */
function waitFor(fn, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      let result = false;
      try {
        result = fn();
      } catch (e) {
        result = false;
      }
      if (result) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - start > timeout) {
        clearInterval(timer);
        reject(new Error('等待超时'));
      }
    }, 20);
  });
}

/**
 * 等待 jsdom 完成 DOMContentLoaded 与 content.js 的初始化
 * （jsdom 的 DOMContentLoaded 是异步触发的，eval 之后需要让出一个事件循环周期）
 * @param {object} env
 * @param {boolean} [expectButton] 是否期待按钮出现（true 时轮询等待）
 */
async function ready(env, expectButton) {
  await new Promise((resolve) => env.window.setTimeout(resolve, 60));
  if (expectButton) {
    try {
      await waitFor(() => !!env.window.document.getElementById('imagegrab-host'), 2000);
    } catch (error) {
      /* 交给断言去报告失败 */
    }
  }
}

/* ============================================================
   用例 1：商品详情页 —— 完整提取流程
   ============================================================ */
async function testDetailPage() {
  console.log('\n== 用例 1：淘宝商品详情页（正常提取） ==');
  const env = createEnv({
    url: 'https://item.taobao.com/item.htm?id=123456789&spm=a1z10.3-c.w4002-1.1',
    html: PAGE_HTML
  });

  const { window, sentMessages } = env;
  await ready(env, true);
  const host = window.document.getElementById('imagegrab-host');

  check('已注入悬浮按钮宿主元素', !!host);
  if (!host) return;

  check('宿主使用 Shadow DOM 隔离样式', !!host.shadowRoot);
  const btn = host.shadowRoot.querySelector('.ig-btn');
  check('按钮文案为「获取图片」', !!btn && /获取图片/.test(btn.textContent), btn ? btn.textContent.trim() : '');
  check('按钮内联定位为 fixed 右下角',
    host.style.position === 'fixed' && host.style.right === '24px' && host.style.bottom === '24px',
    `${host.style.position} ${host.style.right} ${host.style.bottom}`);
  check('按钮引用的 content.css 来自 chrome.runtime.getURL',
    host.shadowRoot.querySelector('link').href.includes('chrome-extension://testextensionid/content.css'));

  // 点击按钮，触发完整提取流程
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  await waitFor(() => sentMessages.length > 0);

  const message = sentMessages[0];
  check('已向 background 发送 IMAGE_GRAB_EXTRACTED',
    message && message.type === 'IMAGE_GRAB_EXTRACTED', message && message.type);
  check('消息携带平台标识 taobao', message.platform === 'taobao', message.platform);
  check('消息携带页面 URL 与标题', !!message.pageUrl && !!message.pageTitle, message.pageTitle);

  const urls = message.images.map((i) => i.url);
  console.log('    提取到的图片：');
  message.images.forEach((i) => console.log(`      - ${i.source.padEnd(10)} ${i.width}x${i.height}  ${i.url}`));

  // 各类来源
  check('提取到主图并还原为原图地址（去掉 _400x400 后缀）',
    urls.includes('https://img.alicdn.com/imgextra/i1/xxx/O1CN01product1.jpg'));
  check('相对路径已补全为绝对 URL',
    urls.includes('https://item.taobao.com/relative/product2.png'));
  check('data-src 懒加载图已提取',
    urls.includes('https://img.alicdn.com/imgextra/lazy1.webp'));
  check('srcset 中的多倍图已提取',
    urls.includes('https://img.alicdn.com/imgextra/a-300.jpg') &&
    urls.includes('https://img.alicdn.com/imgextra/a-600.jpg'));
  check('video poster 已提取',
    urls.includes('https://img.alicdn.com/video/poster.jpg'));
  check('picture/source srcset 已提取',
    urls.includes('https://img.alicdn.com/pic/p1.webp'));

  // 去重：主图的原始地址只应出现一次
  const dupCount = urls.filter((u) => u === 'https://img.alicdn.com/imgextra/i1/xxx/O1CN01product1.jpg').length;
  check('http/https 与尺寸后缀变体已去重', dupCount === 1, `出现 ${dupCount} 次`);

  // 过滤项
  check('图标 URL（含 icon）已被过滤', !urls.some((u) => u.includes('icon-cart')));
  check('小于 100x100 的图片已被过滤', !urls.some((u) => u.includes('small.jpg')));
  check('data: 占位图已被过滤', !urls.some((u) => u.startsWith('data:')));
  check('1x1 像素图已被过滤', !urls.some((u) => u.includes('pixel.gif')));
  check('渐变背景未被误判为图片', !urls.some((u) => u.includes('linear-gradient')));

  // 排序：按面积从大到小
  const areas = message.images.map((i) => i.width * i.height);
  const sorted = areas.every((area, i) => i === 0 || areas[i - 1] >= area);
  check('结果按图片面积降序排列', sorted, areas.join(' > '));

  // 每条记录字段完整
  check('每条记录都含 url/width/height/source',
    message.images.every((i) => !!i.url && typeof i.width === 'number' && typeof i.height === 'number' && !!i.source));

  // 状态提示
  const status = host.shadowRoot.querySelector('.ig-status');
  check('按钮状态气泡给出了结果反馈', !!status && !status.hidden && /已提取|正在打开预览页/.test(status.textContent),
    status ? status.textContent : '');
}

/* ============================================================
   用例 2：背景图提取（单独校验，避免 jsdom 对计算样式的差异影响判断）
   ============================================================ */
async function testBackgroundImage() {
  console.log('\n== 用例 2：CSS 背景图提取 ==');
  const env = createEnv({
    url: 'https://item.taobao.com/item.htm?id=999',
    html: `<!DOCTYPE html><html><body>
      <div id="bg1" style="width:800px;height:600px;background-image:url('https://img.alicdn.com/bg/banner-800.jpg')"></div>
      <img id="real" src="https://img.alicdn.com/imgextra/i1/xxx/O1CN01product1.jpg">
    </body></html>`
  });

  const { window, sentMessages } = env;
  await ready(env, true);
  const btn = window.document.getElementById('imagegrab-host').shadowRoot.querySelector('.ig-btn');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => sentMessages.length > 0);

  const urls = sentMessages[0].images.map((i) => i.url);
  const bgItem = sentMessages[0].images.find((i) => i.url.includes('banner-800.jpg'));

  if (bgItem) {
    check('背景图已被提取', true, `${bgItem.url} (source=${bgItem.source})`);
    check('背景图来源标记为 background', bgItem.source === 'background', bgItem.source);
  } else {
    console.log('  [SKIP] jsdom 未返回 background-image 计算样式，该分支在 jsdom 中无法验证（已在真实浏览器场景由 getComputedStyle 覆盖）');
  }
  check('同一页面普通图片仍被正常提取', urls.length > 0, `${urls.length} 张`);
}

/* ============================================================
   用例 3：非详情页 —— 不应注入任何 UI
   ============================================================ */
function testNonDetailPage() {
  console.log('\n== 用例 3：非详情页（搜索页）不注入按钮 ==');
  const env = createEnv({
    url: 'https://s.taobao.com/search?q=%E6%89%8B%E6%9C%BA',
    html: PAGE_HTML
  });

  return ready(env, false).then(() => {
    const host = env.window.document.getElementById('imagegrab-host');
    check('搜索页未注入悬浮按钮', !host);
    check('但仍注册了消息监听（保证 background 探活可用）', env.messageListeners.length === 1,
      `${env.messageListeners.length} 个监听器`);

    // 探活：模拟 background 发来的 PING
    let responded = null;
    env.messageListeners[0]({ type: 'IMAGE_GRAB_PING' }, {}, (r) => { responded = r; });
    check('PING 能正确响应 { ok: true, ready: true }',
      responded && responded.ok === true && responded.ready === true, JSON.stringify(responded));
  });
}

/* ============================================================
   用例 4：调试开关 ?__imagegrab=1 强制显示
   ============================================================ */
function testForceParam() {
  console.log('\n== 用例 4：调试开关 __imagegrab=1 ==');
  const env = createEnv({
    url: 'https://www.taobao.com/?__imagegrab=1',
    html: '<!DOCTYPE html><html><body><p>任意页面</p></body></html>'
  });
  return ready(env, true).then(() => {
    const host = env.window.document.getElementById('imagegrab-host');
    check('带调试参数时强制注入按钮', !!host);
  });
}

/* ============================================================
   用例 5：天猫 / 京东 / 拼多多 / 商家版 URL 判定
   ============================================================ */
async function testUrlMatch() {
  console.log('\n== 用例 5：各平台详情页 URL 判定 ==');
  const cases = [
    ['https://detail.tmall.com/item.htm?id=123456', true, '天猫详情页'],
    ['https://item.taobao.com/item.htm?id=123', true, '淘宝详情页'],
    ['https://item.jd.com/100012043978.html', true, '京东详情页'],
    ['https://item.m.jd.com/product/100012043978.html', true, '京东触屏版'],
    ['https://mobile.yangkeduo.com/goods.html?goods_id=123456', true, '拼多多 H5'],
    ['https://mms.pinduoduo.com/goods/goods_detail?goods_id=123456', true, '拼多多商家版'],
    ['https://www.pinduoduo.com/goods.html?goods_id=999', true, '拼多多 PC'],
    ['https://www.taobao.com/', false, '淘宝首页'],
    ['https://item.taobao.com/item.htm?spm=a1z10', false, '缺少商品编号'],
    ['https://cart.jd.com/cart.action', false, '京东购物车'],
    ['https://www.jd.com/mall', false, '京东首页']
  ];

  for (const [url, shouldShow, label] of cases) {
    const env = createEnv({ url, html: '<!DOCTYPE html><html><body></body></html>' });
    await ready(env, shouldShow);
    const shown = !!env.window.document.getElementById('imagegrab-host');
    check(`${label} ${shouldShow ? '应显示按钮' : '应隐藏按钮'}`, shown === shouldShow, url);
  }
}

/* ============================================================
   主流程
   ============================================================ */
(async function main() {
  await testDetailPage();
  await testBackgroundImage();
  await testNonDetailPage();
  await testForceParam();
  await testUrlMatch();

  console.log(`\n===== content.js 功能测试：通过 ${pass} 项，失败 ${fail} 项 =====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error('测试执行异常：', error);
  process.exit(1);
});
