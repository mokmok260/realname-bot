let currentBrowser = null;
let taskStatus = '空闲';
let currentTry = 0;

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = process.env.TOKEN || '8875404382:AAEf8jfdnw_qC6G8aIKL-iRXGkh8BbZqXgA';
const CHAT_IDS = ['8760252604', '6302735524'];

let pendingReplyResolve = null;
let pendingReplyChatId = null;
const bot = new TelegramBot(TOKEN, { polling: true });

process.on('uncaughtException', async (error) => {
  console.error('❌ 未捕获的异常:', error);
  await sendToAll('message', `⚠️ 程序异常: ${error.message}`);
});
process.on('unhandledRejection', async (reason) => {
  console.error('❌ 未处理的拒绝:', reason);
  await sendToAll('message', `⚠️ 程序错误: ${reason?.message || reason}`);
});

async function sendToAll(type, content, options = {}) {
  for (const id of CHAT_IDS) {
    try {
      if (type === 'message') {
        await bot.sendMessage(id, content, options);
        console.log(`📨 发送给 ${id}: ${content.substring(0, 50)}`);
      }
      if (type === 'photo') {
        let filePath = content;
        if (typeof content === 'string') filePath = path.resolve(__dirname, content);
        else if (content?.path) filePath = path.resolve(__dirname, content.path);
        if (fs.existsSync(filePath)) {
          await bot.sendPhoto(id, fs.createReadStream(filePath), options);
          console.log(`🖼️ 图片发送给 ${id}`);
        } else {
          await bot.sendMessage(id, '❌ 图片文件不存在');
        }
      }
    } catch (e) {
      console.log(`发送失败 ${id}:`, e.message);
    }
  }
}

async function waitTelegramReply(chatId, timeoutSeconds = 120) {
  return new Promise((resolve) => {
    pendingReplyResolve = resolve;
    pendingReplyChatId = chatId;
    setTimeout(() => {
      if (pendingReplyResolve === resolve) {
        pendingReplyResolve = null;
        pendingReplyChatId = null;
        sendToAll('message', '⏰ 等待回复超时，任务自动取消');
        resolve(null);
      }
    }, timeoutSeconds * 1000);
  });
}

// 检查页面是否包含“已满18周岁”（支持 iframe）
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

