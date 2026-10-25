# iamm.xyz/mira 部署方案与准备记录

当前实际状态：**已安装但邀请密码待设置，入口锁定503**，见[服务器部署状态](DEPLOYMENT_STATUS.md)。以下保留部署前准备记录，不代表已可玩。

目标唯一地址是 **https://iamm.xyz/mira**，规范页面为 `/mira/`。用户明确不要改 `www`，不使用子域名、不安装 Docker。本次只准备仓库代码、模板及离线验证；没有修改服务器、创建生产密码、传送 API key 或部署公网。

## 已知服务器与最小方案

2026-10-25 只读检查：阿里云 ECS `i-wz99vwautoj54vru5yhg` / `120.25.210.117`，Alibaba Cloud Linux 3 x86_64，2 核，1870 MiB 内存（当时约1493 MiB可用），Node 22.23.2、nginx 1.24、systemd。已有 `daily-quest-cards.service` 在 `127.0.0.1:8787`，应保持原样。服务器当时3001空闲，正式操作前须再查。

使用现有 Node 单进程，在 `127.0.0.1:3001` 提供受保护的前端/API/WS，由 nginx 现有443转发。只暴露已有HTTPS入口，不开放3001防火墙，不装数据库/PM2/Docker，不在小内存服务器构建前端。

- 发布目录：`/opt/mira-cafe/releases/<release>`，`/opt/mira-cafe/current` 指向选定版本。
- 运行用户/组：`mira-cafe`，无登录 shell；新建须正式部署授权。
- 非秘密状态目录：`/var/lib/mira-cafe`（700，运行用户拥有）；保存尽力请求统计、受限结构诊断，不保存对白、音频或密钥。现有本地账本不清零、不上传；线上独立统计不代表历史账单。
- 服务配置：`/etc/mira-cafe.env`（root拥有、600），由 systemd 读取；API key和邀请密码哈希仅在服务端。部署模板为 [runtime.env.example](../deploy/runtime.env.example)。
- 服务单元：[mira-cafe.service](../deploy/mira-cafe.service)。它不安装自己，不自动启动。
- 证书沿用现有 `/etc/nginx/ssl/imamm.xyz.pem`（文件名历史拼写保留），已只读确认覆盖 `iamm.xyz`。不新增DNS记录、不改变www，不申请新证书；正式上线时再次检查有效期。

## 构建与子路径

```bash
npm ci
npm run check
npm run build:deploy
npm run check:deploy
```

`build:deploy` 生成 `build/client`（固定 `/mira/` 基址）及 `build/server/index.js`（Node 22目标、ESM，运行时依赖外置）。Vite禁止自动加载环境文件；没有把服务端环境或密钥放入浏览器构建。前端资源、工作线程、API和WS共用基址。静态清单 `mira-build.json` 必须与运行时 `MIRA_BASE_PATH` 一致，否则拒绝启动。

`npm run build` 仍生成根路径本地 `dist`，原3001真实/3002 Mock使用方式保留；子路径构建不覆盖根路径产物。刷新 `/mira/` 仍先鉴权，品牌链接也留在该路径。应用没有其他SPA页面路由，未知路径返回404。

发布包仅含 `build/client`、`build/server`、`package.json`、`package-lock.json`（及审阅后的部署说明）。**不上传Mac的node_modules、.env、.local、测试音频、日志或Git目录。** 在Linux发布目录用现有npm执行：

```bash
npm ci --omit=dev --ignore-scripts --registry=https://registry.npmjs.org
```

这样依赖在目标平台解析，避免Mac/Linux原生模块误用；本次未在服务器运行该命令。锁文件保持原版本，未新增认证依赖。若官方注册源连接失败，报告后再决定，不临时换未知源。

## 邀请密码与会话

密码提交到同源 `POST /mira/auth/login`，只保留scrypt盐化哈希配置。成功后创建32字节随机不透明令牌，服务端仅存令牌摘要和会话期限；无需另外配置持久会话签名密钥。

