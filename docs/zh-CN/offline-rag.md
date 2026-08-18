# 离线 RAG 与紧急语料库

WebBrain 的离线检索增强生成（RAG）流水线允许扩展在没有任何网络连接的情况下，使用本地存储的参考材料回答问题。它建立在末日模式（Apocalypse Mode）的 Wikipedia 存档之上，并新增了紧急语料库（Emergency Box）文本集合——一份涵盖医疗、生存、教育和通信领域公共领域参考文档的精选合集。

## 新增功能

- **紧急语料库文本集。** 一份经过验证的约 502 MB ZIP 文件，包含约 570 份公共领域纯文本文档（约 304 MB 源文本），从 `webbrain-one/emergency-box-corpus` 仓库分发。文档为多种语言的 PDF 衍生参考资料。
- **离线全文搜索。** 跨 Wikipedia 存档和紧急语料库的 SQLite FTS5 BM25 搜索。FTS5 数据库已预构建并随语料库 ZIP 一起分发，浏览器无需自行构建。
- **语义向量搜索。** 可选的 int8 量化多语言 E5 模型（`Xenova/multilingual-e5-small`，约 140 MB 下载），在同样预计算并随 ZIP 分发的段落嵌入上提供余弦相似度向量搜索。
- **E5 重排序。** 当预构建向量索引对某个源不可用时，可使用同一 E5 模型在设备上对 BM25 候选结果进行重排序。
- **倒数排名融合。** 词汇和语义结果通过倒数排名融合进行合并，然后进行多样化处理以限制冗余（最多 8 个段落，每个文档最多 2 个）。
- **本地引用阅读器。** 每条引用都会打开一个本地阅读器页面，该页面会重新计算源文档的哈希值以验证完整性，然后显示段落。紧急语料库的引用使用 `emergency-text.html`；Wikipedia 的引用使用 `wikipedia-reader.html`。没有任何引用会导航到在线网页。
- **RAG 就绪仪表板。** 末日模式和侧面板中的新型 4 格状态网格，独立显示 Wikipedia 搜索、紧急库搜索、语义排序和本地答案生成的就绪状态。
- **源和语言过滤器。** 复选框允许你将检索限制在特定的已安装源和语言。过滤器在会话之间保持。
- **事务性语料库更新。** 先前的语料库保持活跃，直到每个文档校验和与索引都得到验证。原子激活意味着失败的更新永远不会让你失去可用的语料库。

## 技术架构

### 架构

```
agent.js（service worker）
  → offline-retrieval-offscreen.js（MV3 代理）
    → offscreen/offline-rag-host.js（offscreen 文档，拥有检索服务）
      → offline-rag-index.js（主线程 FTS5 + 向量客户端）
        → offline-rag-worker.js（专用 Web Worker，拥有 SQLite Wasm + OPFS SAH 池）
```

Offscreen 文档还托管 E5 重排序 worker（`offline-reranker-worker.js`）。分层代理模式的存在是因为 Chrome MV3 service worker 无法持有 OPFS 同步访问句柄。

### 核心模块

| 模块 | 用途 |
| --- | --- |
| `offline-rag.js` | 浏览器无关的基础原语：分块、分词、引用标记、证据组装、倒数排名融合、多样性选择 |
| `offline-rag-index.js` | FTS5 模式定义、向量索引二进制格式（`WBVE5Q8`）、查询构建器、结果归一化 |
| `offline-rag-worker.js` | 拥有 SQLite Wasm 运行时和 OPFS SAH 池的专用 Web Worker。处理索引构建、FTS5 搜索、int8 向量上的暴力余弦相似度计算 |
| `offline-rag-prompt.js` | 受信提示策略桥接：组装证据、构建带有 `readerUrl` 的引用引用对象 |
| `offline-retrieval.js` | 编排 Wikipedia 词汇搜索 + 紧急词汇搜索 + 紧急向量搜索 + 语义重排序，然后融合和多样化 |
| `offline-reranker.js` | E5 重排序 worker 的客户端。模型下载/暂停/停止、查询嵌入、候选重排序 |
| `emergency-corpus.js` | 事务性生命周期：可恢复的 HTTP Range 下载、SHA-256 验证、清单驱动的提取、OPFS 存储、Web Lock 协调 |
| `emergency-corpus-release.js` | 版本指针：当前语料库的固定 URL、SHA-256、字节数、段落数 |
| `zim-xapian.js` | 许可证门控适配器，用于 Wikipedia ZIM 全文搜索（当前因 GPL 决策而阻塞） |

