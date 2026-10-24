---
description: "The read_image_text tool that extracts text from an image through a separately configured vision-capable route, for models that cannot receive images themselves."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-image-text

English | [中文](README.zh.md)

## Summary

`dsh-tool-image-text` registers `read_image_text`, which lets an agent whose own model route cannot accept images still read a PNG, JPEG, WebP, or GIF file. The tool saves the image through `ctx.attachments`, sends it and a fixed instruction to a vision-capable provider/model route you configure, and returns the extracted text. Choose it when the calling model declares no image input and `read_image` therefore refuses; the cost is one auxiliary model request per call plus durable attachment storage. Provider, model, output-token cap, and deadline are required deployment choices with no defaults.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the tool beside a `ctx.fs` backend, an attachment store, and the LLM runtime, then name the route that can see images.

### When to choose it

Choose `read_image_text` when the agent's own route is text-only but the task involves screenshots, diagrams, scans, or photographed text. Use `read_image` instead when the calling route declares image input and the model should inspect the pixels itself; this package trades that fidelity for a text summary. Both tools accept the same four containers, and both resolve paths through the mounted filesystem backend.

### Minimal composition

The file tools, the policy, the attachment store, and this tool, with the vision route named explicitly.

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

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `provider` | required | Registered provider route that owns the vision model |
| `model` | required | Exact model id passed to that route |
| `maxOutputTokens` | required | Output-token cap for one extraction request |
| `timeoutMs` | required | End-to-end deadline for one extraction request |
| `prompt` | the fixed instruction below | Instruction sent beside the image |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-image-text) lists every accepted field.

### Behavior and failures

The tool returns `{ path, text, provider, model }` and renders the extracted text as its model-facing content. It refuses before any filesystem or attachment work when `file_path` is empty, when the extension names a format other than PNG/JPEG/WebP/GIF, when no attachment store is mounted, or when the configured route does not declare `image` input; that last error names the configured model. A file without an extension is identified from its signature. Missing paths, non-file targets, unsupported signature bytes, deployment-rejected media types, attachment-store refusals, provider failures, empty responses, and the deadline all return a tool error naming the file or the configured model. Image bytes leave the machine through the configured route, so choose a route the deployment's data policy already permits.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package separates route resolution from tool execution. `resolveImageTextRoute` validates the deployment configuration once at plugin load and returns a frozen route; `apply` hands that route to `applyReadImageTextTool`, which registers the tool. Route capability is re-checked per call through `ctx.llm.resolveModelInfo`, because adapter-supplied modality metadata can change between loads without reloading this plugin.

Execution reads the file through `ctx.fs.readBytes` under the attachment store's own byte limits, identifies the media type from the extension or the file signature, and commits the bytes with `ctx.attachments.saveImage`. The returned reference becomes the `image` block of a one-message request dispatched through `ctx.llm.prepareCall` and its registration-bound `stream`, under a deadline derived from `timeoutMs` and the caller's `exec.signal`. Text blocks are assembled and concatenated; the tool is stateless and declares every call concurrency-safe.

The tool is deliberately not gated on the calling route's capabilities and does not mount itself into any default composition. Its product role is optional because a deployment without an explicit vision route would fail at load rather than at the first call.

### Source map

| File | Owns |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin exports, schemastery `Config`, and one-time route resolution |
| [`src/read-image-text.ts`](src/read-image-text.ts) | Route validation, media sniffing, attachment commit, vision dispatch, refusals, and the tool definition |
| [`tests/read-image-text.spec.ts`](tests/read-image-text.spec.ts) | Behavior over the real local filesystem and attachment store with a scripted adapter |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — targets, observations, and the shared error taxonomy this tool follows.
- [Model tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-image-text) — the generated entry for `read_image_text`.
- [`dsh-tool-fs`](../tool-fs/README.md) — the `read`, `read_image`, `write`, and `edit` suite this tool complements.

-----

<a id="model-experience"></a>
## Model Experience

### read_image_text tool schema

#### What the model sees

The complete declaration belongs to the run that mounts the package; the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-image-text) is its canonical projection. The calling model receives one path parameter and a description that states purpose, supported formats, and when to prefer this tool over attaching the image.

##### `read_image_text` arguments

```markdown
{ "file_path": { "type": "string", "required": true } }
```

#### Token effect

The declaration is fixed text: roughly 70 tokens of name, description, and parameter schema, identical on every request while the tool is mounted. It adds no per-call prompt content to the calling model, because the instruction travels only to the vision route.

#### KV Cache effect

The declaration sits in the request's tool section and never changes between calls, so it extends the cacheable prefix instead of interrupting it. Mounting or removing the tool changes that prefix and invalidates cached tokens from the tool section onward.

### read_image_text result text

#### What the model sees

The tool result is the extracted text alone, rendered as one text block; the structured value carries the canonical path, provider, and model beside it. A refusal is a short error sentence naming the offending path or configured model.

#### Token effect

Output tokens follow the image content up to `maxOutputTokens`; the result enters the conversation once and is replayed with the history on later requests. A photographed page of dense text can consume the configured cap, so size it for the densest input the deployment expects.

#### KV Cache effect

Results are append-only conversation content. A new result extends the cached prefix; nothing earlier is rewritten, so repeated reads of different images do not invalidate prior cached tokens.

### vision request system prompt

#### What the model sees

The auxiliary route receives this fixed system prompt, the committed image block, and the prompt constant. The prompt can be replaced through configuration, and the replacement is quoted verbatim in the configuration catalog.

##### Auxiliary system prompt

```markdown
You extract information from one image and answer with plain text.
```

##### Default instruction

```markdown
Transcribe every piece of text visible in this image exactly as it appears, preserving reading order and line breaks. When the image contains no text, describe what it shows instead.
```

#### Token effect

Each call sends one system prompt, one image, and one instruction; there is no conversation history. Input tokens therefore scale with the image's encoded size and the instruction, and output tokens are bounded by `maxOutputTokens`.

#### KV Cache effect

Every auxiliary request is independent, so nothing is reused across calls and the vision route's cache neither helps nor is invalidated. Image bytes dominate the request's token cost on every call.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The package covers text extraction with a configured route and leaves these gaps to later work.

- The auxiliary vision request is not recorded as its own session event. The tool call records `file_path`, and the tool result records the extracted text with its provider and model, but the exact request is reconstructable only from the file content at that moment plus the configured prompt.
- Extracted text is not cached. Reading the same unchanged image twice makes two vision requests and two content-addressed attachment commits.
- The tool returns text only: no bounding boxes, no per-word confidence, and no distinction between printed and handwritten content.
- Route capability is checked through `resolveModelInfo` at execution. An adapter that reports image input but fails provider-side produces the provider's error rather than an earlier refusal.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
