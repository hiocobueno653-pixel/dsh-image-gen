# dsh-image-gen —— DSH 生图插件

把「生图」接进 DSH：一个可换服务的图像 API 客户端 + 一条不说话的生图流水线。
**直接说话**（不需要任何命令）→ 工具卡先出 GridReveal 动画 → 图好了动画消失换成图片。
工具内部自动优化提示词，所以模型不需要替用户润色，也就不会在对话里写一堆文字。

> ⚠️ **本仓库不含任何服务商信息、端点与密钥。** `cordis.patch.yml` 里的 `baseUrl` / `model`
> 故意留空，装好后必须自己填（设置 · 图像模型，或直接改插件配置）。密钥只从环境变量 /
> `$DSH_HOME/.env` 读，或填在设置页里（存本机 `models.json`，不随仓库分发）。

## 安装

```yaml
# ~/.dsh/profiles/<profile>/package.json 的 dsh.profile.bundles 里加一行
"dsh-image-gen"
```

```bash
# 本地开发：把插件链进 profile
dsh plugin add "file:/path/to/dsh-image-gen"
```

然后填两个必填项（任一方式）：

```yaml
# 方式 A：插件配置
baseUrl: https://your-image-api.example.com    # 你的图像 API 地址
model: your-model-name                          # 该服务上的模型名
```

方式 B：打开 设置 · 图像模型，点「+ 添加图像模型」填表（支持多家、可切换当前使用）。
密钥用范围：页面里直接填的 `apiKey` → 条目自己的 `apiKeyEnv` → 插件全局 `apiKeyEnv`；
环境变量名默认 `IMAGE_API_KEY`。

协议：默认走 `POST {baseUrl}/v1/images/generations`（`{ model, prompt, size, ratio, extra_body }`，
返回 `data[].url` 或 `data[].b64_json`）。如果你的服务是 OpenAI 兼容形状，把接口类型选成
「OpenAI 兼容」即可（改用像素 `size` 与顶层 `response_format`）。

## 用法

直接说，例如：

```
画一张：一只趴在窗台的橘猫，午后阳光
只生成图片：赛博朋克雨夜街道，霓虹倒影
给我配一张产品海报图，玻璃立方体在白色影棚里，16:9
```

不需要 `/img` 之类的命令（斜杠命令已移除）。尺寸档位与宽高比由模型从你的话里取，默认 `2K` + `1:1`。

## 演示

- 演示视频（MP4，约 36 秒）：[assets/demo-generate-image.mp4](assets/demo-generate-image.mp4)
- 内容：说一句话生成沙滩图片 → GridReveal 动画 → 显影出图。

## 生图不是消息：这一轮的 Turn 尾卡片

**图片不画在工具行里。** 它渲染在**该轮的 Turn 尾**——`conversation.chat.turnTail` 席位，
位置在收尾文案下方、过程组**之外**，跟着对话流走，但**永远不会被折叠收掉**。

```
用户的提问
（过程组：思考 / 别的工具 —— 该折就折，随便）
助手的收尾文案                     ← 宿主渲染
★★ 图片卡片（Turn 尾席位，本插件）  ← 永不被折叠、刷新后按会话日志重建
已完成，用时 N 秒
```

### 为什么不能塞在工具行里（这是"图片有时看不见"的根因）

宿主 `ui-chat` 的 `ChatGroupSeat` 对工具调用有两层折叠：

```js
// ui-chat bundle
const grouped     = policy.stepGrouping === "collapsed" ||
                    (policy.stepGrouping === "history" && turnLocation?.status !== "open");
const outerHidden = foldCompleted && presentation?.turnClosed === true && spec !== undefined &&
                    !alwaysOpen && stored?.answerStep !== (spec.answerStep ?? 0);
```

而 `POLICIES` 里默认档位（`standard`，桌面端默认）是 `foldCompletedTurns: true` +
`stepGrouping: "collapsed"`——**两条都为真**。于是回合一结束，整个过程组连同里面的图片
被 `hidden` 掉（`useSearchableHidden(outerHidden)`）。图在组里 = 图迟早会消失。

靠 CSS 覆盖 `content-visibility`、或 JS 摘 `hidden` 都是**在跟宿主的折叠对抗**：
React 每次重渲染都可能补回来，而且过程组一多就分不清是谁的。

### 官方给的位置：Turn 级 Definition + turnTail 席位

这条路子是照 `ui-schedule` 的 `schedule_create` 卡片抄的（官方包自己就这么写）：

