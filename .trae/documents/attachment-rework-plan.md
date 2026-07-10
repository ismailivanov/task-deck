# Attachment Rework — Plan (v0.5.0-pre.16+)

## 摘要

用户提供的 HAR 抓包证明我们对 Deck attachment API 的理解一直是错的。
经与用户讨论，最终确定走 **方案 1（双向语法转换）** + 使用正确的 OCS attachment API。

**决策链**：
1. Deck 的 CommonMark 渲染器：`![[…]]` 不认，`![](https://外链)` 因 CSP 被屏蔽，`[…](https://server/f/{fileid} (preview))` **是 Deck 私有的附件预览语法** ← 目标语法
2. Obsidian 只识别 `![[…]]` 或 `![](file://…)` 类语法作 inline 图
3. **push/pull 时做双向转换**：本地 wikilink ↔ Deck 内部附件预览语法

---

## Phase 1: 现状分析

### HAR 关键证据（`nextcloud.jjefieonline.work.har`）

| 事件 | Method | URL | Body / Params |
| --- | --- | --- | --- |
| 列附件 | `GET` | `/ocs/v2.php/apps/deck/api/v1.0/cards/{cardId}/attachments?boardId={id}` | — |
| 传附件 | `POST` | `/ocs/v2.php/apps/deck/api/v1.0/cards/{cardId}/attachment?boardId={id}` | multipart: `cardId`, `type=file`, `file` |
| 响应结构 | 200 | — | `{ocs:{data:{id, cardId, type:"file", data:"filename", extendedData:{path:"/Deck/xxx.png", fileid:5210, hasPreview:true, ...}}}}` |
| Description 里引用 | — | — | `[filename](https://server/f/{fileid} (preview))` |

关键字段：
- `id` 是 Deck attachment id
- `extendedData.fileid` 是 Nextcloud Files 的 file id（**这才是构造 URL 用的**）
- `extendedData.path` 是 Files 里的绝对路径
- `extendedData.hasPreview` 决定能否 `(preview)`

### 当前代码状态（截至 pre.15）

- `deck-client.js` uploadAttachment 用错的 URL（`/index.php/…/boards/…/stacks/…/cards/…/attachments` + `type=deck_file`）
- `attachment-sync.js` pullCard 只记元数据不下载
- `insertImageFromFile` 保存到 `<board.folderPath>/attachments/<filename>`（无 cardId 子目录）
- pre.15 已移除 `rewriteWikilinksForDeck`——描述现在原样传输

---

## Phase 2: 决策

### ✅ 方案 1（双向语法转换）+ OCS API

**用户书写**：只写 Obsidian 语法 `![[<boardFolder>/attachments/<cardId>/foo.png]]`

**本地存储**：md 文件 + data.json 都保存 Obsidian 语法（**权威源**）

**Push 前转换**（不修改本地）：
```
![[<boardFolder>/attachments/<cardId>/foo.png]]
  ↓  attachment-sync 已把此文件上传，card.attachments 里有 {filePath, fileid}
  ↓
[foo.png](https://server/f/5210 (preview))
```
然后把这个转换后的 description 作为 payload.description PUT/POST 到 Deck。**本地文件 / data.json 里的 details 字段永不变**（避免 pre.11 的"污染"）。

**Pull 后转换**（改变 data.json）：
```
[foo.png](https://server/f/5210 (preview))
  ↓  查 card.attachments 里 fileid=5210 对应的 filePath
  ↓
![[<matched.filePath>]]
```

写盘时用转换后的形式，Obsidian 才能 inline 渲染。

**转换失败时的红线**：**保持原文不动**。宁可两边显示不同，也不覆盖用户内容。

### 外部 URL（如 apeuni CDN）
不进行"自动图床化"——保持原文本，Deck 侧可能显示为纯文本 URL，Obsidian 端仍能 inline 渲染 wikilink。这是可接受的降级。

### 关于 details / description 里手动写的 markdown link `[text](url)`
- 只有在 URL 匹配 `https://<serverUrl>/f/<fileid>` 且 title 是 `(preview)` 才会被 pull 反向转成 wikilink
- 其他形式一律不动

---

## Phase 3: 变更清单

### 1) `src/deck-client.js`

**新增 OCS 请求路径 helper**

