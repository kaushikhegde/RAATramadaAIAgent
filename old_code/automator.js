/**
 * automator.js — Jetstar booking automation (dual-backend)
 * =========================================================
 * Two browser backends:
 *  1. OpenClaw Gateway (primary) — headless Chromium in Docker
 *  2. Real Chrome via raw CDP (fallback) — no Playwright needed,
 *     uses Chrome DevTools Protocol directly over WebSocket
 *
 * The automation logic is shared; only the browser interface differs.
 * All CSS selectors are VERIFIED from live Jetstar DOM testing.
 */

const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const WebSocket = require("ws");
let GeminiAgent;
try { GeminiAgent = require("./geminiAgent").GeminiAgent; } catch { GeminiAgent = null; }

// ── Stealth browser deps (puppeteer-extra + rebrowser-puppeteer-core) ──
// package.json aliases "puppeteer-core" → "rebrowser-puppeteer-core"
// which patches CDP internals to hide Runtime.Enable from Akamai/Cloudflare.
// puppeteer-extra wraps it and adds stealth plugin evasions on top.
let puppeteerExtra, StealthPlugin;
try {
  const { addExtra } = require("puppeteer-extra");
  const rebrowserPuppeteer = require("puppeteer-core"); // actually rebrowser-puppeteer-core via alias
  StealthPlugin = require("puppeteer-extra-plugin-stealth");
  // Wrap rebrowser-puppeteer-core with puppeteer-extra so stealth plugin works
  puppeteerExtra = addExtra(rebrowserPuppeteer);
  puppeteerExtra.use(StealthPlugin());
  console.log("✅ puppeteer-extra + stealth + rebrowser-puppeteer-core loaded");
} catch (e) {
  console.warn(`⚠️ Stealth browser deps not available: ${e.message}`);
  console.warn("   Falling back to raw CDP (may be blocked by Akamai)");
}

const DEBUG = process.env.DEBUG === "true";
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_MODE = process.env.CDP_MODE || "internal";

function debug(msg) {
  if (DEBUG) console.log(`  [automator] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═════════════════════════════════════════════════════════════════
//  Backend 1: OpenClaw Gateway Browser Client
// ═════════════════════════════════════════════════════════════════

class GatewayBrowser {
  constructor(gatewayUrl, token) {
    this.gatewayUrl = gatewayUrl;
    this.token = token;
    this.name = "Gateway";
  }

  async invoke(action, args = {}) {
    const headers = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    const body = { tool: "browser", action, args };
    debug(`Gateway → ${action} ${JSON.stringify(args).substring(0, 200)}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const res = await fetch(`${this.gatewayUrl}/tools/invoke`, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
      });
      clearTimeout(timeout);
      const rawText = await res.text();
      let data;
      try { data = JSON.parse(rawText); } catch { data = { rawResponse: rawText }; }
      if (!res.ok) {
        const errDetail = JSON.stringify(data, null, 2);
        throw new Error(`Gateway HTTP ${res.status} (${action}): ${errDetail.substring(0, 500)}`);
      }
      debug(`Gateway ← ${action}: ${JSON.stringify(data).substring(0, 200)}`);
      if (data.result && data.result.details !== undefined) return data.result.details;
      if (data.result?.content?.[0]) {
        try { return JSON.parse(data.result.content[0].text); } catch { return data.result.content[0].text; }
      }
      return data;
    } catch (e) {
      clearTimeout(timeout);
      if (e.name === "AbortError") throw new Error(`Gateway timeout (${action}): >60s`);
      throw e;
    }
  }

  async navigate(url) { return this.invoke("navigate", { url, targetUrl: url }); }
  async click(selector) { return this.invoke("click", { selector }); }
  async fill(selector, value) { return this.invoke("fill", { selector, value }); }
  async type(text) { return this.invoke("type", { text }); }
  async press(key) { return this.invoke("press", { key }); }
  async screenshot() { return this.invoke("screenshot", {}); }
  async evaluate(script) { return this.invoke("evaluate", { script }); }
  async wait(ms) { return sleep(ms); }
  async close() { /* Gateway manages its own browser */ }

  async getCurrentUrl() {
    const r = await this.evaluate("window.location.href");
    return typeof r === "string" ? r : (r?.result || r?.value || "");
  }

  async waitForUrl(pattern, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const url = await this.getCurrentUrl();
      if (url.includes(pattern)) { debug(`URL matched "${pattern}"`); return url; }
      await sleep(2000);
    }
    throw new Error(`Timeout waiting for URL pattern "${pattern}"`);
  }

  async waitForSelector(selector, timeoutMs = 15000) {
    const esc = selector.replace(/'/g, "\\'");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const r = await this.evaluate(`!!document.querySelector('${esc}') && document.querySelector('${esc}').offsetParent !== null`);
        if (r === true || r?.result === true || r?.value === true) { debug(`Found: ${selector}`); return true; }
      } catch {}
      await sleep(1500);
    }
    debug(`Timeout: ${selector}`);
    return false;
  }

  async smartClick(selectors, description, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      for (const sel of selectors) {
        try {
          const esc = sel.replace(/'/g, "\\'");
          const exists = await this.evaluate(`(function(){var el=document.querySelector('${esc}');if(el&&el.offsetParent!==null){el.scrollIntoView({block:'center'});return true;}return false;})()`);
          if (exists === true || exists?.result === true || exists?.value === true) {
            await this.click(sel);
            debug(`smartClick: ${description} (${sel})`);
            return true;
          }
        } catch {}
      }
      if (attempt < maxAttempts) await sleep(2000);
    }
    debug(`smartClick FAILED: ${description}`);
    return false;
  }

  async clickButtonByText(text, maxAttempts = 3) {
    const esc = text.toLowerCase().replace(/'/g, "\\'");
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const r = await this.evaluate(`(function(){var btns=[...document.querySelectorAll('button,a,[role="button"]')];var btn=btns.find(function(b){return b.textContent.trim().toLowerCase().includes('${esc}')&&b.offsetParent!==null;});if(btn){btn.scrollIntoView({block:'center'});btn.click();return true;}return false;})()`);
        if (r === true || r?.result === true || r?.value === true) { debug(`Clicked "${text}"`); return true; }
      } catch {}
      if (attempt < maxAttempts) await sleep(2000);
    }
    debug(`Button not found: "${text}"`);
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════
//  Backend 2: Stealth Browser via puppeteer-extra + stealth plugin
//  Uses rebrowser-patches to hide CDP Runtime.Enable from Akamai
//  Falls back to raw CDP if puppeteer-extra is not available
// ═════════════════════════════════════════════════════════════════

class StealthBrowser {
  constructor(port = 9222, host = "127.0.0.1") {
    this.port = port;
    this.host = host;
    this.name = "CDP";
    this.browser = null; // puppeteer Browser instance
    this.page = null;    // puppeteer Page instance
  }

