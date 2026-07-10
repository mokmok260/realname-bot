// -*- coding: utf-8 -*-
// bot.js - 带内联键盘，点击即可回复

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

// ========== 配置 ==========
const TOKEN = process.env.BOT_TOKEN || '你的机器人Token';
const ALLOWED_IDS = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(id => id.length > 0);

if (ALLOWED_IDS.length === 0) {
  console.error('❌ 错误：未设置 ALLOWED_CHAT_IDS 环境变量。');
  console.log('请设置：export ALLOWED_CHAT_IDS="123456,789012"');
  process.exit(1);
}

const HEADLESS = process.env.HEADLESS === 'true';

const DATA_FILE = path.join(__dirname, 'data.json');
const SUCCESS_FILE = path.join(__dirname, 'success.txt');
const FAILED_FILE = path.join(__dirname, 'failed.txt');
const REVIEW_FILE = path.join(__dirname, 'pending_review.txt');
const TEMP_SUFFIX = '.tmp';

// ========== 全局状态 ==========
let isTaskRunning = false;
let currentTaskId = 0;
let taskIdCounter = 0;
let abortController = null;
let currentBrowser = null;
let currentTry = 0;
const pendingReplies = new Map(); // chatId -> resolve function
const replyTimeouts = new Map();  // chatId -> timer

const bot = new TelegramBot(TOKEN, { polling: true });

