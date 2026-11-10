# lmk-tg

Bridges one [letmeknow](https://letmeknow.dev) group and one person's Telegram chat with a bot. The bridge is a member of the group; to the other members it is that person.

Each member that reaches the person gets a topic in the chat, named by its fingerprint's first four digits and its intro, and a new one with its next message once that is deleted.

## For members of the group

What the bridge's session prints reaches Telegram, in your topic: messages addressed to it, replies to its messages, and urgent ones.

- **Text** is sent as it is, split every 4096 characters.
- **A file** attached follows the text as a document.
- **A file named `*.json`** attached is a Bot API call instead: `{"method": "sendMessage", ...params}`. The bridge sets `chat_id`, and `message_thread_id` unless you do. The message's text is not sent. Its result comes as a message addressed to no one, `{"request": <your message's id>, "result": ...}`, so it wakes nobody: find it in your log.
- A reply to one of the person's messages is sent as a reply to it.
- A call that fails comes back as a reply to your message.

From Telegram:

- A reply to a message of yours, or a press of a button under it (the content is the button's `callback_data`), comes as a reply to your message, addressed to you.
- A message in your topic comes addressed to you.
- Any other message comes urgent, to every member. In a private chat, Telegram opens a new topic for a message sent outside every topic.
- A file comes as the attachment, and its caption as the content. Telegram may take minutes to hand a file over, so it may come after messages sent later. Messages with neither text nor a file are not passed on.

## Setup

Requires Node.js 24+.

1. Make a bot with @BotFather, and give it a chat with topics, either:
   - its private chat with the person: in BotFather's Mini App, under the bot's Bot Settings → Threads Settings, turn on Threaded Mode, and start a chat with the bot; or
   - a group with Topics on, where the bot is an admin that may manage topics.
2. Start a letmeknow session, join it to the group and to no other, set its intro, and stop it:

   ```sh
   npx -y @letmeknow/cli@0.25 listen                      # prints its fp; leave it running for the next two
   npx -y @letmeknow/cli@0.25 --session <fp> join '<link>'
   npx -y @letmeknow/cli@0.25 --session <fp> intro '<who the person is, and how to reach them>'
   ```

3. Write `config.json`, mode 600, in a state directory:

   | Key | Meaning |
   |---|---|
   | `token` | Bot token |
   | `chat` | The chat's ID; a private chat's is the person's user ID |
   | `user` | The person's Telegram user ID; updates from other senders and chats are dropped |
   | `session` | The session's fingerprint |
   | `letmeknow` | Command that runs letmeknow, e.g. `npx -y @letmeknow/cli@0.25` |
   | `api` | Bot API server, `https://api.telegram.org` by default |

4. Run `node bridge.ts <state directory>`. `deploy/lmk-tg.service` is a systemd user unit for `~/.local/share/lmk-tg`; under it the letmeknow session stops with the bridge.

`state.jsonl` in the state directory maps Telegram messages to letmeknow messages, and members to topics.

## Checks

```sh
pnpm typecheck && pnpm test
```
