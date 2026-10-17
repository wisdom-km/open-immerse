/**
 * One HTTP ask. Tests pass fetchImpl. There is no second host.
 * A thrown fetch is an offline (or stopped) result, not a translation retry.
 */

export function askRequestBody(target, messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (target?.provider === "gemini") {
    const system = list.filter((item) => item.role === "system").map((item) => textOf(item)).join("\n\n");
    const contents = list.filter((item) => item.role !== "system").map((item) => ({
      role: item.role === "assistant" ? "model" : "user",
      parts: partsOf(item)
    }));
    const body = { contents, generationConfig: { temperature: 0.2 } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    return body;
  }
  if (target?.provider === "claude") {
    const system = list.filter((item) => item.role === "system").map((item) => textOf(item)).join("\n\n");
    return {
      model: target.model,
      max_tokens: 4096,
      temperature: 0.2,
      system,
      messages: list.filter((item) => item.role !== "system").map((item) => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: textOf(item)
      }))
    };
  }
  return {
    model: target?.model || "",
    temperature: 0.2,
    messages: list.map((item) => ({
      role: item.role,
      content: item.content
    }))
  };
}

export function askHeaders(target, apiKey) {
  const headers = { "Content-Type": "application/json" };
  const key = String(apiKey || "");
  if (target?.provider === "gemini") {
    if (key) headers["x-goog-api-key"] = key;
    return headers;
  }
  if (target?.provider === "claude") {
    if (key) headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
    return headers;
  }
  if (target?.provider === "azure") {
    if (key) headers["api-key"] = key;
    return headers;
  }
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

export function readAskText(target, data) {
  if (!data || typeof data !== "object") return "";
  if (target?.provider === "gemini") {
    const parts = data.candidates?.[0]?.content?.parts || [];
    return parts.map((part) => part?.text || "").join("\n");
  }
  if (target?.provider === "claude") {
    const parts = Array.isArray(data.content) ? data.content : [];
    return parts.map((part) => part?.text || "").join("\n");
  }
  return data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || "";
}

function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n");
  }
  return "";
}

function partsOf(message) {
  if (typeof message?.content === "string") return [{ text: message.content }];
  if (!Array.isArray(message?.content)) return [{ text: "" }];
  const parts = [];
  for (const part of message.content) {
    if (part?.type === "text") parts.push({ text: String(part.text || "") });
    else if (part?.type === "image_url" && part.image_url?.url) {
      const url = String(part.image_url.url);
      const comma = url.indexOf(",");
      const data = url.startsWith("data:") && comma >= 0 ? url.slice(comma + 1) : url;
      parts.push({ inline_data: { mime_type: "image/png", data } });
    }
  }
  return parts.length ? parts : [{ text: "" }];
}

function visionRejected(status, data) {
  const code = Number(status) || 0;
  const blob = JSON.stringify(data || {}).toLowerCase();
  if (code !== 400 && code !== 415) return false;
  return /image|vision|multimodal|unsupported/.test(blob);
}

/**
 * Interrupt points: the fetch await, and the timeout abort.
 * Both paths return one result for this url. They do not call another host.
 */
export async function performAsk({ target, messages, apiKey, signal, fetchImpl, timeoutMs = 60000 } = {}) {
  if (!target?.url) {
    return { ok: false, status: 0, offline: false, timeout: false, error: "missing url", via: target?.via || "" };
  }
  const fetchFn = fetchImpl;
  if (typeof fetchFn !== "function") {
    return { ok: false, status: 0, offline: true, error: "no fetch", via: target.via };
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const onAbort = () => { try { controller?.abort(); } catch { /* ignore */ } };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.("abort", onAbort, { once: true });
  let timer = 0;
  if (controller && timeoutMs > 0) {
    timer = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, timeoutMs);
  }
  try {
    const res = await fetchFn(target.url, {
      method: "POST",
      headers: askHeaders(target, apiKey),
      body: JSON.stringify(askRequestBody(target, messages)),
      signal: controller?.signal
    });
    const status = Number(res?.status) || 0;
    let data = null;
    try { data = await res?.json?.(); } catch { data = null; }
    if (signal?.aborted) return { ok: false, stopped: true, status, via: target.via, host: target.host };
    if (!res || res.ok === false) {
      return {
        ok: false,
        status,
        via: target.via,
        host: target.host,
        visionRejected: visionRejected(status, data),
        error: `HTTP ${status}`
      };
    }
    return { ok: true, status, via: target.via, host: target.host, body: readAskText(target, data) };
  } catch (err) {
    if (signal?.aborted) return { ok: false, stopped: true, status: 0, via: target.via, host: target.host };
    const name = String(err?.name || "");
    if (name === "AbortError" || name === "TimeoutError") {
      return { ok: false, timeout: true, status: 0, via: target.via, host: target.host };
    }
    return { ok: false, offline: true, status: 0, via: target.via, host: target.host, error: String(err?.message || err) };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}
