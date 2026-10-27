# VidFlow (Video Flow): bản kế hoạch tổng thể

VidFlow là công cụ trên máy (Windows) dùng để làm **video AI dài và hoàn chỉnh** từ kịch bản. Luồng chính:

- **Kịch bản:** viết nhiều phương án, chấm điểm, rồi chủ sở hữu duyệt.
- **Storyboard:** dựng bằng ảnh tĩnh, rồi chủ sở hữu duyệt.
- **Render:** Google Flow tạo ảnh và video cho từng cảnh, theo chuỗi nối khung hình.
- **Hoàn thiện:** chọn bản đạt và đoạn cần dùng, dựng âm thanh, ghép video, xuất draft CapCut.

Có hai cách điều khiển:
- Qua **giao diện của tool**.
- Qua **MCP**: Claude Code, Codex hoặc AI khác kết nối vào và làm thay chủ sở hữu.

Dự án được xây bằng **Agent Forge** (xem `docs/milestones/`).

---

## 1. Mục tiêu và phạm vi

**Mục tiêu**

- Từ một ý tưởng và bộ ảnh tham chiếu, ra được video dài nhiều phút. Nhân vật và bối cảnh phải nhất quán, chuyển cảnh liền mạch.
- Kịch bản phải **đạt chất lượng trước khi tốn credit render**.
- Không phải chuyển qua lại giữa các tab Flow. Tool tự dùng nhiều tài khoản Flow đã đăng nhập, và tự chuyển tài khoản khi hết credit.
- Làm lại được từng phần với chi phí biết trước.
- Kết quả cuối gồm một video ghép sẵn (ffmpeg) và một **draft CapCut** để chỉnh tay.

**Không làm**

- Không dùng API trả phí của Google; nguồn sinh hình và video là **Google Flow** (giao diện web).
- Không vượt CAPTCHA hay cơ chế chống bot. Khi Flow yêu cầu xác minh hoặc đăng nhập lại, tool dừng và báo chủ sở hữu.
- Không xóa, làm mờ hay vẽ đè lên dấu nhận diện AI. Logo nhìn thấy được chỉ được **cắt ra ngoài khung** (mục 8). SynthID được giữ nguyên, và video được khai báo là nội dung AI khi đăng.
- Không dùng gương mặt người thật khi chưa có đồng ý, không dùng nhân vật hay thương hiệu có bản quyền, không dùng nhạc không có giấy phép.

---

## 2. Kiến trúc

```
┌──────────────── Giao diện (Electron + React) ─────────────────┐   ┌── MCP server (127.0.0.1, token) ──┐
│ Dự án · Tham chiếu · Kịch bản · Storyboard · Render · Dựng    │   │ Claude Code / Codex điều khiển     │
└───────────────┬───────────────────────────────────────────────┘   └───────────────┬───────────────────┘
                └──────────────────────┬───────────────────────────────────────────┘
                              Lõi VidFlow (Node 24, TypeScript)
  ┌───────────────┬───────────────┬──────────────────┬────────────────┬─────────────────┬───────────────┐
  │ Kho dự án     │ Ngôn ngữ      │ Xưởng kịch bản   │ Điều phối      │ Đường ống media │ Âm thanh &    │
  │ (node:sqlite) │ prompt & @ref │ (LLM qua CLI)    │ render & chuỗi │ (ffmpeg)        │ xuất bản      │
  └───────────────┴───────────────┴──────────────────┴───────┬────────┴─────────────────┴───────────────┘
                                                     Trình điều khiển Flow (Playwright)
                                             nhóm tài khoản Pro/Ultra · credit · hàng đợi
```

**Công nghệ** (chọn sẵn; đổi được nếu có lý do):

