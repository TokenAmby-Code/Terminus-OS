import type { DiscordGateway } from "./service.ts";

/**
 * The discord.js transport adapter is the single seam deferred to the consolidation wave.
 * The whole foundation depends only on the {@link DiscordGateway} interface (../service.ts);
 * this factory is the one place a live client is constructed.
 *
 * Until the adapter lands it fails LOUD — never a silent stub that pretends to connect. A
 * fake gateway that "succeeds" is exactly the ready≠working lie the recon named as the #1
 * morning tax, so the honest end-state is a named, throwing seam.
 */
export class GatewayAdapterMissing extends Error {
  constructor() {
    super(
      "discord.js gateway adapter is not installed — the live Discord transport lands with the consolidation wave",
    );
    this.name = "GatewayAdapterMissing";
  }
}

export function createGateway(): DiscordGateway {
  throw new GatewayAdapterMissing();
}
