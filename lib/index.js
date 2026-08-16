/**
 * dsh-wechat-bot — 微信扫码机器人插件 (host 半区)
 *
 * 基于微信官方 iLink Bot API (https://ilinkai.weixin.qq.com), 纯 HTTP,
 * 零外部依赖。协议参考 DeepSeek-Reasonix internal/bot/weixin 适配器:
 *
 *   - 登录:  GET /ilink/bot/get_bot_qrcode?bot_type=3   取二维码
 *            GET /ilink/bot/get_qrcode_status?qrcode=xx  轮询扫码状态
 *            status: wait → scaned → confirmed (返回 bot_token / ilink_bot_id)
 *   - 收消息: GET /ilink/bot/getupdates   (长轮询 + context_token 断点续传)
 *   - 发消息: POST /ilink/bot/sendmessage (Bearer token + iLink 协议头)
 *   - 辅助:  POST /ilink/bot/sendtyping  (正在输入…)
 *
 * 凭据: 登录成功后保存 token 到 $DSH_HOME/data/dsh-wechat-bot/accounts/<id>.json。
 *
 * 工具:
 *   - wechat_status       查询登录状态 / 二维码
 *   - wechat_send         给联系人/群发文本
 *   - wechat_read_inbox   读取收到的消息
 *
 * 会话桥接: 每个微信 chat_id 绑定一个确定性 DSH 会话 (wechat-<hash>),
 * 收到微信消息自动送入该会话驱动 agent 回复, 回复发回微信;
 * 会话持久化, 可在 DSH Web GUI 中看到/继续这些对话。
 *
 * 配置 (cordis.patch.yml):
 *   statusPath: 二维码页面路径 (默认 /wechat/status)
 *   autoReply:  收到消息自动回复模板 ({content}/{from} 占位), 留空不回复
 *   pollMs:     getupdates 长轮询间隔 (默认 1000)
 *   bridge:     true (默认) 启用微信↔DSH 会话桥接; false 仅收发不入会话
 *   workspace:  桥接会话的工作目录 (默认取进程 cwd)
 *   emptyReply: agent 未产出文本时的兜底回复 (默认关闭, 留空不发送)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { installModelSelection } from "@deepseek-ai/dsh-agent"
import { createUserMessage } from "@deepseek-ai/dsh-llm"
import { SessionId } from "@deepseek-ai/dsh-session"
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings"
import z from "schemastery"

/** Required services. */
export const inject = ["tools", "webServer", "systemPrompt", "agents", "sessions", "agentDefaultModel", "workspaceRegistry"]

/** 默认状态页路径。 */
const DEFAULT_STATUS_PATH = "/wechat/status"

// ---- iLink 协议常量 (与 Reasonix weixin.go 一致) ----
const DEFAULT_ILINK_API = "https://ilinkai.weixin.qq.com"
const GET_UPDATES_PATH = "/ilink/bot/getupdates"
const SEND_MESSAGE_PATH = "/ilink/bot/sendmessage"
const SEND_TYPING_PATH = "/ilink/bot/sendtyping"
const GET_BOT_QR_PATH = "/ilink/bot/get_bot_qrcode"
const GET_QR_STATUS_PATH = "/ilink/bot/get_qrcode_status"
const ILINK_APP_ID = "bot"
const ILINK_CLIENT_VERSION = (2 << 16) | (2 << 8) // 0x20202 → "2.2.0"
const ILINK_CHANNEL_VERSION = "2.2.0"
const WX_ITEM_TEXT = 1
const WX_MSG_TYPE_BOT = 2
const WX_MSG_STATE_DONE = 2
const HTTP_TIMEOUT_MS = 30000

// ---- 运行时状态 ----
let botStatus = "idle" // idle | starting | waiting-scan | scanned | logged-in | token-expired | error
let qrcodeDataUrl = null
let qrcodeText = ""
let qrcodeScanUrl = "" // 可扫的微信链接 (qrcode_img_content)
let loginAccount = null // { accountId, token, baseUrl, userId }
let lastError = null
let pollTimer = null
let loginPollTimer = null
/** 轮询代际: 重新登录/插件重载时 +1, 使旧轮询链立即失效 (防止双轮询并发堆积)。 */
let pollGen = 0
let loginPollGen = 0
let inbox = []
let activeConfig = { statusPath: DEFAULT_STATUS_PATH, autoReply: "", pollMs: 1000, bridge: true, workspace: "", defaultWorkspace: "", emptyReply: "", bindings: [] }
let contextTokens = new Map() // chatId -> context_token
/** chatId → 新建模式创建的会话 id (保证后续消息复用同一会话)。 */
let newSessionMap = new Map()
let updatesBuf = ""
let lastUpdateId = 0

/** 持久化会话标题缓存 (避免 /workspaces 每 5s 轮询反复 loadStored 解压)。 */
const titleCache = new Map() // sessionId -> { title, at }
const TITLE_CACHE_TTL = 30_000

// ---- 诊断状态 (状态页 /json 输出) ----
let diag = { pollCount: 0, lastPollAt: 0, lastPollMsgs: 0, lastPollError: null, lastPollResp: null, tokenExpiredAt: null, lastSwitch: null }

/** 凭据目录: $DSH_HOME/data/dsh-wechat-bot/accounts */
function accountDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "data", "dsh-wechat-bot", "accounts")
}
function accountPath(accountId) {
  return join(accountDir(), `${accountId}.json`)
}
function loadAccount(accountId) {
  try {
    const raw = readFileSync(accountPath(accountId), "utf8")
    // BOM 容错: 外部工具 (如 PowerShell Set-Content) 可能写入 UTF-8 BOM,
    // JSON.parse 会失败导致登录状态丢失 — 剥掉头部 BOM 再解析
    const cleaned = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
    const parsed = JSON.parse(cleaned)
    // accountId 是 bot 自身 id (xxx@im.bot), 自我消息判断用它, 不是 userId
    return { ...parsed, accountId: parsed.accountId ?? accountId }
  } catch {
    return null
  }
}
function loadAnyAccount() {
  try {
    if (!existsSync(accountDir())) return null
    for (const name of readdirSync(accountDir())) {
      if (!name.endsWith(".json")) continue
      const acc = loadAccount(name.slice(0, -5))
      if (acc && acc.token) return acc
    }
  } catch {
    // ignore
  }
  return null
}
function saveAccount(accountId, account) {
  mkdirSync(accountDir(), { recursive: true })
  const target = accountPath(accountId)
  const tmp = `${target}.tmp`
  // 原子替换: 先写 tmp 再 rename
  try {
    writeFileSync(tmp, JSON.stringify(account, null, 2), "utf8")
    renameSync(tmp, target)
  } catch {
    writeFileSync(target, JSON.stringify(account, null, 2), "utf8")
  }
}

/** 工具结果模板。 */
function result(ok, message, extra = {}) {
  return { ok, message, ...extra }
}

/**
 * 写回 settings.yaml 的 wechat-bot.bindings。
 * 只替换 bindings 子块 (或补建该 section), 保留文件其余部分:
 * 其他插件的 section、以及 wechat-bot 下的其他键 (statusPath/autoReply 等)。
 * @param entries - [{ chatId, workspace?, sessionId?, sessionTitle? }]
 */
