// Node.js polyfills for browser APIs
import XMLHttpRequest from 'xmlhttprequest';
import fetch, { Headers, Request, Response } from 'node-fetch';

// Make XMLHttpRequest available globally
global.XMLHttpRequest = XMLHttpRequest.XMLHttpRequest;
// Make fetch available globally with proper polyfill
if (!global.fetch) {
  global.fetch = fetch;
  global.Headers = Headers;
  global.Request = Request;
  global.Response = Response;
}

import express from "express";
import Gun from "gun";
import qr from "qrcode-terminal";
import ip from "ip";
import 'dotenv/config'
import setSelfAdjustingInterval from 'self-adjusting-interval';
import cors from "cors";
import { Ollama } from "ollama";
import { networkInterfaces } from "os";
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/* global process */

const testPort = (port) => {
  return new Promise((resolve, reject) => {
    const server = express().listen(port, () => {
      server.close(() => resolve(true));
    }).on('error', () => resolve(false));
  });
};

// 获取局域网 IP 地址
function getLocalIPAddress() {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // 筛选 IPv4 地址，排除回环地址 (127.0.0.1)
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "0.0.0.0"; 
}

// 测试 Ollama 连接的辅助函数
async function testOllamaConnection(host) {
  try {
    console.log(`🔍 测试连接到: ${host}`);
    
    // 使用原生 fetch 进行简单的连通性测试
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
    
    const response = await fetch(`${host}/api/version`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
      }
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      const version = await response.json();
      console.log(`✅ 连接成功，Ollama 版本: ${version.version || 'unknown'}`);
      return true;
    } else {
      console.log(`❌ HTTP错误: ${response.status} ${response.statusText}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ 连接失败: ${error.message}`);
    return false;
  }
}

// 测试多个可能的 Ollama 地址
async function findWorkingOllamaHost() {
  const localIP = getLocalIPAddress();
  const possibleHosts = [
    process.env.OLLAMA_HOST,
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    `http://${localIP}:11434`,
    "http://0.0.0.0:11434",
    "https://lzcollama.ponzs.heiyu.space",
    "http://baota.ponzs.heiyu.space:11434",
    "https://a.talkflow.team",
    // Docker 内部地址
    "http://host.docker.internal:11434",
    "http://172.17.0.1:11434",
    "http://172.18.0.1:11434",
    // 其他常见内网地址
    "http://192.168.1.1:11434",
    "http://10.0.0.1:11434"
  ].filter(Boolean); // 过滤掉 undefined

  console.log('🔍 尝试连接以下 Ollama 地址:');
  possibleHosts.forEach((host, index) => {
    console.log(`  ${index + 1}. ${host}`);
  });

  for (const host of possibleHosts) {
    const isConnected = await testOllamaConnection(host);
    if (isConnected) {
      console.log(`🎯 找到可用的 Ollama 服务: ${host}`);
      return host;
    }
  }
  
  console.log('❌ 所有 HTTP 地址都不可用');
  return null;
}

// 测试 Ollama CLI 可用性
async function testOllamaCLI() {
  try {
    console.log('🔍 测试 Ollama CLI 可用性...');
    const { stdout } = await execAsync('ollama --version', { timeout: 5000 });
    console.log(`✅ CLI 可用: ${stdout.trim()}`);
    return true;
  } catch (error) {
    console.log(`❌ CLI 不可用: ${error.message}`);
    return false;
  }
}

// 通过 CLI 获取模型列表
async function getModelsViaCLI() {
  try {
    const { stdout } = await execAsync('ollama list', { timeout: 10000 });
    const lines = stdout.trim().split('\n').slice(1); // 跳过标题行
    const models = lines
      .filter(line => line.trim()) // 过滤空行
      .map(line => {
        const parts = line.split(/\s+/);
        return {
          name: parts[0],
          modified_at: parts[1] || '',
          size: parts[2] || '',
          digest: parts[3] || ''
        };
      });
    return { models };
  } catch (error) {
    throw new Error(`CLI List Error: ${error.message}`);
  }
}

