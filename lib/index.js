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
import { createHash, randomBytes, randomUUID, createDecipheriv } from "node:crypto"
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
const WX_ITEM_VOICE = 3 // item.type === 3 → voice_item
const WX_MSG_TYPE_BOT = 2
/** iLink 媒体 CDN 基址 (下载 = {cdn}/download?encrypted_query_param=...)。 */
const ILINK_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c"
/** 语音默认配置。 */
const DEFAULT_ASR_MODEL = "mimo-v2.5-asr"
const DEFAULT_ASR_BASE_URL = "https://api.xiaomimimo.com/v1"
const DEFAULT_ASR_KEY_ENV = "XIAOMI_API_KEY"
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
/** 默认工作区根目录: $DSH_HOME/proj (不存在时自动创建)。 */
const DEFAULT_ROOT_DIR = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "proj")

let activeConfig = { statusPath: DEFAULT_STATUS_PATH, autoReply: "", pollMs: 1000, bridge: true, emptyReply: "", rootDir: DEFAULT_ROOT_DIR, bindings: [], asrEnabled: true, asrModel: DEFAULT_ASR_MODEL, asrBaseUrl: DEFAULT_ASR_BASE_URL, asrKeyEnv: DEFAULT_ASR_KEY_ENV, asrLanguage: "auto" }
/** settings 服务引用 (apply 时注入; 无 settings 提供方时为 null, 保存走 YAML 回退)。 */
let settingsService = null
let contextTokens = new Map() // chatId -> context_token
/** chatId → 新建模式创建的会话 id (保证后续消息复用同一会话)。 */
let newSessionMap = new Map()
let updatesBuf = ""
let lastUpdateId = 0

/** 持久化会话标题缓存 (避免 /workspaces 每 5s 轮询反复 loadStored 解压)。 */
const titleCache = new Map() // sessionId -> { title, at }
const TITLE_CACHE_TTL = 30_000

// ---- 诊断状态 (状态页 /json 输出) ----
let diag = { pollCount: 0, lastPollAt: 0, lastPollMsgs: 0, lastPollError: null, lastPollResp: null, tokenExpiredAt: null, lastSwitch: null, lastVoice: null, lastVoiceRaw: null }

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
      ...(e.provider ? [`      provider: '${esc(e.provider)}'`] : []),
      ...(e.model ? [`      model: '${esc(e.model)}'`] : []),
      ...(e.reasoningEffort ? [`      reasoningEffort: '${esc(e.reasoningEffort)}'`] : []),
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

/** GUI 保存允许修改的键 (其余键一律丢弃)。 */
const SETTINGS_PATCH_KEYS = new Set(["statusPath", "autoReply", "bridge", "emptyReply", "rootDir", "bindings", "asrEnabled", "asrModel", "asrBaseUrl", "asrKeyEnv", "asrLanguage"])

/**
 * 无 settings 服务时的回退: 直接把整个 wechat-bot 段写回 settings.yaml。
 * 仅在该部署没有 settings 提供方 (settings.yaml 无人并发读写) 时走到。
 */
function persistSettingsPatchYaml(patch) {
  const sp = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "settings.yaml")
  let cleaned = ""
  try {
    const raw = readFileSync(sp, "utf8")
    cleaned = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
  } catch {
    // 文件不存在: 稍后整段写入
  }
  const esc = (v) => String(v).replace(/'/g, "''")
  const merged = { ...activeConfig, ...patch }
  const scalars = []
  if (merged.statusPath && merged.statusPath !== DEFAULT_STATUS_PATH) scalars.push(`  statusPath: '${esc(merged.statusPath)}'`)
  if (merged.autoReply) scalars.push(`  autoReply: '${esc(merged.autoReply)}'`)
  scalars.push(`  bridge: ${merged.bridge === false ? "false" : "true"}`)
  if (merged.emptyReply) scalars.push(`  emptyReply: '${esc(merged.emptyReply)}'`)
  if (merged.rootDir) scalars.push(`  rootDir: '${esc(merged.rootDir)}'`)
  if (merged.asrEnabled === false) scalars.push(`  asrEnabled: false`)
  if (merged.asrModel) scalars.push(`  asrModel: '${esc(merged.asrModel)}'`)
  if (merged.asrBaseUrl) scalars.push(`  asrBaseUrl: '${esc(merged.asrBaseUrl)}'`)
  if (merged.asrKeyEnv) scalars.push(`  asrKeyEnv: '${esc(merged.asrKeyEnv)}'`)
  if (merged.asrLanguage) scalars.push(`  asrLanguage: '${esc(merged.asrLanguage)}'`)
  const bindings = Array.isArray(merged.bindings) ? merged.bindings : []
  const block = [
    ...scalars,
    ...(bindings.length
      ? [`  bindings:`, ...bindings.map((e) => [
          `    - chatId: '${esc(e.chatId ?? "")}'`,
          ...(e.sessionId ? [`      sessionId: '${esc(e.sessionId)}'`] : []),
          ...(e.workspace ? [`      workspace: '${esc(e.workspace)}'`] : []),
          ...(e.sessionTitle ? [`      sessionTitle: '${esc(e.sessionTitle)}'`] : []),
          ...(e.provider ? [`      provider: '${esc(e.provider)}'`] : []),
          ...(e.model ? [`      model: '${esc(e.model)}'`] : []),
          ...(e.reasoningEffort ? [`      reasoningEffort: '${esc(e.reasoningEffort)}'`] : []),
        ].join("\n"))]
      : []),
  ].join("\n")
  const section = `wechat-bot:\n${block}\n`
  const lines = cleaned.split(/\r?\n/)
  let secStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^wechat-bot:\s*$/.test(lines[i])) { secStart = i; break }
  }
  if (secStart === -1) {
    writeFileSync(sp, (cleaned ? cleaned.replace(/\s*$/, "\n") : "") + section, "utf8")
    return
  }
  let secEnd = lines.length
  for (let i = secStart + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === "" || /^\s*#/.test(l)) continue
    if (!/^\s/.test(l)) { secEnd = i; break }
  }
  writeFileSync(sp, [...lines.slice(0, secStart), section.trimEnd(), ...lines.slice(secEnd)].join("\n"), "utf8")
}

/**
 * 应用 GUI 保存的配置补丁。优先走 DSH settings 服务 (schema 校验 + 持久化 +
 * 热生效, 不受 Web 客户端命名空间白名单限制 — 那是只挡浏览器通道的边界),
 * 无 settings 服务时回退为直接写 settings.yaml 并同步内存配置。
 * @param patch - 仅含 SETTINGS_PATCH_KEYS 的字段。
 */
