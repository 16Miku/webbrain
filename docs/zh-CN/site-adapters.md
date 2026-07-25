# 站点适配器 —— 如何编写

站点适配器是**最受欢迎的贡献类型第一名**（参见 CONTRIBUTING.md）。它们在代理首次在已知站点上操作时，将简短、人工精选的指导注入到代理的首条消息中。目标不是编码每个选择器（那些腐烂得很快），而是捕捉那些非显而易见的怪癖——这些怪癖会让 LLM 花费数次徒劳的工具调用来自行发现。

---

## 工作原理

### 文件

`src/chrome/src/agent/adapters.js`（以及 `src/firefox/src/agent/adapters.js`——两个构建共享相同的文件内容，修改需同步到两者）。

### 匹配

`getActiveAdapter(url)` 遍历 `ADAPTERS` 数组，返回第一个 `match(url)` 返回 `true` 的适配器：

```js
export function getActiveAdapter(url) {
  if (!url) return null;
  for (const a of ADAPTERS) {
    try {
      if (a.match(url)) return a;
    } catch (e) { /* 跳过格式错误的匹配器 */ }
  }
  return null;
}
```

一次只有一个适配器触发，因此无论适配器总数多少，提示词成本都是固定的。

对于 Mastodon 等联邦平台，请保持通用 URL 形状保守。
裸的 `/@user` 和 `/users/user` 路径出现在许多非 Mastodon 的站点上，
而当前的适配器匹配器只看到 URL 字符串。未来的工作可能会集成
[`instances.social`](https://instances.social/api/doc/) 作为基于技能的查找
或维护的已知实例列表，以便在更广泛地注入 Mastodon 指导之前验证候选主机。

### 注入时机

- **首轮**：适配器的 `notes` 在 `_enrichUserMessageWithCurrentPage()` 中被追加到第一条用户消息。
- **对话中导航**：如果用户导航到匹配不同适配器的 URL，代理会注入一条 `[Site context changed → now on <name>]` 消息。由 `_maybeReinjectAdapter()` 控制。

### 通用前言

`UNIVERSAL_PREAMBLE` 在启用 `useSiteAdapters` 时随每条系统提示一起注入。它涵盖 cookie/同意横幅和付费墙——这两种模式出现在公共网络上，会导致 LLM 做出错误的假设。

---

## 适配器格式

```js
{
  name: 'my-site',          // 唯一短标识符
  category: 'general',       // 'general' | 'finance'
  match: (url) => /^https?:\/\/(www\.)?example\.com\//.test(url),
  notes: `
- 要点 1：可操作的建议。
- 要点 2：另一个建议。
- 保持简短（最多 4–8 条要点）。每个适配器在每轮首轮对话中都会消耗令牌。
`,
}
```

### 字段

| 字段 | 类型 | 描述 |
|---|---|---|
| `name` | string | 适配器的唯一标识符。用于系统提示的标题。 |
| `category` | `'general'` 或 `'finance'` | `'finance'` 会在标题中添加 `[FINANCE / HIGH-STAKES]` 横幅，并在系统提示中触发额外的安全指导。 |
| `match` | `(url) => boolean` | 当适配器应为该 URL 触发时返回 `true`。推荐使用正则表达式——保持足够具体以避免错误匹配。 |
| `notes` | string | 注入到第一条用户消息中的要点式指导。**最多保持 4–8 行。** 参见下面的风格指南。 |

### 排序

适配器在 `ADAPTERS` 数组中按分类/站点排序。**金融适配器必须放在 `finance-generic` 之前**，因为 `finance-generic` 使用宽泛的正则表达式会遮蔽特定的适配器。当前顺序：Stripe → Coinbase → Robinhood → TradingView → finance-generic。

---

## 编写有效的 Notes

### 应该做的

- **描述页面的结构**而不是文字选择器。选择器会腐烂；页面布局模式更稳定。
  ```js
  // 好
  notes: `- 编辑器是一个 contenteditable div，而不是 textarea。`
  // 差
  notes: `- 点击 div[contenteditable="true"] 来编辑。`
  ```
- **指明要优先使用的工具**：引导使用 AX 工具（`click_ax`、`set_field`）而非旧工具（`click({text})`、`type_text`）。
- **标记破坏性的细微之处**："账单页面上的'取消'按钮会立即停止服务——请阅读确认弹窗。"
- **标记 SPA 导航陷阱**："设置更改会自动保存；通过浏览器后退导航会丢弃未保存的编辑。"
- **标记粘性覆盖层**："Cookie 横幅每 24 小时重新出现。不要将其文本描述为页面内容。"
- **标记虚拟化容器**："时间线是虚拟化的——滚动以加载更多内容。"
- **每条要点保持一个可操作的建议**。模型的上下文有限，会快速浏览。

### 不应该做的

- **不要编码 CSS 选择器**——它们在每次站点重新设计时都会变化。
- **不要写超过 8 条要点**——令牌成本会在每次对话中累积。
- **不要包含模型通过阅读页面就能弄清楚的明显建议**（例如，"提交按钮提交表单"）。
- **不要重复通用前言**（cookie/付费墙指导）。
- **不要添加字母表或参考适配器**——每个适配器必须提供真正的指导，能为模型节省至少 2–3 次试错工具调用。

### 示例：好的适配器

```js
{
  name: 'twitter',
  category: 'general',
  match: (url) => /^https?:\/\/(www\.)?(twitter\.com|x\.com)\//.test(url),
  notes: `
- 编辑器是一个 contenteditable，而不是 textarea。字符数由客户端强制限制。
- 时间线是虚拟化的——推文会滚动出 DOM。使用搜索而不是滚动来查找推文。
- "回复"、"转推"、"喜欢"图标位于每条推文下方。
- 引用推文 vs 转发：转推图标会打开一个包含两个选项的菜单。
`,
}
```

### 示例：金融适配器

```js
{
  name: 'stripe',
  category: 'finance',
  match: (url) => /^https?:\/\/(dashboard\.)?stripe\.com\//.test(url),
  notes: `
- LIVE 与 TEST 模式切换在右上角。始终确认当前模式。
- 退款默认为部分退款——请仔细检查金额。
- 删除客户是不可逆的。
- 订阅：按比例计算的提示（"立即收取按比例计算的金额" vs "在下一张发票上"）。
`,
}
```

---

## 测试适配器

1. **添加适配器**到 `src/chrome/src/agent/adapters.js` 和 `src/firefox/src/agent/adapters.js`。
2. **验证匹配**：在加载了扩展的浏览器中导航到目标 URL。打开服务工作线程/后台页面的 DevTools 控制台并运行：
   ```js
   import { getActiveAdapter, listAdapters } from './agent/adapters.js';
   console.log(getActiveAdapter('https://example.com/some-page'));
   ```
3. **验证 notes 出现**：在 Ask、Act 或 Dev 模式下，输入一个简单的指令（例如，"这个页面上有什么？"）。打开侧面板的详细模式，确认第一条用户消息包含带有你的 notes 的 `[Site guidance for <name>]`。
4. **验证只有一个适配器触发**：导航到一个可能匹配多个匹配器的 URL。检查第一个匹配是否胜出且没有其他匹配泄漏。
5. **测试导航重新注入**：在一个非适配站点上开始对话，然后导航到你的适配站点。确认出现 `[Site context changed]` 消息。

### 手动测试 URL

打开每个适配站点并验证：
- 适配器在页面 1 上加载（不是在 SPA 路由变化时）
- notes 有用（不会误导模型）
- 模型不会遵循过时的指令

---

## 添加新适配器的检查清单

- [ ] 将适配器对象添加到 `src/chrome/src/agent/adapters.js` 的 `ADAPTERS` 数组中
- [ ] 将完全相同的更改同步到 `src/firefox/src/agent/adapters.js`
- [ ] 确保 `match()` 正则表达式具体且不会遮蔽相邻的适配器
- [ ] 如果 `category: 'finance'`，将其放在数组中 `finance-generic` 之前
- [ ] 验证 notes 是 4–8 条简洁的要点
- [ ] 使用 `getActiveAdapter(url)` 测试匹配
- [ ] 在加载了扩展的情况下测试端到端
- [ ] 如果适配器针对非英语市场，添加本地化标签提示（参见 WordPress 适配器了解如何注释非英语 UI 标签的示例）
