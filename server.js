const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('.')); // раздаём статику (index.html)

// ---------- Переменные окружения ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CRYPTOPAY_API_KEY = process.env.CRYPTOPAY_API_KEY;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://ваш-домен.up.railway.app'; // замените на ваш

if (!BOT_TOKEN) console.warn('⚠️ BOT_TOKEN не задан');
if (!CRYPTOPAY_API_KEY) console.warn('⚠️ CRYPTOPAY_API_KEY не задан');

const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: true }) : null;

// ---------- Уведомления через бота ----------
async function sendNotification(chatId, text, webAppUrl = WEBAPP_URL) {
    if (!bot) return;
    try {
        await bot.sendMessage(chatId, text, {
            reply_markup: {
                inline_keyboard: [[
                    { text: '🚀 Открыть мини-апп', web_app: { url: webAppUrl } }
                ]]
            }
        });
    } catch (err) {
        console.error('Ошибка отправки уведомления:', err.message);
    }
}

// ---------- API для мини-аппа ----------
// Создание инвойса CryptoPay
app.post('/create-invoice', async (req, res) => {
    const { amount, asset, userId, stars } = req.body;
    if (!CRYPTOPAY_API_KEY) {
        return res.status(500).json({ ok: false, error: 'CryptoPay не настроен' });
    }
    try {
        const response = await axios.post('https://pay.crypt.bot/api/createInvoice', {
            asset,
            amount: amount,
            description: `Покупка ${stars} Stars в Авито Видное`,
            payload: `stars_${stars}_${userId}_${Date.now()}`,
            hidden_message: `Ваш баланс пополнен на ${stars} ⭐`,
            expires_in: 3600
        }, {
            headers: { 'Crypto-Pay-API-Token': CRYPTOPAY_API_KEY }
        });
        res.json({
            ok: true,
            invoice_id: response.data.result.invoice_id,
            invoice_url: response.data.result.bot_url
        });
    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Проверка статуса инвойса CryptoPay
app.post('/check-invoice', async (req, res) => {
    const { invoice_id } = req.body;
    if (!CRYPTOPAY_API_KEY) {
        return res.status(500).json({ status: 'error', error: 'CryptoPay не настроен' });
    }
    try {
        const response = await axios.get('https://pay.crypt.bot/api/getInvoices', {
            params: { invoice_ids: invoice_id },
            headers: { 'Crypto-Pay-API-Token': CRYPTOPAY_API_KEY }
        });
        const invoice = response.data.result.items[0];
        if (invoice && invoice.status === 'paid') {
            res.json({ status: 'paid' });
        } else {
            res.json({ status: 'pending' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ status: 'error' });
    }
});

// Эндпоинт для отправки уведомлений из мини-аппа (например, при новом сообщении)
app.post('/send-notification', async (req, res) => {
    const { userId, type, data } = req.body;
    if (!bot || !userId) return res.json({ ok: false, error: 'no bot or userId' });
    try {
        let text = '';
        if (type === 'new_message') {
            text = `📨 У вас новое сообщение от ${data.fromName}:\n\n"${data.message}"`;
        } else if (type === 'item_approved') {
            text = `✅ Ваш товар "${data.title}" одобрен и опубликован!`;
        } else if (type === 'item_rejected') {
            text = `❌ Ваш товар "${data.title}" отклонён.\nПричина: ${data.reason}`;
        } else {
            return res.json({ ok: false });
        }
        await sendNotification(userId, text);
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
