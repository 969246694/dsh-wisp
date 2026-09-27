# dsh-wisp

DeepSeek Harness Web 界面的浮动陪伴插件：**DeepSeek娘** 桌宠。

**当前版本 `0.5.0`** · 零依赖 · 单文件客户端半包（精灵图内嵌为 data URI）

> 非官方插件，与 DeepSeek（深度求索）官方无关。角色形象与图片许可见 [NOTICE.md](NOTICE.md)。

---

## 它做什么

| 行为 | 触发条件 |
|---|---|
| 漂浮与呼吸 | 常驻（`prefers-reduced-motion` 下停止） |
| `idle` 青色 | 默认 |
| `alert` 琥珀色 | Agent 正在跑（出现「停止生成」按钮）**或** 输入框里有字 |
| `happy` 粉色 | 戳她一下 / 双击 / **一轮跑完** |
| `sleep` 灰色冒 `z` | 静置 `sleepAfterMs`（默认 90 秒）；任意输入唤醒 |
| 拖动 | 按住本体拖动，带边界约束；**松手即记住位置**，下次刷新回到原处 |
| 说话 | 挂载问候、点击、睡着、醒来、跑完各有一组台词 |

外层 `pointer-events:none`，只有本体可点 —— 它不会挡住你对应用的操作。

---

## 文件结构

```
dsh-wisp-plugin/
├── package.json          dsh.bundle.patch + dsh.client.platform，零依赖
├── cordis.patch.yml      插入一行 host 入口（指向 dsh-wisp，绝不能是 dsh-wisp/client）
├── lib/
│   ├── index.js          host 半包：刻意为空的 ES 模块
│   ├── client.template.js  浏览器半包源码（唯一需要编辑的文件）
│   └── client.js         由 build.mjs 生成，勿手改
├── assets/               四张 256x384 透明 WebP（idle / happy / sleepy / work）
├── build.mjs             注入精灵图 + 三道构建防线
├── verify-wisp.mjs       预检：两套契约 + 真实执行
├── NOTICE.md             角色来源与许可
└── README.md             本文件
```

## 构建与预检

```bash
node build.mjs        # 把 assets/*.webp 注入 lib/client.template.js → lib/client.js
node verify-wisp.mjs  # 预检；exit 0 = 两半包都符合契约
```

**改了 `client.template.js` 就必须重新 `build.mjs`** —— `client.js` 是生成物。

`build.mjs` 现在有四道防线，任何一道失败都拒绝写出文件：

1. 占位符 `__SPRITES_LITERAL__` 必须恰好出现一次，且替换后不得残留；
2. 注入后的 `SPRITES` 表要**真的被求值**，四个 key 都必须是 `data:image/` 开头；
3. 产物**不得调用被陷阱的全局**（`setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` / `fetch` / `require`）；
4. `const VERSION` 必须与 `package.json` 的 `version` 一致（防止版本漂移）。

`verify-wisp.mjs` 在真实契约下执行浏览器半包：六个被陷阱的全局以**抛异常**的形式注入，虚拟时钟同时驱动两条调度路径，假 DOM / Blob / localStorage（含"抛异常的存储"这一档）齐全。当前 **98 项全 PASS，exit 0**。

---

## 改形象（素材流水线）

**形象的唯一权威来源是 [tools/CHARACTER-PROMPT.md](tools/CHARACTER-PROMPT.md)** —— 逐字复用的提示词母版 + 四张姿态 + 完整生成参数。改形象 = 改那个文件、重新出图、再跑一条命令。

```bash
# 1. 按 tools/CHARACTER-PROMPT.md 的参数与提示词，为四个情绪各出一张【绿幕】图，存成 <mood>.png
# 2. 绿幕 → 抠图 → 四档素材，一步到位（任何一张抠图异常都会以非 0 退出）
node tools/assets.mjs --from <绿幕母版目录>
# 3. 打进客户端半包
node build.mjs --tier=hi     # hi 档 = 2048x3072，与母版同尺寸，仅重新编码
# 4. 预检
node verify-wisp.mjs
```

三条硬约束（实测依据见 CHARACTER-PROMPT.md 与 NOTICE.md）：

