/**
 * background.js —— 图提取 ImageGrab 的 Service Worker（Manifest V3）
 *
 * 职责：
 *  1) 接收 content.js 提取到的图片列表，写入 chrome.storage.local，并打开/聚焦 gallery.html
 *  2) 接收 gallery.html 的批量下载请求，逐张 fetch + 转 PNG，再用 chrome.downloads.download 保存
 *  3) 下载进度实时广播给所有扩展页面
 *  4) 点击工具栏图标时，向当前标签页注入 content script 并触发一次提取
 *
 * 重要的 MV3 约束（踩坑点）：
 *  - Service Worker 中 **没有** URL.createObjectURL，所以 Blob 必须用
 *    FileReader.readAsDataURL 转成 data URL 才能交给 chrome.downloads.download。
 *  - Service Worker 空闲约 30 秒会被回收，下载队列运行期间需要「保活」。
 */

'use strict';

/* ==================== 常量区 ==================== */

// ---- 消息类型（与 content.js / gallery.js 必须逐字一致）----
const MSG_EXTRACTED = 'IMAGE_GRAB_EXTRACTED';            // content -> background：已提取到图片
const MSG_GET_LATEST = 'IMAGE_GRAB_GET_LATEST';          // gallery -> background：读取最近一次提取结果
const MSG_DOWNLOAD = 'IMAGE_GRAB_DOWNLOAD';              // gallery -> background：批量下载请求
const MSG_PROGRESS = 'IMAGE_GRAB_PROGRESS';              // background -> 所有扩展页面：下载进度
const MSG_LATEST_UPDATED = 'IMAGE_GRAB_LATEST_UPDATED';  // background -> 所有扩展页面：提取结果已更新
const MSG_TRIGGER_EXTRACT = 'IMAGE_GRAB_TRIGGER_EXTRACT'; // background -> content：请执行一次提取
const MSG_PING = 'IMAGE_GRAB_PING';                      // background -> content：探活

// ---- 存储键（与 gallery.js 必须逐字一致）----
const STORAGE_KEY_LATEST = 'imageGrab.latest';
const STORAGE_KEY_SETTINGS = 'imageGrab.settings';
const STORAGE_KEY_GALLERY_TAB = 'imageGrab.galleryTabId';

// ---- 下载参数 ----
const CONCURRENCY = 2;            // 同时处理的最大图片数（过高会占满内存）
const MAX_RETRY = 2;              // PNG 转换的总尝试次数（首次 + 1 次重试）
const KEEPALIVE_INTERVAL = 20000; // Service Worker 保活心跳间隔（毫秒）
const GALLERY_PAGE = 'gallery.html';
const MAX_FILENAME_LENGTH = 120;  // 文件名长度上限，避免超出系统限制

// ---- 默认设置（onInstalled 时写入，gallery 会读取）----
const DEFAULT_SETTINGS = {
  minWidth: 100,
  minHeight: 100,
  folder: '' // 空字符串表示使用浏览器默认下载目录
};

/* ==================== 保活机制 ==================== */

let keepAliveTimer = null;

/**
 * 开始保活：MV3 的 Service Worker 空闲约 30 秒会被浏览器回收，
 * 下载队列执行期间定期调用一个扩展 API，可以重置空闲计时器，避免队列被中断。
 */
function keepAliveStart() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    // 任意扩展 API 调用都会重置 SW 空闲计时器，这里用最轻量的 getPlatformInfo
    try {
      chrome.runtime.getPlatformInfo().catch(() => {});
    } catch (e) {
      /* 忽略：SW 正在退出时可能抛错 */
    }
  }, KEEPALIVE_INTERVAL);
}

/** 结束保活 */
function keepAliveStop() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

/* ==================== 工具函数 ==================== */

/**
 * 向所有扩展页面广播消息（失败时静默忽略：可能没有任何页面在监听）
 * @param {object} message
 */
function broadcast(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch (e) {
    /* 忽略：没有接收方 */
  }
}

/**
 * 广播一条下载进度
 * @param {object} payload { index, total, url, filename, status, message }
 */
function broadcastProgress(payload) {
  broadcast({ type: MSG_PROGRESS, payload });
}

/**
 * 清洗文件名：替换 Windows/macOS 非法字符，限制长度，保证 .png 后缀
 * @param {string} raw 原始文件名
 * @param {number} index 序号（从 0 开始，仅用于兜底命名）
 * @param {number} total 总数（仅用于兜底命名）
 * @returns {string} 安全的文件名
 */
