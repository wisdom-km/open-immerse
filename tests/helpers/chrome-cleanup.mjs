// Shutdown for the capsule render test's Chrome process.
// Errors are reported: a failed cleanup fails the test and prints the path.
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { rememberOwnedTemp } from "./owned-tmp.mjs";

const TERM_TIMEOUT_MS = 5000;
const KILL_TIMEOUT_MS = 2000;
const SCRATCH_PREFIXES = ["com.google.Chrome.", ".com.google.Chrome."];

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function readProc(path) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "ESRCH") return null;
    throw error;
  }
}

function processState(pid) {
  const stat = readProc(`/proc/${pid}/stat`);
  if (!stat) return null;
  const text = stat.toString("utf8");
  const end = text.lastIndexOf(")");
  if (end < 0 || end + 2 >= text.length) return null;
  return text[end + 2];
}

function isLive(pid) {
  const state = processState(pid);
  return state !== null && state !== "Z";
}

function livePids(token) {
  const found = [];
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch (error) {
    if (error.code === "EACCES") return found;
    throw error;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const cmd = readProc(`/proc/${entry}/cmdline`);
    if (!cmd || !cmd.includes(token)) continue;
    if (isLive(pid)) found.push(pid);
  }
  return found;
}

function scratchDirsFromPid(pid) {
  const root = tmpdir();
  const dirs = new Set();
  const paths = [];
  try {
    paths.push(readlinkSync(`/proc/${pid}/cwd`));
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EACCES" && error.code !== "ESRCH") throw error;
  }
  let fds = [];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EACCES" && error.code !== "ESRCH") throw error;
  }
  for (const fd of fds) {
    try {
      paths.push(readlinkSync(`/proc/${pid}/fd/${fd}`));
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EACCES" && error.code !== "ESRCH") throw error;
    }
  }
  for (const target of paths) {
    for (const prefix of SCRATCH_PREFIXES) {
      const marker = `${root}/${prefix}`;
      let from = 0;
      while (from < target.length) {
        const at = target.indexOf(marker, from);
        if (at < 0) break;
        const name = target.slice(at + root.length + 1).split("/")[0];
        if (name.startsWith(prefix)) dirs.add(join(root, name));
        from = at + marker.length;
      }
    }
  }
  return dirs;
}

function chromeScratchDirs(token) {
  const dirs = new Set();
  for (const pid of livePids(token)) {
    for (const dir of scratchDirsFromPid(pid)) dirs.add(dir);
  }
  return [...dirs];
}

function signalGroup(child, signal) {
  if (!child?.pid) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code === "ESRCH") return;
    try {
      child.kill(signal);
    } catch (inner) {
      if (inner.code !== "ESRCH") throw inner;
    }
  }
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

function releaseChild(child) {
  if (!child) return;
  for (const stream of [child.stderr, child.stdout, child.stdin, child.stdio?.[3], child.stdio?.[4]]) {
    if (stream && typeof stream.destroy === "function") stream.destroy();
  }
}

async function stopChrome(child, userDataDir) {
  if (!child?.pid) return;
  signalGroup(child, "SIGTERM");
  let exited = await waitForExit(child, TERM_TIMEOUT_MS);
  if (!exited) {
    signalGroup(child, "SIGKILL");
    exited = await waitForExit(child, KILL_TIMEOUT_MS);
    if (!exited && isLive(child.pid)) {
      throw new Error(`chrome pid ${child.pid} still alive after SIGKILL`);
    }
  }
  const stragglers = livePids(userDataDir).filter((pid) => pid !== child.pid);
  for (const pid of stragglers) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  if (stragglers.length === 0) return;
  const deadline = Date.now() + KILL_TIMEOUT_MS;
  let left = stragglers;
  while (Date.now() < deadline) {
    left = livePids(userDataDir);
    if (left.length === 0) return;
    await sleep(50);
  }
  if (left.length) throw new Error(`chrome still running: ${left.join(",")}`);
}

function closeServer(server) {
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function outsideOwned(dir, ownedDir) {
  if (!ownedDir) return true;
  return dir !== ownedDir && !dir.startsWith(`${ownedDir}${sep}`);
}

async function removeTree(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export async function cleanupChrome({ t, child, server, ownedDir, userDataDir }) {
  const failures = [];
  let scratch = [];
  try {
    if (userDataDir) scratch = chromeScratchDirs(userDataDir);
  } catch (error) {
    failures.push(error);
  }
  for (const dir of scratch) rememberOwnedTemp(dir);

  try {
    await stopChrome(child, userDataDir);
  } catch (error) {
    failures.push(error);
  } finally {
    releaseChild(child);
  }

  if (server) {
    try {
      await closeServer(server);
    } catch (error) {
      failures.push(error);
    }
  }

  const extras = scratch.filter((dir) => outsideOwned(dir, ownedDir));
  for (const dir of [...extras, ownedDir].filter(Boolean)) {
    try {
      await removeTree(dir);
    } catch (error) {
      failures.push(error);
    }
  }

  try {
    if (userDataDir) {
      const live = livePids(userDataDir);
      if (live.length) failures.push(new Error(`chrome still running: ${live.join(",")}`));
    }
  } catch (error) {
    failures.push(error);
  }

  for (const dir of [...extras, ownedDir].filter(Boolean)) {
    if (existsSync(dir)) failures.push(new Error(`temp dir still exists: ${dir}`));
  }

  if (failures.length === 0) return;
  const message = failures.map((error) => error?.message || String(error)).join("; ");
  const path = [...extras, ownedDir].filter(Boolean).join(", ");
  t.diagnostic(`cleanupChrome failed: ${message} path=${path}`);
  throw new Error(`cleanupChrome failed: ${message} path=${path}`);
}
