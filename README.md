# 🎤 dsh-voice

> DeepSeek Harness (dsh) 语音转文字插件：输入框右下角一个麦克风按钮，说完话，文字直接进输入框。

<p align="center">
  <b>点一下说话 · 再点一下出字 · 三种识别引擎可切换 · 液态玻璃风格</b>
</p>

## ✨ 功能特性

- 🎙️ **一键语音输入**：输入框右下角（发送键左侧）的麦克风按钮，点一下开始录音、再点一下停止并转写，结果**追加**进输入框；
- 🔁 **三种识别引擎**（改一个常量切换）：
  | 引擎 | 说明 | 费用 |
  |---|---|---|
  | `webspeech`（默认） | 浏览器自带语音识别，装完即用、零配置（Edge 走微软云端，国内可用；Chrome 走谷歌，国内可能不通） | 免费 |
  | `xfyun` | 讯飞语音听写，中文效果最好、秒级返回，密钥只存在本机服务端 | 免费额度/按量 |
  | `whisper` | 浏览器本地 Whisper（small q8），音频不出机器、可离线 | 免费 |
- 🎚️ **麦克风设备选择下拉框**：列出所有音频输入设备，选择持久化（`localStorage`），不再被浏览器的默认麦克风坑（Web Speech 引擎不支持指定设备，该模式下自动隐藏）；
- 📈 **自动增益**：安静麦克风录出的低音量语音会自动放大再识别，避免"没检测到声音"；
- 🔇 **静音/过短拦截**：完全无声或不足 0.25 秒的录音直接本地拦截，不浪费云端配额；
- 📝 **长句完整拼接**：讯飞按 VAD 把长语音切成多段，插件会把所有段落按顺序拼回，不会只出后半句；
- 🪟 **液态玻璃主题**：按钮用 `--dsw-*` 设计令牌 + `--lg-glass-blur` 毛玻璃效果，与 [dsh-liquid-glass](https://github.com/xingyingyuzhui/dsh-liquid-glass) 主题一致。

## 🚀 安装

```sh
dsh plugin --profile web add git+https://github.com/charlie-pan/dsh-voice.git
客户端：
github:charlie-pan/dsh-voice
github:Karanoyo/dsh-voice-
```

重启 dsh web 并硬刷新，打开一个会话即可在输入框右下角看到麦克风按钮。

## 🛠️ 配置

改 `client.js` 顶部的常量：

| 常量 | 默认 | 说明 |
|---|---|---|
| `ASR_ENGINE` | `'webspeech'` | `'webspeech'` / `'xfyun'` / `'whisper'` |
| `WEBSpeech_LANG` | `'zh-CN'` | Web Speech 引擎的语言 |
| `MODEL_ID` | `onnx-community/whisper-small` | Whisper 引擎的模型；中文想更好可换 medium |
| `TRANSCRIBE_LANGUAGE` | `'chinese'` | Whisper 引擎的转写语言；`null` = 自动检测 |

### 讯飞凭据（使用 `xfyun` 引擎时）

1. 注册 [讯飞开放平台](https://www.xfyun.cn/) → 控制台 →「我的应用」→ 创建应用（开通**语音听写**），拿到 **APPID / APIKey / APISecret**；
2. 二选一配置（密钥只存在本机，不进浏览器、不要提交到仓库）：
   - **环境变量**：`XFYUN_APPID` / `XFYUN_APIKEY` / `XFYUN_APISECRET`；
   - **本地文件**：在插件目录放一个 `xfyun.secret.json`（已被 `.gitignore` 忽略）：`C:\Users\%username%\.dsh\profiles\desktop\node_modules\dsh-voice\`

```json
{ "appId": "…", "apiKey": "…", "apiSecret": "…" }
```

3. 重启 dsh web（host 半在启动时加载）。

## ❓ 常见问题

- **点麦克风没反应/没声音**：检查设备下拉框选的是不是正在用的麦克风；`webspeech` 引擎用的是浏览器默认麦克风，需在浏览器设置里改默认设备。
- **Chrome 下 Web Speech 报 `network` 错误**：国内 Chrome 走谷歌服务不可用，换 Edge（或 WebView2 内核），或改用 `xfyun` 引擎。
- **识别出"you/thank you"等英文乱码（whisper 引擎）**：`TRANSCRIBE_LANGUAGE` 已默认强制中文；换其他语言改它即可。
- **长句只出后半段（xfyun 引擎）**：已修复（多段拼接）；若仍出现请反馈。
- **语音输入没出字但讯飞用量增加**：录音太安静被 VAD 判为无人说话——自动增益已解决大部分情况；建议在 Windows 声音设置里调高麦克风输入音量。

## 🧱 插件结构

```
dsh-voice/
├── package.json        # dsh.bundle.patch + dsh.client(web)
├── cordis.patch.yml    # 插入插件行
├── host.js             # Node 半：/dsh-voice/asr（讯飞）+ /dsh-voice/hf（模型代理）
├── client.js           # 浏览器半：按钮/下拉框/录音/转写/写回
├── README.md · LICENSE · .gitignore
```

## 🔧 开发

```sh
# 本地迭代（改 client.js 刷新即可生效；改 host.js 需重启 dsh）
dsh plugin --profile web add link:<本目录绝对路径>
```

## 📄 License

[MIT](LICENSE)
