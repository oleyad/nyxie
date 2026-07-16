const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { getUserDb, all, get, run } = require('./userDb');

const JWT_SECRET = process.env.JWT_SECRET || 'nyxie-dev-secret-change-in-production';
const JWT_EXPIRES = '7d';
const SALT_ROUNDS = 10;

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

router.post('/register', async (req, res) => {
  try {
    const db = await getUserDb();
    const { username, email, password, display_name } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email and password are required' });
    }

    const trimmedUsername = username.trim();
    if (!/^[a-zA-Z0-9_-]{3,30}$/.test(trimmedUsername)) {
      return res.status(400).json({ error: 'Username must be 3-30 characters (letters, numbers, _ or -).' });
    }
    const reserved = ['admin', 'root', 'system', 'nyxie', 'support'];
    if (reserved.includes(trimmedUsername.toLowerCase())) {
      return res.status(400).json({ error: 'Username not available' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    if (!isValidEmail(trimmedEmail)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const displayName = display_name?.trim() || trimmedUsername;

    const existingUser = get(db, 'SELECT id FROM users WHERE username = ?', [trimmedUsername]);
    if (existingUser) return res.status(409).json({ error: 'Username already taken' });
    const existingEmail = get(db, 'SELECT id FROM users WHERE email = ?', [trimmedEmail]);
    if (existingEmail) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const userId = crypto.randomUUID();
    const now = Date.now();

    run(db,
      `INSERT INTO users (id, username, email, password_hash, display_name, avatar, banner, banner_color, bio, status, created_at, last_seen)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'online', ?, ?)`,
      [userId, trimmedUsername, trimmedEmail, passwordHash, displayName, now, now]
    );

    const defaultServer = get(db, "SELECT id FROM servers WHERE name = 'Nyxie'");
    if (defaultServer) {
      run(db, 'INSERT OR IGNORE INTO server_members (server_id, user_id, joined_at) VALUES (?, ?, ?)',
          [defaultServer.id, userId, now]);
      const channels = all(db, 'SELECT id FROM rooms WHERE server_id = ?', [defaultServer.id]);
      for (const ch of channels) {
        run(db, 'INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)',
            [ch.id, userId, now]);
      }
    }

    const token = signToken(userId);
    res.status(201).json({
      token,
      user: { id: userId, username: trimmedUsername, email: trimmedEmail, display_name: displayName, avatar: null, banner: null, banner_color: null, bio: null, status: 'online' }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const db = await getUserDb();
    const { username, email, password } = req.body;

    if ((!username && !email) || !password) {
      return res.status(400).json({ error: 'username/email and password are required' });
    }

    let user;
    if (username) {
      user = get(db, 'SELECT * FROM users WHERE username = ?', [username.trim()]);
    } else if (email) {
      user = get(db, 'SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.disabled) {
      if (!req.body.reactivate) {
        return res.status(403).json({ error: 'Account disabled', disabled: true });
      }
      run(db, 'UPDATE users SET disabled = 0 WHERE id = ?', [user.id]);
      user.disabled = 0;
    }

    run(db, 'UPDATE users SET last_seen = ? WHERE id = ?', [Date.now(), user.id]);

    const token = signToken(user.id);
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        display_name: user.display_name,
        avatar: user.avatar || null,
        banner: user.banner || null,
        banner_color: user.banner_color || null,
        bio: user.bio || null,
        status: user.status || 'online'
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const db = await getUserDb();
    const user = get(db, 'SELECT id, username, email, display_name, avatar, banner, banner_color, bio, status, created_at, last_seen FROM users WHERE id = ?', [payload.sub]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

router.patch('/status', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token' });
    }
    const token = authHeader.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const { status } = req.body;
    const allowed = ['online', 'offline'];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const db = await getUserDb();
    run(db, 'UPDATE users SET status = ?, status_updated_at = ? WHERE id = ?',
        [status, Date.now(), payload.sub]);
    res.json({ ok: true, status });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
module.exports.JWT_SECRET = JWT_SECRET;