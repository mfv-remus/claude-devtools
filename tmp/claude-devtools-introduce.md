# Claude DevTools — Giới thiệu nội bộ

---

## 1. Claude DevTools là gì?

### Vấn đề nó giải quyết

- **Quá trình suy luận (thinking)** của Claude gần như vô hình trên terminal.
- **Chi tiết tool call** chỉ hiện 1 dòng tóm tắt, không thấy input/output thật.
- **Hoạt động của subagent** (agent gọi agent con) chỉ thấy kết quả cuối, không thấy quá trình.
- **Context window** chỉ có thanh tiến trình 3 màu, không biết token đang bị "ăn" bởi cái gì.
- **Team coordination** (tin nhắn giữa các teammate, giao việc, shutdown request...) bị ẩn hoàn toàn.
- **Xem lại lịch sử chat** nhiều người không biết cách xem lại lịch sử cuộc hội thoại cũ ở đâu, hoặc phải đọc lại file log JSONL với lượng dữ liệu raw khổng lồ.

### Claude DevTools là gì?

**Claude DevTools là một công cụ debug dành cho Claude Code** — một ứng dụng chạy hoàn toàn trên máy của bạn. Nó **đọc lại** các file log JSONL mà Claude Code đã tự ghi sẵn tại `~/.claude/` và dựng lại toàn bộ phiên làm việc (session) một cách trực quan.

Điểm quan trọng: **đây không phải là một wrapper** — nó không can thiệp, không sửa đổi cách Claude Code chạy. Nó chỉ đọc log có sẵn, nên hoạt động với mọi session đã chạy trước đó, dù bạn chạy Claude Code từ terminal, IDE, hay bất kỳ công cụ nào khác. Không cần cấu hình, không cần API key.

| Terminal ẩn gì | Claude DevTools hiện gì |
|---|---|
| `Read 3 files` | Đường dẫn file chính xác, nội dung có highlight syntax, có số dòng |
| `Searched for 1 pattern` | Regex pattern thật, danh sách file khớp, dòng khớp |
| `Edited 2 files` | Diff inline, highlight phần thêm/xóa |
| Thanh context 3 màu | Phân bổ token theo từng lượt hội thoại, chia theo nhiều nhóm nguồn (CLAUDE.md, skill, file @-mention, tool I/O, thinking, team overhead, user text...), kèm biểu đồ khi bị compaction |
| Output subagent bị gộp | Cây thực thi đầy đủ của từng agent: tool trace, token, thời gian, chi phí |
| Không thấy thinking | Nội dung extended thinking hiển thị đầy đủ |
| JSON thô từ `--verbose` | Giao diện có cấu trúc, lọc được, điều hướng được |
| Project memory ẩn trong `~/.claude/projects/.../memory/` | `MEMORY.md` hiển thị như một index có thể click, mở từng layer trong editor |
| Copy từ terminal bị vỡ dòng, dính mã màu ANSI | Text chọn được thật, copy 1-click cho mọi message/code block |

### Các chức năng chính

- **Context Reconstruction** — phân bổ token theo từng lượt hội thoại trên 7 nhóm nguồn, biết chính xác context window đang chứa gì.
- **Copy & Paste thân thiện** — chọn text thật, copy 1-click, export toàn session ra Markdown / JSON / plain text.
- **Project Memory Viewer** — xem `MEMORY.md` và các layer memory của Claude Code dưới dạng sidebar có cấu trúc, hỗ trợ `[[wikilink]]` kiểu Obsidian, mở nhanh bằng Finder/VS Code/Cursor/Zed...
- **Team & Subagent Trees** — cây thực thi cô lập cho từng agent con, subagent lồng nhau vẫn hiển thị đầy đủ.
- **Tool Call Inspector** — mỗi tool call có viewer riêng (Read syntax-highlight, Edit hiện diff, Bash hiện output...).
- **SSH Remote Sessions** — xem session trên máy remote qua SSH, hỗ trợ agent forwarding và key auth.
- **Compaction Visualization** — thấy chính xác thời điểm context bị đầy, bị nén và refill.
- **Notification Triggers** — thông báo hệ thống khi có truy cập `.env`, tool lỗi, token usage cao, hoặc theo regex tùy chỉnh.
- **Command Palette & Multi-Pane** — `Cmd+K` tìm kiếm xuyên session, mở nhiều session cạnh nhau bằng tab kéo-thả.

Chạy được trên **macOS, Linux, Windows** (bản desktop) và **Docker** (bản standalone, chạy như một web server nội bộ).