- Cookie只限 `/mira/`，`HttpOnly; Secure; SameSite=Strict`，固定8小时到期；没有前端localStorage密码或URL密钥。
- 页面、JS/CSS、角色图、工作线程、health、对话、取消、呈现回执、语音WebSocket都经过同一个服务端鉴权。登录页公开；未登录页面转登录，未登录API/资源/WS拒绝访问。
- 登录刷新不产生模型请求；页面初次加载也不朗读。声音产品默认保持开启，需用户手势解锁浏览器。
- 右上角“离开咖啡馆”执行同源POST退出：撤销服务端会话、清Cookie，取消该会话在途回复与语音连接。过期同样撤销；刷新需重新登录。重启服务会使所有会话失效。
- 更换密码需更新哈希后重启服务，旧会话全部失效。共享密码没有个人账号，也不能单独撤销某位持有者；知道密码的人都能使用已配置的收费服务。
- 错误密码返回一般提示，不回显输入；每IP每分钟5次失败后暂缓1分钟。只限制猜密码，不限制已登录用户的金额/累计对话次数。密码校验并发和会话数量作有限内存保护。
- 所有写操作与WS必须匹配配置的精确Origin/Host；`www.iamm.xyz`不被当作同源。nginx覆盖转发IP头，应用仅信任loopback代理。
- 页面/资源不缓存，CSP禁止外部脚本和嵌入框架；同源引用策略保留正常表单Origin。服务不记录密码、Cookie、Authorization、请求体；诊断仅白名单结构/长度/枚举。

正式密码由用户自己选择并私下给评审，不放聊天。可在自己终端显式运行以下**尚未执行的生产凭据步骤**：

```bash
node scripts/create-invitation.mjs --output .env.invitation
```

工具在TTY隐藏输入并二次确认（12–256字符），只写600权限的哈希文件，拒绝覆盖既有文件；不输出哈希或明文。该文件被Git忽略。然后通过自己的本地编辑器把哈希行填到未入库的运行配置中。不要在聊天、终端参数、版本库或录屏里输入真实密码/API key。

必须配置的秘密：`MIRA_PASSWORD_HASH`、`DEEPSEEK_API_KEY`、北京区域 `DASHSCOPE_API_KEY`。其余非秘密字段按 [模板](../deploy/runtime.env.example)；`DASHSCOPE_WORKSPACE_ID`仅工作空间确实要求时填写，endpoint须与该北京工作空间匹配。公网配置缺少auth/hash/任一真实provider会拒绝启动，不悄悄回落Mock。原本地Mock无需这些秘密。

## nginx：只影响 iamm.xyz 的 /mira

只读发现现有443主机块同时列出 `iamm.xyz www.iamm.xyz imamm.xyz www.imamm.xyz`。**不能把新location直接塞到这个共享块**，否则会改变www路径行为。

正式修改前备份 `/etc/nginx/nginx.conf`、`/etc/nginx/conf.d/imamm-ssl.conf` 和相关include；记录四个主机及根站/已有应用基线。只对443做以下可审阅修改：

1. 从共享443块的server_name删除恰好 `iamm.xyz`，其余名称、root、证书、现有location与include不动。
2. 复制该块原有行为到单独的 `server_name iamm.xyz;` 块，保留根站 `/usr/share/nginx/html`、8787应用的原代理规则、错误页、证书以及所有原include。不能用简化示例覆盖真实配置。
3. 仅这个精确主机块引入 [nginx-mira.locations.conf](../deploy/nginx-mira.locations.conf)。在http上下文引入一次 [nginx-mira.http.conf](../deploy/nginx-mira.http.conf) 的独立WS变量。
4. 不改共享80块或www的重定向/路由，不把www重定向到iamm。所有 `/mira/` 都转发应用，保留完整URI；不要另设绕过密码的静态文件location。
5. 只在 `nginx -t` 成功后reload。验证根站、8787应用、www和原错误页相对基线不变，再验证 `https://iamm.xyz/mira` 登录、资源、刷新和WebSocket。该线上验证**尚未做**。

本地模板不会自动执行上述操作，也不含完整现有vhost以免误覆盖。现有访问日志不得新增请求体、Cookie或Authorization字段；表单密码不会出现在URL。

