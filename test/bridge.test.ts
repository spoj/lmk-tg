import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { after, before, test } from "node:test";

type Json = Record<string, any>;

const CHAT = -100;
const USER = 7;
const A = "aaaa000000000000";
const B = "bbbb000000000000";
const dir = mkdtempSync(path.join(tmpdir(), "lmk-tg-test-"));
const chat = { id: CHAT };
const from = { id: USER };

// What the bridge did, in order: its Bot API calls but getUpdates, as `{ tg: method, ...params }`, and its letmeknow
// commands, as the fake reports them.
const done: Json[] = [];
const waiting: Array<(entry: Json) => void> = [];
const did = (entry: Json) => waiting.length ? waiting.shift()!(entry) : void done.push(entry);
const next = (): Promise<Json> => done.length ? Promise.resolve(done.shift()!) : new Promise((resolve) => waiting.push(resolve));
const sent = (...args: string[]) => ["--session", "S", "send", ...args, "-"];
const echo = (request: string, result: unknown) => ({ lmk: sent(), text: JSON.stringify({ request, result }) });

let listener = Promise.withResolvers<ServerResponse>();
let poll: ((updates: Json[]) => void) | undefined;
const updates: Json[] = [];
let updateId = 0;
let posted = 0;
let topics = 0;
const deleted = new Set<unknown>();
let answered = 0;
let held: Promise<void> | undefined;

const server = createServer(async (req, res) => {
  const url = req.url!;
  if (url === "/events") {
    res.flushHeaders();
    return listener.resolve(res);
  }
  if (url === "/call") {
    const call = JSON.parse(await text(req));
    did(call);
    if (call.lmk.includes("members")) return res.end(JSON.stringify({ members: [{ fp: A }, { fp: B }, { fp: "bbbb100000000000" }] }));
    if (call.lmk.includes("gone")) return res.writeHead(500).end("letmeknow: no message has an id that begins gone");
    return res.end(JSON.stringify({ id: `h${++answered}` }));
  }
  if (url.startsWith("/file/")) return url.includes("lost") ? res.writeHead(404).end() : res.end("voice bytes");
  const method = url.split("/").at(-1)!;
  const request = new Request("http://test", { method: "POST", headers: req.headers as HeadersInit, body: Readable.toWeb(req) as BodyInit, duplex: "half" } as RequestInit);
  let params: Json = {};
  if (req.headers["content-type"] === "application/json") params = await request.json() as Json;
  else for (const [key, value] of await request.formData()) params[key] = typeof value === "string" ? value : { name: value.name, content: await value.text() };
  const answer = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
  if (method === "getUpdates") return updates.length ? answer(updates.splice(0)) : void (poll = answer);
  did({ tg: method, ...params });
  const refuse = (description: string) => res.end(JSON.stringify({ ok: false, description }));
  if (method === "fail") return refuse("Bad Request: nope");
  if (method === "getFile") await held;
  if (deleted.has(params.message_thread_id)) return refuse("Bad Request: message thread not found");
  answer(method === "createForumTopic" ? { message_thread_id: 99 + ++topics }
    : method === "getFile" ? { file_path: `voice/${params.file_id}.oga` }
    : method.startsWith("send") ? { message_id: ++posted }
    : true);
});

// Sends the person's update, and returns it as the bridge passes it on.
function human(fields: Json, kind = "message"): string {
  const update = { update_id: ++updateId, [kind]: { chat, from, ...fields } };
  if (!poll) updates.push(update);
  else {
    poll([update]);
    poll = undefined;
  }
  return JSON.stringify(update);
}

async function agent(event: Json): Promise<void> {
  (await listener.promise).write(`${JSON.stringify({ type: "message", from: A, to: ["you"], ...event })}\n`);
}

function file(name: string, content: string): { name: string; path: string } {
  writeFileSync(path.join(dir, name), content);
  return { name, path: path.join(dir, name) };
}

let bridge: ChildProcess;
function start(): void {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    token: "T", chat: CHAT, user: USER, session: "S", letmeknow: path.join(import.meta.dirname, "fake-letmeknow.mjs"), api: base,
  }));
  bridge = spawn(process.execPath, [path.join(import.meta.dirname, "../bridge.ts"), dir], { env: { ...process.env, FAKE: base, TMPDIR: dir }, stdio: "inherit" });
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  start();
});

after(() => {
  bridge.kill();
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true });
});

test("an agent's text opens its topic, named by its fingerprint's first four digits", async () => {
  await agent({ id: "m1", content: "hello" });
  assert.deepEqual(await next(), { lmk: ["--session", "S", "members", "--all"], text: "" });
  assert.deepEqual(await next(), { tg: "createForumTopic", chat_id: CHAT, name: "aaaa" });
  assert.deepEqual(await next(), { tg: "sendMessage", chat_id: CHAT, message_thread_id: 100, text: "hello" });
  assert.deepEqual(await next(), echo("m1", { message_id: 1 }));
});