```js
const OCS_DECK_PREFIX = "/ocs/v2.php/apps/deck/api/v1.0";
buildOcsUrl(path, query) { … }
```

**buildHeaders 里加 `OCS-APIRequest: true`**（OCS 要求，HAR 里浏览器自动附加）

**重写 `uploadAttachment(cardId, boardId, {data, filename, mimeType})`**
- POST `${OCS}/cards/{cardId}/attachment?boardId={boardId}`
- multipart 字段：`cardId=<cardId>`, `type=file`, `file=<binary>`
- 响应解包：`response.data.ocs.data` → 返回 `{id, cardId, type, data, extendedData:{fileid, path, hasPreview, mimetype, filesize}}`

**重写 `getAttachments(cardId, boardId)`**
- GET `${OCS}/cards/{cardId}/attachments?boardId={boardId}`
- 响应解包同上

**重写 `deleteAttachment(cardId, boardId, attachmentId)`**
- DELETE `${OCS}/cards/{cardId}/attachments/{attachmentId}?boardId={boardId}`

**保留 `downloadAttachment`**
- 通过 fileid 用 WebDAV 或者 `/apps/files/api/v1/download` 拉；先尝试 `${server}/index.php/apps/files/ajax/download.php?dir=/Deck&files={filename}` 或简单方式 `${server}/remote.php/dav/files/{user}/{path}`

### 2) `src/attachment-sync.js`

**重写 `pushCard(client, card, board, list)`**
- 从**两个源**收集本地文件：
  - `<board.folderPath>/attachments/<cardId>/*`（历史目录）
  - `card.details` 里所有 `![[…]]` 提取的 vault-relative 路径
- 已在 `card.attachments[]` 里且 `remoteId != null` 的文件跳过
- 剩下的文件调用 `client.uploadAttachment(card.remoteId, board.remoteId, {…})`
- 响应里带 `extendedData.fileid` → 存到 `card.attachments[]`：
  ```
  {remoteId: response.id, fileid: response.extendedData.fileid,
   filePath, filename, mimeType, remoteUpdatedAt, contentType}
  ```
- **参数简化**：`list` 不再需要（OCS API 不要 stack id）

**新增 `pullCard(client, card, board, list)`**
- GET `client.getAttachments(card.remoteId, board.remoteId)` 拿 remote 列表
- 对比 `card.attachments[]`：
  - Remote 有 + local 无 → 下载文件到 `<board.folderPath>/attachments/<card.id>/<filename>`；追加到 `card.attachments`
  - Remote 无 + local 有 → 从 `card.attachments` 剔除（本地文件保留，如果 details 里引用了，wikilink 会照常工作）
  - 都有 → 更新 `remoteUpdatedAt` / `fileid`（可能是 remote rename 后）

**保留 `reap` 处理 pendingAttachmentDeletions**（endpoint 更新为 OCS 的 DELETE）

### 3) `src/sync-mapper.js`

**新增两个转换函数**（纯函数、可测）：

```js
// Local → Deck (push 前)
function localDescriptionToDeck(details, card, serverUrl) {
  // 遍历 ![[…]] 匹配 card.attachments 里 filePath 相同的项
  // 找到 → 替换为 [filename](https://server/f/{fileid} (preview))
  // 找不到 → 保持原字符不动（外链或未上传的文件）
}

// Deck → Local (pull 后)
function deckDescriptionToLocal(description, card, serverUrl) {
  // 遍历 [caption](https://server/f/{fileid} (preview))
  // 查 card.attachments 里 fileid 相同 → 替换为 ![[<filePath>]]
  // 找不到 → 保持原字符不动
}
```

- 用严格正则（`(!?)\[([^\]]*)\]\(([^)]+?)\s*\(preview\)\)` for Deck 形式）
- 单元测试覆盖：
  - 转换成功往返
  - 转换失败保持原文
  - 外链 `https://cdn.example.com/foo.png` 不被误伤
  - Deck 侧非 preview 链接不被误伤

### 4) `src/sync-manager.js`

**pushCreate / pushUpdate**：
```js
const serverUrl = this.plugin.data.nextcloud.serverUrl;
const payload = localCardToDeckPatch(card, {…});
// 附件先传 (走 attachments.pushCard)，确保 card.attachments 里的 fileid 就绪
await this.attachments.pushCard(client, card, localBoard);
// 转换 details → deck description
payload.description = localDescriptionToDeck(payload.description, card, serverUrl);
// 现在 POST/PUT
```

