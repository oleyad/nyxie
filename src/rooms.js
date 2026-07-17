const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getUserDb, all, get, run } = require('./userDb');
const { getMessageDb, allMessages, getMessage, runMessage } = require('./messageDb');
const { requireAuth } = require('./middleware');

async function getLatestMessages(roomIds) {
  if (!roomIds.length) return {};
  const msgDb = await getMessageDb();
  const rows = allMessages(msgDb, `
    SELECT m.room_id, m.content, m.created_at
    FROM messages m
    WHERE m.deleted = 0
      AND m.created_at = (
        SELECT MAX(created_at) FROM messages
        WHERE room_id = m.room_id AND deleted = 0
      )
      AND m.room_id IN (${roomIds.map(() => '?').join(',')})
  `, roomIds);
  const map = {};
  rows.forEach(row => { map[row.room_id] = { content: row.content, created_at: row.created_at }; });
  return map;
}

router.get('/', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const { server_id } = req.query;

  let rooms;
  if (server_id) {
    rooms = all(db, `
      SELECT r.id, r.name, r.description, r.created_at, r.is_dm,
        (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) AS member_count
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id
      WHERE r.server_id = ? AND r.is_dm = 0 AND rm.user_id = ?
      ORDER BY r.created_at DESC
    `, [server_id, req.user.id]);
  } else {
    rooms = all(db, `
      SELECT r.id, r.name, r.description, r.created_at, r.is_dm,
        (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) AS member_count
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id
      WHERE r.is_dm = 1 AND rm.user_id = ?
      ORDER BY r.created_at DESC
    `, [req.user.id]);
    for (const room of rooms) {
      const members = all(db, `SELECT user_id FROM room_members WHERE room_id = ?`, [room.id]);
      const other = members.find(m => m.user_id !== req.user.id);
      if (other) {
        const otherUser = get(db, 'SELECT display_name, username FROM users WHERE id = ?', [other.user_id]);
        room.display_name = otherUser ? (otherUser.display_name || otherUser.username) : 'Unknown';
        room._otherId = other.user_id;
      } else {
        room.display_name = room.name;
      }
    }
  }

  const roomIds = rooms.map(r => r.id);
  const latestMap = await getLatestMessages(roomIds);
  for (const room of rooms) {
    const latest = latestMap[room.id];
    room.last_message = latest ? latest.content : null;
    room.last_message_at = latest ? latest.created_at : null;
  }

  res.json({ rooms });
});

