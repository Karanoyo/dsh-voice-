// dsh-voice —— Node host half.
//
// Two routes:
//  1. GET /dsh-voice/hf/*   — proxy HuggingFace model files (hf-mirror.com)
//     same-origin, so the in-browser Whisper never hits a CORS wall.
//  2. POST /dsh-voice/asr   — iFlytek (讯飞) 语音听写: receives 16kHz/16bit
//     mono PCM as base64, calls the iFlytek IAT WebSocket API server-side,
//     returns { text }. Credentials never reach the browser.

import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-voice'
export const inject = ['webServer']

// ---------------------------------------------------------------------
// 讯飞凭据读取顺序：环境变量 > 同目录 xfyun.secret.json > 空。
// 注册 https://www.xfyun.cn/ → 控制台「我的应用」创建应用，
// 拿到 APPID / APIKey / APISecret 后，二选一：
//  1. 环境变量：XFYUN_APPID / XFYUN_APIKEY / XFYUN_APISECRET
//  2. 本目录 xfyun.secret.json（已被 .gitignore 忽略，不要提交）：
//     { "appId": "...", "apiKey": "...", "apiSecret": "..." }
// ---------------------------------------------------------------------
function loadXfyunSecret() {
  try {
    const p = fileURLToPath(new URL('./xfyun.secret.json', import.meta.url))
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

const XFYUN_SECRET = loadXfyunSecret()

const XFYUN = {
  appId: process.env.XFYUN_APPID || XFYUN_SECRET.appId || '',
  apiKey: process.env.XFYUN_APIKEY || XFYUN_SECRET.apiKey || '',
  apiSecret: process.env.XFYUN_APISECRET || XFYUN_SECRET.apiSecret || '',
}

const HF_BASE = 'https://hf-mirror.com'
const HF_ROUTE = '/dsh-voice/hf'
const ASR_ROUTE = '/dsh-voice/asr'

// ---------------------------------------------------------------------
// Route 1: HuggingFace model proxy (Whisper fallback engine).
// ---------------------------------------------------------------------
function hfHandler(req, res) {
  const raw = String(req.url || '').split('?')[0]
  const rel = raw.startsWith(HF_ROUTE) ? raw.slice(HF_ROUTE.length) : raw
  const target = HF_BASE + (rel.startsWith('/') ? rel : '/' + rel)

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 600000)

  fetch(target, { signal: ac.signal, redirect: 'follow' })
    .then(async (up) => {
      clearTimeout(timer)
      const headers = {
        'content-type': up.headers.get('content-type') || 'application/octet-stream',
        'cache-control': 'public, max-age=86400',
        'access-control-allow-origin': '*',
      }
      const length = up.headers.get('content-length')
      if (length) headers['content-length'] = length
      res.writeHead(up.status, headers)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      const reader = up.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(Buffer.from(value))
      }
      res.end()
    })
    .catch((err) => {
      clearTimeout(timer)
      if (res.headersSent) {
        res.end()
        return
      }
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh-voice proxy error: ' + (err && err.message ? err.message : String(err)))
    })
}

// ---------------------------------------------------------------------
// Route 2: iFlytek 语音听写（IAT，WebSocket）。
// ---------------------------------------------------------------------
async function readJsonBody(req, limit = 12 * 1024 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text || '{}')
}

function iatUrl() {
  const host = 'iat-api.xfyun.cn'
  const date = new Date().toUTCString()
  const signatureOrigin = 'host: ' + host + '\ndate: ' + date + '\nGET /v2/iat HTTP/1.1'
  const signature = createHmac('sha256', XFYUN.apiSecret)
    .update(signatureOrigin)
    .digest('base64')
  const authorizationOrigin =
    'api_key="' + XFYUN.apiKey + '", algorithm="hmac-sha256", headers="host date request-line", signature="' + signature + '"'
  const authorization = Buffer.from(authorizationOrigin).toString('base64')
  return (
    'wss://' + host + '/v2/iat?authorization=' + encodeURIComponent(authorization) +
    '&date=' + encodeURIComponent(date) + '&host=' + host
  )
}

function iatBusiness() {
  return {
    language: 'zh_cn',
    domain: 'iat',
    accent: 'mandarin',
    // ⏱️ 静音停顿检测：官方标准参数 vad_eos，设为讯飞官方允许上限 10000 毫秒（10 秒）
    // 严禁添加未知字段（如 bos/vad_bos/eos），否则讯飞云端会报 10163 参数验证错误
    vad_eos: 10000,
    dwa: 'wpgs',
    ptt: 0,
  }
}

