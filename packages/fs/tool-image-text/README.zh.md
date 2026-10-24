---
description: "通过单独配置的视觉能力路由从图片中提取文本的 read_image_text 工具，供自身无法接收图片的模型使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-image-text

[English](README.md) | 中文

## 概述

`dsh-tool-image-text` 注册 `read_image_text`，让自身模型路由无法接收图片的 agent（智能体）仍能读取 PNG、JPEG、WebP 或 GIF 文件。该工具通过 `ctx.attachments` 保存图片，把图片和固定指令发送到你配置的具备视觉能力的 provider/model 路由，并返回提取出的文本。当调用模型未声明图片输入、因而 `read_image` 拒绝时选择它；代价是每次调用产生一次辅助模型请求以及持久附件存储。Provider、model、输出 token 上限和超时都是必填的部署选择，没有默认值。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把工具挂载在 `ctx.fs` 后端、附件存储和 LLM 运行时旁边，然后指定能够看到图片的路由。

### 何时选择它

当 agent 自身的路由只支持文本，而任务涉及截图、图表、扫描件或拍摄的文字时，选择 `read_image_text`。如果调用路由声明了图片输入、且模型应自行查看像素，则改用 `read_image`；本包以文本摘要换取那种保真度。两个工具接受相同的四种容器，也都通过所挂载的文件系统后端解析路径。

### 最小组合

文件工具、策略、附件存储和本工具，并显式命名视觉路由。

```yaml
- name: '@deepseek-ai/dsh-fs-local'
- name: '@deepseek-ai/dsh-fs-observation-policy'
- name: '@deepseek-ai/dsh-attachment-local'
- name: '@deepseek-ai/dsh-tool-fs'
- name: '@deepseek-ai/dsh-tool-image-text'
  config:
    provider: deepseek
    model: deepseek-vision
    maxOutputTokens: 2048
    timeoutMs: 120000
```

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | 必填 | 拥有该视觉模型的已注册 provider 路由 |
| `model` | 必填 | 传给该路由的确切模型 id |
| `maxOutputTokens` | 必填 | 单次提取请求的输出 token 上限 |
| `timeoutMs` | 必填 | 单次提取请求的端到端超时 |
| `prompt` | 下文固定指令 | 与图片一同发送的指令 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-image-text)列出所有可接受字段。

### 行为与失败

工具返回 `{ path, text, provider, model }`，并把提取文本作为面向模型的内容渲染。在 `file_path` 为空、扩展名不属于 PNG/JPEG/WebP/GIF、未挂载附件存储，或配置的路由未声明 `image` 输入时，它会在任何文件系统或附件操作之前拒绝；最后一种错误会指出配置的模型。没有扩展名的文件按签名识别。路径缺失、目标不是普通文件、签名不受支持、部署拒绝的媒体类型、附件存储拒绝、provider 失败、空响应以及超时都会返回指明文件或配置模型的工具错误。图片字节会经由配置的路由离开本机，因此应选择部署数据策略已允许的路由。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

本包把路由解析与工具执行分开。`resolveImageTextRoute` 在插件加载时验证一次部署配置并返回冻结的路由；`apply` 把该路由交给 `applyReadImageTextTool`，由后者注册工具。路由能力在每次调用时通过 `ctx.llm.resolveModelInfo` 重新检查，因为适配器提供的模态元数据可能在不重新加载本插件的情况下改变。

执行过程通过 `ctx.fs.readBytes` 在附件存储自身的字节上限内读取文件，根据扩展名或文件签名识别媒体类型，并用 `ctx.attachments.saveImage` 提交字节。返回的引用成为单条消息请求中的 `image` 块，该请求经 `ctx.llm.prepareCall` 及其绑定注册的 `stream` 派发，并受基于 `timeoutMs` 与调用方 `exec.signal` 的截止时间约束。文本块被组装并拼接；工具无状态，并声明所有调用都可并发安全。

