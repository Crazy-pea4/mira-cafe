# 本机真实服务配置（已完成三次限量连通测试）

未配置时使用 Mock；产品回复默认有声，首次用户交互解锁，页面加载不自动朗读。用户自行配置密钥后，已明确授权并完成一次 DeepSeek、一次 Chelsie TTS 和一次合成音频 ASR，共三次；没有录音、播放或重试。当前本机进程已通过启动环境选择真实模式，等待用户操作。用户已撤销产品本地金额/次数限制；真实请求按云服务实际用量计费，不自动充值。Agent自动测试仍须另有有界授权。详情、费用估算及接手步骤见 [LIVE_SMOKE](LIVE_SMOKE.md)。

## 最少配置步骤

1. 在 /Users/yemeng/Code/mira-cafe 自行复制 .env.example 为 .env；不要覆盖已有文件。可用 `cp -n .env.example .env`，再用本机编辑器打开 .env。
2. 自行填写下表变量。不要把密钥粘贴进聊天、截图、前端代码或任何 VITE_ 变量。.env / .env.* 已被 Git 忽略（示例除外）。可自行执行 `chmod 600 .env` 限制文件读取。
3. 示例已预填北京区域和官方兼容端点。自行填写 DEEPSEEK_API_KEY 与北京 DASHSCOPE_API_KEY；如账号要求工作空间，填写 DASHSCOPE_WORKSPACE_ID 并将 ASR 端点换成自己的北京工作空间域名。暂时保持 MIRA_ENABLE_LIVE_APIS=false，即可保存配置而不发起收费请求。
4. 真正联调前核对账号价格/用量，再设置 MIRA_ENABLE_LIVE_APIS=true，按需设 MIRA_PROVIDER=deepseek、MIRA_SPEECH_PROVIDER=qwen。录音仍须明确点击并授权；声音随正常对话回复播放。本轮 agent 不录音、不播放、不增加付费测试。
5. 停止原有本项目服务，执行 `npm run build && npm run start:configured`，仍打开 http://127.0.0.1:3001/。普通 `npm start` 不加载 .env；开发时使用 `npm run dev:configured`。不要同时启动两个 API 服务。

| 变量 | 作用 |
|---|---|
| MIRA_ENABLE_LIVE_APIS | 必须明确为 true，服务端才读取密钥并启用已配置适配器；否则完全 Mock |
| MIRA_PROVIDER | mock 或 deepseek |
| DEEPSEEK_API_KEY | DeepSeek 服务端密钥 |
| DEEPSEEK_MODEL | 可替换模型名，默认 deepseek-flash；固定采用非思考模式 thinking.type=disabled |
| MIRA_SPEECH_PROVIDER | mock 或 qwen |
| DASHSCOPE_API_KEY | 所选地域的 DashScope 服务端密钥 |
| DASHSCOPE_REGION | 已预填 cn-beijing，匹配用户选择与北京密钥 |
| DASHSCOPE_WORKSPACE_ID | 如使用工作空间，填对应 ID；可为空，不能填密钥 |
| QWEN_ASR_ENDPOINT / QWEN_TTS_ENDPOINT | 已预填北京兼容端点，必须同地域；模型名由下面变量追加 |
| QWEN_ASR_MODEL | 默认 qwen3-asr-flash-realtime |
| QWEN_TTS_MODEL | 默认 qwen3-tts-flash-realtime |
| QWEN_TTS_VOICE | 默认千雪 Chelsie，保留配置项；仅使用预置音色，不做克隆或定制 |

