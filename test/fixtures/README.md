这些样本来自 2026-09-13 对 MiMo 26.912.121036 的实际调用，使用的是专门创建的简短测试消息。Cookie、认证请求头和账户 Cookie 值均已脱敏。

媒体请求样本补充于 2026-09-15，来自同版本客户端处理测试视频的真实工具闭环；仅保留消息结构，调用 ID、文件路径和图片 URL 已替换为测试值。

| 文件 | 来源与用途 | 结果 |
| --- | --- | --- |
| [client-baseline/trace.json](client-baseline/trace.json) | 原客户端请求、脱敏请求头、响应状态与接收数据块大小/时间 | HTTP 200；6 个数据块 |
| [client-baseline/response.sse](client-baseline/response.sse) | 原客户端原始 SSE，用于按真实数据块边界回放 | 9 个 SSE 事件、2,416 字节；正文 OK |
| [proxy-tools/response.sse](proxy-tools/response.sse) | 工具调用的原始上游 SSE，用于回归 null 分片的合并语义 | echo，参数 text=OK，finish_reason=tool_calls |
| [client-media-request.json](client-media-request.json) | 客户端读取视频 0、2、4 秒三帧后的请求投影；不含原始视频、图片或系统提示 | 3 条文本 tool 结果之后统一附加 user 图片消息；上游 HTTP 200 |

前三份数据由 [server.test.js](../server.test.js) 直接读取，两份 SSE 同时用于 [Responses 回归](../responses.test.js)。媒体请求投影用于验证 Responses 的 JSON / SSE 视频帧工具闭环，所有 tool 消息必须为文本，图片在对应调用组补齐后发送。抓到的是 HTTP 解码后的 SSE 内容，不是 TLS 报文或 TCP 抓包；网络数据块也不等于 SSE 事件。仓库通过 `.gitattributes` 禁止转换 SSE 文件的换行，保证回放时的字节长度一致。

2026-09-13 的普通聊天样本通过客户端实际 IPC 聊天入口调用网关。其请求头明确包含 `X-Mimo-Source: mimocode-cli-free` 和 `X-Client-Version: 26.912.121036`，JSON 顶层字段为 `model/messages/stream/meta`。Cookie 由 Electron 的登录会话自动添加，样本只记录 Cookie 名称及标记，没有导出值。

真实协议带来两项必须修正的细节：

1. 普通文本分片中的 `tool_calls` 可以为 null，表示没有工具增量，不能作为格式错误。
2. 工具调用后续分片中的 `id`、`function.name` 可以为 null，表示不更新；只有有效参数片段应继续拼接。直接覆盖或字符串相加会得到错误的函数名和带有 null 字样的调用 ID。

另外，`mimo-pro` 请求实际返回 `model: mimo-x-pro-preview`；最后的 usage 事件使用 `choices: []`，之后还有 `[DONE]`。代理保留这些实际元数据，而不再把请求模型、固定 stop 或本地生成的元数据强加给响应。

其他一次性验证输出已清理。重新采集的数据写入被 Git 忽略的 `captures/`；新增回归样本需先完成脱敏，再按测试所需范围放入本目录。复现方式见 [项目说明](../../README.md)。
