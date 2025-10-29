// --- Connect to Socket.IO Server ---
// --- TODO #1: Replace 'localhost' with your public backend URL from Render ---
const socket = io('https://telehealth-lxj1.onrender.com'); 

// --- Log connection status ---
socket.on('connect', () => {
  console.log('Successfully connected to signaling server with ID:', socket.id);
});
socket.on('connect_error', (err) => {
  console.error('Failed to connect to signaling server:', err.message);
  setStatus('Error: Could not connect to server. Please refresh.');
});

// --- Get Backend URL for API calls ---
// This makes sure we call the same server our socket is on
const BACKEND_URL = socket.io.uri; 

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
// We will fetch this from our backend
let iceServers = [
  {
    urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
  },
];


// --- Function to fetch TURN credentials ---
async function getIceServers() {
  try {
    // Use Date.now() to prevent caching
    const response = await fetch(`${BACKEND_URL}/api/ice-servers?_=${Date.now()}`);
    if (!response.ok) {
      throw new Error('Failed to fetch ICE servers');
    }
    const twilioIceServers = await response.json();
    
    if (twilioIceServers && twilioIceServers.length > 0) {
      iceServers = [
        ...iceServers, // The STUN servers
        ...twilioIceServers, // The TURN servers from Twilio
      ];
    }
    console.log('Using ICE servers:', iceServers);
  } catch (error) {
    console.error(error);
    console.warn("Warning: Could not get TURN server credentials. Call may fail on some networks.");
  }
}


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
    // Only get stream if we don't already have one or it's stopped
    if (!localStream || localStream.getTracks().every(t => t.readyState === 'ended')) {
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

async function createPeerConnection(partnerSocketId, partnerName = 'User') {
  currentCallPartnerId = partnerSocketId;
  currentCallPartnerName = partnerName;

  if (!localStream) {
    console.error("Local stream is not available.");
    alert("Error: Your camera is not active. Please start your camera again.");
    return false;
  }
  
  // Make sure we have the latest TURN servers
  await getIceServers();

  peerConnection = new RTCPeerConnection({ iceServers: iceServers });

  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = (event) => {
    console.log('Received remote track:', event.track.kind);
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
    }
    remoteStream.addTrack(event.track);
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('send-ice-candidate', {
        toId: currentCallPartnerId,
        candidate: event.candidate,
      });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    console.log('Connection state change:', peerConnection.connectionState);
    if (
      peerConnection.connectionState === 'disconnected' ||
      peerConnection.connectionState === 'closed' ||
      peerConnection.connectionState === 'failed'
    ) {
      if (body.className.includes('in-call')) {
        if(document.getElementById('doctor-page')) {
          handleDoctorCallEnd();
        } else {
          handlePatientCallEnd();
        }
      }
    }
  };
  
  return true;
}

function cleanUpCall() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  remoteVideo.srcObject = null;
  if (remoteStream) {
    remoteStream.getTracks().forEach((track) => track.stop());
    remoteStream = null;
  }
  
  if (currentCallPartnerId) {
    socket.emit('hang-up', { toId: currentCallPartnerId });
    currentCallPartnerId = null;
    currentCallPartnerName = null;
  }
}

// --- Role-specific call end handlers ---

function handleDoctorCallEnd() {
  console.log('Call ended by Doctor.');
  cleanUpCall();
  setUiState('waiting');
  setStatus('Call ended. Waiting for patients...');
  
  const lobbyList = document.getElementById('lobbyList');
  if (lobbyList) {
    lobbyList.querySelectorAll('button').forEach(btn => btn.disabled = false);
  }
}

