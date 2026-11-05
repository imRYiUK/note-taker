import { describe, expect, test } from "bun:test";
import { LIMITS, PROTOCOL_VERSION, parseClientMsg } from "../src/shared/protocol.ts";

const j = (v: unknown) => JSON.stringify(v);

describe("parseClientMsg", () => {
  test("accepts a valid hello", () => {
    const msg = parseClientMsg(j({ type: "hello", role: "pad", token: "abc", deviceId: "d1", protocol: PROTOCOL_VERSION }));
    expect(msg).toEqual({ type: "hello", role: "pad", token: "abc", deviceId: "d1", protocol: PROTOCOL_VERSION });
  });

  test("normalizes a missing token to null", () => {
    const msg = parseClientMsg(j({ type: "hello", role: "viewer", deviceId: "d", protocol: 1 }));
    expect(msg).toMatchObject({ type: "hello", token: null });
  });

  test("rejects unknown roles, types and junk", () => {
    expect(parseClientMsg(j({ type: "hello", role: "admin", deviceId: "d", protocol: 1 }))).toBeNull();
    expect(parseClientMsg(j({ type: "nope" }))).toBeNull();
    expect(parseClientMsg("not json")).toBeNull();
    expect(parseClientMsg(j([1, 2]))).toBeNull();
    expect(parseClientMsg(j({ type: "ping", t: "x" }))).toBeNull();
    expect(parseClientMsg(j({ type: "hello", role: "pad", deviceId: "x".repeat(500), protocol: 1 }))).toBeNull();
  });

  test("ping / pong / adb.open", () => {
    expect(parseClientMsg(j({ type: "ping", t: 1.5 }))).toEqual({ type: "ping", t: 1.5 });
    expect(parseClientMsg(j({ type: "pong", t: 2 }))).toEqual({ type: "pong", t: 2 });
    expect(parseClientMsg(j({ type: "adb.open", serial: "R5C", page: "probe" }))).toEqual({
      type: "adb.open",
      serial: "R5C",
      page: "probe",
    });
    expect(parseClientMsg(j({ type: "adb.open", serial: "R5C", page: "/etc" }))).toBeNull();
  });

  test("erase / undo / redo", () => {
    expect(parseClientMsg(j({ type: "erase", pageId: "p", strokeIds: ["a", "b"] }))).toEqual({
      type: "erase",
      pageId: "p",
      strokeIds: ["a", "b"],
    });
    expect(parseClientMsg(j({ type: "erase", pageId: "p", strokeIds: ["a"], group: "g" }))).toMatchObject({ group: "g" });
    expect(parseClientMsg(j({ type: "erase", pageId: "p", strokeIds: [1] }))).toBeNull();
    expect(parseClientMsg(j({ type: "erase", pageId: "p", strokeIds: ["a"], group: 5 }))).toBeNull();
    expect(parseClientMsg(j({ type: "erase", pageId: "p", strokeIds: new Array(LIMITS.idsPerMessage + 1).fill("a") }))).toBeNull();
    expect(parseClientMsg(j({ type: "undo", extra: 1 }))).toEqual({ type: "undo" });
    expect(parseClientMsg(j({ type: "redo" }))).toEqual({ type: "redo" });
  });

  test("accepts Buffer input", () => {
    expect(parseClientMsg(Buffer.from(j({ type: "ping", t: 0 })))).toEqual({ type: "ping", t: 0 });
  });

  test("stroke messages", () => {
    const begin = { type: "stroke.begin", id: "s1", pageId: "page-1", tool: "pen", color: "#1d1f2b", width: 10 };
    expect(parseClientMsg(j(begin))).toEqual(begin as never);
    expect(parseClientMsg(j({ ...begin, color: "red" }))).toBeNull();
    expect(parseClientMsg(j({ ...begin, tool: "laser" }))).toBeNull();
    expect(parseClientMsg(j({ ...begin, width: 0 }))).toBeNull();
    expect(parseClientMsg(j({ ...begin, id: "" }))).toBeNull();

    expect(parseClientMsg(j({ type: "stroke.points", id: "s1", pts: [1, 2, 0.3, 4] }))).toEqual({
      type: "stroke.points",
      id: "s1",
      pts: [1, 2, 0.3, 4],
    });
    expect(parseClientMsg(j({ type: "stroke.points", id: "s1", pts: [1, 2, 0.3] }))).toBeNull(); // not a multiple of 4
    expect(parseClientMsg(j({ type: "stroke.points", id: "s1", pts: [1, 2, "x", 4] }))).toBeNull();
    expect(parseClientMsg(j({ type: "stroke.points", id: "s1", pts: new Array(LIMITS.pointsPerMessage * 4 + 4).fill(0) }))).toBeNull();

    expect(parseClientMsg(j({ type: "stroke.end", id: "s1", n: 12 }))).toEqual({ type: "stroke.end", id: "s1", n: 12 });
    expect(parseClientMsg(j({ type: "stroke.end", id: "s1", n: 1.5 }))).toBeNull();
    expect(parseClientMsg(j({ type: "stroke.cancel", id: "s1" }))).toEqual({ type: "stroke.cancel", id: "s1" });
    expect(parseClientMsg(j({ type: "page.clear", pageId: "page-1" }))).toEqual({ type: "page.clear", pageId: "page-1" });
  });

  test("settings.set is partial and clamped", () => {
    expect(parseClientMsg(j({ type: "settings.set", ink: { pressureMax: 9 } }))).toEqual({
      type: "settings.set",
      ink: { pressureMax: 1 },
    });
    expect(parseClientMsg(j({ type: "settings.set", ink: { pressureGamma: "x" } }))).toBeNull();
    expect(parseClientMsg(j({ type: "settings.set" }))).toBeNull();
  });
});
