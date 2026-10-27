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

## Yêu cầu

- Windows
- Node 24 trở lên
- ffmpeg trên PATH (hoặc đặt biến `VIDFLOW_FFMPEG`)

## Kiểm thử

```
npm test
```