| Phần | Lựa chọn | Lý do |
| --- | --- | --- |
| Ngôn ngữ | TypeScript, chạy trực tiếp bằng Node 24 (bỏ kiểu dữ liệu khi chạy) | Không cần bước build cho lõi; `npm test` = `node --test` |
| Dữ liệu | `node:sqlite` có sẵn trong Node | Không phải dựng lại module native |
| Điều khiển Flow | Playwright, mỗi tài khoản một hồ sơ trình duyệt riêng | Giữ phiên đăng nhập, chạy song song theo tài khoản |
| Media | ffmpeg / ffprobe (đã có trên máy) | Cắt khung, crop, chuẩn hóa, ghép, trộn âm |
| LLM (viết kịch bản, chấm điểm, soát hình) | Claude Code CLI / Codex CLI chạy cục bộ, như Agent Forge | Dùng tài khoản sẵn có, không cần API key |
| Giao diện | Electron + Vite + React | Giống Agent Forge, đóng gói thành bộ cài Windows |
| Điều khiển bằng AI | Máy chủ MCP (Streamable HTTP, loopback, token) | Giống Agent Forge #289 |

**Thư mục dữ liệu** (nằm ngoài Git): `%APPDATA%/VidFlow/`

- `vidflow.db`
- `profiles/<account>/`: hồ sơ trình duyệt; chứa cookie, **không bao giờ** gửi đi đâu
- `projects/<project-id>/`
  - `refs/`
  - `renders/<scene>/<take>/`
  - `frames/`
  - `audio/`
  - `exports/`

---

## 3. Mô hình dữ liệu

- **Project:** tên, thư mục, tỉ lệ khung hình đích (16:9, 9:16 hoặc cả hai), thời lượng mục tiêu, ngân sách credit, trạng thái.
- **Bible** (master prompt): phong cách hình ảnh, ánh sáng, bảng màu, ống kính, những điều cần tránh, quy tắc vùng an toàn. Bible được ghép vào mọi prompt.
- **Reference:**
  - `name`: tên duy nhất trong dự án, dùng làm `@name`;
  - `role`: nhân vật, bối cảnh, đạo cụ hoặc phong cách;
  - `images[]`: bộ nhân vật gồm chính diện, nghiêng, ¾, toàn thân;
  - `description`: một dòng mô tả bằng chữ;
  - `wardrobe[]`: trang phục theo cảnh;
  - `priority`.
- **ScriptVariant:** logline, đối tượng người xem, giá trị mang lại, danh sách nhịp, danh sách cảnh, điểm chấm, nhận xét, trạng thái (nháp, đạt hoặc được duyệt).
- **Scene:**
  - `index`, `beat`;
  - `duration_used` (ví dụ 3 giây), `moment` (khoảnh khắc cần lấy);
  - `camera`, `action`, `dialogue`, `sfx`;
  - `characters_present[]` (bắt buộc);
  - `location`;
  - `transition`: `continue` (nối khung) hoặc `cut` (cắt cảnh, điểm ngắt chuỗi);
  - `group_id`: các nhịp ngắn liền mạch gộp chung một lượt 8 giây;
  - `mode`: `frames` (khung đầu + khung cuối), `image-to-video` hoặc `text`.
- **Chain:** dãy cảnh nối liền giữa hai lần `cut`. Đây là đơn vị render song song, và là phạm vi phải làm lại khi sửa.
- **RenderJob:** loại (image hoặc video), model (nhanh hoặc chất lượng), prompt đã biên dịch, ảnh đầu vào, tài khoản, trạng thái, credit, lỗi, số lần thử.
- **Take:** file gốc, metadata (độ phân giải, fps, thời lượng), điểm chất lượng của AI, đã chọn hay chưa.
- **Selection:** take được chọn, `in`/`out` (giây), crop logo, khung hình tại điểm ra (đã cắt sạch).
- **Account:** email (hoặc nhãn), loại (Pro/Ultra), hồ sơ trình duyệt, credit còn lại, ngày credit làm mới, trạng thái (sẵn sàng, đang bận, hết credit, cần đăng nhập, bị chặn), giới hạn chạy song song.
- **CreditLedger:** mọi lần tiêu credit, gắn với dự án, cảnh và tài khoản.
- **Asset/Export:** các file âm thanh, phụ đề, bản ghép, draft CapCut, thumbnail.

