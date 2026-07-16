const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { getUserDb, all, get, run } = require('./userDb');
const { requireAuth } = require('./middleware');

// Ensure avatar and banner directories exist
const AVATAR_DIR = path.join(__dirname, '..', 'data', 'avatars');
const BANNER_DIR = path.join(__dirname, '..', 'data', 'banners');
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
if (!fs.existsSync(BANNER_DIR)) fs.mkdirSync(BANNER_DIR, { recursive: true });

// Configure multer for avatars
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATAR_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = req.user.id + '-' + Date.now() + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// Configure multer for banners (images or gifs, slightly larger limit for gifs)
const bannerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, BANNER_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = req.user.id + '-' + Date.now() + ext;
    cb(null, name);
  }
});
const uploadBanner = multer({
  storage: bannerStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// GET /api/users/search
router.get('/search', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ users: [] });
  const users = all(db, `
    SELECT id, username, display_name, avatar, banner, banner_color, bio, last_seen, status
    FROM users
    WHERE (username LIKE ? OR display_name LIKE ?) AND id != ?
    LIMIT 20
  `, [`%${q}%`, `%${q}%`, req.user.id]);
  res.json({ users });
});

// GET /api/users/:id
router.get('/:id', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const user = get(db, 'SELECT id, username, display_name, avatar, banner, banner_color, bio, status, created_at, last_seen FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// PATCH /api/users/me – update profile (username, email, display_name, bio, password)
router.patch('/me', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const { username, email, display_name, bio, banner_color, current_password, new_password } = req.body;
  const userId = req.user.id;

  // Start building updates
  const updates = [];
  const params = [];

  // Username change
  if (username !== undefined) {
    const trimmed = username.trim();
    if (!/^[a-zA-Z0-9_-]{3,30}$/.test(trimmed)) {
      return res.status(400).json({ error: 'Username must be 3-30 characters (letters, numbers, _ or -).' });
    }
    const reserved = ['admin', 'root', 'system', 'nyxie', 'support'];
    if (reserved.includes(trimmed.toLowerCase())) {
      return res.status(400).json({ error: 'Username not available' });
    }
    // Check uniqueness
    const existing = get(db, 'SELECT id FROM users WHERE username = ? AND id != ?', [trimmed, userId]);
    if (existing) return res.status(409).json({ error: 'Username already taken' });
    updates.push('username = ?');
    params.push(trimmed);
  }

  // Email change
  if (email !== undefined) {
    const trimmedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    const existingEmail = get(db, 'SELECT id FROM users WHERE email = ? AND id != ?', [trimmedEmail, userId]);
    if (existingEmail) return res.status(409).json({ error: 'Email already registered' });
    updates.push('email = ?');
    params.push(trimmedEmail);
  }

  // Display name
  if (display_name !== undefined) {
    const trimmed = display_name.trim();
    if (trimmed.length > 64) return res.status(400).json({ error: 'Display name too long (max 64)' });
    updates.push('display_name = ?');
    params.push(trimmed || req.user.username);
  }

  // Bio
  if (bio !== undefined) {
    const trimmed = bio.trim();
    if (trimmed.length > 500) return res.status(400).json({ error: 'Bio too long (max 500 chars)' });
    updates.push('bio = ?');
    params.push(trimmed || null);
  }

  // Banner color — a flat CSS color used when no banner image/gif is set.
  // Sending banner_color clears any uploaded banner image so the two stay mutually exclusive.
  if (banner_color !== undefined) {
    const trimmed = (banner_color || '').trim();
    const isHex = /^#[0-9a-fA-F]{3,8}$/.test(trimmed);
    const isRgb = /^rgba?\([\d.,\s%]+\)$/.test(trimmed);
    if (trimmed && !isHex && !isRgb) {
      return res.status(400).json({ error: 'Invalid banner color' });
    }
    updates.push('banner_color = ?');
    params.push(trimmed || null);
    if (trimmed) {
      const oldUser = get(db, 'SELECT banner FROM users WHERE id = ?', [userId]);
      if (oldUser && oldUser.banner) {
        const oldPath = path.join(__dirname, '..', 'data', 'banners', path.basename(oldUser.banner));
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      updates.push('banner = ?');
      params.push(null);
    }
  }

  // Password change
  if (current_password !== undefined || new_password !== undefined) {
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Both current and new password are required to change password' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    // Verify current password
    const user = get(db, 'SELECT password_hash FROM users WHERE id = ?', [userId]);
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const newHash = await bcrypt.hash(new_password, 10);
    updates.push('password_hash = ?');
    params.push(newHash);
  } else if (email !== undefined) {
    // Email changes are sensitive — require current password even when not also changing password
    if (!current_password) {
      return res.status(400).json({ error: 'Current password is required to change email' });
    }
    const user = get(db, 'SELECT password_hash FROM users WHERE id = ?', [userId]);
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  params.push(userId);
  const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
  run(db, sql, params);

  // Fetch updated user to return
  const updated = get(db, 'SELECT id, username, email, display_name, avatar, banner, banner_color, bio, status FROM users WHERE id = ?', [userId]);
  res.json({ ok: true, user: updated });
});

// PATCH /api/users/status – only online/offline
router.patch('/status', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const { status } = req.body;
  const allowed = ['online', 'offline'];
  if (!status || !allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  run(db, 'UPDATE users SET status = ?, status_updated_at = ? WHERE id = ?',
      [status, Date.now(), req.user.id]);
  res.json({ ok: true, status });
});

// POST /api/users/avatar – upload avatar
router.post('/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }
  const avatarPath = '/avatars/' + req.file.filename;
  const db = await getUserDb();
  // Delete old avatar if exists (avatars live in data/avatars, not public/)
  const oldUser = get(db, 'SELECT avatar FROM users WHERE id = ?', [req.user.id]);
  if (oldUser && oldUser.avatar) {
    const oldPath = path.join(AVATAR_DIR, path.basename(oldUser.avatar));
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  run(db, 'UPDATE users SET avatar = ? WHERE id = ?', [avatarPath, req.user.id]);
  req.user.avatar = avatarPath;
  res.json({ ok: true, avatar: avatarPath });
});

// POST /api/users/banner – upload a banner image or gif
router.post('/banner', requireAuth, uploadBanner.single('banner'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }
  const bannerPath = '/banners/' + req.file.filename;
  const db = await getUserDb();
  // Delete old banner file if exists, and clear any flat banner_color so the two stay mutually exclusive
  const oldUser = get(db, 'SELECT banner FROM users WHERE id = ?', [req.user.id]);
  if (oldUser && oldUser.banner) {
    const oldPath = path.join(BANNER_DIR, path.basename(oldUser.banner));
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  run(db, 'UPDATE users SET banner = ?, banner_color = NULL WHERE id = ?', [bannerPath, req.user.id]);
  req.user.banner = bannerPath;
  res.json({ ok: true, banner: bannerPath });
});

// DELETE /api/users/banner – remove banner (reverts to default)
router.delete('/banner', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const oldUser = get(db, 'SELECT banner FROM users WHERE id = ?', [req.user.id]);
  if (oldUser && oldUser.banner) {
    const oldPath = path.join(BANNER_DIR, path.basename(oldUser.banner));
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  run(db, 'UPDATE users SET banner = NULL, banner_color = NULL WHERE id = ?', [req.user.id]);
  res.json({ ok: true });
});

// POST /api/users/disable – temporarily disable own account (requires password)
router.post('/disable', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password is required' });

  const user = get(db, 'SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Incorrect password' });

  run(db, "UPDATE users SET disabled = 1, status = 'offline' WHERE id = ?", [req.user.id]);
  res.json({ ok: true });
});

// DELETE /api/users/me – permanently delete own account (requires password)
router.delete('/me', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password is required' });

  const user = get(db, 'SELECT password_hash, avatar, banner FROM users WHERE id = ?', [req.user.id]);
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Incorrect password' });

  const userId = req.user.id;

  // Clean up avatar and banner files (these live in data/avatars and data/banners, not public/)
  if (user.avatar) {
    const avatarPath = path.join(AVATAR_DIR, path.basename(user.avatar));
    if (fs.existsSync(avatarPath)) fs.unlinkSync(avatarPath);
  }
  if (user.banner) {
    const bannerPath = path.join(BANNER_DIR, path.basename(user.banner));
    if (fs.existsSync(bannerPath)) fs.unlinkSync(bannerPath);
  }

  // Remove memberships, friendships, friend requests, and leave DMs/channels
  run(db, 'DELETE FROM room_members WHERE user_id = ?', [userId]);
  run(db, 'DELETE FROM server_members WHERE user_id = ?', [userId]);
  run(db, 'DELETE FROM friends WHERE user_a = ? OR user_b = ?', [userId, userId]);
  run(db, 'DELETE FROM friend_requests WHERE from_id = ? OR to_id = ?', [userId, userId]);
  run(db, 'DELETE FROM users WHERE id = ?', [userId]);

  res.json({ ok: true });
});

module.exports = router;