# Shared polygon geometry

`polyclip.mjs` vendors the unmodified `dist/polyclip-ts.umd.min.js` bundle from the npm package `polyclip-ts@0.16.8` (MIT), including its BigNumber and splaytree dependencies. An ES-module-local CommonJS shim before the bundle and named exports after it let Node and browsers execute identical, offline geometry code without global variables or a frontend build step.

Upstream: https://github.com/luizbarboza/polyclip-ts/tree/v0.16.8

Included dependency licenses are in `THIRD_PARTY_LICENSES.txt`.

To reproduce, fetch `npm pack polyclip-ts@0.16.8`, extract the bundle, prepend:

```js
// Pinned polyclip-ts 0.16.8 browser bundle, shared by Node and browser replay.
// See README.md and THIRD_PARTY_LICENSES.txt in this directory.
const exports = {};
const module = { exports };
```

Append a newline and:

```js
export const { difference, intersection, union, xor, version } = exports;
```

SHA-256 of the upstream bundle: `065c85b4d6ed2b020469e0fdb4eb69710b5b7d0a35f12f2b20377e9e1f2326b5`.

SHA-256 of the npm tarball: `9f7df4cb51c02c75648b31a30922c048cd42f1d475619f1d8b742eccad680e02`.