---

## 4. Ngôn ngữ prompt và `@thamchieu`

- **Cú pháp:** `@Ten` trong prompt của cảnh. Tên chỉ gồm chữ, số và `_`, phân biệt hoa thường theo đúng tên đã đăng ký. Viết `@@` để có ký tự `@` thật.
- **Kiểm tra trước khi tốn credit:**
  - tên không có trong thư viện là lỗi;
  - nhân vật nằm trong `characters_present` mà prompt không nhắc thì vẫn được tự thêm;
  - nhắc một nhân vật không có trong `characters_present` thì cảnh báo.
- **Biên dịch prompt:**
  - Thứ tự ghép: Bible, rồi mô tả cảnh với mỗi `@Ten` được thay bằng mô tả chữ của tham chiếu, rồi trang phục theo cảnh, rồi máy quay và hành động, rồi vùng an toàn, rồi những điều cần tránh.
  - Ảnh tham chiếu đi kèm được chọn theo `priority`, trong giới hạn số ảnh Flow cho phép.
  - Kết quả là một bản ghi xác định: cùng đầu vào thì ra cùng prompt (có kiểm thử).
- **Gộp nhịp:** các cảnh cùng `group_id` được viết thành một prompt 8 giây có mốc thời gian, ví dụ "0–3s: …, 3–6s: …".

---

## 5. Xưởng kịch bản (cổng duyệt 1)

1. Ý tưởng, rồi **logline**: nói về gì, cho ai xem, người xem nhận được gì.
2. **Cấu trúc nhịp:**
   - câu móc trong khoảng 3 giây đầu;
   - đặt vấn đề;
   - đẩy cao trào;
   - đoạn "trả thưởng";
   - kết hoặc lời kêu gọi.

   Mỗi nhịp có thời lượng mục tiêu.
3. Viết **3–5 phương án**. Một **AI biên tập khác** chấm từng phương án theo thang điểm 0–10:
   - câu móc;
   - độ rõ ràng;
   - cảm xúc và độ bất ngờ;
   - giá trị cho người xem;
   - nhịp độ và khả năng giữ chân người xem;
   - mức khả thi khi dựng bằng AI;
   - nguy cơ bị Flow từ chối.
4. Phương án chưa đạt ngưỡng thì được sửa theo nhận xét, tối đa N vòng.
5. **Tự soát nội dung:** gương mặt người thật, thương hiệu, nhân vật có bản quyền, chữ trong hình. Chữ được chuyển sang bước dựng.
6. Chủ sở hữu chọn và duyệt một phương án; phương án đó được tách thành các **Scene**.

---

## 6. Storyboard (cổng duyệt 2)

- Tạo ảnh khung chính cho từng cảnh bằng model ảnh của Flow (rẻ), có tham chiếu và có cắt logo.
- Ghép thành **bản xem thử**: slideshow dài đúng `duration_used`, có lồng tiếng hoặc nhạc tạm.
- Hiện **ước tính chi phí**: số cảnh, số lượt tạo video theo số bản mỗi cảnh, và credit theo từng model.
- Chỉ khi chủ sở hữu duyệt mới bắt đầu render video.

---

## 7. Render theo chuỗi

- **Lập lịch:**
  - mỗi **Chain** là một đơn vị độc lập;
  - các Chain khác nhau chạy song song trên các tài khoản khác nhau;
  - trong một Chain, các cảnh chạy tuần tự.