async function applySettingsPatch(patch) {
  const clean = {}
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!SETTINGS_PATCH_KEYS.has(key)) continue
    if (key === "bindings" && !Array.isArray(value)) continue
    clean[key] = value
  }
  if (Object.keys(clean).length === 0) return { ok: true, config: activeConfig }
  if (settingsService) {
    try {
      await settingsService.update("wechat-bot", clean)
      // commit() 在写队列内同步完成, get() 立即返回新解析值 (无需等 watcher 微任务)
      const resolved = settingsService.get("wechat-bot")
      if (resolved) {
        activeConfig = {
          ...activeConfig,
          statusPath: resolved.statusPath ?? activeConfig.statusPath,
          autoReply: resolved.autoReply ?? activeConfig.autoReply,
          bridge: resolved.bridge ?? activeConfig.bridge,
          emptyReply: resolved.emptyReply ?? activeConfig.emptyReply,
          rootDir: resolved.rootDir?.trim() || activeConfig.rootDir,
          bindings: resolved.bindings ?? activeConfig.bindings,
        }
      }
      return { ok: true, config: activeConfig }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
  try {
    persistSettingsPatchYaml(clean)
    activeConfig = { ...activeConfig, ...clean }
    return { ok: true, config: activeConfig }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
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
        let text = items
          .filter((item) => item.type === WX_ITEM_TEXT && item.text_item && item.text_item.text)
          .map((item) => item.text_item.text)
          .join("\n")
        // ★ 语音消息: 转写 (服务端自带文本优先, 否则 mimo ASR) 并拼入 text
        if (items.some((item) => item?.type === WX_ITEM_VOICE)) {
          const voices = await transcribeVoiceItems(bridgeCtx, msg)
          // 诊断: 记录原始语音 item 结构 (前 800 字符), 便于排查字段/编码问题
          try {
            const raw = items.find((item) => item?.type === WX_ITEM_VOICE)
            diag.lastVoiceRaw = JSON.stringify(raw ?? null).slice(0, 800)
          } catch { diag.lastVoiceRaw = "(dump failed)" }
          diag.lastVoice = voices.map((vv) => ({ via: vv.via, text: (vv.text ?? "").slice(0, 50), ...(vv.message ? { message: vv.message } : {}) }))
          const vt = voices.filter((vv) => vv.text).map((vv) => vv.text).join("\n")
          if (vt) {
            text = text ? `${text}\n[语音转文字] ${vt}` : `[语音转文字] ${vt}`
          } else if (text === "" && voices.length > 0) {
            // 纯语音且全部转写失败 → 提示并跳过
            const errs = voices.map((vv) => vv.message).filter(Boolean).join("; ") || "未知原因"
            inbox.push({ from: fromName, chatId, content: `[语音转写失败: ${errs}]`, time: Date.now() })
            await sendMessage(chatId, `🎤 收到语音, 但转写失败: ${errs}\n(设置 → 微信机器人 → 语音输入可调整识别参数, 或改发文字。)`).catch(() => {})
            continue
          }
        }
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
/** chat_id → 已推送的模型覆盖 key ("provider/model/effort"), 避免每条消息重复推。 */
const appliedOverrideKey = new Map()

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
const SWITCH_WORDS = ["切换会话", "切换工作区", "新增工作区", "新增会话", "切换模型", "当前工作区", "当前会话", "当前模型", "统计用量"]
/** 去掉尾部标点/空白后返回命中的切换词 (容忍 "切换会话。"、"切换会话!" 等), 未命中返回 null。 */
function matchSwitchWord(text) {
  const t = String(text ?? "").trim().replace(/[。！!？?，,.\s]+$/g, "")
  return SWITCH_WORDS.find((w) => w === t) ?? null
}

/** 推理等级选项 (deepseek adapter 支持 off/high/max)。 */
const REASONING_EFFORTS = [
  { id: "off", name: "off (关闭思考)" },
  { id: "high", name: "high (高)" },
  { id: "max", name: "max (最高)" },
]

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
  // 若该 chat 有运行中 agent, 重置以便下次按新绑定重连 (真正 dispose 以移出 live 注册表)
  void disposeBridgeAgent(chatId)
  return entries
}

/** 列出可用模型 (provider/模型名), 供「切换模型」选择。 */
async function listModels(ctx) {
  const llm = ctx.get("llm")
  if (llm === void 0 || typeof llm.listProviders !== "function") return []
  const out = []
  try {
    const providers = llm.listProviders()
    for (const p of providers) {
      const pid = String(p.id ?? p.provider ?? "")
      if (!pid) continue
      let models = []
      try {
        if (typeof llm.listModels === "function") {
          models = (await llm.listModels(pid)) ?? []
        }
      } catch {
        models = []
      }
      if (models.length === 0) {
        // adapter 未实现模型目录时, 退化为一个占位条目
        out.push({ provider: pid, id: "", name: pid })
        continue
      }
      for (const m of models) {
        const entry = { provider: pid, id: String(m.id ?? ""), name: String(m.name ?? m.id ?? "") }
        // 采集该模型支持的推理等级 (mimo 等模型不支持 max; 用于「切换模型」过滤)
        try {
          if (typeof llm.resolveModelInfo === "function") {
            const info = await llm.resolveModelInfo(pid, entry.id)
            if (Array.isArray(info?.reasoning?.efforts)) {
              entry.efforts = info.reasoning.efforts.map((e) => String(e.id ?? "")).filter(Boolean)
            } else if (info?.reasoning === false) {
              entry.efforts = []
            }
          }
        } catch { /* 未知等级列表: 缺省用默认选项, 应用时再校验 */ }
        out.push(entry)
      }
    }
  } catch {
    // ignore
  }
  return out
}

/** 格式化模型列表。 */
function formatModelList(models) {
  if ((models ?? []).length === 0) return "(没有可用的模型)"
  return models.map((m, i) => `${i + 1}. ${m.provider} / ${m.name}`).join("\n")
}

/**
 * 该模型「切换模型」可选的推理等级列表 (按模型支持过滤, 未知则用默认列表)。
 * - efforts 为空数组 → 无推理等级可选 (直接应用模型, 不询问)
 * - efforts 有值 → 只列模型支持的等级 (始终允许 off = 关闭思考)
 * - efforts 未知 (undefined) → 用默认 off/high/max, 应用时再校验
 */
function effortOptions(m) {
  const supported = Array.isArray(m?.efforts) ? m.efforts : null
  if (supported === null) return REASONING_EFFORTS
  if (supported.length === 0) return []
  const pool = REASONING_EFFORTS.filter((e) => supported.includes(e.id) || e.id === "off")
  return pool
}

/** 按 序号 / 名称 匹配模型选择。 */
function matchModelChoice(models, text) {
  const t = String(text ?? "").trim()
  if (/^\d+$/.test(t)) {
    const i = Number(t) - 1
    return (models ?? [])[i] ?? null
  }
  const norm = (x) => String(x ?? "").toLowerCase().replace(/\s+/g, "")
  const tn = norm(t)
  if (!tn) return null
  for (const m of models ?? []) {
    if (norm(m.name) === tn || norm(m.id) === tn || norm(m.provider) === tn) return m
  }
  for (const m of models ?? []) {
    const sn = norm(m.name)
    if (sn && (sn.includes(tn) || tn.includes(sn))) return m
  }
  return null
}

/**
 * 更新当前 chat 的绑定字段 (保留 workspace/sessionId, 只改模型/推理等级等)。
 * 持久化并重置桥接 agent (下条消息按新设置重连)。
 */
/**
 * 释放某 chat 的桥接 agent (从 bridgeAgents 移除, 并真正 dispose 其 AgentHandle,
 * 使该 agent 从 DSH live 注册表注销 — 否则切模型/会话后旧 agent 仍被 agents.get 复用)。
 */
function disposeBridgeAgent(chatId) {
  const existing = bridgeAgents.get(chatId)
  if (existing === void 0) return Promise.resolve()
  bridgeAgents.delete(chatId)
  if (typeof existing.dispose === "function") {
    try {
      return Promise.resolve(existing.dispose()).catch(() => {})
    } catch {
      return Promise.resolve()
    }
  }
  return Promise.resolve()
}

function updateBinding(ctx, chatId, patch) {
  const pending = disposeBridgeAgent(chatId)
  appliedOverrideKey.delete(chatId) // 绑定/模型变了 → 下条消息重新推送覆盖
  const rest = activeConfig.bindings.filter((b) => b.chatId !== chatId)
  const cur = activeConfig.bindings.find((b) => b.chatId === chatId)
  const entry = { ...(cur ?? { chatId }), ...patch }
  const entries = [...rest, entry]
  activeConfig.bindings = entries
  try {
    persistBindings(entries)
  } catch (error) {
    // 持久化失败不阻塞 (内存已生效)
  }
  return pending.then(() => entry)
}

/**
 * 应用「切换模型」最终选择: 校验模型/推理等级 → 写入绑定 → 立即推送会话级选择。
 * 若 model 不支持用户选的推理等级 (如 mimo 不支持 max), 降级为模型默认等级并注明。
 * @param m - 模型条目 { provider, id, name }。
 * @param effId - 用户选择的推理等级 id, 或 undefined (模型无等级 / 直接应用)。
 */
async function applyModelSelectionToChat(ctx, chatId, m, effId) {
  const llm = ctx.get("llm")
  let resolvedEffort = effId ?? void 0
  let effortDropped = false
  if (resolvedEffort) {
    let supported = false
    try {
      const cfg = await llm?.resolveCallConfig?.({ provider: m.provider, model: m.id, reasoningEffort: resolvedEffort })
      supported = Boolean(cfg)
    } catch { supported = false }
    if (!supported) {
      // 该模型不支持此等级 → 去掉等级重试 (模型仍切换)
      try {
        const cfg = await llm?.resolveCallConfig?.({ provider: m.provider, model: m.id })
        supported = Boolean(cfg)
        resolvedEffort = void 0
        effortDropped = true
      } catch {
        supported = false
      }
      if (!supported) {
        await sendMessage(chatId, `❌ 模型 ${m.provider} / ${m.name} 当前不可用, 未切换。`).catch(() => {})
        return
      }
    }
  } else {
    // 未指定等级: 校验模型本身可用 (不可用则报错)
    try {
      const cfg = await llm?.resolveCallConfig?.({ provider: m.provider, model: m.id })
      if (!cfg) throw new Error("unresolvable")
    } catch {
      await sendMessage(chatId, `❌ 模型 ${m.provider} / ${m.name} 当前不可用, 未切换。`).catch(() => {})
      return
    }
  }
  const patch = { provider: m.provider, model: m.id }
  if (resolvedEffort) patch.reasoningEffort = resolvedEffort
  await updateBinding(ctx, chatId, patch)
  diag.lastSwitch = { at: Date.now(), chatId, action: "switch-model", provider: m.provider, model: m.id, ...(resolvedEffort ? { reasoningEffort: resolvedEffort } : {}) }
  // 目标会话已 live 时立即推送会话级共享模型选择 (GUI 即时同步)
  try {
    const b2 = resolveBinding(chatId)
    const sid2 = b2 === null ? null : resolveBindingSessionId(ctx, b2)
    if (sid2 !== null) {
      const pushed = await applyModelOverrideToSession(ctx, sid2, { provider: m.provider, model: m.id, ...(resolvedEffort ? { reasoningEffort: resolvedEffort } : {}) })
      if (pushed) appliedOverrideKey.set(chatId, `${m.provider}/${m.id}/${resolvedEffort ?? ""}`)
    }
  } catch { /* 会话未 live / 解析失败: 下条消息再推 */ }
  const effText = resolvedEffort ? resolvedEffort : "默认"
  const note = effortDropped ? `\n(该模型不支持推理等级 ${effId}, 已使用其默认等级)` : ""
  await sendMessage(chatId, `✅ 已切换模型: ${m.provider} / ${m.name}\n推理等级: ${effText}${note}\n之后的微信消息将使用该模型。`).catch(() => {})
}

/**
 * 把 binding 的模型覆盖推送到“会话级共享模型选择” — 走与 GUI 换模型完全相同的机制
 * (session.selectModel → apiproxy 的 selectionFor(agent).current), 因此无论 live
 * agent 由 GUI 还是桥接创建, 下次请求都会用新模型, GUI 也会同步显示。
 * 优先直连 ctx.apiProxy.agents.selectModel (部分版本暴露), 否则回退到浏览器同款
 * HTTP RPC 传线 (POST /api/session.selectModel)。selectModel 会把该模型顺手存为全局
 * 默认, 这里随后恢复原全局默认, 保持 per-chat 语义。
 * @returns true 表示已成功推送。
 */
async function applyModelOverrideToSession(ctx, sessionId, override) {
  const defaultModelSvc = ctx.get("agentDefaultModel")
  let prevDefault = null
  try { prevDefault = defaultModelSvc?.currentSelection?.() ?? null } catch { prevDefault = null }
  // 先带等级试一次; 若模型不支持该等级 (如 mimo 不支持 max) 或失败, 去掉等级再试
  const attempts = []
  if (override.reasoningEffort) {
    attempts.push({
      sessionId: String(sessionId),
      provider: override.provider,
      model: override.model,
      reasoningEffort: String(override.reasoningEffort),
    })
  }
  attempts.push({
    sessionId: String(sessionId),
    provider: override.provider,
    model: override.model,
  })
  let applied = false
  for (const payload of attempts) {
    if (applied) break
    // 1) 直连 apiProxy 服务 (若暴露 agents 域)
    try {
      const apiProxy = ctx.get("apiProxy")
      if (apiProxy !== void 0 && typeof apiProxy?.agents?.selectModel === "function") {
        const resp = await apiProxy.agents.selectModel({ rpcId: `wechat-model-${randomUUID()}`, payload })
        applied = resp?.result?.ok === true && resp?.result?.value?.selected !== void 0
      }
    } catch { applied = false }
    // 2) 回退: 浏览器同款 HTTP RPC 传线
    if (!applied) {
      try {
        const port = ctx.get("webServer")?.port ?? 3080
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 8000)
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/api/session.selectModel`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              type: "client-request",
              rpcId: `wechat-model-${randomUUID()}`,
              method: "session.selectModel",
              payload,
            }),
            signal: controller.signal,
          })
          const data = await resp.json().catch(() => null)
          applied = data?.result?.ok === true && data?.result?.value?.selected !== void 0
        } finally {
          clearTimeout(timer)
        }
      } catch { applied = false }
    }
  }
  // selectModel 会把该模型顺手存为全局默认 → 恢复原默认, 保持 per-chat 语义
  if (applied && prevDefault !== null && prevDefault.provider && prevDefault.model &&
      defaultModelSvc !== void 0 && typeof defaultModelSvc.saveSelection === "function") {
    try {
      await defaultModelSvc.saveSelection({
        provider: prevDefault.provider,
        model: prevDefault.model,
        ...(prevDefault.reasoningEffort ? { reasoningEffort: prevDefault.reasoningEffort } : {}),
      })
    } catch { /* 恢复失败不阻塞 */ }
  }
  return applied
}

/** Windows/文件系统非法字符 (工作区名用作目录名)。 */
const INVALID_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/

// ================= 微信语音 → ASR 转文本 =================

/**
 * 读 ASR 的 key: 优先 DSH credentials 服务 ("dsh 系统中的 mimo api key"),
 * 回退环境变量, 再回退直接读 ~/.dsh/.credentials.yaml。
 * @param envName - key 的引用名 (默认 XIAOMI_API_KEY)。
 */
async function resolveAsrKey(ctx, envName) {
  const ref = String(envName || DEFAULT_ASR_KEY_ENV)
  try {
    const creds = ctx.get("credentials")
    if (creds !== void 0 && typeof creds.resolve === "function") {
      const r = await creds.resolve(ref)
      if (r?.value) return r.value
    }
  } catch { /* 走回退 */ }
  try {
    if (process.env[ref]) return process.env[ref]
  } catch { /* ignore */ }
  try {
    const sp = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".credentials.yaml")
    const raw = readFileSync(sp, "utf8")
    const cleaned = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
    const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const m = cleaned.match(new RegExp("(?:^|\\n)" + esc + "\\s*:\\s*([^\\r\\n]+)"))
    if (m) return m[1].trim()
  } catch { /* ignore */ }
  return null
}

/** 用语音模型 (mimo-v2.5-asr) 把音频字节转成文本 (OpenAI 兼容 chat.completions)。 */
async function runMimoAsr(ctx, audioBytes, mimeType) {
  const base = (activeConfig.asrBaseUrl || DEFAULT_ASR_BASE_URL).trim().replace(/\/+$/, "")
  const model = (activeConfig.asrModel || DEFAULT_ASR_MODEL).trim()
  const lang = (activeConfig.asrLanguage || "auto").trim()
  const key = await resolveAsrKey(ctx, activeConfig.asrKeyEnv)
  if (!key) return { ok: false, message: `未找到语音识别 key (${activeConfig.asrKeyEnv})` }
  const buf = Buffer.isBuffer(audioBytes) ? audioBytes : Buffer.from(audioBytes)
  const base64 = buf.toString("base64")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: `data:${mimeType || "audio/wav"};base64,${base64}` } }] }],
        ...(lang ? { asr_options: { language: lang } } : {}),
      }),
      signal: controller.signal,
    })
    const data = await resp.json().catch(() => null)
    const text = data?.choices?.[0]?.message?.content
    if (typeof text === "string" && text.trim() !== "") return { ok: true, text: text.trim() }
    const detail = data?.error?.message ? `: ${data.error.message}` : ""
    return { ok: false, message: `ASR 无输出 (HTTP ${resp.status}${detail})` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 解密 iLink 媒体: AES-128-ECB, aes_key 为 base64 → 16 字节 hex。 */
function decryptMedia(encrypted, aesKeyBase64) {
  try {
    const decoded = Buffer.from(String(aesKeyBase64 ?? ""), "base64")
    let hex = null
    if (decoded.length === 16) hex = decoded.toString("hex")
    else if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) hex = decoded.toString("ascii").toLowerCase()
    if (hex === null) return null
    const decipher = createDecipheriv("aes-128-ecb", Buffer.from(hex, "hex"), null)
    return Buffer.concat([decipher.update(Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted)), decipher.final()])
  } catch {
    return null
  }
}

/** voice encode_type → ASR 的 MIME (1=pcm 5=amr 7=mp3, 其余 jit silk 等)。 */
function voiceMime(encodeType) {
  if (encodeType === 7) return "audio/mpeg"
  if (encodeType === 5) return "audio/amr"
  if (encodeType === 1) return "audio/wav"
  if (encodeType === 8) return "audio/ogg"
  return "audio/silk"
}

/**
 * 处理一条微信消息里的语音: 返回 [{ via: "builtin"|"asr"|"error", text?, message? }]。
 * 1) voice_item.text (服务端已转写) 存在 → 直接用;
 * 2) 否则下载 CDN 媒体 + AES 解密 → mimo ASR。
 */
async function transcribeVoiceItems(ctx, msg) {
  const items = Array.isArray(msg?.item_list) ? msg.item_list : []
  const out = []
  for (const item of items) {
    if (item?.type !== WX_ITEM_VOICE || item.voice_item == null) continue
    const v = item.voice_item
    const builtin = String(v.text ?? "").trim()
    if (builtin) { out.push({ via: "builtin", text: builtin }); continue }
    if (!activeConfig.asrEnabled) { out.push({ via: "error", message: "语音转写未启用 (设置 → asrEnabled)" }); continue }
    const media = v.media
    if (media == null || !media.encrypt_query_param || !media.aes_key) {
      out.push({ via: "error", message: "语音媒体引用缺失" })
      continue
    }
    try {
      const dlUrl = `${ILINK_CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20000)
      let plain = null
      try {
        const resp = await fetch(dlUrl, { signal: controller.signal })
        if (!resp.ok) throw new Error(`媒体下载 HTTP ${resp.status}`)
        const enc = Buffer.from(await resp.arrayBuffer())
        plain = decryptMedia(enc, media.aes_key)
        if (plain === null) throw new Error("AES 解密失败 (key 格式不支持)")
      } finally {
        clearTimeout(timer)
      }
      const mime = voiceMime(v.encode_type)
      const r = await runMimoAsr(ctx, plain, mime)
      out.push(r.ok ? { via: "asr", text: r.text } : { via: "error", message: r.message })
    } catch (error) {
      out.push({ via: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }
  return out
}

/**
 * 探测可用的 agent preset id: 首选默认 (如自定义的 liangshen), 缺失时回退内置 standard。
 * 其他电脑没有自定义 preset 时, 自动用 DSH 内置标准模式, 保证工具可用。
 * @returns preset id, 或 undefined (无任何可用 preset)。
 */
async function resolvePresetId(ctx) {
  try {
    const presets = ctx.get("agentPresets")
    if (presets === void 0) return void 0
    const preferred = (() => { try { return presets.defaultId } catch { return void 0 } })()
    const rows = typeof presets.list === "function" ? await presets.list() : []
    const available = new Set((rows ?? []).map((r) => String(r?.id ?? "")).filter(Boolean))
    if (preferred && available.has(preferred)) return preferred
    if (available.has("standard")) return "standard"
    return void 0
  } catch {
    return void 0
  }
}

/**
 * 新增工作区: 在根目录下创建同名文件夹并注册为 DSH 工作区。
 * @param ctx - 插件上下文。
 * @param name - 工作区名称 (用作文件夹名)。
 * @param rootDir - 根目录绝对路径 (默认 activeConfig.rootDir)。
 * @returns {{ ok: boolean, path?: string, message?: string }}
 */
async function createWorkspace(ctx, name, rootDir = activeConfig.rootDir) {
  const trimmed = String(name ?? "").trim()
  if (!trimmed) return { ok: false, message: "工作区名称不能为空" }
  if (trimmed === "." || trimmed === "..") return { ok: false, message: `名称 "${trimmed}" 非法` }
  if (INVALID_NAME_CHARS.test(trimmed)) return { ok: false, message: `名称 "${trimmed}" 含非法字符 (\\ / : * ? \" < > | 等)` }
  if (!rootDir) return { ok: false, message: "未配置工作区根目录, 请先在设置中设置" }
  const target = join(rootDir, trimmed)
  try {
    if (existsSync(target)) {
      // 目录已存在: 若未注册则尝试注册 (幂等)
      const registry = ctx.get("workspaceRegistry")
      if (registry !== void 0 && typeof registry.create === "function") {
        await registry.create(target, trimmed)
      }
      return { ok: true, path: target, message: "目录已存在, 已注册为工作区" }
    }
    mkdirSync(target, { recursive: true })
    const registry = ctx.get("workspaceRegistry")
    if (registry !== void 0 && typeof registry.create === "function") {
      await registry.create(target, trimmed)
    }
    return { ok: true, path: target, message: "已创建并绑定" }
  } catch (error) {
    return { ok: false, message: `创建失败: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 会话名称校验: 非空、去首尾空白、限长、不含换行。 */
function validateSessionName(name) {
  const trimmed = String(name ?? "").trim()
  if (!trimmed) return { ok: false, message: "会话名称不能为空" }
  if (trimmed.length > 60) return { ok: false, message: "会话名称过长 (最多 60 字符)" }
  if (/[\r\n]/.test(trimmed)) return { ok: false, message: "会话名称不能包含换行" }
  return { ok: true, name: trimmed }
}

/**
 * 新建 DSH 会话: 在指定工作区创建带名称的会话, 持久化并挂载到工作区。
 * @param ctx - 插件上下文。
 * @param workspacePath - 所属工作区绝对路径 (须已注册)。
 * @param name - 会话名称。
 * @returns {{ ok: boolean, sessionId?: string, path?: string, message?: string }}
 */
async function createSession(ctx, workspacePath, name) {
  const agents = ctx.get("agents")
  const sessions = ctx.get("sessions")
  const defaultModel = ctx.get("agentDefaultModel")
  if (agents === void 0 || sessions === void 0 || defaultModel === void 0) {
    return { ok: false, message: "agents/sessions/agentDefaultModel 服务不可用" }
  }
  const selection = defaultModel.currentSelection()
  if (selection === void 0 || selection.provider === void 0 || selection.model === void 0) {
    return { ok: false, message: "默认模型选择不可用" }
  }
  const agentOptions = { provider: selection.provider, model: selection.model }
  // ★ 挂载 agent preset (默认如梁神模式; 其他电脑缺失时回退内置 standard), 否则会话无任何工具
  const presets = ctx.get("agentPresets")
  const presetId = await resolvePresetId(ctx)
  const setup = async (agentCtx) => {
    installModelSelection(agentCtx, { current: selection, assembled: void 0 })
    try {
      if (presets !== void 0 && typeof presets.mount === "function" && presetId !== void 0) {
        await presets.mount(agentCtx, presetId).catch(() => {
          // 首选失败 (损坏等): 回退内置 standard
          if (presetId !== "standard") return presets.mount(agentCtx, "standard").catch(() => {})
        })
      }
    } catch { /* 挂载失败不阻塞 */ }
  }
  const sid = SessionId(`session-${randomUUID()}`)
  try {
    const { agent, dispose } = await agents.create({
      sessionId: sid,
      meta: { cwd: workspacePath, ...(presetId ? { agentPreset: presetId } : {}) },
      agentOptions,
      setup,
    })
    // 1) 命名
    try {
      const titleSvc = ctx.get("sessionTitle")
      if (titleSvc !== void 0 && typeof titleSvc.rename === "function") {
        titleSvc.rename(agent.session, name)
      }
    } catch { /* 重命名失败不阻塞 */ }
    // 2) 挂载到工作区 (GUI 左侧可见)
    try {
      const registry = ctx.get("workspaceRegistry")
      const wsEntity = registry?.list?.().find((w) => normPath(w.path) === normPath(workspacePath))
      if (wsEntity !== void 0 && typeof wsEntity.attachSession === "function") {
        await wsEntity.attachSession(String(sid))
      }
    } catch { /* 挂载失败不阻塞 */ }
    // 3) 持久化
    try {
      await sessions.flush(agent.session)
    } catch { /* flush 失败不阻塞 */ }
    // 4) 释放 agent (下次访问时 resume) — 用真实 dispose 移出 live 注册表
    try { await dispose?.() } catch { /* ignore */ }
    return { ok: true, sessionId: String(sid), path: workspacePath }
  } catch (error) {
    return { ok: false, message: `创建失败: ${error instanceof Error ? error.message : String(error)}` }
  }
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
  let dispose = null
  try {
    const { agent: created, dispose: disposeFn } = await agents.create({
      sessionId: sid,
      meta: { cwd: process.cwd() },
      agentOptions,
      setup,
    })
    agent = created
    dispose = disposeFn
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
    if (dispose !== null) {
      try { await dispose() } catch { /* ignore */ }
    }
  }
}

/**
 * 处理"切换工作区/会话/新增工作区"请求 (拦截)。返回 true 表示消息已被处理, 不再进入正常桥接。
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
      // 选会话 → 询问是否总结, 确认后执行切换
      const chosen = matchSessionChoice(pending.list, text)
      if (chosen !== null) {
        pendingSwitch.set(chatId, { kind: "session-summary-confirm", chosen, expiresAt: Date.now() + PENDING_SWITCH_TTL })
        await sendMessage(chatId, `📂 已选择: ${wsLabel(chosen)} → 会话「${chosen.sessionTitle}」\n切换前是否总结该会话内容? 回复「是」或「否」(回复其他内容取消)。`).catch(() => {})
        return true
      }
      // 未匹配: 重列列表, 保留 pending
      await sendMessage(chatId, `没有找到「${String(text).trim()}」对应的会话, 请回复序号或完整标题:\n${formatSessionList(pending.list)}`).catch(() => {})
      return true
    }
    if (pending.kind === "session-summary-confirm") {
      // 确认是否总结: 是 → 总结后切换; 否 → 直接切换; 其他 → 取消
      const chosen = pending.chosen
      const t = String(text ?? "").trim().toLowerCase()
      const yes = t === "是" || t === "要" || t === "y" || t === "yes"
      const no = t === "否" || t === "不要" || t === "n" || t === "no"
      if (!yes && !no) {
        pendingSwitch.delete(chatId)
        await sendMessage(chatId, "已取消切换。").catch(() => {})
        return true
      }
      let summary = ""
      if (yes && chosen.sessionId) {
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
    if (pending.kind === "new-workspace") {
      // 新增工作区: 用户回复工作区名称 → 在根目录创建同名文件夹并注册
      const result = await createWorkspace(ctx, text)
      if (result.ok) {
        pendingSwitch.delete(chatId)
        diag.lastSwitch = { at: Date.now(), chatId, action: "new-workspace", path: result.path }
        await sendMessage(chatId, `✅ 新增工作区成功: ${result.path}\n已绑定为 DSH 工作区, 可在工作区列表/绑定会话中看到。`).catch(() => {})
      } else {
        await sendMessage(chatId, `❌ ${result.message}\n请回复另一个名称, 或发送其他消息取消。`).catch(() => {})
      }
      return true
    }
    if (pending.kind === "new-session-ws") {
      // 新增会话第一步: 选工作区
      const ws = matchWorkspaceChoice(pending.list, text)
      if (ws === null) {
        await sendMessage(chatId, `没有找到「${String(text).trim()}」对应的工作区, 请回复序号或名称:\n${formatWorkspaceList(pending.list)}`).catch(() => {})
        return true
      }
      pendingSwitch.set(chatId, { kind: "new-session-name", workspace: ws, expiresAt: Date.now() + PENDING_SWITCH_TTL })
      await sendMessage(chatId, `📂 已选工作区 ${wsLabel(ws)}, 请回复新会话的名称:`).catch(() => {})
      return true
    }
    if (pending.kind === "new-session-name") {
      // 新增会话第二步: 输入名称 → 创建
      const v = validateSessionName(text)
      if (!v.ok) {
        await sendMessage(chatId, `❌ ${v.message}\n请回复另一个名称, 或发送其他消息取消。`).catch(() => {})
        return true
      }
      const ws = pending.workspace
      const result = await createSession(ctx, ws.path, v.name)
      if (result.ok) {
        pendingSwitch.delete(chatId)
        diag.lastSwitch = { at: Date.now(), chatId, action: "new-session", sessionId: result.sessionId, path: result.path }
        await sendMessage(chatId, `✅ 已创建会话「${v.name}」(${wsLabel(ws)})\nid: ${result.sessionId}\n可用「切换会话」选择它, 或在 GUI 工作区中打开。`).catch(() => {})
      } else {
        await sendMessage(chatId, `❌ ${result.message}`).catch(() => {})
        pendingSwitch.delete(chatId)
      }
      return true
    }
    if (pending.kind === "model") {
      // 选模型 → (支持推理等级的话) 接着选等级
      const m = matchModelChoice(pending.list, text)
      if (m === null) {
        await sendMessage(chatId, `没有找到「${String(text).trim()}」对应的模型, 请回复序号或名称:\n${formatModelList(pending.list)}`).catch(() => {})
        return true
      }
      const opts = effortOptions(m)
      if (opts.length === 0) {
        // 模型不支持推理等级 → 直接应用 (无等级)
        pendingSwitch.delete(chatId)
        await applyModelSelectionToChat(ctx, chatId, m, void 0)
        return true
      }
      pendingSwitch.set(chatId, { kind: "effort", model: m, options: opts, expiresAt: Date.now() + PENDING_SWITCH_TTL })
      await sendMessage(chatId, `📂 已选模型 ${m.provider} / ${m.name}, 请选择推理等级 (回复序号或名称):\n${opts.map((e, i) => `${i + 1}. ${e.name}`).join("\n")}`).catch(() => {})
      return true
    }
    if (pending.kind === "effort") {
      // 选推理等级 → 应用模型+等级 (应用时校验: 该模型不支持则降级为默认等级)
      const effList = pending.options ?? REASONING_EFFORTS
      const eff = matchModelChoice(effList, text)
      if (eff === null) {
        await sendMessage(chatId, `没有找到「${String(text).trim()}」对应的推理等级, 请回复序号或名称:\n${effList.map((e, i) => `${i + 1}. ${e.name}`).join("\n")}`).catch(() => {})
        return true
      }
      pendingSwitch.delete(chatId)
      await applyModelSelectionToChat(ctx, chatId, pending.model, eff.id)
      return true
    }
    // 兜底 (未知 kind): 清除并继续
    pendingSwitch.delete(chatId)
  }
  if (pending) pendingSwitch.delete(chatId)

  // 2) 精确词触发
  const switchWord = matchSwitchWord(text)
  if (switchWord === null) return false

  // 「新增工作区」: 询问名称 (在根目录创建)
  if (switchWord === "新增工作区") {
    const rootDir = activeConfig.rootDir
    if (!rootDir) {
      await sendMessage(chatId, "未配置工作区根目录, 请先在 DSH 设置 → 微信机器人 中设置根目录。").catch(() => {})
      return true
    }
    await sendMessage(chatId, `📂 请回复新工作区的名称 (将在 ${rootDir} 下创建同名文件夹并绑定为 DSH 工作区):`).catch(() => {})
    pendingSwitch.set(chatId, { kind: "new-workspace", expiresAt: Date.now() + PENDING_SWITCH_TTL })
    return true
  }

  // 「切换模型」: 列模型 → 选推理等级
  if (switchWord === "切换模型") {
    const models = await listModels(ctx)
    if (models.length === 0) {
      await sendMessage(chatId, "没有可用的模型, 请先在 DSH 设置 → 模型 中配置。").catch(() => {})
      return true
    }
    await sendMessage(chatId, `📂 请选择要切换到的模型 (回复序号或名称):\n${formatModelList(models)}`).catch(() => {})
    pendingSwitch.set(chatId, { kind: "model", list: models, expiresAt: Date.now() + PENDING_SWITCH_TTL })
    return true
  }

  // 「当前工作区」「当前会话」: 查询当前绑定状态
  if (switchWord === "当前工作区" || switchWord === "当前会话") {
    const binding = resolveBinding(chatId)
    if (binding === null || (!binding.sessionId && !binding.workspace)) {
      await sendMessage(chatId, "当前未绑定工作区/会话。\n发「切换会话」或「切换工作区」绑定, 或「新增会话」创建新会话。").catch(() => {})
      return true
    }
    // 拉取工作区列表, 解析路径/标题/id
    let wsList = []
    try {
      wsList = await listWorkspaces(ctx)
    } catch {
      wsList = []
    }
    let wsPath = binding.workspace ?? ""
    let sessionId = binding.sessionId ?? ""
    let sessionTitle = binding.sessionTitle ?? ""
    // 仅 sessionId 绑定: 从列表反查工作区
    if (!wsPath && sessionId) {
      for (const ws of wsList) {
        const s = (ws.sessions ?? []).find((x) => String(x.id) === sessionId)
        if (s !== void 0) { wsPath = ws.path; if (!sessionTitle) sessionTitle = s.title; break }
      }
    }
    const ws = wsList.find((w) => normPath(w.path) === normPath(wsPath))
    // workspace+sessionTitle: 补全 id
    if (!sessionId && ws && binding.sessionTitle) {
      const s = (ws.sessions ?? []).find((x) => x.title === binding.sessionTitle)
      if (s !== void 0) sessionId = String(s.id)
    }
    if (switchWord === "当前工作区") {
      const wsText = ws ? wsLabel(ws) : wsPath || "(未知)"
      const sessionText = sessionTitle
        ? `会话「${sessionTitle}」`
        : binding.workspace && !binding.sessionId
          ? "会话: 尚未创建 (首条消息自动创建)"
          : "会话: 默认 (未命名)"
      await sendMessage(chatId, `📁 当前工作区: ${wsText}\n${sessionText}\n\n发「切换会话」/「切换工作区」可切换, 「新增工作区」/「新增会话」可创建。`).catch(() => {})
      return true
    }
    // 「当前会话」
    const titleText = sessionTitle || (binding.sessionId ? "(未命名)" : "默认 (首条消息自动创建)")
    const wsText = ws ? wsLabel(ws) : wsPath || "(未知)"
    const idText = sessionId ? `\nid: ${sessionId}` : ""
    await sendMessage(chatId, `💬 当前会话: 「${titleText}」\n工作区: ${wsText}${idText}\n\n发「切换会话」可切换到其他会话。`).catch(() => {})
    return true
  }

  // 「当前模型」: 查询当前模型与推理等级 (per-chat 覆盖或全局默认)
  if (switchWord === "当前模型") {
    const bindingRaw = (activeConfig.bindings ?? []).find((b) => b.chatId === chatId)
    const selection = ctx.get("agentDefaultModel")?.currentSelection?.()
    const provider = bindingRaw?.provider ?? selection?.provider
    const model = bindingRaw?.model ?? selection?.model
    const effort = bindingRaw?.reasoningEffort ?? selection?.reasoningEffort
    if (!provider || !model) {
      await sendMessage(chatId, "无法读取当前模型配置, 请检查 DSH 设置 → 模型。").catch(() => {})
      return true
    }
    const overridden = Boolean(bindingRaw?.provider || bindingRaw?.model || bindingRaw?.reasoningEffort)
    const effortText = effort ? `推理等级: ${effort}` : "推理等级: 默认"
    const sourceText = overridden ? "当前会话已覆盖模型 (发「切换模型」可调整)" : "使用 DSH 全局默认 (发「切换模型」可对本会话覆盖)"
    await sendMessage(chatId, `🤖 当前模型: ${provider} / ${model}\n${effortText}\n${sourceText}`).catch(() => {})
    return true
  }

  // 「统计用量」: 查询当前模型对应平台的用量与余额/额度 (复用 dsh-usage-stats 接口)
  if (switchWord === "统计用量") {
    const bindingRaw = (activeConfig.bindings ?? []).find((b) => b.chatId === chatId)
    const selection = ctx.get("agentDefaultModel")?.currentSelection?.()
    const provider = bindingRaw?.provider ?? selection?.provider
    if (!provider) {
      await sendMessage(chatId, "无法确定当前模型对应的平台, 请检查 DSH 设置 → 模型。").catch(() => {})
      return true
    }
    const port = ctx.get("webServer")?.port ?? 3080
    const base = `http://127.0.0.1:${port}/api/usage-stats`
    const fetchJson = async (url, timeoutMs = 10000) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const resp = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } })
        if (!resp.ok) return null
        return await resp.json()
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    }
    // 1) 统一账户快照 (余额/额度窗口)
    const accountData = await fetchJson(`${base}/account?provider=${encodeURIComponent(provider)}&refresh=1`)
    if (accountData === null || !accountData.ok || accountData.account === void 0) {
      await sendMessage(chatId, `❌ 无法获取 ${provider} 的用量数据\n(需要安装 dsh-usage-stats 插件, 且该平台已配置账户/订阅)。`).catch(() => {})
      return true
    }
    const acc = accountData.account
    const statusText = acc.status === "ok" ? "正常" : String(acc.status ?? "未知")
    const lines = [`📊 用量统计 — ${acc.displayName ?? provider}${acc.plan ? ` (${acc.plan})` : ""}`, `状态: ${statusText}`]
    const windowNames = { session: "Session", weekly: "周", monthly: "月" }
    const fmtPct = (v) => (v === void 0 || v === null ? "—" : `${v}%`)
    for (const w of acc.windows ?? []) {
      const label = windowNames[w.kind] ?? w.kind
      lines.push(`· ${label}: 已用 ${fmtPct(w.usedPercent)} / 剩余 ${fmtPct(w.remainingPercent)}${w.resetsAt ? ` (重置 ${new Date(w.resetsAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })})` : ""}`)
    }
    // 2) 今日 token 用量 (按 provider 前缀筛选)
    const usageData = await fetchJson(`${base}/usage`)
    if (usageData !== null && usageData.ok && Array.isArray(usageData.days) && usageData.days.length > 0) {
      const today = usageData.days[usageData.days.length - 1]
      const todayModels = (today.models ?? []).filter((m) => String(m.model ?? "").startsWith(provider + "/"))
      if (todayModels.length > 0) {
        const sum = todayModels.reduce((s, m) => s + (m.inputTokens ?? 0) + (m.outputTokens ?? 0), 0)
        const hits = todayModels.reduce((s, m) => s + (m.cacheReadTokens ?? 0), 0)
        lines.push(`今日 token: ${(sum / 1e6).toFixed(2)}M (缓存读 ${(hits / 1e6).toFixed(1)}M, 命中 ${today.cacheHitRate ?? "—"}%)`)
      }
    }
    await sendMessage(chatId, lines.join("\n")).catch(() => {})
    return true
  }

  // 「新增会话」: 先选工作区, 再输入名称
  if (switchWord === "新增会话") {
    let wsList = []
    try {
      wsList = sliceSessionList(await listWorkspaces(ctx))
    } catch {
      wsList = []
    }
    if (wsList.length === 0) {
      await sendMessage(chatId, "当前没有任何可用的工作区, 请先「新增工作区」或「切换工作区」。").catch(() => {})
      return true
    }
    await sendMessage(chatId, `📂 请选择新会话所在的工作区 (回复序号或名称):\n${formatWorkspaceList(wsList)}`).catch(() => {})
    pendingSwitch.set(chatId, { kind: "new-session-ws", list: wsList, expiresAt: Date.now() + PENDING_SWITCH_TTL })
    return true
  }

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
 * 绑定优先级: bindings[chatId].sessionId → bindings[chatId].workspace → 工作区根目录 (兜底) → 进程 cwd。
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
    let holder = bridgeAgents.get(chatId)
    let agent = holder?.agent
    if (agent === void 0) {
      let heldDispose = void 0 // 本次新建/resume 得到的 AgentHandle.dispose (live 复用则无)
      const selection = defaultModel.currentSelection()
      if (selection === void 0 || selection.provider === void 0 || selection.model === void 0) {
        throw new Error(`bridge: 默认模型选择不可用: ${JSON.stringify(selection)}`)
      }
      // ★ 模型/推理等级: binding 里「切换模型」显式指定的优先, 否则用默认选择
      const provider = binding?.provider ?? selection.provider
      const model = binding?.model ?? selection.model
      const reasoningEffort = binding?.reasoningEffort ?? selection.reasoningEffort
      diag.lastBridge.phase = "creating-agent"
      const agentOptions = {
        provider,
        model,
      }
      // ★ 默认 preset (梁神等): 缺失时回退内置 standard; resume 已有会话不带, 新建会话才挂载
      const presets = ctx.get("agentPresets")
      const presetId = await resolvePresetId(ctx)
      const setupBase = (agentCtx) => {
        installModelSelection(agentCtx, {
          current: { provider, model, reasoningEffort },
          assembled: void 0,
        })
      }
      const setup = async (agentCtx) => {
        setupBase(agentCtx)
        try {
          if (presets !== void 0 && typeof presets.mount === "function" && presetId !== void 0) {
            await presets.mount(agentCtx, presetId).catch(() => {
              if (presetId !== "standard") return presets.mount(agentCtx, "standard").catch(() => {})
            })
          }
        } catch { /* 挂载失败不阻塞 */ }
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
            const { agent: resumed, dispose } = await agents.resume({
              resumeSessionId: sid,
              agentOptions,
              setup: setupBase,
            })
            agent = resumed
            heldDispose = dispose
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
            const { agent: resumed, dispose } = await agents.resume({
              resumeSessionId: sid,
              agentOptions,
              setup: setupBase,
            })
            agent = resumed
            heldDispose = dispose
          } else {
            throw new Error(`bridge: 绑定的会话不存在: ${sid}`)
          }
        }
      } else {
        // 新建/默认会话: 工作区取 绑定workspace → 工作区根目录 (兜底) → 进程 cwd
        const cwd = binding?.workspace || activeConfig.rootDir || process.cwd()
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
            const { agent: resumed, dispose } = await agents.resume({
              resumeSessionId: sessionId,
              agentOptions,
              setup: setupBase,
            })
            agent = resumed
            heldDispose = dispose
          } else {
            // 3) 全新会话 → create (挂载默认 preset, 否则无工具)
            const { agent: created, dispose } = await agents.create({
              sessionId,
              meta: { cwd, ...(presetId ? { agentPreset: presetId } : {}) },
              agentOptions,
              setup,
            })
            agent = created
            heldDispose = dispose
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
      // 记录本轮使用的 agent 及其 dispose 能力 (live 复用时无 dispose, 由持有方管理)
      if (heldDispose !== void 0) {
        bridgeAgents.set(chatId, { agent, dispose: heldDispose })
      } else {
        bridgeAgents.set(chatId, { agent })
      }
    }
    // ★ 应用 binding 的模型覆盖到会话级共享选择 (无论 live agent 由谁创建都生效,
    //   GUI 同步显示; 已应用过同 key 则跳过)。这是「切换模型」真正生效的关键。
    if (binding?.provider && binding?.model) {
      const overrideKey = `${binding.provider}/${binding.model}/${binding.reasoningEffort ?? ""}`
      if (appliedOverrideKey.get(chatId) !== overrideKey) {
        const pushed = await applyModelOverrideToSession(ctx, agent.session.id, {
          provider: binding.provider,
          model: binding.model,
          ...(binding.reasoningEffort ? { reasoningEffort: binding.reasoningEffort } : {}),
        }).catch(() => false)
        if (pushed) appliedOverrideKey.set(chatId, overrideKey)
      }
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
  // 空回复兜底: agent 未产出文本时回的中性确认 (留空 = 关闭)
  emptyReply: z.string().default(""),
  // 工作区根目录: 未绑定 chat 的兜底工作区, 也是「新增工作区」创建文件夹的位置 (默认 $DSH_HOME/proj, 无则自动创建)
  rootDir: z.string().default(DEFAULT_ROOT_DIR),
  // 绑定条目实际是三选一: sessionId (固定) / workspace (新建) / workspace+sessionTitle (动态),
  // 除 chatId 外均为可选, 与 /bind 与 GUI 写入的数据结构一致; 模型字段为「切换模型」的可选覆盖
  bindings: z.array(z.object({
    chatId: z.string(),
    workspace: z.string().required(false),
    sessionId: z.string().required(false),
    sessionTitle: z.string().required(false),
    provider: z.string().required(false),
    model: z.string().required(false),
    reasoningEffort: z.string().required(false),
  })).default([]),
  // 语音输入 (微信语音 → ASR 转文本 → 送入对话); key 默认取 DSH 里的 mimo (xiaomi) key
  asrEnabled: z.boolean().default(true),
  asrModel: z.string().default(DEFAULT_ASR_MODEL),
  asrBaseUrl: z.string().default(DEFAULT_ASR_BASE_URL),
  asrKeyEnv: z.string().default(DEFAULT_ASR_KEY_ENV),
  asrLanguage: z.string().default("auto"),
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
    emptyReply: (config.emptyReply ?? "").trim(),
    rootDir: (config.rootDir ?? DEFAULT_ROOT_DIR).trim() || DEFAULT_ROOT_DIR,
    bindings: Array.isArray(config.bindings) ? config.bindings : [],
    asrEnabled: config.asrEnabled !== false,
    asrModel: (config.asrModel ?? DEFAULT_ASR_MODEL).trim() || DEFAULT_ASR_MODEL,
    asrBaseUrl: (config.asrBaseUrl ?? DEFAULT_ASR_BASE_URL).trim() || DEFAULT_ASR_BASE_URL,
    asrKeyEnv: (config.asrKeyEnv ?? DEFAULT_ASR_KEY_ENV).trim() || DEFAULT_ASR_KEY_ENV,
    asrLanguage: (config.asrLanguage ?? "auto").trim() || "auto",
  }
  installSettingsSection(ctx, WECHAT_BOT_SETTINGS_NS, SettingsConfig, config, {
    setSource: (source) => {
      // 设置值覆盖组合配置 (未设置的字段回退到组合配置)
      activeConfig = {
        ...activeConfig,
        statusPath: source().statusPath ?? activeConfig.statusPath,
        autoReply: source().autoReply ?? activeConfig.autoReply,
        bridge: source().bridge ?? activeConfig.bridge,
        emptyReply: source().emptyReply ?? activeConfig.emptyReply,
        rootDir: source().rootDir?.trim() || activeConfig.rootDir,
        bindings: source().bindings ?? activeConfig.bindings,
        asrEnabled: source().asrEnabled ?? activeConfig.asrEnabled,
        asrModel: (source().asrModel ?? activeConfig.asrModel).trim(),
        asrBaseUrl: (source().asrBaseUrl ?? activeConfig.asrBaseUrl).trim(),
        asrKeyEnv: (source().asrKeyEnv ?? activeConfig.asrKeyEnv).trim(),
        asrLanguage: (source().asrLanguage ?? activeConfig.asrLanguage).trim(),
      }
    },
    onChange: () => {},
    validate: () => {},
  })
  // 持有 settings 服务引用 (GUI /settings 保存走服务通道; 无服务时回退 YAML)
  ctx.inject(["settings"], (sctx) => {
    settingsService = sctx.settings
  })
  const statusPath = activeConfig.statusPath

  // 启动时确保工作区根目录存在并注册为工作区 (兜底工作区, 无则自动创建)
  try {
    void ensureWorkspace(ctx, activeConfig.rootDir)
  } catch {
    // 创建/注册失败不阻塞启动
  }

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
      if (pathname.endsWith("/new-workspace") && req.method === "POST") {
        // 新增工作区: 在根目录下创建同名文件夹并注册为 DSH 工作区
        const body = await readBody(req)
        let payload
        try {
          payload = JSON.parse(body.toString("utf8"))
        } catch {
          res.writeHead(400, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: false, message: "bad json" }))
          return
        }
        const result = await createWorkspace(ctx, String(payload.name ?? "").trim(), String(payload.rootDir ?? "").trim() || activeConfig.rootDir)
        res.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" })
        res.end(JSON.stringify(result))
        return
      }
      // 配置读写 API: 不走 DSH 客户端 settingsScope (该通道不暴露第三方命名空间,
      // 保存会被拒 → GUI 里 rootDir 等字段保存后回退)。插件自带通道, 宿主侧直写 settings 服务。
      if (pathname.endsWith("/settings") && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true, config: activeConfig }))
        return
      }
      if (pathname.endsWith("/settings") && req.method === "POST") {
        const body = await readBody(req)
        let payload
        try {
          payload = JSON.parse(body.toString("utf8"))
        } catch {
          res.writeHead(400, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: false, message: "bad json" }))
          return
        }
        const result = await applySettingsPatch(payload?.patch)
        res.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" })
        res.end(JSON.stringify(result))
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
  // 固定前缀镜像: 客户端始终用 /wechat/status 访问 API, 不受 statusPath 配置影响
  if (statusPath !== DEFAULT_STATUS_PATH) {
    ctx.webServer.register({ kind: "prefix", path: DEFAULT_STATUS_PATH, handler })
  }

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
      // 若该 chat 已有运行中的 agent, 重置以便下次按新绑定重连 (真正 dispose)
      await disposeBridgeAgent(chatId)
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
    for (const holder of bridgeAgents.values()) {
      try { holder?.dispose?.() } catch { /* ignore */ }
    }
    bridgeAgents.clear()
    bridgeQueues.clear()
    pendingSwitch.clear()
  })
}
