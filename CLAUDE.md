# mylabjrp2001 — GitHub profile README

> ⚠️ repo นี้ **public** — GitHub บังคับให้ profile README อยู่ใน repo ชื่อเดียวกับ username และต้อง public
> เป็นข้อยกเว้นของกติกา "ทุก repo private":
> - **ห้าม commit `.env` / token / IP / โดเมนภายใน / รหัสผ่าน** · token อยู่ใน Actions secret `GH_STATS_TOKEN` เท่านั้น
> - `README.md` = หน้าโปรไฟล์ → **Push Log อยู่ที่ [CHANGELOG.md](CHANGELOG.md)** ไม่ใช่ README

## โครง
| ไฟล์ | หน้าที่ |
|---|---|
| `README.md` | หน้าโปรไฟล์ — วางรูปจาก `assets/` ตามลำดับ |
| `profile.config.json` | ข้อความหัว · รายชื่อแอปใน docker ps · วัน cutover · ตั้งค่าภาษา/กราฟ 30 วัน |
| `scripts/build.mjs` | ดึงสถิติ → `data/stats.json` (ตัวเลขรวมเท่านั้น) → วาด `assets/*-{dark,light}.svg` · Node 20 ไม่มี dependency |
| `.github/workflows/profile.yml` | ทุกวัน 06:00 ไทย · กดรันเอง · push ที่แตะ config/scripts/workflow |

## เอกสาร
- [.claude/docs/runbooks/deploy.md](.claude/docs/runbooks/deploy.md) — แก้แล้วขึ้นยังไง · ตั้ง/ต่ออายุ token
- [.claude/knowledge/gotchas.md](.claude/knowledge/gotchas.md) — กับดักที่เจอแล้ว

## งานเสร็จ
`node scripts/build.mjs` ผ่าน → เพิ่มบรรทัดใน CHANGELOG.md → `git pull --rebase` (bot commit รูปทุกวัน) → commit + push
