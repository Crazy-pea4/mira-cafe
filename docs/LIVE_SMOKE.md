# 三次以内真实连通测试记录（2026-10-25）

用户本轮明确授权最多三次请求，不自动重试。执行结果：恰好三次，全部成功；自动付费验证已停止。未使用麦克风，未播放任何音频，未自动充值。

| 服务 | 请求与返回 | 用量 | 保守估算 |
|---|---|---|---|
| DeepSeek Flash | 非思考，max_tokens=128；输入“你好。”，返回“你好，想喝点什么？”；HTTP 200，结构化 JSON 校验通过 | 输入74 tokens，输出27，总101；缓存命中0 | ¥0.000364，按峰时cache-miss输入¥2/百万、输出¥8/百万 |
| Qwen TTS | qwen3-tts-flash-realtime，千雪 Chelsie；固定“你好，欢迎来到咖啡馆。”；只保存临时PCM | 24kHz/单声道/16bit，111360字节，2.32秒；服务端characters=20（汉字按2），tokens=36 | ¥0.002，按¥1/万计费字符 |
| Qwen ASR | 同一合成音频经既有低通重采样24k→16k后提交一次；返回“你好，欢迎来到咖啡馆。” | 16kHz/单声道/16bit，74240字节，2.32秒；返回tokens=61（input44/output17） | ¥0.00099，按3秒向上估计×¥0.00033/秒 |

合计保守估算 ¥0.003354，约 ¥0.0034（不到1分钱）。ASR实际计费最小单位、账号优惠与余额扣费未查询；这不是云端已核实账单。TTS按字符、ASR按秒计费，返回token数不作为这两项价格计算单位。

预算账本保留三次请求：DeepSeek1 / TTS1 / ASR1，本地累计预留¥0.26，实际账单值仍null。预留数用于本地限制，不是本次扣款；失败/取消也不退款、不清零。DeepSeek与Qwen合计用户上限仍为¥10，本地超过¥8预留前停止，最多60次；不能保证云账单精确硬封顶。

测试输入完整messages JSON为259 UTF-8字节，远低于1000输入token额度；输出显式限制128 tokens。TTS文字11个总字符、20计费字符；音频2.32秒，低于15秒上限。没有调用重试、余额查询、列模型或额外验证API。

## 运行状态与用户接手

当前 http://127.0.0.1:3001/ 的健康状态为 provider=deepseek、speech=qwen、speechAvailable=true，等待用户操作。按后续用户决定，正常回复默认有声，加载时不播放；输入入口已修复，真实服务可用时默认显示启用麦克风，服务启动本身不请求模型。

1. 刷新页面，确认“DeepSeek 文字”角标；先输入一句短文字即可手动测试角色回复，会收费。
2. 测讲话识别：刷新页面，点击“启用麦克风”并允许权限；看到“按住说话”后按住，出现录音提示后说话，松开识别。识别结果显示为“你 · 语音识别”，随后进入对话。最新修复见VOICE_INPUT_FIX.md。
3. 正常回复现在默认有声，声音开关与体验工具已移除。首次交互准备播放器，之后回复可能请求 TTS 并收费；播放受限会保留字幕并提示。代理未做实际录音/播放测试。
4. 当前进程通过启动环境启用真实服务，未修改.env中的密钥或开关。以后如需同样启动，先停止旧本项目服务，再在项目目录运行：

```sh
MIRA_ENABLE_LIVE_APIS=true MIRA_BILLING_CONFIRMED=true MIRA_PROVIDER=deepseek MIRA_SPEECH_PROVIDER=qwen QWEN_TTS_VOICE=Chelsie PORT=3001 npm run start:configured
```

仅使用Mock可用：

```sh
MIRA_ENABLE_LIVE_APIS=false MIRA_BILLING_CONFIRMED=false MIRA_PROVIDER=mock MIRA_SPEECH_PROVIDER=mock PORT=3001 npm start
```

两种模式不要同时启动。普通npm start不自动加载.env。已有预算记录不清零。

## 证据与限制

- 一次性脚本 scripts/live-smoke-once.ts；运行标记 .local/authorized-smoke-2026-10-25.json（已忽略Git、无密钥）。已有标记会阻止重复执行；不要为继续测试删除标记。
- 临时原始PCM：/var/folders/6l/slf923cs2kj2w6m_hs6q0clc0000gn/T/mira-smoke-NSSvpQ/chelsie-24000-mono-s16le.pcm。未播放，未公开。
- 脚本只在程序内读取本项目.env，对应密钥只发往DeepSeek与北京DashScope官方域名；没有输出Authorization、完整env、凭据值或原始服务错误。
- 脚本独立严格类型检查通过；前一轮89项假服务测试和构建通过。本次没有修改应用协议实现，没有进行额外收费重跑。
- 这是服务适配器的连通闭环。真实麦克风准确率/授权/设备噪声、浏览器实际音频播放与听感、完整交互延迟仍交给用户测试，不能由合成音频单句通过推断。
- 无测试失败、超时或权限阻塞。

官方依据：[DeepSeek价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[DeepSeek请求参数](https://api-docs.deepseek.com/api/create-chat-completion/)、[百炼价格](https://help.aliyun.com/zh/model-studio/model-pricing)、[ASR手动提交](https://help.aliyun.com/en/model-studio/qwen-asr-realtime-interaction-process)、[TTS PCM流程](https://help.aliyun.com/en/model-studio/interactive-process-of-qwen-tts-realtime-synthesis)。
