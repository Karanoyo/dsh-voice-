// dsh-voice —— Browser client half.
//
// Renders a microphone button in the composer's tool row (bottom-right, just
// before the send button) via the `conversation.input.right` slot. Click to
// record, click again to stop; audio is resampled to 16 kHz mono in-browser
// and transcribed with Whisper (small) through transformers.js. The result is
// appended to the composer draft via `inputActions.setDraft`.
//
// Styled to match the Liquid Glass theme: `--dsw-*` design tokens plus the
// `--lg-glass-blur` backdrop-filter variable that dsh-liquid-glass sets.
window.__ModuleLoader__.load({
  id: 'dsh-voice',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var el = React.createElement

    // ------------------------------------------------------------------
    // Configuration. Edit these before rebuilding/installing.
    // ------------------------------------------------------------------
    var TRANSFORMERS_ESM =
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm'
    var MODEL_ID = 'onnx-community/whisper-small' // 本地 Whisper small
    // 强制转写语言。Whisper 对中文的自动检测不稳：会把中文误判成英文，
    // 输出 "you / thank you" 之类的垃圾词。默认锁定中文；
    // 说英文时改成 'english'，或设 null 恢复自动检测。
    var TRANSCRIBE_LANGUAGE = 'chinese'
    // 识别引擎（三选一）：
    //  'webspeech' = 浏览器自带语音识别（无需密钥/无需模型，用浏览器默认麦克风；
    //                Edge 走微软云端、Chrome 走谷歌，不支持指定设备）
    //  'xfyun'     = 讯飞云端（中文效果好、秒级返回；密钥只在本机 host 半）
    //  'whisper'   = 浏览器本地 Whisper（免费离线，small 中文一般）
    var ASR_ENGINE = 'xfyun'
    var WEBSpeech_LANG = 'zh-CN'
    // 📝 识别结果追加到输入框已有内容末尾时的分隔符（🎲 可选值开关）:
    //   ''  = 直接拼接（什么都不加） | ' ' = 追加一个空格 | '，' = 追加中文逗号 | '\n' = 追加一个换行
    var APPEND_SEPARATOR = ''
    var XFYUN_ASR_URL =
      (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:3080') +
      '/dsh-voice/asr'
    // 模型文件经 dsh host 的同源代理路由（/dsh-voice/hf）转发到 hf-mirror.com，
    // 规避浏览器的 CORS 限制（hf-mirror.com 不带 CORS 头，huggingface.co 又直连不通）。
    var HF_REMOTE_HOST =
      (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:3080') +
      '/dsh-voice/hf'
    var SLOT_NAME = 'conversation.input.right' // 输入框工具行右端、发送键左侧
    var SLOT_ID = 'dsh-voice-mic'
    var STYLE_ID = 'dsh-voice-css'
    var MIC_STORAGE_KEY = 'dsh-voice.micDeviceId' // localStorage 记住选择的麦克风

    // ------------------------------------------------------------------
    // transformers.js lazy loader (ESM dynamic import of the jsDelivr
    // `+esm` bundle — the official web entry, with onnxruntime-web inlined).
    // ------------------------------------------------------------------
    var transformersReady = null
    function loadTransformers() {
      if (transformersReady === null) {
        transformersReady = import(TRANSFORMERS_ESM).then(function (mod) {
          var tf = mod
          if (!tf || typeof tf.pipeline !== 'function') {
            tf = mod && mod.default ? mod.default : mod
          }
          if (!tf || typeof tf.pipeline !== 'function') {
            throw new Error('transformers.js 模块导出异常')
          }
          return tf
        })
      }
      return transformersReady
    }

    // Model download/init progress, shared with the mic button (single reader).
    var progressState = { status: 'idle', progress: 0, file: '' }
    var progressListeners = new Set()
    function publishProgress(next) {
      progressState = next
      progressListeners.forEach(function (fn) {
        fn(next)
      })
    }
    function subscribeProgress(fn) {
      progressListeners.add(fn)
      fn(progressState)
      return function () {
        progressListeners.delete(fn)
      }
    }

    // Model pipeline is created once and reused across recordings.
    var pipelinePromise = null
    function getPipeline() {
      if (pipelinePromise === null) {
        pipelinePromise = loadTransformers().then(function (tf) {
          var env = tf.env
          if (env) {
            env.remoteHost = HF_REMOTE_HOST
            env.allowLocalModels = false
          }
          // q8 = quantized (half size, faster). Remove `dtype` for fp32 if the
          // quantized weights are unavailable for a given model.
          return tf.pipeline('automatic-speech-recognition', MODEL_ID, {
            dtype: 'q8',
            progress_callback: function (info) {
              var st = info && info.status
              if (st === 'progress' && typeof info.progress === 'number') {
                publishProgress({ status: 'progress', progress: info.progress, file: info.file || '' })
              } else if (st === 'initiate') {
                publishProgress({ status: 'initiate', progress: 0, file: info.file || '' })
              } else if (st === 'done') {
                publishProgress({ status: 'done', progress: 100, file: info.file || '' })
              } else if (st === 'ready') {
                publishProgress({ status: 'ready', progress: 100, file: '' })
              } else if (st === 'error') {
                publishProgress({ status: 'error', progress: 0, file: info.file || '' })
              }
            },
          })
        })
      }
      return pipelinePromise
    }

    // One-time warmup: the FIRST forward creates the ONNX sessions, which in
    // browser WASM takes ~1-2 minutes (native CPU ~30s). Run it during the
    // loading phase so the user waits upfront, not after recording.
    var warmupDone = false
    function warmup(pipe) {
      if (warmupDone) return Promise.resolve()
      var t = Date.now()
      console.log('[dsh-voice] 首次初始化模型（创建 ONNX 会话，浏览器 WASM 约 1–2 分钟）…')
      var dummy = new Float32Array(1600) // 0.1s 静音
      return pipe(dummy, TRANSCRIBE_LANGUAGE ? { language: TRANSCRIBE_LANGUAGE } : undefined).then(function () {
        warmupDone = true
        console.log('[dsh-voice] 模型就绪（' + ((Date.now() - t) / 1000).toFixed(1) + 's）')
      })
    }

    // ------------------------------------------------------------------
    // Audio: decode the recorded blob and resample to 16 kHz mono Float32.
    // ------------------------------------------------------------------
    async function decodeTo16kMono(blob) {
      var arrayBuffer = await blob.arrayBuffer()
      var Ctx = window.AudioContext || window.webkitAudioContext
      var actx = new Ctx()
      try {
        var decoded = await actx.decodeAudioData(arrayBuffer)
        var rate = 16000
        var length = Math.max(1, Math.ceil(decoded.duration * rate))
        var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext
        var offline = new Offline(1, length, rate)
        var src = offline.createBufferSource()
        src.buffer = decoded
        src.connect(offline.destination)
        src.start(0)
        var rendered = await offline.startRendering()
        return rendered.getChannelData(0)
      } finally {
        if (actx.close) actx.close().catch(function () {})
      }
    }

    function extractText(result) {
      if (!result) return ''
      if (typeof result.text === 'string') return result.text
      if (Array.isArray(result) && result.length && typeof result[0].text === 'string') {
        return result[0].text
      }
      return ''
    }

    // ------------------------------------------------------------------
    // iFlytek (讯飞) path: float samples -> 16-bit PCM -> base64 -> POST to
    // the host half, which talks to the iFlytek IAT WebSocket API.
    // ------------------------------------------------------------------
    // 自动增益：安静麦克风录出的低音量语音，讯飞 VAD 会判为"无人说话"，
    // 白白消耗配额却返回空结果。这里把峰值拉升到 0.8（最多放大 20 倍）。
    function normalizeAudio(samples, targetPeak, maxGain) {
      targetPeak = targetPeak === undefined ? 0.8 : targetPeak
      maxGain = maxGain === undefined ? 20 : maxGain
      var peak = 0
      for (var i = 0; i < samples.length; i++) {
        var a = Math.abs(samples[i])
        if (a > peak) peak = a
      }
      if (peak <= 0) return samples
      var gain = Math.min(maxGain, targetPeak / peak)
      if (gain < 1.02) return samples
      var out = new Float32Array(samples.length)
      for (var j = 0; j < samples.length; j++) {
        out[j] = samples[j] * gain
      }
      return out
    }

    // ------------------------------------------------------------------
    // 🎙️ 智能静音压缩：用户在说话过程中停顿思考（如停顿 5 秒）时，
    // 原始音频中会有漫长的空白。讯飞等云端识别在遇到长静音时极易触发分句截断或丢字。
    // 该函数在保证声音毫无损耗的前提下，将超过 0.6 秒的冗余连续静音平滑压缩到 0.35 秒，
    // 使得云端收到的音频自然连贯，彻底消除中途停顿导致的文本丢失！
    // ------------------------------------------------------------------
    function compressSilence(samples, threshold, maxSilenceSec) {
      if (!samples || samples.length === 0) return samples
      threshold = threshold === undefined ? 0.012 : threshold
      maxSilenceSec = maxSilenceSec === undefined ? 0.35 : maxSilenceSec

      var sampleRate = 16000
      var blockSize = 1600 // 100ms 一个检测块
      var maxSilenceBlocks = Math.max(1, Math.round((maxSilenceSec * sampleRate) / blockSize))

      var keptBlocks = []
      var consecutiveSilence = 0

      for (var offset = 0; offset < samples.length; offset += blockSize) {
        var end = Math.min(offset + blockSize, samples.length)
        var block = samples.subarray(offset, end)

        // 计算该 100ms 块的能量峰值
        var peak = 0
        for (var i = 0; i < block.length; i++) {
          var abs = Math.abs(block[i])
          if (abs > peak) peak = abs
        }

        var isSilence = peak < threshold
        if (isSilence) {
          consecutiveSilence++
          if (consecutiveSilence <= maxSilenceBlocks) {
            keptBlocks.push(block)
          }
          // 超过最大静音块数的长停顿被平滑过滤，杜绝触发云端截断
        } else {
          consecutiveSilence = 0
          keptBlocks.push(block)
        }
      }

      var totalLen = 0
      for (var b = 0; b < keptBlocks.length; b++) {
        totalLen += keptBlocks[b].length
      }

      if (totalLen >= samples.length || totalLen < 1600) {
        return samples
      }

      var out = new Float32Array(totalLen)
      var writeOffset = 0
      for (var k = 0; k < keptBlocks.length; k++) {
        out.set(keptBlocks[k], writeOffset)
        writeOffset += keptBlocks[k].length
      }
      console.log(
        '[dsh-voice] 静音压缩完成: 原时长 ' + (samples.length / 16000).toFixed(1) + 's -> 压缩后 ' +
        (out.length / 16000).toFixed(1) + 's (成功消除停顿，杜绝丢字)',
      )
      return out
    }

    function floatToPcm16(samples) {
      var out = new Int16Array(samples.length)
      for (var i = 0; i < samples.length; i++) {
        var s = Math.max(-1, Math.min(1, samples[i]))
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      return out
    }

    function int16ToBase64(pcm) {
      var bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
      var binary = ''
      var CHUNK = 0x8000
      for (var i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
      }
      return btoa(binary)
    }

    async function transcribeViaXfyun(samples) {
      var pcm = floatToPcm16(samples)
      var res = await fetch(XFYUN_ASR_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio: int16ToBase64(pcm) }),
      })
      console.log('[dsh-voice] xfyun HTTP ->', res.status)
      var data = await res.json().catch(function () {
        return null
      })
      console.log('[dsh-voice] xfyun 返回:', JSON.stringify(data))
      if (data && data.error) {
        throw new Error(data.error)
      }
      if (!res.ok || !data) {
        throw new Error('讯飞识别失败（HTTP ' + res.status + '）')
      }
      return String(data.text || '').trim()
    }

    // ------------------------------------------------------------------
    // Icons (inline SVG, no dependencies).
    // ------------------------------------------------------------------
    function MicIcon(recording) {
      if (recording) {
        // Stop square while recording.
        return el(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' },
          el('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }),
        )
      }
      return el(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        el('rect', { x: 9, y: 2, width: 6, height: 12, rx: 3 }),
        el('path', { d: 'M5 10v1a7 7 0 0 0 14 0v-1' }),
        el('line', { x1: 12, y1: 18, x2: 12, y2: 22 }),
      )
    }

    function Spinner() {
      return el('span', {
        'aria-hidden': 'true',
        style: {
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: '2px solid rgba(128, 128, 128, 0.35)',
          borderTopColor: 'currentColor',
          display: 'inline-block',
          boxSizing: 'border-box',
          animation: 'dsh-voice-spin 0.8s linear infinite',
        },
      })
    }

    // ------------------------------------------------------------------
    // The mic button. Receives:
    //   input (owner share InputZone) -> current InputState (draft text)
    //   inputActions.setDraft(text)   -> write the draft
    // ------------------------------------------------------------------
    function MicButton(props) {
      var inputActions = props.inputActions
      // Owner share (InputZone) carries the current draft as a point-in-time
      // snapshot re-rendered on every change. Read `input.draft` here (never
      // call the bound `useInput` selector hook — it is not available at this
      // slot entry and throws inside useSyncExternalStore).
      var input = props.input
      var draftRef = React.useRef('')
      draftRef.current = input && typeof input.draft === 'string' ? input.draft : ''
      var 初始文本_引用 = React.useRef('')
      var 光标位置_引用 = React.useRef(-1)

      var phasePair = React.useState('idle') // idle | loading | recording | transcribing
      var phase = phasePair[0]
      var setPhase = phasePair[1]
      var errorPair = React.useState(null)
      var error = errorPair[0]
      var setError = errorPair[1]

      var progressPair = React.useState(progressState)
      var progress = progressPair[0]
      var setProgressView = progressPair[1]
      React.useEffect(function () {
        return subscribeProgress(setProgressView)
      }, [])

      var recorderRef = React.useRef(null)
      var chunksRef = React.useRef([])
      var streamRef = React.useRef(null)
      var mimeRef = React.useRef('audio/webm')
      var deviceLabelRef = React.useRef('')
      var speechRecRef = React.useRef(null)
      var speechFinalRef = React.useRef('')

      React.useEffect(function () {
        return function () {
          stopStream()
        }
      }, [])

      function stopStream() {
        var s = streamRef.current
        if (s) {
          s.getTracks().forEach(function (t) {
            t.stop()
          })
          streamRef.current = null
        }
      }

      // 🔍 辅助函数：定位当前输入框元素（兼容 DSH 官方 Lexical contenteditable 与原生 textarea）
      function 查找编辑框目标() {
        if (typeof document === 'undefined') return null
        var 麦克风按钮 = document.querySelector('[data-dsh-voice-mic]')
        var 容器 = 麦克风按钮 ? (
          麦克风按钮.closest('[data-composer-card]') ||
          麦克风按钮.closest('form') ||
          麦克风按钮.closest('.composer') ||
          (麦克风按钮.parentElement && 麦克风按钮.parentElement.parentElement)
        ) : null

        // 1. 优先定位 DSH 官方 Lexical 编辑器（contenteditable="true"）
        var 可编辑元素 = 容器 ? 容器.querySelector('[contenteditable="true"]') : null
        if (!可编辑元素) {
          可编辑元素 = document.querySelector('[data-composer-card] [contenteditable="true"], .composer [contenteditable="true"], [contenteditable="true"]')
        }
        if (可编辑元素) return { 模式: 'contenteditable', 节点: 可编辑元素 }

        // 2. 兼容原生 textarea 模式
        var 文本域 = 容器 ? 容器.querySelector('textarea') : null
        if (!文本域) {
          文本域 = document.querySelector('[data-composer-card] textarea, .composer textarea, textarea')
        }
        if (文本域) return { 模式: 'textarea', 节点: 文本域 }

        return null
      }

      // 🔍 辅助函数：实时读取当前编辑框的文本全文与光标字符偏移量
      function 采样文本与光标() {
        var 目标 = 查找编辑框目标()
        if (!目标 || !目标.节点) {
          return { 找到节点: false, 文本: '', 光标: -1 }
        }

        if (目标.模式 === 'textarea') {
          var ta = 目标.节点
          var 全文ta = ta.value || ''
          var posTa = -1
          try {
            if (typeof ta.selectionStart === 'number') {
              posTa = ta.selectionStart
            }
          } catch (e) {}
          return { 找到节点: true, 文本: 全文ta, 光标: posTa }
        }

        if (目标.模式 === 'contenteditable') {
          var el = 目标.节点
          var 全文ce = (el.innerText || el.textContent || '').replace(/\r/g, '').replace(/\n+$/, '')
          var posCe = -1
          try {
            var sel = window.getSelection ? window.getSelection() : null
            if (sel && sel.rangeCount > 0) {
              var range = sel.getRangeAt(0)
              // 只有当选区锚点落在可编辑容器内部时，才是有意义的活动光标
              if (el.contains(range.startContainer)) {
                var preRange = range.cloneRange()
                preRange.selectNodeContents(el)
                preRange.setEnd(range.startContainer, range.startOffset)
                var preText = preRange.toString().replace(/\r/g, '')
                posCe = Math.max(0, Math.min(preText.length, 全文ce.length))
              }
            }
          } catch (err) {
            console.warn('[dsh-voice] 获取富文本光标失败:', err && err.message)
          }
          return { 找到节点: true, 文本: 全文ce, 光标: posCe }
        }

        return { 找到节点: false, 文本: '', 光标: -1 }
      }

      // 🧭 实时采样光标与文本（严格忠实反映最新状态，包括清空与删除）
      function 实时采样光标() {
        var 采样结果 = 采样文本与光标()
        if (采样结果.找到节点) {
          // 💡 只要定位到了编辑框DOM，就忠实采纳（哪怕是空串，也表示用户主动删光了内容）
          初始文本_引用.current = 采样结果.文本
          if (采样结果.光标 >= 0) {
            光标位置_引用.current = Math.min(采样结果.光标, 采样结果.文本.length)
          } else {
            光标位置_引用.current = -1
          }
        }
      }

      // 🎧 全生命周期监听：在打字、删除、输入、录音、点击编辑框时全程跟踪光标与文本
      React.useEffect(function () {
        function 选区变更处理() {
          实时采样光标()
        }
        if (typeof document !== 'undefined' && document.addEventListener) {
          document.addEventListener('input', 选区变更处理, true)
          document.addEventListener('selectionchange', 选区变更处理, true)
          document.addEventListener('keyup', 选区变更处理, true)
          document.addEventListener('mouseup', 选区变更处理, true)
          document.addEventListener('cut', 选区变更处理, true)
          document.addEventListener('paste', 选区变更处理, true)
        }
        return function () {
          if (typeof document !== 'undefined' && document.removeEventListener) {
            document.removeEventListener('input', 选区变更处理, true)
            document.removeEventListener('selectionchange', 选区变更处理, true)
            document.removeEventListener('keyup', 选区变更处理, true)
            document.removeEventListener('mouseup', 选区变更处理, true)
            document.removeEventListener('cut', 选区变更处理, true)
            document.removeEventListener('paste', 选区变更处理, true)
          }
        }
      }, [])

      // 🎯 光标精准定位：识别文本写入后，光标精准停在插入文字后面，绝不跳到行尾
      function 恢复编辑框光标(目标偏移) {
        if (typeof 目标偏移 !== 'number' || 目标偏移 < 0) return
        // 延时等待 DSH 客户端 React/Lexical 完成 DOM 重新渲染
        setTimeout(function () {
          try {
            var 目标 = 查找编辑框目标()
            if (!目标 || !目标.节点) return

            // 1. 原生 textarea 模式
            if (目标.模式 === 'textarea') {
              var ta = 目标.节点
              if (typeof ta.setSelectionRange === 'function') {
                ta.focus()
                ta.setSelectionRange(目标偏移, 目标偏移)
              }
              return
            }

            // 2. DSH 官方 Lexical contenteditable 模式
            if (目标.模式 === 'contenteditable') {
              var el = 目标.节点
              el.focus()
              var sel = window.getSelection ? window.getSelection() : null
              if (!sel) return

              var charCount = 0
              var found = false
              var range = document.createRange()

              function traverseNodes(node) {
                if (found) return
                if (node.nodeType === 3) { // 纯文本节点
                  var nextCount = charCount + node.nodeValue.length
                  if (目标偏移 <= nextCount) {
                    var offsetInNode = Math.max(0, 目标偏移 - charCount)
                    range.setStart(node, offsetInNode)
                    range.collapse(true)
                    found = true
                    return
                  }
                  charCount = nextCount
                } else if (node.nodeType === 1) { // 容器元素节点
                  for (var i = 0; i < node.childNodes.length; i++) {
                    traverseNodes(node.childNodes[i])
                    if (found) return
                  }
                }
              }

              traverseNodes(el)
              if (found) {
                sel.removeAllRanges()
                sel.addRange(range)
              }
            }
          } catch (e) {
            console.warn('[dsh-voice] 恢复光标位置失败:', e && e.message)
          }
        }, 60)
      }

      function appendText(text) {
        if (!inputActions || typeof inputActions.setDraft !== 'function') {
          console.warn('[dsh-voice] inputActions 不可用，文字无法写回输入框')
          return
        }

        // 1. 写回前再次主动采样一次最新状态
        实时采样光标()

        // 2. 真实获取当前编辑框最新文本
        var 采样结果 = 采样文本与光标()
        var 当前文本 = 采样结果.找到节点 ? 采样结果.文本 : (初始文本_引用.current || '')

        var 目标光标 = 光标位置_引用.current
        var 最终拼接文本 = ''
        var 恢复光标位置 = -1

        // 3. 判断插入或拼接逻辑
        if (!当前文本) {
          // 当前编辑框无内容：直接写入新识别内容
          console.log('[dsh-voice] 当前编辑框无文本，直接写入新识别内容')
          最终拼接文本 = text
          恢复光标位置 = text.length
        } else if (目标光标 >= 0 && 目标光标 <= 当前文本.length) {
          // 在有效光标位置插入文本
          console.log('[dsh-voice] 在光标位置 (' + 目标光标 + ') 插入文本, 原文长度: ' + 当前文本.length)
          最终拼接文本 = 当前文本.slice(0, 目标光标) + text + 当前文本.slice(目标光标)
          // 💡 光标精准定在刚刚插入文字的正后方，绝不跳到整段末尾！
          恢复光标位置 = 目标光标 + text.length
        } else {
          // 未检测到有效光标，拼接到末尾
          console.log('[dsh-voice] 未检测到有效光标（' + 目标光标 + '），拼接到文本末尾')
          最终拼接文本 = 当前文本 + APPEND_SEPARATOR + text
          恢复光标位置 = 最终拼接文本.length
        }

        inputActions.setDraft(最终拼接文本)
        console.log('[dsh-voice] 已写回输入框最终内容:', JSON.stringify(最终拼接文本), '目标光标:', 恢复光标位置)

        // 4. 精确将光标移动到插入文字后面，不再跳到行尾
        恢复编辑框光标(恢复光标位置)

        // 5. 更新状态与缓存
        光标位置_引用.current = 恢复光标位置
        初始文本_引用.current = 最终拼接文本
      }

      function onButtonMouseDown(e) {
        // 🛡️ 点击麦克风按钮保焦：阻止 mousedown 默认转移焦点的行为，
        // 确保输入框的光标不失焦、不消失、选区不被清除
        实时采样光标()
        if (e && typeof e.preventDefault === 'function') {
          e.preventDefault()
        }
      }

      async function begin() {
        setError(null)
        // 🎙️ 录音开始瞬间，锁定并记录当前编辑框内容与光标位置
        实时采样光标()
        console.log('[dsh-voice] 录音开始，记录初始光标:', 光标位置_引用.current, '初始文本:', JSON.stringify(初始文本_引用.current))
        try {
          setPhase('loading')
          if (ASR_ENGINE === 'whisper') {
            var pipe = await getPipeline()
            await warmup(pipe)
          }

          if (ASR_ENGINE === 'webspeech') {
            // 浏览器自带识别：不经过 getUserMedia/MediaRecorder，
            // 浏览器自己接管麦克风（使用其默认设备），结果走 onresult 回调。
            var SR = window.SpeechRecognition || window.webkitSpeechRecognition
            if (!SR) {
              throw new Error('当前浏览器不支持 Web Speech API 语音识别')
            }
            var wrec = new SR()
            wrec.lang = WEBSpeech_LANG
            wrec.interimResults = true
            wrec.continuous = true
            speechRecRef.current = wrec
            speechFinalRef.current = ''
            wrec.onresult = function (e) {
              var fin = ''
              for (var i = 0; i < e.results.length; i++) {
                if (e.results[i].isFinal) fin += e.results[i][0].transcript
              }
              speechFinalRef.current = fin
              console.log('[dsh-voice] WebSpeech 中间结果:', JSON.stringify(fin))
            }
            wrec.onerror = function (e) {
              console.error('[dsh-voice] WebSpeech 错误:', e.error)
              if (e.error !== 'aborted') {
                setError('浏览器语音识别错误: ' + e.error)
              }
            }
            wrec.onend = function () {
              var text = speechFinalRef.current.trim()
              console.log('[dsh-voice] WebSpeech 结束，文本:', JSON.stringify(text))
              if (text) appendText(text)
              speechRecRef.current = null
              setError(null)
              setPhase('idle')
            }
            wrec.start()
            setPhase('recording')
            return
          }

          var micId = localStorage.getItem(MIC_STORAGE_KEY) || ''
          // 关闭 Chromium 的自动处理（AGC/降噪/回声消除），拿原始信号，
          // 避免它在某些环境里把音量压得过低；低音量由 normalizeAudio 统一补偿。
          var rawAudio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          var constraints = micId
            ? { audio: Object.assign({ deviceId: { exact: micId } }, rawAudio) }
            : { audio: rawAudio }
          var stream = await navigator.mediaDevices.getUserMedia(constraints)
          var audioTrack = stream.getAudioTracks()[0]
          deviceLabelRef.current = audioTrack ? audioTrack.label || '未知设备' : '未知设备'
          console.log('[dsh-voice] 实际使用的麦克风:', deviceLabelRef.current)
          streamRef.current = stream
          chunksRef.current = []

          var mime = ''
          if (window.MediaRecorder) {
            if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus'
            else if (MediaRecorder.isTypeSupported('audio/mp4')) mime = 'audio/mp4'
          }
          mimeRef.current = mime || 'audio/webm'

          var rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
          recorderRef.current = rec
          rec.ondataavailable = function (e) {
            if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
          }
          rec.onerror = function () {
            setError('录音出错')
            setPhase('idle')
          }
          rec.onstop = function () {
            finish()
          }
          rec.start()
          setPhase('recording')
        } catch (err) {
          stopStream()
          setError(err && err.message ? err.message : String(err))
          setPhase('idle')
        }
      }

      async function finish() {
        var blob = new Blob(chunksRef.current, { type: mimeRef.current })
        chunksRef.current = []
        stopStream()
        setPhase('transcribing')
        try {
          var samples = await decodeTo16kMono(blob)
          var maxAmp = 0
          for (var i = 0; i < samples.length; i++) {
            var a = Math.abs(samples[i])
            if (a > maxAmp) maxAmp = a
          }
          console.log(
            '[dsh-voice] 录音: blob=' + blob.size + 'B, ' +
            (samples.length / 16000).toFixed(1) + 's, 最大振幅=' + maxAmp.toFixed(3),
          )
          if (maxAmp < 0.0005) {
            throw new Error('未检测到声音：本次实际使用的设备是「' + deviceLabelRef.current + '」。请在下拉框中选择你正在用的麦克风')
          }
          if (samples.length < 16000 * 0.25) {
            throw new Error('录音太短（不足 0.25 秒），未发送识别')
          }
          if (maxAmp < 0.02) {
            console.warn('[dsh-voice] 音量偏低（振幅 ' + maxAmp.toFixed(4) + '），已自动增益')
          }
          var beforePeak = maxAmp
          samples = normalizeAudio(samples)
          // 🎙️ 在增益后进行智能静音压缩，消除说话中途的漫长停顿，防止云端引擎丢字截断！
          samples = compressSilence(samples)
          var afterPeak = 0
          for (var j = 0; j < samples.length; j++) {
            var b = Math.abs(samples[j])
            if (b > afterPeak) afterPeak = b
          }
          console.log('[dsh-voice] 增益: 峰值 ' + beforePeak.toFixed(4) + ' -> ' + afterPeak.toFixed(4))
          var text = ''
          if (ASR_ENGINE === 'xfyun') {
            text = await transcribeViaXfyun(samples)
          } else {
            var pipe = await getPipeline()
            var genOpts = TRANSCRIBE_LANGUAGE ? { language: TRANSCRIBE_LANGUAGE } : undefined
            var result = await pipe(samples, genOpts)
            text = extractText(result).trim()
          }
          console.log('[dsh-voice] 识别结果:', JSON.stringify(text))
          if (text) {
            appendText(text)
          } else {
            throw new Error('未识别到内容（录音 ' + (samples.length / 16000).toFixed(1) + 's，振幅 ' + maxAmp.toFixed(3) + '，设备「' + deviceLabelRef.current + '」）——若设备不是你的麦克风，请在下拉框切换')
          }
          setError(null)
          setPhase('idle')
        } catch (err) {
          console.error('[dsh-voice] 转写失败:', err && err.message ? err.message : err)
          setError(err && err.message ? err.message : String(err))
          setPhase('idle')
        }
      }

      function onClick() {
        if (phase === 'recording') {
          if (ASR_ENGINE === 'webspeech') {
            var wsr = speechRecRef.current
            if (wsr) wsr.stop()
            return
          }
          var rec = recorderRef.current
          if (rec && rec.state !== 'inactive') rec.stop()
        } else if (phase === 'idle') {
          begin()
        }
      }

      var recording = phase === 'recording'
      var busy = phase === 'loading' || phase === 'transcribing'
      var downloading =
        phase === 'loading' && progress.status === 'progress' && typeof progress.progress === 'number'
      var title = error
        ? error
        : recording
          ? '点击停止并转写'
          : busy
            ? (phase === 'loading'
              ? (downloading
                ? '下载模型 ' + Math.floor(progress.progress) + '%（首次约 250MB）'
                : progress.status === 'done' || progress.status === 'ready'
                  ? '初始化模型（首次约 1–2 分钟，仅一次）…'
                  : '加载模型…')
              : '转写中…')
            : '语音转文字'

      var style = {
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 30,
        height: 30,
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        fontSize: 16,
        lineHeight: 1,
        boxSizing: 'border-box',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
        backdropFilter: 'blur(var(--lg-glass-blur, 14px)) saturate(150%)',
        WebkitBackdropFilter: 'blur(var(--lg-glass-blur, 14px)) saturate(150%)',
        transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, opacity 0.15s ease',
      }
      if (recording) {
        style.borderColor = 'rgba(255,82,82,0.6)'
        style.background = 'rgba(255,82,82,0.16)'
        style.color = '#ff5252'
        style.animation = 'dsh-voice-pulse 1s ease-in-out infinite'
      } else if (error) {
        style.borderColor = 'rgba(255,82,82,0.6)'
        style.color = '#ff5252'
      }
      if (busy) {
        style.cursor = 'progress'
        style.opacity = 0.72
      }

      var content
      if (busy) {
        content = downloading
          ? el('span', { style: { fontSize: 9, fontWeight: 600, lineHeight: 1 } }, String(Math.floor(progress.progress)))
          : Spinner()
      } else {
        content = MicIcon(recording)
      }

      return el(
        'button',
        {
          type: 'button',
          'data-dsh-voice-mic': '',
          'aria-label': title,
          'aria-pressed': recording,
          title: title,
          disabled: busy,
          onMouseDown: onButtonMouseDown,
          onClick: onClick,
          style: style,
        },
        content,
      )
    }

    // ------------------------------------------------------------------
    // 麦克风设备选择器：列出音频输入设备，选择持久化到 localStorage，
    // 录音时用所选 deviceId 精确匹配（不再依赖浏览器的默认麦克风）。
    // ------------------------------------------------------------------
    async function listAudioInputs(unlock) {
      try {
        var list = await navigator.mediaDevices.enumerateDevices()
        var inputs = list.filter(function (d) {
          return d.kind === 'audioinput'
        })
        if (unlock && inputs.length > 0 && inputs.every(function (d) {
          return !d.label
        })) {
          // 标签为空说明还没获得麦克风权限：用户正在操作下拉框（用户手势），
          // 申请一次权限即可解锁设备名，然后立刻释放。
          var stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          stream.getTracks().forEach(function (t) {
            t.stop()
          })
          list = await navigator.mediaDevices.enumerateDevices()
          inputs = list.filter(function (d) {
            return d.kind === 'audioinput'
          })
        }
        var seen = {}
        return inputs.filter(function (d) {
          if (seen[d.deviceId]) return false
          seen[d.deviceId] = true
          return true
        })
      } catch (err) {
        console.warn('[dsh-voice] 枚举麦克风失败:', err && err.message ? err.message : err)
        return []
      }
    }

    function MicDeviceSelect() {
      // 浏览器自带识别（webspeech）不支持指定设备，隐藏选择器。
      if (ASR_ENGINE === 'webspeech') return null
      var devicePair = React.useState([])
      var devices = devicePair[0]
      var setDevices = devicePair[1]
      var valuePair = React.useState(function () {
        try {
          return localStorage.getItem(MIC_STORAGE_KEY) || ''
        } catch {
          return ''
        }
      })
      var value = valuePair[0]
      var setValue = valuePair[1]

      React.useEffect(function () {
        var live = true
        function refresh() {
          listAudioInputs(false).then(function (list) {
            if (live) setDevices(list)
          })
        }
        refresh()
        var onChange = function () {
          refresh()
        }
        if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
          navigator.mediaDevices.addEventListener('devicechange', onChange)
        }
        return function () {
          live = false
          if (navigator.mediaDevices && navigator.mediaDevices.removeEventListener) {
            navigator.mediaDevices.removeEventListener('devicechange', onChange)
          }
        }
      }, [])

      function onFocus() {
        listAudioInputs(true).then(setDevices)
      }

      function onPick(e) {
        var id = e.target.value
        setValue(id)
        try {
          localStorage.setItem(MIC_STORAGE_KEY, id)
        } catch {}
      }

      var options = [el('option', { key: '__default', value: '' }, '默认麦克风')]
      if (devices.length === 0) {
        options.push(el('option', { key: '__hint', value: '__hint', disabled: true }, '未列出设备：点麦克风录一次音后回来刷新'))
      } else {
        devices.forEach(function (d) {
          options.push(el('option', { key: d.deviceId, value: d.deviceId }, d.label || ('设备 ' + d.deviceId.slice(0, 8))))
        })
      }

      return el(
        'select',
        {
          'data-dsh-voice-device': '',
          'aria-label': '选择录音设备',
          title: '选择录音设备',
          value: value,
          onChange: onPick,
          onFocus: onFocus,
          style: {
            height: 30,
            borderRadius: 999,
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: 12,
            lineHeight: 1,
            padding: '0 8px',
            cursor: 'pointer',
            boxSizing: 'border-box',
            maxWidth: 150,
            outline: 'none',
            backdropFilter: 'blur(var(--lg-glass-blur, 14px)) saturate(150%)',
            WebkitBackdropFilter: 'blur(var(--lg-glass-blur, 14px)) saturate(150%)',
          },
        },
        options,
      )
    }

    // 一个槽位里渲染：麦克风按钮 + 设备选择下拉框
    function VoiceControl(props) {
      return el(
        'div',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        el(MicButton, props),
        el(MicDeviceSelect, null),
      )
    }

    // ------------------------------------------------------------------
    // Style injection (keyframes only; the rest uses inline styles).
    // ------------------------------------------------------------------
    var CSS =
      '@keyframes dsh-voice-spin{to{transform:rotate(360deg)}}' +
      '@keyframes dsh-voice-pulse{0%,100%{opacity:1}50%{opacity:0.4}}'

    function installStyles() {
      if (document.getElementById(STYLE_ID)) return function () {}
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
      return function () {
        if (style.parentNode) style.parentNode.removeChild(style)
      }
    }

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (!slots || !React) return
      var disposeStyle = installStyles()
      var disposeSlot = slots.inject(SLOT_NAME, function () {
        return slots.register({ name: SLOT_NAME, id: SLOT_ID, order: 0 }, VoiceControl)
      })
      ctx.effect(function () {
        return function () {
          if (disposeSlot) disposeSlot()
          disposeStyle()
        }
      })
    }

    exports.name = 'dsh-voice'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
