# 雨停之前 · Mira Café

与 26 岁原创旅行摄影师 Mira 在雨夜咖啡馆相遇。当前是移动端优先的本地原型，已接入日系 Galgame 咖啡馆插画、确认的 Mira 及局部表情差分，并增加真实语音适配与预算保护，尚未完成整份 PDF 题目。

**默认静音、无需密钥。** 模拟语音不会访问麦克风；松开按钮使用预设台词。只有用户主动点击右上角“声音关闭”按钮开启声音后，才允许浏览器朗读或已配置的 Qwen 播放。刷新后恢复静音。所有自动测试及当前浏览器验收都保持无声。

## 启动

当前可试玩地址：**http://127.0.0.1:3001/**（构建版，默认 Mock / 静音）。已有进程运行时无需重复启动；开发命令与构建版二选一。

实际验证环境：Node 24.11.1、npm 11.6.2。支持 Node 22.12+ 的 22 系列、24 系列或 26+，建议 Node 24。

本机已经安装依赖：
```sh
cd /Users/yemeng/Code/mira-cafe
npm run dev
```
打开 http://127.0.0.1:5173 。前端 5173、API 3001，仅监听本机。

新环境在项目目录用一条命令：
```sh
npm ci --ignore-scripts && npm run dev
```
依赖来自 npm 官方注册源，准确版本在 package-lock.json。当前首次安装约一分钟，实际受网络影响。无需数据库、账号、Docker 或密钥。

构建后也可单进程本地预览：
```sh
npm run build
npm start
```
打开 http://127.0.0.1:3001 。先停止开发进程，避免 API 端口冲突。未创建远程仓库，未 push、未部署。

## 已实现范围

- 场景主体、字幕、文字输入、明确标注的模拟语音入口。
- 待机、倾听、思考、说话与失败状态。
- 中性/戒备、好奇、释然三种眉眼与嘴部状态；固定身体基图，局部蒙版覆盖；模拟眨眼和说话状态嘴型。侧倾/前倾为 CSS 示意动作，照片事件单独呈现。
- 谈到照片后，由当前回复触发照片事件及环境变暖。
- 可取消 Mock；新输入与打断使旧响应、旧字幕、旧动作和待播放事件失效。
- 浏览器朗读仅为可选预览；默认静音走可取消字幕演出，不保证每台机器都有中文声音。
- 体验工具可模拟慢响应、超时、服务失败、朗读失败，并可重试。
- 已替换为用户确认的 Mira AI 立绘。静音 Mock 的眨眼/嘴型是明确标注的模拟；真实模式按播放状态驱动开合，仍不是音素口型，尚未实测。

已确认基图保存在 assets/candidates/mira-character-sample-v1.png，运行资源与四张原始差分在 public/characters/mira/。不修改原图，通过 CSS mask 只覆盖脸部、眼区、嘴区；详见 public/characters/mira/README.md。

## 技术选型与模块

| 层 | 方案 | 取舍 |
|---|---|---|
| 页面 | React 19、TypeScript、Vite 7 | 单页场景，无需 SSR |
| 后端 | Node、Fastify 5 | 单个轻量本地 API，无数据库 |
| 协议 | 共享 TypeScript + Zod 4 | 前后端校验，只执行枚举内动作 |
| 角色 | 已确认 PNG 基图 + 局部 CSS mask 差分 | 固定衣服/身体，避免生成漂移闪烁 |
| 文字 | Mock / DeepSeek provider | 默认 Mock，真实适配器可取消 |
| 语音 | AudioWorklet + 16k PCM、Qwen realtime ASR/TTS、24k PCM 调度 | 显式启用；当前只验证假设备与假协议 |
| 验证 | Vitest 5、Fastify inject、静音浏览器检查 | 重点覆盖竞争、取消和恢复 |

src/core/engine.ts 负责状态和演出编排；audio.ts 负责默认静音与播放生命周期；transport.ts 负责请求和取消。shared/protocol.ts 定义指令。server/app.ts 负责会话水位、超时和恢复；providers.ts 实现 Mock 与 DeepSeek；qwen.ts 实现服务端语音协议，speech-routes.ts 代理同源 WebSocket。microphone.ts / shared/pcm.ts 负责采集与重采样，voice-input.ts 处理按住说话生命周期，pcm-playback.ts 用音频时钟呈现句子。

