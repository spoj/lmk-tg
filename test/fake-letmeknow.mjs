#!/usr/bin/env node
// Stands in for letmeknow: `listen` prints `ready` and then what the test serves at /events; any other command is
// answered by the test at /call, which gets its arguments, its stdin, and the content of a file it attaches.
import { readFileSync } from "node:fs";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("listen")) {
  console.log(JSON.stringify({ type: "ready", bin: fileURLToPath(import.meta.url) }));
  const events = await fetch(`${process.env.FAKE}/events`);
  try {
    for await (const chunk of events.body) process.stdout.write(chunk);
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
