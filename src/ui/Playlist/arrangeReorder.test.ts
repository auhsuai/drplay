import { describe, expect, it } from "vitest";
import type { Track } from "../../types";
import {
  PLAYLIST_ROW_HEIGHT,
  applyArrangeDrop,
  resolveArrangeDrop,
} from "./arrangeReorder";

const track = (id: string): Track => ({
  id,
  title: id,
  artist: "",
  streamUrl: `https://example.com/${id}.mp3`,
});

const list = (...ids: string[]): Track[] => ids.map(track);

const ids = (tracks: readonly Track[]): string[] => tracks.map((t) => t.id);

const bag = (...items: string[]): Set<string> => new Set(items);

describe("resolveArrangeDrop", () => {
  it("không có item nào selected → không có drop (null)", () => {
    expect(resolveArrangeDrop(list("a", "b"), bag(), 0)).toBeNull();
  });

  it("selected hết cả playlist → không còn gì để chèn quanh (null)", () => {
    expect(resolveArrangeDrop(list("a", "b"), bag("a", "b"), 100)).toBeNull();
  });

  it("playlist 1 item → không reorder được (null)", () => {
    expect(resolveArrangeDrop(list("a"), bag("a"), 50)).toBeNull();
  });

  it("pointer phía trên midpoint đầu tiên của remaining → insertion 0", () => {
    expect(resolveArrangeDrop(list("a", "b", "c"), bag("b"), 10)).toEqual({
      insertionIndex: 0,
      indicatorY: 0,
    });
  });

  it("pointer phía dưới midpoint cuối của remaining → insertion ở cuối (bottom edge của row cuối)", () => {
    // remaining = a(0), b(1), d(3), e(4) — midpoints 28, 84, 196, 252.
    expect(
      resolveArrangeDrop(list("a", "b", "c", "d", "e"), bag("c"), 200),
    ).toEqual({
      insertionIndex: 3,
      indicatorY: 4 * PLAYLIST_ROW_HEIGHT,
    });
  });

  it("pointer nằm giữa 2 remaining rows → line ở top edge của remaining kế tiếp", () => {
    // remaining = a(0), b(1), d(3), e(4) — pointer 60 nằm giữa mid(a)=28 và mid(b)=84.
    expect(
      resolveArrangeDrop(list("a", "b", "c", "d", "e"), bag("c"), 60),
    ).toEqual({
      insertionIndex: 1,
      indicatorY: 1 * PLAYLIST_ROW_HEIGHT,
    });
  });

  it("selected id không còn tồn tại trong tracks → bỏ qua, không tính vào group", () => {
    // remaining = a(0), c(2); pointer 100 nằm giữa mid(a)=28 và mid(c)=140.
    expect(
      resolveArrangeDrop(list("a", "b", "c"), bag("b", "ghost"), 100),
    ).toEqual({
      insertionIndex: 1,
      indicatorY: 2 * PLAYLIST_ROW_HEIGHT,
    });
  });

  it("row height tùy chỉnh được tôn trọng", () => {
    // remaining = a(0), d(3) với rowHeight 100 → midpoints 50, 350.
    const result = resolveArrangeDrop(
      list("a", "b", "c", "d"),
      bag("b", "c"),
      120,
      100,
    );
    expect(result).toEqual({ insertionIndex: 1, indicatorY: 3 * 100 });
  });
});

describe("applyArrangeDrop", () => {
  it("§10 example: group rời rạc chèn trước F, giữ nguyên thứ tự nội bộ B C E", () => {
    const tracks = list("a", "b", "c", "d", "e", "f", "g");
    // remaining = A D F G; insertion 2 = before F.
    expect(ids(applyArrangeDrop(tracks, bag("b", "c", "e"), 2))).toEqual([
      "a",
      "d",
      "b",
      "c",
      "e",
      "f",
      "g",
    ]);
  });

  it("group lấy theo thứ tự source array, không theo thứ tự Set/click", () => {
    const tracks = list("a", "b", "c", "d");
    expect(ids(applyArrangeDrop(tracks, new Set(["c", "b"]), 0))).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("kéo xuống: block liên tiếp di chuyển nguyên khối, không lệch index", () => {
    const tracks = list("a", "b", "c", "d", "e", "f", "g");
    // remaining = A D E F G; insertion 5 = cuối danh sách remaining.
    expect(ids(applyArrangeDrop(tracks, bag("b", "c"), 5))).toEqual([
      "a",
      "d",
      "e",
      "f",
      "g",
      "b",
      "c",
    ]);
  });

  it("kéo lên: block liên tiếp di chuyển nguyên khối", () => {
    const tracks = list("a", "b", "c", "d", "e", "f");
    // remaining = A B E F; insertion 0 = đầu danh sách.
    expect(ids(applyArrangeDrop(tracks, bag("c", "d"), 0))).toEqual([
      "c",
      "d",
      "a",
      "b",
      "e",
      "f",
    ]);
  });

  it("drop vào chính vùng group (kết quả trùng order cũ) → trả đúng reference cũ (no-op)", () => {
    const tracks = list("a", "b", "c", "d", "e");
    // remaining = A D E; insertion 1 → A [B C] D E = order cũ.
    expect(applyArrangeDrop(tracks, bag("b", "c"), 1)).toBe(tracks);
  });

  it("single item drop ngay sau chính nó → no-op reference", () => {
    const tracks = list("a", "b", "c");
    // remaining = A C; insertion 1 → A B C = order cũ.
    expect(applyArrangeDrop(tracks, bag("b"), 1)).toBe(tracks);
  });

  it("select-all → không reorder, trả reference cũ", () => {
    const tracks = list("a", "b", "c");
    expect(applyArrangeDrop(tracks, bag("a", "b", "c"), 0)).toBe(tracks);
  });

  it("insertion index ngoài biên được clamp về [0, remaining.length]", () => {
    const tracks = list("a", "b", "c");
    expect(ids(applyArrangeDrop(tracks, bag("b"), -5))).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(ids(applyArrangeDrop(tracks, bag("b"), 99))).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("không mutate mảng gốc", () => {
    const tracks = list("a", "b", "c");
    const before = ids(tracks);
    applyArrangeDrop(tracks, bag("a"), 2);
    expect(ids(tracks)).toEqual(before);
  });
});