function sanitizeFilename(raw, index = 0, total = 1) {
  let name = String(raw || '').trim();

  // 兜底：gallery 未传文件名时，用「商品图_001.png」规则生成
  if (!name) {
    const digits = Math.max(3, String(total).length);
    name = `商品图_${String(index + 1).padStart(digits, '0')}.png`;
  }

  // 只保留最后一段（防止 gallery 传入路径导致下载到意外目录）
  name = name.split(/[\\/]/).pop() || name;

  // 替换非法字符与控制字符
  name = name
    .replace(/[\\/:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 去掉首尾的点（Windows 不允许以点结尾）
  name = name.replace(/^\.+/, '').replace(/\.+$/, '');

  // 长度截断（保留 .png 后缀）
  if (name.length > MAX_FILENAME_LENGTH) {
    name = name.slice(0, MAX_FILENAME_LENGTH - 4);
  }

  if (!/\.png$/i.test(name)) {
    name = name.replace(/\.[a-z0-9]{1,5}$/i, '') + '.png';
  }

  return name || 'image.png';
}

/**
 * 把下载文件夹与文件名拼成 chrome.downloads 需要的相对路径
 * @param {string} filename
 * @param {string} folder 例如 '商品图'，空字符串表示默认下载目录
 */
function joinFolder(filename, folder) {
  const clean = String(folder || '').replace(/^[\\/]+|[\\/]+$/g, '').trim();
  return clean ? `${clean}/${filename}` : filename;
}

/**
 * 降级下载时推断原图扩展名
 * @param {string} url
 * @returns {string} 形如 '.jpg'
 */
function guessExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(jpe?g|png|webp|gif|bmp|avif)$/i);
    if (match) return '.' + match[1].toLowerCase();
  } catch (e) {
    /* 忽略非法 URL */
  }
  return '.jpg';
}

/**
 * Blob -> data URL（MV3 Service Worker 里不能用 URL.createObjectURL）
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取图片数据失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 拉取图片并统一转成 PNG 的 data URL
 * 流程：fetch -> Blob -> createImageBitmap -> OffscreenCanvas -> PNG Blob -> FileReader
 * @param {string} url 图片原始地址
 * @returns {Promise<string>} data:image/png;base64,...
 */
