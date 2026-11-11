# Face Rig · P3 语音驱动数字人

一个运行在浏览器里的 **3D 表情数字人**：加载带 52 通道 ARKit blendshape 的头部模型，通过语音合成（TTS）的音频时钟驱动口型与表情，并接入大语言模型（LLM）进行实时对话。

> 🤝 **这是一个开源社区项目，欢迎所有人参与开发与维护。** 无论你是想修复 bug、优化渲染、改进表情表现、接入新的模型或 TTS 引擎，还是单纯提建议，你的贡献都会被认真对待。详见 [CONTRIBUTING](#如何参与贡献)。

## 特性

- **ARKit 52 通道 blendshape**：完整映射眼、眉、嘴、颊等面部表情通道
- **语音驱动口型**：基于 TTS 音频时长的音素（viseme）对齐，嘴型与声音同步
- **LLM 实时对话**：支持 Ollama（本地）与 OpenAI 兼容接口，可接入任意模型
- **内联表情标签**：在回复文本中嵌入 `<e:joy:0.8>` 式标签，让表情跟随语义
- **情绪系统**：愉悦度 / 唤醒度驱动的表情基调与节奏控制
- **程序化皮肤烘焙**：运行时按世界坐标烘焙 albedo / 法线 / 粗糙度贴图
- **可塑形头部**：几何重塑（reshape）与眼球独立控制

## 目录结构

```
face-p0/
├── src/                # 前端核心源码（ES 模块）
│   ├── rig.js          # 场景装配、材质、表情绑定
│   ├── anim.js         # blendshape 混合与动画
│   ├── skin.js         # 皮肤/眼球贴图烘焙
│   ├── reshape.js      # 头部几何塑形
│   ├── dialogue.js     # 对话编排
│   ├── viseme.js       # 音素-口型映射
│   ├── semantics.js    # 语义表情标签解析
│   └── ...
├── server.mjs          # Node 静态服务 + LLM/TTS 后端
├── build.mjs           # esbuild 打包脚本
├── assets/             # 模型与贴图资源（.glb / .png）
├── native/             # macOS 原生 TTS（Swift）
└── scripts/            # 分析与测试脚本
```

## 快速开始

### 环境要求

- Node.js ≥ 18
- （可选）[Ollama](https://ollama.com/) 用于本地 LLM，或任意 OpenAI 兼容接口
- （可选）macOS 系统用于原生 TTS（其他平台可用系统自带 TTS 兜底）

### 安装与运行

```bash
# 1. 安装依赖
npm install

# 2. 构建前端 bundle
npm run build

# 3. 启动服务（默认 http://127.0.0.1:5173）
npm start
```

浏览器打开 `http://127.0.0.1:5173` 即可看到数字人。

### 接入大模型

项目默认尝试连接本机 Ollama（`http://127.0.0.1:11434`）。你也可以通过环境变量接入 OpenAI 兼容接口：

```bash
# OpenAI 兼容接口
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_API_KEY=sk-xxxx

# 或指定本地 Ollama 模型
export OLLAMA_URL=http://127.0.0.1:11434
export OLLAMA_MODEL=qwen2.5:7b

npm start
```

> 所有密钥均通过环境变量注入，请勿将真实密钥提交到仓库。

## 技术要点

- **渲染**：Three.js（WebGL），ACES 色调映射，程序化贴图烘焙
- **表情**：ARKit 52 blendshape 由 `FaceMixer` 统一驱动，支持手动控制与标签驱动
- **口型**：`viseme.js` 将 TTS 时间轴映射到嘴部 blendshape
- **对话**：`dialogue.js` 编排 LLM 流式输出、表情标签解析与语音合成

## 如何参与贡献

我们热切欢迎**所有人**参与开发与维护，无论你的经验水平如何：

- 🐛 **报告 Bug**：在 [Issues](../../issues) 中描述问题，附上复现步骤和环境信息
- 💡 **提建议**：有任何想法都可以开 Issue 讨论
- 🔧 **提交代码**：Fork 本仓库 → 创建分支 → 提交 PR，我们会尽快 review
- 📝 **改进文档**：README、注释、Wiki 的完善同样宝贵
- 🌍 **接入新能力**：新的 LLM 后端、TTS 引擎、表情模型等

### 提交代码约定

1. Fork 仓库并创建功能分支（`git checkout -b feat/your-feature`）
2. 提交前运行测试：`npm test`
3. 保持提交信息清晰，说明改了什么、为什么改
4. 提交 Pull Request，描述变更内容

## 许可证

[MIT](./LICENSE) © Face Rig 贡献者
