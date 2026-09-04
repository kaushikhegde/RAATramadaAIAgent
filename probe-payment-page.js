/**
 * probe-payment-page.js — map the Tramada Issue Creditor Payment page.
 * ====================================================================
 * Run this ONCE against the sandbox to discover the real field IDs, button
 * labels and table structure of the creditor-payment flow, which nothing in
 * this codebase has ever touched. The MINT payment module is then written
 * against facts instead of against selectors inferred from the receipt page.
 *
 *   node probe-payment-page.js 13061
 *   node probe-payment-page.js 13061 --user me@raa.com.au --pass 'secret'
 *
 * Credentials are optional: without them it uses whatever session the CDP
 * Chrome already has, and tells you if it needs a manual login first.
 *
 * READ-ONLY BY CONSTRUCTION
 * -------------------------
 * It navigates, it clicks "Add/Issue Payment" to render the form, and it reads.
 * It never fills a field, never ticks an allocation checkbox and never clicks
 * Issue. Every mutating control is listed in the output rather than operated.
 * A probe that can create a creditor payment is not a probe.
 *
 * Output: docs/tramada-payment-page-map.json  (machine-readable)
 *         docs/tramada-payment-page-map.md    (readable)
 *         docs/tramada-payment-page.png       (screenshot)
 */

const fs = require("fs");
const path = require("path");
const { openBrowser, ensureLoggedIn, TRAMADA_BASE_URL } = require("./tramada-receipt");

const args = process.argv.slice(2);
const bookingNo = args.find((a) => !a.startsWith("--"));
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!bookingNo) {
  console.error("Usage: node probe-payment-page.js <bookingNo> [--user EMAIL] [--pass PASSWORD]");
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, "docs");

/**
 * Everything interesting about the current page: inputs, selects (with their
 * options), buttons, and any table that looks like an allocation grid. Runs in
 * the page so it sees the DOM Tramada actually rendered, including anything
 * added by its own scripts after load.
 */
async function snapshot(page, label) {
  const data = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    };

    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      id: el.id || null,
      name: el.getAttribute("name") || null,
      value: el.type === "password" ? "<redacted>" : (el.value || "").slice(0, 60) || null,
      label: (() => {
        if (el.id) {
          const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lab) return lab.textContent.trim();
        }
        const cell = el.closest("td");
        const prev = cell?.previousElementSibling;
        return prev ? prev.textContent.trim().slice(0, 60) : null;
      })(),
      visible: visible(el),
    });

    const inputs = Array.from(document.querySelectorAll("input, textarea"))
      .filter((el) => el.type !== "hidden")
      .map(describe);

    const selects = Array.from(document.querySelectorAll("select")).map((el) => ({
      ...describe(el),
      options: Array.from(el.options).map((o) => ({ value: o.value, text: o.text.trim() })),
    }));

    const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a.button'))
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        value: el.value || null,
        text: (el.textContent || "").trim().slice(0, 60) || null,
        visible: visible(el),
      }));

    // Any table carrying per-row amount inputs is a candidate allocation grid.
    const tables = Array.from(document.querySelectorAll("table"))
      .map((t) => {
        const headers = Array.from(t.querySelectorAll("th")).map((th) => th.textContent.trim());
        const rowInputs = Array.from(t.querySelectorAll("tbody input, tr input")).map((i) => ({
          id: i.id || null,
          type: i.type,
          name: i.getAttribute("name") || null,
        }));
        const firstRow = Array.from(t.querySelectorAll("tbody tr, tr"))
          .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.trim().slice(0, 40)))
          .find((cells) => cells.length > 2);
        return { headers, rowInputs, sampleRow: firstRow || null };
      })
      .filter((t) => t.headers.length || t.rowInputs.length);

    return {
      url: location.href,
      title: document.title,
      inputs,
      selects,
      buttons,
      tables,
      // The left-nav links are how the receipt module learned the page URLs;
      // the same trick gives us the payments page if the guessed URL is wrong.
      navLinks: Array.from(document.querySelectorAll("a[href]"))
        .map((a) => ({ text: a.textContent.trim().slice(0, 40), href: a.getAttribute("href") }))
        .filter((l) => /booking-/.test(l.href))
        .slice(0, 60),
    };
  });

  return { label, ...data };
}

