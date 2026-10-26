# 本地 Docker 开发环境

2026-10-27。本地使用 Docker Compose；云服务器继续沿用 Node.js、systemd 和 nginx，发布流程见 [DEPLOYMENT](DEPLOYMENT.md)。不新增数据库、Redis、ComfyUI 或 GPU 服务。

## 一条命令启动

启动 Docker Desktop 后，在项目目录执行：

```sh
docker compose up --build -d --wait
```

打开 [http://127.0.0.1:5173/](http://127.0.0.1:5173/)。宿主机无需安装 Node.js 或 npm，首次启动需要下载镜像和依赖。默认使用标明模式的 Mock，不要求 API key。

一个开发容器内同时运行 Vite 与 Fastify。宿主机只发布127.0.0.1上的5173端口；后端仍监听容器内部127.0.0.1:3001，由Vite代理HTTP和WebSocket。`MIRA_DOCKER_PORT=5174 docker compose up -d`可更换宿主端口。

源码按目录只读挂载，修改前端会热更新，修改后端由tsx watch重载；文件轮询兼容Docker Desktop。依赖留在Linux镜像中，不使用宿主机node_modules。修改package.json、锁文件或Dockerfile后重新执行带`--build`的启动命令。

## 使用现有真实服务配置

将本机密钥保存在被Git忽略的`.env`，已有文件不要覆盖；首次可参考[.env.example](../.env.example)。随后明确选择真实服务配置：

```sh
docker compose -f compose.yaml -f compose.live.yaml up --build -d --wait
```

访问地址不变。覆盖文件启用DeepSeek和Qwen，只将列出的模型、音色、区域、endpoint和密钥变量传入容器；缺少必需密钥时Compose直接报错。即使`.env`的默认开关仍为false，这条显式命令也会启用真实服务，后续对话按供应商计费。

`.env`不会进入构建上下文、镜像或源码挂载。Vite的envDir关闭，密钥不使用VITE_*前缀，不会注入浏览器。不要将完整的`docker compose config`或容器环境输出粘贴到聊天或仓库。

切回无收费Mock：

```sh
docker compose up -d --wait
```

## 状态与常用操作

```sh
docker compose ps
docker compose logs --tail=50 app
docker compose restart app
docker compose down
```

签名存档密钥与尽力用量统计保存在`mira-cafe_state`命名卷。普通重启、重建和`down`保留它，不使用`down -v`；内存会话可由浏览器签名检查点恢复。

原宿主机`.local`保持独立，不挂载或覆盖；浏览器localStorage按站点和端口隔离，旧3001/3002入口的存档不会自动迁移到5173。仍可按README中的Node启动方式做诊断。

## 容器内检查与服务器构建

在默认Mock模式下执行：

```sh
docker compose exec -T app npm run check
docker compose exec -T app npm run build:deploy
docker compose exec -T app npm run check:deploy
```

构建结果位于容器内`/app/build`，可导出后继续按原服务器发布流程部署：

```sh
mkdir -p build
docker compose cp app:/app/build/. ./build/
```

本镜像包含开发和测试依赖，用于本地开发。镜像不全局设置NODE_ENV，由Vite的dev/build命令选择模式，确保build:deploy仍生成生产版React产物。服务器继续使用编译后的Node服务，不使用该开发容器。

构建输入采用白名单；`.env`、`.local`、`.git`、音视频、宿主机依赖和已有构建目录均不进入镜像。运行时也只挂载列出的源码和配置文件。

Compose覆盖与变量优先级依据 [Docker合并规则](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/) 和 [环境变量优先级](https://docs.docker.com/compose/how-tos/environment-variables/envvars-precedence/)。

## 本次验证

- Linux ARM64、Node24.22.1下379项测试、类型检查、前端与Node构建通过；原服务器/mira构建和30项隔离部署检查通过。
- Mock浏览器十轮完整A结局、咖啡馆与旅馆双向转场、SSE和WebSocket代理、四尺寸布局通过。宿主前端修改实际触发Vite热更新；重建容器后恢复浏览器签名检查点并继续到委托，验证命名卷内签名密钥保留。
- 默认容器不含.env、.local、.git、output或真实密钥。最终使用已有配置运行真实模式，单次文字探针调用1次DeepSeek，收到13次增量事件；未新增ASR/TTS，也未使用物理麦克风或扬声器。旧宿主机3001/3002实例已退出，仅保留Docker的5173入口。

初次构建固定开发模式导致生产包带入开发版React，移除全局NODE_ENV后生产入口恢复381.18kB。浏览器首两次检查在自动刷新与手动导航竞争时中止，保留失败记录后对检查脚本增加有限等待，最终完整通过；没有为此调整业务逻辑。证据在被忽略的`.local/docker-check/`中，未运行格式化或格式检查。
