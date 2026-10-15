/**
 * Extension transport for platform.net.
 *
 * The desktop app passes its own transport (main-process fetch, no CORS)
 * into createPlatformNet and setPlatform. Tests pass fixtureTransport.
 * This file is the only platform module that knows about HTTP.
 */

import { createNet, globalFetchTransport } from "../net/fetch.js";

export function createPlatformNet(options = {}) {
  return createNet({
    transport: options.transport || globalFetchTransport,
    clock: options.clock,
    sleep: options.sleep,
    random: options.random,
    log: options.log,
    cache: options.cache
  });
}