- **Mỗi cảnh:**
  1. Ảnh mở đầu.
     - Cảnh `cut` hoặc cảnh đầu Chain: tạo từ tham chiếu.
     - Cảnh `continue`: dùng **khung hình tại điểm ra của cảnh trước**, đã cắt sạch logo, cộng với tham chiếu.
  2. Ảnh khung cuối, nếu `mode=frames`.
  3. Tạo **K bản** video bằng model nhanh (mặc định K=2).
  4. **Soát hình bằng AI:**
     - cắt khung hình mỗi 0,5 giây;
     - LLM xem hình và chấm: đúng hành động, đủ nhân vật, tay và mặt không hỏng, chuyển động đẹp, có giữ vùng an toàn;
     - chọn take tốt nhất và đoạn `in`/`out`, chừa dư khoảng 0,5 giây ở mỗi đầu.
  5. Nếu không bản nào đạt: tạo lại, có giới hạn số lần. Nếu vẫn không được thì đánh dấu "cần chủ sở hữu xem".
  6. **Bản cuối:** cảnh đã chọn có thể render lại bằng model chất lượng cao, ưu tiên tài khoản Ultra (không có logo).
  7. Ghi lại **khung hình tại điểm ra** để cảnh sau nối tiếp.
- **Sửa một cảnh:** tool tính cảnh nào bị ảnh hưởng (đến lần `cut` kế tiếp) và báo trước "làm lại X cảnh, khoảng Y credit".
- **Ngân sách:** sắp chạm trần credit của dự án thì dừng và hỏi.
- **Bảng so sánh:** các take hiện cạnh nhau, để chủ sở hữu chốt nhanh và ghi đè lựa chọn của AI.

---

## 8. Đường ống media

- **Kiểm tra file và cắt khung:**
  - đọc thông tin file bằng ffprobe;
  - cắt khung hình tại thời điểm chính xác;
  - lấy mẫu khung hình để soát.
- **Cắt logo:**
  - vùng logo được cấu hình theo loại đầu ra;
  - mặc định là góc dưới bên phải, tính theo tỉ lệ phần trăm;
  - cắt một khung **cùng tỉ lệ**, nhỏ hơn khoảng 6–10% và né vùng logo, rồi phóng về độ phân giải gốc;
  - mọi ảnh làm **đầu vào** cho Flow đều được cắt sạch trước, nếu không mô hình sẽ vẽ lại logo;
  - render bằng tài khoản Ultra thì bỏ qua bước cắt;
  - file gốc giữ nguyên, phép cắt chỉ áp dụng khi xuất.
- **Đổi khung hình:** chuyển 16:9 sang 9:16 với khung cắt bám theo chủ thể (do AI đề xuất), và xuất được nhiều tỉ lệ.
- **Chuẩn hóa:** đưa về cùng fps, độ phân giải, codec và tần số lấy mẫu âm thanh; áp **LUT** màu chung.
- **Tăng độ nét/độ phân giải:** tùy chọn, áp cho bản cuối.
- **Ghép bản xem nhanh:** dựng từ timeline (take, in/out, crop) ra một file MP4.

---

## 9. Âm thanh

- **Tắt tiếng Veo theo mặc định.** Mỗi clip tạo một giọng khác nhau, và cắt clip thì tiếng bị đứt.
- **Lồng tiếng:** dùng một giọng cố định cho từng nhân vật. Bản 1 nhập file giọng đọc có sẵn; về sau cắm thêm được dịch vụ TTS. Lời thoại phải vừa thời lượng cảnh, và được kiểm tra ngay từ kịch bản.
- **Nhạc nền:** chỉ dùng nhạc có giấy phép. Thư viện nhạc lưu nguồn và loại giấy phép của từng bài.
- **Hiệu ứng âm thanh, trộn âm:** có ducking (nhạc tự nhỏ đi khi có lời), chuẩn hóa độ lớn theo LUFS.
- **Phụ đề:** SRT từ lời thoại và lồng tiếng, và tùy chọn chữ cháy vào hình.
- **Khớp nhạc:** tùy chọn cắt cảnh theo nhịp phách của nhạc.

