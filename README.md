# 图提取 ImageGrab

一个 Chrome 浏览器扩展（Manifest V3）：在**淘宝 / 天猫 / 京东 / 拼多多（含商家版）**的商品详情页一键提取页面内所有商品图片，在新标签页中集中预览、勾选，并批量下载为 **PNG** 格式。

---

## 一、功能列表

| 功能 | 说明 |
| --- | --- |
| 一键提取 | 扫描页面内 `<img>`、`srcset`、`data-src` 等懒加载属性、`background-image` 背景图、`picture`、`video poster` |
| 智能过滤 | 自动排除图标、logo、占位图、1×1 像素图，以及小于 100×100 的小图 |
| 集中预览 | 新标签页网格展示全部图片，含缩略图、真实尺寸、来源标签 |
| 自由勾选 | 支持全选、反选、点卡片勾选、大图预览、按需下载 |
| 统一 PNG | jpg / webp / gif 等格式自动通过 canvas 转为 PNG |
| 批量下载 | 一键保存到浏览器默认下载目录，文件名按 `商品图_001.png` 递增 |

---

## 二、文件结构

```
image-grab-plugin/
├── manifest.json        # MV3 清单：权限、host_permissions、icons、内容脚本注册
├── icons/               # 工具栏图标（16/32/48/128 的真实 PNG，由 tests/make-icons.js 生成）
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── content.js           # 内容脚本：详情页判定 + 右下角悬浮按钮 + 图片扫描
├── content.css          # 悬浮按钮样式（在 Shadow DOM 内生效，不污染页面）
├── background.js        # Service Worker：消息转发、PNG 转换、下载队列、进度广播
├── gallery.html         # 画廊页结构
├── gallery.js           # 画廊页逻辑：渲染、勾选、下载、进度、大图预览
├── gallery.css          # 画廊页样式（响应式网格）
├── README.md            # 本说明文档
├── tests/               # 开发期校验脚本（与插件运行无关，可直接删除）
│   ├── selfcheck.js         # 静态自检：语法、manifest、HTML/CSS、跨文件消息契约
│   ├── test-background.js   # background.js 的桩对象测试
│   ├── test-content.js      # content.js 的 jsdom 测试（需要 jsdom）
│   ├── test-gallery.js      # gallery.js 的 jsdom 测试（需要 jsdom）
│   └── make-icons.js        # 用 zlib 生成 icons/ 下的 PNG 图标
└── docs/                # 静态官网（与插件运行无关，双击 index.html 即可打开）
    ├── index.html
    ├── css/style.css
    ├── js/main.js
    └── assets/
```

> 加载扩展时只需要 `manifest.json` 所在的这一层目录；`tests/`、`docs/` 不会被打包执行，删掉也不影响插件运行。

### 开发期自检（可选）

在项目根目录执行（需要 Node.js）：

```bash
node tests/selfcheck.js        # 81 项静态检查，不需要额外依赖
node tests/test-background.js  # 50 项，桩对象测试
node tests/test-content.js     # 41 项，需要 jsdom
node tests/test-gallery.js     # 74 项，需要 jsdom
```

后两个脚本需要 `jsdom`（非插件依赖）。查找顺序是：环境变量 `IG_JSDOM_PATH` → `require('jsdom')` → 项目根 / `tests/` 下的 `node_modules` → 开发机上用过的临时目录；都找不到时会打印 `[SKIP]` 提示并正常退出，不会报错中断。安装方式：在项目根目录执行 `npm i jsdom`。

需要重新生成工具栏图标时：

```bash
node tests/make-icons.js icons
```

---

## 三、安装步骤

1. 把 `image-grab-plugin` 文件夹下载／复制到本地（如果拿到的是压缩包，请先解压）。
2. 打开 Chrome，地址栏输入 `chrome://extensions` 回车。
3. 打开右上角的**开发者模式**开关。
4. 点击左上角的**加载已解压的扩展程序**，选择 `image-grab-plugin` 文件夹（即包含 `manifest.json` 的那一层）。
5. 安装成功后，工具栏会出现「图提取 ImageGrab」图标（可点击图标把它固定到工具栏）。

> 提示：安装后如果商品详情页已经打开着，请**刷新页面**，内容脚本才会注入。

---

## 四、使用说明

### 常规流程

1. 打开淘宝 / 天猫 / 京东 / 拼多多商家版的**商品详情页**。
2. 页面右下角会出现蓝紫渐变的「**获取图片**」按钮，点击它。
3. 插件自动扫描页面图片（状态气泡会显示「扫描页面图片…」「校验尺寸 12/48」等进度），完成后自动打开一个新的标签页展示画廊。
4. 在画廊页里用「全选 / 反选」或直接点击卡片勾选需要的图片。
5. 点击「下载选中」，观察进度条与下载日志；完成后顶部横幅会给出结果反馈（成功 / 失败张数）。
6. 文件保存在浏览器默认下载目录，命名为 `商品图_001.png`、`商品图_002.png` ……（超过 999 张时自动加宽位数）。

### 其他入口

- **工具栏图标**：点击扩展图标也可以触发提取（会自动向当前页面注入脚本）。
- **大图预览**：在画廊里点击缩略图可打开大图，支持「选中此图」「下载此图」，按 `Esc` 关闭。
- **失败重试**：若个别图片下载失败，结果横幅旁会出现「重试失败项」，沿用原来的文件编号重新下载。
- **调试开关**：在任意页面 URL 后加 `?__imagegrab=1`，可强制显示按钮，方便本地测试提取逻辑。

