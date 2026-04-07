const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const xss = require('xss');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('.'));

// ---------- КОНФИГУРАЦИЯ ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim());

// ---------- POSTGRESQL ----------
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT,
            login TEXT,
            avatar TEXT,
            stars INTEGER DEFAULT 100,
            status TEXT DEFAULT 'active',
            role TEXT DEFAULT 'user',
            block_reason TEXT,
            registered TEXT
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS items (
            id BIGINT PRIMARY KEY,
            title TEXT,
            price INTEGER,
            category TEXT,
            description TEXT,
            photo TEXT,
            seller_id TEXT REFERENCES users(id),
            seller_name TEXT,
            time TEXT,
            views INTEGER DEFAULT 0,
            likes INTEGER DEFAULT 0,
            status TEXT DEFAULT 'active',
            moderation TEXT DEFAULT 'pending',
            premium BOOLEAN DEFAULT FALSE,
            reject_reason TEXT
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS favorites (
            user_id TEXT REFERENCES users(id),
            item_id BIGINT REFERENCES items(id),
            PRIMARY KEY (user_id, item_id)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chats (
            id BIGINT PRIMARY KEY,
            user1_id TEXT REFERENCES users(id),
            user2_id TEXT REFERENCES users(id),
            messages JSONB DEFAULT '[]',
            updated_at TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            user_id TEXT REFERENCES users(id),
            amount INTEGER,
            description TEXT,
            date TEXT
        )
    `);
    console.log('✅ База данных инициализирована');
}
initDb();

// ---------- ПРОВЕРКА ПОДПИСИ TELEGRAM ----------
function verifyTelegramAuth(initData) {
    if (!initData) return null;
    const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest();
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
    const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (hmac !== hash) return null;
    const userParam = params.get('user');
    if (!userParam) return null;
    return JSON.parse(userParam);
}

function authMiddleware(req, res, next) {
    const initData = req.headers.authorization;
    const tgUser = verifyTelegramAuth(initData);
    if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
    req.tgUser = tgUser;
    next();
}

// ---------- RATE LIMIT ----------
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'Too many requests' }
});

// ---------- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ----------
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// ---------- API: ПОЛУЧЕНИЕ/СОЗДАНИЕ ПОЛЬЗОВАТЕЛЯ ----------
app.post('/api/auth', authMiddleware, async (req, res) => {
    const tgUser = req.tgUser;
    const userId = tgUser.id.toString();
    const isAdmin = ADMIN_IDS.includes(userId);
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
        await pool.query(
            'INSERT INTO users (id, name, login, avatar, role, registered) VALUES ($1, $2, $3, $4, $5, $6)',
            [userId, escapeHtml(tgUser.first_name), tgUser.username ? `@${tgUser.username}` : `user_${userId.slice(-6)}`, '👤', isAdmin ? 'admin' : 'user', new Date().toLocaleDateString()]
        );
    }
    const user = (await pool.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    if (user.status === 'blocked') {
        return res.json({ blocked: true, reason: user.block_reason });
    }
    res.json({ user, isAdmin });
});

// ---------- API: ОБЪЯВЛЕНИЯ ----------
app.post('/api/items', authMiddleware, limiter, async (req, res) => {
    const { title, price, category, description, photo, premium } = req.body;
    const userId = req.tgUser.id.toString();
    if (!title || !price || !description) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const user = (await pool.query('SELECT stars, name FROM users WHERE id = $1', [userId])).rows[0];
    if (premium && user.stars < 15) {
        return res.status(400).json({ error: 'Not enough stars' });
    }
    if (premium) {
        await pool.query('UPDATE users SET stars = stars - 15 WHERE id = $1', [userId]);
        await pool.query('INSERT INTO transactions (user_id, amount, description, date) VALUES ($1, $2, $3, $4)',
            [userId, -15, `Премиум: ${escapeHtml(title)}`, new Date().toLocaleDateString()]);
    }
    const itemId = Date.now();
    await pool.query(
        `INSERT INTO items (id, title, price, category, description, photo, seller_id, seller_name, time, premium, moderation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [itemId, escapeHtml(title), price, category, escapeHtml(description), photo || '', userId, escapeHtml(user.name), new Date().toLocaleTimeString(), premium || false, 'pending']
    );
    res.json({ id: itemId, success: true });
});

