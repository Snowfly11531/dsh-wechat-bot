# dsh-wechat-bot

English · [简体中文](./README.md)

**WeChat QR-Code Bot plugin for DeepSeek Harness (DSH).**

A scan-to-login WeChat bot powered by the **official WeChat iLink Bot API**
(`ilinkai.weixin.qq.com`) — pure HTTP, zero reverse-engineering, no third-party
dependencies. Log in by scanning a QR code with your phone, then chat with your
DSH agent directly from WeChat.

Protocol implementation is based on the verified adapter in
[DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix)
(`internal/bot/weixin`).

## Highlights

- ✅ **Official iLink Bot API** — no unofficial protocols, low ban risk
- ✅ **QR-code login** — scan to create/bind a Bot assistant, no personal WeChat takeover
- ✅ **Free** — no paid tokens or gateways
- ✅ **Zero dependencies** — pure HTTP, only `qrcode` for rendering the QR image
- ✅ **Two-way session bridge** — WeChat messages flow into DSH sessions and replies come back
- ✅ **Workspace & session binding** — bind a chat to an existing conversation or auto-create a new one
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

**Option 1: From GitHub** (recommended, no need to wait for npm)

```sh
dsh plugin --profile web add "github:Snowfly11531/dsh-wechat-bot#<commit-sha>"
```

> Pin a commit SHA (e.g. `#c2d67d5`) for reproducibility. Git installs run the
> `prepare` script to build. pnpm ≥ 10 blocks `prepare` by default — allow it
> in the profile's `pnpm-workspace.yaml`:
> ```yaml
> allowBuilds:
>   dsh-wechat-bot: true
> ```

**Option 2: From npm** (once published)

```sh
dsh plugin --profile web add dsh-wechat-bot
```

**Option 3: Local development** (source in this repo)

```sh
git clone https://github.com/Snowfly11531/dsh-wechat-bot.git
dsh plugin --profile web add link:/absolute/path/to/dsh-wechat-bot
```

## Quick start

1. **Restart `dsh web`** to load the plugin
2. Open **Settings → WeChat Bot** (a dedicated sidebar section)
3. Click **Get QR code** and scan it with WeChat to log in
4. **Bind a session** (required) — see below
5. Message your bot in WeChat — replies come from your DSH agent

5. Message your bot in WeChat — replies come from your DSH agent

### UI preview

| Logged in | Not logged in |
|---|---|
| ![Logged in](./docs/images/settings-logged-in.png) | ![Not logged in](./docs/images/settings-not-logged-in.png) |

> Unbound chats are **ignored**: the bot replies with a hint to bind a session first.

## Binding a session

Open **Settings → WeChat Bot** and use the **Binding** section. Two modes:

### Mode 1: Choose an existing session

```
[●] Choose existing session    [○] New session
chat_id:   (auto-detected, editable)
Workspace: [dropdown ▾]
Session:   [dropdown ▾]   ← shows session titles
[Bind]
```

- Bound by **workspace + session title**, resolved **dynamically at runtime** —
  survives restarts even if session IDs change, as long as a session with the
  same title exists in that workspace
- WeChat messages flow into that session; GUI and WeChat stay in sync

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

| | Existing session | New session |
|---|---|---|
| Session | Reuses an existing one | **Created on the first WeChat message** |
| Naming | Keeps the original title | Custom name |
| Use case | Continue a current conversation | Dedicated chat for WeChat |

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
    bridge: true                 # optional, default true: feed WeChat messages into DSH sessions
    workspace: ''                # optional: default workspace for bridged sessions (auto-created if missing)
    defaultWorkspace: ''         # optional: fallback workspace for unbound chats
    bindings:                    # optional: chat → workspace/session bindings
      - chatId: 'o9cq...@im.wechat'
        workspace: 'D:\proj'     # new-session mode: bind workspace (+ sessionTitle for a custom name)
      # - chatId: '...'          # or bind to an existing session
      #   sessionId: 'session-xxx'
```

## Session bridge details

- **Unbound**: messages are not processed; the bot replies with a binding hint
- **Bound**: messages enter the bound session, agent replies go back to WeChat,
  and everything is written to the DSH session (visible in the GUI)
- Sessions are persisted; a restart resumes them automatically
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