---

## 10. Dựng và xuất bản

- **Draft CapCut:**
  - tạo file dự án CapCut có sẵn timeline: clip đúng in/out, crop, các rãnh âm thanh, phụ đề, logo kênh;
  - có bước **nghiên cứu định dạng** và kiểm thử bằng mẫu. Draft hỏng thì bản ghép bằng ffmpeg vẫn luôn có.
- **Bản ghép ffmpeg:** luôn được tạo để xem ngay.
- **Logo kênh của chủ sở hữu và dòng "có sử dụng AI":** chèn vào video khi cần.
- **Gói xuất bản:**
  - thumbnail: chọn khung đẹp, chữ được chèn khi dựng;
  - tiêu đề, mô tả, hashtag;
  - danh sách kiểm tra trước khi đăng: đã khai báo AI, nhạc có giấy phép.
- **Học từ kết quả:** nhập số liệu sau khi đăng (CSV: tỉ lệ xem hết, điểm người xem bỏ đi), rồi đề xuất chỉnh trọng số của thang điểm kịch bản.
- **Mẫu series:** lưu Bible, nhân vật và phong cách để dùng lại cho video sau.

---

## 11. Trình điều khiển Flow

- **Đăng nhập:**
  - mỗi tài khoản có một hồ sơ trình duyệt riêng;
  - **chủ sở hữu tự đăng nhập** trong cửa sổ do tool mở;
  - tool không lưu mật khẩu.
- **Nhóm tài khoản:**
  - đọc credit còn lại trên giao diện Flow;
  - ghi sổ mọi lần tiêu;
  - tự chuyển sang tài khoản sẵn sàng khi hết credit;
  - chọn đúng loại tài khoản cho từng bước: Pro cho bản nháp, Ultra cho bản cuối;
  - rải đều việc và có nhịp nghỉ giữa các lần chạy.
- **Hàng đợi:**
  - giới hạn số việc chạy song song trên mỗi tài khoản;
  - mỗi việc có thời gian chờ tối đa;
  - thử lại có giới hạn;
  - tải file về và xác minh (thời lượng, kích thước).
- **Nhận diện trạng thái:**
  - prompt bị từ chối: không thử lại mù quáng, mà đề xuất cách viết lại;
  - hết credit;
  - phiên bị đăng xuất, cần xác minh hoặc gặp CAPTCHA: **dừng và báo chủ sở hữu**.
- **Chống vỡ khi giao diện đổi:**
  - các selector của Flow nằm gọn ở **một file cấu hình**;
  - có lệnh **tự kiểm tra** từng selector;
  - lỗi được báo rõ chỗ nào hỏng, kèm ảnh chụp màn hình lưu cục bộ.
- **Kiểm thử:** dùng một **trang Flow giả lập** (HTML cục bộ) để CI chạy được mà không cần tài khoản thật. Ở chế độ thử thật, chủ sở hữu bật tay một lượt nhỏ.

---

## 12. Giao diện và MCP

- **Các màn hình:**
  - Dự án;
  - Thư viện tham chiếu;
  - Bible;
  - Xưởng kịch bản (các phương án, điểm, nhận xét);
  - Storyboard;
  - Hàng đợi render;
  - Bảng so sánh take;
  - Timeline dựng;
  - Tài khoản & credit;
  - Cài đặt (vùng logo, LUT, mặc định model).
- **Công cụ MCP:**

  | Nhóm | Công cụ |
  | --- | --- |
  | Dự án | `get_overview`, `create_project`, `set_bible` |
  | Tham chiếu | `add_reference` (đường dẫn ảnh), `list_references` |
  | Kịch bản | `generate_scripts`, `score_scripts`, `revise_script`, `approve_script` |
  | Phân cảnh | `get_scenes`, `edit_scene` (trả về chi phí làm lại) |
  | Storyboard | `build_storyboard`, `approve_storyboard`, `estimate_cost` |
  | Render | `start_render`, `pause_render`, `render_status`, `list_takes`, `select_take` (in/out), `rerender_scene` |
  | Âm thanh | `set_voiceover`, `set_music` |
  | Xuất | `assemble_preview`, `export_capcut`, `export_publish_kit` |
  | Tài khoản | `list_accounts`, `account_credits` |

  Không công cụ nào trả về cookie hay token.

