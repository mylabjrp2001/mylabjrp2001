# Deploy = push main

ไม่มี server · ทุกอย่างรันบน GitHub Actions ของ repo นี้

## แก้ข้อความ / รายชื่อแอป / หน้าตา
```bash
node scripts/build.mjs                              # ไม่มี token → วาดจาก data/stats.json เดิม ดูรูปใน assets/
GH_TOKEN="$(gh auth token)" node scripts/build.mjs  # ดึงสถิติใหม่จากเครื่องนี้ (token ใช้ชั่วคราว ไม่ถูกเขียนลงไฟล์)
git pull --rebase && git add -A && git commit -m "..." && git push
```
push ที่แตะ `profile.config.json` · `scripts/**` · workflow จะสั่ง workflow รันเอง

## รันเอง / ดูผล
```bash
gh workflow run profile -R mylabjrp2001/mylabjrp2001
gh run watch -R mylabjrp2001/mylabjrp2001
```

## token (`GH_STATS_TOKEN`)
ใช้ให้ workflow นับ repo private ได้ · ไม่มี secret = workflow ยังรัน แต่วาดจาก `data/stats.json` เดิม และงูเห็นแค่ที่ public เห็น

สร้าง: GitHub → Settings → Developer settings → Fine-grained tokens → Generate
- Resource owner: `mylabjrp2001` · Repository access: **All repositories**
- Permissions: **Contents: Read-only** · **Metadata: Read-only** (ไม่ต้องให้สิทธิ์เขียน)

ตั้งค่า (วาง token ตอนถาม — ไม่ต้องส่งให้ใคร):
```bash
gh secret set GH_STATS_TOKEN -R mylabjrp2001/mylabjrp2001
gh workflow run profile -R mylabjrp2001/mylabjrp2001
```
token หมดอายุ → workflow ขึ้นแดง (GraphQL 401) → สร้างใหม่แล้ว `gh secret set` ซ้ำ

## URL ของแอป (`HEALTH_URLS`)
ใช้ให้ชิ้น services เช็กแอปจริงทุกชั่วโมง · ไม่มี secret = ชิ้นนั้นแสดงเป็น docker ps "Up N weeks" แทน

รูปแบบ: JSON บรรทัดเดียว key = ชื่อแอปตาม `docker.apps` ใน config · แอปที่ไม่ใส่จะขึ้น "—" (not monitored)
```json
{"baanmefai":"https://...","gps":"https://...","hr-office":"https://..."}
```
ตั้งค่า (วางตอนถาม · **อย่าเก็บเป็นไฟล์ใน repo**):
```bash
gh secret set HEALTH_URLS -R mylabjrp2001/mylabjrp2001
gh workflow run health -R mylabjrp2001/mylabjrp2001
```
ผลลัพธ์: ต่ำกว่า 500 = up (รวม 302/401/403 ที่เป็นหน้า login) · 5xx / Cloudflare 52x-530 / timeout 10 วิ = down
