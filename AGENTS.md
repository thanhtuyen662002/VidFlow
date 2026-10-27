# VidFlow: quy ước cho các agent lập trình

Đọc `docs/PLAN.md` trước khi làm. Mỗi việc thuộc một mốc trong `docs/milestones/`.

## Cấu trúc

```
src/
  core/        dữ liệu, mô hình, cấu hình (M1)
  prompt/      @thamchieu, Bible, biên dịch, chuỗi (M2)
  media/       ffmpeg (M3)
  script/      xưởng kịch bản, lớp LLM (M4)
  flow/        trình điều khiển Flow, tài khoản, hàng đợi (M5)
  render/      điều phối render (M6)
  edit/        âm thanh, timeline, CapCut, xuất bản (M7)
  app/         Electron, giao diện, MCP (M8)
  cli.ts       điểm vào CLI
tests/         *.test.ts, chạy bằng `npm test` (node --test)
tests/fixtures/  dữ liệu mẫu nhỏ (không chứa media lớn)
docs/decisions/  ghi lại quyết định kỹ thuật
```

## Ngôn ngữ và công cụ

- Dùng **Node 24**. Node chạy TypeScript trực tiếp bằng cách bỏ kiểu dữ liệu, nên chỉ được dùng **cú pháp bỏ được kiểu**:
  - **không** dùng `enum`, `namespace` hay `parameter properties`. Thay `enum` bằng `const` object hoặc union type.
  - import kiểu phải viết `import type`.
  - import file nội bộ phải có đuôi `.ts`, ví dụ `import { x } from './core/db.ts'`.
- Cơ sở dữ liệu dùng `node:sqlite`. Không thêm dependency native.
- Dependency mới phải có lý do rõ ràng và cố định phiên bản. Hiện chỉ dự kiến: Playwright (M5), Electron, Vite và React (M8).
- Gọi tiến trình ngoài (ffmpeg, CLI của LLM, …) bằng `execFile` hoặc `spawn` với tham số dạng mảng, **không bao giờ qua shell**, và luôn có thời gian chờ tối đa.

## Kiểm thử

- `npm test` phải chạy được **không cần mạng và không cần tài khoản thật**.
- Mỗi test dùng một thư mục tạm (đặt `VIDFLOW_HOME`) và tự dọn sau khi chạy.
- Media mẫu được sinh bằng ffmpeg ngay trong test. Không có ffmpeg thì bỏ qua test kèm lý do.
- Flow dùng trang giả lập (M5), LLM dùng bản giả lập (M4).

## An toàn

- Không đưa vào Git: cookie, token, hồ sơ trình duyệt, ảnh chụp màn hình phiên đăng nhập, file media sinh ra, cơ sở dữ liệu chạy thật.
- Log phải lọc dữ liệu nhạy cảm (cookie, token, email nếu không cần).
- Không viết code nhằm vượt CAPTCHA hay cơ chế chống bot của Google. Gặp xác minh thì dừng và báo chủ sở hữu.
- Không xóa hay làm mờ dấu nhận diện AI. Logo chỉ được cắt ra ngoài khung (`docs/PLAN.md` mục 8).
- Mọi đường dẫn từ đầu vào phải nằm trong thư mục dữ liệu của dự án.

## Không phá hủy

File gốc (ảnh tham chiếu, take do Flow tạo) không bao giờ bị ghi đè. Kết quả xử lý nằm ở `frames/` hoặc `exports/`.