> Bởi vì Claude Code thay đổi liên tục, do đó, có thể một vài tính năng / thông tin đã không còn hiển thị được.
> Chúng ta cần liên tục khảo sát dữ liệu của file log để đưa ra thay đổi phù hợp, kịp thời.

---

## 2. Repo này đã update gì so với repo gốc?

`mfv-remus/claude-devtools` là **fork** của repo mã nguồn mở [`matt1398/claude-devtools`](https://github.com/matt1398/claude-devtools).

### Xem được cả các lần chạy Hook trong dòng thời gian

Claude Code có thể chạy các "hook" tùy chỉnh ở nhiều thời điểm (lúc bắt đầu session, sau khi nhận prompt, sau mỗi tool call...).

Claude DevTools gốc:
Các lần chạy hook gần như vô hình.

Claude DevTools update:
Nay Claude DevTools hiển thị chúng ngay trong dòng thời gian hội thoại, cho biết hook nào đã chạy, kết quả thành công/lỗi ra sao. Khi export session ra file, nội dung hook cũng được đưa vào đầy đủ.

### Xem chi tiết Subagent trong cửa sổ riêng

Trước đây muốn xem một subagent đã làm gì, phải cuộn xuyên suốt luồng hội thoại chính. 
Có một vài cách để Claude Code sinh ra subagent:
- 1. Từ agent chính gọi subagent - session chính gọi đến tool Agent.
- 2. Subagent gắn liền với một skill.
  ```yaml
  ---
  name: skill-name
  description: "description of what skill will do"
  context: fork
  agent: general-purpose
  ---
  ```

Claude DevTools gốc:
Chỉ xem được subagent được sinh ra theo trường hợp 1 bằng cách cuộn xuyên suốt luồng hội thoại chính. Không hỗ trợ xem subagent sinh theo trường hợp 2.

Claude DevTools update:
Hỗ trợ xem được cho cả 2 trường hợp.

### Chia sẻ link trực tiếp tới một project/session cụ thể

Claude DevTools gốc:
URL luôn là localhost:3456, bất kể người dùng mở workspace nào, session nào. Do đó, khi user bấm reload, web trỏ về trang chủ ban đầu.

Claude DevTools update:
Mỗi workspace, mỗi session là một URL riêng, do đó khi bấm reload, web vẫn trỏ về đúng session mong muốn.

### Tương thích với phiên bản Claude Code & model mới nhất

Claude Code liên tục cập nhật (đổi tên tool nội bộ, ra model mới như dòng Claude 5: Sonnet 5, Opus 5, Fable 5...). 

Claude DevTools gốc:
Việc parse model có bug khi không parse được format model mới. Do đó trên web không hiển thị session/subagent sử dụng model nào.

Claude DevTools update:
Fixed

### Tăng cường bảo mật khi tự host bằng Docker

Claude DevTools gốc:
Docker container được cấu hình bình thường. Nếu trong source code có luồng nào đẩy thông tin ra ngoài, có thể bị leak thông tin, gây ra vấn đề về security.

Claude DevTools update:
Cấu hình Docker được thiết kế lại để ứng dụng chạy trong một mạng nội bộ cô lập, không có khả năng tự kết nối ra internet — chỉ có một cổng trung gian được mở ra ngoài để người dùng truy cập.

---

## 3. Cài đặt / chạy thử

Có nhiều cách để cài đặt Claude DevTools gốc. Nhưng tôi khuyến nghị chạy bằng Docker vì tôi đã tối ưu về mặt bảo mật cho nó.

**Chạy bằng Docker:**

```bash
docker compose up
# Mở http://localhost:3456
```

---

## 4. Câu hỏi thường gặp (FAQ)

***Nguồn gốc và giấy phép:*
Claude DevTools bản chất là dự án mã nguồn mở, phát hành theo giấy phép **MIT**.
Repo `mfv-remus/claude-devtools` là **fork nội bộ**.

**Claude DevTools có thay đổi cách Claude Code hoạt động không?**
Không. Đây là công cụ chỉ-đọc (read-only), không phải wrapper, không can thiệp vào quá trình Claude Code chạy.

**Cần cấu hình API key không?**
Không cần. Ứng dụng chỉ đọc log JSONL đã có sẵn trên máy.

**Có tài liệu chi tiết hơn không?**
Repo gốc có trang tài liệu đầy đủ tại [claude-dev.tools/docs](https://claude-dev.tools/docs).
