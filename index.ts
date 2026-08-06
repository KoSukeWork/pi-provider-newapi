/**
 * Stable Pi entry point.
 *
 * Keep this file at the package root and keep package.json -> pi.extensions
 * pointed at ./index.ts. Pi uses the configured entry path when rendering the
 * startup extension list, so moving the entry into src/ would change the
 * display from `pi-provider-newapi` to `pi-provider-newapi:src`.
 *
 * The implementation is split under src/ so the Pi-facing loader remains a
 * single extension while configuration, discovery, provider registration, and
 * commands can evolve independently. Internal modules are intentionally not
 * re-exported here: tests import them directly, keeping the package entry's
 * public surface limited to the extension factory. Listing those modules in
 * the manifest would make Pi treat each one as an independent extension.
 */
export { default } from "./src/extension.ts";
