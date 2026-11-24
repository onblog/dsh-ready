/**
 * Installer download for the update flow.
 *
 * The release manifest already carries the installer's size and sha256; this module fetches
 * the same R2-backed URL the site serves, in parallel HTTP ranges (four connections for a
 * full-size installer), writes the pieces into one preallocated `.part` file, verifies the
 * digest and only then renames it into the OS Downloads folder. Nothing goes through the
 * system browser.
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, mkdir, rename, stat, unlink } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { basename, join } from 'node:path'

const RANGE_THREADS = 4
const SMALL_FILE_THREADS = 2
const SMALL_FILE_BYTES = 8 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const RETRIES = 2
const REDIRECTS = 3

function downloadDir() {
  return process.env.DSH_READY_DOWNLOAD_DIR || app.getPath('downloads')
}

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

/** One HTTP request (redirects followed), shared by the manifest range fetches. */
function request(url, headers, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch (error) {
      reject(error)
      return
    }
    const lib = target.protocol === 'http:' ? http : https
    const req = lib.get(target, { headers, signal }, (res) => {
      const status = res.statusCode ?? 0
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects < REDIRECTS) {
        res.resume()
        request(new URL(res.headers.location, target).toString(), headers, signal, redirects + 1).then(resolve, reject)
        return
      }
      resolve(res)
    })
    req.on('error', reject)
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('下载超时')))
  })
}

/** Fetch one byte range and write it at `offset`; retries transient failures. */
async function fetchRange({ url, start, end, offset, handle, signal, onBytes }) {
  let lastError
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const res = await request(
        url,
        {
          Range: `bytes=${start}-${end}`,
          'Accept-Encoding': 'identity',
          Accept: 'application/octet-stream',
        },
        signal,
      )
      if (res.statusCode === 200) {
        res.resume()
        throw new Error('服务器未按分片响应，无法多线程下载')
      }
      if (res.statusCode !== 206) {
        res.resume()
        throw new Error(`分片请求失败：HTTP ${res.statusCode}`)
      }
      const contentRange = String(res.headers['content-range'] || '')
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange)
      if (!match || Number(match[1]) !== start || Number(match[2]) !== end) {
        res.resume()
        throw new Error(`分片范围不匹配：${contentRange || '缺少 Content-Range'}`)
      }

      let position = offset
      let written = 0
      const expected = end - start + 1
      for await (const chunk of res) {
        await handle.write(chunk, 0, chunk.length, position)
        position += chunk.length
        written += chunk.length
        onBytes(chunk.length)
      }
      if (written !== expected) throw new Error(`分片长度不足：${written}/${expected}`)
      return
    } catch (error) {
      lastError = error
      if (signal?.aborted) throw error
      if (attempt === RETRIES) break
      await new Promise((done) => setTimeout(done, 700 * attempt))
    }
  }
  throw lastError
}

/**
 * Download (or reuse) the installer for one release.
 * Resolves `{ path, bytes, reused }`; the digest is always verified before a path is returned.
 */
export async function downloadInstaller({ url, name, size, sha256, signal, onProgress }) {
  const bytes = Number(size) || 0
  if (!url || !name || bytes <= 0 || !sha256) throw new Error('更新清单缺少安装包信息')
  const dir = downloadDir()
  await mkdir(dir, { recursive: true })
  const filename = basename(String(name))
  const finalPath = join(dir, filename)
  const partPath = `${finalPath}.part`

  // A previous run may have finished (or the user checked again); hashing is cheaper than
  // downloading 120 MB twice.
  try {
    const existing = await stat(finalPath)
    if (existing.size === bytes && (await sha256Of(finalPath)) === sha256.toLowerCase()) {
      return { path: finalPath, bytes, reused: true }
    }
  } catch {
    // Missing file: download it.
  }

  await unlink(partPath).catch(() => null)
  const handle = await open(partPath, 'w+')
  let closed = false
  const closeHandle = async () => {
    if (closed) return
    closed = true
    await handle.close().catch(() => null)
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', abort, { once: true })
  }

  let received = 0
  let jobs = []
  const onBytes = (count) => {
    received += count
    onProgress?.(received, bytes)
  }

  try {
    await handle.truncate(bytes)
    const threads = bytes >= SMALL_FILE_BYTES ? RANGE_THREADS : SMALL_FILE_THREADS
    const chunkSize = Math.ceil(bytes / threads)
    for (let index = 0; index < threads; index += 1) {
      const start = index * chunkSize
      if (start >= bytes) break
      const end = Math.min(bytes - 1, start + chunkSize - 1)
      jobs.push(
        fetchRange({
          url,
          start,
          end,
          offset: start,
          handle,
          signal: controller.signal,
          onBytes,
        }),
      )
    }
    await Promise.all(jobs)
    await handle.sync()

    if ((await handle.stat()).size !== bytes) throw new Error('下载文件长度与清单不一致')
    const digest = await sha256Of(partPath)
    if (digest !== sha256.toLowerCase()) throw new Error('下载文件校验失败（sha256 不一致）')

    // Windows cannot rename a file that still has an open handle.
    await closeHandle()
    await unlink(finalPath).catch(() => null)
    await rename(partPath, finalPath)
    return { path: finalPath, bytes, reused: false }
  } catch (error) {
    controller.abort()
    // Let the other ranges settle before the handle is closed, so no write lands on a
    // closed descriptor.
    await Promise.allSettled(jobs).catch(() => null)
    await closeHandle()
    await unlink(partPath).catch(() => null)
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    await closeHandle()
  }
}
