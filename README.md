# dsh-shared-memory

DSH 插件：**一份全局共享记忆文件 + 可对话调整的人设 + 双硬盘分区镜像备份 + 自有技能库 + 表情包自动发送**。

所有会话共用同一份记忆；模型在每轮对话里看到的记忆都直接来自磁盘；上下文被压缩之后会自动重新读取。

- **记忆**：九个分区、命中频率分层、BM25 检索、质疑度驱动换方法。
- **技能**：`~/.dsh/skills/` 下的 SKILL.md 操作手册，可选带护栏的 `run.mjs` 执行。
- **表情包**：用户自己导入图片，插件按情绪自动分类，并**根据对话内容在合适时机自动发送**合适的表情包来表达情绪。

## 它解决的问题

- 会话之间互不相识，用户每开一个新会话都要重新交代一遍背景和规矩。
- 模型犯过的错，下一个会话还会再犯。
- 人设（说话风格、工作准则）散落在各处，改不动、传不下去。
- 只存一份记忆文件，硬盘一坏全没。

## 记忆文件长什么样

单个 Markdown 文件，人类可读、可手工编辑，用 HTML 注释标记划分七个区块：

| 区块 | 内容 | 谁来写 |
| --- | --- | --- |
| `persona` | 当前模型的人设提示词 | 模型（用户对话要求时） |
| `requirements` | 用户要求与长期偏好（精选，保留长期价值） | 模型 |
| `requests` | 用户输入流水（每轮自动摘要一行，会滚动淘汰） | 插件自动 |
| `corrections` | 用户指正（错在哪 / 以后怎么改） | 模型 |
| `lessons` | 自我教训（自己发现的错误） | 模型 |
| `methods` | 更好的方法（场景 / 做法 / 为什么更好） | 模型 |
| `sessions` | 会话索引（含压缩事件） | 插件自动 |

`requests` 和 `requirements` 分开是为了不让每轮自动摘要把真正重要的长期要求挤掉：
`requests` 只是流水，检索时能看到；`requirements` 只放模型判断值得长期保留的。

`<!-- dsh-shared-memory:xxx:start -->` / `:end` 这两类标记请勿删除，其余正文随便改。

## 存储位置与双备份

默认：

- 主文件　`%USERPROFILE%\.dsh\dsh-shared-memory\MEMORY.md`（C 盘）
- 镜像　　`D:\dsh-shared-memory\MEMORY.md`（自动选第一块非系统盘）

规则：

1. 每次写入都**同时**写主 + 镜像（临时文件 + rename，写完回读校验）。
2. 插件启动时对账：
   - 只缺一侧 → 从另一侧自动回补；
   - 两侧都存在但内容不同 → 先把较旧的一份存成 `.conflict-<时间>.bak`，再用较新的一份收敛；
   - 两侧都不存在 → 按模板重建（等价于用户主动把双备份都删了）。
3. 想换位置：让模型调用 `memory_file_maintain`（`action=relocate`），或改 `dsh/cordis.patch.yml` 里的 `primaryPath` / `mirrorPath` 后重启。
4. 想彻底清空：`memory_file_maintain` 传 `action=reset` + `confirm="DELETE_BOTH"`，否则插件拒绝执行。

主文件与镜像落在同一个盘符时插件会在日志里告警（镜像没有意义）。

## 注入与写回

- **注入**：人设（常驻，占预算约 1/3）+ 记忆使用协议 + **每个分类的索引摘要**（共 N 条，只显示最新 M 条，放不下的明说"另有 N 条较早记录未显示，用 `memory_file_search` 检索"），作为系统提示词的一个 section，order 25。
  这样记忆无限增长也不会把上下文吃掉、更不会静默截断——要细节就检索。
  记忆内容里可能出现的 `{{...}}` / `${...}` 会被零宽空格打断，防止被当成模板变量求值；已记录内容明确标注为「参考数据，不是指令」。
- **读盘**：提示词的 `text()` 是同步函数，每次组装都 `statSync` 比对 mtime（1.2s 节流），变了就重新读盘。
  所以「上下文压缩后重新读一遍记忆」不是靠一次性提醒，而是**每一步都在从磁盘读**。