/**
 * Send 16kHz/16bit mono PCM (Int16 bytes) to iFlytek IAT and resolve the text.
 */
function iatTranscribe(pcm) {
  return new Promise((resolve, reject) => {
    let ws
    let settled = false
    // 🎙️ 讯飞标准分句容器：按句子序号 sn 严格隔离存储每句文字，绝不抛弃停顿前后的任何一段文本
    const 分句字典 = {}
    // 总超时延长至 60 秒（覆盖讯飞单次最大允许时长）
    const timer = setTimeout(() => finish(new Error('讯飞识别超时')), 60000)

    function finish(err, text) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws && ws.close()
      } catch {}
      if (err) reject(err)
      else resolve(text)
    }

    try {
      ws = new WebSocket(iatUrl())
    } catch (err) {
      finish(err)
      return
    }

    ws.onopen = () => {
      try {
        const FRAME = 1280
        if (pcm.length === 0) {
          ws.send(JSON.stringify({
            common: { app_id: XFYUN.appId },
            business: iatBusiness(),
            data: { status: 2, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' },
          }))
          return
        }
        let offset = 0
        let status = 0
        while (offset < pcm.length) {
          const end = Math.min(offset + FRAME, pcm.length)
          const chunk = pcm.subarray(offset, end)
          if (end >= pcm.length) status = 2
          ws.send(JSON.stringify({
            common: { app_id: XFYUN.appId },
            business: iatBusiness(),
            data: { status, format: 'audio/L16;rate=16000', encoding: 'raw', audio: chunk.toString('base64') },
          }))
          offset = end
          if (status === 0) status = 1
        }
      } catch (err) {
        finish(err)
      }
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data))
        if (msg.code !== 0) {
          finish(new Error('讯飞错误 ' + msg.code + '：' + (msg.message || '未知')))
          return
        }
        const data = msg.data
        if (!data) return
        const result = data.result
        if (result) {
          const 句号 = typeof result.sn === 'number' ? result.sn : 1
          // 如果开启动态修正并且指示替换前置范围
          if (result.pgs === 'rpl' && Array.isArray(result.rg)) {
            for (let r = result.rg[0]; r <= result.rg[1]; r++) {
              delete 分句字典[r]
            }
          }
          let 本片文字 = ''
          if (Array.isArray(result.ws)) {
            本片文字 = result.ws
              .map((item) => (item.cw || []).map((c) => c.w || '').join(''))
              .join('')
          }
          // 在同一个 sn 句子内累加文字
          分句字典[句号] = (分句字典[句号] || '') + 本片文字
        }

        // 最终消息（ls=true 或 status=2）到达，将所有分句按序号升序完整拼装
        if ((result && result.ls === true) || (data && data.status === 2)) {
          const 排序序号列表 = Object.keys(分句字典).map(Number).sort((a, b) => a - b)
          const 完整合并文本 = 排序序号列表.map((k) => 分句字典[k] || '').join('')
          finish(null, 完整合并文本)
        }
      } catch (err) {
        finish(err)
      }
    }

    ws.onerror = () => {
      finish(new Error('讯飞 WebSocket 连接失败（检查凭据与网络）'))
    }

    ws.onclose = () => {
      finish(new Error('讯飞连接已关闭，未收到识别结果'))
    }
  })
}

async function asrHandler(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  try {
    if (!XFYUN.appId || !XFYUN.apiKey || !XFYUN.apiSecret) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '讯飞凭据未配置：请把 APPID / APIKey / APISecret 填入 host.js 顶部的 XFYUN 常量，然后重启 dsh' }))
      return
    }
    const body = await readJsonBody(req)
    if (typeof body.audio !== 'string' || body.audio.length === 0) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '缺少 audio 字段（base64 PCM 16k/16bit）' }))
      return
    }
    const pcm = Buffer.from(body.audio, 'base64')
    const text = await iatTranscribe(pcm)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ text }))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: err && err.message ? err.message : String(err) }))
  }
}

export function apply(ctx) {
  const disposeHf = ctx.webServer.register({ kind: 'prefix', path: HF_ROUTE, handler: hfHandler })
  const disposeAsr = ctx.webServer.register({ kind: 'exact', path: ASR_ROUTE, handler: asrHandler })
  // ctx.effect 的回调体会被立即执行，必须「返回清理函数」，
  // 否则刚注册的路由会被当场销毁。
  ctx.effect(() => () => {
    disposeHf()
    disposeAsr()
  })
}

// Exported for the standalone connectivity test (test/iat-test.mjs).
export { iatTranscribe }
