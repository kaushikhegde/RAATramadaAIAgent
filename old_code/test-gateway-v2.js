#!/usr/bin/env node
/**
 * test-gateway-v2.js — Test different browser tool invocation formats
 * Run: node test-gateway-v2.js
 */

require("dotenv").config();

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";

const headers = { "Content-Type": "application/json" };
if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;

async function tryInvoke(label, body) {
  process.stdout.write(`\n── ${label} ──\n`);
  process.stdout.write(`   Body: ${JSON.stringify(body)}\n`);
  try {
    const res = await fetch(`${GATEWAY_URL}/tools/invoke`, {
      method: "POST", headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    console.log(`   Status: ${res.status}`);
    console.log(`   Response: ${JSON.stringify(parsed, null, 2).substring(0, 600)}`);
    if (res.ok) console.log(`   ✅ SUCCESS!`);
    return { status: res.status, data: parsed };
  } catch (e) {
    console.log(`   ❌ ${e.message}`);
    return null;
  }
}

async function main() {
  console.log(`OpenClaw Gateway — Payload Format Tests`);
  console.log(`URL: ${GATEWAY_URL}`);
  console.log(`Token: ${TOKEN ? "set" : "none"}`);

  // ── Format 1: Current format ──
  await tryInvoke("Format 1: tool + action + args", {
    tool: "browser",
    action: "navigate",
    args: { url: "https://www.google.com" },
  });

  // ── Format 2: tool + arguments (flat) ──
  await tryInvoke("Format 2: tool + arguments (flat)", {
    tool: "browser",
    arguments: { action: "navigate", url: "https://www.google.com" },
  });

  // ── Format 3: tool + input ──
  await tryInvoke("Format 3: tool + input", {
    tool: "browser",
    input: { action: "navigate", url: "https://www.google.com" },
  });

  // ── Format 4: tool + params ──
  await tryInvoke("Format 4: tool + params", {
    tool: "browser",
    params: { action: "navigate", url: "https://www.google.com" },
  });

  // ── Format 5: Just tool + url directly ──
  await tryInvoke("Format 5: tool + url (flat)", {
    tool: "browser",
    url: "https://www.google.com",
  });

  // ── Format 6: tool with action in args ──
  await tryInvoke("Format 6: action inside args", {
    tool: "browser",
    args: { action: "navigate", url: "https://www.google.com" },
  });

  // ── Format 7: Try a simpler action first (screenshot) ──
  await tryInvoke("Format 7: screenshot (no args)", {
    tool: "browser",
    action: "screenshot",
    args: {},
  });

  // ── Format 8: screenshot with arguments key ──
  await tryInvoke("Format 8: screenshot with arguments key", {
    tool: "browser",
    arguments: { action: "screenshot" },
  });

  // ── Format 9: Maybe the tool name has a prefix ──
  await tryInvoke("Format 9: tool = 'browser_navigate'", {
    tool: "browser_navigate",
    args: { url: "https://www.google.com" },
  });

  await tryInvoke("Format 10: tool = 'browser_navigate' + arguments", {
    tool: "browser_navigate",
    arguments: { url: "https://www.google.com" },
  });

  // ── Test: List/describe the browser tool ──
  console.log(`\n── Describe browser tool ──`);
  try {
    const res = await fetch(`${GATEWAY_URL}/tools/browser`, { headers });
    const text = await res.text();
    console.log(`   GET /tools/browser → ${res.status}`);
    try {
      console.log(`   ${JSON.stringify(JSON.parse(text), null, 2).substring(0, 800)}`);
    } catch {
      console.log(`   ${text.substring(0, 200)}`);
    }
  } catch (e) {
    console.log(`   ❌ ${e.message}`);
  }

  // ── Check /api/tools endpoint ──
  for (const path of ["/api/tools", "/api/v1/tools", "/v1/tools", "/v1/tools/invoke"]) {
    try {
      const res = await fetch(`${GATEWAY_URL}${path}`, { headers });
      if (res.status !== 404) {
        const text = await res.text();
        console.log(`\n   GET ${path} → ${res.status}: ${text.substring(0, 200)}`);
      }
    } catch {}
  }

  console.log(`\n═══ Done ═══\n`);
}

main().catch(console.error);
