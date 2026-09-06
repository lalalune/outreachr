# Eliza Cloud SDK

`elizaos-cloud-sdk-d3159a0b1e7b.tgz` is the immutable SDK package built from Cloud source
`d3159a0b1e7bddb90a48b511a700bf656344b67b`. The adjacent manifest records its source tree and SHA-256.

It uses the generic `/billing/accounts/resolve` endpoint and requires JSON results
for typed billing and inference operations. The archive includes the upstream MIT
license. It is a local release candidate; it does not prove npm publication or
availability of the matching deployed Cloud APIs.

The generated route catalog excludes the retired `/api/v1/outreachr` endpoints.
Product behavior remains in Outreachr and uses the generic app APIs.
