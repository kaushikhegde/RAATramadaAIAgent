/**
 * geminiAgent.js — Gemini AI visual + DOM agent for browser automation
 * =====================================================================
 * Hybrid approach: Screenshot (visual) + live DOM parsing (structural).
 * Gemini receives BOTH the screenshot AND a parsed list of all interactive
 * elements (buttons, links, inputs, selectors, aria-labels, text content).
 *
 * This means Gemini doesn't have to guess CSS selectors from pixels —
 * it can see the real selectors and pick the right one.
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEBUG = process.env.DEBUG === "true";

function debug(msg) {
  if (DEBUG) console.log(`  [gemini-agent] ${msg}`);
}

// ─── DOM extraction script ──────────────────────────────────────
// Runs inside the browser via evaluate(). Returns a structured JSON
// snapshot of all interactive/relevant elements on the page.
const DOM_EXTRACT_SCRIPT = `(function() {
  var result = {
    url: location.href,
    title: document.title,
    pageText: document.body ? document.body.innerText.substring(0, 800) : "",
    buttons: [],
    links: [],
    inputs: [],
    selects: [],
    modals: [],
    other: []
  };

  function getSelector(el) {
    if (el.id) return "#" + el.id;
    if (el.getAttribute("aria-label")) return el.tagName.toLowerCase() + '[aria-label="' + el.getAttribute("aria-label").replace(/"/g, '\\\\"') + '"]';
    if (el.getAttribute("data-testid")) return '[data-testid="' + el.getAttribute("data-testid") + '"]';
    if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
    if (el.className && typeof el.className === "string") {
      var classes = el.className.trim().split(/\\s+/).filter(function(c) { return c && !c.includes("--") && c.length < 40; }).slice(0, 3);
      if (classes.length) return el.tagName.toLowerCase() + "." + classes.join(".");
    }
    return null;
  }

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== "BODY" && el.tagName !== "HTML") return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
  }

  // Buttons
  document.querySelectorAll('button, [role="button"]').forEach(function(el) {
    if (!isVisible(el)) return;
    result.buttons.push({
      text: el.textContent.trim().substring(0, 60),
      selector: getSelector(el),
      ariaLabel: el.getAttribute("aria-label") || "",
      disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
      classes: (el.className || "").substring(0, 80)
    });
  });

  // Links
  document.querySelectorAll("a[href]").forEach(function(el) {
    if (!isVisible(el)) return;
    result.links.push({
      text: el.textContent.trim().substring(0, 60),
      href: el.href.substring(0, 120),
      selector: getSelector(el)
    });
  });

  // Inputs
  document.querySelectorAll("input, textarea").forEach(function(el) {
    if (!isVisible(el)) return;
    result.inputs.push({
      type: el.type || "text",
      name: el.name || "",
      value: (el.value || "").substring(0, 60),
      placeholder: (el.placeholder || "").substring(0, 60),
      selector: getSelector(el),
      ariaLabel: el.getAttribute("aria-label") || "",
      checked: el.type === "checkbox" || el.type === "radio" ? el.checked : undefined
    });
  });

  // Select dropdowns
  document.querySelectorAll("select").forEach(function(el) {
    if (!isVisible(el)) return;
    var opts = [...el.options].map(function(o) { return { value: o.value, text: o.text.substring(0, 40), selected: o.selected }; });
    result.selects.push({
      name: el.name || "",
      selector: getSelector(el),
      selectedValue: el.value,
      options: opts.slice(0, 10)
    });
  });

  // Detect modals/overlays
  document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, .overlay, [class*="popup"], [class*="modal"]').forEach(function(el) {
    if (!isVisible(el)) return;
    var closeBtn = el.querySelector('button[aria-label*="close"], button[aria-label*="Close"], .close-button, [class*="close"]');
    result.modals.push({
      text: el.textContent.trim().substring(0, 150),
      closeSelector: closeBtn ? getSelector(closeBtn) : null
    });
  });

  // Calendar-specific: selected dates
  var selectedDates = [...document.querySelectorAll('button[aria-pressed="true"], .rdp-day_selected, [class*="day_selected"], [class*="selected-date"]')]
    .filter(isVisible)
    .map(function(el) { return { text: el.textContent.trim(), ariaLabel: el.getAttribute("aria-label") || "" }; });
  if (selectedDates.length) result.selectedDates = selectedDates;

  // Calendar-specific: confirm button
  var calConfirm = [...document.querySelectorAll('button')].find(function(b) {
    return isVisible(b) && b.textContent.trim().toLowerCase() === "confirm";
  });
  if (calConfirm) result.calendarConfirmButton = getSelector(calConfirm) || "button with text 'Confirm'";

  // Flight cards
  var flights = [...document.querySelectorAll('.flight-card, [class*="flight-card"], [data-testid*="flight"]')]
    .filter(isVisible)
    .slice(0, 5)
    .map(function(el) {
      return {
        text: el.textContent.trim().substring(0, 120),
        selector: getSelector(el),
        isSelected: el.classList.contains("selected-flight") || el.classList.contains("flight-card--selected")
      };
    });
  if (flights.length) result.flightCards = flights;

  // Limit output size
  result.buttons = result.buttons.slice(0, 20);
  result.links = result.links.slice(0, 10);
  result.inputs = result.inputs.slice(0, 10);

  return JSON.stringify(result);
})()`;

// ─── System prompt ──────────────────────────────────────────────
const AGENT_SYSTEM_PROMPT = `You are a browser automation agent helping complete a Jetstar flight booking.

You receive THREE inputs:
1. A SCREENSHOT of the current page (visual context)
2. A PARSED DOM snapshot listing all interactive elements with their REAL CSS selectors
3. A goal describing what needs to happen

YOUR ADVANTAGE: You have the ACTUAL DOM elements with real selectors. Use them directly.
Do NOT guess selectors — use the exact selectors from the DOM snapshot.

Respond with ONLY a JSON object. No markdown, no explanation.

Action types:
- {"action":"click","selector":"CSS selector from DOM"} — click by CSS selector
- {"action":"clickText","text":"exact button text"} — click by visible text
- {"action":"type","selector":"CSS selector","value":"text"} — type into input
- {"action":"evaluate","script":"JS code"} — run JavaScript (most reliable for complex clicks)
- {"action":"scroll","direction":"down"} — scroll page
- {"action":"wait","ms":2000} — pause (use sparingly)
- {"action":"navigate","url":"https://..."} — go to URL
- {"action":"done"} — goal is ALREADY achieved, move on

Decision priority:
1. If a modal/popup is blocking → dismiss it first
2. If the DOM shows the target element exists → use its exact selector
3. If clicking didn't work → use evaluate with element.click()
4. If element might not be in DOM → try clickText as fallback
5. NEVER repeat a failed action — always try a different approach

Jetstar specifics:
- If calendar is open and dates are selected → click the Confirm button
- If Search button is visible → click it
- Flight cards: use selector from flightCards in the DOM
- "Continue" button: look for button.qa-continue or text "Continue"
- Cookie banners: dismiss before proceeding`;

class GeminiAgent {
  constructor() {
    if (!GEMINI_API_KEY || GEMINI_API_KEY === "your-gemini-api-key-here") {
      throw new Error("GEMINI_API_KEY not set — cannot use Gemini recovery agent");
    }
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    this.model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: AGENT_SYSTEM_PROMPT,
    });
  }

  /**
   * Extract the live DOM state from the browser.
   * Returns parsed JSON or null on failure.
   */
  async extractDOM(browser) {
    try {
      const raw = await browser.evaluate(DOM_EXTRACT_SCRIPT);
      if (typeof raw === "string") return JSON.parse(raw);
      if (raw?.result) return JSON.parse(raw.result);
      if (raw?.value) return JSON.parse(raw.value);
      return null;
    } catch (e) {
      debug(`DOM extraction failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Format DOM snapshot into readable text for the prompt.
   */
  formatDOM(dom) {
    if (!dom) return "(DOM extraction failed — use screenshot only)";

    let lines = [];
    lines.push(`Page: ${dom.title}`);
    lines.push(`URL: ${dom.url}`);

    if (dom.modals?.length) {
      lines.push(`\n⚠️ MODALS/POPUPS DETECTED:`);
      dom.modals.forEach((m, i) => {
        lines.push(`  Modal ${i + 1}: "${m.text.substring(0, 80)}..." ${m.closeSelector ? "| Close: " + m.closeSelector : ""}`);
      });
    }

    if (dom.selectedDates?.length) {
      lines.push(`\n📅 SELECTED DATES: ${dom.selectedDates.map(d => d.ariaLabel || d.text).join(", ")}`);
    }
    if (dom.calendarConfirmButton) {
      lines.push(`📅 CALENDAR CONFIRM BUTTON: ${dom.calendarConfirmButton}`);
    }

    if (dom.flightCards?.length) {
      lines.push(`\n✈️ FLIGHT CARDS:`);
      dom.flightCards.forEach((f, i) => {
        lines.push(`  ${i + 1}. ${f.isSelected ? "[SELECTED] " : ""}${f.text.substring(0, 80)} | selector: ${f.selector}`);
      });
    }

    if (dom.buttons?.length) {
      lines.push(`\n🔘 BUTTONS (${dom.buttons.length}):`);
      dom.buttons.forEach((b, i) => {
        const disabled = b.disabled ? " [DISABLED]" : "";
        lines.push(`  ${i + 1}. "${b.text.substring(0, 40)}"${disabled} | selector: ${b.selector} ${b.ariaLabel ? "| aria: " + b.ariaLabel : ""}`);
      });
    }

    if (dom.inputs?.length) {
      lines.push(`\n📝 INPUTS (${dom.inputs.length}):`);
      dom.inputs.forEach((inp, i) => {
        const val = inp.value ? ` value="${inp.value}"` : "";
        const checked = inp.checked !== undefined ? ` checked=${inp.checked}` : "";
        lines.push(`  ${i + 1}. type=${inp.type} name="${inp.name}"${val}${checked} | selector: ${inp.selector}`);
      });
    }

    if (dom.selects?.length) {
      lines.push(`\n📋 SELECTS:`);
      dom.selects.forEach((s, i) => {
        lines.push(`  ${i + 1}. name="${s.name}" selected="${s.selectedValue}" | selector: ${s.selector}`);
      });
    }

    if (dom.links?.length) {
      lines.push(`\n🔗 LINKS (first ${dom.links.length}):`);
      dom.links.slice(0, 5).forEach((l, i) => {
        lines.push(`  ${i + 1}. "${l.text.substring(0, 40)}" → ${l.href.substring(0, 60)}`);
      });
    }

    lines.push(`\n📄 PAGE TEXT (first 400 chars): ${dom.pageText?.substring(0, 400)}`);

    return lines.join("\n");
  }

  /**
   * Ask Gemini what to do — sends screenshot + DOM + history.
   */
  async decideAction(browser, screenshotBase64, goal, actionHistory = []) {
    // Extract live DOM
    const dom = await this.extractDOM(browser);
    const domText = this.formatDOM(dom);
    const pageUrl = dom?.url || "";

    let historyText = "";
    if (actionHistory.length > 0) {
      historyText = "\n\nACTIONS ALREADY TRIED (do NOT repeat these — try something DIFFERENT):\n";
      actionHistory.forEach((entry, i) => {
        historyText += `  ${i + 1}. ${JSON.stringify(entry.action)} → ${entry.result}\n`;
      });
    }

    const prompt = `GOAL: ${goal}

── LIVE DOM SNAPSHOT ──
${domText}
${historyText}
Based on the screenshot AND the DOM snapshot above, what is the ONE best action to take?
Use the EXACT selectors from the DOM — do not guess.
Return ONLY a JSON object.`;

    debug(`Asking Gemini (attempt ${actionHistory.length + 1}): "${goal}"`);

    const parts = [prompt];

    // Add screenshot if available
    if (screenshotBase64) {
      parts.push({
        inlineData: {
          data: typeof screenshotBase64 === "string"
            ? screenshotBase64
            : screenshotBase64.toString("base64"),
          mimeType: "image/png",
        },
      });
    }

    try {
      const result = await this.model.generateContent(parts);
      const text = result.response.text().trim();
      debug(`Gemini response: ${text}`);

      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
      const jsonStr = (jsonMatch[1] || text).trim();
      const action = JSON.parse(jsonStr);
      return action;
    } catch (err) {
      console.error("[gemini-agent] Error:", err.message);
      return { action: "wait", ms: 3000 };
    }
  }

  /**
   * Execute a Gemini-decided action on the browser.
   */
  async executeAction(browser, action) {
    debug(`Executing: ${JSON.stringify(action)}`);

    try {
      switch (action.action) {
        case "click":
          await browser.click(action.selector);
          return "clicked";

        case "clickText": {
          const clicked = await browser.clickButtonByText(action.text);
          return clicked ? "clicked" : "button not found";
        }

        case "type":
          await browser.fill(action.selector, action.value);
          return "typed";

        case "evaluate": {
          const evalResult = await browser.evaluate(action.script);
          const resultStr = String(JSON.stringify(evalResult) ?? "undefined");
          return `evaluated → ${resultStr.substring(0, 100)}`;
        }

        case "scroll":
          await browser.evaluate(
            action.direction === "up"
              ? "window.scrollBy(0, -500)"
              : "window.scrollBy(0, 500)"
          );
          return "scrolled";

        case "wait":
          await browser.wait(action.ms || 3000);
          return "waited";

        case "navigate":
          await browser.navigate(action.url);
          return "navigated";

        case "done":
          debug("Gemini says goal is achieved");
          return "done";

        default:
          debug(`Unknown action: ${action.action}`);
          return "unknown action";
      }
    } catch (e) {
      return `error: ${e.message}`;
    }
  }

  /**
   * Check if two actions are essentially the same (loop detection).
   */
  _isSameAction(a, b) {
    if (a.action !== b.action) return false;
    if (a.action === "click") return a.selector === b.selector;
    if (a.action === "clickText") return a.text === b.text;
    if (a.action === "evaluate") {
      return a.script.replace(/\s+/g, " ").trim() === b.script.replace(/\s+/g, " ").trim();
    }
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * Get a screenshot as base64 from the browser.
   */
  async _getScreenshot(browser) {
    try {
      const ss = await browser.screenshot();
      if (typeof ss === "string") return ss;
      if (Buffer.isBuffer(ss)) return ss.toString("base64");
      if (ss?.data) return ss.data;
      return null;
    } catch (e) {
      debug(`Screenshot failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Full recovery loop: screenshot + DOM → ask Gemini → execute → repeat.
   * Gemini sees the real DOM every iteration, so it always has fresh context.
   */
  async recover(browser, goal, maxAttempts = 5, checkDone = null) {
    console.log(`[gemini-agent] Recovery: "${goal}" (max ${maxAttempts} attempts)`);

    const actionHistory = [];
    let consecutiveDuplicates = 0;

    for (let i = 0; i < maxAttempts; i++) {
      // Check if already done
      if (checkDone) {
        try {
          if (await checkDone()) {
            console.log(`[gemini-agent] ✅ Goal achieved after ${i} attempts`);
            return true;
          }
        } catch {}
      }

      // Take screenshot
      const screenshotBase64 = await this._getScreenshot(browser);
      if (!screenshotBase64) {
        debug("Could not get screenshot, waiting...");
        await browser.wait(3000);
        continue;
      }

      // Ask Gemini (it extracts DOM internally)
      const action = await this.decideAction(browser, screenshotBase64, goal, actionHistory);

      if (action.action === "done") {
        console.log(`[gemini-agent] ✅ Gemini confirms goal achieved`);
        return true;
      }

      // Loop detection
      if (actionHistory.length > 0) {
        const lastAction = actionHistory[actionHistory.length - 1].action;
        if (this._isSameAction(action, lastAction)) {
          consecutiveDuplicates++;
          console.warn(`[gemini-agent] ⚠️ Duplicate action #${consecutiveDuplicates}: ${JSON.stringify(action).substring(0, 100)}`);
          if (consecutiveDuplicates >= 2) {
            // Skip this attempt — force Gemini to see the history of failures
            actionHistory.push({ action, result: "SKIPPED — duplicate action, need different approach" });
            await browser.wait(2000);
            continue;
          }
        } else {
          consecutiveDuplicates = 0;
        }
      }

      // Execute
      const execResult = await this.executeAction(browser, action);
      actionHistory.push({ action, result: execResult });
      console.log(`[gemini-agent] Action ${i + 1}/${maxAttempts}: ${action.action} → ${execResult}`);
      await browser.wait(2500);
    }

    // Final check
    if (checkDone) {
      try {
        if (await checkDone()) {
          console.log(`[gemini-agent] ✅ Goal achieved on final check`);
          return true;
        }
      } catch {}
    }

    console.warn(`[gemini-agent] Recovery failed after ${maxAttempts} attempts. History:`);
    actionHistory.forEach((h, i) => console.warn(`  ${i + 1}. ${JSON.stringify(h.action).substring(0, 120)} → ${h.result}`));
    return false;
  }
}

module.exports = { GeminiAgent };