1. **不要用服务端的透明背景。** 它会把浅蓝渐变的发梢与鲸尾当背景切掉，表现成"模型跑形"，几乎无法从结果反推。出绿幕、自己抠图 —— 只有 0.4%–0.7% 的边缘像素需要处理，发丝一根不丢。
2. **不要传参考图。** 形象靠提示词锚定；一条提示词只放一个角色。
3. **画风别写"高质量二次元插画"这种笼统说法**，它会推向韩系半写实并崩掉设定。

---

## 性能

一切数字都是在真实 Chromium 里量的（合成 10k 节点会话记录，headless、CPU 光栅，即**最不利**的一档）。可复现的探针脚本在 `F:\deepseek对话\_perf\`。

### 稳态

| 指标 | 数值 |
|---|---|
| 动画帧使用量 | **0**（走 `timer` 服务，根本不挂帧循环） |
| 定时器 | 1 个 `interval`（反应轮询）+ 3 个 `timeout` |
| 反应轮询成本 | **0.44 ms / 次**（每 1.2 s 一次 ≈ 0.04% 单核） |
| 每帧平均间隔 | 无插件 4.202 ms vs 挂载后 4.207 ms（4 次重复，交替测量） |
| 每秒 DOM 查询 | `querySelector` 1 次；`querySelectorAll` **0 次** |

前三个数字来自"每次都重新全量查一遍"的老实现时是：`querySelectorAll` 每次都调、1.27 ms/次。现在把输入框元素**解析一次后缓存**（仅在它离开文档时重新解析），忙碌判定从 4 条精确选择器改成 2 条子串选择器 —— 后者还能顺带匹配没见过的语言标签。

### 一次性成本

- **挂载瞬间**有一次约 15–50 ms 的卡顿（headless CPU 光栅下）。来源是注入样式表触发的整篇样式重算 + 首次模糊光栅化，不是稳态开销；预热 1.5 s 后测 6 s，**没有任何一帧超过 20 ms**。
- 4 张精灵图共 134 KB base64，挂载时只解码用到的 1 张，其余在 1.5 s 后预热。

### 已知的、没修的

- **rAF 兜底路径**在没有 `timer` 服务的壳里，只要还有任务待触发就会保持帧循环（拿不到 `setTimeout`，没有别的唤醒源）。真实 DSH 壳不走这条路 —— `window.__wisp.clock` 若不是 `timer-service` 就是它。
- 常驻的呼吸动画在 headless CPU 光栅下会让偶发单帧变长（4 次重复里最差 37 ms，平均值不受影响）。GPU 合成的真实窗口里这类 `filter` 通常不花钱。`prefers-reduced-motion` 会关掉全部动画。

---

## 配置

配置写在 profile 的 bundle patch 里（`~/.dsh/profiles/<profile>/cordis.patch.yml`，或本包 `cordis.patch.yml` 的 `insert` 行上），作为 `apply(ctx, config)` 的第二个参数。**全部可选，全部会被夹到合法区间**——写错只会退化成默认值，不会做出一个找不到或点不动的桌宠。

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `right` | number | `26` | 距右边缘 px（仅首次落位；拖动过之后以记忆位置为准） |
| `bottom` | number | `46` | 距下边缘 px |
| `size` | number | `4` | 缩放，限制 `0.4–8`；默认绘制 560×840 CSS px |
| `sleepAfterMs` | number | `90000` | 静置多久打盹，限制 `5000–3600000` |
| `reactions` | boolean | `true` | 是否跟随 Agent 忙碌 / 输入框内容变情绪 |
| `persist` | boolean | `true` | 是否跨刷新记住位置 |
| `celebrate` | boolean | `true` | 一轮跑完是否庆祝一下 |
| `celebrateAfterMs` | number | `2500` | 只庆祝跑够这么久的轮次（避免每次小工具调用都跳） |
| `happyMs` | number | `1100` | 高兴状态持续多久 |
| `chatterMs` | number | `0` | `>0` 时按此间隔随机说句话；`0` = 安静 |

例：

```yaml
- id: wisp
  name: "dsh-wisp"
  config:
    bottom: 90
    size: 1.2
    chatterMs: 300000