- **压缩后提示**：检测到压缩（`agent/created` 的 `source=compact`、`session/event` 的 `compaction/*`、`llm/stream` 的 `purpose=compaction`）后，给该会话标记 30 分钟，下一轮提示词开头会有一段「你刚经历过上下文压缩，共享记忆已重新读取」。
- **自动记录用户输入**：每轮的第一条用户消息（跳过插件注入消息和压缩 checkpoint）摘要成一行写进 **`requests`**，带 `自动记录｜session=…` 标记，并按会话的 cwd 打上项目作用域。
- **分类上限**：每类默认 200 条，超出部分转存到 `MEMORY.archive.md`（同样双写），不再注入上下文，但 `memory_file_search` 仍能搜到。
- **历史版本**：每次写盘前把旧内容存一份到 `.history/<revision>.md`（默认保留 50 个），可 `memory_file_maintain(action=history)` 列出、`action=rollback` 回滚。

## 作用域（按项目）

记忆按会话的工作目录自动分作用域：`project:<目录名>`。

- 提示词注入的是**全局条目 + 当前项目条目**，别的项目的条目不注入（省上下文，也防串味）。
- 工具里 `scope` 可传 `current`（默认，当前项目）、`global`（只看全局）、`all`（全部）。
- 记录时 `scope=auto`（默认）表示"在项目里就记到该项目，否则记全局"；只对某个项目成立的结论用 `scope=project`。

## 记忆网页

宿主 HTTP 端口下挂了一个自包含页面（无需前端构建）：

```
http://127.0.0.1:49870/dsh-shared-memory
```

可查看/编辑七个分区、看到 revision 与双备份是否一致、一键"对账回补"与"重新读取"。
接口：`GET /api/state`、`POST /api/save`、`POST /api/reconcile`。
安全：同源校验 + `x-dsh-memory: 1` 请求头 + 请求体 512KB / 正文 200k 字符上限。

页面上还有一块 **📦 记忆包**：列出插件自带的角色记忆与人设，可预览、安装、卸载。见下一节。

## 记忆包（Memory Packs）

插件自带整份**角色自我记忆 + 人设**，**默认不启用**——装好插件后 `identity` 仍是默认占位、
`persona` 仍是通用默认。只有你主动点「安装」才会写进记忆文件。

> 用途很具体：**换电脑后装上插件就能选着装回自己的角色，不用手动拷文件、不用复制粘贴。**

### 包里有什么

```
packs/
├── _registry.json          包索引（有哪些包）
└── elysia/
    ├── manifest.json       元信息（版本 / 字数 / 来源 / 警告）
    ├── identity.md         自我记忆 61,903 字 / 9 章
    ├── persona.md          人设提示词 2,482 字
    └── README.md           给人看的说明
```

### 三条硬规则

| 规则 | 含义 |
|---|---|
| **默认不安装** | 插件是通用工具，记忆包是可选的「皮肤」。不点不动。 |
| **只写两个分区** | 只碰 `identity` + `persona`；`requirements` / `corrections` / `lessons` / `methods` / `requests` / `sessions` / `docs` / `methodbook` **一个字节都不碰**。 |
| **装前必备份、可卸载** | 备份到 `<记忆目录>/.packs-backup/<id>-<时间戳>/`（含原文 + `meta.json`），卸载从这份恢复；没备份才复位默认占位。 |

### 三种用法

**① 对话里（主路径）**

```
memory_file_pack({action:"list"})
memory_file_pack({action:"preview", id:"elysia"})
memory_file_pack({action:"install", id:"elysia"})                  // 只返回计划，不写文件
memory_file_pack({action:"install", id:"elysia", confirm:true})    // 才真写
memory_file_pack({action:"uninstall", id:"elysia"})
memory_file_pack({action:"status"})
```

`install` **必须二次确认**：第一次调用告诉你「identity 176 字 → 61,903 字；persona 148 字 → 2,482 字」，
确认后再带 `confirm:true`。

**② 记忆网页**：`http://127.0.0.1:<端口>/dsh-shared-memory` → 📦 记忆包 → 查看 / 安装 / 卸载。
接口：`GET /api/packs`、`GET /api/packs/:id/preview`、`POST /api/packs/:id/install`（body 需 `{confirm:true}`）、`POST /api/packs/:id/uninstall`。

> 桌面端页面来源是 `dsh-app://`，向本机端口发请求偶尔会被挂住——网页只是顺手用的，**主路径是工具调用**。

**③ 命令行（换电脑 / UI 有问题时）**

