# RunPlanner — แอปวางแผนเส้นทางวิ่ง

แอป Progressive Web App (PWA) ที่ใช้งานได้ทั้งบนเว็บและโทรศัพท์ พัฒนาด้วย React + Leaflet (OpenStreetMap) เป็นเวอร์ชันฟรีก่อน สามารถสลับไปใช้ Google Maps ภายหลังได้

## ฟีเจอร์ที่มี

- วางแผนเส้นทางตามระยะทาง — แตะที่แผนที่เพื่อเพิ่มจุดผ่าน ระบบจะลากเส้นเกาะตามถนน/ทางเดินให้อัตโนมัติ
- บันทึกเส้นทางที่ชอบ — เก็บไว้ในเครื่อง (localStorage) ไม่ต้องสมัครสมาชิก
- ติดตามตำแหน่ง GPS แบบสด — ขณะวิ่ง แสดงระยะทาง เวลา และ pace แบบเรียลไทม์
- ดูข้อมูลความชัน (Elevation profile) — กราฟแสดงระดับความสูงของเส้นทาง พร้อมข้อมูลขึ้น/ลงรวม
- แชร์เส้นทาง — สร้างลิงก์ที่ encode เส้นทางไว้ใน URL ส่งให้เพื่อนได้ทันที
- ติดตั้งบนหน้าจอหลัก — รองรับ "Add to Home Screen" ทั้ง iOS และ Android
- ใช้งานออฟไลน์ได้บางส่วน — service worker แคชหน้าแอปไว้ (แผนที่ยังต้องต่อเน็ต)

## โครงสร้างไฟล์

```
project R/
├── index.html        — หน้าหลัก โหลด React, Leaflet, และ register service worker
├── app.js            — React component หลักทั้งหมด (JSX + Babel ในเบราว์เซอร์)
├── manifest.json     — PWA manifest (ชื่อแอป, icon, theme)
├── sw.js             — Service Worker สำหรับ offline cache
├── icon.svg          — โลโก้แอป (vector)
├── icon-192.png      — Icon สำหรับ Android (192×192)
├── icon-512.png      — Icon สำหรับ Android (512×512)
└── README.md         — เอกสารนี้
```

## วิธีรันบนคอมพิวเตอร์ (Local Development)

PWA และ service worker ต้องเสิร์ฟผ่าน HTTP server ไม่ใช่เปิด `index.html` ตรง ๆ ผ่าน file://

### ทางเลือกที่ 1 — Python (มีติดมากับ macOS/Linux)

```bash
cd "project R"
python3 -m http.server 8000
```

แล้วเปิดเบราว์เซอร์ที่ <http://localhost:8000>

### ทางเลือกที่ 2 — Node.js

```bash
cd "project R"
npx serve .
```

### ทางเลือกที่ 3 — VS Code

ติดตั้ง extension "Live Server" → คลิกขวาที่ `index.html` → "Open with Live Server"

## วิธีใช้งานบนโทรศัพท์

### Android (Chrome)
1. Deploy แอปไว้ที่ HTTPS server (เช่น GitHub Pages, Netlify, Vercel)
2. เปิดลิงก์ใน Chrome
3. แตะเมนู 3 จุด → "ติดตั้งแอป" หรือ "Add to Home Screen"

### iOS (Safari)
1. เปิดลิงก์ใน Safari
2. แตะปุ่ม Share (⬆️) → "Add to Home Screen"
3. หมายเหตุ: บน iOS service worker มีข้อจำกัด แต่แอปยังใช้งานได้ปกติ

### Deploy ฟรี