## 打断与字幕

每次输入先同步递增 turnId，再 abort 旧请求、停止播放器、清空待执行字幕与动作。服务端按 sessionId 维护最新轮次，拒绝旧请求；取消通过 throughTurnId 水位处理，晚到的旧取消不能误伤新轮次。

网络结果、播放开始回调和每个异步继续点均检查轮次。即使 Provider 忽略 abort，旧内容也不能重放。服务端 18 秒超时，客户端 21 秒超时。

短回复完整通过 Zod 校验后分句播放。在音频 onstart 时才显示对应句子并触发该段动作；静音或朗读失败时使用可取消字幕时间线。字幕当前按句推进，没有精确逐字时间戳；降级按文字长度估时。只把完整呈现的助手句子写入后续历史。已经展示的照片可保留，未展示的事件被打断后不再出现。

按住模拟语音立即进入倾听，松开提交预设台词。真实 ASR 代码采用按住说话/松开提交，需显式切换输入模式和本机配置；暂不做自动 VAD。

## 结构化指令

```json
{"segments":[{"text":"这张照片，是我今晚等待的原因。","emotion":"curious","action":"offer-photo","event":"reveal-photo"}]}
```

emotion：guarded / curious / relieved；action：idle / look-window / offer-photo；可选 scene：rain / warm；可选 event：reveal-photo。每次 1–3 段，每段最多 180 字。未知字段、未知动作拒绝。只将 text 分句交给语音层，不朗读 JSON，不执行外部媒体 URL 或任意代码。

## 真实服务与凭据

用户自行填写 .env 后，已按明确授权仅在程序内加载对应密钥，完成三次真实连通测试；未回显或修改密钥，未录音、出声或重试。详见 [LIVE_SMOKE](docs/LIVE_SMOKE.md)。默认 MIRA_ENABLE_LIVE_APIS=false，代码在此状态不读取任何密钥字段。只有明确启用总开关、选择 provider 并填写完整配置后才创建真实适配器。缺少配置各自回退 Mock。

DeepSeek 请求已用假 fetch 验证：可配置 DEEPSEEK_MODEL（默认 deepseek-flash）、thinking.type=disabled、response_format=json_object。Qwen 实现 qwen3-asr-flash-realtime / qwen3-tts-flash-realtime，地域和官方端点由用户选择；服务端 WebSocket 持有密钥。浏览器采集经低通重采样为 16k PCM，TTS 使用 24k PCM，按播放时钟触发句子字幕和动作。

**本地配置步骤、变量、地区和显式录音说明见 [docs/LIVE_SETUP.md](docs/LIVE_SETUP.md)。** .env 已被忽略；普通 npm start 不加载它，用户填写后需主动使用 npm run start:configured。页面默认仍是模拟输入与关闭声音。没有真实麦克风权限、录音、出声或云服务验收；替身测试不能代替真实验证。

官方资料：
- https://api-docs.deepseek.com/api/create-chat-completion/
- https://api-docs.deepseek.com/guides/json_mode/
- https://help.aliyun.com/en/model-studio/qwen-asr-realtime-interaction-process
- https://help.aliyun.com/en/model-studio/interactive-process-of-qwen-tts-realtime-synthesis

## 验证

```sh
npm run check
```
执行类型检查、单元/API 测试和构建。75/75 测试通过；全部依赖 npm audit 为 0 项已知漏洞（2026-10-25）。自动测试用假音频、假网络，不出声、不访问第三方模型。

静音试玩：问“你在等谁？”→ 演出时打断 → 继续问照片 → 体验工具模拟超时并重试 → 选择慢响应后连续发送新问题。不要为测试点击开启声音。完整记录在 docs/ACCEPTANCE.md。

## 来源、限制与后续两周

场景、照片示意和第一阶段人物占位层由本项目 SVG/CSS 绘制，没有下载外部字体或照片。角色及局部差分来自用户任务中的 AI 生成资产，已获用户采用确认，身份和现状单独记录。开源依赖见锁文件。