  // ─── Connect or launch browser with stealth ─────────────────
  async connect() {
    if (!puppeteerExtra) {
      throw new Error("puppeteer-extra not available — cannot create stealth browser");
    }

    // Prefer real Google Chrome, fall back to Chromium
    const chromePath = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";
    const cdpMode = process.env.CDP_MODE || "internal";

    if (cdpMode === "internal") {
      // INTERNAL MODE: Launch real Chrome inside Docker with stealth
      debug(`Stealth: Launching internal Chrome via puppeteer-extra (${chromePath})...`);

      // Auto-detect Chrome version for a matching user-agent
      let chromeVersion = "131.0.0.0";
      try {
        const { execSync } = require("child_process");
        const verOutput = execSync(`${chromePath} --version 2>/dev/null`).toString().trim();
        const match = verOutput.match(/(\d+\.\d+\.\d+\.\d+)/);
        if (match) chromeVersion = match[1];
        debug(`Detected Chrome version: ${chromeVersion}`);
      } catch (e) { debug(`Could not detect Chrome version: ${e.message}`); }

      // Real Chrome user-agent (Windows-style for maximum compatibility with Akamai)
      const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
      debug(`User-Agent: ${userAgent}`);

      this.browser = await puppeteerExtra.launch({
        executablePath: chromePath,
        headless: false, // Need headed mode for noVNC viewing + better fingerprint
        args: [
          // Required for Docker
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          // Window size
          "--window-size=1280,900",
          "--start-maximized",
          // Suppress first-run UI
          "--no-first-run",
          "--no-default-browser-check",
          // Anti-detection: hide automation signals
          "--disable-blink-features=AutomationControlled",
          // Locale
          "--lang=en-AU",
          // Display + remote debugging for noVNC
          `--display=${process.env.DISPLAY || ":99"}`,
          `--remote-debugging-port=${this.port}`,
          "--remote-debugging-address=0.0.0.0",
          // User agent
          `--user-agent=${userAgent}`,
        ],
        // CRITICAL: remove --enable-automation flag that puppeteer adds by default
        ignoreDefaultArgs: ["--enable-automation"],
        defaultViewport: null,
      });

      // Get a fresh page
      const pages = await this.browser.pages();
      this.page = pages[0] || await this.browser.newPage();
    } else {
      // EXTERNAL MODE: Connect to existing Chrome on host via CDP
      debug(`Stealth: Connecting to host Chrome at ${this.host}:${this.port}...`);

      const cdpUrl = `http://${this.host}:${this.port}`;
      // Get browser WebSocket endpoint
      let versionInfo;
      try {
        const res = await fetch(`${cdpUrl}/json/version`);
        versionInfo = await res.json();
      } catch (e) {
        throw new Error(`Cannot reach Chrome at ${cdpUrl}: ${e.message}`);
      }

      let wsUrl = versionInfo.webSocketDebuggerUrl;
      if (this.host !== "127.0.0.1" && this.host !== "localhost") {
        wsUrl = wsUrl.replace(/ws:\/\/[^:/]+/, `ws://${this.host}`);
      }
      debug(`Stealth: Connecting to WS endpoint: ${wsUrl}`);

      this.browser = await puppeteerExtra.connect({
        browserWSEndpoint: wsUrl,
        defaultViewport: null,
      });

      // Open fresh tab, close old ones
      this.page = await this.browser.newPage();
      const allPages = await this.browser.pages();
      for (const p of allPages) {
        if (p !== this.page) {
          try { await p.close(); } catch {}
        }
      }
    }

    // Apply extra anti-detection on the page
    await this._applyExtraPatches();

    console.log(`✅ Stealth browser connected (puppeteer-extra + rebrowser-patches)`);
    return this;
  }

  // ─── Extra anti-detection patches on top of stealth plugin ──
  async _applyExtraPatches() {
    if (!this.page) return;

    // Inject scripts that run on every new document (before page JS)
    await this.page.evaluateOnNewDocument(() => {
      // Force Australian locale signals
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-AU', 'en-US', 'en'],
        configurable: true,
      });

      // Ensure connection API looks real
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          rtt: 50,
          downlink: 10,
          saveData: false,
        }),
        configurable: true,
      });

      // Notification permission
      if (typeof Notification !== 'undefined') {
        Object.defineProperty(Notification, 'permission', {
          get: () => 'default',
          configurable: true,
        });
      }

      // Override WebGL to report a realistic GPU (headless/Docker often shows SwiftShader)
      const getParameterOrig = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return 'Google Inc. (Intel)'; // UNMASKED_VENDOR_WEBGL
        if (param === 37446) return 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630, OpenGL 4.6)'; // UNMASKED_RENDERER_WEBGL
        return getParameterOrig.call(this, param);
      };
      // Same for WebGL2
      if (typeof WebGL2RenderingContext !== 'undefined') {
        const getParam2Orig = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(param) {
          if (param === 37445) return 'Google Inc. (Intel)';
          if (param === 37446) return 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630, OpenGL 4.6)';
          return getParam2Orig.call(this, param);
        };
      }

      // Make navigator.hardwareConcurrency realistic (Docker may show 1)
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });

      // Device memory (Docker may show 0 or undefined)
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });

      // Platform should match user-agent (we use Windows UA)
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
    });

    // Set realistic headers
    try {
      await this.page.setExtraHTTPHeaders({
        "Accept-Language": "en-AU,en;q=0.9,en-US;q=0.8",
      });
    } catch (e) { debug(`setExtraHTTPHeaders: ${e.message}`); }

    // Emulate timezone
    try {
      const client = await this.page.target().createCDPSession();
      await client.send("Emulation.setTimezoneOverride", { timezoneId: "Australia/Adelaide" });
      await client.send("Emulation.setLocaleOverride", { locale: "en-AU" });
      await client.detach();
    } catch (e) { debug(`Timezone/locale override: ${e.message}`); }

    debug("Stealth: Extra anti-detection patches applied.");
  }

  // ─── Clear all browser data ─────────────────────────────────
  async clearBrowserData() {
    debug("Stealth: Clearing cookies, cache, and storage...");
    try {
      const client = await this.page.target().createCDPSession();
      await client.send("Network.clearBrowserCookies");
      await client.send("Network.clearBrowserCache");
      await client.detach();
    } catch (e) { debug(`clearBrowserData CDP: ${e.message}`); }
    try {
      await this.page.evaluate(() => {
        try { localStorage.clear(); sessionStorage.clear(); } catch {}
      });
    } catch (e) { debug(`clearStorage: ${e.message}`); }
    try {
      await this.page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5000 });
    } catch (e) { debug(`navigate blank: ${e.message}`); }
    debug("Stealth: Browser data cleared.");
  }

  // ─── Browser actions (same interface as old CDPBrowser) ─────

  async navigate(url) {
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) {
      // Some pages trigger navigation events that cause timeout — that's ok
      debug(`navigate: ${e.message}`);
    }
    await sleep(3000);
    return { ok: true, url };
  }

  async evaluate(script) {
    try {
      const result = await this.page.evaluate((code) => {
        return eval(code);
      }, script);
      return result;
    } catch (e) {
      debug(`evaluate error: ${e.message}`);
      return undefined;
    }
  }

  async click(selector) {
    return this.evaluate(
      `(function() {
        var el = document.querySelector('${selector.replace(/'/g, "\\'")}');
        if (el) { el.scrollIntoView({block:'center'}); el.click(); return true; }
        return false;
      })()`
    );
  }

  async fill(selector, value) {
    return this.evaluate(
      `(function() {
        var el = document.querySelector('${selector.replace(/'/g, "\\'")}');
        if (!el) return false;
        el.focus();
        el.value = '${value.replace(/'/g, "\\'")}';
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
        return true;
      })()`
    );
  }

  async type(text) {
    await this.page.keyboard.type(text, { delay: 50 });
    return true;
  }

  async press(key) {
    await this.page.keyboard.press(key);
    return true;
  }

  async screenshot() {
    const buffer = await this.page.screenshot({ type: "png", encoding: "base64" });
    return buffer; // base64 string
  }

  async wait(ms) { return sleep(ms); }

  async close() {
    debug("Stealth: Closing browser connection...");
    if (this.browser) {
      const cdpMode = process.env.CDP_MODE || "internal";
      if (cdpMode === "external") {
        // External mode: just disconnect, don't close the browser
        try { this.browser.disconnect(); } catch {}
      } else {
        // Internal mode: close the browser (will be relaunched next time)
        try { await this.browser.close(); } catch {}
      }
    }
  }

  // ─── High-level methods ────────────────────────────────────────

  async getCurrentUrl() {
    try {
      return this.page.url() || "";
    } catch {
      return "";
    }
  }

  async waitForUrl(pattern, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const url = await this.getCurrentUrl();
      if (url.includes(pattern)) { debug(`URL matched "${pattern}"`); return url; }
      await sleep(2000);
    }
    throw new Error(`Timeout waiting for URL pattern "${pattern}"`);
  }

  async waitForSelector(selector, timeoutMs = 15000) {
    try {
      await this.page.waitForSelector(selector, { visible: true, timeout: timeoutMs });
      debug(`Found: ${selector}`);
      return true;
    } catch {
      debug(`Timeout: ${selector}`);
      return false;
    }
  }

  async smartClick(selectors, description, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      for (const sel of selectors) {
        try {
          const esc = sel.replace(/'/g, "\\'");
          const exists = await this.evaluate(`(function(){var el=document.querySelector('${esc}');if(el&&el.offsetParent!==null){el.scrollIntoView({block:'center'});return true;}return false;})()`);
          if (exists) {
            await this.click(sel);
            debug(`smartClick: ${description} (${sel})`);
            return true;
          }
        } catch {}
      }
      if (attempt < maxAttempts) await sleep(2000);
    }
    debug(`smartClick FAILED: ${description}`);
    return false;
  }

  async clickButtonByText(text, maxAttempts = 3) {
    const esc = text.toLowerCase().replace(/'/g, "\\'");
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const r = await this.evaluate(`(function(){var btns=[...document.querySelectorAll('button,a,[role="button"]')];var btn=btns.find(function(b){return b.textContent.trim().toLowerCase().includes('${esc}')&&b.offsetParent!==null;});if(btn){btn.scrollIntoView({block:'center'});btn.click();return true;}return false;})()`);
        if (r) { debug(`Clicked "${text}"`); return true; }
      } catch {}
      if (attempt < maxAttempts) await sleep(2000);
    }
    debug(`Button not found: "${text}"`);
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════
//  Backend 2b: Raw CDP fallback (when puppeteer-extra unavailable)
// ═════════════════════════════════════════════════════════════════

