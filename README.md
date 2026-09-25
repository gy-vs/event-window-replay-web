# event-window-replay-web

事件窗口回放应用，支持可恢复的版本游标：拖动时间线游标可以回到某个窗口提交前的状态，
查看当时已确认的结果、仍在等待的数据和后来才到达的事件，而不是把数据库里的最终值重新渲染一遍。

## 启动 / 测试（沿用原有入口，无额外控制台）

```bash
npm start   # node server.mjs，默认端口 4174
npm test    # node --test
```

状态持久化在 `data/event-window-log.json`（可用 `EVENT_WINDOW_DATA_FILE` 覆盖路径、
`PORT` 覆盖端口），采用临时文件 + 原子改名写入，服务重启后事件、窗口版本与游标全部恢复。

## 模型

- **事件**带 `arrivedSeq`（到达序列），按 `eventTime` 排序存储。
- 窗口初始为 `open`（事件处于等待）；`POST /api/windows/advance` 提交后产生
  `commit` 版本，窗口关闭并冻结快照。
- 已关闭窗口再收到事件即为**迟到**：事件标记 `late`，并立即产生一个 `recompute`
  版本；旧版本快照仍可读取，且被标记 `supersededBy`。
- **游标**绑定具体窗口 + 版本 + 序列位置（`atSeq`，`version.seq - 1` 即提交前）。
  旧版本被重算后，游标历史可读，但 `restore` 返回 `409 STALE_CURSOR`，
  任何历史结果都不会覆盖当前状态。

## 接口

保留原有接口与响应形状：

- `POST /api/events` 写入事件（重复 id 幂等，不推进序列）
- `GET /api/windows` 当前窗口 + 全部版本
- `GET /api/versions/:n` 读取某个版本的历史快照
- `GET /`（`accept: application/json`）旧版服务信息 JSON

新增：

- `POST /api/windows/advance` `{window}` 提交窗口
- `GET /api/timeline` 到达/提交交错的有序时间线
- `GET /api/views?window=…&atSeq=…` 某位置视图：`confirmed` / `waiting` / `later`
- `POST /api/cursors` `{version, atSeq?, label?}` 保存游标（默认锚定提交点）
- `GET /api/cursors` / `GET /api/cursors/:id` 游标及其历史视图
- `POST /api/cursors/:id/restore` 恢复回放（过期返回 409）
- `DELETE /api/cursors/:id` 删除游标

## 浏览器

左侧是实时窗口视图（回放期间继续接收新写入），右侧是版本时间线、游标滑块、
回放视图（已确认 / 等待中 / 后来到达三组）和服务端持久化的游标列表。
窗口折叠状态和事件选中状态跨版本切换保持一致；返回实时视图不会丢失回放期间的新事件。