```js
// 1) Definition：只记数据、不产出视图节点；把每一轮的落地结果发布到 Turn 上
ctx.uiConversation.events.register({
  kind: "image-gen-images",
  match: (event) => /* turn/start | tool/call | tool/result → { id: turn, role } */,
  start: (_ctx, match) => ({ turn, calls: new Map(), images: [] }),
  update: (context, match) => /* 记住 tool/call 的 name/args；tool/result 里挑出 generate_image */,
  buildLocationData: (context, scope) => scope === "turn"
    ? { kind: "turn", turn, key: "image-gen-images", value: { images } }
    : null,
});

// 2) 席位：渲染在收尾文案下方、过程组之外
ctx.slots.register({ name: "conversation.chat.turnTail", id: "image-gen", order: 30 }, Card);
```

好处：**不用对抗折叠**（这个位置本来就不折）；**靠会话日志重放重建**——
刷新页面、换设备、隔天再打开，卡片都还在，不需要任何宿主侧状态。

### 三个席位怎么分工

| 席位 | 职责 | 产出 |
| --- | --- | --- |
| `tool.call.toolview`（key=`generate_image`） | 生成中的动画 + 状态上报 | 0 尺寸标记 `[data-slot='image-gen-slot']`（带 `data-image-gen-state=running\|done`）+ GridReveal 方框 |
| 同一个组件（副作用） | 在宿主渲染的 tool-call **行**上打 `data-image-gen-row=running\|done` | CSS 靠它判断"这一组是不是只有生图" |
| `conversation.chat.turnTail`（id=`image-gen`） | **图片本体** | `.ig-turn` > `.ig-item` > `a.ig-frameLink` > `img.ig-image` |

工具行与 Turn 尾在 React 树里互不相邻，所以工具行渲染时把 `loadImage`（durable 附件地址的取法）
按 `callId` 记进模块级 map，Turn 尾卡片优先用它、拿不到就退回同源路由
`/image-gen/raw/<callId>/<n>`。

### 聊天流侧的 CSS 规则（带守卫，只动生图那几块）

```css
/* 标记本身不占位 */
[data-slot='image-gen-slot']{display:none!important}
/* 出图后：这一行整行收掉 */
[data-chat-flow-kind='tool-call']:has([data-image-gen-state='done']){display:none!important}
/* 只含生图的组：组头 + 整组一起收掉 */
[data-step-process]:has([data-image-gen-row]) > div:first-child{…}
[data-step-process]:has([data-image-gen-row='done']):not(:has([data-chat-flow-kind]:not([data-image-gen-row='done']))){display:none!important}
/* 只生图的那一轮：耗时行也收掉（混合轮保留） */
[data-chat-turn]:has([data-image-gen-row='done']):not(:has([data-chat-flow-kind='tool-call']:not([data-image-gen-row='done']))) [data-turn-process]{display:none!important}
/* 生成中：宿主把过程组折起来时，含 running 标记的那一段强制展开（动画在里面） */
[data-step-process-body][hidden='until-found']:has([data-image-gen-state='running']){content-visibility:visible!important;display:block!important}
```

三条底线：**不藏整轮**（用户的提问必须留着）、**混合组只收生图那一行**（组头和别的步骤照旧）、
**别的组/别的轮零影响**（`test/scope.browser.test.mjs` 逐条断言）。

> ⚠️ CSS **不允许 `:has()` 套 `:has()`**（Chrome 会把整个选择器判非法，整条规则静默失效）。
> 所以"这一组是不是只有生图"不能用 `:not(:has(…:not(:has(…))))` 写，
> 才需要在行上打 `data-image-gen-row`：`:not(:has(…:not([data-image-gen-row])))` 是合法的。

## 尺寸：动画框和成图是**同一个盒子**

用户要的是「动画的比例和大小跟图片一模一样」。做法只有一条：**两边从同一个 `boxStyle(aspect)`
拿尺寸**，而不是各写一遍 `min(100%, 72vh × 比例)`。

```js
function boxStyle(aspect) {                       // ← 唯一来源
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return { width: `min(100%, calc(72vh * ${ratio}))`, aspectRatio: String(ratio) };
}
// 生成中：<div class="ig-frame" style="…boxStyle…"><canvas/></div>
// 出图后：<a class="ig-frameLink" style="…boxStyle…"><img class="ig-image"/></a>
//          .ig-image{width:100%;height:100%;object-fit:cover}
```

为什么必须这样（实测数据，不是推论）：

