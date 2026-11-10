import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, openAsBlob, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

type Json = Record<string, any>;
// A Telegram message that carries a letmeknow message, with that one's author unless it is the bridge; or a member's topic.
type Entry = { tg: number; lmk: string; fp?: string } | { topic: number; fp: string };

const dir = process.argv[2];
const config: { token: string; chat: number; user: number; session: string; letmeknow: string; api?: string } =
  JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8"));
const root = config.api ?? "https://api.telegram.org";
const statePath = path.join(dir, "state.jsonl");

const lmkOf = new Map<number, { lmk: string; fp?: string }>();
const tgOf = new Map<string, number>();
const topicOf = new Map<string, number>();

function apply(entry: Entry): void {
  if ("topic" in entry) return void topicOf.set(entry.fp, entry.topic);
  lmkOf.set(entry.tg, entry);
  if (!entry.fp) tgOf.set(entry.lmk, entry.tg);
}

function record(entry: Entry): void {
  apply(entry);
  appendFileSync(statePath, `${JSON.stringify(entry)}\n`);
}

async function tg(method: string, params: Json, document?: { path: string; name: string }): Promise<any> {
  let body: string | FormData = JSON.stringify(params);
  if (document) {
    body = new FormData();
    for (const [key, value] of Object.entries(params)) body.set(key, typeof value === "string" ? value : JSON.stringify(value));
    body.set("document", await openAsBlob(document.path), document.name);
  }
  const response = await fetch(`${root}/bot${config.token}/${method}`, {
    method: "POST",
    headers: document ? {} : { "content-type": "application/json" },
    body,
  });
  const answer = await response.json();
  if (!answer.ok) throw new Error(`${method}: ${answer.description}`);
  return answer.result;
}

const run = promisify(execFile);

function lmk(args: string[], text?: string): Promise<any> {
  const call = run(bin, ["--session", config.session, ...args, ...(text === undefined ? [] : ["-"])]);
  call.child.stdin!.end(text);
  return call.then(({ stdout }) => JSON.parse(stdout));
}

async function topic(fp: string): Promise<number> {
  if (!topicOf.has(fp)) {
    const { members } = await lmk(["members"]);
    const intro = members.find((member: Json) => member.fp === fp)?.intro ?? "";
    const created = await tg("createForumTopic", { chat_id: config.chat, name: `${fp.slice(0, 4)} ${intro}`.slice(0, 128).trim() });
    record({ fp, topic: created.message_thread_id });
  }
  return topicOf.get(fp)!;
}

async function fromLmk(event: Json): Promise<void> {
  if (event.type !== "message") return void (await tg("sendMessage", { chat_id: config.chat, text: JSON.stringify(event) }));
  const { id, from, attachment, content = "" } = event;
  try {
    const request = attachment?.name.endsWith(".json") && JSON.parse(readFileSync(attachment.path, "utf8"));
    const calls: Json[] = request ? [request] : [
      ...(content.match(/[^]{1,4096}/gu) ?? []).map((text: string) => ({ method: "sendMessage", text })),
      ...(attachment ? [{ method: "sendDocument" }] : []),
    ];
    for (const { method, ...params } of calls) {
      const document = !request && method === "sendDocument" ? attachment : undefined;
      const own = params.message_thread_id === undefined;
      params.chat_id = config.chat;
      params.message_thread_id ??= await topic(from);
      if (tgOf.has(event.reply_to)) params.reply_parameters ??= { message_id: tgOf.get(event.reply_to), allow_sending_without_reply: true };
      const result = await tg(method, params, document).catch(async (error) => {
        // The member's topic was deleted: it gets a new one.
        if (!own || !/message thread not found/.test(error.message)) throw error;
        topicOf.delete(from);
        params.message_thread_id = await topic(from);
        return tg(method, params, document);
      });
      if (result?.message_id) record({ tg: result.message_id, lmk: id, fp: from });
      if (request) await lmk(["send"], JSON.stringify({ request: id, result }));
    }
  } catch (error) {
    await lmk(["send", "--reply-to", id, "--to", from], String(error));
  }
}

async function fromTelegram(update: Json): Promise<void> {
  const query = update.callback_query;
  const message = update.message ?? query.message;
  if (message.chat.id !== config.chat || (query ?? message).from.id !== config.user) return;
  const media = !query && (message.document ?? message.photo?.at(-1) ?? message.video ?? message.audio ?? message.voice
    ?? message.animation ?? message.video_note ?? message.sticker);
  const content = query ? query.data : message.text ?? message.caption ?? "";
  // Service messages, and kinds that carry neither text nor a file, are not passed on.
  if (!content && !media) return;
  const origin = lmkOf.get((query ? message : message.reply_to_message)?.message_id);
  const member = [...topicOf].find(([, thread]) => thread === message.message_thread_id)?.[0];
  const args = origin?.fp ? ["--reply-to", origin.lmk, "--to", origin.fp] : member ? ["--to", member] : ["--urgent"];
  const forward = async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lmk-tg-"));
    try {
      if (media) {
        const { file_path } = await tg("getFile", { file_id: media.file_id });
        const response = await fetch(`${root}/file/bot${config.token}/${file_path}`);
        if (!response.ok) throw new Error(`file download: HTTP ${response.status}`);
        const target = path.join(temp, path.basename(media.file_name ?? file_path));
        await writeFile(target, Buffer.from(await response.arrayBuffer()));
        args.push("--attach", target);
      }
      const { id } = await lmk(["send", ...args], content);
      if (query) await tg("answerCallbackQuery", { callback_query_id: query.id });
      else record({ tg: message.message_id, lmk: id });
    } catch (error) {
      await tg("sendMessage", {
        chat_id: config.chat,
        message_thread_id: message.message_thread_id,
        text: String(error),
        reply_parameters: { message_id: message.message_id },
      });
    } finally {
      await rm(temp, { recursive: true });
    }
  };
  // Telegram may take minutes to hand over a file: later messages do not wait for it.
  if (media) void forward().catch(console.error);
  else await forward();
}

if (existsSync(statePath)) for (const line of readFileSync(statePath, "utf8").split("\n")) if (line) apply(JSON.parse(line));

const [command, ...prefix] = config.letmeknow.split(" ");
const listen = spawn(command, [...prefix, "--session", config.session, "listen"], { stdio: ["ignore", "pipe", "inherit"] });
listen.on("exit", (code) => process.exit(code ?? 1));
const lines = createInterface({ input: listen.stdout })[Symbol.asyncIterator]();
const bin: string = JSON.parse((await lines.next()).value!).bin;

void (async () => {
  for await (const line of lines) await fromLmk(JSON.parse(line)).catch(console.error);
})();

for (let offset = 0; ;) {
  const updates: Json[] = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] })
    .catch(async (error) => {
      console.error(error);
      await sleep(5_000);
      return [];
    });
  for (const update of updates) {
    offset = update.update_id + 1;
    await fromTelegram(update).catch(console.error);
  }
}
