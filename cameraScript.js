/* ---------------------------------------------------------
   GLOBAL VARS
--------------------------------------------------------- */
let devices = [];
let allFiles = [];
let recordingsByHour = {};
let selectedDeviceId = null;
let selectedDate = null;

let flvPlayer = null;
let isLiveMode = false;

const WEBAPP_URL = "YOUR_WEBAPP_URL_HERE";   // ضع رابط سكربت Google Apps Script هنا
const STREAM_HOST = "YOUR_SRS_SERVER";       // ضع رابط السيرفر SRS هنا

/* DOM ELEMENTS */
const deviceSelector = document.getElementById("deviceSelector");
const datePicker = document.getElementById("datePicker");
const loadBtn = document.getElementById("loadBtn");
const statusBar = document.getElementById("statusBar");
const videoPlayer = document.getElementById("videoPlayer");

const hourTimeline = document.getElementById("hourTimeline");
const minuteWrapper = document.getElementById("minuteTimelineWrapper");
const minuteTimeline = document.getElementById("minuteTimeline");

const fileList = document.getElementById("fileList");

/* ---------------------------------------------------------
   INITIALIZATION
--------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", () => {
    loadDevices();
    loadBtn.onclick = loadDayFiles;
});

/* ---------------------------------------------------------
   LOAD DEVICES
--------------------------------------------------------- */
async function loadDevices() {
    const url = WEBAPP_URL + "?type=devices";

    try {
        const res = await fetch(url);
        devices = await res.json();

        deviceSelector.innerHTML = "";
        devices.forEach(d => {
            const opt = document.createElement("option");
            opt.value = d.deviceId;
            opt.textContent = `${d.name} (${d.plate || ''})`;
            deviceSelector.appendChild(opt);
        });

    } catch (e) {
        console.error("Device load error:", e);
    }
}

/* ---------------------------------------------------------
   LOAD FILES FOR FULL DAY
--------------------------------------------------------- */
async function loadDayFiles() {

    selectedDeviceId = deviceSelector.value;
    selectedDate = datePicker.value;

    if (!selectedDeviceId || !selectedDate) {
        alert("الرجاء اختيار الجهاز والتاريخ.");
        return;
    }

    statusBar.innerText = "تحميل تسجيلات اليوم...";

    const url =
        `${WEBAPP_URL}?type=files&deviceId=${selectedDeviceId}&date=${selectedDate}`;

    try {
        const res = await fetch(url);
        allFiles = await res.json();

        if (!allFiles.length) {
            statusBar.innerText = "لا يوجد تسجيلات لهذا اليوم.";
            hourTimeline.innerHTML = "";
            minuteTimeline.innerHTML = "";
            return;
        }

        buildRecordingMap();
        buildHourTimeline();

        statusBar.innerText = "جاهز — اختر ساعة لرؤية التسجيلات.";

    } catch (e) {
        console.error("File load error:", e);
        statusBar.innerText = "خطأ في تحميل الملفات.";
    }
}

/* ---------------------------------------------------------
   BUILD recording-by-hour map
--------------------------------------------------------- */
function buildRecordingMap() {
    recordingsByHour = {};

    allFiles.forEach(f => {
        const parts = f.time.split(":"); // "08:12:05"
        const hh = parts[0];
        const mm = parseInt(parts[1]);

        if (!recordingsByHour[hh]) recordingsByHour[hh] = [];
        recordingsByHour[hh].push(mm);
    });
}

/* ---------------------------------------------------------
   BUILD HOUR TIMELINE (24 blocks)
--------------------------------------------------------- */
function buildHourTimeline() {
    hourTimeline.innerHTML = "";

    for (let h = 0; h < 24; h++) {
        const hh = h.toString().padStart(2, "0");
        const div = document.createElement("div");
        div.className = "hour-block";

        if (recordingsByHour[hh] && recordingsByHour[hh].length > 0) {
            div.style.background = "#2563eb"; // Blue
        } else {
            div.style.background = "#d1d5db"; // Gray
        }

        div.onclick = () => openHour(hh);
        hourTimeline.appendChild(div);
    }
}

