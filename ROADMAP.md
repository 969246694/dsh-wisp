# 更新方案（v1.0.0 —— 已实施）

> 实施结果：**全部完成** —— P0-2 / P1-1 / P1-2 落地；P0-1 做过又按用户决定撤掉；
> P2-1（attn 专属精灵图）在上游恢复后补上，见 v1.1.0。
> 预检 198 项、真实浏览器冒烟 24 项全过，包 1740 KB。
>
> **P0-1 撤销的原因值得记下**：面板技术上可行且验证通过，但与右键菜单重叠过大 ——
> 大小 / 皮肤 / 位置 / 可见性菜单都有，净增量只有三个开关。方案里"所有配置只有 YAML 与
> Console 两个入口"这句是**错的**，当时菜单已经覆盖了大部分。教训：写方案时要先清点现有
> 入口，别把"我以为没有"当成"没有"。

> 制定于 v0.12.0。每条结论都带证据与出处，未经验证的猜测单独标注。

## 一、现状（硬事实）

| 项 | 值 |
|---|---|
| 版本 | `v0.12.0`，已装入 `~/.dsh/profiles/desktop`（symlink → 本目录） |
| 预检 | `verify-wisp.mjs` **180 项全过**，虚拟时钟 + 全部陷阱全局 |
| 体积 | `lib/client.js` **3.23 MB**（2 套皮肤 × 4 情绪 @ 2048×3072） |
| 依赖 | **零**（`dependencies` / `peerDependencies` 皆空） |
| 状态空间 | `idle` / `alert` / `attn` / `happy` / `worried` / `sleep` |
| 交互 | 点击说话、双击开心、拖动、**右键菜单**（5 动作 + 4 角落 + 2 皮肤）、躲起来的迷你按钮、空闲踱步 |
| 宿主半包 | `lib/index.js` 只导出 `{ name: 'wisp', apply }`，不做任何事 |

**当前最大的结构性问题：所有配置只有两个入口 —— YAML 与浏览器 Console。** 用户要调大小、换皮肤、
关掉踱步，必须开 Console 或改配置再重启。这是 v1.0.0 要解决的主线。

## 二、研究结论（决定方案可行性）

### 结论 1：`inject` 不是服务依赖，设置面板不需要它

`dsh.client.inject` 的语义是**包级依赖边**：

> `inject` names package rows whose factories must arrive before this row materializes.
> —— `packages/client/modules/src/client/manifest.ts:47`

即"这些包的客户端半包必须先到"。它**不是**"我依赖某个客户端服务"。客户端服务一律运行时取：
`ctx.get('theme')` / `ctx.get('timer')` / `ctx.get('styles')` / `ctx.get('slots')`，
带 `requiresUndefinedCheck: true`（见 `Cordis Inspect → client Service` 的 `slots.access.optional`）。

**所以 `verify-wisp.mjs` 里"禁止 `inject`/`shared` 声明"这条守卫要保留**：本插件是本地路径安装，
声明一个包级依赖边而对应包不在图里，entry 会停在 pending，而启动审计会抛错点名失败 entry
（`packages/client/web/README.md:66`）。

### 结论 2：零依赖也能用 React —— 平台 seed 表只有 9 个词

```ts
// packages/client/web/src/seed.ts
'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
'@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
'@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
'@deepseek-ai/dsh-client-ui-dockkit'
```

这 9 个是 **shell 注入的平台单例**。加载器 `makeRequire` 先查这张表
（`system.ts:321`：`if (this.seed.has(spec)) return this.seed.get(spec)`），命中即返回。

而本插件的工厂**已经收得到这个 require 面**——`lib/client.template.js:46` 就是
`factory: (require) => {`，只是目前没用它。

**所以：不需要 `dependencies`、不需要 `inject`、不需要打包 JSX，就能渲染设置页。**
这是 v1.0.0 的关键可行性结论。

**更强的证据**：客户端 Builtin 检查器（`Cordis Inspect → client Builtin`）把 `React` 列为
**一等内建**：

> `React` — React runtime exposed without JSX transformation
> `React.createElement(type, props, ...children)` / `React.useState` / `React.useEffect`