function handlePatientCallEnd() {
  console.log('Call ended by Patient.');
  cleanUpCall();
  setUiState('waiting');
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
    
    console.log(`Doctor joining room: ${roomId}`);
    socket.emit('doctor-join-room', roomId);
    setUiState('waiting');
    setStatus(`Office is open. Waiting for patients in room: ${roomId}`);
  };

  socket.on('lobby-updated', (patients) => {
    console.log('Lobby updated:', patients);
    
    if(body.className.includes('in-call') || body.className.includes('ringing')) return;

    lobbyList.innerHTML = '';
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
          console.log(`Doctor calling patient: ${patient.name}`);
          const connectionStarted = await createPeerConnection(patient.socketId, patient.name);
          
          if (!connectionStarted) return; 

          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          
          console.log('Sending offer to patient...');
          socket.emit('offer-to-patient', {
            toPatientId: patient.socketId,
            offer: offer,
          });
          
          setUiState('ringing');
          setStatus(`Calling ${patient.name}...`);
          
          lobbyList.querySelectorAll('button').forEach(btn => btn.disabled = true);
        };
        li.appendChild(callButton);
        lobbyList.appendChild(li);
      });
    }
  });

  socket.on('call-answered-by-patient', async (data) => {
    console.log('Call answered by patient. Setting remote description.');
    if (!peerConnection) return;
    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(data.answer)
    );
    setUiState('in-call');
    setStatus(`In call with ${currentCallPartnerName || 'Patient'}`);
  });
  
  socket.on('call-declined-by-patient', () => {
    console.log('Patient declined the call.');
    setStatus('Patient declined the call. Waiting for patients...');
    setUiState('waiting');
    const lobbyList = document.getElementById('lobbyList');
    if (lobbyList) {
      lobbyList.querySelectorAll('button').forEach(btn => btn.disabled = false);
    }
  });


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
  
  const answerButton = document.getElementById('answerButton');
  const declineButton = document.getElementById('declineButton');
  const ringingStatus = document.getElementById('ringingStatus');
  let incomingCallData = null;


  startCameraButton.onclick = startLocalCamera;
  
  checkInButton.onclick = () => {
    const patientName = nameInput.value;
    const doctorRoomId = doctorRoomIdInput.value;
    if (!patientName) return alert('Please enter your name');
    if (!doctorRoomId) return alert("Please enter the Doctor's Room ID");
    if (!localStream) return alert('Please start your camera first');
    
    console.log(`Patient checking in to room: ${doctorRoomId}`);
    socket.emit('patient-check-in', {
      doctorRoomId: doctorRoomId,
      patientInfo: { name: patientName },
    });
    setUiState('waiting');
    setStatus('You are in the waiting room. The doctor will call you soon.');
  };
  
  socket.on('call-incoming-from-doctor', async (data) => {
    console.log('Receiving call from doctor...');
    if (peerConnection) {
      console.warn("Already in a call, rejecting new one.");
      // socket.emit('call-rejected', { toDoctorId: data.fromDoctorId, reason: 'busy' });
      return; 
    }
    
    incomingCallData = data;
    if (ringingStatus) {
      ringingStatus.textContent = 'The Doctor is calling...';
    }
    setUiState('ringing');
    setStatus('Incoming call...'); // This status is hidden, but good to set
  });
  
  answerButton.onclick = async () => {
    console.log('Patient answering call...');
    if (!incomingCallData) return;
    
    const { fromDoctorId, offer } = incomingCallData;
    incomingCallData = null;
    
    const connectionStarted = await createPeerConnection(fromDoctorId, 'Doctor');
    if (!connectionStarted) {
      setUiState('waiting');
      return; 
    }
    
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    console.log('Sending answer to doctor...');
    socket.emit('answer-to-doctor', {
      toDoctorId: fromDoctorId,
      answer: answer,
    });
    
    setUiState('in-call');
    setStatus('Connected to the doctor.');
  };

  declineButton.onclick = () => {
    console.log('Patient declining call.');
    if (incomingCallData) {
      socket.emit('call-declined-by-patient', { toDoctorId: incomingCallData.fromDoctorId });
      incomingCallData = null;
    }
    setUiState('waiting');
    setStatus('Call declined. Waiting for the doctor...');
  };
  
  
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

