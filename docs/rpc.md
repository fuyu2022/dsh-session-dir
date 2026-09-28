# Host RPC 约定

Client 走 `ctx.connection.rpc.call`，路由挂在 Connection 通道 `/vdirs` 上，endpoint 名为 `vdirs-*`。

| RPC | 入参 | 说明 |
|---|---|---|
| `vdirs-workspaces` | — | 工作区列表 `{workspaces:[{id,title,path}]}` |
| `vdirs-tree` | `{workspaceId}` | 目录树 `{dirs,rootCount,total}` |
| `vdirs-create-dir` | `{workspaceId,parentId?,name}` | 建目录，`parentId` 缺省为根 |
| `vdirs-rename-dir` | `{workspaceId,dirId,name}` | 重命名 |
| `vdirs-delete-dir` | `{workspaceId,dirId}` | 删目录（成员回移上级） |
| `vdirs-move-session` | `{workspaceId,sessionId,dirId?}` | 移动会话，`dirId=null` 回根；空白会话首次对话后也走这里落库 |
| `vdirs-reorder-dir` | `{workspaceId,dirId,targetId?,place}` | 同级排序 |
| `vdirs-sessions` | `{workspaceId,dirId?,offset,limit}` | 分页会话列表；`dirId` 缺省为根，每行 `{sessionId,title,createdAt,lastActiveAt}` |

会话重命名不走 Host：client 直接用官方 `sessions.using(id, {source:'controllerOperation'}, ref => ref.binding.session.rename(title))`。运行中 / 空白等实时状态也取自 client 自己的 `sessions.list` 快照，Host 只负责目录归属、排序、分页与时间戳。

## 注册方式

Host 端**不**使用 `connection.rpc.handle` —— 它把路由挂到 connection 自身 ctx 上，而该 ctx 未注入 `webServer`，会抛 `cannot get property webServer without inject`。正确做法：

- 插件自己 `ctx.inject(['webServer'])`，注册 `/vdirs` prefix 路由；
- 复用 `connection.admit()` 做与 `/api` 一致的 Host/Origin + 浏览器凭据认证。

## Wire 格式

与 `connection.rpc.call` 完全兼容：

```
POST /vdirs/<endpoint>
  → {type:'client-request', rpcId, method, payload}
  ← {type:'server-response', rpcId, result:{ok,value}}
```

通道名必须是单段路径（DSH 规则 `^\/[A-Za-z0-9._~-]+$`，不含内部斜杠）。

## 依赖注入

- **Host**：`workspaceRegistry`、`sessionQuery`、`connection`、`webServer`；可选 `fs`（持久化）、`sessionController`（官方列表 —— 同时提供 updatedAt 与空白会话判定，30s 缓存）。
- **Client**：`slots`、`uiWorkspace`、`workspaces`；可选 `sessions`（空白/运行状态与重命名）、`connection`（RPC）、`timer`。

Client 不依赖动态沙箱全局（无 `harness` / `styles` / `host`），也不 import 任何 Harness Client UI 包（官方图标按 16×16 artwork 内联），只在 factory 内经 `require('react')` 取 React。
