# pi-provider-newapi

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![pi extension](https://img.shields.io/badge/extension-pi%20provider-green.svg)](https://github.com/ttimasdf/pi-provider-newapi)

用于自托管 [NewAPI](https://github.com/QuantumNous/new-api) 网关的 [pi](https://github.com/earendil-works/pi) coding-agent provider 扩展。要求 Pi 与 `@earendil-works/pi-ai` 均为 **v0.80.8 或更高版本**。

支持多个命名 provider，每个 provider 对应独立的 NewAPI 实例。发现的模型会使用 pi 的内置元数据增强，并自动选择路由：

| 模型 API | 端点 |
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

## 快速上手

先添加网关配置：

```text
pi> /newapi-provider-add my_gateway
Provider name: my_gateway
Base URL: https://ai.example.com
Provider "my_gateway" was added. Run /login my_gateway to enter its API key; Pi will then discover its models.
```

然后使用 Pi 标准的凭据流程进行认证：

```text
pi> /login my_gateway
```

即使模型尚未发现，provider 也会出现在 `/login` 中。登录后 Pi 会存储 API Key、刷新 provider 模型列表，模型随即可以使用：

```text
pi> /model my_gateway/claude-sonnet-4-5
```

不要在扩展配置中写入 API Key。凭据由 Pi 管理，并由其配置的 CredentialStore 保存（通常是 `<agentDir>/auth.json`）。

## 命令

| 命令 | 说明 |
|---|---|
| `/newapi-provider-add [name]` | 添加网关配置并立即注册；然后运行 `/login <name>`。 |
| `/newapi-provider-remove [name]` | 注销并删除网关配置。请先运行 `/logout <name>` 删除 Pi 管理的凭据。 |
| `/newapi-provider-list` | 显示已配置 provider 的认证状态、覆盖条目和活动状态。 |

### 移除流程

Pi v0.80.8 尚未向扩展公开凭据删除接口。完整移除 provider 时，请先运行：

```text
/logout my_gateway
/newapi-provider-remove my_gateway
```

移除命令绝不会直接编辑 `auth.json`，因此仍可兼容自定义 Pi CredentialStore。

## 模型列表刷新与离线模型列表

NewAPI 发现功能通过 Pi 的动态 provider 刷新回调实现：

- 打开 `/model` 会在后台刷新已配置的 NewAPI 模型列表。更改 `settings.sendSessionAffinityHeaders` 或其他扩展配置后，打开 `/model` 即可将修改应用到刷新后的模型列表。
- `pi update --models` 会立即强制刷新模型列表；若需要立刻使用更新后的模型配置，请使用该命令而非等待后台刷新。
- 成功的模型列表按 provider 存储在 Pi 的 `<agentDir>/models-store.json`。
- 离线模式下，Pi 会恢复最近一次成功的模型列表，且不会向 NewAPI 发出请求。
- 刷新失败会保留最后一次有效的缓存模型列表。可选的 `/api/ratio_config` 端点失败不会阻止发现；获取新模型列表时 `/v1/models` 必须成功。

缓存模型列表中不会保存 API Key。

## 配置说明

网关配置保存在 `<agentDir>/extensions/provider-newapi.json`：

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
    "onboardingWarnCountdown": 3,
    "sendSessionAffinityHeaders": true
  }
}
```

- **`providers`** — 每个 NewAPI 实例一个条目，键名即 Pi provider ID。
- **`modelOverrides`** — 为未知模型补充元数据，或在已知模型的内置元数据之上覆盖字段。对于已知（已增强）的模型，仅覆盖你显式填写的字段，其余字段沿用内置值，因此像 `{ "reasoning": true }` 这样的部分条目也是合法的。发现未知模型后扩展会生成模板，可按需要修改。
- **`settings.onboardingWarnCountdown`** — 内部状态，用于将无 provider 的提醒限制为三次启动。
- **`settings.sendSessionAffinityHeaders`** — 未设为 `false` 时，会为所有已发现的 `openai-completions` 和 `anthropic-messages` 模型添加 Pi 的会话亲和兼容选项，帮助网关将可缓存的同一会话请求路由至同一后端。默认为 `true`。`openai-responses` 会在启用缓存的请求中自动发送会话亲和数据。

`<agentDir>` 的默认位置：

| 系统 | 路径 |
|---|---|
| Linux / macOS | `~/.pi/agent` |
| Windows | `%USERPROFILE%\.pi\agent` |

如果配置格式错误，扩展会将其备份至 `provider-newapi.json.bak`，然后以有效的空配置重新开始。

## 多 provider

各网关模型在 Pi 的模型选择器中保持独立：

```text
/model internal/claude-sonnet-4-5
/model personal/gpt-4o
```

每个 provider 都有独立的扩展配置、Pi 凭据和缓存模型列表。
