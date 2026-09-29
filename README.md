# 플랜두씨 노트 (ALEPH T06)

계획(Plan) → 실제로 한 일(Do) → 돌아보기(See)를 **서버 데이터베이스(Turso)** 로 잇는 다이어리입니다.
로그인은 아직 없습니다. 링크를 아는 사람은 누구나 볼 수 있으니, 남이 봐도 괜찮은 내용만 넣어 주세요. 잠그는 일은 T07에서 합니다.

- 화면: `public/` (HTML·CSS·JS, 저장된 글자는 전부 textContent로만 표시)
- 서버: `api/*.js` (Vercel 서버리스 함수) + `lib/` (DB 연결·검사·집계)
- DB 구조: `contracts/pds-schema-v2.json`
- 자동 검사: `scripts/check.mjs` → 결과 `evidence/check-result.md`
- 화면 모드: 흰 바탕(기본)·모눈 노트·어둡게 — 오른쪽 위에서 전환, 이 브라우저에 기억
- **배포·자료 입력·제출까지 단계별 안내: [`GUIDE.md`](GUIDE.md)**

## 배포 (Vercel + Turso)

1. **Turso DB 만들기** (T04 때와 같은 방법)
   - turso.tech 대시보드 → Create Database (예: `pds-note`, 지역은 Tokyo 권장)
   - Database URL(`libsql://...`)과 토큰(Generate Token)을 복사합니다.
2. **Vercel 프로젝트 만들기**
   - vercel.com → Add New → Project → GitHub 저장소 `yeaun12/claude-plan` 가져오기
   - Framework Preset: **Other**, Build Command·Output Directory는 비워 둡니다(`vercel.json` 이 `public` 을 지정).
   - Environment Variables 에 두 개를 넣습니다.
     - `TURSO_DATABASE_URL` = `libsql://...`
     - `TURSO_AUTH_TOKEN` = 복사한 토큰
   - Deploy. 표는 첫 요청 때 자동으로 만들어집니다.
3. **공개 확인**: Vercel → Settings → Deployment Protection 에서 Vercel Authentication 이 **꺼져 있어야** 시크릿 창에서 로그인 없이 열립니다.

> 토큰은 Vercel 환경 변수에만 넣고, 코드·채팅·깃에는 절대 붙여 넣지 마세요. `.env` 파일은 `.gitignore` 에 들어 있습니다.

## 로컬에서 실행·검사

```bash
npm install
TURSO_DATABASE_URL=file:local.db npm run dev          # http://localhost:3000

# 자동 검사: 빈 검사용 DB로 서버를 따로 띄운 뒤 (실제 다이어리에 검사 자료가 섞이지 않게)
TURSO_DATABASE_URL=file:check.db PORT=3001 node scripts/dev-server.mjs
CHECK_REPORT=evidence/check-result.md node scripts/check.mjs http://localhost:3001
```