// 通过 CLI 进行聊天对话
async function chatViaCLI(model, messages) {
  try {
    // 构建提示 - 使用最后一个用户消息
    const lastMessage = messages[messages.length - 1];
    const prompt = lastMessage.content.replace(/"/g, '\\"').replace(/\$/g, '\\$');
    
    // 使用 ollama run 命令
    const { stdout } = await execAsync(`echo "${prompt}" | ollama run ${model}`, { 
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      shell: '/bin/bash'
    });
    
    return {
      message: {
        role: 'assistant',
        content: stdout.trim()
      },
      done: true
    };
  } catch (error) {
    throw new Error(`CLI Chat Error: ${error.message}`);
  }
}

// 通过 CLI 生成文本
async function generateViaCLI(model, prompt) {
  try {
    const cleanPrompt = prompt.replace(/"/g, '\\"').replace(/\$/g, '\\$');
    
    const { stdout } = await execAsync(`echo "${cleanPrompt}" | ollama run ${model}`, { 
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      shell: '/bin/bash'
    });
    
    return {
      response: stdout.trim(),
      done: true
    };
  } catch (error) {
    throw new Error(`CLI Generate Error: ${error.message}`);
  }
}

export default {
  initiated: false,
  async init(config = {}) {
    if (this.initiated) return;
    this.initiated = true;

    let {
      host = process.env.RELAY_HOST || ip.address(),
      store = process.env.RELAY_STORE || false,
      port = process.env.RELAY_PORT || 8765,
      path = process.env.RELAY_PATH || "public",
      showQr = process.env.RELAY_QR || false,
      // Ollama配置
      ollamaHost = process.env.OLLAMA_HOST || "http://localhost:11434"
    } = config;

    console.clear();
    console.log('=== GUN-VUE RELAY SERVER WITH OLLAMA API ===\n');

    var app = express();

    // 启用CORS和JSON解析 - 为Ollama API添加
    app.use(cors()); 
    app.use(express.json()); 

    // 错误处理中间件
    app.use((err, req, res, next) => {
      console.error('Server Error:', err.stack);
      res.status(500).json({ error: "Internal Server Error", details: err.message });
    });

    // 寻找可用的 Ollama 服务
    console.log('\n🚀 开始智能搜索 Ollama 服务...\n');
    const workingHost = await findWorkingOllamaHost();
    
    let ollama = null;
    let useCLI = false;
    let activeOllamaHost = workingHost || ollamaHost;

    if (workingHost) {
      console.log(`\n✅ 找到可用的 HTTP 服务: ${workingHost}`);
      
      // 尝试初始化 Ollama SDK
      try {
        ollama = new Ollama({ 
          host: workingHost,
          fetch: global.fetch,
          timeout: 30000
        });
        
        const models = await ollama.list();
        console.log(`✅ Ollama SDK 连接成功，可用模型数量: ${models.models?.length || 0}`);
        if (models.models && models.models.length > 0) {
          console.log(`📋 可用模型: ${models.models.map(m => m.name).join(', ')}`);
        }
        activeOllamaHost = workingHost;
      } catch (error) {
        console.error('❌ Ollama SDK 连接失败:', error.message);
        console.log('🔄 将尝试 CLI 模式...');
        ollama = null;
      }
    }

    // 如果 HTTP API 不可用，尝试 CLI 模式
    if (!ollama) {
      console.log('\n🔧 尝试 CLI 备用模式...');
      const cliWorks = await testOllamaCLI();
      
      if (cliWorks) {
        try {
          const testModels = await getModelsViaCLI();
          console.log(`✅ CLI 模式工作正常，模型数量: ${testModels.models?.length || 0}`);
          if (testModels.models && testModels.models.length > 0) {
            console.log(`📋 CLI 可用模型: ${testModels.models.map(m => m.name).join(', ')}`);
          }
          useCLI = true;
        } catch (error) {
          console.error('❌ CLI 模式失败:', error.message);
        }
      }
    }

    if (!ollama && !useCLI) {
      console.log('\n❌ 警告: 所有 Ollama 连接方式都不可用');
      console.log('   - HTTP API: 无法连接');
      console.log('   - CLI 模式: 不可用');
      console.log('   - 服务将启动，但 Ollama 功能将不可用');
    }

    // === OLLAMA API 路由 ===
    
    // 检查 Ollama 连接的中间件
    const checkOllamaConnection = (req, res, next) => {
      if (!ollama && !useCLI) {
        return res.status(503).json({ 
          error: "Ollama 服务不可用",
          details: "HTTP API 和 CLI 模式都不可用",
          hint: "请检查 Ollama 是否正确安装和运行",
          attempted_hosts: [
            "HTTP API: 已尝试多个地址",
            "CLI 模式: 已尝试 ollama 命令"
          ]
        });
      }
      next();
    };
    
    // 获取可用模型列表
    app.get("/api/models", checkOllamaConnection, async (req, res) => {
      try {
        let result;
        if (ollama) {
          console.log('🔄 使用 HTTP API 获取模型列表');
          const response = await ollama.list();
          result = response.models;
        } else if (useCLI) {
          console.log('🔄 使用 CLI 模式获取模型列表');
          const response = await getModelsViaCLI();
          result = response.models;
        }
        res.json(result);
      } catch (error) {
        console.error('Models API Error:', error);
        res.status(500).json({ 
          error: error.message,
          hint: "请检查 Ollama 服务是否正常运行",
          mode: ollama ? 'HTTP API' : (useCLI ? 'CLI' : 'none')
        });
      }
    });

    // 生成文本（chat completions）
    app.post("/api/chat", checkOllamaConnection, async (req, res) => {
      const { model, messages, stream = false, options = {} } = req.body;
      try {
        if (ollama) {
          console.log(`🔄 使用 HTTP API 进行对话 (模型: ${model})`);
          if (stream) {
            // 流式响应
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");

            const response = await ollama.chat({
              model,
              messages,
              stream: true,
              options,
            });

            for await (const part of response) {
              res.write(`data: ${JSON.stringify(part)}\n\n`);
            }
            res.end();
          } else {
            // 非流式响应
            const response = await ollama.chat({
              model,
              messages,
              options,
            });
            res.json(response);
          }
        } else if (useCLI) {
          console.log(`🔄 使用 CLI 模式进行对话 (模型: ${model})`);
          if (stream) {
            return res.status(400).json({
              error: "CLI 模式不支持流式响应",
              hint: "请使用非流式模式 (stream: false)"
            });
          }
          const response = await chatViaCLI(model, messages);
          res.json(response);
        }
      } catch (error) {
        console.error('Chat API Error:', error);
        res.status(500).json({ 
          error: error.message,
          model: model,
          mode: ollama ? 'HTTP API' : (useCLI ? 'CLI' : 'none'),
          hint: "请检查模型名称是否正确，以及 Ollama 服务状态"
        });
      }
    });

    // 生成文本（generate completions）
    app.post("/api/generate", checkOllamaConnection, async (req, res) => {
      const { model, prompt, stream = false, options = {} } = req.body;
      try {
        if (ollama) {
          console.log(`🔄 使用 HTTP API 生成文本 (模型: ${model})`);
          if (stream) {
            // 流式响应
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");

            const response = await ollama.generate({
              model,
              prompt,
              stream: true,
              options,
            });

            for await (const part of response) {
              res.write(`data: ${JSON.stringify(part)}\n\n`);
            }
            res.end();
          } else {
            // 非流式响应
            const response = await ollama.generate({
              model,
              prompt,
              options,
            });
            res.json(response);
          }
        } else if (useCLI) {
          console.log(`🔄 使用 CLI 模式生成文本 (模型: ${model})`);
          if (stream) {
            return res.status(400).json({
              error: "CLI 模式不支持流式响应",
              hint: "请使用非流式模式 (stream: false)"
            });
          }
          const response = await generateViaCLI(model, prompt);
          res.json(response);
        }
      } catch (error) {
        console.error('Generate API Error:', error);
        res.status(500).json({ 
          error: error.message,
          model: model,
          mode: ollama ? 'HTTP API' : (useCLI ? 'CLI' : 'none'),
          hint: "请检查模型名称是否正确，以及 Ollama 服务状态"
        });
      }
    });

    // 创建模型（仅 HTTP API）
    app.post("/api/models/create", checkOllamaConnection, async (req, res) => {
      if (!ollama) {
        return res.status(400).json({
          error: "此功能仅支持 HTTP API 模式",
          hint: "CLI 模式不支持模型创建"
        });
      }
      
      const { name, modelfile, stream = false } = req.body;
      try {
        console.log(`🔄 创建模型: ${name}`);
        const response = await ollama.create({
          model: name,
          modelfile,
          stream,
        });
        if (stream) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          for await (const part of response) {
            res.write(`data: ${JSON.stringify(part)}\n\n`);
          }
          res.end();
        } else {
          res.json(response);
        }
      } catch (error) {
        console.error('Create Model API Error:', error);
        res.status(500).json({ 
          error: error.message,
          mode: 'HTTP API'
        });
      }
    });

    // 删除模型（仅 HTTP API）
    app.delete("/api/models/:name", checkOllamaConnection, async (req, res) => {
      if (!ollama) {
        return res.status(400).json({
          error: "此功能仅支持 HTTP API 模式",
          hint: "CLI 模式不支持模型删除"
        });
      }
      
      const { name } = req.params;
      try {
        console.log(`🔄 删除模型: ${name}`);
        await ollama.delete({ model: name });
        res.json({ message: `Model ${name} deleted successfully` });
      } catch (error) {
        console.error('Delete Model API Error:', error);
        res.status(500).json({ error: error.message, mode: 'HTTP API' });
      }
    });

    // 复制模型（仅 HTTP API）
    app.post("/api/models/copy", checkOllamaConnection, async (req, res) => {
      if (!ollama) {
        return res.status(400).json({
          error: "此功能仅支持 HTTP API 模式",
          hint: "CLI 模式不支持模型复制"
        });
      }
      
      const { source, destination } = req.body;
      try {
        console.log(`🔄 复制模型: ${source} -> ${destination}`);
        await ollama.copy({ source, destination });
        res.json({ message: `Model copied from ${source} to ${destination}` });
      } catch (error) {
        console.error('Copy Model API Error:', error);
        res.status(500).json({ error: error.message, mode: 'HTTP API' });
      }
    });

    // 显示模型信息（仅 HTTP API）
    app.get("/api/models/:name", checkOllamaConnection, async (req, res) => {
      if (!ollama) {
        return res.status(400).json({
          error: "此功能仅支持 HTTP API 模式",
          hint: "CLI 模式不支持模型详情查询"
        });
      }
      
      const { name } = req.params;
      try {
        console.log(`🔄 获取模型信息: ${name}`);
        const response = await ollama.show({ model: name });
        res.json(response);
      } catch (error) {
        console.error('Show Model API Error:', error);
        res.status(500).json({ error: error.message, mode: 'HTTP API' });
      }
    });

    // 拉取模型（仅 HTTP API）
    app.post("/api/models/pull", checkOllamaConnection, async (req, res) => {
      if (!ollama) {
        return res.status(400).json({
          error: "此功能仅支持 HTTP API 模式",
          hint: "CLI 模式不支持模型拉取"
        });
      }
      
      const { name, stream = false } = req.body;
      try {
        console.log(`🔄 拉取模型: ${name}`);
        if (stream) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");

          const response = await ollama.pull({
            model: name,
            stream: true,
          });

          for await (const part of response) {
            res.write(`data: ${JSON.stringify(part)}\n\n`);
          }
          res.end();
        } else {
          const response = await ollama.pull({
            model: name,
          });
          res.json(response);
        }
      } catch (error) {
        console.error('Pull Model API Error:', error);
        res.status(500).json({ error: error.message, mode: 'HTTP API' });
      }
    });

    // 推送模型（仅 HTTP API）
    app.post("/api/models/push", checkOllamaConnection, async (req, res) => {
      if (!ollama) {
        return res.status(400).json({
          error: "此功能仅支持 HTTP API 模式",
          hint: "CLI 模式不支持模型推送"
        });
      }
      
      const { name, stream = false } = req.body;
      try {
        console.log(`🔄 推送模型: ${name}`);
        if (stream) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");

          const response = await ollama.push({
            model: name,
            stream: true,
          });

          for await (const part of response) {
            res.write(`data: ${JSON.stringify(part)}\n\n`);
          }
          res.end();
        } else {
          const response = await ollama.push({
            model: name,
          });
          res.json(response);
        }
      } catch (error) {
        console.error('Push Model API Error:', error);
        res.status(500).json({ error: error.message, mode: 'HTTP API' });
      }
    });

    // 生成嵌入（仅 HTTP API）
    app.post("/api/embeddings", checkOllamaConnection, async (req, res) => {
      if (!ollama) {
        return res.status(400).json({
          error: "此功能仅支持 HTTP API 模式",
          hint: "CLI 模式不支持嵌入生成"
        });
      }
      
      const { model, prompt } = req.body;
      try {
        console.log(`🔄 生成嵌入: ${model}`);
        const response = await ollama.embeddings({
          model,
          prompt,
        });
        res.json(response);
      } catch (error) {
        console.error('Embeddings API Error:', error);
        res.status(500).json({ error: error.message, mode: 'HTTP API' });
      }
    });

    // 获取服务状态
    app.get("/api/status", (req, res) => {
      res.json({
        service: "Gun-Ollama Relay",
        gun_relay: {
          status: "running",
          port: port,
          host: host
        },
        ollama: {
          http_api: {
            available: !!ollama,
            host: ollama ? activeOllamaHost : null
          },
          cli_mode: {
            available: useCLI,
            status: useCLI ? "active" : "unavailable"
          },
          overall_status: ollama ? "HTTP API" : (useCLI ? "CLI Mode" : "Unavailable")
        },
        endpoints: {
          models: "/api/models",
          chat: "/api/chat", 
          generate: "/api/generate",
          status: "/api/status"
        }
      });
    });

    // === Gun Relay 路由 ===
    
    // Explicit root route handling
    app.get('/', (req, res) => {
      res.sendFile('index.html', { root: path });
    });

    app.use(express.static(path));

    let currentPort = parseInt(port);
    while (!(await testPort(currentPort))) {
      console.log(`Port ${currentPort} in use, trying next...`);
      currentPort++;
    }

    var server = app.listen(currentPort);
    port = currentPort; // Update port for later use

    const gun = Gun({
      super: false,
      file: "store",
      radisk: store,
      web: server,
    });

    const link = "http://" + host + (port ? ":" + port : "");
    const extLink = "https://" + host;
    const localIP = getLocalIPAddress();
    let totalConnections = 0;
    let activeWires = 0;

    const db = gun.get('relays').get(host);

    setSelfAdjustingInterval(() => {
      db.get("pulse").put(Date.now());
    }, 500);

    gun.on("hi", () => {
      totalConnections += 1;
      db.get("totalConnections").put(totalConnections);
      activeWires += 1;
      db.get("activeWires").put(activeWires);
      console.log(`Connection opened (active: ${activeWires})`);
    });

    gun.on("bye", () => {
      activeWires -= 1;
      db.get("activeWires").put(activeWires);
      console.log(`Connection closed (active: ${activeWires})`);
    });

    db.get("host").put(host);
    db.get("port").put(port);
    db.get("link").put(link);
    db.get("ext-ink").put(extLink);
    db.get("store").put(store);
    db.get("status").put("running");
    db.get("started").put(Date.now());

    console.log('\n' + '='.repeat(50));
    console.log('🚀 服务启动完成！');
    console.log('='.repeat(50));
    console.log(`Internal URL: ${link}/`);
    console.log(`External URL: ${extLink}/`);
    console.log(`Gun peer: ${link}/gun`);
    console.log(`Ollama API: ${link}/api/`);
    console.log(`LAN Access: http://${localIP}:${port}/`);
    console.log('='.repeat(50));
    console.log('📊 Ollama 连接状态:');
    if (ollama) {
      console.log(`✅ HTTP API 模式: ${activeOllamaHost}`);
    } else if (useCLI) {
      console.log(`✅ CLI 模式: 本地 ollama 命令行`);
    } else {
      console.log(`❌ 未连接: 所有模式都不可用`);
    }
    console.log(`📁 Storage: ${store ? 'enabled' : 'disabled'}`);
    console.log('='.repeat(50));

    if (showQr != false) {
      console.log('\n=== QR CODE ===');
      qr.generate(link, { small: true });
      console.log('===============\n');
    }

    return { app, db };
  },
};