---

## 五、技术说明

### 权限用途

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 点击工具栏图标时，临时获得当前标签页的操作权限 |
| `scripting` | 图标点击时向页面动态注入 `content.css` / `content.js` |
| `downloads` | 调用 `chrome.downloads.download` 保存 PNG 文件 |
| `storage` | 保存最近一次提取结果（`imageGrab.latest`）与设置（`imageGrab.settings`） |

`host_permissions` 除三大平台域名外，还包含图片 CDN 域名（`alicdn.com`、`360buyimg.com`、`pddpic.com` 等），目的是让 Service Worker 能够直接 `fetch` 这些域名的图片，不受跨域限制。

`web_accessible_resources` 只把 `content.css` 暴露给三个平台的域名（而不是 `<all_urls>`）：内容脚本用 `<link>` 在 Shadow DOM 里引入该样式时，请求是页面发起的，必须声明为可被访问；把范围收窄到平台域名后功能不变，同时不会让无关网站探测到扩展指纹。

`icons` 声明的是 `icons/` 下的真实 PNG（Chrome 的 `icons` 字段不支持 SVG），由 `tests/make-icons.js` 用 zlib 直接生成，不依赖任何图形库。

### PNG 转换原理

1. `fetch(url)` 取回图片 `Blob`（已带 host 权限，不受 CORS 限制）。
2. `createImageBitmap(blob)` 解码为位图。
3. `OffscreenCanvas` + `drawImage` + `convertToBlob({ type: 'image/png' })` 输出 PNG Blob。
4. 再把 PNG `Blob` 通过 `FileReader.readAsDataURL` 转成 data URL，交给 `chrome.downloads.download`。

> 为什么不用 `URL.createObjectURL`？因为 **MV3 的 Service Worker 里没有这个 API**，这是同类插件最常见的报错来源。
>
> 某些图片（例如原图本身是 PNG，或环境不支持 `OffscreenCanvas`）会跳过多余的解码；若转换最终失败，插件会**降级为直接下载原图**，并在日志中说明「已下载原图，PNG 转换失败」。

### 内部消息协议

| 消息 | 方向 | 说明 |
| --- | --- | --- |
| `IMAGE_GRAB_EXTRACTED` | content → background | 上报提取结果，触发写库并打开画廊 |
| `IMAGE_GRAB_GET_LATEST` | gallery → background | 读取最近一次提取结果 |
| `IMAGE_GRAB_DOWNLOAD` | gallery → background | 提交批量下载任务 |
| `IMAGE_GRAB_PROGRESS` | background → 页面 | 下载进度与最终结果 |
| `IMAGE_GRAB_LATEST_UPDATED` | background → 页面 | 提取结果已更新，画廊刷新 |
| `IMAGE_GRAB_TRIGGER_EXTRACT` | background → content | 触发一次提取 |
| `IMAGE_GRAB_PING` | background → content | 探活，判断脚本是否已注入 |

---

## 六、常见问题排查

**1. 页面右下角没有出现「获取图片」按钮**

- 确认当前页面是**商品详情页**（URL 里带商品编号，例如 `item.htm?id=...`、`item.jd.com/1000....html`、`goods.html?goods_id=...`）。列表页、搜索页、购物车页都不会显示按钮。
- 如果刚安装插件，请**刷新页面**再试。
- 商家后台新版本可能改了 URL 结构，可在 `content.js` 的 `DETAIL_RULES` 数组里补充正则，或用 `?__imagegrab=1` 临时强制显示。

**2. 点击按钮后提示「未找到符合条件的商品图」**

- 图片是懒加载的：先向下滚动页面，让详情图都加载出来，再点击按钮。
- 该商品的图片确实都小于 100×100（例如全是图标），可调低 `content.js` 里的 `MIN_WIDTH` / `MIN_HEIGHT`。

**3. 提取出的图片很少 / 混进了不相关的图**

- 过滤规则集中在 `content.js` 顶部的常量区（最小尺寸、数量上限、黑名单关键词），可按需调整。
- 淘宝图片地址中的 `_400x400.jpg` 这类尺寸后缀会被自动剥离，优先取原图。

**4. 下载失败**

- 常见原因是 CDN 防盗链：`background.js` 已用 `fetch(..., { credentials: 'omit', referrerPolicy: 'no-referrer' })` 规避，并带一次自动重试与「下载原图」降级。
- 若某个域名的图片始终失败，请把该域名加入 `manifest.json` 的 `host_permissions`，然后到 `chrome://extensions` 重新加载扩展。

**5. 下载的文件还是 jpg / webp，不是 PNG**

- 说明该图转换失败并走了降级逻辑，下载日志里会写明「已下载原图，PNG 转换失败」。
- 也可能是该图本身就是 PNG（此时不会重复编码）。

**6. 画廊页显示「还没有提取到图片」**

- 说明还没有提取记录，或 `chrome.storage.local` 被清理过。回到商品详情页重新点一次「获取图片」即可。

**7. 插件更新后按钮点击没反应**

- 内容脚本与扩展的通信通道会失效，**刷新页面**即可恢复（按钮会提示「插件已更新，请刷新页面后重试」）。

---

## 七、官网

`docs/` 目录里是一份纯静态的产品官网（HTML + CSS + 原生 JS，无框架、无 CDN、无外部图片）。双击 `docs/index.html` 即可在浏览器中打开浏览，与扩展的运行互不影响。
