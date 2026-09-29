# 架构与实现

## 目录结构

```
dsh-session-dir/
├── package.json        # 双端插件包元数据（main=host 入口，exports["./client"]=浏览器入口）
├── cordis.patch.yml    # bundle patch：把插件行插入 profile 组合
├── src/index.js        # Host：vdirs-* RPC、目录/会话状态、中央存储读写
├── src/client.js       # Client：React UI（目录树 + 拖拽 + 空白会话 claim）
├── scripts/            # verify-*.mjs，无头验证（不进发布包）
└── docs/               # 本文档与 rpc.md
```

## 存储模型

目录树集中存放在 Harness 数据根下，**不在插件目录、也不在工作区**：

```
<DSH_HOME>/dsh-session-dir/
├── index.json              # 规范化工作区路径 → {title,path,file,updatedAt}
└── config/<slug>-<hash8>.json
```

单份配置的结构：

```json
{
  "format": 1,
  "id": "<workspaceId>",
  "workspace": { "path": "<明文路径>", "title": "<标题>" },
  "savedAt": 1730000000000,
  "dirs": [{ "id": "d…", "name": "设计", "parentId": null, "createdAt": 1 }],
  "members": { "d…": ["<sessionId>"] },
  "rootOrder": []
}
```

会话顺序就是持久顺序：目录内按 `members` 数组、根目录按 `rootOrder` 排列，拖拽排序（`vdirs-reorder-session`）直接改写并落盘，新会话追加在末尾。`rootOrder` 是新增的可选字段，旧文件没有它时根目录回退为 Host 列表顺序；`members` 数组一直是顺序列表，1.x 导入后即可排序。

设计约束：

- **`$DSH_HOME` 解析顺序**为显式 `DSH_HOME` → `~/.dsh`，空白值视为未设置；每次 `apply()` 惰性求值，改环境变量后重启即生效。
- **文件名 = 可读 slug + 规范化路径的 sha256 前 8 位**。slug 让人一眼看出是哪个工作区，哈希保证同名工作区不撞车；文件名从路径**推导**得出，因此索引损坏也能定位文件。
- **索引只作对照表**，读取时先按推导出的文件名直读，工作区路径不匹配则回退为扫描 `config/` 逐份比对明文路径（应对手工改名或手工编辑索引）。
- **写入原子化并串行**：临时文件 + `rename`，同一工作区的写操作排队；响应等待本次写入完成，避免连续拖拽时「后写先落」丢改动。
- **坏文件不覆盖**：无法解析或不属于本工作区的文件只记日志并当作空树，绝不改写——它可能是仅存的副本。索引同样只读不改。
- **删除目录后仍会写回一份空配置**：中央文件与工作区无关，保留它是为了让「目录被删空」这件事本身可持久化，避免下次读取时把旧的 1.x 文件当成新状态重新导入。

### 与 1.x 的关系

1.5 及更早版本把同名数据写在**工作区根目录**的 `.dsh-vdirs.json`。当中央文件不存在时，插件读取该文件、导入中央存储，此后**不再写它、也不删除它**——它是升级路径与降级回退，不是第二份事实来源。

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

- **Host**（`src/index.js`）：`showableIds()` 依据官方 Host 列表的 `blank` 字段（即侧边栏隐藏 `New Session` 行所用的同一个值），把空白会话从**所有**列表与计数中排除，失焦的空白行不可能落在「根目录」；旧版遗留在 `.dsh-vdirs.json` 的空白成员会在首次读取时清掉。`sessionController` 是可选服务：拿不到它时只裁剪**确知**应隐藏的归档成员，不会因为无法证明某行是空白而误删真实会话。
- **Client**（`src/client.js` 的 claim 机制）：「当前空白会话」= `sessions.list` 快照里 `blank === true` 且 `retainedBy.mainView > 0` 的那一个，与官方浏览器取 `New Session` 行的判据一致；渲染时再按同一个 `blank` 位过滤一遍。目录归属只存在于浏览器内存，**空白会话绝不写进持久层**；空白行是不可拖拽、无会话数据的临时行，无需轮询去「猜」新建出来的会话。

## 开发约定

- 纯 JS，无 TS/JSX 转译：用 `React.createElement`，不要写 `<Component/>`。
- 变更 RPC 前缀（`vdirs-`）时，同步更新 client 的 `rpc.call(...)` 参数（endpoint 名同为 `vdirs-*`）。
- 配置结构以 `format` 字段定版，字段见 Host 端 `adopt()` / `payloadOf()`；改结构时同步递增 `STORE_FORMAT` 并保留旧值读取。
- 语法检查 `node --check src/index.js && node --check src/client.js`；无头验证 `npm run verify`（假服务加载 `src/*.js`，按用户操作顺序驱动并断言）：
  - `verify-host.mjs`：`/vdirs` 路由与信封、鉴权拒绝、目录 CRUD、排序、分页、空白/归档成员裁剪、1.x 文件只读导入与中央存储落盘；
  - `verify-store.mjs`：真实文件系统上的中央存储 —— 多工作区各一份文件、索引对照、重启后恢复、坏文件不覆盖；
  - `verify-claim.mjs`：新建会话全流程 —— 委托官方 `startSession`、空白行在目标目录内渲染、失焦后移除隐藏、再次点击复用同一空白会话、首次对话后落库到该目录。

## 数据与槽位

- 目录归属数据集中持久化在 `<DSH_HOME>/dsh-session-dir/`（文件级，非内存），与插件安装目录、工作区目录都无关，因此卸载/覆盖安装不受影响。
- 插件以 `priority: -100` 覆盖官方浏览器占用的 `sidebar.workspaces` 单值槽位；若同时启用其他覆盖该槽位的插件（如 `dsh-better-sidebar`），需保证 priority 不同，否则 SlotCore 会因同优先级重复注册而报错。