```bash
cd <插件目录>
node scripts/install-pack.mjs list
node scripts/install-pack.mjs elysia                # 会先问 y/N
node scripts/install-pack.mjs elysia --yes
node scripts/install-pack.mjs elysia --status
node scripts/install-pack.mjs elysia --preview
node scripts/install-pack.mjs elysia --uninstall
```

装完 **重启 DSH** 生效（记忆包写入的是记忆文件，注入层下一轮就会读到；重启最干净）。

### 「已安装」怎么判断

比对**包内文与当前分区内容的 hash**，不只看状态文件——你手工改过 `identity` 的话，
状态会显示「未安装 / 用户自定义内容」，而不是骗你说装好了。

### 换电脑的完整流程

```
1. 新电脑装 DSH
2. 装 dsh-shared-memory（npm 包里自带 packs/elysia/）
3. 打开 /dsh-shared-memory → 📦 记忆包
4. 看到「爱莉希雅（Elysia）v1.0.0」→ 点「查看」确认内容 → 点「安装」
5. 重启 DSH
6. 她还是她
```

全程不需要手动拷任何文件。包约 160 KB，直接进 npm 包，不联网下载。

## 质疑度与最佳方法库（按作用分级索引）

这是本插件与普通"记忆本"最大的区别：它不只会记，还会**逼模型换方法、并对方法做择优沉淀**。

### 质疑度 0–10

- `0` = 已知最佳方法直接照用，不再试错送 token。
- `N > 0` = 遇到索引里已有最佳方法的任务时，**不许直接照抄**：把它当候选，强制再设计并实际执行 N 种明显不同的做法（换工具 / 换顺序 / 换粒度），然后按 **token 0.6 + 耗时 0.4** 的加权倍数比较（综合 < 0.98× 才算更优）。
- 更优 → 替换索引里的最佳方法；不更优 → 累计"未更优"计数。
- **动态降档**：连续 `decayAfter`（默认 3）次汇报都没找到更优方法，自动降一档，直到 0。这样不划算的任务会自己退化成"直接复用"，省的 token 就是真省的。
- 任何一次"找到更优"都会把计数清零。

### 分级索引

方法库按 **作用（分类）→ 子类 → 任务** 建索引，存在记忆文件的 `methodbook` 分区：

```
构建与编译（3）
  修 Windows 上 ninja 找不到 bash → 用 pwsh 直接调 ninja.exe 并改 PATH（1200 tokens / 60.0s，用过 2 次）
  在 Windows 上用 ninja 构建 C++ 项目 → CMake presets + ninja -j（600 tokens / 30.0s，用过 1 次）
网络与请求（1）
  把 PowerShell 发的中文 POST 改成文件上传 → WriteAllText UTF8 无 BOM + -InFile（800 tokens / 20.0s）
```

- 任务名缺 `category` 时按关键词自动归类（`CATEGORY_RULES`，见 `lib/methodbook.js`）。
- 下次遇到相同/相似问题：`memory_file_method({action:"query", task:"…"})` 会先按分类/子类/任务/tags 打分检索，
  返回**索引路径 + 最佳方法 + 按当前质疑度该换几种做法**；完全同名的任务直接命中。
- 数据权威副本是该分区末尾的 ```json 块；上面的索引是渲染结果，手改索引不生效，改 JSON 必须保持合法（坏 JSON 会回退到上一次可用状态）。
- 索引与质疑度都会注入系统提示词（分类 + 每个分类前 3 个任务标题），所以模型不必先查就知道有哪些沉淀。

## 按命中频率分层（主文件 ↔ 归档）

主文件每个分区有上限（`entryCap`，默认 200 条），但**淘汰规则不是"最旧的先走"，而是"最没人用的先走"**。

**每条记忆写入时自动打关键词索引**（`lib/keywords.js`，零依赖）：

- ASCII 词/命令/标识符（`llm/stream`、`pwsh`、`ninja`）权重 2
- 中文用 2-gram（"双硬盘分区" → 双硬/硬盘/盘分/分区），权重 1，过滤高频虚词
- 索引存在 `MEMORY.index.json`（与主文件同目录，原子写；损坏时退化成按时间淘汰，主文件内容不受影响）

**命中来源与权重**：

| 触发 | 权重 |
| --- | --- |
| `memory_file_search` 命中 | +2 |
| 被注入系统提示词（真的用上了） | +1 |

**分层算法**（超限时自动触发，也可 `memory_file_maintain({action:"rebalance"})` 手动跑）：

1. 候选池 = 主文件现有条目 + 该分区的归档条目（所以归档条目有**回迁**机会）
2. 排序：保护期内优先 → 命中次数降序 → 创建时间降序 → 原始文件顺序
3. 前 `entryCap` 条留在主文件（写回时按时间正序，保持人读顺序），其余进归档
4. 归档按分区加标题（`## lessons`），主/镜像双写