// 截图并发送已实名通知
async function handleAlreadyVerified(page, browser) {
  console.log('⚠️ 账号已实名');
  const screenshotPath = path.resolve(__dirname, 'already_verified.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await sendToAll('photo', screenshotPath, { caption: '⚠️ 账号已实名，无法继续' });
  await browser.close();
  currentBrowser = null;
  return true;
}

// 智能查找实名输入框和身份证输入框（支持多种选择器）
async function findInputs(page) {
  const nameSelectors = ['#realname', '#real_name_ipt', 'input[name="realname"]', 'input[placeholder*="姓名"]'];
  const idSelectors = ['#idcard', '#card_id_ipt', 'input[name="idcard"]', 'input[placeholder*="身份证"]'];

  let nameInput = null;
  let idInput = null;

  for (const sel of nameSelectors) {
    nameInput = await page.$(sel);
    if (nameInput) break;
  }
  for (const sel of idSelectors) {
    idInput = await page.$(sel);
    if (idInput) break;
  }
  return { nameInput, idInput };
}

bot.on('message', async (msg) => {
  const text = msg.text;
  const chatId = msg.chat.id.toString();

  if (pendingReplyResolve && pendingReplyChatId === chatId) {
    pendingReplyResolve(text.toLowerCase());
    pendingReplyResolve = null;
    pendingReplyChatId = null;
    return;
  }

  if (text === '/starttask') {
    await sendToAll('message', `开始实名任务\n/cancel 关闭\n/status 状态\n/queue 剩余资料\n\nc=继续 n=下一条 q=退出`);
    taskStatus = '运行中';
    await sendToAll('message', '选择登录方式:\n1 = 微信\n2 = QQ');
    const loginType = await waitTelegramReply(chatId, 60);
    if (!loginType) return;
    await startTask(loginType, chatId);
    return;
  }

  if (text === '/cancel') {
    if (currentBrowser) {
      await currentBrowser.close();
      currentBrowser = null;
      await sendToAll('message', '✅ 任务已关闭');
    } else {
      await sendToAll('message', '无运行中任务');
    }
    taskStatus = '空闲';
    return;
  }

  if (text === '/status') {
    await sendToAll('message', `状态: ${taskStatus}\n尝试次数: ${currentTry}`);
    return;
  }

  if (text === '/queue') {
    try {
      const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
      await sendToAll('message', `剩余资料: ${data.length}`);
    } catch (e) {
      await sendToAll('message', '读取资料失败');
    }
    return;
  }
});

async function startTask(loginType, chatId) {
  await sendToAll('message', '🤖 启动中...');
  let data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
  if (data.length === 0) {
    await sendToAll('message', '❌ 没有资料');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  currentBrowser = browser;
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://jiazhang.qq.com/zk/home.html');
  await page.waitForTimeout(3000);

  if (loginType === '2') {
    await page.click('text=QQ登录');
    console.log('选择 QQ');
  } else {
    await page.click('text=微信登录');
    console.log('选择微信');
  }
  await page.waitForTimeout(5000);

  // 获取登录 iframe
  let frame;
  for (let i = 0; i < 10; i++) {
    if (loginType === '2') {
      frame = page.frames().find(f => f.url().includes('ptlogin2.qq.com'));
    } else {
      frame = page.frames().find(f => f.url().includes('open.weixin.qq.com'));
    }
    if (frame) break;
    await page.waitForTimeout(1000);
  }
  if (!frame) {
    await sendToAll('message', '❌ 找不到登录窗口');
    await browser.close();
    currentBrowser = null;
    return;
  }

  // 获取二维码元素
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
    await page.waitForTimeout(1000);
  }
  if (!qrElement) {
    await sendToAll('message', '❌ 找不到二维码');
    await browser.close();
    currentBrowser = null;
    return;
  }

  const qrPath = path.resolve(__dirname, 'qr.png');
  await qrElement.screenshot({ path: qrPath });
  await sendToAll('photo', qrPath, { caption: '📱 请扫码登录' });

  // 等待扫码（微信5分钟，QQ110秒）
  const expireTime = (loginType === '2') ? 110 * 1000 : 5 * 60 * 1000;
  const startTime = Date.now();
  let loggedIn = false;

  while (!loggedIn) {
    await page.waitForTimeout(2000);
    if (Date.now() - startTime > expireTime) {
      await sendToAll('message', `⏰ 二维码过期（${loginType === '2' ? '110秒' : '5分钟'}）`);
      await browser.close();
      currentBrowser = null;
      return;
    }
    if (await isAlreadyVerified(page)) {
      await handleAlreadyVerified(page, browser);
      return;
    }
    let loginFrame;
    if (loginType === '2') {
      loginFrame = page.frames().find(f => f.url().includes('ptlogin2.qq.com'));
    } else {
      loginFrame = page.frames().find(f => f.url().includes('open.weixin.qq.com'));
    }
    if (!loginFrame) {
      console.log('登录成功，iframe消失');
      loggedIn = true;
      break;
    }
  }

  await page.waitForTimeout(5000);
  console.log('登录后等待页面稳定...');

  // 再次检查已实名
  if (await isAlreadyVerified(page)) {
    await handleAlreadyVerified(page, browser);
    return;
  }

  // 等待实名输入框出现（重点修改：使用智能选择器，并考虑 iframe）
  console.log('查找实名输入框...');
  let nameInput = null;
  let idInput = null;

  // 首先在主页面查找
  let found = false;
  for (let retry = 0; retry < 20; retry++) {
    const inputs = await findInputs(page);
    nameInput = inputs.nameInput;
    idInput = inputs.idInput;
    if (nameInput && idInput) {
      found = true;
      break;
    }
    // 如果在主页面找不到，尝试在所有 iframe 中查找
    for (const f of page.frames()) {
      const iframeInputs = await findInputs(f);
      if (iframeInputs.nameInput && iframeInputs.idInput) {
        nameInput = iframeInputs.nameInput;
        idInput = iframeInputs.idInput;
        found = true;
        break;
      }
    }
    if (found) break;
    await page.waitForTimeout(1000);
    console.log(`等待实名表单... ${retry+1}秒`);
  }

  if (!nameInput || !idInput) {
    console.log('未找到实名输入框');
    await sendToAll('message', '❌ 未找到实名表单，请手动检查页面');
    await browser.close();
    currentBrowser = null;
    return;
  }

  console.log('找到实名输入框，开始填写');
  await sendToAll('message', '✅ 已进入实名页面，开始自动填写');

  // 实名循环
  let failCount = 0;
  let totalTry = 0;

  while (data.length > 0) {
    totalTry++;
    currentTry = totalTry;
    const current = data[0];
    const realName = current.name;
    const idCard = current.id;
    console.log(`尝试 ${totalTry}: ${realName} ${idCard}`);

    try {
      // 清空并填写（注意可能跨 frame，需要重新获取元素）
      let curNameInput = nameInput;
      let curIdInput = idInput;
      if (!curNameInput || !curIdInput) {
        const inputs = await findInputs(page);
        curNameInput = inputs.nameInput;
        curIdInput = inputs.idInput;
        if (!curNameInput || !curIdInput) {
          throw new Error('输入框丢失');
        }
      }
      await curNameInput.fill('');
      await curNameInput.fill(realName);
      await curIdInput.fill('');
      await curIdInput.fill(idCard);
      await page.waitForTimeout(1500);

      // 勾选协议
      const agreeCheckbox = await page.$('#rule_check, input[type="checkbox"]');
      if (agreeCheckbox) {
        const isChecked = await agreeCheckbox.isChecked();
        if (!isChecked) await agreeCheckbox.click();
      }
      // 提交按钮
      const submitBtn = await page.$('#submit_info, button[type="submit"], input[value="提交"]');
      if (!submitBtn) throw new Error('找不到提交按钮');
      await submitBtn.click();
      await page.waitForTimeout(5000);

      const screenshotPath = path.resolve(__dirname, `result_${totalTry}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await sendToAll('photo', screenshotPath, { caption: '实名结果' });

      // 检查是否成功（实名输入框消失或出现成功提示）
      const stillHasInput = await findInputs(page);
      if (!stillHasInput.nameInput && !stillHasInput.idInput) {
        await sendToAll('message', `✅ 实名成功\n${realName}\n${idCard}`);
        fs.appendFileSync('success.txt', `${realName}|${idCard}\n`);
        data.shift();
        fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
        break;
      } else {
        // 异常处理
        await sendToAll('message', '⚠️ 异常，请回复 c(继续) n(下一条) q(退出)');
        const ans = await waitTelegramReply(chatId, 120);
        if (ans === 'q') break;
        if (ans === 'n') {
          data.shift();
          fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
          failCount++;
        } else if (ans === 'c') {
          try { await page.keyboard.press('Escape'); } catch(e) {}
        }
      }

      if (failCount >= 5) {
        await sendToAll('message', '连续失败5次，y继续 / q退出');
        const ans = await waitTelegramReply(chatId, 60);
        if (ans !== 'y') break;
        failCount = 0;
      }
    } catch (err) {
      console.error('实名步骤错误:', err);
      await sendToAll('message', `程序错误: ${err.message}\n回复 c 继续 / q 退出`);
      const ans = await waitTelegramReply(chatId, 60);
      if (ans === 'q') break;
    }
  }

  taskStatus = '空闲';
  await browser.close();
  currentBrowser = null;

// 启动 HTTP 服务（Render 健康检查需要）
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`HTTP 服务运行在端口 ${PORT}`);
});

}