/* ---------------------------------------------------------
   OPEN MINUTES TIMELINE FOR SELECTED HOUR
--------------------------------------------------------- */
function openHour(hh) {

    // Clear minute timeline
    minuteTimeline.innerHTML = "";

    // Prepare minute availability
    const minutesData = new Array(60).fill(false);
    if (recordingsByHour[hh]) {
        recordingsByHour[hh].forEach(m => minutesData[m] = true);
    }

    // Build minute blocks
    for (let i = 0; i < 60; i++) {
        const b = document.createElement("div");
        b.className = "minute-block";

        b.style.background = minutesData[i] ? "#1e40af" : "#e5e7eb";

        b.onclick = () => playFromMinute(hh, i);
        minuteTimeline.appendChild(b);
    }

    // Show minute timeline with slide down
    minuteWrapper.classList.remove("hidden");
    minuteWrapper.classList.remove("slide-up");
    minuteWrapper.classList.add("slide-down");
}

/* ---------------------------------------------------------
   PLAY FROM MINUTE (run replaylist of 5 files)
--------------------------------------------------------- */
function playFromMinute(hh, mm) {

    // Find file index in allFiles matching this minute EXACT
    const matchIndex = allFiles.findIndex(f => {
        const [h, m] = f.time.split(":");
        return h == hh && parseInt(m) === mm;
    });

    if (matchIndex === -1) {
        alert("لا يوجد ملف يبدأ في هذه الدقيقة.");
        return;
    }

    runReplayList(matchIndex);
}

/* ---------------------------------------------------------
   REPLAY LIST (5 FILES)
--------------------------------------------------------- */
async function runReplayList(startIndex) {

    const files = allFiles.slice(startIndex, startIndex + 5)
        .map(f => f.filename);

    if (!files.length) {
        alert("لا يوجد ملفات للتشغيل.");
        return;
    }

    statusBar.innerText = "تشغيل التسجيل...";

    const fileParam = encodeURIComponent(files.join(","));

    // Send command to Jimi via Google Apps Script
    const url =
        `${WEBAPP_URL}?type=playback&deviceId=${selectedDeviceId}&fileName=${fileParam}`;

    try {
        await fetch(url);
    } catch (e) {
        console.error("ReplayList send failed:", e);
    }

    // After sending command, attach FLV
    playWithWait(selectedDeviceId, "history");
}

/* ---------------------------------------------------------
   RESET FLV (FIX FREEZING)
--------------------------------------------------------- */
function resetFlvPlayer() {
    try {
        if (flvPlayer) {
            flvPlayer.pause();
            flvPlayer.unload();
            flvPlayer.destroy();
        }
    } catch (e) {}

    flvPlayer = null;

    videoPlayer.pause();
    videoPlayer.removeAttribute("src");
    videoPlayer.src = "";
    videoPlayer.load();
}

/* ---------------------------------------------------------
   PLAY (LIVE / HISTORY)
--------------------------------------------------------- */
function playWithWait(deviceId, mode = "live") {

    isLiveMode = (mode === "live");

    resetFlvPlayer();

    statusBar.innerText = mode === "live"
        ? "بث مباشر..."
        : "تشغيل تسجيل...";

    // Jimi IMEI is same as deviceId for simplicity (يمكنك تعديله)
    const imei = deviceId;

    const flvUrl =
        `https://${STREAM_HOST}/live/0/${imei}.flv?_=${Date.now()}`;

    setTimeout(() => {
        if (flvjs.isSupported()) {
            flvPlayer = flvjs.createPlayer({ type: "flv", url: flvUrl });

            flvPlayer.attachMediaElement(videoPlayer);
            flvPlayer.load();
            flvPlayer.play();
        }
    }, 600); // delay for ReplayList stability
}

/* ---------------------------------------------------------
   OPTIONAL: PLAY LIVE BUTTON (إذا أردت)
--------------------------------------------------------- */
function playLive() {
    playWithWait(deviceSelector.value, "live");
}

/* ---------------------------------------------------------
   DEBUG / FILE LIST
--------------------------------------------------------- */
function updateFileListForHour(hh) {
    const list = recordingsByHour[hh] || [];
    fileList.innerHTML = list.map(m => `الدقيقة ${m}`).join("<br>");
}
