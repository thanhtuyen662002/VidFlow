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

Chạy `VidFlow-Setup-<phiên bản>.exe` (tải ở trang [Releases](https://github.com/thanhtuyen662002/VidFlow/releases)) một lần là xong. Bộ cài:

- cài cho tài khoản Windows đang dùng, không hỏi quyền quản trị;
- tạo biểu tượng trên màn hình và trong menu Start;
- mở VidFlow ngay sau khi cài.

Bộ cài đã kèm sẵn ffmpeg, ffprobe và trình duyệt Chromium dùng cho Google Flow, nên không cần cài Node, ffmpeg hay trình duyệt riêng.

Từ bản 0.1.2, mỗi lần mở VidFlow sẽ kiểm tra bản mới trên GitHub Releases. Khi có bản mới, góc dưới thanh bên hiện **Có bản mới** với nút **Cập nhật ngay**: VidFlow tải bộ cài, kiểm tra mã SHA-256, hỏi lại rồi cài và mở lại ứng dụng.

## Phát triển

Yêu cầu:

- Windows
- Node 24 trở lên
- ffmpeg trên PATH (hoặc đặt biến `VIDFLOW_FFMPEG`)

Tạo bộ cài:

```
npm run package:win
```

Lệnh này dựng ứng dụng, chép ffmpeg, ffprobe và Chromium vào `vendor/` (xem `config/vendor-tools.mjs`), tạo `release/VidFlow-Setup-<phiên bản>.exe`, rồi ghi `release/vidflow-update.json` (xem `config/update-manifest.mjs`).

Phát hành: tăng `version` trong `package.json`, chạy `npm run package:win`, rồi tạo GitHub release `v<phiên bản>` (không đánh dấu pre-release) kèm **cả hai** file trên. Các bản đã cài đọc `vidflow-update.json` của release mới nhất để biết có bản mới.

## Kiểm thử

```
npm test
```
