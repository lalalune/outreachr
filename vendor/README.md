# Eliza Cloud SDK release candidate

`elizaos-cloud-sdk-61bd46408cdec.tgz` is the immutable SDK package built by the
Cloud release task from source commit `61bd46408cdec1c338f6b5cabe8f071258c1a5de`.
The adjacent manifest records its source tree and SHA-256. The repository-relative
dependency and lockfile allow CI and Docker to install exactly these bytes.

This is a release candidate, not an npm publication or evidence that the matching
Cloud API is deployed. Before replacing it, verify the new manifest and checksum,
review the SDK contract changes, and rerun purchaser, provisioning, ownership,
membership, inference, browser and packaged-server checks.
