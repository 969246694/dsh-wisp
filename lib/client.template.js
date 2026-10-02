/* ============================================================================
   dsh-wisp — browser half.  GENERATED FILE — edit lib/client.template.js then
   run `node build.mjs`. The build injects one object of data URIs (see the SPRITES const).

   A CLASSIC browser script that registers itself with the web shell's module
   loader. Not an ES module: no import, no export.

       window.__ModuleLoader__.load({ id, factory: (require) => { … } })

   The companion is DeepSeek娘 — the community's personification of DeepSeek.
   Four AI-generated sprites are embedded as data URIs so the plugin stays a
   single self-contained file with no asset paths to resolve. See NOTICE.md for
   the character and image provenance.

   Moods map to sprites:
       idle   -> idle    (default)
       alert  -> work    (agent is busy, or the composer has text)
       happy  -> happy   (you clicked her, or a run just finished)
       sleep  -> sleepy  (left alone for a while)

   FOUR PLATFORM FACTS THIS FILE IS BUILT AROUND (each one cost a debugging
   session — the traps are documented in NOTICE.md):

   1. setTimeout / setInterval / clearTimeout / clearInterval / fetch / require
      are THROWING TRAPS inside a client half evaluated by the dynamic runner.
      All timing here comes from the Client `timer` service (ctx.get('timer')),
      with a requestAnimationFrame deadline table as the fallback for a shell
      that does not provide it. Neither path ever touches a trapped global.

   2. The rAF fallback is armed ONLY while jobs are pending. An always-on frame
      loop would keep a desktop GUI process waking sixty times a second to do
      nothing — and pointermove fires often enough that re-arming a job per
      event is its own small leak.

   3. Sprite bytes reach <img> through a blob: object URL, never as the raw
      `data:` URI: this shell serves its UI from a custom origin and renders a
      data: image source as a broken-image icon.

   4. The bubble and text colors come from the app's own theme tokens
      (--dsw-alias-*) with hard-coded fallbacks, and the light/dark fallback is
      keyed off `body[data-ds-dark-theme]` — the attribute the shell's theme
      presenter actually writes.
   ========================================================================== */