class CDPBrowser {
  constructor(port = 9222, host = "127.0.0.1") {
    this.port = port;
    this.host = host;
    this.name = "CDP";
    this.ws = null;
    this.msgId = 1;
    this.pending = new Map();
    this.targetId = null;
  }

  async connect() {
    const cdpUrl = `http://${this.host}:${this.port}`;
    debug(`CDP fallback: connecting to ${cdpUrl}`);

    let pages;
    try {
      pages = await this._httpGet(`${cdpUrl}/json`);
    } catch {
      debug("CDP: Chrome not running, launching...");
      await this._launchChrome();
      await sleep(4000);
      pages = await this._httpGet(`${cdpUrl}/json`);
    }

    const existingPages = pages.filter(p => p.type === "page");
    let target;
    try {
      const newTab = await this._httpGet(`${cdpUrl}/json/new?about:blank`);
      target = newTab;
      for (const old of existingPages) {
        try { await this._httpGet(`${cdpUrl}/json/close/${old.id}`); } catch {}
      }
    } catch {
      target = existingPages[0];
      if (!target) throw new Error("CDP: No browser tabs available");
    }

    this.targetId = target.id;
    let wsUrl = target.webSocketDebuggerUrl;
    if (this.host !== "127.0.0.1" && this.host !== "localhost") {
      wsUrl = wsUrl.replace(/ws:\/\/[^:/]+/, `ws://${this.host}`);
    }

    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
      this.ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      });
    });

    await this._send("Page.enable");
    await this._send("Runtime.enable");
    await this._send("DOM.enable");
    await this._send("Network.enable");

    console.log(`✅ Connected via raw CDP (no stealth) on port ${this.port}`);
    return this;
  }

  async clearBrowserData() {
    try {
      await this._send("Network.clearBrowserCookies");
      await this._send("Network.clearBrowserCache");
    } catch {}
    try {
      await this._send("Runtime.evaluate", {
        expression: "try { localStorage.clear(); sessionStorage.clear(); } catch(e) {}",
        returnByValue: true,
      });
    } catch {}
    try {
      await this._send("Page.navigate", { url: "about:blank" });
      await sleep(500);
    } catch {}
  }

  _send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async _httpGet(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CDP HTTP ${res.status}`);
    return res.json();
  }

  async _launchChrome() {
    const platform = os.platform();
    let chromePath;
    if (platform === "darwin") chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    else if (platform === "win32") chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    else chromePath = "google-chrome";

    const args = [
      `--remote-debugging-port=${this.port}`,
      "--user-data-dir=/tmp/chrome-debug",
      "--no-first-run",
      "--no-default-browser-check",
    ].join(" ");

    const child = exec(`"${chromePath}" ${args}`);
    child.unref();
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
  }

  async navigate(url) {
    await this._send("Page.navigate", { url });
    await sleep(3000);
    return { ok: true, url };
  }

  async evaluate(script) {
    const result = await this._send("Runtime.evaluate", {
      expression: script, returnByValue: true, awaitPromise: false,
    });
    return result?.result?.value;
  }

  async click(selector) {
    return this.evaluate(`(function(){var el=document.querySelector('${selector.replace(/'/g, "\\'")}');if(el){el.scrollIntoView({block:'center'});el.click();return true;}return false;})()`);
  }

  async fill(selector, value) {
    return this.evaluate(`(function(){var el=document.querySelector('${selector.replace(/'/g, "\\'")}');if(!el)return false;el.focus();el.value='${value.replace(/'/g, "\\'")}';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  }

  async type(text) {
    for (const char of text) {
      await this._send("Input.dispatchKeyEvent", { type: "keyDown", text: char, key: char });
      await this._send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
    }
    return true;
  }

  async press(key) {
    await this._send("Input.dispatchKeyEvent", { type: "keyDown", key });
    await this._send("Input.dispatchKeyEvent", { type: "keyUp", key });
    return true;
  }

  async screenshot() {
    const result = await this._send("Page.captureScreenshot", { format: "png" });
    return result?.data;
  }

  async wait(ms) { return sleep(ms); }

  async close() {
    debug("CDP: keeping Chrome open");
    if (this.ws) this.ws.close();
  }

  async getCurrentUrl() {
    return (await this.evaluate("window.location.href")) || "";
  }

  async waitForUrl(pattern, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const url = await this.getCurrentUrl();
      if (url.includes(pattern)) { debug(`URL matched "${pattern}"`); return url; }
      await sleep(2000);
    }
    throw new Error(`Timeout waiting for URL pattern "${pattern}"`);
  }

  async waitForSelector(selector, timeoutMs = 15000) {
    const esc = selector.replace(/'/g, "\\'");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const r = await this.evaluate(`!!document.querySelector('${esc}')&&document.querySelector('${esc}').offsetParent!==null`);
        if (r === true) { debug(`Found: ${selector}`); return true; }
      } catch {}
      await sleep(1500);
    }
    debug(`Timeout: ${selector}`);
    return false;
  }

  async smartClick(selectors, description, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      for (const sel of selectors) {
        try {
          const esc = sel.replace(/'/g, "\\'");
          const exists = await this.evaluate(`(function(){var el=document.querySelector('${esc}');if(el&&el.offsetParent!==null){el.scrollIntoView({block:'center'});return true;}return false;})()`);
          if (exists) { await this.click(sel); debug(`smartClick: ${description} (${sel})`); return true; }
        } catch {}
      }
      if (attempt < maxAttempts) await sleep(2000);
    }
    debug(`smartClick FAILED: ${description}`);
    return false;
  }

  async clickButtonByText(text, maxAttempts = 3) {
    const esc = text.toLowerCase().replace(/'/g, "\\'");
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const r = await this.evaluate(`(function(){var btns=[...document.querySelectorAll('button,a,[role="button"]')];var btn=btns.find(function(b){return b.textContent.trim().toLowerCase().includes('${esc}')&&b.offsetParent!==null;});if(btn){btn.scrollIntoView({block:'center'});btn.click();return true;}return false;})()`);
        if (r) { debug(`Clicked "${text}"`); return true; }
      } catch {}
      if (attempt < maxAttempts) await sleep(2000);
    }
    debug(`Button not found: "${text}"`);
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════
//  Helpers
// ═════════════════════════════════════════════════════════════════

// ─── Page Block Detection ────────────────────────────────────
// Detects three types of blocks:
//   1. HARD BLOCK (Akamai) — "landed here by mistake" + reference number → NOT solvable
//   2. SOFT BLOCK (error page) — "can't find the page" → NOT solvable, needs retry
//   3. CAPTCHA — "not a robot", checkbox, etc. → User can solve via noVNC
//
// Returns: "ok" | "hard_block" | "soft_block" | "captcha"
function classifyPage(text) {
  const t = typeof text === "string" ? text.toLowerCase() : "";

  // Hard Akamai block — reference number present, nothing to solve
  if (t.includes("landed here by mistake") || (t.includes("reference number") && t.includes("oops"))) {
    return "hard_block";
  }

  // Soft error page — booking engine returned 404
  if (t.includes("can't find the page") || t.includes("page not found") || t.includes("page you're looking for")) {
    return "soft_block";
  }

  // Solvable CAPTCHA — user can interact via noVNC
  if (t.includes("not a robot") || t.includes("captcha") || t.includes("verify you are human")) {
    return "captcha";
  }

  return "ok";
}

// Checks page and handles each block type appropriately.
// - hard_block / soft_block → throws immediately (not solvable by user)
// - captcha → pauses and waits for user to solve via noVNC
// - ok → returns false (no block)
async function checkAndWaitForCaptcha(browser, notify, stepNum, timeoutMs = 180000) {
  const pageText = await browser.evaluate(
    "document.body ? document.body.innerText.substring(0, 2000) : ''"
  );
  const classification = classifyPage(pageText);

  if (classification === "ok") return false;

  if (classification === "hard_block") {
    console.log(`[automator] ❌ Akamai HARD BLOCK at step ${stepNum} — not solvable`);
    if (notify) {
      notify(stepNum, "❌ Akamai blocked the request (reference number error). This is a server-side block that cannot be solved manually. Will retry with a fresh session...");
    }
    throw new Error("Akamai hard block detected (reference number). The bot detection rejected this browser session.");
  }

  if (classification === "soft_block") {
    console.log(`[automator] ❌ Booking engine error page at step ${stepNum}`);
    if (notify) {
      notify(stepNum, "❌ Booking page returned an error. The session may have been invalidated by bot detection. Retrying...");
    }
    throw new Error("Booking engine returned error page. Session invalidated by bot detection.");
  }

  // classification === "captcha" — user can solve this
  console.log(`[automator] ⚠️ CAPTCHA detected at step ${stepNum} — waiting for user to solve`);
  if (notify) {
    notify(stepNum, "⚠️ CAPTCHA detected! Please solve it in the browser viewer at http://localhost:6080/vnc.html — automation will resume automatically.");
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(5000);

    const newText = await browser.evaluate(
      "document.body ? document.body.innerText.substring(0, 2000) : ''"
    );
    const newClass = classifyPage(newText);

    if (newClass === "ok") {
      console.log(`[automator] ✅ CAPTCHA resolved! Continuing automation...`);
      if (notify) notify(stepNum, "✅ CAPTCHA resolved! Continuing...");
      await sleep(2000);
      return true;
    }

    if (newClass === "hard_block") {
      throw new Error("CAPTCHA resolved but hit Akamai hard block. Session rejected.");
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    if (elapsed % 30 === 0) {
      debug(`Still waiting for CAPTCHA resolution... (${elapsed}s elapsed)`);
    }
  }

  throw new Error(`CAPTCHA not resolved within ${timeoutMs / 1000}s. Solve it at http://localhost:6080/vnc.html`);
}

function detectPage(url) {
  if (url.includes("/booking/select-flights") || url.includes("/booking/flights")) return "flights";
  if (url.includes("/booking/baggage")) return "baggage";
  if (url.includes("/booking/seats")) return "seats";
  if (url.includes("/booking/extras") || url.includes("/booking/customise")) return "extras";
  if (url.includes("/booking/details") || url.includes("/booking/passengers")) return "details";
  if (url.includes("/booking/review") || url.includes("/booking/pay")) return "review";
  if (url.includes("jetstar.com/au/en/home") || url.includes("jetstar.com/au/en/")) return "home";
  return "unknown";
}

function getWeekdayName(d) { return new Date(d + "T12:00:00").toLocaleDateString("en-AU", { weekday: "long" }); }
function getMonthName(d) { return new Date(d + "T12:00:00").toLocaleDateString("en-AU", { month: "long" }); }
function getYear(d) { return new Date(d + "T12:00:00").getFullYear(); }
function getDay(d) { return new Date(d + "T12:00:00").getDate(); }

function buildJetstarUrl(booking) {
  const p = new URLSearchParams();
  p.set("origin", booking.origin);
  p.set("destination", booking.destination);
  p.set("adults", String(booking.adults || 1));
  p.set("children", String(booking.children || 0));
  p.set("infants", String(booking.infants || 0));
  p.set("flight-type", booking.returnDate ? "2" : "1");
  // Pass dates in URL so Jetstar pre-fills the calendar
  if (booking.departureDate) p.set("selected-departure-date", booking.departureDate);
  if (booking.returnDate) p.set("selected-return-date", booking.returnDate);
  return `https://www.jetstar.com/au/en/home?${p.toString()}`;
}

// ─── Gemini recovery wrapper ─────────────────────────────────────
// Wraps a step function — if it throws, asks Gemini to look at the
// page and figure out the next action.
let geminiAgent = null;
function getGeminiAgent() {
  if (!geminiAgent && GeminiAgent) {
    try { geminiAgent = new GeminiAgent(); } catch (e) { debug(`Gemini agent unavailable: ${e.message}`); }
  }
  return geminiAgent;
}

async function withRecovery(browser, stepFn, goal, checkDone = null, maxRetries = 5) {
  // Run the scripted step
  let stepError = null;
  try {
    await stepFn();
  } catch (err) {
    stepError = err;
    debug(`Step threw: ${err.message}`);
  }

  // ALWAYS verify the page actually changed (even if step didn't throw)
  if (checkDone) {
    try {
      if (await checkDone()) {
        debug(`✅ Step verified — page is in expected state`);
        return true; // Page is correct, move on
      }
    } catch {}
  } else if (!stepError) {
    return true; // No checkDone provided and no error — trust the step
  }

  // If we get here: either the step threw, or it "succeeded" but the page
  // didn't actually change. Both cases need Gemini recovery.
  const agent = getGeminiAgent();
  if (!agent) {
    if (stepError) throw stepError;
    throw new Error(`Step completed but page didn't advance, and no Gemini agent available: ${goal}`);
  }

  const reason = stepError
    ? `Step threw error: ${stepError.message}`
    : `Step completed but page didn't change — still on wrong page`;
  console.log(`[automator] ${reason}. Asking Gemini for help: "${goal}"`);

  const recovered = await agent.recover(browser, goal, maxRetries, checkDone);
  if (!recovered) throw new Error(`Step failed and Gemini recovery failed: ${goal}`);
  return true;
}

// ─── Session screenshot folder ──────────────────────────────────
let sessionScreenshotDir = null;

function initScreenshotDir() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const baseDir = path.join(__dirname, "completed");
  sessionScreenshotDir = path.join(baseDir, `session-${timestamp}`);
  fs.mkdirSync(sessionScreenshotDir, { recursive: true });
  console.log(`[automator] Screenshots will be saved to: ${sessionScreenshotDir}`);
  return sessionScreenshotDir;
}

async function saveScreenshot(browser, stepNum, label) {
  if (!sessionScreenshotDir) return null;
  try {
    const ss = await browser.screenshot();
    let base64Data;
    if (typeof ss === "string") base64Data = ss;
    else if (Buffer.isBuffer(ss)) base64Data = ss.toString("base64");
    else if (ss?.data) base64Data = ss.data;
    else return null;

    const safeName = label.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 50);
    const filename = `step${stepNum}_${safeName}.png`;
    const filepath = path.join(sessionScreenshotDir, filename);
    fs.writeFileSync(filepath, Buffer.from(base64Data, "base64"));
    debug(`Screenshot saved: ${filename}`);
    return { filepath, base64Data };
  } catch (e) {
    debug(`Screenshot save failed: ${e.message}`);
    return null;
  }
}

