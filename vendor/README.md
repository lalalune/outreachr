# Eliza Cloud SDK

`elizaos-cloud-sdk-4970b47fbb835.tgz` is the immutable SDK package built from Cloud source
`4970b47fbb83533390a515d75e719243d56d1a4f`. The adjacent manifest records its source tree and SHA-256.

It uses the generic `/billing/accounts/resolve` endpoint and requires JSON results
for typed billing, inference, and delegation management operations. The archive includes the upstream MIT
license. It is a local release candidate; it does not prove npm publication or
availability of the matching deployed Cloud APIs.

The generated route catalog excludes the retired `/api/v1/outreachr` endpoints.
Product behavior remains in Outreachr and uses the generic app APIs.
