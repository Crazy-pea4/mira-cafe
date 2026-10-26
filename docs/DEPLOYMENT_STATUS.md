# 服务器部署状态 · 2026-10-26

**已开放私密评审：[https://iamm.xyz/mira](https://iamm.xyz/mira)。** 未登录会进入邀请密码页，API/素材返回401；不再是503锁定页。实际应用版本为 `5ecd5dd`，包含右侧剧情时间线、常驻对白框、五套姿态和剧情收束修复。

## 访问方式

邀请密码按用户授权随机生成，明文仅保存在本机 `.local/reviewer-access.txt`（600权限）；哈希在被Git忽略的 `.env.invitation`。没有在聊天、仓库或录屏中写入密码。用户可在自己的本机文件中查看并私下提供给评审。

服务器只保留盐化哈希，API key沿用此前已授权的600权限配置。本轮只加密传输邀请哈希，没有重新传输API key。一次性RSA私钥与远端邀请密文已在导入时删除，本地密文也已删除。

## 实际部署

- 经既有 Workbench 通道，发布包 SHA256：`36695f58207ea02a04e429d712de867eda186cc876ddbb116557e7c6af434023`。
- 发布目录 `/opt/mira-cafe/releases/5ecd5dd`，`/opt/mira-cafe/current` 指向它。旧 `d0144bf` 与 `95c4964` 保留，供回滚。
- 包仅含编译前后端、package清单/锁文件与无秘密检查工具，不含Mac node_modules、.env、私密文件、测试日志、音频或视频。
- 在Linux用既有Node 22.23.2从官方npm源安装84个锁定生产包，禁用安装脚本。目录755、静态文件644、发布所有者root；配置仍root:root 600，状态目录由mira-cafe拥有且700。
- `/etc/mira-cafe.ready` 已创建；`mira-cafe.service` active，以无登录shell的mira-cafe用户运行，监听127.0.0.1:3001。原daily-quest-cards.service仍active，127.0.0.1:8787保持。
- 沿用先前已经准备的nginx子路径与HTTPS代理，本轮没有更改nginx配置、DNS、防火墙、www、80或安装Docker。`nginx -t`通过。

启动等待时前两次本机探测收到连接拒绝，随后服务就绪并检查通过；没有把等待中的探测当作通过。激活脚本具备失败后撤销ready标记、停止Mira并恢复旧发布指向的回滚路径，本次未触发。

## 验证

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

如需紧急锁定，仅移除Mira专用`/etc/mira-cafe.ready`并停止`mira-cafe.service`。回滚代码时将current指回保留版本，恢复就绪后启动；不删除状态、密码或其他站点。密码轮换不重用首次导入工具，需明确更新哈希并重启以撤销旧会话。

真人手机麦克风、软键盘、安全区、实际听感和用户最终表演效果仍待实际确认。

## 真实录屏驱动的修复更新

用户要求真实API录屏后，实际多轮浏览器发现3秒呈现回执超时。5ecd5dd已修复为10秒/至多一次幂等重传；只重传不调用模型的回执，不重试收费对话。更新包SHA256为`e582aa1e2ec4c2e09f6940f7b2995682beaabee6a80eb6a6c602178f56dab29e`，复用此前未改动的Linux依赖和素材，Linux root与受限用户各30项检查通过，nginx与凭据未更改。

在该版本实际录成3分38秒线上API视频：10轮成功页面回复，服务端新增11次DeepSeek与19次Qwen TTS，21份回执均200，实际C结局完成。全部录制现已结束，真人设备与听感的验收边界仍保留。
