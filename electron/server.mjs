import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import http from 'node:http'
import { resolveDsh } from './dsh.mjs'
import { ensureRuntime } from './runtime.mjs'
import { push } from './logger.mjs'
import { ensureShellEnv } from './shellenv.mjs'

const PORT_PATTERN = /http:\/\/127\.0\.0\.1:(\d+)\//

let child = null
let url = null
let openUrl = null
let port = null
let stopping = false

export function currentState() {
  return {
    running: Boolean(child),
    pid: child?.pid ?? null,
    port,
    url,
    openUrl,
  }
}

/** After dsh starts it prints the real token-bearing URL to the log; that is the address to open in the browser. */
function captureAccessUrl(line) {
  if (!port) return
  const match = new RegExp(`(http://127\\.0\\.0\\.1:${port}/\\?token=[\\w-]+)`).exec(line)
  if (match) openUrl = match[1]
}

function probe(target) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${target}/`, { timeout: 2000 }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

function isPortFree(target) {
  return new Promise((resolve) => {
    const socket = createConnection({ port: target, host: '127.0.0.1' })
    socket.setTimeout(800)
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(true))
  })
}

async function waitReady(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!child) return false
    if (port && (await probe(port))) return true
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return false
}

export async function start(targetPort) {
  if (child) return url
  const desired = Number(targetPort)
  if (!Number.isInteger(desired) || desired < 1 || desired > 65535) {
    throw new Error('端口无效，请设置在 1–65535 之间')
  }
  await ensureShellEnv()
  const runtime = await ensureRuntime()
  const target = resolveDsh()
  if (!target) throw new Error('尚未安装 DSH，请先安装')
  if (!existsSync(target.path)) throw new Error(`未找到 dsh 可执行文件：${target.path}`)
  push(`使用用户环境 DSH ${target.version}（${target.path}）`)

  if (!(await isPortFree(desired))) {
    throw new Error(`端口 ${desired} 已被占用，请先停止占用它的程序，或点击界面上的端口改成其它值`)
  }
  port = desired
  const nodeDir = dirname(runtime.nodePath)
  const env = {
    ...process.env,
    PATH: `${nodeDir}:${process.env.PATH ?? ''}`,
  }

  push(`启动 DSH（端口 ${desired}）`)
  child = spawn(target.path, ['web', '--no-open', '--port', String(desired)], {
    cwd: homedir(),
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const flush = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue
      const portMatch = PORT_PATTERN.exec(line)
      if (portMatch && Number(portMatch[1]) !== port) {
        push(`注意：dsh 实际监听 ${portMatch[1]}，与设置的 ${port} 不一致`)
        port = Number(portMatch[1])
      }
      captureAccessUrl(line)
      push(line.trimEnd())
    }
  }
  child.stdout?.on('data', flush)
  child.stderr?.on('data', flush)

  child.on('error', (error) => {
    push(`DSH 启动失败：${error.message}`)
    child = null
    port = null
    url = null
    openUrl = null
  })

  child.on('exit', (code, signal) => {
    const reason = signal ? `信号 ${signal}` : `退出码 ${code}`
    push(stopping ? `DSH 已停止（${reason}）` : `DSH 进程已退出（${reason}）`)
    child = null
    port = null
    url = null
    openUrl = null
    stopping = false
  })

  push('等待 DSH 就绪…')
  const ready = await waitReady()
  if (!ready) {
    push('等待超时，DSH 可能启动失败，日志见上方')
    await stop()
    throw new Error('DSH 启动超时，请查看日志')
  }

  url = `http://127.0.0.1:${port}`
  push(`DSH 已就绪：${url}`)
  return url
}

function killGroup(pid, signal) {
  if (process.platform === 'win32') {
    // Windows has no process group signals, so kill the whole process tree with taskkill.
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // The process may already have exited.
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // The process may already have exited.
    }
  }
}

export async function stop() {
  if (!child) return
  stopping = true
  const pid = child.pid
  push('正在停止 DSH…')
  killGroup(pid, 'SIGTERM')
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
  if (!exited) {
    push('进程未在 5 秒内退出，强制结束')
    killGroup(pid, 'SIGKILL')
    child = null
    port = null
    url = null
    openUrl = null
    stopping = false
  }
}
