# dsh-wechat-bot

English · [简体中文](./README.md)

**WeChat QR-Code Bot plugin for DeepSeek Harness (DSH).**

A scan-to-login WeChat bot powered by the **official WeChat iLink Bot API**
(`ilinkai.weixin.qq.com`) — pure HTTP, zero reverse-engineering, no third-party
dependencies. Log in by scanning a QR code with your phone, then chat with your
DSH agent directly from WeChat.

**It plugs WeChat into your existing DSH conversations — including the one you
are chatting in right now.** Bind to an *existing session* and every WeChat
message arrives with the session's **full history**: the agent remembers
everything you talked about, and your next question in WeChat continues the
same conversation seamlessly.

Protocol implementation is based on the verified adapter in
[DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix)
(`internal/bot/weixin`).

## Highlights

- ✅ **Official iLink Bot API** — no unofficial protocols, low ban risk
- ✅ **QR-code login** — scan to create/bind a Bot assistant, no personal WeChat takeover
- ✅ **Free** — no paid tokens or gateways
- ✅ **Zero dependencies** — pure HTTP, only `qrcode` for rendering the QR image
- ✅ **Continue existing conversations** — WeChat and an existing DSH session
  share one conversation history, nothing gets lost
- ✅ **Two-way sync** — messages and replies are written into the session in
  real time (visible in the GUI); you can keep chatting from either side
- ✅ **Persistent memory** — sessions survive restarts and resume automatically
- ✅ **Built-in GUI settings** — a dedicated section in DSH Settings for login, status, and binding

## How it works

```
WeChat user ──message──▶ iLink Bot API (long-polling getupdates)
                              │
                              ▼
                    DSH session (bound workspace)
                              │
                              ▼
                    Agent replies ──sendmessage──▶ back to WeChat
```

## Installation

**Option 1: From GitHub** (recommended)

```sh
dsh plugin --profile web add "github:Snowfly11531/dsh-wechat-bot"
```

> This plugin is **zero-build**: the source IS the artifact (the `lib/` folder
> loads directly). There is no `prepare` script, so pnpm's build-script
> allowlist (`allowBuilds`) is **not needed** — it works right after install.

**Option 2: From npm** (once published)

```sh
dsh plugin --profile web add dsh-wechat-bot
```

**Option 3: Local development** (source in this repo)

```sh
git clone https://github.com/Snowfly11531/dsh-wechat-bot.git
dsh plugin --profile web add link:/absolute/path/to/dsh-wechat-bot
```

Restart `dsh web` after installation.

## Quick start

1. **Restart `dsh web`** to load the plugin
2. Open **Settings → WeChat Bot** (a dedicated sidebar section)
3. Click **Get QR code** and scan it with WeChat to log in
4. **Bind a session** (required) — see below
5. Message your bot in WeChat — replies come from your DSH agent

### UI preview

| Logged in | Not logged in |
|---|---|
| ![Logged in](./docs/images/settings-logged-in.png) | ![Not logged in](./docs/images/settings-not-logged-in.png) |

> Unbound chats are **ignored**: the bot replies with a hint to bind a session first.

## The killer use case: plug WeChat into the conversation you're already having

This is what the plugin is really for:

```
① You're mid-conversation with an agent in the DSH GUI (e.g. discussing a plan)
        │
② Open Settings → WeChat Bot → Mode 1 "Choose existing session"
        │       pick that session → Bind
        ▼
③ On the go, send a message to the bot in WeChat
        │
④ The agent replies with the FULL context — same person, same conversation
```

- WeChat messages **enter that session**; the agent's reply is written into the
  session (visible in the GUI) **and** sent back to WeChat
- Back at your desk, open that session in the **DSH GUI and keep chatting**;
  the next WeChat message is answered with the updated context — both sides
  always share the same memory
- Restart dsh and the session resumes automatically; WeChat continues right
  where it left off

> Tip: start the conversation in the GUI first, then bind it to WeChat — the
> smoothest experience.

## Binding a session