async function fetchAsPngDataUrl(url) {
  const response = await fetch(url, {
    credentials: 'omit',            // 不携带 cookie，避免部分 CDN 的跨域限制
    referrerPolicy: 'no-referrer',  // 不发送 Referer，绕过多数防盗链校验
    cache: 'force-cache'
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const blob = await response.blob();
  if (!blob || blob.size === 0) {
    throw new Error('图片内容为空');
  }

  // 本身就是 PNG 时直接使用，省掉一次解码编码
  if (blob.type === 'image/png') {
    return await blobToDataUrl(blob);
  }

  // 能力检测：老版浏览器可能没有 OffscreenCanvas / createImageBitmap
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') {
    throw new Error('当前环境不支持 PNG 转换');
  }

  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布上下文');
    // PNG 支持透明通道，直接绘制即可
    ctx.drawImage(bitmap, 0, 0);
    const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    if (!pngBlob || pngBlob.size === 0) throw new Error('PNG 转换结果为空');
    return await blobToDataUrl(pngBlob);
  } finally {
    // createImageBitmap 得到的位图需要手动释放，否则批量下载时内存增长很快
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

/**
 * 下载单张图片：优先转 PNG，全部失败后降级下载原图
 * @param {string} url 图片地址
 * @param {string} filename 目标文件名（已清洗）
 * @param {string} folder 目标文件夹（可为空）
 * @param {number} index 序号（兜底命名用）
 * @param {number} total 总数（兜底命名用）
 * @returns {Promise<{ok: boolean, degraded: boolean, message: string}>}
 */
async function downloadOne(url, filename, folder, index, total) {
  const safeName = sanitizeFilename(filename, index, total);
  let lastError = null;

  // ---- 第一优先级：fetch + canvas 转 PNG ----
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const dataUrl = await fetchAsPngDataUrl(url);
      await chrome.downloads.download({
        url: dataUrl,
        filename: joinFolder(safeName, folder),
        saveAs: false,
        conflictAction: 'uniquify' // 重名时自动加 (1) 而不是覆盖
      });
      return { ok: true, degraded: false, message: '已保存为 PNG' };
    } catch (error) {
      lastError = error;
      // 短暂退避后重试
      if (attempt < MAX_RETRY) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }

  // ---- 降级方案：直接把原图地址交给 downloads（浏览器会带上必要的请求头，能绕过部分防盗链）----
  try {
    const fallbackName = safeName.replace(/\.png$/i, guessExtension(url));
    await chrome.downloads.download({
      url,
      filename: joinFolder(fallbackName, folder),
      saveAs: false,
      conflictAction: 'uniquify'
    });
    return {
      ok: true,
      degraded: true,
      message: `已下载原图（PNG 转换失败：${lastError ? lastError.message : '未知原因'}）`
    };
  } catch (fallbackError) {
    return {
      ok: false,
      degraded: false,
      message: `下载失败：${fallbackError.message || fallbackError}`
    };
  }
}

/**
 * 启动下载队列（带并发控制）
 * @param {Array<{url: string, filename: string}>} items
 * @param {string} folder 目标文件夹
 */
async function startDownloadQueue(items, folder) {
  const total = items.length;
  if (total === 0) return;

  keepAliveStart();

  let success = 0;   // 成功保存为 PNG 的数量
  let degraded = 0;  // 转换失败但成功下载了原图的数量
  let failed = 0;    // 完全失败的数量
  const failedItems = [];
  let cursor = 0;

  /** 单个工作协程：不断领取下一个任务直到队列清空 */
  async function worker() {
    while (cursor < total) {
      const index = cursor; // 领取任务
      cursor += 1;
      const item = items[index];
      const safeName = sanitizeFilename(item && item.filename, index, total);

      broadcastProgress({
        index: index + 1,
        total,
        url: item && item.url,
        filename: safeName,
        status: 'start',
        message: `正在处理 ${index + 1}/${total}`
      });

      // 兼容：极端情况下 item 缺失
      const result = item && item.url
        ? await downloadOne(item.url, safeName, folder, index, total)
        : { ok: false, degraded: false, message: '缺少图片地址' };

      if (result.ok && result.degraded) {
        degraded += 1;
        success += 1;
        broadcastProgress({
          index: index + 1,
          total,
          url: item && item.url,
          filename: safeName,
          status: 'ok',
          message: result.message
        });
      } else if (result.ok) {
        success += 1;
        broadcastProgress({
          index: index + 1,
          total,
          url: item && item.url,
          filename: safeName,
          status: 'ok',
          message: '已保存为 PNG'
        });
      } else {
        failed += 1;
        failedItems.push(item);
        broadcastProgress({
          index: index + 1,
          total,
          url: item && item.url,
          filename: safeName,
          status: 'fail',
          message: result.message
        });
      }
    }
  }

  const workerCount = Math.max(1, Math.min(CONCURRENCY, total));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  keepAliveStop();

  // 汇总结果
  broadcastProgress({
    index: total,
    total,
    status: 'done',
    success,
    degraded,
    failed,
    message: failed > 0
      ? `下载完成：成功 ${success} 张（其中 ${degraded} 张为原图格式），失败 ${failed} 张`
      : `下载完成：成功 ${success} 张${degraded > 0 ? `（其中 ${degraded} 张为原图格式）` : ''}`
  });

  // 失败项返回给页面，方便「重试失败项」
  if (failedItems.length > 0) {
    broadcast({
      type: MSG_PROGRESS,
      payload: {
        index: total,
        total,
        status: 'done',
        success,
        degraded,
        failed,
        failedItems,
        message: '存在下载失败的图片，可点击「重试失败项」再次尝试'
      }
    });
  }
}

/* ==================== 画廊页管理 ==================== */

/**
 * 打开或聚焦画廊页：如果之前打开过就复用那个标签页并刷新（保证数据是最新的）
 */
async function openOrFocusGallery() {
  const galleryUrl = chrome.runtime.getURL(GALLERY_PAGE);

  // 读取上次记录的标签页 id
  let storedId = null;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_GALLERY_TAB);
    storedId = stored && stored[STORAGE_KEY_GALLERY_TAB];
  } catch (e) {
    storedId = null;
  }

  // 尝试复用已存在的标签页（标签页可能已被用户手动关闭，所以要 try/catch）
  if (typeof storedId === 'number') {
    try {
      const tab = await chrome.tabs.get(storedId);
      if (tab) {
        // 传入相同的 URL 会触发重新加载，页面重新读取最新的 storage 数据
        await chrome.tabs.update(storedId, { url: galleryUrl, active: true });
        if (typeof tab.windowId === 'number') {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return;
      }
    } catch (e) {
      // 标签页已不存在，走新建流程
    }
  }

  const tab = await chrome.tabs.create({ url: galleryUrl });
  if (tab && typeof tab.id === 'number') {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY_GALLERY_TAB]: tab.id });
    } catch (e) {
      /* 忽略 */
    }
  }
}