### 存储布局

- **OPFS**（Origin Private File System）：
  - `.webbrain-offline-rag-sahpool-v1/` — SQLite SAH 池目录
  - `webbrain-offline-rag/emergency-box-text/downloads/` 和 `installs/` — 紧急语料库文件
- **IndexedDB**（`webbrain_offline_rag`）：语料库生命周期状态、活跃版本、清单、安装 ID、索引路径、向量索引声明
- **遗留段落向量缓存**：上限 256 MB

### FTS5 模式

```sql
CREATE VIRTUAL TABLE passages USING fts5(
  passage_id UNINDEXED, document_id UNINDEXED, source_id UNINDEXED,
  title, language UNINDEXED, collection, source UNINDEXED, license UNINDEXED,
  locator, body, search_terms,
  passage_sha256 UNINDEXED, token_estimate UNINDEXED, ordinal UNINDEXED,
  reader_url UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

BM25 评分权重：`body` 7、`search_terms` 1、`locator` 0.6、`collection` 2、`title` 4。

### 向量索引格式

带 `WBVE5Q8` 魔术头的自定义二进制格式：
- 4096 字节头部，包含 JSON 元数据（模型 ID、修订版、数据类型、段落数、维度）
- int8 量化的段落向量（每个 384 维）
- Float32 L2 范数用于余弦相似度
- Worker 中的暴力余弦相似度计算（251K 段落是可行的）

### 段落分块

文档被分割为 180–700 个 token 的段落（目标约 420）：
1. 按换行符分割为段落
2. 检测标题（markdown `#`、`Chapter` 等模式、编号章节、全大写行）
3. 按句子边界分割过大的段落
4. 合并相邻的小段落直至达到目标 token 数
5. 每个段落获得基于文档 + 定位符 + 内容哈希的确定性 `passageId`

### 检索模式

| 模式 | 描述 |
| --- | --- |
| `hybrid-full-vector` | 直接使用预构建的 E5 向量（紧急语料库） |
| `semantic-reranked` | 对 BM25 候选使用 E5 重排序 |
| `lexical-fallback` | 仅 BM25（无 E5 模型可用） |

### 优雅降级

- 无 E5：回退到 BM25 词汇搜索
- 无紧急语料库：仅搜索 Wikipedia 源
- 两者都没有：报告离线搜索不可用
- Xapian Wikipedia 全文搜索：因 GPL 许可证决策而阻塞；仅标题搜索仍然可用

## 供应商库

所有供应商库均以 vendored 文件形式提交。不进行运行时可执行代码获取。仅模型权重和语料库数据由用户下载。

| 库 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| fflate | 0.8.3 | MIT | 流式 ZIP 解压 |
| SQLite Wasm | 3.53.0-build1 | Apache-2.0 | FTS5 全文搜索引擎 |
| Transformers.js | 4.2.0 | Apache-2.0 | E5 推理运行时 |
| ONNX Runtime Web | 1.27.0 | MIT | WASM/GPU 推理后端 |
| E5 模型 | multilingual-e5-small q8 | Apache-2.0 | 语义嵌入（单独下载） |

## 许可证

紧急语料库、SQLite、fflate 和 Transformers.js 均为宽松许可证，不影响 WebBrain 的 MIT 许可证。

Xapian/libzim Wikipedia 全文运行时是另一个问题。详见 [offline-rag-licensing.md](offline-rag-licensing.md)，了解仓库所有者在打包该运行时之前必须做出的完整分析和三个选项。

## 延伸阅读

- [末日模式](apocalypse-mode.md) — Wikipedia 存档管理
- [离线 RAG 许可证](offline-rag-licensing.md) — GPL 决策记录
- [发布检查清单](offline-rag-release-checklist.md) — 验证关卡和测量