test("a reply reaches the message's author as a reply, as Telegram's update", async () => {
  const text = human({ message_id: 50, message_thread_id: 100, text: "yes", reply_to_message: { message_id: 1 } });
  assert.deepEqual(await next(), { lmk: sent("--reply-to", "m1", "--to", A), text });
});

test("a message in a topic reaches its member, one outside every member", async () => {
  let text = human({ message_id: 51, message_thread_id: 100, text: "status?" });
  assert.deepEqual(await next(), { lmk: sent("--to", A), text });
  text = human({ message_id: 52, text: "all stop" });
  assert.deepEqual(await next(), { lmk: sent("--urgent"), text });
});

test("an agent's reply to a human message replies to it", async () => {
  await agent({ id: "m2", content: "fine", reply_to: "h3" });
  assert.deepEqual(await next(), {
    tg: "sendMessage", chat_id: CHAT, message_thread_id: 100, text: "fine",
    reply_parameters: { message_id: 51, allow_sending_without_reply: true },
  });
  assert.deepEqual(await next(), echo("m2", { message_id: 2 }));
});

test("long text is split, and a file follows it", async () => {
  await agent({ id: "m3", content: "x".repeat(4097), attachment: file("log.txt", "log") });
  assert.equal((await next()).text, "x".repeat(4096));
  assert.deepEqual(await next(), echo("m3", { message_id: 3 }));
  assert.equal((await next()).text, "x");
  assert.deepEqual(await next(), echo("m3", { message_id: 4 }));
  assert.deepEqual(await next(), { tg: "sendDocument", chat_id: "-100", message_thread_id: "100", document: { name: "log.txt", content: "log" } });
  assert.deepEqual(await next(), echo("m3", { message_id: 5 }));
});

test("a .json attachment is a Bot API call, whose result goes to no one and whose error to its sender", async () => {
  await agent({ id: "m4", content: "a poll", attachment: file("poll.json", JSON.stringify({ method: "sendPoll", chat_id: 1, question: "ok?", options: ["y", "n"] })) });
  assert.deepEqual(await next(), { tg: "sendPoll", chat_id: CHAT, message_thread_id: 100, question: "ok?", options: ["y", "n"] });
  assert.deepEqual(await next(), echo("m4", { message_id: 6 }));
  await agent({ id: "m5", attachment: file("fail.json", JSON.stringify({ method: "fail" })) });
  assert.equal((await next()).tg, "fail");
  assert.deepEqual(await next(), { lmk: sent("--reply-to", "m5", "--to", A), text: "Error: fail: Bad Request: nope" });
});

test("a button press reaches the author of its message", async () => {
  const text = human({ id: "q1", data: "yes", message: { message_id: 6, chat, message_thread_id: 100 } }, "callback_query");
  assert.deepEqual(await next(), { lmk: sent("--reply-to", "m4", "--to", A), text });
  assert.deepEqual(await next(), { tg: "answerCallbackQuery", callback_query_id: "q1" });
});

test("a file arrives as an attachment", async () => {
  const text = human({ message_id: 53, message_thread_id: 100, voice: { file_id: "f1" } });
  assert.deepEqual(await next(), { tg: "getFile", file_id: "f1" });
  const call = await next();
  assert.equal(path.basename(call.lmk.at(-2)), "f1.oga");
  assert.deepEqual({ ...call, lmk: call.lmk.toSpliced(-2, 1) }, { lmk: sent("--to", A, "--attach"), text, file: "voice bytes" });
});

test("a later message does not wait for a file", async () => {
  const file = Promise.withResolvers<void>();
  held = file.promise;
  human({ message_id: 60, message_thread_id: 100, voice: { file_id: "f2" } });
  assert.deepEqual(await next(), { tg: "getFile", file_id: "f2" });
  const text = human({ message_id: 61, message_thread_id: 100, text: "meanwhile" });
  assert.deepEqual(await next(), { lmk: sent("--to", A), text });
  file.resolve();
  assert.equal((await next()).file, "voice bytes");
});

