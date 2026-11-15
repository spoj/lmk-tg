import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

type Json = Record<string, any>;

const CHAT = -100;
const USER = 7;
const A = "aaaa000000000000";
const B = "bbbb000000000000";
const bridgePath = path.join(import.meta.dirname, "../bridge.ts");
const fakeLmkPath = path.join(import.meta.dirname, "fake-letmeknow.mjs");

async function withIsolatedBridge(
  fn: (ctx: {
    dir: string;
    next: (ms?: number) => Promise<Json>;
    done: Json[];
    start: (extra?: Json) => ReturnType<typeof spawn>;
    stop: () => Promise<void>;
    pushUpdate: (update: Json) => void;
    sendEvent: (line: string) => Promise<void>;
    waitPoll: (offset: number) => Promise<void>;
    seenOffsets: number[];
    hooks: {
      onCall?: (call: Json, res: ServerResponse) => boolean;
      onTg?: (method: string, params: Json, res: ServerResponse) => boolean;
    };
  }) => Promise<void>,
) {
  const dir = mkdtempSync(path.join(tmpdir(), "lmk-tg-edge-"));
  const done: Json[] = [];
  const waiting: Array<(entry: Json) => void> = [];
  const did = (entry: Json) => (waiting.length ? waiting.shift()!(entry) : void done.push(entry));
  const next = (ms = 3000): Promise<Json> =>
    done.length
      ? Promise.resolve(done.shift()!)
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timeout; done=${JSON.stringify(done)}`)), ms);
          waiting.push((entry) => {
            clearTimeout(timer);
            resolve(entry);
          });
        });

  let listener = Promise.withResolvers<ServerResponse>();
  let poll: ((updates: Json[]) => void) | undefined;
  const queued: Json[] = [];
  const seenOffsets: number[] = [];
  const pollWaiters = new Map<number, () => void>();
  let posted = 0;
  let topics = 0;
  let answered = 0;
  const hooks: {
    onCall?: (call: Json, res: ServerResponse) => boolean;
    onTg?: (method: string, params: Json, res: ServerResponse) => boolean;
  } = {};

  const server = createServer(async (req, res) => {
    const url = req.url!;
    if (url === "/events") {
      res.flushHeaders();
      return listener.resolve(res);
    }
    if (url === "/call") {
      const call = JSON.parse(await text(req));
      did(call);
      if (hooks.onCall?.(call, res)) return;
      if (call.lmk.includes("members")) return res.end(JSON.stringify({ members: [{ fp: A }, { fp: B }] }));
      return res.end(JSON.stringify({ id: `h${++answered}` }));
    }
    const method = url.split("/").at(-1)!;
    const request = new Request("http://test", { method: "POST", headers: req.headers as HeadersInit, body: Readable.toWeb(req) as BodyInit, duplex: "half" } as RequestInit);
    const params = req.headers["content-type"] === "application/json" ? ((await request.json()) as Json) : {};
    const answer = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
    if (method === "getUpdates") {
      seenOffsets.push(params.offset);
      pollWaiters.get(params.offset)?.();
      pollWaiters.delete(params.offset);
      while (queued.length && queued[0].update_id < params.offset) queued.shift();
      return queued.length ? answer(queued.slice(0)) : void (poll = answer);
    }
    did({ tg: method, ...params });
    if (hooks.onTg?.(method, params, res)) return;
    answer(method === "createForumTopic" ? { message_thread_id: 99 + ++topics } : method.startsWith("send") ? { message_id: ++posted } : true);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let proc: ReturnType<typeof spawn> | undefined;

  const start = (extra: Json = {}) => {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ token: "T", chat: CHAT, user: USER, session: "S", letmeknow: fakeLmkPath, api: base, ...extra }),
      { mode: 0o600 },
    );
    proc = spawn(process.execPath, [bridgePath, dir], { env: { ...process.env, FAKE: base, TMPDIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
    return proc;
  };

  const stop = async () => {
    if (proc && proc.exitCode === null) {
      const exited = new Promise((resolve) => proc!.once("exit", resolve));
      proc.kill();
      (await Promise.race([listener.promise, sleep(50).then(() => undefined)]))?.end();
      await exited;
    }
    listener = Promise.withResolvers<ServerResponse>();
    poll = undefined;
  };

  const pushUpdate = (update: Json) => {
    queued.push(update);
    if (poll) {
      const cb = poll;
      poll = undefined;
      cb(queued.slice(0));
    }
  };

  const sendEvent = async (line: string) => {
    const stream = await Promise.race([
      listener.promise,
      sleep(2000).then(() => {
        throw new Error("listen never connected");
      }),
    ]);
    stream.write(`${line}\n`);
  };

  const waitPoll = (offset: number) =>
    seenOffsets.includes(offset) ? Promise.resolve() : new Promise<void>((resolve) => pollWaiters.set(offset, resolve));

  try {
    await fn({ dir, next, done, start, stop, pushUpdate, sendEvent, waitPoll, seenOffsets, hooks });
  } finally {
    await stop();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("failed state.jsonl append never acknowledges an unsaved Telegram update, and recovers once writable", { timeout: 10000 }, async () => {
  await withIsolatedBridge(async ({ dir, start, stop, pushUpdate, next, waitPoll, seenOffsets }) => {
    const statePath = path.join(dir, "state.jsonl");
    writeFileSync(statePath, `${JSON.stringify({ fp: A, topic: 100 })}\n`, { mode: 0o600 });
    start();
    await waitPoll(0);
    chmodSync(statePath, 0o400);
    const u1 = { update_id: 1, message: { message_id: 10, chat: { id: CHAT }, from: { id: USER }, message_thread_id: 100, text: "must not lose" } };
    pushUpdate(u1);
    await sleep(150);
    assert.equal(seenOffsets.some((o) => o > 1), false, `acknowledged unsaved update: offsets=${JSON.stringify(seenOffsets)}`);
    chmodSync(statePath, 0o600);
    await stop();
    start();
    const forwarded = await next();
    assert.deepEqual(forwarded, { lmk: ["--session", "S", "send", "--to", A, "-"], text: JSON.stringify(u1) });
    await waitPoll(2);
  });
});

test("incomplete trailing state.jsonl fragment is truncated on startup while preserving prior entries and historical topic mappings", { timeout: 5000 }, async () => {
  await withIsolatedBridge(async ({ dir, start, next, pushUpdate, sendEvent }) => {
    const departed = "aaaa111111111111";
    const oldTopicMsg = { update_id: 4, message: { message_id: 20, chat: { id: CHAT }, from: { id: USER }, message_thread_id: 100, text: "from old topic" } };
    writeFileSync(
      path.join(dir, "state.jsonl"),
      [
        JSON.stringify({ fp: A, topic: 100 }),
        JSON.stringify({ fp: A, topic: 101 }),
        JSON.stringify({ fp: departed, topic: 102 }),
        JSON.stringify({ update: oldTopicMsg }),
      ].join("\n") + "\n{\"update\":{\"update_id\":9,",
      { mode: 0o600 },
    );
    start();
    assert.deepEqual(await next(), { lmk: ["--session", "S", "send", "--to", A, "-"], text: JSON.stringify(oldTopicMsg) });

    // Departed member prefix collision check + inline/actor_chat clean filter + 502 HTML error message
    pushUpdate({ update_id: 5, callback_query: { id: "iq", from: { id: USER }, inline_message_id: "im", data: "x" } });
    pushUpdate({ update_id: 6, message_reaction: { chat: { id: CHAT }, message_id: 1, actor_chat: { id: CHAT }, date: 1 } });
    const after = { update_id: 7, message: { message_id: 21, chat: { id: CHAT }, from: { id: USER }, message_thread_id: 101, text: "ok" } };
    pushUpdate(after);
    assert.deepEqual(await next(), { lmk: ["--session", "S", "send", "--to", A, "-"], text: JSON.stringify(after) });

    await sendEvent(JSON.stringify({ type: "message", id: "new1", from: "aaaa222222222222", to: ["you"], content: "hi" }));
    assert.equal((await next()).lmk[2], "members");
    assert.deepEqual(await next(), { tg: "createForumTopic", chat_id: CHAT, name: "aaaa2" });
    assert.equal((await next()).tg, "sendMessage");
    assert.equal((await next()).lmk[2], "send");
  });
});

test("departed recipient error falls back to unaddressed log report without infinite restart loop, and large stdin EPIPE / stray stdout / --home / quoted command work", { timeout: 5000 }, async () => {
  await withIsolatedBridge(async ({ dir, start, stop, pushUpdate, sendEvent, next, waitPoll, hooks, done }) => {
    const spaceDir = path.join(dir, "with space");
    rmSync(spaceDir, { recursive: true, force: true });
    mkdtempSync(path.join(dir, "keep-"));
    const fs = await import("node:fs");
    fs.mkdirSync(spaceDir);
    const spacedLmk = path.join(spaceDir, "fake-lmk.mjs");
    symlinkSync(fakeLmkPath, spacedLmk);

    writeFileSync(path.join(dir, "state.jsonl"), `${JSON.stringify({ fp: A, topic: 100 })}\n${JSON.stringify({ fp: B, topic: 101 })}\n`, { mode: 0o600 });
    hooks.onCall = (call, res) => {
      if (call.lmk.includes(A)) {
        res.writeHead(500).end("letmeknow: unknown member");
        return true;
      }
      return false;
    };
    hooks.onTg = (method, _params, res) => {
      if (method === "badGateway") {
        res.writeHead(502, { "content-type": "text/html" }).end("<html>Bad Gateway</html>");
        return true;
      }
      return false;
    };

    const proc = start({ letmeknow: `"${spacedLmk}" --home "${dir}"` });
    await sendEvent("non-json-stdout-line-should-not-crash");

    const badJsonPath = path.join(dir, "gw.json");
    writeFileSync(badJsonPath, JSON.stringify({ method: "badGateway" }));
    await sendEvent(JSON.stringify({ type: "message", id: "gw1", from: B, to: ["you"], attachment: { name: "gw.json", path: badJsonPath } }));
    assert.equal((await next()).tg, "badGateway");
    const gwErr = await next();
    assert.equal(gwErr.text, "Error: badGateway: HTTP 502");
    assert.deepEqual(gwErr.lmk.slice(0, 2), ["--home", dir]);

    const u = { update_id: 1, message: { message_id: 30, chat: { id: CHAT }, from: { id: USER }, message_thread_id: 100, text: "X".repeat(150_000) } };
    pushUpdate(u);
    assert.equal((await next()).lmk.includes(A), true); // initial send fails
    assert.equal((await next()).tg, "sendMessage"); // Telegram error reply succeeds
    assert.equal((await next()).lmk.includes(A), true); // --to A error report fails
    const fallback = await next(); // unaddressed fallback succeeds!
    assert.deepEqual(fallback.lmk, ["--home", dir, "--session", "S", "send", "-"]);
    await waitPoll(2);
    assert.equal(proc.exitCode, null);

    await stop();
    start({ letmeknow: `"${spacedLmk}" --home "${dir}"` });
    await sleep(150);
    assert.equal(done.length, 0);
  });

  // Also verify pre-ready exit propagates exit code instead of SyntaxError JSON.parse(undefined), and fast-fail >64KB stdin does not crash with EPIPE
  await withIsolatedBridge(async ({ dir, start, pushUpdate }) => {
    const earlyExit = path.join(dir, "early.mjs");
    writeFileSync(earlyExit, "#!/usr/bin/env node\nprocess.exit(42);\n", { mode: 0o755 });
    const p1 = start({ letmeknow: earlyExit });
    const code = await new Promise<number | null>((resolve) => p1.once("exit", (c) => resolve(c)));
    assert.equal(code, 42);

    const fastFail = path.join(dir, "fastfail.mjs");
    writeFileSync(
      fastFail,
      `#!/usr/bin/env node
import { fileURLToPath } from "node:url";
if (process.argv.includes("listen")) {
  console.log(JSON.stringify({ type: "ready", bin: fileURLToPath(import.meta.url) }));
  const events = await fetch(process.env.FAKE + "/events");
  try { for await (const _ of events.body) {} } catch {}
} else process.exit(1);
`,
      { mode: 0o755 },
    );
    writeFileSync(path.join(dir, "state.jsonl"), `${JSON.stringify({ fp: A, topic: 100 })}\n`, { mode: 0o600 });
    const p2 = start({ letmeknow: fastFail });
    let stderr = "";
    p2.stderr!.on("data", (d) => (stderr += d));
    pushUpdate({ update_id: 1, message: { message_id: 1, chat: { id: CHAT }, from: { id: USER }, message_thread_id: 100, text: "Z".repeat(200_000) } });
    await sleep(250);
    assert.equal(p2.exitCode, null, `crashed with EPIPE: ${stderr}`);
  });
});

test("partial ENOSPC append rolls back cleanly, lazy mkdtemp errors report via channels, non-media double-faults do not stall batches, and --home= / --membership args work", { timeout: 10000 }, async () => {
  // 1. Real kernel ENOSPC partial write on tmpfs rolls back without welding corrupt interior line
  const nsCheck = spawn("unshare", ["-Urm", "true"]);
  const [nsCode] = await new Promise<[number | null]>((resolve) => nsCheck.once("exit", (c) => resolve([c])));
  if (nsCode === 0) {
    const enospcScript = `
      set -eu
      d=\$(mktemp -d /tmp/lmktg-enospc-XXXXXX)
      trap 'umount -l "\$d/mnt" 2>/dev/null || true; rm -rf "\$d"' EXIT
      mkdir -p "\$d/mnt"
      mount -t tmpfs -o size=32k tmpfs "\$d/mnt"
      STATE="\$d/mnt" BRIDGE=${JSON.stringify(bridgePath)} FAKE_LMK=${JSON.stringify(fakeLmkPath)} node --input-type=module -e '
        import assert from "node:assert/strict";
        import { spawn } from "node:child_process";
        import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
        import { createServer } from "node:http";
        import { text } from "node:stream/consumers";
        import { setTimeout as sleep } from "node:timers/promises";
        import path from "node:path";

        const dir = process.env.STATE;
        let poll;
        let offsets = [];
        let sent = [];
        const u1 = { update_id: 1, message: { message_id: 1, chat: { id: -100 }, from: { id: 7 }, message_thread_id: 100, text: "x".repeat(9000) } };
        const server = createServer(async (req, res) => {
          if (req.url === "/events") { res.flushHeaders(); return; }
          if (req.url === "/call") { sent.push(JSON.parse(await text(req))); return res.end(JSON.stringify({ id: "h1" })); }
          const method = req.url.split("/").at(-1);
          const params = JSON.parse(await text(req));
          if (method === "getUpdates") {
            offsets.push(params.offset);
            if (params.offset <= 1) return res.end(JSON.stringify({ ok: true, result: [u1] }));
            poll = res;
            return;
          }
          res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
        });
        await new Promise(r => server.listen(0, "127.0.0.1", r));
        const base = "http://127.0.0.1:" + server.address().port;
        writeFileSync(path.join(dir, "config.json"), JSON.stringify({ token: "T", chat: -100, user: 7, session: "S", letmeknow: process.env.FAKE_LMK, api: base }));
        writeFileSync(path.join(dir, "filler"), "f".repeat(18000));
        writeFileSync(path.join(dir, "state.jsonl"), JSON.stringify({ fp: "aaaa000000000000", topic: 100 }) + "\\n");
        const p1 = spawn(process.execPath, [process.env.BRIDGE, dir], { env: { ...process.env, FAKE: base } });
        let err = "";
        p1.stderr.on("data", d => err += d);
        while (!err.includes("ENOSPC")) await sleep(30);
        unlinkSync(path.join(dir, "filler"));
        while (!offsets.includes(2)) await sleep(50);
        p1.kill();
        await new Promise(r => p1.once("exit", r));
        for (const line of readFileSync(path.join(dir, "state.jsonl"), "utf8").trim().split("\\n")) JSON.parse(line);
        server.closeAllConnections();
        server.close();
      '
    `;
    const ns = spawn("unshare", ["-Urm", "sh", "-c", enospcScript], { stdio: ["ignore", "pipe", "pipe"] });
    let nsErr = "";
    ns.stderr!.on("data", (d) => (nsErr += d));
    const [code] = await new Promise<[number | null]>((resolve) => ns.once("exit", (c) => resolve([c])));
    assert.equal(code, 0, `tmpfs ENOSPC rollback failed: ${nsErr}`);
  }

  // 2. Non-media double-fault does not stall batch for 5s, lazy mkdtemp failure reports via channels, and --home="..." + --membership args work
  await withIsolatedBridge(async ({ dir, start, pushUpdate, next, waitPoll, hooks }) => {
    const subHome = path.join(dir, "sub home");
    const fs = await import("node:fs");
    fs.mkdirSync(subHome);
    let listenArgv: string[] = [];
    const argChecker = path.join(dir, "arg-check.mjs");
    writeFileSync(
      argChecker,
      [
        "#!/usr/bin/env node",
        'import { text } from "node:stream/consumers";',
        'import { fileURLToPath } from "node:url";',
        "const args = process.argv.slice(2);",
        'if (args.includes("listen")) {',
        '  await fetch(process.env.FAKE + "/call", { method: "POST", body: JSON.stringify({ listenArgs: args }) });',
        '  console.log(JSON.stringify({ type: "ready", bin: fileURLToPath(import.meta.url) }));',
        '  const ev = await fetch(process.env.FAKE + "/events");',
        "  try { for await (const _ of ev.body) {} } catch {}",
        "} else {",
        '  const call = { lmk: args, text: await text(process.stdin) };',
        '  const ans = await fetch(process.env.FAKE + "/call", { method: "POST", body: JSON.stringify(call) });',
        "  if (ans.ok) console.log(await ans.text()); else { console.error(await ans.text()); process.exitCode = 1; }",
        "}",
      ].join("\n"),
      { mode: 0o755 },
    );

    writeFileSync(
      path.join(dir, "state.jsonl"),
      `${JSON.stringify({ fp: A, topic: 100 })}\n${JSON.stringify({ poll: "p-del", lmk: "poll-req", fp: A })}\n`,
      { mode: 0o600 },
    );

    hooks.onCall = (call, res) => {
      if (call.listenArgs) {
        listenArgv = call.listenArgs;
        res.end("{}");
        return true;
      }
      if (call.lmk.includes("poll-req")) {
        res.writeHead(500).end("letmeknow: expired poll-req");
        return true;
      }
      return false;
    };
    hooks.onTg = (method, params, res) => {
      if (method === "sendMessage" && params.message_thread_id === 100) {
        res.end(JSON.stringify({ ok: false, description: "Bad Request: message thread not found" }));
        return true;
      }
      return false;
    };

    start({ letmeknow: `"${argChecker}" --home="${subHome}" --membership="relay.example.com"` });
    const firstListen = await next();
    assert.deepEqual(listenArgv, [`--home=${subHome}`, "--session", "S", "listen", "--membership=relay.example.com"]);
    void firstListen;
    await waitPoll(0);

    // Make TMPDIR read-only: plain text still succeeds (no mkdtemp needed!), while poll_answer double-fault falls back to top-level notice and doesn't stall u2 for 5s!
    chmodSync(dir, 0o500);
    try {
      // state.jsonl already exists (0600) so appends still succeed!
      const t0 = Date.now();
      const u1 = { update_id: 1, poll_answer: { poll_id: "p-del", user: { id: USER }, option_ids: [0] } };
      const u2 = { update_id: 2, message: { message_id: 50, chat: { id: CHAT }, from: { id: USER }, message_thread_id: 100, text: "plain text without mkdtemp" } };
      pushUpdate(u1);
      pushUpdate(u2);

      assert.equal((await next()).lmk[0], `--home=${subHome}`); // u1 initial lmk send (fails, no --membership!)
      assert.equal((await next()).tg, "sendMessage"); // u1 deleted topic 100 attempt
      const topNotice = await next(); // u1 top-level fallback notice!
      assert.equal(topNotice.tg, "sendMessage");
      assert.equal(topNotice.message_thread_id, undefined);
      assert.equal((await next()).lmk[0], `--home=${subHome}`); // u1 lmk error report

      const u2Call = await next();
      assert.equal(JSON.parse(u2Call.text).update_id, 2);
      assert.ok(Date.now() - t0 < 2000, "u2 was stalled by spurious 5s backoff");
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
