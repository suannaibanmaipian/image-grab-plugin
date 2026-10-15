/**
 * gallery.js —— 图提取 ImageGrab 画廊页逻辑
 *
 * 职责：
 *  1) 读取 background 保存的最近一次提取结果（chrome.storage.local）
 *  2) 网格化渲染所有图片：缩略图、尺寸、来源、复选框
 *  3) 提供全选 / 反选 / 已选计数 / 批量下载 / 单项下载 / 失败重试
 *  4) 监听 background 广播的下载进度，展示进度条与结果反馈
 *  5) 支持大图预览（Lightbox）
 *
 * 注意：本文件是普通脚本（非 module），因为 MV3 的内容安全策略禁止内联脚本，
 *      同时普通脚本在 file:// 下也能直接加载，方便单独调试页面样式。
 */

(function () {
  'use strict';

  /* ==================== 常量区 ==================== */

  // 存储键（与 background.js 必须逐字一致）
  const STORAGE_KEY_LATEST = 'imageGrab.latest';
  const STORAGE_KEY_SETTINGS = 'imageGrab.settings';

  // 消息类型（与 background.js 必须逐字一致）
  const MSG_GET_LATEST = 'IMAGE_GRAB_GET_LATEST';
  const MSG_DOWNLOAD = 'IMAGE_GRAB_DOWNLOAD';
  const MSG_PROGRESS = 'IMAGE_GRAB_PROGRESS';
  const MSG_LATEST_UPDATED = 'IMAGE_GRAB_LATEST_UPDATED';

  // 默认设置（background 写入的同名键会覆盖这里）
  const DEFAULT_SETTINGS = { minWidth: 100, minHeight: 100, folder: '' };

  // 平台与来源的展示文案
  const PLATFORM_LABELS = { taobao: '淘宝', tmall: '天猫', jd: '京东', pinduoduo: '拼多多' };
  const SOURCE_LABELS = {
    img: '页面图片',
    srcset: '自适应图',
    'data-src': '懒加载图',
    background: '背景图',
    poster: '视频封面'
  };

  const FILENAME_PREFIX = '商品图'; // 文件名前缀：商品图_001.png
  const LOG_LIMIT = 200;             // 日志最多保留条数

  /* ==================== 状态 ==================== */

  const state = {
    images: [],            // 全部图片：[{ url, width, height, source }]
    selected: new Set(),   // 已选中的下标集合
    settings: Object.assign({}, DEFAULT_SETTINGS),
    platform: 'unknown',
    pageTitle: '',
    pageUrl: '',
    timestamp: 0,
    downloading: false,     // 是否正在下载（用于禁用按钮）
    failedItems: [],        // 下载失败的条目，供「重试失败项」使用
    progress: { done: 0, total: 0 }
  };

  /* ==================== DOM 引用 ==================== */

  const el = {
    envWarning: document.getElementById('envWarning'),
    sourceInfo: document.getElementById('sourceInfo'),
    platformBadge: document.getElementById('platformBadge'),
    selectAllBtn: document.getElementById('selectAllBtn'),
    invertBtn: document.getElementById('invertBtn'),
    reloadBtn: document.getElementById('reloadBtn'),
    retryBtn: document.getElementById('retryBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    counter: document.getElementById('counter'),
    progressWrap: document.getElementById('progressWrap'),
    progressFill: document.getElementById('progressFill'),
    progressText: document.getElementById('progressText'),
    resultBanner: document.getElementById('resultBanner'),
    emptyState: document.getElementById('emptyState'),
    gallery: document.getElementById('gallery'),
    logWrap: document.getElementById('logWrap'),
    logList: document.getElementById('logList'),
    clearLogBtn: document.getElementById('clearLogBtn'),
    lightbox: document.getElementById('lightbox'),
    lightboxBackdrop: document.getElementById('lightboxBackdrop'),
    lightboxImg: document.getElementById('lightboxImg'),
    lightboxInfo: document.getElementById('lightboxInfo'),
    lightboxToggle: document.getElementById('lightboxToggle'),
    lightboxDownload: document.getElementById('lightboxDownload'),
    lightboxClose: document.getElementById('lightboxClose'),
    toastArea: document.getElementById('toastArea')
  };

  // 当前 Lightbox 展示的图片下标（-1 表示未打开）
  let lightboxIndex = -1;

  /**
   * 最近一次真正渲染过的数据签名。
   *
   * 为什么需要它：background 在保存提取结果后，既会广播 IMAGE_GRAB_LATEST_UPDATED，
   * 也会触发 chrome.storage.onChanged，两条路径都会调用 loadData()，
   * 于是同一份数据被渲染两次（列表整块重建，选中状态被重置，白做一遍 DOM 工作）。
   * 用「数据签名」比对即可让第二条路径自动跳过。
   */
  let lastRenderedSignature = null;

  /* ==================== 环境判断与小工具 ==================== */

  /**
   * 是否运行在扩展环境中（直接双击打开 HTML 时为 false）
   * @returns {boolean}
   */
  function hasExtensionApi() {
    return (
      typeof chrome !== 'undefined' &&
      !!chrome.runtime &&
      !!chrome.runtime.id &&
      !!chrome.storage &&
      !!chrome.storage.local
    );
  }

  /**
   * Promise 化的 chrome.runtime.sendMessage
   * @param {object} message
   * @returns {Promise<object>}
   */
  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      if (!hasExtensionApi()) {
        reject(new Error('当前不在扩展环境中运行'));
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response || {});
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 生成下载文件名：商品图_001.png
   * @param {number} index 从 1 开始的序号
   * @param {number} total 本次下载总数（决定补零位数）
   * @returns {string}
   */
  function buildFilename(index, total) {
    const digits = Math.max(3, String(Math.max(total, 1)).length);
    return `${FILENAME_PREFIX}_${String(index).padStart(digits, '0')}.png`;
  }

  /**
   * 轻提示
   * @param {string} text
   * @param {'ok'|'err'|''} [tone]
   */
  function showToast(text, tone) {
    const toast = document.createElement('div');
    toast.className = 'toast' + (tone ? ` toast--${tone}` : '');
    toast.textContent = text;
    el.toastArea.appendChild(toast);
    setTimeout(() => toast.remove(), 2600);
  }

  /**
   * 顶部结果横幅
   * @param {string} text
   * @param {'ok'|'warn'|'err'|''} [tone]
   */
  function showBanner(text, tone) {
    el.resultBanner.textContent = '';
    el.resultBanner.className = 'banner' + (tone ? ` banner--${tone}` : '');
    el.resultBanner.hidden = false;

    const textSpan = document.createElement('span');
    textSpan.textContent = text;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'banner__close';
    closeBtn.setAttribute('aria-label', '关闭提示');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', hideBanner);

    el.resultBanner.appendChild(textSpan);
    el.resultBanner.appendChild(closeBtn);
  }

  /** 隐藏横幅 */
  function hideBanner() {
    el.resultBanner.hidden = true;
    el.resultBanner.textContent = '';
  }

  /**
   * 追加一条下载日志（最新的显示在最上面）
   * @param {string} text
   * @param {'ok'|'fail'|''} [tone]
   */
  function appendLog(text, tone) {
    el.logWrap.hidden = false;

    const item = document.createElement('li');
    item.className = 'log__item' + (tone ? ` log__item--${tone}` : '');
    const time = new Date().toLocaleTimeString();
    item.textContent = `[${time}] ${text}`;

    el.logList.insertBefore(item, el.logList.firstChild);

    // 控制日志长度，避免长时间下载把 DOM 撑爆
    while (el.logList.children.length > LOG_LIMIT) {
      el.logList.removeChild(el.logList.lastChild);
    }
  }

  /* ==================== 数据读取与渲染 ==================== */

  /**
   * 读取扩展设置（空目录、最小尺寸等）
   */
  async function loadSettings() {
    if (!hasExtensionApi()) return;
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY_SETTINGS);
      state.settings = Object.assign(
        {},
        DEFAULT_SETTINGS,
        (stored && stored[STORAGE_KEY_SETTINGS]) || {}
      );
    } catch (error) {
      state.settings = Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  /**
   * 计算一份提取结果的签名：同一次提取签名相同，不同次提取签名不同。
   * timestamp 由 background 在每次提取时写入；首尾 URL 与张数作为兜底指纹，
   * 万一日后出现没有 timestamp 的数据，也不会被误判成「和上次一样」。
   * @param {object|null} data
   * @returns {string}
   */
  function signatureOf(data) {
    if (!data) return 'empty';
    const images = Array.isArray(data.images) ? data.images : [];
    const first = images.length ? images[0].url : '';
    const last = images.length ? images[images.length - 1].url : '';
    return `${data.timestamp || 0}::${images.length}::${first}::${last}`;
  }

  /**
   * 读取最近一次提取结果（优先问 background，失败则直接读 storage）
   * @param {{force?: boolean}} [options] force 为 true 时即使数据没变也重新渲染（「重新读取」按钮用）
   * @returns {Promise<boolean>} 是否真的执行了渲染
   */
  async function loadData(options) {
    const force = !!(options && options.force);

    if (!hasExtensionApi()) {
      if (!force && lastRenderedSignature === 'empty') return false;
      lastRenderedSignature = 'empty';
      applyData(null);
      return true;
    }

    let data = null;
    try {
      const response = await sendMessage({ type: MSG_GET_LATEST });
      data = response.data || null;
    } catch (error) {
      data = null;
    }

    if (!data) {
      // 兜底：background 未响应时直接读本地存储
      try {
        const stored = await chrome.storage.local.get(STORAGE_KEY_LATEST);
        data = (stored && stored[STORAGE_KEY_LATEST]) || null;
      } catch (error) {
        data = null;
      }
    }

    // 广播与 storage.onChanged 会先后到达，第二遍拿到的是同一份数据，直接跳过重复渲染
    const signature = signatureOf(data);
    if (!force && signature === lastRenderedSignature) return false;

    lastRenderedSignature = signature;
    applyData(data);
    return true;
  }

  /**
   * 判断图片数据是否可用
   * @param {object} item
   * @returns {boolean}
   */
  function isUsableImage(item) {
    return !!item && typeof item.url === 'string' && item.url.length > 0;
  }

  /**
   * 应用数据到界面
   * @param {object|null} data
   */
  function applyData(data) {
    const images = data && Array.isArray(data.images) ? data.images.filter(isUsableImage) : [];

    state.images = images;
    state.selected = new Set();
    state.failedItems = [];
    state.platform = (data && data.platform) || 'unknown';
    state.pageTitle = (data && data.pageTitle) || '';
    state.pageUrl = (data && data.pageUrl) || '';
    state.timestamp = (data && data.timestamp) || 0;

    renderSourceInfo();
    renderGrid();
    updateToolbar();
    hideBanner();
  }

  /** 渲染来源页面信息与平台徽章 */
  function renderSourceInfo() {
    const label = PLATFORM_LABELS[state.platform];
    el.platformBadge.hidden = !label;
    el.platformBadge.textContent = label ? `${label} 商品详情页` : '';

    if (!hasExtensionApi()) {
      el.sourceInfo.textContent = '当前不在扩展环境中运行，页面仅展示样式';
      el.sourceInfo.removeAttribute('title');
      return;
    }

    if (!state.pageTitle && state.images.length === 0) {
      el.sourceInfo.textContent = '还没有提取记录，去商品详情页点一下「获取图片」吧';
      el.sourceInfo.removeAttribute('title');
      return;
    }

    const time = state.timestamp ? new Date(state.timestamp).toLocaleString() : '';
    el.sourceInfo.textContent = `${state.pageTitle || '未知页面'}${time ? ` · 提取于 ${time}` : ''}`;
    el.sourceInfo.title = state.pageUrl || '';
  }

  /** 渲染图片网格 */
  function renderGrid() {
    el.gallery.textContent = '';

    if (state.images.length === 0) {
      el.emptyState.hidden = false;
      document.title = '图提取 ImageGrab · 图片预览与下载';
      return;
    }

    el.emptyState.hidden = true;

    const fragment = document.createDocumentFragment();
    state.images.forEach((item, index) => {
      fragment.appendChild(createCard(item, index));
    });
    el.gallery.appendChild(fragment);

    document.title = `${state.images.length} 张图片 · 图提取 ImageGrab`;
  }

  /**
   * 创建单张图片卡片
   * @param {object} item
   * @param {number} index
   * @returns {HTMLElement}
   */
  function createCard(item, index) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.index = String(index);
    if (state.selected.has(index)) card.classList.add('is-selected');

    // ---- 缩略图 ----
    const thumb = document.createElement('div');
    thumb.className = 'card__thumb';

    const img = document.createElement('img');
    img.className = 'card__img';
    img.alt = `第 ${index + 1} 张商品图`;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer'; // 关键：不带 Referer，绕过大部分 CDN 防盗链
    img.src = item.url;
    img.addEventListener('error', () => {
      // 缩略图加载失败不影响勾选与下载
      img.remove();
      const fail = document.createElement('div');
      fail.className = 'card__fail';
      fail.textContent = '缩略图加载失败（仍可尝试下载）';
      thumb.appendChild(fail);
    });
    thumb.appendChild(img);

    // 点击缩略图打开大图预览（不切换选中状态）
    thumb.addEventListener('click', (event) => {
      event.stopPropagation();
      openLightbox(index);
    });

    // ---- 复选框 ----
    const checkLabel = document.createElement('label');
    checkLabel.className = 'card__check';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'card__input';
    input.checked = state.selected.has(index);
    input.setAttribute('aria-label', `选择第 ${index + 1} 张图片`);
    input.addEventListener('change', () => {
      setSelected(index, input.checked);
    });

    const box = document.createElement('span');
    box.className = 'card__box';
    box.setAttribute('aria-hidden', 'true');

    checkLabel.appendChild(input);
    checkLabel.appendChild(box);
    // 阻止冒泡，避免卡片点击与复选框互相打架
    checkLabel.addEventListener('click', (event) => event.stopPropagation());

    // ---- 信息区 ----
    const meta = document.createElement('div');
    meta.className = 'card__meta';

    const size = document.createElement('span');
    size.className = 'card__size';
    size.textContent = `${Math.round(item.width || 0)} × ${Math.round(item.height || 0)}`;

    const source = document.createElement('span');
    source.className = 'card__source';
    source.textContent = SOURCE_LABELS[item.source] || item.source || '图片';

    meta.appendChild(size);
    meta.appendChild(source);

    card.appendChild(thumb);
    card.appendChild(checkLabel);
    card.appendChild(meta);

    // 点击卡片任意位置切换选中
    card.addEventListener('click', () => {
      setSelected(index, !state.selected.has(index));
    });

    return card;
  }

  /* ==================== 选择逻辑 ==================== */

  /**
   * 设置某张图片的选中状态
   * @param {number} index
   * @param {boolean} selected
   */
  function setSelected(index, selected) {
    if (selected) {
      state.selected.add(index);
    } else {
      state.selected.delete(index);
    }
    syncCardState(index);
    updateToolbar();
    if (lightboxIndex === index) updateLightboxToggle();
  }

  /**
   * 同步单张卡片的选中外观
   * @param {number} index
   */
  function syncCardState(index) {
    const card = el.gallery.querySelector(`.card[data-index="${index}"]`);
    if (!card) return;
    const selected = state.selected.has(index);
    card.classList.toggle('is-selected', selected);
    const input = card.querySelector('.card__input');
    if (input) input.checked = selected;
  }

  /** 同步所有卡片的选中外观（全选/反选后使用） */
  function syncAllCardStates() {
    state.images.forEach((item, index) => syncCardState(index));
  }

  /** 全选 */
  function selectAll() {
    if (state.images.length === 0) {
      showToast('还没有可选的图片', 'err');
      return;
    }
    state.selected = new Set(state.images.map((item, index) => index));
    syncAllCardStates();
    updateToolbar();
  }

  /** 反选 */
  function invertSelection() {
    if (state.images.length === 0) {
      showToast('还没有可选的图片', 'err');
      return;
    }
    const next = new Set();
    state.images.forEach((item, index) => {
      if (!state.selected.has(index)) next.add(index);
    });
    state.selected = next;
    syncAllCardStates();
    updateToolbar();
  }

  /** 更新工具栏（计数、按钮文案与可用状态） */
  function updateToolbar() {
    const selectedCount = state.selected.size;
    const total = state.images.length;

    el.counter.textContent = `已选 ${selectedCount} / 共 ${total}`;
    el.downloadBtn.textContent = `下载选中 (${selectedCount})`;
    el.downloadBtn.disabled = state.downloading || selectedCount === 0;
    el.retryBtn.hidden = !(state.failedItems.length > 0 && !state.downloading);
    el.retryBtn.textContent = `重试失败项 (${state.failedItems.length})`;

    // 批量下载进行中时，预览层里的「下载此图」也要一起禁用。
    // 否则用户点下去只会弹一句「正在下载中，请稍候」，很容易让人以为按钮坏了。
    el.lightboxDownload.disabled = state.downloading;
  }

  /* ==================== 下载 ==================== */

  /**
   * 更新进度条
   * @param {number} done 已完成数量
   * @param {number} total 总数
   */
  function updateProgressUI(done, total) {
    state.progress = { done, total };
    el.progressWrap.hidden = false;
    el.progressText.textContent = `${done} / ${total}`;
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    el.progressFill.style.width = `${percent}%`;
  }

  /** 下载结束后的收尾 */
  function finishDownload() {
    state.downloading = false;
    updateToolbar();
  }

  /**
   * 执行下载（接受任意 items，便于「重试失败项」复用）
   * @param {Array<{url: string, filename: string}>} items
   */
  async function runDownload(items) {
    if (state.downloading) {
      showToast('正在下载中，请稍候', 'err');
      return;
    }
    if (!items || items.length === 0) {
      showToast('请先勾选需要下载的图片', 'err');
      return;
    }
    if (!hasExtensionApi()) {
      showToast('当前不在扩展环境中，无法下载', 'err');
      return;
    }

    const total = items.length;

    state.downloading = true;
    state.failedItems = [];
    el.logList.textContent = '';
    el.logWrap.hidden = false;
    hideBanner();
    updateProgressUI(0, total);
    updateToolbar();

    try {
      const response = await sendMessage({
        type: MSG_DOWNLOAD,
        items,
        targetFolder: state.settings.folder || ''
      });

      if (!response || response.ok !== true) {
        throw new Error((response && response.error) || '后台未确认下载请求');
      }
      appendLog(`已提交 ${response.started || total} 张图片，开始下载…`, '');
    } catch (error) {
      showBanner(
        `发起下载失败：${error.message}。若插件刚更新过，请关闭本页后重新从插件打开。`,
        'err'
      );
      finishDownload();
    }
  }

  /** 下载当前勾选的图片（文件名按网格顺序重新编号） */
  function downloadSelected() {
    const indices = Array.from(state.selected).sort((a, b) => a - b);
    if (indices.length === 0) {
      showToast('请先勾选需要下载的图片', 'err');
      return;
    }

    const total = indices.length;
    const items = indices.map((imageIndex, order) => ({
      url: state.images[imageIndex].url,
      filename: buildFilename(order + 1, total)
    }));

    runDownload(items);
  }

  /** 下载单张图片（Lightbox 内使用） */
  function downloadSingle(index) {
    const item = state.images[index];
    if (!item) return;
    runDownload([
      {
        url: item.url,
        filename: buildFilename(index + 1, state.images.length || 1)
      }
    ]);
  }

  /** 重试失败项（沿用原来的文件名编号） */
  function retryFailed() {
    if (state.failedItems.length === 0) {
      showToast('没有失败的图片需要重试', 'err');
      return;
    }
    const items = state.failedItems.slice();
    runDownload(items);
  }

  /**
   * 处理 background 广播的下载进度
   * @param {object} payload
   */
  function handleProgress(payload) {
    if (!payload || !payload.status) return;

    const total = payload.total || 0;

    switch (payload.status) {
      case 'start':
        appendLog(`开始处理 ${payload.filename || ''}`, '');
        updateProgressUI(Math.max(0, (payload.index || 1) - 1), total);
        break;

      case 'ok':
        appendLog(
          `已完成 ${payload.filename || ''}${
            payload.message && payload.message !== '已保存为 PNG' ? `（${payload.message}）` : ''
          }`,
          'ok'
        );
        updateProgressUI(payload.index || 0, total);
        break;

      case 'fail':
        appendLog(`失败 ${payload.filename || ''}：${payload.message || '未知原因'}`, 'fail');
        updateProgressUI(payload.index || 0, total);
        if (payload.url) {
          state.failedItems.push({ url: payload.url, filename: payload.filename });
        }
        break;

      case 'done': {
        updateProgressUI(total, total);

        // 失败项（第二次广播会带上 failedItems）
        if (Array.isArray(payload.failedItems) && payload.failedItems.length > 0) {
          state.failedItems = payload.failedItems;
        }

        const failed = payload.failed || 0;
        const success = payload.success || 0;
        const degraded = payload.degraded || 0;

        const summary =
          payload.message ||
          `下载完成：成功 ${success} 张${degraded > 0 ? `（其中 ${degraded} 张为原图格式）` : ''}${
            failed > 0 ? `，失败 ${failed} 张` : ''
          }`;

        showBanner(
          failed > 0 ? `${summary}　可点击「重试失败项」再次尝试` : summary,
          failed > 0 ? 'warn' : 'ok'
        );
        appendLog(summary, failed > 0 ? 'fail' : 'ok');

        if (state.downloading) finishDownload();
        break;
      }

      default:
        break;
    }
  }

  /* ==================== 大图预览（Lightbox） ==================== */

  /**
   * 打开大图预览
   * @param {number} index
   */
  function openLightbox(index) {
    const item = state.images[index];
    if (!item) return;

    lightboxIndex = index;
    el.lightboxImg.src = item.url;
    el.lightboxInfo.textContent =
      `第 ${index + 1} 张 / 共 ${state.images.length} 张 · ` +
      `${Math.round(item.width || 0)} × ${Math.round(item.height || 0)} · ` +
      `${SOURCE_LABELS[item.source] || item.source || '图片'}`;
    updateLightboxToggle();
    el.lightbox.hidden = false;
    el.lightboxClose.focus();
  }

  /** 关闭大图预览 */
  function closeLightbox() {
    el.lightbox.hidden = true;
    lightboxIndex = -1;
    el.lightboxImg.removeAttribute('src');
  }

  /** 更新 Lightbox 中「选中此图」按钮的文案 */
  function updateLightboxToggle() {
    if (lightboxIndex < 0) return;
    const selected = state.selected.has(lightboxIndex);
    el.lightboxToggle.textContent = selected ? '取消选中' : '选中此图';
  }

  /* ==================== 事件绑定与初始化 ==================== */

  /** 绑定所有 DOM 事件 */
  function bindEvents() {
    el.selectAllBtn.addEventListener('click', selectAll);
    el.invertBtn.addEventListener('click', invertSelection);
    el.reloadBtn.addEventListener('click', () => {
      // 手动重新读取：即使用户点的时候数据没变，也要按用户的预期重新渲染一次
      loadData({ force: true }).then(() => showToast('已重新读取提取结果'));
    });
    el.retryBtn.addEventListener('click', retryFailed);
    el.downloadBtn.addEventListener('click', downloadSelected);
    el.clearLogBtn.addEventListener('click', () => {
      el.logList.textContent = '';
      el.logWrap.hidden = true;
    });

    // Lightbox
    el.lightboxBackdrop.addEventListener('click', closeLightbox);
    el.lightboxClose.addEventListener('click', closeLightbox);
    el.lightboxToggle.addEventListener('click', () => {
      if (lightboxIndex < 0) return;
      setSelected(lightboxIndex, !state.selected.has(lightboxIndex));
    });
    el.lightboxDownload.addEventListener('click', () => {
      if (lightboxIndex < 0) return;
      downloadSingle(lightboxIndex);
    });

    // Esc 关闭大图预览
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !el.lightbox.hidden) {
        closeLightbox();
      }
    });
  }

  /** 注册来自 background 的广播监听 */
  function registerMessageListener() {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || !message.type) return;
      if (message.type === MSG_PROGRESS) {
        handleProgress(message.payload);
      } else if (message.type === MSG_LATEST_UPDATED) {
        // 收到广播就说明确实有一次新的提取结果：提示照常给，
        // 渲染交给 loadData 去重（可能刚刚已经被 storage.onChanged 那一路渲染过了）
        loadData().then(() => showToast('检测到新的提取结果，正在刷新'));
      }
    });

    // 额外保险：直接监听 storage 变化，避免广播丢失导致列表不更新
    // （与上面的广播共用同一套签名去重，所以同一份数据不会渲染两次）
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes[STORAGE_KEY_LATEST]) {
        loadData();
      }
    });
  }

  /**
   * 初始化
   */
  function init() {
    bindEvents();

    // 非扩展环境：显示提示 + 空状态，不报错、不白屏
    if (!hasExtensionApi()) {
      el.envWarning.hidden = false;
      state.images = [];
      renderSourceInfo();
      renderGrid();
      updateToolbar();
      return;
    }

    registerMessageListener();
    loadSettings().then(loadData);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
