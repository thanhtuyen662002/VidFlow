# M7.2: trộn âm và giấy phép nhạc

Triển khai trong `src/edit/audio.ts`, dùng duy nhất wrapper M3 `runMediaFiles`.
Kết quả là WAV 48 kHz trong `exports/`; file đã tồn tại bị từ chối.
Không thêm dependency, dịch vụ mạng hay thay đổi timeline M7.1.

## Giao diện

- `mix(db, projectId, input: MixInput, output, context: AudioContext)` trả về
  `{ path, musicId?, loudness }`.
- `normalize(input, output, context, targetLufs = -14)` trả về `Promise<Loudness>`.
- `measure_loudness(input, context)` trả về `Promise<Loudness>`:
  `integratedLufs`, `truePeak` (dBTP).
- `parseLoudnorm(stderr)` đọc JSON lượt một từ cuối stderr, kiểm tra số hữu hạn.
- `TtsProvider.synthesize(text, voice, lang, outPath, context)` trả về
  `Promise<{ path, durationSec }>`; `TtsRegistry.get(name)` chọn provider.
  Chỉ đăng ký sẵn `mock`. Provider tương lai phải miễn phí hoặc chạy cục bộ.

`MixInput` nhận `original?`, `dialogue?`, `music?: { id, gainDb? }`,
`durationSec`, `ducking?`, `targetLufs?`. Rãnh gốc và lời có
`file`, `gainDb?`, `startSec?`. Không truyền rãnh gốc thì tiếng Veo bị tắt.
Mọi rãnh được đổi về stereo 48 kHz, dịch thời gian, đệm và cắt theo thời lượng.
Trộn lời bằng `amix normalize=0`, chia lời thành tín hiệu nghe và sidechain key.
Nhạc dùng `sidechaincompress` khi có lời; không có lời thì bỏ ducking.

Mặc định ducking: threshold 0.02 (biên độ tuyến tính), ratio 8,
attack 20 ms, release 250 ms, musicUnderDialogueDb −15 dB.
Mức −15 dB là gain bổ sung cho nền nhạc khi bản trộn có lời; mức giảm động
thực tế còn phụ thuộc biên độ key và cấu hình compressor, không bảo đảm
chênh lệch LUFS cố định giữa hai nguồn bất kỳ. Có thể đặt gain này về 0
để chỉ dùng compressor. Tất cả tham số đều được kiểm tra trước khi chạy.

Loudnorm hai lượt dùng I mặc định −14, TP −1.5, LRA 11, JSON lượt một
và measured_I/TP/LRA/thresh, offset, linear=true trong lượt hai.
Đo lại file kết quả; lệch quá 1 LU thì ném lỗi tiếng Việt.
Bản trộn không có rãnh tạo silence hợp lệ, trả `loudness: null` vì silence
không có integrated LUFS hữu hạn. Nguồn toàn silence được đưa vào normalize
sẽ báo lỗi số đo thay vì tuyên bố đã đạt −14 LUFS.

## Dữ liệu

Migration **15 — Music library licences** tạo `music_tracks`:
id, project_id, file (đường dẫn tương đối trong dự án), title,
has_license (0/1), license_source, attribution.
Repository `src/repo/music.ts` có create/get/list/update/deleteMusicTrack(s).
`mix` tra nhạc bằng id, kiểm tra cùng dự án và có giấy phép kèm nguồn.
Không cho truyền đường dẫn nhạc trực tiếp để bỏ qua hồ sơ giấy phép.

## Kiểm chứng trong sandbox

- Node v24.19.0.
- `node --test test/audio.test.ts`: sandbox từ chối tạo tiến trình con (`spawn EPERM`).
- `node --test --test-isolation=none test/audio.test.ts`: 5 tests,
  pass 3, fail 0, skipped 2 (thiếu ffmpeg/ffprobe trên PATH).
- LUFS thực đo: **chưa có** do ffmpeg không có trong môi trường.
  Test tích hợp in LUFS và true peak bằng `t.diagnostic` khi có công cụ.
- `npm.cmd test`: `Missing script: "test"`; workspace không có package.json.
- Đã chạy toàn bộ file `test/**/*.test.ts` riêng từng file bằng
  `node --test --test-isolation=none`: có lỗi môi trường từ `mkdtemp EPERM`,
  tiến trình/CLI và thiếu công cụ; không thể kết luận cả suite đạt.
  Các test migration hiện có: pass 7, fail 0; timeline: pass 5, fail 0.
- Không có cấu hình lint/typecheck trong context được cung cấp.

Test mới kiểm tra parser, đồ thị ducking, nâng DB 14→15 và CRUD giấy phép;
test media sinh sine 440/220 Hz ở −30 dB, trộn và đo lại −14 LUFS ±1,
silence khi không có rãnh, bảo vệ file gốc, và TTS WAV xác định cùng
thời lượng đọc bằng ffprobe. Tất cả đều offline, tự dọn thư mục tạm.