| 写法 | 16:9 时量到的盒子 |
| --- | --- |
| 各写一遍：动画用 `aspect-ratio:16/9`，图片用自身像素比 | 动画 617.6×347.4（1.7778） / 图片 617.6×**346.5**（1.7826）→ 落地时跳 1px |
| 共用 `boxStyle` + 图片 `object-fit:cover` | 两边都是 **640×360（1.7778）**，逐像素相同 |

原因：有些服务的「16:9」实际返回 1312×736 = 1.7826，不是数学上的 1.7778。只要让**盒子**决定比例、
图片只负责填满，就不会被图片的原始像素带偏。查过索引里 34 张图，请求比例与返回像素比的最大偏差
只有 **0.27%**，所以 `cover` 顶多裁掉不到 1px，不会真的裁掉画面（比 `contain` 留黑边好）。

`test/box-ratio.browser.test.mjs` 在真 Chromium 里把两种盒子并排量一遍，覆盖
1:1 / 16:9 / 4:3 / 9:16 / 2:3 / 21:9 / 真实服务像素比 七种情况，要求宽高都一致（<0.5px）。

## 生成中的表现

动画是 **rareui.com/components/gridreveal** 的 1:1 移植（源码逐函数搬过来，见下节）。

| 阶段 | 界面 |
| --- | --- |
| `preparing`（模型刚开始吐工具参数） | 图区立刻出现一个圆角方框，框里就是 GridReveal：canvas 上 1 个根格二分分裂成 180 格，按自走进度依次裂开、缝隙先开（带圆角）后合、格子保持灰度微闪。**运行期一个文字都没有** |
| `start`（已派发、正在跑） | 与上面完全一致。图片没到之前进度封顶在 `WAIT_CAP=0.72`，永远不会"跑完" |
| `result` | 图片一落地就以"图片到达"收尾：从图里采样各格平均色开始着色 → 缝隙合拢 → `PHOTO_FROM=0.93` 起照片淡入，动画在同一框里结束。整个框就是「打开原图」链接，**框下没有任何文字** |
| 失败 | 红色 `role=alert` 文案（HTTP 状态 + 原因） |

无障碍说明：「零文字」只是视觉上的——运行期方框仍带 `aria-busy="true"` 与 `aria-label="正在生成图片"`，
读屏用户不会被静默。

### 宿主配合点：出图后不要再补一段文字

模型拿到工具结果后习惯写"已生成…画面/规格/文件"，所以 `generate_image` 在 `execute` 一开始就调用
`exec.concludeTurn?.()`——工具原生能力，这一轮在结果落地后直接结束，不会再有跟进模型调用。
工具描述里也补了一句同样的要求作为兜底。


## GridReveal 移植说明（`lib/client.js` 上半部分）

原组件用 `motion/react` + Tailwind + `@/lib/utils`；插件客户端半边没有构建链、模块种子表里也只有 `react`，
所以做了三处等价替换，动画数学一行未改：

| 原实现 | 这里 |
| --- | --- |
| `useReducedMotion()`（motion） | `matchMedia('(prefers-reduced-motion: reduce)')` 自挂钩子；reduce 时直接落到定格帧 |
| `document.documentElement.classList.contains('dark')` | 读 DSH 的 `--dsw-alias-bg-base` 亮度（500ms 缓存），退回系统偏好 |
| caption 的 `motion.span` + `SHIMMER` + `backgroundPosition` 关键帧 | 同一个渐变 + `@keyframes ig-shimmer`（1.6s 扫过 + 0.5s 停顿 = 2.1s 循环）；**插件里不传 caption**（运行期零文字），组件本身仍保留这项能力 |

保留的原常量：`CELLS=180`、`OPENING_CELLS=4`、`HOLD=0.9`、`WAIT_CAP=0.72`、`LAST_SPLIT=0.92`、
`MORPH=0.055`、`SAMPLE=128`、`GUTTER_FROM=0.35`、`GUTTER_TO=0.75`。

### 显影节奏（融合 bencho.dev/blocks/generate）