app.get('/api/items', async (req, res) => {
    const { cat, search, limit = 50, offset = 0 } = req.query;
    let query = `SELECT * FROM items WHERE moderation = 'approved' AND status != 'sold'`;
    const params = [];
    if (cat && cat !== 'all') {
        params.push(cat);
        query += ` AND category = $${params.length}`;
    }
    if (search) {
        params.push(`%${search}%`);
        query += ` AND (title ILIKE $${params.length} OR description ILIKE $${params.length})`;
    }
    query += ` ORDER BY premium DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const result = await pool.query(query, params);
    res.json(result.rows);
});

app.post('/api/item/:id/like', authMiddleware, async (req, res) => {
    const userId = req.tgUser.id.toString();
    const itemId = parseInt(req.params.id);
    const exists = await pool.query('SELECT 1 FROM favorites WHERE user_id = $1 AND item_id = $2', [userId, itemId]);
    if (exists.rows.length === 0) {
        await pool.query('INSERT INTO favorites (user_id, item_id) VALUES ($1, $2)', [userId, itemId]);
        await pool.query('UPDATE items SET likes = likes + 1 WHERE id = $1', [itemId]);
    } else {
        await pool.query('DELETE FROM favorites WHERE user_id = $1 AND item_id = $2', [userId, itemId]);
        await pool.query('UPDATE items SET likes = likes - 1 WHERE id = $1', [itemId]);
    }
    res.json({ success: true });
});

app.post('/api/item/:id/view', async (req, res) => {
    const itemId = parseInt(req.params.id);
    await pool.query('UPDATE items SET views = views + 1 WHERE id = $1', [itemId]);
    res.json({ success: true });
});

// ---------- API: ЧАТЫ ----------
app.post('/api/chats', authMiddleware, async (req, res) => {
    const userId = req.tgUser.id.toString();
    const { otherId } = req.body;
    let chat = await pool.query(
        `SELECT * FROM chats WHERE (user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1)`,
        [userId, otherId]
    );
    if (chat.rows.length === 0) {
        const chatId = Date.now();
        await pool.query(
            `INSERT INTO chats (id, user1_id, user2_id, messages) VALUES ($1, $2, $3, $4)`,
            [chatId, userId, otherId, JSON.stringify([])]
        );
        chat = { rows: [{ id: chatId, user1_id: userId, user2_id: otherId, messages: [] }] };
    }
    res.json(chat.rows[0]);
});

app.post('/api/chats/:id/message', authMiddleware, async (req, res) => {
    const chatId = parseInt(req.params.id);
    const userId = req.tgUser.id.toString();
    const { text } = req.body;
    const chat = (await pool.query('SELECT * FROM chats WHERE id = $1', [chatId])).rows[0];
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const messages = chat.messages || [];
    messages.push({
        from: userId,
        text: escapeHtml(text),
        time: new Date().toLocaleTimeString()
    });
    await pool.query('UPDATE chats SET messages = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(messages), chatId]);
    res.json({ success: true });
});

app.get('/api/chats', authMiddleware, async (req, res) => {
    const userId = req.tgUser.id.toString();
    const chats = await pool.query(
        `SELECT * FROM chats WHERE user1_id = $1 OR user2_id = $1 ORDER BY updated_at DESC`,
        [userId]
    );
    res.json(chats.rows);
});

// ---------- API: АДМИНКА ----------
app.post('/api/admin/moderate', authMiddleware, async (req, res) => {
    const tgUser = req.tgUser;
    const isAdmin = ADMIN_IDS.includes(tgUser.id.toString());
    if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const { itemId, action, reason } = req.body;
    if (action === 'approve') {
        await pool.query('UPDATE items SET moderation = $1 WHERE id = $2', ['approved', itemId]);
    } else if (action === 'reject') {
        const item = (await pool.query('SELECT seller_id, premium, title FROM items WHERE id = $1', [itemId])).rows[0];
        if (item.premium) {
            await pool.query('UPDATE users SET stars = stars + 15 WHERE id = $1', [item.seller_id]);
        }
        await pool.query('UPDATE items SET moderation = $1, reject_reason = $2 WHERE id = $3', ['rejected', reason || 'Без причины', itemId]);
    }
    res.json({ success: true });
});

app.post('/api/admin/user/:userId/block', authMiddleware, async (req, res) => {
    const tgUser = req.tgUser;
    const isAdmin = ADMIN_IDS.includes(tgUser.id.toString());
    if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const { userId } = req.params;
    const { reason, action } = req.body;
    if (action === 'block') {
        await pool.query('UPDATE users SET status = $1, block_reason = $2 WHERE id = $3', ['blocked', reason, userId]);
    } else {
        await pool.query('UPDATE users SET status = $1, block_reason = NULL WHERE id = $2', ['active', userId]);
    }
    res.json({ success: true });
});

app.get('/api/admin/stats', authMiddleware, async (req, res) => {
    const tgUser = req.tgUser;
    const isAdmin = ADMIN_IDS.includes(tgUser.id.toString());
    if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const usersCount = (await pool.query('SELECT COUNT(*) FROM users')).rows[0].count;
    const itemsCount = (await pool.query('SELECT COUNT(*) FROM items')).rows[0].count;
    const pendingCount = (await pool.query('SELECT COUNT(*) FROM items WHERE moderation = $1', ['pending'])).rows[0].count;
    const totalStars = (await pool.query('SELECT SUM(stars) FROM users')).rows[0].sum || 0;
    res.json({ usersCount, itemsCount, pendingCount, totalStars });
});

// ---------- ЗАПУСК ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));
