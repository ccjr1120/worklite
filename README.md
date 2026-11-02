# WorkLite 本地部署

首次部署需要 Node.js 22、pnpm 10 和 `lsof`：

```sh
pnpm deploy:local
```

部署成功后会自动检查并在 `~/.local/bin` 安装指向此项目的 `worklite` 命令。如果该目录不在 PATH 中，将安装脚本提示的 `export` 命令加入 shell 配置并重新加载。项目目录需要保留在原位置。

之后可在任意目录执行：

```sh
worklite start
worklite restart
```

命令启动上次成功部署的版本，默认地址为 http://127.0.0.1:23390/，不会重新构建或修改部署版本。更新项目代码后仍需在项目目录运行 `pnpm deploy:local`；重启电脑后可运行 `worklite start`。数据保存在项目的 `.data/deployment` 中。
