# Mira Café 部署与维护

当前版本已经开放在 [https://iamm.xyz/mira](https://iamm.xyz/mira)，准确版本、验证和访问方式见 [DEPLOYMENT_STATUS](DEPLOYMENT_STATUS.md)。本页是后续维护说明，不是待审批清单。

## 运行结构

既有阿里云ECS上使用Node单进程和systemd，监听127.0.0.1:3001，由现有nginx的精确iamm.xyz主机代理/mira。www、根站、8787应用和80保持原行为。无需Docker、数据库、PM2或新端口。

| 位置                                  | 用途                        |
| ------------------------------------- | --------------------------- |
| /opt/mira-cafe/releases/版本          | 不可变发布目录              |
| /opt/mira-cafe/current                | 当前发布符号链接            |
| /etc/mira-cafe.env                    | root拥有、600权限的服务配置 |
| /etc/mira-cafe.ready                  | Mira专用就绪/开放标记       |
| /var/lib/mira-cafe                    | mira-cafe拥有的700状态目录  |
| /etc/systemd/system/mira-cafe.service | 受限服务用户和沙箱设置      |

## 构建和更新

本地开发使用[Docker Compose](DOCKER.md)，服务器仍按本页Node/systemd/nginx流程部署。可在本机Node环境构建，也可按Docker说明在容器内构建并导出build目录；不把开发容器发布到服务器。

先运行 `npm run check`、`npm run build:deploy`、`npm run check:deploy`。依项目约定不主动执行格式化或格式检查。根路径dist和/mira的build/client彼此独立，服务端产物为build/server/index.js。

发布包仅包含build、package.json、package-lock.json及必要的无秘密检查工具。经既有Workbench上传，在全新release目录用`tar --no-same-owner`解包，规范目录755/静态文件644，再使用官方源执行：

```sh
npm ci --omit=dev --ignore-scripts --registry=https://registry.npmjs.org
```

不要上传Mac node_modules、.env、.local、凭据、视频或日志。先在Linux及与正式服务相同的受限用户/沙箱内检查编译产物，再原子切换current。保留旧release供回滚。现有nginx路由无需为普通版本更新重写。

## 邀请密码与会话

首次设置已完成。密码哈希通过AES-256-GCM加密、RSA-OAEP-SHA256封装后传输；接收私钥只留服务器，导入后删除。工具为`scripts/deploy-transport.mjs`，不把密码、key或仅base64的秘密写入CLI参数。

登录同源POST校验scrypt哈希，8小时不透明服务端会话，Cookie路径/mira/，Secure、HttpOnly、SameSite=Strict。页面、JS/CSS、图片、工作线程、API和WS共用鉴权；右上“离开咖啡馆”撤销会话。共享邀请没有完整个人账号；重启服务撤销旧会话。

写操作和WS要求精确Origin/Host。服务不记录密码、Cookie、Authorization或请求体，诊断仅保留白名单结构信息。公网缺少邀请哈希或任一真实provider时拒绝启动，不静默变成Mock；本地Mock仍无需密钥。

## 故障和回滚

ready标记缺失时，nginx对Mira入口返回503，systemd条件也不允许启动。撤下入口时只移除Mira标记并停止Mira服务；不要删除其他项目、状态记录或改支付设置。

回滚时在锁定状态将current指向保留的已验证release，检查配置和素材权限后恢复标记并启动。若修改nginx，必须备份、`nginx -t`通过后再reload，并核对根站、www和已有路径；普通应用更新不需要reload。

## 检查与仍需真人验证

`check:deploy`使用临时随机密码、隔离状态和Mock，覆盖30项实际编译产物检查，不加载.env或访问收费服务。线上另外检查真实HTTPS Cookie、素材、刷新、WS代理和退出，不能由本地注入测试替代。

真实模型连通测试必须单独有界记录，不因产品取消金额/次数拦截而无限运行。真人麦克风、手机软键盘、安全区和最终听感仍需用户实际确认。