// ─── Gemini step verification ───────────────────────────────────
// After each step, take screenshot + parse DOM, send to Gemini,
// verify we are on the expected page and not stuck.
// BLOCKS PROGRESSION: throws if verification fails and recovery fails.
async function verifyStep(browser, stepNum, expectedDescription, notify, urlCheck = null) {
  // Fast URL-based check first (no Gemini call needed)
  if (urlCheck) {
    try {
      const url = await browser.getCurrentUrl();
      if (urlCheck(url)) {
        debug(`Step ${stepNum} URL check passed: ${url}`);
        await saveScreenshot(browser, stepNum, `verified_${expectedDescription}`);
        console.log(`[automator] ✅ Step ${stepNum} verified via URL`);
        if (notify) notify(stepNum, `✅ Verified via URL`);
        return true;
      }
    } catch {}
    // URL check failed — fall through to Gemini verification
  }

  const agent = getGeminiAgent();
  const ss = await saveScreenshot(browser, stepNum, `verify_${expectedDescription}`);
  if (!ss) {
    debug("Could not take verification screenshot");
    return true; // Can't verify, proceed optimistically
  }

  if (!agent) {
    debug("No Gemini agent for verification — skipping visual check");
    return true;
  }

  try {
    // Extract live DOM for context
    const dom = await agent.extractDOM(browser);
    const domText = agent.formatDOM(dom);

    const verifyPrompt = `I just completed automation step ${stepNum}. The expected state is: "${expectedDescription}"

── LIVE DOM SNAPSHOT ──
${domText}

Look at the screenshot AND the DOM snapshot. Answer with ONLY a JSON object:
- {"verified": true, "summary": "brief description of what you see"} — if the page matches expected state
- {"verified": false, "summary": "what you actually see", "stuck": true, "suggestion": "what action to take"} — if stuck on wrong page

Check for: loading spinners, error messages, popups blocking the page, still on previous step, CAPTCHA, etc.`;

    const imagePart = {
      inlineData: { data: ss.base64Data, mimeType: "image/png" },
    };

    const result = await agent.model.generateContent([verifyPrompt, imagePart]);
    const text = result.response.text().trim();
    debug(`Gemini verify response: ${text}`);

    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    const parsed = JSON.parse((jsonMatch[1] || text).trim());

    if (parsed.verified) {
      console.log(`[automator] ✅ Step ${stepNum} verified: ${parsed.summary}`);
      if (notify) notify(stepNum, `✅ Verified: ${parsed.summary}`);
      return true;
    } else {
      console.warn(`[automator] ⚠️ Step ${stepNum} verification FAILED: ${parsed.summary}`);
      if (notify) notify(stepNum, `⚠️ Stuck? ${parsed.summary} — attempting recovery...`);

      if (parsed.suggestion) {
        debug(`Gemini suggests: ${parsed.suggestion}`);
      }
      const recovered = await agent.recover(browser, expectedDescription, 3, null);
      if (recovered) {
        await saveScreenshot(browser, stepNum, `recovered_${expectedDescription}`);
        if (notify) notify(stepNum, `🔄 Recovered after getting stuck`);
        return true;
      }
      // Recovery failed — BLOCK progression
      throw new Error(`Step ${stepNum} stuck: ${parsed.summary}. Recovery failed.`);
    }
  } catch (e) {
    if (e.message.startsWith("Step ")) throw e; // Re-throw our own error
    debug(`Verification error: ${e.message}`);
    return true; // On Gemini API error, proceed optimistically
  }
}

