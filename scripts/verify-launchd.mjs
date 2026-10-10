#!/usr/bin/env node
/**
 * verify-launchd.mjs — post-upgrade launchd verification
 *
 * After an npm global install / package rename, the hermes-web-ui launchd job
 * may be unloaded (bootout succeeded, bootstrap failed) or the plist may still
 * point at the old package path. This script:
 *
 *   1. Finds the hermes-web-ui.plist
 *   2. Checks its ProgramArguments path exists on disk
 *   3. If the path is stale (old package name), rewrites it to the new location
 *   4. Ensures the launchd job is loaded (bootstrap if missing)
 *   5. Verifies the server port is reachable
 *
 * Usage:  node scripts/verify-launchd.mjs [--port 81]
 * Exit:   0 = healthy, 1 = intervention needed / failed
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const PORT = parseInt(process.argv.find((a, i) => process.argv[i - 1] === "--port") || "81", 10);
const PLIST = path.join(homedir(), "Library/LaunchAgents/hermes-web-ui.plist");
const NPM_GLOBAL = path.join(homedir(), ".npm-global/lib/node_modules");
const LABEL = "hermes-web-ui";

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 15000 }).trim();
  } catch (e) {
    return `__ERROR__:${e.message?.split("\n")[0] || e}`;
  }
}

function log(msg) {
  console.log(`[verify-launchd] ${msg}`);
}

function fail(msg) {
  console.error(`[verify-launchd] ❌ ${msg}`);
  process.exit(1);
}

// 1. Plist must exist
if (!existsSync(PLIST)) {
  fail(`plist not found: ${PLIST}`);
}
log(`plist: ${PLIST}`);

// 2. Parse current path from plist (simple XML grep — good enough for this)
const plistContent = readFileSync(PLIST, "utf8");
const pathMatch = plistContent.match(/<string>([^<]+dist\/server\/index\.js)<\/string>/);
if (!pathMatch) {
  fail("could not find server index.js path in plist");
}
const currentPath = pathMatch[1];
log(`plist points to: ${currentPath}`);

// 3. If path doesn't exist, find the correct one and rewrite
if (!existsSync(currentPath)) {
  log(`stale path! searching for new location under ${NPM_GLOBAL}...`);
  // Try known package names: ekko-studio, hermes-web-ui
  const candidates = ["ekko-studio", "hermes-web-ui"];
  let found = null;
  for (const name of candidates) {
    const p = path.join(NPM_GLOBAL, name, "dist/server/index.js");
    if (existsSync(p)) {
      found = p;
      break;
    }
  }
  if (!found) {
    fail(`no valid server path found. Tried: ${candidates.map(c => path.join(NPM_GLOBAL, c, "dist/server/index.js")).join(", ")}`);
  }
  log(`found new path: ${found}`);
  const newContent = plistContent.replace(currentPath, found);
  writeFileSync(PLIST, newContent);
  log(`plist rewritten: ${currentPath} → ${found}`);
  // Need to re-bootstrap after plist change
  sh(`launchctl bootout gui/$(id -u)/${LABEL} 2>/dev/null`);
  sleep(1000);
}

// 4. Ensure job is loaded
const jobList = sh(`launchctl list 2>/dev/null | grep -w '${LABEL}'`);
if (jobList.startsWith("__ERROR__") || !jobList.includes(LABEL)) {
  log(`job not loaded, bootstrapping...`);
  const bs = sh(`launchctl bootstrap gui/$(id -u) ${PLIST} 2>&1`);
  if (bs.startsWith("__ERROR__") && !bs.includes("113")) {
    fail(`bootstrap failed: ${bs}`);
  }
  log("bootstrap issued");
  sleep(3000);
} else {
  log(`job loaded: ${jobList.split("\n")[0]}`);
}

// 5. Port check
const portCheck = sh(`lsof -i :${PORT} -sTCP:LISTEN -t 2>/dev/null`);
if (portCheck.startsWith("__ERROR__") || !portCheck || portCheck === "") {
  log(`port ${PORT} not yet listening (server may still be starting), will re-check in 5s...`);
  sleep(5000);
  const portCheck2 = sh(`lsof -i :${PORT} -sTCP:LISTEN -t 2>/dev/null`);
  if (portCheck2.startsWith("__ERROR__") || !portCheck2 || portCheck2 === "") {
    fail(`port ${PORT} still not listening after upgrade`);
  }
  log(`port ${PORT} listening (pid ${portCheck2.split("\n")[0]})`);
} else {
  log(`port ${PORT} listening (pid ${portCheck.split("\n")[0]})`);
}

log("✅ all checks passed");
process.exit(0);

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
