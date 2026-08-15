# dsh-wechat-bot

[English](./README_EN.md) · 简体中文

微信扫码机器人插件 for DSH。基于**微信官方 iLink Bot API**(`ilinkai.weixin.qq.com`),
纯 HTTP 协议,零外部依赖(仅 qrcode 用于生成二维码图片)。

协议实现参考 [DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) 的
`internal/bot/weixin` 适配器(已验证的官方接口用法)。

## 特点

- ✅ **官方接口**,非逆向协议,低封号风险
- ✅ 扫码创建/绑定「Bot 助手」,不需要托管个人微信号
- ✅ 免费
- ✅ 零外部依赖(wechaty 全家桶都不需要)
- ✅ 微信消息 ↔ DSH 会话双向同步

## 安装

**方式 1:GitHub 安装**(推荐)

```sh
dsh plugin --profile web add "github:Snowfly11531/dsh-wechat-bot"
```

> 本插件**零构建**:源码即发布产物(`lib/` 目录直接可加载),不包含 `prepare` 脚本,
> 因此 pnpm 的构建脚本白名单(`allowBuilds`)**无需配置**,安装后即可使用。

**方式 2:npm 安装**(发布后)

```sh
dsh plugin --profile web add dsh-wechat-bot
```

**方式 3:本地开发**(源码在仓库里)

```sh
git clone https://github.com/Snowfly11531/dsh-wechat-bot.git
dsh plugin --profile web add link:/absolute/path/to/dsh-wechat-bot
```

安装完成后重启 `dsh web` 生效。

## 快速开始

1. **重启 dsh web** 加载插件
2. 打开「设置 → 微信机器人」(侧边栏独立一栏,与 通用/模型/插件 并列)
3. **扫码登录**:点「获取二维码」→ 微信扫一扫 → 创建/绑定 Bot 助手(登录后 chat_id 自动识别)
4. **绑定会话**(必做,见下)——未绑定的微信消息**不会处理**,机器人会回复提示
5. 在微信里给 Bot 助手发消息 → 自动进入绑定会话并回复

### 界面预览

| 已登录 | 未登录 |
|---|---|
| ![已登录](./docs/images/settings-logged-in.png) | ![未登录](./docs/images/settings-not-logged-in.png) |

## 绑定会话(核心)

打开「设置 → 微信机器人」,在「绑定会话」区域选择模式:

### 模式一:选择原有会话

```
[●] 选择原有会话    [○] 新建会话
chat_id:  (自动识别, 也可手动填)
工作区:   [下拉选择 ▾]
会话:     [下拉选择 ▾]   ← 显示会话标题
[绑定]
```

- 按 **工作区 + 会话标题** 绑定,运行时**动态解析**——即使重启后会话 id 变化,只要该工作区存在同名标题的会话就能匹配
- 微信消息直接进入所选会话,GUI 与微信双向同步

### 模式二:新建会话

```
[○] 选择原有会话    [●] 新建会话
chat_id:  (自动识别, 也可手动填)
工作区:   [下拉选择 ▾]
新会话名称: [例如: 微信助手  ]
[绑定]
```

> ⚠️ **注意:选择「新建会话」后,会话并不会立即创建!**
> 它只在**微信里给机器人发送第一条消息时**才会在所选工作区创建,
> 并以你填的名称命名(如「微信助手」)。
> 绑定后什么都不做的话,会话列表里是看不到这个会话的——先去微信发条消息。

- 每条微信聊天对应一个**独立的新会话**(UUID,不会与其他 chat 共用)
- 创建后自动挂载到所选工作区(GUI 左侧工作区列表可见)
- 首次消息后,后续消息持续进入同一会话(对话记忆保持)

### 两种模式对比

| | 选择原有会话 | 新建会话 |
|---|---|---|
| 会话 | 复用已存在的 | **发第一条微信消息时才创建** |
| 命名 | 沿用原标题 | 自定义名称 |
| 适用 | 想接续已有对话 | 想为微信开独立对话 |

## 配置

**方式 A:GUI 设置(推荐)** — 见上「快速开始」,保存后**实时生效,无需重启**。

**方式 B:编辑 `~/.dsh/profiles/web/cordis.patch.yml`**(静态配置):

```yaml
- id: wechat-bot
  name: 'dsh-wechat-bot'
  config:
    statusPath: /wechat/status   # 可选, 默认
    autoReply: ''                # 可选: 收到消息自动回复模板, 支持 {content} {from} (bridge 关闭时生效)
    emptyReply: ''               # 可选: agent 未产出文本时的兜底回复 (如 '✅ 已处理'), 留空关闭
    bridge: true                 # 可选, 默认 true: 微信消息自动送入 DSH 会话并回复
    workspace: ''                # 可选: 桥接会话的工作目录 (不存在会自动创建)
    defaultWorkspace: ''         # 可选: 未绑定 chat 时的默认工作区 (不存在会自动创建)
    bindings:                    # 可选: chat → 工作区/现有会话 的绑定
      - chatId: 'o9cq808...@im.wechat'
        workspace: 'D:\proj'     # 新建会话模式: 绑定工作区, 首次消息时创建 (可加 sessionTitle 指定名称)
      # - chatId: '...'          # 或绑定到现有会话 (复用其上下文)
      #   sessionId: 'session-xxx'
```

## 会话桥接说明

- **未绑定**:微信消息不处理,机器人回复"请先在设置中绑定会话"
- **已绑定**:微信消息进入绑定会话,agent 回复发回微信,消息同时写入 DSH 会话(GUI 可见)
- 会话持久化,重启 dsh 后自动恢复
- 配置 `bridge: false` 可关闭桥接(仅收发,不驱动 agent)

## 工具

| 工具 | 说明 |
| --- | --- |
| `wechat_status` | 查询登录状态 / 二维码是否就绪 |
| `wechat_send` | 给 chat_id 发文本(chat_id 来自 inbox) |
| `wechat_read_inbox` | 读取收到的最近 200 条消息 |
| `wechat_sessions` | 列出可选会话(id + 工作目录) |
| `wechat_bind` | 把 chat_id 绑到指定 workspace 或 sessionId |

## 凭据位置

登录成功后 token 保存在 `~/.dsh/data/dsh-wechat-bot/accounts/<bot_id>.json`。

## License

MIT
