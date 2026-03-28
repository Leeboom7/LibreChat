# E2B Agent 系统架构文档

## 📋 目录
1. [系统概述](#1-系统概述)
2. [整体架构](#2-整体架构)
3. [核心模块详解](#3-核心模块详解)
4. [数据流详解](#4-数据流详解)
5. [与 Azure Assistant 对比](#5-与-azure-assistant-对比)

---

## 1. 系统概述

### 1.1 设计目标
- 提供可扩展的数据分析 Agent 框架
- 支持自定义工具和 Python 沙箱执行
- 完全透明的执行流程和调试能力
- 避免供应商锁定

### 1.2 技术栈
- **后端**: Node.js + Express.js
- **LLM**: OpenAI Chat Completions（支持 OpenAI/Azure OpenAI，默认回退 gpt-4o）
- **沙箱**: E2B Cloud Sandbox
- **数据库**: MongoDB
- **存储**: Local/S3/Azure Blob

### 1.3 代码统计
```
Git 统计:
- 提交数: 83 个（相对于 upstream/main）
- 文件变更: 139 files changed, 17842 insertions(+), 204 deletions(-)
- 新增文件: 49 个

核心模块代码量:
- Controller:        1029 行 (api/server/routes/e2bAssistants/controller.js)
- E2BAgent:          902 行 (api/server/services/Agents/e2bAgent/index.js)
- Context Manager:   368 行 (api/server/services/Agents/e2bAgent/contextManager.js)
- Tools:             476 行 (api/server/services/Agents/e2bAgent/tools.js)
- System Prompts:    280 行 (api/server/services/Agents/e2bAgent/prompts.js)
- Sandbox Manager:   919 行 (api/server/services/Endpoints/e2bAssistants/initialize.js)
- Code Executor:     206 行 (api/server/services/Sandbox/codeExecutor.js)
- File Handler:      172 行 (api/server/services/Sandbox/fileHandler.js)

代码分类汇总:
- 后端核心逻辑:  ~4,352 行
- 前端组件:       ~400 行
- 测试代码:       ~808 行
- 文档:           ~6,500 行
- E2B 模板:       ~85 行
- TypeScript Schema: ~86 行
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
总计新增代码:     ~17,842 行（相对 upstream/main）
```

---

## 2. 整体架构

### 2.1 系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    LibreChat Frontend                        │
│                     (React + TypeScript)                     │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP/SSE
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    Express.js Backend                        │
│         POST /api/e2b-assistants/:assistantId/chat           │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│               Controller (1029 行)                           │
│    api/server/routes/e2bAssistants/controller.js            │
│                                                              │
│  职责:                                                       │
│  - 加载历史消息 (getMessages)                                │
│  - 初始化 E2BAgent                                           │
│  - 处理 SSE 流式响应                                         │
│  - 消息持久化 (saveMessage)                                  │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                  E2BAgent 核心 (902 行)                      │
│    api/server/services/Agents/e2bAgent/index.js             │
│                                                              │
│  ┌────────────────────────────────────────────────┐         │
│  │  ReAct 循环 (最大 20 次迭代)                   │         │
│  │  1. 构建消息 (系统提示 + 历史 + 用户消息)     │         │
│  │  2. 调用 LLM (messages + tools)               │         │
│  │  3. 解析响应 (text / tool_calls)              │         │
│  │  4. 执行工具 (如有 tool_calls)                │         │
│  │  5. 添加结果到消息历史                         │         │
│  │  6. 重复直到 LLM 结束或达到最大迭代            │         │
│  └────────────────────────────────────────────────┘         │
│                                                              │
│  依赖组件:                                                   │
│  - Context Manager (368 行) - 状态管理                      │
│  - System Prompts (280 行) - 提示词生成                     │
│  - Tools (476 行) - 工具执行                                │
└──────────┬──────────────────────┬──────────────────────────┘
           │                      │
           ▼                      ▼
┌──────────────────────────┐    ┌─────────────────────────────────┐
│  OpenAI Chat Completions │    │   E2B Sandbox Manager (919 行)  │
│                  │    │   initialize.js                 │
│ - OpenAI / Azure  │    │                                 │
│ - Tool calling   │    │ 职责:                           │
│ - Streaming      │    │ - 沙箱创建/复用/销毁            │
└──────────────────────────┘    │ - 文件上传/下载/列表            │
                        │ - 代码执行接口                  │
                        └────────┬────────────────────────┘
                                 │
                                 ▼
                      ┌────────────────────────┐
                      │   E2B Cloud Sandbox    │
                      │   (Python 3.11+)       │
                      │                        │
                      │ 预装库:                │
                      │ - pandas, numpy        │
                      │ - matplotlib, seaborn  │
                      │ - scikit-learn         │
                      │ - xgboost              │
                      └────────────────────────┘
```

### 2.2 请求流程概览

```
用户发送消息 "分析 titanic.csv"
  ↓
Controller: 加载历史消息
  ↓
Controller: 初始化 E2BAgent
  ↓
Agent: 检查沙箱，恢复文件 (Layer 1)
  ↓
Agent: 开始 ReAct 循环
  │
  ├─> Iteration 1:
  │   ├─> LLM 调用 (history + user message)
  │   ├─> LLM 响应: tool_use(execute_code)
  │   ├─> Tools: 执行代码 → E2B Sandbox
  │   ├─> Tools: 检测超时 → 恢复 (Layer 2 如需要)
  │   ├─> Tools: 持久化图片
  │   └─> 将结果添加到 messages
  │
  ├─> Iteration 2:
  │   ├─> LLM 调用 (with tool result)
  │   ├─> LLM 响应: text + stop
  │   └─> 循环结束
  │
  ↓
Controller: SSE 流式返回
  ↓
Controller: 保存消息到数据库
```

---

## 3. 核心模块详解

### 3.1 E2BAgent (index.js - 902 行)

**文件位置**: `api/server/services/Agents/e2bAgent/index.js`

#### 职责
- 协调 LLM 和工具的交互（ReAct 循环）
- 管理对话历史和上下文
- 控制迭代次数和流式输出
- 管理沙箱生命周期

#### 核心属性
```javascript
class E2BDataAnalystAgent {
  constructor(options) {
    this.userId               // 用户 ID
    this.conversationId       // 对话 ID
    this.assistantId          // 助手 ID
    this.openai               // OpenAI/Azure OpenAI 客户端
    this.tools                // 可用工具 [execute_code, list_files, upload_file, export_file, complete_task]
    this.sandbox              // E2B 沙箱实例
    this.contextManager       // Context Manager 实例
    this.maxIterations = 20   // 最大迭代次数
  }
}
```

#### 关键方法

**1. processMessage()** - 消息处理入口 (第 44-102 行)
```javascript
功能:
  - 检查并创建沙箱
  - Layer 1 沙箱恢复: 从数据库恢复文件
  - 调用 _runAgent() 执行主逻辑

关键逻辑 (第 50-100 行):
  if (existingFiles.length > 0 && !sandbox) {
    // 从数据库查询 file_ids
    const fileIdsToRestore = existingFiles.map(f => f.file_id);
    
    // 实际上传到新沙箱 (关键修复)
    const restoredFiles = await fileHandler.syncFilesToSandbox({
      userId, conversationId, fileIds, sandbox
    });
    
    // 更新 Context Manager
    this.contextManager.updateUploadedFiles(restoredFiles);
  }
```

**2. _runAgent()** - ReAct 循环 (第 189-371 行)
```javascript
功能:
  - 构建消息数组 (system + history + user)
  - 迭代调用 LLM
  - 检测 tool_calls 并执行
  - 累积最终内容

流式模式 (第 189-279 行):
  while (iteration <= this.maxIterations) {
    const response = await this.openai.chat.completions.create({
      messages,
      tools,
      stream: true
    });
    
    // 处理流式 token
    for await (const chunk of response) {
      if (chunk.type === 'content_block_delta') {
        this.emit('token', chunk.delta.text);
      }
    }
    
    // 检测 tool_calls
    if (stop_reason === 'tool_use') {
      const toolResult = await this._executeTools(toolCalls);
      messages.push(...); // 添加到历史
      iteration++;
      continue;
    }
    
    // 迭代提醒 (第 318-330 行)
    if (iteration >= this.maxIterations - 3) {
      toolResponseContent += "\n\n⚠️ IMPORTANT: You have X iterations remaining...";
    }
  }
```

**3. _executeTools()** - 工具执行 (第 387-432 行)
```javascript
功能:
  - 遍历 tool_calls 数组
  - 调用对应的工具函数
  - 捕获错误并格式化

代码:
  for (const toolCall of toolCalls) {
    const toolFunc = this.tools[toolCall.name];
    const result = await toolFunc(toolCall.input, this);
    results.push({ tool_use_id, content: result });
  }
```

#### 与其他模块的交互

```javascript
// → Context Manager
this.contextManager.addUploadedFile(file);
this.contextManager.generateFilesContext();
this.contextManager.generateErrorRecoveryContext(error);

// → E2B Sandbox Manager
const sandbox = await e2bClientManager.getSandbox(userId, conversationId);
await e2bClientManager.killSandbox(userId, conversationId);

// → LLM Provider
    const response = await this.openai.chat.completions.create({
  messages,
  tools: this.tools,
  stream: true
});

// → Tools
const result = await execute_code({ code: '...' }, agent);
```

---

### 3.2 Context Manager (contextManager.js - 387 行)

**文件位置**: `api/server/services/Agents/e2bAgent/contextManager.js`

#### 职责
- **Single Source of Truth**: 统一管理会话状态
- 内部存储 file_id (带 UUID 前缀)，外部暴露 clean filename
- 生成结构化的 LLM 上下文
- 提供动态错误恢复指导

#### 核心数据结构
```javascript
class ContextManager {
  constructor(userId, conversationId, assistantId) {
    this.userId = userId;
    this.conversationId = conversationId;
    this.assistantId = assistantId;
    
    // 核心状态
    this.uploadedFiles = [];      // [{ filename, file_id, filepath }]
    this.generatedArtifacts = [];  // [{ name, type, path, conversationId }]
    this.recentErrors = [];        // [{ type, message, timestamp }]
  }
}
```

#### 核心方法

**1. 文件管理**
```javascript
addUploadedFile(file)         // 添加上传的文件
updateUploadedFiles(files)    // 批量更新（用于恢复）
getUploadedFiles()            // 获取文件列表
```

**2. 工件管理**
```javascript
addGeneratedArtifact(artifact)  // 记录生成的图片/文件
  位置: 第 56-70 行
  功能: 
    - 关联 conversationId
    - 防止跨对话混淆
    - 增强日志记录

getGeneratedArtifacts()         // 获取工件列表
```

**3. 上下文生成**

**generateFilesContext()** (第 128-169 行)
```markdown
输出示例:

📁 AVAILABLE FILES:
1. titanic.csv
   Path: /home/user/titanic.csv
   Uploaded: 2 minutes ago

💡 IMPORTANT:
- Use these exact paths in your code
- Files persist across conversation turns
- DO NOT try to save plots to /images/ directory
```

**generateArtifactsContext()** (第 171-196 行)
```markdown
输出示例:

📊 GENERATED ARTIFACTS (2):
1. plot-0.png (image)
   Path: /images/userId/timestamp-plot-0.png
2. analysis.csv (data)
   Path: /images/userId/timestamp-analysis.csv
```

**generateErrorRecoveryContext()** (第 228-256 行)
```javascript
分层错误处理:

Tier 1 - 关键错误 (环境相关):
  if (error.includes('FileNotFoundError')) {
    return _generateFileRecoveryGuidance();
  }
  if (error.includes('ModuleNotFoundError')) {
    return _generateLibraryGuidance();
  }

Tier 2 - 通用调试 (第 320-345 行):
  return _generateGenericErrorGuidance();
  
  输出:
  💡 DEBUGGING TIPS:
  1. Read the error traceback carefully
  2. Check data types - Use df.dtypes, df.info()
  3. Inspect data - Use df.head(), df.describe()
  4. Common issues: wrong data types, missing values, wrong columns
  5. Fix strategies: df.select_dtypes(), df.dropna(), df.astype()
```

#### 设计理念

**Explicit over Implicit (明确优于隐式)**
- LLM 不看到内部 UUID 前缀
- 提供清晰的文件路径和使用说明
- 动态生成针对性的错误指导

**Single Source of Truth**
- 所有状态集中管理
- 避免状态分散导致不一致

---

### 3.3 Tools (tools.js - 476 行)

**文件位置**: `api/server/services/Agents/e2bAgent/tools.js`

#### 职责
- 定义工具的 schema
- 实现工具执行逻辑
- 格式化 observation 返回
- 处理图片持久化
- Layer 2 沙箱恢复

#### 可用工具列表

工具总数: **5 个**
1. `execute_code` - 执行 Python 代码
2. `list_files` - 列出沙箱文件
3. `upload_file` - 上传文件到沙箱
4. `export_file` - 导出沙箱文件并返回下载链接
5. `complete_task` - 智能任务完成（2026-01-19 新增）

**execute_code** (第 29-220 行)

**功能**: 在 E2B 沙箱中执行 Python 代码

**返回格式**:
```javascript
{
  success: true,
  stdout: "执行输出...",
  stderr: "",
  has_plots: true,
  plot_count: 2,
  image_paths: [
    "/images/userId/timestamp-plot-0.png",
    "/images/userId/timestamp-plot-1.png"
  ],
  images_markdown: "![Plot 0](/images/.../plot-0.png)\n...",
  plot_info: "Generated 2 plot(s). Use these paths directly..."
}
```

**关键特性**:

**① Layer 2 沙箱恢复** (第 64-109 行)
```javascript
try {
  result = await codeExecutor.execute(...);
} catch (error) {
  // 检测沙箱超时
  if (error.message?.includes('timeout') || 
      error.message?.includes('502')) {
    
    logger.warn('Sandbox timeout detected, recreating...');
    
    // 重建沙箱
    sandbox = await e2bClientManager.createSandbox(...);
    
    // 恢复文件
    const existingFiles = agent.contextManager.getUploadedFiles();
    const fileIds = existingFiles.map(f => f.file_id);
    const restoredFiles = await fileHandler.syncFilesToSandbox({...});
    
    // 重新执行代码
    result = await codeExecutor.execute(...);
  }
}
```

**② 图片自动持久化** (第 117-180 行)
```javascript
if (result.images && result.images.length > 0) {
  // 持久化到存储后端 (Local/S3/Azure)
  const persistedFiles = await fileHandler.persistArtifacts(
    agent.userId,
    sandbox.sandboxId,
    result.images
  );
  
  // 添加到 Context Manager
  persistedFiles.forEach(file => {
    agent.contextManager.addGeneratedArtifact({
      name: file.filename,
      type: 'image',
      path: file.filepath
    });
  });
  
  // 直接提供正确路径给 LLM
  observation.image_paths = persistedFiles.map(f => f.filepath);
  observation.images_markdown = persistedFiles.map((f, i) => 
    `![Plot ${i}](${f.filepath})`
  ).join('\n');
}
```

**③ 统一错误格式** (第 192-209 行)
```javascript
// 失败时也返回完整结构，防止 LLM 无限重试
return {
  success: false,
  error: error.message,
  stdout: '',
  stderr: error.message,  // 提供 traceback
  has_plots: false,
  plot_count: 0,
  image_paths: [],
  images_markdown: '',
  plot_info: ''
};
```

**upload_file** (第 239-279 行)
- 上传文件到沙箱
- 支持 base64 编码文件或文本内容
- 自动记录到 Context Manager

**complete_task** (第 330-353 行) ⭐ 新增

**功能**: 智能任务完成机制，让 LLM 主动决定何时结束任务

**参数**:
```javascript
{ summary: string }  // 任务总结（必需）
```

**返回格式**:
```javascript
{
  success: true,
  completed: true,
  message: 'Task completed successfully',
  summary: '完整的任务总结...'
}
```

**设计理念**:
- **从被动判断到主动决策**: 旧版依赖 "没有 tool_calls" 判断任务完成，容易造成误判（LLM 解释后就停止）
- **明确终止信号**: LLM 必须显式调用 `complete_task` 才算任务完成
- **防止提前停止**: 确保 LLM 完成所有计划步骤后才终止
- **自动总结**: 强制 LLM 提供任务总结，提升输出质量

**工作流**: 
```
Iteration 1: 计划 (4步) + 执行 Step 1
Iteration 2: Step 1 解释 + 执行 Step 2
Iteration 3: Step 2 解释 + 执行 Step 3
...
Iteration N: 最后一步解释 + complete_task(summary="所有步骤完成...") ✅
```

---

### 3.4 System Prompts (prompts.js - 280 行) ⭐ 已优化

**文件位置**: `api/server/services/Agents/e2bAgent/prompts.js`

#### 职责
- 定义 Agent 的行为规范
- 说明工具使用方法（5 个工具：execute_code, list_files, upload_file, export_file, complete_task）
- 提供可视化和错误处理指导

#### 优化历史 (2026-02-09 + 2026-03)
- 删除 `Multi-Scenario Adaptation Rules` 章节（~50 行冗余示例代码）
- 删除 `Common Error Patterns` 章节（~15 行硬编码错误类型）
- 删除数据库连接、XGBoost 等冗余示例代码（~40 行）
- 在 2026-03 扩展后当前为 280 行（新增 export_file/download 流程与更完整约束）
- **哲学转变**: 从 "详尽示例驱动" → "简洁原则驱动"

#### 核心章节

**1. 身份定义** (第 3-7 行)
```
You are a Professional Data Analyst Agent specialized in end-to-end Python data tasks.
帮助用户完成数据采集、预处理、EDA、机器学习、结果解读等任务。
遵循最佳实践：可复现代码、清晰文档、逐步解释。
```

**2. 工具定义** (第 43-50 行)
```
4. **Tool Calling Format**:
   - execute_code(code): 执行完整可运行代码
   - list_files(path): 检查沙箱中的文件
  - upload_file(filename, content): 上传文件到沙箱
  - export_file(path): 导出文件并返回下载链接
   - complete_task(summary): 所有步骤完成后调用（必需）✨
```

**3. Execution Workflow** (第 62-79 行) - 关键优化
```
### 1. Initial Turn (First Response)
- Step 1: 生成编号计划（3-5 步）作为第一输出
- Step 2: 通过 execute_code 工具执行第 1 步
- Step 3: 立即提供量化解释（纯文本，不在工具参数内）

### 2. Subsequent Turns (Iterative Execution)
- 直接执行下一步（不要说 "现在执行第 X 步"）
- 立即解释结果
- 自动进入下一轮（无需用户确认）

### 3. Final Turn (Task Termination) ✨
- 执行最后一步 + 解释结果
- **必须调用 complete_task 工具**终止任务
- 不要仅用文本终止 — complete_task 工具调用是必需的
```

**4. 强制性要求** (第 81-88 行)
```
1. Plan First（先计划，零容忍违规）
2. Sequential Execution（按顺序完成所有步骤）
3. Immediate Interpretation Rule（每次执行后必须解释）
4. Autonomous Operation（不要询问用户确认）
5. Objective Reporting（仅呈现量化结果和可验证观察）
6. Language Consistency（全程使用用户语言）
```

---

### 3.5 E2B Sandbox Manager (initialize.js - 919 行)

**文件位置**: `api/server/services/Endpoints/e2bAssistants/initialize.js`

#### 职责
- 管理沙箱的创建、复用、销毁
- 提供文件操作接口
- 自动清理过期沙箱

#### 核心类
```javascript
class E2BClientManager {
  constructor() {
    this.sandboxes = new Map();  // key: userId:conversationId
    this.apiKey = process.env.E2B_API_KEY;
    this.templateId = process.env.E2B_SANDBOX_TEMPLATE;
    this.defaultTimeout = 5 * 60 * 1000; // 5 分钟
  }
}
```

#### 核心方法

**getSandbox()** - 获取或创建 (第 72-115 行)
```javascript
const key = `${userId}:${conversationId}`;

// 检查是否已存在
if (this.sandboxes.has(key)) {
  const existingSandbox = this.sandboxes.get(key);
  // 验证沙箱是否活跃
  if (await this._isSandboxAlive(existingSandbox.sandbox)) {
    return existingSandbox;  // 复用
  }
}

// 创建新沙箱
return await this.createSandbox(userId, conversationId);
```

**createSandbox()** - 创建新沙箱 (第 117-170 行)
- 调用 E2B SDK
- 存储到 Map
- 设置超时自动清理

**文件操作接口**
- uploadFile() (第 172-197 行)
- listFiles() (第 199-219 行)
- downloadFile() (第 221-251 行)

---

### 3.6 Code Executor (codeExecutor.js - 206 行)

**文件位置**: `api/server/services/Sandbox/codeExecutor.js`

#### 职责
- 代码安全验证
- 调用 E2B 执行代码
- 提取图片
- 统一返回格式

#### 核心方法

**execute()** - 执行代码 (第 32-120 行)
```javascript
流程:
  1. validateCode() - 安全验证
  2. sandbox.run_python(code)
  3. _extractImages() - 提取图片
  4. 格式化返回
```

**validateCode()** - 安全验证 (第 122-161 行)
```javascript
检查项:
  Critical: exec(), eval(), compile(), __import__()
  Warning: import os, import sys, import subprocess
```

**_extractImages()** - 图片提取
- 从 execution.results 提取
- 支持 PNG, JPEG, SVG
- Base64 → Buffer

---

### 3.7 File Handler (fileHandler.js - 172 行)

**文件位置**: `api/server/services/Sandbox/fileHandler.js`

#### 职责
- 多存储后端支持 (Local/S3/Azure)
- 同步文件到沙箱
- 持久化沙箱生成的文件
- 创建数据库记录

#### 核心方法

**syncFilesToSandbox()** - 同步文件 (第 38-136 行)
```javascript
功能:
  - 从数据库获取文件元数据
  - 从存储后端下载内容
  - 上传到 E2B 沙箱
  - 自动清理 UUID 前缀 (第 84-86 行)
    const cleanFilename = filepath.replace(/^UUID__[0-9a-f-]+__/, '');
```

**persistArtifacts()** - 持久化 (第 138-256 行)
```javascript
功能:
  - 从沙箱下载文件
  - 保存到存储后端
  - 创建数据库记录
  - 生成唯一路径: timestamp-filename
```

---

### 3.8 Controller (controller.js - 852 行) ⭐ 已优化

**文件位置**: `api/server/routes/e2bAssistants/controller.js`

#### 职责
- 处理 HTTP 请求
- 加载历史消息
- 初始化 E2BAgent
- 处理 SSE 流式响应
- 消息持久化

#### 核心方法

**chat()** - 对话入口 (第 395-588 行)
```javascript
流程:
  1. 验证权限
  2. 加载助手配置
  3. 加载历史消息 → 转换为 OpenAI 格式
  4. 初始化 E2BAgent
  5. 调用 agent.processMessage()
  6. SSE 流式返回
  7. 保存消息到数据库
```

**历史消息处理** (第 410-463 行)
```javascript
// 加载历史
const messages = await getMessages({ conversationId });

// 转换为 OpenAI 格式
const history = messages.map(msg => ({
  role: msg.isCreatedByUser ? 'user' : 'assistant',
  content: msg.text || msg.content || ''
}));

// 增强日志 (采样前 2 条)
logger.info('[E2B Assistant] History sample:');
messages.slice(0, 2).forEach((msg, i) => {
  logger.info(`  Message ${i + 1}: ${msg.text?.substring(0, 100)}...`);
});

// 检测图片路径（防止混淆）
const imageMatches = historyText.match(/\/images\/[^\s)]+/g) || [];
```

**SSE 响应与 contentParts 初始化** (第 520-560 行) ⭐ 关键修复

**稀疏数组问题修复 (2026-02-09)**:
```javascript
// 旧实现（有风险）
const contentParts = [];  // 空数组
let contentIndex = 1;     // 从 1 开始
// 如果第一个事件是 TOOL_CALL → contentParts[1] 存在，contentParts[0] 为 undefined
// 前端访问 contentParts[0].type 会报错：Cannot read properties of null (reading 'type')

// 新实现（安全）
const contentParts = [
  { type: 'text', text: { value: '\u200B' } }  // 零宽空格占位符
];
let currentTextIndex = 0;  // TEXT part 已存在于 index=0
let contentIndex = 1;      // 后续 index 从 1 开始
```

**SSE 事件流**:
```javascript
// sync 事件（匹配 Azure Assistant 格式）
sendEvent(res, {
  sync: true,
  conversationId: finalConversationId,
  requestMessage: userMessage,
  responseMessage: initialResponseMessage  // 包含零宽空格
});

// 立即发送零宽空格 TEXT 事件（维持 loading 状态）
sendEvent(res, {
  type: ContentTypes.TEXT,
  index: 0,
  [ContentTypes.TEXT]: { value: '\u200B' },
  messageId: responseMessageId,
  conversationId: finalConversationId
});

// 单次 flush（减少闪烁）
if (res.flush) res.flush();

// token 流式输出
onToken = (token) => {
  // 第一个 token 替换零宽空格，后续 token 追加
  if (contentParts[currentTextIndex].text.value === '\u200B') {
    contentParts[currentTextIndex].text.value = token;
  } else {
    contentParts[currentTextIndex].text.value += token;
  }
  
  sendEvent(res, {
    type: 'text',
    index: currentTextIndex,
    text: { value: token }
  });
  if (res.flush) res.flush();
};

// final 事件
res.write(`event: message\ndata: ${JSON.stringify({
  type: 'final',
  conversation,
  requestMessage,
  responseMessage
})}\n\n`);
```

---

## 4. 数据流详解

### 4.1 完整请求-响应流程

```
┌────────────────────────────────────────────────────────┐
│ 1. 用户发送消息                                         │
│    POST /api/e2b-assistants/:assistantId/chat          │
│    Body: {                                             │
│      message: "对 titanic.csv 进行分析",               │
│      conversationId: "xxx"                             │
│    }                                                   │
└────────────────────┬───────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────┐
│ 2. Controller.chat()                                   │
│    - getMessages(conversationId)                       │
│    - 转换为: [{ role: 'user', content: '...' }, ...]  │
└────────────────────┬───────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────┐
│ 3. new E2BDataAnalystAgent({...})                      │
│    - 初始化 Context Manager                            │
│    - 加载工具定义                                      │
└────────────────────┬───────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────┐
│ 4. Agent.processMessage()                              │
│    Layer 1 沙箱恢复:                                   │
│    - contextManager.getUploadedFiles()                 │
│    - 从数据库查询 file_ids                             │
│    - fileHandler.syncFilesToSandbox()                  │
│    - contextManager.updateUploadedFiles()              │
└────────────────────┬───────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────┐
│ 5. Agent._runAgent() - ReAct 循环                      │
│    Iteration 1:                                        │
│    ┌──────────────────────────────────────────┐       │
│    │ a. 构建 messages                         │       │
│    │    [system, ...history, user]            │       │
│    │                                          │       │
│    │ b. LLM 调用                              │       │
│    │    openai.chat.completions.create({      │       │
│    │      messages,                           │       │
│    │      tools: [execute_code, list_files,   │       │
│    │              upload_file, export_file,   │       │
│    │              complete_task],              │       │
│    │      stream: true                        │       │
│    │    })                                    │       │
│    │                                          │       │
│    │ c. LLM 响应: tool_use                    │       │
│    │    { name: 'execute_code',               │       │
│    │      input: { code: '...' } }            │       │
│    └──────────────────────────────────────────┘       │
└────────────────────┬───────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────┐
│ 6. Agent._executeTools()                               │
│    → tools.execute_code({ code })                      │
│      ├─> 检测沙箱超时 (Layer 2 恢复)                   │
│      ├─> codeExecutor.execute(code)                    │
│      │   └─> E2B: sandbox.run_python(code)            │
│      ├─> 提取图片                                      │
│      ├─> fileHandler.persistArtifacts()                │
│      │   └─> 保存到 Local/S3/Azure                    │
│      ├─> contextManager.addGeneratedArtifact()         │
│      └─> 返回 observation:                             │
│          { success: true,                              │
│            image_paths: ["/images/.../plot-0.png"],   │
│            images_markdown: "![Plot 0](...)..." }      │
└────────────────────┬───────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────┐
│ 7. Agent._runAgent() - Iteration 2                     │
│    - 将 tool result 添加到 messages                    │
│    - 再次调用 LLM                                      │
│    - LLM 响应: text + stop                            │
│      "分析结果: ![Age](...)..."                        │
│    - stop_reason === 'end_turn' → 循环结束            │
└────────────────────┬───────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────┐
│ 8. Controller: SSE 流式返回                            │
│    - 'sync' 事件 (request/response 同步)               │
│    - 'text/content' 事件 (逐 token)                    │
│    - 'on_context_metrics' 事件 (压缩指标)              │
│    - 'final' 事件 (完整响应)                           │
└────────────────────┬───────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────┐
│ 9. Controller: 保存消息到数据库                        │
│    - saveMessage(requestMessage)                       │
│    - saveMessage(responseMessage)                      │
└────────────────────────────────────────────────────────┘
```

### 4.2 双层沙箱恢复详解

```
场景: 用户刷新页面，沙箱已过期
├─> Layer 1: 初始化时恢复 (index.js processMessage)
│   │
│   ├─> 1. 检查 Context Manager
│   │      existingFiles = contextManager.getUploadedFiles()
│   │      → [{ filename: 'titanic.csv', file_id: 'xxx' }]
│   │
│   ├─> 2. 检查沙箱状态
│   │      sandbox = await getSandbox(userId, convId)
│   │      → null (已过期)
│   │
│   ├─> 3. 触发恢复
│   │      // 从数据库查询第一条包含文件的消息
│   │      const firstMessage = await Message.findOne({
│   │        conversationId,
│   │        files: { $exists: true, $ne: [] }
│   │      });
│   │      
│   │      // 提取 file_ids
│   │      const fileIds = firstMessage.files.map(f => f.file_id);
│   │      
│   │      // 实际上传到新沙箱
│   │      const restoredFiles = await fileHandler
│   │        .syncFilesToSandbox({ userId, conversationId, fileIds, sandbox });
│   │      
│   │      // 更新 Context Manager
│   │      contextManager.updateUploadedFiles(restoredFiles);
│   │
│   └─> 结果: 文件恢复完成，用户无感知
│
└─> Layer 2: 执行时恢复 (tools.js execute_code)
    │
    ├─> 1. 尝试执行代码
    │      try {
    │        result = await codeExecutor.execute(code);
    │      } catch (error) {
    │
    ├─> 2. 检测沙箱超时
    │        if (error.message.includes('timeout') || 
    │            error.message.includes('502')) {
    │
    ├─> 3. 重建沙箱
    │          sandbox = await e2bClientManager
    │            .createSandbox(userId, conversationId);
    │
    ├─> 4. 恢复文件
    │          const existingFiles = agent.contextManager
    │            .getUploadedFiles();
    │          const fileIds = existingFiles.map(f => f.file_id);
    │          await fileHandler.syncFilesToSandbox({...});
    │
    ├─> 5. 重新执行代码
    │          result = await codeExecutor.execute(code);
    │        }
    │      }
    │
    └─> 结果: 自动恢复并重试，用户无感知
```

**关键点**:
- Layer 1: 主动检测和恢复（初始化时）
- Layer 2: 被动触发恢复（执行失败时）
- 双保险: 确保会话连续性
- 实际上传: 不仅更新状态，真正调用 E2B API

---

## 5. 与 Azure Assistant 对比

### 5.1 架构对比

| 维度 | E2B Agent | Azure OpenAI Assistant |
|------|-----------|----------------------|
| **控制力** | 完全控制（ReAct 循环、工具、prompt） | 受限于 Azure API |
| **透明度** | 完全透明（日志、中间状态） | 黑盒 |
| **自定义工具** | 任意添加 | 仅预定义工具 |
| **LLM** | 可切换（Claude, GPT-4, etc.） | 仅 GPT-4 |
| **沙箱** | 自定义环境（任意 Python 库） | 固定环境 |
| **调试** | 完整日志追踪 | 困难 |
| **成本** | 精确控制 LLM 调用 | 按 token 计费 |
| **供应商锁定** | 低 | 高 |

### 5.2 E2B Agent 的优势

✅ **更强可控性**
- 完全控制 ReAct 循环逻辑
- 自定义工具（数据库查询、API 调用等）
- System prompt 完全自定义

✅ **更好调试体验**
- 完整的日志（LLM、工具、沙箱）
- 可查看每次迭代的中间状态
- 透明的错误处理

✅ **更灵活的沙箱**
- 自定义 Python 环境
- 控制资源限制和超时
- 支持多种运行时

✅ **更低供应商锁定**
- 随时切换 LLM provider
- 随时切换沙箱服务
- 不依赖单一云服务商

### 5.3 适用场景

**E2B Agent 更适合**:
- 需要自定义工具和数据源
- 需要特定 Python 环境
- 需要深度调试
- 大规模部署（成本敏感）
- 避免供应商锁定

**Azure Assistant 更适合**:
- 快速原型开发
- 不需要自定义功能
- 企业级合规要求
- 团队缺乏 DevOps 资源

---

## 6. 总结

### 6.1 系统特点

✅ **完全可控**: 工具、prompt、执行流程完全自定义  
✅ **高度透明**: 完整的日志和调试能力  
✅ **灵活扩展**: 轻松添加新工具和能力（如 complete_task）  
✅ **成本优化**: 精确控制 LLM 调用和资源使用  
✅ **供应商独立**: 可随时切换 LLM 或沙箱服务  
✅ **智能终止**: LLM 主动决定任务何时完成（complete_task 机制）  
✅ **防御性编程**: 稀疏数组防护、错误自愈、双层沙箱恢复  

### 6.2 核心模块总览

```
Controller (1029 行) ⭐ 已优化
  ├─> E2BAgent (902 行) ⭐ 已优化
  │    ├─> Context Manager (368 行)
  │    ├─> System Prompts (280 行)
  │    └─> Tools (476 行) ⭐ 含 execute/list/upload/export/complete
  │         ├─> Code Executor (206 行)
  │         └─> File Handler (172 行)
  └─> E2B Sandbox Manager (919 行)
```

### 6.3 数据流总结

```
用户消息 → Controller → Agent → Context Manager
                               ↓
                          LLM (OpenAI)
                               ↓
                       Tool Calls (execute_code)
                               ↓
                    E2B Sandbox (Python)
                               ↓
                      图片持久化 + 数据库
                               ↓
                          最终响应
```

### 6.4 2026-03 收口更新

✅ **上下文压缩链路闭环（2026-03-20）**
- 后端压缩判定收紧：仅 `outputTokens < rawTokens` 记为压缩成功。
- 运行时摘要注入顺序确认：`system -> summary/history -> user`。
- 前端压缩卡片在流式与完成态保持稳定。

✅ **流式显示稳定性收口（2026-03-24）**
- 助手名稳定：SSE 非空优先合并 + 渲染层 `messageId` 缓存，解决“出现后消失”。
- Loading Dot 稳定：统一到单一路径 `result-streaming`，消除双 dot 重叠、闪断和形状切换。
- 运行态一致：完成容器重建并核验修复代码已进入镜像。

---

## 附录：完整文件清单

### A.1 新增文件列表 (33个)

#### 后端服务层 (13个)
```
api/models/E2BAssistant.js                                       89 行
api/server/services/Agents/e2bAgent/index.js                    902 行
api/server/services/Agents/e2bAgent/contextManager.js           368 行
api/server/services/Agents/e2bAgent/prompts.js                  280 行
api/server/services/Agents/e2bAgent/tools.js                    476 行
api/server/services/Endpoints/e2bAssistants/index.js             64 行
api/server/services/Endpoints/e2bAssistants/initialize.js       919 行
api/server/services/Endpoints/e2bAssistants/buildOptions.js     107 行
api/server/services/Sandbox/codeExecutor.js                     206 行
api/server/services/Sandbox/fileHandler.js                      172 行
api/server/routes/e2bAssistants/index.js                         32 行
api/server/routes/e2bAssistants/controller.js                  1029 行
```

#### 前端组件 (修改现有文件 + 新增类型)
```
client/src/components/Chat/Messages/Content/Parts/ExecuteCode.tsx  ~200 行 (修改)
client/src/components/Chat/Messages/Content/Part.tsx               ~150 行 (修改)
packages/data-provider/src/types/agents.ts                          +10 行 (新增字段)
packages/data-provider/src/types/assistants.ts                      +10 行 (新增字段)
```

#### TypeScript Schema (3个)
```
packages/data-schemas/src/schema/e2bAssistant.ts                 45 行
packages/data-schemas/src/models/e2bAssistant.ts                 23 行
packages/data-schemas/src/types/e2bAssistant.ts                  18 行
```

#### 测试文件 (5个)
```
api/tests/e2b/codeExecutor.test.js                              218 行
api/tests/e2b/fileHandler.test.js                               173 行
api/tests/e2b/real_integration.js                               147 行
api/tests/e2b/manual_integration.js                             181 行
api/tests/e2b/debug_sandbox.js                                   89 行
```

#### E2B 自定义模板 (5个)
```
e2b_template/data-analyst/template.ts                            14 行
e2b_template/data-analyst/build.dev.ts                           13 行
e2b_template/data-analyst/build.prod.ts                          10 行
e2b_template/data-analyst/package.json                            6 行
e2b_template/data-analyst/README.md                              42 行
```

#### 项目文档 (7个)
```
docs/E2B_DATA_ANALYST_AGENT_DEVELOPMENT.md                     1354 行
docs/E2B_AGENT_ARCHITECTURE.md                                  862 行 (本文档)
docs/E2B_AGENT_FIXES.md                                         783 行
docs/E2B_AGENT_TEST_CASES.md                                    456 行
docs/E2B_AGENT_ADVANCED_TEST_CASES.md                           389 行
docs/WORK_LOG.md                                               1062 行
docs/TODO.md                                                    156 行
CONTEXT_MANAGER_DESIGN.md                                       234 行
```

### A.2 Git 统计摘要
```bash
# 提交统计
$ git log --oneline upstream/main..HEAD | wc -l
83

# 变更统计
$ git diff --stat upstream/main..HEAD
139 files changed, 17842 insertions(+), 204 deletions(-)

# 新增文件
$ git diff --name-status upstream/main..HEAD | grep "^A" | wc -l
49
```

---

**文档版本**: v2.5  
**最后更新**: 2026-03-28  
**维护者**: Li Ruisen  
**最新变更**: 
- 按代码实况校正核心模块行数与 Git 统计
- 更新 LLM 调用路径说明（OpenAI/Azure OpenAI Chat Completions）
- 更新工具集合（execute/list/upload/export/complete）与 SSE 事件链路
- 新增 2026-03 上下文压缩闭环收口说明
- 新增 2026-03 流式显示稳定性收口（助手名 + Loading Dot）
- 补充运行态一致性验证（容器重建后代码核验）
**相关文档**: 
- [问题解决文档](./E2B_AGENT_FIXES.md)
- [开发文档](./E2B_DATA_ANALYST_AGENT_DEVELOPMENT.md)
- [测试用例](./E2B_AGENT_TEST_CASES.md)
- [工作日志](./WORK_LOG.md)
