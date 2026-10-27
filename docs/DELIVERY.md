# 交付清单

更新：2026-10-27。依据原题“交付内容”六项；岗位职责不替代本题要求。

| 交付项 | 可直接交给评审的入口 | 状态 |
| --- | --- | --- |
| 1. 源代码仓库 | [GitHub公开仓库](https://github.com/Crazy-pea4/mira-cafe) | 已公开，特性独立提交 |
| 2. 演示地址或本地说明 | [线上演示](https://iamm.xyz/mira/) / [本地Docker](DOCKER.md) | 线上需共享邀请密码，私下提供；不含注册体系 |
| 3. 一条命令启动 | `docker compose up --build -d --wait` | 默认无密钥Mock，依赖Docker Desktop；首次下载受网络影响 |
| 4. 3–5分钟演示录屏 | [3分48秒MP4](https://github.com/Crazy-pea4/mira-cafe/releases/download/demo-2026-10-27/mira-demo-live.mp4) / [Release](https://github.com/Crazy-pea4/mira-cafe/releases/tag/demo-2026-10-27) | 当前版本，含文字/语音、角色状态与场景、说话中打断、动画和失败重试 |
| 5. README | [项目说明](../README.md) | 包含结构、模块、语音/打断、指令、服务/素材、取舍、已知问题、投入及两周计划 |
| 6. AI_USAGE | [简要说明](../AI_USAGE.md) | 工具、参与工作、人工验证及发现/修正实例四项 |

## 录屏与材料边界

视频来自应用源码8b297fd的本地Docker真实DeepSeek/Qwen链路，包含完整A结局。电话段使用明确标注的合成测试输入，不采集真人麦克风；故障段主动中断一次文字请求，再手动重试。末尾手机画面是浏览器截图，未验收物理设备、外放回声或真人听感。详细章节、调用记录与校验见[演示录屏](DEMO_VIDEO.md)。

线上版本与本地录屏分别记录；公网首屏素材下载仍可能造成等待，见[部署状态](DEPLOYMENT_STATUS.md)。ComfyUI只有适配层，未真实部署或动态生图。未完成的可选扩展见[考核核对](ASSESSMENT_AUDIT.md)，不能因接口存在就记作完成。

粗估投入及方法见[PROJECT_EFFORT](PROJECT_EFFORT.md)，不是精确人工工时。72小时是否按时提交仍需结合实际收题和提交时间判断。

邀请密码、API key、身份Cookie、数据库和原始音频均不放进交付仓库或Release。Release提供视频、SHA256及脱敏验证元数据。
