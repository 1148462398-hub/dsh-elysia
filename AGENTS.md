# AGENTS.md — dsh-shared-memory 插件开发规则

改这个插件之前先读完。以下规则每条都是踩过坑换来的，违反会让插件静默失效或让 DSH 整体崩溃。

---

## 1. Cordis 流式钩子（`llm/stream` 等）：必须同步返回 AsyncIterable

`llm/stream` 是 waterfall 事件，listener 的返回值会被下游 `yield* next()` / `for await (... of stream)` 直接消费。
**返回 Promise 会让所有 LLM 调用崩溃**，报错形如：

```
TypeError: yield* (intermediate value) is not async iterable
TypeError: stream is not async iterable
```

**禁止**（`async` 箭头函数返回 Promise）：

```js
ctx.on('llm/stream', async (options, next) => {
  await doSomething()
  return next()          // ← Promise 里包了个流，不是流本身
})
```

**必须**（`async function*`，调用即返回 AsyncGenerator）：

```js
ctx.on('llm/stream', async function* (options, next) {
  await doSomething()
  yield* next()          // ← 不是 return next()
})
```

两个必须一起改的点，只改一半会引入更隐蔽的 bug：

| 写法 | 返回 | 结果 |
|---|---|---|
| `async (…)=>{ return next() }` | Promise | **崩溃**，报 `is not async iterable` |
| `async function*(…){ return next() }` | AsyncGenerator | **不报错但流被吞空**，输出全无 |
| `async function*(…){ yield* next() }` | AsyncGenerator | ✓ 正常透传 |

- `async function* (a, b) => {` 是**非法语法**（function 不带箭头），照抄会 SyntaxError。
- generator 里 `return expr` 只是结束生成器并把 expr 作为返回值，**不会把它 yield 出去**；透传流必须 `yield*`。

**改动后自查**（三行，跑通再收工）：

```js
const r = handler({}, nextMock)                 // nextMock 是一个 async generator
console.assert(r && typeof r[Symbol.asyncIterator] === 'function', '必须同步返回 AsyncIterable')
for await (const c of r) console.log(c)         // 必须能看到 next() 透传的内容，空数组即为吞流
```

## 2. 其余既有规则

- `ctx.tools.register` 的 `output.schema` 必须是真实 JSON Schema（`{ type: 'object', ... }`），写 `{ type: 'json' }` 会抛 `JsonSchemaError`，且注册失败会被 try/catch 吞掉、界面静默。
- HTTP 接口写入含中文的 JSON：先落 UTF-8 无 BOM 文件再 `-InFile`，`ContentType` 带 `charset=utf-8`。
- `package.json` 的 `dsh.client` 只在宿主启动时扫描一次，运行期新增不生效，需重启；client bundle 的 `factory` 里不能写 `module.exports`，要 `return` 插件对象。
- 记忆文件双盘镜像（`C:\Users\123\.dsh\dsh-shared-memory\MEMORY.md` ↔ `D:\dsh-shared-memory\MEMORY.md`）：**手工编辑后两侧都要改**，否则下次校验回补会用一侧覆盖另一侧。

## 3. 记忆包（`lib/packs.js`）—— 五个不能改的设计前提

这几条是产品决定，不是实现细节。改之前先想清楚会破坏什么。

1. **默认不安装。** 插件装好后 `identity` 必须是 `DEFAULT_IDENTITY`、`persona` 必须是 `DEFAULT_PERSONA`。
   任何"启动时自动装包""检测到包就导入"的改动都是错的——插件是通用工具，包是可选的皮肤。
2. **只写 `identity` 和 `persona`。** `PACK_SECTIONS` 就这两个。
   其余八个分区（requirements / corrections / lessons / methods / requests / sessions / docs / methodbook）
   是用户自己的积累，记忆包一个字节都不能碰。`test/packs-smoke.mjs` 里有专门的 hash 断言守着这条。
3. **装前必须备份。** 写 `<记忆目录>/.packs-backup/<id>-<时间戳>/`，含 `identity.md`、`persona.md`、`meta.json`
   （记当时字数、hash、`wasDefault`）。卸载靠它恢复。
4. **卸载在无备份时才能退化成默认占位。** 有备份就必须还回备份里那份——
   用户装包前本来有自己的内容，卸载把他变成默认占位等于**删了他的记忆**。
5. **"已安装"按内容 hash 判断，状态文件只作辅助。**
   用户手工改过 `identity` 时，状态文件会撒谎；hash 不会。

### 两个容易踩的实现坑

- **`\n` 在 `PAGE` 模板字符串里会被渲染成真换行。** `webui.js` 的 `PAGE` 是一个巨型模板字符串，
  里面写 `join('\n')` 或 `confirm('...\n\n...')` 会把 JS 源码真的断行 → 浏览器里语法错误、整页白屏。
  必须写成 `join('\\n')`。`test/smoke.mjs` 第 13 段有断言守着（抓出来的内联 JS 用 `new Function()` 编译一次最稳）。
- **`normalizeBody` 必须和 `store.setSection` 的 trim 行为一致**（去 BOM、CRLF→LF、trim），
  否则"包内容"和"写入后的分区内容"hash 永远对不上，会一直显示"未安装"。

### 测试要注意

- `test/packs-smoke.mjs` 全在临时目录跑，随时可跑。
- `test/real-overwrite-reversibility.mjs` **会写真实 MEMORY.md**，所以用 `DSH_ALLOW_REAL_MEMORY_TEST=1` 门禁；
  它在 `finally` 里一定会把原文双写还原，但跑完仍建议手工核一次两侧 hash。
