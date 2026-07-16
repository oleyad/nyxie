require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const { setupWebSocket } = require('./src/websocket');
const authRoutes = require('./src/auth');
const userRoutes = require('./src/users');
const roomRoutes = require('./src/rooms');
const serverRoutes = require('./src/servers');
const friendRoutes = require('./src/friends');
const { getUserDb } = require('./src/userDb');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded avatars and banners. These live under /data, not /public,
// so without this line requests to /avatars/* and /banners/* 404 even
// though the files were written successfully on upload.
app.use('/avatars', express.static(path.join(__dirname, 'data', 'avatars')));
app.use('/banners', express.static(path.join(__dirname, 'data', 'banners')));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/servers', serverRoutes);
app.use('/api/friends', friendRoutes);

const { broadcast, broadcastToUser } = setupWebSocket(server);
app.locals.broadcast = broadcast;
app.locals.broadcastToUser = broadcastToUser;

getUserDb().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});