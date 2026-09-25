# event-window-replay-web

事件窗口回放应用：在实时聚合之外，为每个事件窗口维护可恢复的版本游标，
可回到某次窗口提交前后的状态，查看当时已确认的数据、仍在等待的数据，
以及后来才到达（迟到）的事件。

## 启动

```bash
npm start          # 默认 http://localhost:4174，日志 data/event-window.log
PORT=4000 npm start
LOG_FILE=/path/to/store.log npm start
npm test
```

仍使用原有的 `node server.mjs` 启动方式，状态以 JSONL 追加日志持久化，
重启后事件、提交点和游标全部重放恢复。

## 概念

- **版本（version）**：每次向窗口写入事件产生一个不可变版本，含当时的事件集合快照。
- **提交（commit）**：`POST /api/windows/:window/commit` 把窗口头部版本标记为
  已确认水位。提交之后再到达的事件记为**迟到**，旧提交置为 `superseded`，
  窗口进入 `recalculated`，直到再次提交。
- **游标（cursor）**：绑定「窗口 + 版本 + 名称」，可随时恢复。被重算的游标
  仍可读取历史（`stale: true`），但任何回放路径都不会把旧结果写回实时状态。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/events` | 写入事件（重复 id 幂等，不产生新版本） |
| GET | `/api/windows` | 实时视图：窗口状态、已确认/等待事件、全部版本、游标 |
| GET | `/api/versions/:v` | 读取单个版本的冻结事件集（原有接口） |
| POST | `/api/windows/:window/commit` | 提交窗口水位（无新数据时为 no-op） |
| GET | `/api/replay?window=&version=` | 回放视图：confirmed / waiting / later 三桶及时间线 |
| POST/GET | `/api/cursors`、`/api/cursors/:id` | 保存 / 列出 / 恢复游标 |

游标或版本不存在返回 404；游标版本属于其他窗口返回 409。

## 浏览器

打开 `/`：顶部切换窗口与实时/回放，拖动版本时间线回到任意版本；
回放期间实时视图继续轮询，新写入的事件不会丢失，会出现在「后来才到达」
桶里并在回到实时时可见。窗口选择、事件选中、折叠状态通过 URL hash 与
localStorage 跨版本切换保持。
