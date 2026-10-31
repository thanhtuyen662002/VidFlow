# M9.5: hợp đồng adapter và xác nhận xóa

Giữ nguyên tên, schema và kênh IPC của các lệnh M8. Preload bổ sung nhóm archive, takes và update; mọi công cụ MCP lấy từ registry và đi qua xác thực Bearer hiện có. Renderer và CLI chỉ gọi dịch vụ.

Xem trước không xóa file. planId là SHA-256 của snapshot ứng viên (dự án, đường dẫn, kích thước, hash nội dung), ổn định qua các tiến trình CLI. Khi xác nhận, dịch vụ lập lại snapshot và đối chiếu planId trước khi gọi cơ chế xóa có kiểm tra selection, liên kết và nội dung file. executeTakeCleanup báo CONFIRMATION_REQUIRED khi thiếu xác nhận hoặc planId. Lệnh pruneApply cũ giữ kết quả dry-run khi thiếu confirm; không xóa gì. CLI bắt buộc cả --yes và --plan-id. Giao diện chỉ gửi confirm sau nút xác nhận trong hộp thoại.

Các test cũ cố định 55 lệnh và yêu cầu một workflow gọi toàn bộ registry đã lỗi thời so với M9.5 (bổ sung bốn lệnh archive/takes). Cập nhật số thành 59 và mở rộng workflow để thực sự gọi cả bốn lệnh, giữ phép so sánh toàn bộ registry. Test preload kiểm tra thêm bốn kênh update của wrapper M9.4, tách khỏi core registry. Test analytics bridge kiểm tra thêm các kênh này. Không bỏ assertion hay giảm phạm vi kiểm tra.

Trong sandbox, node --test bị EPERM khi spawn; có thể kiểm tra các test thuần Node bằng --test-isolation=none. Dependency React/jsdom/Vite đã được khai báo nhưng chưa có trong workspace này; không sửa package.json hoặc cài dependency.

Kiểm tra revision: 51 test liên quan qua `node --test --test-isolation=none` đều đạt (TMP/TEMP trỏ tới test/ để sandbox cho phép tạo thư mục tạm). Bộ này gồm service, MCP HTTP/auth, IPC/preload, CSV, mẫu series, archive, cleanup, updater và CLI scene. Test jsdom đã dùng named API/ServiceResult như preload thực tế và kiểm tra data-testid; chưa chạy được do dependency chưa được provision.