```

### 运行时 API

页面 Console 里 `window.__wisp` 可用：

```js
window.__wisp.say('你好')                 // 说一句
window.__wisp.mood('happy')               // idle | alert | happy | sleep
window.__wisp.configure({ size: 1.5 })    // 部分更新，其余键保持不动
window.__wisp.move(200, 300)
window.__wisp.position                     // { x, y }
window.__wisp.resetPosition()              // 清掉记忆位置，回到右下角
window.__wisp.clock                        // 'timer-service' | 'animation-frame'
window.__wisp.destroy()
```

`window.__wisp.clock` 直接告诉你这台机器走了哪条调度路径，排查时先看它。

---

## 平台契约（踩过的坑都在这）

### 1. 两个文件、两套契约

宿主 **import** `cordis.patch.yml` 里 `name:` 指向的包 —— 必须是合法 ESM，即 `lib/index.js`。
浏览器半包是**经典脚本**，由 `package.json` 的 `exports["./client"]` 定位、`/plugins` 路由投递，自己调用 `window.__ModuleLoader__.load({ id, factory })` 注册。

**patch 那一行写成 `dsh-wisp/client` 会导致 `failed to import`** ——宿主无法 import 经典脚本。

### 2. 六个全局是抛异常的陷阱

`setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` / `fetch` / `require` 在客户端半包里被**抛异常的形参**遮蔽。所有时序因此来自 Client `timer` 服务：

```js
ctx.get('timer').timeout(fn, ms)   // → disposer
ctx.get('timer').interval(fn, ms)  // → disposer
```

`timer` 服务取不到时（老壳 / 无头壳）退回 `requestAnimationFrame` 截止时间表，**且只在有任务待触发时才挂帧**——原来那种常驻 60fps 帧循环会让桌面进程每秒白醒 60 次。

`ctx.get('theme')` 与 `ctx.on('theme/change')` 用来跟随明暗；`body[data-ds-dark-theme]` 是兜底（这是壳真的会写的属性）。

### 3. 精灵图必须走 `blob:`，不能直接给 `data:`

初版把 base64 data URI 直接赋给 `img.src`：插件"挂载成功"、DOM 正确、光晕正常，**图是碎的**。字节经校验无误，是这个壳拒绝 `data:` 作图片源。现在解码成 `Blob` 再取 object URL，拆解时 `revokeObjectURL` 释放，**并把缓存条目一起删掉**——blob 缓存是模块级的，而挂载是每次 apply 一次，只 revoke 不删键会让下一次挂载拿到已吊销的 URL，又变成碎图。

### 4. 一次性实例

`apply` 会先销毁已存在的 `window.__wisp`。HMR 重挂、重复行、以及注入版残留都会走到这条路径，否则会叠出第二只。

### 5. 反应信号取自 DOM 事实

- 忙碌：`button[aria-label*="停止"],button[aria-label*="Stop"]` —— 壳自己的「正在跑」按钮（zh 标签是"停止生成"，en 是 "Stop generating"）。用子串而不是枚举精确标签，是因为标签会被翻译，而且实测 2 条子串选择器比 4 条精确选择器便宜 40%，覆盖反而更宽；
- 输入框有字：`[data-composer-input]`（依次回退到 `textarea`、`[contenteditable="true"]`）——**解析一次后缓存**，只在元素离开文档时重新解析。

两者都是壳为自家用户渲染的东西，比内部服务契约更抗版本升级。

---

## 安装

**从 npm 装（推荐）** —— 这是**唯一不需要访问 GitHub** 的方式。在「添加插件」对话框里，把**安装源**设为 **中国大陆镜像源**（`registry.npmmirror.com`），然后填**包名**：

```
dsh-wisp
```

**从 GitHub 装** —— 需要能访问 github.com：

```
plugin_manager install_bundle  https://github.com/969246694/dsh-wisp
```

**从本地路径装** —— 桌面版 profile 归 Electron 独占管理，`dsh plugin --profile desktop` 会被拒绝，所以走 GUI：**插件管理页 → 添加插件 → 填本目录绝对路径**。本地路径安装不下载任何包。

> **为什么镜像源只对 npm 那条路有用**：GitHub 地址被归类为 **git 规格**，由 `git` 拉取，**完全绕过 npm**——「安装源」那个设置对它无效。

装完**刷新页面**（`Ctrl+Shift+R`）即可拿到浏览器半包——`/plugins` 路由的 `rev` 由文件 `mtime` 驱动，必然变化。宿主半包（`lib/index.js`）的改动才需要完全退出托盘进程重启。

### 装好后这样验

- [ ] 右下角出现发光桌宠
- [ ] Console 有 `[wisp] mounted — DeepSeek娘 v0.5.0 (timers: …)`，且括号里是 `timer-service`
- [ ] 打字 → 变琥珀色；清空 → 回青色
- [ ] 让她跑一轮 → 结束时会庆祝一下
- [ ] 拖到别处 → 硬刷新 → **还在原处**
- [ ] `window.__wisp` 存在

---

## 变更

### 0.5.0

- **素材流水线收进插件**（`tools/`）：`CHARACTER-PROMPT.md` 成为形象的唯一权威来源（逐字复用提示词 + 四姿态 + 生成参数），`assets.mjs` 一条命令完成「绿幕 → 抠图 → 四档素材」，任何一张抠图异常都会以非 0 退出而不是悄悄混进包里；`keyout.mjs` 可单独抠一张调试
- **情绪切换改为交叉淡入淡出**：原来直接换 `src`，观感像闪一下；现在旧精灵保留独立图层淡出后再移除
- **每个情绪有自己的动作**：happy 改成 1.15s 小跳，alert 呼吸加快到 4.6s，sleep 仍是 9s 慢呼吸
- 预检增至 98 项（新增交叉淡入淡出的两层/回收断言）

### 0.4.0 – 0.4.4

- 尺寸从 140×210 放大到 560×840（`size: 4`，上限提到 8）
- **修复 `transform` 位移写错导致的"挪不动"**：位移是原点无关的，之前按"重心原点"补了半格导致绘制位置与命中区错开半个身位；同时补上行内关键样式，避免样式表未生效时把她所在的层变成文档流元素、把页面撑出滚动条（实测旧行为可达 3292px）
- 抠图质量：弃用服务端透明背景，改绿幕 + 本地抠图（发梢与鲸尾不再被切掉）
- 形象更新：深蓝超长双马尾 + 鲸鱼鳍耳饰 + 单薄性感女仆装 + 商业级高精度二次元画风

### 0.3.1

- **反应轮询成本降到 1/3**（实测 1.27 ms → 0.44 ms 每次）：输入框元素改为**解析一次后缓存**，不再每次全量 `querySelectorAll`（现在每秒 0 次 NodeList 收集）；忙碌判定由 4 条精确选择器改为 2 条子串选择器（顺带覆盖未预见的语言标签）
- **去掉常驻 `will-change: transform`**：只在真的拖动期间挂合成提示，不再为几乎不发生的事件常驻一个合成层
- `paint()` 不再每次重写永不变化的 `transform-origin`
- 新增 3 项预检守卫：已解析的输入框不得每帧重查、一次 tick 不得收集 NodeList、无输入框时每 tick 最多一次探测

### 0.3.0

- **调度改用 Client `timer` 服务**，rAF 降级为兜底且只在有待触发任务时挂帧 —— 去掉常驻帧循环与每次 `pointermove` 重建定时器的开销
- **修复 `nowMs` 混用两个时钟源**：`window.performance && performance.now()` 在壳自带 `window` 的场景下会用两个时间基准算/比截止时间，导致**任何定时器都永不触发**；现在只经 `window.performance` 读取
- **修复重挂载碎图**：blob 缓存改为吊销时一并清键（模块级缓存 × 每次 apply 挂载的交叉 bug）
- 新增：位置记忆、跑完庆祝、`configure()` 部分更新、`resetPosition()`、`clock` / `position` / `currentMood` 只读查询
- 新增：`theme` 服务订阅，气泡与文字改用 `--dsw-alias-*` 主题 token（带手调兜底）
- 新增：忙碌判定改用壳真实的「停止生成」按钮标签
- 加固：配置区间夹取（坏配置退化为默认值而非 NaN 几何）、`document.body` 未就绪时有限重试、存储不可用（不透明源）时优雅降级
- `build.mjs` 增加陷阱全局与版本漂移两道防线；`verify-wisp.mjs` 重写为六陷阱注入 + 虚拟时钟双路径驱动

### 0.2.1

- 精灵图内嵌；blob URL 修复碎图；`ctx.effect` 拆除钩子

### 0.2.0

- host 半包清空为零依赖；patch 指向 host 半包（修 `failed to import`）

### 0.1.0

- 初版（纯 DOM 注入版）
