import { describe, expect, test } from "bun:test";
import {
  EPHEMERAL_CHANNEL_CONTRACT as ROOT_CONTRACT,
  EPHEMERAL_CHANNEL_DISABLED_ENVELOPE as ROOT_ENVELOPE,
} from "@terminus-os/contracts";
import {
  EPHEMERAL_CHANNEL_CONTRACT,
  EPHEMERAL_CHANNEL_DISABLED_ENVELOPE,
  EPHEMERAL_CHANNEL_ERROR_CODE,
  EPHEMERAL_CHANNEL_ERROR_MESSAGE,
  EphemeralChannelContract,
  EphemeralChannelDisabledEnvelope,
} from "@terminus-os/contracts/ephemeral";

describe("ephemeral channel temporary disablement", () => {
  test("the policy and exact fail-loud error envelope parse", () => {
    expect(EphemeralChannelContract.parse(EPHEMERAL_CHANNEL_CONTRACT)).toEqual({
      availability: "temporarily_disabled",
      error: {
        code: "ephemeral_channel_temporarily_disabled",
        message: "ephemeral channel disabled by decree",
      },
      automatic_reprompt: false,
      automatic_retry: false,
    });

    expect(EphemeralChannelDisabledEnvelope.parse(EPHEMERAL_CHANNEL_DISABLED_ENVELOPE)).toEqual({
      ok: false,
      error: {
        code: EPHEMERAL_CHANNEL_ERROR_CODE,
        message: EPHEMERAL_CHANNEL_ERROR_MESSAGE,
      },
    });
  });

  test("automatic reprompt or retry cannot be enabled while temporarily disabled", () => {
    expect(() =>
      EphemeralChannelContract.parse({
        ...EPHEMERAL_CHANNEL_CONTRACT,
        automatic_reprompt: true,
      }),
    ).toThrow();
    expect(() =>
      EphemeralChannelContract.parse({
        ...EPHEMERAL_CHANNEL_CONTRACT,
        automatic_retry: true,
      }),
    ).toThrow();
  });

  test("silent success, no-op, and malformed errors are rejected", () => {
    expect(() =>
      EphemeralChannelDisabledEnvelope.parse({ ok: true, result: undefined }),
    ).toThrow();
    expect(() => EphemeralChannelDisabledEnvelope.parse({ ok: true, result: {} })).toThrow();
    expect(() => EphemeralChannelDisabledEnvelope.parse({ ok: false })).toThrow();
    expect(() =>
      EphemeralChannelDisabledEnvelope.parse({
        ok: false,
        error: { code: "disabled", message: EPHEMERAL_CHANNEL_ERROR_MESSAGE },
      }),
    ).toThrow();
    expect(() =>
      EphemeralChannelDisabledEnvelope.parse({
        ok: false,
        error: { code: EPHEMERAL_CHANNEL_ERROR_CODE, message: "try again later" },
      }),
    ).toThrow();
  });

  test("the package root and ./ephemeral subpath export the same contract", () => {
    expect(ROOT_CONTRACT).toEqual(EPHEMERAL_CHANNEL_CONTRACT);
    expect(ROOT_ENVELOPE).toEqual(EPHEMERAL_CHANNEL_DISABLED_ENVELOPE);
  });
});