北京工作空间地址格式为 `wss://<你的工作空间ID>.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime`；新加坡为 `wss://<你的工作空间ID>.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime`。如果账号使用官方兼容端点，北京为 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`，新加坡为 `wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime`。请按控制台与官方文档核对自己的账号可用端点、模型与地域，不把占位尖括号照填。

应用只接受上面两个地区的官方 wss 主机，不自动跨区或回退其他地区。本次已验证当前账号下的指定模型与 Chelsie 连通；其他配置仍需按官方支持范围核对。缺少密钥、region 或两个合法端点时，语音保持 Mock；文字与语音独立回退。无配置对话显示简洁“演示模式”，示例按钮标注“不录音”；真实语音可用时直接显示“启用麦克风”，不再展示模型/调试标签；/api/health 只返回非敏感状态。启动时已有 shell 环境变量优先于 .env，用户排查时只看变量名和状态，不打印密钥。

## 明确的录音与声音操作

- 真实语音配置可用时，主入口自动显示“启用麦克风”。首次点击仅申请权限并立即释放准备流，不上传音频。允许后明确提示再按住“按住说话”，看到录音提示后讲话；松开停止采集并提交识别。页面加载不会请求麦克风。
- 松开立即结束采集并提交识别。成功后完整识别文字显示为“你 · 语音转写”消息，然后进入对话；模拟入口显示“示例对白”，不冒充真实识别。空白、纯标点、非文本或超过 800 字的异常结果只提示重录，不提交给文字模型。
- 权限准备与按住录音分离，弹窗失焦不会误取消准备，允许后不自动开始录音。连接未就绪时松开会先停采集并保留有效PCM，等待连接后提交；短于250ms提示重录，最长30秒，手动提交，无VAD。
- 新文字、新录音、切换模式、失焦、重置都会停止旧采集和识别；旧转写不进入新轮次。录音没有扬声器回放，麦克风处理节点输出为零。
- 默认回复有声，声音开关与体验面板已移除。首次用户点击/按键解锁播放，不发送欢迎音频；正常回复会请求已配置的 Qwen TTS 并收费。浏览器受限则保留字幕并提示，未解锁时不请求 TTS。刷新需要新的用户交互，不能自动出声。
- localhost/127.0.0.1 或 HTTPS 才支持麦克风。服务只监听本机，本阶段不开放公网或手机局域网访问。

## 数据链路与边界

浏览器 AudioWorklet 输出实际设备采样率 Float32；经带低通的流式重采样转为 16kHz、单声道、16bit little-endian PCM，再通过同源 WebSocket 到本地后端。未使用 MediaRecorder WebM 冒充 PCM。后端持有 Authorization，代理到 Qwen；仅允许本机同源 WebSocket 升级，不记录录音、转写或密钥。

DeepSeek 检查结束状态、整理完整已知包装并经 Zod 校验后只提取 text，按中文句子逐次合成，原始 JSON 不进入 TTS。Qwen 返回 24kHz PCM，由 AudioContext 时钟连续排队。每句实际到达音频播放时钟时才呈现字幕和动作，结束后开始下一句；没有逐字/音素时间戳，嘴型仍是占位动画。静音/失败则降级为明确提示的可取消字幕演出。

取消同时关闭代理、丢弃迟到 PCM、停止已排期节点并失效字幕/动作回调。断线不自动收费重试；录音重新按住，文字的格式/空对白/截断失败最多自动修正2次（共3次、各自计费并记录次数），耗尽再提示；取消和18秒整轮超时覆盖所有尝试。网络/权限/余额/过滤不这样重试，TTS失败保留字幕。原始上游错误不直接展示或打印。无数据库、无录音持久化。

## 真实验证仍待完成

已确认北京；原10元自动测试授权是历史测试范围，产品金额/累计次数限制现已按用户要求取消。用户已自行配置凭据并完成三次限量连通，用户后来追加授权真实多轮连测和仅对白格式失败的受控修正，已完成的最新结果见 LIVE_MULTITURN_TEST.md。当前自动验证已停止；AI 不得未经新授权录音或出声。尚待真实设备验证：真实设备权限与采样率、PCM 链路、Qwen 实际事件顺序、真人听感、句子字幕对齐、连续打断、弱网重连和延迟/成本。当前 192 项单测使用替身，另有明确记录的真实无声 API 连测；单测不代表真人麦克风、听感或本次格式修复已获人工验收。

官方依据：
- [DeepSeek chat completion](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Qwen ASR 实时交互](https://help.aliyun.com/en/model-studio/qwen-asr-realtime-interaction-process)
- [ASR 客户端事件](https://help.aliyun.com/en/model-studio/qwen-asr-realtime-client-events)
- [Qwen TTS 实时交互](https://help.aliyun.com/en/model-studio/interactive-process-of-qwen-tts-realtime-synthesis)
- [TTS 客户端事件](https://help.aliyun.com/en/model-studio/qwen-tts-realtime-client-events)


## 不阻断使用的统计与日志

用户明确要求移除本地金额与累计次数限制。应用不再按原¥10合计、¥8固定预留线、60次累计、旧费率核对期限或旧计费确认变量拒绝请求；文字输入、动态建议和ASR/TTS使用相同规则。`MIRA_BILLING_CONFIRMED` 与 `MIRA_MAX_LIVE_REQUESTS` 已废弃，已有.env中的值可保留但不会生效，无需为本次修改密钥。

显式 `MIRA_ENABLE_LIVE_APIS=true`、所选provider与服务端凭据仍必需；官方端点/同源检查、输入长度、超时、取消和旧轮次失效保留。格式校验最多2次额外修正（共3次），网络/权限/余额失败不无限重试。每次成功或失败的上游尝试都可能计费，实际账单需在官方控制台核对。

原`.local/budget.json`不删除、不清零。兼容v1记录继续尽力增加服务次数及其旧固定权重（DeepSeek .20、ASR .02、TTS .04）；`legacyWeightedCny`只是旧权重统计，不是现行价格、账户余额、已扣款或预算。锁冲突、损坏、不可写时不阻断服务、不自动删锁或重置，健康状态标记统计不可用；这时可能漏记，不能把计数当完整账单。

产品页不展示预算面板；只读`/api/health`返回`usagePolicy.localLimits=false`，语音可用性由配置决定，统计放在`usage`且`actualBilledCny`仍为null。启动日志仅允许枚举状态与端口，不输出密钥、Authorization、完整请求/响应、录音或对话。未改云平台付款/充值设置。解除用户使用限制不授权agent无限付费测试，后续自动测试须单独限制规模与费用。

预置音色依据：2026-10-25 核对 [Qwen 官方音色表](https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list)，实时 qwen3-tts-flash-realtime 列出千雪 Chelsie。最初核对文档与假网络参数；后续经授权完成一次未播放的真实 Chelsie 合成，见 LIVE_SMOKE.md。当前产品不提供声音关闭按钮。真实 ASR 仍需要显式开启真实服务并取得录音授权，正常语音输入会继续触发已配置的文字和语音回复；不要把完整对话当作只会产生 ASR 费用。自动化通过假设备/服务分别验证，不新增真实请求。

最新入口修复与假设备回归详见 [VOICE_INPUT_FIX](VOICE_INPUT_FIX.md)；真实服务可用时不再默认模拟入口。

## 回复格式异常的本地诊断

先检查 finish_reason，截断/过滤/异常结束不会播放。完整已知包装可本地整理，无效对白或指令经严格Zod拒绝；仅可修复格式失败最多额外修正2次（总3次），耗尽明确报错，不伪造成功。唯一额外诊断是 .local/last-reply-diagnostic.json（被 Git 忽略），仅保留白名单枚举、长度/段数和数字 token 用量，不记录原始响应、提示词、转写、凭据或会话标识。旧错误未保留原响应，不能确认当次具体根因。详见 [ISSUES_AND_FIXES](ISSUES_AND_FIXES.md)。

权限等待、录音与转写进度、取消和失败提示仍会显示在输入区；没有把录音隐私状态随开发标签一起删掉。常驻重复说明已移除，模型/预算/技术限制见本文与 README，不作为场景内标签。