function toMarkdown(snapshots) {
  const lines = [
    "# Tramada — Issue Creditor Payment page map",
    "",
    `Probed ${new Date().toISOString()} against \`${TRAMADA_BASE_URL}\` using booking **${bookingNo}**.`,
    "",
    "Generated by `probe-payment-page.js`. Read-only — nothing was filled or issued.",
    "",
  ];

  for (const s of snapshots) {
    lines.push(`## ${s.label}`, "", `**URL:** \`${s.url}\`  `, `**Title:** ${s.title}`, "");

    if (s.selects.length) {
      lines.push("### Dropdowns", "", "| id | label | options |", "|---|---|---|");
      for (const sel of s.selects) {
        const opts = sel.options.map((o) => `${o.text} (\`${o.value}\`)`).join("<br>") || "—";
        lines.push(`| \`#${sel.id || "?"}\` | ${sel.label || "—"} | ${opts} |`);
      }
      lines.push("");
    }

    if (s.inputs.length) {
      lines.push("### Fields", "", "| id | label | type | value |", "|---|---|---|---|");
      for (const i of s.inputs.filter((x) => x.visible)) {
        lines.push(`| \`#${i.id || "?"}\` | ${i.label || "—"} | ${i.type || "—"} | ${i.value || "—"} |`);
      }
      lines.push("");
    }

    if (s.buttons.length) {
      lines.push("### Buttons", "", "| id | value / text |", "|---|---|");
      for (const b of s.buttons.filter((x) => x.visible)) {
        lines.push(`| \`#${b.id || "?"}\` | ${b.value || b.text || "—"} |`);
      }
      lines.push("");
    }

    for (const [n, t] of s.tables.entries()) {
      if (!t.rowInputs.length && !t.headers.length) continue;
      lines.push(`### Table ${n + 1}`, "");
      if (t.headers.length) lines.push(`**Columns:** ${t.headers.join(" | ")}`, "");
      if (t.sampleRow) lines.push(`**Sample row:** ${t.sampleRow.join(" | ")}`, "");
      if (t.rowInputs.length) {
        lines.push("**Row inputs:**", "");
        for (const ri of t.rowInputs.slice(0, 12)) {
          lines.push(`- \`#${ri.id || "?"}\` (${ri.type}${ri.name ? `, name=${ri.name}` : ""})`);
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

(async () => {
  const snapshots = [];
  let browser, context, page, launched = false;

  try {
    // Same plumbing runTramadaReceipt uses: connect (or launch), take the
    // existing context so a human's warm session is reused, open a fresh page.
    ({ browser, launched } = await openBrowser((pct, m) => console.log(`[probe] ${pct}% ${m}`)));
    context = browser.contexts()[0] || (await browser.newContext());
    page = await context.newPage();

    await ensureLoggedIn(page, {
      username: flag("user") || process.env.TRAMADA_USER,
      password: flag("pass") || process.env.TRAMADA_PASS,
      onNeedLogin: () =>
        console.log("[probe] Tramada needs a login — sign in in the CDP Chrome window, then re-run."),
    });

    // Step 2 of the guide: Payments under Booking Transaction. The URL follows
    // the same shape as every other booking page, but it is a GUESS until this
    // probe confirms it — which is why navLinks are captured either way.
    const paymentsUrl = `${TRAMADA_BASE_URL}/booking/booking-payments.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`;
    console.log("[probe] opening", paymentsUrl);
    await page.goto(paymentsUrl, { waitUntil: "domcontentloaded" });
    snapshots.push(await snapshot(page, "Booking Payments (list)"));

    // Step 3: the top-right dropdown should read "Creditor Payment", then
    // "Add/Issue Payment". Follow the button, never a direct form URL — the
    // receipt module learned the hard way that deep-linking the form breaks
    // Issue (tramada-receipt.js:372).
    const addBtn = page
      .locator('input[value*="Issue Payment" i], input[value*="Add" i][value*="Payment" i], button:has-text("Issue Payment")')
      .first();

    if (await addBtn.count()) {
      console.log("[probe] clicking Add/Issue Payment");
      await addBtn.click();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(2000);
      snapshots.push(await snapshot(page, "Issue Creditor Payment (form)"));
    } else {
      console.log("[probe] no Add/Issue Payment button found — capturing the list page only.");
      console.log("[probe] check navLinks in the JSON for the real payments URL.");
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, "tramada-payment-page-map.json"), JSON.stringify(snapshots, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, "tramada-payment-page-map.md"), toMarkdown(snapshots));
    await page.screenshot({ path: path.join(OUT_DIR, "tramada-payment-page.png"), fullPage: true }).catch(() => {});

    console.log("\n[probe] wrote:");
    console.log("  docs/tramada-payment-page-map.md   ← read this");
    console.log("  docs/tramada-payment-page-map.json");
    console.log("  docs/tramada-payment-page.png");
  } catch (err) {
    console.error("[probe] failed:", err.message);
    process.exitCode = 1;
  } finally {
    // Close our own page, but leave a CDP-attached Chrome alone — it is the
    // human's browser and their warm Tramada session lives in it.
    await page?.close().catch(() => {});
    if (browser && launched) await browser.close().catch(() => {});
  }
})();
