# Draft CapCut (M7.4)

Đây là định dạng **best-effort** do VidFlow ghi ra, chỉ kiểm chứng bằng cấu trúc
dưới đây và test tự động, chưa kiểm chứng với phiên bản CapCut cụ thể. Không có
draft mẫu, phiên bản CapCut hay tài liệu bên ngoài làm tham chiếu; hợp đồng này
dựa trên yêu cầu M7.4. Không cam kết CapCut nhập được trực tiếp.

## Thư mục và cách ghi

Luồng `exportFinal` tạo MP4 và SRT trước, sau đó tạo:

```text
<project>/exports/<ratio>/capcut_draft-<suffix>/capcut_draft/
  draft_content.json
  draft_meta_info.json
```

`<ratio>` là `16x9` hoặc `9x16`; nếu có `outDir` thì dùng thư mục đó thay
`exports`. `<suffix>` ngẫu nhiên do `mkdtemp` tạo, luôn dùng thư mục mới kể cả
khi đã xuất trước đó. Hai JSON UTF-8 được ghi vào `.pending` bên trong thư mục
mới rồi đổi tên thư mục thành `capcut_draft`. Khi lỗi, chỉ dọn thư mục vừa tạo.
API writer trả đường dẫn thực tế. Chỉ ghi dưới `exports/` của dự án trong
`VIDFLOW_HOME`, kiểm tra cả symlink bằng cơ chế đường dẫn hiện có.

Media được tham chiếu bằng đường dẫn tuyệt đối trong dự án, không sao chép,
di chuyển, sửa, ghi đè hay xóa bản gốc. Phải giữ media ở nguyên vị trí.

## JSON

`draft_content.json` chứa:

- `id`: ID timeline.
- `canvas_config`: `width`, `height`, `ratio`, lần lượt là 1920/1080/`16:9`
  hoặc 1080/1920/`9:16`.
- `duration`: điểm kết thúc lớn nhất của tất cả segment, đơn vị microsecond.
- `materials.videos`, `materials.audios`: mỗi clip có một material riêng với
  `id`, `path` tuyệt đối và `duration`. Vì timeline không lưu toàn bộ thời lượng
  nguồn, `duration` material là điểm out, tức độ dài nguồn tối thiểu cần dùng.
- `tracks`: giữ thứ tự mảng track trong snapshot. Track `video` thành `video`,
  `dialogue` và `music` thành `audio`; bỏ track `subtitle` vì không chứa media.
  Kể cả track rỗng cũng được giữ. Mỗi track có `id`, `type`, `segments`.
- Mỗi segment có `id`, `material_id`, `source_timerange: {start, duration}`,
  `target_timerange: {start, duration}`, `volume`. Mỗi clip thành đúng một
  segment theo thứ tự mảng clips, kể cả clip của track tắt tiếng. `volume` là 0
  cho video (tiếng Veo tắt mặc định) hoặc track muted, còn audio bật là 1.

Timeline dùng giây. Chuyển bằng `Math.round(seconds * 1_000_000)`:
source start là inPoint, duration là outPoint − inPoint. Video target start
là tổng duration đã chuyển của các clip trước trong cùng track. Audio giữ
timelineStart để bảo toàn khoảng trống và vị trí lồng tiếng/nhạc. Không đổi
tốc độ hay lượng tử hóa theo fps. Thời gian âm, không hữu hạn hoặc duration
làm tròn bằng 0 bị từ chối.

ID xác định theo chỉ số bắt đầu từ 0 trong mảng đầu vào: `track-T`,
`material-T-C`, `segment-T-C`; không dùng tên file nên clip trùng nguồn vẫn
có ID riêng. Cùng snapshot tạo cùng nội dung JSON.

`draft_meta_info.json` chứa `draft_id` (ID timeline), `draft_name`
(`VidFlow <ID timeline>`), `draft_duration` (bằng content.duration).

Crop, LUT, phụ đề, logo và cấu hình ducking/loudness chưa được biểu diễn trong
draft tối thiểu này; SRT và bản ghép ffmpeg vẫn là đầu ra tham chiếu M7.3.
Draft dùng các rãnh audio snapshot, không tự thay chúng bằng file audio đã mix.

## Lỗi độc lập

Lỗi builder/writer không thoát khỏi `exportFinal`: MP4/SRT vẫn được giữ, kết quả
có `capcutDraft: {ok: false, error}` và `warnings`, đồng thời ghi warning vào
logger có lọc dữ liệu nhạy cảm. Thành công trả `{ok: true, path}`. Lỗi logger
cũng không làm hỏng bản xuất. Có thể tiêm `draftWriter` để kiểm thử lỗi.
