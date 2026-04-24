const videoElement = document.getElementById('input-video');
const canvasElement = document.getElementById('output-canvas');
const canvasCtx = canvasElement.getContext('2d');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const systemDot = document.getElementById('system-dot');
const systemText = document.getElementById('system-text');
const driverStatus = document.getElementById('driver-status');
const driverStatusText = driverStatus.querySelector('h2');
const earValueEl = document.getElementById('ear-value');
const earBar = document.getElementById('ear-bar');
const marValueEl = document.getElementById('mar-value');
const marBar = document.getElementById('mar-bar');
const logsContainer = document.getElementById('logs-container');
const alarmAudio = document.getElementById('alarm-audio');
const loadingSpinner = document.getElementById('loading-spinner');
const timerOverlay = document.getElementById('timer-overlay');
const timerValue = document.getElementById('timer-value');
const msSound = document.getElementById('ms-sound');
const msSMS = document.getElementById('ms-sms');
const msCapture = document.getElementById('ms-capture');
const msSoundFill = document.getElementById('ms-sound-fill');
const msSMSFill = document.getElementById('ms-sms-fill');
const msCaptureFill = document.getElementById('ms-capture-fill');

// Location Elements
const locationStatus = document.getElementById('location-status');
const locationCoords = document.getElementById('location-coords');
const locationLat = document.getElementById('location-lat');
const locationLon = document.getElementById('location-lon');
const locationAddress = document.getElementById('location-address');
const addressText = document.getElementById('address-text');

// Configuration
const CONFIG = {
    EYE_AR_THRESH: 0.28,
    MOUTH_AR_THRESH: 0.60,
    ALARM_TIME: 2000,   // 2 seconds
    SMS_TIME: 5000,     // 5 seconds
    CAPTURE_TIME: 10000 // 10 seconds
};

// State
let isRunning = false;
let eyeClosedStartTime = null;
let isAlertActive = false;
let smsSent = false;
let photosTaken = 0;
let lastCaptureTime = 0;
let currentLocation = null;
let locationWatcher = null;
let lastSpeechAlertTime = 0;
let currentLanguage = null;
let lastAlertAddress = null;

// Landmarks Indices (same as Python)
const LEFT_EYE_IDX = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE_IDX = [362, 385, 387, 263, 373, 380];
const MOUTH_IDX = [61, 81, 311, 291, 308, 415, 402, 317, 14, 87, 178, 95];

// Helper: Euclidean Distance
function euclideanDistance(pt1, pt2) {
    return Math.sqrt(Math.pow(pt1.x - pt2.x, 2) + Math.pow(pt1.y - pt2.y, 2));
}

// Helper: Eye Aspect Ratio
function getEAR(landmarks, indices) {
    const p1 = landmarks[indices[1]];
    const p5 = landmarks[indices[5]];
    const p2 = landmarks[indices[2]];
    const p4 = landmarks[indices[4]];
    const p0 = landmarks[indices[0]];
    const p3 = landmarks[indices[3]];

    const A = euclideanDistance(p1, p5);
    const B = euclideanDistance(p2, p4);
    const C = euclideanDistance(p0, p3);

    return (A + B) / (2.0 * C);
}

// Helper: Mouth Aspect Ratio
function getMAR(landmarks, indices) {
    const A = euclideanDistance(landmarks[indices[2]], landmarks[indices[10]]);
    const B = euclideanDistance(landmarks[indices[4]], landmarks[indices[8]]);
    const C = euclideanDistance(landmarks[indices[0]], landmarks[indices[6]]);

    return (A + B) / (2.0 * C);
}

function log(msg, type = 'text', data = null) {
    const now = new Date();
    const time = now.toLocaleTimeString();

    if (type === 'image' && data) {
        const div = document.createElement('div');
        div.className = 'log-entry image-entry';
        div.innerHTML = `<span style="color: #8899A6;">[${time}] ${msg}</span><br><img src="${data}" style="width: 100px; border-radius: 5px; margin-top: 5px; border: 1px solid #00f2fe;">`;
        logsContainer.insertBefore(div, logsContainer.firstChild);
    } else {
        const p = document.createElement('p');
        p.className = 'log-entry';
        p.innerText = `[${time}] ${msg}`;
        logsContainer.insertBefore(p, logsContainer.firstChild);
    }
}

