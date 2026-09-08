initToolbar();

async function initToolbar() {
  const { settings } = await chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" });
  if (settings.showFab === false) return;
  if (document.querySelector(".oi-fab")) return;
  const bar = document.createElement("div");
  bar.className = "oi-fab";
  bar.innerHTML = `
    <button type="button" data-act="toggle" title="开关全文翻译">译</button>
    <button type="button" data-act="restore" title="恢复原文">原</button>
    <button type="button" data-act="save" title="收藏选中">藏</button>
    <button type="button" data-act="sub" title="视频字幕">幕</button>
    <button type="button" data-act="more" title="更多">···</button>
    <div class="oi-fab-menu" hidden>
      <button type="button" data-act="learn">学习中心</button>
      <button type="button" data-act="docs">文档翻译</button>
      <button type="button" data-act="autosite">本站自动翻译</button>
    </div>
  `;
  document.documentElement.appendChild(bar);
  syncToggle(document.documentElement.classList.contains("oi-active"));
  window.addEventListener("oi-running", (ev) => syncToggle(Boolean(ev.detail)));

  bar.addEventListener("click", async (ev) => {
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    const menu = bar.querySelector(".oi-fab-menu");
    if (act === "more") {
      menu.hidden = !menu.hidden;
      return;
    }
    menu.hidden = true;
    if (act === "toggle") {
      const on = !document.documentElement.classList.contains("oi-active");
      chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch: { enabled: on } });
      chrome.runtime.sendMessage({ type: on ? "OI_START" : "OI_STOP" });
      window.postMessage({ type: on ? "OI_START" : "OI_STOP" }, "*");
      document.dispatchEvent(new CustomEvent(on ? "oi-please-start" : "oi-please-stop"));
      chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" }).then(() => {
        chrome.tabs ? null : null;
      });
      await chrome.runtime.sendMessage({ type: on ? "OI_START" : "OI_STOP" }).catch(() => {});
      if (on) await requestStart();
      else await requestStop();
    }
    if (act === "restore") await requestRestore();
    if (act === "save") chrome.runtime.sendMessage({ type: "OI_SAVE_CURRENT_SELECTION" });
    if (act === "sub") window.dispatchEvent(new CustomEvent("oi-toggle-subtitles"));
    if (act === "learn") chrome.runtime.sendMessage({ type: "OI_OPEN_PAGE", page: "learning" });
    if (act === "docs") chrome.runtime.sendMessage({ type: "OI_OPEN_PAGE", page: "documents" });
    if (act === "autosite") {
      const host = location.hostname.replace(/^www\./, "");
      await chrome.runtime.sendMessage({
        type: "OI_TOGGLE_SITE_RULE",
        host,
        rule: { auto: true }
      });
      toastFab("已开启本站自动翻译");
    }
  });
}

function syncToggle(on) {
  const btn = document.querySelector('.oi-fab [data-act="toggle"]');
  if (btn) {
    btn.textContent = on ? "停" : "译";
    btn.classList.toggle("on", on);
  }
}

function requestStart() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch: { enabled: true } }, () => {
      chrome.runtime.sendMessage({ type: "OI_START" }, resolve);
    });
  });
}

function requestStop() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch: { enabled: false } }, () => {
      chrome.runtime.sendMessage({ type: "OI_STOP" }, resolve);
    });
  });
}

function requestRestore() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "OI_RESTORE" }, resolve);
  });
}

function toastFab(text) {
  chrome.runtime.sendMessage({ type: "OI_TOAST", message: text });
}
