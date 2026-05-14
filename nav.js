(function () {
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
