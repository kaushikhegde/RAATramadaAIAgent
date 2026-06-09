#!/usr/bin/env node
/**
 * test-gateway.js — Diagnose OpenClaw Gateway browser tool issues
 * ================================================================
 * Run: node test-gateway.js
 *
 * Tests:
 *  1. Gateway health check
 *  2. List available tools
 *  3. Attempt browser.navigate via /tools/invoke
 *  4. Attempt browser.navigate via WebSocket (if HTTP fails)
 */

require("dotenv").config();

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";

const headers = { "Content-Type": "application/json" };
if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;

async function test(label, fn) {
  process.stdout.write(`\n${"─".repeat(60)}\n${label}\n${"─".repeat(60)}\n`);
  try {
    await fn();
  } catch (err) {
    console.error(`❌ ${err.message}\n`);
  }
}

async function main() {
  console.log(`\nOpenClaw Gateway Diagnostic`);
  console.log(`Gateway URL: ${GATEWAY_URL}`);
  console.log(`Auth Token:  ${TOKEN ? TOKEN.substring(0, 8) + "..." : "(none)"}`);

  // ── Test 1: Health check ──
  await test("1. Health Check (GET /healthz)", async () => {
    const res = await fetch(`${GATEWAY_URL}/healthz`, { headers });
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    console.log(`Response: ${text}`);
    if (res.ok) console.log("✅ Gateway is reachable");
    else console.log("❌ Gateway returned non-200");
  });

  // ── Test 2: List tools ──
  await test("2. List Available Tools (GET /tools)", async () => {
    const res = await fetch(`${GATEWAY_URL}/tools`, { headers });
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    if (res.ok) {
      try {
        const data = JSON.parse(text);
        const tools = data.tools || data;
        if (Array.isArray(tools)) {
          console.log(`Available tools (${tools.length}):`);
          tools.forEach(t => {
            const name = t.name || t.tool || t;
            console.log(`  • ${typeof name === "string" ? name : JSON.stringify(name)}`);
          });
          const hasBrowser = tools.some(t =>
            (t.name || t.tool || t || "").toString().toLowerCase().includes("browser")
          );
          if (hasBrowser) console.log("\n✅ Browser tool IS listed");
          else console.log("\n⚠️  Browser tool NOT listed — it may be denied");
        } else {
          console.log(JSON.stringify(data, null, 2).substring(0, 1000));
        }
      } catch {
        console.log(text.substring(0, 1000));
      }
    } else {
      console.log(`Response: ${text.substring(0, 500)}`);
    }
  });

  // ── Test 3: List tools via POST /tools/list ──
  await test("3. List Tools (POST /tools/list)", async () => {
    const res = await fetch(`${GATEWAY_URL}/tools/list`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    if (res.ok) {
      try {
        const data = JSON.parse(text);
        console.log(`Response keys: ${Object.keys(data).join(", ")}`);
        console.log(JSON.stringify(data, null, 2).substring(0, 1500));
      } catch {
        console.log(text.substring(0, 500));
      }
    } else {
      console.log(`Response: ${text.substring(0, 500)}`);
    }
  });

  // ── Test 4: Invoke browser.navigate via HTTP ──
  await test("4. Browser Navigate via HTTP (POST /tools/invoke)", async () => {
    const body = {
      tool: "browser",
      action: "navigate",
      args: { url: "https://www.google.com" },
    };
    console.log(`Request body: ${JSON.stringify(body)}`);

    const res = await fetch(`${GATEWAY_URL}/tools/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    try {
      const data = JSON.parse(text);
      console.log(`Response: ${JSON.stringify(data, null, 2).substring(0, 1000)}`);
    } catch {
      console.log(`Response: ${text.substring(0, 1000)}`);
    }

    if (res.ok) {
      console.log("\n✅ Browser tool works via HTTP /tools/invoke!");
    } else if (res.status === 403) {
      console.log("\n❌ Browser tool is DENIED (HTTP 403).");
      console.log("   Fix: Update openclaw.json to allow the browser tool.");
      console.log('   Add to gateway section: "tools": { "allow": ["browser"], "deny": [] }');
    } else if (res.status === 500) {
      console.log("\n❌ Browser tool execution FAILED (HTTP 500).");
      console.log("   Possible causes:");
      console.log("   1. Browser tool is on the Gateway hard deny list");
      console.log("   2. Browser binaries missing or crashed inside Docker");
      console.log("   3. Chromium failed to launch (check Docker logs)");
      console.log("\n   Debug steps:");
      console.log("   • Run: docker compose logs openclaw-gateway | tail -50");
      console.log("   • Check if 'browser' appears in /tools list above");
    }
  });

  // ── Test 5: Try alternative invocation formats ──
  await test("5. Alternative: Invoke with 'name' field", async () => {
    const body = {
      name: "browser",
      arguments: { action: "navigate", url: "https://www.google.com" },
    };
    console.log(`Request body: ${JSON.stringify(body)}`);

    const res = await fetch(`${GATEWAY_URL}/tools/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    try {
      const data = JSON.parse(text);
      console.log(`Response: ${JSON.stringify(data, null, 2).substring(0, 1000)}`);
    } catch {
      console.log(`Response: ${text.substring(0, 1000)}`);
    }
    if (res.ok) console.log("\n✅ This format works!");
  });

  // ── Test 6: Try tool as "mcp_browser" or "computer" ──
  await test("6. Alternative tool names", async () => {
    for (const toolName of ["mcp_browser", "computer", "puppeteer", "playwright"]) {
      const body = { tool: toolName, action: "navigate", args: { url: "https://www.google.com" } };
      try {
        const res = await fetch(`${GATEWAY_URL}/tools/invoke`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`  ${toolName}: HTTP ${res.status} — ${text.substring(0, 200)}`);
        if (res.ok) console.log(`  ✅ "${toolName}" works!`);
      } catch (e) {
        console.log(`  ${toolName}: Error — ${e.message}`);
      }
    }
  });

  // ── Test 7: OpenClaw API endpoints discovery ──
  await test("7. API Endpoint Discovery", async () => {
    const endpoints = [
      { method: "GET", path: "/" },
      { method: "GET", path: "/api" },
      { method: "GET", path: "/api/v1" },
      { method: "GET", path: "/sessions" },
      { method: "GET", path: "/tools" },
      { method: "POST", path: "/tools" },
      { method: "GET", path: "/config" },
      { method: "GET", path: "/status" },
    ];
    for (const ep of endpoints) {
      try {
        const res = await fetch(`${GATEWAY_URL}${ep.path}`, {
          method: ep.method,
          headers,
        });
        const text = await res.text();
        console.log(`  ${ep.method} ${ep.path}: ${res.status} — ${text.substring(0, 150).replace(/\n/g, " ")}`);
      } catch (e) {
        console.log(`  ${ep.method} ${ep.path}: Error — ${e.message}`);
      }
    }
  });

  console.log(`\n${"═".repeat(60)}`);
  console.log("Diagnostic complete.");
  console.log(`${"═".repeat(60)}\n`);
}

main().catch(console.error);