function persistBindings(entries) {
  const sp = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "settings.yaml")
  const raw = readFileSync(sp, "utf8")
  const cleaned = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
  const esc = (v) => String(v).replace(/'/g, "''")
  const block = [
    `  bindings:`,
    ...entries.map((e) => [
      `    - chatId: '${esc(e.chatId)}'`,
      ...(e.sessionId ? [`      sessionId: '${esc(e.sessionId)}'`] : []),
      ...(e.workspace ? [`      workspace: '${esc(e.workspace)}'`] : []),
      ...(e.sessionTitle ? [`      sessionTitle: '${esc(e.sessionTitle)}'`] : []),
    ].join("\n")),
  ].join("\n")
  const lines = cleaned.split(/\r?\n/)
  // 定位 wechat-bot: section 起始行
  let secStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^wechat-bot:\s*$/.test(lines[i])) { secStart = i; break }
  }
  if (secStart === -1) {
    // 无该 section: 追加到文件末尾
    writeFileSync(sp, cleaned.replace(/\s*$/, "\n") + `wechat-bot:\n${block}\n`, "utf8")
    return
  }
  // section 结束: 下一行顶格新键 (跳过空行与注释)
  let secEnd = lines.length
  for (let i = secStart + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === "" || /^\s*#/.test(l)) continue
    if (!/^\s/.test(l)) { secEnd = i; break }
  }
  // 定位 section 内 bindings: 行
  let bindStart = -1
  for (let i = secStart + 1; i < secEnd; i++) {
    if (/^\s{2}bindings:/.test(lines[i])) { bindStart = i; break }
  }
  if (bindStart === -1) {
    // 无 bindings 块: 插到 section 末尾
    writeFileSync(sp, [...lines.slice(0, secEnd), block, ...lines.slice(secEnd)].join("\n"), "utf8")
    return
  }
  let bindEnd
  if (/^\s{2}bindings:\s*$/.test(lines[bindStart])) {
    // 块式: 到下一个缩进 < 4 的非空行结束 (bindings 条目缩进 ≥ 4)
    bindEnd = secEnd
    for (let i = bindStart + 1; i < secEnd; i++) {
      const l = lines[i]
      if (l.trim() === "") continue
      if ((l.match(/^\s*/)?.[0].length ?? 0) < 4) { bindEnd = i; break }
    }
  } else {
    // 流式单行 (bindings: [...]): 整行替换
    bindEnd = bindStart + 1
  }
  writeFileSync(sp, [...lines.slice(0, bindStart), block, ...lines.slice(bindEnd)].join("\n"), "utf8")
}

