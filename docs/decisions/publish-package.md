# Gói xuất bản M7.5

`src/edit/package.ts` tạo bản mới trong `exports/<slug>/<thời-gian>-<uuid>/`.
Việc đăng lên các nền tảng hoàn toàn thủ công. `ready_to_publish` chỉ là nhãn cục bộ.

Gói gồm MP4 mỗi tỉ lệ, SRT từ timeline, ảnh bìa PNG, mô tả JSON/Markdown,
khai báo AI JSON/TXT và danh sách giấy phép. Manifest liệt kê SHA256, số byte,
vai trò và trạng thái từng tệp; manifest không tự băm chính nó.
Khai báo được nối sau mô tả LLM và không có tùy chọn tắt.
Nhạc không tìm thấy trong thư viện là `unknown`; thiếu bằng chứng hoặc trạng thái
khác `licensed` đều chặn đánh dấu sẵn sàng đăng. Thông tin giấy phép là bản chụp
tại lúc tạo gói; sau khi sửa thư viện cần tạo gói mới.

Ví dụ (đường dẫn đầu vào tương đối với thư mục dự án):

```powershell
node src/cli.ts timeline "Tên dự án" --music ID_NHAC --voice audio/voice.wav
node src/cli.ts export "Tên dự án" --timeline ID_TIMELINE --audio exports/mixed.wav --aspect 16:9,9:16
$env:VIDFLOW_LLM = 'fake'
$env:VIDFLOW_LLM_RESPONSES = '["{\"title\":\"Khu vườn\",\"description\":\"Một câu chuyện\",\"hashtags\":[\"#vuon\"]}"]'
node src/cli.ts package "Tên dự án" --timeline ID_TIMELINE --result exports/result-UUID.json --model MockLlm
node src/cli.ts package "Tên dự án" --ready --directory exports/slug/phien-ban
```

`--audio` dùng kết quả trộn từ M7.1; nhạc và lời nhập được ghi vào timeline
bằng `--music` và `--voice`. Lệnh export tái sử dụng `exportFinal`, bao gồm
phụ đề, chuẩn hóa âm lượng và draft CapCut. Lệnh package tái sử dụng
`extractFrame` nếu không truyền `--cover frames/cover.png`. Khi dùng TTS,
truyền `--tts-model` để ghi tên mô hình trong khai báo.
Các lệnh hỗ trợ `--help` và trả mã khác 0 khi lỗi.
