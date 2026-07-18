# Fav Vault - 📦 将社交媒体收藏转为自动下载任务流

简体中文 | [English](README.md)

收藏 → 任务队列 → 自动下载 → 归档 → 去重 → 完成消费

Fav Vault 是一个自动化工具，用于将社交媒体的"收藏行为"转化为可执行的下载任务流，实现收藏内容的自动获取与本地归档。

它让收藏夹不再只是静态列表，而是一个持续运行的内容处理系统。

<p align="center"><img src="screenshot/screenshot_index.png" width="100%"></p>
<p align="center"><img src="screenshot/screenshot_detail.png" width="100%"></p>

---

## ⚠️ 警告

本项目可能触发社交媒体风控规则，存在不可预期的风险，请谨慎使用。  
程序会在作品处理完成后执行**取消该作品收藏/书签操作**。  
程序会将账号登录凭证保存到本地数据库，请确保 database 文件安全。  
本脚本仅供学习与技术交流，请遵守平台规则和相关法律法规。

---

## ✨ 功能特性

### 📥 自动化收藏采集
自动读取社交媒体收藏内容，并转换为下载任务，无需手动操作。

### ⚙️ 任务流式处理
基于任务队列执行下载流程，支持定时运行与手动触发。

### 🗂️ 自动归档管理
按作者 / 来源自动整理文件结构，使下载内容清晰可查。可自定义下载路径模板。

### 📊 实时进度追踪
下载过程中实时显示整体进度和单文件进度，支持 SSE 实时推送。

### 🖼️ 文件预览
下载完成后支持点击文件名弹出预览，图片/视频内联显示，支持左右键切换。

---

## 📸 支持平台

| 平台 | 状态 | 驱动方式 |
|------|------|----------|
| 抖音 | ✅ 已支持 | 收藏 |
| Twitter / X | ✅ 已支持 | 书签 |

---

## 🚀 快速开始

### 本地运行

```bash
npm install
npm start
```

启动服务（自定义参数）：

```bash
CHROME_PATH=/path/to/chrome PORT=8080 npm start
```

Windows：

```powershell
$env:CHROME_PATH="C:\path\chrome.exe"
npm start
```

访问：

```
http://localhost:5000
```

---

### Docker 部署

使用预构建镜像（推荐）：

```bash
docker run -d \
  -p 5000:5000 \
  -v ~/fav-vault/downloads:/app/downloads \
  -v ~/fav-vault/database:/app/database \
  --name fav-vault \
  ghcr.io/tanmusong/fav-vault:latest
```

或自行构建：

```bash
docker compose build
docker compose up -d
```

访问：

```
http://localhost:5000
```

---

## 📖 使用流程

### 1️⃣ 获取 Cookie

登录目标平台后，通过浏览器开发者工具或 [Cookie Editor](https://cookie-editor.com/) 插件获取登录 Cookie。

### 2️⃣ 创建任务

在 Web 界面点击 `+ 新建任务`，填写：

- 社交媒体平台
- 执行间隔（分钟）
- Cookie
- 下载路径模板（可选，默认 `{type}/{user}/{author_id}_{author}`）

系统自动验证登录状态。

### 3️⃣ 自动执行

系统将周期性执行：

- 扫描收藏/书签内容
- 生成下载任务
- 执行下载（支持并发）
- 实时显示进度
- 自动归档
- 移除已处理收藏

也可手动点击 **立即执行**。

### 4️⃣ 查看结果

可查看：

- 下载内容及文件预览
- 作者信息与用户ID
- 执行状态与进度
- 下载文件列表与大小
- 历史记录

---

## ⚙️ 下载路径模板

创建任务时可自定义下载路径模板，支持以下变量：

| 变量 | 含义 |
|------|------|
| `{type}` | 平台名称 |
| `{user}` | 任务名称（用户名） |
| `{id}` | 用户ID |
| `{author}` | 作者显示名 |
| `{author_id}` | 作者账号 |

默认模板：`{type}/{user}/{author_id}_{author}`

---

## ⚙️ 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| PORT | Web 服务端口 | 5000 |
| DOWNLOAD_DIR | 下载目录 | `~/fav-vault/downloads` |
| DB_PATH | 数据库存储路径 | `~/fav-vault/database` |
| MAX_CONCURRENT | 最大并发下载数 | 2 |
| CHROME_PATH | Chrome/Chromium 路径 | 必填 |

---

## 🛠️ 环境要求

- Node.js 22+
- Chrome / Chromium
- Docker（可选）

---

## 🔐 安全说明

- Cookie 仅用于本地登录态维持
- 不上传任何第三方服务器
- 所有数据均存储在本地

---

## ☕ 赞助

如果觉得本项目有帮助，欢迎请我喝杯咖啡：

<a href="https://www.afdian.com/a/tanmusong" target="_blank"><img src="https://pic1.afdiancdn.com/static/img/welcome/button-sponsorme.png" height="40"></a>

<a href="https://ko-fi.com/tanmusong" target="_blank"><img src="https://storage.ko-fi.com/cdn/brandasset/v2/support_me_on_kofi_blue.png" height="40"></a>
