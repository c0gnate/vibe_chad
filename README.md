# CHAD Suite Merged v1

Single-server package that combines:
- `pirate_chad_v1` (downloader + backend API)
- `wizard_chad_v1` (converter)
- `encrypt_chad_v1` (encryptor)

## Run

1. Open a terminal in `chad_suite_merged_v1`
2. Install deps:
   - `npm install`
3. Start server:
   - `npm start`
4. Open:
   - `http://localhost:3000`

## Notes

- The pirate tool backend endpoints are preserved:
  - `POST /api/extract`
  - `GET /api/download`
- Navigation between all three tools is done through the 3 PNG sidebar buttons on each page.
