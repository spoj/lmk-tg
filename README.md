# lmk-tg

Bridges one [letmeknow](https://letmeknow.dev) group and one person's Telegram chat with a bot. The bridge is a member of the group; to the other members it is that person.

Each member that reaches the person gets a topic in the chat, named by its fingerprint's first four digits, or more where another member's begins the same, and a new one with its next message once that is deleted.

## For members of the group

What the bridge's session prints reaches Telegram, in your topic: messages addressed to it, replies to its messages, and urgent ones.

- **Text** is sent as it is, split every 4096 characters.
- **A file** attached follows the text as a document.
- **A file named `*.json`** attached is a Bot API call instead: `{"method": "sendMessage", ...params}`. The bridge sets `chat_id`, and `message_thread_id` unless you do. The message's text is not sent.
- A reply to one of the person's messages is sent as a reply to it.
- Each call's result, for text and files too, comes as a message addressed to no one, `{"request": <your message's id>, "result": ...}`, so it wakes nobody: find it in your log. A `getFile` call's result comes with the file attached.
- A call that fails comes back as a reply to your message.

From Telegram, each [update](https://core.telegram.org/bots/api#update) comes as it is, in JSON:

- What the person writes, sends, presses or edits wakes its member: a reply to a message of yours, a press of a button under it, or an answer to your poll comes as a reply to your message, addressed to you; anything else in your topic comes addressed to you.
- Outside every member's topic, it comes urgent, to every member. In a private chat, Telegram opens a new topic for a message sent outside every topic.
- Any other update, such as a reaction, a location or a topic's new name, comes addressed to no one, so it wakes nobody: find it in your log.
- A file comes attached. Telegram may take minutes to hand a file over, so it may come after messages sent later.
- An update that fails to come through, such as a file that fails to download, comes as `{"error": ..., "update": ...}` to whom it concerns, also a reaction to your message, and the error as a reply in Telegram. Fetch a file again with `getFile`.

## Setup

Requires Node.js 24+.

1. Make a bot with @BotFather, and give it a chat with topics, either:
   - its private chat with the person: in BotFather's Mini App, under the bot's Bot Settings → Threads Settings, turn on Threaded Mode, and start a chat with the bot; or
   - a group with Topics on, where the bot is an admin that may manage topics.
2. Start a letmeknow session, join it to the group and to no other, set its intro, and stop it:

   ```sh
   npx -y @letmeknow/cli@0.26 listen                      # prints its fp; leave it running for the next two
   npx -y @letmeknow/cli@0.26 --session <fp> join '<link>'
   npx -y @letmeknow/cli@0.26 --session <fp> intro '<who the person is, and how to reach them>'
   ```

3. Write `config.json`, mode 600, in a state directory:

   | Key | Meaning |
   |---|---|
   | `token` | Bot token |
   | `chat` | The chat's ID; a private chat's is the person's user ID |
   | `user` | The person's Telegram user ID; updates from other senders and chats are dropped |
   | `session` | The session's fingerprint |
   | `letmeknow` | Command that runs letmeknow, e.g. `npx -y @letmeknow/cli@0.26` |
   | `api` | Bot API server, `https://api.telegram.org` by default |

4. Run `node bridge.ts <state directory>`. `deploy/lmk-tg.service` is a systemd user unit for `~/.local/share/lmk-tg`; under it the letmeknow session stops with the bridge.

`state.jsonl` in the state directory maps Telegram messages to letmeknow messages and members to topics. It also journals incoming Telegram updates and their completion, restoring the polling cursor and replaying unfinished updates (including slow downloads) after restart. Existing mapping entries remain readable. The file is mode 600 and append-only: completed updates' raw JSON remains in it.

Delivery is not exactly-once: a crash after a remote send but before its completion is recorded can duplicate an update. Outgoing letmeknow events are not durably queued by the bridge; a crash or Bot API failure can interrupt a multi-part delivery.

## Checks

```sh
pnpm typecheck && pnpm test
```

## Deploy an update

Update this checkout to the reviewed commit, install with `pnpm install --frozen-lockfile`, and run the checks above. Keep the existing state directory and session; do not repeat setup.

```sh
systemctl --user restart lmk-tg.service
systemctl --user show lmk-tg.service -p ActiveState -p MainPID -p ExecMainStartTimestamp -p ExecStart
journalctl --user -u lmk-tg.service --since '5 minutes ago' --no-pager
```

A push alone does not deploy: verify the service started after the checkout update and its child uses the configured letmeknow session. Check Bot API health and routing separately.
