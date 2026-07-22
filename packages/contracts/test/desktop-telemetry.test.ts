import { describe, expect, test } from "bun:test";
import { DesktopTelemetryEvent, type DesktopTelemetryEventT } from "../src/desktop-telemetry";


const video = {
  schema_version: 1,
  event_id: "018f47d2-e083-7d38-9cf8-6f0c3f5e5c77",
  observed_at: "2026-07-22T20:00:00.000Z",
  machine: "wsl",
  source: "windows_event",
  activity: "video",
  application: "brave",
  title: "A useful talk - YouTube",
  foreground: true,
  youtube: true,
} satisfies DesktopTelemetryEventT;

describe("desktop telemetry", () => {
  test("accepts a typed YouTube observation", () => {
    expect(DesktopTelemetryEvent.parse(video)).toEqual(video);
  });

  test("rejects policy, transport, and enforcement instructions", () => {
    expect(() => DesktopTelemetryEvent.parse({ ...video, enforcement_level: 4 })).toThrow();
    expect(() => DesktopTelemetryEvent.parse({ ...video, action: "close-video" })).toThrow();
  });

  test("rejects contradictory YouTube facts", () => {
    expect(() => DesktopTelemetryEvent.parse({ ...video, activity: "music", application: "spotify" })).toThrow();
  });
});
