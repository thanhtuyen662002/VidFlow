# M7.3: phụ đề và xuất nhiều tỉ lệ

`src/edit/export.ts` cung cấp `exportFinal(timeline, options)`. Options gồm
`projectDir`, `mixedAudioPath` (đường dẫn kết quả `mix()` của M7.2),
`aspect` (`16:9` hoặc `9:16`), tùy chọn `timestamp`, `outDir`, `timeoutMs`.
Chạy hai lần với cùng timeline để xuất hai tỉ lệ. Mặc định 1920×1080 và
1080×1920, scale và crop giữa khung, dùng đồ thị trim/normalize chung M3.
Chỉ hỗ trợ các clip video nối tiếp liên tục; timeline có khoảng trống hoặc
clip chồng nhau bị từ chối rõ ràng.

M7.1 hiện lưu phụ đề ở thời gian tuyệt đối theo cảnh, chưa có thời gian từng
câu trong nguồn. Adapter nhỏ: `TimelineClip.dialogueLines` tùy chọn chứa
`{text,start,end}` tính bằng giây trong nguồn trước trim, và `Timeline.fps`
tùy chọn (mặc định 24). Không thêm mô hình timeline hoặc migration thứ hai.
Các trường này thuộc snapshot truyền vào export, chưa được lưu bởi getTimeline.
Nếu không có dialogueLines, dùng phụ đề tuyệt đối đang lưu của M7.1, không
tự suy đoán thời gian câu nói. Muốn chính xác từng câu cần cung cấp timing thật.

Phụ đề chuyển thời gian sang microsecond nguyên, cộng offset, cắt theo trim,
làm tròn frame rồi chuyển sang millisecond SRT. Khi chồng lời, câu sau bắt đầu
sau câu trước, hoặc bị bỏ nếu không còn thời lượng. SRT UTF-8 và MP4 nằm
trong exports, không ghi đè kết quả cũ. Không có cue thì bỏ filter burn-in.

Âm thanh dùng lại normalize() M7.2: đo loudnorm JSON, áp measured_* với
linear=true ở lượt hai, rồi mã hóa AAC trong lượt ghép video duy nhất.
File WAV tạm được xóa khi hoàn tất hoặc lỗi. Nguồn im lặng không có LUFS hữu
hạn nên normalize() báo lỗi, không giả báo đạt −14 LUFS.

Kiểm thử: `node --test test/final-export.test.ts`; test sinh media bằng runner
M3, gọi mix M7.2, xuất cả hai tỉ lệ và đo lại chính MP4 bằng ffprobe/loudnorm.