// ========== 工具函数 ==========
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function atomicWriteFile(filePath, data) {
  const tempPath = filePath + TEMP_SUFFIX;
  fs.writeFileSync(tempPath, data, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function maskId(id) {
  return id;
}

async function sendToChat(chatId, content, options = {}) {
  try {
    await bot.sendMessage(chatId, content, options);
    console.log(`[消息] 发送给 ${chatId}: ${content.substring(0, 50)}`);
  } catch (e) {
    console.log(`发送失败 ${chatId}: ${e.message}`);
  }
}

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

async function broadcastMessage(content, options = {}) {
  for (const id of ALLOWED_IDS) {
    await sendToChat(id, content, options);
  }
}

async function broadcastPhoto(filePath, options = {}) {
  for (const id of ALLOWED_IDS) {
    await sendPhotoToChat(id, filePath, options);
  }
}

// ========== 内联键盘创建函数 ==========
function createInlineKeyboard(buttons, columns = 2) {
  const keyboard = [];
  let row = [];
  for (let i = 0; i < buttons.length; i++) {
    row.push(buttons[i]);
    if ((i + 1) % columns === 0 || i === buttons.length - 1) {
      keyboard.push(row);
      row = [];
    }
  }
  return { reply_markup: { inline_keyboard: keyboard } };
}

// 登录方式选择键盘
function loginKeyboard() {
  return createInlineKeyboard([
    { text: '📱 微信', callback_data: 'login_1' },
    { text: '💬 QQ', callback_data: 'login_2' }
  ]);
}

// 通用选择键盘：继续 / 下一条 / 退出
function continueKeyboard() {
  return createInlineKeyboard([
    { text: '🔄 继续 (c)', callback_data: 'choice_c' },
    { text: '⏭️ 下一条 (n)', callback_data: 'choice_n' },
    { text: '🚪 退出 (q)', callback_data: 'choice_q' }
  ]);
}

// 人工审核失败键盘：重试 / 下一条 / 退出
function retryKeyboard() {
  return createInlineKeyboard([
    { text: '🔄 重试 (r)', callback_data: 'choice_r' },
    { text: '⏭️ 下一条 (n)', callback_data: 'choice_n' },
    { text: '🚪 退出 (q)', callback_data: 'choice_q' }
  ]);
}

// 不确定状态键盘：成功 / 失败 / 审核中
function unknownKeyboard() {
  return createInlineKeyboard([
    { text: '✅ 成功 (y)', callback_data: 'choice_y' },
    { text: '❌ 失败 (n)', callback_data: 'choice_n' },
    { text: '⏳ 审核中 (r)', callback_data: 'choice_r' }
  ]);
}

// 连续失败键盘：继续 / 退出
function failKeyboard() {
  return createInlineKeyboard([
    { text: '🔄 继续 (y)', callback_data: 'choice_y' },
    { text: '🚪 退出 (q)', callback_data: 'choice_q' }
  ]);
}

// ========== 等待回复（支持内联键盘和文字输入） ==========
function waitTelegramReply(chatId, abortSignal, timeoutSeconds = 120) {
  return new Promise((resolve) => {
    // 清除旧定时器
    if (replyTimeouts.has(chatId)) {
      clearTimeout(replyTimeouts.get(chatId));
      replyTimeouts.delete(chatId);
    }

    const onAbort = () => {
      if (replyTimeouts.has(chatId)) {
        clearTimeout(replyTimeouts.get(chatId));
        replyTimeouts.delete(chatId);
      }
      pendingReplies.delete(chatId);
      resolve(null);
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      abortSignal.removeEventListener('abort', onAbort);
      pendingReplies.delete(chatId);
      replyTimeouts.delete(chatId);
      sendToChat(chatId, '⏰ 回复超时，任务将退出。');
      resolve(null);
    }, timeoutSeconds * 1000);
    replyTimeouts.set(chatId, timer);

    const wrappedResolve = (value) => {
      if (replyTimeouts.has(chatId)) {
        clearTimeout(replyTimeouts.get(chatId));
        replyTimeouts.delete(chatId);
      }
      abortSignal.removeEventListener('abort', onAbort);
      pendingReplies.delete(chatId);
      resolve(value);
    };
    pendingReplies.set(chatId, wrappedResolve);
  });
}

// ========== 页面操作函数 ==========
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

async function isUnderManualReview(page) {
  const keywords = ['人工实名审核中', '提交人工实名认证', '审核中'];
  let bodyText = await page.textContent('body').catch(() => '');
  for (const kw of keywords) {
    if (bodyText.includes(kw)) {
      console.log(`🔍 检测到审核状态关键词: ${kw}`);
      return true;
    }
  }
  for (const f of page.frames()) {
    const text = await f.textContent('body').catch(() => '');
    for (const kw of keywords) {
      if (text.includes(kw)) {
        console.log(`🔍 在iframe中检测到审核状态关键词: ${kw}`);
        return true;
      }
    }
  }
  return false;
}

async function handleManualReview(page, taskId, realName, idCard, chatId) {
  console.log(`📋 任务 ${taskId}: 进入人工审核状态`);
  const screenshotPath = path.join(__dirname, `manual_review_${taskId}_${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  
  await sendPhotoToChat(chatId, screenshotPath, { 
    caption: `📋 【人工审核中】\n姓名：${realName}\n身份证：${maskId(idCard)}\n\n该资料已提交人工审核，请等待结果。` 
  });
  await broadcastPhoto(screenshotPath);
  await broadcastMessage(`📋 人工审核状态\n姓名：${realName}\n身份证：${maskId(idCard)}\n任务 ${taskId} 已提交人工审核。`);
  
  const oldReview = fs.existsSync(REVIEW_FILE)
    ? fs.readFileSync(REVIEW_FILE, 'utf8')
    : '';
  atomicWriteFile(REVIEW_FILE, oldReview + `${realName}|${idCard}|${new Date().toISOString()}\n`);
  
  return true;
}

async function handleManualFailure(page, taskId, realName, idCard, chatId, reason) {
  console.log(`⚠️ 任务 ${taskId}: 人工审核失败 - ${reason}`);
  const screenshotPath = path.join(__dirname, `manual_failure_${taskId}_${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  
  await sendPhotoToChat(chatId, screenshotPath, { 
    caption: `⚠️ 【人工审核失败】\n姓名：${realName}\n身份证：${maskId(idCard)}\n失败原因：${reason}` 
  });
  await broadcastPhoto(screenshotPath);
  await broadcastMessage(`⚠️ 人工审核失败\n姓名：${realName}\n身份证：${maskId(idCard)}\n原因：${reason}`);
  
  // 发送内联键盘
  await sendToChat(chatId, '请选择操作：', retryKeyboard());
  
  const ans = await waitTelegramReply(chatId, abortController.signal, 120);
  if (abortController?.signal?.aborted || ans === null) {
    return 'abort';
  }
  return ans;
}

async function handleFailure(page, taskId, realName, idCard, chatId, reason) {
  console.log(`❌ 任务 ${taskId}: 实名失败 - ${reason}`);
  const screenshotPath = path.join(__dirname, `failed_${taskId}_${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  
  await sendPhotoToChat(chatId, screenshotPath, { 
    caption: `❌ 【实名失败】\n姓名：${realName}\n身份证：${maskId(idCard)}\n失败原因：${reason}\n时间：${new Date().toLocaleString()}` 
  });
  await broadcastPhoto(screenshotPath);
  await broadcastMessage(`❌ 实名失败\n姓名：${realName}\n身份证：${maskId(idCard)}\n失败原因：${reason}`);
  
  const oldFailed = fs.existsSync(FAILED_FILE)
    ? fs.readFileSync(FAILED_FILE, 'utf8')
    : '';
  atomicWriteFile(FAILED_FILE, oldFailed + `${realName}|${idCard}|${reason}|${new Date().toISOString()}\n`);
  
  return true;
}

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

async function findInputsInAllFrames(page) {
  let result = await findInputs(page);
  if (result.nameInput && result.idInput) return result;
  for (const f of page.frames()) {
    const r = await findInputs(f);
    if (r.nameInput && r.idInput) return r;
  }
  return { nameInput: null, idInput: null };
}

async function hasInputs(page) {
  const { nameInput, idInput } = await findInputsInAllFrames(page);
  return !!(nameInput && idInput);
}

async function findInFrames(page, selector) {
  let el = await page.$(selector);
  if (el) return el;
  for (const f of page.frames()) {
    el = await f.$(selector);
    if (el) return el;
  }
  return null;
}

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

async function checkVerificationStatus(page) {
  try {
    if (await isUnderManualReview(page)) {
      return { result: 'review', reason: '人工审核中' };
    }
    
    const manualFailKeywords = ['人工实名审核失败', '暂不支持', '护照以外证件', '重新提交护照'];
    let bodyText = await page.textContent('body').catch(() => '');
    for (const kw of manualFailKeywords) {
      if (bodyText.includes(kw)) {
        console.log('🔍 检测到人工审核失败关键词:', kw);
        return { result: 'manual_failure', reason: '人工审核失败，需人工处理' };
      }
    }
    for (const f of page.frames()) {
      const text = await f.textContent('body').catch(() => '');
      for (const kw of manualFailKeywords) {
        if (text.includes(kw)) {
          console.log('🔍 在iframe中检测到人工审核失败关键词:', kw);
          return { result: 'manual_failure', reason: '人工审核失败，需人工处理' };
        }
      }
    }

    const inputsExist = await hasInputs(page);
    if (!inputsExist) {
      console.log('✅ 输入框已消失，判定为成功。');
      return { result: 'success', reason: '输入框消失' };
    }

    const errorKeywords = ['系统繁忙', '网络异常', '错误', '重新登录', '失败', '请稍后再试'];
    bodyText = await page.textContent('body').catch(() => '');
    for (const kw of errorKeywords) {
      if (bodyText.includes(kw)) {
        console.log('❌ 检测到错误关键词:', kw);
        return { result: 'failed', reason: `检测到错误提示: ${kw}` };
      }
    }
    for (const f of page.frames()) {
      const text = await f.textContent('body').catch(() => '');
      for (const kw of errorKeywords) {
        if (text.includes(kw)) {
          console.log('❌ 在iframe中检测到错误关键词:', kw);
          return { result: 'failed', reason: `检测到错误提示: ${kw}` };
        }
      }
    }

    console.log('⚠️ 状态不确定，等待人工确认。');
    return { result: 'unknown', reason: '无法自动判断' };
  } catch (e) {
    console.error('检查状态出错:', e.message);
    return { result: 'unknown', reason: `检查出错: ${e.message}` };
  }
}

// ========== 主任务函数 ==========
async function startTask(loginType, chatId, taskId, abortSignal) {
  let browser = null;
  let normalCompletion = true;

  try {
    await sendToChat(chatId, `🤖 任务 ${taskId} 启动中...`);
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

    browser = await chromium.launch({ headless: HEADLESS });
    currentBrowser = browser;
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('https://jiazhang.qq.com/zk/home.html');
    await delay(3000);
    if (abortSignal.aborted) { normalCompletion = false; return; }

    if (loginType === '2') {
      await page.getByText('QQ登录').click();
    } else {
      await page.getByText('微信登录').click();
    }
    await delay(5000);
    if (abortSignal.aborted) { normalCompletion = false; return; }

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

    const qrPath = path.join(__dirname, `qr_${taskId}.png`);
    await qrElement.screenshot({ path: qrPath });
    await sendPhotoToChat(chatId, qrPath, { caption: `📱 任务 ${taskId} - 请扫码登录` });

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

    while (data.length > 0) {
      if (abortSignal.aborted) { normalCompletion = false; return; }
      totalTry++;
      currentTry = totalTry;
      const current = data[0];
      const realName = current.name;
      const idCard = current.id;
      console.log(`任务 ${taskId} 第 ${totalTry} 次尝试: ${realName}`);

      try {
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

        await curNameInput.fill('');
        await curNameInput.fill(realName);
        await curIdInput.fill('');
        await curIdInput.fill(idCard);
        await delay(1500);

        const agreeCheckbox = await findInFrames(page, '#rule_check');
        if (agreeCheckbox) {
          const isChecked = await agreeCheckbox.isChecked();
          if (!isChecked) await agreeCheckbox.click();
        }
        const submitBtn = await findInFrames(page, '#submit_info');
        if (!submitBtn) throw new Error('找不到提交按钮 #submit_info');
        await submitBtn.click();
        await delay(5000);

        const screenshotPath = path.join(__dirname, `result_${taskId}_${totalTry}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        await sendPhotoToChat(chatId, screenshotPath, { caption: `任务 ${taskId} 执行结果` });

        const status = await checkVerificationStatus(page);

        // ----- 处理各种结果 -----
        if (status.result === 'success') {
          const oldSuccess = fs.existsSync(SUCCESS_FILE)
            ? fs.readFileSync(SUCCESS_FILE, 'utf8')
            : '';
          atomicWriteFile(SUCCESS_FILE, oldSuccess + `${realName}|${idCard}|${new Date().toISOString()}\n`);

          const masked = maskId(idCard);
          await sendToChat(chatId, `✅ 任务 ${taskId} 实名成功\n${realName} | ${masked}`);
          data.shift();
          atomicWriteFile(DATA_FILE, JSON.stringify(data, null, 2));
          break;
          
        } else if (status.result === 'review') {
          await handleManualReview(page, taskId, realName, idCard, chatId);
          data.shift();
          atomicWriteFile(DATA_FILE, JSON.stringify(data, null, 2));
          failCount = 0;
          break;
          
        } else if (status.result === 'manual_failure') {
          const action = await handleManualFailure(page, taskId, realName, idCard, chatId, status.reason);
          if (action === 'abort' || action === 'quit' || action === 'q') {
            normalCompletion = false;
            break;
          } else if (action === 'skip' || action === 'n') {
            data.shift();
            atomicWriteFile(DATA_FILE, JSON.stringify(data, null, 2));
            failCount++;
            continue;
          } else if (action === 'retry' || action === 'r') {
            const retryBtn = await findButtonByText(page, '实名认证');
            if (retryBtn) {
              await retryBtn.click();
              await delay(3000);
              continue;
            } else {
              await sendToChat(chatId, '⚠️ 找不到“实名认证”按钮，跳过该资料。');
              data.shift();
              atomicWriteFile(DATA_FILE, JSON.stringify(data, null, 2));
              failCount++;
              continue;
            }
          }
          
        } else if (status.result === 'failed') {
          await handleFailure(page, taskId, realName, idCard, chatId, status.reason);
          
          await sendToChat(chatId, '⚠️ 实名失败，请选择操作：', continueKeyboard());
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
          
        } else { // unknown
          await sendToChat(chatId, '⚠️ 系统无法自动判断结果，请查看截图并选择：', unknownKeyboard());
          const ans = await waitTelegramReply(chatId, abortSignal, 60);
          if (abortSignal.aborted || ans === null) { normalCompletion = false; return; }
          
          if (ans === 'y') {
            const oldSuccess = fs.existsSync(SUCCESS_FILE)
              ? fs.readFileSync(SUCCESS_FILE, 'utf8')
              : '';
            atomicWriteFile(SUCCESS_FILE, oldSuccess + `${realName}|${idCard}|${new Date().toISOString()}\n`);

            const masked = maskId(idCard);
            await sendToChat(chatId, `✅ 任务 ${taskId} 实名成功（人工确认）\n${realName} | ${masked}`);
            data.shift();
            atomicWriteFile(DATA_FILE, JSON.stringify(data, null, 2));
            break;
          } else if (ans === 'r') {
            await handleManualReview(page, taskId, realName, idCard, chatId);
            data.shift();
            atomicWriteFile(DATA_FILE, JSON.stringify(data, null, 2));
            failCount = 0;
            break;
          } else {
            await handleFailure(page, taskId, realName, idCard, chatId, '人工判定为失败');
            
            await sendToChat(chatId, '人工判定为失败，请选择操作：', continueKeyboard());
            const ans2 = await waitTelegramReply(chatId, abortSignal, 120);
            if (abortSignal.aborted || ans2 === null) { normalCompletion = false; return; }
            if (ans2 === 'q') { normalCompletion = false; return; }
            if (ans2 === 'n') {
              data.shift();
              atomicWriteFile(DATA_FILE, JSON.stringify(data, null, 2));
              failCount++;
            } else if (ans2 === 'c') {
              await handlePopup(page);
            }
          }
        }

        if (failCount >= 5) {
          await sendToChat(chatId, '连续失败5次，请选择：', failKeyboard());
          const ans = await waitTelegramReply(chatId, abortSignal, 60);
          if (abortSignal.aborted || ans === null) { normalCompletion = false; return; }
          if (ans !== 'y') { normalCompletion = false; return; }
          failCount = 0;
        }
      } catch (err) {
        if (abortSignal.aborted) { normalCompletion = false; return; }
        console.error(`任务 ${taskId} 错误:`, err);
        await sendToChat(chatId, `错误: ${err.message}，请选择操作：`, continueKeyboard());
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
    if (browser && await browser.isConnected()) {
      try { await browser.close(); } catch (e) {}
      currentBrowser = null;
    }
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

// ========== 内联键盘回调处理 ==========
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id.toString();
  const data = callbackQuery.data;
  
  // 只处理授权用户
  if (!ALLOWED_IDS.includes(chatId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ 未授权' });
    return;
  }

  // 处理登录选择
  if (data.startsWith('login_')) {
    const value = data.replace('login_', '');
    await bot.answerCallbackQuery(callbackQuery.id);
    // 清除原有回复等待
    if (pendingReplies.has(chatId)) {
      const resolve = pendingReplies.get(chatId);
      pendingReplies.delete(chatId);
      if (replyTimeouts.has(chatId)) {
        clearTimeout(replyTimeouts.get(chatId));
        replyTimeouts.delete(chatId);
      }
      resolve(value);
    }
    return;
  }

  // 处理选择回复 (c/n/q/r/y)
  if (data.startsWith('choice_')) {
    const value = data.replace('choice_', '');
    await bot.answerCallbackQuery(callbackQuery.id);
    if (pendingReplies.has(chatId)) {
      const resolve = pendingReplies.get(chatId);
      pendingReplies.delete(chatId);
      if (replyTimeouts.has(chatId)) {
        clearTimeout(replyTimeouts.get(chatId));
        replyTimeouts.delete(chatId);
      }
      resolve(value);
    }
    return;
  }

  await bot.answerCallbackQuery(callbackQuery.id);
});

// ========== Telegram 消息处理 ==========
bot.on('message', async (msg) => {
  if (!msg.text) return;
  const text = msg.text;
  const chatId = msg.chat.id.toString();

  if (!ALLOWED_IDS.includes(chatId)) {
    console.log(`未授权访问: ${chatId}`);
    return;
  }

  // 处理文字回复（兼容内联键盘和文字输入）
  if (!text.startsWith('/')) {
    if (pendingReplies.has(chatId)) {
      const resolve = pendingReplies.get(chatId);
      pendingReplies.delete(chatId);
      if (replyTimeouts.has(chatId)) {
        clearTimeout(replyTimeouts.get(chatId));
        replyTimeouts.delete(chatId);
      }
      resolve(text.toLowerCase());
      return;
    }
  }

  // ---------- 命令处理 ----------
  if (text.startsWith('/add ')) {
    if (isTaskRunning) {
      await sendToChat(chatId, '⚠️ 任务正在运行，请先 /cancel 再添加。');
      return;
    }
    try {
      const parts = text.split(' ');
      if (parts.length < 3) {
        await sendToChat(chatId, '⚠️ 格式错误，请使用：/add 姓名 身份证号\n例如：/add 王五 110101199001011234');
        return;
      }
      const name = parts[1];
      const idCard = parts.slice(2).join('');
      if (!/^\d{17}[\dXx]$/.test(idCard)) {
        await send