- **An toàn của máy chủ MCP:**
  - chỉ nghe trên 127.0.0.1;
  - bắt buộc token Bearer;
  - từ chối mọi yêu cầu có `Origin` (từ trình duyệt);
  - giới hạn kích thước yêu cầu.

---

## 13. Yêu cầu chung

- **Bảo mật:** cookie, hồ sơ trình duyệt và token không bao giờ vào Git, log hay bằng chứng; log được lọc dữ liệu nhạy cảm.
- **Làm tiếp được:** mọi trạng thái nằm trong cơ sở dữ liệu, nên dừng giữa chừng thì chạy tiếp được; việc đang chạy dở khi khởi động lại sẽ được đối soát.
- **Lưu trữ:** quy ước đặt tên file; tự dọn take không được chọn sau khi xuất; sao lưu hoặc khôi phục cả dự án.
- **Kiểm thử:**
  - `npm test` (`node --test`) không cần mạng, không cần tài khoản;
  - ffmpeg có thể dùng trong test (đã có trên máy CI Windows và trên máy chủ sở hữu); test cần ffmpeg thì tự bỏ qua kèm lý do khi không có.
- **Ngôn ngữ giao diện:** tiếng Việt mặc định, có tiếng Anh.

---

## 14. Lộ trình

Mỗi mốc là **một dự án Agent Forge** (một hợp đồng trong `docs/milestones/`), làm theo thứ tự:

| Mốc | Nội dung | Phụ thuộc |
| --- | --- | --- |
| M1 | Nền tảng: kho dữ liệu, mô hình dữ liệu, cấu hình, CLI | — |
| M2 | Ngôn ngữ prompt `@thamchieu`, Bible, biên dịch prompt, chuỗi cảnh | M1 |
| M3 | Đường ống media ffmpeg: kiểm tra file, cắt khung, cắt logo, chuẩn hóa, LUT, ghép, storyboard | M1 |
| M4 | Xưởng kịch bản: LLM qua CLI, phương án, chấm điểm, sửa, soát nội dung, tách cảnh | M2 |
| M5 | Trình điều khiển Flow: hồ sơ, nhóm tài khoản, credit, hàng đợi, trạng thái, selector, Flow giả lập | M1 |
| M6 | Điều phối render: chuỗi song song, take, soát hình AI, in/out, nối khung, làm lại, ngân sách | M2, M3, M5 |
| M7 | Âm thanh, dựng, draft CapCut, nhiều tỉ lệ, gói xuất bản | M3, M6 |
| M8 | Giao diện Electron và máy chủ MCP | M1–M7 |
| M9 | Học từ kết quả, mẫu series, lưu trữ và sao lưu, đóng gói bộ cài | M8 |

M2, M3 và M5 không phụ thuộc nhau, nên có thể chạy song song thành các dự án Agent Forge riêng.

---

## 15. Quyết định đã chốt

- Nguồn sinh hình và video: **Google Flow**, không dùng API.
- Nhiều tài khoản Flow, chủ sở hữu tự đăng nhập; tự chuyển tài khoản khi hết credit; không vượt CAPTCHA hay chống bot.
- Logo Flow: **cắt ra ngoài khung**, không xóa hay làm mờ; nội dung luôn được khai báo là AI.
- Kịch bản và storyboard phải được duyệt trước khi render video.
- Làm đủ mọi phần trong bản kế hoạch này; đây là dự án thử sức Agent Forge.