## 正式部署待一次确认的精确操作

以下都未执行。建议用户一次确认部署目标、文件/服务修改及凭据传输：

1. 允许经既有Workbench通道上传审阅后的发布包到该ECS；重查目录/端口，创建上述专用用户、发布/状态目录，不覆盖现有项目。
2. 允许在新发布目录安装锁定的生产npm依赖；安装systemd服务并设置开机启动。不会安装Node/Docker或改防火墙。
3. 用户自行准备邀请密码哈希；确认是否复用现有DeepSeek与北京DashScope key，还是提供新的服务专用key。API key最终需要进入该服务器的600权限运行配置。**此授权阶段未读取既有.env，也未传输任何key。**
4. 凭据后续只通过经授权的文件传输：用户本地私密配置文件（600）经现有Workbench上传到root私密临时路径，再安装为 `/etc/mira-cafe.env`、删除临时副本；不把秘密嵌入远程命令字符串或输出。该文件内容/准确路径须在执行时明确确认，不能因已有本地API授权就假定允许上传。
5. 允许按上述精确主机拆分修改nginx，`nginx -t`后reload；根站/www行为保留。确认公网持有共享密码的评审会通过用户账户产生真实API费用，产品不设原已撤销的金额/次数门槛。
6. 启动服务、做不收费的登录/HTTP/WS握手检查；是否进行收费真实对话、录音或实际放声另依用户授权，不能自动扩展。原本地3001/3002不必因此停止。

正式服务安装的非秘密命令轮廓（仅供审阅；目录/账号不存在时才创建）：

```text
useradd --system --home-dir /var/lib/mira-cafe --shell /sbin/nologin mira-cafe
install -d -m 755 /opt/mira-cafe/releases/<release>
install -d -o mira-cafe -g mira-cafe -m 700 /var/lib/mira-cafe
# 解包到本次全新release，并在该Linux目录执行上面的npm ci。
# 用户认可的秘密配置单独安装为root:root、600；不在此文档填值。
# current符号链接指向本次release；旧release保留作回滚。
install -m 644 deploy/mira-cafe.service /etc/systemd/system/mira-cafe.service
systemctl daemon-reload
systemctl enable --now mira-cafe.service
# nginx更改经差异审阅、nginx -t成功后再reload。
```

回滚：恢复nginx备份并验证后reload；将current指回上个release并重启服务。首次部署失败则停止新mira服务并恢复nginx；不删除已有服务、状态记录或修改云账单。所有操作范围仅Mira部署，保留既有服务。

## 本阶段验证与缺口

- 254项离线测试：包括子路径、未认证页面/API/WS/素材拒绝、cookie属性、CSRF、精确主机、不同评审状态隔离、退出取消、到期/重启失效、密码失败暂缓；未恢复对话预算上限。
- `npm run check`、`npm run build:deploy`通过。生成服务器约96KB（外置依赖），未增加包。
- `npm run check:deploy` 用实际编译bundle执行30项本地HTTP/WS检查。临时随机密码只在内存，独立临时状态目录，Mock-only，不加载.env，不连接模型服务；结束清理。
- AI浏览器检查1280×900与390×844：错误密码、成功登录、全屏素材、刷新保持登录、退出及再访问重定向。独立Mock预览阻止声音/麦克风。发现并修复 `no-referrer` 让表单Origin被抑制的问题；HTTP注入测试不会覆盖此浏览器行为。
- **未验证**：实际Linux安装/运行、systemd沙箱、nginx最终配置语法与线上根站/www无回归、真实HTTPS Cookie与WebSocket代理、线上API连通、真实手机键盘与真人听感。本次不是线上验收，不声称服务器已上线。
- 用户要求最终项目完成时再统一formatter，本阶段未执行。

依据：[Vite公共基址](https://vite.dev/guide/build.html#public-base-path)、[Fastify请求钩子](https://fastify.dev/docs/latest/Reference/Hooks/)、[Node scrypt](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)、[Cookie属性](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)、[nginx WebSocket代理](https://nginx.org/en/docs/http/websocket.html)。
