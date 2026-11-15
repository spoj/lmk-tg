import { execFile, spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, openAsBlob, readFileSync, statSync, truncateSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

type Json = Record<string, any>;
// A Telegram message or poll that carries a letmeknow message, with that one's author unless it is the bridge; or a member's topic.
type Entry =
  | { tg: number; lmk: string; fp?: string }
  | { poll: string; lmk: string; fp: string }
  | { topic: number; fp: string }
  | { update: Json }
  | { done: number };

const dir = process.argv[2];
const config: { token: string; chat: number; user: number; session: string; letmeknow: string; api?: string } =
  JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8"));
const root = config.api ?? "https://api.telegram.org";
const statePath = path.join(dir, "state.jsonl");

const lmkOf = new Map<number, { lmk: string; fp?: string }>();
const pollOf = new Map<string, { lmk: string; fp: string }>();
const tgOf = new Map<string, number>();
const topicOf = new Map<string, number>();
const memberOf = new Map<number, string>();
const pending = new Map<number, Json>();
let offset = 0;

function apply(entry: Entry): void {
  if ("update" in entry) {
    pending.set(entry.update.update_id, entry.update);
    offset = Math.max(offset, entry.update.update_id + 1);
    return;
  }
  if ("done" in entry) return void pending.delete(entry.done);
  if ("poll" in entry) return void pollOf.set(entry.poll, entry);
  if ("topic" in entry) {
    topicOf.set(entry.fp, entry.topic);
    memberOf.set(entry.topic, entry.fp);
    return;
  }
  lmkOf.set(entry.tg, entry);
  if (!entry.fp) tgOf.set(entry.lmk, entry.tg);
}

function record(entry: Entry): void {
  const size = existsSync(statePath) ? statSync(statePath).size : 0;
  try {
    appendFileSync(statePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (error) {
    if (existsSync(statePath)) truncateSync(statePath, size);
    throw error;
  }
  apply(entry);
}

async function tg(method: string, params: Json, document?: { path: string; name: string }): Promise<any> {
  let body: string | FormData = JSON.stringify(params);
  if (document) {
    body = new FormData();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) body.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    body.set("document", await openAsBlob(document.path), document.name);
  }
  const response = await fetch(`${root}/bot${config.token}/${method}`, {
    method: "POST",
    headers: document ? {} : { "content-type": "application/json" },
    body,
  });
  const raw = await response.text();
  let answer: Json;
  try {
    answer = JSON.parse(raw);
  } catch {
    throw new Error(`${method}: HTTP ${response.status}`);
  }
  if (!answer.ok) throw new Error(`${method}: ${answer.description}`);
  return answer.result;
}

const run = promisify(execFile);

function lmk(args: string[], text?: string): Promise<any> {
  const call = run(bin, [...shared, "--session", config.session, ...args, ...(text === undefined ? [] : ["-"])]);
  call.child.stdin!.on("error", () => {});
  call.child.stdin!.end(text);
  return call.then(({ stdout }) => JSON.parse(stdout));
}

async function topic(fp: string): Promise<number> {
  if (!topicOf.has(fp)) {
    const { members } = await lmk(["members", "--all"]);
    const others = new Set<string>([...members.map((member: Json) => member.fp), ...topicOf.keys()]);
    others.delete(fp);
    let name = fp.slice(0, 4);
    while (name.length < fp.length && [...others].some((other) => other.startsWith(name))) name = fp.slice(0, name.length + 1);
    const created = await tg("createForumTopic", { chat_id: config.chat, name });
    record({ fp, topic: created.message_thread_id });
  }
  return topicOf.get(fp)!;
}

async function fromLmk(event: Json): Promise<void> {
  if (event.type !== "message") {
    for (const text of JSON.stringify(event).match(/[^]{1,4096}/gu) ?? []) await tg("sendMessage", { chat_id: config.chat, text });
    return;
  }
  let { id, from, attachment, content = "" } = event;
  let temp: string | undefined;
  try {
    if (event.truncated && log && existsSync(log)) {
      const whole = readFileSync(log, "utf8").split("\n").findLast((line) => {
        if (!line || !line.includes(id)) return false;
        try {
          const entry = JSON.parse(line);
          return entry.type === "message" && entry.id === id && (!event.group || entry.group === event.group);
        } catch {
          return false;
        }
      });
      if (whole) content = JSON.parse(whole).content;
    }
    const native = Boolean(attachment?.name.endsWith(".json"));
    let calls: Json[];
    if (native) {
      const request = JSON.parse(readFileSync(attachment.path, "utf8"));
      if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.method !== "string" || !/^[A-Za-z0-9_]+$/.test(request.method)) {
        throw new Error("invalid Bot API call");
      }
      calls = [request];
    } else {
      calls = [
        ...(content.match(/[^]{1,4096}/gu) ?? []).filter((text: string) => /\S/.test(text)).map((text: string) => ({ method: "sendMessage", text })),
        ...(attachment ? [{ method: "sendDocument" }] : []),
      ];
      if (!calls.length) calls = [{ method: "sendMessage", text: content }];
    }
    for (const { method, ...params } of calls) {
      const document = !native && method === "sendDocument" ? attachment : undefined;
      const own = !("message_thread_id" in params);
      params.chat_id = config.chat;
      if (own) params.message_thread_id = await topic(from);
      else if (params.message_thread_id === null) delete params.message_thread_id;
      if (tgOf.has(event.reply_to)) params.reply_parameters ??= { message_id: tgOf.get(event.reply_to), allow_sending_without_reply: true };
      const result = await tg(method, params, document).catch(async (error) => {
        // The member's topic was deleted: it gets a new one.
        if (!own || !/message thread not found/.test(error.message)) throw error;
        topicOf.delete(from);
        params.message_thread_id = await topic(from);
        return tg(method, params, document);
      });
      for (const item of Array.isArray(result) ? result : [result]) {
        if (item?.message_id) record({ tg: item.message_id, lmk: id, fp: from });
        if (item?.poll?.id) record({ poll: item.poll.id, lmk: id, fp: from });
      }
      // getFile's result brings the file with it.
      if (result?.file_path) {
        temp ??= await mkdtemp(path.join(tmpdir(), "lmk-tg-"));
        const outBase = path.basename(result.file_path);
        const file = path.join(temp, outBase && outBase !== "." && outBase !== ".." ? outBase : "file");
        const response = await fetch(`${root}/file/bot${config.token}/${result.file_path}`);
        if (!response.ok) throw new Error(`file download: HTTP ${response.status}`);
        await writeFile(file, Buffer.from(await response.arrayBuffer()));
        await lmk(["send", "--attach", file], JSON.stringify({ request: id, result }));
      } else {
        await lmk(["send"], JSON.stringify({ request: id, result }));
      }
    }
  } catch (error) {
    await lmk(["send", "--reply-to", id, "--to", from], String(error));
  } finally {
    if (temp) await rm(temp, { recursive: true });
  }
}

async function fromTelegram(update: Json): Promise<void> {
  const entry = Object.entries(update).find(([key]) => key !== "update_id");
  if (!entry) return;
  const [kind, body] = entry;
  const pollAnswer = kind === "poll_answer" ? pollOf.get(body?.poll_id) : undefined;
  const query = update.callback_query;
  const message = query?.message ?? body;
  if (pollAnswer ? body?.user?.id !== config.user : message?.chat?.id !== config.chat || (body?.from ?? body?.user)?.id !== config.user) return;
  const fresh = kind === "message";
  const edited = kind === "edited_message";
  const media = (fresh || edited) && (message.document ?? message.photo?.at(-1) ?? message.video ?? message.audio ?? message.voice
    ?? message.animation ?? message.video_note ?? message.sticker);
  const origin = pollAnswer ?? (fresh || edited
    ? (message.external_reply?.chat?.id === config.chat ? lmkOf.get(message.external_reply.message_id) : undefined)
      ?? lmkOf.get(message.reply_to_message?.message_id)
    : lmkOf.get(message?.message_id));
  const member = origin?.fp ?? memberOf.get(message?.message_thread_id);
  // What the person writes, sends, presses or edits wakes its member, or outside every member's topic every member;
  // other updates, such as reactions and a topic's new name, wake no one. A failure wakes whom its update concerns.
  const said = Boolean(pollAnswer || query || media || (message?.text ?? message?.caption) !== undefined);
  const to = member ? ["--to", member] : said ? ["--urgent"] : [];
  if (!pending.has(update.update_id)) record({ update });
  const forward = async () => {
    let temp: string | undefined;
    const args = said ? [...(origin?.fp ? ["--reply-to", origin.lmk] : []), ...to] : [];
    try {
      if (media) {
        const { file_path } = await tg("getFile", { file_id: media.file_id });
        const response = await fetch(`${root}/file/bot${config.token}/${file_path}`);
        if (!response.ok) throw new Error(`file download: HTTP ${response.status}`);
        temp = await mkdtemp(path.join(tmpdir(), "lmk-tg-"));
        const name = path.basename(media.file_name || "");
        const fallback = path.basename(file_path || "");
        const target = path.join(temp, name && name !== "." && name !== ".." ? name : fallback && fallback !== "." && fallback !== ".." ? fallback : "file");
        await writeFile(target, Buffer.from(await response.arrayBuffer()));
        args.push("--attach", target);
      }
      const { id } = await lmk(["send", ...args], JSON.stringify(update));
      if (fresh || edited) record({ tg: message.message_id, lmk: id });
      record({ done: update.update_id });
      if (query) await tg("answerCallbackQuery", { callback_query_id: query.id }).catch(console.error);
    } catch (error) {
      const notice = {
        chat_id: config.chat,
        message_thread_id: pollAnswer ? topicOf.get(member!) : message?.message_thread_id,
        text: String(error),
        ...(message?.message_id ? { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } } : {}),
      };
      await tg("sendMessage", notice)
        .catch((err) => pollAnswer && /message thread not found/.test(err.message)
          ? tg("sendMessage", { chat_id: config.chat, text: String(error) })
          : Promise.reject(err))
        .catch(console.error);
      const report = JSON.stringify({ error: String(error), update });
      await lmk(["send", ...to], report).catch((err) => {
        if (!to.length) throw err;
        return lmk(["send"], report);
      });
      record({ done: update.update_id });
    } finally {
      if (temp) await rm(temp, { recursive: true });
    }
  };
  // Telegram may take minutes to hand over a file: later messages do not wait for it.
  if (media) void forward().catch(console.error);
  else await forward();
}