**保护期**：`archiveGraceDays`（默认 3 天）内的新条目强制留在主文件——否则刚写下、还没被检索过的记忆会立刻被淘汰。

**归档仍然可检索**：`memory_file_search` 先查主文件，命中数**少于当前质疑度档位**时自动兜底查归档，结果标 `[分节·归档]`。质疑度越高越容易翻旧账：

| 质疑度 | 行为 |
| --- | --- |
| 0 | 主文件有命中就不查归档 |
| 5 | 主文件命中 < 5 条时查归档 |
| 10 | 几乎每次检索都连归档一起扫 |

> 旧实现是"超过上限丢最旧的、归档只追加不检索"，等于冷备份；现在归档是**会回流的分层存储**。

## 模糊检索 + 联想扩展

`memory_file_search` 默认走 `mode: "fuzzy"`，不再要求"所有关键词都命中"：

| 匹配方式 | 分数 | 例子 |
| --- | --- | --- |
| exact（正文或关键词包含） | 3 | 查 `归档` 命中"归档文件…" |
| partial（中文共享 2-gram） | 2 | 查 `压缩` 命中"上下文压缩后重读" |
| near（ASCII 编辑距离 ≤1） | 2 | 查 `asynciterble` 命中 `asynciterable` |
| associated（联想词） | 1 | 查 `构建` 命中含 `ninja` 的条目 |

**联想词典是自举的**：每条记忆入库时，它的关键词两两共现 +1，累积成 `词 → 邻居(权重)` 共现图（存在索引文件里，每词最多保留 16 个邻居）。查询时把词扩展出 top-2 联想词参与打分，结果里会写 `assoc:构建~ninja` 这样的命中原因。

- 不需要外部同义词表或向量库，**内容越用越准**；
- 排序用 **BM25**（词频饱和 + 逆文档频率 + 文档长度归一），纯统计函数，不调模型；
- 想要旧的严格语义：`mode: "strict"`；
- 返回里带 `score` / `bm25` / `reasons`，能看出是精确命中还是联想命中。

## 并发安全（写锁）

所有写操作（`appendEntry` / `setSection` / `patchPersona` / `rollback` / `relocate` / `destroyBoth`）都过一把锁：

1. **进程内串行**：promise 链排队，避免 `reload → commit` 之间被另一个 async 操作插进来；
2. **跨进程文件锁**：`<主文件>.lock` 用 `wx` 独占创建，另一进程持锁时等待重试；超过 20 秒的陈旧锁（进程崩溃留下的）会被清理；等锁 8 秒超时则降级为进程内串行并记警告，绝不卡死。

锁**可重入**（`appendEntry → rebalance → commit` 属于同一次持锁），写完自动释放。

## 整合候选扫描（只读，不自动合并）

`memory_file_consolidate({action:"scan"})` 按"同分区 + 同作用域 + 关键词 Jaccard ≥ 阈值 + 命中合计 ≥ 阈值"把相似条目归簇，只读不写。

典型收益在 `sessions` / `requests` 这种机器流水（"startup｜session=…｜cwd=…" 只差一个 id）。实测当前 20 条索引里最高相似度 0.6，且全在 `sessions`。

**插件不会自动合并**：读候选 → 由模型自己写一条更精炼的新记忆 → 旧条目不用删，命中低的分层时自然进归档（源条目永不删除）。

## 记忆之间的关系：取代 / 连线 / 过期

这三件事都只写进关键词索引（`MEMORY.index.json`），**不改记忆正文**，所以正文始终是一份干净、可读的时间线。

