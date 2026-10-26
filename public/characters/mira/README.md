# Mira 当前外观：琥珀色雨衣与银色星星发夹

Mira 为 26 岁旅行摄影师。原 PDF 第 1 页把这组设定列为可选故事种子；用户随后明确要求画面遵守其中外观，故本组统一替换早期开衫候选。保持二次元画风、近似原脸、放下的兜帽和银色五星发夹。本次没有重写已批准的摄影委托剧情。用户尚未验收本组最终页面效果。

五张图由主任务的 OpenAI 图像工具编辑生成，经 Library 支持的物化流程下载。本机验证文件可读、身份属性、1024×1536 / 8bit RGBA、透明通道和像素。素材原始字节不改动；带版本的路径避免旧缓存与新衣服混用。旧图只留在 assets/history/mira-v1/ 与 assets/candidates/，不再放在 public 中。

| 文件                       | Library ID                               |  字节数 | 用途                    |
| -------------------------- | ---------------------------------------- | ------: | ----------------------- |
| mira-amber-neutral-v3.png  | libfile_155fccd2bdc481919e7b33405dc7b9db | 2176496 | 固定身体、中性/戒备基图 |
| mira-amber-curious-v3.png  | libfile_3b0235afca0c8191a068e29f26010f81 | 2170642 | 好奇眉眼/嘴             |
| mira-amber-warm-v3.png     | libfile_5f268b68a29c8191a1dde6d9cb2cf023 | 2164920 | 释然眉眼/嘴             |
| mira-amber-blink-v3.png    | libfile_b5c6a9682e048191ae3df4745885d263 | 2173097 | 独立闭眼区域            |
| mira-amber-speaking-v3.png | libfile_a0d9c51120848191b17bcc8766597c85 | 2169456 | 独立张嘴区域            |

固定身体仅使用 neutral。差分存在轻微生成漂移，不整张快速替换；CSS 渐变 mask 只取局部眉眼/嘴。鼻部小区域对齐比较后，curious、warm、speaking 下移 1 原始像素，blink 不平移；眼嘴覆盖互相独立。基图 alpha>128 边界（左上含、右下不含）为 (24,18,984,1536)，四张差分边界最多相差 1px。alpha 为 0–254，完全透明像素数分别 582980 / 578635 / 578113 / 579190 / 568824；边缘透明的原始字节保留。

眨眼是定时动画；嘴型是说话状态控制的开合示意，不是音素或音频振幅分析。Mock 使用假/模拟时钟，真实模式由播放开始/结束状态控制，实际听感和口型匹配未在本轮测试。打断立即闭嘴并取消旧回调；眼嘴同时动作不会用整张闭眼图盖掉嘴型。整体呼吸、侧倾/前倾是 CSS 示意动作，照片是独立剧情道具，没有手臂骨骼动画。

运行映射：src/character-assets.ts；时钟：src/core/facial-animation.ts；合成：src/Character.tsx。无声工具验证范围见 docs/ACCEPTANCE.md；人工发现偏离 brief 与纠正过程见 AI_USAGE.md。

## 已批准的五套上半身关键帧

用户确认样图后接入以下原始文件。全部1024×1536 / 8bit RGBA，四角alpha=0，素材不做像素编辑，旧五张仍保留。新姿态使用完整身体，不叠旧眼嘴补丁。尚未制作连续逐帧动画。

| 文件                                  | Library ID                               |  字节数 | 完全透明像素 |
| ------------------------------------- | ---------------------------------------- | ------: | -----------: |
| mira-amber-thinking-upperbody-v1.png  | libfile_301d0c99341881919cdecc48ca16ee9c | 2244059 |       565977 |
| mira-amber-laughing-upperbody-v1.png  | libfile_bc27d9ddcc688191a85856eba58db7a5 | 2284193 |       515581 |
| mira-amber-listening-upperbody-v1.png | libfile_b0fd00b86dc481918edbe53ee1a8d552 | 2286352 |       514174 |
| mira-amber-surprised-upperbody-v2.png | libfile_306f4f8664248191b1b85f1713328a7f | 2247727 |       532493 |
| mira-amber-hesitant-upperbody-v1.png  | libfile_011556a08a808191b52a044fa407c796 | 2251939 |       571461 |

全身alpha沿用生成资源0–254范围，部分透明边缘保留。触发、优先级、失败回退与实际验证边界见[姿态说明](../../../docs/POSES.md)。基础neutral与局部差分规则仅适用于idle姿态。
