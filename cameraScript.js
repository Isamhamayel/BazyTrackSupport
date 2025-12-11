/* ======================================================
   CONFIG
====================================================== */
const FILE_SHEET_ID   = "1GjVH6jlTGf7BEBqld0GEX1yMqUgfQc235g64CWdNyUM";
const DEVICE_SHEET_ID = FILE_SHEET_ID;

const FILE_SHEET_URL =
  `https://docs.google.com/spreadsheets/d/${FILE_SHEET_ID}/gviz/tq?tqx=out:json`;
const DEVICE_SHEET_URL =
  `https://docs.google.com/spreadsheets/d/${DEVICE_SHEET_ID}/gviz/tq?tqx=out:json&sheet=Devices`;

const WEBAPP_URL =
  "https://script.google.com/macros/s/AKfycbwwI70vwtzhZtzChTG7WzF-UvQIHm0z2iXNH70wYzB0vjgodvsT3ciHcaN0MohSmeMW/exec";

const STREAM_HOST = "streaming.bazytrack.jo";

/* ======================================================
   GLOBALS
====================================================== */
let allFilesForDate = [];
let lastDeviceIdForDate = null;
let lastDateForDate = null;

let deviceNames = {};
let cameraFilter = "all";

let flvPlayer = null;

/* === Timeline Structures === */
let recordingsByHour = {};  // { "08": [12, 13, 20], ... }

/* DOM ELEMENTS */
const deviceSelect = document.getElementById("deviceSelect");
const datePicker = document.getElementById("datePicker");
const hourPicker = document.getElementById("hourPicker");
const cameraSelect = document.getElementById("cameraFilter");
const fileList = document.getElementById("fileList");
const statusBar = document.getElementById("statusBar");
const videoPlayer = document.getElementById("videoPlayer");

/* ======================================================
   INIT
====================================================== */
window.onload = () => {
    loadDeviceDropdown();
};

/* ======================================================
   LOAD DEVICE NAMES
====================================================== */
async function loadDeviceNames(){
    try {
        const res = await fetch(DEVICE_SHEET_URL);
        const text = await res.text();
        const json = JSON.parse(text.substring(47).slice(0,-2));

        deviceNames = {};
        json.table.rows.forEach(r => {
            const c = r.c;
            if (!c) return;
            const id = c[0]?.v;
            const name = c[2]?.v;
            if (id && name) deviceNames[id] = name;
        });

    } catch (e){
        console.error("Device load error:", e);
    }
}

/* ======================================================
   POPULATE DEVICES
====================================================== */
async function loadDeviceDropdown() {
    await loadDeviceNames();

    deviceSelect.innerHTML = '<option value="">اختر الجهاز</option>';

    for (let id in deviceNames){
        deviceSelect.innerHTML += `
        <option value="${id}">${deviceNames[id]}</option>
        `;
    }

    // Fill hour dropdown
    for (let h=0; h<24; h++){
        const hh = h.toString().padStart(2, "0");
        hourPicker.innerHTML += `<option value="${hh}">${hh}:00</option>`;
    }
}

/* ======================================================
   LOAD FILES FOR ONE DAY
====================================================== */
async function loadFiles(){
    const id   = deviceSelect.value;
    const date = datePicker.value;

    if (!id || !date){
        fileList.innerHTML = '<div class="info-text">اختر الجهاز والتاريخ لعرض التسجيلات.</div>';
        allFilesForDate = [];
        updateTimelineFiles([]);
        return;
    }

    // cache check
    if (lastDeviceIdForDate === id && lastDateForDate === date && allFilesForDate.length){
        renderFileListForHour();
        updateTimelineFiles(allFilesForDate);
        return;
    }

    fileList.innerHTML = '<div class="info-text">جارِ تحميل قائمة التسجيلات لليوم بالكامل...</div>';

    const sql = `select * where G=${id} order by A`;
    const url = FILE_SHEET_URL + "&tq=" + encodeURIComponent(sql);

    try {
        const text = await (await fetch(url)).text();
        const json = JSON.parse(text.substring(47).slice(0,-2));
        const rows = json.table.rows || [];

        const list = [];

        rows.forEach(r => {
            const c = r.c;
            if (!c) return;

            const raw = c[0]?.f || c[0]?.v;
            if (!raw) return;

            const parts = raw.split(" ");
            if (parts.length < 2) return;

            const mdy = parts[0];
            const t   = parts[1];

            const [M, D, Y] = mdy.split("/");
            const d2 =
              `${Y}-${M.toString().padStart(2,"0")}-${D.toString().padStart(2,"0")}`;

            if (d2 !== date) return;

            const hh = t.split(":")[0].padStart(2,"0");

            const camVal = c[4]?.v;
            if (cameraFilter !== "all" && String(camVal) !== String(cameraFilter))
                return;

            list.push({
                time: t,
                filename: c[2]?.v,
                deviceId: c[6]?.v,
                hour: hh
            });
        });

        allFilesForDate = list;
        lastDeviceIdForDate = id;
        lastDateForDate = date;

        if (!list.length){
            fileList.innerHTML = '<div class="info-text">لا يوجد ملفات في هذا اليوم لهذا الجهاز.</div>';
            updateTimelineFiles([]);
            return;
        }

        renderFileListForHour();
        updateTimelineFiles(list);

    } catch(err){
        console.error(err);
        fileList.innerHTML =
            '<div class="info-text">حدث خطأ أثناء تحميل البيانات.</div>';
        updateTimelineFiles([]);
    }
}