// MediaPipe Setup
const faceMesh = new FaceMesh({
    locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
    }
});

faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
});

faceMesh.onResults(onResults);

// Camera Setup
const camera = new Camera(videoElement, {
    onFrame: async () => {
        if (isRunning) {
            await faceMesh.send({ image: videoElement });
        }
    },
    width: 640,
    height: 480
});

function onResults(results) {
    // Draw Video
    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];

        // Draw Mesh
        drawConnectors(canvasCtx, landmarks, FACEMESH_TESSELATION, { color: '#C0C0C070', lineWidth: 0.5 });
        drawConnectors(canvasCtx, landmarks, FACEMESH_RIGHT_EYE, { color: '#00F2FE', lineWidth: 1 });
        drawConnectors(canvasCtx, landmarks, FACEMESH_LEFT_EYE, { color: '#00F2FE', lineWidth: 1 });
        drawConnectors(canvasCtx, landmarks, FACEMESH_LIPS, { color: '#FF9068', lineWidth: 1 });

        // ---------------- LOGIC ----------------
        const leftEar = getEAR(landmarks, LEFT_EYE_IDX);
        const rightEar = getEAR(landmarks, RIGHT_EYE_IDX);
        const ear = (leftEar + rightEar) / 2.0;

        const mar = getMAR(landmarks, MOUTH_IDX);

        updateMetrics(ear, mar);
        checkDrowsiness(ear);

    } else {
        // No face detected
        if (isAlertActive) stopAlert();
    }

    canvasCtx.restore();
}

function updateMetrics(ear, mar) {
    earValueEl.innerText = ear.toFixed(3);
    marValueEl.innerText = mar.toFixed(3);

    // Update bars
    earBar.style.width = `${Math.min(ear * 250, 100)}%`;
    marBar.style.width = `${Math.min(mar * 100, 100)}%`;
}

function checkDrowsiness(ear) {
    const now = Date.now();

    if (ear < CONFIG.EYE_AR_THRESH) {
        if (eyeClosedStartTime === null) {
            eyeClosedStartTime = now;
        }

        const duration = now - eyeClosedStartTime;
        const seconds = duration / 1000;

        // Show timer overlay
        timerOverlay.classList.remove('hidden');
        timerValue.innerText = seconds.toFixed(1) + 's';

        // Update milestone progress bars
        msSoundFill.style.width = Math.min((seconds / 2) * 100, 100) + '%';
        if (seconds >= 2) msSound.classList.add('reached');
        else msSound.classList.remove('reached');

        msSMSFill.style.width = Math.min((seconds / 5) * 100, 100) + '%';
        if (seconds >= 5) msSMS.classList.add('reached');
        else msSMS.classList.remove('reached');

        msCaptureFill.style.width = Math.min((seconds / 10) * 100, 100) + '%';
        if (seconds >= 10) msCapture.classList.add('reached');
        else msCapture.classList.remove('reached');

        // 1. Alarm at 2 seconds
        if (duration >= CONFIG.ALARM_TIME) {
            triggerAlert("⚠️ DROWSINESS DETECTED!");
            speakLocationAlert();
        }

        // 2. Alert Message/SMS at 5 seconds
        if (duration >= CONFIG.SMS_TIME && !smsSent) {
            log("🚨 EMERGENCY: Sending SMS Alert...", "text");
            sendEmergencySMS();
            smsSent = true;
        }

        // 3. Capture 5 photos at 10 seconds
        if (duration >= CONFIG.CAPTURE_TIME && photosTaken < 5) {
            if (now - lastCaptureTime > 500) {
                capturePhoto();
                photosTaken++;
                lastCaptureTime = now;
            }
        }

    } else {
        // Reset Logic
        eyeClosedStartTime = null;
        stopAlert();
        smsSent = false;
        photosTaken = 0;

        // Hide timer overlay and reset
        timerOverlay.classList.add('hidden');
        timerValue.innerText = '0.0s';
        msSoundFill.style.width = '0%';
        msSMSFill.style.width = '0%';
        msCaptureFill.style.width = '0%';
        msSound.classList.remove('reached');
        msSMS.classList.remove('reached');
        msCapture.classList.remove('reached');

        driverStatusText.innerText = "MONITORING";
        driverStatus.className = "status-display monitoring";
    }
}

