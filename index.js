// -*- coding: utf-8 -*-
// bot.js - Production-ready, secure & robust

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

// ========== CONFIGURATION ==========
const TOKEN = process.env.BOT_TOKEN;
const ALLOWED_IDS = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(id => id.length > 0);

if (!TOKEN) {
  console.error('❌ Error: BOT_TOKEN environment variable not set.');
  process.exit(1);
}
if (ALLOWED_IDS.length === 0) {
  console.error('❌ Error: ALLOWED_CHAT_IDS environment variable not set or empty.');
  process.exit(1);
}

// Use headless mode? Set HEADLESS=true for headless, default false for debugging
const HEADLESS = process.env.HEADLESS === 'true';

const DATA_FILE = path.join(__dirname, 'data.json');
const SUCCESS_FILE = path.join(__dirname, 'success.txt');
const TEMP_SUFFIX = '.tmp';

// ========== GLOBAL STATE ==========
let isTaskRunning = false;
let currentTaskId = 0;
let taskIdCounter = 0;
let abortController = null;
let currentBrowser = null;
let currentTry = 0;
const pendingReplies = new Map();

const bot = new TelegramBot(TOKEN, { polling: true });

// ========== UTILITY FUNCTIONS ==========
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Atomic write: write to temp file then rename
function atomicWriteFile(filePath, data) {
  const tempPath = filePath + TEMP_SUFFIX;
  fs.writeFileSync(tempPath, data, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function maskId(id) {
  if (!id || id.length < 10) return '****';
  return id.substring(0, 6) + '********' + id.substring(id.length - 4);
}

async function sendToChat(chatId, content, options = {}) {
  try {
    await bot.sendMessage(chatId, content, options);
    console.log(`[MSG] to ${chatId}: ${content.substring(0, 50)}`);
  } catch (e) {
    console.log(`Send failed to ${chatId}: ${e.message}`);
  }
}

async function sendPhotoToChat(chatId, filePath, options = {}) {
  try {
    if (fs.existsSync(filePath)) {
      await bot.sendPhoto(chatId, fs.createReadStream(filePath), options);
      console.log(`[PHOTO] to ${chatId}`);
    } else {
      await sendToChat(chatId, '❌ Image file not found');
    }
  } catch (e) {
    console.log(`Photo send failed to ${chatId}: ${e.message}`);
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
      // Send timeout notification
      sendToChat(chatId, '⏰ Reply timeout, task will exit.');
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

// ========== PAGE HELPERS ==========
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

async function handleAlreadyVerified(page, browser) {
  console.log('⚠️ Account already verified');
  const screenshotPath = path.join(__dirname, 'already_verified.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await broadcastMessage('⚠️ Already verified, cannot proceed');
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
    console.log('Popup handling error:', e.message);
  }
}

// Strict success detection: check only visible success elements (if possible)
async function isVerificationSuccess(page) {
  try {
    // First check for error keywords to quickly reject
    const errorKeywords = ['系统繁忙', '网络异常', '错误', '重新登录', '失败'];
    let bodyText = await page.textContent('body').catch(() => '');
    for (const kw of errorKeywords) {
      if (bodyText.includes(kw)) return false;
    }
    // Check iframes too
    for (const f of page.frames()) {
      const text = await f.textContent('body').catch(() => '');
      for (const kw of errorKeywords) {
        if (text.includes(kw)) return false;
      }
    }

    // Now check success keywords only in specific elements (like #result_msg, .tip-success)
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

    // Fallback: check entire body for success keywords (but only if no error keywords found)
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
    console.error('Error checking success:', e.message);
    return false;
  }
}

// ========== MAIN TASK ==========
async function startTask(loginType, chatId, taskId, abortSignal) {
  let browser = null;
  let normalCompletion = true;
  let exitReason = null;

  try {
    await sendToChat(chatId, `🤖 Task ${taskId} starting...`);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      await sendToChat(chatId, '❌ Failed to read data.json.');
      normalCompletion = false;
      return;
    }
    if (data.length === 0) {
      await sendToChat(chatId, '❌ No data left');
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

    // Choose login
    if (loginType === '2') {
      await page.getByText('QQ登录').click();
    } else {
      await page.getByText('微信登录').click();
    }
    await delay(5000);
    if (abortSignal.aborted) { normalCompletion = false; return; }

    // Locate login iframe
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
      await sendToChat(chatId, '❌ Cannot find login window');
      normalCompletion = false;
      return;
    }

    // QR code
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
      await sendToChat(chatId, '❌ Cannot find QR code');
      normalCompletion = false;
      return;
    }

    const qrPath = path.join(__dirname, `qr_${taskId}.png`);
    await qrElement.screenshot({ path: qrPath });
    await sendPhotoToChat(chatId, qrPath, { caption: `📱 Task ${taskId} - Scan QR` });

    // Wait for scan
    const expireTime = (loginType === '2') ? 110 * 1000 : 5 * 60 * 1000;
    const startTime = Date.now();
    let loggedIn = false;

    while (!loggedIn) {
      await delay(2000);
      if (abortSignal.aborted) { normalCompletion = false; return; }
      if (Date.now() - startTime > expireTime) {
        await sendToChat(chatId, `⏰ QR expired (task ${taskId})`);
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

    // Wait for verification form
    console.log(`Task ${taskId}: looking for verification form...`);
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
      await sendToChat(chatId, '❌ Verification form not found.');
      normalCompletion = false;
      return;
    }

    await sendToChat(chatId, '✅ Verification page ready, auto-filling...');

    let failCount = 0;
    let totalTry = 0;

    while (data.length > 0) {
      if (abortSignal.aborted) { normalCompletion = false; return; }
      totalTry++;
      currentTry = totalTry;
      const current = data[0];
      const realName = current.name;
      const idCard = current.id;
      console.log(`Task ${taskId} try ${totalTry}: ${realName}`);

      try {
        // Refresh inputs
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
        if (!curNameInput || !curIdInput) throw new Error('Input fields lost');

        await curNameInput.fill('');
        await curNameInput.fill(realName);
        await curIdInput.fill('');
        await curIdInput.fill(idCard);
        await delay(1500);

        // Use precise checkbox selector: #rule_check only
        const agreeCheckbox = await findInFrames(page, '#rule_check');
        if (agreeCheckbox) {
          const isChecked = await agreeCheckbox.isChecked();
          if (!isChecked) await agreeCheckbox.click();
        }
        // Use precise submit button: #submit_info
        const submitBtn = await findInFrames(page, '#submit_info');
        if (!submitBtn) throw new Error('Submit button not found (#submit_info)');
        await submitBtn.click();
        await delay(5000);

        const screenshotPath = path.join(__dirname, `result_${taskId}_${totalTry}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        await sendPhotoToChat(chatId, screenshotPath, { caption: `Task ${taskId} result` });

        const success = await isVerificationSuccess(page);
        if (success) {
          // Mask ID in message
          const masked = maskId(idCard);
          await sendToChat(chatId, `✅ Task ${taskId} succeeded\n${realName} | ${masked}`);
          // Store full data in success file (still needed for audit)
          atomicWriteFile(SUCCESS_FILE, fs.readFileSync(SUCCESS_FILE, 'utf8') + `${realName}|${idCard}\n`);
          data.shift();
          atomicWriteFile(DATA_FILE, JSON.stringify(data, null, 2));
          break;
        } else {
          await sendToChat(chatId, '⚠️ Verification failed (no success text). Reply c(continue) n(next) q(quit)');
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

        if (failCount >= 5) {
          await sendToChat(chatId, 'Failed 5 times. y(continue) / q(quit)');
          const ans = await waitTelegramReply(chatId, abortSignal, 60);
          if (abortSignal.aborted || ans === null) { normalCompletion = false; return; }
          if (ans !== 'y') { normalCompletion = false; return; }
          failCount = 0;
        }
      } catch (err) {
        if (abortSignal.aborted) { normalCompletion = false; return; }
        console.error(`Task ${taskId} error:`, err);
        await sendToChat(chatId, `Error: ${err.message}\nReply c(continue) n(next) q(quit)`);
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

    // Only send completion if not cancelled
    if (!abortSignal.aborted && normalCompletion) {
      await sendToChat(chatId, `✅ Task ${taskId} finished normally.`);
    }

  } catch (err) {
    if (!abortSignal.aborted) {
      console.error(`Fatal error in task ${taskId}:`, err);
      await sendToChat(chatId, `❌ Fatal error: ${err.message}`);
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
    console.log(`Task ${taskId} terminated.`);
  }
}

// ========== GLOBAL ERROR HANDLERS ==========
process.on('uncaughtException', async (error) => {
  console.error('❌ Uncaught Exception:', error);
  await broadcastMessage(`⚠️ Fatal exception: ${error.message}. Bot will exit.`);
  process.exit(1);
});
process.on('unhandledRejection', async (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
  await broadcastMessage(`⚠️ Unhandled rejection: ${reason?.message || reason}. Bot will exit.`);
  process.exit(1);
});

// ========== TELEGRAM MESSAGE HANDLER ==========
bot.on('message', async (msg) => {
  if (!msg.text) return;
  const text = msg.text;
  const chatId = msg.chat.id.toString();

  if (!ALLOWED_IDS.includes(chatId)) {
    console.log(`Unauthorized from ${chatId}`);
    return;
  }

  // Handle pending reply (only if not a command)
  if (!text.startsWith('/')) {
    if (pendingReplies.has(chatId)) {
      const resolve = pendingReplies.get(chatId);
      pendingReplies.delete(chatId);
      resolve(text.toLowerCase());
      return;
    }
  }

  // ---------- Commands ----------
  if (text === '/list' || text.startsWith('/list ')) {
    try {
      let page = 1;
      const parts = text.split(' ');
      if (parts.length > 1 && /^\d+$/.test(parts[1])) page = parseInt(parts[1]);
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (data.length === 0) { await sendToChat(chatId, '📭 Queue empty'); return; }
      const pageSize = 10;
      const totalPages = Math.ceil(data.length / pageSize);
      if (page > totalPages) page = totalPages;
      const start = (page - 1) * pageSize;
      const end = Math.min(start + pageSize, data.length);
      let message = `📋 Data list (page ${page}/${totalPages}, total ${data.length})\n━━━━━━━━━━━━━━━\n`;
      for (let i = start; i < end; i++) {
        const item = data[i];
        const maskedId = maskId(item.id);
        message += `【${i+1}】${item.name} | ${maskedId}\n`;
      }
      message += `━━━━━━━━━━━━━━━\n💡 Use /del <number> to delete`;
      await sendToChat(chatId, message);
    } catch (e) {
      await sendToChat(chatId, `❌ Read data failed: ${e.message}`);
    }
    return;
  }

  if (text.startsWith('/del ')) {
    if (isTaskRunning) {
      await sendToChat(chatId, '⚠️ A task is running. Use /cancel first.');
      return;
    }
    try {
      const parts = text.split(' ');
      if (parts.length < 2 || !/^\d+$/.test(parts[1])) {
        await sendToChat(chatId, '⚠️ Provide a valid number, e.g. /del 5');
        return;
      }
      const index = parseInt(parts[1]) - 1;
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (index < 0 || index >= data.length) {
        await sendToChat(chatId, `❌ Invalid. Total ${data.length} entries.`);
        return;
      }
      const deleted = data[index];
      data.splice(index, 1);
      atomicWriteFile(DATA_FILE, JSON.stringify(data, null, 2));
      const maskedId = maskId(deleted.id);
      await sendToChat(chatId, `✅ Deleted: ${deleted.name} | ${maskedId}\nRemaining: ${data.length}`);
    } catch (e) {
      await sendToChat(chatId, `❌ Delete failed: ${e.message}`);
    }
    return;
  }

  if (text === '/starttask') {
    if (isTaskRunning) {
      await sendToChat(chatId, `⚠️ A task (ID ${currentTaskId}) is already running. Use /cancel first.`);
      return;
    }

    currentTry = 0;

    const taskId = ++taskIdCounter;
    currentTaskId = taskId;
    const newAbortController = new AbortController();
    abortController = newAbortController;
    isTaskRunning = true;

    await sendToChat(chatId, `Start task ${taskId}\n/cancel to stop\n/status\n/queue\n/list\n/del\n\nDuring task: c=continue, n=next, q=quit`);
    await sendToChat(chatId, 'Choose login:\n1 = WeChat\n2 = QQ');

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
        await sendToChat(chatId, 'Invalid. Enter 1 or 2:');
      }
    }

    await startTask(loginType, chatId, taskId, newAbortController.signal);
    if (isTaskRunning) {
      isTaskRunning = false;
      abortController = null;
      currentTaskId = 0;
    }
    return;
  }

  if (text === '/cancel') {
    if (!isTaskRunning || !abortController) {
      await sendToChat(chatId, 'No running task to cancel.');
      return;
    }
    abortController.abort();
    if (currentBrowser) {
      try {
        if (await currentBrowser.isConnected()) {
          await currentBrowser.close();
        }
      } catch (e) { /* ignore */ }
      currentBrowser = null;
    }
    for (const [cid, resolve] of pendingReplies) {
      pendingReplies.delete(cid);
      resolve(null);
    }
    await sendToChat(chatId, `✅ Cancellation signal sent for task ${currentTaskId}`);
    return;
  }

  if (text === '/status') {
    if (isTaskRunning) {
      await sendToChat(chatId, `Status: running (task ${currentTaskId})`);
    } else {
      await sendToChat(chatId, 'Status: idle');
    }
    await sendToChat(chatId, `Attempts: ${currentTry}`);
    return;
  }

  if (text === '/queue') {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      await sendToChat(chatId, `Remaining: ${data.length}`);
    } catch (e) {
      await sendToChat(chatId, 'Failed to read queue');
    }
    return;
  }
});

console.log('🤖 Bot is running. Single-task mode, robust and secure.');
console.log(`Headless mode: ${HEADLESS}`);
console.log(`Allowed users: ${ALLOWED_IDS.join(', ')}`);
