(function () {
  function normalize(path) {
    return String(path || "")
      .split("?")[0]
      .split("#")[0]
      .replace(/^\.\//, "")
      .replace(/^\.\.\//, "");
  }

  function currentPageName() {
    const current = location.pathname.split("/").pop() || "index.html";
    return current;
  }

  function initNavbar() {
    const toggle = document.querySelector(".site-nav__toggle");
    const drawer = document.querySelector("[data-nav-drawer]");
    const backdrop = document.querySelector("[data-nav-backdrop]");
    const links = document.querySelectorAll(".site-nav__link");

    if (!toggle || !drawer || !backdrop) return;

    const page = currentPageName();

    links.forEach((link) => {
      const href = normalize(link.getAttribute("href"));
      if (href.split("/").pop() === page) {
        link.classList.add("is-active");
      }
    });

    const setOpen = (open) => {
      drawer.classList.toggle("is-open", open);
      backdrop.classList.toggle("is-open", open);
      document.body.classList.toggle("nav-open", open);
      toggle.setAttribute("aria-expanded", String(open));
    };

    toggle.addEventListener("click", () => {
      setOpen(!drawer.classList.contains("is-open"));
    });

    backdrop.addEventListener("click", () => setOpen(false));

    links.forEach((link) => {
      link.addEventListener("click", () => setOpen(false));
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setOpen(false);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initNavbar);
  } else {
    initNavbar();
  }
})();
