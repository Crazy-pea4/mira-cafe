# ComfyUI 接口适配层

2026-10-26。用户将范围收敛为接口适配与代码说明：本次不安装 ComfyUI、Python 模型环境、Docker 镜像或模型文件，不增加网页生图入口，不更改服务器部署。

**当前状态：已实现自托管 ComfyUI HTTP 协议适配与离线替身验证，尚未真实联调 ComfyUI。** 示例工作流没有经过真实模型执行验证，不能将它描述成已跑通的生图工作流或已有 ComfyUI 实操交付。

## 当前接入边界

`server/media.ts` 定义独立的 `MediaProvider`，与现有文字、语音 Provider 并列。业务调用方不需要知道 ComfyUI 的具体节点或文件下载参数。现有 `server/index.ts`、聊天协议、剧情导演和前端不会创建这个 Provider，没有新增媒体 HTTP 路由；线上维持现有静态图片与剧情，不会连接本机 ComfyUI。

| 方法 | 行为 |
| --- | --- |
| `submit(request, signal)` | 把提示词、可选负面提示词和 seed 填入配置好的工作流，单次提交 `/prompt`，返回任务 ID |
| `inspect(jobId, signal)` | 查询 `/history/{prompt_id}` 与 `/queue`，区分排队、运行、成功、失败、取消和暂未找到 |
| `download(image, signal)` | 从 `/view` 获取指定输出图片，返回字节与类型，校验文件引用、PNG/JPEG/WebP 文件头和10MiB上限 |
| `cancel(jobId, signal)` | 删除指定的排队任务并复查；运行中返回 `stopped:false`，不调用全局 `/interrupt` |
| `waitForMedia(...)` | 有界轮询，默认1秒一次、最多120秒；状态变化通知调用方 |

`ComfyUiMediaProvider` 的每次网络操作默认10秒超时。网络、鉴权、工作流错误和超时均不自动重复提交。POST响应丢失时返回 `SUBMISSION_UNKNOWN` 并携带候选任务ID；先核对服务端任务再决定是否重试。支持客户端 `prompt_id` 的服务可用这个ID查询；旧版若忽略它，需要结合队列与client_id核查，不能保证候选ID对应真实任务。

AbortSignal终止本次HTTP读取、下载或轮询；它不证明GPU任务已停止。提交期间中断的AbortError也携带候选jobId。排队删除后如果任务已进入运行态，明确返回 `stopped:false`。运行中精确取消需要后续按目标ComfyUI版本接入并实测，本版不声称支持。

当前使用HTTP轮询，没有实现WebSocket节点进度、预览帧、上传参考图、图生图一致性、任务数据库、图片落盘或对象存储。这些属于后续业务服务与页面集成范围。

## 无服务的验证方式

```sh
npm run demo:media
```

该命令默认强制Mock，即使当前shell包含真实配置也不访问外部服务。它会依次输出queued、running、succeeded，以及一张单像素测试图片的字节数；不写图片文件、不请求模型、不播放声音。这个像素只是接口夹具，不是旅馆照片或生成效果展示。

```sh
npx vitest run tests/comfyui-adapter.test.ts
```

测试通过注入fetch替身验证请求、状态、异常、取消与下载，不启动ComfyUI或联网。

## 以后有可用服务时如何接入

1. 在目标ComfyUI环境中调通工作流，记录ComfyUI版本、模型和自定义节点依赖，并导出 **API格式** 的工作流；普通画布格式不能直接提交。
2. 参考 `workflows/comfyui-lodge.example.json`，把真实API工作流放在 `workflow` 下，设置正向/负向提示词、seed节点的绑定，以及返回图片的输出节点ID。示例是单张512×512文生图模板，checkpoint含明确占位符；保留占位符会在任何请求前拒绝启用，不代表可直接生成或保持原旅馆外观。
3. 显式配置下面四项；文件仅放服务器端，地址可以是本机或授权访问的远程自托管服务。此适配器不实现Comfy Cloud的鉴权及专用API，也不直接使用任意第三方托管平台的接口。

```dotenv
MIRA_MEDIA_PROVIDER=comfyui
MIRA_ENABLE_MEDIA_APIS=true
COMFYUI_BASE_URL=http://127.0.0.1:8188
COMFYUI_WORKFLOW_SPEC=/absolute/path/to/verified-comfy-workflow.json
```

显式加载本机配置后，可单独运行外部服务联调示例：

```sh
node --env-file=.env --import tsx scripts/media-adapter-demo.ts --live
```

该命令会实际提交一次生成、等待并读取图片，GPU服务是否收费取决于目标部署，本次没有执行。普通 `npm run demo:media` 始终走离线Mock。仅填写这些变量不会让当前聊天页面调用ComfyUI；主应用还没有接入这个扩展点。

4. 后续业务服务通过 `createMediaProvider(env)` 获取实例，并关联任务所有者、剧情上下文与媒体事件；自己管理任务和图片的持久化。普通聊天可继续已确认生成任务，重置/替换构图时使旧结果失效，完成后再展示。复用现有呈现回执时，仅确认用户实际看到的媒体事件。
5. 服务器保持 `MIRA_MEDIA_PROVIDER=disabled`、`MIRA_ENABLE_MEDIA_APIS=false`，无需Docker或ComfyUI环境。当前主应用未调用工厂；未来接入时仍须保留这个关闭方式。

## 来源与验收

协议依据 [ComfyUI原生服务路由](https://docs.comfy.org/development/comfyui-server/comms_routes) 和 [官方Python调用示例](https://github.com/Comfy-Org/ComfyUI/blob/master/script_examples/websockets_api_example.py)。工作流示例按标准节点连接编写，未下载或验证任何checkpoint。

本次只完成适配层、Mock演示、单元测试和工程检查。真实服务的版本兼容性、模型出图质量、延迟、显存/内存、物理任务取消与产品全流程仍需后续验证；不以替身通过代替真实联调。

验证结果：新增18项适配层测试通过；全量38个测试文件、379项、TypeScript、根路径构建、`/mira`前后端构建及30项隔离部署检查通过。`npm run demo:media`实际完成离线状态链并返回67字节PNG夹具；付费请求0、ComfyUI进程0，未修改线上服务，也未进行本轮浏览器验收，因为没有修改页面或注册媒体路由。遵照项目约定未运行格式化或格式检查。
