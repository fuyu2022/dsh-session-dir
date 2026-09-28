# 架构与实现

## 目录结构

```
dsh-session-dir/
├── package.json        # 双端插件包元数据（main=host 入口，exports["./client"]=浏览器入口）
├── cordis.patch.yml    # bundle patch：把插件行插入 profile 组合
├── src/index.js        # Host：vdirs-* RPC、目录/会话状态、.dsh-vdirs.json 持久化
├── src/client.js       # Client：React UI（目录树 + 拖拽 + 空白会话 claim）
├── scripts/            # verify-host.mjs / verify-claim.mjs，无头验证（不进发布包）
└── docs/               # 本文档与 rpc.md
```

## 新建会话机制

官方 `uiWorkspace.startSession(workspaceId)` 会「复用或创建」该工作区的空白会话，且侧边栏只在它**仍是当前会话**时显示 —— 所以反复点「新建会话」永远只维持一个空白行，失去焦点即隐藏，再点又回到同一个会话。本插件沿用这套语义并延伸到虚拟目录：

| 动作 | 行为 |
|---|---|
| 工作区标题上的 `＋` | 调用官方 `startSession`，空白行显示在「根目录」 |
| 目录行上的 `＋` | 先展开该目录，再调用官方 `startSession`，空白行显示在该目录内 |
| 空白状态下切走到别的会话 | 行立即消失：该目录与根目录都不再显示 |
| 空白状态下发出第一条消息 | 转为正式会话，并**持久化归属到创建它的目录** |
| 再次点 `＋` | 复用同一个空白会话（不新建），重新显示 |

### 实现要点

- **Host**（`src/index.js`）：`showableIds()` 依据官方 Host 列表的 `blank` 字段（即侧边栏隐藏 `New Session` 行所用的同一个值），把空白会话从**所有**列表与计数中排除，失焦的空白行不可能落在「根目录」；旧版遗留在 `.dsh-vdirs.json` 的空白成员会在首次读取时清掉。
- **Client**（`src/client.js` 的 claim 机制）：「当前空白会话」= `sessions.list` 快照里 `blank === true` 且 `retainedBy.mainView > 0` 的那一个，与官方浏览器取 `New Session` 行的判据一致；渲染时再按同一个 `blank` 位过滤一遍。目录归属只存在于浏览器内存，**空白会话绝不写进 `.dsh-vdirs.json`**；空白行是不可拖拽、无会话数据的临时行，无需轮询去「猜」新建出来的会话。

## 开发约定

- 纯 JS，无 TS/JSX 转译：用 `React.createElement`，不要写 `<Component/>`。
- 变更 RPC 前缀（`vdirs-`）时，同步更新 client 的 `rpc.call(...)` 参数（endpoint 名同为 `vdirs-*`）。
- `.dsh-vdirs.json` 保持既定结构，字段见 Host 端 `ensure()` 解析逻辑。
- 语法检查 `node --check src/index.js && node --check src/client.js`；无头验证 `npm run verify`（假服务加载 `src/*.js`，按用户操作顺序驱动并断言）：
  - `verify-host.mjs`：`/vdirs` 路由与信封、鉴权拒绝、目录 CRUD、排序、分页、空白/归档成员裁剪与旧数据收敛；
  - `verify-claim.mjs`：新建会话全流程 —— 委托官方 `startSession`、空白行在目标目录内渲染、失焦后移除隐藏、再次点击复用同一空白会话、首次对话后落库到该目录。

## 数据与槽位

- 目录归属数据持久化在每个工作区的 `.dsh-vdirs.json`（文件级，非内存）。
- 插件以 `priority: -100` 覆盖官方浏览器占用的 `sidebar.workspaces` 单值槽位；若同时启用其他覆盖该槽位的插件（如 `dsh-better-sidebar`），需保证 priority 不同，否则 SlotCore 会因同优先级重复注册而报错。
