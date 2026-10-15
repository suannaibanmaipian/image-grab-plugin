/**
 * main.js —— 图提取 ImageGrab 官网交互脚本
 *
 * 功能：
 *   1) 导航栏滚动吸顶阴影
 *   2) 移动端汉堡菜单展开 / 收起（含点击链接自动收起、Esc 关闭、点击外部关闭）
 *   3) 锚点平滑滚动（自动补偿吸顶导航的高度）
 *   4) 滚动时高亮当前所在区块的导航项
 *   5) 元素进入视口时的淡入上移动画（IntersectionObserver）
 *
 * 说明：纯原生 JS，无任何框架与外部依赖；所有事件都用 addEventListener 绑定，
 *      不与 HTML 内联事件属性耦合。
 */

(function () {
  'use strict';

  /* ==================== DOM 引用 ==================== */

  const navbar = document.getElementById('navbar');
  const navToggle = document.getElementById('navToggle');
  const navMenu = document.getElementById('navMenu');
  const navLinks = Array.from(document.querySelectorAll('.nav__link'));

  // 需要参与「当前区块高亮」的 section（按文档顺序）
  const sections = Array.from(document.querySelectorAll('main section[id]'));

  // 是否尊重用户的「减少动态效果」偏好
  const prefersReducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ==================== 1. 导航栏吸顶阴影 ==================== */

  /** 滚动超过一定距离后给导航栏加阴影 */
  function updateNavbarShadow() {
    if (!navbar) return;
    navbar.classList.toggle('is-scrolled', window.scrollY > 8);
  }

  /* ==================== 2. 移动端汉堡菜单 ==================== */

  function initMobileMenu() {
    if (!navToggle || !navMenu) return;

    /**
     * 展开 / 收起菜单
     * @param {boolean} open
     */
    function setMenuOpen(open) {
      navMenu.classList.toggle('is-open', open);
      navToggle.classList.toggle('is-active', open);
      // 同步无障碍状态，读屏软件才知道菜单是开还是关
      navToggle.setAttribute('aria-expanded', String(open));
      navToggle.setAttribute('aria-label', open ? '收起导航菜单' : '展开导航菜单');
    }

    /** 当前菜单是否展开 */
    function isMenuOpen() {
      return navMenu.classList.contains('is-open');
    }

    // 点击汉堡按钮切换
    navToggle.addEventListener('click', () => {
      setMenuOpen(!isMenuOpen());
    });

    // 点击任意导航链接后自动收起
    navLinks.forEach((link) => {
      link.addEventListener('click', () => setMenuOpen(false));
    });

    // Esc 关闭
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isMenuOpen()) {
        setMenuOpen(false);
        navToggle.focus();
      }
    });

    // 点击菜单与按钮之外的区域关闭
    document.addEventListener('click', (event) => {
      if (!isMenuOpen()) return;
      if (navMenu.contains(event.target) || navToggle.contains(event.target)) return;
      setMenuOpen(false);
    });

    // 窗口放大到桌面断点后，强制复位（避免宽度变化后残留展开态）
    window.addEventListener('resize', () => {
      if (window.innerWidth >= 768 && isMenuOpen()) setMenuOpen(false);
    });
  }

  /* ==================== 3. 锚点平滑滚动 ==================== */

  function initSmoothScroll() {
    const links = Array.from(document.querySelectorAll('a[href^="#"]'));

    links.forEach((link) => {
      link.addEventListener('click', (event) => {
        const hash = link.getAttribute('href');
        if (!hash || hash === '#') return;

        let target = null;
        try {
          target = document.querySelector(hash);
        } catch (error) {
          target = null;
        }
        if (!target) return;

        event.preventDefault();

        // 补偿吸顶导航的高度，避免标题被导航栏挡住
        const navHeight = navbar ? navbar.offsetHeight : 0;
        const top = target.getBoundingClientRect().top + window.scrollY - navHeight - 8;

        window.scrollTo({
          top: Math.max(top, 0),
          behavior: prefersReducedMotion ? 'auto' : 'smooth'
        });

        // 更新地址栏 hash，但不触发浏览器默认跳转
        if (history.replaceState) {
          history.replaceState(null, '', hash);
        }

        // 让键盘用户与读屏软件跟随焦点
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      });
    });
  }

  /* ==================== 4. 滚动高亮当前区块 ==================== */

  /**
   * 计算当前所在区块 id
   * 逻辑：取「区块顶部已经越过视口参考线」的最后一个区块；
   *      滚动到页面底部时高亮最后一个区块。
   * @returns {string|null}
   */
  function pickActiveSectionId() {
    if (sections.length === 0) return null;

    const navHeight = navbar ? navbar.offsetHeight : 0;
    const referenceY = window.scrollY + navHeight + 24;

    let activeId = null;
    sections.forEach((section) => {
      if (section.offsetTop <= referenceY) activeId = section.id;
    });

    // 触底时锁定最后一个区块
    const atBottom =
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    if (atBottom) activeId = sections[sections.length - 1].id;

    return activeId;
  }

  /**
   * 给对应的导航链接加高亮
   * @param {string|null} id
   */
  function setActiveNavLink(id) {
    navLinks.forEach((link) => {
      const isMatch = !!id && link.getAttribute('href') === `#${id}`;
      link.classList.toggle('is-active', isMatch);
      if (isMatch) {
        link.setAttribute('aria-current', 'true');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  }

  /* ==================== 5. 进入视口淡入动画 ==================== */

  // 参与淡入的元素，以及它们的观察器（供「兜底点亮」逻辑复用）
  let revealItems = [];
  let revealObserver = null;

  /**
   * 兜底：把「已经跑到视口上方、却还没点亮」的元素直接设为可见。
   *
   * 为什么必须有这一步：IntersectionObserver 只在「相交状态发生变化」时回调。
   * 如果页面是带着滚动位置被刷新的（浏览器会恢复上次的滚动位置），或者用锚点
   * 一次性跳过了若干元素，这些元素会永远停在 opacity: 0 —— 用户再也看不到它们，
   * 整页截图和「打印成 PDF」也会出现大片空白。
   */
  function revealAboveViewport() {
    if (revealItems.length === 0) return;

    revealItems = revealItems.filter((item) => {
      if (item.classList.contains('is-visible')) return false;
      if (item.getBoundingClientRect().bottom <= 0) {
        item.classList.add('is-visible');
        if (revealObserver) revealObserver.unobserve(item);
        return false;
      }
      return true;
    });
  }

  function initReveal() {
    const items = Array.from(document.querySelectorAll('.reveal'));
    if (items.length === 0) return;

    // 不支持 IntersectionObserver 或用户偏好减少动效时，直接全部显示
    if (!('IntersectionObserver' in window) || prefersReducedMotion) {
      items.forEach((item) => item.classList.add('is-visible'));
      return;
    }

    revealItems = items;
    revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;

          // 同一组内的元素依次出场，形成轻微的错位节奏
          const parent = entry.target.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((child) =>
              child.classList && child.classList.contains('reveal')
            );
            const order = Math.max(0, siblings.indexOf(entry.target));
            entry.target.style.transitionDelay = `${Math.min(order, 4) * 70}ms`;
          }

          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target); // 只需触发一次
        });
      },
      {
        threshold: 0.12,
        rootMargin: '0px 0px -8% 0px'
      }
    );

    items.forEach((item) => revealObserver.observe(item));

    // 首屏先兜底一次：页面可能是带着滚动位置刷新的，此时首屏上方的元素永远等不到回调
    revealAboveViewport();
  }

  /* ==================== 滚动事件统一节流 ==================== */

  function initScrollHandler() {
    let rafId = 0;

    /** 滚动时统一更新（用 requestAnimationFrame 节流，避免频繁重排） */
    function onScroll() {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        updateNavbarShadow();
        setActiveNavLink(pickActiveSectionId());
        // 快速滚动或锚点跳转可能把某些元素「跳」过去，不会有相交回调，这里补一次兜底
        revealAboveViewport();
      });
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    // 首屏先执行一次，保证初始状态正确
    updateNavbarShadow();
    setActiveNavLink(pickActiveSectionId());
    revealAboveViewport();
  }

  /* ==================== 初始化 ==================== */

  function init() {
    initMobileMenu();
    initSmoothScroll();
    initReveal();
    initScrollHandler();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