该工具有意不受调用路由能力限制，也不会把自己挂载进任何默认组合。其产品角色为可选，因为缺少显式视觉路由的部署会在加载时失败，而不是等到首次调用。

### 源码映射

| 文件 | 负责内容 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件导出、schemastery `Config` 与一次性路由解析 |
| [`src/read-image-text.ts`](src/read-image-text.ts) | 路由校验、媒体嗅探、附件提交、视觉派发、拒绝路径与工具定义 |
| [`tests/read-image-text.spec.ts`](tests/read-image-text.spec.ts) | 基于真实本地文件系统与附件存储、配合脚本化适配器的行为 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md) — 本工具遵循的目标、观测与共享错误分类。
- [模型工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-image-text) — `read_image_text` 的生成条目。
- [`dsh-tool-fs`](../tool-fs/README.zh.md) — 本工具所补充的 `read`、`read_image`、`write` 与 `edit` 套件。

-----

<a id="model-experience"></a>
## 模型体验

### read_image_text 工具 schema

#### 模型看到什么

完整声明属于挂载本包的那次运行；生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-image-text)是其规范投影。调用模型收到一个路径参数，以及说明用途、支持格式和何时优先使用本工具而非直接附图的描述。

##### `read_image_text` 参数

```markdown
{ "file_path": { "type": "string", "required": true } }
```

#### Token 影响

声明是固定文本：名称、描述与参数 schema 约 70 个 token，只要工具处于挂载状态每次请求都相同。它不为调用模型增加任何逐调用提示内容，因为指令只发送到视觉路由。

#### KV Cache 影响

声明位于请求的工具部分且调用之间不变，因此它延长可缓存前缀而不会中断它。挂载或移除该工具会改变该前缀，并使从工具部分起的缓存 token 失效。

### read_image_text 结果文本

#### 模型看到什么

工具结果仅为提取出的文本，渲染为一个文本块；结构化值同时携带规范路径、provider 与 model。拒绝则是简短的错误语句，指明有问题的路径或配置的模型。

#### Token 影响

输出 token 随图片内容增长直至 `maxOutputTokens`；结果进入会话一次，并在后续请求中随历史重放。一页密集文字的照片可能消耗配置的上限，因此应按部署预期的最密集输入来设定它。

#### KV Cache 影响

结果是只追加的会话内容。新结果延长已缓存前缀，不会重写更早的内容，因此读取不同图片不会使先前缓存的 token 失效。

### 视觉请求系统提示

#### 模型看到什么

辅助路由收到这段固定系统提示、已提交的图片块和提示常量。提示可通过配置替换，替换内容会原样引用在配置目录中。

##### 辅助系统提示

```markdown
You extract information from one image and answer with plain text.
```

##### 默认指令

```markdown
Transcribe every piece of text visible in this image exactly as it appears, preserving reading order and line breaks. When the image contains no text, describe what it shows instead.
```

#### Token 影响

每次调用发送一段系统提示、一张图片和一条指令，没有会话历史。因此输入 token 随图片编码大小和指令长度增长，输出 token 受 `maxOutputTokens` 约束。

#### KV Cache 影响

每次辅助请求彼此独立，调用之间不复用任何内容，视觉路由的缓存既无帮助也不会被失效。图片字节在每次调用中都占据请求 token 成本的主要部分。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

本包覆盖通过配置路由提取文本，并把这些缺口留待后续工作。

- 辅助视觉请求不会记录为独立的会话事件。工具调用记录 `file_path`，工具结果记录提取文本及其 provider 和 model，但确切请求只能由当时的文件内容与配置的提示重建。
- 提取文本不会被缓存。对同一未变图片读取两次会产生两次视觉请求和两次内容寻址的附件提交。
- 工具只返回文本：没有边界框、没有逐词置信度，也不区分印刷体与手写体。
- 路由能力在执行时通过 `resolveModelInfo` 检查。若适配器报告支持图片输入但在 provider 侧失败，则产生 provider 的错误，而不是更早的拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

None.

</details>