**pullCards**：
```js
// 现有逻辑：mergeRemoteCardOntoLocal 生成 merged.details = remote.description
// 追加：先运行 attachments.pullCard 拿到 fileid → filePath 映射
// 然后 merged.details = deckDescriptionToLocal(merged.details, merged, serverUrl)
```

顺序：**先 attachments.pullCard 保证映射就绪，再做 description 反向转换**

### 5) `src/modals.js` — `insertImageFromFile`

- 改保存路径：`<board.folderPath>/attachments/<cardId>/<filename>`（加 cardId 子目录，与 attachment-sync 对齐）
- 保留 `![[<targetPath>]]` 语法不变
- 保存后**不需要立即修改** `card.attachments`；这由 attachment-sync 下次 pushCard 时扫描目录 + details 发现新文件后处理

### 6) `src/plugin.js`

**写盘（writeCardFile）**：card.details 里已经是 Obsidian 语法（本地权威源），无需转换

**读盘（parseCardMarkdown）**：同上

**syncCardsFromFolder / 30s scanner**：无需变动，本身就是本地文件系统的调解

---

## 断裂性变更 / 迁移

- 之前 pre.13-14 里 `card.attachments[]` 用 `remoteId` 但没 `fileid`。第一次 pull 后新的 `getAttachments` 响应会带 `fileid`，会补齐
- description 里如果之前被 `rewriteWikilinksForDeck` 污染成裸文件名（比如 "foo.png"），pull 后仍然是裸文件名，不会被 `deckDescriptionToLocal` 认（因为不是 `[…](https://…/f/… (preview))` 形式）→ 用户需要手动修回 `![[…]]`

---

## Phase 4: 验证步骤

按顺序：

1. **API 联通性**（在 mock-nextcloud.js 或真实实例）
   - `getAttachments(11, 1)` 返回 `[{id, extendedData:{fileid, path}}, ...]`
   - `uploadAttachment(11, 1, {data:<png>, filename:"test.png", mimeType:"image/png"})` 返回 `{id, extendedData:{fileid, path, hasPreview:true}}`

2. **单元测试**（scripts/test-sync-units.js）
   - `localDescriptionToDeck` 转换成功案例
   - `localDescriptionToDeck` 匹配失败保持原文
   - `deckDescriptionToLocal` 反向转换成功
   - `deckDescriptionToLocal` 非 preview 链接不被误伤

3. **端到端 push 图片**
   - 卡片粘贴图 → md 里存 `![[<board>/attachments/<cardId>/foo.png]]`
   - Sync now → attachments.pushCard 上传（应看到 push.upload.response 里带 fileid）
   - 云端 description 里应显示为 `[foo.png](https://server/f/{fileid} (preview))`
   - Deck web UI 应 inline 渲染缩略图

4. **端到端 pull 图片**
   - Web UI 给卡加图（description 里由 Deck 自动生成 `[…](…/f/… (preview))`）
   - Sync now → attachments.pullCard 下载 → card.attachments 更新 → deckDescriptionToLocal 转换
   - 本地 md 里 details 应为 `![[<board>/attachments/<cardId>/xxx.png]]`
   - Obsidian 编辑器里 inline 显示

5. **外链保持**
   - description 里放 `![[https://apeuni.com/logo.png]]`
   - push → Deck 保存原文
   - pull → 本地保存原文

6. **删除双向**
   - 本地 delete 文件 → 加 tombstone → sync 后 Deck 附件消失
   - Deck 删附件 → pull 后 card.attachments 移除对应条目（本地文件保留）

7. **同一附件多次引用**（可选）
   - details 里两次 `![[…]]` 同一 filePath → push 应只上传一次 → 两处 wikilink 都转成同一 fileid 的 preview link

---

## 假设

- Deck ≥ 1.3.0（用户实例已确认）
- Nextcloud Files 的 `/f/{fileid}` 短链能被 Deck markdown 渲染成缩略图（HAR 已证）
- OCS API 用 App Password Basic Auth 能通过；如需要额外 header 加 `OCS-APIRequest: true`
