// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// --- NEW: Load environment variables ---
require('dotenv').config(); 
// --- NEW: Import Twilio ---
const twilio = require('twilio');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*', // Allow all origins for development
    methods: ['GET', 'POST'],
  },
});

// --- NEW: Securely get Twilio credentials from .env or Render ---
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

// --- NEW: Create a Twilio client ---
// Only create the client if credentials are provided
let twilioClient;
if (accountSid && authToken) {
  twilioClient = twilio(accountSid, authToken);
} else {
  console.warn('Twilio credentials not found. TURN server will not be available.');
}

// --- NEW: API Endpoint for Frontend ---
// This is a new route your frontend will call
app.get('/api/ice-servers', async (req, res) => {
  if (!twilioClient) {
    // If Twilio isn't set up, just return an empty array
    // The frontend will still use the public STUN servers
    return res.json([]);
  }
  
  try {
    // Ask Twilio to generate temporary TURN server credentials
    const token = await twilioClient.tokens.create();
    // Send them to the frontend
    res.json(token.iceServers);
  } catch (error) {
    console.error('Error fetching Twilio ICE servers:', error);
    res.status(500).json({ error: 'Failed to get ICE servers' });
  }
});


console.log('Server starting...');

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // --- Doctor Logic ---
  socket.on('doctor-join-room', (roomId) => {
    socket.join(roomId);
    socket.isDoctor = true;
    socket.roomId = roomId; // Store room on the socket for later
    console.log(`Doctor ${socket.id} joined room: ${roomId}`);

    // Create the lobby if it doesn't exist
    if (!lobbies[roomId]) {
      lobbies[roomId] = [];
    }

    // Send the current patient list (lobby) to the doctor
    socket.emit('lobby-updated', lobbies[roomId]);
  });

  // --- Patient Logic ---
  socket.on('patient-check-in', (data) => {
    const { doctorRoomId, patientInfo } = data;
    socket.isDoctor = false;
    socket.patientInfo = patientInfo;
    socket.waitingForRoom = doctorRoomId;

    // Add patient to the lobby
    if (!lobbies[doctorRoomId]) {
      lobbies[doctorRoomId] = [];
    }
    lobbies[doctorRoomId].push({ ...patientInfo, socketId: socket.id });

    // Tell the doctor's room (and only that room) that the lobby has updated
    io.to(doctorRoomId).emit('lobby-updated', lobbies[doctorRoomId]);
    console.log(`Patient ${patientInfo.name} is waiting for doctor ${doctorRoomId}`);
  });

  // --- WebRTC Signaling Logic ---

  // 1. Doctor sends an offer to a *specific* patient
  socket.on('offer-to-patient', (data) => {
    const { toPatientId, offer } = data;
    console.log(`Doctor sending offer to patient ${toPatientId}`);
    io.to(toPatientId).emit('call-incoming-from-doctor', {
      fromDoctorId: socket.id,
      offer: offer,
    });
  });

  // 2. Patient accepts and sends an answer back to the doctor
  socket.on('answer-to-doctor', (data) => {
    const { toDoctorId, answer } = data;
    console.log(`Patient sending answer to doctor ${toDoctorId}`);
    io.to(toDoctorId).emit('call-answered-by-patient', {
      fromPatientId: socket.id,
      answer: answer,
    });
  });

  // 3. General ICE candidate relay for both
  socket.on('send-ice-candidate', (data) => {
    // console.log(`Relaying ICE candidate from ${socket.id} to ${data.toId}`);
    io.to(data.toId).emit('receive-ice-candidate', {
      fromId: socket.id,
      candidate: data.candidate,
    });
  });

  // 4. Handle disconnects
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // If a patient disconnects, remove them from the lobby
    if (!socket.isDoctor && socket.waitingForRoom) {
      const lobby = lobbies[socket.waitingForRoom];
      if (lobby) {
        // Filter out the disconnected patient
        lobbies[socket.waitingForRoom] = lobby.filter(
          (p) => p.socketId !== socket.id
        );
        // Send the updated lobby to the doctor
        io.to(socket.waitingForRoom).emit(
          'lobby-updated',
          lobbies[socket.waitingForRoom]
        );
      }
    }
    
    // Also, if a call is in progress, you need to tell the other user.
    io.to(socket.callPartner).emit('call-ended');
  });

  socket.on('hang-up', (data) => {
    console.log(`Hang up signal from ${socket.id} to ${data.toId}`);
    io.to(data.toId).emit('call-ended');
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Signaling server listening on *:${PORT}`);
});