router.post('/dm', requireAuth, async (req, res) => {
  const db = await getUserDb();
  const { target_user_id } = req.body;
  if (!target_user_id) return res.status(400).json({ error: 'target_user_id required' });
  if (target_user_id === req.user.id) return res.status(400).json({ error: 'Cannot DM yourself' });

  const targetUser = get(db, 'SELECT id, username, display_name FROM users WHERE id = ?', [target_user_id]);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  const existing = get(db, `
    SELECT r.id FROM rooms r
    JOIN room_members rm1 ON rm1.room_id = r.id AND rm1.user_id = ?
    JOIN room_members rm2 ON rm2.room_id = r.id AND rm2.user_id = ?
    WHERE r.is_dm = 1
    AND (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) = 2
    LIMIT 1
  `, [req.user.id, target_user_id]);

  if (existing) return res.json({ room_id: existing.id });

  const roomId = crypto.randomUUID();
  const now = Date.now();
  run(db, 'INSERT INTO rooms (id, name, description, created_by, created_at, is_dm) VALUES (?, ?, ?, ?, ?, 1)',
    [roomId, `dm-${req.user.id}-${target_user_id}`, '', req.user.id, now]);
  run(db, 'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [roomId, req.user.id, now]);
  run(db, 'INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [roomId, target_user_id, now]);

  const initiator = { id: req.user.id, username: req.user.username, display_name: req.user.display_name };
  const target    = { id: targetUser.id, username: targetUser.username, display_name: targetUser.display_name || targetUser.username };
  req.app.locals.broadcastToUser(req.user.id,   { type: 'dm_created', room_id: roomId, with_user: target });
  req.app.locals.broadcastToUser(target_user_id, { type: 'dm_created', room_id: roomId, with_user: initiator });

  res.status(201).json({ room_id: roomId });
});

router.get('/:id/messages', requireAuth, async (req, res) => {
  const userDb = await getUserDb();
  const isMember = get(userDb, 'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!isMember) return res.status(403).json({ error: 'Not a member' });

  const msgDb = await getMessageDb();
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const before = req.query.before ? parseInt(req.query.before) : Date.now() + 1;

  const messages = allMessages(msgDb, `
    SELECT id, room_id, user_id, content, nonce, created_at, edited_at, deleted
    FROM messages
    WHERE room_id = ? AND created_at < ?
    ORDER BY created_at DESC
    LIMIT ?
  `, [req.params.id, before, limit]);

  const userIds = [...new Set(messages.map(m => m.user_id))];
  let userMap = {};
  if (userIds.length) {
    const placeholders = userIds.map(() => '?').join(',');
    const users = all(userDb, `SELECT id, username, display_name FROM users WHERE id IN (${placeholders})`, userIds);
    users.forEach(u => { userMap[u.id] = u; });
  }

  const enriched = messages.map(m => ({
    ...m,
    username: userMap[m.user_id]?.username || 'unknown',
    display_name: userMap[m.user_id]?.display_name || userMap[m.user_id]?.username || 'Unknown'
  }));

  res.json({ messages: enriched.reverse() });
});

router.post('/:id/messages', requireAuth, async (req, res) => {
  const userDb = await getUserDb();
  const isMember = get(userDb, 'SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!isMember) return res.status(403).json({ error: 'Not a member' });

  const { content, ciphertext, nonce } = req.body;
  if (!content && !ciphertext) {
    return res.status(400).json({ error: 'Message content or ciphertext required' });
  }
  const msgContent = content ? content.trim() : ciphertext;
  const msgNonce = nonce || null;

  if (!msgContent) return res.status(400).json({ error: 'Message content required' });
  if (msgContent.length > 4000) return res.status(400).json({ error: 'Message too long' });

  const msgId = crypto.randomUUID();
  const now = Date.now();
  const msgDb = await getMessageDb();
  runMessage(msgDb, 'INSERT INTO messages (id, room_id, user_id, content, nonce, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [msgId, req.params.id, req.user.id, msgContent, msgNonce, now]);

  const message = {
    id: msgId,
    room_id: req.params.id,
    content: msgContent,
    nonce: msgNonce,
    created_at: now,
    user_id: req.user.id,
    username: req.user.username,
    display_name: req.user.display_name
  };

  req.app.locals.broadcast(req.params.id, { type: 'new_message', message });
  res.status(201).json({ message });
});

router.patch('/:roomId/messages/:msgId', requireAuth, async (req, res) => {
  const msgDb = await getMessageDb();
  const msg = getMessage(msgDb, 'SELECT * FROM messages WHERE id = ? AND room_id = ?', [req.params.msgId, req.params.roomId]);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.user_id !== req.user.id) return res.status(403).json({ error: 'Not your message' });
  if (msg.deleted) return res.status(400).json({ error: 'Cannot edit deleted message' });

  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Content required' });

  const now = Date.now();
  runMessage(msgDb, 'UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', [content.trim(), now, msg.id]);

  req.app.locals.broadcast(req.params.roomId, {
    type: 'message_edited',
    message_id: msg.id,
    content: content.trim(),
    edited_at: now
  });
  res.json({ ok: true });
});

router.delete('/:roomId/messages/:msgId', requireAuth, async (req, res) => {
  const msgDb = await getMessageDb();
  const msg = getMessage(msgDb, 'SELECT * FROM messages WHERE id = ? AND room_id = ?', [req.params.msgId, req.params.roomId]);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.user_id !== req.user.id) return res.status(403).json({ error: 'Not your message' });

  runMessage(msgDb, 'UPDATE messages SET deleted = 1, content = \'[deleted]\' WHERE id = ?', [msg.id]);
  req.app.locals.broadcast(req.params.roomId, { type: 'message_deleted', message_id: msg.id });
  res.json({ ok: true });
});

router.post('/:id/leave', requireAuth, async (req, res) => {
  const db = await getUserDb();
  run(db, 'DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

module.exports = router;