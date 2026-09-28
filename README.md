# dsh-session-dir

**虚拟目录会话管理器** —— 把 DSH 侧边栏的会话列表替换成目录树：拖拽移动 / 排序、会话重命名与归档。
目前只有中文界面。

## 安装

```bash
dsh plugin --profile web add github:fuyu2022/dsh-session-dir#main
```

装完**重启 DSH**。确认 bundle patch 已生效：

```bash
dsh --profile web --dump-config | grep -A2 dsh-session-dir
```

> 插件以 `priority: -100` 覆盖官方占用的 `sidebar.workspaces` 槽位；同时启用其他覆盖该槽位的插件（如 `dsh-better-sidebar`）时需保证 priority 不同，否则 SlotCore 会因同优先级重复注册而报错。

## 本地开发安装

首选 **link** —— pnpm 建立符号链接，仓库里的改动直接对运行中的 profile 生效：

```bash
dsh plugin --profile web link "./dsh-session-dir"
```


装好后：

- **重启 DSH**

## 卸载
```
dsh plugin --profile web remove dsh-session-dir
```

## License

MIT
