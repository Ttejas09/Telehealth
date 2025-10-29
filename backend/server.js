// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const twilio = require('twilio');
// Load environment variables from .env file
require('dotenv').config(); 

const twilioClient = require('twilio')(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const app = express();
const server = http.createServer(app);

// Enable CORS for all routes
// This is important for the API route
const cors = require('cors');
app.use(cors({
  origin: '*' // Allow all origins for development
}));


const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// --- THIS IS THE FIX ---
// This object will store our waiting rooms (lobbies)
const lobbies = {};
// ----------------------

console.log('Server starting...');

// --- API Endpoint for TURN Credentials ---
app.get('/api/ice-servers', async (req, res) => {
  try {
    const token = await twilioClient.tokens.create();
    // 'token.iceServers' includes STUN and TURN
    res.json(token.iceServers); 
  } catch (error) {
    console.error('Error fetching Twilio ICE servers:', error);
    res.status(500).json({ error: 'Failed to fetch ICE servers' });
  }
});


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
    if (!lobbies[doctorRoomId]) { // This was the line that crashed
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
    io.to(data.toId).emit('receive-ice-candidate', {
      fromId: socket.id,
      candidate: data.candidate,
    });
  });
  
  // 4. Patient declines the call
  socket.on('call-declined-by-patient', (data) => {
    console.log(`Patient declined call from doctor ${data.toDoctorId}`);
    io.to(data.toDoctorId).emit('call-declined-by-patient');
  });

  // 5. Handle disconnects
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // If a patient disconnects, remove them from the lobby
    if (!socket.isDoctor && socket.waitingForRoom) {
      const lobby = lobbies[socket.waitingForRoom];
      if (lobby) {
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

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Signaling server listening on *:${PORT}`);
});