rareui 只解决"格子怎么裂开"，出图那一下是硬淡入。[bencho 的 generate 块](https://bencho.dev/blocks/generate)
的做法是**先定大的、后定细的**：图一直在玻璃下，同一个时钟开三个窗口
（`shapes=smooth(0.1,0.82,t)` 驱动 blur 20→1.6px / contrast 2.4→1，`grain=smooth(0.7,1,t)` 最后才定，
液体扰动 ∝ `(1-t)^1.5`，scale 1.04→1）。移植到 canvas：

| 层 | 内容 | 驱动 |
| --- | --- | --- |
| 底 | 照片在离屏画布里显影：`filter: blur() contrast()` + 轻微收拢，再按 26 条切片做正弦扰动（逐渐静置） | `DEV_MS=1700` 内的 `dev` 进度 |
| 上 | 格子马赛克继续细分（此时已染上照片自己的分块平均色），最后整体溶解 | `split` + `grain = 1 - smoothstep(0.25, 1, dev)` |

所以照片**一落地就出现**（大块模糊形状），而不是等格子跑满才淡入；格子在它上面收拢消失，
"大形状先定、细节后定"。`test/develop.browser.test.mjs` 在真 Chromium 里逐帧渲染并断言
早期颜色数显著少于末期（14 → 1055 → 518），把这条节奏钉死。

只有"刚刚出图"（结果事件时间 12s 内）才播显影；刷新页面重放的历史图直接显示，不重播。

驱动方式：原组件支持 `progress`（外部给）与自走（`selfPaced`，时间常数 `estimatedDuration`）两条路。
插件里不传 `progress`，用自走 + "图片落地即进入显影"——这正是原组件为「生成中 → 出图」设计的路径
（`HOLD` 让它永远差一点到 1，`WAIT_CAP` 让等待期不至于把格子裂满）。


## 配置（`cordis.patch.yml` 的 config）

| key | 默认 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `IMAGE_API_KEY` | 密钥来源：先看进程环境变量，再看 `$DSH_HOME/.env` |
| `baseUrl` | 空 | **必填**：服务端点（空值直接报错，绝不回落到写死地址） |
| `model` | 空 | **必填**：模型名 |
| `size` / `ratio` | `2K` / `1:1` | 默认档位与宽高比 |
| `count` | `1` | 默认张数 |
| `optimize` | `true` | 是否在生图前做提示词增强（`false` = 直接用原文） |
| `optimizer.provider` / `.model` | 空 | 留空 = 跟随当前会话的模型；填了就固定用它。**设置页选过的会覆盖这两项** |
| `optimizeTimeoutMs` | `8000` | 增强超时。超时即跳过、回退原文，绝不把等待翻倍 |
| `optimizeTemperature` / `optimizeMaxTokens` | `0.7` / `700` | 创意外扩与结构稳定的折中 |
| `saveFiles` / `saveDir` | `true` / `generated-images` | 是否把图存到会话工作区，存到哪个子目录 |
| `timeoutMs` | `300000` | 单次请求超时（多数服务建议 60–360s） |

## 提示词前置增强（Prompt Optimizer Interceptor）

    [用户原始输入] → [promptOptimizer.js：轻量 LLM 改写] → [生图 Client] → [图像]

- 模板在 `src/promptTemplates.js`（Art Director 英文模板：主体与动作 / 构图与留白 /
  风格与媒介 / 光影与配色；海报文字用双引号定位置；禁止 fluff 词），
  调用与回退在 `src/optimize.js`，接线在 `src/promptOptimizer.js`。
- **对生图 Client 非侵入**：`withPromptEnhancement()` 装饰 `generateWithModel`，
  `imageApi.js` / `imageProviders.js` 一行不改，只在调用前换掉 `prompt`。
- **失败必回退**：没有 llm / 超时 / 报错 / 输出不像提示词（模型只回一句"Sure!"）→
  退回规则式增强或原文，`via` 字段标明走了哪条路（`llm` / `cache` / `rule` / `none` / `off`）。
  超时是自己掐表（`withDeadline` 竞速），不依赖上游是否尊重 `signal`。
- **输出后处理**：`stripFluff()` 兜底剥掉 `photorealistic` / `8K` / `masterpiece`
  （实测 deepseek-flash 会带出来，违反模板规则 4）。
- **选模型**：设置 · 图像模型 → 「提示词优化模型」下拉，候选来自宿主 llm 的 provider 目录
  （即你在「模型」页添加的那些）。存 `models.json`，不写宿主的 `cordis.yml`。
  ⚠️ `llm.listModels()` 收的是**路由 id**（`LlmProviderInfo.id`），不是显示名 —— 拿显示名去查会全空。
- **日志**：每次增强都打一条 `info`，含 `via` / 模型 / 耗时 / raw 与 optimized 对照，出图不理想时能判断是谁的锅。
- **画幅感知**：优化请求里会带真实画布
  `Final canvas: 9:16 (vertical), 2K`，要求按这个比例排构图与留白，并明确禁止把比例/分辨率写进正文
  （渲染器负责，写反了只会自相矛盾）。出口再用 `stripRatioMentions()` 兜底清掉模型硬写的
  `3:4 aspect ratio` / `(9:16)` / 裸 `21:9`，保留 `vertical` / `horizontal` 这类构图词。
  实测过的真实故障：1:1 画布被模型写成 `A vertical 3:4 aspect ratio`。
- **结果复用**：同（provider, model, 原文, styleHint, ratio, size）在 10 分钟内直接复用上次结果，
  `via=cache`，不重复烧 LLM；只缓存 LLM 成功结果（回退不缓存），上限 40 条、LRU 淘汰。

### 等待期间的表现

占位动画框从工具行挂载起就在跑（格子裂到 `WAIT_CAP=0.72` 后持续呼吸），
下方一行阶段文字按宿主记录的阶段推进：

    正在优化提示词…  →  正在生成图片…  →  正在保存图片…

文字走同源 `GET /image-gen/stage/<callId>`（只读、1.2s 一次、到 `save` 即停），
不经 `ctx.remote.imageGen` —— 那需要写进 inject 名单，缺一项整个桌面端起不来（#11）。

## 图像模型（设置 · 图像模型）

独立一个导航页（`settings.section`，id=`image-gen-models`）。可以存**多个**图像模型，
点「使用」切换当前生图用哪个；**绿点 = 当前使用中**（不是"有密钥"，两件事别挤一个视觉位）。
布局照官方「设置 · 模型」页的观感：一列卡片行（名称 + `自定义` 标记 + 绿点 + 使用/编辑/删除），
底部虚线「+ 添加图像模型」，展开后同一个卡片里是表单，**API 密钥直接在表单里填**。

> ⚠️ 试过把它并进官方「模型」页（注册 `settings.models.footer` 席位，宿主确实在
> provider 行之后渲染它），**用户反馈要恢复独立导航页**。别再改回 footer 了。

- 代码：`src/imageModels.js`（注册表）+ `src/imageProviders.js`（多协议调度）+
  `lib/client.js` 的 `ImageModelsSettings`（页面）+ `src/cordis.js` 的 `modelsAdmin`（动作分发）
- 存储：`$DSH_HOME/cache/dsh-image-gen/models.json`（`{ models, defaultId }`）
- 接口类型：`KINDS`（允许存储）= `standard` / `openai-images` / `custom`；
  `KIND_CHOICES`（下拉能选）= `openai-images` / `custom` —— 内置那条固定用 `standard`，不再供新选。
  两者必须分开：`standard` 是内置那条（由配置的 baseUrl/model 派生）的协议，
  从 `KINDS` 里删掉会让存量行被 `normalizeModel` 静默改协议、立刻打不开图。
  编辑存量行时 `kindOptions()` 会把它补回选项，否则 select 显示成第一项、
  用户点保存就把协议悄悄改了。旧版本存下的旧协议名会被归一成 `standard`（请求体相同）。
  协议实现：`standard`（复用 `imageApi.js`，ratio/extra_body 写法）、
  `openai-images`（`/v1/images/generations`，ratio 映射成像素 size，并随 1K/2K/3K/4K 档位放大）、
  `custom`（直接 POST baseUrl，响应形状 `data|images|output|results` × `url|b64_json|…` 都认）
- 「从已添加的模型里提取」：读 `ctx.llm.listProviders()` + `listModels(provider)` 填表，
  **只读不注册**（见踩坑 #15）
- 密钥优先级：页面里直接填的 `apiKey` → 条目自己的 `apiKeyEnv` → 插件全局 `apiKeyEnv`。
  明文只落本机那个 JSON 文件（与插件早已使用的 `$DSH_HOME/.env` 同一信任域），
  **对外一律走 `publicModel()`**：剥掉 `apiKey`，换成 `hasKey` + `keyHint`（掩码）。
  设置页标「未配置密钥」看的是宿主算的 **`keyReady`**（三个来源任一解析得到即可用），
  不是 `hasKey` —— 只看它会把"密钥配在环境变量里"的模型误报成没密钥。
  编辑时密钥框留空 = 保持原值不变。内置行（`default`）也可编辑/换 key，
  改它会落一条 `builtin:true` 的覆盖记录，由 `listRaw()` 与配置派生值合并。

## 数据落点

- 图片文件：`<会话工作区>/generated-images/<时间戳>-<提示词 slug>.png`
- 附件：`ctx.attachments.saveImage()`（内容寻址，随会话持久化；工具结果里以 image 块返回，宿主画廊据此加载）
- 结果索引：`$DSH_HOME/cache/dsh-image-gen/index.json`（callId → 提示词/优化结果/附件/文件，保留最近 300 条）
- 图片字节路由（画廊之外的兜底）：`GET /image-gen/raw/<callId>/<index>`（宿主 `webServer` 注册，同源、仅本机）

## 验证

```bash
npm test            # 7 个离线测试：栅栏 / 注册表 / 图像客户端 / 提示词增强 / 宿主管理 / 宿主全链路 / 客户端结构
npm run test:browser   # 4 个真 Chromium 测试（需要 `npm i` 拉 playwright，或用 CHROME_PATH 指定本机 Chrome）
```

离线测试**不联网、不需要密钥、不写用户目录**（DSH_HOME 与工作目录都是临时目录，
生图请求用假 fetch 桩）；真机验证另外跑 `test/turn-card.live.mjs`（参数与隔离实例做法写在那个文件的头注释里）。

## 实现要点（踩过的坑）

1. **`ctx.get('webServer'/'tools'/'sessions'…)` 在 `apply` 当下是 `undefined`** —— 服务尚未注册。
   必须用 `ctx.inject(deps, child => …)`，依赖齐了才回调，子上下文里才有 `child.tools` 等；
   运行时服务（sessions / attachments / llm / agentDefaultModel）同样在回调里回填给服务实例。
2. **`webServer` 的 `kind:'prefix'` 是字符串前缀匹配**：注册路径写成 `/image-gen/`（带尾斜杠）时
   `/image-gen/raw/…` 会落到 SPA 兜底 404。路径不能带尾斜杠。
3. **工具卡三阶段**：`tool.call.toolview` 的 owner props 里 `phase` = `preparing` | `start` | `result`；
   `preparing` 阶段连参数都还没派发，但因为席位按工具名派发，动画可以**在模型刚开始吐参数时就出现**。
4. **图片自己画在 canvas 里**：不再声明 `tool.call.images` 子席位（那是宿主图片画廊的位置），
   避免同一张图出现两次——GridReveal 的 canvas 本身就是最终展示面，旁边只给一个「打开原图」链接。
5. **canvas 取色要求同源**：`readAverages()` 会把图片画进 128×128 的离屏 canvas 再 `getImageData`；
   跨域图片会污染 canvas。所以优先用宿主 `loadImage()` 给的 durable 地址（同源），
   退回插件自己的 `/image-gen/raw/…` 路由；两者都拿不到时组件按设计退回灰格 + 照片淡入。
6. **宿主半改动不会被热重载拾取**：Node 的 ESM 缓存让 disable→enable 仍加载旧代码，
   改宿主半（工具描述、注册项）后需要重启一次 DSH；只改 `lib/client.js` 则刷新页面即可。
7. **客户端 bundle 只认 `clientModules.rebuilt(id)`**。宿主把「bundle 内容变更」的唯一入口
   收敛到这个方法（`@deepseek-ai/dsh-client-hmr` 的轮询监视器比较 mtime/ctime/size 后调用它），
   所以改完 `lib/client.js` 光刷新页面**不一定够**——要让监视器观察到 mtime 变化
   （`Copy-Item` 会改 mtime，通常够；必要时 `touch` 一下），必要时重启 DSH。
8. **`/plugins` 路由需要浏览器会话 cookie**（`isAuthenticated` 校验 HMAC 签名 + authority），
   直接用脚本 fetch 会拿到 401；要验证线上实际加载的字节，得带上 `dsh web` 打印的 URL 里的凭据。
9. **⚠️ 不要手动改名 `node_modules\dsh-image-gen` 来「禁用」插件**。本插件曾因此让整个宿主
   启动失败（`web boot: 1 entry did not activate / dsh-image-gen: failed`，弹「应用无法启动」）。
   机制：条目一旦加载失败，宿主会**把它从 `dsh.profile.bundles` 移除**，之后即使把目录名改回来
   也不会自动恢复（与 `plugin-heatmap` 记录的 usage-stats 是同一个坑）。
   诊断：`plugin_manager list_plugins` 里 `dsh-image-gen` 会**从列表消失**，`set_plugin` 回 `unknown-plugin`；
   崩溃日志在桌面端日志目录的 `crash-<ts>-web-boot.log`。
   修复：把 `"dsh-image-gen"` 加回 profile `package.json` 的 `dsh.profile.bundles` 再重启 DSH。
   要禁用请用 `cordis.patch.yml` 里的 `disabled: true`，别动目录名。
10. **`conversation.input.dock` 是 ship 出来的既有席位**，`order` 已被占：
   `todo=0` / `goal=10` / `queue=20`。本插件用 `order: 30`；抢位会挤掉既有 UI
   （`plugin_manager` 的 `listSubTree` 可以查到 occupants）。
11. **⚠️ `ctx.slots.register` 必须包在 `ctx.slots.inject(席位名, …)` 里调用**。
   裸 register 在真实的宿主 ctx 上会抛异常（隔离 profile 复现：
   `web boot: 1 entry did not activate / dsh-image-gen: failed`），
   而桌面端把任何条目激活失败当致命错误 → **整个应用弹「应用无法启动」打不开**。
   这曾是 2026-09-30 桌面端打不开的根因。宿主自己的示例代码全部用
   `ctx.slots.inject('tool.call.images', () => ctx.slots.register({...}, …))` 的形态，
   照抄这个形态就不会踩。`test/client.test.mjs` 的假 ctx 已模拟这个语义（裸 register 直接 throw）作回归守卫。
   诊断手段：用 `dsh --profile <名> --no-open` 起**隔离 profile**（`DSH_HOME` 指临时目录），
   再用真 Chrome + HMAC cookie 进页面看 console —— 桌面弹窗只显示 `failed`，浏览器 console 才有上下文。
12. **⚠️ CSS 不允许 `:has()` 套 `:has()`。** `:not(:has(X:not(:has(Y))))` 会被 Chrome 判成
   **非法选择器，整条规则失效**——不报错、不警告，只是那一块样式"没生效"，在真机上极难定位。
   `test/scope.browser.test.mjs` 与 `test/client.test.mjs` 都加了这条守卫（正则扫 CSS）。
   需要"这一组只有生图吗"这类判断时，改成在元素上打属性再 `:not(:has(…:not([attr])))`。
13. **图片不能画在工具行里。** 宿主默认档位 `stepGrouping: 'collapsed'` +
   `foldCompletedTurns: true`：回合结束时整个过程组被 `hidden`，图就跟着消失。
   正确位置是 `conversation.chat.turnTail`（过程组之外，Turn 级），走 Definition 发布数据——
   见 `lib/client.js` 顶部注释与本文「生图不是消息」一节。改回去之前先想清楚怎么对抗折叠。
14. **⚠️ `:has()` 只匹配后代，不含元素自身。** 宿主真实 DOM 里
    `data-chat-anchor-key` 与 `data-chat-flow-kind` / `data-image-gen-row` 挂在**同一个**
    flowItem 上，所以 `[data-chat-anchor-key]:not(:has([data-image-gen-row]))`
    会把生图行自己也判成"别的成员"，连动画一起 `display:none`（实测踩过：动画整个消失）。
    判定"这一支是不是我们的行"要用**保证是真后代**的锚点——`data-image-gen-state`
    由我们自己渲染在单元格内部，永远成立。
    同类坑：`test/scope.browser.test.mjs` 的 fixture 当初把 anchor-key 与 flow-kind 写成
    父子两层，与真实 DOM 不符，所以漏测。**fixture 必须照真实属性分布写**。
15. **⚠️ 设置页取数据走同源 `fetch('/image-gen/models')`，不要走 `ctx.remote.imageGen`。**
    读未声明的 remote 命名空间会抛 `cannot get property "remote.imageGen" without inject`，
    席位内容当场崩；而把它加进 `exports.inject` 又带来新风险——**inject 里任何一项缺失
    都会让条目激活失败 → 桌面端整个应用起不来**（#11 同源）。所以：
    `inject` 名单保持不动，宿主半在 `webServer` 路由里加一个 JSON 端点，页面用 `fetch` 打它。
    同理设置页整段注册包在 `try` 里：没有 `settings.section` 席位也只是少一个页面。
16. **图像模型绝不能注册进 llm 目录。** 聊天输入框的模型选择器读
    `sessionController.modelCatalog()`，其数据源是 `ctx.llm` 的 provider/adapter 目录。
    所以图像模型只存插件自己的 `models.json`，对 `llm` **只读**（`listProviders`/`listModels`
    用于"从已添加的模型里提取"），一次 `registerAdapter` 都会让它冒进选择器。
    `test/imageModels.test.mjs` 用静态扫描 + 假 llm 双重钉死这条契约。
17. **桌面端 `target="_blank"` 会被 Electron 拦掉。** 点卡片"打开原图"在普通 Chrome 里正常，
    在 DSH 桌面端就是没反应。改成自绘的应用内浮层（`openViewer()`，普通 DOM 挂到 `body`，
    不依赖 react-dom——模块种子表里只有 `react`；`position:fixed` 也不受消息流容器
    transform/contain 影响），点背景 / × / ESC 关闭。带修饰键的点击仍走默认行为。
18. **设置页导航图标只能靠 CSS 换。** 宿主 `navIcon(id)` 是写死的 id→图标映射
    （account/models/plugins/…），不在表里的 id 一律给齿轮；而 `settings.section` 的注册
    契约只有 `id/order/label`，**没有 icon 选项**。做法：给我们的那一行打个
    `data-ig-nav` 属性，CSS 里 `>svg{display:none}` + `::before` 用 `mask` 画图标
    （不替换宿主节点，React 下次更新不会拿着被换掉的 DOM 报错）。
    ⚠️ 打标不能放在页面组件的 `useEffect` 里 —— 组件是**点了那一行才挂载**的，
    而图标要在点之前就在，成了鸡生蛋。挂在 `apply()` 里观察 `document.body` 的
    **直接子节点**（`subtree:false`）：设置面板是 portal 到 body 的，够用；聊天流式
    输出改的是深层节点，不会触发。React 填导航行可能晚一两帧，所以每次触发跑一个
    有界阶梯（0/60/180/400ms），跑完即停，不留常驻定时器。
    ⚠️ mask 的 data URI 必须把 `<` `>` 编码掉，且**要带 `width/height`** ——
    写坏时 Chromium 不报错、不警告，只是什么都不画。`test/navIcon.browser.test.mjs`
    把 mask 的 data URI 真解码一遍并数不透明像素，专门抓这种"静默失败"。
19. **⚠️ 插件自己 `webServer.register()` 的路由不经过宿主鉴权管道。**
    只有宿主的 `/api` 通道走 `connection.admit()`（回环 Host + sec-fetch-site +
    Origin + 浏览器会话 cookie）。本插件的 `/image-gen/models` 一度直接暴露：实测不带
    cookie 即可 200 读到模型配置、`GET ?action=remove` 改数据、`action=probe` 白烧生图
    额度；最坏情况是 `add` 一个 baseUrl 指向攻击者服务器的模型再 `setDefault`——之后每次
    生图，插件会把**真实 API key 当 Bearer 发给那个地址**。代码注释当时还写着"处在宿主
    登录鉴权之后"，是错的：注释不能当安全边界，要实测（`curl` 不带 cookie 一发就穿）。
    修法（`src/cordis.js` 的 `fenceLocal` / `fenceRequest`）：
    · 写端点复用宿主同一道 `connection.requestRejection()`，拿不到就退回本地栅栏（fail closed）；
    · **判定路径必须用解析后的 `pathname`，不能用原始 `req.url` 前缀**：absolute-form
      （`GET http://127.0.0.1:PORT/image-gen/models`）会让前缀判定落到只验回环的分支，
      而 `new URL()` 解析出的 pathname 仍是写端点 → 本机任意进程都能绕过 cookie 校验。
      现在非 origin-form 直接 400（`test/host.test.mjs` 有回归用例）；
    · GET 只许 `list`/`sources`，写动作必须 POST + `application/json`（浏览器发 JSON 必然先过
      CORS 预检，跨站页面伪造不出这个"非简单请求"，配合 Origin 栅栏才堵得住 CSRF）；
    · `connection` 在 `apply` 里显式 `wire(ctx, ['connection'], …)` 回填（只 `ctx.get` 会
      静默退化成仅回环校验而不报错）；它不写进 `exports.inject`，避免缺一项就激活失败（#11）；
    · `/raw` 只过本地栅栏、不强制 cookie：它是渲染进程当图片资源直接加载的路径，
      一旦某条加载路径不带 cookie，图片会整片打不开。
    `test/fence.test.mjs` 钉住这些分支（含"抛错也绝不放行"、"null Origin 拒绝"）。

## 第三方素材与许可

本插件自带的部分视觉素材来自第三方，按原许可使用；如果你要再分发，请一并保留出处：

| 素材 | 出处 | 说明 |
| --- | --- | --- |
| GridReveal 格子分裂动画 | [rareui.com](https://rareui.com) 的 `gridreveal` 组件 | 逐函数移植到 canvas（该站点未声明开源许可，**再分发前请自行确认授权**；不想承担风险可替换为自绘动画，替换点集中在 `lib/client.js` 的 `buildTree` / `drawScene`） |
| 显影节奏（大形状先定、细节后定） | [bencho.dev/blocks/generate](https://bencho.dev/blocks/generate) | 只借鉴了时间曲线与三层参数，未复制代码 |
| 图标 path | [Lucide](https://lucide.dev) | ISC License，path 逐条内联在 `lib/client.js` 的 `ICON_PATHS` |

## 许可证

[MIT](./LICENSE)
