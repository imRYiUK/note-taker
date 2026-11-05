import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, parseClientMsg } from "../src/shared/protocol.ts";

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

  test("accepts Buffer input", () => {
    expect(parseClientMsg(Buffer.from(j({ type: "ping", t: 0 })))).toEqual({ type: "ping", t: 0 });
  });
});
