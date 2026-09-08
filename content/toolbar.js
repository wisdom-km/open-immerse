(() => {
  initToolbar();

  async function initToolbar() {
    const { settings } = await chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" });
    const features = settings.features || {};
    if (features.fab === false || settings.showFab === false) return;
    if (document.querySelector(".oi-fab")) return;

    const showPage = features.webpage !== false;
    const showLearn = features.learning !== false;
    const showDocs = features.documents !== false;
    const showSub = (isYouTubePage() && features.youtube) || (isXPage() && features.x);

    const bar = document.createElement("div");
    bar.className = "oi-fab";
    bar.innerHTML =
      (showPage
        ? '<button type="button" data-act="toggle" title="toggle">译</button><button type="button" data-act="restore" title="restore">原</button>'
        : "") +
      (showLearn ? '<button type="button" data-act="save" title="save">藏</button>' : "") +
      (showSub ? '<button type="button" data-act="sub" title="subtitles">幕</button>' : "") +
      '<button type="button" data-act="more" title="more">...</button><div class="oi-fab-menu" hidden></div>';

    const menu = bar.querySelector(".oi-fab-menu");
    if (showLearn) addMenuBtn(menu, "learn", "学习中心");
    if (showDocs) addMenuBtn(menu, "docs", "文档翻译");
    if (showPage) addMenuBtn(menu, "autosite", "本站自动翻译");

    document.documentElement.appendChild(bar);
    syncToggle(document.documentElement.classList.contains("oi-active"));
    window.addEventListener("oi-running", (ev) => syncToggle(Boolean(ev.detail)));

    bar.addEventListener("click", async (ev) => {
      const act = ev.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      if (act === "more") {
        menu.hidden = !menu.hidden;
        return;
      }
      menu.hidden = true;
      if (act === "toggle" && showPage) {
        const on = !document.documentElement.classList.contains("oi-active");
        await chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch: { enabled: on } });
        window.dispatchEvent(new CustomEvent(on ? "oi-please-start" : "oi-please-stop"));
      }
      if (act === "restore" && showPage) {
        await chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch: { enabled: false } });
        window.dispatchEvent(new CustomEvent("oi-please-restore"));
      }
      if (act === "save" && showLearn) chrome.runtime.sendMessage({ type: "OI_SAVE_CURRENT_SELECTION" });
      if (act === "sub" && showSub) window.dispatchEvent(new CustomEvent("oi-toggle-subtitles"));
      if (act === "learn" && showLearn) chrome.runtime.sendMessage({ type: "OI_OPEN_PAGE", page: "learning" });
      if (act === "docs" && showDocs) chrome.runtime.sendMessage({ type: "OI_OPEN_PAGE", page: "documents" });
      if (act === "autosite" && showPage) {
        await chrome.runtime.sendMessage({
          type: "OI_TOGGLE_SITE_RULE",
          host: location.hostname.replace(/^www\./, ""),
          rule: { auto: true }
        });
        window.dispatchEvent(new CustomEvent("oi-please-start"));
      }
    });
  }

  function addMenuBtn(menu, act, label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.act = act;
    btn.textContent = label;
    menu.appendChild(btn);
  }

  function syncToggle(on) {
    const btn = document.querySelector('.oi-fab [data-act="toggle"]');
    if (!btn) return;
    btn.textContent = on ? "停" : "译";
    btn.classList.toggle("on", on);
  }

  function isYouTubePage() {
    return /youtube\.com|youtu\.be/.test(location.hostname);
  }

  function isXPage() {
    return /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(location.hostname);
  }
})();