window.__ModuleLoader__.load({
  id: 'dsh-wisp/client',
  /* 参数故意不叫 `require`：客户端半包里 `require` 是**被陷阱的全局**（一调用就抛），
     而构建守卫对源码做正则，无法区分"被陷阱的全局"与"遮蔽它的工厂参数"。叫
     `loadModule` 让"这是模块系统的解析面"成为代码里看得见的事实，守卫也就能保持严格。 */
  factory: (loadModule) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const VERSION = '1.43.2'

/* 每一版一句话。**必须写当前版本** —— 预检里有一条断言盯着它，
   忘了更新就会红，不会静默过期。 */
const WHATS_NEW = {
  '1.16.0': '按社区规范换上鲸鳍耳。',
  '1.17.0': '鳍耳缩小、加上呆毛。',
  '1.18.0': '新增原版女仆的完整提示词。',
  '1.20.0': '第五套皮肤「原版女仆」上线。',
  '1.21.0': '去掉双马尾，五套皮肤统一长直发。',
  '1.22.0': '生成审计日志：素材来源可自查。',
  '1.23.0': '滚轮调大小、方向键挪位置、躲起来也能开菜单。',
  '1.24.0': '她会报自己的版本，更新过会告诉你，还能把包名复制给你。',
  '1.25.0': '她真的会去查有没有新版本了。',
  '1.25.1': '内容与 1.25.0 相同，重新发布以修好安装源。',
  '1.26.0': '检查更新同时读 npm 和 GitHub，取更高的那个版本。',
  '1.27.0': '她饿了会捧出一碗白米饭，还有第八个表情。',
  '1.28.0': '菜单分成折叠分组，另外多了「关于她」和「动作一览」两个弹窗。',
  '1.29.0': '夜深了她会劝你去睡；你走开再回来她记得；连续来了几天她也记着。',
  '1.30.0': '会陪你专注计时了；页面藏起来时她会安静下来，不再空转。',
  '1.31.0': '菜单重做：状态一目了然，开关是开关，大小能直接拖。',
  '1.32.0': '分组改成鼠标悬停就展开、移开就收起（点一下则是钉住）。',
  '1.33.0': '子菜单改成在旁边弹出（真正的菜单栏形状），→/← 进出自如。',
  '1.33.1': '修子菜单位置算错、会压住主菜单的问题。',
  '1.33.2': '修她在屏幕四角时子菜单跟着偏的问题。',
  '1.34.0': '菜单样式重做：摘要做成胶囊、每行都有图标位、键盘焦点看得见。',
  '1.34.1': '菜单改成紧凑刻度，占屏幕小了三成。',
  '1.35.0': '她开始替你值班：你走开时看着，回来报账；还能说今日小结。',
  '1.36.0': '她会说英文了（跟随界面语言/系统语言，也能强制）；音效与"汇报"姿势已就位。',
  '1.37.0': '菜单里能直接选台词语言（跟随界面 / 中文 / English），选一次就记住。',
  '1.38.0': '她有身体了：按下去会压一下弹回来、拖着会侧身、落地会顿一下，指针靠近会朝你倾过来。',
  '1.39.0': '她会看你的余额了（菜单里点一下），未登录或查不到时如实说。',
  '1.40.0': '她的透明处真的点不到了：按轮廓命中，站在按钮上也不挡你点它。',
  '1.41.0': '检查更新更耐得住：一个源连不上不再把另一个拖死，失败时 doctor() 会说清是哪个源、为什么。',
  '1.42.0': '查更新失败时她会直接说清是哪一种：没通道 / 连不上 / 宿主没应答。',
  '1.43.0': '一批"真的用鼠标点过一遍"才发现的问题：拨完开关面板不再消失、大小能调回出厂值、触摸与指针离开不再留姿势、静止档真的会停。',
  '1.43.1': '检查更新多了一条兜底通道（问插件管理器），并且失败时会直接说出"为什么拿不到"。',
  '1.43.2': '台词只说人话；查不成的原因排进「关于她」弹窗，不再往句子里塞英文碎片。',
}

/* 更新这件事**这个插件自己做不到**，如实写在代码里，免得以后有人以为能：
   宿主半包跑在 vm 沙箱里，harness 只给 { defineTool, registerTool, handle }，
   沙箱里还有 nodeApiTraps() 挡着 Node API —— 没有网络、没有文件系统。
   DSH 的插件安装器也没有以可注入服务的形式暴露出来。
   所以这里只做三件真能做的事：报版本、说她更新了、把包名复制给你去 DSH 里装。 */
const SEEN_VERSION_KEY = 'dsh-wisp:seen-version:v1'
const UPDATE_HINT = '在 DSH 的插件列表里按包名安装：dsh-wisp'
/* 但"按包名安装"只在 npm 上已经有这一版时成立。npm 暂存（或还没发）而 GitHub
   已经更新时，照那句话装回来的是**旧版** —— 她得改口，并复制仓库地址而不是包名。
   她本来就知道这个版本号是从哪个源读到的（updateCheck.from / sources）。 */
const UPDATE_REPO = 'https://github.com/969246694/dsh-wisp'
const UPDATE_HINT_GITHUB = 'npm 上还是旧版，用这个地址装 dsh-wisp：' + UPDATE_REPO

    /* ---- sprites: 256x384 WebP, transparent, inlined by build.mjs ---- */
    const SPRITES = __SPRITES_LITERAL__

    /* 皮肤显示名。没在这里登记的皮肤直接用它的目录名 —— 所以增删皮肤只需要
       放素材 + 重新构建，不必改这一段。 */
    const SKIN_LABELS = { deepsea: '深海女仆', canon: '原版女仆', classic: '素绘女仆', night: '宵蓝礼服', pajama: '宵眠睡衣', default: '默认' }
    /* 皮肤 id 表放在模块级：mount 里恢复"上次选的皮肤"时就要用它，那时 mount
       内部的 const 还没求值（写成 mount 内的 const 会踩 TDZ）。 */
    const SKIN_IDS = Object.keys(SPRITES)

    /* ---------------------------------------------------------------------
       SPRITE URL RESOLUTION — why this is not simply `img.src = dataUri`.

       The first shipped build set `img.src` to the base64 data URI directly.
       The plugin loaded (console showed "[wisp] mounted"), the DOM was correct
       and the ground glow rendered — but the sprite box showed a broken-image
       icon. The embedded bytes were verified good (RIFF/WEBP magic, 256x384
       RGBA), so the failure was the page refusing a `data:` URI as an image
       source. This shell serves its UI over a custom `dsh-app://` protocol,
       which appears to intercept resource loads.

       So the data URI is decoded into a Blob and an object URL is used instead,
       which is what the page accepts. Blob URLs are revoked on teardown.
       --------------------------------------------------------------------- */
    const blobUrls = Object.create(null)

    const resolveSprite = (dataUri) => {
      if (blobUrls[dataUri]) return blobUrls[dataUri]
      try {
        const comma = dataUri.indexOf(',')
        const meta = dataUri.slice(0, comma)
        const body = dataUri.slice(comma + 1)
        const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/webp'
        const bin = atob(body)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
        blobUrls[dataUri] = url
        return url
      } catch (error) {
        // Blob unavailable for some reason — fall back to the raw data URI.
        blobUrls[dataUri] = dataUri
        return dataUri
      }
    }

    /* Revoking is not enough: this cache is per MODULE, while a mount is per
       apply, so a second apply in the same module (HMR, or the singleton
       replacement below) would otherwise hand the new <img> a revoked blob URL
       and render the sprite as a broken image. Dropping the entries makes the
       next mount rebuild them. */
    const revokeSprites = () => {
      for (const key in blobUrls) {
        const url = blobUrls[key]
        if (typeof url === 'string' && url.indexOf('blob:') === 0) {
          try { URL.revokeObjectURL(url) } catch (e) { /* ignore */ }
        }
        delete blobUrls[key]
      }
    }

    /* ---- geometry: one box per mood so she never jumps ---- */
    const BOX_W = 140
    const BOX_H = 210
    const GROUND = 46          // px from the bottom edge to her feet
    const SAY_MS = 4400        // bubble lifetime
    const SAY_MAX_W = 210      // must match .wisp-say max-width in the CSS
    const SAY_CLEARANCE = 84   // room the bubble needs above its anchor
    const POLL_MS = 1200       // reaction poll
    const WAKE_THROTTLE_MS = 1000
    const WORRIED_MS = 3500                 // 出错表情持续多久

    /* ---------------------------------------------------------------------
       动作（motion）。

       在这之前，"她的动作"只有两件事：换一张精灵图，以及一条常驻的呼吸
       循环动画。按下、拖动、松手这些**手势**在画面上没有任何回应 —— 她像
       一张贴在屏幕上的图，而不是一个被碰到会有反应的东西。

       这里补的是"身体感"，而且刻意只用 CSS 关键帧 + 一个样式变量：插件
       的稳态开销承诺是**零动画帧**（见 README 性能表），加一条 rAF 循环
       就等于把那条承诺撤掉。所有动作都是"事件写一次属性，浏览器自己算"。

       三个层各管一件事。CSS 的 transform 在同一个元素上是**覆盖**而不是
       叠加，所以"分层"不是设计洁癖，是唯一做法：

         .wisp-body    情绪动画（呼吸 / 跳 / 推 / 担心）—— 既有，不动
         .wisp-motion  一次性动作（按下压一下 / 落地顿一下 / 换表情弹一下）
                       由 data-accent 驱动，放外层 → 落地时的压扁是**屏幕坐标**
                       里的竖直方向（重力方向），不会跟着侧倾一起歪
         .wisp-lean    持续姿势（拖动速度 / 指针靠近 / 溜达方向）
                       由 --wisp-tilt 驱动，旋转原点在脚底 → 像钟摆，不像转盘

       data-accent 的取值里，pop-a / pop-b 是**同一件事的两个名字**：改
       animation-name 是让同一条动画立刻重播的唯一可靠办法（同一个值再写
       一次不会重播），而连戳两下必须看到两次弹。
       --------------------------------------------------------------------- */
    const MOTION_AMP = { full: 1, subtle: 0.5, off: 0 }
    const TILT_DRAG_MAX = 8        // 拖动时最大侧倾（度）
    const TILT_DRAG_PER_PX = 0.55  // 每一次指针事件横向走 1px 折算多少度（≈速度）
    const TILT_NEAR_MAX = 3.5      // 指针靠近时最大侧倾（度）
    const TILT_NEAR_PX = 170       // 多远算"她注意到你了"
    const TILT_GLIDE_MAX = 2.5     // 溜达时朝行进方向前倾（度）
    const TILT_GLIDE_PER_PX = 0.02 // 溜达距离折算成前倾角的斜率
    /* 变化小于这个数就不写样式 —— pointermove 一秒能来上百次，而 0.05° 在
       屏幕上是看不见的。写一次 = 一次样式重算，阈值就是它的闸门。 */
    const TILT_STEP = 0.05

    /* 动作时长必须是**代码**里的一份：CSS 只负责怎么动，什么时候收手由这里
       决定（和 glide 的 1700ms 一个路子）。两边对不上就会出现"动画早放完了，
       属性还挂着"或者反过来的空档。
       没有 release：松手之后紧接着就是**点击反应**（换表情 → 弹一下），两者
       抢同一个通道，而反应赢 —— "手指抬起来了"不值得盖过"她换了个表情"。
       通道只留最后发生的那件事，不留一个永远演不到的关键帧。 */
    const ACCENT_MS = { press: 200, land: 560, pop: 380 }

    /* 换表情时"弹一下"的表情集合。idle / alert / sleep 不在里面：它们要么是
       长时间稳态，要么由轮询反复重算，弹一下就变成抖。 */
    const POPPY_MOODS = ['happy', 'poked', 'proud', 'attn', 'care', 'eat', 'worried', 'report']

    const DEFAULTS = {
      bottom: GROUND,
      right: 26,
      sleepAfterMs: 90000,
      reactions: true,
      /* 交互动效档位：full 灵动 / subtle 克制（半幅）/ off 静止。
         默认全开 —— 但必须有一个**不用改系统设置**就能让她安静下来的开关，
         prefers-reduced-motion 是给"所有动画"的，不是给"我不想让她动"的。 */
      motion: 'full',
      size: 4,                  // 560x840 CSS px, drawn from the 2048x3072 tier
      persist: true,            // remember where she was dragged to
      celebrate: true,          // cheer when a run finishes
      celebrateAfterMs: 2500,   // ...but only for runs that lasted this long
      chatterMs: 0,             // 0 = she stays quiet when idle
      careAfterMs: 5400000,     // 连续活动这么久之后提醒你起来动动（90 分钟；0 = 关）
      hungry: true,             // 干饭：她饿了会说
      hungerMs: 2700000,        // 连续活动这么久就该吃一碗了（45 分钟；0 = 关）
      focusMinutes: 25,         // 菜单里「专注 N 分钟」用的默认时长
      night: true,              // 深夜劝睡
      bedtimeHour: 23,          // 几点算深夜（0-23）
      wakeHour: 5,              // 几点算天亮（0-23）；bedtime > wake 时窗口跨零点
      nightMs: 1800000,         // 深夜每隔这么久说一句（30 分钟；0 = 关）
      backAfterMs: 120000,      // 离开超过这么久，回来时她会说一句（2 分钟；0 = 关）
      milestones: true,         // 今日轮次到达里程碑时得意一下
      memory: true,             // 她记着你：一起多少天 / 常放哪个角 / 常穿哪套
      /* lang 与 soundVolume 曾经**只在 CONFIG_SPEC 里声明、DEFAULTS 里没有**：
         前者靠 isZhNow() 把非字符串兜成 'auto' 侥幸没事，后者直接是 undefined →
         `Number(undefined)` = NaN → `clip.volume = NaN` 在浏览器里抛，被
         playSound 的 try/catch 吞掉 —— 于是"打开音效"整条路静默失效。
         配置键的两个"端"（声明 / 默认值）现在由预检钉住。 */
      lang: 'auto',             // 'auto' 跟随界面语言；'zh' / 'en' 强制
      sound: false,             // 音效默认关（无故出声是最招人烦的交互之一），且要有素材
      soundVolume: 0.7,         // 音效音量（音效本身默认关，且要有 assets/audio 才存在）
      happyMs: 1100,
      wander: true,             // stroll around on her own while idle
      wanderMs: 45000,          // how often she considers moving
      wanderRange: 260,         // furthest a single stroll may travel
      skin: '',                 // '' = 上次选的那套；也可点名一套皮肤
      hidden: false,            // true = 挂载时就是躲起来的状态（只能强制隐藏，恢复走菜单）
      /* 让窗口的 DWM 背景材质（Mica/Acrylic）真正露出来：清掉"铺满视口的不透明底色"。
         桌面窗口有两种"透"：
           1) 整窗 alpha（SetLayeredWindowAttributes + LWA_ALPHA）—— 桌面不模糊地透过来，
              但**窗内每一个像素**都被乘掉，包括她的精灵图，于是她跟着一起透；
           2) DWM 背景材质（Mica/Acrylic）—— 只有窗口背景透，窗内内容保持不透明。
         2 正是"壁纸可见 + 她实心"，但它要求页面在背景处不画不透明像素。
         默认关：这是一处影响整个应用的视觉改动，不该由她替别人做主。 */
      backdrop: false,
    }

    /* ---------------------------------------------------------------------
       台词表。

       她是个"长期在场"的东西：一天点几十次、看几百轮任务。3–6 句的池子在一周内就会被
       看穿，所以每个场景的池子都留得足够宽，且按**时段**分四套招呼语 —— 凌晨三点和上午
       十点不该说同一句话。

       语气基准：安静、干、偶尔自嘲，不谄媚也不聒噪；她和你并排坐着干活，不是客服。
       --------------------------------------------------------------------- */
    const LINES_ZH = {
      hello: ['我在这儿。', '灯亮着，你忙你的。', '需要我就戳一下。', '我又来了。', '还在老位置。'],

      // 招呼语按时段取，见下面的 greetPoolName()
      morning: ['早上好。', '早，今天从哪儿开始？', '醒了？我比你先到。', '早上安静，适合干活。', '早上的脑子最好用，别浪费。'],
      afternoon: ['下午了。', '这一下午还长着呢。', '午后最容易走神，我盯着你。', '下午的光比上午暖。', '喝口水吧，还早。'],
      evening: ['到晚上了。', '天黑了，灯打开没？', '晚上的你和白天的你不太一样。', '入夜了，剩下的慢慢来。', '这个点最容易一口气干到天亮。'],
      night: ['这么晚还在？', '夜深了，别硬撑。', '凌晨的屏幕最亮。', '我不催你，但我会记着时间。', '夜里的话少，正好干活。'],

      click: [
        '嗯？', '在的。', '别戳啦。', '……痒。', '有事说，没事也成。', '我一直看着屏幕呢。',
        '你再戳一下我就不客气了。', '干嘛？', '在呢在呢。', '戳我一百下也不会多出一条信息。',
        '手闲了？', '我在这儿待着挺好的。', '有点痒，但是不讨厌。', '你想说什么就说吧。',
      ],
      happy: [
        '叮——', '这个我喜欢。', '再来一次？', '哦？', '难得。', '嗯，这算好事。', '记下了。',
        '你心情不错。', '看得出来今天顺。',
      ],
      sleep: [
        '呼……', '我眯一会儿。', '……先睡了。', '撑不住了，抱歉。', '有事叫我，我听得见。', '你忙，我躺会儿。',
        '眼睛闭上了，耳朵还开着。', '别看我，我睡着了。',
      ],
      wake: [
        '醒了醒了。', '嗯，我在。', '谁？……哦，是你。', '没睡着，只是闭着眼。', '来了。', '继续吧。',
        '刚才梦到海了。', '一点动静就醒。',
      ],
      done: [
        '跑完了。', '收了。', '这一轮结束。', '去看看？', '结束了，轮到你。', '干得不错。',
        '这轮比上轮快。', '我数着步数呢，收工。', '好了，喘口气。', '结论在上面，自己看。',
      ],
      chatter: [
        '……', '有点安静。', '我在数窗外的光。', '你打字的声音挺好听的。', '刚才那行删掉又打了一遍。',
        '我不打扰你，就是想说句话。', '这个字你打错了三次。', '屏幕有点烫。', '你喝水了吗。',
        '我在这儿看了很久了。',
      ],
      move: [
        '这儿也行。', '我挪个位置。', '让让，我站这儿。', '换个角度。', '这边清楚点。', '不挡你吧？',
        '挪好了。', '新位置，一样站得住。',
      ],
      home: [
        '回来了。', '还是老地方。', '嗯，归位。', '兜一圈还是这儿最好。', '角落最省地方。', '站稳了。',
        '老位置，踏实。', '就这儿吧。',
      ],
      error: [
        '出错了。', '好像不太顺。', '这一下没成。', '要不要看一眼报错？', '红的。去看一眼。',
        '这次不怪你……也不一定。', '停下来了，可能需要你。', '又来了，先别急。', '报错在下面。',
      ],
      attn: [
        '有人在等你回答。', '这里需要你点一下。', '轮到你了。', '它停下来了，等你。', '别让它干等着。',
        '要你拍板。', '你看一眼这里。', '这一步只有你能过。',
      ],
      poked: [
        '等一下。', '别戳了别戳了。', '……你干嘛。', '我在这儿又不会跑。', '手拿开。', '再戳我就躲起来了。',
        '有点过分了啊。', '戳坏了你赔。', '我抗议。', '停。',
      ],
      /* 久坐提醒：她是"盯着你干活"的那个，所以这件事本来就该由她说。 */
      /* 今日轮次里程碑：台词里的 {n} 会被替换成实际轮数 */
      /* 她记着的那些事。带 {n}/{c}/{s} 的占位符在说话时替换。 */
      days: [
        '我们一起 {n} 天了。', '第 {n} 天 —— 记着呢。', '{n} 天了，居然还在。', '今天是第 {n} 天。',
      ],
      habitCorner: [
        '你总把我放在{c}。', '又是{c} —— 你习惯那儿了。', '{c} 都快成我的位置了。',
      ],
      habitSkin: [
        '你最近常让我穿{s}。', '{s} —— 你好像挺喜欢这套。', '又是{s}，我都快忘了别的了。',
      ],
      /* 检查更新用的三句。前两句带结果，第三句是"查不了/没查成"。 */
      /* 干饭。社区给她的设定里，白米饭是算力的唯一硬通货 —— 这是她最像"DeepSeek娘"
         而不是随便一只桌宠的地方。台词照这个底色写。 */
      eat: [
        '白米饭才是硬通货。', '先干一碗，再想复杂的事。', '冰箱里能吃的？那整台冰箱都是我的便当盒。',
        '才不是特意帮你，只是吃饱了顺手活动一下手指。', '比起深度推理，先来一碗香喷喷的白米饭。',
        '算力不够了，得补点碳水。', '电量告急，切待机。', '你要不要也来一口？',
        '这碗不算加餐，算基础设施。', '吃饱了才有力气摸鱼。', '饭碗见底了，该续命了。', '我数着米粒呢。',
      ],
      /* 值班：你走开的时候她替你看着，回来汇报。分片拼装（跑了多少轮 / 有没有报错），
         因为三种组合（只有轮次、只有报错、两者都有）都该读起来像人话。 */
      awayOpen: ['你走的这段时间，', '刚才那会儿，', '我没走开 —— '],
      awayRuns: ['跑完了 {n} 轮。', '跑完 {n} 轮了。', '有 {n} 轮跑完了。'],
      awayErrors: ['有一次报错，我看过了。', '出了 {n} 次错。', '有 {n} 次报错，你回来看一眼。'],
      /* 单轮跑得异常久：不是催促，是"我还在看着" */
      longRun: [
        '这轮跑了 {n} 分钟了，还在跑。', '{n} 分钟了，我一直看着。', '还在跑，已经 {n} 分钟。',
        '{n} 分钟 —— 要不要我替你盯着，你先去忙？',
      ],
      /* 今日小结：把她记着的东西一次说完 */
      summary: [
        '今天跑了 {runs} 轮，报错 {errors} 次，专注 {focus} 分钟 —— 我提醒你起来 {care} 次。',
        '今天：{runs} 轮、{errors} 次报错、专注 {focus} 分钟、起来活动 {care} 次。记着呢。',
        '这一天跑完 {runs} 轮，出错 {errors} 次，专注 {focus} 分钟。我提醒过你 {care} 次别久坐。',
      ],
      /* 专注计时器。她是陪着你干活的，所以"替你画出一段时间的边界"比再多说几句更实在。 */
      focusStart: [
        '{n} 分钟。开始吧。', '好，{n} 分钟，我盯着你。', '计时开始，{n} 分钟。', '{n} 分钟不看别的。',
        '这段时间归你了。{n} 分钟。',
      ],
      focusDone: [
        '{n} 分钟到了。收工。', '{n} 分钟，干完了？', '时间到。{n} 分钟，去喝口水。', '{n} 分钟到了 —— 站起来伸个懒腰。',
        '这一轮 {n} 分钟，结束了。',
      ],
      focusStop: ['行，那就先到这儿。', '不专注了？那我歇着。', '计时取消了。', '好吧，下次再说。'],
      focusLeft: [
        '还有 {n} 分钟。', '{n} 分钟，快了。', '还剩 {n} 分钟，别分心。', '还有 {n} 分钟呢，盯着屏幕。',
      ],
      /* 深夜劝睡：23 点后一种语气，凌晨 1 点后另一种 —— 后者是社区设定里"嘴硬心软"那一档。
         分档按 bedtimeHour + 2 推导，所以改了作息这套分档也跟着走。 */
      nightLate: [
        '十一点了。', '该收的东西收一收吧。', '我不催你，时钟在催。', '这个点还在跑，明天会还债的。',
        '夜里的屏幕最亮，眼睛最累。', '再干一会儿就收工？', '白天的你会感谢现在的你。', '我给你留着灯。',
        '要不要把剩下的留到明天？', '深夜的算力也是算力，但人也得睡。', '我先打个盹，你随意。', '这时候的安静挺值钱的。',
      ],
      nightDeep: [
        '一点了。', '我不管你，但……真的该睡了。', '明天再跑也一样，代码不会跑。', '再撑下去，明天会很难受。',
        '才不是担心你，只是我不想半夜还看着屏幕。', '你要是倒下，我可没有备份。', '这个点做的决定，白天多半会后悔。',
        '我数到十你就去睡。……一。', '熬夜是拿明天的算力换今晚的。', '天快亮了，你还在这儿。',
        '我要是能关灯就好了。', '睡吧。我留在这儿。',
      ],
      /* 离开又回来：按走了多久分两档（阈值见 backAfterMs / BACK_LONG_MS）。 */
      backSoon: [
        '回来了。', '刚才去哪了。', '我在这儿等着呢。', '一眼没看见你。', '这么快就回来，水都没喝吧。', '位置我没动。',
      ],
      backLong: [
        '你走了好久。', '差点以为今天见不到了。', '回来了就好。', '我一直在这儿。', '这么久，是去吃饭了吗？',
        '屏幕都凉了。', '我还以为你把我关了。', '下次说一声，我就不数时间了。',
      ],
      /* 连续天数（{n} 是天数） */
      streak: [
        '连续第 {n} 天了。', '第 {n} 天了，你还在。', '我们已经连着见了 {n} 天。', '第 {n} 天。我记着呢。', '{n} 天没断，挺厉害的。',
      ],
      updateCurrent: ['已经是最新的了。', '我就是最新的。', '没有更新的。'],
      updateAvailable: ['有新版本了：', '有新版：', '更新来了：'],
      updateFailed: ['更新没查成。', '这次没查到更新。', '更新检查没成功。'],
      /* 失败不是一个笼统的状态：「这个壳里没有联网的通道」「两个源都没连上」
         「宿主那边没应答」是三件事，含糊地说成"没查到"就没人能追下去 ——
         而用户看到的恰恰只有那一句。 */
      updateNoChannel: ['这个壳里我没有联网的通道，查不了更新。', '这里没有能出去的网络通道。'],
      updateNoHost: ['宿主那边没应答，更新没查成。', '问不到宿主，更新没查成。'],
      milestone: [
        '今天第 {n} 轮了。', '{n} 轮了，还不错。', '已经 {n} 轮了，你挺能撑。',
        '第 {n} 轮 —— 我数着呢。', '{n} 轮，进度可观。', '今天 {n} 轮，记上了。',
        '第 {n} 轮，干得不错。', '{n} 轮了，比昨天多？',
      ],
      care: [
        '你已经坐很久了。', '起来走两步吧，我不跑。', '水杯空了吧。', '眼睛也要休息。',
        '我数着时间呢。', '站起来伸个懒腰。', '再坐下去腰会抗议的。', '别一坐就是一整天。',
        '去窗边看看。', '我在这儿等你回来。', '坐太久了，动一下。', '你不动，我就一直看着你。',
      ],
      hint: ['右键我一下试试。', '右键我有菜单。', '拖我，或者右键我。'],

      /* 余额。数字由客户端拼好（{n}），台词只管口气 —— 她报的是账户，
         不是她自己的钱，所以既不邀功也不夸张。 */
      balanceChecking: ['看一下……', '等等，我查查。', '让我看看。'],
      balance: ['余额 {n}。', '还有 {n}。', '{n}，暂时够用。', '账上是 {n}。'],
      balanceBonus: ['其中赠送 {n}。', '还有 {n} 是赠送的。'],
      balanceEmpty: ['没查到余额记录。', '账上没有额度记录。'],
      balanceSignedOut: ['没登录，看不到余额。', '这个得先登录才行。', '还没登录，余额在平台那边。'],
      balanceUnavailable: ['刚才没读到，一会儿再看。', '这一下没读到，稍后再试。'],
      balanceFailed: ['余额没查成。', '这个没读出来，稍后再试。'],
      balanceUnsupported: ['这个壳里我查不了余额。', '这里没有查余额的通道。'],
    }

    /* 英文台词。**只翻译她说的话**（菜单按钮文案仍由 DSH 界面语言决定，不在这一层）。
       值只是"覆盖层"：哪条没翻就自动用中文 —— 可以慢慢补齐，不会出现半句英文。 */
    const LINES_EN = {
      hello: ['Hi.', "I'm here.", 'Ready when you are.'],
      morning: ['Morning. Slept okay?', 'Morning — coffee first?'],
      afternoon: ['Good afternoon.', "It's the afternoon already."],
      evening: ['Evening.', "It's getting dark."],
      night: ["It's late. Don't push too hard.", 'Still up?'],
      click: ['Yes?', "I'm listening.", 'What is it?'],
      happy: ['Nice!', 'That went well.', 'Good.'],
      sleep: ['Zzz…', 'Napping for a bit…'],
      wake: ["Mm — I'm up.", "Oh, you're back."],
      done: ['Done.', 'Finished.', 'That run is over.'],
      error: ['Something failed.', 'There is an error.', 'That one broke.'],
      attn: ['I need you to decide something.', 'Your call on this one.'],
      poked: ['Hey — wait a second.', 'Careful.'],
      care: ["You've been sitting a while. Stretch?", 'Stand up for a minute?', 'Time to move a little.'],
      eat: ['I want a snack.', 'Getting hungry…'],
      awayOpen: ['While you were away, ', 'Just now, ', "I didn't look away — "],
      awayRuns: ['{n} run(s) finished.', '{n} more run(s) done.'],
      awayErrors: ['there was an error — I saw it.', '{n} error(s) came up.'],
      longRun: ['This run has been going {n} minutes.', '{n} minutes and still running.'],
      summary: [
        '{runs} runs, {errors} errors, {focus} minutes focused — I nudged you {care} times.',
        'Today: {runs} runs, {errors} errors, {focus} min focused, {care} stretch breaks.',
      ],
      focusStart: ['{n} minutes. Go.', 'Timer set: {n} minutes.'],
      focusDone: ['{n} minutes — done. Take a break.', 'Focus block over: {n} minutes.'],
      focusStop: ['Stopped at {n} minutes.', 'Timer cancelled — {n} minutes in.'],
      backSoon: ['Back already?', 'There you are.'],
      backLong: ['You were gone a while.', 'Long break. Welcome back.'],
      streak: ['{n} days in a row.', 'Day {n} together.'],
      updateFailed: ["The update check didn't work.", "Couldn't reach the update sources."],
      updateNoChannel: ["This shell gives me no network channel, so I can't check for updates.", 'No way out to the network from here.'],
      updateNoHost: ["The host side didn't answer — the update check failed.", 'No answer from the host.'],
      balanceChecking: ['One moment…', 'Let me check.'],
      balance: ['Balance: {n}.', "You've got {n}.", '{n} on the account.'],
      balanceBonus: [' {n} of that is credit.', ' ({n} is credit.)'],
      balanceEmpty: ['No balance record came back.', 'Nothing on the account.'],
      balanceSignedOut: ["You're signed out — I can't see the balance.", 'Sign in first and I can read it.'],
      balanceUnavailable: ["Couldn't read it just now — try again in a bit.", 'That read did not go through.'],
      balanceFailed: ["The balance lookup didn't work.", "Couldn't read that — try again later."],
      balanceUnsupported: ["I can't reach the balance from this shell.", 'No balance channel here.'],
    }

    /* 语言：中文环境（或读不到语言）用中文，其余走英文覆盖层。
       来源按优先级排：① 本地存的强制值（用户能自己定）② 页面的 <html lang>
       ③ navigator.language。页面语言比 navigator 更准 —— 界面是中文、系统是英文的
       用户不应该听到英文台词。 */
    const langStored = (() => {
      try { return window.localStorage.getItem('dsh-wisp-lang') || '' } catch (e) { return '' }
    })()
    const langHtml = (() => {
      try {
        const el = document && document.documentElement
        return el && typeof el.lang === 'string' ? el.lang : ''
      } catch (e) { return '' }
    })()
    const LANG_TAG = (() => {
      if (langStored !== '') return langStored
      if (langHtml !== '') return langHtml
      try { return String(navigator.language || navigator.userLanguage || 'zh') } catch (e) { return 'zh' }
    })()
    /* 进页面时的默认判定（用户没显式选过就用它） */
    const IS_ZH_DEFAULT = LANG_TAG.toLowerCase().indexOf('zh') === 0

    /* 现在用哪种语言：① 设置里显式选过就听它 ② 否则用进页面时的判定。
       —— 做成**函数**而不是常量，这样菜单里切换立刻生效，不用刷新。 */
    const isZhNow = () => {
      /* cfg 是后面才声明的 const：取词可能发生在它初始化之前，
         而那时访问它会抛 TDZ 错误（不是 undefined）—— 所以这里必须兜住。 */
      let forced = 'auto'
      try { forced = (cfg && typeof cfg.lang === 'string') ? cfg.lang : 'auto' } catch (e) { forced = 'auto' }
      if (forced === 'zh') return true
      if (forced === 'en') return false
      return IS_ZH_DEFAULT
    }

    /* LINES 是一个**视图**：取词的那一刻才决定用中文还是英文覆盖层。
       用 Proxy 而不是"提前合并成一个对象" —— 后者在切换语言时是死值，必须刷新页面。
       覆盖层缺哪条就退回中文，所以可以慢慢补齐，永远不会出现半句话。 */
    const LINES = new Proxy({}, {
      get(_target, key) {
        const zh = LINES_ZH[key]
        if (isZhNow()) return zh
        const en = LINES_EN[key]
        return en === undefined ? zh : en
      },
      has(_target, key) { return key in LINES_ZH },
      ownKeys() { return Reflect.ownKeys(LINES_ZH) },
      getOwnPropertyDescriptor() { return { enumerable: true, configurable: true } },
    })

    /* 深夜窗口。bedtime > wake 时它跨零点（默认 23→5）；不跨也能用（比如 1→5）。 */
    const isNightHour = (hour, from, to) => {
      if (from === to) return false
      return from > to ? (hour >= from || hour < to) : (hour >= from && hour < to)
    }
    /* "深度深夜"= 已经过了入睡时间两小时以上。按**经过的小时数**算，而不是按绕圈区间：
       后者在窄窗口（比如 13 点睡、14 点起）会把窗外的一大段时间也算进来。 */
    const DEEP_AFTER_HOURS = 2
    const hoursSince = (hour, from) => (((hour - from) % 24) + 24) % 24
    const deepHourOf = (bedtime) => (Math.round(bedtime) + DEEP_AFTER_HOURS) % 24

    /* 连续天数：从今天往回数，memory.days 里一天不落有多长。
       用毫秒回推而不是解析日期字符串 —— dayKey() 产出的 2026-9-30 不是 ISO 形式，
       各引擎对它的解析并不一致。 */
    const dayKeyOf = (ms) => {
      try {
        const d = new Date(ms)
        return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
      } catch (e) { return 'unknown' }
    }
    const streakOf = (days) => {
      if (!Array.isArray(days) || days.length === 0) return 0
      const set = new Set(days)
      let n = 0
      let t = Date.now()
      while (n < 400 && set.has(dayKeyOf(t))) { n++; t -= 86400000 }
      return n
    }
    /* 连续天数的里程碑；到了才说一次。 */
    const STREAK_MILESTONES = [7, 30, 100, 365]

    /* 时段划分：凌晨与白天说话的口气不一样。深夜跨了两天，所以按"< 5 点"算夜里。 */
    const greetPoolName = (hour) => {
      if (hour < 5 || hour >= 22) return 'night'
      if (hour < 11) return 'morning'
      if (hour < 18) return 'afternoon'
      return 'evening'
    }
    const greetPool = (name) => (LINES[name] && LINES[name].length ? LINES[name] : LINES.hello)
    const hourNow = () => {
      try { return new Date().getHours() } catch (e) { return 12 }
    }

    const pick = (a) => a[Math.floor(Math.random() * a.length)]
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

    /* Read the clock through `window` only. The obvious `window.performance &&
       performance.now()` mixes two references: in a page they are the same
       object, but under a shell that supplies its own `window` the bare
       `performance` global can be a different — or absent — one, and then every
       deadline is computed on one time base and compared against another, so
       nothing ever comes due. */
    const nowMs = () => {
      const perf = window.performance
      return perf && typeof perf.now === 'function' ? perf.now() : Date.now()
    }

    /* ---------------------------------------------------------------------
       CONFIG — normalized and clamped on the way in.

       The config arrives from a profile YAML patch, so nothing about it is
       guaranteed: a typo yields a string where a number belongs, and an
       extreme value yields a companion nobody can find or click. Clamping
       here means a bad patch degrades into a usable wisp instead of a bug
       report.
       --------------------------------------------------------------------- */
    const num = (value, lo, hi, fallback) => {
      const n = typeof value === 'number' && isFinite(value) ? value : fallback
      return clamp(n, lo, hi)
    }
    const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

    /* One table drives both the initial normalization and the partial merge a
       runtime `configure({…})` performs, so a key can never be clamped one way
       at mount and another way later. */
    /* 音效。默认关闭；SOUNDS 由构建内联（assets/audio/*.mp3 -> data URL）。
       没有对应文件时整条路径静默返回 —— 素材可以后补，缺它不会变成坏行为。
       菜单里的开关也只在真有音效时才出现（见 menuItems），免得摆一个点了没反应的开关。 */
    const SOUNDS = (typeof __WISP_SOUNDS__ === 'object' && __WISP_SOUNDS__ !== null) ? __WISP_SOUNDS__ : {}
    const HAS_SOUNDS = Object.keys(SOUNDS).length > 0
    const audioCtor = () => {
      try { return (typeof window !== 'undefined' && typeof window.Audio === 'function') ? window.Audio : null } catch (e) { return null }
    }
    const playSound = (key) => {
      if (!HAS_SOUNDS) return
      if (typeof cfg !== 'object' || cfg === null || cfg.sound !== true) return
      const src = SOUNDS[key]
      if (typeof src !== 'string' || src === '') return
      const Ctor = audioCtor()
      if (Ctor === null) return
      try {
        const clip = new Ctor(src)
        /* 音量必须落到 [0,1] 内的有限数：给媒体元素设 NaN/Infinity 会**抛异常**，
           而这一整段是被 catch 包住的 —— 一个坏值会让音效静默消失，看起来像"开关没反应"。 */
        const volume = Number(cfg.soundVolume)
        clip.volume = isFinite(volume) ? clamp(volume, 0, 1) : 0.7
        const started = clip.play()
        if (started && typeof started.catch === 'function') started.catch(() => { /* 自动播放被拦下就作罢 */ })
      } catch (e) { /* 音效永远不该打断别的事 */ }
    }

    const CONFIG_SPEC = {
      bottom: { kind: 'num', lo: 0, hi: 4000 },
      right: { kind: 'num', lo: 0, hi: 4000 },
      size: { kind: 'num', lo: 0.4, hi: 8 },
      sleepAfterMs: { kind: 'num', lo: 5000, hi: 3600000 },
      celebrateAfterMs: { kind: 'num', lo: 0, hi: 600000 },
      chatterMs: { kind: 'num', lo: 0, hi: 3600000 },
      careAfterMs: { kind: 'num', lo: 0, hi: 86400000 },
      hungry: { kind: 'bool' },
      hungerMs: { kind: 'num', lo: 0, hi: 86400000 },
      focusMinutes: { kind: 'num', lo: 1, hi: 600 },
      lang: { kind: 'str' },
      sound: { kind: 'bool' },
      soundVolume: { kind: 'num', lo: 0, hi: 1 },
      night: { kind: 'bool' },
      bedtimeHour: { kind: 'num', lo: 0, hi: 23 },
      wakeHour: { kind: 'num', lo: 0, hi: 23 },
      nightMs: { kind: 'num', lo: 0, hi: 86400000 },
      backAfterMs: { kind: 'num', lo: 0, hi: 86400000 },
      milestones: { kind: 'bool' },
      memory: { kind: 'bool' },
      happyMs: { kind: 'num', lo: 200, hi: 10000 },
      wanderMs: { kind: 'num', lo: 5000, hi: 3600000 },
      wanderRange: { kind: 'num', lo: 0, hi: 2000 },
      reactions: { kind: 'bool' },
      motion: { kind: 'one', of: Object.keys(MOTION_AMP) },
      persist: { kind: 'bool' },
      celebrate: { kind: 'bool' },
      wander: { kind: 'bool' },
      hidden: { kind: 'bool' },
      backdrop: { kind: 'bool' },
      skin: { kind: 'str' },
    }

    const coerce = (key, value, fallback) => {
      const spec = CONFIG_SPEC[key]
      if (spec.kind === 'num') return num(value, spec.lo, spec.hi, fallback)
      if (spec.kind === 'str') return typeof value === 'string' ? value : fallback
      /* 枚举：认不出来的值一律退回 fallback。写错一个档位名不该让她变成
         "动也不动、也没有报错"的那种坏状态。 */
      if (spec.kind === 'one') return spec.of.indexOf(value) >= 0 ? value : fallback
      return bool(value, fallback)
    }

    const normalizeConfig = (config) => {
      const src = config && typeof config === 'object' ? config : {}
      const cfg = {}
      for (const key in CONFIG_SPEC) cfg[key] = coerce(key, src[key], DEFAULTS[key])
      return cfg
    }

    /* Merge only the keys the caller actually sent: `configure({size: 2})` must
       not silently reset every other preference to its default. */
    const mergeConfig = (cfg, partial) => {
      if (!partial || typeof partial !== 'object') return cfg
      for (const key in CONFIG_SPEC) {
        if (!Object.prototype.hasOwnProperty.call(partial, key)) continue
        cfg[key] = coerce(key, partial[key], cfg[key])
      }
      return cfg
    }

    /* ---------------------------------------------------------------------
       CLOCK — one scheduling surface, two implementations.

       `mode` is reported on the handle and in the mount log so a bug report can
       say which path this page took without a debugger.
       --------------------------------------------------------------------- */
    const createServiceClock = (timer) => {
      const live = []
      const track = (handle) => { live.push(handle); return handle }
      const release = (handle) => {
        const at = live.indexOf(handle)
        if (at >= 0) live.splice(at, 1)
      }
      return {
        mode: 'timer-service',
        after(ms, fn) {
          const handle = { cancelled: false, release: null }
          handle.release = timer.timeout(() => {
            handle.cancelled = true
            release(handle)
            fn()
          }, ms)
          return track(handle)
        },
        every(ms, fn) {
          const handle = { cancelled: false, release: null }
          handle.release = timer.interval(() => {
            if (!handle.cancelled) fn()
          }, ms)
          return track(handle)
        },
        cancel(handle) {
          if (!handle || handle.cancelled) return
          handle.cancelled = true
          release(handle)
          try { handle.release() } catch (e) { /* already fired */ }
        },
        dispose() {
          const pending = live.splice(0, live.length)
          for (const handle of pending) {
            handle.cancelled = true
            try { handle.release() } catch (e) { /* already fired */ }
          }
        },
      }
    }

    const createFrameClock = (win) => {
      const jobs = []
      let frame = 0

      const arm = () => {
        if (frame === 0 && jobs.length > 0) frame = win.requestAnimationFrame(tick)
      }
      const tick = () => {
        frame = 0
        const now = nowMs()
        for (let i = jobs.length - 1; i >= 0; i--) {
          const job = jobs[i]
          if (now < job.at) continue
          if (job.every > 0) job.at = now + job.every
          else { job.cancelled = true; jobs.splice(i, 1) }
          try { job.fn() } catch (e) { /* one failing job must not stop the clock */ }
        }
        arm()   // stop the loop entirely once nothing is pending
      }
      const push = (ms, fn, every) => {
        const handle = { cancelled: false, at: nowMs() + ms, fn, every: every ? ms : 0 }
        jobs.push(handle)
        arm()
        return handle
      }

      return {
        mode: 'animation-frame',
        after: (ms, fn) => push(ms, fn, false),
        every: (ms, fn) => push(ms, fn, true),
        cancel(handle) {
          if (!handle || handle.cancelled) return
          handle.cancelled = true
          const at = jobs.indexOf(handle)
          if (at >= 0) jobs.splice(at, 1)
        },
        dispose() {
          for (const job of jobs) job.cancelled = true
          jobs.length = 0
          if (frame !== 0) {
            try { win.cancelAnimationFrame(frame) } catch (e) { /* ignore */ }
            frame = 0
          }
        },
      }
    }

    const createClock = (ctx) => {
      const timer = ctx && typeof ctx.get === 'function' ? ctx.get('timer') : undefined
      if (timer && typeof timer.timeout === 'function' && typeof timer.interval === 'function') {
        return createServiceClock(timer)
      }
      return createFrameClock(window)
    }

    /* ---------------------------------------------------------------------
       STORAGE — best effort, never fatal.

       Reading `window.localStorage` itself throws on an opaque origin, which is
       exactly what the desktop shell can be: the same plugin has to survive a
       page that has no storage at all, so every access is guarded and a miss
       just means "no remembered position".
       --------------------------------------------------------------------- */
    const POSITION_KEY = 'dsh-wisp:position:v1'
    const SKIN_KEY = 'dsh-wisp:skin:v1'
    const HIDDEN_KEY = 'dsh-wisp:hidden:v1'
    const PREFS_KEY = 'dsh-wisp:prefs:v1'
    const HINT_KEY = 'dsh-wisp:hint:v1'

    const readStored = (key) => {
      try {
        const raw = window.localStorage.getItem(key)
        return raw === null ? null : JSON.parse(raw)
      } catch (e) {
        return null
      }
    }
    const writeStored = (key, value) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
        return true
      } catch (e) {
        return false
      }
    }

    /* ---------------------------------------------------------------------
       THE CSS. Three things are deliberate:

       * Colors prefer the app's own alias tokens, so the companion inherits
         whatever theme is active (including a third-party one) instead of
         hard-coding a white bubble that looks wrong in one palette. The
         token-free fallbacks are the hand-tuned pair, and
         `body[data-ds-dark-theme]` is the shell's real dark switch.

       * The bubble lives in `.wisp-layer`, NOT inside `.wisp-root`. It used to
         be a child of the root, which mirrored its text whenever she faced left
         (the root carries `scaleX(-1)`) and scaled its font with `size`. In
         screen space it stays readable and unmirrored at any size.

       * `--wisp-scale` carries the render scale for the few decorations that
         should grow with her even though the root is laid out at its final
         size rather than transform-scaled.
       --------------------------------------------------------------------- */
    const CSS = `.wisp-layer{position:fixed;inset:0;z-index:2147482000;pointer-events:none;overflow:hidden;font-family:inherit;--wisp-scale:1;--wisp-say-fg:#0d1a22;--wisp-say-bg:rgba(255,255,255,.93);--wisp-say-line:rgba(15,30,40,.10);--wisp-ink:#3b5a70}
.wisp-root{position:absolute;width:${BOX_W}px;height:${BOX_H}px;pointer-events:none;transform-origin:top center;--wisp-aura:rgba(110,200,255,.42)}
.wisp-root[data-dragging="true"]{will-change:transform}
.wisp-root[data-gliding="true"]{transition:transform 1.6s cubic-bezier(.4,0,.2,1)}
.wisp-body{position:absolute;inset:0;pointer-events:none;touch-action:none;user-select:none;-webkit-user-select:none;animation:wisp-bob 5.6s ease-in-out infinite}
/* 命中层：一个**不画任何东西**的空盒子，只负责被鼠标点到。它带一层由 alpha 蒙版
   生成的 clip-path —— 于是"透明处点不到"是**浏览器**做的，而不是 JS 事后补救：
   事件根本不会派到她身上，下面的应用照常收到 hover / 点击 / 右键 / 滚轮。
   （只写 pointer-events:none 是不够的：那只是不拦她自己的事，盒子仍然盖在应用上面。） */
.wisp-hit{position:absolute;inset:0;pointer-events:auto;cursor:grab}
.wisp-hit:active{cursor:grabbing}
.wisp-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:bottom center;filter:drop-shadow(0 6px 14px rgba(0,0,0,.30));transition:opacity .28s ease,filter .5s ease}
.wisp-shine{position:absolute;left:50%;bottom:-8px;width:68%;height:16px;margin-left:-34%;border-radius:50%;background:radial-gradient(ellipse at center,var(--wisp-aura) 0%,transparent 70%);filter:blur(4px);pointer-events:none;transition:background .5s ease}
.wisp-zzz{position:absolute;right:6px;top:8px;font-size:calc(13px * var(--wisp-scale));font-weight:600;color:var(--wisp-ink);text-shadow:0 0 8px var(--wisp-aura);animation:wisp-zzz 2.6s ease-out infinite;pointer-events:none}
.wisp-say{position:absolute;max-width:210px;width:max-content;padding:7px 11px;border-radius:12px;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-primary,var(--wisp-say-fg));background:var(--dsw-alias-bg-overlay,var(--wisp-say-bg));border:1px solid var(--dsw-alias-border-l1,var(--wisp-say-line));box-shadow:0 6px 24px rgba(0,0,0,.22);-webkit-backdrop-filter:blur(14px) saturate(160%);backdrop-filter:blur(14px) saturate(160%);animation:wisp-say 4.2s ease forwards;pointer-events:none;white-space:pre-wrap}
.wisp-root[data-mood="alert"]{--wisp-aura:rgba(255,196,92,.50)}
.wisp-root[data-mood="happy"]{--wisp-aura:rgba(255,132,206,.50)}
.wisp-root[data-mood="sleep"]{--wisp-aura:rgba(140,152,215,.30)}
body[data-ds-dark-theme] .wisp-layer{--wisp-say-fg:#eaf2f8;--wisp-say-bg:rgba(20,24,32,.88);--wisp-say-line:rgba(255,255,255,.14);--wisp-ink:#cfe6ff}
.wisp-root[data-mood="sleep"] .wisp-body{animation-duration:9s}
.wisp-root[data-mood="alert"] .wisp-body{animation-duration:4.6s}
.wisp-root[data-mood="happy"] .wisp-body{animation-name:wisp-hop;animation-duration:1.15s;animation-timing-function:ease-in-out}
.wisp-root[data-mood="sleep"] .wisp-img{filter:drop-shadow(0 6px 14px rgba(0,0,0,.25)) saturate(.82) brightness(.96)}
@keyframes wisp-bob{0%{transform:translate3d(0,0,0)}50%{transform:translate3d(0,-9px,0)}100%{transform:translate3d(0,0,0)}}
@keyframes wisp-zzz{0%{opacity:0;transform:translate(0,0) scale(.6)}30%{opacity:.9}100%{opacity:0;transform:translate(14px,-30px) scale(1.15)}}
.wisp-root[data-mood="attn"]{--wisp-aura:rgba(255,138,120,.55)}
.wisp-root[data-mood="worried"]{--wisp-aura:rgba(150,170,190,.5)}
.wisp-root[data-mood="worried"] .wisp-img{filter:drop-shadow(0 6px 14px rgba(0,0,0,.25)) saturate(.86)}
.wisp-root[data-mood="worried"] .wisp-body{animation-name:wisp-worry;animation-duration:2.4s;animation-iteration-count:3}
@keyframes wisp-worry{0%,100%{transform:translate3d(0,0,0)}50%{transform:translate3d(0,-5px,0)}}
.wisp-root[data-mood="attn"] .wisp-body{animation-name:wisp-nudge;animation-duration:1.5s;animation-iteration-count:4}
@keyframes wisp-nudge{0%,100%{transform:translate3d(0,0,0)}25%{transform:translate3d(-7px,0,0)}75%{transform:translate3d(7px,0,0)}}
@keyframes wisp-hop{0%,100%{transform:translate3d(0,0,0)}45%{transform:translate3d(0,-16px,0)}}
/* ---- 动作层（见文件上方 motion 常量处的说明）----
   两层都是**空盒子**：绝对定位铺满、不吃指针。姿势与一次性动作分别只碰自己
   那一层的 transform，所以它们永远不会互相覆盖。
   transform-origin 放在脚底：压扁是"踩在地上压下去"，侧倾是"钟摆"，不是"转盘"。 */
.wisp-motion,.wisp-lean{position:absolute;inset:0;pointer-events:none;transform-origin:50% 100%}
.wisp-lean{transform:rotate(var(--wisp-tilt,0deg));transition:transform .5s cubic-bezier(.22,1.2,.36,1)}
/* 拖动中姿势必须**跟手**：一有过渡，拖起来就像拽着一根橡皮筋。 */
.wisp-root[data-dragging="true"] .wisp-lean{transition:none}
/* 幅度档位：一个变量管住所有一次性动作的幅度（关键帧里用 calc 乘它），
   指针侧倾的幅度在 JS 里读同一张表 —— 两边不会各调各的。 */
.wisp-root{--wisp-amp:1}
.wisp-root[data-motion="subtle"]{--wisp-amp:.5}
.wisp-root[data-motion="off"]{--wisp-amp:0}
/* 静止档：连呼吸和 z 都停 —— 她说"我不想让她动"时，是最彻底的静止。 */
.wisp-root[data-motion="off"] .wisp-body,.wisp-root[data-motion="off"] .wisp-zzz{animation:none}
/* 但"不动"不等于"冻住"：动画一关，z 会停在满不透明的初始态，看起来像一个卡住的字 */
.wisp-root[data-motion="off"] .wisp-zzz{opacity:.5}
.wisp-root[data-accent="press"] .wisp-motion{animation:wisp-press .2s ease-out}
.wisp-root[data-accent="land"] .wisp-motion{animation:wisp-land .56s cubic-bezier(.2,1.15,.35,1)}
.wisp-root[data-accent="pop-a"] .wisp-motion{animation:wisp-pop-a .38s ease-out}
.wisp-root[data-accent="pop-b"] .wisp-motion{animation:wisp-pop-b .38s ease-out}
@keyframes wisp-press{0%{transform:scale(1,1)}60%{transform:scale(calc(1 + .045*var(--wisp-amp,1)),calc(1 - .06*var(--wisp-amp,1)))}100%{transform:scale(1,1)}}
@keyframes wisp-land{0%{transform:scale(calc(1 + .06*var(--wisp-amp,1)),calc(1 - .085*var(--wisp-amp,1)))}42%{transform:scale(calc(1 - .022*var(--wisp-amp,1)),calc(1 + .028*var(--wisp-amp,1)))}74%{transform:scale(calc(1 + .01*var(--wisp-amp,1)),calc(1 - .012*var(--wisp-amp,1)))}100%{transform:scale(1,1)}}
@keyframes wisp-pop-a{0%{transform:scale(1)}46%{transform:scale(calc(1 + .035*var(--wisp-amp,1)))}100%{transform:scale(1)}}
@keyframes wisp-pop-b{0%{transform:scale(1)}46%{transform:scale(calc(1 + .03*var(--wisp-amp,1)),calc(1 - .025*var(--wisp-amp,1)))}100%{transform:scale(1,1)}}
/* 菜单与级联子面板共用一套外观变量 —— 面板是菜单的"上一层"，只改阴影与浮起量。
   尺寸走**紧凑刻度**：这是陪伴插件的浮层，不该占掉屏幕的观感重心。 */
.wisp-menu{--wisp-surface:var(--dsw-alias-bg-overlay,var(--wisp-say-bg));--wisp-line:var(--dsw-alias-border-l1,var(--wisp-say-line));--wisp-hover:var(--dsw-alias-bg-layer-2,rgba(120,170,255,.2));--wisp-accent:var(--dsw-alias-brand-primary,#4a7cf7);position:absolute;min-width:164px;max-width:196px;padding:4px;border-radius:9px;font-size:11px;line-height:1.2;color:var(--dsw-alias-label-primary,var(--wisp-say-fg));background:var(--wisp-surface);border:1px solid var(--wisp-line);box-shadow:0 10px 28px rgba(0,0,0,.3);-webkit-backdrop-filter:blur(16px) saturate(160%);backdrop-filter:blur(16px) saturate(160%);pointer-events:auto;animation:wisp-menu .13s ease}
.wisp-menu-item{display:block;width:100%;padding:4px 6px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;white-space:nowrap;transition:background .1s ease,box-shadow .1s ease}
.wisp-menu-item:hover{background:var(--wisp-hover,rgba(120,170,255,.2))}
.wisp-menu-item:active{background:var(--wisp-hover,rgba(120,170,255,.2));box-shadow:inset 0 1px 2px rgba(0,0,0,.12)}
/* 键盘焦点必须是**看得见**的：这些行都是 border:0 的按钮，浏览器默认轮廓很弱。 */
.wisp-menu-item:focus-visible,.wisp-corner:focus-visible,.wisp-slider:focus-visible{outline:2px solid var(--wisp-accent,#4a7cf7);outline-offset:-2px}
.wisp-menu-head{padding:1px 6px 4px}
.wisp-menu-title{font-size:11.5px;font-weight:600;letter-spacing:.01em}
.wisp-menu-sub{font-size:9px;opacity:.6;margin-top:0}
.wisp-menu-sep{height:1px;margin:3px 4px;background:var(--wisp-line,var(--wisp-say-line));opacity:.5}
.wisp-menu-hint{padding:4px 6px 0;font-size:9px;opacity:.5;border-top:1px solid var(--wisp-line,var(--wisp-say-line));margin-top:3px}
.wisp-menu-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
/* 摘要做成胶囊：收起状态也要能一眼扫到"现在是什么"，纯淡字太弱。 */
.wisp-menu-sum{flex:0 1 auto;min-width:0;padding:0 4px;border-radius:999px;background:var(--wisp-hover,rgba(120,170,255,.2));font-size:9px;line-height:13px;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 主操作（专注）：淡色底 + 左侧强调条 + 字形，一眼看出"这是主要动作"。 */
.wisp-menu-item[data-accent="true"]{position:relative;font-weight:600;color:var(--wisp-accent,inherit);background:linear-gradient(90deg,var(--wisp-hover,rgba(120,170,255,.2)),transparent 88%)}
.wisp-menu-item[data-accent="true"]::before{content:"";position:absolute;left:2px;top:50%;width:2px;height:11px;margin-top:-5.5px;border-radius:1px;background:var(--wisp-accent,#4a7cf7)}
.wisp-menu-item[data-accent="true"]:hover{background:linear-gradient(90deg,var(--wisp-hover,rgba(120,170,255,.32)),transparent 92%)}
.wisp-menu-item[data-muted="true"]{opacity:.8}
/* 字形槽：每行都留等宽位，标签左边线才对得齐 */
.wisp-menu-glyph{display:inline-block;width:12px;margin-right:4px;text-align:center;font-size:10.5px;opacity:.72;font-weight:400}
.wisp-menu-item[data-accent="true"] .wisp-menu-glyph{opacity:1}
.wisp-menu-caret{opacity:.5;font-size:8px;flex:0 0 auto}
/* 三选一的胶囊组：选中的那颗有强调色，其余是淡底 —— 一眼看出"只能选一个、现在选的是哪个" */
.wisp-choice{display:flex;gap:2px;flex:0 0 auto;padding:1px;border-radius:999px;background:rgba(140,160,190,.18)}
.wisp-choice-opt{padding:1px 6px;border:0;border-radius:999px;background:none;color:inherit;font:inherit;font-size:9.5px;line-height:13px;cursor:pointer;opacity:.7;transition:background .1s ease,opacity .1s ease}
.wisp-choice-opt:hover{opacity:1}
.wisp-choice-opt[data-on="true"]{background:var(--wisp-accent,#4a7cf7);color:#fff;opacity:1}
.wisp-switch{flex:0 0 auto;width:22px;height:12px;border-radius:6px;background:rgba(140,160,190,.4);position:relative;transition:background .16s ease}
.wisp-switch[data-on="true"]{background:var(--wisp-accent,#4a7cf7);box-shadow:0 0 0 2px rgba(74,124,247,.14)}
.wisp-switch i{position:absolute;top:2px;left:2px;width:8px;height:8px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform .16s ease}
.wisp-switch[data-on="true"] i{transform:translateX(10px)}
.wisp-slider-row{padding:3px 6px 5px}
.wisp-slider-top{display:flex;justify-content:space-between;align-items:baseline;font-size:9.5px;opacity:.85;margin-bottom:1px}
.wisp-slider-value{font-variant-numeric:tabular-nums;opacity:.75}
.wisp-slider{position:relative;height:12px;cursor:pointer;outline:none;touch-action:none}
.wisp-slider-track{position:absolute;left:0;right:0;top:5px;height:2px;border-radius:1px;background:rgba(140,160,190,.4)}
.wisp-slider-fill{position:absolute;left:0;top:5px;height:2px;border-radius:1px;background:var(--wisp-accent,#4a7cf7)}
.wisp-slider-knob{position:absolute;top:1px;width:9px;height:9px;margin-left:-5px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.35);transition:transform .1s ease}
.wisp-slider:hover .wisp-slider-knob{transform:scale(1.15)}
.wisp-slider:active .wisp-slider-knob{transform:scale(1.25)}
/* 四个角落做成"键帽"：方位是空间的，控件也该长得像方位键。 */
.wisp-grid2{display:grid;grid-template-columns:1fr 1fr;gap:3px;padding:1px 4px 3px}
.wisp-grid2 button,.wisp-corner{display:flex;align-items:center;justify-content:center;gap:3px;padding:3px 3px;border:1px solid var(--wisp-line,var(--wisp-say-line));border-radius:5px;background:var(--wisp-hover,rgba(120,170,255,.12));color:inherit;font:inherit;font-size:9.5px;cursor:pointer;transition:background .1s ease,border-color .1s ease}
.wisp-grid2 button:hover,.wisp-corner:hover{background:var(--wisp-hover,rgba(120,170,255,.26))}
.wisp-grid2 button[data-current="true"],.wisp-corner[data-current="true"]{border-color:var(--wisp-accent,#4a7cf7);color:var(--wisp-accent,inherit);font-weight:600;box-shadow:0 0 0 1px var(--wisp-accent,#4a7cf7) inset}
.wisp-corner-glyph{font-size:10px;opacity:.7}
.wisp-root[data-hidden="true"]{display:none}
.wisp-tab{position:absolute;width:56px;height:56px;padding:0;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:16px;border:1px solid var(--dsw-alias-border-l1,var(--wisp-say-line));background:var(--dsw-alias-bg-overlay,var(--wisp-say-bg));box-shadow:0 6px 18px rgba(0,0,0,.22);cursor:pointer;pointer-events:auto;animation:wisp-menu .16s ease;transition:transform .16s ease}
.wisp-tab:hover{transform:translateY(-2px)}
.wisp-tab img{width:100%;height:100%;object-fit:contain;object-position:bottom center;pointer-events:none}
@keyframes wisp-menu{0%{opacity:0;transform:scale(.94)}100%{opacity:1;transform:scale(1)}}
@keyframes wisp-say{0%{opacity:0;transform:translate(-50%,-100%) translateY(6px) scale(.94)}12%{opacity:1;transform:translate(-50%,-100%) translateY(0) scale(1)}82%{opacity:1;transform:translate(-50%,-100%) translateY(0) scale(1)}100%{opacity:0;transform:translate(-50%,-100%) translateY(-6px) scale(.98)}}
.wisp-menu-item[data-group]{display:flex;align-items:center;justify-content:space-between;gap:10px}
.wisp-menu-caret{opacity:.55;font-size:10px;flex:0 0 auto}
/* 级联子菜单：浮在行的**右侧**（放不下时翻到左侧），不把下面的内容推下去。
   与父行顶部对齐、允许轻微重叠 —— 指针从行斜着移到面板上时不会穿出"同一区域"。 */
.wisp-submenu{--wisp-surface:var(--dsw-alias-bg-overlay,var(--wisp-say-bg));--wisp-line:var(--dsw-alias-border-l1,var(--wisp-say-line));--wisp-hover:var(--dsw-alias-bg-layer-2,rgba(120,170,255,.2));--wisp-accent:var(--dsw-alias-brand-primary,#4a7cf7);position:absolute;box-sizing:border-box;width:150px;padding:4px;border-radius:9px;font-size:11px;line-height:1.2;color:var(--dsw-alias-label-primary,var(--wisp-say-fg));background:var(--dsw-alias-bg-overlay,var(--wisp-say-bg));border:1px solid var(--dsw-alias-border-l1,var(--wisp-say-line));box-shadow:0 16px 40px rgba(0,0,0,.34),0 2px 6px rgba(0,0,0,.18);-webkit-backdrop-filter:blur(18px) saturate(170%);backdrop-filter:blur(18px) saturate(170%);pointer-events:auto;animation:wisp-fade .12s ease}
@keyframes wisp-fade{0%{opacity:0}100%{opacity:1}}
.wisp-menu-sub{padding-left:10px}
.wisp-menu-sub .wisp-menu-item{padding-left:12px;opacity:.94}
.wisp-dialog-backdrop{position:absolute;inset:0;background:rgba(6,12,26,.34);pointer-events:auto;animation:wisp-menu .16s ease}
.wisp-dialog{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(340px,calc(100vw - 28px));max-height:min(440px,calc(100vh - 36px));overflow:auto;padding:14px 14px 10px;border-radius:14px;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary,var(--wisp-say-fg));background:var(--dsw-alias-bg-overlay,var(--wisp-say-bg));border:1px solid var(--dsw-alias-border-l1,var(--wisp-say-line));box-shadow:0 18px 50px rgba(0,0,0,.34);-webkit-backdrop-filter:blur(16px) saturate(160%);backdrop-filter:blur(16px) saturate(160%);pointer-events:auto;animation:wisp-menu .16s ease}
.wisp-dialog-title{font-size:13.5px;font-weight:600;margin:0 22px 8px 0}
.wisp-dialog p,.wisp-dialog .wisp-dialog-p{margin:0 0 8px}
.wisp-dialog-x{position:absolute;right:8px;top:7px;width:22px;height:22px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;font-size:15px;line-height:1;cursor:pointer;opacity:.7}
.wisp-dialog-x:hover{opacity:1;background:var(--dsw-alias-bg-layer-2,rgba(120,170,255,.22))}
.wisp-dialog-foot{display:flex;justify-content:space-between;gap:10px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,var(--wisp-say-line));font-size:11px;opacity:.72}
.wisp-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:2px 0 6px}
.wisp-cell{display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px 2px 5px;border:1px solid transparent;border-radius:9px;background:none;color:inherit;font:inherit;font-size:10.5px;cursor:pointer}
.wisp-cell:hover{border-color:var(--dsw-alias-border-l1,var(--wisp-say-line));background:var(--dsw-alias-bg-layer-2,rgba(120,170,255,.18))}
.wisp-cell img{width:100%;height:52px;object-fit:contain;object-position:bottom center;pointer-events:none}
.wisp-credits{font-size:11px;opacity:.8;margin:6px 0 0}
.wisp-dialog-action{display:block;width:100%;margin:4px 0 2px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1,var(--wisp-say-line));border-radius:8px;background:none;color:inherit;font:inherit;cursor:pointer}
.wisp-dialog-action:hover{background:var(--dsw-alias-bg-layer-2,rgba(120,170,255,.2))}
@media (prefers-reduced-motion:reduce){.wisp-body{animation:none!important}.wisp-motion{animation:none!important}.wisp-zzz{animation:none!important;opacity:.5}.wisp-lean{transform:none!important;transition:none!important}.wisp-menu,.wisp-submenu,.wisp-switch,.wisp-switch i,.wisp-slider-knob,.wisp-menu-item,.wisp-corner{animation:none!important;transition:none!important}}`

    const installStyles = (styles) => {
      if (styles && typeof styles.insert === 'function') {
        try {
          const dispose = styles.insert(CSS)
          if (typeof dispose === 'function') return dispose
          return null
        } catch (e) { /* fall through to the owned <style> tag */ }
      }
      const head = document.head || document.documentElement
      if (!head) return null
      if (!document.getElementById('dsh-wisp-css')) {
        const tag = document.createElement('style')
        tag.id = 'dsh-wisp-css'
        tag.textContent = CSS
        head.appendChild(tag)
        return () => { if (tag.parentNode) tag.remove() }
      }
      return null
    }

    /* ---- hit testing: only her own pixels may take the pointer ----
       `.wisp-body` has to cover a whole box to be draggable, and that box is
       mostly empty: a standing figure in a 2:3 frame only fills 55-87% of the
       width (measured), and the rest is transparent margin. At the shipped size
       that margin sits over the composer, so a click aimed at Send would be
       swallowed by nothing. Sampling the sprite's alpha channel is what makes a
       large companion harmless. */
    const MASK_W = 96
    const MASK_H = 144
    const MASK_MIN_ALPHA = 16
    const masks = Object.create(null)

    /** 3x3 grow, so the hit area is never tighter than the eye expects. */
    const dilate = (src) => {
      const out = new Uint8Array(src.length)
      for (let y = 0; y < MASK_H; y++) {
        for (let x = 0; x < MASK_W; x++) {
          if (src[y * MASK_W + x] <= MASK_MIN_ALPHA) continue
          for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy
            if (ny < 0 || ny >= MASK_H) continue
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx
              if (nx < 0 || nx >= MASK_W) continue
              out[ny * MASK_W + nx] = 255
            }
          }
        }
      }
      return out
    }

    /* 经 window 取 Image，而不是裸的全局名：这个半包在壳里由 new Function 求值，
       裸名解析到的是**外层的全局作用域**，那里未必有 Image —— 实测在预检环境里就是
       `TypeError: Image is not a constructor`（点动作预览换到新精灵图键时才踩出来）。
       这个文件读时钟、读性能也是同样的规矩：一切经 window。
       两处用它：命中蒙版、以及换皮肤后的预热。 */
    const imageCtor = () => {
      if (typeof window !== 'undefined' && window && typeof window.Image === 'function') return window.Image
      if (typeof Image === 'function') return Image
      return null
    }

    const buildMask = (key, url, onReady) => {
      if (masks[key]) {
        if (typeof onReady === 'function') onReady(key)
        return
      }
      try {
        const canvas = document.createElement('canvas')
        if (!canvas || typeof canvas.getContext !== 'function') return
        const ctx = canvas.getContext('2d')
        if (!ctx || typeof ctx.drawImage !== 'function' || typeof ctx.getImageData !== 'function') return
        canvas.width = MASK_W
        canvas.height = MASK_H
        const ImageCtor = imageCtor()
        if (ImageCtor === null) return
        const probe = new ImageCtor()
        probe.onload = () => {
          try {
            ctx.drawImage(probe, 0, 0, MASK_W, MASK_H)
            const data = ctx.getImageData(0, 0, MASK_W, MASK_H).data
            const raw = new Uint8Array(MASK_W * MASK_H)
            let anyOpaque = false
            for (let i = 0; i < raw.length; i++) {
              raw[i] = data[i * 4 + 3]
              if (raw[i] > MASK_MIN_ALPHA) anyOpaque = true
            }
            // A mask with no opaque pixel at all means the draw or the read did
            // not do what we think (a cleared canvas, an unexpected format).
            // Falling back to the whole box keeps her grabbable; the alternative
            // is a companion that ignores every click.
            if (!anyOpaque) return
            // One cell of dilation: the mask is coarser than the sprite (each
            // cell is ~3.6 CSS px at the shipped size) and her widest pixels are
            // the aura, so without this a click that looks like it is on her
            // edge falls into the pass-through margin.
            masks[key] = dilate(raw)
            if (typeof onReady === 'function') onReady(key)
          } catch (e) { /* tainted or unsupported: the full box stays hittable */ }
        }
        probe.src = url
      } catch (e) { /* no canvas: the full box stays hittable */ }
    }

    /* ---------------------------------------------------------------------
       蒙版 → clip-path。

       蒙版是 96×144 的格，这里把每行连续的不透明格合并成矩形（再和上一行同列同宽的
       矩形纵向合并），输出一条 SVG path。段数通常在几十段（实测某套皮肤 40 段），
       一次设置、只在换皮肤或改大小时重算 —— 不是每帧的事。

       为什么非要交给浏览器：`pointer-events:none` 只能让她自己不拦事件，她那个
       560×840 的盒子仍然盖在应用上面 —— 事件**先派给她**，JS 再 return 已经晚了。
       有了 clip-path，命中判定在浏览器里就按她的轮廓做，透明处是真的穿透。
       --------------------------------------------------------------------- */
    const clipPathOf = (mask, width, height) => {
      if (!mask || !(width > 0) || !(height > 0)) return ''
      const rects = []
      let prev = new Map()          // 上一行里"可能继续往下长"的矩形
      for (let y = 0; y < MASK_H; y++) {
        const next = new Map()
        let x = 0
        while (x < MASK_W) {
          if (mask[y * MASK_W + x] <= MASK_MIN_ALPHA) { x++; continue }
          const start = x
          while (x < MASK_W && mask[y * MASK_W + x] > MASK_MIN_ALPHA) x++
          const key = start + ':' + (x - start)
          const carried = prev.get(key)
          if (carried && carried.y + carried.h === y) {
            carried.h++
            next.set(key, carried)
          } else {
            const rect = { x: start, y, w: x - start, h: 1 }
            rects.push(rect)
            next.set(key, rect)
          }
        }
        prev = next
      }
      if (rects.length === 0) return ''
      const sx = width / MASK_W
      const sy = height / MASK_H
      let d = ''
      for (const rect of rects) {
        const rx = (rect.x * sx).toFixed(1)
        const ry = (rect.y * sy).toFixed(1)
        const rw = (rect.w * sx).toFixed(1)
        const rh = (rect.h * sy).toFixed(1)
        d += 'M' + rx + ' ' + ry + 'h' + rw + 'v' + rh + 'h-' + rw + 'z'
      }
      return 'path("' + d + '")'
    }

    /* ---------------------------------------------------------------------
       WHAT THE APP IS DOING — read from the DOM, deliberately.

       These are facts the shell renders for its own users, so they survive DSH
       version upgrades the way an internal service contract does not.

       Cost matters here because this runs on a timer for as long as the app is
       open, and both arms were measured in Chromium on a 10k-node transcript
       (40k in brackets):

         querySelectorAll('[data-composer-input],[contenteditable="true"],textarea')
             0.33 ms (1.42 ms)   full-document COLLECTION, every tick
         querySelector('button[aria-label="…"]') x4 exact
             0.45 ms (1.86 ms)   four full traversals to find nothing, which is
                                 the usual case: the button is absent when idle
         querySelector('button[aria-label*="停止"],…*="Stop"]')
             0.27 ms (1.10 ms)   two traversals, and it also matches a label we
                                 have not seen yet — the label is localized

       So: the composer is resolved ONCE and cached, re-resolved only when the
       element leaves the document, and busy detection uses the two substring
       arms. Same reaction, roughly a third of the cost.
       --------------------------------------------------------------------- */
    const STOP_SELECTOR = 'button[aria-label*="停止"],button[aria-label*="Stop"]'

    /* Most specific hook first; the older shapes are only tried when it is
       missing, and only on the cold path. */
    const COMPOSER_HOOKS = ['[data-composer-input]', 'textarea', '[contenteditable="true"]']
    const MISS_RETRY_POLLS = 4

    const agentIsBusy = () => !!document.querySelector(STOP_SELECTOR)

    /* ---------------------------------------------------------------------
       "在等你动手" —— 三个面板各自用 data-* key 标注，语言无关：
         [data-question-key]       Agent 提问了，等你回答
         [data-plan-review-key]    计划待你确认
         [data-approval-key]       工具授权待你批准
       元素只在真的有待处理项时才渲染，所以"存在"本身就是信号；key 用来区分
       "新的一件事" —— 同一件事不重复提醒，换了一件才再说一次。
       --------------------------------------------------------------------- */
    const PENDING_ATTRS = ['data-question-key', 'data-plan-review-key', 'data-approval-key']
    const PENDING_SELECTOR = PENDING_ATTRS.map((a) => '[' + a + ']').join(',')

    const readPending = () => {
      let el = null
      try { el = document.querySelector(PENDING_SELECTOR) } catch (e) { return null }
      if (!el || typeof el.getAttribute !== 'function') return null
      for (let i = 0; i < PENDING_ATTRS.length; i++) {
        const value = el.getAttribute(PENDING_ATTRS[i])
        if (value) return value
      }
      return 'pending'
    }

    /* ---------------------------------------------------------------------
       出错的行。DSH 给失败的工具行与命令卡都标了 data-error="true"（ui-tool 的
       ToolRow、ui-chat 的 GenericCommandCard），所以存在性就是信号。

       但这是全文档扫描，不能放进每 1.2 秒的轮询里 —— 那会把"空闲时 0 次
       querySelectorAll"的性能结论作废。只在"一轮刚跑完"的那一刻查一次：错误
       只会出现在那个时刻，而且一轮一次，摊到整场会话可以忽略。
       --------------------------------------------------------------------- */
    const ERROR_SELECTOR = '[data-error="true"]'

    /* 插件在这个页面里用到的主题令牌。doctor() 会把它们逐个读出来 —— 全为空说明
       壳的主题层没起来，亮暗跟随会退化成默认色。 */
    const THEME_TOKENS = [
      '--dsw-alias-label-primary',
      '--dsw-alias-bg-overlay',
      '--dsw-alias-border-l1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-brand-primary',
    ]
    const countErrors = () => {
      try {
        const found = document.querySelectorAll(ERROR_SELECTOR)
        return found && typeof found.length === 'number' ? found.length : 0
      } catch (e) {
        return 0
      }
    }

    let composerEl = null
    let composerMisses = 0

    const composerHasText = () => {
      if (composerEl === null || composerEl.isConnected === false) {
        // The precise hook is probed every tick while unresolved — it is one
        // early-exit query, and a composer that has just appeared (a session was
        // opened) must not wait seconds to be noticed.
        composerEl = document.querySelector(COMPOSER_HOOKS[0])
        if (composerEl === null && composerMisses++ % MISS_RETRY_POLLS === 0) {
          // The pre-`data-composer-input` shapes match any rich-text editor on
          // the page, so they are only worth probing occasionally.
          for (let i = 1; i < COMPOSER_HOOKS.length && composerEl === null; i++) {
            composerEl = document.querySelector(COMPOSER_HOOKS[i])
          }
        }
      }
      if (composerEl === null) return false
      composerMisses = 0
      const text = composerEl.tagName === 'TEXTAREA' ? composerEl.value : composerEl.textContent
      return !!(text && text.trim().length > 0)
    }

    const mount = (config, ctx) => {
      const cfg = normalizeConfig(config)
      /* 配置里"显式写了 size"与"用了默认值"必须区分开：前者该压过记忆里的尺寸，
         后者不该 —— 否则用户在菜单里调好的大小会被默认值悄悄顶掉。 */
      const sizeIsExplicit = !!config && typeof config === 'object'
        && Object.prototype.hasOwnProperty.call(config, 'size') && config.size !== undefined
      const clock = createClock(ctx)
      const styleDispose = installStyles(ctx && typeof ctx.get === 'function' ? ctx.get('styles') : undefined)


      const vw = () => window.innerWidth || 1400
      const vh = () => window.innerHeight || 900
      /* The box she OCCUPIES is the base box times the render scale, and every
         clamp and placement below goes through these two. Clamping against the
         unscaled box let a scaled wisp hang off the edge with her drag area in
         the wrong place — invisible at size 1, obvious at any other. */
      const boxW = () => BOX_W * cfg.size
      const boxH = () => BOX_H * cfg.size

      /* ---------------------------------------------------------------------
         让窗口的 DWM 背景材质露出来（cfg.backdrop，默认关）

         "壁纸透过来"有两条完全不同的路：

           1) 整窗 alpha —— SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA)。
              桌面**不模糊**地透过来，因为它是把整窗表面乘一个系数再叠上去。
              代价：窗内**每一个像素**都被乘掉 —— 包括她的精灵图，所以她会跟着一起透。
              这是 `dsh-transparent` 的默认做法（alpha 默认 215）。

           2) DWM 背景材质 —— DwmSetWindowAttribute(hwnd, 38, Mica|Acrylic)。
              只有**窗口背景**是壁纸，窗内内容（文字、面板、她）保持不透明。
              这正是"壁纸可见 + 她实心"，两条要求同时成立。

         2 的唯一前提：页面在背景处**不画不透明像素**。若应用自己在整个视口上铺了一层底色，
         Mica 就被整块挡住 —— 这时把那层底色清掉即可，Mica 自然露出来。

         为什么由她来做这件事：她要的是"自己不受整窗 alpha 影响"，而唯一能同时满足
         "壁纸可见"的机制就是 2；把 2 卡住的那层底色清掉，是她能自己完成的最小改动，
         不需要去改另一个插件的任何一行。
         --------------------------------------------------------------------- */
      const BACKDROP_STYLE_ID = 'wisp-backdrop'

      /* 只处理"铺满视口"的元素：采样点上最上面那个画底色的，且尺寸接近整个视口。
         有尺寸下限，所以内容卡片、气泡、菜单都不会被误伤。 */
      const findBackdropBlockers = () => {
        const selectors = new Set()
        const blockers = []
        const skipped = []
        const errors = []
        const seenEls = new Set()
        if (typeof document.elementsFromPoint !== 'function') return { selectors: [], blockers, skipped, errors }
        const spots = [[0.5, 0.5], [0.2, 0.5], [0.8, 0.5], [0.5, 0.85]]
        for (const [fx, fy] of spots) {
          let stack = []
          try { stack = document.elementsFromPoint(vw() * fx, vh() * fy) || [] } catch (e) { continue }
          for (const el of stack) {
            if (!el || el === document.documentElement || el === document.body) continue
            if (seenEls.has(el)) continue          // 同一个元素会在多个采样点上出现，只记一次
            seenEls.add(el)
            let bg
            let rect
            try {
              bg = window.getComputedStyle(el).backgroundColor
              rect = el.getBoundingClientRect()
            } catch (e) { continue }
            if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') continue
            if (rect.width < vw() * 0.8 || rect.height < vh() * 0.3) continue
            blockers.push({ background: bg, size: Math.round(rect.width) + 'x' + Math.round(rect.height) })
            /* 类名要能安全地写进选择器：带数字开头的哈希类名（CSS 里得转义）直接跳过，
               宁可漏掉一层也不要写出无效规则把整张样式表毁掉。 */
            const cls = String(el.className || '').split(/\s+/).filter(Boolean)[0]
            if (cls && /^-?[_a-zA-Z][-_a-zA-Z0-9]*$/.test(cls)) selectors.add(cls)
            else if (cls) skipped.push(cls)
            break          // 只看每个采样点上最上面那一层
          }
        }
        return { selectors: [...selectors], blockers, skipped, errors }
      }

      const removeBackdropStyle = () => {
        try {
          const tag = document.getElementById(BACKDROP_STYLE_ID)
          if (tag && tag.parentNode) tag.parentNode.removeChild(tag)
        } catch (e) { /* ignore */ }
      }

      const applyBackdrop = () => {
        const report = { enabled: !!cfg.backdrop, cleared: [], blockers: [], skipped: [], errors: [] }
        /* 关掉开关要把已经注入的规则收回 —— 否则"关掉"只是不再新增，页面上还留着上一次的改动。 */
        if (!report.enabled) { removeBackdropStyle(); return report }
        const found = findBackdropBlockers()
        report.blockers = found.blockers
        report.skipped = found.skipped
        report.errors = found.errors
        /* 只在开关打开时打一行：这个功能的成败取决于"页面上到底有没有挡路的底色"，
           而那件事只有页面自己知道 —— 说出来，否则"壁纸没回来"就无从判断是哪一步没成。 */
        if (typeof console !== 'undefined' && console.log) {
          console.log('[wisp] backdrop: ' + (found.selectors.length
            ? '清掉 ' + found.selectors.length + ' 层铺满视口的底色 ' + JSON.stringify(found.selectors)
              + (found.blockers[0] ? '（原色 ' + found.blockers[0].background + '）' : '')
            : '没找到铺满视口的不透明底色 —— 挡路的另有其人，或 Mica 本身不生效')
            + (found.errors.length ? '；扫描报错 ' + JSON.stringify(found.errors) : ''))
        }
        if (found.selectors.length === 0) return report
        const css = found.selectors
          .map((c) => '.' + c + '{background-color:transparent !important;background-image:none !important}')
          .join('')
        let tag = document.getElementById(BACKDROP_STYLE_ID)
        if (!tag) {
          tag = document.createElement('style')
          tag.id = BACKDROP_STYLE_ID
          document.head.appendChild(tag)
        }
        tag.textContent = css
        report.cleared = found.selectors
        return report
      }
      let backdropReport = applyBackdrop()

      /* 菜单里调过的大小要活过刷新 —— 位置/皮肤/隐藏都记了，尺寸没记会显得前后
         不一致。但配置里显式写了 size 时以配置为准（那是项目级的设定，比一次
         临时缩放更权威）。 */
      if (!sizeIsExplicit && cfg.persist) {
        const prefs = readStored(PREFS_KEY)
        if (prefs && typeof prefs.size === 'number' && isFinite(prefs.size)) {
          cfg.size = num(prefs.size, CONFIG_SPEC.size.lo, CONFIG_SPEC.size.hi, cfg.size)
        }
      }

      const maxX = () => Math.max(0, vw() - boxW())
      const maxY = () => Math.max(0, vh() - boxH())
      const halfSay = () => Math.min(SAY_MAX_W / 2, Math.max(0, (vw() - 20) / 2))

      const layer = document.createElement('div')
      layer.className = 'wisp-layer'
      /* Critical layout is written INLINE as well as in the stylesheet.
         A `position: static` div appended to <body> is an in-flow block, and a
         non-absolute <img> is an in-flow replaced element — either one can make
         the whole page scrollable if the stylesheet is not applied yet (or at
         all) when this mounts, which is exactly what boot-time mounting risks.
         Inline styles cannot be missing. */
      layer.style.position = 'fixed'
      layer.style.top = '0'
      layer.style.left = '0'
      layer.style.right = '0'
      layer.style.bottom = '0'
      layer.style.overflow = 'hidden'
      layer.style.pointerEvents = 'none'
      layer.style.zIndex = '2147482000'

      const root = document.createElement('div')
      root.className = 'wisp-root'
      root.dataset.mood = 'idle'
      root.style.position = 'absolute'
      root.style.pointerEvents = 'none'
      root.style.transformOrigin = 'top center'

      /* Restore where she was left, clamped into the current viewport: the
         window may well have been resized (or moved to another monitor) since
         the position was written. */
      const stored = cfg.persist ? readStored(POSITION_KEY) : null
      const coords = { x: 0, y: 0 }
      if (stored && isFinite(stored.x) && isFinite(stored.y)) {
        coords.x = clamp(stored.x, 0, maxX())
        coords.y = clamp(stored.y, 0, maxY())
      } else {
        coords.x = clamp(vw() - cfg.right - boxW(), 0, maxX())
        coords.y = clamp(vh() - cfg.bottom - boxH(), 0, maxY())
      }

      /* 皮肤：优先用配置里点名的（必须存在），否则用上次选的，再否则用第一套。
         记忆的皮肤名可能属于一个已经不再随包发布的皮肤，所以必须校验。 */
      const storedSkin = cfg.persist ? readStored(SKIN_KEY) : null
      let activeSkin = SKIN_IDS[0]
      if (typeof cfg.skin === 'string' && SKIN_IDS.indexOf(cfg.skin) >= 0) activeSkin = cfg.skin
      else if (storedSkin && typeof storedSkin.id === 'string' && SKIN_IDS.indexOf(storedSkin.id) >= 0) activeSkin = storedSkin.id

      /* The root is LAID OUT at its final size rather than transform-scaled:
         a scaled layer is rasterized once and then stretched, so an enlarged
         sprite goes soft, whereas a laid-out box rasterizes the 512px source at
         the size it is actually drawn at. Only the left/right mirror stays a
         transform. `transform-origin` is the top CENTRE so mirroring happens in
         place — with the old `top left` origin she jumped a full box width to
         the left the moment she crossed the midline. */
      root.style.width = Math.round(boxW()) + 'px'
      root.style.height = Math.round(boxH()) + 'px'
      layer.style.setProperty('--wisp-scale', String(cfg.size))

      /* ---- the speech bubble lives in screen space (see the CSS note) ---- */
      let sayEl = null
      const placeSay = () => {
        if (sayEl === null) return
        const half = halfSay()
        const centre = coords.x + boxW() / 2
        const upper = Math.max(half + 10, vw() - half - 10)
        sayEl.style.left = Math.round(Math.min(Math.max(centre, half + 10), upper)) + 'px'
        // The bubble hangs ABOVE this anchor, so it needs clearance: at a size
        // where she is pinned to the top of the viewport the anchor would sit at
        // y=0 and the bubble would render entirely off-screen.
        sayEl.style.top = Math.round(Math.max(coords.y, SAY_CLEARANCE)) + 'px'
      }

      /* ---- 姿势角 --------------------------------------------------------
         tiltScreen 是**屏幕坐标**里的角度：正数 = 顶朝右。
         但她在左半边时整个 root 是镜像的（scaleX(-1)），镜像会把里面的旋转
         一起翻过去 —— 所以写进样式前先乘一次 facing。少了这一步，"她朝指针
         倾"在她跨过屏幕中线之后会变成朝反方向倾，而且只在半张屏幕上错。
         它必须写在 paint() 里，因为 facing 只在 paint() 里算。 */
      let tiltScreen = 0
      let tiltWritten = null
      let facingNow = 1
      const applyTilt = () => {
        const text = (Math.round(tiltScreen * facingNow * 10) / 10) + 'deg'
        if (text === tiltWritten) return          // 同一个值不重复写：写一次就是一次样式重算
        tiltWritten = text
        root.style.setProperty('--wisp-tilt', text)
      }

      const paint = () => {
        const facing = coords.x + boxW() / 2 < vw() / 2 ? -1 : 1
        // The translate places the box's TOP-LEFT corner, so it is `coords.x`,
        // NOT `coords.x + boxW()/2`: a translation is origin-independent, and
        // feeding it a centre offset put the whole box half a box-width to the
        // right, off the edge of the viewport. The mirror still pivots in place
        // because `transform-origin` is the top CENTRE.
        facingNow = facing
        root.style.transform = 'translate3d(' + coords.x + 'px,' + coords.y + 'px,0) scaleX(' + facing + ')'
        applyTilt()
        placeSay()
      }
      paint()

      const bodyEl = document.createElement('div')
      bodyEl.className = 'wisp-body'
      bodyEl.style.position = 'absolute'
      bodyEl.style.top = '0'
      bodyEl.style.left = '0'
      bodyEl.style.right = '0'
      bodyEl.style.bottom = '0'
      bodyEl.style.pointerEvents = 'none'
      bodyEl.setAttribute('role', 'button')
      /* tabindex 是 0 而不是 -1：菜单已经支持键盘导航（↑↓/Home/End/Esc），但如果她本身
         不可聚焦，键盘用户就**没有办法打开它** —— 声明了 role="menu" 却没有入口，与
         "声明了 role 却按不动"是同一类问题。她挂在 body 末尾，所以 Tab 顺序上排在应用
         内容之后，不会插队。 */
      bodyEl.setAttribute('tabindex', '0')
      bodyEl.setAttribute('aria-label', 'DeepSeek娘')
      bodyEl.setAttribute('aria-haspopup', 'menu')

      /* 命中层（见 clipPathOf 上面的说明）：空盒子 + 由蒙版生成的 clip-path。
         关键样式同样行内再写一遍 —— 样式表缺失时它必须仍然是"铺满、吃指针"的那个。 */
      const hitEl = document.createElement('div')
      hitEl.className = 'wisp-hit'
      hitEl.setAttribute('aria-hidden', 'true')
      hitEl.style.position = 'absolute'
      hitEl.style.top = '0'
      hitEl.style.left = '0'
      hitEl.style.right = '0'
      hitEl.style.bottom = '0'
      hitEl.style.pointerEvents = 'auto'
      hitEl.style.cursor = 'grab'

      /* 动作层（见文件上方 motion 常量处的说明）：两个空盒子，把"姿势"与
         "一次性动作"从情绪动画里分出来。关键样式同样**行内再写一遍** ——
         理由和 layer/root 一样：样式表缺失时它们是 position:static 的普通
         div，会把精灵图挤成两个叠着的方块。 */
      const motionEl = document.createElement('div')
      motionEl.className = 'wisp-motion'
      const leanEl = document.createElement('div')
      leanEl.className = 'wisp-lean'
      for (const box of [motionEl, leanEl]) {
        box.style.position = 'absolute'
        box.style.top = '0'
        box.style.left = '0'
        box.style.right = '0'
        box.style.bottom = '0'
        box.style.pointerEvents = 'none'
        /* 旋转/压扁的原点在脚底：否则侧倾像转盘，压扁像从头顶往下缩。 */
        box.style.transformOrigin = '50% 100%'
      }

      const shine = document.createElement('div')
      shine.className = 'wisp-shine'

      const img = document.createElement('img')
      img.className = 'wisp-img'
      img.style.position = 'absolute'
      img.style.top = '0'
      img.style.left = '0'
      img.style.width = '100%'
      img.style.height = '100%'
      img.style.objectFit = 'contain'
      img.style.objectPosition = 'bottom center'
      img.alt = ''
      img.draggable = false
      img.decoding = 'async'
      img.onerror = () => {
        if (typeof console !== 'undefined' && console.error) console.error('[wisp] sprite failed to load')
      }
      let currentSprite = 'idle'
      /* 皮肤：一套完整的 idle/happy/sleepy/work。activeSkin 随配置与记忆恢复，
         切换时只需要重建精灵图与命中蒙版，位置和状态都不动。 */
      /* 一套皮肤若不包含某个情绪（例如将来只给了四张），退到备选而不是空白 */
      const spriteOf = (key) => {
        const skin = SPRITES[activeSkin]
        if (skin && typeof skin[key] === 'string') return skin[key]
        const alt = SPRITE_FALLBACK[key]
        if (alt && typeof skin[alt] === 'string') return skin[alt]
        return skin.idle
      }

      /* 把当前精灵图的蒙版变成命中层的形状。蒙版是异步来的（图片解码完才有），
         所以它由 buildMask 的回调触发；换皮肤、改大小的时候各再调一次。 */
      let hitClip = null
      const applyHitClip = (key) => {
        if (key !== currentSprite) return            // 过期的回调：那张图已经不是现在这张
        const mask = masks[activeSkin + '/' + key]
        const path = mask ? clipPathOf(mask, boxW(), boxH()) : ''
        if (path === hitClip) return                 // 同一个形状不重复写
        hitClip = path
        hitEl.style.clipPath = path
        hitEl.style.webkitClipPath = path
      }

      const setSprite = (key) => {
        currentSprite = key
        const url = resolveSprite(spriteOf(key))
        buildMask(activeSkin + '/' + key, url, () => applyHitClip(key))
        currentSprite = key
        /* Cross-fade rather than swapping `src` outright: a hard swap makes every
           mood change read as a glitch. The outgoing sprite keeps its own layer
           for the length of the fade, then is removed. */
        const previous = img.src
        if (!previous || previous === url) {
          img.src = url
          img.style.opacity = '1'
          return
        }
        const outgoing = document.createElement('img')
        outgoing.className = 'wisp-img'
        outgoing.style.position = 'absolute'
        outgoing.style.top = '0'
        outgoing.style.left = '0'
        outgoing.style.width = '100%'
        outgoing.style.height = '100%'
        outgoing.style.objectFit = 'contain'
        outgoing.style.objectPosition = 'bottom center'
        outgoing.style.opacity = '1'
        outgoing.draggable = false
        outgoing.setAttribute('aria-hidden', 'true')
        outgoing.src = previous
        leanEl.insertBefore(outgoing, img)
        img.src = url
        img.style.opacity = '0'
        clock.after(16, () => {
          if (destroyed) return
          img.style.opacity = '1'
          outgoing.style.opacity = '0'
        })
        clock.after(340, () => { if (outgoing.parentNode) outgoing.parentNode.removeChild(outgoing) })
      }

      /* 结构：body（情绪动画）> motion（一次性动作）> lean（姿势）> shine/img，
      外加一个兄弟节点 hit（命中层）。 */
      /* 光晕（脚底那圈光）挂在 motion 层、**不在 lean 层**：它是地面上的东西，
         不该跟着她的侧身一起歪 —— 挂在 lean 里的时候，她一倾斜光圈也跟着转，
         看起来像地板歪了。但按下/落地那一下的压扁它该跟着（那是"她压在地上"），
         所以留在 motion 层而不是提到 body 层。 */
      motionEl.appendChild(shine)
      leanEl.appendChild(img)
      motionEl.appendChild(leanEl)
      bodyEl.appendChild(motionEl)
      bodyEl.appendChild(hitEl)
      root.appendChild(bodyEl)
      layer.appendChild(root)
      setSprite('idle')

      let destroyed = false
      let attached = false
      let attachAttempts = 0

      const attach = () => {
        if (destroyed || attached) return
        if (!document.body) {
          // The client half can in principle run before <body> exists; a bounded
          // retry beats both a crash and an unbounded poll.
          if (attachAttempts++ < 60) clock.after(50, attach)
          else if (console && console.error) console.error('[wisp] document.body never appeared')
          return
        }
        /* 挂载前先清掉页面上任何**残留的旧层**。
           只靠 `window.__wisp` 那一个句柄是不够的：那个引用可能属于另一个上下文/另一次加载，
           于是旧层留在页面上、新层再叠一层 —— 表现就是"出现了两个她"。
           她只有一个，这件事不该依赖任何一本书里记着的引用。 */
        try {
          const strays = document.querySelectorAll('.wisp-layer')
          for (let i = 0; i < strays.length; i++) {
            const el = strays[i]
            if (el && el !== layer && el.parentNode) el.parentNode.removeChild(el)
          }
        } catch (e) { /* 清不掉也不该挡住挂载 */ }
        document.body.appendChild(layer)
        attached = true
      }

      /* ---- mood -> sprite ----
         attn 曾借用 work 那张，现在有自己的一张（抬手招你过来的姿态）。
         仍然保留回退：某一套皮肤将来若没有 attn，她会退回 work，而不是变成空白。 */
      /* report = 抱着记录本汇报的姿势（值班汇报 / 今日小结 / 专注结束用它）。
         素材还没生成时由 SPRITE_FALLBACK 退回 idle —— 不会出现空白或坏图。 */
      const SPRITE_OF = { idle: 'idle', alert: 'work', happy: 'happy', sleep: 'sleepy', attn: 'attn', care: 'attn', poked: 'poked', proud: 'proud', worried: 'sleepy', eat: 'eat', report: 'report' }
      const SPRITE_FALLBACK = { attn: 'work', report: 'idle' }
      let mood = 'idle'

      /* 换皮肤 = 换一整套精灵图。位置、情绪、气泡都不动，只有图与命中蒙版重建。 */
      const skinLabel = (id) => SKIN_LABELS[id] ?? id
      const applySkin = (id) => {
        if (destroyed || typeof id !== 'string') return false
        if (SKIN_IDS.indexOf(id) < 0) return false      // 不认识的名字就当作没这回事
        const changed = id !== activeSkin
        /* 只有**换到不同**的一套才算一次使用：初始皮肤是直接赋值进来的，不走这个函数；
           setSkin 传同一个 id 也不该计数。（这里用 changed —— 别再写一个不存在的变量名。） */
        if (changed) bump(memory.skins, id)
        activeSkin = id
        writeStored(SKIN_KEY, { id })
        if (changed) setSprite(SPRITE_OF[mood])
        return true
      }

      /* ---- 动作层的三个入口 -------------------------------------------------
         amp()    ：幅度档位（full 1 / subtle .5 / off 0），CSS 那边读的是同一个
                    区间 —— 关键帧里用 calc 乘 --wisp-amp，指针侧倾在这里乘。
         reduced()：prefers-reduced-motion。CSS 已经把动画关掉了，但**姿势是 JS
                    写进去的**，样式表关不掉它，所以这里必须再问一次系统。
                    matchMedia 不存在的壳里返回 false：拿不到就不假装系统说了什么。
         accent() ：放一次"一次性动作"。它只写一个属性，什么时候收手由这里的
                    时钟决定（CSS 只管怎么动）—— 所以不会出现"动画早放完了、
                    属性还挂着"那种半截状态。 */
      let reducedMql = null
      const reduced = () => {
        try {
          if (reducedMql === null && typeof window.matchMedia === 'function') {
            reducedMql = window.matchMedia('(prefers-reduced-motion: reduce)')
          }
          return !!(reducedMql && reducedMql.matches)
        } catch (e) { return false }
      }
      const amp = () => {
        const value = MOTION_AMP[cfg.motion]
        return typeof value === 'number' ? value : 1
      }

      let accentHandle = null
      let accentFlip = false
      const accent = (name) => {
        if (destroyed) return
        /* 静止档与"系统要求别动"都不放动作。CSS 那边也关着（媒体查询 +
           --wisp-amp:0），但**属性本身也不该被写上** —— 否则 doctor() 会报一个
           根本没发生的动作，读代码的人也会以为这条路是活的。 */
        if (amp() === 0 || reduced()) return
        /* pop-a / pop-b 是同一件事的两个名字。**同一个值再写一次不会重播动画**，
           而连戳两下必须看到两次弹 —— 换名字是这里最可靠的强制重播办法
           （靠读一次 offsetWidth 强制重排也能做到，但那要在替身里也装一个
           布局引擎，而替身没有布局）。 */
        const value = name === 'pop'
          ? ((accentFlip = !accentFlip) ? 'pop-b' : 'pop-a')
          : name
        root.dataset.accent = value
        if (accentHandle) clock.cancel(accentHandle)
        accentHandle = clock.after(ACCENT_MS[name] || 400, () => {
          accentHandle = null
          if (!destroyed) delete root.dataset.accent
        })
      }

      /* 姿势：° 是**屏幕坐标**里的角度（正 = 顶朝右），乘镜像由 applyTilt 做。
         这里是所有姿势的唯一闸门 —— 静止档与"系统要求别动"都在这一个地方归零，
         调用点不必各自记得判断。 */
      const setTilt = (deg) => {
        const next = (amp() === 0 || reduced()) ? 0 : clamp(deg, -TILT_DRAG_MAX, TILT_DRAG_MAX)
        if (Math.abs(next - tiltScreen) < TILT_STEP) return
        tiltScreen = next
        applyTilt()
      }

      /* 档位改动要**当场**生效，不用刷新：属性一改，CSS 那边的全部幅度规则
         （关键帧里的 --wisp-amp、静止档关掉呼吸与 z）立刻跟上。
         另外把姿势归零 —— 从"灵动"切到"静止"时她还歪着，就成了半截状态。 */
      const applyMotion = () => {
        root.dataset.motion = cfg.motion
        if (amp() === 0 || reduced()) setTilt(0)
      }
      applyMotion()

      const setMood = (next) => {
        if (destroyed) return
        if (mood === next) return
        mood = next
        root.dataset.mood = next
        /* 换表情 = 弹一下（只给有表情的那几个状态配，理由见 POPPY_MOODS）。
           它必须在"真的换了表情"**之后**：`attn` 也在 POPPY_MOODS 里，而
           poll 只要看到待处理面板就每一轮重算 setMood('attn') —— 放在去重之前，
           她会在你盯着审批卡片等的时候每 1.2 秒抽一下（真机上 6 秒 5 次）。
           "连戳两下第二下也要弹"是**手势**的要求，由 flashHappy/flashPoked
           自己补（见那两处），不该让稳态重算也走这条路。 */
        if (POPPY_MOODS.indexOf(next) >= 0) accent('pop')
        /* 睡着时不该还朝着你的指针倾 —— 那和一个"睡着了还跟着你转头"的人一样怪。
           在**进入** sleep 时归零，而不是在指针处理器里每帧都判一次。 */
        if (next === 'sleep') setTilt(0)
        const want = SPRITE_OF[next] || 'idle'
        if (want !== currentSprite) setSprite(want)
        const zs = root.querySelectorAll('.wisp-zzz')
        for (let i = zs.length - 1; i >= 0; i--) zs[i].remove()
        if (next === 'sleep') {
          const z1 = document.createElement('div'); z1.className = 'wisp-zzz'; z1.textContent = 'z'
          const z2 = document.createElement('div'); z2.className = 'wisp-zzz'; z2.textContent = 'z'
          z2.style.right = '24px'; z2.style.top = '-2px'; z2.style.animationDelay = '1.1s'
          root.appendChild(z1); root.appendChild(z2)
        }
      }

      /* 气泡也挂在 layer 上，所以躲起来时必须单独收掉 —— 只把 root 设成
         display:none 的话，会留下一个悬空的气泡在屏幕上。 */
      const clearSay = () => {
        if (sayHandle) { clock.cancel(sayHandle); sayHandle = null }
        if (sayEl !== null && sayEl.parentNode) sayEl.remove()
        sayEl = null
      }

      let sayHandle = null
      const say = (text) => {
        if (destroyed) return
        if (sayEl !== null && sayEl.parentNode) sayEl.remove()
        const el = document.createElement('div')
        el.className = 'wisp-say'
        el.style.position = 'absolute'
        /* 气泡的淡出时长跟着**它的寿命**走，而不是跟着样式表里那个数：
           两边各写一份就会漂（样式表里写 4.2s、代码里活 4.4s —— 气泡会提前
           200ms 淡完再干等）。和 ACCENT_MS 一个道理：CSS 管怎么动，代码管多久。 */
        el.style.animationDuration = (SAY_MS / 1000) + 's'
        el.textContent = text
        // Into the LAYER, not the root: a child of the root would be mirrored
        // with her and scaled by `size`.
        layer.appendChild(el)
        sayEl = el
        placeSay()
        if (sayHandle) clock.cancel(sayHandle)
        sayHandle = clock.after(SAY_MS, () => {
          if (sayEl === el) sayEl = null
          if (el.parentNode) el.remove()
        })
      }

      /* ---- idle / wake ----
         The sleep deadline is re-armed at most once a second. pointermove can
         fire over a hundred times a second, and cancelling plus recreating a
         timer for each of those is pure overhead for a decision whose real
         resolution is ninety seconds. */
      let sleepHandle = null
      let lastWakeAt = 0
      const armSleep = () => {
        if (sleepHandle) clock.cancel(sleepHandle)
        sleepHandle = clock.after(cfg.sleepAfterMs, () => {
          sleepHandle = null
          if (destroyed) return
          setMood('sleep')
          if (Math.random() < 0.6) say(pick(LINES.sleep))
        })
      }
      const wake = (force) => {
        if (destroyed) return
        const now = nowMs()
        if (!force && now - lastWakeAt < WAKE_THROTTLE_MS) return
        lastWakeAt = now
        if (mood === 'sleep') {
          setMood('idle')
          if (Math.random() < 0.5) say(pick(LINES.wake))
        }
        armSleep()
      }
      const WAKE_EVENTS = ['pointerdown', 'keydown', 'wheel', 'pointermove']
      for (const ev of WAKE_EVENTS) window.addEventListener(ev, wake, { passive: true })

      /* ---- theme: follow the shell's own light/dark decision ---- */
      const themeService = ctx && typeof ctx.get === 'function' ? ctx.get('theme') : undefined
      let offTheme = null
      const applyTheme = (snapshot) => {
        const scheme = snapshot && snapshot.active && snapshot.active.colorScheme === 'dark' ? 'dark' : 'light'
        root.dataset.wispTheme = scheme
      }
      if (themeService && typeof themeService.getTheme === 'function') {
        try { applyTheme(themeService.getTheme()) } catch (e) { /* the CSS fallback still applies */ }
      }
      if (ctx && typeof ctx.on === 'function') {
        try {
          offTheme = ctx.on('theme/change', (snapshot) => {
            try { applyTheme(snapshot) } catch (e) { /* ignore a malformed snapshot */ }
          })
        } catch (e) { offTheme = null }
      }

      /* ---- 今日轮次：里程碑 --------------------------------------------------
         她数的是"今天跑完多少轮"，所以要跨刷新记住。按天存：换了一天就归零，
         但**记过的里程碑也要一起存** —— 否则同一天里刷新页面会把 10、25 又说一遍。
         这里用真实日期（new Date()）而不是插件时钟：问的是"今天"，不是"这次页面开了多久"。 */
      const RUNS_KEY = 'dsh-wisp:runs:v1'
      const MILESTONES = [10, 25, 50, 100, 200, 500]
      const dayKey = () => {
        try {
          const d = new Date()
          return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
        } catch (e) { return 'unknown' }
      }
      let runsToday = (() => {
        const stored = readStored(RUNS_KEY)
        const today = dayKey()
        if (stored && typeof stored === 'object' && stored.day === today && typeof stored.count === 'number') {
          return { day: today, count: stored.count, said: Array.isArray(stored.said) ? stored.said : [] }
        }
        return { day: today, count: 0, said: [] }
      })()

      /* ---- 她记着你 --------------------------------------------------------
         存的是"一起多少天 / 常放哪个角 / 常穿哪套"，以及**已经说过哪些**。
         两条防噪规则是有意的：
           1) 同一条记忆一辈子只说一次（said 里记着）；
           2) 一天最多说一句（remarkDay）。
         没有这两条，这些台词会在每次刷新时重复出现，很快就会从"她记得"变成"她唠叨"。 */
      const MEMORY_KEY = 'dsh-wisp:memory:v1'
      const MEMORY_MAX_DAYS = 90          // 别让这个记录无限长下去
      const DAY_MILESTONES = [2, 7, 14, 30, 100]
      const HABIT_MIN = 8                 // 一个角落至少用过这么多次才算"习惯"
      const HABIT_SHARE = 0.6             // 而且要占大多数
      const SKIN_MIN = 6

      const memory = (() => {
        const stored = readStored(MEMORY_KEY)
        const mem = stored && typeof stored === 'object' ? stored : {}
        const today = dayKey()
        const days = Array.isArray(mem.days) ? mem.days.filter((d) => typeof d === 'string') : []
        if (days.indexOf(today) < 0) days.push(today)
        return {
          days: days.slice(-MEMORY_MAX_DAYS),
          corners: mem.corners && typeof mem.corners === 'object' ? mem.corners : {},
          skins: mem.skins && typeof mem.skins === 'object' ? mem.skins : {},
          said: Array.isArray(mem.said) ? mem.said : [],
          remarkDay: typeof mem.remarkDay === 'string' ? mem.remarkDay : '',
        }
      })()
      const saveMemory = () => writeStored(MEMORY_KEY, memory)
      saveMemory()                        // 今天来过了，先记上

      const bump = (bag, key) => {
        if (typeof key !== 'string' || key === '') return
        bag[key] = (typeof bag[key] === 'number' ? bag[key] : 0) + 1
        saveMemory()
      }
      const topOf = (bag) => {
        let best = null
        let total = 0
        for (const key of Object.keys(bag)) {
          const n = bag[key]
          if (typeof n !== 'number') continue
          total += n
          if (best === null || n > best.count) best = { key, count: n }
        }
        return best === null ? null : { key: best.key, count: best.count, total }
      }

      /* 挑一句"她记着的事"。返回 null 表示今天不该说。 */
      const memoryRemark = () => {
        if (!cfg.memory) return null
        const today = dayKey()
        if (memory.remarkDay === today) return null
        const once = (key) => memory.said.indexOf(key) < 0
        const claim = (key) => { memory.said.push(key); memory.remarkDay = today; saveMemory() }

        if (DAY_MILESTONES.indexOf(memory.days.length) >= 0 && once('days:' + memory.days.length)) {
          claim('days:' + memory.days.length)
          return { mood: 'happy', text: pick(LINES.days).split('{n}').join(String(memory.days.length)) }
        }
        const corner = topOf(memory.corners)
        if (corner && corner.count >= HABIT_MIN && corner.count / corner.total >= HABIT_SHARE && once('corner:' + corner.key)) {
          claim('corner:' + corner.key)
          return { mood: 'proud', text: pick(LINES.habitCorner).split('{c}').join(corner.key) }
        }
        const skin = topOf(memory.skins)
        if (skin && skin.count >= SKIN_MIN && skin.key !== activeSkin && once('skin:' + skin.key)) {
          claim('skin:' + skin.key)
          return { mood: 'proud', text: pick(LINES.habitSkin).split('{s}').join(skinLabel(skin.key)) }
        }
        return null
      }

      /* ---- 今天记了些什么 -----------------------------------------------------
         轮次、报错、专注时长、提醒次数 —— 这些数字本来就在手上，以前只是没留下来。
         存在记忆里（按天重置），刷新页面也不会丢，这样"今日小结"才说得准。 */
      const watchToday = () => {
        const today = dayKey()
        if (!memory.stats || memory.statsDay !== today) {
          memory.stats = { runs: 0, errors: 0, longestMs: 0, focusMs: 0, care: 0 }
          memory.statsDay = today
          saveMemory()
        }
        return memory.stats
      }
      const bumpStats = (patchStats) => {
        const stats = watchToday()
        for (const key of Object.keys(patchStats)) {
          if (typeof stats[key] !== 'number') stats[key] = 0
          stats[key] += patchStats[key]
        }
        saveMemory()
        return stats
      }
      const saySummary = () => {
        const stats = watchToday()
        const text = pick(LINES.summary)
          .split('{runs}').join(String(stats.runs))
          .split('{errors}').join(String(stats.errors))
          .split('{focus}').join(String(Math.round(stats.focusMs / 60000)))
          .split('{care}').join(String(stats.care))
        wake(true)
        setMood('report')
        flashHappy(text)
      }

      /* ---- 值班 ---------------------------------------------------------------
         你在的时候她陪你；你走开的时候她替你看着：跑完了几轮、有没有报错。
         藏起来时**放慢**轮询而不是停掉 —— 值班的前提是还看得见（5 秒的延迟对这件事足够）。
         回来时把那段时间的账报给你。 */
      const HIDDEN_POLL_MS = 5000
      const LONG_RUN_MS = 600000
      let longRunSaidAt = 0
      let awayWatch = null

      /* ---- react to what the app is doing ---- */
      let lastBusy = false
      let lastPending = null
      let busySince = 0
      /* 久坐追踪：activeSince = 这一段"坐在电脑前"的起点；0 表示不在这一段里。
         CARE_ACTIVE_GAP_MS = 中间停顿多久算离开。 */
      const CARE_ACTIVE_GAP_MS = 90000
      let activeSince = 0
      let lastActiveAt = 0
      let lastCareAt = 0
      /* 上一顿饭的时间。起手是 0，所以计时以 activeSince 为准 —— 见下面 mealBase。 */
      let lastMealAt = 0
      /* 上一次深夜劝睡；离开又回来的时间点。 */
      let lastNightAt = 0
      let awayAt = 0
      let happyHandle = null
      let lastErrorCount = 0

      const flashProud = (text) => {
        setMood('proud')
        say(text)
        if (proudHandle) clock.cancel(proudHandle)
        proudHandle = clock.after(PROUD_MS, () => { if (mood === 'proud') setMood('idle') })
      }

      /* 记一轮完成；命中里程碑时返回那个数字，否则 null */
      const recordRun = () => {
        const today = dayKey()
        if (runsToday.day !== today) runsToday = { day: today, count: 0, said: [] }
        runsToday.count++
        const hit = MILESTONES.find((m) => m === runsToday.count && runsToday.said.indexOf(m) < 0)
        if (hit !== undefined) runsToday.said.push(hit)
        writeStored(RUNS_KEY, { day: runsToday.day, count: runsToday.count, said: runsToday.said })
        return hit === undefined ? null : hit
      }

      const flashHappy = (text) => {
        /* 手势驱动的反应：**已经是这个表情时也要弹**。setMood 的弹一下挂在
           "真的换了表情"后面（否则轮询重算的 attn 会变成 1.2 秒一次的抽搐），
           所以"连戳两下"这条要求由这里补上 —— 它只由用户的手势触发。 */
        if (mood === 'happy') accent('pop')
        setMood('happy')
        say(text)
        if (happyHandle) clock.cancel(happyHandle)
        happyHandle = clock.after(cfg.happyMs, () => { if (mood === 'happy') setMood('idle') })
      }

      /* 连戳到一定程度就换成"抗议"。它和 happy 一样是**瞬时状态**，但必须自己一份定时器：
         否则同一轮询里的 idle/alert 会把它盖掉 —— worried 当初就是这么坏的。 */
      const POKED_MS = 1800
      let pokedHandle = null
      const flashPoked = (text) => {
        if (mood === 'poked') accent('pop')     // 同上：连戳到底也要每次都弹
        setMood('poked')
        say(text)
        if (pokedHandle) clock.cancel(pokedHandle)
        pokedHandle = clock.after(POKED_MS, () => { if (mood === 'poked') setMood('idle') })
      }

      /* 打盹：深夜劝睡用它（一个哈欠比一条通知更像她）。睡着是瞬时状态，
         自己到期就回稳态。 */
      const NAP_MS = 5200
      let napHandle = null
      const flashSleepy = (text) => {
        if (mood === 'sleep') wake(true)
        setMood('sleep')
        say(text)
        if (napHandle) clock.cancel(napHandle)
        napHandle = clock.after(NAP_MS, () => { if (mood === 'sleep') setMood('idle') })
      }

      /* 干饭用的也是瞬时状态（借 eat 的姿态）。比"提醒你活动"长一点 ——
         吃饭本来就慢。 */
      const EAT_MS = 5200
      let eatHandle = null
      const flashEat = (text) => {
        if (mood === 'sleep') wake(true)
        setMood('eat')
        say(text)
        if (eatHandle) clock.cancel(eatHandle)
        eatHandle = clock.after(EAT_MS, () => { if (mood === 'eat') setMood('idle') })
      }

      /* 久坐提醒用的也是一个**瞬时状态**（借 attn 的姿态），理由和 poked 一样：
         稳态逻辑每轮都会重算，不给它自己的定时器就会被抹掉。 */
      const PROUD_MS = 2800
      let proudHandle = null

      const CARE_MS = 4200
      let careHandle = null
      const flashCare = (text) => {
        setMood('care')
        say(text)
        if (careHandle) clock.cancel(careHandle)
        careHandle = clock.after(CARE_MS, () => { if (mood === 'care') setMood('idle') })
      }

      let worriedHandle = null
      const flashWorried = (text) => {
        setMood('worried')
        say(text)
        if (worriedHandle) clock.cancel(worriedHandle)
        worriedHandle = clock.after(WORRIED_MS, () => { if (mood === 'worried') setMood('idle') })
      }

      /* 一轮刚跑完的那一刻看一次错误。同一批错误只说一次；错误清掉之后再出现新的
         才会再说 —— 否则每轮结束都会重复念同一句。 */
      const checkErrors = () => {
        if (!cfg.reactions) return 0
        const count = countErrors()
        /* 只有"新出现"的才算一次：同一批错误不该被数很多遍（值班汇报要的是新账） */
        const fresh = count > lastErrorCount ? count - lastErrorCount : 0
        if (count > 0 && count !== lastErrorCount && !paused) flashWorried(pick(LINES.error))
        lastErrorCount = count
        return fresh
      }

      const poll = () => {
        if (destroyed) return
        let busy = false
        try { busy = agentIsBusy() } catch (e) { busy = false }
        if (busy && !lastBusy) busySince = nowMs()
        if (!busy && lastBusy) {
          /* 里程碑优先于普通庆祝：同一次跑完只该说一句，而"第 25 轮"比"跑完了"更值得说 */
          const hit = cfg.reactions && cfg.milestones ? recordRun() : null
          /* 藏起来时**只记账不表演**：没人看得见她，而且"只说一次"的状态会被白白用掉
             （里程碑在没人看的时候被说掉，你回来就不会再提了）。回来有专门的汇报。 */
          if (!paused) {
            if (hit !== null) {
              flashProud(pick(LINES.milestone).split('{n}').join(String(hit)))
            } else if (cfg.celebrate && nowMs() - busySince >= cfg.celebrateAfterMs) {
              playSound('done')
              flashHappy(pick(LINES.done))
            }
          }
          // 一轮结束 = 错误唯一会出现的时机，所以错误检查挂在这个边上而不是轮询里
          const fresh = checkErrors()
          /* 记账：今天跑了多少轮、最长一轮多久、有没有新报错；走开期间的另记一份 */
          const ranMs = busySince > 0 ? nowMs() - busySince : 0
          bumpStats({ runs: 1, errors: fresh })
          const stats = watchToday()
          if (ranMs > stats.longestMs) { stats.longestMs = ranMs; saveMemory() }
          if (awayWatch !== null) {
            awayWatch.runs++
            awayWatch.errors += fresh
            if (ranMs > awayWatch.longestMs) awayWatch.longestMs = ranMs
          }
        }
        lastBusy = busy

        /* 单轮跑得异常久：她中途说一声（同一轮只说一次）。不是催促，是"我还在看着"。 */
        if (busy && busySince > 0) {
          const ran = nowMs() - busySince
          if (!paused && ran >= LONG_RUN_MS && longRunSaidAt < busySince) {
            longRunSaidAt = nowMs()
            say(pick(LINES.longRun).split('{n}').join(String(Math.round(ran / 60000))))
          }
        }

        /* ---- 久坐追踪 ---------------------------------------------------------
           "连着坐了多久"没有直接信号，用"最近有没有活动"近似：跑着任务或输入框里有字
           就算还在动。中间短暂停一下（不到 CARE_ACTIVE_GAP_MS）不算离开 —— 人是会停下来
           想事情的，把那种间隙当成"离开"会让计时永远攒不满。
           判定放在这里（而不是稳态赋值之后）：瞬时的表情可能提前 return，而计时必须每轮都走。 */
        let typing = false
        try { typing = composerHasText() } catch (e) { typing = false }
        const activeNow = busy || typing
        const nowTick = nowMs()
        if (activeNow) {
          if (activeSince === 0) activeSince = nowTick
          lastActiveAt = nowTick
        } else if (activeSince !== 0 && nowTick - lastActiveAt > CARE_ACTIVE_GAP_MS) {
          activeSince = 0                     // 他离开了一阵，这一段结束
        }
        if (
          cfg.careAfterMs > 0 && activeSince !== 0
          && nowTick - activeSince >= cfg.careAfterMs
          && nowTick - lastCareAt >= cfg.careAfterMs
        ) {
          lastCareAt = nowTick
          /* 提醒你的时候她自己得先醒着 —— 打盹着喊人起来活动，读起来像 bug。
             pending 面板那条路也是这么处理的（先 wake 再说话）。 */
          if (mood === 'sleep') wake(true)
          playSound('notice')
          bumpStats({ care: 1 })
          flashCare(pick(LINES.care))
        }

        /* ---- 干饭 -------------------------------------------------------------
           和久坐共用同一套"还在动"的判定，但含义相反：久坐是提醒你起来，
           干饭是提醒她自己该补碳了。计时基准取 lastMealAt 与 activeSince 里更晚的那个 ——
           离开很久回来之后，不该立刻就说饿（那一段已经结束了）。 */
        const mealBase = Math.max(lastMealAt, activeSince)
        if (
          cfg.hungry && cfg.hungerMs > 0 && activeSince !== 0
          && nowTick - mealBase >= cfg.hungerMs
        ) {
          lastMealAt = nowTick
          flashEat(pick(LINES.eat))
        }

        /* ---- 深夜劝睡 ---------------------------------------------------------
           作息**是可配的**（bedtimeHour / wakeHour），所以它既是一项真功能，
           也让测试不必伪造时钟 —— 把窗口套在当前那个小时上就能测。
           深度深夜从 bedtime + 2 起算，语气换一档：从"该收了"变成"嘴硬心软"。 */
        if (cfg.night && cfg.nightMs > 0) {
          const hour = hourNow()
          const nightBase = Math.max(lastNightAt, activeSince)
          if (isNightHour(hour, cfg.bedtimeHour, cfg.wakeHour)
            && nowTick - nightBase >= cfg.nightMs) {
            lastNightAt = nowTick
            const deep = hoursSince(hour, cfg.bedtimeHour) >= DEEP_AFTER_HOURS
            flashSleepy(pick(deep ? LINES.nightDeep : LINES.nightLate))
          }
        }

        // 有东西在等她处理时，优先级高于一切：这是唯一"你不理它就卡住"的状态。
        const pending = cfg.reactions ? readPending() : null
        if (pending === null) {
          lastPending = null
        } else if (pending !== lastPending) {
          lastPending = pending
          if (mood === 'sleep') wake(true)     // 睡着了也要叫起来
          say(pick(LINES.attn))
        }
        if (pending !== null) {
          setMood('attn')
          return
        }

        /* 专注期间不让稳态把她从"干活中"挪走 —— 她在盯着你，这是这个功能的全部意义。
           位置在这里而不是函数开头：久坐、干饭、劝睡该响还得响。 */
        if (focusUntil > 0) {
          if (mood !== 'alert') setMood('alert')
          return
        }

        // 临时状态（happy / worried）在自己的计时器到期前不能被稳态赋值覆盖 ——
        // 否则刚摆出的表情在同一个 poll 周期里就被 setMood('idle') 抹掉了。
        if (mood === 'sleep' || mood === 'happy' || mood === 'poked' || mood === 'proud' || mood === 'care'
          || mood === 'eat' || mood === 'worried') return
        /* 动作预览期间也要挡住稳态赋值，否则刚摆的表情在同一轮里被算回去 */
        if (nowMs() < previewUntil) return
        setMood((busy || typing) ? 'alert' : 'idle')
      }

      /* ---- 专注计时器 ---------------------------------------------------------
         桌面陪伴插件最该有的实用功能：替你画出一段时间的边界。
         专注期间她保持"干活中"的姿势（poll 里给她一个 hold —— 否则稳态会把她挪走），
         到点收工庆祝；戳她一下就是问"还剩多久"。
         她**不碰应用**：不改输入框、不发消息，只是陪着 + 计时。 */
      let focusUntil = 0
      let focusHandle = null
      let focusMinutes = 0
      let focusDone = 0

      const focusLeftMs = () => Math.max(0, focusUntil - nowMs())
      const focusState = () => (focusUntil > 0
        ? { active: true, minutes: focusMinutes, leftMs: Math.round(focusLeftMs()), leftMin: Math.max(1, Math.ceil(focusLeftMs() / 60000)), done: focusDone }
        : { active: false, minutes: 0, leftMs: 0, leftMin: 0, done: focusDone })

      const stopFocus = (silent) => {
        if (focusUntil === 0 && focusHandle === null) return false
        focusUntil = 0
        focusMinutes = 0
        if (focusHandle) { clock.cancel(focusHandle); focusHandle = null }
        if (silent !== true) {
          wake(true)
          flashHappy(pick(LINES.focusStop))
        }
        return true
      }

      const finishFocus = () => {
        const minutes = focusMinutes
        focusUntil = 0
        focusHandle = null
        focusMinutes = 0
        focusDone++
        bumpStats({ focusMs: minutes * 60000 })
        playSound('focusEnd')
        wake(true)
        setMood('report')          // 专注结束用"汇报"的姿势
        flashProud(pick(LINES.focusDone).split('{n}').join(String(minutes)))
      }

      const startFocus = (minutes) => {
        const mins = clamp(Math.round(Number(minutes) || cfg.focusMinutes), 1, 600)
        stopFocus(true)
        focusMinutes = mins
        focusUntil = nowMs() + mins * 60000
        wake(true)
        say(pick(LINES.focusStart).split('{n}').join(String(mins)))
        focusHandle = clock.after(mins * 60000, () => { if (focusUntil > 0) finishFocus() })
        return focusState()
      }

      /* 没人在看的时候别空转：页面藏起来就停掉轮询、絮叨、踱步三个定时器。
         它们本来就是"给看得见的人看的"，停下来是纯赚（CPU 与电量）。 */
      let paused = false

      let chatterHandle = null
      const syncChatter = () => {
        if (chatterHandle) { clock.cancel(chatterHandle); chatterHandle = null }
        if (cfg.chatterMs <= 0 || paused) return
        chatterHandle = clock.every(cfg.chatterMs, () => {
          if (destroyed || mood !== 'idle') return
          if (agentIsBusy()) return
          say(pick(LINES.chatter))
        })
      }

      let pollHandle = null
      const syncPoll = () => {
        if (pollHandle) { clock.cancel(pollHandle); pollHandle = null }
        if (cfg.reactions && !paused) pollHandle = clock.every(POLL_MS, poll)
      }
      syncPoll()
      syncChatter()

      /* ---- 自己踱步 ----
         只在真正空闲时发生，并且是一段可见的滑行而不是瞬移。滑行期间挂
         `data-gliding`，由 CSS 过渡接管 transform；一旦按下就立刻摘掉，
         否则拖动会被过渡拖后腿。 */
      let glideHandle = null
      const glideTo = (dx) => {
        root.dataset.gliding = 'true'
        paint()
        /* 朝行进方向微微前倾。整段 1.6 秒的滑行里，这一点倾斜就是"她往那边去"
           与"她被平移到那边"的区别 —— 归零那一半由 .wisp-lean 的过渡做。 */
        setTilt(clamp((Number(dx) || 0) * TILT_GLIDE_PER_PX, -TILT_GLIDE_MAX, TILT_GLIDE_MAX) * amp())
        if (glideHandle) clock.cancel(glideHandle)
        glideHandle = clock.after(1700, () => {
          glideHandle = null
          delete root.dataset.gliding
          setTilt(0)
        })
      }
      const stopGlide = () => {
        if (glideHandle) { clock.cancel(glideHandle); glideHandle = null }
        delete root.dataset.gliding
        setTilt(0)
      }

      let wanderHandle = null
      const syncWander = () => {
        if (wanderHandle) { clock.cancel(wanderHandle); wanderHandle = null }
        /* 溜达也是"动作"：`motion: off` 和 prefers-reduced-motion 都该让她待在原地。
           之前只关了 CSS 动画，她照样会自己滑走 —— 那是最容易被忽略的一种"没停下来"，
           因为看起来只是一次正常的挪动。（CSS 关不掉 JS 写进去的坐标。） */
        if (cfg.motion === 'off' || reduced()) return
        if (!cfg.wander || cfg.wanderRange <= 0 || paused) return
        wanderHandle = clock.every(cfg.wanderMs, () => {
          if (destroyed || hidden || mood !== 'idle' || start !== null) return
          if (agentIsBusy()) return
          // A random bearing with a floor on the distance, so a stroll is always
          // a real stroll rather than a rounding error in a random direction.
          const angle = Math.random() * Math.PI * 2
          const dist = cfg.wanderRange * (0.45 + Math.random() * 0.55)
          const fromX = coords.x
          coords.x = clamp(coords.x + Math.cos(angle) * dist, 0, maxX())
          coords.y = clamp(coords.y + Math.sin(angle) * dist * 0.6, 0, maxY())
          glideTo(coords.x - fromX)
          // 故意不 rememberPosition()：记忆的是"用户把她放在哪"，她自己的溜达
          // 不该覆盖那个意图，否则刷新后她会出现在一个用户从没选过的位置。
        })
      }
      syncWander()

      /* ---- 躲起来 / 叫回来 ----
         她放大到 560x840 之后会挡住会话和输入框，而"让她消失一会儿"原先只能整个
         禁用插件。躲起来时留一个迷你按钮（用的是当前皮肤的 idle 图，所以不需要
         额外素材），点一下就回来。状态记在本地，刷新后仍然躲着。 */
      let hidden = cfg.hidden === true || (cfg.persist && readStored(HIDDEN_KEY)?.hidden === true)
      root.dataset.hidden = hidden ? 'true' : 'false'
      let tabEl = null

      const hideTab = () => {
        if (tabEl && tabEl.parentNode) tabEl.parentNode.removeChild(tabEl)
        tabEl = null
      }

      const showTab = () => {
        if (destroyed || tabEl !== null) return
        const tab = document.createElement('button')
        tab.className = 'wisp-tab'
        tab.setAttribute('type', 'button')
        tab.setAttribute('title', '把' + '她' + '叫回来')
        tab.setAttribute('aria-label', '把 DeepSeek娘 叫回来')
        tab.style.position = 'absolute'
        tab.style.right = Math.round(cfg.right) + 'px'
        tab.style.bottom = Math.round(cfg.bottom + 40) + 'px'
        const thumb = document.createElement('img')
        thumb.className = 'wisp-tab-thumb'
        thumb.setAttribute('src', resolveSprite(spriteOf('idle')))
        thumb.setAttribute('alt', '')
        thumb.setAttribute('draggable', 'false')
        tab.appendChild(thumb)
        tab.addEventListener('pointerdown', (ev) => ev.stopPropagation())
        tab.addEventListener('click', (ev) => {
          ev.preventDefault(); ev.stopPropagation()
          setHidden(false)
        })
        /* 躲起来之后，原先只能靠那个小按钮把她叫回来 —— 换皮肤、调大小、换角落在那个状态下
           全都够不着。右键它直接开同一个菜单，这里就补上了。
           （openMenu 在下面才定义；showTab 只在挂载完成之后的用户操作里跑，所以不是 TDZ。） */
        tab.addEventListener('contextmenu', (ev) => {
          ev.preventDefault(); ev.stopPropagation()
          openMenu(ev.clientX ?? 0, ev.clientY ?? 0)
        })
        layer.appendChild(tab)
        tabEl = tab
      }

      const setHidden = (next) => {
        if (destroyed) return
        hidden = next === true
        root.dataset.hidden = hidden ? 'true' : 'false'
        if (hidden) { closeMenu(); hideTab(); clearSay(); showTab(); setTilt(0) }
        else { hideTab(); paint() }
        if (cfg.persist) writeStored(HIDDEN_KEY, { hidden })
      }

      /* ---- drag & click ---- */
      let start = null, origin = null, moved = false, lastClick = 0
      /* 上一次指针的横坐标：拖动中的侧倾是"这一段的位移"，不是"从按下算起的总位移" */
      let lastDragX = 0
      /* 连戳计数：POKE_WINDOW_MS 内累计到 POKE_ANNOYED_AT 次就抗议一次 */
      const POKE_WINDOW_MS = 3000
      const POKE_ANNOYED_AT = 3
      let pokeStreak = 0
      let pokeWindowStart = 0

      const rememberPosition = () => {
        if (!cfg.persist) return
        writeStored(POSITION_KEY, { x: Math.round(coords.x), y: Math.round(coords.y) })
      }

      /** Whether this pointer is over an opaque pixel of the current sprite. */
      const hitsBody = (e) => {
        const mask = masks[activeSkin + '/' + currentSprite]
        if (!mask) return true            // no mask yet: stay grabbable rather than vanish
        const boxw = boxW()
        const boxh = boxH()
        let mx = (e.clientX - coords.x) / boxw
        const my = (e.clientY - coords.y) / boxh
        if (mx < 0 || mx >= 1 || my < 0 || my >= 1) return false
        // The root mirrors about its centre, so sample the un-mirrored pixel.
        if (coords.x + boxw / 2 < vw() / 2) mx = 1 - mx
        const col = Math.min(MASK_W - 1, Math.floor(mx * MASK_W))
        const row = Math.min(MASK_H - 1, Math.floor(my * MASK_H))
        return mask[row * MASK_W + col] > MASK_MIN_ALPHA
      }

      const onMove = (e) => {
        if (!start) return
        const dx = e.clientX - start.x, dy = e.clientY - start.y
        if (!moved && Math.sqrt(dx * dx + dy * dy) > 4) moved = true
        if (!moved) return
        const beforeX = coords.x, beforeY = coords.y
        coords.x = clamp(origin.x + dx, 0, maxX())
        coords.y = clamp(origin.y + dy, 0, maxY())
        /* 被边界夹住时她其实**没有动** —— 这时候再按指针位移去倾，就是"原地歪"，
           看起来像坏了。位置没变就把姿势归零（指针继续拖也不影响，因为下一帧
           只要真的动了就会重新算）。 */
        if (coords.x === beforeX && coords.y === beforeY) {
          lastDragX = e.clientX
          setTilt(0)
          return
        }
        /* 拖动时她朝**运动的反方向**倾：被拎着走的东西，顶是往后倒的。
           只看"这一次事件走了多远"就等价于速度，不用存历史、不用积分 ——
           而且它天然跟着指针事件的频率走，慢拖就是小角度。 */
        setTilt(-(e.clientX - lastDragX) * TILT_DRAG_PER_PX * amp())
        lastDragX = e.clientX
        paint()
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        delete root.dataset.dragging
        /* 松手分两种：真拖过 = 落地（顿一下）；只按了一下 = 什么都不放 ——
           紧接着的点击反应会自己弹一下（见 ACCENT_MS 的说明：通道只留
           最后发生的那件事）。姿势则一律由 CSS 过渡归零（拖动中它被
           data-dragging 关掉了，现在恢复了）。 */
        if (moved) accent('land')
        setTilt(0)
        start = null
        if (moved) {
          rememberPosition()
          if (Math.random() < 0.35) say(pick(LINES.move))
          return
        }
        if (destroyed) return
        /* 用 nowMs()（插件自己的时钟）而不是 Date.now()：双击窗口与连戳窗口必须和其他
           有时间意义的行为共用同一个时钟，否则测试没法推进它，行为也无法在虚拟时间下复现。 */
        const now = nowMs()
        const dbl = now - lastClick < 420
        lastClick = now
        /* 连戳升级：短窗口内戳到第三次，她从"开心"转成"抗议"。
           计数在窗口过期后归零 —— 隔一会儿再戳一下不该被记仇。 */
        if (now - pokeWindowStart > POKE_WINDOW_MS) { pokeWindowStart = now; pokeStreak = 0 }
        pokeStreak++
        wake(true)
        /* 专注中戳她是在问进度，不算戳着玩（也就不会升级成"抗议"）。 */
        if (focusUntil > 0) {
          const left = Math.max(1, Math.ceil(focusLeftMs() / 60000))
          say(pick(LINES.focusLeft).split('{n}').join(String(left)))
          return
        }
        if (pokeStreak >= POKE_ANNOYED_AT) {
          pokeStreak = 0
          flashPoked(pick(LINES.poked))
        } else {
          flashHappy(dbl ? pick(LINES.happy) : pick(LINES.click))
        }
      }
      const onDown = (e) => {
        if (e.button !== 0) return
        // Only her own pixels grab the pointer. Her transparent margins pass the
        // click through, but anywhere she is actually drawn she is grabbable —
        // including over the composer: she can be moved, so she does not have to
        // yield to whatever she is standing on.
        if (!hitsBody(e)) return
        stopGlide()          // a stroll must not fight the drag
        e.preventDefault(); e.stopPropagation()
        /* 点她 = 把键盘焦点给她。以前这是浏览器的默认行为（她自己就是那个被点的
           tabindex=0 元素）；命中层接管点击之后默认焦点会落到 <body>，于是
           "点一下她、再按 Enter 开菜单"就断了 —— 显式补回来。 */
        focusHer()
        start = { x: e.clientX, y: e.clientY }
        origin = { x: coords.x, y: coords.y }
        moved = false
        lastDragX = e.clientX
        root.dataset.dragging = 'true'
        /* 按下去就压一下 —— 触摸反馈要在**按下**那一刻发生，等到松手才动
           就已经晚了（那正是"拖动"与"点击"共同的起点）。 */
        accent('press')
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }
      bodyEl.addEventListener('pointerdown', onDown)

      /* ---- 姿势：她注意到你的指针 -------------------------------------------
         指针进到 170px 的圈里，她朝指针方向侧身；贴得越近倾得越多，出圈归零。

         这是全插件唯一一处"持续读指针"的逻辑，所以它必须便宜：
           · 纯算术，不查 DOM、不读布局（读一次 getBoundingClientRect 就是一次强制重排）
           · 出圈就走 setTilt(0)，而 setTilt 自己挡掉"变化不到 0.05°"的写入
           · 拖动中直接返回 —— 那时候姿势由速度接管
         window 上本来就挂着 pointermove（wake：她得能被碰醒），所以这里不是
         新开一条全局热路径，只是同一条路上的第二个判断。 */
      const leanToPointer = (e) => {
        if (destroyed || paused || hidden || start !== null) return
        if (mood === 'sleep') return
        if (cfg.motion === 'off' || reduced()) return
        /* 触摸屏上"指针"就是手指：手指划过时让她整只歪过去是错的 ——
           那既不是"靠近"也不是"路过"，而且手指一抬起姿势就冻在那儿。
           所以触摸一律归零（真正该有的反馈是"按下压一下"，那是另一条通道）。 */
        if (e.pointerType === 'touch') { setTilt(0); return }
        if (typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return
        const dx = e.clientX - (coords.x + boxW() / 2)
        const dy = e.clientY - (coords.y + boxH() / 2)
        if (Math.abs(dx) > TILT_NEAR_PX || Math.abs(dy) > TILT_NEAR_PX) { setTilt(0); return }
        const near = 1 - Math.abs(dx) / TILT_NEAR_PX
        const level = 1 - Math.abs(dy) / TILT_NEAR_PX   // 从她正上方路过不该让她倾
        setTilt((dx < 0 ? -1 : 1) * TILT_NEAR_MAX * near * level * amp())
      }
      window.addEventListener('pointermove', leanToPointer, { passive: true })
      /* 指针移出窗口、或者你切走应用之后，不会再有点事件来把它归零 ——
         没有这一下，她会一直朝着最后那个位置歪着。
         `blur` 只覆盖"切走应用"，**指针移出窗口不会触发它** —— 补一个文档级
         mouseleave（指针离开文档时才发），两条一起才真的覆盖到。 */
      const resetTilt = () => setTilt(0)
      window.addEventListener('blur', resetTilt)
      try {
        if (typeof document !== 'undefined' && document.addEventListener) {
          document.addEventListener('mouseleave', resetTilt)
        }
      } catch (e) { /* 没有 document：她最多保留最后一次侧身，不影响其它功能 */ }

      /* 键盘入口：Enter / Space / 菜单键 / Shift+F10 打开菜单。
         Space 默认会滚动页面，Enter 在表单里会提交 —— 都要拦。 */
      /* 方向键微调位置。
         在这之前，**挪动她只能靠鼠标拖** —— 键盘用户拿到焦点后除了开菜单什么也做不了。
         方向键是这类「可拖动物件」的通行补法（与拖动共用同一套边界夹紧与位置持久化）。
         Shift = 细调；默认步长 16px，因为 1px 要按十几次才看得出动。 */
      const NUDGE = 16
      const NUDGE_FINE = 4
      const NUDGE_KEYS = {
        ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
      }

      const onBodyKey = (ev) => {
        const nudge = NUDGE_KEYS[ev.key]
        if (nudge) {
          /* 不拦的话，方向键会同时把页面滚走 —— 那时候她看起来像是「跑掉了」。 */
          if (typeof ev.preventDefault === 'function') ev.preventDefault()
          if (typeof ev.stopPropagation === 'function') ev.stopPropagation()
          const step = ev.shiftKey ? NUDGE_FINE : NUDGE
          coords.x = clamp(coords.x + nudge[0] * step, 0, maxX())
          coords.y = clamp(coords.y + nudge[1] * step, 0, maxY())
          paint()
          rememberPosition()
          return
        }
        const opensMenu = ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar'
          || ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')
        if (!opensMenu) return
        if (typeof ev.preventDefault === 'function') ev.preventDefault()
        if (typeof ev.stopPropagation === 'function') ev.stopPropagation()
        openMenu(coords.x + boxW() / 2, coords.y + Math.min(boxH() / 2, 320))
      }
      bodyEl.addEventListener('keydown', onBodyKey)

      /* ---- Ctrl/⌘ + 滚轮 = 调大小 ----
         只认**带修饰键**的滚轮：她占地不小，直接吞掉普通滚轮等于在她身上把页面滚动禁掉。
         带修饰键是「缩放」的通行手势，此时 preventDefault 才是帮忙而不是捣乱。
         步长 0.25，上下限由 CONFIG_SPEC 统一夹紧（0.4–8），不在这里再写一遍。 */
      /* 步长必须是"默认值可达"的：size 的区间是 0.4–8，默认 2.5。
         原来键盘/滚轮步长 0.25，可达值只有 0.4 + 0.25k —— **2.5 不在格点上**
         （最近的是 2.4 / 2.65），于是用户只要动过一次滑块，就再也调不回出厂大小。
         0.1 让 2.5 正好落在格点上（0.4 + 21×0.1）。预检里有一条守着这个不变式。 */
      const WHEEL_STEP = 0.1
      const onWheel = (ev) => {
        if (!ev.ctrlKey && !ev.metaKey) return          // 普通滚轮原样放行
        if (typeof ev.preventDefault === 'function') ev.preventDefault()
        if (typeof ev.stopPropagation === 'function') ev.stopPropagation()
        const dir = (ev.deltaY ?? 0) < 0 ? 1 : -1       // 向上 = 变大，与浏览器缩放同向
        applyConfig({ size: cfg.size + dir * WHEEL_STEP })
      }
      bodyEl.addEventListener('wheel', onWheel)

      /* ---- 右键 = 叫回原位 ----
         她大了之后很容易被拖到看不见的地方，而"恢复位置"原先只能开 Console。
         现在右键她本体弹出菜单，归位只是其中一项。 */
      const MENU_W = 164
      const MENU_ITEM_H = 30
      const MENU_PAD = 10
      let menuEl = null
      let menuOff = null
      /* 折叠分组要"在原地重开"，所以记住这次的落点 */
      let menuAtX = 0
      let menuAtY = 0
      /* 行构造器：菜单和子面板都用它们 —— 所以放在模块级，不能藏在 openMenu 里面。 */
      let menuExtras = 0
      /* 动作行：点了就执行、然后关菜单。 */
      /* 行左侧的小字形（子 span，不写进按钮自己的 textContent） */
      const glyph = (text) => {
        const g = document.createElement('span')
        g.className = 'wisp-menu-glyph'
        g.setAttribute('aria-hidden', 'true')
        g.textContent = text
        return g
      }

      const actionRow = (spec, into) => {
        const btn = document.createElement('button')
        btn.className = 'wisp-menu-item'
        btn.setAttribute('type', 'button')
        btn.setAttribute('role', 'menuitem')
        btn.setAttribute('tabindex', '-1')
        if (spec.accent === true) btn.dataset.accent = 'true'
        if (spec.muted === true) btn.dataset.muted = 'true'
        btn.textContent = spec.label
        /* 字形槽：有图标的画图标，没有的留等宽占位 —— 所有标签的左边线对齐。
           一律用**子 span**：真浏览器显示图标，简化 DOM 里按钮自己的 textContent
           仍是纯标签（测试读的就是它）。 */
        if (btn.insertBefore) btn.insertBefore(glyph(spec.glyph || ''), btn.firstChild)
        // 菜单自己吞掉 pointerdown，否则会被下面那个"点外面就关"的监听判成外部点击
        btn.addEventListener('pointerdown', (ev) => ev.stopPropagation())
        btn.addEventListener('click', (ev) => {
          ev.preventDefault(); ev.stopPropagation()
          closeMenu()
          try { spec.run() } catch (err) { /* 单个动作失败不该带塌整个菜单 */ }
        })
        into.appendChild(btn)
        menuButtons.push(btn)
        return btn
      }

      /* 开关行：真开关的样子 + role=menuitemcheckbox + aria-checked。
         点完**不关菜单** —— 拨开关时菜单消失是最烦人的交互之一。 */
      /* 三选一（语言）。做成一行里的一排小胶囊：比三个开关清楚 ——
         "同时只能选一个"这件事，胶囊组是自明的，开关组不是。 */
      const choiceRow = (spec, into) => {
        const row = document.createElement('div')
        row.className = 'wisp-menu-item wisp-menu-row wisp-choice-row'
        row.dataset.choice = spec.key
        const label = document.createElement('span')
        label.textContent = spec.label
        row.appendChild(glyph(spec.glyph || ''))
        row.appendChild(label)
        const group = document.createElement('span')
        group.className = 'wisp-choice'
        group.setAttribute('role', 'radiogroup')
        group.setAttribute('aria-label', spec.label)
        const current = cfg[spec.key] === undefined ? 'auto' : String(cfg[spec.key])
        for (const opt of spec.options) {
          const btn = document.createElement('button')
          btn.className = 'wisp-choice-opt'
          btn.setAttribute('type', 'button')
          btn.setAttribute('role', 'radio')
          btn.setAttribute('tabindex', '-1')
          btn.setAttribute('aria-checked', opt.value === current ? 'true' : 'false')
          btn.dataset.value = opt.value
          btn.dataset.on = opt.value === current ? 'true' : 'false'
          btn.textContent = opt.label
          btn.addEventListener('pointerdown', (ev) => ev.stopPropagation())
          btn.addEventListener('click', (ev) => {
            ev.preventDefault(); ev.stopPropagation()
            try { applyConfig({ [spec.key]: opt.value }) } catch (err) { /* ignore */ }
            refreshSurfaces()          // 立刻重画：语言切换要当场看得见
          })
          group.appendChild(btn)
          menuButtons.push(btn)
        }
        row.appendChild(group)
        into.appendChild(row)
        return row
      }

      const switchRow = (spec, into) => {
        const on = cfg[spec.key] === true
        const btn = document.createElement('button')
        btn.className = 'wisp-menu-item wisp-menu-row'
        btn.setAttribute('type', 'button')
        btn.setAttribute('role', 'menuitemcheckbox')
        btn.setAttribute('aria-checked', on ? 'true' : 'false')
        btn.setAttribute('tabindex', '-1')
        btn.dataset.switchKey = spec.key
        const label = document.createElement('span')
        label.textContent = spec.label
        if (btn.insertBefore && glyph) btn.insertBefore(glyph(spec.glyph || ''), btn.firstChild)
        const toggle = document.createElement('span')
        toggle.className = 'wisp-switch'
        toggle.dataset.on = on ? 'true' : 'false'
        toggle.appendChild(document.createElement('i'))
        btn.appendChild(label)
        btn.appendChild(toggle)
        btn.addEventListener('pointerdown', (ev) => ev.stopPropagation())
        btn.addEventListener('click', (ev) => {
          ev.preventDefault(); ev.stopPropagation()
          try { applyConfig({ [spec.key]: cfg[spec.key] !== true }) } catch (err) { /* ignore */ }
          /* 原地重画：菜单和（如果开着的）子面板都留在原地 ——
             开关可能就在子面板里，拨一下面板就消失是最烦人的交互之一。 */
          refreshSurfaces()
        })
        into.appendChild(btn)
        menuButtons.push(btn)
        return btn
      }

      /* 大小滑块：连续量就该直接拖，而不是一次次点"放大一点"。
         键盘也能调（←/→ 各 0.25 档）—— 所以它自己是可聚焦的。
         替身里没有布局，getBoundingClientRect 全是 0，所以宽度为 0 时用固定跨度兜底；
         测试一律走方向键那条路，不依赖像素。 */
      const sliderRow = (into) => {
        const SPEC = CONFIG_SPEC.size
        const row = document.createElement('div')
        row.className = 'wisp-slider-row'
        const top = document.createElement('div')
        top.className = 'wisp-slider-top'
        const name = document.createElement('span')
        name.textContent = '大小'
        const value = document.createElement('span')
        value.className = 'wisp-slider-value'
        value.dataset.sliderValue = '1'
        value.textContent = Math.round(cfg.size * 100) + '%'
        top.appendChild(name)
        top.appendChild(value)
        row.appendChild(top)
        const track = document.createElement('div')
        track.className = 'wisp-slider'
        track.setAttribute('role', 'slider')
        track.setAttribute('tabindex', '-1')
        track.setAttribute('aria-label', '大小')
        track.dataset.slider = '1'
        track.setAttribute('aria-valuemin', String(SPEC.lo))
        track.setAttribute('aria-valuemax', String(SPEC.hi))
        track.setAttribute('aria-valuenow', String(cfg.size))
        const bg = document.createElement('div')
        bg.className = 'wisp-slider-track'
        const fill = document.createElement('div')
        fill.className = 'wisp-slider-fill'
        const knob = document.createElement('div')
        knob.className = 'wisp-slider-knob'
        track.appendChild(bg)
        track.appendChild(fill)
        track.appendChild(knob)
        const paintSlider = () => {
          const ratio = clamp((cfg.size - SPEC.lo) / (SPEC.hi - SPEC.lo), 0, 1)
          fill.style.width = Math.round(ratio * 100) + '%'
          knob.style.left = Math.round(ratio * 100) + '%'
          value.textContent = Math.round(cfg.size * 100) + '%'
          track.setAttribute('aria-valuenow', String(cfg.size))
        }
        paintSlider()
        const setFromClientX = (clientX) => {
          let rect = { left: 0, width: 0 }
          try { rect = track.getBoundingClientRect() } catch (e) { rect = { left: 0, width: 0 } }
          const span = rect.width > 0 ? rect.width : 120
          const ratio = clamp((clientX - rect.left) / span, 0, 1)
          const next = Math.round((SPEC.lo + ratio * (SPEC.hi - SPEC.lo)) * 4) / 4
          applyConfig({ size: next })
          paintSlider()
        }
        track.addEventListener('pointerdown', (ev) => {
          ev.preventDefault(); ev.stopPropagation()
          setFromClientX(ev.clientX)
          const move = (e) => setFromClientX(e.clientX)
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        })
        row.appendChild(track)
        into.appendChild(row)
        menuButtons.push(track)
        menuExtras++
        return track
      }

      /* 四个角落用 2×2 的方位控件，而不是四个文字条目 —— 空间的事用空间的形式表达。 */
      const cornerGrid = (into) => {
        const grid = document.createElement('div')
        grid.className = 'wisp-grid2'
        for (const corner of CORNERS) {
          const b = document.createElement('button')
          b.className = 'wisp-corner'
          b.setAttribute('type', 'button')
          b.setAttribute('tabindex', '-1')
          b.dataset.corner = corner.label
          b.textContent = corner.label
          /* 方位是空间的，就给它一个方位字形 —— 键帽上写着 ↖ 比写着"左上角"快得多。 */
          const arrows = { '左上角': '↖', '右上角': '↗', '左下角': '↙', '右下角': '↘' }
          const arrow = arrows[corner.label]
          if (arrow && b.insertBefore) {
            const g = document.createElement('span')
            g.className = 'wisp-corner-glyph'
            g.setAttribute('aria-hidden', 'true')
            g.textContent = arrow
            b.insertBefore(g, b.firstChild)
          }
          if (corner.label === currentCorner()) b.dataset.current = 'true'
          b.addEventListener('pointerdown', (ev) => ev.stopPropagation())
          b.addEventListener('click', (ev) => {
            ev.preventDefault(); ev.stopPropagation()
            closeMenu()
            try { goCorner(corner.label) } catch (err) { /* ignore */ }
          })
          grid.appendChild(b)
          menuButtons.push(b)
        }
        into.appendChild(grid)
        menuExtras++
      }

      const renderChildren = (children, into) => {
        for (const child of children) {
          if (child.kind === 'switch') { switchRow(child, into); continue }
        if (child.kind === 'choice') { choiceRow(child, into); continue }
          if (child.kind === 'corners') { cornerGrid(into); continue }
          actionRow(child, into)
        }
      }

      /* ---- 级联子菜单（flyout）------------------------------------------------
         桌面菜单栏的形状：悬停一行，在它**旁边**开一个独立面板，而不是把下面的内容推下去。
         面板浮在 layer 上（和菜单同一坐标系），所以能探出菜单外面。
         指针在「行」与「面板」之间移动算同一区域 —— 两边都挂 enter/leave：
         任一边进入就取消关闭，两边都离开才开始计宽限。
         延迟是 hover intent：鼠标只是路过一行，不该弹出东西。 */
      const HOVER_OPEN_MS = 140
      const HOVER_CLOSE_MS = 260
      const SUBMENU_W = 150
      let flyoutName = ''
      let flyoutEl = null
      let flyoutRow = null
      let flyoutSide = 'right'
      let flyoutButtons = []
      let flyoutOpenTimer = null
      let flyoutCloseTimer = null
      /* 点开的子面板被"钉住"：鼠标移开也不关。悬停是预览，点击是决定。 */
      let flyoutPinned = false

      const clearFlyoutTimers = () => {
        if (flyoutOpenTimer) { clock.cancel(flyoutOpenTimer); flyoutOpenTimer = null }
        if (flyoutCloseTimer) { clock.cancel(flyoutCloseTimer); flyoutCloseTimer = null }
      }
      /* 焦点是否在子面板里 —— 键盘用户正在里面操作时，鼠标移开不该把它收掉。 */
      const focusInsideFlyout = () => {
        if (flyoutEl === null) return false
        let el = null
        try { el = document.activeElement } catch (e) { el = null }
        let hops = 0
        while (el && hops < 24) {
          if (el === flyoutEl) return true
          el = el.parentNode || null
          hops++
        }
        return false
      }
      const closeFlyout = () => {
        clearFlyoutTimers()
        flyoutPinned = false
        if (flyoutEl && flyoutEl.parentNode) flyoutEl.parentNode.removeChild(flyoutEl)
        flyoutEl = null
        flyoutName = ''
        flyoutRow = null
        if (flyoutButtons.length) {
          menuButtons = menuButtons.filter((b) => flyoutButtons.indexOf(b) < 0)
          flyoutButtons = []
        }
        /* 行上的指示与 aria 跟着回退 */
        if (menuEl) {
          for (const row of menuEl.querySelectorAll('.wisp-menu-item')) {
            if (row.dataset && row.dataset.group) {
              row.dataset.open = 'false'
              row.setAttribute('aria-expanded', 'false')
              const caret = row.querySelector ? row.querySelector('.wisp-menu-caret') : null
              if (caret) caret.textContent = '▸'
            }
          }
        }
      }
      const isMouse = (ev) => !(ev && ev.pointerType && ev.pointerType !== 'mouse')

      /* 重画两个面：菜单 + （如果开着）子面板。
         子面板里的开关点完必须留在原地 —— 拨个开关面板就消失是最烦人的交互之一。 */
      const refreshSurfaces = () => {
        const keep = flyoutName
        /* 重画之前先记住"这个面板是点开的还是悬停开的"：openMenu 里的 closeFlyout()
           会把标记清掉，不记下来，拨一次开关后面板就从"钉住"降级成"悬停开启" ——
           而重画出来的 DOM 里鼠标并没有真的悬停过，宽限期一到面板就自己关了。
           用户看到的现象就是：拨个开关，面板消失（而这正是这段注释上面说不能有的）。 */
        const keepPinned = flyoutPinned
        const keepIndex = flyoutRow && flyoutRow.dataset ? Number(flyoutRow.dataset.rowIndex) : -1
        openMenu(menuAtX, menuAtY, false)          // 重画菜单（会先关掉面板）
        if (!keep || !menuEl) return
        const row = menuEl.querySelectorAll('.wisp-menu-item')
          .find((el) => el.dataset && el.dataset.group === keep)
        if (row) openFlyout(keep, row, Number.isFinite(keepIndex) && keepIndex >= 0 ? keepIndex : Number(row.dataset.rowIndex), keepPinned)
      }

      const openFlyout = (name, rowEl, index, pinned) => {
        if (flyoutName === name && flyoutEl !== null) return
        closeFlyout()
        const spec = menuItems().find((it) => it.group === name)
        const panel = document.createElement('div')
        panel.className = 'wisp-submenu'
        panel.setAttribute('role', 'menu')
        panel.dataset.submenu = name
        panel.addEventListener('pointerdown', (ev) => ev.stopPropagation())
        panel.addEventListener('pointerenter', (ev) => { if (isMouse(ev)) clearFlyoutTimers() })
        panel.addEventListener('pointerleave', (ev) => { if (isMouse(ev)) scheduleFlyoutClose() })
        /* 子项按顺序 push 进 menuButtons —— 先摘出来，再重排到"那一行"后面 */
        const before = menuButtons.length
        const kids = (spec && spec.children) || []
        for (const child of kids) {
          if (child.kind === 'switch') { switchRow(child, panel); continue }
          if (child.kind === 'corners') { cornerGrid(panel); continue }
          actionRow(child, panel)
        }
        flyoutButtons = menuButtons.splice(before)
        layer.appendChild(panel)
        /* 位置：贴在这一行右侧，越界就翻到左边。
           **只用量层坐标 + 宽度** —— 宽度与坐标系无关，所以这个式子不可能算错：
             菜单的 left/top 是图层坐标（我们自己设的），菜单宽度取它自己的矩形宽度；
             面板宽度是**常量**（CSS 里给了固定 width，菜单面板本来就不该随内容变宽）。
           前面几版之所以一直偏，是因为去量"刚 append、还没布局"的面板的矩形 ——
           那时宽度是 0，整套校正被守卫挡掉，位置就停在了估算值上。 */
        let menuW = MENU_W
        try {
          const mr = menuEl && menuEl.getBoundingClientRect ? menuEl.getBoundingClientRect() : null
          if (mr && mr.width > 0) menuW = mr.width
        } catch (e) { /* 用常量兜底 */ }
        /* 菜单的**实际**位置，不是"请求"的位置（menuAtX/menuAtY）。
           菜单会被夹进视口：她站在右下/左下时菜单被往上推，站在右上时被往左推。
           用请求坐标算出面板位置，就会跟着偏 —— 而且越靠角落偏得越多
           （这正是"她在右下角时子菜单更偏下、右上角时压住菜单"的原因）。 */
        const menuLeft = menuEl ? (Number.parseFloat(menuEl.style.left) || menuAtX) : menuAtX
        const menuTop = menuEl ? (Number.parseFloat(menuEl.style.top) || menuAtY) : menuAtY
        let x = menuLeft + menuW + 2
        flyoutSide = 'right'
        if (x + SUBMENU_W > vw() - 8) {
          x = menuLeft - SUBMENU_W - 2
          flyoutSide = 'left'
        }
        panel.style.left = Math.round(Math.max(8, x)) + 'px'
        /* 纵向：用"行矩形相对菜单矩形的**偏移**" —— 相对量与坐标系无关，
           所以它既准确又不受图层偏移影响，也不需要知道头部/分隔线有多高。 */
        let rowOffset = MENU_PAD + Math.max(0, index) * MENU_ITEM_H
        try {
          const mr2 = menuEl && menuEl.getBoundingClientRect ? menuEl.getBoundingClientRect() : null
          const rr2 = rowEl && rowEl.getBoundingClientRect ? rowEl.getBoundingClientRect() : null
          if (mr2 && rr2 && rr2.height > 0) rowOffset = rr2.top - mr2.top
        } catch (e) { /* 用估算值 */ }
        panel.style.top = Math.round(Math.max(8, menuTop + rowOffset)) + 'px'
        flyoutEl = panel
        flyoutName = name
        flyoutRow = rowEl
        flyoutPinned = pinned === true
        /* 焦点顺序：子项紧跟那一行之后（→ 进子菜单、↑↓ 在子菜单里走） */
        if (index >= 0 && flyoutButtons.length) menuButtons.splice(index + 1, 0, ...flyoutButtons)
        if (rowEl) {
          rowEl.dataset.open = 'true'
          rowEl.setAttribute('aria-expanded', 'true')
          const caret = rowEl.querySelector ? rowEl.querySelector('.wisp-menu-caret') : null
          if (caret) caret.textContent = flyoutSide === 'left' ? '◂' : '▸'
        }
      }

      const scheduleFlyoutOpen = (name, rowEl, index) => {
        clearFlyoutTimers()
        if (flyoutName === name) return
        flyoutOpenTimer = clock.after(HOVER_OPEN_MS, () => {
          flyoutOpenTimer = null
          if (destroyed || menuEl === null) return
          openFlyout(name, rowEl, index, false)
        })
      }
      const scheduleFlyoutClose = () => {
        clearFlyoutTimers()
        if (flyoutEl === null) return
        flyoutCloseTimer = clock.after(HOVER_CLOSE_MS, () => {
          flyoutCloseTimer = null
          if (destroyed || menuEl === null) return
          if (flyoutPinned) return                 // 点开的：鼠标移开也不关
          if (focusInsideFlyout()) return          // 键盘用户还在里面，别关
          closeFlyout()
        })
      }

      const closeMenu = () => {
        if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl)
        menuEl = null
        menuButtons = []
        menuFocusAt = -1
        /* 先收子面板：这一句必须在 menuEl 被置空之前跑，
           否则关菜单时面板会留在屏幕上（写成 if (menuEl) 就是这个 bug）。 */
        closeFlyout()
        if (menuOff) { menuOff(); menuOff = null }
      }

      /* 四个角落。她放大到 560x840 之后，"右下角"未必就是合适的位置 —— 屏幕右边
         可能是侧栏，左下角未必被输入框挡住。 */
      const CORNERS = [
        { label: '右上角', at: (w, h, bw, bh, c) => ({ x: clamp(w - c.right - bw, 0, Math.max(0, w - bw)), y: clamp(c.bottom, 0, Math.max(0, h - bh)) }) },
        { label: '左上角', at: (w, h, bw, bh, c) => ({ x: clamp(c.right, 0, Math.max(0, w - bw)), y: clamp(c.bottom, 0, Math.max(0, h - bh)) }) },
        { label: '左下角', at: (w, h, bw, bh, c) => ({ x: clamp(c.right, 0, Math.max(0, w - bw)), y: clamp(h - c.bottom - bh, 0, Math.max(0, h - bh)) }) },
        { label: '右下角', at: (w, h, bw, bh, c) => ({ x: clamp(w - c.right - bw, 0, Math.max(0, w - bw)), y: clamp(h - c.bottom - bh, 0, Math.max(0, h - bh)) }) },
      ]

      const goHome = () => goCorner('右下角')
      /* 角落用法要计数，而 goCorner 是把人挪过去的唯一入口 —— 计数放在它里面最省事，
         而且只有用户会触发它（初始位置是直接算坐标的，不走这里）。 */

      const goCorner = (label) => {
        const corner = CORNERS.find((c) => c.label === label) || CORNERS[CORNERS.length - 1]
        const spot = corner.at(vw(), vh(), boxW(), boxH(), cfg)
        coords.x = spot.x
        coords.y = spot.y
        paint()
        rememberPosition()
        say(pick(LINES.home))
      }

      /* 菜单分四段：动作 / 行为开关 / 位置 / 皮肤。后三段各有一个小标题。
         行为开关原本在设置页里，但那页与菜单重叠过大被撤掉了 —— 这三个开关是面板
         真正的净增量，放进菜单比再建一页便宜得多（复用现有的项结构、键盘支持与关闭逻辑）。 */
      const TOGGLES = [
        { key: 'wander', label: '自己溜达' },
        { key: 'reactions', label: '跟随状态' },
        { key: 'celebrate', label: '跑完撒花' },
        { key: 'hungry', label: '饿了会说话' },
        { key: 'night', label: '深夜劝睡' },
      ]

      /* ---- 弹窗 ----------------------------------------------------------------
         菜单是"做事"的地方，不是"看东西"的地方：19 个同级条目，谁也找不到谁。
         所以顶层只留动作，"她是谁"和"她有哪些动作"放进弹窗 —— 关掉即从 DOM 移除，
         不常驻、不参与轮询。 */
      let dialogEl = null
      let dialogKind = null
      let dialogKeyOff = null
      let activeGroup = ''
      /* 预览锁：动作预览要摆出某个表情给你看，而稳态轮询每一轮都会把它算回去。
         用一个到期时间挡住轮询，比给每个情绪再加一个瞬时标记干净。 */
      let previewUntil = 0
      let previewHandle = null

      const closeDialog = () => {
        if (dialogEl && dialogEl.parentNode) dialogEl.parentNode.removeChild(dialogEl)
        dialogEl = null
        dialogKind = null
      }

      /* 弹窗不抢焦点，所以 Esc 只能靠一个常驻监听 —— 而且必须是**一个**：
         每次开弹窗都挂一个新的会越积越多，引用还拿不回来，销毁时摘不掉。 */
      const onDialogKey = (ev) => {
        if (ev.key !== 'Escape' || dialogEl === null) return
        ev.preventDefault()
        closeDialog()
        focusHer()
      }
      /* 文档级监听：真 document 一定有，但这里仍然判断一下 ——
         "环境少一个方法"不该让整个插件起不来（预检的替身就少了它）。 */
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('keydown', onDialogKey, true)
      }

      const para = (text) => {
        const p = document.createElement('p')
        p.className = 'wisp-dialog-p'
        p.textContent = text
        return p
      }

      const dialogFoot = (left, right) => {
        const row = document.createElement('div')
        row.className = 'wisp-dialog-foot'
        const a = document.createElement('span')
        /* 两个 span 各带类名：真 DOM 从父节点就能读到汇总文本，
           简化 DOM 不能 —— 带类名意味着两边都能定位到这段文字。 */
        a.className = 'wisp-dialog-foot-l'
        a.textContent = left
        const b = document.createElement('span')
        b.className = 'wisp-dialog-foot-r'
        b.textContent = right
        row.appendChild(a)
        row.appendChild(b)
        return row
      }

      const openDialog = (kind, title, rows) => {
        closeMenu()
        closeDialog()
        const back = document.createElement('div')
        back.className = 'wisp-dialog-backdrop'
        back.addEventListener('pointerdown', () => { closeDialog(); focusHer() })
        const card = document.createElement('div')
        card.className = 'wisp-dialog'
        card.setAttribute('role', 'dialog')
        card.setAttribute('aria-modal', 'true')
        card.setAttribute('aria-label', title)
        card.addEventListener('pointerdown', (ev) => ev.stopPropagation())
        const head = document.createElement('div')
        head.className = 'wisp-dialog-title'
        head.textContent = title
        card.appendChild(head)
        const x = document.createElement('button')
        x.className = 'wisp-dialog-x'
        x.setAttribute('type', 'button')
        x.setAttribute('aria-label', '关闭')
        x.textContent = '×'
        x.addEventListener('click', (ev) => { ev.preventDefault(); closeDialog(); focusHer() })
        card.appendChild(x)
        for (let i = 0; i < rows.length; i++) card.appendChild(rows[i])
        back.appendChild(card)
        layer.appendChild(back)
        dialogEl = back
        dialogKind = kind
        return card
      }

      /* 八个动作。key 是精灵图名，mood 是运行时该摆的状态 —— 两者不一样：
         "干活中"的图叫 work，但状态是 alert；"待机"两者都是 idle。 */
      const ACTION_ROWS = [
        { key: 'idle', mood: 'idle', label: '待机', say: '平时就是这样。' },
        { key: 'happy', mood: 'happy', label: '开心', say: '嗯，开心。' },
        { key: 'sleepy', mood: 'sleep', label: '打盹', say: '困了……' },
        { key: 'work', mood: 'alert', label: '干活中', say: '在跑呢，别催。' },
        { key: 'attn', mood: 'attn', label: '有动静', say: '我注意到了。' },
        { key: 'poked', mood: 'poked', label: '被戳', say: '干嘛。' },
        { key: 'proud', mood: 'proud', label: '得意', say: '跑完了，不错吧。' },
        { key: 'eat', mood: 'eat', label: '干饭', say: '先吃一碗。' },
      ]

      const previewMood = (key) => {
        const row = ACTION_ROWS.find((r) => r.key === key)
        if (!row) return false
        closeDialog()
        /* 被点掉的那个格子随弹窗一起消失了，焦点必须有人接 —— 否则掉进 <body>。 */
        focusHer()
        previewUntil = nowMs() + 6000
        setMood(row.mood)
        /* 预览必须**自己有到期时间**：预览的姿势可能在"稳态轮询不许覆盖"的名单里
           （干饭就在），光靠 previewUntil 挡住轮询的话，锁一过期她就被永久卡在那个表情上。
           到点主动交还稳态，之后该是什么由轮询说了算。 */
        if (previewHandle) clock.cancel(previewHandle)
        previewHandle = clock.after(6200, () => { setMood('idle') })
        say(row.say)
        return true
      }

      const actionsDialog = () => {
        const grid = document.createElement('div')
        grid.className = 'wisp-grid'
        for (const row of ACTION_ROWS) {
          const cell = document.createElement('button')
          cell.className = 'wisp-cell'
          cell.setAttribute('type', 'button')
          cell.setAttribute('aria-label', '预览' + row.label)
          cell.dataset.mood = row.key
          const im = document.createElement('img')
          im.setAttribute('alt', '')
          im.src = resolveSprite(spriteOf(row.key))
          const cap = document.createElement('span')
          cap.textContent = row.label
          cell.appendChild(im)
          cell.appendChild(cap)
          cell.addEventListener('click', (ev) => { ev.preventDefault(); previewMood(row.key) })
          grid.appendChild(cell)
        }
        return openDialog('actions', '动作一览', [
          para('点一个动作，她就当场做给你看。（图都是当前皮肤 ' + skinLabel(activeSkin) + '）'),
          grid,
          dialogFoot('共 ' + ACTION_ROWS.length + ' 个动作', '按 Esc 关闭'),
        ])
      }

      const aboutDialog = (diagRes) => {
        const note = WHATS_NEW[VERSION]
        /* 菜单里那条「版本与更新」已经收掉了（版本号现在直接显示在菜单头部），
           所以检查更新必须有新的入口 —— 放在这里，上下文正合适。 */
        const checkBtn = document.createElement('button')
        checkBtn.className = 'wisp-dialog-action'
        checkBtn.setAttribute('type', 'button')
        checkBtn.textContent = '检查更新'
        checkBtn.addEventListener('click', (ev) => {
          ev.preventDefault()
          closeDialog()
          showUpdate()
        })
        return openDialog('about', '关于她', [
          para('DeepSeek娘 —— DSH 界面上的浮动桌宠。她会跟着你的状态换表情：你打字她在忙，你闲着她在晃，你跑完一轮她替你高兴。'),
          para('她的样子照社区规范来：深蓝色渐变长直发、头顶一个大圆环呆毛、两片鲸鳍耳、女仆装。'),
          para('白米饭是算力的硬通货 —— 所以她每隔一阵会捧碗出来补点碳水。'),
          para('她还能陪你专注计时：菜单里开一段 25 或 45 分钟，期间她保持"干活中"，戳她一下是问还剩多久，到点她替你收工。'),
          para('这一版：' + (note || VERSION)),
          para('形象与设定参考社区项目 Neko3000/deepseek-whalechan（设定文档 CC BY-NC-SA 4.0，原作者 B站 ZipZipPipe、上善无形）。'),
          /* 上一次检查更新失败时，把宿主看到的东西摆在最显眼的位置 —— 台词只有一句，
             而"为什么拿不到"必须能被看到、被复制、被追问。 */
          diagRes ? para('上次查更新为什么没成：\n' + describeDiag(diagRes)) : null,
          checkBtn,
          dialogFoot('非官方同人作品，与 DeepSeek 官方无关', 'v' + VERSION),
        ].filter(Boolean))
      }

      /* 菜单的结构 ------------------------------------------------------------
         三段：**动作在上**（专注是最常用的，置顶）、**设置在中间**（三个可折叠分组 +
         大小滑块）、**信息在下**（动作一览 / 关于她）。每段之间有空行。
         分组的标题行直接显示当前状态（皮肤名 / 几个开关开着 / 哪个角落），
         所以收起时也知道里面是什么 —— 这是它和"一个写着外观的按钮"的区别。 */
      const onToggleCount = () => TOGGLES.filter((t) => cfg[t.key] === true).length
      const currentCorner = () => {
        const bw = boxW()
        const bh = boxH()
        const hit = CORNERS.find((c) => {
          const want = c.at(vw(), vh(), bw, bh, cfg)
          return Math.abs(want.x - coords.x) < 2 && Math.abs(want.y - coords.y) < 2
        })
        return hit ? hit.label : '自由'
      }
      const menuItems = () => [
        { kind: 'head' },
        { kind: 'sep' },
        /* 专注：最常用的动作，放最上面；进行中时这一行本身就是状态 + 结束 */
        ...(focusUntil > 0
          ? [{ label: '专注中 · 还剩 ' + Math.max(1, Math.ceil(focusLeftMs() / 60000)) + ' 分钟', run: () => stopFocus(false), accent: true, glyph: '⏱' }]
          : [
              { label: '专注 ' + cfg.focusMinutes + ' 分钟', run: () => startFocus(cfg.focusMinutes), accent: true, glyph: '⏱' },
              { label: '专注 45 分钟', run: () => startFocus(45), glyph: '⏱' },
            ]),
        { kind: 'sep' },
        {
          group: '外观', summary: skinLabel(activeSkin),
          children: [
            ...SKIN_IDS.map((id) => ({
              label: (id === activeSkin ? '✓ ' : '　') + skinLabel(id),
              skin: id,
              run: () => {
                if (id === activeSkin) return
                applySkin(id)
                say('换成' + skinLabel(id) + '了。')
              },
            })),
          ],
        },
        {
          group: '行为',
          summary: onToggleCount() + '/' + TOGGLES.length + ' 开',
          children: [
            { label: '说句话', glyph: '✦', run: () => { wake(true); say(pick(LINES.click)) } },
            { label: '睡一会儿', glyph: '☾', run: () => setMood('sleep') },
            { label: '今天做了什么', glyph: '✎', run: () => saySummary() },
            /* 余额：按需查，查完她自己说 —— 不做轮询（稳态零开销那条承诺不破）。 */
            { label: '看看余额', glyph: '¥', run: () => { checkBalance() } },
            /* 语言：三选一。切换**立刻生效**（LINES 是视图，不是死值）。 */
            {
              kind: 'choice', key: 'lang', label: '台词语言', glyph: '文',
              options: [
                { value: 'auto', label: '跟随界面' },
                { value: 'zh', label: '中文' },
                { value: 'en', label: 'English' },
              ],
            },
            /* 动作幅度：三选一。同样立刻生效 —— 它只改一个属性，CSS 全挂在上面。
               给这一档的理由：prefers-reduced-motion 是**系统级**的"所有动画都别放"，
               而"我不想让这只桌宠动来动去"是另一件事，不该逼人去改系统设置。 */
            {
              kind: 'choice', key: 'motion', label: '动作幅度', glyph: '≈',
              options: [
                { value: 'full', label: '灵动' },
                { value: 'subtle', label: '克制' },
                { value: 'off', label: '静止' },
              ],
            },
            /* 没有音效文件就不摆这个开关 —— 点了没反应的开关比没有开关更糟 */
            ...(HAS_SOUNDS ? [{ kind: 'switch', key: 'sound', label: '音效', glyph: '♪' }] : []),
            /* 开关是**真正的开关行**：带 aria-checked，点完菜单不关（就在原地更新） */
            ...TOGGLES.map((t) => ({ kind: 'switch', key: t.key, label: t.label })),
          ],
        },
        {
          group: '位置',
          summary: currentCorner(),
          children: [{ kind: 'corners' }],
        },
        { kind: 'slider' },
        { kind: 'sep' },
        { label: '动作一览…', glyph: '▤', run: () => actionsDialog() },
        { label: '关于她…', glyph: 'ⓘ', run: () => aboutDialog() },
        { kind: 'sep' },
        /* 一个开关，不是一个单向动作：从迷你按钮右键打开菜单时，它必须能把她叫回来。 */
        { label: hidden ? '回来吧' : '先躲起来', glyph: '⤓', run: () => setHidden(!hidden), muted: true },
        { kind: 'hint' },
      ]

      /* ---- 菜单的键盘驱动 ----
         菜单已经声明了 role="menu"，没有键盘支持的话，对屏幕阅读器来说比不声明更糟 ——
         它宣布了一个你无法操作的菜单。采用 roving tabindex：只有当前项 tabindex=0，
         其余 -1，焦点本身用原生 .focus()。Enter/Space 不做显式处理 —— 焦点落在真正的
         <button> 上，激活是浏览器原生行为，自己再拦一次会双重触发。 */
      let menuButtons = []
      let menuFocusAt = -1

      const focusMenuItem = (at) => {
        if (menuButtons.length === 0) return
        const next = ((at % menuButtons.length) + menuButtons.length) % menuButtons.length
        menuFocusAt = next
        for (let i = 0; i < menuButtons.length; i++) {
          const btn = menuButtons[i]
          btn.tabIndex = i === next ? 0 : -1
          btn.setAttribute('tabindex', i === next ? '0' : '-1')
          btn.setAttribute('aria-selected', i === next ? 'true' : 'false')
        }
        const target = menuButtons[next]
        if (target && typeof target.focus === 'function') {
          try { target.focus() } catch (err) { /* 焦点不可用也不该让菜单崩掉 */ }
        }
      }

      const focusHer = () => {
        if (typeof bodyEl.focus === 'function') {
          try { bodyEl.focus() } catch (err) { /* ignore */ }
        }
      }

      /* keepGroup：点分组是"在原地重开"，得把刚设好的分组带过去。
         其他入口都是新手势，一律回到收起状态 —— 所以这个重置放在这里，
         而不是 closeMenu 里（放那里会让展开动作把自己清掉）。 */
      const openMenu = (x, y, keepGroup) => {
        menuAtX = x
        menuAtY = y
        if (keepGroup !== true) closeFlyout()
        closeMenu()
        stopGlide()
        const items = menuItems()
        menuButtons = []
        const menu = document.createElement('div')
        menu.className = 'wisp-menu'
        menu.setAttribute('role', 'menu')
        menu.style.position = 'absolute'
        menuExtras = 0

        let rowIndex = -1
        for (let i = 0; i < items.length; i++) {
          const spec = items[i]
          if (spec.kind === 'head') {
            /* 头部：她是谁、哪一版、现在什么状态。不可聚焦 —— 它不是动作。 */
            const head = document.createElement('div')
            head.className = 'wisp-menu-head'
            const title = document.createElement('div')
            title.className = 'wisp-menu-title'
            title.textContent = 'DeepSeek娘'
            const subline = document.createElement('div')
            subline.className = 'wisp-menu-sub'
            const bits = ['v' + VERSION, skinLabel(activeSkin)]
            if (focusUntil > 0) bits.push('专注中')
            subline.textContent = bits.join(' · ')
            head.appendChild(title)
            head.appendChild(subline)
            menu.appendChild(head)
            menuExtras++
            continue
          }
          if (spec.kind === 'sep') {
            const sep = document.createElement('div')
            sep.className = 'wisp-menu-sep'
            menu.appendChild(sep)
            menuExtras++
            continue
          }
          if (spec.kind === 'hint') {
            const hint = document.createElement('div')
            hint.className = 'wisp-menu-hint'
            hint.textContent = '↑↓ 选择 · ←→ 调大小 · Esc 关闭'
            menu.appendChild(hint)
            menuExtras++
            continue
          }
          if (spec.kind === 'slider') { sliderRow(menu); continue }
          if (spec.header !== undefined) {
            // 小标题是分组标签，不是菜单项 —— 不能被聚焦，否则键盘用户会停在一个按不动的东西上
            const head = document.createElement('div')
            head.className = 'wisp-menu-head'
            head.textContent = spec.header
            menu.appendChild(head)
            menuExtras++
            continue
          }
          if (spec.group !== undefined) {
            /* 级联子菜单的行：右边一个 ▸，悬停/点击在**旁边**开一个独立面板。
               子项不再内联展开 —— 那是网页的手风琴，不是菜单栏。 */
            const open = flyoutName === spec.group
            const btn = document.createElement('button')
            btn.className = 'wisp-menu-item wisp-menu-row'
            btn.setAttribute('type', 'button')
            btn.setAttribute('role', 'menuitem')
            btn.setAttribute('tabindex', '-1')
            btn.setAttribute('aria-haspopup', 'true')
            btn.setAttribute('aria-expanded', open ? 'true' : 'false')
            btn.dataset.group = spec.group
            btn.dataset.open = open ? 'true' : 'false'
            btn.dataset.rowIndex = String(rowIndex)
            /* 文字直接写在按钮上，不拆成子 span：真 DOM 会汇总子节点的 textContent，
               但简化 DOM（预检的替身）不会 —— 依赖那种汇总会让分组名在替身里变成空串。 */
            btn.textContent = spec.group
            if (spec.summary !== undefined) {
              const sum = document.createElement('span')
              sum.className = 'wisp-menu-sum'
              sum.dataset.summary = '1'
              sum.textContent = spec.summary
              btn.appendChild(sum)
            }
            const caret = document.createElement('span')
            caret.className = 'wisp-menu-caret'
            caret.textContent = open && flyoutSide === 'left' ? '◂' : '▸'
            btn.appendChild(caret)
            btn.addEventListener('pointerdown', (ev) => ev.stopPropagation())
            btn.addEventListener('click', (ev) => {
              ev.preventDefault(); ev.stopPropagation()
              /* 点击 = 钉住：开着的再点一次收起 */
              if (flyoutName === spec.group) closeFlyout()
              else openFlyout(spec.group, btn, rowIndex, true)
            })
            /* 悬停展开 / 移开收起。pointerType 不为 mouse 的一律不管 ——
               触屏没有悬停，不判这个的话手指一碰就会莫名其妙展开。 */
            btn.addEventListener('pointerenter', (ev) => {
              if (!isMouse(ev)) return
              scheduleFlyoutOpen(spec.group, btn, rowIndex)
            })
            btn.addEventListener('pointerleave', (ev) => {
              if (!isMouse(ev)) return
              scheduleFlyoutClose()
            })
            menu.appendChild(btn)
            menuButtons.push(btn)
            continue
          }
          actionRow(spec, menu)
        }

        // 先挂上去再定位：定位要用最终尺寸，而尺寸只有渲染后才知道
        layer.appendChild(menu)
        menuEl = menu
        const w = MENU_W
        // 高度只用于夹取落点，所以按**实际渲染出来的行数**估算即可（假 DOM 里没有布局可测）
        const hs = MENU_PAD + menuExtras * 24 + menuButtons.length * MENU_ITEM_H
        menu.style.left = Math.round(clamp(x, 8, Math.max(8, vw() - w - 8))) + 'px'
        menu.style.top = Math.round(clamp(y, 8, Math.max(8, vh() - hs - 8))) + 'px'

        const onOutside = () => closeMenu()
        const onKey = (ev) => {
          if (ev.key === 'Escape') {
            /* 一次退一层：先关子面板，再关菜单。
               这一段必须排在"关菜单"之前 —— 排后面的话永远轮不到它。 */
            if (flyoutEl !== null) {
              if (typeof ev.preventDefault === 'function') ev.preventDefault()
              const row = flyoutRow
              closeFlyout()
              if (row && menuButtons.indexOf(row) >= 0) focusMenuItem(menuButtons.indexOf(row))
              return
            }
            closeMenu()
            focusHer()          // 关掉之后焦点要回到她身上，不能掉进 <body>
            return
          }
          if (menuButtons.length === 0) return
          const focusedRow = menuFocusAt >= 0 ? menuButtons[menuFocusAt] : null
          /* → 在分组行上：展开旁边的子菜单并把焦点送进去（菜单栏的标准操作） */
          if (ev.key === 'ArrowRight' && focusedRow && focusedRow.dataset && focusedRow.dataset.group
            && flyoutName !== focusedRow.dataset.group) {
            if (typeof ev.preventDefault === 'function') ev.preventDefault()
            openFlyout(focusedRow.dataset.group, focusedRow, Number(focusedRow.dataset.rowIndex), false)
            const firstInPanel = flyoutEl && flyoutEl.querySelectorAll ? flyoutEl.querySelectorAll('button')[0] : null
            if (firstInPanel) {
              /* 优先走 roving tabindex；万一它不在 menuButtons 里（面板的子项不止一种），
                 也要把焦点送进去 —— 否则 → 只打开了面板、焦点却留在菜单上。 */
              const at = menuButtons.indexOf(firstInPanel)
              if (at >= 0) focusMenuItem(at)
              else if (typeof firstInPanel.focus === 'function') { firstInPanel.focus(); menuFocusAt = -1 }
            }
            return
          }
          /* ← 在子菜单里：关掉它并把焦点还给父行（逐层退回） */
          if (ev.key === 'ArrowLeft' && focusInsideFlyout()) {
            if (typeof ev.preventDefault === 'function') ev.preventDefault()
            const row = flyoutRow
            closeFlyout()
            if (row) focusMenuItem(menuButtons.indexOf(row))
            return
          }
          /* 焦点在滑块上：←/→ 调大小，不移动焦点（这是滑块的常规键盘交互）。 */
          const focused = menuFocusAt >= 0 ? menuButtons[menuFocusAt] : null
          if (focused && focused.dataset && focused.dataset.slider === '1'
            && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
            if (typeof ev.preventDefault === 'function') ev.preventDefault()
            const step = ev.shiftKey ? 1 : 0.1
            applyConfig({ size: cfg.size + (ev.key === 'ArrowRight' ? step : -step) })
            /* 只更新滑块自身，不重画整张菜单 —— 焦点和展开状态都不动 */
            try {
              const SPEC = CONFIG_SPEC.size
              const ratio = clamp((cfg.size - SPEC.lo) / (SPEC.hi - SPEC.lo), 0, 1)
              const knob = focused.querySelector('.wisp-slider-knob')
              const fill = focused.querySelector('.wisp-slider-fill')
              if (knob) knob.style.left = Math.round(ratio * 100) + '%'
              if (fill) fill.style.width = Math.round(ratio * 100) + '%'
              focused.setAttribute('aria-valuenow', String(cfg.size))
              const row = focused.parentNode
              const label = row && row.querySelector ? row.querySelector('[data-slider-value]') : null
              if (label) label.textContent = Math.round(cfg.size * 100) + '%'
            } catch (err) { /* 画不出来也不该挡住改大小 */ }
            return
          }
          let at = menuFocusAt
          if (ev.key === 'ArrowDown') at = at < 0 ? 0 : at + 1
          else if (ev.key === 'ArrowUp') at = at < 0 ? menuButtons.length - 1 : at - 1
          else if (ev.key === 'Home') at = 0
          else if (ev.key === 'End') at = menuButtons.length - 1
          else if (ev.key === 'Tab') { closeMenu(); return }   // Tab 离开 = 关掉，别把人困在菜单里
          else return
          if (typeof ev.preventDefault === 'function') ev.preventDefault()
          focusMenuItem(at)
        }
        // 冒泡阶段（非捕获）：菜单项的 stopPropagation 才能拦住它
        window.addEventListener('pointerdown', onOutside)
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('resize', onOutside)
        window.addEventListener('wheel', onOutside)
        menuOff = () => {
          window.removeEventListener('pointerdown', onOutside)
          window.removeEventListener('keydown', onKey, true)
          window.removeEventListener('resize', onOutside)
          window.removeEventListener('wheel', onOutside)
        }
        // 打开即聚焦第一项：键盘用户不必先 Tab 进去
        focusMenuItem(0)
      }

      const onContext = (e) => {
        if (!hitsBody(e)) return
        e.preventDefault(); e.stopPropagation()
        openMenu(e.clientX, e.clientY)
      }
      bodyEl.addEventListener('contextmenu', onContext)

      const onResize = () => {
        coords.x = clamp(coords.x, 0, maxX())
        coords.y = clamp(coords.y, 0, maxY())
        paint()
      }
      window.addEventListener('resize', onResize)

      /* ---- 你离开又回来 --------------------------------------------------------
         visibilitychange 是唯一能知道"你去忙别的了"的信号。离开时长按两个阈值分档：
         短走一句、长走一句；backAfterMs: 0 就整个关掉。
         注意监听要能摘掉（destroy 里 remove）—— 文档级监听泄漏过一次，记住这个教训。 */
      const BACK_LONG_MS = 900000
      const onVisibility = () => {
        let state = 'visible'
        try { state = document.visibilityState === 'hidden' ? 'hidden' : 'visible' } catch (e) { state = 'visible' }
        if (state === 'hidden') {
          awayAt = nowMs()
          /* 絮叨和踱步停掉（它们本来就只给看得见的人看），但**轮询放慢而不是停掉** ——
             值班的前提是还看得见：你走开时跑完的那几轮、出的错，都得记下来。 */
          paused = true
          awayWatch = { runs: 0, errors: 0, longestMs: 0, at: awayAt }
          syncPoll()
          syncChatter()
          syncWander()
          if (pollHandle) { clock.cancel(pollHandle); pollHandle = null }
          pollHandle = clock.every(HIDDEN_POLL_MS, poll)
          return
        }
        /* 回来了：先恢复再算问候 —— 恢复是必须的，问候才是锦上添花 */
        if (paused) {
          paused = false
          syncPoll()
          syncChatter()
          syncWander()
        }
        if (awayAt === 0) return
        const away = nowMs() - awayAt
        const watch = awayWatch
        awayWatch = null
        awayAt = 0
        if (!(cfg.backAfterMs > 0) || away < cfg.backAfterMs) return
        wake(true)
        /* 有账就报账（这才是"值班"的意义）；没账才是普通的那句问候。 */
        if (watch !== null && (watch.runs > 0 || watch.errors > 0)) {
          const bits = []
          if (watch.runs > 0) bits.push(pick(LINES.awayRuns).split('{n}').join(String(watch.runs)))
          if (watch.errors > 0) bits.push(pick(LINES.awayErrors).split('{n}').join(String(watch.errors)))
          setMood('report')
          say(pick(LINES.awayOpen) + bits.join(''))
          return
        }
        say(pick(away >= BACK_LONG_MS ? LINES.backLong : LINES.backSoon))
      }
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', onVisibility)
      }

      attach()
      /* 打招呼按时段取：凌晨三点和上午十点不该说同一句话。时段在**挂载时**取一次 ——
         一个挂了一整天的页面不该在过零点后突然换口气，那反而像 bug。 */
      const greetHour = hourNow()
      const greetName = greetPoolName(greetHour)
      clock.after(800, () => say(pick(greetPool(greetName))))

      /* 连续天数：第 2 天起才提（第一天说"连续第 1 天"很怪）；到里程碑单独说一句。 */
      const streak = streakOf(memory.days)
      if (streak >= 2 && cfg.memory) {
        const hitMilestone = STREAK_MILESTONES.indexOf(streak) >= 0
        clock.after(2600, () => {
          if (destroyed) return
          const text = pick(hitMilestone ? LINES.milestone : LINES.streak).split('{n}').join(String(streak))
          flashHappy(text)
        })
      }

      /* ---- 她更新了吗 --------------------------------------------------------
         插件不能联网，所以"检查更新"它做不了。但**它知道自己现在是哪一版** —— 于是能做到
         一件真事：上次见到的是旧版本，这次不是了，那就是更新过了，说一句。
         第一次安装（没记录）不吭声：那时候她还没"更新"，只是刚来。 */
      const seenVersion = readStored(SEEN_VERSION_KEY)
      if (typeof seenVersion === 'string' && seenVersion !== VERSION) {
        clock.after(1600, () => {
          if (destroyed) return
          flashHappy('我更新到 ' + VERSION + ' 了。')
        })
      }
      writeStored(SEEN_VERSION_KEY, VERSION)
      /* 记忆台词排在三件事之后：打招呼（0.8s）、首次右键提示（约 3.6s）。
         曾经和提示撞在同一秒，结果两条互相盖掉 —— 挪到 7 秒，彼此都有位置。 */
      if (cfg.reactions) {
        clock.after(7000, () => {
          if (destroyed) return
          const remark = memoryRemark()
          if (remark === null) return
          if (remark.mood === 'proud') flashProud(remark.text)
          else flashHappy(remark.text)
        })
      }
      /* 第一次见面时提一句右键 —— 菜单是主要入口，但从外观上完全看不出来。
         只提一次：第二次见面还念叨就成了骚扰。 */
      if (cfg.persist && readStored(HINT_KEY) === null) {
        clock.after(3600, () => {
          if (destroyed) return
          say(pick(LINES.hint))
          writeStored(HINT_KEY, { told: true })
        })
      }
      wake(true)
      if (hidden) showTab()

      /* warm the other sprites after the first frame so mood changes never blink */
      clock.after(1500, () => {
        if (destroyed) return
        /* 预热其余的精灵图。没有 Image 构造函数的地方（简化 DOM）就跳过，
           预热本来就是锦上添花，不该把整只宠物带崩 —— 这里原来硬用裸的 new Image()。 */
        const ImageCtor = imageCtor()
        if (ImageCtor === null) return
        for (const key in SPRITES[activeSkin]) {
          if (key === currentSprite) continue
          const pre = new ImageCtor()
          pre.src = resolveSprite(spriteOf(key))
        }
      })

      const applyConfig = (partial) => {
        mergeConfig(cfg, partial)
        // configure({skin: '…'}) 也要能换皮肤，否则配置与菜单两条路会不一致
        if (partial && typeof partial.skin === 'string' && partial.skin !== '') applySkin(partial.skin)
        // 尺寸也要活过刷新：位置/皮肤/隐藏都记了，只有尺寸不记会显得前后不一致
        if (cfg.persist && partial && typeof partial === 'object' && partial.size !== undefined) {
          writeStored(PREFS_KEY, { size: cfg.size })
        }
        /* 语言选择存到**语言键**上（不是 PREFS_KEY）：它在**加载时**就会被读，
           所以下次打开才生效。菜单里的胶囊切的是"以后说哪种话"。 */
        if (partial && typeof partial === 'object' && typeof partial.lang === 'string') {
          try { window.localStorage.setItem('dsh-wisp-lang', cfg.lang) } catch (e) { /* 存不了就算了 */ }
        }
        // A bigger companion occupies a bigger box, so the stored position has
        // to be re-clamped or she would grow off the edge.
        root.style.width = Math.round(boxW()) + 'px'
        root.style.height = Math.round(boxH()) + 'px'
        layer.style.setProperty('--wisp-scale', String(cfg.size))
        /* 尺寸变了，命中层的形状也要跟着缩放（clip-path 里的坐标是 px，不是百分比）。 */
        applyHitClip(currentSprite)
        /* 动作档位也要当场生效（菜单里的胶囊就靠这一行）：它只改一个属性，
           CSS 那边所有幅度规则都挂在它上面。 */
        if (partial && typeof partial === 'object' && partial.motion !== undefined) applyMotion()
        coords.x = clamp(coords.x, 0, maxX())
        coords.y = clamp(coords.y, 0, maxY())
        paint()
        armSleep()
        syncPoll()
        syncChatter()
        syncWander()
        // 开关 backdrop 之后要立刻生效，不用刷新页面
        if (partial && typeof partial === 'object' && partial.backdrop !== undefined) {
          backdropReport = applyBackdrop()
        }
        return api
      }

      /* ---- 检查更新 -----------------------------------------------------------
         浏览器半包的 fetch 是教学陷阱，宿主半包又在 vm 沙箱里没有 Node API ——
         所以这条必须走**平台给的服务**：宿主半包 inject 'web'，用 ctx.web.fetch 抓
         远端 package.json，再用 harness.handle 注册成 checkUpdate，这边用 host.call 调。

         host 是 shell 注入的名字，不是全局：拿不到就如实说"查不了"，不许抛。 */
      let updateCheck = { state: 'idle', at: 0 }
      /* 上一次真正复制给用户的提示语（doctor 里能看到）—— "她让你装的是哪个" 必须可查，
         否则"按包名安装"和"用 GitHub 地址装"这两条路到底走了哪条就没人说得清。 */
      let lastUpdateHint = UPDATE_HINT

      const compareVersions = (a, b) => {
        const parse = (v) => String(v).split('-')[0].split('.').map((n) => {
          const x = Number.parseInt(n, 10)
          return Number.isFinite(x) ? x : 0
        })
        const left = parse(a)
        const right = parse(b)
        for (let i = 0; i < Math.max(left.length, right.length); i++) {
          const l = left[i] ?? 0
          const r = right[i] ?? 0
          if (l !== r) return l < r ? -1 : 1
        }
        return 0
      }

      /* shell 把 host 作为闭包符号给它；typeof 对未声明名字是安全的，
         但如果 shell 根本没提供，这里只会得到 undefined，不会炸。 */
      const hostSeat = () => {
        try {
          if (typeof host !== 'undefined' && host && typeof host.call === 'function') return host
        } catch (e) { /* 没这个座位 */ }
        return null
      }

      const checkForUpdate = () => {
        const seat = hostSeat()
        if (seat === null) {
          updateCheck = { state: 'unsupported', at: nowMs() }
          return Promise.resolve(updateCheck)
        }
        updateCheck = { state: 'checking', at: nowMs() }
        return Promise.resolve()
          .then(() => seat.call('checkUpdate', { current: VERSION }))
          .then((res) => {
            if (!res || res.ok !== true || typeof res.latest !== 'string') {
              /* 失败时也要把**每个源各自的原因**留下来。用户看到的是"没查成"，
                 而 doctor() 必须能说清是"这个壳里没有网络服务"还是"两个源都没连上" ——
                 以前这里把 sources 丢了，失败就变成一句无法追问的话。 */
              updateCheck = {
                state: 'failed',
                reason: (res && res.reason) || 'no-result',
                sources: (res && res.sources) || null,
                /* 宿主看到的诊断也要留下来 —— 失败台词会把它念出来，doctor 里也能查。 */
                diag: (res && res.diag) || null,
                at: nowMs(),
              }
            } else if (compareVersions(VERSION, res.latest) < 0) {
              /* from / sources 一起留着：两个源不一致时（npm 暂存、GitHub 已更新），
                 "这个数字是哪儿来的"比数字本身更需要能查。 */
              updateCheck = { state: 'available', latest: res.latest, from: res.from ?? null, sources: res.sources ?? null, at: nowMs() }
            } else {
              updateCheck = { state: 'current', latest: res.latest, from: res.from ?? null, sources: res.sources ?? null, at: nowMs() }
            }
            return updateCheck
          })
          .catch((err) => {
            updateCheck = {
              state: 'failed',
              reason: 'call-failed',
              detail: String(err && err.message ? err.message : err),
              at: nowMs(),
            }
            return updateCheck
          })
      }

      /* ---- 看余额 -------------------------------------------------------------
         和"检查更新"走同一条路，但服务不同：宿主半包 inject 'deepseekAccount'，
         用平台自己的账户服务取余额。**插件从头到尾不碰 API key** —— 凭据在平台
         手里，浏览器半包连读都读不到（它没有网络，fetch 是陷阱）。

         未登录、读不到、这个壳里没有那个服务，是三句不同的话：
         说是"查不到"但其实是"没登录"，就是在骗人。 */
      let balanceCheck = { state: 'idle', at: 0 }

      /* 金额由客户端拼，台词只管口气。货币符号认不出来就原样写代码。 */
      const balanceAmount = (wallets) => {
        const bits = []
        for (const w of (Array.isArray(wallets) ? wallets : [])) {
          if (!w || typeof w.balance !== 'string') continue
          const sign = w.currency === 'CNY' ? '¥' : (w.currency === 'USD' ? '$' : '')
          bits.push(sign === '' ? (w.balance + (w.currency ? ' ' + w.currency : '')) : sign + w.balance)
        }
        return bits.join(' + ')
      }

      const balanceLine = (res) => {
        if (res.state === 'ready') {
          const main = balanceAmount(res.wallets)
          if (main === '') return pick(LINES.balanceEmpty)
          const text = pick(LINES.balance).split('{n}').join(main)
          const bonus = balanceAmount(res.bonusWallets)
          return bonus === '' ? text : text + pick(LINES.balanceBonus).split('{n}').join(bonus)
        }
        if (res.state === 'signed-out') return pick(LINES.balanceSignedOut)
        if (res.state === 'unavailable') return pick(LINES.balanceUnavailable)
        if (res.state === 'unsupported') return pick(LINES.balanceUnsupported)
        return pick(LINES.balanceFailed)
      }

      /* 按需查：菜单里那一行和 `__wisp.checkBalance()` 都走这里。
         它**自己说话**（先"看一下……"再报结果）—— 菜单点完就关了，留一个
         只返回状态、不出声的函数，用户会以为没反应。 */
      const checkBalance = () => {
        const seat = hostSeat()
        if (seat === null) {
          balanceCheck = { state: 'unsupported', at: nowMs() }
          wake(true)
          say(balanceLine(balanceCheck))
          return Promise.resolve(balanceCheck)
        }
        balanceCheck = { state: 'checking', at: nowMs() }
        wake(true)
        say(pick(LINES.balanceChecking))
        return Promise.resolve()
          .then(() => seat.call('checkBalance', { locale: LANG_TAG }))
          .then((res) => {
            if (!res || res.ok !== true) {
              balanceCheck = { state: 'failed', reason: (res && res.reason) || 'no-result', at: nowMs() }
            } else if (res.status === 'ready') {
              balanceCheck = {
                state: 'ready',
                wallets: Array.isArray(res.wallets) ? res.wallets : [],
                bonusWallets: Array.isArray(res.bonusWallets) ? res.bonusWallets : [],
                at: nowMs(),
              }
            } else if (res.status === 'signed-out' || res.status === 'unavailable') {
              balanceCheck = { state: res.status, at: nowMs() }
            } else {
              /* 平台答了，答案是 failed —— 是结果，不是异常。 */
              balanceCheck = { state: 'failed', reason: 'service-failed', at: nowMs() }
            }
            say(balanceLine(balanceCheck))
            return balanceCheck
          })
          .catch((err) => {
            balanceCheck = {
              state: 'failed',
              reason: 'call-failed',
              detail: String(err && err.message ? err.message : err),
              at: nowMs(),
            }
            say(balanceLine(balanceCheck))
            return balanceCheck
          })
      }

      /* 版本号来自 GitHub，而 npm 上那份**不是同一个号**（通常是 npm 暂存或还没发）——
         这时候"按包名安装"会把人送回旧版。 */
      const githubOnlyNewer = (res) => {
        if (!res || res.state !== 'available' || res.from !== 'github') return false
        const npm = res.sources && res.sources.npm
        return !!(npm && npm.ok === true && npm.version !== res.latest)
      }

      const updateLine = (res) => {
        if (res.state === 'available') return pick(LINES.updateAvailable) + res.latest
        if (res.state === 'current') return pick(LINES.updateCurrent)
        /* 失败要说清是哪一种：没有通道 / 连不上 / 宿主没应答。
           `no-web-service` 是"这个壳根本没有联网入口"，不是"网络不好"——
           以前两者共用一句"没查到更新"，于是诊断只能靠猜。 */
        if (res.state === 'unsupported' || res.reason === 'no-web-service') return pick(LINES.updateNoChannel)
        if (res.reason === 'call-failed') return pick(LINES.updateNoHost)
        return pick(LINES.updateFailed)
      }

      /* 技术的部分**不进台词**（台词是给人读的一句话，塞进去就是一串英文碎片），
         但必须看得见 —— 失败时把宿主实际看到的排进「关于她」弹窗：
         取服务的方式、拿到的东西是什么形状、兜底通道为什么也不行。
         这是"她说查不了"和"我知道为什么"之间的那一步。 */
      const describeDiag = (res) => {
        const diag = res && res.diag
        if (!diag || typeof diag !== 'object') return '这次连诊断信息都没有拿到。'
        const lines = ['通道：' + String(diag.via || '未知')]
        if (diag.how) lines.push('取服务的方式：' + String(diag.how))
        if (diag.why) lines.push('看到的东西：' + String(diag.why))
        if (diag.registry) lines.push('插件管理器的 registry：' + String(diag.registry))
        if (diag.manager) lines.push('兜底通道：' + String(diag.manager))
        return lines.join('\n')
      }

      /* 把包名复制到剪贴板，便于在 DSH 的「按插件包名安装」里粘贴。
         没有剪贴板权限（或不是安全上下文）时**静默降级**成只说话 —— 不该因此报错。 */
      const copyText = (text) => {
        try {
          const nav = window.navigator
          const cb = nav && nav.clipboard
          if (cb && typeof cb.writeText === 'function') {
            const p = cb.writeText(text)
            if (p && typeof p.catch === 'function') p.catch(() => {})
            return true
          }
        } catch (e) { /* 降级 */ }
        return false
      }

      /* 「版本与更新」：说出当前版本与这一版的要点，并把包名复制好。
         用户点这一项想知道的就是这两件事。 */
      const showUpdate = () => {
        const note = WHATS_NEW[VERSION]
        let hint = UPDATE_HINT
        const copied = copyText('dsh-wisp')
        /* 一步到位：先把"我是谁、这一版做了什么"说出来，同时去查有没有新版；
           查回来再用一句话覆盖掉 —— 一次只冒一个气泡，所以是"说完结果就结束"。 */
        const base = '我是 ' + VERSION + '。'
        flashHappy(note ? base + note : base)
        const started = checkForUpdate()
        if (started && typeof started.then === 'function') {
          started.then((res) => {
            if (destroyed) return
            if (res.state === 'checking') return
            /* 新版只在 GitHub 上 → 改口 + 把仓库地址放进剪贴板（包名会装回旧版）。 */
            if (githubOnlyNewer(res)) {
              hint = UPDATE_HINT_GITHUB
              lastUpdateHint = hint
              copyText(UPDATE_REPO)
            }
            flashHappy(base + updateLine(res))
            /* 查不成的时候：把"为什么"摆到弹窗里（台词只留一句人话）。 */
            if (res.state === 'failed') aboutDialog(res)
          })
        }
        lastUpdateHint = hint
        return { version: VERSION, note: note || null, copied, checking: true }
      }

      const api = {
        version: VERSION,
        clock: clock.mode,
        say,
        mood: setMood,
        move(x, y) { coords.x = x; coords.y = y; paint() },
        configure: applyConfig,
        resetPosition() {
          try { window.localStorage.removeItem(POSITION_KEY) } catch (e) { /* ignore */ }
          coords.x = clamp(vw() - cfg.right - boxW(), 0, maxX())
          coords.y = clamp(vh() - cfg.bottom - boxH(), 0, maxY())
          paint()
        },
        get element() { return root },
        get sprites() { return Object.keys(SPRITES[activeSkin]) },
        get skins() { return SKIN_IDS.slice() },
        /* 读用 skin、写用 setSkin。同一个对象字面量里 get skin() 与 skin: fn
           不能共存 —— 后者会静默覆盖前者，读出来就成了函数。 */
        get skin() { return activeSkin },
        setSkin: applySkin,
        showUpdate,
        checkForUpdate,
        /* 弹窗与折叠分组：菜单结构变了之后，测试要能问"现在开着哪个弹窗 / 哪个分组"。 */
        /* 专注计时器：脚本与测试都能驱动 */
        startFocus,
        stopFocus,
        saySummary,
        checkBalance,
        get today() { return { ...watchToday() } },
        get focus() { return focusState() },
        openAbout: () => aboutDialog(),
        openActions: () => actionsDialog(),
        closeDialog,
        previewMood,
        get dialog() { return dialogKind },
        get menuGroup() { return flyoutName },
        get menuSide() { return flyoutSide },
        get updateCheck() { return { ...updateCheck } },
        get hidden() { return hidden },
        hide: () => setHidden(true),
        show: () => setHidden(false),
        /* 读实时配置（Console 里 `__wisp.config` 是唯一能看到生效值的地方）。给的是副本。 */
        get config() { return Object.assign({}, cfg) },
        goCorner,

        /* -----------------------------------------------------------------
           doctor() —— 自检：这个页面里，插件依赖的每个钩子到底能不能解析。

           存在的理由：这些选择器是我读 DSH 源码推出来的，而**它们错了不会有任何报错** ——
           对应的功能只是永远不触发，看起来像"她今天没反应"。而插件跑在带鉴权的页面里，
           外部脚本（包括我这边的浏览器）连不上，所以自检必须由插件自己在页面里提供。

           只读，无副作用。Console 里敲 `__wisp.doctor()` 即可。
           ----------------------------------------------------------------- */
        doctor() {
          const probe = (selector) => {
            try { return document.querySelectorAll(selector).length } catch (e) { return -1 }
          }
          const composer = COMPOSER_HOOKS.map((selector) => ({ selector, matches: probe(selector) }))
          const pending = PENDING_ATTRS.map((attr) => ({
            selector: '[' + attr + ']',
            matches: probe('[' + attr + ']'),
          }))
          const body = document.body
          /* 走 window. 而不是裸全局：客户端半包可能运行在"被提供的 window ≠ 环境全局"之下，
             裸 getComputedStyle 会解析到别处（或不存在）。nowMs 当初就是这么坏掉的。 */
          const style = body && window && typeof window.getComputedStyle === 'function'
            ? window.getComputedStyle(body)
            : null
          const tokens = THEME_TOKENS.map((token) => ({
            token,
            value: style ? style.getPropertyValue(token).trim() : '',
          }))

          /* 把"数字"翻译成"哪个功能会失效"，否则这份报告没人看得懂。
             只列**真的意味着失效**的条件：待处理面板与出错行缺席是正常状态，
             把它们算进 problems 只会训练人忽略这份清单。 */
          const problems = []
          if (!composer.some((h) => h.matches > 0)) {
            problems.push('输入框钩子一个都没匹配到 —— 若你此刻正开着会话（能看到输入框），'
              + '就是钩子失效了：「你在打字时她进入待命」不会触发')
          }
          if (tokens.every((t) => t.value === '')) {
            problems.push('主题令牌全为空 → 亮暗跟随退化成默认色')
          }
          if (!body) problems.push('document.body 不存在')

          const busyMatches = probe(STOP_SELECTOR)
          /* 忙碌钩子是唯一无法静态确认的：它的 aria-label 来自语言表，而不是源码里的字面量
             （其余 data-* 钩子我已在已发布的 app.asar 里逐个确认存在）。所以找不到时，把页面上
             实际存在的按钮 aria-label 一起报出来 —— 一次 doctor() 就能看出真正的标签是什么。 */
          const sampleAriaLabels = () => {
            try {
              const all = document.querySelectorAll('button[aria-label]')
              const out = []
              for (let i = 0; i < all.length && out.length < 12; i++) {
                const label = all[i].getAttribute('aria-label')
                if (label && out.indexOf(label) < 0) out.push(label)
              }
              return out
            } catch (e) {
              return []
            }
          }

          return {
            version: VERSION,
            clock: clock.mode,
            mood,
            skin: activeSkin,
            hidden,
            position: { x: Math.round(coords.x), y: Math.round(coords.y) },
            config: Object.assign({}, cfg),
            hooks: {
              composer,
              busy: busyMatches === 0
                ? { selector: STOP_SELECTOR, matches: 0, ariaLabelsOnPage: sampleAriaLabels() }
                : { selector: STOP_SELECTOR, matches: busyMatches },
              pending,
              error: { selector: ERROR_SELECTOR, matches: probe(ERROR_SELECTOR) },
            },
            dark: !!(body && body.hasAttribute('data-ds-dark-theme')),
            /* 余额：最后一次查的结果 + 有没有 host 座位。**凭据从不经过这里** ——
               插件拿不到 key，也就不可能被谁从 doctor() 里读走。 */
            balance: Object.assign({ hostSeat: hostSeat() !== null }, balanceCheck),
            /* 动作层的实时状态。姿势角是**屏幕坐标**里的角度（未乘镜像），
               accent 是当下挂着的一次性动作 —— "她为什么歪着/弹了一下"
               在 Console 里一眼能看出来，不用去读样式。 */
            motion: {
              level: cfg.motion,
              amp: amp(),
              reduced: reduced(),
              tilt: Math.round(tiltScreen * 100) / 100,
              tiltLocal: tiltWritten,
              accent: root.dataset.accent || null,
              pressed: root.dataset.dragging === 'true',
            },
            tokens,
            /* 窗口背景：Mica 能不能露出来，取决于页面有没有在背景处画不透明像素。
               blockers 是"每个采样点上最上面那个铺满视口的画底色的元素"，
               cleared 是已经被清掉的那些 —— 一眼就能看出有没有找对。 */
            backdrop: {
              enabled: !!cfg.backdrop,
              blockers: backdropReport.blockers,
              cleared: backdropReport.cleared,
              skipped: backdropReport.skipped,
              errors: backdropReport.errors,
            },
            /* 页面上到底有几个她。只要不是 1 就是 bug，而这件事必须能被一眼看见 ——
               "出现了两个她"最早是从用户嘴里知道的，不该是这样。 */
            /* 更新相关的实情：当前版本、这一版做了什么、以及更新该走哪条路。
               注意：插件自己**没有**联网能力，这里给的是"怎么做"，不是"帮你做"。 */
            update: {
              version: VERSION,
              whatsNew: WHATS_NEW[VERSION] ?? null,
              seenBefore: readStored(SEEN_VERSION_KEY),
              hint: lastUpdateHint,
              canSelfUpdate: false,
              /* 上一次检查的结果（idle / checking / current / available / failed / unsupported） */
              lastCheck: { ...updateCheck },
              why: '宿主半包在 vm 沙箱里，harness 只有 defineTool/registerTool/handle，Node API 被 nodeApiTraps 挡住',
            },
            /* 干饭：不用猜"她为什么突然捧碗" */
            hunger: { enabled: cfg.hungry === true, everyMs: cfg.hungerMs, lastMealAt: Math.round(lastMealAt) },
            /* 深夜：窗口是可配的，所以把算出来的窗口一起报出来 */
            night: {
              enabled: cfg.night === true,
              window: [cfg.bedtimeHour, cfg.wakeHour],
              deepFrom: deepHourOf(cfg.bedtimeHour),
              hour: hourNow(),
              lastAt: Math.round(lastNightAt),
            },
            streak: streakOf(memory.days),
            /* 语言判定的输入与结果 —— 中英文走岔时能一眼看清是哪一层不对 */
            lang: {
              tag: LANG_TAG, zh: isZhNow(), choice: (cfg && typeof cfg.lang === 'string') ? cfg.lang : 'auto',
              stored: langStored, html: langHtml, pools: Object.keys(LINES_EN).length,
            },
            awaySince: Math.round(awayAt),
            /* 今天记了什么 —— 不用猜"她为什么说今天跑了 7 轮" */
            today: { ...watchToday() },
            /* 走开期间的值班记录（不在值班时为 null） */
            watch: awayWatch === null ? null : { ...awayWatch, forMs: Math.round(nowMs() - awayWatch.at) },
            /* 单轮跑了多久、有没有已经提过 —— 断言失败时能自己说出原因，不用猜 */
            runInFlightMs: busySince > 0 && lastBusy ? Math.round(nowMs() - busySince) : 0,
            longRunSaid: longRunSaidAt > 0,
            /* 专注：不用猜"她为什么一直站在干活中" */
            focus: focusState(),
            /* 定时器是否挂着；页面藏起来时三个都该是 false */
            timers: {
              poll: pollHandle !== null,
          pollMs: paused ? HIDDEN_POLL_MS : cfg.pollMs, chatter: chatterHandle !== null,
              wander: wanderHandle !== null, paused,
            },
            /* 今日轮次：不用猜"她为什么突然得意"，数字就在这里 */
            runsToday: { day: runsToday.day, count: runsToday.count, said: runsToday.said.slice() },
            /* 她记着你：一起多少天、习惯放在哪、常穿哪套、已经说过哪些 */
            memory: {
              days: memory.days.length,
              topCorner: topOf(memory.corners),
              topSkin: topOf(memory.skins),
              said: memory.said.slice(),
              remarkDay: memory.remarkDay,
            },
            instances: (() => {
              try {
                return { layers: document.querySelectorAll('.wisp-layer').length, roots: document.querySelectorAll('.wisp-root').length }
              } catch (e) { return { layers: -1, roots: -1 } }
            })(),
            /* 时段招呼：报告当前用的是哪一套、几分钟前算的。她在凌晨和上午的口气不同，
               而这些文案是按小时选的 —— 报告出来，就不用靠猜"她现在为什么这么说"。 */
            greeting: {
              pool: greetName,
              hour: greetHour,
              poolSize: greetPool(greetName).length,
              pools: { morning: LINES.morning.length, afternoon: LINES.afternoon.length, evening: LINES.evening.length, night: LINES.night.length },
            },
            problems,
            /* 已知的下一步：SessionSnapshot 里有权威的 `running` 与 `lastAgentError`
               （经 sessions.binding(id).session）。它比 busy/error 两个 DOM 选择器可靠得多，
               但需要先拿到当前会话 id，而且我无法在带鉴权的页面外验证 —— 所以先记在这里。 */
            sessionsService: !!(ctx && typeof ctx.get === 'function' && ctx.get('sessions')),
          }
        },
        get skinLabels() { return SKIN_IDS.map((id) => ({ id, label: skinLabel(id) })) },
        get position() { return { x: Math.round(coords.x), y: Math.round(coords.y) } },
        get currentMood() { return mood },
        destroy() {
          if (destroyed) return
          destroyed = true
          rememberPosition()
          clock.dispose()
          for (const ev of WAKE_EVENTS) window.removeEventListener(ev, wake)
          window.removeEventListener('resize', onResize)
          if (typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibility)
          }
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointermove', leanToPointer)
          window.removeEventListener('blur', resetTilt)
          bodyEl.removeEventListener('pointerdown', onDown)
          bodyEl.removeEventListener('keydown', onBodyKey)
          bodyEl.removeEventListener('contextmenu', onContext)
          closeMenu()
          closeDialog()
          if (dialogKeyOff) { dialogKeyOff(); dialogKeyOff = null }
          hideTab()
          if (typeof offTheme === 'function') {
            try { offTheme() } catch (e) { /* ignore */ }
            offTheme = null
          }
          if (typeof styleDispose === 'function') {
            try { styleDispose() } catch (e) { /* ignore */ }
        /* 背景规则也要收掉：她自己的东西必须自己清干净，不能留在页面上 */
        removeBackdropStyle()
          }
          if (layer.parentNode) layer.remove()
          revokeSprites()
          if (window.__wisp === api) delete window.__wisp
        },
      }
      window.__wisp = api
      return api
    }

    const plugin = {
      name: 'wisp',
      apply(ctx, config) {
        try {
          /* Single instance, always. A re-apply (HMR, a duplicate row, or the
             console-injection build) must replace the companion rather than
             stack a second one on top of it. */
          const previous = window.__wisp
          if (previous && typeof previous.destroy === 'function') {
            try { previous.destroy() } catch (e) { /* never let a dead instance block a live one */ }
          }
          const instance = mount(config, ctx)
          if (ctx && typeof ctx.effect === 'function') {
            ctx.effect(() => () => instance.destroy(), 'dsh-wisp: teardown')
          }
          if (typeof console !== 'undefined' && console.log) {
            console.log('[wisp] mounted — DeepSeek娘 v' + VERSION + ' (timers: ' + instance.clock + ')')
          }
        } catch (error) {
          if (typeof console !== 'undefined' && console.error) {
            console.error('[wisp] mount failed', error && error.message)
          }
        }
      },
    }

    exports.default = plugin
    exports.plugin = plugin
    exports.apply = plugin.apply
    exports.name = plugin.name
    exports.version = VERSION

    return module.exports
  },
})
