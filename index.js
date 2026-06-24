// -*- coding: utf-8 -*-
// bot.js - 中文版，生产就绪，安全可靠

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

// ========== 配置 ==========
// 从环境变量读取，如果没有则使用默认值（仅测试用）
const TOKEN = process.env.BOT_TOKEN || '你的机器人Token';
const ALLOWED_IDS = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(id => id.length > 0);

// 如果没有设置环境变量，使用默认授权用户（仅测试用）
if (ALLOWED_IDS.length === 0) {
  // 如果你想硬编码测试，可以在这里添加
  // ALLOWED_IDS.push('你的用户ID');
  console.error('❌ 错误：未设置 ALLOWED_CHAT_IDS 环境变量。');
  console.log('请设置：export ALLOWED_CHAT_IDS="123456,789012"');
  process.exit(1);
}

// 是否启用无头模式（true=后台运行，false=显示浏览器）
const HEADLESS = process.env.HEADLESS === 'true';

const DATA_FILE = path.join(__dirname, 'data.json');
const SUCCESS_FILE = path.join(__dirname, 'success.txt');
const TEMP_SUFFIX = '.tmp';

// ========== 全局状态 ==========
let isTaskRunning = false;        // 任务是否正在运行
let currentTaskId = 0;            // 当前任务ID
let taskIdCounter = 0;            // 任务ID计数器
let abortController = null;       // 取消控制器
let currentBrowser = null;        // 当前浏览器实例
let currentTry = 0;               // 当前尝试次数
const pendingReplies = new Map(); // 等待回复映射表

const bot = new TelegramBot(TOKEN, { polling: true });

// ========== 工具函数 ==========
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 原子写入文件（先写临时文件再重命名，防止损坏）
function atomicWriteFile(filePath, data) {
  const tempPath = filePath + TEMP_SUFFIX;
  fs.writeFileSync(tempPath, data, 'utf8');
  fs.renameSync(tempPath, filePath);
}

// 身份证号脱敏（显示前6位和后4位）
function maskId(id) {
  if (!id || id.length < 10) return '****';
  return id.substring(0, 6) + '********' + id.substring(id.length - 4);
}

// 发送消息给指定用户
async function sendToChat(chatId, content, options = {}) {
  try {
    await bot.sendMessage(chatId, content, options);
    console.log(`[消息] 发送给 ${chatId}: ${content.substring(0, 50)}`);
  } catch (e) {
    console.log(`发送失败 ${chatId}: ${e.message}`);
  }
}

// 发送图片给指定用户
async function sendPhotoToChat(chatId, filePath, options = {}) {
  try {
    if (fs.existsSync(filePath)) {
      await bot.sendPhoto(chatId, fs.createReadStream(filePath), options);
      console.log(`[图片] 发送给 ${chatId}`);
    } else {
      await sendToChat(chatId, '❌ 图片文件不存在');
    }
  } catch (e) {
    console.log(`图片发送失败 ${chatId}: ${e.message}`);
  }
}

// 广播消息给所有授权用户
async function broadcastMessage(content, options = {}) {
  for (const id of ALLOWED_IDS) {
    await sendToChat(id, content, options);
  }
}

// 广播图片给所有授权用户
async function broadcastPhoto(filePath, options = {}) {
  for (const id of ALLOWED_IDS) {
    await sendPhotoToChat(id, filePath, options);
  }
}

// 等待用户回复（支持取消信号）
function waitTelegramReply(chatId, abortSignal, timeoutSeconds = 120) {
  return new Promise((resolve) => {
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      pendingReplies.delete(chatId);
      resolve(null);
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });

    timer = setTimeout(() => {
      abortSignal.removeEventListener('abort', onAbort);
      pendingReplies.delete(chatId);
      sendToChat(chatId, '⏰ 回复超时，任务将退出。');
      resolve(null);
    }, timeoutSeconds * 1000);

    const wrappedResolve = (value) => {
      if (timer) clearTimeout(timer);
      abortSignal.removeEventListener('abort', onAbort);
      pendingReplies.delete(chatId);
      resolve(value);
    };
    pendingReplies.set(chatId, wrappedResolve);
  });
}

