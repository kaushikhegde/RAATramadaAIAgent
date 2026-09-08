/**
 * probe-payment-page.js — map the Tramada page a payment flow lands on.
 * =====================================================================
 * Run this ONCE per flow against the sandbox to discover the real field IDs,
 * button labels and table structure, so tramada-payment.js is written against
 * facts instead of against selectors inferred from the receipt page.
 *
 *   node probe-payment-page.js 13061                  # mint (default)
 *   node probe-payment-page.js 13061 --flow dvc
 *   node probe-payment-page.js 13061 --flow ipsi
 *   node probe-payment-page.js 13061 --flow travelpay --user me@raa.com.au --pass 'secret'
 *
 * The four flows do not land on the same page. Mint and TravelPay go to
 * Payments → Issue Creditor Payment; DVC goes to Receipts → Issue Agency
 * Credit Card Transaction; IPSI goes to Receipts → Issue Debtor Payment
 * Receipt. Only the first has ever been inspected, so the DVC and IPSI
 * selectors in tramada-payment.js are educated guesses until this has been run
 * against them — which is exactly what the errors in that module tell you to do.
 *
 * Credentials are optional: without them it uses whatever session the CDP
 * Chrome already has, and tells you if it needs a manual login first.
 *
 * READ-ONLY BY CONSTRUCTION
 * -------------------------
 * It navigates, it clicks the Add/Issue button to render the form, and it
 * reads. It never fills a field, never ticks an allocation checkbox and never
 * clicks Issue. Every mutating control is listed in the output rather than
 * operated. A probe that can create a payment is not a probe.
 *
 * Output (per flow): docs/tramada-<flow>-page-map.json  (machine-readable)
 *                    docs/tramada-<flow>-page-map.md    (readable)
 *                    docs/tramada-<flow>-page.png       (screenshot)
 */

const fs = require("fs");
const path = require("path");
const { openBrowser, ensureLoggedIn, TRAMADA_BASE_URL } = require("./tramada-receipt");
const { getFlow, PAYMENT_FLOWS } = require("./tramada-payment");

const args = process.argv.slice(2);
const bookingNo = args.find((a) => !a.startsWith("--"));
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!bookingNo) {
  console.error(
    "Usage: node probe-payment-page.js <bookingNo> [--flow " +
      Object.keys(PAYMENT_FLOWS).join("|") +
      "] [--user EMAIL] [--pass PASSWORD]"
  );
  process.exit(1);
}

const flow = getFlow(flag("flow") || "mint");
const OUT_DIR = path.join(__dirname, "docs");
const OUT_STEM = `tramada-${flow.id}-page`;

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

    // Step 2 of the guide: Payments or Receipts under Booking Transaction,
    // depending on the flow. The URL follows the same shape as every other
    // booking page, but it is a GUESS until this probe confirms it — which is
    // why navLinks are captured either way.
    const listUrl = `${TRAMADA_BASE_URL}/booking/${flow.urlSlug}.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`;
    console.log(`[probe] flow: ${flow.label} — ${flow.guide}`);
    console.log("[probe] opening", listUrl);
    await page.goto(listUrl, { waitUntil: "domcontentloaded" });
    snapshots.push(await snapshot(page, `Booking ${flow.navText} (list)`));

    // Step 3: set the top-right dropdown to this flow's transaction, then
    // click its Add/Issue button. Follow the button, never a direct form URL —
    // the receipt module learned the hard way that deep-linking the form
    // breaks Issue (tramada-receipt.js:372).
    //
    // The dropdown is SET here, not just read: on a page that defaults to a
    // different transaction the button renders the wrong form, and a map of
    // the wrong form is worse than no map at all.
    const chose = await page.evaluate((pattern) => {
      const re = new RegExp(pattern, "i");
      for (const sel of document.querySelectorAll("select")) {
        const opt = Array.from(sel.options).find((o) => re.test(o.text));
        if (opt) {
          if (sel.value !== opt.value) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return opt.text.trim();
        }
      }
      return null;
    }, flow.listOption);
    console.log(
      chose
        ? `[probe] transaction dropdown set to "${chose}"`
        : `[probe] no option matching /${flow.listOption}/ — the form below may be the wrong one`
    );
    await page.waitForTimeout(800);

    const selector = flow.addButton
      .split("|")
      .flatMap((t) => [`input[value*="${t}" i]`, `button:has-text("${t}")`])
      .join(", ");
    const addBtn = page.locator(selector).first();

    if (await addBtn.count()) {
      console.log("[probe] clicking", flow.addButton.split("|")[0]);
      await addBtn.click();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(2000);
      snapshots.push(await snapshot(page, `${flow.label} form`));
    } else {
      console.log(`[probe] no "${flow.addButton.split("|")[0]}" button found — capturing the list page only.`);
      console.log("[probe] check navLinks in the JSON for the real URL.");
    }

    // DVC reads the Booking Profile page too (step 11's Level 1 Branch), so
    // map it in the same run rather than leaving that lookup unverified.
    if (flow.needsProfile) {
      const profileUrl = `${TRAMADA_BASE_URL}/booking/booking-profile.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`;
      console.log("[probe] opening", profileUrl);
      await page.goto(profileUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(1000);
      snapshots.push(await snapshot(page, "Booking Profile (Level 1 Branch)"));
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, `${OUT_STEM}-map.json`), JSON.stringify(snapshots, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, `${OUT_STEM}-map.md`), toMarkdown(snapshots));
    await page.screenshot({ path: path.join(OUT_DIR, `${OUT_STEM}.png`), fullPage: true }).catch(() => {});

    console.log("\n[probe] wrote:");
    console.log(`  docs/${OUT_STEM}-map.md   ← read this`);
    console.log(`  docs/${OUT_STEM}-map.json`);
    console.log(`  docs/${OUT_STEM}.png`);
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
