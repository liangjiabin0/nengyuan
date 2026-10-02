---
name: image-generation
title: 生成图片
description: 按用户文字描述调用能元平台图像接口生成或编辑图片，可选按 linshenkx/prompt-optimizer 文生图流程优化提示词。用户要求画一张图、生成插画、示意图、场景图、海报、文生图，或提到提示词优化、关闭优化时使用。
---

# 生成图片

用户要「生成图片 / 画一张 / 文生图 / 出一张示意图」时，先 `skill` 加载 `image-generation`，再用脚本真正生成图片文件。不要只写一段文字描述交差，也不要把数据折线图误用成本技能。定量数据图不属于本技能；需要画数据图时，请用户在输入框功能列表中选中「主动生成数据图」，不要自行寻找或加载出图技能。

## 何时加载

出现下面任一情况就 `skill` 加载 `image-generation` 并跑脚本：

- 用户明确要求生成、绘制、创作一张图片
- 需要概念示意、场景、装置外观、海报、封面，且没有现成可画的数据表
- 回答里要配一张原创图，而不是引用语料里的旧图

不要用本技能：表格/CSV/时序数据出图（请用户选中「主动生成数据图」）、纯文字解释、用户只是在讨论已有附件图片。

## 输出位置（系统认这里为附件）

把成品图写到系统提示里给出的「图表输出目录」。那个目录已经建好，必须原样使用。

缺省形态：

```text
storage/chat-workspaces/<完整会话ID>/charts/<文件名>.png
```

文件名用英文短横线，例如 `pv-array-scene.png`。单轮 1–2 张。

正文用一句话说明这张图画的是什么。不要写 `![](本地路径)`，系统会把图收成附件。

## 生成步骤

1. 把用户意图收成一句清晰的中文或英文 prompt：主体、场景、风格、视角、不要出现的内容。
2. 按下面「提示词优化」决定是否加 `--optimize-prompt` 或 `--no-optimize-prompt`。
3. 用脚本真正写出文件，禁止只打印 URL。
4. 确认目标目录里已经有对应 PNG/JPG/WEBP，再写最终回答。

工作区不在仓库根时，用 `$AI4ES_PROJECT_ROOT`（PowerShell：`$env:AI4ES_PROJECT_ROOT`）或技能目录里的 `scripts/`。

```bash
node "$AI4ES_PROJECT_ROOT/tools/image-generation/scripts/generate_image.mjs" --prompt "晴天光伏阵列与储能集装箱，工程示意图，干净白底" --out charts/pv-storage.png
```

可选：`--size 1024x1024|1024x1536|1536x1024|auto`，`--quality 1K|2K|4K`。`16:9` / `1920x1080` / `1280x720` 会映射为横版 `1536x1024`（接口不提供真正的 16:9 像素）。长提示词不要塞进命令行，改用 `--prompt-file`，科研 PPT 还可再加 `--global-prompt-file`。

参考图编辑（最多 8 张 PNG/JPEG/WebP），走同一套设置页图像端点（`/images/edits`）：

```bash
node "$AI4ES_PROJECT_ROOT/tools/image-generation/scripts/edit_image.mjs" --prompt "保持构图，改成黄昏光线" --out charts/pv-storage-dusk.png path/to/ref.png
node "$AI4ES_PROJECT_ROOT/tools/image-generation/scripts/edit_image.mjs" --global-prompt-file global-prompt.txt --prompt-file slide-02.txt --size 16:9 --out charts/slide-02.png path/to/template-preview.png
```

只预览优化后的提示词、不真正出图：

```bash
node "$AI4ES_PROJECT_ROOT/tools/image-generation/scripts/optimize-prompt.mjs" --prompt "晴天光伏阵列"
```

## 提示词优化

默认跟随设置页「图像生成 → 开启提示词优化」（缺省为开）。脚本会用能元已配置的小模型，按 [linshenkx/prompt-optimizer](https://github.com/linshenkx/prompt-optimizer) 的文生图改写方式补全主体、空间关系和光线情绪；失败则回退原文，不中断出图。

| 用户意图 | 标志 |
| --- | --- |
| 开启 / 先优化提示词 / 把描述写细再出图 | `--optimize-prompt` |
| 关闭 / 不要优化 / 按原文出图 | `--no-optimize-prompt` |
| 没说 | 不加标志，用设置页开关 |

已写好的长提示词（科研 PPT 页提示、结构化分镜）默认加 `--no-optimize-prompt`，避免改写破坏既定构图。关闭优化也可在设置页关掉「开启提示词优化」。

## 提示词

- 写清主体、环境、风格（工程示意 / 写实 / 扁平插画）
- 需要中文标注时，在 prompt 里写明「图中中文标注：…」
- 不要生成可识别真人面孔、印章、签名或证件

## 失败时

脚本报未配置图像接口或 HTTP 错误：不要假装已经生成。说明失败原因，并给出可改的文字描述；不要改去加载出图技能。