// Send Emergency SMS with precise GPS location
async function sendEmergencySMS() {
    if (currentLocation) {
        log(`📍 GPS: ${currentLocation.lat.toFixed(6)}, ${currentLocation.lon.toFixed(6)}`, "text");
        const address = await reverseGeocode(currentLocation.lat, currentLocation.lon);
        callSMSAPI(currentLocation.lat, currentLocation.lon, address);
    } else {
        log(`⚠️ GPS unavailable, trying IP location fallback`, "text");
        const data = await getIPLocation();
        callSMSAPI(data.lat, data.lon, data.address);
    }
}

// Reverse geocode coordinates to address (via server proxy for accuracy)
async function reverseGeocode(lat, lon) {
    try {
        const response = await fetch(`/api/geocode?lat=${lat}&lon=${lon}`);
        const data = await response.json();
        if (data.address) {
            return data.address;
        }
    } catch (e) {
        console.error("Server geocode failed, trying Nominatim:", e);
    }

    // Fallback: Direct Nominatim call
    try {
        const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`
        );
        const data = await response.json();
        return data.display_name || `${lat}, ${lon}`;
    } catch (e) {
        return `${lat}, ${lon}`;
    }
}

// Fallback: Get location from IP
async function getIPLocation() {
    try {
        const response = await fetch('http://ip-api.com/json');
        const data = await response.json();
        if (data.status === 'success') {
            return {
                lat: data.lat,
                lon: data.lon,
                address: `${data.city}, ${data.regionName}, ${data.country}`
            };
        }
    } catch (e) {
        console.error("IP location failed:", e);
    }
    return { lat: 0, lon: 0, address: "Unknown Location" };
}

// Call the backend SMS API (with optional image)
async function callSMSAPI(lat, lon, address) {
    try {
        // Capture a snapshot to send with the SMS
        let imageData = null;
        try {
            const captureCanvas = document.createElement('canvas');
            captureCanvas.width = videoElement.videoWidth;
            captureCanvas.height = videoElement.videoHeight;
            const ctx = captureCanvas.getContext('2d');
            ctx.drawImage(videoElement, 0, 0, captureCanvas.width, captureCanvas.height);
            imageData = captureCanvas.toDataURL('image/jpeg', 0.7);
        } catch (e) {
            console.error("Failed to capture image for SMS:", e);
        }

        const response = await fetch('/api/send-sms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat, lon, address, image: imageData })
        });

        const result = await response.json();
        if (result.success) {
            log("✅ SMS Sent to Police & Family!", "text");
        } else {
            log("❌ SMS Failed: " + (result.message || result.error), "text");
        }
    } catch (e) {
        log("❌ Network error: " + e.message, "text");
    }
}

function capturePhoto() {
    const captureCanvas = document.createElement('canvas');
    captureCanvas.width = videoElement.videoWidth;
    captureCanvas.height = videoElement.videoHeight;
    const ctx = captureCanvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0, captureCanvas.width, captureCanvas.height);
    const dataURL = captureCanvas.toDataURL('image/jpeg');

    log(`📸 Auto-Capture #${photosTaken + 1}`, 'image', dataURL);
    saveImageToServer(dataURL, photosTaken + 1);
}

// Save captured image to the server's captures folder
async function saveImageToServer(dataURL, photoNum) {
    try {
        const response = await fetch('/api/save-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: dataURL, photoNum: photoNum })
        });

        const result = await response.json();
        if (result.success) {
            log(`💾 Saved to: ${result.path}`, "text");
        } else {
            log(`❌ Save failed: ${result.error}`, "text");
        }
    } catch (e) {
        log(`❌ Save error: ${e.message}`, "text");
    }
}

// Helper: Get current language from sessionStorage
function getCurrentLanguage() {
    if (!currentLanguage) {
        currentLanguage = sessionStorage.getItem('selectedLang') || 'en';
    }
    return currentLanguage;
}

