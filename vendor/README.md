# Eliza Cloud SDK

`elizaos-cloud-sdk-503c08fee8f3.tgz` is the immutable SDK package built from Cloud source
`503c08fee8f3d257a0d1e629c4bc7a8bf03dcc96`. The adjacent manifest records its source tree and SHA-256.

It uses the generic `/billing/accounts/resolve` endpoint and requires JSON results
for typed billing and inference operations. The archive includes the upstream MIT
license. It is a local release candidate; it does not prove npm publication or
availability of the matching deployed Cloud APIs.

The generated route catalog excludes the retired `/api/v1/outreachr` endpoints.
Product behavior remains in Outreachr and uses the generic app APIs.
