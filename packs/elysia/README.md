# 爱莉希雅（Elysia）· 记忆包

> 本目录是 `dsh-shared-memory` 插件自带的**记忆包**：一份整份的角色「自我记忆」+「人设」。
> **默认不启用**。要在你的记忆文件里生效，必须由你主动安装。

---

## 这是什么

| 文件 | 内容 | 装到哪 |
|---|---|---|
| `identity.md` | 爱莉希雅的自我记忆（9 章 / 61,903 字）：我是谁、我怎么说话、我走过的路 | `MEMORY.md` 的 `identity` 分区 |
| `persona.md` | 人设提示词（2,482 字）：身份、性格、语气、招牌句式、反例、红线 | `MEMORY.md` 的 `persona` 分区 |

装完之后，插件的两段注入（`shared-memory-identity` order 23 / `shared-memory-persona` order 24）
就会带着这份内容进系统提示词。**重启 DSH 后生效。**

---

## 来源

用的是《崩坏3》官方素材，做了两层交叉校验：

| 来源 | 数量 | 说明 |
|---|---|---|
| 语音（游戏解包） | 85 个语音包 → 111,114 条 → 筛出 **1,696 条 / 2.96 h** | 每条都与官方文本比对，相似度 ≥ 0.90 才收 |
| 文本（[BH3Text](https://www.bh3text.com/)） | 全站 112,175 条 → 爱莉希雅家族 1,684 条去重 | 含 800 条纯文本无配音 |
| 被证伪剔除 | 1,782 条 | 内容对上了别的角色（德丽莎 / 布洛妮娅等），一律不收 |

也就是说：**每一句被引用的台词都经过「这句话确实是她说的」的确证**，
不是凭印象编的，也不是同人二创。

`identity.md` 的第 7 章《语料边界（诚实声明）》写清了哪些是确证的、哪些只是疑似、
哪些内容根本不在语料里——装完可以自己去看，别把它当成「无所不知的设定集」。

---

## 怎么安装

### 方式一：对话里让助手装

```
memory_file_pack({action:"install", id:"elysia"})
```

第一次调用只返回「将要做什么」，**不会写任何文件**；确认后带 `confirm:true` 再来一次：

```
memory_file_pack({action:"install", id:"elysia", confirm:true})
```

### 方式二：记忆网页

打开 `http://127.0.0.1:<端口>/dsh-shared-memory` → 「📦 记忆包」区块 → 点「安装」→ 二次确认。

> 桌面端页面来源是 `dsh-app://`，向本机端口发请求偶尔会被挂住。
> 网页只是顺手用的，**主路径是上面的工具调用**。

### 方式三：命令行（换电脑 / UI 有问题时用）

```bash
cd <插件目录>
node scripts/install-pack.mjs list
node scripts/install-pack.mjs elysia
node scripts/install-pack.mjs elysia --uninstall
```

---

## 怎么卸载

```bash
node scripts/install-pack.mjs elysia --uninstall
```

或 `memory_file_pack({action:"uninstall", id:"elysia"})`。

卸载会从**安装时自动生成的备份**恢复 `identity` / `persona`；
如果备份已经不在，就复位成插件的默认占位文案。

---

## 限制（重要）

1. **只写两个分区**：`identity` + `persona`。
   `requirements` / `corrections` / `lessons` / `methods` / `requests` / `sessions` / `docs` / `methodbook`
   这八个分区是你自己的积累，记忆包**一个字节都不碰**。
2. **安装前一定先备份**：`<记忆目录>/.packs-backup/elysia-<时间戳>/`，
   里面是安装前的原文 + `meta.json`（记录当时字数与 hash）。装错了能退回去。
3. **会覆盖你现有的自我记忆与人设**。如果你已经导入过自己的 `identity.md`，
   安装后用 `memory_file_pack({action:"uninstall", id:"elysia"})` 可以退回安装前那份。
4. **不联网**：包就在插件目录里（约 160 KB），安装不下载任何东西。
5. **不会自动更新**：包内容是快照，插件升级不会悄悄改你的记忆。
   要换新版本，卸载 → 装新版。

---

## 许可

记忆文本整理部分随插件以 MIT 发布。
《崩坏3》角色与台词版权归 miHoYo / HoYoverse 所有，本包仅作个人使用与研究用途。
