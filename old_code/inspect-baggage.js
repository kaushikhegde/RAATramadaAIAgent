/**
 * inspect-baggage.js — Run while Chrome is on the Jetstar baggage page
 * to dump the exact DOM structure of the baggage option cards.
 *
 * Usage:
 *   1. Have Chrome open on booking.jetstar.com/au/en/booking/baggage (with --remote-debugging-port=9222)
 *   2. Run: node inspect-baggage.js
 */

const { chromium } = require("playwright");

(async () => {
  const CDP_PORT = process.env.CDP_PORT || "9222";
  console.log(`Connecting to Chrome on port ${CDP_PORT}...`);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const contexts = browser.contexts();
  const context = contexts[0];
  const pages = context.pages();

  // Find the baggage page
  let page = pages.find(p => p.url().includes("/booking/baggage"));
  if (!page) {
    console.log("No baggage page found. Available pages:");
    pages.forEach(p => console.log(`  - ${p.url()}`));
    console.log("\nUsing the last page...");
    page = pages[pages.length - 1];
  }

  console.log(`\nInspecting page: ${page.url()}\n`);

  // Dump detailed info about the "No checked baggage" card area
  const result = await page.evaluate(() => {
    const output = {};

    // 1. Find all elements containing "No checked baggage" text
    const allEls = [...document.querySelectorAll("*")];
    const noBagEls = allEls.filter(el =>
      el.textContent.trim().includes("No checked") &&
      el.childElementCount < 5 &&
      el.offsetParent !== null
    );

    output.noBagElements = noBagEls.map(el => ({
      tag: el.tagName,
      id: el.id,
      className: el.className.toString().substring(0, 150),
      role: el.getAttribute("role"),
      ariaLabel: el.getAttribute("aria-label"),
      ariaSelected: el.getAttribute("aria-selected"),
      ariaChecked: el.getAttribute("aria-checked"),
      dataTestId: el.getAttribute("data-testid"),
      tabIndex: el.getAttribute("tabindex"),
      text: el.textContent.trim().substring(0, 60),
      size: `${el.clientWidth}x${el.clientHeight}`,
      outerHTML: el.outerHTML.substring(0, 300),
      // Parent info
      parentTag: el.parentElement?.tagName,
      parentClass: el.parentElement?.className?.toString().substring(0, 100),
      parentRole: el.parentElement?.getAttribute("role"),
      parentAriaLabel: el.parentElement?.getAttribute("aria-label"),
      parentDataTestId: el.parentElement?.getAttribute("data-testid"),
      // Grandparent info
      gpTag: el.parentElement?.parentElement?.tagName,
      gpClass: el.parentElement?.parentElement?.className?.toString().substring(0, 100),
      gpRole: el.parentElement?.parentElement?.getAttribute("role"),
      gpDataTestId: el.parentElement?.parentElement?.getAttribute("data-testid"),
    }));

    // 2. Find the 7kg card that IS selected (for comparison)
    const sevenKgEls = allEls.filter(el =>
      /\b7kg\b/.test(el.textContent.trim()) &&
      el.textContent.trim().includes("Starter") &&
      el.childElementCount < 10 &&
      el.offsetParent !== null &&
      el.clientHeight > 40
    );

    output.sevenKgElements = sevenKgEls.map(el => ({
      tag: el.tagName,
      id: el.id,
      className: el.className.toString().substring(0, 150),
      role: el.getAttribute("role"),
      ariaSelected: el.getAttribute("aria-selected"),
      ariaChecked: el.getAttribute("aria-checked"),
      dataTestId: el.getAttribute("data-testid"),
      tabIndex: el.getAttribute("tabindex"),
      text: el.textContent.trim().substring(0, 60),
      size: `${el.clientWidth}x${el.clientHeight}`,
      outerHTML: el.outerHTML.substring(0, 300),
      parentTag: el.parentElement?.tagName,
      parentClass: el.parentElement?.className?.toString().substring(0, 100),
      parentRole: el.parentElement?.getAttribute("role"),
    }));

    // 3. Look for input[type=radio] or hidden inputs near baggage
    const radios = [...document.querySelectorAll("input[type='radio'], input[type='hidden']")].filter(el => {
      const container = el.closest("[class*='baggage'], [class*='option'], [data-testid*='baggage']");
      return container !== null;
    });
    output.hiddenInputs = radios.map(el => ({
      type: el.type,
      name: el.name,
      value: el.value,
      checked: el.checked,
      id: el.id,
      parentClass: el.parentElement?.className?.toString().substring(0, 100),
    }));

    // 4. Find all elements with "baggage" or "option" in data-testid
    const testIdEls = allEls.filter(el => {
      const tid = el.getAttribute("data-testid") || "";
      return (tid.includes("baggage") || tid.includes("option") || tid.includes("checked")) &&
        el.offsetParent !== null;
    });
    output.dataTestIdElements = testIdEls.map(el => ({
      tag: el.tagName,
      dataTestId: el.getAttribute("data-testid"),
      role: el.getAttribute("role"),
      ariaSelected: el.getAttribute("aria-selected"),
      className: el.className.toString().substring(0, 100),
      text: el.textContent.trim().substring(0, 60),
      size: `${el.clientWidth}x${el.clientHeight}`,
    }));

    // 5. Find all elements with role="radio", role="option", role="listbox", role="radiogroup"
    const roleEls = allEls.filter(el => {
      const role = el.getAttribute("role");
      return role && ["radio", "option", "listbox", "radiogroup", "tab", "tabpanel"].includes(role) &&
        el.offsetParent !== null;
    });
    output.roleElements = roleEls.map(el => ({
      tag: el.tagName,
      role: el.getAttribute("role"),
      ariaSelected: el.getAttribute("aria-selected"),
      ariaChecked: el.getAttribute("aria-checked"),
      className: el.className.toString().substring(0, 100),
      text: el.textContent.trim().substring(0, 80),
      size: `${el.clientWidth}x${el.clientHeight}`,
    }));

    // 6. Full ancestry of the first "No checked baggage" text element
    const noCheckedTextEl = allEls.find(el =>
      el.childElementCount === 0 &&
      el.textContent.trim() === "No checked baggage" &&
      el.offsetParent !== null
    );
    if (noCheckedTextEl) {
      const ancestry = [];
      let current = noCheckedTextEl;
      for (let i = 0; i < 8 && current; i++) {
        ancestry.push({
          tag: current.tagName,
          id: current.id,
          className: current.className?.toString().substring(0, 120),
          role: current.getAttribute("role"),
          ariaSelected: current.getAttribute("aria-selected"),
          dataTestId: current.getAttribute("data-testid"),
          tabIndex: current.getAttribute("tabindex"),
          size: `${current.clientWidth}x${current.clientHeight}`,
          clickHandler: !!current.onclick,
          eventListeners: typeof getEventListeners === "function" ? Object.keys(getEventListeners(current)) : "N/A",
        });
        current = current.parentElement;
      }
      output.noCheckedAncestry = ancestry;
    }

    return output;
  });

  console.log("=== NO CHECKED BAGGAGE ELEMENTS ===");
  console.log(JSON.stringify(result.noBagElements, null, 2));

  console.log("\n=== 7KG SELECTED CARD (for comparison) ===");
  console.log(JSON.stringify(result.sevenKgElements, null, 2));

  console.log("\n=== HIDDEN INPUTS NEAR BAGGAGE ===");
  console.log(JSON.stringify(result.hiddenInputs, null, 2));

  console.log("\n=== DATA-TESTID ELEMENTS ===");
  console.log(JSON.stringify(result.dataTestIdElements, null, 2));

  console.log("\n=== ROLE ELEMENTS (radio, option, listbox) ===");
  console.log(JSON.stringify(result.roleElements, null, 2));

  console.log("\n=== ANCESTRY OF 'No checked baggage' TEXT ===");
  console.log(JSON.stringify(result.noCheckedAncestry, null, 2));

  await browser.close();
  console.log("\nDone!");
})().catch(console.error);
