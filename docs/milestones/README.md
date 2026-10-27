# Các mốc VidFlow cho Agent Forge

Mỗi file `M*.md` là **một dự án Agent Forge**. Các trường trong file khớp với công cụ MCP `set_project_plan`:

- `goal`
- `acceptance_criteria`
- `testing_requirements`
- `non_goals`
- `owner_policies`
- `technical_constraints`

## Cách chạy một mốc

Nói với Claude, khi Claude đã kết nối MCP của Agent Forge:

> Dùng Agent Forge tạo dự án "VidFlow M1" cho thư mục `D:\Projects\VidFlow`, lấy kế hoạch từ `docs/milestones/M1.md`. Lệnh kiểm thử `npm test`. Bật Quản lý tự quyết định và tự đưa code vào nhánh chính. Bấm chạy, rồi báo tiến độ cho tôi tới khi xong.

## Thứ tự

1. **M1**
2. **M2, M3 và M5**: không phụ thuộc nhau. Agent Forge có thể chạy chúng thành ba dự án riêng, nhưng nên chạy lần lượt để code gộp vào `main` không xung đột.
3. **M4**, sau M2.
4. **M6**, sau M2, M3 và M5.
5. **M7**
6. **M8**
7. **M9**

## Quy tắc chung cho mọi mốc

Thêm các dòng này vào `owner_policies` của mỗi dự án:

- Tuân theo `AGENTS.md` của repo.
- Không sửa `docs/PLAN.md`. Nếu thấy kế hoạch sai, ghi đề xuất vào `docs/decisions/`.
- Mọi test chạy được bằng `npm test`, không cần mạng và không cần tài khoản thật.
- Không đưa cookie, token, hồ sơ trình duyệt, file media lớn hay dữ liệu chạy thật vào Git.
