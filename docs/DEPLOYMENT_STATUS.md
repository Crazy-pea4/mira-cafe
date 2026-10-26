# 服务器部署状态 · 2026-10-26

**已开放私密评审：[https://iamm.xyz/mira](https://iamm.xyz/mira)。** 未登录会进入邀请密码页，API/素材返回401；不再是503锁定页。实际应用版本为 `31bdece`，新增剧情背景转场、流式文字与电话式连续语音，保留推进选项高亮、自由输入判断、切页签继续、自动存档/刷新续接、重置、对白防空白，以及此前时间线、常驻对白框、五套姿态和剧情收束修复。

## 本次更新（31bdece）

- 通过全局 AGENTS.md 指定的 Workbench 通道部署，源码提交为 `31bdece50bd015519ee0de669e45ec315870afef`。发布包27.0MiB，SHA256为 `824e4ee879e149da8b9e91e7390d7f445d1348c27c09831dddc5af19d4093b86`，仅含编译产物、依赖清单、文件摘要和部署检查脚本。
- `/opt/mira-cafe/current` 已原子切换到 `/opt/mira-cafe/releases/31bdece`，保留 `5703005` 供回滚。两版依赖锁文件相同，复用Linux现有node_modules；没有在小内存服务器构建前端或安装Docker、ComfyUI。主应用不实例化媒体适配工厂，不会启动生成任务。
- 本地379项测试、类型、根路径及/mira构建和30项部署检查通过。服务器校验包与逐文件SHA256后，Linux root与实际mira-cafe受限账号各30项通过，再切换并重启Mira。启动等待曾两次连接拒绝，随后就绪；Mira和daily-quest-cards均active，nginx -t通过。未修改nginx、其他站点、凭据或持久状态。
- 公网真实DeepSeek/Qwen检查新增3次文字调用、1次合成音频ASR、4次TTS。电话模式停顿后自动识别并完成一轮；另以文字输入验证播放中点击打断和后续对话。三次HTTP回复均为SSE，页面记录56次增量变化，4份呈现回执均200，无页面或语音错误。
- 认证后JS、CSS、旅馆背景和AudioWorklet与本地构建的字节摘要一致；Cookie为Secure/HttpOnly/SameSite=Strict、路径/mira/。HTTPS登录、带登录态刷新、退出及退出后API401通过，1280×900、390×844、320×640、390×410无横向溢出，输入和电话入口可达。原站7条路径的状态、跳转与正文SHA256与发布前一致。

首次公网脚本在完成上述真实交互后，因要求浏览器必须收到 `X-Accel-Buffering: no` 而中止；该断言不适用于默认隐藏X-Accel-*头的nginx代理，参见 [nginx官方说明](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_hide_header)。保留原始失败记录，复核已取得的SSE和增量渲染证据，再独立补完不收费的布局、登录、刷新与退出检查；未修改代理配置或重跑收费对话。原始与补查结果分别位于忽略的 `.local/deploy-31bdece/online.json` 和 `followup.json`，收费检查结束后已退出登录。

本次未使用真人麦克风或物理扬声器，未验证外放回声、真人插话和真机系统行为；刷新检查覆盖登录态和页面加载，剧情存档恢复沿用此前验收。本次没有重录视频，现有3分03秒录屏尚未包含电话入口与流式文字。

## 访问方式

邀请密码按用户授权随机生成，明文仅保存在本机 `.local/reviewer-access.txt`（600权限）；哈希在被Git忽略的 `.env.invitation`。没有在聊天、仓库或录屏中写入密码。用户可在自己的本机文件中查看并私下提供给评审。

服务器只保留盐化哈希，API key沿用此前已授权的600权限配置。本次应用更新没有重新传输邀请密码、哈希或API key；首次配置时只加密传输了邀请哈希。一次性RSA私钥与远端邀请密文已在导入时删除，本地密文也已删除。

## 上一版部署（5703005，历史）

- 经既有 Workbench 通道，发布包 SHA256：`36695f58207ea02a04e429d712de867eda186cc876ddbb116557e7c6af434023`。
- 发布目录 `/opt/mira-cafe/releases/5703005`，`/opt/mira-cafe/current` 指向它。旧 `73920f3`、`efa4008`、`3ca7291`、`5ecd5dd`、`d0144bf` 与 `95c4964` 保留，供回滚。
- 包仅含编译前后端、package清单/锁文件与无秘密检查工具，不含Mac node_modules、.env、私密文件、测试日志、音频或视频。
- 在Linux用既有Node 22.23.2从官方npm源安装84个锁定生产包，禁用安装脚本。目录755、静态文件644、发布所有者root；配置仍root:root 600，状态目录由mira-cafe拥有且700。
- `/etc/mira-cafe.ready` 已创建；`mira-cafe.service` active，以无登录shell的mira-cafe用户运行，监听127.0.0.1:3001。原daily-quest-cards.service仍active，127.0.0.1:8787保持。
- 沿用先前已经准备的nginx子路径与HTTPS代理，本轮没有更改nginx配置、DNS、防火墙、www、80或安装Docker。`nginx -t`通过。

启动等待时前两次本机探测收到连接拒绝，随后服务就绪并检查通过；没有把等待中的探测当作通过。激活脚本具备失败后撤销ready标记、停止Mira并恢复旧发布指向的回滚路径，本次未触发。

## 上一版验证（历史）

- Linux root运行编译产物30项Mock认证/HTTP/WS检查通过。
- 相同检查通过临时systemd单元，以mira-cafe用户、ProtectSystem/ProtectHome/PrivateTmp/NoNewPrivileges条件执行，30项通过。
- 实际公网HTTPS浏览器登录、受保护页面/素材、刷新、退出及退出后API401通过。
- Cookie实查为Secure、HttpOnly、SameSite=Strict，路径/mira/。
- 认证后的nginx WebSocket握手101通过；该握手本身不请求收费语音。
- 桌面1280×900、手机390×844线上截图确认时间线存在、折叠控件为0、无横向溢出、pageerror为0。
- 发布前后7项既有URL的状态、重定向与正文SHA256一致：根站、fetiao、404、旧health、www根站、www/mira、80根路径。

实际线上闭环另行通过：1次DeepSeek、1次TTS、1次合成PCM的ASR，识别文字与合成原句归一化后相同。使用正式HTTPS API与nginx WSS，不是仅检查health或握手；没有真人麦克风或扬声器输出。检查后已退出并停止收费验证。完整验收边界见[交付验收](RELEASE_ACCEPTANCE.md)。

## 运维与边界

使用者正常对话会按已配置服务计费；本地金额/累计次数拦截保持用户要求的关闭状态。统计不等于云账单。

如需紧急锁定，仅移除Mira专用`/etc/mira-cafe.ready`并停止`mira-cafe.service`。回滚代码时将current指回保留版本，恢复就绪后启动；不删除状态、密码或其他站点。密码轮换不重用首次导入工具，需明确更新哈希并重启以撤销旧会话。存档签名使用现有哈希作为密钥材料，轮换密码后旧存档需重置；本机无认证模式使用`.local/story-save.key`，并发启动原子创建，600权限，不入库。

真人手机麦克风、软键盘、安全区、实际听感和用户最终表演效果仍待实际确认。

## 真实录屏驱动的修复更新

用户要求真实API录屏后，实际多轮浏览器发现3秒呈现回执超时。5ecd5dd已修复为10秒/至多一次幂等重传；只重传不调用模型的回执，不重试收费对话。更新包SHA256为`e582aa1e2ec4c2e09f6940f7b2995682beaabee6a80eb6a6c602178f56dab29e`，复用此前未改动的Linux依赖和素材，Linux root与受限用户各30项检查通过，nginx与凭据未更改。

在该版本实际录成3分38秒线上API视频：10轮成功页面回复，服务端新增11次DeepSeek与19次Qwen TTS，21份回执均200，实际C结局完成。全部录制现已结束，真人设备与听感的验收边界仍保留。

## 自动存档及对白保护更新

存档阶段应用为`efa4008`。先发布存档版`3ca7291`，再加入本机密钥并发启动修复和对白防空白保护。该阶段编译更新包SHA256为`a6a8697b00a136a9397a54f48100167c48a8004a75cf0f01f194217b8c7b4df3`，Linux root与受限mira-cafe用户各30项检查通过；只切换Mira发布并重启服务，nginx、密码、API key及其他服务未更改。

存档版已在真实HTTPS/WSS完成两轮DeepSeek与三次Qwen TTS，4份回执均200；刷新、退出后重新登录、继续到照片情节、重置后再刷新均通过。原站7项URL基线一致。本机3001沿用明确启用的真实配置、3002为无收费Mock；配置文件的默认关闭开关保持。

最终`efa4008`再做三轮真实页面检查：4次DeepSeek（一次非空回复的表情枚举修正）、6次TTS请求、8份回执200，没有空模型返回或空白对白，手机无溢出，pageerror为0。刷新/重新登录后继续到来信、重置后再刷新通过，原站7项URL基线仍一致。末尾出现过语音降级提示，真实文本继续显示；不声称全部TTS都成功播放。收费验证结束并退出，临时3003和5174检查进程已关闭。

## 页签切换继续播放更新

`73920f3`已发布，包SHA256为`5ecc3e0a94a020e2c58458d117158513969dec7b9dfb63ef530f5ea92ddb221c`。从保留的efa4008复制Linux依赖及素材后覆盖编译程序，Linux root与受限mira-cafe各30项检查通过，原子切换current并重启；nginx、凭据及其他站点配置未改，Mira与原daily-quest-cards服务均active。

受控后台事件的真实API检查通过：1次DeepSeek、2次Qwen TTS均完成，2份回执200，后台15个原生音频片段开始/结束，无取消请求或音频关闭，完成剧情自动存档。没有原生OS后台长期播放或真人听感验收；检查已退出并关闭隔离浏览器。

## 推进选项与自由输入更新

该阶段版本为5703005，更新包SHA256为4ee4cfc131f585a72d3843c7a880ff29b6e5e4e405afa6fe6729f788d70cd75d。复用73920f3的Linux依赖与素材，覆盖编译程序，Linux root与受限用户各30项通过，current原子切换并重启；旧版保留，原邀请哈希、存档签名、API key、nginx和其他服务配置未改。

正式网页交替点击发亮选项与自由输入十轮到A结局，10次DeepSeek、20次Qwen TTS全部完成、24份回执200，0页面/语音错误或降级提示。四种尺寸无横向溢出，截图经检查，退出后停止收费检查。本地真实3001/无收费3002已加载新逻辑，临时3004关闭。全部用户反馈已记录AI_USAGE，不声称真人设备或听感已验收。

发布后根站、www等7项既有URL状态、跳转及正文SHA256与基线一致，证据在.local/story-progression-root-regression.json。
