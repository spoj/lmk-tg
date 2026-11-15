#!/usr/bin/env node
// Stands in for letmeknow: `listen` logs full events to `ready.log` and prints `ready` plus 8 KiB-cut events from /events;
// any other command is answered by the test at /call, which gets its arguments, its stdin, and any attached file's content.
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("listen")) {
  const log = path.join(mkdtempSync(path.join(tmpdir(), "lmk-fake-")), "log.jsonl");
  console.log(JSON.stringify({ type: "ready", bin: fileURLToPath(import.meta.url), log }));
  const events = await fetch(`${process.env.FAKE}/events`);
  try {
    for await (const line of createInterface({ input: Readable.fromWeb(events.body) })) {
      if (!line) continue;
      let out = line;
      try {
        const event = JSON.parse(line);
        appendFileSync(log, `${line}\n`, { mode: 0o600 });
        if (event.type === "message" && typeof event.content === "string") {
          const bytes = Buffer.from(event.content, "utf8");
          if (bytes.length > 8192) {
            let end = 8192;
            while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
            out = JSON.stringify({ ...event, content: bytes.subarray(0, end).toString("utf8"), truncated: true });
          }
        }
      } catch {}
      console.log(out);
    }
  } catch {
    // The test ended the stream.
  }
} else {
  const attach = args.indexOf("--attach");
  const call = { lmk: args, text: await text(process.stdin) };
  if (attach >= 0) call.file = readFileSync(args[attach + 1], "utf8");
  const answer = await fetch(`${process.env.FAKE}/call`, { method: "POST", body: JSON.stringify(call) });
  if (answer.ok) console.log(await answer.text());
  else {
    console.error(await answer.text());
    process.exitCode = 1;
  }
}