/** iLink 请求: 带协议头的 fetch。 */
async function ilinkFetch(baseUrl, path, { method = "GET", token = "", body = null, qs = "" } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const headers = {
      "content-type": "application/json",
      // Reasonix ilinkGET/setIlinkHeaders: 登录/轮询/发消息都带这两个 App 头
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": String(ILINK_CLIENT_VERSION),
    }
    if (token) {
      headers["AuthorizationType"] = "ilink_bot_token"
      headers["Authorization"] = `Bearer ${token}`
      headers["X-WECHAT-UIN"] = randomWechatUin()
      headers["Content-Length"] = String(body ? Buffer.byteLength(JSON.stringify(body)) : 0)
    }
    const response = await fetch(`${baseUrl}${path}${qs}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`iLink HTTP ${response.status}: ${text.slice(0, 200)}`)
    }
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`iLink bad JSON: ${text.slice(0, 200)}`)
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

/** 随机 X-WECHAT-UIN (伪装客户端)。 */
function randomWechatUin() {
  const buf = randomBytes(4)
  const n = (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]
  return Buffer.from(String(n >>> 0)).toString("base64")
}

/** 请求体读取。 */
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

/** 启动扫码登录会话。 */
async function startLogin(bridgeCtx) {
  try {
    const resp = await ilinkFetch(DEFAULT_ILINK_API, GET_BOT_QR_PATH, { qs: "?bot_type=3" })
    qrcodeText = String(resp.qrcode ?? "")
    if (!qrcodeText || qrcodeText === "null") {
      throw new Error("iLink 二维码响应缺少 qrcode")
    }
    // 真正的扫码内容: qrcode_img_content 是可扫的微信链接 (qrcode 字段只是轮询 key)
    const scanContent = String(resp.qrcode_img_content ?? "")
    if (scanContent && scanContent !== "null") {
      qrcodeScanUrl = scanContent
    } else {
      qrcodeScanUrl = qrcodeText
    }
    // 生成二维码 dataURL (内嵌到状态页)
    const QR = await import("qrcode").catch(() => null)
    if (QR) {
      qrcodeDataUrl = await QR.default.toDataURL(qrcodeScanUrl, { width: 260, margin: 1 })
    } else {
      qrcodeDataUrl = null
    }
    botStatus = "waiting-scan"
    lastError = null
    diag.tokenExpiredAt = null
    startLoginPoll(bridgeCtx)
  } catch (error) {
    botStatus = "error"
    lastError = error instanceof Error ? error.message : String(error)
  }
}

/** 轮询扫码状态: 该接口是长轮询 (未扫码时挂约 30s 才返回 wait), 串行链式调度避免并发堆积。 */
function startLoginPoll(bridgeCtx) {
  const gen = ++loginPollGen
  if (loginPollTimer !== null) clearTimeout(loginPollTimer)
  const deadline = Date.now() + 8 * 60 * 1000
  const stop = () => {
    if (loginPollTimer !== null) {
      clearTimeout(loginPollTimer)
      loginPollTimer = null
    }
  }
  const pollOnce = async () => {
    if (gen !== loginPollGen) return
    if (botStatus !== "waiting-scan" && botStatus !== "scanned") return
    try {
      const resp = await ilinkFetch(DEFAULT_ILINK_API, GET_QR_STATUS_PATH, { qs: `?qrcode=${encodeURIComponent(qrcodeText)}` })
      const status = String(resp.status ?? "")
      if (status === "scaned" || status === "scaned_but_redirect") {
        botStatus = "scanned"
      } else if (status === "confirmed") {
        const accountId = String(resp.ilink_bot_id ?? "")
        const token = String(resp.bot_token ?? "")
        const userId = String(resp.ilink_user_id ?? "")
        if (!accountId || !token) {
          throw new Error("iLink 确认扫码但凭据不完整")
        }
        const account = { accountId, token, baseUrl: DEFAULT_ILINK_API, userId, savedAt: new Date().toISOString() }
        saveAccount(accountId, account)
        saveAccount("default", account)
        loginAccount = { accountId, token, baseUrl: DEFAULT_ILINK_API, userId }
        botStatus = "logged-in"
        qrcodeDataUrl = null
        qrcodeText = ""
        qrcodeScanUrl = ""
        stop()
        startPollLoop(bridgeCtx)
        return
      } else if (status === "expired") {
        botStatus = "idle"
        lastError = "二维码已过期, 请重新获取"
        stop()
        return
      }
    } catch {
      // 长轮询超时/中断是正常现象, 不视为错误
    }
    // 串行下一轮 (上一轮返回或超时后才发起)
    if (gen !== loginPollGen) return
    if (botStatus === "waiting-scan" || botStatus === "scanned") {
      if (Date.now() > deadline) {
        botStatus = "idle"
        lastError = "二维码已过期, 请重新获取"
        stop()
        return
      }
      loginPollTimer = setTimeout(() => void pollOnce(), 1500)
    }
  }
  void pollOnce()
}

/** 长轮询收消息循环 (getupdates 是 POST 长轮询, 串行链式避免并发堆积)。 */
function startPollLoop(bridgeCtx) {
  const gen = ++pollGen
  if (pollTimer !== null) clearTimeout(pollTimer)
  const poll = async () => {
    if (gen !== pollGen) return
    if (loginAccount === null) return
    // 仅登录态轮询: token-expired/idle 等状态下不再打无效请求
    if (botStatus !== "logged-in") return
    try {
      // Reasonix 协议: POST body 携带 get_updates_buf + base_info
      const payload = {
        get_updates_buf: updatesBuf,
        base_info: { channel_version: ILINK_CHANNEL_VERSION },
      }
      const resp = await ilinkFetch(loginAccount.baseUrl, GET_UPDATES_PATH, {
        method: "POST",
        token: loginAccount.token,
        body: payload,
      })
      diag.pollCount += 1
      diag.lastPollAt = Date.now()
      diag.lastPollError = null
      diag.lastPollResp = { errcode: resp.errcode ?? 0, ret: resp.ret ?? 0 }

      // ★ 关键: 检查业务错误码 (HTTP 200 但 errcode != 0, 如 session timeout)
      if (resp.errcode !== undefined && resp.errcode !== 0) {
        const msg = String(resp.errmsg ?? "")
        if (resp.errcode === -14 || msg.includes("session timeout")) {
          // token 失效: 重载磁盘上最新的账号 (用户可能重新扫码过)
          const fresh = loadAccount("default") ?? loadAnyAccount()
          if (fresh && fresh.token && fresh.token !== loginAccount.token) {
            loginAccount = { accountId: fresh.accountId ?? "default", token: fresh.token, baseUrl: fresh.baseUrl || DEFAULT_ILINK_API, userId: fresh.userId ?? "" }
            updatesBuf = ""
            lastError = "token 已过期, 已自动加载最新账号并重试"
            diag.lastPollError = "token-refreshed"
            // 立即重试
            pollTimer = setTimeout(() => void poll(), 300)
            return
          }
          markTokenExpired("getupdates")
          return
        }
        lastError = `getupdates errcode=${resp.errcode}: ${msg}`
        diag.lastPollError = lastError
      }
      const updates = Array.isArray(resp.updates) ? resp.updates : []
      // 消息也可能出现在 msgs 字段 (item_list 结构)
      const msgs = Array.isArray(resp.msgs) ? resp.msgs : []
      diag.lastPollMsgs = msgs.length + updates.length
      const autoReply = activeConfig.autoReply
      for (const msg of msgs) {
        // 忽略机器人自己发出的消息: 用 bot 的 accountId (xxx@im.bot) 判断,
        // 不能用 userId (扫码者 id, 与消息 from_user_id 相同会误杀所有消息)
        const sender = String(msg.from_user_id ?? "")
        if (sender === loginAccount.accountId) continue
        const chatId = String(msg.chat_room_id ?? msg.room_id ?? msg.from_user_id ?? "")
        const fromName = String(msg.from_user_id ?? "unknown")
        const items = Array.isArray(msg.item_list) ? msg.item_list : []
        const text = items
          .filter((item) => item.type === WX_ITEM_TEXT && item.text_item && item.text_item.text)
          .map((item) => item.text_item.text)
          .join("\n")
        if (!chatId || !text) continue
        inbox.push({ from: fromName, chatId, content: text, time: Date.now() })
        if (inbox.length > 200) inbox.shift()
        diag.lastBridge = { at: Date.now(), chatId, text: text.slice(0, 50), phase: "received" }
        if (autoReply && !activeConfig.bridge) {
          const reply = autoReply.replace("{content}", text).replace("{from}", fromName)
          await sendMessage(chatId, reply).catch(() => {})
        }
        if (activeConfig.bridge) {
          // fire-and-forget: 不 await, 避免 agent 回复慢时阻塞收消息轮询;
          // 同一 chat 的消息已由 bridgeQueues 串行化, 不同 chat 互不阻塞
          void bridgeMessage(bridgeCtx, { chatId, from: fromName, text }).catch((error) => {
            lastError = `bridge: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
          })
        }
      }
      for (const update of updates) {
        const msg = update.message ?? {}
        if (update.update_id !== undefined && update.update_id <= lastUpdateId) continue
        if (update.update_id !== undefined) lastUpdateId = update.update_id
        const chatId = String(msg.chat_id ?? "")
        const from = msg.from ?? {}
        const fromUserId = String(from.user_id ?? "")
        if (fromUserId === loginAccount.accountId) continue
        const text = String(msg.text ?? "")
        if (!text) continue
        const fromName = String(from.user_name ?? from.user_id ?? "unknown")
        inbox.push({
          from: fromName,
          chatId,
          content: text,
          time: Number(msg.timestamp ?? Date.now()),
        })
        if (inbox.length > 200) inbox.shift()
        if (autoReply && !activeConfig.bridge) {
          const reply = autoReply.replace("{content}", text).replace("{from}", fromName)
          await sendMessage(chatId, reply).catch(() => {})
        }
        if (activeConfig.bridge) {
          void bridgeMessage(bridgeCtx, { chatId, from: fromName, text }).catch((error) => {
            lastError = `bridge: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
          })
        }
      }
      if (resp.context_token !== undefined && resp.context_token !== null) {
        contextTokens.set("default", String(resp.context_token))
      }
      if (resp.get_updates_buf !== undefined && resp.get_updates_buf !== null) {
        updatesBuf = String(resp.get_updates_buf)
      }
    } catch (error) {
      diag.pollCount += 1
      diag.lastPollAt = Date.now()
      diag.lastPollError = error instanceof Error ? error.message : String(error)
      lastError = `getupdates: ${error instanceof Error ? error.message : String(error)}`
    }
    // 串行下一轮
    if (loginAccount !== null && gen === pollGen) {
      pollTimer = setTimeout(() => void poll(), activeConfig.pollMs || 1000)
    }
  }
  void poll()
}

/**
 * token 失效且磁盘无新 token: 进入醒目的 token-expired 状态并终止轮询链,
 * 避免对已失效的 token 持续发送无效请求。
 * @param where - 触发来源 (getupdates / sendmessage), 用于提示文案。
 */
function markTokenExpired(where) {
  botStatus = "token-expired"
  lastError = `微信会话已过期 (token 失效于 ${where}), 请到状态页重新扫码登录`
  diag.lastPollError = "session-timeout"
  diag.tokenExpiredAt = Date.now()
  pollGen += 1 // 终止当前 getupdates 轮询链
  if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null }
}

/** 发送文本消息。 */
async function sendMessage(chatId, text) {
  if (loginAccount === null) throw new Error("微信机器人未登录")
  const payload = {
    base_info: { channel_version: ILINK_CHANNEL_VERSION },
    msg: {
      from_user_id: "",
      to_user_id: chatId,
      client_id: `dsh-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      message_type: WX_MSG_TYPE_BOT,
      message_state: WX_MSG_STATE_DONE,
      item_list: [{ type: WX_ITEM_TEXT, text_item: { text } }],
    },
  }
  const ctx = contextTokens.get(chatId) ?? contextTokens.get("default")
  if (ctx) payload.msg.context_token = ctx
  const resp = await ilinkFetch(loginAccount.baseUrl, SEND_MESSAGE_PATH, {
    method: "POST",
    token: loginAccount.token,
    body: payload,
  })
  // ★ 成功判断: sendmessage 成功响应只有 message_id (无 errcode/ret 字段),
  //    只有显式存在的非零错误码才算失败 (resp.ret !== 0 在字段缺失时会误判!)
  const failed = (resp.errcode !== undefined && resp.errcode !== 0) || (resp.ret !== undefined && resp.ret !== 0)
  if (failed) {
    const msg = String(resp.errmsg ?? "")
    if (resp.errcode === -14 || msg.includes("session timeout")) {
      const fresh = loadAccount("default") ?? loadAnyAccount()
      if (fresh && fresh.token && fresh.token !== loginAccount.token) {
        loginAccount = { accountId: fresh.accountId ?? "default", token: fresh.token, baseUrl: fresh.baseUrl || DEFAULT_ILINK_API, userId: fresh.userId ?? "" }
        return sendMessage(chatId, text)
      }
      markTokenExpired("sendmessage")
    }
    // context_token 失效则清除重试一次
    if (ctx && !msg.includes("session timeout")) {
      contextTokens.delete(chatId)
      contextTokens.delete("default")
      return sendMessage(chatId, text)
    }
    throw new Error(`iLink sendmessage ret=${resp.ret} errcode=${resp.errcode}: ${msg}`)
  }
  return resp
}

// ================= 微信 ↔ DSH 会话桥接 =================

/** chat_id → AgentHandle 的常驻映射 (保持对话记忆)。 */
const bridgeAgents = new Map()
/** chat_id → 串行队列 (同一聊天逐条处理)。 */
const bridgeQueues = new Map()

/** 确定性会话 id: wechat-<sha256(chatId) 前 12 位>。 */
function sessionIdFor(chatId) {
  return SessionId(`wechat-${createHash("sha256").update(chatId).digest("hex").slice(0, 12)}`)
}

/**
 * 收集一轮回复: 从 agent 会话事件中提取最后一个 assistant 文本。
 * 事件在 followup 之后新增, 取最后一个 assistant/message 的 text 块。
 */
function collectReply(events, fromSeq) {
  let text = ""
  for (const event of events) {
    if (event.seq < fromSeq) continue
    if (event.type === "assistant/message") {
      const joined = (event.data.message.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("")
      if (joined !== "") text = joined
    }
  }
  return text
}

/** 读持久化会话标题 (带 TTL 缓存)。 */
async function storedTitleOf(persistence, sid) {
  const hit = titleCache.get(sid)
  if (hit !== void 0 && Date.now() - hit.at < TITLE_CACHE_TTL) return hit.title
  let title = ""
  try {
    const stored = await persistence.loadStored(sid)
    title = sessionTitleOf(stored)
  } catch {
    // 读取失败则无标题
  }
  titleCache.set(sid, { title, at: Date.now() })
  return title
}

/**
 * 解析微信 chat_id 的绑定目标。
 * bindings 配置形如: [{ chatId, workspace?, sessionId?, sessionTitle? }]
 * @returns {{ workspace?: string, sessionId?: string, sessionTitle?: string } | null}
 */
function resolveBinding(chatId) {
  const bindings = activeConfig.bindings ?? []
  for (const b of bindings) {
    if (b.chatId && b.chatId === chatId) {
      return { workspace: b.workspace, sessionId: b.sessionId, sessionTitle: b.sessionTitle }
    }
  }
  return null
}

/**
 * 从会话事件流提取标题 (session/title 事件的最后一个值)。
 * 会话 header 无 title; title 由事件记录。
 * @param session - live session 对象。
 * @returns 标题字符串 (无则空)。
 */
function sessionTitleOf(session) {
  try {
    if (!session) return ""
    const events = session.events ?? []
    let title = ""
    for (const e of events) {
      if (e.type === "session/title") {
        const v = e.data?.title ?? e.data
        if (typeof v === "string" && v.trim() !== "") title = v
      }
    }
    return title
  } catch {
    return ""
  }
}

/**
 * 动态解析绑定: 按 工作区+会话标题 找到当前匹配的会话 id。
 * @returns sessionId 字符串; 找不到返回 null。
 */
function resolveBindingSessionId(ctx, binding) {
  if (binding?.sessionId) return binding.sessionId
  if (!binding?.workspace || !binding?.sessionTitle) return null
  try {
    const registry = ctx.get("workspaceRegistry")
    const sessionsSvc = ctx.get("sessions")
    if (registry === void 0 || typeof registry.list !== "function") return null
    const wsPath = binding.workspace.replace(/[\\/]+$/, "")
    for (const ws of registry.list()) {
      const wsPathNorm = (ws.path ?? "").replace(/[\\/]+$/, "")
      if (wsPathNorm !== wsPath) continue
      for (const sid of ws.sessionIds ?? []) {
        const s = sessionsSvc?.get(sid)
        if (s && sessionTitleOf(s) === binding.sessionTitle) return String(sid)
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * 确保目录存在并注册为 DSH 工作区 (会话 cwd 必须在已注册工作区内)。
 * 幂等: 目录已存在/已注册则直接复用。
 * @param ctx - 插件上下文。
 * @param dir - 目标目录绝对路径。
 */
async function ensureWorkspace(ctx, dir) {
  if (!dir) return
  try {
    // 1. 目录不存在则递归创建
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    // 2. 注册为工作区 (重复注册会复用已有实体, 幂等)
    const registry = ctx.get("workspaceRegistry")
    if (registry !== void 0 && typeof registry.create === "function") {
      await registry.create(dir, `wechat-${dir.split(/[\\/]/).pop() || "proj"}`)
    }
  } catch (error) {
    // 注册失败不阻塞会话创建 (cwd 可能已在注册表或目录不可写)
    lastError = `ensureWorkspace(${dir}): ${error instanceof Error ? error.message : String(error)}`
  }
}

// ================= 微信内切换工作区/会话 (路由拦截) =================

/** 粗筛关键词: 命中才走模型判断 (避免每条消息都调模型)。 */
/** 切换触发词: 仅这些精确词触发切换流程, 其他消息一律进入正常聊天。 */
const SWITCH_WORDS = ["切换会话", "切换工作区"]
/** 去掉尾部标点/空白后返回命中的切换词 (容忍 "切换会话。"、"切换会话!" 等), 未命中返回 null。 */
function matchSwitchWord(text) {
  const t = String(text ?? "").trim().replace(/[。！!？?，,.\s]+$/g, "")
  return SWITCH_WORDS.find((w) => w === t) ?? null
}

/** 待确认切换: 询问后等待用户回复序号/名称 (30 分钟有效)。 */
const pendingSwitch = new Map() // chatId -> { kind: "session"|"workspace", list, expiresAt }
const PENDING_SWITCH_TTL = 30 * 60 * 1000
const normPath = (p) => String(p ?? "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase()

/** 列出工作区及其会话 (实时: 用 sessionPersistence.list 覆盖新建会话)。 */
async function listWorkspaces(ctx) {
  const registry = ctx.get("workspaceRegistry")
  const sessionsSvc = ctx.get("sessions")
  const persistence = ctx.get("sessionPersistence")
  const out = []
  let allHeaders = []
  try {
    if (persistence !== void 0 && typeof persistence.list === "function") {
      allHeaders = await persistence.list()
    }
  } catch {
    allHeaders = []
  }
  const norm = (p) => String(p ?? "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase()
  if (registry !== void 0 && typeof registry.list === "function") {
    for (const ws of registry.list()) {
      const sessions = []
      const seen = new Set()
      const wsNorm = norm(ws.path)
      // 1) 持久化会话按 cwd 归属
      for (const h of allHeaders) {
        if (norm(h.cwd) !== wsNorm) continue
        const sid = String(h.id)
        if (seen.has(sid)) continue
        seen.add(sid)
        const s = sessionsSvc?.get(sid)
        let title = sessionTitleOf(s)
        // 内存中无此会话 → 从持久化读取标题 (带缓存)
        if (title === "" && persistence !== void 0 && typeof persistence.loadStored === "function") {
          title = await storedTitleOf(persistence, sid)
        }
        sessions.push({ id: sid, title: title || sid.slice(0, 8), cwd: h.cwd ?? ws.path })
      }
      // 2) 注册表索引的会话补充 (可能未持久化)
      for (const sid of ws.sessionIds ?? []) {
        const sidStr = String(sid)
        if (seen.has(sidStr)) continue
        seen.add(sidStr)
        const s = sessionsSvc?.get(sidStr)
        let title = sessionTitleOf(s)
        if (title === "" && persistence !== void 0 && typeof persistence.loadStored === "function") {
          title = await storedTitleOf(persistence, sidStr)
        }
        sessions.push({ id: sidStr, title: title || sidStr.slice(0, 8), cwd: s?.header?.cwd ?? ws.path })
      }
      out.push({ id: String(ws.id), path: ws.path, title: ws.title, sessions })
    }
  }
  return out
}

/** 截断工作区/会话列表 (防止列表过长, 模型与用户看到同一份)。 */
function sliceSessionList(wsList, maxWs = 12, maxSessions = 8) {
  return (wsList ?? []).slice(0, maxWs).map((w) => ({
    id: w.id,
    path: w.path,
    title: w.title,
    sessions: (w.sessions ?? []).slice(0, maxSessions),
  }))
}

/** 把会话列表格式化为带序号文本 (给模型与给用户的同一格式)。 */
/** 工作区显示名: 优先网页列表中的名字 (title), 无名字才显示路径。 */
function wsLabel(ws) {
  const title = String(ws?.title ?? "").trim()
  const path = String(ws?.path ?? "")
  return title && title !== path ? `${title} (${path})` : path
}

/** 把会话列表格式化为带序号文本 (给模型与给用户的同一格式)。 */
function formatSessionList(wsList) {
  const lines = []
  let n = 0
  for (const ws of wsList) {
    const sessions = ws.sessions ?? []
    if (sessions.length === 0) {
      lines.push(`${++n}. 📁 ${wsLabel(ws)} (暂无会话)`)
      continue
    }
    for (const s of sessions) {
      lines.push(`${++n}. 📁 ${wsLabel(ws)} → 会话「${s.title}」`)
    }
  }
  return lines.length === 0 ? "(没有任何可用会话)" : lines.join("\n")
}

/** 按 序号 / 标题精确 / 标题包含 匹配用户的选择回复。 */
function matchSessionChoice(wsList, text) {
  const t = String(text ?? "").trim()
  if (/^\d+$/.test(t)) {
    let n = 0
    for (const ws of wsList) {
      for (const s of ws.sessions ?? []) {
        n += 1
        if (n === Number(t)) return { workspace: ws.path, workspaceTitle: ws.title, sessionTitle: s.title, sessionId: s.id }
      }
    }
    return null
  }
  const norm = (x) => String(x ?? "").toLowerCase().replace(/\s+/g, "")
  const tn = norm(t)
  if (!tn) return null
  for (const ws of wsList) {
    for (const s of ws.sessions ?? []) {
      if (norm(s.title) === tn) return { workspace: ws.path, workspaceTitle: ws.title, sessionTitle: s.title, sessionId: s.id }
    }
  }
  for (const ws of wsList) {
    for (const s of ws.sessions ?? []) {
      const sn = norm(s.title)
      if (sn.includes(tn) || tn.includes(sn)) return { workspace: ws.path, workspaceTitle: ws.title, sessionTitle: s.title, sessionId: s.id }
    }
  }
  return null
}

/** 把工作区列表格式化为带序号文本 (仅工作区, 不含会话)。 */
function formatWorkspaceList(wsList) {
  if ((wsList ?? []).length === 0) return "(没有任何可用工作区)"
  return wsList.map((ws, i) => `${i + 1}. 📁 ${wsLabel(ws)}`).join("\n")
}

/** 按 序号 / 工作区名 / 路径 匹配用户对工作区的选择。 */
function matchWorkspaceChoice(wsList, text) {
  const t = String(text ?? "").trim()
  if (/^\d+$/.test(t)) {
    const i = Number(t) - 1
    return (wsList ?? [])[i] ?? null
  }
  const norm = (x) => String(x ?? "").toLowerCase().replace(/\s+/g, "")
  const tn = norm(t)
  if (!tn) return null
  for (const ws of wsList ?? []) {
    if (norm(ws.title) === tn || normPath(ws.path) === normPath(t)) return ws
  }
  for (const ws of wsList ?? []) {
    const sn = norm(ws.title)
    if (sn && (sn.includes(tn) || tn.includes(sn))) return ws
  }
  return null
}

/** 绑定当前 chat → 目标 (更新内存 + 持久化 + 重置桥接 agent)。与 /bind 共享。 */
function applyBinding(ctx, chatId, entry) {
  const rest = activeConfig.bindings.filter((b) => b.chatId !== chatId)
  const entries = [...rest, entry]
  activeConfig.bindings = entries
  // 持久化到 settings.yaml (wechat-bot.bindings, 仅替换 bindings 子块)
  try {
    persistBindings(entries)
  } catch (error) {
    // 持久化失败不阻塞 (内存绑定已生效)
  }
  // 若该 chat 有运行中 agent, 重置以便下次按新绑定重连
  const existing = bridgeAgents.get(chatId)
  if (existing !== void 0) {
    bridgeAgents.delete(chatId)
    try {
      existing.dispose?.()
    } catch {
      // ignore
    }
  }
  return entries
}

/**
 * 从会话事件中提取最近的对话文本 (用户/助手消息, 不含工具调用细节)。
 * @returns 形如 "用户: ...\n助手: ..." 的文本, 最多 maxMessages 条、maxChars 字符。
 */
function extractHistoryText(events, maxMessages = 20, maxChars = 4000) {
  const parts = []
  for (const event of events ?? []) {
    const msg = event.data?.message
    if (msg === void 0) continue
    const blocks = Array.isArray(msg.content) ? msg.content : []
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
    if (text === "") continue
    const role = event.type === "assistant/message" ? "助手" : event.type === "user/message" ? "用户" : null
    if (role === null) continue
    parts.push(`${role}: ${text}`)
  }
  const tail = parts.slice(-maxMessages)
  let out = ""
  for (const part of tail) {
    if (out.length + part.length > maxChars) break
    out += part + "\n"
  }
  return out.trim()
}

/** 读取会话历史 (live session 优先, 其次持久化), 返回事件数组或 null。 */
async function loadSessionEvents(ctx, sessionId) {
  const sid = SessionId(sessionId)
  const sessionsSvc = ctx.get("sessions")
  const persistence = ctx.get("sessionPersistence")
  try {
    const live = sessionsSvc?.get(sid)
    if (live !== void 0 && Array.isArray(live.events)) return live.events
  } catch { /* fallthrough */ }
  try {
    if (persistence !== void 0 && typeof persistence.loadStored === "function") {
      const stored = await persistence.loadStored(sid)
      if (stored !== void 0 && Array.isArray(stored.events)) return stored.events
    }
  } catch { /* fallthrough */ }
  return null
}

/**
 * 用默认模型总结目标会话的历史 (临时 agent, 用完即弃, 不污染会话)。
 * @returns 总结文本; 失败/无内容返回 null。
 */
async function summarizeSession(ctx, sessionId) {
  const events = await loadSessionEvents(ctx, sessionId)
  if (events === null) return null
  const history = extractHistoryText(events)
  if (history === "") return null
  const agents = ctx.get("agents")
  const defaultModel = ctx.get("agentDefaultModel")
  if (agents === void 0 || defaultModel === void 0) return null
  const selection = defaultModel.currentSelection()
  if (selection === void 0 || selection.provider === void 0 || selection.model === void 0) return null
  const agentOptions = { provider: selection.provider, model: selection.model }
  const setup = (agentCtx) => {
    installModelSelection(agentCtx, { current: selection, assembled: void 0 })
  }
  const sid = SessionId(`wechat-summarize-${randomUUID()}`)
  let agent = null
  try {
    const { agent: created } = await agents.create({
      sessionId: sid,
      meta: { cwd: process.cwd() },
      agentOptions,
      setup,
    })
    agent = created
    const prompt = [
      "请总结下面这段 DSH 会话对话的要点, 用简洁的中文输出, 3-6 条要点:",
      "- 每行一条, 以「· 」开头",
      "- 覆盖: 对话主题、已经完成的事、当前进展/结论、尚未完成或待办",
      "- 不要复述原文, 不要输出其他内容",
      "",
      "对话内容:",
      history,
    ].join("\n")
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "user" } }))
    await agent.whenIdle()
    let reply = ""
    for (const event of agent.session.events ?? []) {
      if (event.type === "assistant/message") {
        const joined = (event.data.message.content ?? [])
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("")
        if (joined !== "") reply = joined
      }
    }
    return reply === "" ? null : reply
  } catch {
    return null
  } finally {
    if (agent !== null) {
      try { await agent.dispose?.() } catch { /* ignore */ }
    }
  }
}

/**
 * 处理"切换工作区/会话/模型/权限"请求 (拦截)。返回 true 表示消息已被处理, 不再进入正常桥接。
 * 策略: 仅精确词触发; 其余消息一律进入正常聊天。
 */
async function tryHandleSwitch(ctx, chatId, text) {
  // 1) 待确认状态: 上一轮被询问, 用户回复序号/名称
  const pending = pendingSwitch.get(chatId)
  if (pending && Date.now() < pending.expiresAt) {
    if (pending.kind === "workspace") {
      // 选工作区 → 列出该工作区的会话 (无会话则直接绑定工作区)
      const ws = matchWorkspaceChoice(pending.list, text)
      if (ws === null) {
        await sendMessage(chatId, `没有找到「${String(text).trim()}」对应的工作区, 请回复序号或名称:\n${formatWorkspaceList(pending.list)}`).catch(() => {})
        return true
      }
      const sessions = ws.sessions ?? []
      if (sessions.length === 0) {
        pendingSwitch.delete(chatId)
        applyBinding(ctx, chatId, { chatId, workspace: ws.path })
        diag.lastSwitch = { at: Date.now(), chatId, action: "switch-workspace", workspace: ws.path }
        await sendMessage(chatId, `✅ 已切换到工作区: ${wsLabel(ws)}\n该工作区暂无会话, 下一条微信消息将自动创建新会话。`).catch(() => {})
        return true
      }
      pendingSwitch.set(chatId, { kind: "session", list: [ws], expiresAt: Date.now() + PENDING_SWITCH_TTL })
      await sendMessage(chatId, `📂 工作区 ${wsLabel(ws)} 下的会话, 请选择 (回复序号或标题):\n${formatSessionList([ws])}`).catch(() => {})
      return true
    }
    if (pending.kind === "session") {
      // 选会话 → 先 AI 总结目标会话, 再执行切换
      const chosen = matchSessionChoice(pending.list, text)
      if (chosen !== null) {
        // ★ 先总结目标会话 (失败不阻塞切换)
        let summary = ""
        if (chosen.sessionId) {
          try {
            summary = (await summarizeSession(ctx, chosen.sessionId)) ?? ""
          } catch {
            summary = ""
          }
        }
        pendingSwitch.delete(chatId)
        applyBinding(ctx, chatId, { chatId, workspace: chosen.workspace, sessionTitle: chosen.sessionTitle })
        diag.lastSwitch = { at: Date.now(), chatId, action: "switch", workspace: chosen.workspace, sessionTitle: chosen.sessionTitle, summarized: summary !== "" }
        const confirm = `✅ 已切换: ${wsLabel(chosen)} → 会话「${chosen.sessionTitle}」\n之后的微信消息都会进入这个会话。`
        const body = summary !== "" ? `${confirm}\n\n📝 该会话内容摘要:\n${summary}` : confirm
        await sendMessage(chatId, body).catch(() => {})
        return true
      }
      // 未匹配: 重列列表, 保留 pending
      await sendMessage(chatId, `没有找到「${String(text).trim()}」对应的会话, 请回复序号或完整标题:\n${formatSessionList(pending.list)}`).catch(() => {})
      return true
    }
    // 兜底 (未知 kind): 清除并继续
    pendingSwitch.delete(chatId)
  }
  if (pending) pendingSwitch.delete(chatId)

  // 2) 精确词触发
  const switchWord = matchSwitchWord(text)
  if (switchWord === null) return false

  // 3) 切换工作区 / 切换会话: 拉取列表
  let wsList = []
  try {
    wsList = sliceSessionList(await listWorkspaces(ctx))
  } catch {
    wsList = []
  }
  if (wsList.length === 0) {
    await sendMessage(chatId, "当前没有任何可用的工作区, 请先在 DSH 中创建工作区。").catch(() => {})
    return true
  }

  if (switchWord === "切换工作区") {
    await sendMessage(chatId, `📂 请选择要切换的工作区 (回复序号或名称):\n${formatWorkspaceList(wsList)}`).catch(() => {})
    pendingSwitch.set(chatId, { kind: "workspace", list: wsList, expiresAt: Date.now() + PENDING_SWITCH_TTL })
    return true
  }

  // 「切换会话」: 直接列全部会话
  await sendMessage(chatId, `📂 请选择要切换到的会话 (回复序号或标题):\n${formatSessionList(wsList)}`).catch(() => {})
  pendingSwitch.set(chatId, { kind: "session", list: wsList, expiresAt: Date.now() + PENDING_SWITCH_TTL })
  return true
}

/**
 * 把一条微信消息送入 (或创建) 对应 DSH 会话, 驱动 agent 回复并回发微信。
 * 绑定优先级: bindings[chatId].sessionId → bindings[chatId].workspace → defaultWorkspace → 进程 cwd。
 * @param ctx - 插件上下文 (agents / sessions / agentDefaultModel)。
 * @param input - { chatId, from, text }。
 */
async function bridgeMessage(ctx, { chatId, from, text }) {
  // ★ 切换拦截: 先判断是否为"切换工作区/会话"请求, 命中则不再进入正常桥接
  try {
    const handled = await tryHandleSwitch(ctx, chatId, text)
    if (handled) return
  } catch (error) {
    lastError = `switch: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
  }
  const agents = ctx.get("agents")
  const sessions = ctx.get("sessions")
  const defaultModel = ctx.get("agentDefaultModel")
  if (agents === void 0 || sessions === void 0 || defaultModel === void 0) {
    throw new Error("bridge: agents/sessions/agentDefaultModel 服务不可用")
  }

  diag.lastBridge = { at: Date.now(), chatId, text: text.slice(0, 50), phase: "bridge-start" }

  // ★ 门控: 必须先绑定会话才能使用微信 bot
  const binding = resolveBinding(chatId)
  if (binding === null || (!binding.sessionId && !binding.workspace)) {
    diag.lastBridge.phase = "unbound"
    await sendMessage(chatId, "🤖 请先在 DSH 设置 → 微信机器人 中绑定会话 (工作区或现有对话), 绑定后才能使用。").catch(() => {})
    return
  }

  // 串行化同一 chat 的消息
  const prev = bridgeQueues.get(chatId) ?? Promise.resolve()
  const run = prev.then(async () => {
    let agent = bridgeAgents.get(chatId)
    if (agent === void 0) {
      const selection = defaultModel.currentSelection()
      if (selection === void 0 || selection.provider === void 0 || selection.model === void 0) {
        throw new Error(`bridge: 默认模型选择不可用: ${JSON.stringify(selection)}`)
      }
      diag.lastBridge.phase = "creating-agent"
      const agentOptions = {
        provider: selection.provider,
        model: selection.model,
      }
      const setup = (agentCtx) => {
        installModelSelection(agentCtx, {
          current: selection,
          assembled: void 0,
        })
      }

      if (binding?.sessionId) {
        // 固定 sessionId 绑定: 复用其上下文
        const targetSessionId = resolveBindingSessionId(ctx, binding)
        if (targetSessionId === null) {
          throw new Error(`bridge: 绑定的会话不存在: ${binding.sessionId}, 请重新绑定`)
        }
        const sid = SessionId(targetSessionId)
        // live agent 直接复用; 持久化会话才 resume
        const liveAgent = agents.get(sid)
        if (liveAgent !== void 0) {
          agent = liveAgent
        } else {
          const existing = sessions.get(sid)
          if (existing !== void 0) {
            const { agent: resumed } = await agents.resume({
              resumeSessionId: sid,
              agentOptions,
              setup,
            })
            agent = resumed
          } else {
            throw new Error(`bridge: 绑定的会话不存在: ${targetSessionId}`)
          }
        }
      } else if (binding?.workspace && binding?.sessionTitle) {
        // 工作区+标题绑定, 且已存在同名会话 → 复用 (动态解析)
        const targetSessionId = resolveBindingSessionId(ctx, binding)
        if (targetSessionId === null) {
          throw new Error(`bridge: 绑定 (工作区+标题) 未匹配到会话: ${binding.workspace} / ${binding.sessionTitle}`)
        }
        const sid = SessionId(targetSessionId)
        const liveAgent = agents.get(sid)
        if (liveAgent !== void 0) {
          agent = liveAgent
        } else {
          const existing = sessions.get(sid)
          if (existing !== void 0) {
            const { agent: resumed } = await agents.resume({
              resumeSessionId: sid,
              agentOptions,
              setup,
            })
            agent = resumed
          } else {
            throw new Error(`bridge: 绑定的会话不存在: ${sid}`)
          }
        }
      } else {
        // 新建/默认会话: 工作区取 绑定workspace → defaultWorkspace → workspace → 进程 cwd
        const cwd = binding?.workspace || activeConfig.defaultWorkspace || activeConfig.workspace || process.cwd()
        // 确保目录存在并注册为工作区 (会话 cwd 必须在已注册工作区内)
        await ensureWorkspace(ctx, cwd)
        // 新建模式 (绑定带自定义名): 用新 UUID 会话, 与 chat_id 无关, 避免跨工作区撞车
        let sessionId
        if (binding?.sessionTitle) {
          const mapped = newSessionMap.get(chatId)
          if (mapped !== void 0) {
            sessionId = SessionId(mapped)
          } else {
            sessionId = SessionId(`wechat-${randomUUID()}`)
            newSessionMap.set(chatId, String(sessionId))
          }
        } else {
          // 默认模式: 确定性会话 (每 chat 一个)
          sessionId = sessionIdFor(chatId)
        }
        // 1) 已有 live agent → 直接复用句柄 (不能 resume 一个 live 会话!)
        const liveAgent = agents.get(sessionId)
        if (liveAgent !== void 0) {
          agent = liveAgent
        } else {
          const existing = sessions.get(sessionId)
          if (existing !== void 0) {
            // 2) 有持久化会话 → resume (恢复历史上下文)
            const { agent: resumed } = await agents.resume({
              resumeSessionId: sessionId,
              agentOptions,
              setup,
            })
            agent = resumed
          } else {
            // 3) 全新会话 → create
            const { agent: created } = await agents.create({
              sessionId,
              meta: { cwd },
              agentOptions,
              setup,
            })
            agent = created
            // 4) 若绑定带自定义会话名 → 立即设置标题
            if (binding?.sessionTitle) {
              try {
                const titleSvc = ctx.get("sessionTitle")
                if (titleSvc !== void 0 && typeof titleSvc.rename === "function") {
                  titleSvc.rename(agent.session, binding.sessionTitle)
                }
              } catch {
                // 重命名失败不阻塞
              }
            }
            // 5) 把会话挂到工作区 (GUI 左侧工作区列表才能看到)
            try {
              const registry2 = ctx.get("workspaceRegistry")
              const wsEntity = registry2?.list?.().find((w) => (w.path ?? "").replace(/[\\/]+$/, "") === cwd.replace(/[\\/]+$/, ""))
              if (wsEntity !== void 0 && typeof wsEntity.attachSession === "function") {
                await wsEntity.attachSession(String(sessionId))
              }
            } catch {
              // 挂载失败不阻塞 (workspaces 端点仍按 cwd 实时列出)
            }
          }
        }
      }
      bridgeAgents.set(chatId, agent)
    }
    diag.lastBridge.phase = "followup"
    await agent.whenIdle()
    const fromSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "user" },
    }))
    await agent.whenIdle()
    // ★ 持久化会话 (否则新建会话不出现在工作区/会话列表)
    try {
      await sessions.flush(agent.session)
    } catch {
      // flush 失败不阻塞回复
    }
    diag.lastBridge.phase = "collecting-reply"
    let reply = collectReply(agent.session.events, fromSeq)
    // 空回复兜底: agent 只调工具/未产出文本时, 回一条中性确认 (emptyReply 留空则关闭)
    if (reply === "" && activeConfig.emptyReply) {
      reply = activeConfig.emptyReply
      diag.lastBridge.fallback = true
    }
    if (reply !== "") {
      diag.lastBridge.phase = "sending-reply"
      await sendMessage(chatId, reply)
    }
    diag.lastBridge.phase = "done"
  }).catch((error) => {
    // ★ 错误必须透传, 不能静默吞掉 (否则状态页无法诊断)
    lastError = `bridge: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
    if (diag.lastBridge) diag.lastBridge.phase = "error"
  })
  const done = run.then(() => undefined, () => undefined)
  bridgeQueues.set(chatId, done)
  // 队列条目用后即清: 期间无新消息则释放 Map 条目 (防每 chat 常驻增长)
  void done.then(() => {
    if (bridgeQueues.get(chatId) === done) bridgeQueues.delete(chatId)
  })
  return run
}

/** 渲染状态页 HTML。 */
function renderStatusPage() {
  const state = {
    status: botStatus,
    user: loginAccount?.userId ?? null,
    error: lastError,
    qrcode: qrcodeDataUrl,
    inboxCount: inbox.length,
  }
  const stateJson = JSON.stringify(state).replace(/</g, "\\u003c")
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<title>微信机器人 - DSH</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f5f6f7; display: flex; justify-content: center; padding: 40px 16px; }
  .card { background: #fff; border-radius: 16px; padding: 32px; box-shadow: 0 4px 20px rgba(0,0,0,.08); max-width: 420px; width: 100%; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 13px; margin: 8px 0 16px; }
  .badge.idle, .badge.error, .badge.token-expired { background: #fee2e2; color: #b91c1c; }
  .badge.waiting-scan, .badge.starting, .badge.scanned { background: #fef3c7; color: #92400e; }
  .badge.logged-in { background: #dcfce7; color: #166534; }
  .qrcode img { width: 260px; height: 260px; border-radius: 8px; }
  .hint { font-size: 13px; color: #888; margin-top: 16px; }
  .error { font-size: 13px; color: #b91c1c; margin-top: 12px; word-break: break-all; }
  .user { font-size: 15px; font-weight: 600; margin-top: 8px; }
  .row { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }
  button { border: 1px solid #d0d5dd; background: #fff; border-radius: 8px; padding: 8px 16px; cursor: pointer; font-size: 14px; }
  button.primary { background: #07c160; border-color: #07c160; color: #fff; }
</style>
</head>
<body>
<div class="card">
  <h1>🤖 微信机器人</h1>
  <div id="badge" class="badge">加载中…</div>
  <div class="qrcode" id="qrcode"></div>
  <div class="user" id="user"></div>
  <div class="error" id="error"></div>
  <div class="hint" id="hint"></div>
  <div class="row">
    <button id="login" class="primary">获取二维码</button>
  </div>
</div>
<script>
const initial = ${stateJson};
const $ = (id) => document.getElementById(id);
const STATUS_TEXT = { idle: "未登录", starting: "启动中…", "waiting-scan": "等待扫码", scanned: "已扫码, 请在手机上确认", "logged-in": "已登录", "token-expired": "⚠ 会话已过期", error: "错误" };
async function refresh() {
  try {
    const r = await fetch(location.pathname + "/json", { headers: { accept: "application/json" } });
    if (r.ok) render(await r.json());
  } catch {}
}
function render(s) {
  const badge = $("badge");
  badge.textContent = STATUS_TEXT[s.status] ?? s.status;
  badge.className = "badge " + s.status;
  $("user").textContent = s.user ? "Bot ID: " + s.user : "";
  if (s.status === "waiting-scan" && s.qrcode) {
    $("qrcode").innerHTML = '<img src="' + s.qrcode + '" alt="微信扫码登录" />';
    $("hint").textContent = "使用微信扫一扫, 创建/绑定 Bot 助手 (8 分钟内有效)";
  } else {
    $("qrcode").innerHTML = "";
    $("hint").textContent =
      s.status === "logged-in" ? "已登录, 消息将自动接入 DSH" :
      s.status === "token-expired" ? "token 已失效, 点击下方按钮获取新二维码重新登录" : "";
  }
  $("error").textContent = s.error ?? "";
}
$("login").addEventListener("click", async () => {
  await fetch(location.pathname + "/login", { method: "POST" });
  setTimeout(refresh, 500);
});
render(initial);
setInterval(refresh, 3000);
</script>
</body>
</html>`
}

/**
 * 设置 schema (GUI「设置 → 插件配置」中编辑, 实时生效, 覆盖组合配置)。
 */
const WECHAT_BOT_SETTINGS_NS = settingsNamespace("wechat-bot")
const SettingsConfig = z.object({
  statusPath: z.string().default(DEFAULT_STATUS_PATH),
  autoReply: z.string().default(""),
  bridge: z.boolean().default(true),
  workspace: z.string().default(""),
  defaultWorkspace: z.string().default(""),
  // 空回复兜底: agent 未产出文本时回的中性确认 (留空 = 关闭)
  emptyReply: z.string().default(""),
  // 绑定条目实际是三选一: sessionId (固定) / workspace (新建) / workspace+sessionTitle (动态),
  // 除 chatId 外均为可选, 与 /bind 与 GUI 写入的数据结构一致
  bindings: z.array(z.object({
    chatId: z.string(),
    workspace: z.string().required(false),
    sessionId: z.string().required(false),
    sessionTitle: z.string().required(false),
  })).default([]),
})

/**
 * 插件主入口。
 * @param ctx - 注册上下文。
 * @param config - 组合配置。
 */
export function apply(ctx, config = {}) {
  // 组合配置作为 base; 设置页 (settings.yaml / GUI) 覆盖之, 实时生效
  activeConfig = {
    statusPath: (config.statusPath ?? DEFAULT_STATUS_PATH).trim() || DEFAULT_STATUS_PATH,
    autoReply: (config.autoReply ?? "").trim(),
    pollMs: Number(config.pollMs) > 0 ? Number(config.pollMs) : 1000,
    bridge: config.bridge !== false,
    workspace: (config.workspace ?? "").trim() || process.cwd(),
    defaultWorkspace: (config.defaultWorkspace ?? "").trim(),
    emptyReply: (config.emptyReply ?? "").trim(),
    bindings: Array.isArray(config.bindings) ? config.bindings : [],
  }
  installSettingsSection(ctx, WECHAT_BOT_SETTINGS_NS, SettingsConfig, config, {
    setSource: (source) => {
      // 设置值覆盖组合配置 (未设置的字段回退到组合配置)
      activeConfig = {
        ...activeConfig,
        statusPath: source().statusPath ?? activeConfig.statusPath,
        autoReply: source().autoReply ?? activeConfig.autoReply,
        bridge: source().bridge ?? activeConfig.bridge,
        workspace: source().workspace?.trim() || activeConfig.workspace,
        defaultWorkspace: source().defaultWorkspace?.trim() || activeConfig.defaultWorkspace,
        emptyReply: source().emptyReply ?? activeConfig.emptyReply,
        bindings: source().bindings ?? activeConfig.bindings,
      }
    },
    onChange: () => {},
    validate: () => {},
  })
  const statusPath = activeConfig.statusPath

  // 启动时: 有已保存账号则直接登录, 否则 idle (页面可点获取二维码)
  const saved = loadAccount("default") ?? loadAnyAccount()
  if (saved) {
    loginAccount = { accountId: saved.accountId ?? "default", token: saved.token, baseUrl: saved.baseUrl || DEFAULT_ILINK_API, userId: saved.userId ?? "" }
    botStatus = "logged-in"
    startPollLoop(ctx)
  }

  // ---- 状态页 / JSON / 登录路由 ----
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://dsh.local")
      const pathname = url.pathname
      if (pathname.endsWith("/json")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({
          status: botStatus,
          user: loginAccount?.userId ?? null,
          error: lastError,
          qrcode: qrcodeDataUrl,
          inboxCount: inbox.length,
          bindings: activeConfig.bindings,
          diag,
        }))
        return
      }
      if (pathname.endsWith("/login") && req.method === "POST") {
        await readBody(req)
        await startLogin(ctx)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true, status: botStatus }))
        return
      }
      if (pathname.endsWith("/workspaces") && req.method === "GET") {
        // 列出工作区及其会话 (实时: 用 sessionPersistence.list 覆盖新建会话)
        const out = await listWorkspaces(ctx)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true, workspaces: out }))
        return
      }
      if (pathname.endsWith("/bind") && req.method === "POST") {
        // 绑定 chat → 会话 (更新内存 + 持久化 settings.yaml)
        const body = await readBody(req)
        let payload
        try {
          payload = JSON.parse(body.toString("utf8"))
        } catch {
          res.writeHead(400, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: false, message: "bad json" }))
          return
        }
        const chatId = String(payload.chatId ?? "").trim()
        // 支持两种绑定: sessionId (固定) 或 workspace+sessionTitle (动态)
        const sessionId = String(payload.sessionId ?? "").trim()
        const workspace = String(payload.workspace ?? "").trim()
        const sessionTitle = String(payload.sessionTitle ?? "").trim()
        if (!chatId) {
          res.writeHead(400, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: false, message: "chatId 必填 (请先给机器人发一条消息以识别你的微信)" }))
          return
        }
        // 校验: sessionId (固定) / workspace (新建会话) / workspace+sessionTitle (动态) 三选一
        if (!sessionId && !workspace) {
          res.writeHead(400, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: false, message: "需要 sessionId, 或 workspace (新建), 或 workspace+sessionTitle" }))
          return
        }
        const entry = { chatId }
        if (sessionId) entry.sessionId = sessionId
        if (workspace) entry.workspace = workspace
        if (sessionTitle) entry.sessionTitle = sessionTitle
        applyBinding(ctx, chatId, entry)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true, bindings: activeConfig.bindings }))
        return
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(renderStatusPage())
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" })
      res.end(error instanceof Error ? error.message : "internal error")
    }
  }
  ctx.webServer.register({ kind: "prefix", path: statusPath, handler })

  // ---- 工具 ----
  ctx.tools.register({
    name: "wechat_status",
    description: "查询微信机器人登录状态。返回 { status, user, error, hasQrcode, statusPath }。status: idle/starting/waiting-scan/scanned/logged-in/error。用户问「微信机器人登没登 / 扫码 / 二维码」时使用。",
    parameters: { type: "object", properties: {} },
    output: {
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          status: { type: "string" },
          user: { oneOf: [{ type: "string" }, { type: "null" }] },
          error: { oneOf: [{ type: "string" }, { type: "null" }] },
          hasQrcode: { type: "boolean" },
          statusPath: { type: "string" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    async execute() {
      return {
        ok: true,
        status: botStatus,
        user: loginAccount?.userId ?? null,
        error: lastError,
        hasQrcode: qrcodeDataUrl !== null,
        statusPath,
      }
    },
  })

  ctx.tools.register({
    name: "wechat_send",
    description: "通过已登录的微信机器人 (iLink Bot) 给微信用户/群发送一条文本消息。to 是对方 chat_id (来自 wechat_read_inbox 的消息)。返回 { ok, message }。",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "接收者 chat_id" },
        content: { type: "string", description: "要发送的文本内容" },
      },
      required: ["to", "content"],
    },
    output: {
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          message: { type: "string" },
        },
        required: ["ok", "message"],
        additionalProperties: false,
      },
    },
    async execute(args) {
      if (loginAccount === null || botStatus !== "logged-in") {
        return result(false, `微信机器人未登录 (状态: ${botStatus}), 请先访问 ${statusPath} 扫码登录`)
      }
      try {
        await sendMessage(String(args.to ?? "").trim(), String(args.content ?? ""))
        return result(true, "已发送")
      } catch (error) {
        return result(false, error instanceof Error ? error.message : String(error))
      }
    },
  })

  ctx.tools.register({
    name: "wechat_read_inbox",
    description: "读取微信机器人收到的最近消息 (最多 200 条, 新消息在前)。包含 from/chatId/content/time。chatId 可用于 wechat_send 回复。",
    parameters: { type: "object", properties: {} },
    output: {
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from: { type: "string" },
                chatId: { type: "string" },
                content: { type: "string" },
                time: { type: "integer" },
              },
            },
          },
        },
        required: ["ok", "messages"],
      },
    },
    async execute() {
      return { ok: true, messages: [...inbox].reverse() }
    },
  })

  // ---- 绑定工具 ----
  ctx.tools.register({
    name: "wechat_bind",
    description: "把某个微信 chat_id 绑定到指定工作区 (workspace) 或现有会话 (sessionId)。绑定后该微信聊天将复用目标会话/工作区, 而不是默认的独立会话。chatId 来自 wechat_read_inbox。返回 { ok, message }。",
    parameters: {
      type: "object",
      properties: {
        chatId: { type: "string", description: "微信 chat_id (来自 inbox)" },
        workspace: { type: "string", description: "目标工作区绝对路径 (绑定后新会话创建在该目录); 与 sessionId 二选一" },
        sessionId: { type: "string", description: "目标现有会话 id (复用其上下文); 与 workspace 二选一" },
      },
      required: ["chatId"],
    },
    output: {
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          message: { type: "string" },
        },
        required: ["ok", "message"],
        additionalProperties: false,
      },
    },
    async execute(args) {
      const chatId = String(args.chatId ?? "").trim()
      if (!chatId) return result(false, "chatId 不能为空")
      const entry = { chatId }
      if (args.sessionId) entry.sessionId = String(args.sessionId).trim()
      if (args.workspace) entry.workspace = String(args.workspace).trim()
      if (!entry.sessionId && !entry.workspace) return result(false, "必须提供 workspace 或 sessionId 之一")
      // 更新绑定表 (替换同 chatId 的旧条目)
      const rest = activeConfig.bindings.filter((b) => b.chatId !== chatId)
      activeConfig.bindings = [...rest, entry]
      // 若该 chat 已有运行中的 agent, 重置以便下次按新绑定重连
      const existing = bridgeAgents.get(chatId)
      if (existing !== void 0) {
        bridgeAgents.delete(chatId)
        try {
          await existing.dispose?.()
        } catch {
          // ignore
        }
      }
      return result(true, `已绑定 ${chatId} → ${entry.sessionId ? `会话 ${entry.sessionId}` : `工作区 ${entry.workspace}`} (重启后仍生效需写入 cordis.patch.yml)`)
    },
  })

  ctx.tools.register({
    name: "wechat_sessions",
    description: "列出当前可用的 DSH 会话 (id + 工作目录), 供 wechat_bind 选择绑定目标 (例如绑定到当前对话)。返回 { ok, sessions }。",
    parameters: { type: "object", properties: {} },
    output: {
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          sessions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                cwd: { type: "string" },
              },
            },
          },
        },
        required: ["ok", "sessions"],
      },
    },
    async execute() {
      const sessions = ctx.get("sessions")
      if (sessions === void 0) return result(false, "sessions 服务不可用")
      const live = sessions.list()
      const list = live.map((s) => ({ id: String(s.id), cwd: s.header?.cwd ?? "" }))
      return { ok: true, sessions: list }
    },
  })

  // ---- 系统提示 ----
  ctx.systemPrompt.section({
    name: "plugin:wechat-bot",
    order: 241,
    text: `本机已安装 dsh-wechat-bot 插件（微信扫码机器人, 基于官方 iLink Bot API）。能力：wechat_status 查登录状态、wechat_send 给微信用户/群发消息（to 用 chat_id）、wechat_read_inbox 读收到的消息（含 chat_id 可回复）、wechat_sessions 列出可选会话、wechat_bind 把微信 chat 绑定到指定工作区或现有会话；二维码登录页在 ${statusPath}。用户提到「微信 / 个人微信 / 扫码登录微信 / 给微信好友发消息 / 把微信绑到当前对话」时即指本插件，请据此协作。`,
  })

  // ---- 卸载清理: 停轮询 (代际失效), 释放桥接 agent ----
  ctx.on("dispose", () => {
    pollGen += 1
    loginPollGen += 1
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null }
    if (loginPollTimer !== null) { clearTimeout(loginPollTimer); loginPollTimer = null }
    for (const agent of bridgeAgents.values()) {
      try { agent.dispose?.() } catch { /* ignore */ }
    }
    bridgeAgents.clear()
    bridgeQueues.clear()
    pendingSwitch.clear()
  })
}
