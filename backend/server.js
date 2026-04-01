require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const Message = require('./models/Message');
const { body } = require('express-validator');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors({ origin: '*' }));
app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.log(err));

// Get message history between two users
app.get('/api/messages/:user1/:user2', async (req, res) => {
  try {
    const { user1, user2 } = req.params;
    const messages = await Message.find({
      $or: [
        { sender: user1, receiver: user2 },
        { sender: user2, receiver: user1 }
      ]
    }).sort({ timestamp: 1 }).limit(100);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark messages as read
app.post('/api/messages/read', async (req, res) => {
  try {
    const { sender, receiver } = req.body;
    await Message.updateMany(
      { sender, receiver, isRead: false },
      { $set: { isRead: true } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all contacts for a user (people they have messaged)
app.get('/api/contacts/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const sentTo = await Message.distinct('receiver', { sender: username });
    const receivedFrom = await Message.distinct('sender', { receiver: username });
    const allContacts = [...new Set([...sentTo, ...receivedFrom])];
    res.json(allContacts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.io logic
let onlineUsers = {}; // username -> socketId mapping

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Login / join
  socket.on('login', async (username) => {
    if (username && username.trim().length > 0) {
      const trimmedUsername = username.trim();
      onlineUsers[trimmedUsername] = socket.id;
      socket.username = trimmedUsername;
      
      console.log(`${trimmedUsername} logged in`);

      // Broadcast updated user list to all
      io.emit('onlineUsers', Object.keys(onlineUsers));
    }
  });

  // Private chat message
  socket.on('privateMessage', async (data) => {
    const { receiver, message } = data;
    if (socket.username && receiver && message) {
      try {
        const newMessage = new Message({
          sender: socket.username,
          receiver: receiver,
          message: message.trim()
        });
        const savedMsg = await newMessage.save();
        const msgObj = savedMsg.toObject();

        console.log('New message saved:', msgObj._id);

        // Send to receiver if online
        const receiverSocketId = onlineUsers[receiver];
        if (receiverSocketId) {
          io.to(receiverSocketId).emit('newPrivateMessage', msgObj);
        }
        
        // Also send back to sender
        socket.emit('newPrivateMessage', msgObj);
      } catch (err) {
        console.error('Error saving private message:', err);
      }
    }
  });

  // Edit message
  socket.on('editMessage', async (data) => {
    console.log('Edit request received:', data);
    const { messageId, newMessage } = data;
    try {
      const msg = await Message.findById(messageId);
      if (!msg) {
        console.log('Message not found for edit:', messageId);
        return;
      }
      if (msg.sender !== socket.username) {
        console.log('Unauthorized edit attempt by:', socket.username);
        return;
      }

      msg.message = newMessage.trim();
      msg.isEdited = true;
      const savedMsg = await msg.save();
      const msgObj = savedMsg.toObject();
      
      console.log('Message updated in DB, broadcasting ID:', msgObj._id);
      // Notify receiver
      const receiverSocketId = onlineUsers[msgObj.receiver];
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('messageUpdate', msgObj);
      }
      // Notify sender
      socket.emit('messageUpdate', msgObj);
    } catch (err) {
      console.error('Error editing message:', err);
    }
  });

  // Delete message
  socket.on('deleteMessage', async (messageId) => {
    console.log('Delete request received for ID:', messageId);
    try {
      const msg = await Message.findById(messageId);
      if (!msg) {
        console.log('Message not found for delete:', messageId);
        return;
      }
      if (msg.sender !== socket.username) {
        console.log('Unauthorized delete attempt by:', socket.username);
        return;
      }

      const receiver = msg.receiver;
      await Message.findByIdAndDelete(messageId);
      
      console.log('Message deleted from DB, broadcasting ID:', messageId);
      // Notify receiver
      const receiverSocketId = onlineUsers[receiver];
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('messageDelete', messageId);
      }
      // Notify sender
      socket.emit('messageDelete', messageId);
    } catch (err) {
      console.error('Error deleting message:', err);
    }
  });

  // Forward message
  socket.on('forwardMessage', async (data) => {
    console.log('Forward request received:', data);
    const { receiver, message } = data;
    if (socket.username && receiver && message) {
      try {
        const newMessage = new Message({
          sender: socket.username,
          receiver: receiver,
          message: message.trim(),
          isForwarded: true
        });
        const savedMsg = await newMessage.save();
        const msgObj = savedMsg.toObject();

        console.log('Forwarded message saved, broadcasting ID:', msgObj._id);
        const receiverSocketId = onlineUsers[receiver];
        if (receiverSocketId) {
          io.to(receiverSocketId).emit('newPrivateMessage', msgObj);
        }
        socket.emit('newPrivateMessage', msgObj);
      } catch (err) {
        console.error('Error saving forward message:', err);
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      // Only delete if this socket is the one registered for this username
      if (onlineUsers[socket.username] === socket.id) {
        delete onlineUsers[socket.username];
      }
      io.emit('onlineUsers', Object.keys(onlineUsers));
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