async function checkGateway() {
  try {
    const headers = {};
    if (OPENCLAW_GATEWAY_TOKEN) headers["Authorization"] = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 5000);
    const res = await fetch(`${OPENCLAW_GATEWAY_URL}/healthz`, { signal: c.signal, headers });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}

async function navigateCalendarToMonth(browser, targetMonth, targetYear) {
  for (let i = 0; i < 12; i++) {
    const r = await browser.evaluate(`(function(){var labels=document.querySelectorAll('span[class*="caption_label"]');for(var l of labels){if(l.textContent.includes('${targetMonth}')&&l.textContent.includes('${targetYear}'))return true;}return false;})()`);
    if (r === true || r?.result === true || r?.value === true) { debug(`Calendar: ${targetMonth} ${targetYear}`); return; }
    await browser.click('button[aria-label="Go to the Next Month"]');
    await browser.wait(500);
  }
}

async function clickContinueAndWait(browser, targetPage, timeoutMs = 20000) {
  const clicked = await browser.smartClick(["button.qa-continue"], `Continue to ${targetPage}`);
  if (!clicked) await browser.clickButtonByText("continue");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const url = await browser.getCurrentUrl();
      if (detectPage(url) === targetPage) { debug(`Reached ${targetPage}`); await browser.wait(2000); return true; }
    } catch {}
    await browser.wait(2000);
  }
  return false;
}

// ═════════════════════════════════════════════════════════════════
//  Browser creation — tries Gateway, falls back to real Chrome CDP
// ═════════════════════════════════════════════════════════════════

async function createBrowser(callbacks = {}) {
  const { onStep } = callbacks;
  const notify = (msg) => { console.log(`[automator] ${msg}`); if (onStep) onStep(0, msg); };

  // Try Gateway first
  const gatewayOk = await checkGateway();
  if (gatewayOk) {
    notify("Trying OpenClaw Gateway...");
    const gw = new GatewayBrowser(OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN);
    try {
      await gw.navigate("https://www.jetstar.com/au/en/home");
      await sleep(3000);
      const url = await gw.getCurrentUrl();
      if (url.includes("jetstar.com")) {
        notify("Gateway browser loaded Jetstar!");
        return gw;
      }
    } catch (e) {
      console.warn(`[automator] Gateway failed on Jetstar: ${e.message}`);
      notify("Gateway blocked by Jetstar CDN — switching to real Chrome...");
    }
  } else {
    notify("OpenClaw Gateway not reachable — using real Chrome...");
  }

  // Connect via CDP — prefer StealthBrowser (puppeteer-extra), fall back to raw CDP
  if (puppeteerExtra) {
    // ── Stealth mode: puppeteer-extra + stealth plugin + rebrowser-patches ──
    if (CDP_MODE === "external") {
      notify(`Connecting to host Chrome at ${CDP_HOST}:${CDP_PORT} (stealth mode)...`);
      const sb = new StealthBrowser(CDP_PORT, CDP_HOST);
      await sb.connect();
      return sb;
    } else {
      notify("Launching stealth Chromium (puppeteer-extra + anti-detection)...");
      const sb = new StealthBrowser(CDP_PORT, "127.0.0.1");
      await sb.connect();
      return sb;
    }
  } else {
    // ── Fallback: raw CDP (no stealth — may be blocked by Akamai) ──
    console.warn("[automator] ⚠️ puppeteer-extra not available — using raw CDP (Akamai may block)");
    if (CDP_MODE === "external") {
      notify(`Connecting to host Chrome at ${CDP_HOST}:${CDP_PORT} (raw CDP)...`);
      const cdp = new CDPBrowser(CDP_PORT, CDP_HOST);
      await cdp.connect();
      return cdp;
    } else {
      notify("Connecting to internal Chromium (raw CDP)...");
      const cdp = new CDPBrowser(CDP_PORT, "127.0.0.1");
      await cdp.connect();
      return cdp;
    }
  }
}

// ═════════════════════════════════════════════════════════════════
//  MAIN AUTOMATION
// ═════════════════════════════════════════════════════════════════

async function runAutomation(booking, callbacks = {}) {
  const { onStep, onError, onComplete } = callbacks;
  const notify = (step, msg) => { console.log(`[automation] Step ${step}: ${msg}`); if (onStep) onStep(step, msg); };
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let browser;
    try {
      return await _runAutomationAttempt(booking, callbacks, notify, attempt);
    } catch (err) {
      const isBlock = err.message.includes("hard block") || err.message.includes("bot detection") || err.message.includes("Session invalidated");
      if (isBlock && attempt < MAX_RETRIES) {
        console.log(`[automator] Attempt ${attempt}/${MAX_RETRIES} blocked. Retrying with fresh browser in 5s...`);
        notify(0, `Attempt ${attempt} blocked by bot detection. Retrying (${attempt + 1}/${MAX_RETRIES})...`);
        await sleep(5000);
        continue;
      }
      // Not a block error, or out of retries
      console.error("[automator] Error:", err);
      if (onError) onError(`Automation error: ${err.message}`);
      throw err;
    }
  }
}