它的同级内建还有 `ctx`（`get`/`on`/`provide`/`effect`）、`host`（到本包宿主半包的 JSON RPC）、
`styles`、`console`。**并且已在发行版里确认**：`app.asar`（112 MB）中
`react/jsx-runtime`、`dsh-client-ui-slots`、`dsh-client-ui-dockkit`、`staticModules`、
以及 builtin 清单原文**全部命中** —— 打包进发行版的 shell 确实带着这张表。

**取用策略**：优先用内建 `React`（若以参数/全局下发），否则 `require('react')`（seed 词）。
spike 只用来确定**哪条路是实际生效的那条**，不再是"能不能拿到"。

取不到时的行为也是明确的 —— 抛错且可捕获：
> `require("…") missed the module table — not a platform seed word, not a materialized module, and no registered package factory`
> —— `system.ts:326`

### 结论 3：设置页有两个 `replaceRisk: none` 的席位

来自运行时 `Cordis Inspect → client Slots → listSubTree`：

| 槽位 | kind | replaceRisk | 用途（原文） |
|---|---|---|---|
| `settings.section` | list | **none** | One settings page per list entry. |
| `settings.general.item` | list | **none** | One preference row inside the General section — the additive seat for a single setting that needs no page of its own |

注册形态（`Cordis Inspect → client Service → slots`）：

```ts
slots.register({ key: 'settings.section', id: 'wisp', order: 60, label: 'DeepSeek娘' },
               (props) => ReactNode)
```

方法说明明确：注册与注销走**调用者的 fiber**（`slots` 的代理在调用时把 `this.ctx` 绑到 caller），
所以插件卸载会自动移除贡献。

## 三、v1.0.0 目标

**一句话：把"只能开 Console"变成"有正经设置界面"，同时把工程底座补齐。**

不新增任何依赖、不新增构建链（不引入 JSX/打包器），保持"两个文件手写 + 两条命令"的形态。

## 四、工作项

### P0-1 设置面板（旗舰）

**做什么**：在 `settings.section` 注册一页「DeepSeek娘」，含：大小滑块、皮肤选择、四个角落、
踱步开关与范围、出错/撒花反应开关、先躲起来、恢复默认。用 `require('react').createElement` 手写，
不引入 JSX。

**数据源**：面板只操作 `window.__wisp`（`configure()` / `setSkin()` / `hide()`），
不另建一套状态 —— 否则菜单与面板会分叉。

**降级**：`require('react')` 抛错或 `ctx.get('slots')` 为 undefined → **静默跳过注册**，
插件其余功能完全不受影响。这条必须走 try/catch，且要有测试证明"取不到时不影响挂载"。

**顺带评估**：seed 里有 `@deepseek-ai/dsh-client-store`，其 `StoreSpec` 支持 `persist`。
若它比现在的 localStorage 封装更合适（例如跨 profile 同步），在 spike 里比较后决定是否替换；
否则不动。

**验收**：假 React（记录 `createElement` 调用）+ 假 slots（记录 `register` 的 key/options 与回调）
下，断言：注册了 `settings.section`、label 正确；渲染出的树里改 size 会真的调到 `configure`；
取不到 react/slots 时不注册且挂载照常成功。真实浏览器里打开设置页截图确认。

**风险**：中。React 版本差异；用 `createElement` 而非 JSX 可规避 jsx-runtime 依赖。
**未验证项**：设置面板在 `dsh-app://` 协议下的实际渲染效果（本机无法直接点开设置页，需人工确认）。

### P0-2 右键菜单的键盘可达性

**为什么**：菜单已经声明 `role="menu"`，但**没有任何键盘支持**。对屏幕阅读器来说这比不声明更糟 ——
它宣布了一个你无法操作的菜单。

**做什么**：↑↓ 移动焦点（跳过小标题）、Home/End、Enter/Space 激活、Esc 关闭并把焦点交还给她；
打开时焦点落到第一项；`aria-activedescendant` 或 roving tabindex 二选一（倾向后者）。

**验收**：断言焦点索引随按键变化、小标题不可聚焦、Enter 触发对应动作、Esc 后焦点回到 `.wisp-body`。
假 DOM 需要补一个最小焦点模型（`document.activeElement` + `tabIndex` + `focus()`）。

### P1-1 体积：3.23 MB → 目标 ≤2 MB

**为什么**：两套皮肤 @ 2048×3072 让包翻倍。她在屏上最大只需要 1680×2520（DPR 3 最坏情况），
而 `hi` 档是 2048×3072 —— **多数情况下多出来的像素并不被看到**。