// Update Location Display
function updateLocationDisplay() {
    if (currentLocation) {
        const lat = currentLocation.lat.toFixed(6);
        const lon = currentLocation.lon.toFixed(6);
        if (locationLat) locationLat.textContent = `Lat: ${lat}`;
        if (locationLon) locationLon.textContent = `Lon: ${lon}`;
        if (locationCoords) locationCoords.classList.remove('hidden');
        if (locationStatus) {
            locationStatus.innerText = '✅ GPS Active';
            locationStatus.style.color = '#00e676';
        }

        // Also fetch and show address
        reverseGeocode(currentLocation.lat, currentLocation.lon).then(addr => {
            if (addressText && addr) {
                addressText.textContent = addr;
                if (locationAddress) locationAddress.classList.remove('hidden');
            }
        });
    }
}

// Speak Location Alert on drowsiness
async function speakLocationAlert() {
    const now = Date.now();

    // Prevent alert spam - only speak every 10 seconds
    if (now - lastSpeechAlertTime < 10000) {
        return;
    }

    lastSpeechAlertTime = now;
    const lang = getCurrentLanguage();

    if (currentLocation) {
        const address = await reverseGeocode(currentLocation.lat, currentLocation.lon);
        if (address) {
            lastAlertAddress = address;
            if (typeof speakDrowsinessAlert === 'function') {
                speakDrowsinessAlert(lang, address);
            }
        } else {
            if (typeof speakDrowsinessAlert === 'function') {
                speakDrowsinessAlert(lang, null);
            }
        }
    } else {
        if (typeof speakDrowsinessAlert === 'function') {
            speakDrowsinessAlert(lang, null);
        }
    }
}

function triggerAlert(msg) {
    if (driverStatusText.innerText !== msg) {
        driverStatusText.innerText = msg;
        driverStatus.className = "status-display drowsy";
        log(msg);
    }

    if (!isAlertActive) {
        alarmAudio.play().catch(e => console.log("Audio play failed:", e));
        isAlertActive = true;
    }
}

function stopAlert() {
    if (isAlertActive) {
        alarmAudio.pause();
        alarmAudio.currentTime = 0;
        isAlertActive = false;
    }
}

// Event Listeners
startBtn.addEventListener('click', () => {
    loadingSpinner.classList.remove('hidden');

    // Store current language
    currentLanguage = sessionStorage.getItem('selectedLang') || 'en';

    if (navigator.geolocation) {
        locationWatcher = navigator.geolocation.watchPosition(
            (pos) => {
                currentLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude };
                updateLocationDisplay();
            },
            (err) => {
                console.log("GPS Watch error", err);
                if (locationStatus) {
                    locationStatus.innerText = '⚠️ GPS Unavailable';
                    locationStatus.style.color = '#ff9800';
                }
            },
            { enableHighAccuracy: true, maximumAge: 0 }
        );
    }

    camera.start()
        .then(() => {
            isRunning = true;
            loadingSpinner.classList.add('hidden');
            startBtn.disabled = true;
            stopBtn.disabled = false;
            systemDot.classList.add('active');
            systemText.innerText = "SYSTEM ACTIVE";
            log("System started. Camera active.");
        })
        .catch(err => {
            log("Error starting camera: " + err);
            loadingSpinner.classList.add('hidden');
        });
});

stopBtn.addEventListener('click', () => {
    isRunning = false;
    if (locationWatcher !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(locationWatcher);
        locationWatcher = null;
    }
    videoElement.srcObject.getTracks().forEach(track => track.stop());

    startBtn.disabled = false;
    stopBtn.disabled = true;
    systemDot.classList.remove('active');
    systemText.innerText = "SYSTEM STANDBY";

    // Clear Canvas
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    // Reset State
    stopAlert();
    eyeClosedStartTime = null;
    smsSent = false;
    updateMetrics(0, 0);
    driverStatusText.innerText = "MONITORING";
    driverStatus.className = "status-display monitoring";
    log("System stopped.");
});

// Audio error handler
alarmAudio.addEventListener('error', (e) => {
    console.error("Audio Error:", e.target.error);
});