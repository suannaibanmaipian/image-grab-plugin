/**
 * gallery.js 功能测试（开发期使用，不属于插件功能）
 *
 * 位置：tests/test-gallery.js，在项目根目录用 `node tests/test-gallery.js` 执行。
 *
 * 在 jsdom 里加载 gallery.html + gallery.js，覆盖：数据渲染、勾选/全选/反选、计数、
 * 下载消息与文件名编号、进度反馈、失败重试、大图预览、空状态、非扩展环境降级。
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

  console.log('[SKIP] 未找到 jsdom，tests/test-gallery.js 本次跳过（这不是插件功能的问题）。');
  console.log('       安装：在项目根目录执行 npm i jsdom；');
  console.log('       或设置环境变量 IG_JSDOM_PATH 指向包含 jsdom 的 node_modules 目录。');
  if (process.env.IG_JSDOM_DEBUG) console.log(errors.join('\n'));
  return null;
}

const jsdomModule = loadJSDOM();
if (!jsdomModule) process.exit(0);

const { JSDOM } = jsdomModule;

const GALLERY_HTML = fs.readFileSync(path.join(PROJECT, 'gallery.html'), 'utf8');
const GALLERY_JS = fs.readFileSync(path.join(PROJECT, 'gallery.js'), 'utf8');

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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 造一批测试图片数据 */
function makeImages(count) {
  return Array.from({ length: count }, (item, index) => ({
    url: `https://img.alicdn.com/imgextra/i${index}.jpg`,
    width: 800 + index,
    height: 800 + index,
    source: index % 2 === 0 ? 'img' : 'data-src'
  }));
}

/**
 * 构造画廊页测试环境
 * @param {object} options
 * @param {object|null} options.data 存储中的提取结果
 * @param {object} [options.settings] 设置
 * @param {boolean} [options.noExtension] 是否模拟非扩展环境
 */
