# Chat 本地图片产物

受保护的 `worklite-platform` 工具 `upload_local_images` 将 API 主机上已有的图片登记到当前工作区的 Artifacts。它不生成图片，也不创建临时静态目录。Web Chat 使用现有 Markdown 图片组件渲染返回的引用。

调用示例（工具输入，也就是 `POST /api/artifacts/local-images` 的 JSON 请求体）：

```json
{
  "files": [
    { "path": "/tmp/e2e-techdoc/V-home.png", "description": "首页截图" },
    { "path": "/tmp/e2e-techdoc/V-detail.jpg", "description": "详情截图" }
  ]
}
```

成功返回 `{ "images": [...] }`。每项含稳定的 `art_` id、名称、真实 MIME、大小、尺寸、`contentUrl` 和 `markdown`。把 `markdown` 原样放入回复，例如 `![首页截图](/api/artifacts/art_<uuid>/content)`，即可显示图片。源绝对路径和内部 object key 不出现在响应中；未提供描述时名称为「图片 1」等。链接沿用产物的工作区权限，保留到产物被删除，不走临时 Chat 附件的过期清理。此入口只承诺 Web Chat 直接显示；其他渠道原生发送图片仍使用各自现有的 Chat 附件链路。

支持 PNG、JPEG、GIF、WebP，按内容签名及实际解码校验，不信任文件扩展名。每批 1–8 张，每张最多 10 MiB，每批合计最多 40 MiB；单边不超过 16384 像素，总像素不超过 4000 万。源路径必须是本地绝对路径，拒绝 `..`、非普通文件和符号链接；macOS 系统 `/tmp`、`/var`、`/etc` 别名会先规范化。读取有固定字节上限，并检查读取期间文件是否变化。

文件沿用数据库所在部署目录下的 `artifacts/` 根目录，以真实类型确定后缀，拒绝符号链接根目录、非法 object key 和最终文件链接。独占创建避免覆盖已有文件，完整批次校验后才写文件；所有文件写入并同步成功后，在一个 SQLite 事务内登记。落盘失败清理本次文件，数据库失败回滚整批并清理文件；清理本身失败会明确返回错误而非成功结果。文件系统和 SQLite 无跨系统事务，进程被强制终止时仍可能遗留未登记文件，但不会先生成指向未写完图片的记录。

`packages/db/src/client.ts` 同步生成工具声明、脚本、平台 Skill 说明和 Chat systemPrompt。工具结果保留实际图片引用，不转换成快照引用。测试代码覆盖类型伪造、多图、限额、路径和链接、工作区隔离、并发写入、失败清理、prompt 和 Markdown 渲染；本次按执行器约束未运行测试或其他运行时验证。
