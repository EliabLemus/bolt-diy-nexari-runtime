# Nexari browser stack (vendored)

These tarballs are consumed only by the optional `VITE_RUNTIME_BACKEND=nexari` boot path. StackBlitz remains the default backend.

## Provenance

- Source repository: `/Users/openjaime/projects/nexari-boltdiy-integration`
- Runtime contract/core/adapter source commit: `458d1b297e72ea60b5d93dd74b2563bdd3531be1`
- Browser-assets source commit: `4e9e71708ffbd3e11aadf6a3fec11ea27f552210`
- Packaging command: `npm run pack:browser-stack`
- Package manifest: `manifest.json`

The browser-assets archive is a pinned data artifact, not a package-manager dependency: the consumer must extract and serve only its verified local copy. It must never read a producer directory at runtime.

## SHA-256

```text
e009f62147cb805bd61e552968308935c23a72cfabb7e990d3ad04b3552cd663  nexari-runtime-contract-0.1.0-dev.tgz
d83656b7cf4941e618ab7f529bdb8156ba5616125ccc293892c34281eb6f99d5  vivari-core-1.0.0.tgz
87732e88f23ae64858d40eb529b12383cd8ebca7365e8b3d78d2b2cf505eb2a9  nexari-vivari-adapter-0.1.0-dev.tgz
6c97fb8ea6e82ffa3fa5ce27d225d38885e685712ec854669f994d4548b134da  nexari-vivari-browser-assets-0.1.0-dev.tgz
```

`package.json` pins each executable package via a repository-relative `file:` dependency. The browser-assets artifact deliberately has no package-manager dependency, avoiding a mutable directory or registry fallback; later consumer packaging must validate its manifest checksum before extraction.