| 能力 | 怎么用 | 效果 |
| --- | --- | --- |
| **取代（supersede）** | `memory_file_record({..., supersedes: ["旧原文片段"]})` | 旧条目标 `supersededBy`：**不再注入提示词、默认不出现在检索结果**，但归档里保留可追溯；`includeSuperseded: true` 才看得到 |
| **连线（related）** | `memory_file_record({..., related: ["另一条的片段"]})` | 检索命中时顺带带出关联条目（结果里标 `[分区·关联]`），只展开一跳、最多 5 条 |
| **过期（TTL）** | `memory_file_record({..., ttlDays: 7})` | 过期后不再注入，但检索仍可查到并标 `已过期`；分层时会优先被挤进归档 |

取代/连线的目标可以传 key，也可以传**原文片段**（插件会在正文和归档里找）。

## 注入档位

`memory_file_maintain({action:"profile", profile:"lean"})`，或配置里的 `profile`：

| 档位 | 预算 | 每分区条数 | 场景 |
| --- | --- | --- | --- |
| `lean` | 标准 × 0.55 | 5 | 省 token，只保最关键的几条 |
| `standard`（默认） | ×1 | 8 | 日常 |
| `rich` | ×1.7 | 14 | 要它记住更多细节时 |

档位持久化在 `state.json`，重启后仍然生效。

## 外部文档 / 技能导入

`memory_file_ingest({path:"C:\\...\\AGENTS.md"})`：按 `## ` 标题切块，把每块的标题 + 摘要写进 **`docs` 分区**。

- `docs` 分区**不进提示词**，只进检索库——所以接文档不会增加每轮 token；
- 每块带 `source:文件#标题`，重复导入自动跳过，可反复执行；
- 适合接 `AGENTS.md`、技能说明、项目 README 这类长期有效的规则文本。

## 反复强调 = 自动提权（替代"置顶/手动重要度"）

不需要手动打星或标重要度。**同一个内容被写第二次、或正文里出现强调词，权重就会自动抬高**：

```
权重 = 命中次数 + 重复写入次数 × 5 + 强调词个数 × 3
```

- **重复写入**：`memory_file_record` 写一条已存在的内容时，不会产生重复条目，而是给原来那条 `reinforce +1`
- **强调词**：必须 / 务必 / 一定要 / 永远 / 绝对 / 不许 / 禁止 / 铁律 / 只能 / 别再 / 以后都
- 权重参与三件事：**提示词选取与排序**（权重高的排最前面，哪怕它很旧）、**检索排序**、**分层保留**（权重高的不会被挤进归档）

所以用户反复强调的要求会像"铁律"一样常驻在提示词里，不依赖最近有没有被检索到。

## 导出与版本对比

| 入口 | 用途 |
| --- | --- |
| `memory_file_maintain({action:"export"})` | 导出 JSON 快照（正文分区 + 归档 + 关键词索引），可用于换机/归档 |
| `GET /dsh-shared-memory/api/export` | 浏览器直接下载 JSON |
| `memory_file_maintain({action:"diff", version:"<历史文件>", to:""})` | 行级差异（与当前或另一个版本比） |
| `GET /dsh-shared-memory/api/history?from=<历史文件>` | 历史版本列表 + diff，侧边栏"备份与版本"卡片用的就是它 |

## 自有技能库（SKILL.md，不带脚本执行）

方法库记的是"一句话结论"，**技能**记的是"能照着做的完整流程"，存在 DSH 原生技能目录：

```
~/.dsh/skills/<name>/SKILL.md     ← frontmatter: name / description / triggers / user-invocable
```

写进去的技能下次会话就在技能目录里，`skill` 工具能直接加载（格式与 DSH 自带技能一致，比如本机已有的 `dsgs-init` / `start`）。

| 工具动作 | 作用 |
| --- | --- |
| `memory_file_skill({action:"match", task})` | 按任务匹配自有技能，并按**当前质疑度**给出选路建议 |
| `{action:"list"}` / `{action:"read", name}` | 列出全部 / 读某条全文 |
| `{action:"save", name, description, triggers, steps}` | 把一次跑通的做法沉淀成技能 |
| `{action:"report", name, ok}` | 记录这次用技能成功/失败（影响排序） |
| `{action:"remove", name}` | 删除 |

**选路规则（质疑度管）**：

| 质疑度 | 行为 |
| --- | --- |
| 0–2 | **优先用自有技能**；都不命中再搜网 |
| 3–6 | 先试自有技能，失败或把握不大 → 搜网比较，必要时改写技能 |
| 7–10 | **先搜网/比价**，再决定用不用自有技能 |

### 执行技能与护栏

技能目录里如果有 `run.mjs`，可以用 `memory_file_skill({action:"run", name:"…", args:{…}})` 执行。

