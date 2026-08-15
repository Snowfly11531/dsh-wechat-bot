// 截图 DSH 设置页 (微信机器人) - v4: CDP 坐标点击 + 导航 + 截图
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9337
const OUT = process.argv[2] ?? '.'

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + join(OUT, '.chrome-profile'),
  '--window-size=1600,1000', '--force-device-scale-factor=1',
  'about:blank',
], { stdio: 'ignore' })

async function waitForCdp() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return } catch {}
    await sleep(200)
  }
  throw new Error('CDP 端口未就绪')
}

function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  }
  const ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  return {
    ready,
    send(method, params = {}) {
      return ready.then(() => new Promise((resolve, reject) => {
        const mid = ++id
        pending.set(mid, { resolve, reject })
        ws.send(JSON.stringify({ id: mid, method, params }))
      }))
    },
    close() { ws.close() },
  }
}

async function evalJs(session, expression) {
  const r = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.exceptionDetails ? 'EXCEPTION' : r.result?.value
}

async function clickElement(session, finderExpr, label) {
  const info = await evalJs(session, `(() => {
    const el = ${finderExpr}
    if (!el) return 'not-found'
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return 'not-visible'
    return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height })
  })()`)
  if (typeof info !== 'string' || info.startsWith('not')) { console.log(`[${label}] 找不到元素:`, info); return false }
  const pos = JSON.parse(info)
  const cx = Math.round(pos.x + pos.w / 2), cy = Math.round(pos.y + pos.h / 2)
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
  console.log(`[${label}] 已点击 (${cx}, ${cy})`)
  return true
}

async function main() {
  await waitForCdp()
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const session = cdpSession(page.webSocketDebuggerUrl)
  await session.ready
  await session.send('Page.enable')
  await session.send('Runtime.enable')
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })

  await session.send('Page.navigate', { url: 'http://127.0.0.1:3080/' })
  await sleep(8000)

  // 1. 点「设置」
  await clickElement(session, `[...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '设置')`, '设置按钮')
  await sleep(3000)

  // 2. 列出设置导航项, 找「微信机器人」
  const items = await evalJs(session, `JSON.stringify([...document.querySelectorAll('[role="tab"], button, a, span, div')].map(el => ({ t: (el.textContent || '').trim(), cls: (el.className || '').toString().slice(0, 30) })).filter(x => x.t === '微信机器人' || x.t === 'WeChat Bot' || x.t === '通用' || x.t === '插件').slice(0, 10))`)
  console.log('设置导航候选:', items)

  // 3. 点「微信机器人」导航
  await clickElement(session, `[...document.querySelectorAll('*')].find(e => (e.textContent || '').trim() === '微信机器人')`, '微信机器人导航')
  await sleep(3000)

  // 4. 截图 1: 设置页 (顶部: 扫码状态 + 绑定区域)
  const shot1 = await session.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'settings-wechat-bot.png'), Buffer.from(shot1.data, 'base64'))
  console.log('截图1 已保存: settings-wechat-bot.png (' + Math.round(shot1.data.length / 1024) + ' KB)')

  // 5. 滚动到绑定会话区域, 截图 2
  const scrolled = await evalJs(session, `(() => {
    const all = [...document.querySelectorAll('section, div, label')]
    const card = all.find(el => /绑定会话|Bind WeChat chat/.test(el.textContent || '') && el.getBoundingClientRect().height > 80 && el.getBoundingClientRect().height < 700)
    if (card) { card.scrollIntoView({ block: 'start' }); return 'ok' }
    return 'not-found'
  })()`)
  console.log('滚动到绑定区:', scrolled)
  await sleep(1500)

  const shot2 = await session.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, 'settings-bind.png'), Buffer.from(shot2.data, 'base64'))
  console.log('截图2 已保存: settings-bind.png (' + Math.round(shot2.data.length / 1024) + ' KB)')

  session.close()
  chrome.kill()
}

main().catch((e) => { console.error('失败:', e.message); chrome.kill(); process.exit(1) })