**三个选项（按推荐顺序）**：

1. **按皮肤分档**：默认皮肤用 `hi`，其余皮肤用 `md`。切换时那一套会略软，但控制在一眼之内。
   改动最小，`build.mjs` 里加一张 `--tier-map` 即可。
2. **动态分块**：加载器支持包内相对 chunk（`system.ts:331` `require.async('./x.js')`，
   校验 `CLIENT_CHUNK`、URL 由 `chunkUrl(row, fileName, revision)` 生成）。
   让非默认皮肤在首次切换时才加载。**这是最干净的答案**，但需要先做 spike 验证
   本地路径安装下 chunk 能否被正确服务 —— **未验证**。
3. 什么都不做，只在文档里写清 `--tier` 的取舍。

**验收**：记录改动前后的 bundle KB 与挂载耗时；跑一遍 `tools/smoke.mjs` 确认换皮肤后视觉无异常。

### P1-2 把真实浏览器检查收进仓库

**为什么**：本轮开发中**三个真 bug 只有真实浏览器能发现** —— 躲避后气泡悬空、菜单越界夹取、
`display:none` 的实际生效。这些检查现在散在开发机上的一组临时脚本里（不属于交付物），换台机器就没了。

**做什么**：`tools/smoke.mjs`，一条命令跑完：挂载 → 菜单几何与夹取 → 躲起来/叫回来（含气泡清理）→
换皮肤 → 交叉淡入淡出 → **页面不被撑出滚动条**。复用本机 Playwright，找不到浏览器时**跳过而不是报错**
（它是可选依赖，不进 `dependencies`）。

**验收**：`node tools/smoke.mjs` 在本机全绿；在没有 Playwright 的机器上以 0 退出并打印跳过原因。

### P2-1 `attn` 专属精灵图（依赖上游）

**现状**：`attn` 与 `worried` 都借用别的图（`work` / `sleepy`），靠光晕与动作区分。

**做什么**：出图（`tools/CHARACTER-PROMPT.md` 姿态表加一行「身体微前倾、抬手招了招」）→
`tools/assets.mjs` → `build.mjs` 的 `MOODS` 加 `attn` → `SPRITE_OF.attn = 'attn'`。
两套皮肤各加一张，`hi` 档约 +600 KB。

**门槛**：上一轮上游 `generate_image` 持续 `Request timed out`（4K + GPT + high quality）。
**若仍不可用，本项从 v1.0.0 移除**，不为了凑功能去降参数 —— 用户明确否过一次降级。

### P3（可选，不进 v1.0.0 的承诺范围）

- **i18n**：台词目前只有中文。客户端有 `locale` 服务，可按语言切换台词表，便于分享给非中文用户。
- **第三套皮肤**：内容工作，取决于出图是否稳定。
- **动态分块加载非默认皮肤**：取决于 P1-1 的 spike 结果。

## 四之二、下一轮的候选（有依据，未实施）

**用会话状态替换两个脆弱选择器。** 客户端 `sessions` 服务的 `SessionSnapshot` 里有权威信号：

```ts
running: boolean               // 现在靠 button[aria-label*="停止"/"Stop"] 猜
lastAgentError: string | null  // 现在靠 [data-error="true"] 数
promptError: PromptError | null
```

取用路径：`sessions.binding(id)` 可以**借用**已被会话界面 retain 的 binding（不延长生命周期），
`binding.session.getSnapshot()` 即得。比 DOM 选择器可靠得多，而且语言无关。

**现在的状态**：所有 `data-*` 钩子已在**已发布的 app.asar** 里确认存在（v1.6.0）。剩下的问题是
  忙碌钩子那个语言相关的 `aria-label` —— `__wisp.doctor()` 现在会在它 miss 时把页面上真实的
  按钮标签带出来，所以**一次调用就能判定要不要换**。

**为什么还没换**：需要先拿到"当前会话 id"（`retain` 要求声明 `source: 'controllerOperation' | 'gateway'`，
一个第三方插件声称自己是它们是在说谎；`retainInfo` 与 binding 都要先有 id），而这条路我**无法在
带鉴权的页面外验证** —— 加进去就是一段没人验证过的代码。

