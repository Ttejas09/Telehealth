// --- Connect to Socket.IO Server ---
// --- CHANGE THIS: Replace 'localhost' with your public backend URL from Render ---
const socket = io('https://your-backend-url.onrender.com');

// --- Global DOM Elements (Shared) ---
const body = document.body;
const statusBar = document.getElementById('status-bar');
const startCameraButton = document.getElementById('startCameraButton');
const hangUpButton = document.getElementById('hangUpButton');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');

// --- Global State ---
let localStream;
let peerConnection;
let remoteStream;
let currentCallPartnerId; // The socket ID of the person we are in a call with
let currentCallPartnerName; // The name of the person we are in a call with

// --- WebRTC Configuration ---
// --- ADD THIS: Fill in your TURN server credentials from Twilio ---
const servers = {
  iceServers: [
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
    // --- Add your Twilio TURN servers here ---
    // Example:
    // {
    //   urls: 'turn:global.turn.twilio.com:3478?transport=udp',
    //   username: 'YOUR_TWILIO_ACCOUNT_SID',
    //   credential: 'YOUR_TWILIO_AUTH_TOKEN'
    // }
    // --- End of TURN servers ---
  ],
  iceCandidatePoolSize: 10,
};

// --- Helper Functions ---
function setUiState(state) {
  body.className = `state-${state}`;
}

function setStatus(message) {
  statusBar.textContent = message;
}

// --- Shared WebRTC Functions ---

async function startLocalCamera() {
  try {
    // Only get stream if we don't already have one
    if (!localStream || localStream.getTracks().length === 0) {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
    }
    localVideo.srcObject = localStream;
    setUiState('ready');
    setStatus('Camera on. Please proceed.');
  } catch (error) {
    console.error('Error accessing media devices.', error);
    setStatus('Error: Could not access camera or microphone.');
  }
}

function createPeerConnection(partnerSocketId, partnerName = 'User') {
  // Store who we are talking to
  currentCallPartnerId = partnerSocketId;
  currentCallPartnerName = partnerName;

  // --- FIX: Check for localStream FIRST ---
  if (!localStream) {
    console.error("Local stream is not available to add to peer connection.");
    alert("Error: Your camera is not active. Please start your camera again.");
    return false; // Stop if camera isn't working
  }

  peerConnection = new RTCPeerConnection(servers);

  // Add local video/audio tracks to the connection
  // Now we know localStream exists
  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  // --- UPDATED 'ontrack' HANDLER ---
  // This is the robust, modern way to handle incoming video/audio
  peerConnection.ontrack = (event) => {
    console.log('Received remote track:', event.track.kind);
    // Create the remote stream if it doesn't exist
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
    }
    
    // Add the incoming track (either audio or video) to the stream
    remoteStream.addTrack(event.track);
  };

  // Find network paths (candidates) and send them to the other user
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('send-ice-candidate', {
        toId: currentCallPartnerId,
        candidate: event.candidate,
      });
    }
  };

  // Listen for the connection to close
  peerConnection.onconnectionstatechange = () => {
    if (
      peerConnection.connectionState === 'disconnected' ||
      peerConnection.connectionState === 'closed' ||
      peerConnection.connectionState === 'failed'
    ) {
      if (body.className === 'state-in-call') {
        // Find the correct handler to reset the UI
        if(document.getElementById('doctor-page')) {
          handleDoctorCallEnd();
        } else {
          handlePatientCallEnd();
        }
      }
    }
  };
  
  return true; // <-- Report success
}

/**
 * --- MODIFIED HANGUP ---
 * This function is now ONLY responsible for cleaning up an active call.
 * It NO LONGER stops the local camera stream.
 * It NO LONGER manages the UI state (the caller does).
 */
function cleanUpCall() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  // Stop ONLY the remote stream
  remoteVideo.srcObject = null;
  if (remoteStream) {
    remoteStream.getTracks().forEach((track) => track.stop());
    remoteStream = null;
  }
  
  // Tell the other user
  if (currentCallPartnerId) {
    socket.emit('hang-up', { toId: currentCallPartnerId });
    currentCallPartnerId = null;
    currentCallPartnerName = null;
  }
}

// --- Role-specific call end handlers ---

function handleDoctorCallEnd() {
  cleanUpCall(); // Clean up the call
  setUiState('waiting'); // Go back to lobby
  setStatus('Call ended. Waiting for patients...');
  
  // Re-enable lobby buttons
  const lobbyList = document.getElementById('lobbyList');
  if (lobbyList) {
    // This check is to prevent errors if the lobby isn't visible
    lobbyList.querySelectorAll('button').forEach(btn => btn.disabled = false);
  }
}

function handlePatientCallEnd() {
  cleanUpCall(); // Clean up the call
  setUiState('waiting'); // Go back to waiting room
  setStatus('Call ended. The doctor will call you again if needed.');
}


// --- Main Logic: Check which page we are on ---