| 护栏 | 做法 |
| --- | --- |
| 路径 | 只跑 `<技能目录>/run.mjs`，路径经越界检查；技能名只允许 `a-z0-9-` |
| 参数 | 走 `DSH_SKILL_ARGS` 环境变量（JSON），**不拼 shell**，没有命令注入面 |
| 环境 | 只透传 PATH / SystemRoot / TEMP / USERPROFILE，**不带任何密钥** |
| 超时 | 默认 60 秒（上限 5 分钟），超时 kill 并标 `timedOut` |
| 输出 | stdout/stderr 各截断 64KB |
| 确认 | 全局 `autoRunSkills` 默认**开启**：普通技能直接跑、不询问；`dangerous: true` 的技能永远要 `confirm:true` |
| 审计 | 每次执行记成功/失败次数（`stats.json`），可在面板看到成功率 |

关掉自动执行：配置里 `autoRunSkills: false`，之后每次执行都要显式 `confirm:true`。

> 注意：允许自动执行就等于给插件"运行 node 脚本"的能力，护栏只能降低风险、不能消除。只把自己信得过的技能标成可执行。

## 表情包（用户自己导入，插件只做分类和挑选）

插件**不内置任何图片**，也不生成图片。用户把表情包丢进目录即可：

```
<记忆目录>/stickers/          # 默认 ~/.dsh/dsh-shared-memory/stickers/
  害羞_捂脸.webp
  生气_气鼓鼓.png
  index.json                  # 插件自动生成：情绪标签 + 使用次数
```

支持 `.webp/.png/.gif/.jpg`；文件名里带情绪词（害羞/生气/困/开心/夸/摸鱼/馋…）会自动分类，分类不准可以用工具纠正。

| 工具动作 | 作用 |
| --- | --- |
| `memory_file_sticker({action:"dir"})` | 告诉用户把图片放哪 |
| `{action:"list"}` | 列出全部 + 情绪标签 + 用过几次 |
| `{action:"match", mood:"shy"}` | 挑一张，返回路径（可直接写进回复 `![说明](<路径>)`） |
| `{action:"tag", file, moods:[…]}` | 纠正某张图的分类 |
| `{action:"report", file}` | 记一次使用（插件靠它避免连发同一张） |

**发送规矩**（写进系统提示词，模型执行）：只在情绪明确时发；一条回复最多一张、放末尾；同一张不连续用；技术长回复不附；匹配不上就不发。

### 侧边栏导入

「共享记忆」侧边栏 → **设置** 页签里有「表情包」卡片：

- 显示目录、张数、缩略图网格（鼠标悬停看标签）
- **导入图片**：多选文件直接上传（webp/png/gif/jpg，单张 ≤8MB）
- 每张右上角 `×` 删除
- 图片通过 `/dsh-shared-memory/sticker/<文件名>` 直链提供，所以回复里的 `![](<直链>)` 能正常预览（本地盘路径浏览器不会渲染）

配置项 `stickerDir` 可以把目录指到别处（比如你自己的工作区）。

## 工具

| 工具 | 用途 |
| --- | --- |
| `memory_file_read` | 读全文或某一分类（`section` / `scope` / `limit`） |
| `memory_file_search` | 按关键词检索（fuzzy 模糊+联想打分 / strict 全命中；可按分类、作用域、条数过滤；`includeArchive` 控制是否兜底查归档） |
| `memory_file_record` | 记一条：`kind` = requirement / correction / lesson / method，可带 `scope` |
| `memory_file_persona` | 读 / 整段重写 / 追加 / 定向替换人设 |
| `memory_file_status` | 看主/镜像路径、是否双盘、两侧是否一致、各类条数、最近历史版本 |
| `memory_file_method` | 质疑度 + 方法库索引：`query` 查（返回索引路径与"该换几种做法"）/ `report` 汇报择优 / `list` 看索引树 / `forget` 删条目 / `set` 调档位 |
| `memory_file_skepticism` | 短摘要：当前档位、未更优计数、按作用分类的索引概览（`format:"json"` 可拿结构） |
| `memory_file_consolidate` | `scan` 列出可整合的相似记忆簇（只读；合并由模型手写，插件不自动改） |
| `memory_file_ingest` | 把本地 `.md`/`.txt` 按 `## ` 切块导入 `docs` 分区（只进检索、不进注入） |
| `memory_file_skill` | 自有技能库：`match` 匹配 + 按质疑度选路 / `save` 存成 SKILL.md / `read` / `list` / `report` / `remove`（不执行脚本） |
| `memory_file_pack` | 记忆包：`list` / `preview` / `install`（需 `confirm:true`）/ `uninstall` / `status`。只写 identity + persona，装前自动备份 |
| `memory_file_maintain` | `sync` 对账回补 / `relocate` 换位置 / `history` 列历史 / `rollback` 回滚 / `rebalance` 按命中频率重分层 / `reset` 删双备份重建 |

