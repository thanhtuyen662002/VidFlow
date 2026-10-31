# VidFlow (Video Flow)

Công cụ làm video AI dài từ kịch bản, gồm các bước:

- kịch bản: nhiều phương án, chấm điểm, rồi duyệt;
- storyboard;
- render bằng Google Flow theo chuỗi nối khung hình;
- chọn bản đạt và đoạn cần dùng;
- âm thanh;
- ghép video và xuất draft CapCut.

Điều khiển được bằng giao diện, hoặc qua MCP từ Claude Code hay Codex.

- Kế hoạch tổng thể: [`docs/PLAN.md`](docs/PLAN.md)
- Các mốc (dự án Agent Forge): [`docs/milestones/`](docs/milestones/README.md)
- Quy ước cho agent lập trình: [`AGENTS.md`](AGENTS.md)

## Cài đặt cho người dùng

Chạy `VidFlow Setup <phiên bản>.exe` một lần là xong. Bộ cài:

- cài cho tài khoản Windows đang dùng, không hỏi quyền quản trị;
- tạo biểu tượng trên màn hình và trong menu Start;
- mở VidFlow ngay sau khi cài.

Bộ cài đã kèm sẵn ffmpeg, ffprobe và trình duyệt Chromium dùng cho Google Flow, nên không cần cài Node, ffmpeg hay trình duyệt riêng.

## Phát triển

Yêu cầu:

- Windows
- Node 24 trở lên
- ffmpeg trên PATH (hoặc đặt biến `VIDFLOW_FFMPEG`)

Tạo bộ cài:

```
npm run package:win
```

Lệnh này dựng ứng dụng, chép ffmpeg, ffprobe và Chromium vào `vendor/` (xem `config/vendor-tools.mjs`), rồi tạo file cài trong `release/`.

## Kiểm thử

```
npm test
```
