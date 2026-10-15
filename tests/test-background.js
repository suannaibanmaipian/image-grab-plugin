/**
 * background.js 功能测试（开发期使用，不属于插件功能）
 *
 * 位置：tests/test-background.js，在项目根目录用 `node tests/test-background.js` 执行。
 *
 * 在 Node 里用桩对象执行 background.js，覆盖：存储写入、打开/复用画廊页、消息响应、
 * PNG 转换管线、文件名清洗、降级下载、失败统计、进度广播、SW 保活、工具栏图标注入逻辑。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 脚本位于 tests/ 下，项目根目录是它的上一级
const PROJECT = path.join(__dirname, '..');
const CODE = fs.readFileSync(path.join(PROJECT, 'background.js'), 'utf8');

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
   桩对象
   ============================================================ */

function createHarness() {
  const store = {};                  // 模拟 chrome.storage.local
  const broadcasts = [];             // 模拟 chrome.runtime.sendMessage 广播
  const downloads = [];              // 模拟 chrome.downloads.download 调用
  const tabsCreated = [];            // 模拟 chrome.tabs.create
  const tabsUpdated = [];            // 模拟 chrome.tabs.update
  const windowsFocused = [];
  const scriptingCalls = [];         // 模拟 chrome.scripting
  const tabMessages = [];            // 模拟 chrome.tabs.sendMessage
  const fetchCalls = [];
  const bitmapCalls = [];
  const badgeCalls = [];
  const fetchPlan = new Map();       // url -> { mode, type }
  const downloadFailSet = new Set(); // 这些 URL 的下载会失败
  const tabIdToReturn = { value: 42 }; // tabs.create 返回的 id
  let pingShouldFail = false;         // tabs.sendMessage(PING) 是否失败
  let injectShouldFail = false;       // scripting 注入是否失败
  let intervalCount = 0;
  let intervalCleared = 0;

  let messageListener = null;
  let installedListener = null;
  let actionClickListener = null;

  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { messageListener = fn; } },
      onInstalled: { addListener: (fn) => { installedListener = fn; } },
      getURL: (p) => `chrome-extension://testextensionid/${p}`,
      sendMessage: (message) => {
        broadcasts.push(message);
        return Promise.resolve();
      },
      getPlatformInfo: () => Promise.resolve({ os: 'win' })
    },
    storage: {
      local: {
        get: (key) => {
          if (typeof key === 'string') {
            return Promise.resolve(key in store ? { [key]: store[key] } : {});
          }
          return Promise.resolve(Object.assign({}, store));
        },
        set: (obj) => {
          Object.assign(store, obj);
          return Promise.resolve();
        }
      }
    },
    tabs: {
      get: (id) => Promise.resolve({ id, windowId: 7 }),
      update: (id, props) => {
        tabsUpdated.push({ id, props });
        return Promise.resolve({ id, windowId: 7 });
      },
      create: (props) => {
        tabsCreated.push(props);
        return Promise.resolve({ id: tabIdToReturn.value, windowId: 7 });
      },
      sendMessage: (tabId, message) => {
        tabMessages.push({ tabId, message });
        if (message && message.type === 'IMAGE_GRAB_PING') {
          return pingShouldFail
            ? Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'))
            : Promise.resolve({ ok: true, ready: true });
        }
        return Promise.resolve({ ok: true });
      }
    },
    windows: {
      update: (id, props) => {
        windowsFocused.push({ id, props });
        return Promise.resolve({ id });
      }
    },
    downloads: {
      download: (options) => {
        downloads.push(options);
        if (downloadFailSet.has(options.url)) {
          return Promise.reject(new Error('下载被拒绝'));
        }
        return Promise.resolve(downloads.length);
      }
    },
    scripting: {
      insertCSS: (opts) => {
        scriptingCalls.push({ api: 'insertCSS', opts });
        return injectShouldFail ? Promise.reject(new Error('注入失败')) : Promise.resolve();
      },
      executeScript: (opts) => {
        scriptingCalls.push({ api: 'executeScript', opts });
        return injectShouldFail ? Promise.reject(new Error('注入失败')) : Promise.resolve();
      }
    },
    action: {
      onClicked: { addListener: (fn) => { actionClickListener = fn; } },
      setBadgeText: (opts) => { badgeCalls.push(opts); return Promise.resolve(); },
      setBadgeBackgroundColor: () => Promise.resolve()
    }
  };

  /** 模拟 fetch：按 fetchPlan 决定行为 */
  function fetchStub(url, options) {
    fetchCalls.push({ url, options });
    const plan = fetchPlan.get(url) || { mode: 'ok', type: 'image/jpeg' };
    if (plan.mode === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
    if (plan.mode === 'http') {
      return Promise.resolve({ ok: false, status: 403, blob: () => Promise.resolve({ type: '', size: 0 }) });
    }
    if (plan.mode === 'empty') {
      return Promise.resolve({
        ok: true,
        status: 200,
        blob: () => Promise.resolve({ type: plan.type || 'image/jpeg', size: 0 })
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      blob: () => Promise.resolve({ type: plan.type || 'image/jpeg', size: 2048 })
    });
  }

  /** 模拟 FileReader（MV3 Service Worker 里唯一的 Blob -> dataURL 途径） */
  class FakeFileReader {
    readAsDataURL(blob) {
      setTimeout(() => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,QUJD`;
        if (typeof this.onload === 'function') this.onload();
      }, 1);
    }
  }

  /** 模拟 OffscreenCanvas */
  class FakeOffscreenCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return { drawImage: () => {} };
    }
    convertToBlob(options) {
      return Promise.resolve({ type: options.type, size: 4096 });
    }
  }

  /** 模拟 createImageBitmap */
  function createImageBitmapStub(blob) {
    bitmapCalls.push(blob);
    return Promise.resolve({ width: 800, height: 800, close: () => {} });
  }

  // 记录保活定时器的注册与清理
  const setIntervalStub = (fn, ms) => {
    intervalCount += 1;
    return setInterval(fn, 100000); // 换成超长间隔，避免测试期间真的触发
  };
  const clearIntervalStub = (timer) => {
    intervalCleared += 1;
    clearInterval(timer);
  };

  const sandbox = {
    chrome,
    fetch: fetchStub,
    FileReader: FakeFileReader,
    OffscreenCanvas: FakeOffscreenCanvas,
    createImageBitmap: createImageBitmapStub,
    URL,
    setTimeout,
    clearTimeout,
    setInterval: setIntervalStub,
    clearInterval: clearIntervalStub,
    console: { log: () => {}, warn: () => {}, error: () => {} }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'background.js' });

  return {
    sandbox,
    store,
    broadcasts,
    downloads,
    tabsCreated,
    tabsUpdated,
    windowsFocused,
    scriptingCalls,
    tabMessages,
    fetchCalls,
    bitmapCalls,
    badgeCalls,
    fetchPlan,
    downloadFailSet,
    setPingFail: (v) => { pingShouldFail = v; },
    setInjectFail: (v) => { injectShouldFail = v; },
    getIntervalStats: () => ({ registered: intervalCount, cleared: intervalCleared }),
    sendToBackground: (message) =>
      new Promise((resolve) => {
        if (!messageListener) throw new Error('background.js 未注册 onMessage 监听');
        messageListener(message, { tab: { id: 1 } }, resolve);
      }),
    fireInstalled: () => installedListener && installedListener(),
    fireActionClick: (tab) => actionClickListener && actionClickListener(tab)
  };
}

/** 等待广播中出现符合条件的进度 */
function waitForBroadcast(h, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const hit = h.broadcasts.find((b) => b && b.type === 'IMAGE_GRAB_PROGRESS' && predicate(b.payload || {}));
      if (hit) {
        clearInterval(timer);
        resolve(hit.payload);
      } else if (Date.now() - start > timeout) {
        clearInterval(timer);
        reject(new Error('等待广播超时'));
      }
    }, 15);
  });
}

/**
 * 只等待「本次」新产生的广播，避免匹配到前面用例残留的 payload
 * （例如两次下载的 total 都是 3 时，旧 done 会让等待提前返回）
 */
function waitForNewBroadcast(h, predicate, timeout = 3000) {
  const baseline = h.broadcasts.length;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const hit = h.broadcasts
        .slice(baseline)
        .find((b) => b && b.type === 'IMAGE_GRAB_PROGRESS' && predicate(b.payload || {}));
      if (hit) {
        clearInterval(timer);
        resolve(hit.payload);
      } else if (Date.now() - start > timeout) {
        clearInterval(timer);
        reject(new Error('等待广播超时'));
      }
    }, 15);
  });
}

/** 等待一小段时间，让队列完成 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ============================================================
   用例 1：提取结果写入存储 + 打开画廊页
   ============================================================ */
async function testExtracted(h) {
  console.log('\n== 用例 1：IMAGE_GRAB_EXTRACTED 写库并打开画廊页 ==');

  const images = [
    { url: 'https://img.alicdn.com/a.jpg', width: 800, height: 800, source: 'img' },
    { url: 'https://img.alicdn.com/b.jpg', width: 600, height: 600, source: 'data-src' },
    { url: 'https://img.alicdn.com/c.webp', width: 1200, height: 1200, source: 'srcset' }
  ];

  const response = await h.sendToBackground({
    type: 'IMAGE_GRAB_EXTRACTED',
    images,
    pageUrl: 'https://item.taobao.com/item.htm?id=1',
    pageTitle: '测试商品',
    platform: 'taobao'
  });

  check('响应 ok 且 count 正确', response.ok === true && response.count === 3, JSON.stringify(response));

  const saved = h.store['imageGrab.latest'];
  check('已写入 imageGrab.latest', !!saved);
  check('存储结构包含 images/pageUrl/pageTitle/platform/timestamp',
    !!saved && Array.isArray(saved.images) && saved.images.length === 3 &&
    !!saved.pageUrl && !!saved.pageTitle && saved.platform === 'taobao' && typeof saved.timestamp === 'number',
    saved ? `platform=${saved.platform}, images=${saved.images.length}` : '');

  check('新建了画廊标签页', h.tabsCreated.length === 1, JSON.stringify(h.tabsCreated[0]));
  check('画廊页地址正确',
    h.tabsCreated[0] && h.tabsCreated[0].url === 'chrome-extension://testextensionid/gallery.html',
    h.tabsCreated[0] && h.tabsCreated[0].url);

  check('记录了画廊标签页 id 以便复用', h.store['imageGrab.galleryTabId'] === 42,
    String(h.store['imageGrab.galleryTabId']));

  const updatedBroadcast = h.broadcasts.find((b) => b.type === 'IMAGE_GRAB_LATEST_UPDATED');
  check('广播了 IMAGE_GRAB_LATEST_UPDATED', !!updatedBroadcast);
}

/* ============================================================
   用例 2：0 张图片时不打开画廊页
   ============================================================ */
async function testExtractedEmpty(h) {
  console.log('\n== 用例 2：提取到 0 张时的处理 ==');
  const before = h.tabsCreated.length;

  const response = await h.sendToBackground({
    type: 'IMAGE_GRAB_EXTRACTED',
    images: [],
    pageUrl: 'https://item.taobao.com/item.htm?id=1',
    pageTitle: '测试商品',
    platform: 'taobao'
  });

  check('响应 { ok: true, count: 0 }', response.ok === true && response.count === 0, JSON.stringify(response));
  check('没有新建画廊标签页', h.tabsCreated.length === before);
}

/* ============================================================
   用例 3：复用已存在的画廊标签页
   ============================================================ */
async function testReuseTab(h) {
  console.log('\n== 用例 3：再次提取时复用画廊标签页 ==');
  const beforeCreate = h.tabsCreated.length;

  await h.sendToBackground({
    type: 'IMAGE_GRAB_EXTRACTED',
    images: [{ url: 'https://img.alicdn.com/d.jpg', width: 500, height: 500, source: 'img' }],
    pageUrl: 'https://item.taobao.com/item.htm?id=2',
    pageTitle: '测试商品 2',
    platform: 'taobao'
  });

  check('未重复新建标签页', h.tabsCreated.length === beforeCreate, `create 调用 ${h.tabsCreated.length} 次`);
  const lastUpdate = h.tabsUpdated[h.tabsUpdated.length - 1];
  check('复用了原标签页并刷新到画廊页',
    !!lastUpdate && lastUpdate.id === 42 &&
    lastUpdate.props.url === 'chrome-extension://testextensionid/gallery.html' &&
    lastUpdate.props.active === true,
    JSON.stringify(lastUpdate));
  check('聚焦了所在窗口', h.windowsFocused.length > 0 && h.windowsFocused[0].id === 7);
}

/* ============================================================
   用例 4：读取最近一次结果
   ============================================================ */
async function testGetLatest(h) {
  console.log('\n== 用例 4：IMAGE_GRAB_GET_LATEST ==');
  const response = await h.sendToBackground({ type: 'IMAGE_GRAB_GET_LATEST' });
  check('返回 ok 与数据', response.ok === true && !!response.data, JSON.stringify(response).slice(0, 80));
  check('返回的是最近一次写入的数据', response.data.images.length === 1, `${response.data.images.length} 张`);
}

/* ============================================================
   用例 5：下载管线（成功路径，jpg -> png）
   ============================================================ */
async function testDownloadSuccess(h) {
  console.log('\n== 用例 5：批量下载并转换为 PNG ==');
  const items = [
    { url: 'https://img.alicdn.com/p1.jpg', filename: '商品图_001.png' },
    { url: 'https://img.alicdn.com/p2.webp', filename: '商品图_002.png' },
    { url: 'https://img.alicdn.com/p3.png', filename: '商品图_003.png' }
  ];
  // 第 3 张本身就是 PNG，应跳过 createImageBitmap
  h.fetchPlan.set('https://img.alicdn.com/p3.png', { mode: 'ok', type: 'image/png' });

  const beforeDownloads = h.downloads.length;
  const beforeBitmaps = h.bitmapCalls.length;

  const response = await h.sendToBackground({ type: 'IMAGE_GRAB_DOWNLOAD', items, targetFolder: '' });
  check('立即响应 { ok: true, started: 3 }', response.ok === true && response.started === 3, JSON.stringify(response));

  const done = await waitForNewBroadcast(h, (p) => p.status === 'done');
  check('广播了 done 汇总', done.status === 'done');
  check('成功 3 张、失败 0 张', done.success === 3 && done.failed === 0, JSON.stringify(done));

  const newDownloads = h.downloads.slice(beforeDownloads);
  check('调用了 3 次 chrome.downloads.download', newDownloads.length === 3, `${newDownloads.length} 次`);
  check('下载地址是 PNG 的 data URL（SW 里不能用 blob URL）',
    newDownloads.every((d) => d.url.startsWith('data:image/png;base64,')),
    newDownloads.map((d) => d.url.slice(0, 28)).join(' | '));
  check('文件名按传入值使用', newDownloads.map((d) => d.filename).join(',') === '商品图_001.png,商品图_002.png,商品图_003.png',
    newDownloads.map((d) => d.filename).join(','));
  check('未开启另存为对话框', newDownloads.every((d) => d.saveAs === false));
  check('重名时自动改名而非覆盖', newDownloads.every((d) => d.conflictAction === 'uniquify'));

  const bitmapDelta = h.bitmapCalls.length - beforeBitmaps;
  check('jpg/webp 走了 canvas 转换，PNG 原图直接复用', bitmapDelta === 2, `createImageBitmap 调用 ${bitmapDelta} 次`);

  check('fetch 时未携带 cookie 与 Referer',
    h.fetchCalls.length > 0 && h.fetchCalls.every((c) => c.options.credentials === 'omit' && c.options.referrerPolicy === 'no-referrer'));

  const statuses = h.broadcasts
    .filter((b) => b.type === 'IMAGE_GRAB_PROGRESS')
    .map((b) => b.payload.status);
  check('每张都广播了 start 与 ok', statuses.filter((s) => s === 'start').length >= 3 && statuses.filter((s) => s === 'ok').length >= 3,
    statuses.join(','));
}

/* ============================================================
   用例 6：fetch 失败 -> 重试 -> 降级下载原图
   ============================================================ */
async function testDegradedDownload(h) {
  console.log('\n== 用例 6：PNG 转换失败后降级下载原图 ==');
  const url = 'https://img.alicdn.com/broken.webp';
  h.fetchPlan.set(url, { mode: 'throw' });

  const beforeDownloads = h.downloads.length;
  const beforeFetches = h.fetchCalls.length;

  await h.sendToBackground({
    type: 'IMAGE_GRAB_DOWNLOAD',
    items: [{ url, filename: '商品图_010.png' }],
    targetFolder: ''
  });

  const done = await waitForNewBroadcast(h, (p) => p.status === 'done' && p.total === 1);
  check('汇总里成功 1 张（按降级计）', done.success === 1, JSON.stringify(done));
  check('统计出降级数量 degraded = 1', done.degraded === 1, String(done.degraded));

  const fetchDelta = h.fetchCalls.length - beforeFetches;
  check('PNG 转换共尝试 2 次（首次 + 1 次重试）', fetchDelta === 2, `${fetchDelta} 次`);

  const fallback = h.downloads.slice(beforeDownloads);
  check('降级为直接下载原图', fallback.length === 1, `${fallback.length} 次`);
  check('降级下载使用原始 URL', fallback[0] && fallback[0].url === url);
  check('降级下载扩展名按原图推断（.webp）', fallback[0] && fallback[0].filename === '商品图_010.webp',
    fallback[0] && fallback[0].filename);

  const okPayload = h.broadcasts
    .filter((b) => b.type === 'IMAGE_GRAB_PROGRESS')
    .map((b) => b.payload)
    .find((p) => p.status === 'ok' && p.url === url);
  check('提示文案说明了降级原因', !!okPayload && /原图/.test(okPayload.message), okPayload && okPayload.message);
}

/* ============================================================
   用例 7：彻底失败 -> 统计失败并回传失败项
   ============================================================ */
async function testTotalFailure(h) {
  console.log('\n== 用例 7：彻底失败时的失败统计与重试数据 ==');
  const url = 'https://img.alicdn.com/dead.jpg';
  h.fetchPlan.set(url, { mode: 'http' });      // fetch 403
  h.downloadFailSet.add(url);                  // 降级下载也失败

  const baseline = h.broadcasts.length;

  await h.sendToBackground({
    type: 'IMAGE_GRAB_DOWNLOAD',
    items: [{ url, filename: '商品图_020.png' }],
    targetFolder: ''
  });

  // 等待本次新产生的 done 广播（失败 1 张）
  await waitForNewBroadcast(h, (p) => p.status === 'done' && p.failed === 1);

  const newPayloads = h.broadcasts.slice(baseline).map((b) => b.payload || {});

  const failPayload = newPayloads.find((p) => p.status === 'fail');
  check('广播了 fail 状态', !!failPayload, failPayload && failPayload.message);

  const donePayloads = newPayloads.filter((p) => p.status === 'done');
  check('done 汇总里失败 1 张', donePayloads.some((p) => p.failed === 1), JSON.stringify(donePayloads[donePayloads.length - 1]));
  check('回传了 failedItems 供「重试失败项」使用',
    donePayloads.some((p) => Array.isArray(p.failedItems) && p.failedItems.length === 1 && p.failedItems[0].url === url));
}

/* ============================================================
   用例 8：文件名清洗
   ============================================================ */
async function testFilenameSanitize(h) {
  console.log('\n== 用例 8：文件名清洗与兜底 ==');
  const before = h.downloads.length;

  await h.sendToBackground({
    type: 'IMAGE_GRAB_DOWNLOAD',
    items: [
      { url: 'https://img.alicdn.com/s1.jpg', filename: '商:品*图?"_001.png' },
      { url: 'https://img.alicdn.com/s2.jpg', filename: 'a/b/../c.png' },
      { url: 'https://img.alicdn.com/s3.jpg', filename: '' }
    ],
    targetFolder: '商品图'
  });

  const done = await waitForNewBroadcast(h, (p) => p.status === 'done' && p.total === 3);
  check('三张都完成', done.total === 3, JSON.stringify(done));

  const got = h.downloads.slice(before).map((d) => d.filename);
  check('非法字符已替换为下划线', got[0] && !/[:*?"]/.test(got[0]) && got[0].endsWith('.png'), got[0]);
  check('路径穿越被压平成单层文件名', got[1] && got[1].indexOf('/') === got[1].lastIndexOf('/'), got[1]);
  check('文件名都带上了目标文件夹', got.every((f) => f.startsWith('商品图/')), got.join(' , '));
  check('空文件名按「商品图_序号.png」兜底', got[2] === '商品图/商品图_003.png', got[2]);
}

/* ============================================================
   用例 9：SW 保活
   ============================================================ */
async function testKeepAlive(h) {
  console.log('\n== 用例 9：下载期间 Service Worker 保活 ==');
  const stats = h.getIntervalStats();
  check('队列运行期间注册了保活定时器', stats.registered > 0, `注册 ${stats.registered} 次`);
  check('队列结束后清理了定时器', stats.cleared > 0, `清理 ${stats.cleared} 次`);
}

/* ============================================================
   用例 10：安装时写入默认设置
   ============================================================ */
async function testInstalled(h) {
  console.log('\n== 用例 10：onInstalled 写入默认设置 ==');
  h.fireInstalled();
  await delay(50);
  const settings = h.store['imageGrab.settings'];
  check('写入了 imageGrab.settings', !!settings, JSON.stringify(settings));
  check('默认包含 minWidth/minHeight/folder',
    settings && settings.minWidth === 100 && settings.minHeight === 100 && settings.folder === '',
    JSON.stringify(settings));

  // 再触发一次，验证不覆盖用户改动
  h.store['imageGrab.settings'] = { minWidth: 200, minHeight: 200, folder: '我的图' };
  h.fireInstalled();
  await delay(50);
  check('不会覆盖用户已修改的设置', h.store['imageGrab.settings'].minWidth === 200,
    JSON.stringify(h.store['imageGrab.settings']));
}

/* ============================================================
   用例 11：工具栏图标点击
   ============================================================ */
async function testActionClick(h) {
  console.log('\n== 用例 11：点击工具栏图标触发提取 ==');
  // 11-1 内容脚本已在页面上（PING 成功）：直接触发，不重复注入
  const beforeScripting = h.scriptingCalls.length;
  h.setPingFail(false);
  await h.fireActionClick({ id: 5 });
  await delay(50);

  check('探活成功时不重复注入脚本', h.scriptingCalls.length === beforeScripting);
  check('发送了 IMAGE_GRAB_TRIGGER_EXTRACT',
    h.tabMessages.some((m) => m.message.type === 'IMAGE_GRAB_TRIGGER_EXTRACT' && m.tabId === 5));

  // 11-2 内容脚本未注入：先 PING 再注入再触发
  h.setPingFail(true);
  const before2 = h.scriptingCalls.length;
  const beforeMessages = h.tabMessages.length;
  await h.fireActionClick({ id: 6 });
  await delay(80);

  const injected = h.scriptingCalls.slice(before2);
  check('探活失败时注入 content.css 与 content.js',
    injected.length === 2 &&
    injected[0].api === 'insertCSS' && injected[0].opts.files[0] === 'content.css' &&
    injected[1].api === 'executeScript' && injected[1].opts.files[0] === 'content.js',
    injected.map((c) => `${c.api}:${c.opts.files[0]}`).join(' , '));
  check('注入后仍发送了 TRIGGER_EXTRACT',
    h.tabMessages.slice(beforeMessages).some((m) => m.message.type === 'IMAGE_GRAB_TRIGGER_EXTRACT'));

  // 11-3 完全不支持的页面：注入失败 -> 显示 × 徽标
  h.setInjectFail(true);
  const beforeBadge = h.badgeCalls.length;
  await h.fireActionClick({ id: 7 });
  await delay(80);
  check('不支持页面时用「×」徽标提示用户',
    h.badgeCalls.slice(beforeBadge).some((b) => b.text === '×' && b.tabId === 7),
    JSON.stringify(h.badgeCalls.slice(beforeBadge)));
  h.setInjectFail(false);
}

/* ============================================================
   主流程
   ============================================================ */
(async function main() {
  const h = createHarness();

  await testExtracted(h);
  await testExtractedEmpty(h);
  await testReuseTab(h);
  await testGetLatest(h);
  await testDownloadSuccess(h);
  await testDegradedDownload(h);
  await testTotalFailure(h);
  await testFilenameSanitize(h);
  await testKeepAlive(h);
  await testInstalled(h);
  await testActionClick(h);

  console.log(`\n===== background.js 功能测试：通过 ${pass} 项，失败 ${fail} 项 =====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error('测试执行异常：', error);
  process.exit(1);
});
