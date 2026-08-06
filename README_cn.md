# pi-provider-newapi

[![CI](https://github.com/ttimasdf/pi-provider-newapi/actions/workflows/ci.yml/badge.svg)](https://github.com/ttimasdf/pi-provider-newapi/actions/workflows/ci.yml)
[![pi package catalog](https://img.shields.io/badge/pi-package%20catalog-5B5BD6.svg)](https://pi.dev/packages/pi-provider-newapi)
[![npm](https://img.shields.io/npm/v/pi-provider-newapi.svg)](https://www.npmjs.com/package/pi-provider-newapi)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![社区 | Linux.do](https://img.shields.io/badge/社区-Linux.do-blue.svg)](https://linux.do/)

将 [pi](https://github.com/earendil-works/pi) 连接到一个或多个自托管的 [NewAPI](https://github.com/QuantumNous/new-api) 网关。扩展要求 Pi Coding Agent 为 **v0.84.0 或更高版本**。

每个网关都会在 pi 中注册为独立的命名 provider。扩展可以：

- 从 NewAPI 动态发现可用模型；
- 使用 pi 内置的模型能力与兼容性元数据补全已知模型；
- 根据网关公布的端点自动选择兼容 API，并支持通过正则表达式覆盖；
- 在 NewAPI 提供 ratio 配置时计算模型费用；
- 在离线或网关暂时不可用时继续使用最近一次成功的模型目录。

凭据始终由 pi 管理。扩展不会把 API Key 写入自身配置、模型定义、日志或缓存目录。

**[English README](https://github.com/ttimasdf/pi-provider-newapi/blob/main/README.md)**

## 安装

从 npm 安装：

```bash
pi install npm:pi-provider-newapi
```

也可以直接从 GitHub 安装：

```bash
pi install git:github.com/ttimasdf/pi-provider-newapi
```

## 快速上手

使用网关根地址添加 provider，不要包含 `/v1`：

```text
pi> /newapi-provider-add my_gateway
Base URL: https://ai.example.com
Provider "my_gateway" added. Run /login my_gateway to enter its API key; Pi will then discover its models.
```

添加时会尝试检查网关是否可以访问。即使出现警告，配置仍会保存，因为需要认证的网关通常会拒绝匿名探测。

接下来，通过 pi 的标准登录流程录入 API Key：

```text
pi> /login my_gateway
```

在首次发现模型之前，provider 就已经可以通过 `/login` 进行认证。完成登录后，打开 `/model`，选择如 `my_gateway/claude-sonnet-4-5` 这样的模型即可。

凭据由 pi 配置的 CredentialStore 保存，通常位于 `<agentDir>/auth.json`。请勿将 API Key 写入 `provider-newapi.json`。

## 命令

| 命令 | 说明 |
|---|---|
| `/newapi-provider-add [name]` | 添加并立即注册 NewAPI 网关，然后提示输入网关根地址。 |
| `/newapi-provider-remove [name]` | 注销 provider 并删除扩展配置；请先运行 `/logout <name>`。 |
| `/newapi-provider-list` | 显示各 provider 的地址、认证状态、API 覆盖数量和启用状态。 |
| `/newapi-generate-models-json` | 为已经发现但 pi 尚不认识的模型生成可编辑的 `modelOverrides` 模板。 |

### 移除 provider

Pi 尚未通过扩展 API 提供凭据删除能力。若要同时移除凭据和 provider 配置，请按顺序运行：

```text
/logout my_gateway
/newapi-provider-remove my_gateway
```

扩展不会直接编辑 `auth.json`，因此这套流程同样兼容自定义 pi CredentialStore。

## 模型发现与缓存

动态 provider 的模型目录由 pi 负责触发刷新：

- 打开 `/model` 会在后台开始刷新。修改 `modelApiOverrides` 或 pi 的 `models.json` 后，也可用这种方式应用新配置。
- `pi update --models` 会立即强制刷新，无需等待后台更新。
- 刷新成功后，pi 会把各 provider 的模型目录存入 `<agentDir>/models-store.json`。
- 禁止网络访问时，扩展会直接恢复最近一次成功的目录，不会请求 NewAPI。
- 刷新失败时仍会保留最后一次可用的目录。`/api/ratio_config` 是可选端点，但要生成新的模型目录，`/v1/models` 必须请求成功。
- `/v1/models` 请求超时为 15 秒，可选比例元数据请求超时为 10 秒，添加 provider 时的连通性检查超时为 5 秒。底层仍由 pi 的全局 HTTP dispatcher 负责代理路由与空闲超时处理。

目录更新使用 pi 带代次校验的发布 API，因此较早发起、较晚完成的刷新不会覆盖更新的数据。缓存中绝不会包含 API Key。

## 配置

添加和移除命令会管理 `<agentDir>/extension-settings/provider-newapi.json`。通常只有在需要覆盖 API 路由时，才需要直接编辑此文件：

```json
{
  "version": 1,
  "providers": {
    "my_gateway": {
      "baseUrl": "https://ai.example.com",
      "modelApiOverrides": {
        "^claude-": "anthropic-messages",
        "^gpt-": "openai-completions"
      }
    },
    "second_gateway": {
      "baseUrl": "https://gw2.example.com",
      "modelApiOverrides": {}
    }
  },
  "settings": {
    "onboardingWarnCountdown": 3
  }
}
```

- **`version`** 是扩展配置的 schema 版本，当前为 `1`。没有版本字段的旧配置会自动升级；由更高版本 schema 创建的文件会原样保留，并拒绝加载，直到扩展完成升级。
- **`providers`** 为每个 NewAPI 网关保存一个条目。键名就是 pi 中显示的 provider ID。
- **`baseUrl`** 是不含 `/v1` 的网关根地址；末尾的斜杠会自动移除。
- **`modelApiOverrides`** 将 JavaScript 正则表达式映射到 pi API。规则按 JSON 中的顺序匹配，首个命中项生效。可用值为 `anthropic-messages`、`openai-completions` 和 `openai-responses`；无效的正则或 API 值会被忽略并输出警告。
- **`settings.onboardingWarnCountdown`** 是内部状态，用于将未配置 provider 的提醒限制为三次启动。

### API 路由

默认情况下，扩展会结合 pi 的内置元数据与 NewAPI 返回的 `supported_endpoint_types` 选择 API。命中的 `modelApiOverrides` 规则优先级高于这两者。

| 模型 API | 传给 pi 的 Base URL |
|---|---|
| `openai-completions`、`openai-responses` | `{baseUrl}/v1` |
| `anthropic-messages` | `{baseUrl}` |

### 模型元数据与兼容性

模型元数据和兼容性覆盖由 pi 管理。请使用相同的 provider ID，将配置写入 `<agentDir>/models.json`：

```json
{
  "providers": {
    "my_gateway": {
      "compat": {
        "sendSessionAffinityHeaders": true
      },
      "modelOverrides": {
        "unknown-model-id": {
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 32768
        }
      }
    }
  }
}
```

Pi 会在模型发现完成后，按精确模型 ID 应用这些覆盖。Provider 级 `compat` 会影响网关上的所有模型；如果只想影响一个模型，请将 `compat` 放入该模型的覆盖项中。

对于 pi 内置目录中不存在的模型，可运行：

```text
/newapi-generate-models-json
```

该命令会刷新当前可用的目录，并将模板写入 `<agentDir>/models-generated.json`。它不会修改由用户维护的 `models.json`；请把需要的 provider 和模型条目复制到该文件中，并与已有内容合并。如果某个 provider 尚无可用目录，请先打开 `/model`，再重新运行生成命令。

### 从 v0.4 迁移

扩展不再读取旧的 `modelOverrides` 或 `settings.sendSessionAffinityHeaders` 字段。请将原有的 `api` 选择迁移到 `modelApiOverrides`——精确匹配可使用 `^model-id$` 这样的表达式——并按上例将模型元数据和 `compat` 设置迁移到 pi 的 `models.json`。

`<agentDir>` 的默认位置为：

| 系统 | 路径 |
|---|---|
| Linux / macOS | `~/.pi/agent` |
| Windows | `%USERPROFILE%\.pi\agent` |

首次使用时，已有的 `<agentDir>/extensions/provider-newapi.json` 会自动移动到新的 `extension-settings` 目录。如果配置格式错误，扩展会先备份为 `provider-newapi.json.bak`，再替换成有效的空配置。

## 多网关

不同 provider 的模型目录、凭据和缓存彼此独立。例如，模型选择器中可以同时出现：

```text
internal/claude-sonnet-4-5
personal/gpt-4o
```

## 开发

项目不需要构建：pi 会直接加载根目录的 `index.ts`。具体实现按功能拆分在 `src/` 下，测试位于 `test/`。

```bash
pnpm install
pnpm run typecheck
pnpm test
```

GitHub Actions 会在 push 和 pull request 上运行同一套类型检查与测试。