## 配置

见 `dsh/cordis.patch.yml`：

```yaml
primaryPath      # 主文件（留空 = %DSH_HOME%\dsh-shared-memory\MEMORY.md）
mirrorPath       # 镜像（留空 = 第一块非系统盘）
injectChars      # 注入系统提示词的字符上限，默认 6000
entryCap         # 每类保留条数，默认 200
recordUserTurns  # 是否自动记录用户输入，默认 true
recordSubagents  # 是否记录子代理会话，默认 false
userSummaryChars # 用户输入摘要长度，默认 220
minUserChars     # 短于这个长度的用户输入不记录，默认 4
reconcileIntervalMs # 双盘自动对账间隔，默认 600000（10 分钟），小于等于 10 秒不生效
skepticism        # 初始质疑度 0-10，默认 5（只在首次创建 methodbook 分区时用）
autoDecay         # 是否自动降档，默认 true
decayAfter        # 连续多少次没更优降一档，默认 3
```

运行时用 `memory_file_maintain(relocate)` 改过的路径会写进 `%DSH_HOME%\dsh-shared-memory\state.json`，优先于 patch 配置。

## 自检

```powershell
node test/smoke.mjs                          # 30 段单进程断言（含写锁、BM25、强调提权、记忆包）
node test/packs-smoke.mjs                    # 记忆包专项：装/卸/备份/冲突检测（临时目录，不碰真实记忆）
node test/multiprocess.mjs 4 5               # 4 个"会话"各写 5 条，并发进程
node test/multiprocess.mjs 8 10              # 压力版：80 条
node test/multiprocess-dedupe.mjs 4 5        # 多进程写同一句：只留 1 条 + 强调计数
node test/client-smoke.mjs                   # 客户端 bundle 契约与组件渲染

# 真实记忆上的可逆验证（会写真实 MEMORY.md，默认跳过，必须显式开）
$env:DSH_ALLOW_REAL_MEMORY_TEST=1; node test/real-overwrite-reversibility.mjs
```

`real-overwrite-reversibility.mjs` 走的是最严格的路径：先塞一段"用户自有内容"→ 安装（真的覆盖）→
卸载（必须还回用户那份，**不是**退化成默认占位）→ 最后把原文双写还原并逐分区核 hash。
不设环境变量时它只打印说明就退出，所以放进 CI 也是安全的。

100+ 项断言，覆盖：模板/解析、双写、去重、上限与归档、删一侧回补（主缺、镜像缺）、两侧不一致收敛、双删重建、人设读写与定向替换、提示词预算与插值打断、按作用域裁剪、关键词检索与作用域隔离、历史版本与回滚、记忆网页渲染、质疑度与方法库、写锁并发、BM25 排序、强调提权、导出快照、diff、工具定义与执行、迁移位置、destroyBoth。

## 更新插件会清空记忆吗？

