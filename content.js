/**
 * content.js —— 图提取 ImageGrab 内容脚本
 *
 * 职责：
 *  1) 判定当前页面是否为电商商品详情页（淘宝 / 天猫 / 京东 / 拼多多 / 拼多多商家版）
 *  2) 在页面右下角注入「获取图片」悬浮按钮（Shadow DOM 隔离，不污染页面样式）
 *  3) 扫描页面内所有商品图：img / srcset / data-* 懒加载属性 / 背景图 / picture / poster
 *  4) 过滤图标、logo、占位图、小于最小尺寸的小图，去重后交给 background.js
 *
 * 运行环境：Chrome 扩展隔离世界（Isolated World），可安全读写 DOM。
 */

(function () {
  'use strict';

  /* ==================== 全局注入保护 ==================== */
  // background.js 在必要时会动态注入本脚本，这里加一道闸，避免重复初始化
  if (window.__imageGrabInjected) return;
  window.__imageGrabInjected = true;

  /* ==================== 常量区 ==================== */

  const HOST_ID = 'imagegrab-host';        // 悬浮按钮宿主元素 id
  const MIN_WIDTH = 100;                   // 最小宽度（像素），小于该值的图片会被过滤
  const MIN_HEIGHT = 100;                  // 最小高度（像素）
  const MAX_IMAGES = 500;                  // 最多保留的图片数量
  const CANDIDATE_LIMIT = 1200;            // 候选地址上限（防止超大页面把内存吃满）
  const PROBE_TIMEOUT = 800;               // 单张图片尺寸探测超时（毫秒）
  const PROBE_CONCURRENCY = 8;             // 探测并发数
  const BG_ELEMENT_LIMIT = 4000;           // 背景图扫描的最大元素数
  const BG_CHUNK_SIZE = 200;               // 背景图扫描的分片大小（分片让出主线程）
  const FORCE_QUERY = '__imagegrab';       // 调试开关：URL 带 ?__imagegrab=1 时强制显示按钮

  // ---- 消息类型（与 background.js 必须逐字一致）----
  const MSG_EXTRACTED = 'IMAGE_GRAB_EXTRACTED';
  const MSG_TRIGGER_EXTRACT = 'IMAGE_GRAB_TRIGGER_EXTRACT';
  const MSG_PING = 'IMAGE_GRAB_PING';

  /**
   * 详情页 URL 规则表
   * platform：平台标识；re：URL 正则；needId：是否必须带商品编号参数
   */
  const DETAIL_RULES = [
    // ---- 淘宝 ----
    { platform: 'taobao', re: /^https?:\/\/(?:[\w-]+\.)*taobao\.com\/(?:item\.htm|item\/|detail\/)/i, needId: true },
    // 淘宝卖家中心等后台商品页（路径包含 item/goods/product/detail）
    { platform: 'taobao', re: /^https?:\/\/(?:[\w-]+\.)*taobao\.com\/.*(?:item|goods|product|detail)/i, needId: true },

    // ---- 天猫 ----
    { platform: 'tmall', re: /^https?:\/\/(?:[\w-]+\.)*tmall\.com\/(?:item\.htm|item\/|detail\/)/i, needId: true },
    { platform: 'tmall', re: /^https?:\/\/(?:[\w-]+\.)*tmall\.com\/.*(?:item|goods|product|detail)/i, needId: true },

    // ---- 京东 ----
    { platform: 'jd', re: /^https?:\/\/item\.(?:m\.)?jd\.com\/(?:product\/)?\d+(?:\.html)?/i, needId: false },
    { platform: 'jd', re: /^https?:\/\/(?:[\w-]+\.)*jd\.com\/.*(?:goods|product|item|detail)/i, needId: true },

    // ---- 拼多多（App 分享页 / H5 / PC）----
    { platform: 'pinduoduo', re: /^https?:\/\/(?:mobile\.)?yangkeduo\.com\/(?:goods)/i, needId: true },
    { platform: 'pinduoduo', re: /^https?:\/\/(?:[\w-]+\.)*pinduoduo\.com\/(?:goods)/i, needId: true },
    // 拼多多商家版后台（mms.pinduoduo.com 等）
    { platform: 'pinduoduo', re: /^https?:\/\/(?:[\w-]+\.)*pinduoduo\.com\/.*(?:goods|item|product)/i, needId: false }
  ];

  // 商品编号类参数名
  const ID_PARAM_RE = /^(?:id|iid|ids|item_?id|goods_?id|spu_?id|sku_?id|ware_?id|product_?id|num_?iid|offer_?id|detail_?id)$/i;

  // 通用兜底：路径里出现这些词且带编号参数
  const GENERIC_PATH_RE = /(?:item|goods|product|detail|offer)/i;

  /**
   * 黑名单关键词：命中则认为不是商品图（图标、logo、占位图等）。
   * 注意这里要求关键词被路径分隔符包裹，避免误伤随机文件名（如 TB1qr8xxx.jpg 里不含独立的 qr 段）。
   */
  const BLACKLIST_SEGMENT_RE = /(?:^|[/_.\-#?&=])(icon|logo|sprite|placeholder|blank|loading|spinner|avatar|qrcode|watermark|default|grey|gray|pixel|favicon)(?:[/_.\-?#&=]|$)/i;

  // 明显的 1x1 像素图特征
  const TINY_RE = /(?:^|[^\d])1x1(?:[^\d]|$)|[?&](?:w|width)=1(?:&|$)|[?&](?:h|height)=1(?:&|$)/i;

  // 淘宝/天猫 CDN 的尺寸后缀，例如 xxx.jpg_400x400.jpg -> xxx.jpg（换成原图，提高清晰度）
  const CDN_SIZE_SUFFIX_RE = /_\d+x\d+(?:xz)?(?:q\d+)?(?:\.(?:jpe?g|png|webp|gif|avif))$/i;

  // 图片地址后缀校验
  const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp|gif|avif|bmp)(?:\?|#|$)/i;

  // 悬浮按钮图标（内联 SVG，避免依赖外部资源）
  const ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>' +
    '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/></svg>';

  /* ==================== 运行时状态 ==================== */

  let currentPlatform = 'unknown'; // 当前平台标识
  let isRunning = false;           // 是否正在提取（防重复触发）
  let hostEl = null;               // Shadow DOM 宿主
  let shadowRoot = null;
  let btnEl = null;
  let statusEl = null;
  let statusTimer = null;

  // 候选图片集合：key 为去重键
  const candidates = new Map();

  /* ==================== 工具函数 ==================== */

  /**
   * 把相对地址补全为绝对地址
   * @param {string} url
   * @returns {string} 失败返回空字符串
   */
  function toAbsolute(url) {
    if (!url || typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (!trimmed) return '';
    try {
      return new URL(trimmed, location.href).href;
    } catch (e) {
      return '';
    }
  }

  /**
   * 判断地址是否应该直接丢弃
   * @param {string} url
   * @returns {boolean}
   */
  function isSkippable(url) {
    if (!url) return true;
    // 协议过滤：data:（懒加载占位图）、blob:、about: 等一律不要
    if (/^(?:data|blob|about|javascript|chrome|chrome-extension|moz-extension|edge):/i.test(url)) return true;
    // SVG 图标不是商品图，且无法用 canvas 转 PNG
    if (/\.svg(?:[?#]|$)/i.test(url)) return true;
    // 太短的地址基本都是占位图
    if (url.length < 16) return true;
    // 黑名单关键词（图标 / logo / 占位图）
    if (BLACKLIST_SEGMENT_RE.test(url)) return true;
    // 1x1 像素图
    if (TINY_RE.test(url)) return true;
    return false;
  }

  /**
   * 去掉 CDN 尺寸后缀，尽量换成原图地址
   * @param {string} url
   * @returns {string}
   */
  function toOriginalUrl(url) {
    const stripped = url.replace(CDN_SIZE_SUFFIX_RE, '');
    // 仅当去掉后缀后仍然是合法图片地址时才采用
    return stripped !== url && IMAGE_EXT_RE.test(stripped) ? stripped : url;
  }

  /**
   * 去重键：忽略 http/https 差异与 #fragment
   * @param {string} url
   * @returns {string}
   */
  function dedupeKey(url) {
    return url.replace(/^https?:/i, '').replace(/#.*$/, '');
  }

  /**
   * 解析 srcset 字符串为 URL 数组
   * @param {string} srcset
   * @returns {string[]}
   */
  function parseSrcset(srcset) {
    if (!srcset || typeof srcset !== 'string') return [];
    return srcset
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  /**
   * 让出主线程（浏览器支持时用 requestIdleCallback）
   * @returns {Promise<void>}
   */
  function nextIdle() {
    return new Promise((resolve) => {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => resolve(), { timeout: 200 });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  /**
   * 并发执行任务池
   * @param {Array<Function>} tasks 每个元素是返回 Promise 的函数
   * @param {number} limit 并发上限
   * @returns {Promise<Array>}
   */
  async function runPool(tasks, limit) {
    const results = new Array(tasks.length).fill(null);
    let cursor = 0;
    const worker = async () => {
      while (cursor < tasks.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await tasks[index]();
      }
    };
    const workerCount = Math.max(1, Math.min(limit, tasks.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  /* ==================== 平台与详情页判定 ==================== */

  /**
   * 根据域名推断平台
   * @returns {'taobao'|'tmall'|'jd'|'pinduoduo'|'unknown'}
   */
  function matchPlatformByHost() {
    const host = location.hostname.toLowerCase();
    if (host.endsWith('taobao.com')) return 'taobao';
    if (host.endsWith('tmall.com')) return 'tmall';
    if (host.endsWith('jd.com')) return 'jd';
    if (host.endsWith('pinduoduo.com') || host.endsWith('yangkeduo.com')) return 'pinduoduo';
    return 'unknown';
  }

  /**
   * 判断查询参数里是否带商品编号
   * @returns {boolean}
   */
  function hasIdParam() {
    let params;
    try {
      params = new URLSearchParams(location.search);
    } catch (e) {
      return false;
    }
    for (const [key, value] of params) {
      if (ID_PARAM_RE.test(key)) return true;
      // 兜底：任何以 id 结尾的参数，且值是较长的数字串
      if (/id$/i.test(key) && /^\d{3,}$/.test(value)) return true;
    }
    return false;
  }

  /**
   * 判定当前页面是否应该显示「获取图片」按钮
   * @returns {{ok: boolean, platform: string, forced?: boolean}}
   */
  function detectDetailPage() {
    // 调试开关：?__imagegrab=1 强制显示（本地测试任意页面时很方便）
    let forced = false;
    try {
      forced = new URLSearchParams(location.search).get(FORCE_QUERY) === '1';
    } catch (e) {
      forced = false;
    }

    if (forced) {
      return { ok: true, platform: matchPlatformByHost(), forced: true };
    }

    const href = location.href;
    for (const rule of DETAIL_RULES) {
      if (rule.re.test(href) && (!rule.needId || hasIdParam())) {
        return { ok: true, platform: rule.platform };
      }
    }

    // 通用兜底：路径像商品页 + 带商品编号 + 域名属于三大平台之一
    const platformByHost = matchPlatformByHost();
    if (platformByHost !== 'unknown' && GENERIC_PATH_RE.test(location.pathname) && hasIdParam()) {
      return { ok: true, platform: platformByHost };
    }

    return { ok: false, platform: 'unknown' };
  }

  /* ==================== 悬浮按钮 UI（Shadow DOM） ==================== */

  /**
   * 创建宿主元素与按钮（只创建一次）
   */
  function ensureUI() {
    // 宿主还在页面上就直接复用
    if (hostEl && document.documentElement.contains(hostEl)) return;

    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    // 关键定位写成内联样式，双保险防止页面样式覆盖（content.css 里同样有定义）
    hostEl.style.position = 'fixed';
    hostEl.style.right = '24px';
    hostEl.style.bottom = '24px';
    hostEl.style.zIndex = '2147483000';
    hostEl.style.pointerEvents = 'none';

    shadowRoot = hostEl.attachShadow({ mode: 'open' });

    // 通过 <link> 引入 content.css（该文件已在 manifest 的 web_accessible_resources 中声明）
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('content.css');
    shadowRoot.appendChild(link);

    const panel = document.createElement('div');
    panel.className = 'ig-panel';

    btnEl = document.createElement('button');
    btnEl.type = 'button';
    btnEl.className = 'ig-btn';
    btnEl.id = 'ig-btn';
    btnEl.setAttribute('aria-label', '提取当前页面的所有商品图片（图提取 ImageGrab）');
    btnEl.innerHTML =
      '<span class="ig-btn__icon">' + ICON_SVG + '</span>' +
      '<span class="ig-btn__label">获取图片</span>';
    btnEl.addEventListener('click', runExtraction);

    statusEl = document.createElement('div');
    statusEl.className = 'ig-status';
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.hidden = true;

    panel.appendChild(btnEl);
    panel.appendChild(statusEl);
    shadowRoot.appendChild(panel);

    document.documentElement.appendChild(hostEl);
  }

  /**
   * 更新状态提示气泡
   * @param {string} text 文本；传空字符串则隐藏
   * @param {'ok'|'error'|''} [tone] 语义色
   */
  function setStatus(text, tone) {
    if (!statusEl) return;
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (!text) {
      statusEl.hidden = true;
      return;
    }
    statusEl.textContent = text;
    statusEl.classList.toggle('ig-status--ok', tone === 'ok');
    statusEl.classList.toggle('ig-status--error', tone === 'error');
    statusEl.hidden = false;

    // 普通进度提示 4 秒后自动隐藏；成功/失败提示保留，让用户看清结果
    if (!tone) {
      statusTimer = setTimeout(() => {
        statusEl.hidden = true;
      }, 4000);
    }
  }

  /**
   * 切换按钮忙碌态
   * @param {boolean} busy
   */
  function setBusy(busy) {
    if (!btnEl) return;
    btnEl.disabled = busy;
    btnEl.classList.toggle('ig-btn--busy', busy);
    const label = btnEl.querySelector('.ig-btn__label');
    if (label) {
      if (busy) {
        if (!label.dataset.idleText) label.dataset.idleText = label.textContent;
        label.textContent = '提取中…';
      } else if (label.dataset.idleText) {
        label.textContent = label.dataset.idleText;
      }
    }
  }

  /* ==================== 图片扫描 ==================== */

  /**
   * 加入候选列表（自动补全绝对地址、过滤、去重、换原图）
   * @param {string} rawUrl 原始地址
   * @param {string} source 来源标记
   * @param {Element|null} element 来源元素（可用于复用已加载的尺寸）
   * @param {{width: number, height: number}|null} knownSize 已知尺寸
   */
  function addCandidate(rawUrl, source, element, knownSize) {
    const absolute = toAbsolute(rawUrl);
    if (isSkippable(absolute)) return;

    const url = toOriginalUrl(absolute);
    if (isSkippable(url)) return;

    const key = dedupeKey(url);
    if (candidates.has(key)) {
      const existing = candidates.get(key);
      // 后出现的信息可能更完整（比如拿到了元素引用），补一下
      if (!existing.element && element) existing.element = element;
      return;
    }

    if (candidates.size >= CANDIDATE_LIMIT) return; // 上限保护

    candidates.set(key, {
      url,
      source,
      width: knownSize ? knownSize.width : 0,
      height: knownSize ? knownSize.height : 0,
      element: element || null
    });
  }

  /**
   * 扫描所有 <img> 元素：src / currentSrc / srcset / 各类 data-* 懒加载属性
   */
  function scanImgElements() {
    const imgs = document.querySelectorAll('img');
    for (const img of imgs) {
      // 已加载完成的图片可以直接拿到真实尺寸，后续就不用再探测了
      const knownSize =
        img.naturalWidth > 0 && img.naturalHeight > 0
          ? { width: img.naturalWidth, height: img.naturalHeight }
          : null;

      addCandidate(img.getAttribute('src'), 'img', img, knownSize);
      addCandidate(img.currentSrc, 'img', img, knownSize);

      parseSrcset(img.getAttribute('srcset')).forEach((u) => addCandidate(u, 'srcset', img, knownSize));

      // 懒加载写法五花八门：data-src / data-lazy-src / data-original / data-echo ...
      for (const attr of Array.from(img.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value;
        if (!value || !name.startsWith('data-')) continue;
        if (!/(src|img|image|pic|url|origin|lazy|echo|thumb)/.test(name)) continue;
        if (/srcset/i.test(name)) {
          parseSrcset(value).forEach((u) => addCandidate(u, 'data-src', img, knownSize));
        } else {
          addCandidate(value, 'data-src', img, knownSize);
        }
      }
    }
  }

  /**
   * 扫描 <picture><source srcset> 与 <video poster>
   */
  function scanPictureAndVideo() {
    for (const source of document.querySelectorAll('picture source[srcset]')) {
      parseSrcset(source.getAttribute('srcset')).forEach((u) => addCandidate(u, 'srcset', source, null));
    }
    for (const video of document.querySelectorAll('video[poster]')) {
      addCandidate(video.getAttribute('poster'), 'poster', video, null);
    }
  }

  /**
   * 扫描 CSS 背景图（分片执行 + 让出主线程，避免长任务卡死页面）
   * @param {(done: number, total: number) => void} [onProgress]
   */
  async function scanBackgroundImages(onProgress) {
    const all = Array.from(document.querySelectorAll('*')).slice(0, BG_ELEMENT_LIMIT);
    const skipTags = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'HEAD', 'TITLE', 'HTML']);
    const urlRe = /url\((['"]?)(.*?)\1\)/g;

    for (let i = 0; i < all.length; i += 1) {
      const el = all[i];

      if (skipTags.has(el.tagName)) continue;
      if (el.id === HOST_ID) continue;
      // 跳过我们自己的 UI（Shadow DOM 内部元素不必扫）
      if (typeof el.closest === 'function' && el.closest('#' + HOST_ID)) continue;

      let bg = '';
      try {
        bg = getComputedStyle(el).backgroundImage || '';
      } catch (e) {
        bg = '';
      }
      if (!bg || bg === 'none') continue;

      urlRe.lastIndex = 0;
      let match = urlRe.exec(bg);
      while (match !== null) {
        const raw = match[2];
        if (raw && !raw.startsWith('data:')) {
          addCandidate(raw, 'background', el, null);
        }
        match = urlRe.exec(bg);
      }

      // 分片：每处理 BG_CHUNK_SIZE 个元素就让出一次主线程
      if (i > 0 && i % BG_CHUNK_SIZE === 0) {
        if (onProgress) onProgress(i, all.length);
        await nextIdle();
      }
    }
  }

  /**
   * 探测单张图片的真实尺寸（同时起到「验证地址是否可用」的作用）
   * @param {string} url
   * @returns {Promise<{width: number, height: number}|null>} 不合格返回 null
   */
  function probeImage(url) {
    return new Promise((resolve) => {
      const probe = new Image();
      let settled = false;
      let timer = null;

      /**
       * 收尾：清理定时器与事件回调。
       * @param {{width: number, height: number}|null} result 探测结果
       * @param {boolean} abort 是否掐断尚未完成的图片请求
       */
      const finish = (result, abort) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        probe.onload = null;
        probe.onerror = null;
        // 超时的图片如果放着不管，请求会继续跑完整张图，大页面上会白白占用带宽与内存；
        // 置空 src 会取消这次未完成的加载（要在摘掉 onerror 之后再置空，避免误触发回调）
        if (abort) {
          try {
            probe.src = '';
          } catch (e) {
            /* 忽略 */
          }
        }
        resolve(result);
      };

      timer = setTimeout(() => finish(null, true), PROBE_TIMEOUT);

      probe.onload = () => {
        const width = probe.naturalWidth;
        const height = probe.naturalHeight;
        finish(width >= MIN_WIDTH && height >= MIN_HEIGHT ? { width, height } : null, false);
      };
      probe.onerror = () => finish(null, false);

      probe.referrerPolicy = 'no-referrer'; // 不发送 Referer，避免 CDN 防盗链拒绝
      probe.decoding = 'async';
      probe.src = url;
    });
  }

  /**
   * 并发探测所有候选图片的尺寸
   * @param {Array} list 候选列表
   * @param {(done: number, total: number) => void} [onProgress]
   * @returns {Promise<Array<{width: number, height: number}|null>>}
   */
  async function probeAll(list, onProgress) {
    let finished = 0;

    const tasks = list.map((item) => async () => {
      let size = null;

      // 已经拿到真实尺寸的（页面上已加载的 <img>）直接用，省一次网络请求
      if (item.width >= MIN_WIDTH && item.height >= MIN_HEIGHT) {
        size = { width: item.width, height: item.height };
      } else {
        size = await probeImage(item.url);
      }

      finished += 1;
      if (onProgress && (finished % 10 === 0 || finished === list.length)) {
        onProgress(finished, list.length);
      }
      return size;
    });

    return runPool(tasks, PROBE_CONCURRENCY);
  }

  /**
   * 完整提取流程
   * @returns {Promise<Array<{url: string, width: number, height: number, source: string}>>}
   */
  async function extractImages() {
    candidates.clear();

    // 1) 收集候选
    setStatus('扫描页面图片…');
    scanImgElements();
    scanPictureAndVideo();
    await scanBackgroundImages((done, total) => setStatus(`扫描背景图 ${done}/${total}`));

    const list = Array.from(candidates.values());
    if (list.length === 0) return [];

    // 2) 校验尺寸与可用性
    setStatus(`发现 ${list.length} 个候选，正在校验尺寸…`);
    const probed = await probeAll(list, (done, total) => setStatus(`校验尺寸 ${done}/${total}`));

    // 3) 汇总、过滤、按面积从大到小排序
    const accepted = [];
    for (let i = 0; i < list.length; i += 1) {
      const size = probed[i];
      if (!size) continue;
      accepted.push({
        url: list[i].url,
        width: size.width,
        height: size.height,
        source: list[i].source
      });
    }

    accepted.sort((a, b) => b.width * b.height - a.width * a.height);
    return accepted.slice(0, MAX_IMAGES);
  }

  /* ==================== 消息通信 ==================== */

  /**
   * 把提取结果发给 background
   * @param {Array} images
   * @returns {Promise<{ok: boolean, count?: number, error?: string}>}
   */
  function sendExtractMessage(images) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: MSG_EXTRACTED,
            images,
            pageUrl: location.href,
            pageTitle: document.title,
            platform: currentPlatform
          },
          (response) => {
            // 扩展被重载 / 禁用后 lastError 会被置位，此时页面需要刷新才能恢复
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: friendlyError(chrome.runtime.lastError.message) });
              return;
            }
            resolve(response || { ok: true, count: images.length });
          }
        );
      } catch (error) {
        resolve({ ok: false, error: friendlyError(error && error.message) });
      }
    });
  }

  /**
   * 把底层错误翻译成用户能看懂的提示
   * @param {string} message
   * @returns {string}
   */
  function friendlyError(message) {
    const text = String(message || '');
    if (/context invalidated|Receiving end does not exist|message port closed/i.test(text)) {
      return '插件已更新，请刷新页面后重试';
    }
    return text || '未知错误';
  }

  /**
   * 一次完整的「点击按钮」流程：提取 -> 上报 -> 状态反馈
   */
  async function runExtraction() {
    if (isRunning) return;
    isRunning = true;
    setBusy(true);

    try {
      const images = await extractImages();

      if (images.length === 0) {
        setStatus('未找到符合条件的商品图，可先向下滚动页面让图片加载出来', 'error');
        return;
      }

      setStatus(`提取到 ${images.length} 张，正在打开预览页…`);
      const response = await sendExtractMessage(images);

      if (response && response.ok) {
        setStatus(`已提取 ${response.count} 张图片，正在打开预览页…`, 'ok');
      } else {
        setStatus(`打开预览页失败：${(response && response.error) || '未知错误'}`, 'error');
      }
    } catch (error) {
      setStatus(`提取失败：${error && error.message ? error.message : error}`, 'error');
    } finally {
      setBusy(false);
      isRunning = false;
    }
  }

  /* ==================== 初始化 ==================== */

  /**
   * 注册来自 background 的消息监听
   * 注意：PING 必须始终可响应，否则 background 会认为脚本没注入而重复注入
   */
  function registerMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || !message.type) return false;

      if (message.type === MSG_PING) {
        sendResponse({ ok: true, ready: true });
        return false;
      }

      if (message.type === MSG_TRIGGER_EXTRACT) {
        runExtraction();
        sendResponse({ ok: true });
        return false;
      }

      return false;
    });
  }

  /**
   * 单页应用（拼多多商家版后台等）路由切换后重新判定是否需要显示按钮
   */
  function watchSpaNavigation() {
    const recheck = () => {
      const detection = detectDetailPage();
      if (!detection.ok) return;
      currentPlatform = detection.platform;
      ensureUI();
    };

    window.addEventListener('popstate', recheck);
    window.addEventListener('hashchange', recheck);

    // 用 history API 打补丁的方式监听 pushState/replaceState 引起的地址变化
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      if (typeof original !== 'function') continue;
      history[method] = function patchedHistoryMethod() {
        const result = original.apply(this, arguments);
        setTimeout(recheck, 300);
        return result;
      };
    }
  }

  function init() {
    const detection = detectDetailPage();

    // 始终注册消息监听，保证 background 的探活能得到响应
    registerMessageListener();

    // 非详情页：不注入任何 UI
    if (!detection.ok) return;

    currentPlatform = detection.platform;
    ensureUI();
    watchSpaNavigation();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