async function _runAutomationAttempt(booking, callbacks, notify, attemptNum) {
  const { onStep, onError, onComplete } = callbacks;
  let browser;

  try {
    // ── Init session screenshot folder ──
    initScreenshotDir();

    // ── Step 0: Get a browser ──
    notify(0, attemptNum > 1 ? `Retry attempt ${attemptNum}: Setting up fresh browser...` : "Setting up browser...");
    browser = await createBrowser(callbacks);
    notify(0, `Using ${browser.name} browser`);

    // Don't clear browser data by default — the persistent CDP profile holds
    // warmed-up Jetstar/Akamai cookies that we *want* to keep across runs.
    // Set CLEAR_BROWSER_DATA=true to opt back in (e.g. to debug a stuck session).
    if (process.env.CLEAR_BROWSER_DATA === "true" && browser.clearBrowserData) {
      notify(0, "Clearing browser data (CLEAR_BROWSER_DATA=true)...");
      await browser.clearBrowserData();
    }

    const url = buildJetstarUrl(booking);
    debug(`URL: ${url}`);

    // Navigate to booking URL (always start fresh from homepage)
    if (browser.name === "Gateway") {
      try { await browser.navigate(url); } catch {
        await browser.evaluate(`window.location.href='${url}'`);
      }
    } else {
      await browser.navigate(url);
    }
    await browser.wait(5000);

    // Check for CAPTCHA/bot block on initial page load
    await checkAndWaitForCaptcha(browser, notify, 0);

    await browser.waitForSelector('button[aria-label="Search"]', 30000);
    await browser.wait(2000);
    try { await browser.clickButtonByText("accept", 1); } catch {}

    // Screenshot: initial page loaded
    await saveScreenshot(browser, 0, "homepage_loaded");

    // ── Step 1: Dates + Search ──
    // Follows the same flow as the proven booking.js:
    //   Open calendar → set trip type → click dates → Confirm (submit) → Search
    notify(1, "Setting dates and searching...");
    await withRecovery(browser, async () => {

      // Open the calendar date picker
      debug("Opening date picker...");
      await browser.evaluate(`(function(){
        var btn = document.querySelector('#popoverButton');
        if (btn) { btn.scrollIntoView({block:'center'}); btn.click(); return true; }
        return false;
      })()`);
      await browser.wait(2000);

      // Set trip type
      if (!booking.returnDate) {
        await browser.evaluate(`(function(){
          var r = document.querySelector('input[name="triptype"][value="Oneway"]');
          if (r) { r.click(); return true; } return false;
        })()`);
        await browser.wait(500);
      } else {
        await browser.evaluate(`(function(){
          var r = document.querySelector('input[name="triptype"][value="Return"]');
          if (r && !r.checked) { r.click(); return true; } return false;
        })()`);
        await browser.wait(500);
      }

      // Select departure date
      const depMonth = getMonthName(booking.departureDate), depYear = getYear(booking.departureDate);
      const depDay = getDay(booking.departureDate), depWeekday = getWeekdayName(booking.departureDate);
      await navigateCalendarToMonth(browser, depMonth, depYear);
      const depLabel = `${depWeekday}, ${depDay} ${depMonth} ${depYear}`;
      debug(`Selecting departure: ${depLabel}`);
      await browser.evaluate(`(function(){
        var btn = document.querySelector('button[aria-label="${depLabel}"]');
        if (btn) { btn.scrollIntoView({block:'center'}); btn.click(); return true; }
        return false;
      })()`);
      await browser.wait(1000);

      // Select return date
      if (booking.returnDate) {
        const retMonth = getMonthName(booking.returnDate), retYear = getYear(booking.returnDate);
        const retDay = getDay(booking.returnDate), retWeekday = getWeekdayName(booking.returnDate);
        await navigateCalendarToMonth(browser, retMonth, retYear);
        const retLabel = `${retWeekday}, ${retDay} ${retMonth} ${retYear}`;
        debug(`Selecting return: ${retLabel}`);
        await browser.evaluate(`(function(){
          var btn = document.querySelector('button[aria-label="${retLabel}"]');
          if (btn) { btn.scrollIntoView({block:'center'}); btn.click(); return true; }
          return false;
        })()`);
        await browser.wait(1000);
      }

      // Click Confirm — the SUBMIT button (from booking.js: button[type="submit"] with "Confirm")
      debug("Clicking calendar Confirm button...");
      const confirmClicked = await browser.evaluate(`(function(){
        var btn = document.querySelector('button[type="submit"]');
        if (btn && btn.textContent.trim().includes('Confirm') && btn.offsetParent !== null) {
          btn.scrollIntoView({block:'center'}); btn.click(); return 'submit';
        }
        var btns = [...document.querySelectorAll('button')];
        var confirm = btns.find(function(b){ return b.textContent.trim() === 'Confirm' && b.offsetParent !== null; });
        if (confirm) { confirm.scrollIntoView({block:'center'}); confirm.click(); return 'text'; }
        return false;
      })()`);
      debug(`Confirm clicked via: ${confirmClicked}`);
      await browser.wait(1500);

      // Click Search
      debug("Clicking Search button...");
      await browser.evaluate(`(function(){
        var btn = document.querySelector('button[aria-label="Search"]');
        if (btn) { btn.scrollIntoView({block:'center'}); btn.click(); return true; }
        return false;
      })()`);

      // Wait for flight results page
      try { await browser.waitForUrl("/booking/select-flights", 30000); } catch {
        // Check for CAPTCHA or alternative URL
        const bodyText = await browser.evaluate("document.body ? document.body.textContent.substring(0, 500) : ''");
        const text = typeof bodyText === "string" ? bodyText : "";
        if (text.includes("not a robot") || text.includes("CAPTCHA") || text.includes("challenge")) {
          notify(1, "CAPTCHA detected — solve it in the browser window...");
          await browser.waitForUrl("/booking/select-flights", 120000);
        } else {
          const curUrl = await browser.getCurrentUrl();
          if (curUrl.includes("booking.jetstar.com")) {
            debug("On booking.jetstar.com — close enough");
          } else {
            throw new Error("Failed to reach flight results page. URL: " + curUrl);
          }
        }
      }

      // ── CRITICAL: Check for CAPTCHA / bot block / error page ──
      // Akamai can let the URL through but block the session, or show a challenge.
      // If detected, pause and ask user to solve it via noVNC.
      await browser.wait(3000);
      await checkAndWaitForCaptcha(browser, notify, 1);
    },
    `Open the date picker calendar, select departure ${booking.departureDate} and return ${booking.returnDate || 'N/A'}, click the Confirm submit button to close calendar, then click the Search button`,
    async () => {
      const url = await browser.getCurrentUrl();
      if (!url.includes("/booking/select-flights") && !url.includes("/booking/flights") && !url.includes("booking.jetstar.com")) return false;
      // URL matches — also check page content isn't blocked/errored
      const content = await browser.evaluate("document.body ? document.body.innerText.substring(0, 2000) : ''");
      const pageClass = classifyPage(content);
      if (pageClass !== "ok") {
        debug(`Step 1 checkDone: URL matches but page is ${pageClass}`);
        return false;
      }
      return true;
    }, 5);
    await browser.wait(4000);
    // Double-check page content is actually flight results, not a block page
    const step1Content = await browser.evaluate("document.body ? document.body.innerText.substring(0, 2000) : ''");
    const step1Class = classifyPage(step1Content);
    if (step1Class !== "ok") {
      throw new Error(`Flight results page is actually a ${step1Class} page. Bot detection active.`);
    }
    notify(1, "Flight results loaded.");
    await verifyStep(browser, 1, "Flight search results page showing available departure flights", notify,
      (url) => url.includes("/booking/select-flights") || url.includes("/booking/flights"));

    // ── Step 2: Departure flight ──
    // Mirrors booking.js step7_selectDepartureFlight — uses evaluate() for reliable React clicks
    notify(2, "Selecting departure flight...");
    await checkAndWaitForCaptcha(browser, notify, 2);
    await withRecovery(browser, async () => {
      // Wait for flight cards to load (booking.js: .flight-card visible 20s timeout)
      await browser.waitForSelector(".flight-card", 20000);
      await browser.wait(2000);

      // Strategy 1: Click first visible .flight-card
      let cardClicked = await browser.evaluate(`(function(){
        var card = document.querySelector('.flight-card');
        if (card && card.offsetParent !== null) {
          card.scrollIntoView({block:'center'});
          card.click();
          return true;
        }
        return false;
      })()`);

      // Strategy 2: Try .flight-card.unselected-flight
      if (cardClicked !== true) {
        cardClicked = await browser.evaluate(`(function(){
          var card = document.querySelector('.flight-card.unselected-flight');
          if (card && card.offsetParent !== null) {
            card.scrollIntoView({block:'center'});
            card.click();
            return true;
          }
          return false;
        })()`);
      }

      if (cardClicked !== true) throw new Error("Could not find any departure flight card to click");
      await browser.wait(2000);

      // After clicking card, fare bundles expand. Click first visible "Select" button (= Starter/cheapest)
      const selectClicked = await browser.evaluate(`(function(){
        var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
        var filtered = btns.filter(function(b){ return b.textContent.trim() === 'Select' && b.offsetParent !== null; });
        if (filtered.length > 0) {
          filtered[0].scrollIntoView({block:'center'});
          filtered[0].click();
          return true;
        }
        return false;
      })()`);
      if (selectClicked !== true) throw new Error("Could not find 'Select' button for departure fare");
      await browser.wait(3000);
    },
    "Click the first/cheapest departure flight card to expand fares, then click the Select button for the Starter fare",
    async () => {
      // Done when a flight is selected or return section appears or URL moved
      const check = await browser.evaluate(`(function(){
        var selected = document.querySelector('.flight-card.selected-flight, .flight-card--selected');
        var returnSection = document.querySelector('[data-testid="return-flights"], .return-flight-list');
        return !!(selected || returnSection);
      })()`);
      if (check === true) return true;
      const url = await browser.getCurrentUrl();
      return url.includes("/booking/baggage") || url.includes("/booking/seats");
    }, 5);
    await saveScreenshot(browser, 2, "departure_flight_selected");
    notify(2, "Departure flight selected.");
    await verifyStep(browser, 2, "Departure flight selected, showing fare options or return flight selection", notify);

    // ── Step 3: Return flight ──
    // Mirrors booking.js step8_selectReturnFlight
    if (booking.returnDate) {
      notify(3, "Selecting return flight...");
      await withRecovery(browser, async () => {
        await browser.wait(3000);

        // Strategy 1: Click first unselected flight card
        let cardClicked = await browser.evaluate(`(function(){
          var cards = Array.prototype.slice.call(document.querySelectorAll('.flight-card'));
          var unselected = cards.find(function(c){ return c.offsetParent && c.classList.contains('unselected-flight'); });
          if (unselected) { unselected.scrollIntoView({block:'center'}); unselected.click(); return true; }
          return false;
        })()`);

        // Strategy 2: Any flight card that isn't already selected
        if (cardClicked !== true) {
          cardClicked = await browser.evaluate(`(function(){
            var cards = Array.prototype.slice.call(document.querySelectorAll('.flight-card'));
            var unselected = cards.find(function(c){ return c.offsetParent && !c.classList.contains('selected-flight'); });
            if (unselected) { unselected.scrollIntoView({block:'center'}); unselected.click(); return true; }
            return false;
          })()`);
        }

        if (cardClicked !== true) throw new Error("Could not find any return flight card to click");
        await browser.wait(2000);

        // Click first visible "Select" button for Starter fare
        const selectClicked = await browser.evaluate(`(function(){
          var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
          var filtered = btns.filter(function(b){ return b.textContent.trim() === 'Select' && b.offsetParent !== null; });
          if (filtered.length > 0) {
            filtered[0].scrollIntoView({block:'center'});
            filtered[0].click();
            return true;
          }
          return false;
        })()`);
        if (selectClicked !== true) throw new Error("Could not find 'Select' button for return fare");
        await browser.wait(3000);
      },
      "Select the return flight — click an unselected flight card in the return section, then click the Select button for Starter fare",
      async () => {
        const url = await browser.getCurrentUrl();
        return url.includes("/booking/baggage") || url.includes("/booking/seats");
      }, 5);
      await saveScreenshot(browser, 3, "return_flight_selected");
      notify(3, "Return flight selected.");
      await verifyStep(browser, 3, "Return flight selected, ready to proceed to baggage page", notify,
        (url) => url.includes("/booking/baggage") || url.includes("/booking/seats"));
    } else {
      notify(3, "One-way — skipping return.");
    }

    // ── Step 4: Baggage ──
    // Mirrors booking.js step9_baggage — uses qa-continue button + baggage card selection
    notify(4, "Handling baggage...");
    await withRecovery(browser, async () => {
      // Navigate to baggage page if not already there
      if (detectPage(await browser.getCurrentUrl()) !== "baggage") {
        debug("Not on baggage page — clicking Continue...");
        // Try button.qa-continue first (proven from booking.js)
        let clicked = await browser.evaluate(`(function(){
          var btn = document.querySelector('button.qa-continue');
          if (btn && btn.offsetParent !== null) { btn.scrollIntoView({block:'center'}); btn.click(); return true; }
          return false;
        })()`);
        if (clicked !== true) {
          // Fallback: any button with "continue" text
          await browser.evaluate(`(function(){
            var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
            var btn = btns.find(function(b){ return b.textContent.trim().toLowerCase().includes('continue') && b.offsetParent !== null; });
            if (btn) { btn.scrollIntoView({block:'center'}); btn.click(); return true; }
            return false;
          })()`);
        }
        // Wait for navigation to baggage page
        try { await browser.waitForUrl("/booking/baggage", 20000); } catch {
          debug("waitForUrl baggage timed out, proceeding...");
        }
      }
      await browser.wait(3000);

      // Click ALL "No checked baggage" cards
      await browser.evaluate(`(function(){
        var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
        buttons.forEach(function(c){
          if (c.querySelector('.baggage-option-card__no-checked-baggage') && c.offsetParent) {
            c.scrollIntoView({block:'center'});
            c.click();
          }
        });
      })()`);
      await browser.wait(1500);

      // Fallback: try by text if stable class didn't match
      await browser.evaluate(`(function(){
        var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
        buttons.forEach(function(c){
          if (c.textContent.includes('No checked baggage') && c.offsetParent) {
            c.scrollIntoView({block:'center'});
            c.click();
          }
        });
      })()`);
      await browser.wait(1500);

      // Click ALL "7kg Starter" carry-on cards
      await browser.evaluate(`(function(){
        var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
        buttons.forEach(function(c){
          if (c.querySelector('.baggage-option-card__bundle-tag') && c.offsetParent) {
            var t = c.textContent;
            if (t.indexOf('7kg') !== -1 && t.indexOf('Starter') !== -1 && t.indexOf('14kg') === -1) {
              c.scrollIntoView({block:'center'});
              c.click();
            }
          }
        });
      })()`);
      await browser.wait(1500);

      // Click Continue to move past baggage
      await browser.evaluate(`(function(){
        var btn = document.querySelector('button.qa-continue');
        if (btn && btn.offsetParent !== null) { btn.scrollIntoView({block:'center'}); btn.click(); return true; }
        var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
        var cont = btns.find(function(b){ return b.textContent.trim().toLowerCase().includes('continue') && b.offsetParent !== null; });
        if (cont) { cont.scrollIntoView({block:'center'}); cont.click(); return true; }
        return false;
      })()`);
      await browser.wait(3000);
    },
    "On the baggage page, select no checked baggage and 7kg Starter carry-on for all flights, then click Continue",
    async () => {
      const url = await browser.getCurrentUrl();
      return url.includes("/booking/seats") || url.includes("/booking/extras") || url.includes("/booking/customise");
    }, 5);
    await saveScreenshot(browser, 4, "baggage_done");
    notify(4, "Baggage configured.");
    await verifyStep(browser, 4, "Baggage page completed, moving to seats selection page", notify,
      (url) => url.includes("/booking/seats") || url.includes("/booking/extras") || url.includes("/booking/customise"));

    // ── Step 5: Seats ──
    // Mirrors booking.js step10_seats — uses evaluate() with retry loop to skip seats
    notify(5, "Handling seats...");
    await withRecovery(browser, async () => {
      // Navigate to seats page if not already there
      if (detectPage(await browser.getCurrentUrl()) !== "seats") {
        debug("Not on seats page — clicking Continue...");
        await browser.evaluate(`(function(){
          var btn = document.querySelector('button.qa-continue');
          if (btn && btn.offsetParent !== null) { btn.scrollIntoView({block:'center'}); btn.click(); return true; }
          var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
          var cont = btns.find(function(b){ return b.textContent.trim().toLowerCase().includes('continue') && b.offsetParent !== null; });
          if (cont) { cont.scrollIntoView({block:'center'}); cont.click(); return true; }
          return false;
        })()`);
        try { await browser.waitForUrl("/booking/seats", 20000); } catch {
          debug("waitForUrl seats timed out, proceeding...");
        }
      }
      await browser.wait(3000);

      // Helper: click skip seats button via evaluate (matches booking.js clickSkipSeats)
      async function clickSkipSeats(label) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          debug(`Attempt ${attempt} to skip seats for ${label}...`);
          // Method 1: "Skip seats for this flight" button
          let clicked = await browser.evaluate(`(function(){
            var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
            var skipBtn = buttons.find(function(b){
              return b.textContent.trim().toLowerCase().indexOf('skip seats for this flight') !== -1 && b.offsetParent !== null;
            });
            if (skipBtn) { skipBtn.scrollIntoView({block:'center'}); skipBtn.click(); return true; }
            return false;
          })()`);
          if (clicked === true) { debug(`Clicked skip seats for ${label}`); return true; }

          // Method 2: Any "skip seats" element (button/a/role=button)
          clicked = await browser.evaluate(`(function(){
            var allEls = Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"]'));
            var skipEl = allEls.find(function(el){
              return el.textContent.trim().toLowerCase().indexOf('skip seats') !== -1 && el.offsetParent !== null;
            });
            if (skipEl) { skipEl.scrollIntoView({block:'center'}); skipEl.click(); return true; }
            return false;
          })()`);
          if (clicked === true) { debug(`Clicked skip seats link for ${label}`); return true; }

          await browser.wait(2000);
        }
        debug(`Could not find skip seats element for ${label}`);
        return false;
      }

      // Skip seats for departure
      await clickSkipSeats("departure");

      // Skip seats for return (if return trip)
      if (booking.returnDate) {
        debug("Waiting for return flight seat map to load...");
        await browser.wait(4000);

        // Wait for skip seats element to appear for return flight (up to 15s)
        const s5 = Date.now();
        while (Date.now() - s5 < 15000) {
          const found = await browser.evaluate(`(function(){
            var allEls = Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"]'));
            return allEls.some(function(b){ return b.textContent.trim().toLowerCase().indexOf('skip seats') !== -1 && b.offsetParent !== null; });
          })()`);
          if (found === true) break;
          await browser.wait(2000);
        }
        await browser.wait(1000);
        await clickSkipSeats("return");
      }
      await browser.wait(2000);
    },
    "On the seats page, click 'Skip seats for this flight' button. If return trip, wait for return flight seat map and skip that too.",
    async () => {
      const url = await browser.getCurrentUrl();
      return url.includes("/booking/extras") || url.includes("/booking/customise") || url.includes("/booking/details");
    }, 5);
    await saveScreenshot(browser, 5, "seats_skipped");
    notify(5, "Seats skipped.");
    await verifyStep(browser, 5, "Seats skipped, moved to extras or customise page", notify,
      (url) => url.includes("/booking/extras") || url.includes("/booking/customise") || url.includes("/booking/details"));

    // ── Step 6: Extras ──
    // Mirrors booking.js step11_extras — qa-continue + membership decline
    notify(6, "Handling extras...");
    await withRecovery(browser, async () => {
      // Navigate to extras page if not already there
      if (detectPage(await browser.getCurrentUrl()) !== "extras") {
        debug("Not on extras page — clicking Continue...");
        await browser.evaluate(`(function(){
          var btn = document.querySelector('button.qa-continue');
          if (btn && btn.offsetParent !== null) { btn.scrollIntoView({block:'center'}); btn.click(); return true; }
          var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
          var cont = btns.find(function(b){ return b.textContent.trim().toLowerCase().includes('continue') && b.offsetParent !== null; });
          if (cont) { cont.scrollIntoView({block:'center'}); cont.click(); return true; }
          return false;
        })()`);
        try { await browser.waitForUrl("/booking/customise", 20000); } catch {
          debug("waitForUrl customise timed out, proceeding...");
        }
      }
      await browser.wait(3000);

      // Decline Club Jetstar membership (matching booking.js step11)
      // Strategy 1: "no, continue without membership"
      await browser.evaluate(`(function(){
        var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
        var btn = btns.find(function(b){
          return b.textContent.trim().toLowerCase().indexOf('no, continue without membership') !== -1 && b.offsetParent !== null;
        });
        if (btn) { btn.scrollIntoView({block:'center'}); btn.click(); return true; }
        return false;
      })()`);
      await browser.wait(2000);

      // Strategy 2: Scroll down + look for "no" and "membership"
      await browser.evaluate(`(function(){
        window.scrollTo(0, document.body.scrollHeight);
        var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
        var btn = btns.find(function(b){
          var t = b.textContent.trim().toLowerCase();
          return t.indexOf('no') !== -1 && t.indexOf('membership') !== -1 && b.offsetParent !== null;
        });
        if (btn) { btn.scrollIntoView({block:'center'}); btn.click(); return true; }
        return false;
      })()`);
      await browser.wait(2000);

      // Strategy 3: "continue without" as fallback
      await browser.evaluate(`(function(){
        var allEls = Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"]'));
        var btn = allEls.find(function(el){
          return el.textContent.trim().toLowerCase().indexOf('continue without') !== -1 && el.offsetParent !== null;
        });
        if (btn) { btn.scrollIntoView({block:'center'}); btn.click(); return true; }
        return false;
      })()`);
      await browser.wait(2000);

      // Click Continue to move past extras (booking.js: qa-continue then text fallback)
      await browser.evaluate(`(function(){
        window.scrollTo(0, document.body.scrollHeight);
        var btn = document.querySelector('button.qa-continue');
        if (btn && btn.offsetParent !== null) { btn.scrollIntoView({block:'center'}); btn.click(); return true; }
        var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
        var cont = btns.find(function(b){ return b.textContent.trim().toLowerCase().includes('continue') && b.offsetParent !== null; });
        if (cont) { cont.scrollIntoView({block:'center'}); cont.click(); return true; }
        return false;
      })()`);
      await browser.wait(3000);
    },
    "On the extras page, dismiss any membership popup by clicking 'No, continue without membership', then click Continue to skip all extras",
    async () => {
      const url = await browser.getCurrentUrl();
      return url.includes("/booking/details") || url.includes("/booking/passengers") || url.includes("/booking/review");
    }, 5);
    await saveScreenshot(browser, 6, "extras_skipped");
    notify(6, "Extras skipped.");
    await verifyStep(browser, 6, "Extras page skipped, moving to passenger details page", notify,
      (url) => url.includes("/booking/details") || url.includes("/booking/passengers") || url.includes("/booking/review"));

    // ── Step 7: Booking details / Review ──
    // Mirrors booking.js step12_continueToBookingDetails
    notify(7, "Navigating to booking details...");
    await withRecovery(browser, async () => {
      const s7 = Date.now();
      let currentPage = "unknown";

      // Poll for up to 20s to see if we land on details/review
      while (Date.now() - s7 < 20000) {
        try {
          const u = await browser.getCurrentUrl();
          currentPage = detectPage(u);
          if (currentPage === "details" || currentPage === "review") return;
        } catch {}
        await browser.wait(2000);
      }

      // Not there yet — scroll down and click Continue
      if (currentPage !== "details" && currentPage !== "review") {
        debug("Not on details/review — clicking Continue...");
        await browser.evaluate(`(function(){
          window.scrollTo(0, document.body.scrollHeight);
          var btn = document.querySelector('button.qa-continue');
          if (btn && btn.offsetParent !== null) { btn.scrollIntoView({block:'center'}); btn.click(); return true; }
          var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
          var cont = btns.find(function(b){ return b.textContent.trim().toLowerCase().includes('continue') && b.offsetParent !== null; });
          if (cont) { cont.scrollIntoView({block:'center'}); cont.click(); return true; }
          return false;
        })()`);
        await browser.wait(5000);
        currentPage = detectPage(await browser.getCurrentUrl());
        if (currentPage !== "details" && currentPage !== "review") {
          throw new Error("Could not reach booking details page");
        }
      }
    },
    "Click Continue or navigate to reach the passenger details / booking details page where passenger names and contact info are entered",
    async () => {
      const url = await browser.getCurrentUrl();
      const pg = detectPage(url);
      return pg === "details" || pg === "review";
    }, 5);
    const finalPage = detectPage(await browser.getCurrentUrl());
    notify(7, `Reached ${finalPage} page. Automation complete.`);
    await saveScreenshot(browser, 7, `final_${finalPage}_page`);
    await verifyStep(browser, 7, "Passenger details or review page where names and contact info are entered", notify,
      (url) => url.includes("/booking/details") || url.includes("/booking/passengers") || url.includes("/booking/review"));

    if (onComplete) {
      const viewMsg = browser.name === "CDP"
        ? "Check your Chrome window to see the booking."
        : "Open OpenClaw Canvas to see the browser.";
      const ssMsg = sessionScreenshotDir ? ` Screenshots saved to: ${path.basename(sessionScreenshotDir)}` : "";
      onComplete(`Automation complete! Reached the ${finalPage} page. Passenger details left for manual entry. ${viewMsg}${ssMsg}`);
    }

  } catch (err) {
    throw err; // Let the retry wrapper in runAutomation handle it
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { runAutomation, checkGateway, GatewayBrowser, CDPBrowser, StealthBrowser };
