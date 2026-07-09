# Attachment Rework — Plan (v0.5.0-pre.15)

## 摘要

用户提供的 HAR 抓包证明我们对 Deck attachment API 的理解一直是错的。本 plan 阐述现状、给出**推荐方案**（对齐 Web UI 的行为，走正确的 OCS API），并列出为什么另一个"图床方案"暂不推荐。请求用户在开工前确认。

**不做代码修改，仅规划。**

---

## Phase 1: 现状分析（基于 HAR + 代码 review）

### HAR 关键证据（`nextcloud.jjefieonline.work.har`）

Web UI 上传附件的真实请求：

| 事件 | Method | URL | Body / Params |
| --- | --- | --- | --- |
| 列出附件 | `GET` | `/ocs/v2.php/apps/deck/api/v1.0/cards/{cardId}/attachments?boardId={id}` | — |
| 上传附件 | `POST` | `/ocs/v2.php/apps/deck/api/v1.0/cards/{cardId}/attachment?boardId={id}` | multipart: `cardId`, `type=file`, `file` |
| 响应 | 200 | — | `{"ocs":{"data":{"id":4, "cardId":11, "type":"file", "data":"filename.png", "extendedData":{"path":"/Deck/filename.png", "fileid":5210, "hasPreview":true, ...}}}}` |

**注意事项**：

1. **URL 前缀是 OCS API `/ocs/v2.php/apps/deck/api/v1.0`**，不是 `/index.php/apps/deck/api/v1.0`
2. **上传 URL 是 `cards/{id}/attachment`（单数）；获取是 `attachments`（复数）**
3. **`type=file`（Deck ≥ 1.3.0 新格式）**，不是 `deck_file`
4. body 里带 `cardId`，query 里带 `boardId`
5. 附件实际存储路径为 Nextcloud Files 的 `Deck/<filename>`（`extendedData.path`），全用户可见
6. 响应带 `hasPreview: true`，Deck Web UI 会渲染缩略图

### 当前插件代码的问题

**[src/deck-client.js](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/deck-client.js)**

- `uploadAttachment` 走 `/index.php/apps/deck/api/v1.0/boards/{b}/stacks/{s}/cards/{c}/attachments` + `type=deck_file`
- 这条路径可能是老版本 API（Deck < 1.3.0）遗留；在你的 Nextcloud 实例（新版）上要么返回 5xx，要么 fall through 到通用文件上传（导致"文件传上去了但 attachment 面板空"）
- `downloadAttachment` 走 `/index.php/apps/deck/cards/{id}/attachment/{aid}`，走的不是 API，是 web view 端点

**[src/attachment-sync.js](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/attachment-sync.js)**

- `pushCard` 扫本地 `<boardFolder>/attachments/<cardId>/` 目录 → 上传所有 loose 文件
- `pullCard` 目前**只把 remote attachments 列表元数据存到 `card.attachments[]`，不下载文件到本地 vault**
- Card `attachments` 数组格式：`{remoteId, filePath, filename, remoteUpdatedAt, contentType}`