/* ==================== 消息处理 ==================== */

/**
 * 处理「已提取」消息：写 storage -> 广播 -> 打开画廊页
 * @param {{images: Array, pageUrl: string, pageTitle: string, platform: string}} message
 * @returns {Promise<{ok: boolean, count: number, error?: string}>}
 */
async function handleExtracted(message) {
  const images = Array.isArray(message.images) ? message.images : [];

  if (images.length === 0) {
    return { ok: true, count: 0 };
  }

  const payload = {
    images,
    pageUrl: message.pageUrl || '',
    pageTitle: message.pageTitle || '',
    platform: message.platform || 'unknown',
    timestamp: Date.now()
  };

  try {
    await chrome.storage.local.set({ [STORAGE_KEY_LATEST]: payload });
  } catch (error) {
    return { ok: false, count: images.length, error: `保存数据失败：${error.message}` };
  }

  // 通知已经打开的画廊页刷新列表
  broadcast({ type: MSG_LATEST_UPDATED, payload: { count: images.length } });

  try {
    await openOrFocusGallery();
  } catch (error) {
    return { ok: false, count: images.length, error: `打开预览页失败：${error.message}` };
  }

  return { ok: true, count: images.length };
}

/**
 * 统一的消息入口
 * 约定：异步分支必须 return true，否则消息通道会提前关闭
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;

  switch (type) {
    // content.js 上报提取结果
    case MSG_EXTRACTED: {
      handleExtracted(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, count: 0, error: error.message }));
      return true;
    }

    // gallery.js 读取最近一次提取结果
    case MSG_GET_LATEST: {
      chrome.storage.local
        .get(STORAGE_KEY_LATEST)
        .then((stored) => {
          sendResponse({ ok: true, data: (stored && stored[STORAGE_KEY_LATEST]) || null });
        })
        .catch((error) => sendResponse({ ok: false, data: null, error: error.message }));
      return true;
    }

    // gallery.js 请求批量下载
    case MSG_DOWNLOAD: {
      const items = Array.isArray(message.items) ? message.items : [];
      const folder = typeof message.targetFolder === 'string' ? message.targetFolder : '';

      // 立刻响应，避免页面等待；真正的下载在后台队列中进行
      sendResponse({ ok: true, started: items.length });

      if (items.length > 0) {
        startDownloadQueue(items, folder).catch((error) => {
          // 队列级异常（理论上不会发生）也要反馈给页面，不能静默失败
          broadcastProgress({
            index: 0,
            total: items.length,
            status: 'done',
            success: 0,
            degraded: 0,
            failed: items.length,
            message: `下载队列异常：${error.message}`
          });
        });
      }
      return false;
    }

    default:
      // 忽略广播类消息（例如 SW 自己发出的进度广播）
      return false;
  }
});

/* ==================== 工具栏图标：手动触发提取 ==================== */

/**
 * 在指定标签页触发一次提取；content script 未注入时先动态注入
 * @param {number} tabId
 */
async function triggerExtractOnTab(tabId) {
  let injected = false;

  // 先探活：能收到响应说明 content script 已在运行
  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG_PING });
    injected = true;
  } catch (e) {
    injected = false;
  }

  // 未注入则手动注入（依赖 activeTab + scripting 权限）
  if (!injected) {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  }

  await chrome.tabs.sendMessage(tabId, { type: MSG_TRIGGER_EXTRACT });
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab || typeof tab.id !== 'number') return;

  triggerExtractOnTab(tab.id).catch((error) => {
    // 不支持的页面（非三大平台或非详情页）会走到这里，用徽标给个提示
    try {
      chrome.action.setBadgeText({ tabId: tab.id, text: '×' });
      chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#b42318' });
      setTimeout(() => {
        chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {});
      }, 2000);
    } catch (e) {
      /* 忽略 */
    }
    console.warn('[图提取] 无法在当前页面触发提取：', error && error.message);
  });
});

/* ==================== 安装初始化 ==================== */

chrome.runtime.onInstalled.addListener(() => {
  // 写入默认设置，但绝不覆盖用户已经改过的值
  chrome.storage.local
    .get(STORAGE_KEY_SETTINGS)
    .then((stored) => {
      const current = (stored && stored[STORAGE_KEY_SETTINGS]) || {};
      const merged = Object.assign({}, DEFAULT_SETTINGS, current);
      return chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: merged });
    })
    .catch((error) => {
      console.warn('[图提取] 初始化默认设置失败：', error);
    });
});