/* ======================================================
   UPDATE TIMELINE WITH NEW FILES
====================================================== */
function updateTimelineFiles(list) {

    recordingsByHour = {};   // reset

    list.forEach(f => {
        const [hh, mm] = f.time.split(":");
        if (!recordingsByHour[hh]) recordingsByHour[hh] = [];
        recordingsByHour[hh].push(parseInt(mm));
    });

    buildHourTimeline();
    hideMinuteTimeline();
}

/* ======================================================
   BUILD 24-HOUR TIMELINE
====================================================== */
function buildHourTimeline() {
    const el = document.getElementById("hourTimeline");
    if (!el) return;

    el.innerHTML = "";

    for (let h = 0; h < 24; h++) {
        const hh = h.toString().padStart(2,"0");

        const div = document.createElement("div");
        div.className = "hour-block";

        div.style.background =
            recordingsByHour[hh] && recordingsByHour[hh].length > 0
                ? "#2563eb"
                : "#d1d5db";

        div.onclick = () => buildMinuteTimeline(hh);

        el.appendChild(div);
    }
}

/* ======================================================
   BUILD 60 MINUTE TIMELINE
====================================================== */
function buildMinuteTimeline(hh) {
    const wrap = document.getElementById("minuteTimelineWrapper");
    const el   = document.getElementById("minuteTimeline");

    if (!wrap || !el) return;

    el.innerHTML = "";

    const minutes = recordingsByHour[hh] || [];
    const map = new Array(60).fill(false);
    minutes.forEach(m => map[m] = true);

    for (let m = 0; m < 60; m++) {
        const d = document.createElement("div");
        d.className = "minute-block";
        d.style.background = map[m] ? "#1e40af" : "#e5e7eb";

        d.onclick = () => playFromMinute(hh, m);

        el.appendChild(d);
    }

    wrap.classList.remove("hidden");
    wrap.classList.remove("slide-up");
    wrap.classList.add("slide-down");
}

/* ======================================================
   HIDE MINUTE TIMELINE
====================================================== */
function hideMinuteTimeline() {
    const wrap = document.getElementById("minuteTimelineWrapper");
    if (!wrap) return;

    wrap.classList.add("slide-up");

    setTimeout(() => {
        wrap.classList.add("hidden");
    }, 500);
}

/* ======================================================
   PLAY FROM MINUTE (REPLAYLIST OF 5 FILES)
====================================================== */
function playFromMinute(hh, mm) {

    const idx = allFilesForDate.findIndex(f => {
        const [h, m] = f.time.split(":");
        return h === hh && parseInt(m) === mm;
    });

    if (idx === -1) {
        alert("لا يوجد ملف يبدأ في هذه الدقيقة.");
        return;
    }

    runReplayList(idx);
}

/* ======================================================
   BUILD & SEND REPLAYLIST COMMAND
====================================================== */
async function runReplayList(index) {

    const files = allFilesForDate
        .slice(index, index + 5)
        .map(f => f.filename);

    if (!files.length) {
        alert("لا يوجد ملفات للتشغيل.");
        return;
    }

    const param = encodeURIComponent(files.join(","));
    const deviceId = allFilesForDate[index].deviceId;

    const url =
      `${WEBAPP_URL}?type=playback&deviceId=${deviceId}&fileName=${param}`;

    try { await fetch(url); }
    catch(e) { console.error("ReplayList send failed:", e); }

    playWithWait(deviceId, "history");
}

/* ======================================================
   RESET FLV.JS (FIX FREEZE)
====================================================== */
function resetFlvPlayer(){
    try {
        if (flvPlayer) {
            flvPlayer.pause();
            flvPlayer.unload();
            flvPlayer.destroy();
        }
    } catch(e){}

    flvPlayer = null;
    videoPlayer.pause();
    videoPlayer.removeAttribute("src");
    videoPlayer.src = "";
    videoPlayer.load();
}

/* ======================================================
   PLAY (LIVE OR HISTORY)
====================================================== */
function playWithWait(deviceId, mode="live") {

    resetFlvPlayer();

    const flvUrl =
      `https://${STREAM_HOST}/live/0/${deviceId}.flv?_=${Date.now()}`;

    setTimeout(() => {

        if (flvjs.isSupported()) {

            flvPlayer = flvjs.createPlayer({ type:"flv", url: flvUrl });

            flvPlayer.attachMediaElement(videoPlayer);
            flvPlayer.load();
            flvPlayer.play();

        }

    }, 600);
}

/* ======================================================
   FILE LIST RENDERING
====================================================== */
function renderFileListForHour(){
    const hour = hourPicker.value;

    if (!allFilesForDate.length){
        fileList.innerHTML =
          '<div class="info-text">لا يوجد تسجيلات لهذا اليوم.</div>';
        return;
    }

    let subset = allFilesForDate;
    if (hour){
        subset = allFilesForDate.filter(v => v.hour === hour);
    }

    if (!subset.length){
        fileList.innerHTML =
        '<div class="info-text">لا يوجد ملفات في هذه الساعة.</div>';
        return;
    }

    fileList.innerHTML = "";
    subset.forEach(v => {
        if (!v.filename) return;

        fileList.innerHTML += `
            <div class="file-item"
                 onclick="playVideo('${v.filename}','${v.deviceId}')">
                <div class="time-label">${v.filename}</div>
                <b>${v.time}</b>
            </div>
        `;
    });
}

/* ======================================================
   PLAY SINGLE FILE (OLD BUTTON)
====================================================== */
async function playVideo(filename, deviceId){
    if (!filename) return;

    const url =
       `${WEBAPP_URL}?type=playback&deviceId=${deviceId}&fileName=${filename}`;

    try { await fetch(url); } catch(e){}

    playWithWait(deviceId, "history");
}