**[src/modals.js#L1300](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/modals.js#L1300) `insertImageFromFile`**

- 粘贴/拖拽图片 → 保存到 `<boardFolder>/attachments/<filename>`（注意：**没有 cardId 子目录，与 attachment-sync 目录结构不匹配**）
- 插入 `![[<targetPath>]]` 到 card details

**[src/sync-manager.js#L498](file:///Users/victorsmith/Documents/trae_projects/task-deck/src/sync-manager.js#L498) `rewriteWikilinksForDeck`**（pre.11 引入）

- push 前把 details 里所有 `![[...]]` 匹配上传成功附件的替换为 **空字符串**
- 匹配不上的替换为 caption 文本
- 这是 "云端 description 里图片位置变成图片名字" 的根源 —— 用户看到的就是这里的 caption

### 三个观察结论

1. **附件上传从来没成功过**（Deck ≥ 1.3.0）：URL、type、参数全错。你看到的 "Nextcloud Files 里有图" 是 web UI 上传的，不是插件传的
2. **附件下载从来没做过**：`AttachmentSyncer.pullCard` 只记元数据，不写文件到 vault
3. **`rewriteWikilinksForDeck` 是错误尝试的副作用**：Deck description 的 CommonMark 渲染既不认 `![[…]]` 也很难渲染 `![](URL)`。这段代码需要移除

---

## Phase 2: 关于两个候选方案的确认

### 方案 A（用户想法 1）：图床方式，绕过 attachment 模块

**流程**：details 里的 `![[…]]` push 前 → WebDAV 上传到 Nextcloud Files 某目录 → 描述改为 `![](https://<server>/remote.php/dav/files/<user>/<path>)` 或 public share link

**风险 / 未知**：
- Deck description 的 markdown 渲染层能否加载**同源 http/https URL 图片**？pre.10 的经验表明相对路径（`/index.php/…`）被 CSP 拒。**绝对 https URL 有可能能加载**（Nextcloud Web UI 本身在同一 origin），但需要实测确认
- 即使能渲染，图片对**未登录访问者不可见**（除非用 public share），这在 Deck 板协作场景通常不成问题
- 与 Deck attachment 模块彻底解耦——从此附件不出现在 Deck 附件面板

**优点**：不需要碰 attachment API，简单

**缺点**：description 渲染能力**未知**，可能白干；协作用户看到的图片体验会脱离 Deck 原生 UX

### 方案 B（用户想法 2）：走正确的 attachment API

**流程**：
1. 用 HAR 里的正确 endpoint 上传：`POST /ocs/v2.php/apps/deck/api/v1.0/cards/{id}/attachment?boardId={b}`，`type=file`
2. Pull 时用正确的 GET 拉列表 + 下载文件到本地 vault
3. **移除 `rewriteWikilinksForDeck`**（description 干净地保留 `![[…]]`，本地渲染；Deck 上就是显示原始 `![[…]]` 文本，不影响附件在附件面板独立展示）
4. 本地 UI：卡片弹窗新增 "Attachments" 区域，显示 remote + local 的附件列表，点击预览/下载

**风险 / 未知**：
- OCS API 认证：`/ocs/v2.php/` endpoint 是否需要额外 header（比如 `OCS-APIRequest: true`）
- 关于**上传响应里 `data` 字段是文件名而非完整对象**，需要再 GET 一次列表拿完整元数据（可选）
- 目录结构：现有本地 `<boardFolder>/attachments/<cardId>/<filename>` 和 `insertImageFromFile` 使用的 `<boardFolder>/attachments/<filename>` 不一致，需要统一

**优点**：使用 Deck 官方设计，附件正常出现在 Deck 附件面板；描述保持干净，与 Web UI 用户体验一致

**缺点**：改动面较广（deck-client + attachment-sync + modals UI）

---

## Phase 3: 决策与实施计划

### 决策（等用户确认）

**推荐方案 B（走 attachment API）**，理由：

1. HAR 已给出精确的接口契约，风险已消除
2. 附件面板是 Deck 原生 UX，协作/移动端一致
3. `Description 里 ![[…]]`**留在本地正常渲染**，push 上去 Deck 显示为纯文本 `![[…]]` 也无伤大雅——反正真正的附件呈现在附件面板里
4. 保留未来实现"description 图床"作为**替代**方案（如果附件功能不够时再加）
5. 用户方案 A 的核心担忧（description 渲染 markdown 能力）在方案 B 里根本不再是问题

### 变更清单（方案 B）

#### 1) `src/deck-client.js`
- 新增 OCS API 前缀常量 `OCS_DECK_PREFIX = "/ocs/v2.php/apps/deck/api/v1.0"`
- 新增 `buildOcsUrl(path, query)` helper
- `buildHeaders` 里为 OCS 请求加 `OCS-APIRequest: true`，同时保持 `Accept: application/json`
- 重写 `uploadAttachment(cardId, boardId, {data, filename, mimeType})`：
  - POST `${OCS_PREFIX}/cards/{cardId}/attachment?boardId={boardId}`
  - multipart: `cardId={cardId}`, `type=file`, `file={binary}`
  - 响应格式 `{ocs:{data:{id, cardId, type, data, extendedData:{path, fileid, hasPreview, ...}}}}` → 解包返回 `data.ocs.data`
- 重写 `getAttachments(cardId, boardId)`：
  - GET `${OCS_PREFIX}/cards/{cardId}/attachments?boardId={boardId}`
  - 解包 `data.ocs.data`
- 重写 `deleteAttachment(cardId, boardId, attachmentId)`：
  - DELETE `${OCS_PREFIX}/cards/{cardId}/attachments/{attachmentId}?boardId={boardId}`（**GET 用复数，DELETE 也用复数——按 REST 惯例，upload 是单数的特例**）
- 重写 `downloadAttachment(cardId, attachmentId)`：
  - GET `${server}/index.php/apps/deck/cards/{cardId}/attachment/{attachmentId}` — 这个之前是对的，保留但确认（附件下载走 web endpoint 保持不变）

#### 2) `src/attachment-sync.js`
- `pushCard(client, card, board, list)`：
  - 参数简化：不再需要 `board.remoteId` / `list.remoteId`；OCS API 只要 `cardId` + `boardId` 两个 remote id
  - 扫描目录改成两个来源：
    - `<boardFolder>/attachments/<cardId>/<filename>` （历史目录）
    - **card details 里通过 `![[<boardFolder>/attachments/<filename>]]` 引用的文件**（新增：从 details 提取所有 wikilink target）
  - 只上传"card 引用了但 remote 上没有"的文件
- 新增 `pullCard(client, card, board, list)`：
  - GET `getAttachments` 拿列表
  - 对比 `card.attachments[]`，本地缺失的 → GET `downloadAttachment` 下载到 `<boardFolder>/attachments/<cardId>/<filename>` → 更新 `card.attachments`
- 保留删除孤儿逻辑（remote 上删了、本地 tombstone 也删了）

#### 3) `src/sync-manager.js`
- **移除 `rewriteWikilinksForDeck` 函数及所有调用点**
- pushCreate 里的"二次 update 用 rewritten description"整段删除
- pushUpdate 里的 `payload.description = rewriteWikilinksForDeck(...)` 一行删除
- description 直接 push 原始 details（包含 `![[…]]`），云端存的就是原始文本

#### 4) `src/modals.js` — 卡片弹窗附件区
- 在 details 编辑区**下方**新增 "Attachments" 折叠区（默认展开若有附件）
- 显示每张附件的 `filename`，缩略图（如果是图片），点击打开 / 下载
- 支持"删除附件"按钮 → 加入 pendingAttachmentDeletions + 从 details 里移除对应 `![[…]]`
- 顶部有 "+ Add attachment" 按钮，触发文件选择 → 走现有 `insertImageFromFile` 逻辑
- 目的：**让用户能看清一张卡上有哪些附件**（不管是 details 里引用的，还是 Deck 上单独附加的）

#### 5) `src/modals.js` `insertImageFromFile`
- 修改本地保存路径为 `<boardFolder>/attachments/<cardId>/<filename>`（加上 cardId 子目录，与 attachment-sync 的目录布局一致）
- 保留插入 `![[…]]` 到 details 的语法不变（本地 Obsidian 用它渲染 inline 图片）

#### 6) `src/plugin.js` `writeCardFile` / `parseCardMarkdown`
- **无需修改**：card details 里的 `![[…]]` 语法保持不变，本地 md 文件的 frontmatter 也不变
- attachment 只作为 card 数据 (`card.attachments[]`) 的一部分持久化到 data.json，不写进 md frontmatter（保持向后兼容）

### 断裂性变更

- 之前 pre.13 及以下版本上传的"游离文件"（存在 Nextcloud Files 但没被 attachment 面板收录）**不会被自动清理** —— plan 里不做清理，因为无从判断哪些是插件传的。用户手动删。
- data.cards 里 `card.attachments[].remoteId` 值格式一致（数字），无需迁移

### 假设

- **Deck 后端版本 ≥ 1.3.0**（用户实例已确认）
- OCS API 用当前 App Password 认证方式（Basic auth）能通过；如通过不了，需在 header 加 `OCS-APIRequest: true`（HAR 里没显式看到但可能是浏览器自动加的）
- 本地 `<boardFolder>/attachments/<cardId>/<filename>` 目录布局适合所有 board

---

## Phase 4: 验证步骤

实施后按以下顺序测试：

1. **Endpoint 联通性**
   - `getAttachments(11, 1)` → 应返回 HAR 里那样的数组（可能是空数组 `data: []`）
   - `uploadAttachment(11, 1, {…})` → 应返回 `{id, cardId, type:"file", data:"filename", extendedData:{...}}`

2. **本地→云端**
   - 新卡片粘贴一张图 → 保存到 `<boardFolder>/attachments/<cardId>/xxx.png`
   - Sync → 云端卡片附件面板应出现该图
   - 云端 description 里保留 `![[<boardFolder>/attachments/<cardId>/xxx.png]]` 纯文本（Deck 显示为文字而非 img，可接受）

3. **云端→本地**
   - Web UI 上给卡片加一张附件
   - Sync → 本地 vault `<boardFolder>/attachments/<cardId>/xxx.png` 出现该文件
   - `card.attachments[]` 里有对应条目
   - **卡片弹窗**里能看到该附件

4. **删除双向**
   - 本地删除文件 + sync → 云端附件面板消失
   - 云端删除附件 + sync → 本地 vault 里对应文件被移除

5. **数据完整性**
   - description 里的 `![[…]]` 语法 push → 云端保留原始文本
   - pull 回来 → 本地 md 文件里 `![[…]]` 仍能正常渲染
   - 不再有"图片位置变成图片名字"现象

---

## 需要用户拍板的问题

1. 确认走**方案 B**（走 attachment API）而不是方案 A（图床）？如仍想尝试方案 A，需先手动测试 Deck description 能否加载 `https://` 图片，才能立项
2. 卡片弹窗新增的"Attachments"区域的具体位置和交互（先做最基本的：列表 + 缩略图 + 删除按钮）是否合适？如需更复杂（拖拽排序、批量上传等）请说明
3. 是否需要保留 pre.13 的 `card.attachments[]` 数据结构（我倾向于保留，只改 sync 逻辑）？
