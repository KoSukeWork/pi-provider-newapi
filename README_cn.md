# pi-provider-newapi

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![pi extension](https://img.shields.io/badge/extension-pi%20provider-green.svg)](https://github.com/ttimasdf/pi-provider-newapi)

[pi](https://github.com/earendil-works/pi) coding agent 的自托管 [NewAPI](https://github.com/QuantumNous/new-api) AI 网关 provider 扩展。

支持**多个命名 provider**，每个 provider 对应一个独立的 NewAPI 实例。启动时，每个 provider 会自动发现模型、从 pi 内置元数据中进行增强，并完成注册。API 路由自动完成：

| 推荐 API | 端点 |
|---|---|
| `openai-completions`、`openai-responses` | `{baseUrl}/v1` |
| `anthropic-messages` | `{baseUrl}` |

**[English README](https://github.com/ttimasdf/pi-provider-newapi/blob/main/README.md)**

## 安装

```bash
pi install npm:pi-provider-newapi
```

或从 git 安装：

```bash
pi install git:github.com/ttimasdf/pi-provider-newapi
```

扩展通过 `package.json` 中的 `pi.extensions` 字段自动发现，无需额外配置。

## 快速上手

在 pi 会话中运行 `/newapi-provider-add`，命令将依次提示输入：

1. **Provider 名称** — 自定义标识符（如 `my_gateway`），不能与 pi 内置 provider 名称重复。
2. **Base URL** — NewAPI 实例的根地址（如 `https://ai.example.com`）。
3. **API Key** — NewAPI 密钥。

命令在保存任何内容前会先验证连通性。成功后立即注册 provider，无需 `/reload`。

```
pi> /newapi-provider-add my_gateway
Provider name: my_gateway
Base URL: https://ai.example.com
API Key: sk-your-api-key
✓ Provider "my_gateway" added with 42 models.
```

可添加任意数量的 provider，每个 provider 以其名称独立注册：

```
pi> /model my_gateway/claude-sonnet-4-5
```

## 命令

| 命令 | 说明 |
|---|---|
| `/newapi-provider-add [name]` | 添加新 provider（交互式提示） |
| `/newapi-provider-remove [name]` | 移除 provider，同时注销注册、删除配置和凭据 |
| `/newapi-provider-list` | 显示所有已配置 provider 的地址、认证状态和模型覆盖数 |

## 配置说明

### 配置文件

`<agentDir>/extensions/provider-newapi.json`

```json
{
  "providers": {
    "my_gateway": {
      "baseUrl": "https://ai.example.com",
      "modelOverrides": {
        "unknown-model-id": {
          "api": "anthropic-messages",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 4096
        }
      }
    },
    "second_gateway": {
      "baseUrl": "https://gw2.example.com",
      "modelOverrides": {}
    }
  },
  "settings": {
    "onboardingWarnCountdown": 3
  }
}
```

- **`providers`** — 每个 NewAPI 实例对应一个条目，键名即为 pi 注册的 provider 名称。
- **`modelOverrides`** — 手动补充或覆盖 pi 内置目录中未收录的模型元数据。扩展会为每个未知模型自动生成模板条目，按需编辑即可。对于已收录的模型，条目会保留，并在增强后的内置元数据之上应用覆盖。
- **`settings.onboardingWarnCountdown`** — 内部计数器；未配置任何 provider 时，每次启动递减一次。

### 凭据存储

API 密钥存储在 pi 标准的 `<agentDir>/auth.json` 中，以 provider 名称为键。`/newapi-provider-add` 会自动写入。初次设置后，也可通过 pi 的 `/login` 命令更新已有 provider 的密钥。

`<agentDir>` 默认路径：

| 系统 | 路径 |
|---|---|
| Linux / macOS | `~/.pi/agent` |
| Windows | `%USERPROFILE%\.pi\agent` |

### 配置无效时的处理

若 `provider-newapi.json` 无法解析或格式不符，扩展会将其备份为 `provider-newapi.json.bak`，以空配置启动，并打印警告。使用 `/newapi-provider-add` 重新配置即可。

## 多 provider 示例

```json
{
  "providers": {
    "internal": {
      "baseUrl": "https://ai.corp.internal",
      "modelOverrides": {}
    },
    "personal": {
      "baseUrl": "https://my-newapi.fly.dev",
      "modelOverrides": {}
    }
  },
  "settings": {}
}
```

两个 provider 的模型均可在 `/model` 中按各自命名空间访问（`internal/<id>`、`personal/<id>`）。
