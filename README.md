<div align="center">

# <img src="icon/app-icon.png" width="30" height="30" style="vertical-align:-6px"> Video Lab

**批量成片项目管理器 · Electron 桌面应用**

扫描项目与 TXT 配置，按日期分支管理版本，一键批量生成成片；也可对已有视频批量后处理（去黑屏 / 变速 / 转分辨率 / 转码 等）。

<br>

[![版本](https://img.shields.io/badge/版本-2.6.0-0078D7?style=flat-square)](https://github.com/HirannU-OVO/video-lab/releases)
![Platform](https://img.shields.io/badge/平台-Windows%2010%2F11-00A4EF?style=flat-square)
![Engine](https://img.shields.io/badge/任务引擎-内置-5391FE?style=flat-square)
![FFmpeg](https://img.shields.io/badge/FFmpeg-可自动下载-FF7F2A?style=flat-square)

</div>

---

## 功能亮点

| 类别 | 说明 |
| --- | --- |
| 免装依赖 | 任务执行组件随包内置，无需系统安装额外环境；缺少 FFmpeg 时应用启动后自动下载 |
| 视频处理工具 | 对已有视频批量后处理 —— 去黑屏 / 变速 / 转分辨率 / 转码（H.264 · H.265 · AV1）/ 叠加图片 / 截取 / 删帧 / 倒放 / 旋转镜像 / 音频 / 帧率，步骤自由组合，只编码一次 |
| 任务队列与通知 | 成片任务与视频处理任务同一队列：可排队、可在当前成片完成后暂停排队、失败可续跑；任务失败或本轮跑完弹系统通知 |
| 遮罩叠加 | 多原片 × 多遮罩自由组合（遮罩+水印 / 仅水印 / 仅遮罩），GPU 硬件编码，失败任务断点续跑 |
| 复刻与续跑 | 完全复刻 / 去重复刻双模式，失败成片可「继续制作」从断点恢复 |
| 日期分支管理 | TXT 配置按日期分支归档，历史版本随时比对与跳转 |
| 水印体系 | 归属校验、跨项目保存、主流水印一键递归替换 |
| 深度定制界面 | 多皮肤主题（含 Maid Atelier 女仆皮肤）、自制标题栏、托盘菜单自绘 |
| 后台化体验 | 预检测与成片索引后台运行不阻塞、缓存失效后台清理、开机自启静默到托盘、冷启动提速 |

## 目录结构

```
Video Lab/
├─ build/               # 打包钩子（afterPack.js）
├─ frontend/            # 渲染进程页面、样式与脚本
│  ├─ index.html        # 主窗口页面
│  ├─ settings.*        # 设置页（html/js/css）
│  ├─ task.*            # 任务列表（html/js）
│  ├─ tool.*            # 视频处理工具窗口（html/js）
│  ├─ guide.* / preview.html / trayMenu.html
│  ├─ app.js / icons.js / styles.css / titlebar.js / txapi.js
│  ├─ skins/            # 皮肤（Black_Orange / white_blue / Maid_Atelier + assets）
│  └─ fonts/            # 内置字体
├─ engines/             # 内置任务引擎，构建时复制为产物 resources\Engines
│  ├─ engine-runner.js / registry.js
│  ├─ base/             # 共享底座（ffmpeg/ffprobe/缓存/锁/日志/路径等）
│  ├─ modules/          # batch / mask / replica 三个成片引擎
│  └─ tools/            # 视频处理工具引擎（后处理步骤 + 流水线）
├─ icon/                # 应用图标
├─ main.js              # Electron 主进程
├─ preload.js           # 渲染进程桥接
├─ backend.js           # 后端业务逻辑
├─ server.js            # 浏览器访问 HTTP 服务
├─ run.js               # 启动入口（run.js 启动）
├─ package.json / package-lock.json
└─ CHANGELOG.md / LICENSE / NOTICE
```

> 运行时由 `app.asar` 加载应用源码；修改源码后需用 `@electron/asar` 重新打包才生效。

## 运行环境

- **NVIDIA 显卡（必需）**

  视频编码使用 NVIDIA NVENC 硬件编码器，必须配备 NVIDIA 独立显卡才能生成成片；
  暂不支持 CPU 回退编码，也不支持 AMD / Intel 等其他显卡的硬件编码。


## 首次运行

首次运行（或尚未设置工作路径）时，应用会打开「首次设置」引导窗口：

1. **项目数据根目录**：存放各项目文件夹与 TXT 配置（必选，也可直接跳过）

选择并保存工作路径后，软件会自动扫描现有配置、填入水印默认目录并开始检测，无需手动设置；跳过时主界面会显示「选择路径」引导提示。配置与缓存的实际保存位置（程序目录 / 用户数据目录）可在设置页「配置和数据保存位置」中调整。

## 构建与运行

```bash
npm install            # 安装依赖（含 electron / electron-builder 开发依赖）
npm start              # 开发运行
npm run build:dir      # 构建可直接运行的程序（产出 dist\win-unpacked，双击其中的 Video Lab.exe 即可使用）
```

> 构建产物是**可直接运行的目录** `dist\win-unpacked\`：双击里面的 `Video Lab.exe` 即可使用，无需安装。

> FFmpeg 不在构建产物内，应用启动会自动下载；如需离线使用：把自备的 `ffmpeg.exe` 与 `ffprobe.exe` 放进**程序目录的 `resources\ffmpeg`**，或在设置页指定 FFmpeg 目录（适合自备完整版）。**不会回退系统 PATH**。

## 皮肤素材来源与许可

内置皮肤「深海女仆（Maid Atelier）」移植自开源皮肤项目 `maid-atelier`（dsh-deep-whale 仓库）：

- 皮肤项目地址：<https://github.com/Small-tailqwq/dsh-deep-whale/tree/main/maid-atelier>
- 上游授权（分离）：**代码 MIT** / **素材 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**（署名-非商业性使用-相同方式共享）

按 CC BY-NC-SA 4.0 的署名要求，本皮肤保留完整创作链，原始作者与主页如下：

| 创作层 | 作者 | 说明 | 来源 |
| --- | --- | --- | --- |
| 一创 | 上善（上善无形） | 鲸鱼娘（whale-girl）角色形象原作 | [Pixiv](https://www.pixiv.net/users/62155430) · [Bilibili](https://b23.tv/8h5L4xz) |
| 二创 | ZipZipPipe | 女仆鲸鱼娘二次设计（含 DeepSeek 元素，GPT Image 2 生成） | [Pixiv](https://www.pixiv.net/users/18604994) · [Bilibili](https://b23.tv/Pnw6nG8) |
| 三创（皮肤实现） | Small-tailqwq | DeepSeek 元素再设计与皮肤工程实现 | [GitHub](https://github.com/Small-tailqwq/dsh-deep-whale) |

皮肤工程脚手架来自 [zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web)（作者：Solitude，Apache-2.0）。

依据授权条款：本皮肤素材仅限**非商业性**使用；对包含本皮肤的部分进行再分发或修改时，须以**相同方式共享（ShareAlike）**并保留上述署名与完整创作链。

本仓库采用分离授权：

- **代码部分**（除 `frontend/skins/assets/` 外）：**[MIT](./LICENSE)**
- **素材部分**（`frontend/skins/assets/` 下的图片素材）：**[CC BY-NC-SA 4.0](./LICENSE-ARTWORK)** —— 仅限非商业性使用

创作链与第三方素材声明见 [`NOTICE`](./NOTICE)。

## 更新日志

详见 [CHANGELOG.md](./CHANGELOG.md)。