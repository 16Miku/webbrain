// WebBrain Companion site: picks the visitor's system for the download button
// and the tray illustration, and fills the illustration's usage meters once.
(() => {
  const desk = document.querySelector(".desk");
  const get = document.getElementById("get");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function detectOS() {
    const ua = navigator.userAgent || "";
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    if (/android|iphone|ipad|ipod/i.test(ua)) return "";
    if (/mac/i.test(platform) || /Mac OS X/.test(ua)) return "mac";
    if (/win/i.test(platform) || /Windows/.test(ua)) return "win";
    if (/linux|x11|cros/i.test(platform + " " + ua)) return "linux";
    return "";
  }

  const buttons = document.querySelectorAll(".seg button");
  function showMenuFor(os) {
    if (!desk) return;
    desk.dataset.os = os;
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.os === os)));
  }
  buttons.forEach((b) => b.addEventListener("click", () => showMenuFor(b.dataset.os)));

  const os = detectOS();
  if (os) {
    showMenuFor(os);
    if (get && get.dataset[os]) {
      get.textContent = get.dataset[os];
      const href = get.dataset[os + "Href"];
      if (href) get.href = href;
    }
    const row = document.querySelector('.dl[data-os="' + os + '"]');
    if (row) row.classList.add("current");
  }

  // The menu opens (CSS), then each meter fills to its value, one after another.
  if (desk && !reduce) {
    const meters = Array.from(desk.querySelectorAll(".meter"));
    const targets = meters.map((m) => m.querySelectorAll("i.on").length);
    meters.forEach((m) => m.querySelectorAll("i").forEach((i) => i.classList.remove("on")));
    const start = performance.now() + 600;
    const step = (now) => {
      let done = true;
      meters.forEach((m, k) => {
        const n = Math.min(targets[k], Math.max(0, Math.floor((now - start - k * 80) / 50)));
        if (n < targets[k]) done = false;
        m.querySelectorAll("i").forEach((i, j) => i.classList.toggle("on", j < n));
      });
      if (!done) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
})();