test("other chats and other senders are dropped, and a failed send is reported in Telegram and to its member", async () => {
  await agent({ id: "gone", content: "bye" });
  assert.equal((await next()).text, "bye");
  assert.deepEqual(await next(), echo("gone", { message_id: 7 }));
  human({ message_id: 55, chat: { id: 8 }, text: "another chat" });
  human({ message_id: 55, from: { id: 8 }, text: "another sender" });
  const update = human({ message_id: 56, message_thread_id: 100, text: "wait", reply_to_message: { message_id: 7 } });
  assert.deepEqual(await next(), { lmk: sent("--reply-to", "gone", "--to", A), text: update });
  const reply = await next();
  assert.match(reply.text, /no message has an id that begins gone/);
  assert.deepEqual({ ...reply, text: "" }, { tg: "sendMessage", chat_id: CHAT, message_thread_id: 100, text: "", reply_parameters: { message_id: 56 } });
  assert.deepEqual(await next(), { lmk: sent("--to", A), text: JSON.stringify({ error: reply.text, update: JSON.parse(update) }) });
});

test("a member whose topic was deleted gets a new one", async () => {
  deleted.add(100);
  await agent({ id: "m6", content: "moved" });
  assert.deepEqual(await next(), { tg: "sendMessage", chat_id: CHAT, message_thread_id: 100, text: "moved" });
  assert.deepEqual(await next(), { lmk: ["--session", "S", "members", "--all"], text: "" });
  assert.deepEqual(await next(), { tg: "createForumTopic", chat_id: CHAT, name: "aaaa" });
  assert.deepEqual(await next(), { tg: "sendMessage", chat_id: CHAT, message_thread_id: 101, text: "moved" });
  assert.deepEqual(await next(), echo("m6", { message_id: 9 }));
});

test("topics and messages outlast a restart", async () => {
  bridge.kill();
  (await listener.promise).end();
  listener = Promise.withResolvers();
  poll = undefined;
  start();
  const text = human({ message_id: 57, message_thread_id: 101, text: "again", reply_to_message: { message_id: 1 } });
  assert.deepEqual(await next(), { lmk: sent("--reply-to", "m1", "--to", A), text });
  await agent({ id: "m7", content: "back" });
  assert.deepEqual(await next(), { tg: "sendMessage", chat_id: CHAT, message_thread_id: 101, text: "back" });
  assert.deepEqual(await next(), echo("m7", { message_id: 10 }));
});

test("what is neither text, a file nor a button press goes to its topic's member or its message's author, else to no one", async () => {
  let text = human({ message_id: 70, message_thread_id: 101, location: { latitude: 22.3, longitude: 114.2 } });
  assert.deepEqual(await next(), { lmk: sent("--to", A), text });
  text = human({ message_id: 57, message_thread_id: 101, text: "again!", edit_date: 1 }, "edited_message");
  assert.deepEqual(await next(), { lmk: sent("--to", A), text });
  text = human({ message_id: 1, from: undefined, user: from, new_reaction: [{ type: "emoji", emoji: "👍" }] }, "message_reaction");
  assert.deepEqual(await next(), { lmk: sent("--reply-to", "m1", "--to", A), text });
  text = human({ message_id: 71, forum_topic_created: { name: "new" } });
  assert.deepEqual(await next(), { lmk: sent(), text });
});

test("a topic's name takes more digits where another member's fingerprint begins the same", async () => {
  await agent({ id: "b1", from: B, content: "hi" });
  assert.deepEqual(await next(), { lmk: ["--session", "S", "members", "--all"], text: "" });
  assert.deepEqual(await next(), { tg: "createForumTopic", chat_id: CHAT, name: "bbbb0" });
  assert.deepEqual(await next(), { tg: "sendMessage", chat_id: CHAT, message_thread_id: 102, text: "hi" });
  assert.deepEqual(await next(), echo("b1", { message_id: 11 }));
});

test("a file that fails to come through reaches its member as the error, and getFile fetches it again", async () => {
  const update = human({ message_id: 80, message_thread_id: 101, voice: { file_id: "lost" } });
  assert.deepEqual(await next(), { tg: "getFile", file_id: "lost" });
  const error = "Error: file download: HTTP 404";
  assert.deepEqual(await next(), { tg: "sendMessage", chat_id: CHAT, message_thread_id: 101, text: error, reply_parameters: { message_id: 80 } });
  assert.deepEqual(await next(), { lmk: sent("--to", A), text: JSON.stringify({ error, update: JSON.parse(update) }) });
  await agent({ id: "m8", attachment: file("get.json", JSON.stringify({ method: "getFile", file_id: "f1" })) });
  assert.deepEqual(await next(), { tg: "getFile", file_id: "f1", chat_id: CHAT, message_thread_id: 101 });
  const call = await next();
  assert.equal(path.basename(call.lmk.at(-2)), "f1.oga");
  assert.deepEqual({ ...call, lmk: call.lmk.toSpliced(-2, 1) }, { ...echo("m8", { file_path: "voice/f1.oga" }), lmk: sent("--attach"), file: "voice bytes" });
});