**下一步**：先用 `__wisp.doctor()`（v1.4.0）确认 DOM 钩子在真实页面里是否成立。若 `hooks.busy` 或
`hooks.error` 长期为 0，就说明该换，那时再申请 GUI 的访问方式，或由你在 Console 里跑几段我给的探针。

## 四之三、第三套皮肤「宵蓝礼服」—— 已完成（v1.9.0）

想做的方向：**宵蓝礼服** —— 形象要素全部保留（深蓝超长双马尾、鲸尾、女仆发箍、鲸鱼发夹、
鳍耳饰、颈饰），只把服装从单薄女仆装换成**单层深蓝色露肩礼服**（一字露肩、及膝略短、侧边开衩、
同色细腰带、裸腿 + 白色细带高跟）。这样三套皮肤的差别是"同一件衣服之外的东西换了"，读得出来
又不至于认不出人。

**卡在哪**：4K 出图连续三次 `Request timed out`（上游不可用）。按既定纪律**不降参数** ——
用户明确否决过一次擅自降级。

**恢复后怎么做**：把 `tools/CHARACTER-PROMPT.md` 的【服装】段换成上面那段，其余逐字不动；
每个情绪各出一张 → `node tools/assets.mjs --from <目录> --skin night` → `node build.mjs`。
预计包体积 +1.1 MB（第三个皮肤 5 张）。

## 五、明确不做

1. **不加 `dependencies` / `inject` / `shared`** —— 见结论 1；本地路径安装下包级依赖边会挂住 entry。
2. **不引入 JSX / 打包器** —— `createElement` 足够，多一条构建链就多一处漂移。
3. **不用 `position: fixed` 之外的方式做覆盖层** —— 本可以走 `shell.overlay` 槽位，但那需要把整个
   她改造成 React 组件，收益不抵风险；现在的行内关键样式已经保证样式表缺失也不会撑出滚动条。
4. **不为了赶进度降低出图参数** —— 已因擅自降级被明确否决过一次。

## 六、验收标准

- `verify-wisp.mjs` 全过（当前 180 项，预计 **210+ 项**），且**连跑三次无偶发**。
- `tools/smoke.mjs` 全绿。
- 真实浏览器：设置页能改大小/换皮肤并立刻生效；菜单可全程键盘操作。
- 包体积有明确记录（改动前 / 后），不出现"悄悄变大"。
- README 与 `cordis.patch.yml` 同步；`NOTICE.md` 的硬规则不变。

## 七、排期（按依赖顺序）

| 阶段 | 内容 | 产出 |
|---|---|---|
| 1 | P0-2 菜单键盘导航 | 小、零风险，先把 a11y 缺口补上 |
| 2 | P0-1 设置面板 spike → 实现 | 先验证 `require('react')` 在真实 shell 里可用，再写面板 |
| 3 | P1-2 `tools/smoke.mjs` | 为阶段 4 的体积调整提供回归网 |
| 4 | P1-1 体积 | 有回归网之后再动体积 |
| 5 | P2-1 `attn` 精灵图 | 视上游可用性；不可用则跳过 |
| 6 | 文档、版本号、预检收口 | v1.0.0 |

**阶段 2 是本方案唯一的硬风险点，但已从"能不能拿到 React"降级为"走哪条路拿到它"** ——
发行版 shell 里 seed 表与内建清单都已确认存在（见结论 2）。spike 只确定生效路径。
若两条路在本机 shell 里都不可用（例如动态半包与静态包的 builtin 下发方式不同），
设置面板整项改为"只读展示 + 一键复制配置"的降级形态。

## 八、风险表

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| React 的取用路径与预期不符 | **低**（发行版已确认 seed 表存在） | 设置面板要多试一条路 | 阶段 2 spike 确定路径；降级形态已设计 |
| 动态分块在本地路径安装下不可用 | 中 | 体积只能靠分档 | 备选项 1（按皮肤分档）已可用 |
| 上游出图继续超时 | 中 | 少一张精灵图 | 直接砍掉该项，不降参数 |
| 设置面板与右键菜单状态分叉 | 中 | 行为不一致 | 面板只操作 `window.__wisp`，不另建状态 |
| 预检因新加的假 DOM 能力而失真 | 低 | 测试替身说谎 | 每加一项替身能力，同时补一条"真实浏览器"侧的对应检查 |