if (existsSync(statePath)) {
  chmodSync(statePath, 0o600);
  let raw = readFileSync(statePath, "utf8");
  if (raw && !raw.endsWith("\n")) {
    raw = raw.slice(0, raw.lastIndexOf("\n") + 1);
    truncateSync(statePath, Buffer.byteLength(raw));
  }
  for (const line of raw.split("\n")) if (line) apply(JSON.parse(line));
}

const [command, ...rawPrefix] = (config.letmeknow.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [])
  .map((arg) => arg.replace(/"([^"]*)"|'([^']*)'/g, "$1$2"));
const prefix: string[] = [];
const shared: string[] = [];
const listenArgs: string[] = [];
for (let i = 0; i < rawPrefix.length; i++) {
  const arg = rawPrefix[i];
  if (arg === "--membership" && i + 1 < rawPrefix.length) listenArgs.push(arg, rawPrefix[++i]);
  else if (arg.startsWith("--membership=")) listenArgs.push(arg);
  else {
    prefix.push(arg);
    if (arg === "--home" && i + 1 < rawPrefix.length) {
      const val = rawPrefix[++i];
      prefix.push(val);
      shared.push(arg, val);
    } else if (arg.startsWith("--home=")) shared.push(arg);
  }
}
const listen = spawn(command, [...prefix, "--session", config.session, "listen", ...listenArgs], { stdio: ["ignore", "pipe", "inherit"] });
listen.on("exit", (code) => process.exit(code ?? 1));
const lines = createInterface({ input: listen.stdout })[Symbol.asyncIterator]();
const first = await lines.next();
if (first.done) await new Promise(() => {});
const { bin, log }: { bin: string; log?: string } = JSON.parse(first.value!);

void (async () => {
  for await (const line of lines) await (async () => fromLmk(JSON.parse(line)))().catch(console.error);
})();

for (const update of pending.values()) await fromTelegram(update).catch(console.error);

for (;;) {
  const updates: Json[] = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "edited_message", "callback_query", "message_reaction", "poll_answer"] })
    .catch(async (error) => {
      console.error(error);
      await sleep(5_000);
      return [];
    });
  for (const update of updates) {
    try {
      await fromTelegram(update);
      offset = update.update_id + 1;
    } catch (error) {
      console.error(error);
      if (offset <= update.update_id) {
        await sleep(5_000);
        break;
      }
      offset = update.update_id + 1;
    }
  }
}