Deploy อยู่บน **Vercel** (<https://routewing.vercel.app>), ต่อกับ GitHub repo นี้โดยตรง —
`git push` ขึ้น `main` แล้ว deploy อัตโนมัติ ไม่ต้องรันคำสั่งเอง:

```bash
# ต้องการ deploy manual (เช่นเทสจากเครื่องตัวเองก่อน push) ใช้:
npx vercel --prod
```

`vercel.json` มี rewrite rule สำหรับ `/r/:slug*` (ใช้โดยฟีเจอร์แชร์ลิงก์ถาวรในอนาคต) ไม่ต้อง build
step ใดๆ — ไฟล์ทั้งหมด serve ตรงๆ เหมือนเดิม

## API ที่ใช้ (ฟรีทั้งหมด)

| บริการ | ใช้สำหรับ | ข้อจำกัด |
|---|---|---|
| OpenStreetMap (tiles) | แสดงแผนที่ | ห้ามใช้ tiles จาก openstreetmap.org เกินกว่าใช้งานส่วนตัว/ทดสอบ |
| OSRM public server | คำนวณเส้นทางตามถนน | Demo server ไม่รับประกัน uptime |
| Open-Elevation API | ข้อมูลความสูง | บริการสาธารณะ อาจช้าบางจังหวะ |
| Geolocation API | GPS ของอุปกรณ์ | ต้อง HTTPS (หรือ localhost) |

⚠️ **สำหรับใช้งานจริง (production)** ควร self-host OSRM และ tile server เอง หรือสมัครบริการแบบ paid

## วิธีเปลี่ยนไปใช้ Google Maps API

เมื่อพร้อมใช้ API key ของคุณแล้ว แก้ไขแบบนี้:

### 1. ใน `index.html` — เพิ่ม Google Maps script แทน Leaflet:

```html
<!-- ลบ Leaflet CSS/JS ออก แล้วเพิ่ม: -->
<script async defer
    src="https://maps.googleapis.com/maps/api/js?key=YOUR_API_KEY&libraries=geometry&callback=initMap">
</script>
```

### 2. ใน `app.js` — แทน `L.map(...)` ด้วย `google.maps.Map(...)`:

```javascript
const map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 13.7563, lng: 100.5018 },
    zoom: 14,
});
map.addListener("click", (e) => {
    setWaypoints(prev => [...prev, { lat: e.latLng.lat(), lng: e.latLng.lng() }]);
});
```

### 3. ใช้ Google Directions API แทน OSRM:

```javascript
const directionsService = new google.maps.DirectionsService();
directionsService.route({
    origin: from,
    destination: to,
    travelMode: google.maps.TravelMode.WALKING,
}, (result) => { /* ... */ });
```

### 4. ใช้ Elevation API ของ Google แทน Open-Elevation:

```javascript
const elevator = new google.maps.ElevationService();
elevator.getElevationAlongPath({ path: coords, samples: 100 }, ...);
```

💡 ข้อดีของ Google Maps: เร็ว แม่นยำกว่า รองรับภาษาไทยดี และมีข้อมูลความชันที่แม่นยำ
💡 ข้อเสีย: ต้องสมัคร API key, ผูกบัตรเครดิต (มี free tier $200/เดือน), มี request limit

## ข้อจำกัดของ Prototype นี้

- GPS tracking ต้องการให้หน้าจอเปิดไว้ — เบราว์เซอร์อาจ pause background tab
- ข้อมูลความสูงจาก Open-Elevation อาจไม่ละเอียดในบางพื้นที่
- บันทึกเก็บใน localStorage เท่านั้น — ถ้าล้าง cache ข้อมูลจะหาย (สำหรับ production ควร sync ขึ้น cloud)
- OSRM public server อาจช้าหรือล่ม — ถ้าเกิดขึ้น เส้นทางจะลากเป็นเส้นตรงแทน
- ไม่มีระบบสมัครสมาชิก / sync ระหว่างอุปกรณ์

## ขั้นตอนต่อไป (ถ้าจะพัฒนาเป็น production)

1. แปลงเป็น Vite/Next.js โปรเจกต์ (แทน Babel standalone ในเบราว์เซอร์ — เร็วขึ้น 5–10 เท่า)
2. ย้ายข้อมูลขึ้น backend (Firebase, Supabase) เพื่อ sync ระหว่างอุปกรณ์
3. เพิ่มระบบสมัครสมาชิก/login
4. ปรับ service worker ให้ cache map tiles ในพื้นที่ที่กำหนด (offline maps)
5. เพิ่มฟีเจอร์ social — follow เพื่อน, leaderboard, share to Strava
6. Export เป็น .gpx / .tcx สำหรับนำไปใช้กับ Garmin/Strava

## วิธีเทส / How to test

### 📱 บนมือถือ (แนะนำ — HTTPS, GPS ใช้ได้)
เปิด URL นี้บนมือถือเลย ไม่ต้องเปิดอะไรในคอม:

**https://routewing.vercel.app/**

อัปเดตอัตโนมัติทุกครั้งที่ `git push` ขึ้น `main` (Vercel auto-deploy, ปกติเสร็จใน ~10-30 วินาที
พร้อม preview deploy แยกสำหรับ PR/branch อื่น) — ลิงก์ GitHub Pages เดิม
(pattanan-th.github.io/RunPlanner) ยังใช้งานได้แต่ไม่ใช่ที่หลักอีกต่อไป

### 💻 บนคอม / LAN dev server
ดับเบิลคลิก **`dev-server.bat`** ในโฟลเดอร์โปรเจกต์ → จะโชว์ URL ในหน้าต่าง cmd
เปิดบนมือถือ (Wi-Fi เดียวกันกับ PC): `http://<IP-ของ-PC>:8080/`

ข้อจำกัด: HTTP เท่านั้น → **GPS / "ตำแหน่งฉัน" ใช้ไม่ได้บนมือถือ** (ใช้บน desktop ได้)
ปิด: ปิดหน้าต่าง cmd

### ⚙️ Google Maps API key
คีย์อยู่ใน `index.html` (จำกัด referrer ใน Google Cloud Console แล้ว)
- `https://pattanan-th.github.io/*` — production
- `http://localhost:*/*` — dev
- `http://192.168.1.187:8080/*` — LAN (เปลี่ยน IP ถ้าคอมย้ายเครือข่าย)