// ========== 页面操作函数 ==========
// 检查是否已实名（页面包含"已满18周岁"）
async function isAlreadyVerified(page) {
  const bodyText = await page.textContent('body').catch(() => '');
  if (bodyText.includes('已满18周岁')) return true;
  for (const f of page.frames()) {
    try {
      const text = await f.textContent('body').catch(() => '');
      if (text.includes('已满18周岁')) return true;
    } catch (e) {}
  }
  return false;
}

// 处理已实名情况
async function handleAlreadyVerified(page, browser) {
  console.log('⚠️ 账号已实名');
  const screenshotPath = path.join(__dirname, 'already_verified.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await broadcastMessage('⚠️ 账号已实名，无法继续');
  await broadcastPhoto(screenshotPath);
  if (browser && await browser.isConnected()) {
    await browser.close();
    currentBrowser = null;
  }
  return true;
}

// 查找姓名和身份证输入框
async function findInputs(pageOrFrame) {
  const nameSelectors = ['#realname', '#real_name_ipt', 'input[name="realname"]'];
  const idSelectors = ['#idcard', '#card_id_ipt', 'input[name="idcard"]'];
  let nameInput = null, idInput = null;
  for (const sel of nameSelectors) {
    nameInput = await pageOrFrame.$(sel);
    if (nameInput) break;
  }
  for (const sel of idSelectors) {
    idInput = await pageOrFrame.$(sel);
    if (idInput) break;
  }
  return { nameInput, idInput };
}

// 在所有框架中查找输入框
async function findInputsInAllFrames(page) {
  let result = await findInputs(page);
  if (result.nameInput && result.idInput) return result;
  for (const f of page.frames()) {
    const r = await findInputs(f);
    if (r.nameInput && r.idInput) return r;
  }
  return { nameInput: null, idInput: null };
}

// 检查是否存在输入框
async function hasInputs(page) {
  const { nameInput, idInput } = await findInputsInAllFrames(page);
  return !!(nameInput && idInput);
}

// 在所有框架中查找元素
async function findInFrames(page, selector) {
  let el = await page.$(selector);
  if (el) return el;
  for (const f of page.frames()) {
    el = await f.$(selector);
    if (el) return el;
  }
  return null;
}

// 根据文字查找按钮
async function findButtonByText(page, text) {
  const locator = page.locator(`button:has-text("${text}")`);
  const count = await locator.count().catch(() => 0);
  if (count > 0) return locator.first();
  for (const f of page.frames()) {
    const frameLocator = f.locator(`button:has-text("${text}")`);
    const frameCount = await frameLocator.count().catch(() => 0);
    if (frameCount > 0) return frameLocator.first();
  }
  return null;
}

// 处理弹窗
async function handlePopup(page) {
  try {
    let btn = await findButtonByText(page, '确定');
    if (!btn) btn = await findButtonByText(page, '关闭');
    if (btn) {
      await btn.click();
      await delay(500);
      return;
    }
    const popup = await findInFrames(page, '#real_name_pop');
    if (popup) {
      const closeBtn = await popup.$('button, .btn, .confirm, .close');
      if (closeBtn) {
        await closeBtn.click();
        await delay(500);
        return;
      }
    }
    await page.keyboard.press('Escape');
  } catch (e) {
    console.log('弹窗处理错误:', e.message);
  }
}

// 严格的成功检测
async function isVerificationSuccess(page) {
  try {
    // 先检查错误关键词，快速排除
    const errorKeywords = ['系统繁忙', '网络异常', '错误', '重新登录', '失败'];
    let bodyText = await page.textContent('body').catch(() => '');
    for (const kw of errorKeywords) {
      if (bodyText.includes(kw)) return false;
    }
    for (const f of page.frames()) {
      const text = await f.textContent('body').catch(() => '');
      for (const kw of errorKeywords) {
        if (text.includes(kw)) return false;
      }
    }

    // 在特定成功元素中查找
    const successSelectors = ['#result_msg', '.tip-success', '.success-tip', '#success_msg'];
    for (const sel of successSelectors) {
      const el = await findInFrames(page, sel);
      if (el) {
        const text = await el.textContent().catch(() => '');
        if (text.includes('实名认证成功') || text.includes('实名成功') || text.includes('认证通过')) {
          return true;
        }
      }
    }

    // 降级方案：检查整个页面
    const successKeywords = ['实名认证成功', '实名成功', '认证通过'];
    bodyText = await page.textContent('body').catch(() => '');
    for (const kw of successKeywords) {
      if (bodyText.includes(kw)) return true;
    }
    for (const f of page.frames()) {
      const text = await f.textContent('body').catch(() => '');
      for (const kw of successKeywords) {
        if (text.includes(kw)) return true;
      }
    }
    return false;
  } catch (e) {
    console.error('检查成功状态出错:', e.message);
    return false;
  }
}

// ========== 主任务函数 ==========
async function startTask(loginType, chatId, taskId, abortSignal) {
  let browser = null;
  let normalCompletion = true;

  try {
    await sendToChat(chatId, `🤖 任务 ${taskId} 启动中...`);
    
    // 读取资料数据
    let data;
    try {
      data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      await sendToChat(chatId, '❌ 读取 data.json 失败，请检查文件是否存在且格式正确。');
      normalCompletion = false;
      return;
    }
    if (data.length === 0) {
      await sendToChat(chatId, '❌ 没有剩余资料');
      normalCompletion = false;
      return;
    }

    // 启动浏览器
    browser = await chromium.launch({ headless: HEADLESS });
    currentBrowser = browser;
    const context = await browser.newContext();
    const page = await context.newPage();

    // 打开家长监护页面
    await page.goto('https://jiazhang.qq.com/zk/home.html');
    await delay(3000);
    if (abortSignal.aborted) { normalCompletion = false; return; }

    // 选择登录方式
    if (loginType === '2') {
      await page.getByText('QQ登录').click();
    } else {
      await page.getByText('微信登录').click();
    }
    await delay(5000);
    if (abortSignal.aborted) { normalCompletion = false; return; }

    // 定位登录 iframe
    let frame = null;
    for (let i = 0; i < 10; i++) {
      if (loginType === '2') {
        frame = page.frames().find(f => f.url().includes('ptlogin2.qq.com'));
      } else {
        frame = page.frames().find(f => f.url().includes('open.weixin.qq.com'));
      }
      if (frame) break;
      await delay(1000);
      if (abortSignal.aborted) { normalCompletion = false; return; }
    }
    if (!frame) {
      await sendToChat(chatId, '❌ 找不到登录窗口');
      normalCompletion = false;
      return;
    }

    // 获取二维码
    let qrElement = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (loginType === '2') {
        qrElement = await frame.$('.qrImg');
      } else {
        const qrElements = await frame.$$('.js_qrcode_img');
        for (const el of qrElements) {
          const box = await el.boundingBox().catch(() => null);
          if (box && box.width > 100) {
            qrElement = el;
            break;
          }
        }
      }
      if (qrElement) break;
      await delay(1000);
      if (abortSignal.aborted) { normalCompletion = false; return; }
    }
    if (!qrElement) {
      await sendToChat(chatId, '❌ 找不到二维码');
      normalCompletion = false;
      return;
    }

    // 截图并发送二维码
    const qrPath = path.join(__dirname, `qr_${taskId}.png`);
    await qrElement.screenshot({ path: qrPath });
    await sendPhotoToChat(chatId, qrPath, { caption: `📱 任务 ${taskId} - 请扫码登录` });

    // 等待扫码（微信5分钟，QQ110秒）
    const expireTime = (loginType === '2') ? 110 * 1000 : 5 * 60 * 1000;
    const startTime = Date.now();
    let loggedIn = false;

    while (!loggedIn) {
      await delay(2000);
      if (abortSignal.aborted) { normalCompletion = false; return; }
      if (Date.now() - startTime > expireTime) {
        await sendToChat(chatId, `⏰ 二维码已过期（任务 ${taskId}）`);
        normalCompletion = false;
        return;
      }
      if (await isAlreadyVerified(page)) {
        await handleAlreadyVerified(page, browser);
        normalCompletion = false;
        return;
      }
      let loginFrame;
      if (loginType === '2') {
        loginFrame = page.frames().find(f => f.url().includes('ptlogin2.qq.com'));
      } else {
        loginFrame = page.frames().find(f => f.url().includes('open.weixin.qq.com'));
      }
      if (!loginFrame) {
        loggedIn = true;
        break;
      }
    }

    await delay(5000);
    if (abortSignal.aborted) { normalCompletion = false; return; }
    if (await isAlreadyVerified(page)) {
      await handleAlreadyVerified(page, browser);
      normalCompletion = false;
      return;
    }

    // 等待实名表单出现
    console.log(`任务 ${taskId}: 查找实名表单...`);
    let nameInput = null, idInput = null;
    let found = false;
    for (let retry = 0; retry < 20; retry++) {
      const inputs = await findInputsInAllFrames(page);
      nameInput = inputs.nameInput;
      idInput = inputs.idInput;
      if (nameInput && idInput) {
        found = true;
        break;
      }
      await delay(1000);
      if (abortSignal.aborted) { normalCompletion = false; return; }
    }
    if (!nameInput || !idInput) {
      await sendToChat(chatId, '❌ 找不到实名表单，请手动检查页面。');
      normalCompletion = false;
      return;
    }

    await sendToChat(chatId, '✅ 已进入实名页面，开始自动填写...');

    let failCount = 0;
    let totalTry = 0;

    // 主循环：逐个处理资料
    while (data.length > 0) {
      if (abortSignal.aborted) { normalCompletion = false; return; }
      totalTry++;
      currentTry = totalTry;
      const current = data[0];
      const realName = current.name;
      const idCard = current.id;
      console.log(`任务 ${taskId} 第 ${totalTry} 次尝试: ${realName}`);

      try {
        // 重新获取输入框（防止引用失效）
        let curNameInput = null, curIdInput = null;
        for (let retry = 0; retry < 5; retry++) {
          const inputs = await findInputsInAllFrames(page);
          curNameInput = inputs.nameInput;
          curIdInput = inputs.idInput;
          if (curNameInput && curIdInput) break;
          await delay(500);
          if (abortSignal.aborted) { normalCompletion = false; return; }
        }
        if (abortSignal.aborted) { normalCompletion = false; return; }
        if (!curNameInput || !curIdInput) throw new Error('输入框丢失');

        // 填写姓名和身份证
        await curNameInput.fill('');
        await curNameInput.fill(realName);
        await curIdInput.fill('');
        await curIdInput.fill(idCard);
        await delay(1500);

        // 勾选协议（精确选择器）
        const agreeCheckbox = await findInFrames(page, '#rule_check');
        if (agreeCheckbox) {
          const isChecked = await agreeCheckbox.isChecked();
          if (!isChecked) await agreeCheckbox.click();
        }
        
        // 点击提交按钮（精确选择器）
        const submitBtn = await findInFrames(page, '#submit_info');
        if (!submitBtn) throw new Error('找不到提交按钮 #submit_info');
        await submitBtn.click();
        await delay(5000);

        // 截图保存结果
        const screenshotPath = path.join(__dirname, `result_${taskId}_${totalTry}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        await sendPhotoToChat(chatId, screenshotPath, { caption: `任务 ${taskId} 执行结果` });

        // 检测是否成功
        const success = await isVerificationSuccess(page);
        if (success) {
          // 成功：脱敏后发送消息
          const masked = maskId(idCard);
          await sendToChat(chatId, `✅ 任务 ${taskId} 实名成功\n${realName} | ${masked}`);
          // 完整数据存入成功记录
          atomicWriteFile(SUCCESS_FILE, fs.readFileSync(SUCCESS_FILE, 'utf8') + `${realName}|${idCard}\n`);
          data.shift();
          atomicWriteFile(DATA_FILE, JSON.stringify(data, null, 2));
          break;
        } else {
          // 失败：等待用户指令
          await sendToChat(chatId, '⚠️ 实名失败（未检测到成功文字）。回复 c(继续) n(下一条) q(退出)');
          const ans = await waitTelegramReply(chatId, abortSignal, 120);
          if (abortSignal.aborted || ans === null) { normalCompletion = false; return; }
          if (ans === 'q') { normalCompletion = false; return; }
          if (ans === 'n') {
            data.shift();
            atomicWriteFile(DATA_FILE, JSON.stringify(data, null, 2));
            failCount++;
          } else if (ans === 'c') {
            await handlePopup(page);
          }
        }

        // 连续失败5次提示
        if (failCount >= 5) {
          await sendToChat(chatId, '连续失败5次。y(继续) / q(退出)');
          const ans = await waitTelegramReply(chatId, abortSignal, 60);
          if (abortSignal.aborted || ans === null) { normalCompletion = false; return; }
          if (ans !== 'y') { normalCompletion = false; return; }
          failCount = 0;
        }
      } catch (err) {
        if (abortSignal.aborted) { normalCompletion = false; return; }
        console.error(`任务 ${taskId} 错误:`, err);
        await sendToChat(chatId, `错误: ${err.message}\n回复 c(继续) n(下一条) q(退出)`);
        const ans = await waitTelegramReply(chatId, abortSignal, 60);
        if (abortSignal.aborted || ans === null) { normalCompletion = false; return; }
        if (ans === 'q') { normalCompletion = false; return; }
        if (ans === 'n') {
          data.shift();
          atomicWriteFile(DATA_FILE, JSON.stringify(data, null, 2));
          failCount++;
        } else if (ans === 'c') {
          await handlePopup(page);
        }
      }
    }

    // 正常完成
    if (!abortSignal.aborted && normalCompletion) {
      await sendToChat(chatId, `✅ 任务 ${taskId} 已完成。`);
    }

  } catch (err) {
    if (!abortSignal.aborted) {
      console.error(`任务 ${taskId} 致命错误:`, err);
      await sendToChat(chatId, `❌ 致命错误: ${err.message}`);
    }
    normalCompletion = false;
  } finally {
    // 关闭浏览器
    if (browser && await browser.isConnected()) {
      try { await browser.close(); } catch (e) {}
      currentBrowser = null;
    }
    // 释放锁
    isTaskRunning = false;
    abortController = null;
    if (currentTaskId === taskId) currentTaskId = 0;
    console.log(`任务 ${taskId} 已终止。`);
  }
}

// ========== 全局错误处理 ==========
process.on('uncaughtException', async (error) => {
  console.error('❌ 未捕获的异常:', error);
  await broadcastMessage(`⚠️ 致命异常: ${error.message}。机器人将退出。`);
  process.exit(1);
});
process.on('unhandledRejection', async (reason) => {
  console.error('❌ 未处理的拒绝:', reason);
  await broadcastMessage(`⚠️ 未处理的错误: ${reason?.message || reason}。机器人将退出。`);
  process.exit(1);
});

// ========== Telegram 消息处理 ==========
bot.on('message', async (msg) => {
  if (!msg.text) return;
  const text = msg.text;
  const chatId = msg.chat.id.toString();

  // 权限验证
  if (!ALLOWED_IDS.includes(chatId)) {
    console.log(`未授权访问: ${chatId}`);
    return;
  }

  // 处理等待回复（仅当不是命令时）
  if (!text.startsWith('/')) {
    if (pendingReplies.has(chatId)) {
      const resolve = pendingReplies.get(chatId);
      pendingReplies.delete(chatId);
      resolve(text.toLowerCase());
      return;
    }
  }

  // ---------- 命令处理 ----------
  // 1. 查看资料列表
  if (text === '/list' || text.startsWith('/list ')) {
    try {
      let page = 1;
      const parts = text.split(' ');
      if (parts.length > 1 && /^\d+$/.test(parts[1])) page = parseInt(parts[1]);
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (data.length === 0) { await sendToChat(chatId, '📭 队列为空'); return; }
      const pageSize = 10;
      const totalPages = Math.ceil(data.length / pageSize);
      if (page > totalPages) page = totalPages;
      const start = (page - 1) * pageSize;
      const end = Math.min(start + pageSize, data.length);
      let message = `📋 资料列表 (第 ${page}/${totalPages} 页，共 ${data.length} 条)\n━━━━━━━━━━━━━━━\n`;
      for (let i = start; i < end; i++) {
        const item = data[i];
        const maskedId = maskId(item.id);
        message += `【${i+1}】${item.name} | ${maskedId}\n`;
      }
      message += `━━━━━━━━━━━━━━━\n💡 使用 /del 序号 删除，如 /del 5`;
      await sendToChat(chatId, message);
    } catch (e) {
      await sendToChat(chatId, `❌ 读取资料失败: ${e.message}`);
    }
    return;
  }

  // 2. 删除指定资料
  if (text.startsWith('/del ')) {
    if (isTaskRunning) {
      await sendToChat(chatId, '⚠️ 任务正在运行，请先 /cancel 再删除。');
      return;
    }
    try {
      const parts = text.split(' ');
      if (parts.length < 2 || !/^\d+$/.test(parts[1])) {
        await sendToChat(chatId, '⚠️ 请输入有效数字，例如 /del 5');
        return;
      }
      const index = parseInt(parts[1]) - 1;
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (index < 0 || index >= data.length) {
        await sendToChat(chatId, `❌ 序号无效，共有 ${data.length} 条资料。`);
        return;
      }
      const deleted = data[index];
      data.splice(index, 1);
      atomicWriteFile(DATA_FILE, JSON.stringify(data, null, 2));
      const maskedId = maskId(deleted.id);
      await sendToChat(chatId, `✅ 已删除: ${deleted.name} | ${maskedId}\n剩余: ${data.length} 条`);
    } catch (e) {
      await sendToChat(chatId, `❌ 删除失败: ${e.message}`);
    }
    return;
  }

  // 3. 启动任务
  if (text === '/starttask') {
    if (isTaskRunning) {
      await sendToChat(chatId, `⚠️ 任务 (ID ${currentTaskId}) 正在运行，请先 /cancel。`);
      return;
    }

    // 重置尝试计数
    currentTry = 0;

    // 生成新任务ID
    const taskId = ++taskIdCounter;
    currentTaskId = taskId;
    const newAbortController = new AbortController();
    abortController = newAbortController;
    isTaskRunning = true;

    await sendToChat(chatId, `启动任务 ${taskId}\n/cancel 停止\n/status 状态\n/queue 剩余\n/list 列表\n/del 删除\n\n任务中: c=继续, n=下一条, q=退出`);
    await sendToChat(chatId, '请选择登录方式:\n1 = 微信\n2 = QQ');

    let loginType = null;
    while (loginType === null) {
      const reply = await waitTelegramReply(chatId, newAbortController.signal, 60);
      if (newAbortController.signal.aborted || reply === null) {
        isTaskRunning = false;
        abortController = null;
        currentTaskId = 0;
        return;
      }
      if (reply === '1' || reply === '2') {
        loginType = reply;
      } else {
        await sendToChat(chatId, '输入无效，请输入 1(微信) 或 2(QQ)：');
      }
    }

    // 启动任务
    await startTask(loginType, chatId, taskId, newAbortController.signal);
    if (isTaskRunning) {
      isTaskRunning = false;
      abortController = null;
      currentTaskId = 0;
    }
    return;
  }

  // 4. 取消任务
  if (text === '/cancel') {
    if (!isTaskRunning || !abortController) {
      await sendToChat(chatId, '没有正在运行的任务。');
      return;
    }
    // 发送取消信号
    abortController.abort();
    // 关闭浏览器（忽略错误）
    if (currentBrowser) {
      try {
        if (await currentBrowser.isConnected()) {
          await currentBrowser.close();
        }
      } catch (e) { /* 忽略 */ }
      currentBrowser = null;
    }
    // 清理等待回复
    for (const [cid, resolve] of pendingReplies) {
      pendingReplies.delete(cid);
      resolve(null);
    }
    await sendToChat(chatId, `✅ 已发送取消信号给任务 ${currentTaskId}`);
    return;
  }

  // 5. 查看状态
  if (text === '/status') {
    if (isTaskRunning) {
      await sendToChat(chatId, `状态: 运行中 (任务 ${currentTaskId})`);
    } else {
      await sendToChat(chatId, '状态: 空闲');
    }
    await sendToChat(chatId, `尝试次数: ${currentTry}`);
    return;
  }

  // 6. 查看队列数量
  if (text === '/queue') {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      await sendToChat(chatId, `剩余资料: ${data.length}`);
    } catch (e) {
      await sendToChat(chatId, '读取队列失败');
    }
    return;
  }
});

console.log('🤖 机器人已启动。单任务模式，安全可靠。');
console.log(`无头模式: ${HEADLESS}`);
console.log(`授权用户: ${ALLOWED_IDS.join(', ')}`);
console.log('\n可用命令：');
console.log('  /starttask - 启动实名任务');
console.log('  /cancel   - 取消当前任务');
console.log('  /status   - 查看任务状态');
console.log('  /queue    - 查看剩余资料数量');
console.log('  /list     - 查看资料列表（脱敏）');
console.log('  /del 序号 - 删除指定资料');
console.log('  任务中: c=继续, n=下一条, q=退出');
