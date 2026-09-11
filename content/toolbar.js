(() => {
  initToolbar();

  async function send(payload) {
    try {
      if (!chrome.runtime?.id) return null;
      return await chrome.runtime.sendMessage(payload);
    } catch (err) {
      const msg = String(err && err.message || err);
      if (/Extension context invalidated|message port closed/i.test(msg)) return null;
      throw err;
    }
  }

  async function initToolbar() {
    const res = await send({ type: "OI_GET_SETTINGS" });
    if (!res) return;
    const { settings } = res;
    const features = settings.features || {};
    if (features.fab === false || settings.showFab === false) return;
    if (document.querySelector(".oi-fab")) return;

    const showPage = features.webpage !== false;
    const showLearn = features.learning !== false;
    const showDocs = features.documents !== false;

    const bar = document.createElement("div");
    bar.className = "oi-fab";
    bar.innerHTML =
      (showPage
        ? '<button type="button" data-act="toggle" title="翻译">翻译</button><button type="button" data-act="restore" title="原文">原文</button>'
        : "") +
      (showLearn ? '<button type="button" data-act="save" title="收藏">收藏</button>' : "") +
      '<button type="button" data-act="more" title="更多">⋯</button><div class="oi-fab-menu" hidden></div>';

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
        await send({ type: "OI_SAVE_SETTINGS", patch: { enabled: on } });
        window.dispatchEvent(new CustomEvent(on ? "oi-please-start" : "oi-please-restore"));
      }
      if (act === "restore" && showPage) {
        await send({ type: "OI_SAVE_SETTINGS", patch: { enabled: false } });
        window.dispatchEvent(new CustomEvent("oi-please-restore"));
      }
      if (act === "save" && showLearn) send({ type: "OI_SAVE_CURRENT_SELECTION" });
      if (act === "learn" && showLearn) send({ type: "OI_OPEN_PAGE", page: "learning" });
      if (act === "docs" && showDocs) send({ type: "OI_OPEN_PAGE", page: "documents" });
      if (act === "autosite" && showPage) {
        await send({
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
    btn.textContent = on ? "停止" : "翻译";
    btn.title = on ? "停止" : "翻译";
    btn.classList.toggle("on", on);
  }
})();