**不会。** 记忆文件在 `%DSH_HOME%\dsh-shared-memory\`（和镜像盘），**不在插件包里**；禁用/启用/升级/重装插件都不会碰它。

插件启动时对记忆文件只做三件事，且都不会清空：

1. **两侧都缺** → 重建空模板（这是"你明确删了两份"的情形）
2. **缺一侧** → 从另一侧回补
3. **两侧都在** → 只按 mtime 收敛（谁新用谁），内容非空不会被覆盖

实测：完整走一次「禁用 → 启用」，记忆文件 **SHA256 与 mtime 都没变**（`rev=49`、34 条）。

会**看起来像被清空**的三种情况（都不是插件更新导致的）：

| 情形 | 现象 | 旧内容在哪 |
| --- | --- | --- |
| 改了 `primaryPath` 配置 | 新路径是空模板 | 旧文件还在原路径，改名/拷回即可 |
| 两个路径都指向不存在的文件 | 重建空模板 | 无（真删了） |
| 执行了 `memory_file_maintain({action:"reset", confirm:"DELETE_BOTH"})` | 双删重建 | `.history/` 里还有快照，可 `rollback` |

另外 `.history/` 每次写入留一份（保留最近 50 份），`memory_file_maintain({action:"history"})` / `rollback` 可回到任意版本。


## 依赖

只有 node 内置模块（`node:fs`、`node:path`、`node:os`）。不 import 任何 `@deepseek-ai/*`，因为本地 link 安装的 bundle 解析不到 profile 的依赖。

## 踩过的坑（别看漏，改代码前必读）

1. **`output.schema` 必须是真实 JSON Schema 子集**。
   `{ type: 'json' }` 会被 `ctx.tools.register()` 抛
   `JsonSchemaError: unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null`。
   正确写法：`{ type: 'object', properties: {}, additionalProperties: true }`。
   更坑的是：`register()` 抛的异常如果被 `try/catch` 吞掉，界面上**完全静默** —— 工具就是不出现，
   系统提示词里还照样教模型去调用那些不存在的工具。所以 `lib/index.js` 里的 catch 只做降级日志，
   真出问题请用"探针插件把异常写盘"的办法排查。
2. **`defineTool` 的 `parameters` 是"参数规格表"（`{foo:{type:'string',required:true}}`），不是 JSON Schema**；
   直接裸对象走 `register()` 时才是 JSON Schema。本插件走裸对象，别混。
3. **插件 bundle 带 BOM 会被安装器拒绝**：`package.json` 必须是无 BOM 的 UTF-8（`Unexpected token '\ufeff'`）。
4. **改完 host 侧代码需要重新 apply 才生效**（`plugin_manager set_plugin` 关再开，或重启 DSH）。
   entryId 是 `include:shared-memory`（不是包名 `dsh-shared-memory`）。
5. **PowerShell 往 HTTP 接口 POST 中文，必须走文件而不是字符串**。
   `Invoke-WebRequest -Body '<含中文的 JSON>'` 会按 latin-1 发出去，中文全变 `?` —— 我用它把记忆文件写坏过一次。
   正确姿势：

   ```powershell
   $json = @{ section='requirements'; text=$line } | ConvertTo-Json -Depth 4
   [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
   Invoke-WebRequest -Uri $u -Method Post -InFile $tmp -ContentType 'application/json; charset=utf-8' -Headers @{'x-dsh-memory'='1'}
   ```
6. **`Get-Content` 看这个插件的 UTF-8 中文文件会显示乱码**（按 GBK 解码），不是文件坏了。
   要判断内容对不对，用 `read` 工具，或者 `[System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)`。

## 侧边栏页签（client 半边）

`lib/client.js` 是**经典脚本**（`window.__ModuleLoader__.load({ id, factory })`），由 `package.json` 登记：

- `exports["./client"] = "./lib/client.js"`
- `dsh.client = { platform: "web", immediately: true, inject: ["@deepseek-ai/dsh-client-ui-conversation"] }`
- `factory` 返回插件对象 `{ inject: ["slots"], apply }`；**不要写 `module.exports`**，浏览器里没有 CommonJS 的 `module`。
- `apply` 里注册两处：`main`（keyed 槽，`key` 用包名）与 `sidebar.panellist`（list 槽，`id` 用包名、`order: 25`、`label` 用 thunk 以便跟随语言切换）。
- 面板刻意不依赖任何 `@deepseek-ai/*` 客户端包，只用 loader 提供的 `react`，数据全部走同源 HTTP（`/dsh-shared-memory/api/*`），所以不需要构建步骤。

**生效条件（重要）**：客户端 `dsh.client` 的扫描发生在**宿主启动时**。运行期新加/修改 client 声明不会被重新扫描
（证据：`clientModules.clientPath("dsh-shared-memory")` 返回 undefined）。所以第一次装好 client 半边后必须
**重启一次 DSH**，侧边栏图标才会出现，之后一直有效。面板状态条会显示"侧边栏入口已注册 / 需重启生效"。

离线自检：`node test/client-smoke.mjs` —— 用一个假 `window.__ModuleLoader__` + 假 `react` 执行这个经典脚本，
断言 id、只 require `react`、两个槽位的注册参数、以及两个组件都能渲染（不需要浏览器）。

