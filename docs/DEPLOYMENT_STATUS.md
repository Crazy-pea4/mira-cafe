# 服务器部署状态（2026-10-25）

目标：[https://iamm.xyz/mira](https://iamm.xyz/mira)。**已安装，但尚未开放评审体验**：邀请密码未选择，页面显示“咖啡馆尚未开放，请稍后再来。”并返回503；匿名API/WS同样被阻止。这不是模型余额限制。

## 实际部署

- 通过用户确认的既有Workbench通道，应用基线为95c49646a196f12238232b9f7db0d46756dce700。无Docker、DNS、防火墙或SSH设置变化。
- /opt/mira-cafe/releases/95c4964 保存发布，current指向它；创建无登录shell的mira-cafe用户，以及该用户拥有的700状态目录 /var/lib/mira-cafe。
- 现有Node22.23.2从官方npm源安装84个锁定生产包，禁用安装脚本，没有上传Mac node_modules。应用构建未混入后续新姿态素材。
- 服务 /etc/systemd/system/mira-cafe.service 已安装并enable；ConditionPathExists=/etc/mira-cafe.ready 未满足，服务inactive，没有监听3001。
- nginx备份：/root/mira-deploy-95c4964/backup/。主nginx.conf未改；443共享块仅移出精确iamm.xyz到新块，原根站与8787代理规则原样复制。
- 新配置为 /etc/nginx/conf.d/mira-iamm.conf、00-mira-map.conf、/etc/nginx/mira/locations.conf。只有iamm.xyz的/mira增加路由；缺就绪标记时直接503，不代理后端。
- 原daily-quest-cards.service仍active、127.0.0.1:8787；www与80原行为保持。
- 无秘密源包SHA256：92b57bb97fe910b8c23accf96430f4b46360e5030c7b0ffd475af678281e47c8。部署工具/条件锁定模板作为本次后续提交记录，不冒称属于原应用基线。

## 秘密传输

Workbench v1.0.1 upload经OSS中转，[官方说明](https://www.alibabacloud.com/help/en/ecs/user-guide/use-workbench-cli-to-manage-ecs-instances)没有明确本次对象留存与审计细节，因此未上传明文配置或把key写成云命令/base64命令。

[deploy-transport.mjs](../scripts/deploy-transport.mjs)先在服务器生成临时RSA-3072接收密钥，私钥仅服务器root私密目录600；公钥经Workbench读取并核对SHA256。Mac只在进程内解析本项目.env的允许字段，AES-256-GCM加密配置、RSA-OAEP-SHA256封装随机数据密钥。支持的upload只携带密文；工具参数/命令/输出没有原始或仅base64的API key。

服务器解密写入 /etc/mira-cafe.env，root:root、600。其中只含部署所需字段与已授权的DeepSeek/北京DashScope key，邀请哈希仍为空；没有传走整个.env或无关配置。临时私钥、远端密文、Mac密文均已删除。未新增SSH身份、持久登录凭据或生产共享密码。不能声称服务商完全没有日志或密文存储副本。

## 验证与实际纠错

- Linux实际Node bundle的30项HTTP/WS检查通过；全部临时测试密码、Mock，不加载生产配置。
- 同样30项通过临时systemd单元，以mira-cafe用户和正式服务相同的ProtectSystem/PrivateTmp/ProtectHome条件运行，通过。
- 第二组检查发现Mac素材保留600与Mac UID，普通服务用户读图500。只将发布静态目录/文件改755/644、发布所有者统一root:root后通过；秘密配置仍600，状态目录仍700。以后解tar使用--no-same-owner并规范静态资源权限。
- 初次基线脚本不兼容服务器Python3.6，发生在安装前；改兼容参数后记录16项基线。npm空user/global配置指向同一文件也在安装前报错，改成独立空配置路径后成功，没有盲重建账号或覆盖项目。
- nginx -t通过，reload稳定后14项应保留URL的状态/重定向/静态正文摘要一致，包括根站、fetiao、404、既有health、www/mira和80。
- /mira、/mira/、/mira/login、素材、health、匿名POST对话及WS Upgrade均503。Mac对公网HTTPS正常证书验证也收到锁定页。
- 服务器无3001/3002监听，原8787保持loopback。未认证不可访问真实服务。
- 本轮付费模型请求、麦克风采集、实际放声均0；不是用户真人登录或线上模型连通验收。

## 用户回Mac后的步骤

在项目终端运行（尚未替用户执行）：

    cd /Users/yemeng/Code/mira-cafe
    node scripts/create-invitation.mjs --output .env.invitation

两次隐藏输入自己选择的12–256字符密码。工具只保存600的盐化哈希，拒绝覆盖既有文件。密码由用户私下发评审，不粘贴聊天；生成后告诉助手“哈希文件已生成”，不必提供内容。

后续：服务器生成新的临时传输密钥；本地seal-invitation只加密该哈希；经Workbench上传后import-invitation在服务器更新600配置，保留API key并删除临时材料。验证完整配置后才创建root拥有的空 /etc/mira-cafe.ready 标记，并启动Mira服务。nginx已经有就绪检查，无需再改根站/www。首次导入工具拒绝覆盖已有非空邀请哈希；轮换密码需另行明确操作。

缺标记或密码时不能开放真实API。若需撤下入口，可移除Mira专用标记并停止该服务，不影响其他站点。尚待密码设置后的真实HTTPS登录Cookie、认证后的nginx WS代理、登录/退出与根站回归；收费API测试仍需相应授权。当前503检查不代表评审已经可玩。
