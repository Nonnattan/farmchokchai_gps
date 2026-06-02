(function () {
  function getStatusElements() {
    return Array.from(document.querySelectorAll('[data-firebase-status]'));
  }

  function applyStatusToElement(el, connected, message) {
    if (!el) return;

    el.classList.remove('is-connected', 'is-disconnected', 'is-unknown');

    const dot = el.querySelector('.site-nav__status-dot');
    const text = el.querySelector('.site-nav__status-text');

    if (connected === true) {
      el.classList.add('is-connected');
      if (dot) dot.setAttribute('aria-label', 'Firebase เชื่อมต่อแล้ว');
      if (text) text.textContent = message || 'เชื่อมต่อ Firebase ได้ปกติ';
      return;
    }

    if (connected === false) {
      el.classList.add('is-disconnected');
      if (dot) dot.setAttribute('aria-label', 'Firebase เชื่อมต่อไม่ได้');
      if (text) text.textContent = message || 'เชื่อมต่อไม่ได้';
      return;
    }

    el.classList.add('is-unknown');
    if (dot) dot.setAttribute('aria-label', 'กำลังตรวจสอบ Firebase');
    if (text) text.textContent = message || 'กำลังตรวจสอบ Firebase...';
  }

  window.setFirebaseNavStatus = function setFirebaseNavStatus(connected, message) {
    getStatusElements().forEach((el) => applyStatusToElement(el, connected, message));
  };

  function getPageName() {
    const current = location.pathname.split('/').pop() || 'index.html';
    return current;
  }

  function initNavbar() {
    const nav = document.querySelector('.site-nav');
    const toggle = document.querySelector('[data-nav-toggle]');
    const drawer = document.querySelector('[data-nav-drawer]');
    const backdrop = document.querySelector('[data-nav-backdrop]');
    const closeButtons = document.querySelectorAll('[data-nav-close]');
    const links = document.querySelectorAll('.site-nav__link');

    if (!nav || !toggle || !drawer || !backdrop) return;

    window.setFirebaseNavStatus(null, 'กำลังตรวจสอบ Firebase...');

    const page = getPageName();

    links.forEach((link) => {
      const href = link.getAttribute('href');
      if (href === page) link.classList.add('is-active');
    });

    const setOpen = (open) => {
      drawer.classList.toggle('is-open', open);
      backdrop.classList.toggle('is-open', open);
      document.body.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    };

    toggle.addEventListener('click', () => {
      setOpen(!drawer.classList.contains('is-open'));
    });

    backdrop.addEventListener('click', () => setOpen(false));

    closeButtons.forEach((btn) => {
      btn.addEventListener('click', () => setOpen(false));
    });

    links.forEach((link) => {
      link.addEventListener('click', () => setOpen(false));
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNavbar);
  } else {
    initNavbar();
  }
})();