Open **Settings → WeChat Bot** and use the **Binding** section. Two modes:

### Mode 1: Choose an existing session (recommended — continue a conversation)

```
[●] Choose existing session    [○] New session
chat_id:   (auto-detected, editable)
Workspace: [dropdown ▾]
Session:   [dropdown ▾]   ← shows session titles
[Bind]
```

- This is **continuation, not a new chat**: WeChat messages flow into the
  chosen session and the agent replies using its **entire history** (including
  everything said in the GUI)
- Bound by **workspace + session title**, resolved **dynamically at runtime** —
  survives restarts even if session IDs change, as long as a session with the
  same title exists in that workspace
- WeChat and GUI stay in sync (see the use case above)

### Mode 2: New session

```
[○] Choose existing session    [●] New session
chat_id:         (auto-detected, editable)
Workspace:       [dropdown ▾]
New session name: [e.g. WeChat Assistant  ]
[Bind]
```

> ⚠️ **Important: with "New session", the session is NOT created immediately!**
> It is created **only when you send the first message to the bot in WeChat**,
> in the selected workspace, named with the custom name you entered.
> If you bind and do nothing, the session will not appear anywhere — go send
> a message in WeChat first.

- Each WeChat chat gets its **own dedicated session** (UUID, never shared)
- The session is **auto-attached to the selected workspace** (visible in the
  DSH GUI workspace list after the first message)
- Subsequent messages keep flowing into the same session (conversation memory)

### Mode comparison

| | Existing session (recommended) | New session |
|---|---|---|
| Session | Reuses an existing one, **with full history** | **Created on the first WeChat message** |
| Memory | Remembers everything said in the GUI | Starts fresh, then persists |
| Naming | Keeps the original title | Custom name |
| Use case | Bring WeChat into a conversation in progress; chat from both ends | Dedicated fresh chat for WeChat |

## Switching workspaces/sessions from WeChat

No computer needed — send the bot an **exact command** in WeChat:

- Send **"切换会话"** (switch session): the bot lists sessions across all
  workspaces; reply with a **number or title** to switch
- Send **"切换工作区"** (switch workspace): the bot first lists workspaces;
  after you pick one, it lists that workspace's sessions — reply with a number
  or title to switch (if the workspace has no sessions, it binds as new-session mode)
- Send **"切换模型"** (switch model): lists available models (provider/model);
  after picking one, choose the **reasoning effort** (off/high/max) — future
  messages in this WeChat session use the new model (per-chat override, persisted)