已完成指定 DeepSeek/Qwen 账号三次限量连通验证。未完成：真实设备录音/音频听感验收、差分接缝与角色表演的用户验收、真实手机验收、3–5 分钟交付录屏。采集、重采样和实时适配代码已完成，假设备/假网络测试通过；真实服务已完成单句合成→重采样→识别，尚未进行麦克风或播放测试。Mock 剧情分支有限，不等价于真实模型自由对话。内存会话最多 100 个，30 分钟清理，刷新重开，无持久化。

构建存在 Zod 上游注释 tree-shaking 警告，构建成功；浏览器检查没有 JavaScript 异常。静音是明确用户要求，实际出声测试须得到新的明确同意。

时间：仓库创建于 2026-10-25 08:01 UTC，首轮验收约 08:14 UTC，静音与依赖修复后的最终检查约 08:26 UTC。约 25 分钟 agent 执行时间，不代表人工工时；人工投入待用户补充。截止为 2026-10-28 07:32 UTC（北京时间 15:32）。

继续两周：先安全接入并测量 DeepSeek/Qwen；实测 PCM 播放时钟、字幕和真实打断；完善已接入的立绘差分与角色表演；覆盖实机与弱网恢复；再做会话回放、延迟观测，最后评估 VAD、口型和生成式媒体。



## 本轮确认与预算

用户已采用 Mira 形象，选择百炼北京区域，DeepSeek + Qwen 合计预算人民币 10 元，不自动充值。示例已预填北京端点；Key 已由用户在本机填写；程序仅在授权连通测试与当前真实模式中加载，未输出或修改。

预算保护在发出请求前持久化预留：DeepSeek 0.20 元/次，ASR 0.02 元/次，TTS 0.04 元/次；合计最多 60 次、预留超过 8 元前停止。取消/错误不退款，重启不清零。MIRA_BILLING_CONFIRMED 默认 false；未经费率和用量核对，真实调用保持关闭。它是保守预留与限次，不是实际账单，不能宣称精准 10 元云端硬限。详见 docs/LIVE_SETUP.md。

眨眼/嘴型差分只覆盖独立局部，身体不换图。静音时钟用于模拟，打断立即闭嘴；真实音频模式只以播放状态启停嘴型，尚未验证实际听感和音素匹配。减少动态效果偏好会停用眨眼、嘴型及 CSS 动画。

## 插画咖啡馆背景

已用主任务提供的日系视觉小说风咖啡馆图替换程序绘制主体。源图在 public/backgrounds/mira-cafe-galgame-background.png，1672×941 RGB，原图保留。加载成功后隐藏旧窗框、吊灯与桌子，失败回退原场景。桌面居中、手机55%水平裁切；轻雨和剧情变暖仍在，字幕局部遮罩保留可读性，不整图压暗。桌面与390px静音检查、HTTP资源检查及最终75项测试/类型/构建通过。背景身份见 public/backgrounds/README.md。

## 语音转文字优先核验（2026-10-25）

真实语音最终识别结果会显示为“你 · 语音识别”消息，并将同一份文字交给对话引擎；Mock 按住入口明确显示“模拟语音 · 预设台词”。空白、纯标点、非文本及超长识别结果只提示重录，不触发文字模型。松开后按钮显示识别中，成功/失败后均可再次按住。只使用可配置预置音色，默认千雪 Chelsie，不做克隆或定制。配置参见 [LIVE_SETUP](docs/LIVE_SETUP.md)。本次核验使用假设备/假服务，不代表真实识别准确率或延迟验收。

## 真实语音入口修复

已配置Qwen时，页面自动进入真实语音入口。首次点击“启用麦克风”并允许，随后按住“按住说话”，看到录音提示后讲话、松开识别；不再需要进入体验工具选择真实模式。“模拟台词”明确不识别讲话。权限弹窗与按住采集分开，慢连接下松手不会丢弃有效音频。101项假设备测试、类型检查及构建通过；本轮未录音、出声或新增付费调用。详见 [修复验收](docs/VOICE_INPUT_FIX.md)。
