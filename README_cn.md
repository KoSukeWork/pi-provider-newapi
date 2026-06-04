# pi-provider-newapi

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![pi extension](https://img.shields.io/badge/extension-pi%20provider-green.svg)](https://github.com/ttimasdf/pi-provider-newapi)

[pi](https://github.com/earendil-works/pi) coding agent 的自托管 [NewAPI](https://github.com/QuantumNous/new-api) AI 网关 provider 扩展。

注册一个 `newapi` provider，支持动态模型发现、自动费用计算，并根据模型 ID 前缀自动路由到对应后端：

| 模型前缀 | 后端 | 端点 |
|---|---|---|
| `gpt-`、`o1`、`o3`、`o4` | OpenAI Responses | `{baseUrl}/v1` |
| 其他所有模型 | Anthropic Messages | `{baseUrl}` |

**[English](README.md)**

## 安装

本扩展是 [pi](https://github.com/earendil-works/pi) coding agent 的 provider 扩展，没有额外的运行时依赖，仅需 pi 本身作为 peer 依赖。

```bash
pi install npm:pi-provider-newapi
```

或从 git 安装：

```bash
pi install git:github.com/ttimasdf/pi-provider-newapi
```

扩展通过 `package.json` 中的 `pi.extensions` 字段自动发现——安装后无需额外配置。

## 快速开始

### 方式 A：环境变量（快速方式）

```bash
export NEWAPI_BASE_URL=https://ai.your-gateway.com
export NEWAPI_API_KEY=sk-your-api-key
```

扩展在启动时自动注册，并发现可用模型。

### 方式 B：交互式 `/login`（持久化密钥）

```bash
export NEWAPI_BASE_URL=https://ai.your-gateway.com
```

```
pi> /login
```

在 pi 会话中运行 `/login`，pi 会交互式地提示选择 provider 并输入 API Key（如 `sk-your-api-key`）。密钥会通过 pi 内置的凭据存储保存到 `<agentDir>/auth.json`。下次启动时扩展会自动读取。

## 配置

基础 URL 和模型元数据存储在 `<agentDir>/extensions/provider-newapi.json`。API Key 由 pi 内置的 `<agentDir>/auth.json` 单独管理（通过 `/login` 或 `NEWAPI_API_KEY` 环境变量设置）。

`<agentDir>` 默认值为：

| 操作系统 | 路径 |
|---|---|
| Linux / macOS | `~/.pi/agent` |
| Windows | `%USERPROFILE%\.pi\agent` |

```json
{
  "baseUrl": "https://ai.your-gateway.com",
  "modelInfo": {
    "unknown-model-id": {
      "reasoning": false,
      "input": ["text"],
      "contextWindow": 128000,
      "maxTokens": 4096
    }
  }
}
```

启动时，如果 `NEWAPI_BASE_URL` 与存储值不同，基础 URL 会自动更新。如果未设置 `NEWAPI_BASE_URL`，则会打印警告。

`modelInfo` 条目会为内置模型数据库中未找到的模型自动生成。你可以编辑它们以调整 `reasoning`、`input` 类型、`contextWindow` 或 `maxTokens`。也可以选择添加 `thinkingLevelMap`（如 `{ "xhigh": "max" }`）。当之前未知的模型后来被识别时，该模板会自动移除。

## 工作原理

1. **配置同步** — 读取已存储的密钥和基础 URL，与 `NEWAPI_BASE_URL` 环境变量同步
2. **费率配置获取** — 从网关获取 `GET /api/ratio_config`（无需认证），读取 NewAPI 的 `model_ratio`、`completion_ratio`、`cache_ratio` 和 `create_cache_ratio` 映射。此步骤为尽力而为——如果失败，费用将报告为 `0`
3. **模型发现** — 从网关获取 `GET /v1/models`（需要 API Key）
4. **费率匹配** — 通过三级回退机制将每个模型 ID 与费率配置键匹配：精确匹配 → 不区分大小写匹配 → 前缀匹配。这处理了 NewAPI 不一致的命名（如版本标签、混合大小写）
5. **模型增强** — 将发现的模型与 `vercel-ai-gateway` 内置模型数据匹配（通过去除 `provider/` 前缀并转换为小写进行标准化），以填充 `contextWindow`、`maxTokens`、`reasoning`、`thinkingLevelMap` 和 `input` 类型。未知模型使用默认值（128K 上下文 / 4096 最大输出 token / 仅文本）
6. **费用计算** — 将 NewAPI 配额转换为每百万 token 的美元价格。基于 NewAPI 公式 `Quota = (Input + Output × CompletionRate) × ModelRate × GroupRate`，其中 `1 USD = 500,000 配额`：
   - `cost.input     = modelRatio × 2`
   - `cost.output    = modelRatio × completionRatio × 2`
   - `cost.cacheRead  = modelRatio × cacheRatio × 2`
   - `cost.cacheWrite = modelRatio × createCacheRatio × 2`
7. **后端路由** — 匹配 `gpt-`、`o1`、`o3` 或 `o4` 前缀的模型使用 OpenAI Responses API；其他所有模型使用 Anthropic Messages API
8. **模型信息模板** — 未知模型（不在内置数据中）会在 `provider-newapi.json` 的 `modelInfo` 中添加模板供手动编辑。当之前未知的模型后来被识别时，模板会自动移除

### 优雅降级

如果模型发现失败（网络错误、认证失败等），provider 会回退到**未配置**状态：

- 注册一个占位模型 `newapi/unconfigured`
- 如果 `auth.json` 中存在 API Key，提示用户运行 `/reload` 然后 `/model`
- 如果不存在 API Key，提示用户运行 `/login`

这确保 pi 在启动时永远不会崩溃——它始终呈现一个可用的（尽管处于非活动状态的）provider。

## 系统要求

- [pi](https://github.com/earendil-works/pi-coding-agent) 编码代理
- NewAPI 网关
- 如需费用追踪：网关设置 → 运营 → 费率中的 `ExposeRatioEnabled` 必须为 `true`
- 通过网关访问模型所需的 API Key

## 无 ratio_config 时

如果网关的 `ExposeRatioEnabled` 设置为 `false`，扩展仍然可以正常工作——所有费用将报告为 `0`（使用量追踪已禁用）。模型发现和路由不受影响。

## 许可证

[MIT](LICENSE) © [ttimasdf](https://github.com/ttimasdf)
