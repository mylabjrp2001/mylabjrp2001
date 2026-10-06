# Gotchas

- **commit จะขึ้นกราฟก็ต่อเมื่ออีเมลผู้เขียนยืนยันแล้วในบัญชี `mylabjrp2001`** — 6 ต.ค. 2026 เจอ 15 repo ในเครื่องตั้ง `git config --local user.email` ทับเป็นอีเมลที่ยืนยันไม่ได้ (`<username>@github.com` ไม่ใช่ noreply ของ GitHub) และ gmail ที่ผูกอยู่กับบัญชีเก่า → commit ราว 4,000 ตัวไม่ถูกนับ · ลบ override แล้ว ใช้ global `@mylabjrp.online` · **ห้ามตั้ง user.email ราย repo**
- **GraphQL `contributionsCollection` ซ่อนรายละเอียด repo private** แม้ใช้ token เจ้าของเอง (`gho_` ของ gh ที่มี scope `repo`) → private ทั้งหมดไปอยู่ใน `restrictedContributionsCount` · ยอดรวมรายวันใน `contributionCalendar` ยังถูก แต่ยอดราย repo ต้องนับเองจาก REST `GET /repos/{o}/{r}/commits?author=&since=` (นับเฉพาะ default branch เหมือนกราฟ)
- bot commit รูปทุกวัน → **ก่อน push ต้อง `git pull --rebase`** ไม่งั้น push ถูกปฏิเสธ
- bot ใช้ `github-actions[bot]` เป็นผู้เขียน → การรีเฟรชรายวันไม่นับเป็น contribution ของเรา (ตั้งใจ ไม่ปั่นกราฟ)
- รูปใน README ถูกเสิร์ฟผ่าน camo เป็น `<img>` → ไม่มี JS · โหลดฟอนต์จากข้างนอกไม่ได้ → ใช้ฟอนต์ monospace ของระบบ · แอนิเมชันใช้ CSS ใน SVG ได้
- แอนิเมชันพิมพ์ของหัว: สถานะพักของแผ่นปิดคือ "เปิดข้อความ" แล้ว keyframes ปิดไว้แค่ช่วง delay (`backwards`) → ถ้าตัวแสดงผลไม่รันแอนิเมชัน ข้อความยังขึ้นครบ
- งู (Platane/snk) ถูกฝังเป็น `<svg>` ซ้อนในกรอบของเรา → class ของเราขึ้นต้น `k-` เสมอ กันชนกับ CSS ของ snk
- รูปคู่ใช้ `<img width="49%">` ใน `<picture>` → บนมือถือจะย่อลงแต่ยังอยู่คู่กัน ไม่ตัดบรรทัด
- GitHub cache รูปไว้ครู่หนึ่ง → อัปเดตแล้วหน้าโปรไฟล์ยังเก่าให้รอสักพักหรือ hard refresh
- **log ของ Actions ใน repo public เปิดดูได้ทุกคน** — GitHub ปิด (mask) ให้เฉพาะค่า secret ทั้งก้อน URL ที่แยกออกมาจาก JSON ใน `HEALTH_URLS` จะไม่ถูกปิด → สคริปต์ print แค่ชื่อแอปกับจำนวน ห้าม print URL หรือ error ที่มี URL ของแอป
- **ช่องว่างหลายตัวใน SVG ถูกยุบเหลือช่องเดียว** (`[  OK  ]` · รูป ASCII) ถ้าไม่ใส่ `xml:space="preserve"` ที่ `<text>` ทุกตัว + `white-space:pre` · ใส่ที่ `<svg>` ตัวนอกอย่างเดียวไม่พอ (WebKit ไม่สืบทอด)
- รูป ASCII ใน neofetch ใช้ `+ - | =` ล้วน — ตัวเส้นกรอบ `┌─═` แต่ละฟอนต์กว้างไม่เท่ากัน รูปเบี้ยว
- `--health` วาดแค่ชิ้น services · การรันในเครื่องที่ไม่มี `dist/snake-*.svg` จะ**ไม่ทับ**งูที่ commit ไว้ (วาดกริดนิ่งเฉพาะตอนยังไม่มีไฟล์งูเลย)
- ชิ้น services ไม่มีเวลาที่เช็กในรูป → bot commit เฉพาะตอนสถานะเปลี่ยน ถ้าใส่เวลา/ms จะ commit ทุกชั่วโมง
- punch card นับจาก REST `author=<login>` เหมือนกราฟ → commit ที่อีเมลยังไม่ผูกบัญชีไม่ถูกนับ (ตัวเลขน้อยกว่า git log ในเครื่อง)