if (document.getElementById('doctor-page')) {
  // --- DOCTOR PAGE LOGIC ---
  const joinRoomButton = document.getElementById('joinRoomButton');
  const roomIdInput = document.getElementById('roomIdInput');
  const lobbyList = document.getElementById('lobbyList');

  startCameraButton.onclick = startLocalCamera;

  joinRoomButton.onclick = () => {
    const roomId = roomIdInput.value;
    if (!roomId) return alert('Please enter an Office Room ID');
    if (!localStream) return alert('Please start your camera first');

    socket.emit('doctor-join-room', roomId);
    setUiState('waiting');
    setStatus(`Office is open. Waiting for patients in room: ${roomId}`);
  };

  socket.on('lobby-updated', (patients) => {
    // Don't update lobby if in a call
    if(body.className.includes('in-call') || body.className.includes('ringing')) return;

    lobbyList.innerHTML = ''; // Clear list
    if (patients.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No patients in the waiting room.';
      lobbyList.appendChild(li);
    } else {
      patients.forEach((patient) => {
        const li = document.createElement('li');
        li.textContent = patient.name;
        const callButton = document.createElement('button');
        callButton.textContent = 'Call';
        callButton.className = 'btn btn-primary';
        callButton.onclick = async () => {
          // Start the call
          // --- FIX: Check the return value ---
          const connectionStarted = createPeerConnection(patient.socketId, patient.name);
          
          // Check if peerConnection was created successfully
          if (!connectionStarted) return; 

          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          
          socket.emit('offer-to-patient', {
            toPatientId: patient.socketId,
            offer: offer,
          });
          
          // --- DOCTOR'S 'RINGING' STATE ---
          setUiState('ringing');
          setStatus(`Calling ${patient.name}...`);
          
          // Disable lobby buttons to prevent multiple calls
          lobbyList.querySelectorAll('button').forEach(btn => btn.disabled = true);
        };
        li.appendChild(callButton);
        lobbyList.appendChild(li);
      });
    }
  });

  socket.on('call-answered-by-patient', async (data) => {
    if (!peerConnection) return; // Call might have been cancelled
    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(data.answer)
    );
    setUiState('in-call');
    setStatus(`In call with ${currentCallPartnerName || 'Patient'}`);
  });

  // Use the new role-specific handler
  hangUpButton.onclick = handleDoctorCallEnd;
  socket.on('call-ended', handleDoctorCallEnd);
  
  socket.on('receive-ice-candidate', (data) => {
    if (peerConnection) {
      try {
        peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.error('Error adding received ice candidate', e);
      }
    }
  });

} else if (document.getElementById('patient-page')) {
  // --- PATIENT PAGE LOGIC ---
  const checkInButton = document.getElementById('checkInButton');
  const nameInput = document.getElementById('nameInput');
  const doctorRoomIdInput = document.getElementById('doctorRoomIdInput');
  
  // --- NEW: Get Answer/Decline buttons ---
  const answerButton = document.getElementById('answerButton');
  const declineButton = document.getElementById('declineButton');

  // --- NEW: Store incoming call data ---
  let incomingCallData = null;


  startCameraButton.onclick = startLocalCamera;
  
  checkInButton.onclick = () => {
    const patientName = nameInput.value;
    const doctorRoomId = doctorRoomIdInput.value;
    if (!patientName) return alert('Please enter your name');
    if (!doctorRoomId) return alert("Please enter the Doctor's Room ID");
    if (!localStream) return alert('Please start your camera first');

    socket.emit('patient-check-in', {
      doctorRoomId: doctorRoomId,
      patientInfo: { name: patientName },
    });
    setUiState('waiting');
    setStatus('You are in the waiting room. The doctor will call you soon.');
  };
  
  // --- REPLACED confirm() WITH UI STATE ---
  socket.on('call-incoming-from-doctor', async (data) => {
    // Don't allow a call if already in one
    if (peerConnection) {
      console.warn("Already in a call, rejecting new one.");
      return; 
    }
    
    // Store call data and show the ringing UI
    incomingCallData = data;
    setUiState('ringing');
    setStatus('The doctor is calling...');
  });
  
  // --- NEW: Handle Answer Button ---
  answerButton.onclick = async () => {
    if (!incomingCallData) return;
    
    const { fromDoctorId, offer } = incomingCallData;
    incomingCallData = null; // Clear incoming call data
    
    // --- FIX: Check return value ---
    const connectionStarted = createPeerConnection(fromDoctorId, 'Doctor');
    if (!connectionStarted) {
      setUiState('waiting'); // Go back to waiting if camera fails
      return; 
    }
    
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    socket.emit('answer-to-doctor', {
      toDoctorId: fromDoctorId,
      answer: answer,
    });
    
    setUiState('in-call');
    setStatus('Connected to the doctor.');
  };

  // --- NEW: Handle Decline Button ---
  declineButton.onclick = () => {
    if (incomingCallData) {
      // You could emit a 'call-rejected' signal here
      // socket.emit('call-rejected', { toDoctorId: incomingCallData.fromDoctorId });
      incomingCallData = null;
    }
    setUiState('waiting');
    setStatus('Call declined. Waiting for the doctor...');
  };
  
  
  // Use the new role-specific handler
  hangUpButton.onclick = handlePatientCallEnd;
  socket.on('call-ended', handlePatientCallEnd);
  
  socket.on('receive-ice-candidate', (data) => {
    if (peerConnection) {
      try {
        peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.error('Error adding received ice candidate', e);
      }
    }
  });
}