- Send **"当前工作区"** / **"当前会话"** / **"当前模型"** (current
  workspace/session/model): query the current binding (workspace name/path,
  session title and id) and the active model/reasoning effort (notes whether
  it's a session override or the global default)
- **Asks whether to summarize before switching**: once a target session is
  picked, the bot asks whether to AI-summarize it (topic / progress / to-dos);
  reply "是" to get the summary with the confirmation, "否" to switch directly
- The binding is persisted; later WeChat messages flow into the new session;
  `diag.lastSwitch` records the last switch (visible on the status page)

```
You: 切换会话
Bot: 📂 Please pick the session to switch to (reply with a number or title):
     1. 📁 proj (D:\proj) → session "微信助手"
     2. 📁 proj (D:\proj) → session "dsh更新状态查询"
     3. 📁 工作区A (C:\work) → session "周报"
You: 3
Bot: 📂 Selected: 工作区A (C:\work) → session "周报"
     Summarize this session before switching? Reply "是" or "否" (anything else cancels).
You: 是
Bot: ✅ Switched: 工作区A (C:\work) → session "周报"
     📝 Session summary:
     · Topic: weekly report
     · Done: data aggregation table
     · To-do: send to manager
     Future WeChat messages will go to this session.
```

> **Only the eight exact words "切换会话", "切换工作区", "新增工作区",
> "新增会话", "切换模型", "当前工作区", "当前会话" and "当前模型" trigger the
> interception** (trailing punctuation like "切换会话。" is tolerated). Every
> other message — including phrasings like "切到 xx" or "换到 xx" — goes
> straight into the currently bound session as a normal chat: no interception,
> no extra model calls. "切换模型" overrides
> only this WeChat session (per-chat); otherwise the DSH global default model
> is used. Permission mode is controlled by DSH global config (sandbox-policy),
> not by this plugin.

## Configuration

**Method A: GUI settings (recommended)** — see "Quick start". Changes take
effect immediately, no restart needed.

**Method B: static config** in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: wechat-bot
  name: 'dsh-wechat-bot'
  config:
    statusPath: /wechat/status   # optional, default
    autoReply: ''                # optional: auto-reply template, supports {content} {from} (used when bridge is off)
    emptyReply: ''               # optional: fallback reply when the agent produces no text (e.g. '✅ Done'); empty = off
    bridge: true                 # optional, default true: feed WeChat messages into DSH sessions
    workspace: ''                # optional: default workspace for bridged sessions (auto-created if missing)
    defaultWorkspace: ''         # optional: fallback workspace for unbound chats
    rootDir: 'D:\proj'           # optional: workspace root; new workspaces are created as same-name folders here
    bindings:                    # optional: chat → workspace/session bindings
      - chatId: 'o9cq...@im.wechat'
        workspace: 'D:\proj'     # new-session mode: bind workspace (+ sessionTitle for a custom name)
      # - chatId: '...'          # or bind to an existing session (reuse its context)
      #   sessionId: 'session-xxx'
```

## Creating workspaces

Two ways, both create a same-name folder under the **workspace root**
(default `D:\proj`, configurable in the settings UI) and register it as a DSH
workspace:

- **Settings UI**: Settings → WeChat Bot → "New workspace" card, enter a name
  and click "Create & bind"
- **WeChat exact command**: send **"新增工作区"** → the bot asks for a name →
  reply with the name to create:

```
You: 新增工作区
Bot: 📂 Please reply with the new workspace name (a same-name folder will be created under D:\proj and bound as a DSH workspace):
You: 我的项目
Bot: ✅ Workspace created: D:\proj\我的项目
     Bound as a DSH workspace — visible in the workspace list / session binding.
```

> Names must not contain `\ / : * ? " < > |`; if the target folder already
> exists it is simply registered as a workspace (contents are untouched).

## Creating sessions

WeChat exact command **"新增会话"** (new session): pick a workspace, then
enter a session name — a new named session is created in that workspace,
persisted and visible in the GUI workspace list:

```
You: 新增会话
Bot: 📂 Please pick the workspace for the new session (reply with a number or name):
     1. 📁 proj (D:\proj)
     2. 📁 工作区A (C:\work)
You: 1
Bot: 📂 Workspace proj (D:\proj) selected — please reply with the new session name:
You: 测试会话
Bot: ✅ Session "测试会话" created (proj (D:\proj))
     id: session-xxxx
     Pick it later with "切换会话" or open it in the GUI workspace.
```

## Session bridge details

- **Unbound**: messages are not processed; the bot replies with a binding hint
- **Bound**: messages enter the bound session, agent replies go back to WeChat,
  and everything is written to the DSH session (visible in the GUI)
- **Continuation**: when bound to an *existing* session, replies use the full
  session history — everything said in the GUI is remembered; messages sent in
  the GUI join the same context, and later WeChat messages are answered with
  the latest state
- Sessions are persisted; a restart resumes them automatically, and WeChat
  picks up where it left off
- Set `bridge: false` to disable the bridge (receive/send only, no agent)

## Tools

| Tool | Description |
| --- | --- |
| `wechat_status` | Query login status / QR readiness |
| `wechat_send` | Send text to a chat_id (from inbox) |
| `wechat_read_inbox` | Read the last 200 received messages |
| `wechat_sessions` | List available sessions (id + workspace) |
| `wechat_bind` | Bind a chat_id to a workspace or sessionId |

## Credentials

After login, the token is stored at
`~/.dsh/data/dsh-wechat-bot/accounts/<bot_id>.json`.

## License

MIT