async function createGalleryEnv({ data, settings, noExtension }) {
  const dom = new JSDOM(GALLERY_HTML, {
    url: 'chrome-extension://testextensionid/gallery.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });

  const { window } = dom;
  const sentMessages = [];
  const messageListeners = [];
  const storageListeners = [];
  const store = {};
  if (data) store['imageGrab.latest'] = data;
  if (settings) store['imageGrab.settings'] = settings;

  if (!noExtension) {
    window.chrome = {
      runtime: {
        id: 'testextensionid',
        lastError: null,
        sendMessage: (message, callback) => {
          sentMessages.push(message);
          let response = { ok: true };
          if (message.type === 'IMAGE_GRAB_GET_LATEST') {
            response = { ok: true, data: store['imageGrab.latest'] || null };
          } else if (message.type === 'IMAGE_GRAB_DOWNLOAD') {
            response = { ok: true, started: (message.items || []).length };
          }
          if (typeof callback === 'function') window.setTimeout(() => callback(response), 1);
        },
        onMessage: { addListener: (fn) => messageListeners.push(fn) }
      },
      storage: {
        local: {
          get: (key) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
          set: () => Promise.resolve()
        },
        onChanged: { addListener: (fn) => storageListeners.push(fn) }
      }
    };
  }

  // 执行 gallery.js（jsdom 不会自动加载外部脚本，这里手动注入）
  window.eval(GALLERY_JS);

  // 等待 DOMContentLoaded + 异步加载数据
  await delay(120);

  return {
    dom,
    window,
    doc: window.document,
    sentMessages,
    messageListeners,
    storageListeners,
    /** 直接改写 mock 存储，用来模拟「又提取了一次」产生新数据 */
    setLatest: (next) => {
      store['imageGrab.latest'] = next;
    },
    /** 模拟 background 广播的进度 */
    emitProgress: (payload) => {
      messageListeners.forEach((fn) => fn({ type: 'IMAGE_GRAB_PROGRESS', payload }));
    },
    /** 模拟 background 广播的「结果已更新」 */
    emitLatestUpdated: () => {
      messageListeners.forEach((fn) => fn({ type: 'IMAGE_GRAB_LATEST_UPDATED', payload: { count: 1 } }));
    },
    /** 点击元素 */
    click: (element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  };
}

/* ============================================================
   用例 1：渲染提取结果
   ============================================================ */
async function testRender() {
  console.log('\n== 用例 1：渲染网格与信息 ==');
  const env = await createGalleryEnv({
    data: {
      images: makeImages(3),
      pageUrl: 'https://item.taobao.com/item.htm?id=1',
      pageTitle: '测试商品标题',
      platform: 'taobao',
      timestamp: Date.now()
    },
    settings: { minWidth: 100, minHeight: 100, folder: '' }
  });

  const { doc } = env;
  const cards = doc.querySelectorAll('.card');

  check('渲染出 3 张卡片', cards.length === 3, `${cards.length} 张`);
  check('空状态已隐藏', doc.getElementById('emptyState').hidden === true);
  check('来源信息显示页面标题', /测试商品标题/.test(doc.getElementById('sourceInfo').textContent),
    doc.getElementById('sourceInfo').textContent);
  check('平台徽章显示「淘宝 商品详情页」', doc.getElementById('platformBadge').hidden === false &&
    /淘宝/.test(doc.getElementById('platformBadge').textContent),
    doc.getElementById('platformBadge').textContent);

  const firstImg = cards[0].querySelector('.card__img');
  check('缩略图使用 no-referrer 避免防盗链 403', firstImg.referrerPolicy === 'no-referrer', firstImg.referrerPolicy);
  check('缩略图开启懒加载', firstImg.loading === 'lazy');
  check('缩略图地址正确', firstImg.src === 'https://img.alicdn.com/imgextra/i0.jpg', firstImg.src);

  check('显示图片尺寸', /800 × 800/.test(cards[0].querySelector('.card__size').textContent),
    cards[0].querySelector('.card__size').textContent);
  check('显示来源标签', cards[1].querySelector('.card__source').textContent === '懒加载图',
    cards[1].querySelector('.card__source').textContent);
  check('每张卡片都有复选框', cards[0].querySelector('.card__input').type === 'checkbox');

  check('初始计数为「已选 0 / 共 3」', doc.getElementById('counter').textContent === '已选 0 / 共 3',
    doc.getElementById('counter').textContent);
  check('未选中时下载按钮禁用', doc.getElementById('downloadBtn').disabled === true);
  check('页面标题包含张数', /3 张图片/.test(doc.title), doc.title);

  return env;
}

/* ============================================================
   用例 2：全选 / 反选 / 单张勾选 / 下载消息
   ============================================================ */
async function testSelection(env) {
  console.log('\n== 用例 2：选择逻辑与下载请求 ==');
  const { doc } = env;

  // 全选
  env.click(doc.getElementById('selectAllBtn'));
  check('全选后计数正确', doc.getElementById('counter').textContent === '已选 3 / 共 3',
    doc.getElementById('counter').textContent);
  check('全选后所有卡片高亮', doc.querySelectorAll('.card.is-selected').length === 3,
    `${doc.querySelectorAll('.card.is-selected').length} 张`);
  check('全选后复选框均勾选', Array.from(doc.querySelectorAll('.card__input')).every((i) => i.checked));
  check('下载按钮文案带数量并启用',
    doc.getElementById('downloadBtn').textContent === '下载选中 (3)' && doc.getElementById('downloadBtn').disabled === false,
    doc.getElementById('downloadBtn').textContent);

  // 反选
  env.click(doc.getElementById('invertBtn'));
  check('反选后计数为 0', doc.getElementById('counter').textContent === '已选 0 / 共 3',
    doc.getElementById('counter').textContent);
  env.click(doc.getElementById('invertBtn'));
  check('再次反选回到全选', doc.getElementById('counter').textContent === '已选 3 / 共 3',
    doc.getElementById('counter').textContent);
  env.click(doc.getElementById('invertBtn'));

  // 单张勾选：点击卡片
  const cards = doc.querySelectorAll('.card');
  env.click(cards[1]);
  check('点击卡片可勾选', doc.getElementById('counter').textContent === '已选 1 / 共 3',
    doc.getElementById('counter').textContent);
  check('被点击卡片高亮', cards[1].classList.contains('is-selected'));

  // 再点一次取消
  env.click(cards[1]);
  check('再次点击取消勾选', doc.getElementById('counter').textContent === '已选 0 / 共 3',
    doc.getElementById('counter').textContent);

  // 通过复选框勾选
  const input = cards[2].querySelector('.card__input');
  input.checked = true;
  input.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  check('勾选复选框同步选中状态', doc.getElementById('counter').textContent === '已选 1 / 共 3',
    doc.getElementById('counter').textContent);
  check('复选框勾选后卡片高亮', cards[2].classList.contains('is-selected'));

  // 发起下载
  const before = env.sentMessages.length;
  env.click(cards[0]);   // 已选 2 张：索引 0 与 2
  env.click(doc.getElementById('downloadBtn'));
  await delay(50);

  const newMessages = env.sentMessages.slice(before);
  const downloadMsg = newMessages.find((m) => m.type === 'IMAGE_GRAB_DOWNLOAD');
  check('发送了 IMAGE_GRAB_DOWNLOAD', !!downloadMsg);
  check('下载项数量与所选一致', downloadMsg && downloadMsg.items.length === 2, downloadMsg && String(downloadMsg.items.length));
  check('文件名按「商品图_001.png」递增编号',
    downloadMsg && downloadMsg.items.map((i) => i.filename).join(',') === '商品图_001.png,商品图_002.png',
    downloadMsg && downloadMsg.items.map((i) => i.filename).join(','));
  check('文件名按网格顺序（而非点击顺序）排列',
    downloadMsg && downloadMsg.items[0].url === 'https://img.alicdn.com/imgextra/i0.jpg' &&
    downloadMsg.items[1].url === 'https://img.alicdn.com/imgextra/i2.jpg',
    downloadMsg && downloadMsg.items.map((i) => i.url.split('/').pop()).join(','));
  check('下载按钮在下载中禁用', doc.getElementById('downloadBtn').disabled === true);
  check('进度条已显示', doc.getElementById('progressWrap').hidden === false);

  // 未选中时点击下载应给出提示而不发消息
  const beforeEmpty = env.sentMessages.length;
  env.click(doc.getElementById('invertBtn'));
  env.click(doc.getElementById('invertBtn'));
  // 此时全选状态，先取消全部再点下载
  env.click(doc.getElementById('invertBtn'));
  env.click(doc.getElementById('downloadBtn'));
  const toast = doc.querySelectorAll('.toast');
  check('未选中时提示且不发下载消息',
    env.sentMessages.length === beforeEmpty && toast.length > 0,
    toast.length ? toast[toast.length - 1].textContent : '无提示');

  return env;
}

/* ============================================================
   用例 3：进度反馈与结果横幅
   ============================================================ */
async function testProgress(env) {
  console.log('\n== 用例 3：下载进度与结果反馈 ==');
  const { doc } = env;
  const downloadBtn = doc.getElementById('downloadBtn');

  // 先全选并下载，进入下载中状态
  env.click(doc.getElementById('selectAllBtn'));
  env.click(downloadBtn);
  await delay(50);

  check('下载中按钮显示禁用态', downloadBtn.disabled === true);

  // 模拟 background 广播
  env.emitProgress({ index: 1, total: 3, url: 'https://img.alicdn.com/imgextra/i0.jpg', filename: '商品图_001.png', status: 'start' });
  check('进度条更新为 0 / 3', doc.getElementById('progressText').textContent === '0 / 3',
    doc.getElementById('progressText').textContent);
  // 此时日志应有 2 条：runDownload 提交时写的「已提交 N 张…」，以及本条 start 进度
  check('下载日志出现记录',
    doc.getElementById('logWrap').hidden === false && doc.getElementById('logList').children.length === 2,
    `共 ${doc.getElementById('logList').children.length} 条：${doc.getElementById('logList').textContent}`);
  check('下载日志含本次 start 进度', /开始处理 商品图_001\.png/.test(doc.getElementById('logList').textContent),
    doc.getElementById('logList').textContent);

  env.emitProgress({ index: 1, total: 3, filename: '商品图_001.png', status: 'ok', message: '已保存为 PNG' });
  check('完成后进度条变为 1 / 3', doc.getElementById('progressText').textContent === '1 / 3',
    doc.getElementById('progressText').textContent);
  check('进度条宽度按比例更新', doc.getElementById('progressFill').style.width === '33%',
    doc.getElementById('progressFill').style.width);

  env.emitProgress({ index: 2, total: 3, filename: '商品图_002.png', status: 'fail', url: 'https://img.alicdn.com/imgextra/i1.jpg', message: '下载失败：403' });
  const failLog = Array.from(doc.querySelectorAll('.log__item--fail')).map((n) => n.textContent);
  check('失败项写入日志并标红', failLog.length === 1, failLog.join(' | '));

  env.emitProgress({ index: 3, total: 3, status: 'done', success: 2, degraded: 1, failed: 1, message: '下载完成：成功 2 张（其中 1 张为原图格式），失败 1 张' });
  check('完成后显示结果横幅', doc.getElementById('resultBanner').hidden === false);
  check('横幅提示失败可重试', /重试失败项/.test(doc.getElementById('resultBanner').textContent),
    doc.getElementById('resultBanner').textContent);
  check('横幅样式为警示色', doc.getElementById('resultBanner').className.includes('banner--warn'),
    doc.getElementById('resultBanner').className);
  check('下载结束后按钮恢复可用', downloadBtn.disabled === false);

  const retryBtn = doc.getElementById('retryBtn');
  check('出现「重试失败项」按钮', retryBtn.hidden === false && /重试失败项 \(1\)/.test(retryBtn.textContent),
    retryBtn.textContent);

  // 关闭横幅：必须放在点「重试失败项」之前。
  // 因为 runDownload() 内部会调用 hideBanner() 清空横幅内容（这是预期行为），
  // 先点重试的话 .banner__close 就不存在了，测试会在 dispatchEvent 上抛 TypeError。
  const closeBtn = doc.querySelector('.banner__close');
  check('横幅带有关闭按钮', !!closeBtn);
  if (closeBtn) env.click(closeBtn);
  check('横幅可关闭', doc.getElementById('resultBanner').hidden === true);

  // 点击重试
  const before = env.sentMessages.length;
  env.click(retryBtn);
  await delay(50);
  const retryMsg = env.sentMessages.slice(before).find((m) => m.type === 'IMAGE_GRAB_DOWNLOAD');
  check('重试只重发失败项', retryMsg && retryMsg.items.length === 1 && retryMsg.items[0].url === 'https://img.alicdn.com/imgextra/i1.jpg',
    retryMsg && JSON.stringify(retryMsg.items));
  check('重试沿用原文件名', retryMsg && retryMsg.items[0].filename === '商品图_002.png',
    retryMsg && retryMsg.items[0].filename);
  check('重试后横幅被清空（新一轮下载开始）', doc.getElementById('resultBanner').hidden === true);

  // 收尾：模拟 background 对本轮重试的完成广播，把画廊送回空闲态。
  // 不做这一步的话 state.downloading 会一直是 true，
  // 后续用例（大图预览里下载单张）会被「正在下载中」的守卫拦下而误判为缺陷。
  env.emitProgress({
    index: 1, total: 1, status: 'done',
    success: 1, degraded: 0, failed: 0, message: '下载完成：成功 1 张'
  });
  check('重试完成后回到空闲态', downloadBtn.disabled === false, `downloadBtn.disabled=${downloadBtn.disabled}`);
  check('无失败项时隐藏「重试失败项」', retryBtn.hidden === true);

  return env;
}

/* ============================================================
   用例 4：大图预览（Lightbox）
   ============================================================ */
async function testLightbox(env) {
  console.log('\n== 用例 4：大图预览 ==');
  const { doc } = env;
  const card = doc.querySelectorAll('.card')[0];
  const selectedBefore = card.classList.contains('is-selected');

  env.click(card.querySelector('.card__thumb'));
  check('点击缩略图打开大图预览', doc.getElementById('lightbox').hidden === false);
  check('预览显示尺寸与序号', /800 × 800/.test(doc.getElementById('lightboxInfo').textContent),
    doc.getElementById('lightboxInfo').textContent);
  check('打开预览不改变选中状态', card.classList.contains('is-selected') === selectedBefore);

  const toggle = doc.getElementById('lightboxToggle');
  check('预览里按钮文案为「选中此图」或「取消选中」', /选中/.test(toggle.textContent), toggle.textContent);
  env.click(toggle);
  check('预览里可以切换选中', card.classList.contains('is-selected') !== selectedBefore);

  // 从预览里下载单张
  const before = env.sentMessages.length;
  env.click(doc.getElementById('lightboxDownload'));
  await delay(50);
  const single = env.sentMessages.slice(before).find((m) => m.type === 'IMAGE_GRAB_DOWNLOAD');
  check('预览里可以下载单张', single && single.items.length === 1, single && JSON.stringify(single.items));

  // Esc 关闭
  doc.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('按 Esc 关闭预览', doc.getElementById('lightbox').hidden === true);

  // 关闭按钮
  env.click(card.querySelector('.card__thumb'));
  env.click(doc.getElementById('lightboxClose'));
  check('点击关闭按钮可关闭预览', doc.getElementById('lightbox').hidden === true);
}

/* ============================================================
   用例 5：空状态与占位
   ============================================================ */
async function testEmptyState() {
  console.log('\n== 用例 5：没有提取记录时的空状态 ==');
  const env = await createGalleryEnv({ data: null, settings: { minWidth: 100, minHeight: 100, folder: '' } });
  const { doc } = env;

  check('显示空状态', doc.getElementById('emptyState').hidden === false);
  check('网格为空', doc.querySelectorAll('.card').length === 0);
  check('下载按钮禁用', doc.getElementById('downloadBtn').disabled === true);
  check('不会显示环境警告（扩展环境）', doc.getElementById('envWarning').hidden === true);
  check('空状态给出了操作指引', /获取图片/.test(doc.getElementById('emptyState').textContent));
  check('平台徽章隐藏', doc.getElementById('platformBadge').hidden === true);
}

/* ============================================================
   用例 6：文件名补零位数（超过 999 张时自动加宽）
   ============================================================ */
async function testFilenamePadding() {
  console.log('\n== 用例 6：文件名补零位数 ==');
  const total = 1200;
  const env = await createGalleryEnv({
    data: {
      images: makeImages(total),
      pageUrl: 'https://item.jd.com/1.html',
      pageTitle: '大商品',
      platform: 'jd',
      timestamp: Date.now()
    },
    settings: { minWidth: 100, minHeight: 100, folder: '' }
  });
  const { doc } = env;

  check(`渲染 ${total} 张卡片`, doc.querySelectorAll('.card').length === total,
    `${doc.querySelectorAll('.card').length} 张`);
  check('计数显示 1200 张', /共 1200/.test(doc.getElementById('counter').textContent),
    doc.getElementById('counter').textContent);

  env.click(doc.getElementById('selectAllBtn'));
  const before = env.sentMessages.length;
  env.click(doc.getElementById('downloadBtn'));
  await delay(120);

  const msg = env.sentMessages.slice(before).find((m) => m.type === 'IMAGE_GRAB_DOWNLOAD');
  check('提交了 1200 个下载项', msg && msg.items.length === total, msg && String(msg.items.length));
  check('超过 999 张时补零位数自动加宽到 4 位',
    msg && msg.items[0].filename === '商品图_0001.png' && msg.items[1199].filename === '商品图_1200.png',
    msg ? `${msg.items[0].filename} … ${msg.items[1199].filename}` : '');
}

/* ============================================================
   用例 7：非扩展环境降级（直接双击打开 HTML）
   ============================================================ */
async function testNoExtension() {
  console.log('\n== 用例 7：非扩展环境（双击打开）不白屏 ==');
  let error = null;
  let env = null;
  try {
    env = await createGalleryEnv({ noExtension: true });
  } catch (e) {
    error = e;
  }

  check('脚本执行不抛异常', !error, error && error.message);
  if (env) {
    const { doc } = env;
    check('显示「不在扩展环境」提示', doc.getElementById('envWarning').hidden === false);
    check('显示空状态而不是白屏', doc.getElementById('emptyState').hidden === false);
    check('工具栏按钮存在且可用性合理',
      !!doc.getElementById('selectAllBtn') && doc.getElementById('downloadBtn').disabled === true);
    check('页面仍有标题', /图提取/.test(doc.title), doc.title);
  }
}

/* ============================================================
   用例 8：设置项参与下载（目标文件夹）
   ============================================================ */
async function testTargetFolder() {
  console.log('\n== 用例 8：设置里的下载目录生效 ==');
  const env = await createGalleryEnv({
    data: {
      images: makeImages(1),
      pageUrl: 'https://item.taobao.com/item.htm?id=1',
      pageTitle: '测试',
      platform: 'taobao',
      timestamp: Date.now()
    },
    settings: { minWidth: 100, minHeight: 100, folder: '商品图素材' }
  });
  const { doc } = env;

  env.click(doc.getElementById('selectAllBtn'));
  const before = env.sentMessages.length;
  env.click(doc.getElementById('downloadBtn'));
  await delay(50);

  const msg = env.sentMessages.slice(before).find((m) => m.type === 'IMAGE_GRAB_DOWNLOAD');
  check('下载请求带上了设置里的目录', msg && msg.targetFolder === '商品图素材',
    msg && String(msg.targetFolder));
}

/* ============================================================
   用例 9：同一份提取结果只渲染一次（广播与 storage.onChanged 去重）
   ============================================================ */
async function testDedupe() {
  console.log('\n== 用例 9：同一份数据不重复渲染 ==');
  const data = {
    images: makeImages(3),
    pageUrl: 'https://item.taobao.com/item.htm?id=9',
    pageTitle: '去重测试',
    platform: 'taobao',
    timestamp: 1730000000000
  };
  const env = await createGalleryEnv({
    data,
    settings: { minWidth: 100, minHeight: 100, folder: '' }
  });
  const { doc } = env;

  // 先手动选中一张，作为「有没有被整块重建」的探针：重新渲染会清空选中状态
  const cards = doc.querySelectorAll('.card');
  env.click(cards[0]);
  check('先选中 1 张作为探针', doc.querySelectorAll('.card.is-selected').length === 1,
    `${doc.querySelectorAll('.card.is-selected').length} 张`);

  // 模拟 background 保存数据后触发的两条路径：广播 + storage.onChanged（数据完全相同）
  env.emitLatestUpdated();
  env.storageListeners.forEach((fn) =>
    fn({ 'imageGrab.latest': { newValue: data, oldValue: data } }, 'local'));
  await delay(120);

  check('广播 + storage 同时到达时没有重建列表（选中状态保住了）',
    doc.querySelectorAll('.card.is-selected').length === 1,
    `选中 ${doc.querySelectorAll('.card.is-selected').length} 张`);
  check('卡片数量没有翻倍', doc.querySelectorAll('.card').length === 3,
    `${doc.querySelectorAll('.card').length} 张`);
  check('计数仍是「已选 1 / 共 3」', doc.getElementById('counter').textContent === '已选 1 / 共 3',
    doc.getElementById('counter').textContent);

  // 新的一次提取（timestamp 变了）必须重新渲染
  env.setLatest(Object.assign({}, data, { timestamp: data.timestamp + 1000 }));
  env.emitLatestUpdated();
  await delay(120);
  check('新数据（timestamp 变化）仍然会重新渲染',
    doc.querySelectorAll('.card.is-selected').length === 0,
    `选中 ${doc.querySelectorAll('.card.is-selected').length} 张`);

  // 「重新读取」按钮是用户显式操作，即使数据没变也必须强制重渲染
  env.click(cards[0]);
  env.click(doc.getElementById('reloadBtn'));
  await delay(120);
  check('「重新读取」按钮强制重新渲染',
    doc.querySelectorAll('.card.is-selected').length === 0,
    `选中 ${doc.querySelectorAll('.card.is-selected').length} 张`);
}

/* ============================================================
   主流程
   ============================================================ */
(async function main() {
  const env = await testRender();
  await testSelection(env);
  await testProgress(env);
  await testLightbox(env);
  await testEmptyState();
  await testFilenamePadding();
  await testNoExtension();
  await testTargetFolder();
  await testDedupe();

  console.log(`\n===== gallery.js 功能测试：通过 ${pass} 项，失败 ${fail} 项 =====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error('测试执行异常：', error);
  process.exit(1);
});
